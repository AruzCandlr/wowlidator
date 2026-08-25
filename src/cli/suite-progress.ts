/**
 * The progress ledger of a suite — what a catalog run has proved so far, so a
 * run that stops short can be continued instead of started over.
 *
 * Live, 2026-08-21: a 108-row catalog stopped at row 36 when a model's daily
 * budget was refused; seventy cases were marked "never ran" and the only way
 * on was to run all 108 again — including the 36 that already had a verdict.
 * The ledger is written **after every case**, next to the claims file it
 * belongs to (`<claims>.progress.json`), and `catalog --resume` reads it:
 * a case with a verdict is skipped, a case that never ran (blocked) or was
 * never reached runs.
 *
 * Two rules:
 * - **A verdict is kept; a non-verdict is retried.** `passed`, `failed` and
 *   `review` say something about the application and are not re-run by a
 *   resume (re-running a failure is a retry, a different decision). `blocked`
 *   says nothing about the application and is exactly what a resume is for.
 * - **The cause of stopping is recorded where it can be.** A case that threw
 *   and a process that caught a signal both write `ended.cause`; a process
 *   killed outright cannot, and the reader then sees `ended: null` with the
 *   last recorded case as the high-water mark — honest about what is known.
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { CaseOutcome } from './exit.js';

export const LEDGER_VERSION = 1;

export interface LedgerOutcome {
  verdict: CaseOutcome['verdict'];
  /** The bundle's own status, when there was a bundle. */
  status: string | null;
  reason: string | null;
  reportPath: string | null;
  /** The authored flow on disk, when the run knew it — what `--rerun-vacuous` re-reads. */
  flowPath?: string | null | undefined;
  /** True when the flow asserted nothing about its claim (see `generator/vacuous.ts`). A resume re-authors it. */
  vacuous?: boolean | undefined;
  /**
   * The case's full name (`PL_06_05 ตรวจสอบ…`), so a resume can list this
   * finished case in its own roll-up without re-reading the sheet. Absent in
   * ledgers written before it was recorded; the id then stands in.
   */
  name?: string | undefined;
  /**
   * The case's proof bundle on disk, when the run wrote one. What a resume
   * re-reads to carry this finished case into its own suite index with the
   * full evidence rather than a bare verdict line.
   */
  proofPath?: string | null | undefined;
  at: string;
}

export interface SuiteLedger {
  version: number;
  title: string;
  /** The case ids the suite set out to prove, in sheet order. */
  planned: string[];
  startedAt: string;
  updatedAt: string;
  /**
   * The authoring pass's stamp (`GenerationProvenance.generatedAt`). wowUI
   * groups runs by it, so a resume reuses it and its cases land under the
   * original group rather than opening a new one. Null until the first
   * flow of the pass is authored.
   */
  generatedAt: string | null;
  /**
   * The catalog run's unique key: `<catalog name, slugged>@<pass stamp>` —
   * minted when the run is initialised, before anything is authored, and
   * reused verbatim by every resume, so the whole life of one approved list
   * (first run, pauses, continues, reruns) answers to one key. Null only in
   * ledgers written before the key existed.
   */
  runKey: string | null;
  /**
   * What started this run — enough to rebuild a resume command after the
   * process (and the panel that spawned it) are gone. Paths are absolute.
   * Absent in ledgers written before it was recorded.
   */
  launch?:
    | {
        catalog: string;
        claims: string;
        url?: string | undefined;
        repo?: string | undefined;
      }
    | undefined;
  outcomes: Record<string, LedgerOutcome>;
  /** Set when the run ended — cleanly or not. Null while it is (or was last seen) running. */
  ended: { at: string; cause: string | null; complete: boolean } | null;
}

/** Beside the claims file: `be100.claims.json` → `be100.claims.progress.json`. */
export function ledgerPathFor(claimsPath: string): string {
  return claimsPath.replace(/\.json$/i, '') + '.progress.json';
}

export function newLedger(title: string, planned: readonly string[]): SuiteLedger {
  const now = new Date().toISOString();
  return {
    version: LEDGER_VERSION,
    title,
    planned: [...planned],
    startedAt: now,
    updatedAt: now,
    generatedAt: null,
    runKey: null,
    outcomes: {},
    ended: null,
  };
}

export async function readLedger(path: string): Promise<SuiteLedger | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as SuiteLedger;
    if (!parsed || parsed.version !== LEDGER_VERSION || typeof parsed.outcomes !== 'object') return null;
    // Ledgers written before the run key existed read back as key-less, not broken.
    parsed.runKey ??= null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeLedger(path: string, ledger: SuiteLedger): Promise<void> {
  ledger.updatedAt = new Date().toISOString();
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  await rename(temp, path);
}

/** For a signal handler, where nothing may be awaited before the process goes. */
export function writeLedgerSync(path: string, ledger: SuiteLedger): void {
  ledger.updatedAt = new Date().toISOString();
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  renameSync(temp, path);
}

/** The case id a suite case name starts with — `PL_06_05 ตรวจสอบ…` → `PL_06_05`. */
export function caseIdOf(name: string): string {
  return name.split(/\s+/, 1)[0] ?? name;
}

