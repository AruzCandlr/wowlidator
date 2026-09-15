/**
 * What an HTTP API provider says about its own limits, remembered for long
 * enough to stop dispatching into them.
 *
 * `claude-quota.ts` can ASK the account how much of its window is left, and
 * `cli/quota-hold.ts` stops the suite before the window fills. An API key has
 * no such endpoint: the only time a provider states a limit is in the body of
 * the call it just refused. So this module is that reading — a refusal is
 * recorded, and for as long as the provider asked (or a backoff, when it said
 * nothing) the suite treats that provider as closed.
 *
 * What it is for (2026-09-10, a BE catalog on `emmiedev:default` at four
 * lanes): the provider caps a key at TWO calls in flight and answers a third
 * with `{"type":"rate_limit_error","code":"too_many_concurrent"}`. The SDK
 * spent its four attempts inside one authoring call, the row sealed as an
 * authoring refusal — the sticky kind a `--resume` will not pick back up —
 * and the run was killed three minutes later having proved nothing. The
 * concurrency ceiling (`config.providerConcurrency`) is the first half of the
 * answer: never send the third call. This is the second: when a refusal
 * arrives anyway, stop starting new work rather than spending the catalog on
 * refusals.
 *
 * Deliberately NOT a circuit breaker. The breaker in `llm-factory.ts` refuses
 * the CALL, which is what poisons a case mid-flight; this holds DISPATCH and
 * lets everything already in flight finish. A success clears the pressure at
 * once — a limit that has reopened must not cost the rest of the wait.
 */

/** First wait after a refusal the provider gave no delay for. */
export const API_PRESSURE_BASE_MS = 20_000;
/** However many refusals in a row, never hold longer than this. */
export const API_PRESSURE_MAX_MS = 5 * 60_000;

export interface ApiPressureState {
  provider: string;
  /** Epoch ms the hold runs until. */
  until: number;
  /** Consecutive refusals; the backoff doubles on each. */
  refusals: number;
  /** The first line of the provider's own complaint — the only honest wording. */
  reason: string;
  /** True when the delay came from the provider (`retry-after`), not a guess. */
  stated: boolean;
}

const pressure = new Map<string, ApiPressureState>();

/**
 * How long the provider itself asked for, in ms, or null when it said
 * nothing. Reads the two shapes an OpenAI-compatible endpoint uses: the
 * `retry-after` header (seconds, or an HTTP date) and a `retry_after` /
 * `retryDelay` field in the error body.
 */
export function statedRetryMs(error: unknown, now: number = Date.now()): number | null {
  const headers = (error as { responseHeaders?: Record<string, string> } | undefined)?.responseHeaders;
  const header = headers?.['retry-after'] ?? headers?.['Retry-After'];
  if (typeof header === 'string' && header.trim() !== '') {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
    const at = Date.parse(header);
    if (Number.isFinite(at)) return Math.max(0, at - now);
  }
  const body = (error as { responseBody?: unknown } | undefined)?.responseBody;
  if (typeof body === 'string') {
    const match = body.match(/"retry(?:_after|Delay)"\s*:\s*"?(\d+(?:\.\d+)?)(s)?"?/);
    if (match) {
      const value = Number(match[1]);
      if (Number.isFinite(value)) return Math.round(value * 1000);
    }
  }
  return null;
}

/** The provider's own words, cut to one line — never this file's paraphrase. */
function complaint(error: unknown): string {
  const body = (error as { responseBody?: unknown } | undefined)?.responseBody;
  if (typeof body === 'string' && body.trim() !== '') {
    try {
      const parsed = JSON.parse(body) as { error?: { message?: unknown; code?: unknown } };
      const message = parsed.error?.message;
      const code = parsed.error?.code;
      if (typeof message === 'string' && message.trim() !== '') {
        return typeof code === 'string' && code !== '' ? `${message} (${code})` : message;
      }
    } catch {
      // Not JSON: the raw first line is still the provider's own wording.
    }
    return body.split('\n')[0]!.slice(0, 240);
  }
  const text = error instanceof Error ? error.message : String(error);
  return (text.split('\n')[0] ?? text).slice(0, 240);
}

/**
 * Record that `provider` turned a call away. Returns the state, so a caller
 * may log the wait it just bought.
 */
export function noteApiRefusal(
  provider: string,
  error: unknown,
  now: number = Date.now(),
): ApiPressureState {
  const previous = pressure.get(provider);
  const refusals = (previous?.refusals ?? 0) + 1;
  const stated = statedRetryMs(error, now);
  // Exponential in the number of consecutive refusals, because a provider
  // that has just refused twice is not one more second from ready.
  const guessed = Math.min(API_PRESSURE_MAX_MS, API_PRESSURE_BASE_MS * 2 ** (refusals - 1));
  const waitMs = Math.min(API_PRESSURE_MAX_MS, stated ?? guessed);
  const state: ApiPressureState = {
    provider,
    until: now + waitMs,
    refusals,
    reason: complaint(error),
    stated: stated !== null,
  };
  pressure.set(provider, state);
  return state;
}

/**
 * Record that `provider` answered. Clears the hold outright: the limit is
 * demonstrably open, and keeping the wait would cost the run minutes the
 * provider is not asking for.
 */
export function noteApiSuccess(provider: string): void {
  pressure.delete(provider);
}

/** The live hold for one provider, or null when it is not held. */
export function apiPressureFor(provider: string, now: number = Date.now()): ApiPressureState | null {
  const state = pressure.get(provider);
  if (state === undefined) return null;
  if (state.until <= now) {
    // Expired, but the refusal count is kept: a provider that refuses again
    // immediately gets the longer wait, not the first one over again.
    pressure.set(provider, { ...state, until: 0 });
    return null;
  }
  return state;
}

/** Every provider held right now, longest wait first. */
export function apiPressureHolds(now: number = Date.now()): ApiPressureState[] {
  return [...pressure.keys()]
    .map((provider) => apiPressureFor(provider, now))
    .filter((state): state is ApiPressureState => state !== null)
    .sort((a, b) => b.until - a.until);
}

/** Is any provider holding dispatch? */
export function apiPressureHolding(now: number = Date.now()): boolean {
  return apiPressureHolds(now).length > 0;
}

/** One line for a log or the monitor: what the hold knows. */
export function describeApiPressure(now: number = Date.now()): string | null {
  const [worst] = apiPressureHolds(now);
  if (worst === undefined) return null;
  const seconds = Math.max(1, Math.round((worst.until - now) / 1000));
  return (
    `${worst.provider} refused the call and dispatch is held for ~${seconds}s ` +
    `(${worst.stated ? 'the provider asked for this wait' : `refusal ${worst.refusals}, backing off`}): ${worst.reason}`
  );
}

/** Test seam. */
export function resetApiPressure(): void {
  pressure.clear();
}
