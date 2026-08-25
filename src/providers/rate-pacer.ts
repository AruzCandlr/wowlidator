/**
 * Pacing for a provider that meters by the minute and by the day — Google AI
 * Studio's free tier, concretely: requests per minute (RPM), tokens per
 * minute (TPM) and requests per day (RPD), per model, per key.
 *
 * **There is no endpoint that says what a key's limits are.** The Gemini API
 * sends no `x-ratelimit-*` headers and has no quota-lookup call; the limits
 * are published per model and tier, and the only time the API states one is
 * in a 429 body — `QuotaFailure.violations[].quotaValue` names the ceiling
 * that was hit and `RetryInfo.retryDelay` says how long to wait. So this
 * module works from three sources, in order of trust:
 *
 * 1. **What a 429 said** (`learnFrom`): the `quotaValue` for the metric that
 *    tripped overrides the table, and `retryDelay` is obeyed to the second.
 * 2. **`WOWLIDATOR_GOOGLE_RPM` / `_TPM` / `_RPD`** — the person's own tier.
 * 3. **`GOOGLE_FREE_TIER_LIMITS`** — the documented free-tier numbers, which
 *    drift the way model ids do. Treat them as a starting point.
 *
 * The pacer counts what THIS process (and, for the day, every process that
 * shares `.wowlidator/llm-usage.json`) has sent, and `reserve()` waits before
 * a call that would cross `PACER_HEADROOM` of a limit — arriving under a
 * limit costs seconds; arriving over it costs a 429, the SDK's retries, and a
 * key rotation that spends the next key on the same minute. Day counts are
 * persisted because a catalog is many CLI processes spawned by the panel,
 * each of which would otherwise start its RPD from zero.
 *
 * Accounting is per `(key, model)`: Google meters per project per model, and
 * a key is the nearest thing to a project this codebase can see.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { logLlmLine } from './llm-log.js';

export interface RateLimits {
  rpm: number | null;
  tpm: number | null;
  rpd: number | null;
}

/**
 * Documented Google AI Studio free-tier limits, per model. Unknown ids fall
 * back to `GOOGLE_FREE_TIER_DEFAULT`. Verified 2026-08 — expect drift.
 */
export const GOOGLE_FREE_TIER_LIMITS: Readonly<Record<string, RateLimits>> = {
  'gemini-2.5-pro': { rpm: 5, tpm: 250_000, rpd: 100 },
  'gemini-2.5-flash': { rpm: 10, tpm: 250_000, rpd: 250 },
  'gemini-2.5-flash-lite': { rpm: 15, tpm: 250_000, rpd: 1000 },
  'gemini-3-flash-preview': { rpm: 10, tpm: 250_000, rpd: 250 },
  'gemini-3.1-flash-lite': { rpm: 15, tpm: 250_000, rpd: 1000 },
};
export const GOOGLE_FREE_TIER_DEFAULT: RateLimits = { rpm: 10, tpm: 250_000, rpd: 250 };

/** Fraction of a limit the pacer will fill before waiting. */
export const PACER_HEADROOM = 0.9;
/** The longest a single `reserve()` or 429 wait may be before giving up on waiting. */
export const PACER_MAX_WAIT_MS = 90_000;
/** Characters per token, for the estimate a reservation is made on. */
const CHARS_PER_TOKEN = 4;

const MINUTE_MS = 60_000;

