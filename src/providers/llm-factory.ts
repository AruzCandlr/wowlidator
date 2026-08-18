/**
 * Provider abstraction over the Vercel AI SDK.
 *
 * Everything model-shaped in wowlidator goes through `LanguageModel`, so the engine
 * never imports a vendor SDK and swapping providers is a config change rather
 * than a code change. Adding a fourth provider means one entry in `FACTORIES`
 * and one string in `PROVIDERS` — no call site moves.
 *
 * Roles are resolved lazily: a run that never heals and has no `workflow`
 * steps never constructs a model, and therefore never demands an API key.
 */

import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import {
  APICallError,
  NoObjectGeneratedError,
  generateObject,
  type LanguageModel,
} from 'ai';
import { z } from 'zod';

import {
  PROVIDER_META,
  loadConfig,
  type LlmRole,
  type ProviderName,
  type RoleConfig,
  type WowlidatorConfig,
} from '../config.js';

export class MissingApiKeyError extends Error {
  readonly provider: ProviderName;
  readonly role: LlmRole;

  constructor(role: LlmRole, provider: ProviderName) {
    const meta = PROVIDER_META[provider];
    super(
      `wowlidator needs a ${meta.label} key to run the "${role}" role.\n` +
        `  export ${meta.envKey}=...   (${meta.consoleUrl})\n` +
        `  ${meta.freeTier}\n` +
        `  Add more than one as a comma-separated list (${meta.envKey}=key1,key2) ` +
        `and wowlidator fails over to the next automatically when one is exhausted.\n` +
        `Or point the role elsewhere: WOWLIDATOR_${role.toUpperCase()}_PROVIDER=<google|groq|openrouter|emmiedev|zai>`,
    );
    this.name = 'MissingApiKeyError';
    this.provider = provider;
    this.role = role;
  }
}

/**
 * Every key for `provider` failed. Distinct from `MissingApiKeyError` — that
 * one means "nothing configured"; this one means "configured, and none of it
 * works right now". Carries every attempt so the actual cause of each failure
 * (not just the last one) is visible rather than discarded.
 */
export class AllKeysExhaustedError extends Error {
  readonly role: LlmRole;
  readonly provider: ProviderName;
  readonly attempts: ReadonlyArray<{ keyIndex: number; error: unknown }>;

  constructor(
    role: LlmRole,
    provider: ProviderName,
    attempts: ReadonlyArray<{ keyIndex: number; error: unknown }>,
  ) {
    const meta = PROVIDER_META[provider];
    super(
      `all ${attempts.length} ${meta.label} key(s) failed for the "${role}" role:\n` +
        attempts.map((a) => `  key ${a.keyIndex + 1}: ${summarize(a.error)}`).join('\n') +
        `\nAdd another key, or fix ${meta.envKey}.`,
      { cause: attempts[attempts.length - 1]?.error },
    );
    this.name = 'AllKeysExhaustedError';
    this.role = role;
    this.provider = provider;
    this.attempts = attempts;
  }
}

function summarize(error: unknown): string {
  return error instanceof Error ? (error.message.split('\n')[0] ?? error.message) : String(error);
}

const KEY_FAILURE_PATTERN =
  /\bquota\b|rate.?limit|too many requests|\b(401|403|429)\b|invalid[_ ]api[_ ]key|unauthorized|permission denied|forbidden|resource_exhausted/i;

/**
 * Whether a failure looks like the KEY is the problem — expired, revoked,
 * rate-limited, or out of quota — as opposed to the request or the model's
 * own capability (a malformed prompt, a model that cannot emit
 * schema-constrained JSON). Only the former is worth rotating for: rotating
 * on the latter would just spend another key's quota on a call that was never
 * going to succeed, and would mask which model actually failed.
 *
 * `generateStructured` wraps whatever it catches in a new `Error` with the
 * original as `cause`, so both the direct SDK error and the wrapped one are
 * checked — this runs on both the raw `doctor` probe and every
 * `generateStructuredForModel` call.
 */
