/**
 * The decisions route: TypeSafe's Jev, natively or through OpenRouter.
 *
 * Jev is not a language model. It takes a `state` and a map of typed
 * questions and answers each one with a CHOICE (an option, a probability per
 * option, a confidence) or a NOUL (the probability a yes/no holds) — no text
 * is generated, so there is no schema to fill and nothing to parse. That is
 * why it lives beside `llm-factory.ts` rather than inside it: the AI SDK has
 * no adapter for a model that answers questions, and wrapping one in a
 * `LanguageModel` would only be a prompt pretending to be a question.
 *
 * Two routes carry the SAME request body (`{model, state, questions}`) and
 * answer in the same shape (measured 2026-09-18, see
 * `docs/research/2026-09-18-jev-spike/README.md`):
 *
 * - `typesafe`  → `POST https://api.typesafe.ai/v1/systemone`, `TYPESAFE_API_KEY`
 * - `openrouter` with a `~typesafe/…` model id → `POST
 *   https://openrouter.ai/api/alpha/decisions`, the OpenRouter key. Beta; the
 *   path is OpenRouter's alpha namespace and may move. Its `usage` carries a
 *   `cost` in USD the native route does not.
 *
 * One difference on the wire, learned from the community routing PRs and
 * confirmed live: OpenRouter takes `criteria` values and `instructions` as
 * TEXT, so structured values are JSON-encoded by `asText` before sending.
 * The native API types them `string | null` too, so the encoding is the
 * portable form on both.
 *
 * Failover and key handling are the factory's: `askDecisions` runs inside
 * `LlmFactory.callWithFailover`, so a 401/403/429 rotates to the next
 * configured key exactly as a chat call would, and a key never reaches a
 * message, a log line or a thrown error — the URL carries none and the
 * response body is scrubbed of every configured key before it is kept.
 *
 * `validateChoice` is jev-ultrafast's contract, ported: an answer whose
 * choice is not an offered option, whose distribution is not over exactly the
 * offered options, or whose numbers are not finite probabilities is refused
 * as a typed error and NO action is executed on it. Confidence alone is
 * clamped rather than refused — "never trust a number" (`src/providers/CLAUDE.md`).
 */

import { APICallError } from 'ai';

import { isDecisionModel, type LlmRole, type ProviderName, type RoleConfig } from '../config.js';
import type { LlmFactory } from './llm-factory.js';
import { logLlmFailure, logLlmRequest, logLlmResponse } from './llm-log.js';

export const TYPESAFE_DECISIONS_URL = 'https://api.typesafe.ai/v1/systemone';
export const OPENROUTER_DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';

/** How many times a 429/503/529 is retried before the failure is the caller's. */
export const DECISIONS_RETRIES = 2;
/** First retry delay; doubles per attempt. A `retry-after` header wins when present. */
export const DECISIONS_BACKOFF_MS = 500;
/** Longest one attempt may take. Jev answers in well under two seconds when it answers. */
export const DECISIONS_TIMEOUT_MS = 25_000;
/**
 * Longest a transient status is waited out on ONE key. A `retry-after` past
 * this (OpenRouter has answered 3600 s) is not waited for: the 429 is thrown
 * at once so `callWithFailover` rotates to the next key — the same shape as
 * `PACER_MAX_WAIT_MS` on the chat path. Nothing here may hold a doctor click,
 * a panel check or an agent turn hostage (review 2026-09-18).
 */
export const DECISIONS_MAX_WAIT_MS = 10_000;

export interface DecisionsRoute {
  provider: ProviderName;
  url: string;
  model: string;
  /** `provider:model`, the label every log line and record carries. Never a key. */
  label: string;
}

/** The route a role's config names, or null when the role is on a chat model. */
export function decisionsRouteFor(entry: Pick<RoleConfig, 'provider' | 'modelId'>): DecisionsRoute | null {
  if (!isDecisionModel(entry.provider, entry.modelId)) return null;
  const url = entry.provider === 'typesafe' ? TYPESAFE_DECISIONS_URL : OPENROUTER_DECISIONS_URL;
  return { provider: entry.provider, url, model: entry.modelId, label: `${entry.provider}:${entry.modelId}` };
}

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  /** Option → its rubric, or null for an option that needs none. */
  criteria: Record<string, string | null>;
}

