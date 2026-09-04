/**
 * Flake quarantine (spec A5).
 *
 * A case that alternates between passing and failing turns a pipeline red at
 * random. The usual responses are both bad: delete the test, and lose the
 * coverage; or ignore red builds, and lose the signal from every other test.
 *
 * Quarantine is the third option — **keep running it, keep reporting it in
 * full, stop counting it as a failure** — and it only works because wowlidator
 * already knows what flaky means. `analyseTrend` computes the verdict from run
 * history, and `flaky` deliberately outranks pass/fail there, so nothing new
 * has to be inferred here.
 *
 * ## Two rules that keep this from becoming a way to hide bugs
 *
 * **Entry is never automatic.** A run is quarantined only when the caller
 * passed `--quarantine-flaky`. Silently downgrading a flaky failure would be
 * precisely the "suite that goes green while checking nothing" outcome the
 * history module exists to prevent — the opt-in is the whole safety mechanism.
 *
 * **Leaving requires a streak, not a single pass.** One green run of a flaky
 * test proves nothing; that is what flaky means. `CONSECUTIVE_PASSES_TO_CLEAR`
 * consecutive passes are required, which is the same evidentiary standard
 * `analyseTrend` uses to call a test stable in the first place.
 */

import type { ProofBundle } from '../engine/proof-bundle.js';
import { isPassing } from '../engine/proof-bundle.js';
import type { HistoryEntry } from './run-history.js';

/** Consecutive passes required before a quarantined case counts normally again. */
export const CONSECUTIVE_PASSES_TO_CLEAR = 5;

export interface QuarantineDecision {
  /** Whether this run's failures should stop counting as failures. */
  quarantined: boolean;
  /** Why — surfaced in the report and the CLI, never silent. */
  reason: string;
}

/**
 * Decide whether a finished run should be quarantined.
 *
 * `history` is the same window `analyseTrend` reads, most recent last.
 */
export function decideQuarantine(
  bundle: ProofBundle,
  history: readonly HistoryEntry[],
  options: { enabled: boolean },
): QuarantineDecision {
  if (!options.enabled) {
    return { quarantined: false, reason: 'quarantine not requested' };
  }
  if (isPassing(bundle.status)) {
    return { quarantined: false, reason: 'run passed' };
  }
  if (bundle.trend?.verdict !== 'flaky') {
    // A test that fails consistently is broken, not flaky, and quarantining it
    // would hide a real regression behind a feature meant for noise.
    return {
      quarantined: false,
      reason: `not flaky (trend: ${bundle.trend?.verdict ?? 'unknown'}) — a consistently failing test is a broken test`,
    };
  }

  const recent = history.filter((entry) => entry.runId !== bundle.runId).slice(-CONSECUTIVE_PASSES_TO_CLEAR);
  const streak = countTrailingPasses(recent);
  if (streak >= CONSECUTIVE_PASSES_TO_CLEAR) {
    return {
      quarantined: false,
      reason: `left quarantine after ${streak} consecutive passes`,
    };
  }

  return {
    quarantined: true,
    reason:
      `known flaky (${bundle.trend.flips} pass/fail flips in the last ${bundle.trend.sampleSize} runs) — ` +
      `reported but not counted; ${CONSECUTIVE_PASSES_TO_CLEAR} consecutive passes will clear it`,
  };
}

function countTrailingPasses(history: readonly HistoryEntry[]): number {
  let streak = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (!isPassing(history[i]?.status ?? '')) break;
    streak += 1;
  }
  return streak;
}