export function googleLimitsFor(modelId: string, env: NodeJS.ProcessEnv = process.env): RateLimits {
  const table = GOOGLE_FREE_TIER_LIMITS[modelId] ?? GOOGLE_FREE_TIER_DEFAULT;
  const num = (name: string): number | null => {
    const raw = env[name]?.trim();
    if (raw === undefined || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
  };
  return {
    rpm: num('WOWLIDATOR_GOOGLE_RPM') ?? table.rpm,
    tpm: num('WOWLIDATOR_GOOGLE_TPM') ?? table.tpm,
    rpd: num('WOWLIDATOR_GOOGLE_RPD') ?? table.rpd,
  };
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** What a Google 429 body states, when it states anything. */
export interface RateLimitNotice {
  /** Seconds the server asked us to wait, or null. */
  retryAfterS: number | null;
  /** Which limit tripped, when the quota metric names one. */
  metric: 'rpm' | 'tpm' | 'rpd' | null;
  /** The ceiling the server named for it, or null. */
  quotaValue: number | null;
}

/**
 * Read `retryDelay` and the `QuotaFailure` violation out of a 429 — from the
 * JSON body when the SDK kept it, from the message otherwise (the SDK folds
 * the body into the message for Google errors).
 */
export function parseRateLimitNotice(error: unknown): RateLimitNotice {
  const notice: RateLimitNotice = { retryAfterS: null, metric: null, quotaValue: null };
  const e = error as { responseBody?: unknown; message?: unknown; cause?: unknown } | undefined;
  const texts = [e?.responseBody, e?.message, (e?.cause as { responseBody?: unknown } | undefined)?.responseBody]
    .filter((t): t is string => typeof t === 'string');
  for (const text of texts) {
    const delay = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(text) ?? /retry(?:\s|-)?(?:after|in)\s+(\d+(?:\.\d+)?)\s*s/i.exec(text);
    if (delay && notice.retryAfterS === null) notice.retryAfterS = Math.ceil(Number(delay[1]));
    const quota = /"quotaId"\s*:\s*"([^"]+)"[\s\S]*?"quotaValue"\s*:\s*"(\d+)"/.exec(text)
      ?? /"quotaMetric"\s*:\s*"([^"]+)"[\s\S]*?"quotaValue"\s*:\s*"(\d+)"/.exec(text);
    if (quota && notice.metric === null) {
      const id = quota[1]!.toLowerCase();
      notice.metric = /perday|per_day|daily/.test(id) ? 'rpd'
        : /token|input_token/.test(id) ? 'tpm'
          : /request/.test(id) ? 'rpm' : null;
      notice.quotaValue = Number(quota[2]);
    }
  }
  const headers = (e as { responseHeaders?: Record<string, string> } | undefined)?.responseHeaders;
  if (notice.retryAfterS === null && headers) {
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === 'retry-after' && /^\d+$/.test(v.trim())) notice.retryAfterS = Number(v.trim());
    }
  }
  return notice;
}

interface Sample {
  at: number;
  tokens: number;
}

interface PersistedDay {
  /** `YYYY-MM-DD` in UTC — Google's day resets at midnight Pacific, which this
   *  does not track; UTC is conservative by up to 7 hours. */
  day: string;
  requests: number;
  tokens: number;
}

type Persisted = Record<string, PersistedDay>;

export interface PacerSnapshot {
  limits: RateLimits;
  minute: { requests: number; tokens: number };
  day: { requests: number; tokens: number };
}

/**
 * One pacer per (key, model). `reserve()` before a call, `record()` after it
 * with the real usage, `learnFrom()` on a 429.
 */
export class RatePacer {
  readonly id: string;
  limits: RateLimits;
  readonly #minute: Sample[] = [];
  #day: PersistedDay;
  #blockedUntil = 0;
  #reserved = 0;
  /** Set only by a 429 whose quota metric is the DAY's — the table never sets it. */
  #dayBlocked = false;
  #warnedDay = false;
  readonly #store: string | null;
  readonly #now: () => number;
  readonly #log: (line: string) => void;

  constructor(
    id: string,
    limits: RateLimits,
    options: { store?: string | null; now?: () => number; log?: (line: string) => void } = {},
  ) {
    this.id = id;
    this.limits = limits;
    this.#store = options.store === undefined ? null : options.store;
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? logLlmLine;
    this.#day = { day: this.#today(), requests: 0, tokens: 0 };
  }

  #today(): string {
    return new Date(this.#now()).toISOString().slice(0, 10);
  }