export interface NoulQuestion {
  type: 'noul';
  instructions: string;
  criteria?: { true?: string; false?: string } | undefined;
}

export type DecisionQuestion = ChoiceQuestion | NoulQuestion;

export interface DecisionsRequest {
  /** Text or JSON structure. OpenRouter and TypeSafe both take an object. */
  state: unknown;
  questions: Record<string, DecisionQuestion>;
}

export interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface NoulAnswer {
  type: 'noul';
  noul: number;
}

export type DecisionAnswer = ChoiceAnswer | NoulAnswer;

export interface DecisionsResponse {
  /** The versioned id that answered (`typesafe/jev-1.13-20260917`), never the alias sent. */
  model: string;
  answers: Record<string, DecisionAnswer>;
  /**
   * Null, never 0, when the response does not say — "never a row of zeros".
   * `costUsd` is what OpenRouter's Decisions endpoint bills for the call; the
   * native route reports none. It is carried on the response and NOT booked
   * anywhere yet — no ledger row, no `byRole`, not under the usage cap.
   */
  usage: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null };
  latencyMs: number;
}

/** Criteria and instructions travel as text; a structure is JSON-encoded, a string is itself. */
export function asText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** The answer is not one the code offered, or not a distribution — no action may be taken on it. */
export class DecisionsAnswerError extends Error {
  constructor(message: string) {
    super(`invalid decision answer — no action executed: ${message}`);
    this.name = 'DecisionsAnswerError';
  }
}

const finiteUnit = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;

/**
 * jev-ultrafast's `validate_choice`, ported. `options` is what the request
 * offered; anything the model answers outside it is refused.
 */
/** Two decimals of rounding either side: the precision the decisions route reports probabilities at. */
export const ROUNDING_TOLERANCE = 0.02;

export function validateChoice(answer: unknown, options: readonly string[]): ChoiceAnswer {
  if (answer === null || typeof answer !== 'object') throw new DecisionsAnswerError('the answer is not an object');
  const raw = answer as { choice?: unknown; probabilities?: unknown; confidence?: unknown };
  if (typeof raw.choice !== 'string' || !options.includes(raw.choice)) {
    throw new DecisionsAnswerError(`choice ${JSON.stringify(raw.choice)} is not one of the offered options`);
  }
  if (raw.probabilities === null || typeof raw.probabilities !== 'object') {
    throw new DecisionsAnswerError('no probability distribution');
  }
  const probabilities = raw.probabilities as Record<string, unknown>;
  const keys = Object.keys(probabilities);
  const offered = new Set(options);
  if (keys.length !== offered.size || keys.some((k) => !offered.has(k))) {
    throw new DecisionsAnswerError('the distribution is not over exactly the offered options');
  }
  const values = keys.map((k) => probabilities[k]);
  if (!values.every(finiteUnit)) throw new DecisionsAnswerError('a probability is not a finite number in 0..1');
  const numbers = values as number[];
  const sum = numbers.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) >= 0.02) throw new DecisionsAnswerError(`probabilities sum to ${sum.toFixed(3)}, not 1`);
  // The distribution arrives rounded to two decimals, so a choice within that
  // precision of the most probable option is not a contradiction (HUMI SIT
  // 1.001, 2026-09-18: `choice: CLICK` at 0.39 beside SCROLL_DOWN at 0.40
  // ended a whole leg as a model failure, the hire wizard half filled). A
  // choice further below the maximum than rounding can explain still is.
  const chosen = probabilities[raw.choice] as number;
  if (chosen < Math.max(...numbers) - ROUNDING_TOLERANCE) {
    throw new DecisionsAnswerError('the choice is not the most probable option');
  }
  // Clamped, not refused: the answer is the distribution; confidence is a
  // derived number a reader weighs, and a stray 1.4 must not void a correct pick.
  const confidence = typeof raw.confidence === 'number' && Number.isFinite(raw.confidence) ? Math.min(1, Math.max(0, raw.confidence)) : 0;
  return { type: 'choice', choice: raw.choice, probabilities: probabilities as Record<string, number>, confidence };
}

