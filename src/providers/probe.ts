/**
 * Is a role's model usable right now — one real call, one structured answer.
 *
 * `wowlidator doctor` has always made this call: the smallest round trip that
 * proves a model id resolves, over the exact key-failover path a run would
 * take. What it produced was a printed line, and the panel needed the same
 * fact as data — so the call lives here and both surfaces read from it. One
 * probe, two renderings; a second implementation would be a second thing to
 * drift, and the first symptom would be the panel calling a model ready that
 * `doctor` calls dead.
 *
 * ## The status is chosen by cause, not by "it failed"
 *
 * The question people actually bring here is not "does it work" but "is my
 * key out of quota, or is the model id wrong, or is the provider down" — each
 * of which is fixed somewhere different (wait / edit `.env` / wait longer). So
 * `classifyProbeError` reads the HTTP status first, then the message, and the
 * ordering is load-bearing: a 401 saying "authentication" is a rejected key,
 * not an unreachable provider, and a 429 whose body mentions the model name is
 * quota, not a missing model. `isKeyExhaustedError` (which decides whether a
 * run *rotates*) lumps auth and quota together on purpose — both mean "try
 * the next key" — and is exactly the distinction this module has to make.
 *
 * ## Quota headers are read where a provider sends them
 *
 * Groq answers every call with `x-ratelimit-remaining-tokens` and friends;
 * that is the difference between "ready" and "ready, with 1,200 tokens left
 * this minute", which is what someone about to start a twelve-case catalog
 * wants to know. Read best-effort, never required: Google and OpenRouter send
 * nothing of the kind and the probe says nothing about it.
 *
 * ## It spends tokens, and it says how many
 *
 * ~10 in, a handful out, per role. Cheap, not free — which is why the panel
 * runs it on a click and never on a poll.
 */

import { APICallError, generateText } from 'ai';

import { PROVIDER_META, type LlmRole, type ProviderName } from '../config.js';
import { AllKeysExhaustedError, LlmFactory, MissingApiKeyError } from './llm-factory.js';

/** Long enough for a cold free-tier model that thinks first; short enough not to hang a panel. */
export const PROBE_TIMEOUT_MS = 30_000;
/**
 * A local server loads its weights on the first request (measured: ~10s for a
 * 9B 8-bit model) and a thinking model then spends ~15s reasoning about a
 * one-word reply — both inside one probe. 30s called a working server
 * `unreachable` on every cold start.
 */
export const LOCAL_PROBE_TIMEOUT_MS = 120_000;

/**
 * Generous on purpose: reasoning models spend output budget on thinking, and a
 * 16-token cap makes a healthy model look empty.
 */
const PROBE_MAX_OUTPUT_TOKENS = 512;

export const PROBE_PROMPT = 'Reply with the single word: ok';

/**
 * What one probe concluded, in the order a person should check things.
 *
 * - `ready` — answered. The model resolves, the key works, there is quota.
 * - `empty` — answered with nothing. Usually a reasoning model that spent the
 *   whole budget thinking; suspicious for a role that needs a JSON reply.
 * - `exhausted` — the key is out of quota, rate-limited, or out of credit.
 *   Wait, or start on another key.
 * - `rejected` — the key itself is refused (401/403). Replace it.
 * - `model-missing` — the provider does not serve this id. Fix the routing.
 * - `unreachable` — no answer, a 5xx, or a provider saying it is overloaded.
 *   The provider, not the config.
 * - `no-key` — nothing configured for the role's provider.
 * - `failed` — something else; the detail carries the provider's own words.
 */
export type ProbeStatus =
  | 'ready'
  | 'empty'
  | 'exhausted'
  | 'rejected'
  | 'model-missing'
  | 'unreachable'
  | 'no-key'
  | 'failed';

/** Whether a status means the role can be relied on for the next run. */
export function probeIsUsable(status: ProbeStatus): boolean {
  return status === 'ready' || status === 'empty';
}

/** Rate-limit headroom, where the provider states it. Strings verbatim from the headers. */
export interface ProbeQuota {
  remainingTokens: number | null;
  limitTokens: number | null;
  remainingRequests: number | null;
  limitRequests: number | null;
  /** How long until the token bucket refills, as the provider wrote it (`2m59.56s`, `7s`). */
  resetTokens: string | null;
  resetRequests: string | null;
}

export interface ProbeAttempt {
  /** Index into the factory's key list for the provider — 0-based. */
  keyIndex: number;
  status: ProbeStatus;
  detail: string;
}

export interface RoleProbe {
  role: LlmRole;
  provider: ProviderName;
  modelId: string;
  status: ProbeStatus;
  /** One line a person can act on. Never contains a key. */
  detail: string;
  latencyMs: number;
  /** The reply's first characters, when there was one — proof it was this model answering. */
  reply: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null } | null;
  /** The key that answered (0-based, into the factory's list), or null when none did. */
  keyIndex: number | null;
  keyCount: number;
  /** Keys tried and abandoned before the answer — the failover trail. */
  attempts: ProbeAttempt[];
  quota: ProbeQuota | null;
  checkedAt: string;
}