export function isKeyExhaustedError(error: unknown): boolean {
  const cause = error instanceof Error ? error.cause : undefined;
  const apiError = APICallError.isInstance(error)
    ? error
    : APICallError.isInstance(cause)
      ? cause
      : undefined;
  if (apiError?.statusCode === 401 || apiError?.statusCode === 403 || apiError?.statusCode === 429) {
    return true;
  }
  return KEY_FAILURE_PATTERN.test(error instanceof Error ? error.message : String(error));
}

type ModelBuilder = (apiKey: string, modelId: string) => LanguageModel;

/**
 * One entry per provider. Each returns a `LanguageModel` — the AI SDK's
 * common denominator — so nothing downstream knows which vendor answered.
 */
const FACTORIES: Record<ProviderName, ModelBuilder> = {
  google: (apiKey, modelId) => createGoogleGenerativeAI({ apiKey })(modelId),
  groq: (apiKey, modelId) => createGroq({ apiKey })(modelId),
  openrouter: (apiKey, modelId) => createOpenRouter({ apiKey })(modelId),
  emmiedev: (apiKey, modelId) =>
    createOpenAICompatible({
      name: 'emmiedev',
      baseURL: 'https://chat.emmiedev.com/v1',
      apiKey,
    })(modelId),
  zai: (apiKey, modelId) =>
    createOpenAICompatible({
      name: 'zai',
      baseURL: 'https://api.z.ai/api/paas/v4',
      apiKey,
    })(modelId),
};

export interface ResolvedModel {
  role: LlmRole;
  provider: ProviderName;
  modelId: string;
  model: LanguageModel;
  /** `provider:modelId`, recorded in proof bundles and reports. Never
   *  includes the key — rotating keys must not change a run's model label. */
  id: string;
  /** Which of the provider's configured keys this model was built from. */
  keyIndex: number;
  /** How many keys are configured for this provider. */
  keyCount: number;
}

export function modelIdFor(entry: RoleConfig): string {
  return `${entry.provider}:${entry.modelId}`;
}

/**
 * Build the model for one role from its `keyIndex`-th configured key
 * (default: the topmost / first-listed one). Throws `MissingApiKeyError` with
 * setup instructions rather than a provider-level auth failure ten seconds
 * later.
 *
 * `builders` is a test-only extension point — `LlmFactory` passes its own
 * injected builders through so key-failover can be exercised with a stub
 * model instead of a real provider SDK. External callers never need it; the
 * real AI SDK factories are the default.
 */
export function createModelForRole(
  role: LlmRole,
  config: WowlidatorConfig,
  keyIndex = 0,
  builders: Record<ProviderName, ModelBuilder> = FACTORIES,
): ResolvedModel {
  const entry = config.roles[role];
  const keys = config.apiKeys[entry.provider] ?? [];
  const apiKey = keys[keyIndex];
  if (apiKey === undefined) throw new MissingApiKeyError(role, entry.provider);

  return {
    role,
    provider: entry.provider,
    modelId: entry.modelId,
    model: builders[entry.provider](apiKey, entry.modelId),
    id: modelIdFor(entry),
    keyIndex,
    keyCount: keys.length,
  };
}

/**
 * Lazily resolves and caches one model per role, with automatic key failover.
 *
 * Construction is deferred so the CLI can start, parse a flow, and connect to
 * a browser without any provider key present — only a role that actually runs
 * pays the key requirement.
 *
 * A provider can have more than one key configured (comma-separated in its
 * env var). The active key per provider starts at index 0 — the topmost /
 * first-listed one — and only moves forward, via `callWithFailover`, when a
 * call actually fails in a way that looks like the key rather than the
 * request. The move is sticky and shared across every role on that provider,
 * so a repair role and a generation role pointed at the same exhausted
 * Google key do not independently rediscover the same dead key.
 */
export class LlmFactory {
  readonly config: WowlidatorConfig;

  readonly #builders: Record<ProviderName, ModelBuilder>;
  readonly #cache = new Map<LlmRole, ResolvedModel>();
  readonly #keyIndex = new Map<ProviderName, number>();