export function recordOutcome(
  ledger: SuiteLedger,
  outcome: CaseOutcome,
  extra: { flowPath?: string | undefined; vacuous?: boolean | undefined; proofPath?: string | undefined } = {},
): void {
  ledger.outcomes[caseIdOf(outcome.name)] = {
    verdict: outcome.verdict,
    status: outcome.bundle?.status ?? null,
    reason: outcome.reason ?? null,
    reportPath: outcome.reportPath ?? null,
    flowPath: extra.flowPath ?? null,
    vacuous: extra.vacuous ?? false,
    name: outcome.name,
    proofPath: extra.proofPath ?? null,
    at: new Date().toISOString(),
  };
}

/**
 * Mark every recorded outcome whose flow proves nothing about its claim as
 * needing a re-run. `judge` reads the flow file and answers why it is
 * vacuous, or null. Returns the ids marked. The verdict becomes `blocked` —
 * a vacuous pass was never a verdict about the application.
 */
export async function markVacuous(
  ledger: SuiteLedger,
  judge: (flowPath: string) => Promise<string | null>,
): Promise<string[]> {
  const marked: string[] = [];
  for (const [id, outcome] of Object.entries(ledger.outcomes)) {
    if (!outcome.flowPath || outcome.verdict === 'blocked') continue;
    const why = await judge(outcome.flowPath);
    if (why === null) continue;
    outcome.verdict = 'blocked';
    outcome.vacuous = true;
    outcome.reason = `vacuous: ${why}`;
    marked.push(id);
  }
  return marked;
}

/**
 * Mark every recorded outcome `pick` selects as needing a run again — the
 * verdict becomes `blocked` (so `remaining()` includes it) and the reason
 * says which re-run asked for it. Returns the ids marked. Used for "rerun
 * all errors" (the harness broke, not the app) and "heal all failed" (a
 * second go with autoheal on).
 */
export function markForRerun(
  ledger: SuiteLedger,
  pick: (outcome: LedgerOutcome, id: string) => boolean,
  label: string,
): string[] {
  const marked: string[] = [];
  for (const [id, outcome] of Object.entries(ledger.outcomes)) {
    if (outcome.verdict === 'blocked' || !pick(outcome, id)) continue;
    outcome.verdict = 'blocked';
    outcome.reason = `${label}: ${outcome.reason ?? outcome.status ?? 'no reason recorded'}`;
    marked.push(id);
  }
  return marked;
}

/** The cases the harness ended, not the application: an `error` bundle or no bundle at all. */
export function isErrorOutcome(outcome: LedgerOutcome): boolean {
  return outcome.status === 'error' || (outcome.verdict === 'failed' && outcome.status === null);
}

/** A real failure about the application: failed or dead-end. */
export function isFailedOutcome(outcome: LedgerOutcome): boolean {
  return outcome.verdict === 'failed' && (outcome.status === 'failed' || outcome.status === 'dead-end');
}

/**
 * Which planned cases still need a run: never reached, or reached and blocked.
 * A case with a verdict is done as far as a resume is concerned.
 */
export function remaining(ledger: SuiteLedger, planned: readonly string[] = ledger.planned): string[] {
  return planned.filter((id) => {
    const done = ledger.outcomes[id];
    return done === undefined || done.verdict === 'blocked' || done.vacuous === true;
  });
}

export interface LedgerSummary {
  planned: number;
  passed: number;
  failed: number;
  review: number;
  blocked: number;
  notReached: number;
}

/**
 * The finished cases a resume inherits rather than re-runs: every planned case
 * that was not run this pass and already holds a real verdict. `blocked` and
 * vacuous outcomes are excluded — they are exactly what the resume exists to
 * run — and so is anything the current pass ran (its fresh outcome stands).
 * Returned in plan order, since that is the order everything downstream keeps.
 */
export function carriedOutcomes(
  prior: Record<string, LedgerOutcome>,
  planned: readonly string[],
  ranIds: ReadonlySet<string>,
): { id: string; outcome: LedgerOutcome }[] {
  const carried: { id: string; outcome: LedgerOutcome }[] = [];
  for (const id of planned) {
    if (ranIds.has(id)) continue;
    const outcome = prior[id];
    if (outcome === undefined || outcome.verdict === 'blocked' || outcome.vacuous === true) continue;
    carried.push({ id, outcome });
  }
  return carried;
}

/**
 * Order merged outcomes as the plan someone approved reads, not as a stopwatch
 * result: a resume's roll-up interleaves carried and fresh cases, and sheet
 * order is the one order both sides share. Names outside the plan (a suite
 * with no planned ids) keep their existing relative order, after the planned.
 */
export function sortByPlan(outcomes: readonly CaseOutcome[], planned: readonly string[]): CaseOutcome[] {
  if (planned.length === 0) return [...outcomes];
  const rank = new Map(planned.map((id, index) => [id, index]));
  return [...outcomes]
    .map((outcome, index) => ({ outcome, index, at: rank.get(caseIdOf(outcome.name)) ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.at - b.at || a.index - b.index)
    .map((entry) => entry.outcome);
}

export function summariseLedger(ledger: SuiteLedger): LedgerSummary {
  const counts = { passed: 0, failed: 0, review: 0, blocked: 0 };
  for (const id of ledger.planned) {
    const o = ledger.outcomes[id];
    if (o) counts[o.verdict] += 1;
  }
  const reached = counts.passed + counts.failed + counts.review + counts.blocked;
  return { planned: ledger.planned.length, ...counts, notReached: Math.max(0, ledger.planned.length - reached) };
}
