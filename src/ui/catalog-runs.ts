/**
 * The record's run list for catalogs — read from the ledgers on disk, not
 * from the panel's memory.
 *
 * `JobRunner` forgets every job when the panel restarts, but a catalog run's
 * progress ledger (`<claims>.progress.json`, see `cli/suite-progress.ts`)
 * survives on disk with everything a "continue this catalog" list needs: the
 * run key minted at initialisation, the plan, every verdict so far, how it
 * ended, and — since the ledger learned `launch` — enough to rebuild the
 * resume command. This module is the read side; the resume route in
 * `server.ts` is the write side.
 *
 * Only the two directories claims files are known to land in are scanned (the
 * panel's uploads and the report directory's `catalogs/`), the same
 * known-roots reasoning as file serving: the client never names a path, it
 * picks from what the server itself discovered.
 */

import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  readLedger,
  remaining,
  summariseLedger,
  isErrorOutcome,
  isFailedOutcome,
  type LedgerSummary,
  type SuiteLedger,
} from '../cli/suite-progress.js';
import { CATALOG_DIR } from './uploads.js';

export interface CatalogRunEntry {
  /** Absolute path of the ledger — the id a resume request must echo back. */
  ledgerPath: string;
  title: string;
  /** `<catalog>@<stamp>` — the run's unique key. Null for pre-key ledgers. */
  runKey: string | null;
  generatedAt: string | null;
  startedAt: string;
  updatedAt: string;
  summary: LedgerSummary;
  /** Planned cases still without a verdict — what Continue would run. */
  left: number;
  /** Recorded cases the harness ended (error bundle or none) — Rerun errors. */
  errors: number;
  /** Recorded failed / dead-end cases — Heal all failed. */
  failed: number;
  ended: SuiteLedger['ended'];
  /** True when a resume has work to do: cases never reached, blocked, or vacuous. */
  resumable: boolean;
  /** What started the run, when the ledger recorded it. Without it a resume
   *  can only reuse a same-session job's argv. */
  launch: SuiteLedger['launch'] | null;
}

const LEDGER_SUFFIX = '.progress.json';
const MAX_LISTED = 50;

/** The directories catalog ledgers land in, for one report dir. */
function catalogRunRoots(reportDir: string): string[] {
  return [...new Set([resolve(CATALOG_DIR), join(resolve(reportDir), 'catalogs')])];
}

function toEntry(ledgerPath: string, ledger: SuiteLedger): CatalogRunEntry {
  const outcomes = Object.values(ledger.outcomes);
  const left = remaining(ledger).length;
  return {
    ledgerPath,
    title: ledger.title,
    runKey: ledger.runKey,
    generatedAt: ledger.generatedAt,
    startedAt: ledger.startedAt,
    updatedAt: ledger.updatedAt,
    summary: summariseLedger(ledger),
    left,
    errors: outcomes.filter(isErrorOutcome).length,
    failed: outcomes.filter(isFailedOutcome).length,
    ended: ledger.ended,
    resumable: left > 0,
    launch: ledger.launch ?? null,
  };
}

/**
 * Every catalog run the disk remembers, newest movement first. An unreadable
 * or foreign file is skipped, never fatal — the list is a view, not a check.
 */
export async function listCatalogRuns(reportDir: string): Promise<CatalogRunEntry[]> {
  const entries: CatalogRunEntry[] = [];
  const seen = new Set<string>();
  for (const root of catalogRunRoots(reportDir)) {
    const names = await readdir(root).catch(() => [] as string[]);
    for (const name of names) {
      if (!name.endsWith(LEDGER_SUFFIX)) continue;
      const path = resolve(join(root, name));
      if (seen.has(path)) continue;
      seen.add(path);
      const ledger = await readLedger(path);
      if (ledger === null) continue;
      entries.push(toEntry(path, ledger));
    }
  }
  return entries
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, MAX_LISTED);
}