export function validateNoul(answer: unknown): NoulAnswer {
  const value = (answer as { noul?: unknown } | null)?.noul;
  if (!finiteUnit(value)) throw new DecisionsAnswerError('noul is not a finite number in 0..1');
  return { type: 'noul', noul: value };
}

export interface PostDecisionsOptions {
  /** Test seam; defaults to the global fetch. */
  fetch?: typeof fetch | undefined;
  /** Test seam for the retry backoff. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /** What the call is for, beside the role — `agent · turn 3`. */
  task?: string | undefined;
  signal?: AbortSignal | undefined;
  retries?: number | undefined;
  /** Keys to scrub from any text kept off the response. */
  scrub?: readonly string[] | undefined;
}

const retryAfterMs = (headers: Headers): number | null => {
  const raw = headers.get('retry-after');
  if (raw === null || raw.trim() === '') return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
};

const headersOf = (headers: Headers): Record<string, string> => {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
};

function scrubbed(text: string, keys: readonly string[]): string {
  let out = text;
  keys.forEach((key, i) => {
    if (key.length >= 8) out = out.split(key).join(`<key ${i + 1}>`);
  });
  return out;
}

/**
 * One request to a decisions route, at one key. Retries the transient
 * statuses (429, 503, 529) with backoff, honouring `retry-after`; any other
 * HTTP failure is an `APICallError` carrying the status and headers, so the
 * probe's classifier and the factory's key-rotation rule read it exactly as
 * they read a chat provider's. The request body is logged like every model
 * call (`llm-log.ts`); the key is in no message, log line or error.
 */
