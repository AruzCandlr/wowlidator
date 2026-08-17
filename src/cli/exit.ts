/**
 * The exit-code contract and run-outcome classification. Split out of cli.ts
 * verbatim.
 */

import type { ProofBundle } from '../engine/proof-bundle.js';

/**
 * The exit-code contract.
 *
 * Frozen and documented because automation depends on it: a CI job has to tell
 * "the test found a bug" apart from "the test could not run", and those demand
 * opposite responses — one opens a ticket, the other fixes the runner. Adding a
 * code is a breaking change to every pipeline consuming wowlidator; changing what an
 * existing one means is worse.
 */
export const EXIT = {
  /** Ran to completion, everything passed. */
  ok: 0,
  /** Ran to completion, at least one step or case failed. A real result. */
  failed: 1,
  /** Could not start: bad arguments, missing file, invalid flow. */
  usage: 2,
  /** Could not start: no browser, undriveable Chrome, missing provider key. */
  environment: 3,
} as const;

/**
 * Map a finished run onto the contract.
 *
 * A run that never attached to a browser is an environment problem wearing a
 * failed run's clothes — reporting it as `failed` would have CI file bugs
 * against an application it never reached.
 */
export function exitCodeFor(bundle: { status: string; error?: string | undefined }): number {
  if (bundle.status === 'passed') return EXIT.ok;
  // "The browser went away mid-run" joins the attach failures: a run without
  // a browser is an environment problem wearing a failed run's clothes, and
  // reporting it as `failed` would have CI file bugs against an application
  // the run never reached. See `BrowserGoneError` in the runner.
  if (
    bundle.error &&
    /could not attach to a browser|Browser context management|browser went away mid-run/.test(
      bundle.error,
    )
  ) {
    return EXIT.environment;
  }
  return EXIT.failed;
}

/**
 * Classify an error that escaped a command.
 *
 * The backstop for the exit-code contract: an unrecognised flag, an unreadable
 * file and an unreachable browser all used to surface as 1 — "the tests
 * failed" — which is the one thing none of them mean.
 */
export function classifyError(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (/Unknown option|argument is required|not allowed|Unexpected argument/i.test(message)) {
    return EXIT.usage;
  }
  if (/ENOENT|not valid JSON|Unexpected token/i.test(message)) return EXIT.usage;
  // A model that cannot produce schema output is the machinery failing, not
  // the application — "regard as system failure" is the contract here: CI
  // must fix the role's routing, not file a bug against the app.
  if (
    /could not attach to a browser|Browser context management|no API key|ConfigError|failed to produce a valid structured response|structured-output circuit is open/i.test(
      message,
    )
  ) {
    return EXIT.environment;
  }
  return EXIT.failed;
}

/** What became of one listed case. */
export interface CaseOutcome {
  name: string;
  /** `blocked` — it produced no verdict about the application. See `neverRan`. */
  verdict: 'passed' | 'failed' | 'blocked';
  /** Null only when nothing was produced at all — the call itself threw. */
  bundle: ProofBundle | null;
  /** Where its report landed, when there is one. */
  reportPath?: string | undefined;
  /** Why it is blocked, or which step broke. */
  reason?: string | undefined;
}

/**
 * Did this run learn anything about the application, or only about the harness?
 *
 * Returns the reason it did not, or `null` when the verdict is real.
 *
 * **This, not the exception, is what a dead browser looks like.** `runFlow`
 * catches a failure to attach and returns a bundle carrying the error — status
 * `failed`, zero steps — so a `try`/`catch` around the call almost never fires,
 * and every case after the browser went away was reported as a red ✗ with no
 * explanation under it. Read literally that says the application is broken in
 * seven new ways; it says nothing about the application at all.
 *
 * The test is "the run failed, but no step of it did". Either nothing ran, or it
 * broke off partway without any assertion being contradicted. **Blocked, not
 * failed** — the same distinction `proofs-to-artifacts.py` makes for a step that
 * never ran, and the reason is the same: scoring the harness's own gap as a
 * defect sends someone to look for a bug that was never claimed to exist.
 */
export function neverRan(bundle: ProofBundle): string | null {
  if (bundle.status === 'passed') return null;
  if (bundle.steps.some((step) => step.status !== 'passed')) return null;
  // First line only, same as `failureOf`: this goes on one line of a roll-up
  // that has one line per case, and the engine's attach error carries a
  // two-line "start Chrome like this" hint. The whole text is still on the
  // bundle and in the report.
  const reason = bundle.error?.split('\n')[0]?.trim();
  return reason === undefined || reason === ''
    ? 'the run ended before any step could fail'
    : reason;
}

/**
 * The exit code for a list of cases.
 *
 * A real failure outranks everything: something about the application is wrong.
 * Otherwise a case that never ran still cannot be reported as success — nothing
 * was proved — and it is an environment problem rather than a product one, so
 * it takes the environment code.
 */
export function suiteExit(outcomes: readonly CaseOutcome[]): number {
  if (outcomes.some((o) => o.verdict === 'failed')) return EXIT.failed;
  if (outcomes.some((o) => o.verdict === 'blocked')) return EXIT.environment;
  return EXIT.ok;
}

/** The step that broke, as one line, or undefined when none did. */
export function failureOf(bundle: ProofBundle): string | undefined {
  const broke = bundle.steps.find((step) => step.status !== 'passed');
  if (broke === undefined) return undefined;
  return `${broke.intent ?? broke.action}: ${(broke.error ?? 'failed').split('\n')[0] ?? 'failed'}`;
}