  /**
   * @param builders Test-only. Overrides how a (provider, apiKey, modelId)
   *   becomes a `LanguageModel` — lets failover be exercised with a stub
   *   instead of a real provider SDK. Defaults to the real AI SDK factories.
   */
  constructor(
    config: WowlidatorConfig = loadConfig(),
    builders: Partial<Record<ProviderName, ModelBuilder>> = {},
  ) {
    this.config = config;
    this.#builders = { ...FACTORIES, ...builders };
  }

  /** The key index currently active for a provider — 0 until a failover moves it. */
  activeKeyIndex(provider: ProviderName): number {
    return this.#keyIndex.get(provider) ?? 0;
  }

  /** Resolve (and memoise) the model for a role, at whichever key is currently active. */
  forRole(role: LlmRole): ResolvedModel {
    const provider = this.config.roles[role].provider;
    const idx = this.activeKeyIndex(provider);
    const cached = this.#cache.get(role);
    // A cached entry from before a rotation is stale — rebuild at the new key.
    if (cached && cached.keyIndex === idx) return cached;
    const resolved = createModelForRole(role, this.config, idx, this.#builders);
    this.#cache.set(role, resolved);
    return resolved;
  }

  /** Whether `forRole` would succeed — used to fail fast with a clear message. */
  canResolve(role: LlmRole): boolean {
    return (this.config.apiKeys[this.config.roles[role].provider]?.length ?? 0) > 0;
  }

  get maxRetries(): number {
    return this.config.maxRetries;
  }

  /**
   * Run `attempt` against the role's model, rotating through its provider's
   * configured keys — topmost first — whenever a call fails in a way that
   * looks like the key (auth, quota, rate limit) rather than the request.
   * See `isKeyExhaustedError` for exactly what triggers a rotation.
   *
   * The first attempt starts at whichever key is already active (0, unless an
   * earlier call already rotated it forward). A key that succeeds becomes the
   * active key going forward — for every role sharing that provider, not just
   * this one — so the framework never re-probes a key it already knows is
   * dead.
   *
   * Throws `MissingApiKeyError` if the role has no key at all, the original
   * error unchanged if only one key was tried, or `AllKeysExhaustedError`
   * once every configured key has failed.
   */
  async callWithFailover<T>(
    role: LlmRole,
    attempt: (resolved: ResolvedModel) => Promise<T>,
  ): Promise<T> {
    const provider = this.config.roles[role].provider;
    const keys = this.config.apiKeys[provider] ?? [];
    if (keys.length === 0) throw new MissingApiKeyError(role, provider);

    const tried: { keyIndex: number; error: unknown }[] = [];
    for (let i = this.activeKeyIndex(provider); i < keys.length; i++) {
      const resolved = createModelForRole(role, this.config, i, this.#builders);
      this.#cache.set(role, resolved);
      try {
        const result = await attempt(resolved);
        this.#keyIndex.set(provider, i);
        return result;
      } catch (error) {
        tried.push({ keyIndex: i, error });
        const hasNext = i < keys.length - 1;
        if (!hasNext || !isKeyExhaustedError(error)) {
          throw tried.length > 1 ? new AllKeysExhaustedError(role, provider, tried) : error;
        }
        // The cursor moves even before the next attempt succeeds, so a
        // concurrent call for a different role on the same provider does not
        // waste a request re-discovering the same dead key.
        this.#keyIndex.set(provider, i + 1);
        process.stderr.write(
          `[wowlidator] ${PROVIDER_META[provider].label} key ${i + 1}/${keys.length} for "${role}" ` +
            `looks exhausted (${summarize(error)}) — trying key ${i + 2}/${keys.length}\n`,
        );
      }
    }
    // Unreachable: the loop above always returns or throws before running out.
    throw new AllKeysExhaustedError(role, provider, tried);
  }
}

// --- Structured generation --------------------------------------------------

/** An image the model must read — a diagram photo, a screenshot of a spec. */
export interface StructuredImage {
  data: Uint8Array;
  /** IANA media type, e.g. `image/png`. */
  mediaType: string;
}

export interface StructuredRequest<T> {
  model: LanguageModel;
  /** `provider:modelId`, used to make failures name the model that failed. */
  modelLabel: string;
  schema: z.ZodType<T>;
  system: string;
  prompt: string;
  /**
   * Images sent alongside the prompt, for vision-capable models. A model
   * without vision fails the call with its label in the message — the useful
   * question is which role to repoint, same as every other failure here.
   */
  images?: readonly StructuredImage[] | undefined;
  maxOutputTokens?: number | undefined;
  maxRetries?: number | undefined;
  /** Raw provider request fields, keyed by the provider's registry name. */
  providerOptions?: Record<string, Record<string, unknown>> | undefined;
}

export interface StructuredResponse<T> {
  object: T;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
}

/**
 * One structured-output call, with the failure mode that actually bites on
 * free tiers spelled out: not every free model can emit JSON matching a
 * schema, and when one can't, the error should say which model and which role
 * rather than surfacing a bare parse failure.
 */
/**
 * How many times a *generation* failure is worth re-asking.
 *
 * The AI SDK's own `maxRetries` covers transport: a 429 or a 500 is retried,
 * which is why a rate limit reports "Failed after 3 attempts". It does not
 * retry a response that arrived intact and was simply wrong — a truncated
 * object, unparseable text, a shape zod rejects — because from the SDK's
 * position those are indistinguishable from a model that can never comply.
 *
 * From here they are distinguishable, because the rate is measurable: on
 * glm-4.7-flash the generator succeeds about four times in five, so a failure
 * is overwhelmingly a bad roll rather than a model that cannot do this at all.
 * Two extra attempts take a ~21% call failure rate to roughly 1%. A model that
 * genuinely cannot comply still fails — three times, and then with the same
 * message it gives now.
 */
const RECOVERABLE_ATTEMPTS = 3;

/**
 * Exhausted re-ask cycles before a model's structured output is declared
 * broken for this process. One cycle can be a bad roll (~20% on some free
 * tiers); two full cycles — six unusable answers running — is a model that
 * cannot do this, and every further ask would spend three calls and their
 * timeouts to learn it again. Tripping the breaker converts that repeating
 * cost into one immediate, clearly-worded SYSTEM failure.
 */
const BREAKER_TRIPS = 2;
const exhaustedCycles = new Map<string, number>();

/** Test seam: the breaker is process-wide state. */
export function resetStructuredBreaker(): void {
  exhaustedCycles.clear();
}

/**
 * A model that cannot produce schema-valid output — a fact about the
 * *machinery*, never about the application under test. Typed so every
 * consumer can classify it as an environment/system failure: the CLI exits
 * `EXIT.environment`, the healer records unavailability, and nothing files
 * an application defect over it.
 */
export class StructuredOutputUnavailableError extends Error {
  readonly modelLabel: string;

  constructor(message: string, modelLabel: string, cause?: unknown) {
    super(message);
    this.name = 'StructuredOutputUnavailableError';
    this.modelLabel = modelLabel;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Whether the model answered, badly, in a way that re-asking might fix.
 *
 * Deliberately narrow: only `NoObjectGeneratedError`, which is what the SDK
 * raises once a response has come back and failed to become an object. A
 * transport error is already retried a layer down, and a key failure must
 * rotate rather than repeat — re-asking there would just spend another call on
 * something that was never going to work, which is the same reason
 * `isKeyExhaustedError` exists.
 */
function worthReasking(error: unknown): boolean {
  return NoObjectGeneratedError.isInstance(error) && !isKeyExhaustedError(error);
}

export async function generateStructured<T>(
  request: StructuredRequest<T>,
): Promise<StructuredResponse<T>> {
  // Breaker first: a model that has already burned the full re-ask budget
  // twice does not get a third chance per call site — it gets one immediate
  // system failure, and the run's report says which role to repoint.
  const tripped = exhaustedCycles.get(request.modelLabel) ?? 0;
  if (tripped >= BREAKER_TRIPS) {
    throw new StructuredOutputUnavailableError(
      `${request.modelLabel} structured-output circuit is open: it returned unusable ` +
        `objects through ${tripped} full re-ask cycles this session. This is a SYSTEM ` +
        `failure (the model, not the application). Point the role at a model that can ` +
        `do JSON-schema output — run \`wowlidator doctor\`, or set the role's ` +
        `WOWLIDATOR_*_PROVIDER / WOWLIDATOR_*_MODEL.`,
      request.modelLabel,
    );
  }

  let last: unknown;
  for (let attempt = 1; attempt <= RECOVERABLE_ATTEMPTS; attempt++) {
    try {
      const response = await attemptStructured(request);
      // A success halves the count rather than clearing it: one good roll
      // from a mostly-broken model must not reset the evidence against it.
      const seen = exhaustedCycles.get(request.modelLabel) ?? 0;
      if (seen > 0) exhaustedCycles.set(request.modelLabel, seen - 1);
      return response;
    } catch (error) {
      last = error;
      if (attempt === RECOVERABLE_ATTEMPTS || !worthReasking(error)) break;
      // Same channel as key rotation: a run's output should say what it spent
      // and why, rather than a retry being invisible in the token count.
      process.stderr.write(
        `[wowlidator] ${request.modelLabel} returned an unusable object ` +
          `(${summarize(error)}) — re-asking, attempt ${attempt + 1}/${RECOVERABLE_ATTEMPTS}\n`,
      );
    }
  }
  if (worthReasking(last)) {
    exhaustedCycles.set(request.modelLabel, (exhaustedCycles.get(request.modelLabel) ?? 0) + 1);
  }
  throw describeStructuredFailure(request, last);
}

function describeStructuredFailure<T>(request: StructuredRequest<T>, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  // The capability advice is wrong for a key failure, and actively
  // misleading: "try a different model id" sends someone changing config
  // when the model was fine and the call was rate-limited. Those failures
  // already rotate keys on their own — see `isKeyExhaustedError`.
  const advice = isKeyExhaustedError(error)
    ? 'This looks like the key rather than the model — rate limit, quota, or ' +
      'an expired credential. Retry, or add a second key to rotate into.'
    : `Not every free-tier model supports JSON-schema output, and this one failed ` +
      `${RECOVERABLE_ATTEMPTS} times running. Try a different model id for this role, ` +
      'or point the role at another provider.';
  return new StructuredOutputUnavailableError(
    `${request.modelLabel} failed to produce a valid structured response: ${detail}\n` +
      describeGenerationFailure(error) +
      advice,
    request.modelLabel,
    error,
  );
}

async function attemptStructured<T>(
  request: StructuredRequest<T>,
): Promise<StructuredResponse<T>> {
  {
    const result = await generateObject({
      model: request.model,
      schema: request.schema,
      system: request.system,
      // With images the prompt travels as a text part beside them — the SDK
      // takes `prompt` or `messages`, never both.
      ...(request.images?.length
        ? {
            messages: [
              {
                role: 'user' as const,
                content: [
                  { type: 'text' as const, text: request.prompt },
                  ...request.images.map((image) => ({
                    type: 'file' as const,
                    data: image.data,
                    mediaType: image.mediaType,
                  })),
                ],
              },
            ],
          }
        : { prompt: request.prompt }),
      // Zero, explicitly, for every structured call. Nothing here is creative
      // writing: a healer repairing a selector, an author turning a claim
      // into steps, an agent picking one action — each has a most-likely
      // right answer, and sampling around it is where run-to-run
      // inconsistency came from (the same claim authored as 25 steps one run
      // and 29 the next, with different invented roles). Providers that
      // reject the parameter fall back on their own default via retry
      // machinery; none of the current five do.
      temperature: 0,
      maxOutputTokens: request.maxOutputTokens ?? 4096,
      maxRetries: request.maxRetries ?? 2,
      ...(request.providerOptions === undefined
        ? {}
        : { providerOptions: request.providerOptions as never }),
    });

    return {
      object: result.object,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    };
  }
}

/**
 * What actually came back when a structured call failed — the difference
 * between "the model can't do JSON" and "the model was cut off mid-thought".
 *
 * "No object generated: the model did not return a response" hides three very
 * different causes: a reasoning model that spent the whole output budget (or
 * the server's own completion ceiling) thinking and emitted nothing (`length`
 * with empty text), a model that wrapped the JSON in prose (text present but
 * unparseable), and a provider that errored outright. The evidence is on the
 * error object the SDK throws; this puts it in the message a person reads.
 */
function describeGenerationFailure(error: unknown): string {
  const source = evidenceBearer(error);
  const zod = findInChain(error, (x) => x?.name === 'ZodError');
  const e = source as {
    finishReason?: unknown;
    usage?: { outputTokens?: unknown };
    text?: unknown;
  };
  const parts: string[] = [];
  if (typeof e?.finishReason === 'string') parts.push(`finish=${e.finishReason}`);
  const out = e?.usage?.outputTokens;
  if (typeof out === 'number') parts.push(`outputTokens=${out}`);
  if (typeof e?.text === 'string') {
    parts.push(
      e.text === ''
        ? 'model text was empty — likely all output budget went to hidden reasoning'
        : echoedTheSchema(e.text)
          ? 'the model replied with the JSON *schema* instead of an instance of it ' +
            '(its answers are inside "const" fields) — see promptSchemaInstruction'
          : `model text began: ${JSON.stringify(e.text.slice(0, 160))}`,
    );
  }
  // Which fields the model actually got wrong. Without this a schema mismatch
  // reads as "response did not match schema" and nothing else — the failure
  // that sent someone reproducing this by hand rather than reading the error.
  const issues = (zod as { issues?: { path?: unknown[]; code?: unknown }[] } | undefined)?.issues;
  if (Array.isArray(issues) && issues.length > 0) {
    const named = [
      ...new Set(
        issues.map((issue) => {
          const path = (issue.path ?? []).filter((p) => typeof p === 'string').join('.');
          return `${path === '' ? '(root)' : path}: ${String(issue.code)}`;
        }),
      ),
    ];
    parts.push(`rejected ${named.slice(0, 5).join(', ')}`);
  }
  return parts.length === 0 ? '' : `  (${parts.join(', ')})\n`;
}

/** Walk an error's `cause` chain, cycle-safe. */
function findInChain(
  error: unknown,
  match: (candidate: { name?: unknown } | undefined) => boolean,
): unknown {
  const seen = new Set<unknown>();
  let node: unknown = error;
  while (node !== undefined && node !== null && !seen.has(node)) {
    seen.add(node);
    if (match(node as { name?: unknown })) return node;
    node = (node as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * The link in the chain that actually carries what the model said.
 *
 * This used to unwrap `cause` exactly once, which is right for a JSON parse
 * failure and wrong for a schema mismatch: `NoObjectGeneratedError` holds
 * `text`, `finishReason` and `usage` *itself*, and its cause is a
 * `TypeValidationError` that holds none of them. So the one failure mode
 * someone most needs evidence for — "response did not match schema" — was the
 * one that printed nothing at all. Take the first link that has the evidence,
 * whichever depth it sits at.
 */
function evidenceBearer(error: unknown): unknown {
  const bearer = findInChain(error, (candidate) => {
    const c = candidate as { text?: unknown; finishReason?: unknown } | undefined;
    return typeof c?.text === 'string' || typeof c?.finishReason === 'string';
  });
  return bearer ?? error;
}

/**
 * Whether the model answered with the schema rather than with data.
 *
 * A distinctive failure and an opaque one — zod reports every field as
 * `undefined`, which reads like a model that cannot emit JSON at all. Naming
 * it costs one parse of text we already have, and points at the one function
 * that fixes it. Deliberately narrow: a *real* instance would have to carry
 * both `properties` and one of the other schema keywords at the top level to
 * be mistaken for one.
 */
function echoedTheSchema(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
    const keys = new Set(Object.keys(parsed));
    return keys.has('properties') && (keys.has('$schema') || keys.has('type') || keys.has('required'));
  } catch {
    return false;
  }
}

/** Where a structured request gets its model from. */
export type ModelSource = { factory: LlmFactory; role: LlmRole } | { model: LanguageModel };

/**
 * Run one structured-output request against a model source.
 *
 * A factory-backed source gets automatic key failover via
 * `LlmFactory.callWithFailover` — this is how every `Llm*Model` class picks
 * up rotation without knowing it exists. An explicit model (used by tests and
 * by embedders that construct their own `LanguageModel`) is called directly:
 * there is no factory, and therefore nothing to fail over into.
 */
/**
 * Providers whose models bill hidden reasoning tokens against the same
 * output budget as the answer.
 *
 * Every `maxOutputTokens` in this codebase was sized for *visible* output —
 * 256 for a data value, 1024 for a repair. A reasoning model (EmmieDev's
 * `small` spends ~340 completion tokens to say "hello") burns those budgets
 * thinking, hits the cap mid-thought, and returns empty content — surfacing
 * as "No object generated: the model did not return a response", an error
 * that reads like a broken provider rather than a starved one. The floor
 * leaves the thinking room; a model that needs less simply stops sooner and
 * never bills the difference.
 */
const REASONING_OUTPUT_FLOOR: Partial<Record<ProviderName, number>> = {
  emmiedev: 16_384,
  // z.ai is deliberately absent. The floor was here because GLM models think
  // by default and that thinking bills against `max_tokens` — but
  // `withPromptSchema` now sends `thinking: { type: 'disabled' }` for z.ai, and
  // the measured `reasoningTokens` is 0. With the premise gone the floor only
  // buys a runaway generation more rope: seen live, a request for 3 test cases
  // ran to 16,384 tokens and 129KB of JSON before truncating mid-string, when
  // the generator's own 8,192 budget would have stopped it at half the cost.
  // Truncation is handled by retrying (see `RECOVERABLE_ATTEMPTS`); this only
  // decides how much is spent discovering it.
  // Gemini flash models think by default too, and thinking spends from the
  // same maxOutputTokens budget as the answer. Seen live on gemini-3.5-flash:
  // a generator call producing valid JSON that stopped mid-object — "No
  // object generated: could not parse the response" with the text visibly
  // truncated. The floor leaves the thinking room; non-thinking Gemini models
  // simply never use it.
  google: 16_384,
};

/**
 * Providers whose models never see a JSON schema unless we put it in the
 * prompt ourselves.
 *
 * `generateObject` delivers the schema through the provider's structured
 * output channel (`response_format: json_schema`). A plain OpenAI-compatible
 * endpoint has no such channel, and the SDK then sends the request with **no
 * schema in it at all** — the model returns fluent JSON in whatever shape it
 * invents, and every call fails validation with "response did not match
 * schema". Measured against z.ai's glm-4.5-flash: 0/3 with the bare request,
 * 3/3 with the schema stated in the system prompt. `json_object` mode is
 * requested alongside (both endpoints accept it; z.ai enforces it) so the
 * reply cannot be prose-wrapped.
 *
 * **How that instruction is worded is itself load-bearing — see
 * `promptSchemaInstruction`.**
 */
const SCHEMA_IN_PROMPT_PROVIDERS: ReadonlySet<ProviderName> = new Set(['emmiedev', 'zai']);

/**
 * Silence the one AI SDK warning this codebase makes untrue.
 *
 * For the providers above, every structured call triggers "The feature
 * \"responseFormat\" is not supported" — the SDK saying it could not deliver
 * the schema through the provider's structured-output channel. True, and
 * handled: `withPromptSchema` puts the schema in the prompt and requests
 * `json_object` mode itself, so the warning describes a problem that no
 * longer exists, once per call, on stderr, forever. Every other warning
 * still logs — this filters, it does not switch the system off (setting the
 * global to `false` would).
 */
type SdkWarning = { type?: string; feature?: string };
(globalThis as { AI_SDK_LOG_WARNINGS?: unknown }).AI_SDK_LOG_WARNINGS = (options: {
  warnings: SdkWarning[];
  provider?: string;
  model?: string;
}): void => {
  const spurious = (w: SdkWarning) =>
    w.type === 'unsupported' &&
    w.feature === 'responseFormat' &&
    options.provider !== undefined &&
    (SCHEMA_IN_PROMPT_PROVIDERS as ReadonlySet<string>).has(options.provider.split('.')[0] ?? '');
  for (const warning of options.warnings) {
    if (spurious(warning)) continue;
    const scope = options.provider ? ` (${options.provider} / ${options.model ?? '?'})` : '';
    console.warn(`AI SDK Warning${scope}: ${JSON.stringify(warning)}`);
  }
};

/**
 * How to ask for an *instance* of a schema without being handed the schema.
 *
 * The obvious wording — "respond with a JSON object that matches this JSON
 * schema exactly" — is ambiguous, and GLM 4.7 reads it the wrong way: it
 * replies with the schema itself, answers tucked into `const` fields, like
 * this:
 *
 * ```json
 * {"$schema":"…","type":"object","properties":{
 *    "name":{"type":"string","const":"Verify successful login"}, …}}
 * ```
 *
 * That is valid JSON, so `json_object` mode is satisfied and nothing catches
 * it until zod rejects every field as `undefined` — surfacing as
 * "No object generated: response did not match schema", which reads like a
 * model that cannot do structured output at all. It can; it answered the
 * wrong question.
 *
 * Two things provoke it, and the fix addresses both:
 *
 * - **Nesting.** The failure tracks schema shape, not model quality. Measured
 *   on glm-4.7-flash: the healer's flat four-key object came back correct 4/4
 *   with the old wording, while the generator's `steps: array of objects`
 *   managed **3/8**. A nested schema simply looks more like a document to
 *   reproduce.
 * - **`$schema`.** `z.toJSONSchema` emits a `$schema` key, which is a strong
 *   hint that the thing being shown is a document worth echoing. It is
 *   dropped: nothing downstream reads it, and the model is being told what
 *   this is in prose anyway.
 *
 * The replacement names the distinction outright and lists the keywords a
 * schema echo would contain, so the failure is ruled out by the instruction
 * rather than hoped against. Same measurement, same prompts, same model:
 * **8/8**.
 */
export function promptSchemaInstruction(schema: z.ZodType): string {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json['$schema'];
  return (
    'Reply with one JSON object and nothing else — no prose, no markdown fences.\n' +
    'Your reply must be DATA described by the JSON Schema below, never the schema itself. ' +
    'Do not emit the keys "$schema", "type", "properties", "items", "required" or "const"; ' +
    'emit the keys the schema names under "properties", with values of the types it gives.' +
    `\n\nJSON Schema:\n${JSON.stringify(json)}`
  );
}

/** The request rewritten for a provider that needs the schema in the prompt. */
function withPromptSchema<T>(
  request: Omit<StructuredRequest<T>, 'model'>,
  provider: ProviderName,
): Omit<StructuredRequest<T>, 'model'> {
  if (!SCHEMA_IN_PROMPT_PROVIDERS.has(provider)) return request;
  return {
    ...request,
    system: `${request.system}\n\n${promptSchemaInstruction(request.schema as z.ZodType)}`,
    providerOptions: {
      [provider]: {
        response_format: { type: 'json_object' },
        // GLM models think before every answer, and on the free tier that
        // thinking is both slow to produce and billed as output — measured
        // ~340 hidden tokens and 18s to say "ok", 2 tokens and 7s without.
        // Structured schema-following measured 3/3 either way, so the
        // thinking is pure cost here. z.ai-only: other providers don't know
        // the field.
        ...(provider === 'zai' ? { thinking: { type: 'disabled' } } : {}),
      },
    },
  };
}

export async function generateStructuredForModel<T>(
  source: ModelSource,
  request: Omit<StructuredRequest<T>, 'model'>,
): Promise<StructuredResponse<T>> {
  if ('model' in source) {
    return generateStructured({ ...request, model: source.model });
  }
  return source.factory.callWithFailover(source.role, (resolved) => {
    const floor = REASONING_OUTPUT_FLOOR[resolved.provider];
    const maxOutputTokens =
      floor === undefined
        ? request.maxOutputTokens
        : Math.max(request.maxOutputTokens ?? 0, floor);
    const adapted = withPromptSchema({ ...request, maxOutputTokens }, resolved.provider);
    return generateStructured({ ...adapted, model: resolved.model });
  });
}