export async function postDecisions(
  route: DecisionsRoute,
  apiKey: string,
  request: DecisionsRequest,
  options: PostDecisionsOptions = {},
): Promise<DecisionsResponse> {
  const doFetch = options.fetch ?? fetch;
  const signal = options.signal ?? AbortSignal.timeout(DECISIONS_TIMEOUT_MS);
  // The wait races the caller's signal: an aborted probe or turn must not
  // keep sleeping on its behalf.
  const sleep =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(done, ms);
        function done(): void {
          clearTimeout(timer);
          signal.removeEventListener('abort', done);
          resolve();
        }
        signal.addEventListener('abort', done, { once: true });
      }));
  const retries = options.retries ?? DECISIONS_RETRIES;
  const task = options.task ?? 'decisions';
  const scrub = options.scrub ?? [apiKey];
  const body = JSON.stringify({ model: route.model, state: request.state, questions: request.questions });
  const started = Date.now();
  for (let attempt = 1; ; attempt += 1) {
    logLlmRequest({
      task,
      modelLabel: route.label,
      system: '',
      prompt: body,
      estTokens: Math.ceil(body.length / 4),
      attempt,
    });
    let response: Response;
    try {
      response = await doFetch(route.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body,
        signal,
      });
    } catch (error) {
      logLlmFailure({ task, modelLabel: route.label, ms: Date.now() - started, error });
      throw error;
    }
    const transient = response.status === 429 || response.status === 503 || response.status === 529;
    const wait = transient ? retryAfterMs(response.headers) ?? DECISIONS_BACKOFF_MS * 2 ** (attempt - 1) : 0;
    if (transient && attempt <= retries && wait <= DECISIONS_MAX_WAIT_MS && !signal.aborted) {
      logLlmFailure({
        task,
        modelLabel: route.label,
        ms: Date.now() - started,
        error: new Error(`HTTP ${response.status}`),
        willRetryInMs: wait,
      });
      await response.text().catch(() => '');
      await sleep(wait);
      continue;
    }
    const text = await response.text();
    if (!response.ok) {
      const error = new APICallError({
        message: `${route.label} answered HTTP ${response.status}: ${scrubbed(text, scrub).slice(0, 300)}`,
        url: route.url,
        requestBodyValues: {},
        statusCode: response.status,
        responseHeaders: headersOf(response.headers),
        responseBody: scrubbed(text, scrub),
        isRetryable: transient,
      });
      logLlmFailure({ task, modelLabel: route.label, ms: Date.now() - started, error });
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      const error = new DecisionsAnswerError(`the response is not JSON (began: ${scrubbed(text, scrub).slice(0, 80)})`);
      logLlmFailure({ task, modelLabel: route.label, ms: Date.now() - started, error });
      throw error;
    }
    const raw = parsed as { model?: unknown; answers?: unknown; usage?: { input_tokens?: unknown; output_tokens?: unknown; cost?: unknown } };
    if (raw.answers === null || typeof raw.answers !== 'object') {
      const error = new DecisionsAnswerError('the response carries no answers');
      logLlmFailure({ task, modelLabel: route.label, ms: Date.now() - started, error });
      throw error;
    }
    const usage = {
      inputTokens: typeof raw.usage?.input_tokens === 'number' ? raw.usage.input_tokens : null,
      outputTokens: typeof raw.usage?.output_tokens === 'number' ? raw.usage.output_tokens : null,
      costUsd: typeof raw.usage?.cost === 'number' ? raw.usage.cost : null,
    };
    const latencyMs = Date.now() - started;
    logLlmResponse({
      task,
      modelLabel: route.label,
      ms: latencyMs,
      inputTokens: usage.inputTokens ?? undefined,
      outputTokens: usage.outputTokens ?? undefined,
      object: raw.answers,
    });
    return {
      model: typeof raw.model === 'string' ? raw.model : route.model,
      answers: raw.answers as Record<string, DecisionAnswer>,
      usage,
      latencyMs,
    };
  }
}

export interface AskDecisionsOptions extends PostDecisionsOptions {
  /** Called for every key that failed before the answer — the probe's failover trail. */
  onAttemptFailure?: ((keyIndex: number, error: unknown) => void) | undefined;
  /** A fresh signal per key attempt, so a second key gets its own budget rather than what the first left. */
  signalFor?: (() => AbortSignal) | undefined;
}

/**
 * Ask the role's decisions route, rotating keys through the factory exactly
 * as a chat call would. Throws `MissingApiKeyError` with no key, the one
 * attempt's error unchanged, or `AllKeysExhaustedError` — the factory's own
 * contract — and a plain `Error` when the role is not on a decision model.
 */
export async function askDecisions(
  factory: LlmFactory,
  role: LlmRole,
  request: DecisionsRequest,
  options: AskDecisionsOptions = {},
): Promise<DecisionsResponse> {
  const entry = factory.config.roles[role];
  const route = decisionsRouteFor(entry);
  if (route === null) {
    throw new Error(`the "${role}" role is on ${entry.provider}:${entry.modelId}, which is not a decision model`);
  }
  const keys = factory.config.apiKeys[entry.provider] ?? [];
  return await factory.callWithFailover(role, async (resolved) => {
    const apiKey = keys[resolved.keyIndex];
    if (apiKey === undefined) throw new Error(`no key at index ${resolved.keyIndex} for ${entry.provider}`);
    try {
      return await postDecisions(route, apiKey, request, {
        ...options,
        ...(options.signalFor === undefined ? {} : { signal: options.signalFor() }),
        scrub: keys,
      });
    } catch (error) {
      options.onAttemptFailure?.(resolved.keyIndex, error);
      throw error;
    }
  });
}

/** The doctor's one-token question: a noul over the word "ok". */
export const PROBE_DECISION_REQUEST: DecisionsRequest = {
  state: 'ok',
  questions: { probe: { type: 'noul', instructions: 'Is the state exactly the word "ok"?' } },
};
