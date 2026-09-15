/**
 * The suite-wide quota hold — one state, every loop that starts model work
 * reads it (the run lanes through `runQueue`'s `waitWhile`, the authoring
 * pool before each row), the same shape as the pause flag in `pause.ts`.
 *
 * What it is for (2026-09-05, a 272-case catalog on claude-cli): the
 * account's 5-hour session window hit 100% at 17:07 and NOTHING stopped.
 * Every model call for the next two hours was refused ("You've hit your
 * session limit"), and the run "finished" 243 cases on those refusals — 213
 * recorded as never ran, 30 as error — before the window reset at 19:11.
 * The cap in `claude-cli.ts` (`assertUnderUsageCap`) refuses the CALL, which
 * is exactly what poisons a case mid-flight; what a suite needs is to stop
 * DISPATCHING before the window is full and resume when it opens again.
 *
 * Decision, pure (`quotaHoldDecision`): hold when the session window is at or
 * past the threshold; release when it has fallen back below the threshold
 * less a hysteresis band (a fresh window reads a few percent, an old one
 * hovers at the line), or when the endpoint's own `resetsAt` has passed. A
 * reading that is unavailable never changes the state — a 429 from the usage
 * endpoint is not a reason to hold, and not a reason to release either.
 *
 * Off by default? No: on whenever a claude-* provider serves any role — the
 * window belongs to those providers and only they spend it — and off for a
 * suite with none, or with `WOWLIDATOR_QUOTA_HOLD_PERCENT=off`.
 */
import type { WowlidatorConfig } from '../config.js';
import { sessionQuotaPoint } from '../providers/claude-quota.js';
import { apiPressureHolding, describeApiPressure } from '../providers/api-pressure.js';
import { providerConcurrency } from '../config.js';

export const QUOTA_HOLD_ENV = 'WOWLIDATOR_QUOTA_HOLD_PERCENT';
/** Percent of the session window at which dispatch stops. Measured 1.4 pt/min at full speed; ~12 pt of headroom lets 8 in-flight lanes finish. */
export const DEFAULT_QUOTA_HOLD_PERCENT = 85;
/** Released only this far under the threshold — a window at the line must not flap. */
export const QUOTA_HOLD_HYSTERESIS = 5;
/** How often the window is read while a suite runs (the reader caches on its own TTL and backs off a 429). */
export const QUOTA_POLL_MS = 60_000;

const CLAUDE_PROVIDERS = new Set(['claude-cli', 'claude-tty', 'claude-cloud']);

/** The threshold the env asks for: default, a number in 1..99, or null for off. */
export function quotaHoldPercent(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = (env[QUOTA_HOLD_ENV] ?? '').trim().toLowerCase();
  if (raw === '') return DEFAULT_QUOTA_HOLD_PERCENT;
  if (raw === 'off' || raw === '0' || raw === 'false') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 1 && value <= 99 ? Math.floor(value) : DEFAULT_QUOTA_HOLD_PERCENT;
}

/** Does any role spend the account's window? A suite with no claude-* provider has nothing to hold for. */
export function spendsClaudeWindow(config: WowlidatorConfig): boolean {
  return Object.values(config.roles).some((role) => CLAUDE_PROVIDERS.has(role.provider));
}

export interface QuotaReading {
  percent: number | null;
  resetsAt: string | null;
}

/**
 * The next hold state from the current one and a reading. Pure — this is
 * the whole policy, and the unit test's subject.
 */
export function quotaHoldDecision(
  holding: boolean,
  reading: QuotaReading,
  threshold: number,
  now: number = Date.now(),
): boolean {
  if (reading.percent === null) return holding;
  if (!holding) return reading.percent >= threshold;
  // Holding: the window reset (the endpoint's own clock), or the number fell
  // back under the band — either reopens the lanes.
  if (reading.resetsAt !== null) {
    const resetMs = Date.parse(reading.resetsAt);
    if (Number.isFinite(resetMs) && resetMs <= now && reading.percent < threshold) return false;
  }
  return reading.percent >= threshold - QUOTA_HOLD_HYSTERESIS;
}

interface HoldState {
  holding: boolean;
  percent: number | null;
  resetsAt: string | null;
  threshold: number;
  since: number | null;
  timer: NodeJS.Timeout | null;
  log: ((line: string) => void) | undefined;
}

