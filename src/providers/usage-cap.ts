/**
 * A hard cap on the signed-in Claude session's usage, in PERCENT of the
 * windows the account itself reports.
 *
 * `bin/cost-guard.sh` caps dollars this repo recorded; this caps the thing
 * the account actually meters — the 5-hour session window and the weekly
 * windows `claude-quota.ts` already reads — so the number on the panel is
 * the number Anthropic will enforce, not an estimate of it. The cap is
 * compared against the CURRENT SESSION window only (the 5-hour window) —
 * asked for 2026-08-28: the weekly and per-model windows (`week`,
 * `week (Fable)`) are budgets the person manages themselves, and a cap that
 * tripped on the Fable weekly at 50% held every run for a window no amount
 * of waiting inside the day would reset. The session window is the one this
 * panel's own spending moves on the hour scale a run lives in.
 *
 * Two enforcement points, one rule (`evaluateUsageCap`):
 *
 *  - **In the panel** (`src/ui/usage-cap.ts`): a tick every quota TTL stops
 *    every running job and holds new ones until a person resets it.
 *  - **In every process that calls claude-cli** (`assertUnderUsageCap`, at
 *    the top of `claude-cli.ts`'s `doGenerate`): a run started from a
 *    terminal the panel cannot see refuses its next model call with a typed
 *    error. The quota fetch is TTL-cached, so this costs one request per
 *    30 s per process, not one per call.
 *
 * Off by default — a cap is a decision, not a surprise. Settings live in
 * `.env` (`WOWLIDATOR_USAGE_CAP`, `WOWLIDATOR_USAGE_CAP_PERCENT`) so a CLI
 * run and the panel read the same line.
 */

import { fetchClaudeQuota, type ClaudeQuotaLimit, type ClaudeQuotaSnapshot } from './claude-quota.js';

export const USAGE_CAP_ENV = 'WOWLIDATOR_USAGE_CAP';
export const USAGE_CAP_PERCENT_ENV = 'WOWLIDATOR_USAGE_CAP_PERCENT';
export const DEFAULT_USAGE_CAP_PERCENT = 90;
/** "Approaching" is this much of the cap — a warning, never a stop. */
export const USAGE_CAP_NEARING_RATIO = 0.9;

export interface UsageCapSettings {
  enabled: boolean;
  /** 1–100. */
  capPercent: number;
}

export function usageCapSettings(env: NodeJS.ProcessEnv = process.env): UsageCapSettings {
  const raw = env[USAGE_CAP_ENV]?.trim().toLowerCase();
  const enabled = raw === 'on' || raw === '1' || raw === 'true' || raw === 'yes';
  const pct = Number(env[USAGE_CAP_PERCENT_ENV]);
  return {
    enabled,
    capPercent: Number.isFinite(pct) && pct >= 1 && pct <= 100 ? Math.floor(pct) : DEFAULT_USAGE_CAP_PERCENT,
  };
}

/** A cap percent as a person typed it, or the reason it is refused. */
export function parseCapPercent(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isFinite(n) || n < 1 || n > 100) {
    throw new Error('the usage cap must be a whole number from 1 to 100 (percent of the window)');
  }
  return Math.floor(n);
}

export interface UsageCapVerdict {
  enabled: boolean;
  capPercent: number;
  /** The highest percent any reported window stands at; 0 when unreadable. */
  maxPercent: number;
  /** The window that stands highest, or null when nothing was reported. */
  worst: ClaudeQuotaLimit | null;
  /** Some window is at or past the cap. */
  tripped: boolean;
  /** Some window is past `USAGE_CAP_NEARING_RATIO` of the cap, not yet at it. */
  nearing: boolean;
  /** Why the quota could not be read, or ''. A cap that cannot see never trips. */
  note: string;
}

/** Pure: the cap against a snapshot. Deterministic, so the panel and the CLI agree. */
export function evaluateUsageCap(
  snapshot: ClaudeQuotaSnapshot,
  settings: UsageCapSettings,
): UsageCapVerdict {
  let worst: ClaudeQuotaLimit | null = null;
  // Session window only — the weekly windows are informational here (the
  // status line still shows them); they never trip the cap.
  for (const limit of snapshot.limits) {
    if (limit.kind !== 'session') continue;
    if (worst === null || limit.percent > worst.percent) worst = limit;
  }
  const maxPercent = worst === null ? 0 : Math.max(0, worst.percent);
  const tripped = settings.enabled && worst !== null && maxPercent >= settings.capPercent;
  const nearing =
    settings.enabled && !tripped && worst !== null && maxPercent >= settings.capPercent * USAGE_CAP_NEARING_RATIO;
  return {
    enabled: settings.enabled,
    capPercent: settings.capPercent,
    maxPercent,
    worst,
    tripped,
    nearing,
    note: snapshot.limits.length === 0 ? snapshot.note : '',
  };
}

/** One line: `session 92% ≥ cap 90%`. */
export function describeTrip(verdict: UsageCapVerdict): string {
  const w = verdict.worst;
  return w === null
    ? `usage cap ${verdict.capPercent}% reached`
    : `${w.label} ${Math.round(w.percent)}% ≥ cap ${verdict.capPercent}%`;
}

/**
 * Thrown by a model call refused under the cap. Worded as a provider fact —
 * the exit contract and `generateStructured` read "the provider refused"
 * as an environment problem, never an application defect.
 */
export class UsageCapExceededError extends Error {
  readonly verdict: UsageCapVerdict;
  constructor(verdict: UsageCapVerdict) {
    super(
      `claude CLI could not be asked — the provider refused the call: usage cap reached (${describeTrip(verdict)}). ` +
        `Raise ${USAGE_CAP_PERCENT_ENV}, set ${USAGE_CAP_ENV}=off, or wait for the window to reset` +
        (verdict.worst?.resetsAt ? ` (${verdict.worst.resetsAt})` : ''),
    );
    this.name = 'UsageCapExceededError';
    this.verdict = verdict;
  }
}

/**
 * Refuse when the cap is on and reached. Never throws for any other reason:
 * an unreadable quota is a note, and a cap that cannot see does not stop a
 * run on a guess.
 */
export async function assertUnderUsageCap(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const settings = usageCapSettings(env);
  if (!settings.enabled) return;
  let snapshot: ClaudeQuotaSnapshot;
  try {
    snapshot = await fetchClaudeQuota(env);
  } catch {
    return;
  }
  const verdict = evaluateUsageCap(snapshot, settings);
  if (verdict.tripped) throw new UsageCapExceededError(verdict);
}
