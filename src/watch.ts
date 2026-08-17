/**
 * `wowlidator watch` — re-run on an interval, speak up only when something changes
 * (spec A4).
 *
 * ## Why this is not just `while true; do wowlidator run; sleep; done`
 *
 * Because that notifies on every run, and a notification that arrives whether
 * or not anything happened is one people mute. The useful signal is the
 * *transition*: green→red, red→green, or "this has started alternating". wowlidator
 * already computes exactly that — `analyseTrend` over the append-only history —
 * so watch is a thin loop around machinery that exists, not new logic.
 *
 * ## The notify seam
 *
 * `--notify <cmd>` runs an arbitrary command and writes the verdict to its
 * stdin as JSON. One seam, no integrations: Slack, `osascript`, `mail`, a
 * pager, a shell function — all of them are `--notify 'jq -r .headline | mail
 * me'`. Growing a Slack client inside a test runner would be a second thing to
 * maintain, a second place for credentials to live, and useless to anyone whose
 * chat tool is different.
 *
 * Not a daemon. Foreground, Ctrl-C stops it, and if you want it supervised, put
 * it under whatever already supervises things where you work.
 */

import { spawn } from 'node:child_process';

import type { ProofBundle, RunStatus } from './engine/proof-bundle.js';
import { buildVerdict } from './reporter/verdict.js';

export const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
export const MIN_INTERVAL_MS = 5_000;

/** Why a watch iteration is worth telling someone about. */
export type ChangeKind = 'first-result' | 'broke' | 'fixed' | 'now-flaky' | 'unchanged';

export interface WatchState {
  /** Status of the previous iteration, if any. */
  previousStatus?: RunStatus | undefined;
  /** Trend verdict of the previous iteration. */
  previousTrend?: string | undefined;
}

/**
 * Classify one iteration against the last.
 *
 * `flaky` is treated as a change in its own right even when the pass/fail
 * result is unchanged — a test that has started alternating is news, and
 * reporting only pass/fail would hide exactly that, the same reason `flaky`
 * outranks pass/fail in `analyseTrend`.
 */
export function classifyChange(bundle: ProofBundle, state: WatchState): ChangeKind {
  const status = bundle.status;
  const trend = bundle.trend?.verdict;

  if (state.previousStatus === undefined) return 'first-result';
  if (trend === 'flaky' && state.previousTrend !== 'flaky') return 'now-flaky';
  if (status !== state.previousStatus) return status !== 'passed' ? 'broke' : 'fixed';
  return 'unchanged';
}

/** The payload handed to `--notify` on stdin. */
export interface NotifyPayload {
  change: ChangeKind;
  status: string;
  name: string;
  runId: string;
  headline: string;
  what: string;
  owner: string | null;
  trend: string | null;
  reportPath: string | null;
  startedAt: string;
}

export function notifyPayload(
  bundle: ProofBundle,
  change: ChangeKind,
  reportPath: string | null,
): NotifyPayload {
  const verdict = buildVerdict(bundle);
  return {
    change,
    status: bundle.status,
    name: bundle.name,
    runId: bundle.runId,
    headline: verdict.headline,
    what: verdict.what,
    owner: verdict.owner,
    trend: bundle.trend?.verdict ?? null,
    reportPath,
    startedAt: bundle.startedAt,
  };
}

/**
 * Run the notify command, handing it the payload on stdin.
 *
 * Never throws and never blocks the loop: a broken notifier is a broken
 * notifier, not a reason to stop watching. Its failure is reported on stderr
 * so it cannot fail silently either.
 */
export async function runNotify(command: string, payload: NotifyPayload): Promise<void> {
  await new Promise<void>((resolvePromise) => {
    const child = spawn(command, { shell: true, stdio: ['pipe', 'inherit', 'inherit'] });
    child.on('error', (error) => {
      process.stderr.write(`wowlidator watch: notify command failed: ${error.message}\n`);
      resolvePromise();
    });
    child.on('close', (code) => {
      if (code !== 0) {
        process.stderr.write(`wowlidator watch: notify command exited ${code}\n`);
      }
      resolvePromise();
    });
    child.stdin.end(JSON.stringify(payload, null, 2));
  });
}

/**
 * Parse `--every 15m` / `90s` / `2h` into milliseconds.
 *
 * Rejects anything below `MIN_INTERVAL_MS`: a watch that re-runs a browser
 * suite every second is a fork bomb with better manners.
 */
export function parseInterval(raw: string | undefined): number {
  if (!raw) return DEFAULT_INTERVAL_MS;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i.exec(raw.trim());
  if (!match) throw new Error(`--every: cannot read "${raw}" — try 30s, 15m, or 2h`);
  const value = Number(match[1]);
  const unit = (match[2] ?? 'm').toLowerCase();
  const ms =
    unit === 'ms' ? value : unit === 's' ? value * 1000 : unit === 'h' ? value * 3_600_000 : value * 60_000;
  if (ms < MIN_INTERVAL_MS) {
    throw new Error(`--every: ${raw} is too short — the minimum is ${MIN_INTERVAL_MS / 1000}s`);
  }
  return ms;
}

/** One line per iteration, for the terminal. */
export function formatWatchLine(payload: NotifyPayload, iteration: number): string {
  const mark = payload.status === 'passed' ? '✓' : '✗';
  const change =
    payload.change === 'unchanged' ? '' : `  ← ${payload.change.replace(/-/g, ' ').toUpperCase()}`;
  return `[${new Date(payload.startedAt).toISOString().slice(11, 19)}] #${iteration} ${mark} ${payload.name}${change}`;
}