let state: HoldState | null = null;

/**
 * Is dispatch held right now?
 *
 * Two sources, one answer. The claude-* half is a WINDOW the account reports
 * and this module polls. The API half is a REFUSAL a provider has already
 * given (`providers/api-pressure.ts`) — there is no endpoint to poll, so the
 * reading is the thing that went wrong, held for as long as the provider
 * asked. Either one stops new work; neither touches a call already in flight.
 *
 * The API half needs no arming: a refusal can only be recorded by a call that
 * was actually made, so a suite with no API provider never sees one.
 */
export function quotaHolding(): boolean {
  return (state?.holding ?? false) || apiPressureHolding();
}

/** One line for a log or a report: what the hold knows. */
export function describeQuotaHold(): string {
  const pressure = describeApiPressure();
  if (pressure !== null) return `provider hold ON — ${pressure}`;
  if (state === null) return 'quota hold off';
  const pct = state.percent === null ? 'unknown' : `${Math.round(state.percent)}%`;
  const reset = state.resetsAt === null ? '' : ` · resets ${new Date(state.resetsAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
  return state.holding
    ? `quota hold ON — session ${pct} ≥ ${state.threshold}%${reset}; nothing new starts until the window reopens`
    : `quota hold armed at ${state.threshold}% — session ${pct}${reset}`;
}

async function poll(force: boolean): Promise<void> {
  if (state === null) return;
  const point = await sessionQuotaPoint(process.env, force).catch(() => null);
  const reading: QuotaReading = point === null ? { percent: null, resetsAt: null } : { percent: point.percent, resetsAt: point.resetsAt };
  if (state === null) return;
  const before = state.holding;
  const next = quotaHoldDecision(before, reading, state.threshold);
  if (reading.percent !== null) {
    state.percent = reading.percent;
    state.resetsAt = reading.resetsAt;
  }
  if (next !== before) {
    state.holding = next;
    state.since = next ? Date.now() : null;
    state.log?.(`  ⏸ ${describeQuotaHold()}`);
  }
}

/**
 * Arm the hold for this process — idempotent, so the authoring pool and the
 * run loop may both call it and share one state. Returns false when nothing
 * is armed (no claude-* role, or the env says off).
 */
export function ensureQuotaHold(
  config: WowlidatorConfig,
  log?: (line: string) => void,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (state !== null) return true;
  const threshold = quotaHoldPercent(env);
  if (threshold === null || !spendsClaudeWindow(config)) {
    announceApiCeilings(config, log, env);
    return false;
  }
  state = { holding: false, percent: null, resetsAt: null, threshold, since: null, timer: null, log };
  void poll(true);
  state.timer = setInterval(() => void poll(true), QUOTA_POLL_MS);
  state.timer.unref?.();
  log?.(`  ⏸ ${describeQuotaHold()} (${QUOTA_HOLD_ENV}=off disables)`);
  return true;
}

let announced = false;

/**
 * Say, once, which providers will make a lane WAIT rather than be refused.
 * A ceiling that is invisible reads as a slow run; a ceiling that is stated
 * reads as the run obeying a limit, which is what it is doing.
 */
function announceApiCeilings(
  config: WowlidatorConfig,
  log?: (line: string) => void,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (announced || log === undefined) return;
  announced = true;
  const seen = new Map<string, number>();
  for (const role of Object.values(config.roles)) {
    const limit = providerConcurrency(role.provider, env);
    if (limit !== undefined) seen.set(role.provider, limit);
  }
  for (const [provider, limit] of seen) {
    log(
      `  ⏸ ${provider} takes ${limit} call(s) at once from one key — a lane past that waits ` +
      `(WOWLIDATOR_${provider.replace(/-/g, '_').toUpperCase()}_CONCURRENCY=off removes the ceiling); ` +
      'a refusal holds dispatch until the provider reopens',
    );
  }
}

/** Stop polling and forget the state. Safe to call twice. */
export function stopQuotaHold(): void {
  if (state?.timer) clearInterval(state.timer);
  state = null;
  announced = false;
}

/** Wait here while the hold is on — for a loop with no `waitWhile` of its own (the authoring pool). */
export async function awaitQuotaRelease(
  shouldStop: () => boolean = () => false,
  stepMs = 15_000,
): Promise<void> {
  while (quotaHolding() && !shouldStop()) {
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}