  /** Load the day's counts from the shared file, if there is one. Never throws. */
  async load(): Promise<void> {
    if (this.#store === null) return;
    try {
      const data = JSON.parse(await readFile(this.#store, 'utf8')) as Persisted;
      const saved = data[this.id];
      if (saved && saved.day === this.#today()) this.#day = { ...saved };
    } catch {
      /* no file yet, or unreadable — start the day from what this process sees */
    }
  }

  async #save(): Promise<void> {
    if (this.#store === null) return;
    try {
      await mkdir(dirname(this.#store), { recursive: true });
      let data: Persisted = {};
      try {
        data = JSON.parse(await readFile(this.#store, 'utf8')) as Persisted;
      } catch {
        data = {};
      }
      const existing = data[this.id];
      // Another process may have counted since we loaded: keep the larger of
      // the two for today rather than overwriting its count with ours.
      const merged: PersistedDay =
        existing && existing.day === this.#day.day
          ? {
              day: this.#day.day,
              requests: Math.max(existing.requests, this.#day.requests),
              tokens: Math.max(existing.tokens, this.#day.tokens),
            }
          : this.#day;
      data[this.id] = merged;
      const temp = `${this.#store}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(data, null, 2), 'utf8');
      await rename(temp, this.#store);
    } catch {
      /* accounting is advisory; a write failure must never fail a call */
    }
  }

  #prune(): void {
    const cutoff = this.#now() - MINUTE_MS;
    while (this.#minute.length > 0 && this.#minute[0]!.at <= cutoff) this.#minute.shift();
    if (this.#day.day !== this.#today()) this.#day = { day: this.#today(), requests: 0, tokens: 0 };
  }

  snapshot(): PacerSnapshot {
    this.#prune();
    return {
      limits: this.limits,
      minute: {
        requests: this.#minute.length + this.#reserved,
        tokens: this.#minute.reduce((s, x) => s + x.tokens, 0),
      },
      day: { requests: this.#day.requests, tokens: this.#day.tokens },
    };
  }

  /**
   * How long a call of `estTokens` should wait before it is sent, in ms. Zero
   * when it fits. `Infinity` when the DAY is spent — waiting for midnight is
   * not something a run should do silently.
   */
  waitFor(estTokens: number): number {
    this.#prune();
    const now = this.#now();
    let wait = Math.max(0, this.#blockedUntil - now);
    const { rpm, tpm, rpd } = this.limits;
    // The day's ceiling from the table or the environment is a GUESS about a
    // tier, and a guess must never refuse work: live, a model id missing
    // from the table fell back to 250 RPD on a 500-RPD tier, and seventy
    // cases of a catalog were blocked by this file, not by Google. So the
    // day ends only when the server's own 429 names the daily metric
    // (`learnFrom`); the table's number is announced once and then advisory.
    if (this.#dayBlocked) return Infinity;
    if (rpd !== null && !this.#warnedDay && this.#day.requests >= Math.floor(rpd * PACER_HEADROOM)) {
      this.#warnedDay = true;
      this.#log(
        `${this.id}: ${this.#day.requests} requests today, past ${PACER_HEADROOM * 100}% of the ${rpd} RPD this tier is believed to have — ` +
          `continuing; only a 429 from the server naming the daily quota ends the day (set WOWLIDATOR_GOOGLE_RPD to state your tier)`,
      );
    }
    const inMinute = this.#minute.length + this.#reserved;
    if (rpm !== null && inMinute >= Math.floor(rpm * PACER_HEADROOM)) {
      const oldest = this.#minute[0];
      wait = Math.max(wait, oldest ? oldest.at + MINUTE_MS - now + 50 : 1000);
    }
    if (tpm !== null) {
      let tokens = this.#minute.reduce((s, x) => s + x.tokens, 0) + estTokens;
      let i = 0;
      while (tokens > tpm * PACER_HEADROOM && i < this.#minute.length) {
        tokens -= this.#minute[i]!.tokens;
        wait = Math.max(wait, this.#minute[i]!.at + MINUTE_MS - now + 50);
        i++;
      }
    }
    return wait;
  }

  /**
   * Wait until the call fits, then hold a request slot for it. Resolves with
   * the ms waited. Throws `RateBudgetExhaustedError` when the day is spent or
   * a single wait would exceed `PACER_MAX_WAIT_MS`.
   */
  async reserve(estTokens: number, task: string): Promise<number> {
    let waited = 0;
    for (;;) {
      const wait = this.waitFor(estTokens);
      if (wait === Infinity) {
        throw new RateBudgetExhaustedError(
          `${this.id}: the server said the day's request quota (${this.limits.rpd ?? '?'} RPD) is spent ` +
            `— wait for the reset or start on another key.`,
        );
      }
      if (wait <= 0) break;
      if (wait > PACER_MAX_WAIT_MS) {
        throw new RateBudgetExhaustedError(
          `${this.id}: ${task} would have to wait ${Math.round(wait / 1000)}s for rate-limit headroom (limit ${PACER_MAX_WAIT_MS / 1000}s).`,
        );
      }
      const snap = this.snapshot();
      this.#log(
        `${task}: pacing ${Math.round(wait / 1000)}s — ${this.id} at ${snap.minute.requests}/${this.limits.rpm ?? '∞'} RPM, ` +
          `${snap.minute.tokens}/${this.limits.tpm ?? '∞'} TPM, ${snap.day.requests}/${this.limits.rpd ?? '∞'} RPD`,
      );
      await new Promise((r) => setTimeout(r, wait));
      waited += wait;
    }
    this.#reserved++;
    return waited;
  }

  /** The call went out: replace the reservation with what it actually used. */
  record(usage: { inputTokens?: number | undefined; outputTokens?: number | undefined }, estTokens: number): void {
    this.#reserved = Math.max(0, this.#reserved - 1);
    const tokens = (usage.inputTokens ?? estTokens) + (usage.outputTokens ?? 0);
    this.#minute.push({ at: this.#now(), tokens });
    this.#prune();
    this.#day.requests++;
    this.#day.tokens += tokens;
    void this.#save();
  }

  /** The call failed before it could be counted as used. */
  release(): void {
    this.#reserved = Math.max(0, this.#reserved - 1);
  }

  /**
   * A 429 happened: block until the server's `retryDelay`, and take the
   * ceiling it named as the truth over the table. Returns the ms to wait.
   */
  learnFrom(error: unknown, task: string): number {
    const notice = parseRateLimitNotice(error);
    if (notice.metric !== null && notice.quotaValue !== null && notice.quotaValue > 0) {
      if (this.limits[notice.metric] !== notice.quotaValue) {
        this.#log(`${task}: ${this.id} ${notice.metric.toUpperCase()} is ${notice.quotaValue} (the server said so); was ${this.limits[notice.metric] ?? '∞'}`);
        this.limits = { ...this.limits, [notice.metric]: notice.quotaValue };
      }
      if (notice.metric === 'rpd') {
        this.#day.requests = Math.max(this.#day.requests, notice.quotaValue);
        this.#dayBlocked = true;
      }
    }
    // A 429 with no stated delay: the minute is what is full, so wait it out
    // from the oldest sample; with no samples (another process spent it), a
    // flat 20 s is the measured recovery on this tier.
    const delayMs =
      notice.retryAfterS !== null
        ? notice.retryAfterS * 1000 + 250
        : this.#minute.length > 0
          ? Math.max(1000, this.#minute[0]!.at + MINUTE_MS - this.#now() + 250)
          : 20_000;
    this.#blockedUntil = Math.max(this.#blockedUntil, this.#now() + delayMs);
    return delayMs;
  }
}

export class RateBudgetExhaustedError extends Error {}

/** Providers the pacer meters. Others have headers or no published minute quota. */
export const PACED_PROVIDERS: ReadonlySet<string> = new Set(['google']);

const pacers = new Map<string, RatePacer>();

/** Default store: beside the proof bundles and the cache, per working directory. */
function defaultUsageStore(): string {
  return join(process.cwd(), '.wowlidator', 'llm-usage.json');
}

/**
 * The pacer for one (key, model). Keyed on the key's tail, never the key: the
 * id lands in log lines and in the usage file.
 */
export async function pacerFor(
  provider: string,
  apiKey: string,
  modelId: string,
  options: { store?: string | null; env?: NodeJS.ProcessEnv } = {},
): Promise<RatePacer> {
  const tail = apiKey.length > 4 ? apiKey.slice(-4) : '****';
  const id = `${provider}:${modelId}@…${tail}`;
  let pacer = pacers.get(id);
  if (pacer === undefined) {
    // `WOWLIDATOR_LLM_USAGE_STORE=off` keeps the day count in memory only —
    // the test suite sets it, so a mock 429 never lands in the real file.
    const env = options.env ?? process.env;
    const store =
      options.store !== undefined ? options.store : env['WOWLIDATOR_LLM_USAGE_STORE'] === 'off' ? null : defaultUsageStore();
    pacer = new RatePacer(id, googleLimitsFor(modelId, env), { store });
    await pacer.load();
    pacers.set(id, pacer);
  }
  return pacer;
}

/** Test seam. */
export function resetPacers(): void {
  pacers.clear();
}

export function isRateLimitError(error: unknown): boolean {
  const e = error as { statusCode?: unknown; cause?: { statusCode?: unknown }; message?: unknown } | undefined;
  if (e?.statusCode === 429 || e?.cause?.statusCode === 429) return true;
  const msg = typeof e?.message === 'string' ? e.message : '';
  return /\b429\b|resource_exhausted|rate.?limit|too many requests|exceeded your current quota/i.test(msg);
}