/** Test seam: the one call the probe makes. */
export type ProbeGenerate = typeof generateText;

export interface ProbeOptions {
  generate?: ProbeGenerate;
  timeoutMs?: number;
  now?: () => number;
}

/**
 * Probe one role through `factory`, exactly the way a run would call it.
 *
 * Never throws. Every failure is a status with a detail, because the caller
 * is a doctor line or a panel cell and either can show a reason but neither
 * can do anything with an exception.
 */
export async function probeRole(
  factory: LlmFactory,
  role: LlmRole,
  options: ProbeOptions = {},
): Promise<RoleProbe> {
  const generate = options.generate ?? generateText;
  const entry = factory.config.roles[role];
  const timeoutMs =
    options.timeoutMs ?? (entry.provider === 'local' ? LOCAL_PROBE_TIMEOUT_MS : PROBE_TIMEOUT_MS);
  const now = options.now ?? Date.now;
  const keys = factory.config.apiKeys[entry.provider] ?? [];
  const keyCount = keys.length;
  const attempts: ProbeAttempt[] = [];
  const started = now();

  const base = {
    role,
    provider: entry.provider,
    modelId: entry.modelId,
    keyCount,
    attempts,
    checkedAt: new Date(started).toISOString(),
  };

  if (!factory.canResolve(role)) {
    return {
      ...base,
      status: 'no-key',
      detail: `no API key — ${PROVIDER_META[entry.provider].envKey} is unset`,
      latencyMs: 0,
      reply: null,
      usage: null,
      keyIndex: null,
      quota: null,
    };
  }

  try {
    const { text, usage, response } = await factory.callWithFailover(role, async (resolved) => {
      try {
        return await generate({
          model: resolved.model,
          prompt: PROBE_PROMPT,
          maxOutputTokens: PROBE_MAX_OUTPUT_TOKENS,
          maxRetries: 0,
          abortSignal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        // Recorded here because `callWithFailover` swallows every attempt but
        // the last: the trail of "key 1 exhausted, answered on key 2" is what
        // tells someone their first key is the problem before a run finds out.
        const classified = classifyProbeError(error);
        attempts.push({ keyIndex: resolved.keyIndex, ...classified });
        throw error;
      }
    });

    const reply = text.trim();
    const latencyMs = now() - started;
    const keyIndex = factory.activeKeyIndex(entry.provider);
    for (const attempt of attempts) attempt.detail = scrubKeys(attempt.detail, keys);
    const quota = quotaFromHeaders(response?.headers);
    const tokens = `${usage.inputTokens ?? '?'} in / ${usage.outputTokens ?? '?'} out`;
    const keyNote = keyCount > 1 ? `, key ${keyIndex + 1}/${keyCount}` : '';

    return {
      ...base,
      status: reply === '' ? 'empty' : 'ready',
      detail:
        reply === ''
          ? `responded in ${latencyMs}ms, ${tokens}${keyNote} — EMPTY reply; model may not suit this role`
          : `responded in ${latencyMs}ms, ${tokens}${keyNote}`,
      latencyMs,
      reply: reply === '' ? null : reply.slice(0, 24),
      usage: {
        inputTokens: usage.inputTokens ?? null,
        outputTokens: usage.outputTokens ?? null,
      },
      keyIndex,
      quota,
    };
  } catch (error) {
    const latencyMs = now() - started;
    const scrub = (text: string): string => scrubKeys(text, keys);
    for (const attempt of attempts) attempt.detail = scrub(attempt.detail);
    if (error instanceof MissingApiKeyError) {
      return {
        ...base,
        status: 'no-key',
        detail: `no API key — ${PROVIDER_META[entry.provider].envKey} is unset`,
        latencyMs,
        reply: null,
        usage: null,
        keyIndex: null,
        quota: null,
      };
    }
    // Every key failed: the verdict is the last key's, and the trail above
    // carries the rest. Otherwise the error is the one attempt's, unchanged.
    const last =
      error instanceof AllKeysExhaustedError
        ? error.attempts[error.attempts.length - 1]?.error
        : error;
    const classified = classifyProbeError(last);
    const detail =
      error instanceof AllKeysExhaustedError
        ? `all ${error.attempts.length} keys failed — last: ${classified.detail}`
        : classified.detail;
    return {
      ...base,
      status: classified.status,
      detail: scrub(detail),
      latencyMs,
      reply: null,
      usage: null,
      keyIndex: null,
      quota: quotaFromHeaders(apiCallErrorOf(last)?.responseHeaders),
    };
  }
}

const MODEL_MISSING_PATTERN =
  /model[^\n]{0,80}(not found|does not exist|not exist|is not available|unknown|decommissioned|no longer supported|has been deprecated)|no such model|not a valid model|model_not_found|is not found for api version|unsupported model/i;
const EXHAUSTED_PATTERN =
  /\bquota\b|rate.?limit|too many requests|resource_exhausted|insufficient[_ ](credits?|balance|quota|funds)|out of credits|billing|exceeded your current|\b1305\b/i;
const REJECTED_PATTERN =
  /invalid[_ ]api[_ ]key|incorrect api key|unauthori[sz]ed|forbidden|permission denied|authentication|api key not valid|invalid.?token/i;
const UNREACHABLE_PATTERN =
  /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|fetch failed|network|socket hang up|timed? ?out|aborted|service unavailable|overloaded/i;

/**
 * Turn a failed call into a status and a one-line reason.
 *
 * Status code first, message second — see the module note for why the order
 * matters. The message is the provider's own first line, trimmed, so the
 * detail is evidence rather than a paraphrase; a key can only reach it if the
 * provider echoed one back, and Google's key travels in the URL, so URLs are
 * stripped from the line before it is kept.
 */
export function classifyProbeError(error: unknown): { status: ProbeStatus; detail: string } {
  const apiError = apiCallErrorOf(error);
  const message = firstLine(error);
  const status = apiError?.statusCode;
  const wrap = (kind: ProbeStatus, lead: string): { status: ProbeStatus; detail: string } => ({
    status: kind,
    detail: `${lead}${status !== undefined ? ` (${status})` : ''} — ${message}`,
  });

  if (status === 401 || status === 403) return wrap('rejected', 'the key was refused');
  // z.ai signals *its own* overload as a 429 (its error 1305). That is the
  // provider's problem, not the key's quota, and calling it "out of quota"
  // would send someone to wait on a reset that is not the issue.
  if (status === 429 && /overload/i.test(message)) {
    return wrap('unreachable', 'the provider is overloaded, retry later');
  }
  if (status === 429 || status === 402) {
    const wait = retryAfter(apiError?.responseHeaders);
    return wrap(
      'exhausted',
      status === 402 ? 'out of credit' : `out of quota or rate-limited${wait ? `, retry in ${wait}` : ''}`,
    );
  }
  if (status === 404) return wrap('model-missing', 'the provider does not serve this model id');
  if (status !== undefined && status >= 500) return wrap('unreachable', 'the provider answered');

  if (MODEL_MISSING_PATTERN.test(message)) {
    return wrap('model-missing', 'the provider does not serve this model id');
  }
  if (EXHAUSTED_PATTERN.test(message)) return wrap('exhausted', 'out of quota or rate-limited');
  if (REJECTED_PATTERN.test(message)) return wrap('rejected', 'the key was refused');
  if (
    (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) ||
    UNREACHABLE_PATTERN.test(message)
  ) {
    return wrap('unreachable', 'no answer from the provider');
  }
  return wrap('failed', 'the call failed');
}

/**
 * A provider that echoes the key back in its own error text ("Invalid API Key
 * gsk_…") is the one way a credential could reach a doctor line or the panel.
 * Every configured key is replaced by its position before the text is kept.
 */
function scrubKeys(text: string, keys: readonly string[]): string {
  let out = text;
  keys.forEach((key, i) => {
    if (key.length >= 8) out = out.split(key).join(`<key ${i + 1}>`);
  });
  return out;
}

function apiCallErrorOf(error: unknown): APICallError | undefined {
  if (APICallError.isInstance(error)) return error;
  const cause = error instanceof Error ? error.cause : undefined;
  return APICallError.isInstance(cause) ? cause : undefined;
}

function firstLine(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const line = raw.split('\n').find((l) => l.trim() !== '') ?? raw;
  // Google's key is a query parameter of the request URL, and the SDK's error
  // text quotes the URL. Nothing here may carry a credential.
  return line.replace(/https?:\/\/\S+/g, '<url>').trim().slice(0, 240);
}

function header(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (headers === undefined) return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

function retryAfter(headers: Record<string, string> | undefined): string | null {
  const seconds = header(headers, 'retry-after');
  if (seconds !== undefined && seconds.trim() !== '') return `${seconds.trim()}s`;
  return header(headers, 'x-ratelimit-reset-tokens') ?? header(headers, 'x-ratelimit-reset-requests') ?? null;
}

/**
 * The OpenAI-shaped rate-limit headers, where present. Groq sends all six on
 * every response; a provider that sends none yields `null`, never a row of
 * zeros that would read as "nothing left".
 */
export function quotaFromHeaders(headers: Record<string, string> | undefined): ProbeQuota | null {
  const num = (name: string): number | null => {
    const value = header(headers, name);
    if (value === undefined) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const quota: ProbeQuota = {
    remainingTokens: num('x-ratelimit-remaining-tokens'),
    limitTokens: num('x-ratelimit-limit-tokens'),
    remainingRequests: num('x-ratelimit-remaining-requests'),
    limitRequests: num('x-ratelimit-limit-requests'),
    resetTokens: header(headers, 'x-ratelimit-reset-tokens') ?? null,
    resetRequests: header(headers, 'x-ratelimit-reset-requests') ?? null,
  };
  return Object.values(quota).every((v) => v === null) ? null : quota;
}
