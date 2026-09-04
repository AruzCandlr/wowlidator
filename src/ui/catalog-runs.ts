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

import { readdir, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import {
  readLedger,
  remaining,
  summariseLedger,
  isErrorOutcome,
  isFailedOutcome,
  type LedgerSummary,
  type SuiteLedger,
} from '../cli/suite-progress.js';
import { catalogReportPath } from '../reporter/catalog-report.js';
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
  /** Every planned case id, in plan order — what maps a case row to its run. */
  planned: readonly string[];
  /**
   * The catalog report's file name under `reports/`, when the file exists —
   * what the panel's Report button opens (via `/reports/<file>`, so the
   * report's relative links to its workbooks resolve). Written at run start
   * and after every case, so it is there for a running catalog too.
   */
  reportFile: string | null;
  /** The account the run signed in as (email only), when the ledger recorded it. */
  persona: string | null;
}

const LEDGER_SUFFIX = '.progress.json';
const MAX_LISTED = 50;

/** The directories catalog ledgers land in, for one report dir. */
function catalogRunRoots(reportDir: string): string[] {
  return [...new Set([resolve(CATALOG_DIR), join(resolve(reportDir), 'catalogs')])];
}

async function toEntry(ledgerPath: string, ledger: SuiteLedger): Promise<CatalogRunEntry> {
  const outcomes = Object.values(ledger.outcomes);
  const left = remaining(ledger).length;
  const reportPath = catalogReportPath(ledger.runKey, ledger.title);
  const reportFile = (await stat(reportPath).catch(() => null))?.isFile() ? basename(reportPath) : null;
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
    planned: ledger.planned,
    reportFile,
    persona: ledger.launch?.persona ?? null,
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
      entries.push(await toEntry(path, ledger));
    }
  }
  return entries
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, MAX_LISTED);
}

/** One account a resume still needs the password for. Label and email only. */
export interface MissingPersona {
  label: string;
  email: string;
}

/**
 * Which of a recorded run's accounts still have no password, and what the
 * resume may therefore send the job.
 *
 * The gate this generalises used to read `launch.persona` alone — the single
 * `--as` email. A catalog whose rows change hands names more than one account,
 * `launch.personas` (label → email) has recorded them all along, and nothing
 * read it: a resume after a panel restart started with the first account's
 * password and none of the others, and every case needing the second person
 * died at its `signIn` with `PersonaUnknownError`. Refusing with the list is
 * the same choice the single-persona gate already made, applied to N.
 *
 * The caller supplies passwords BY LABEL and nothing else. Each is paired here
 * with the email the LEDGER recorded, so a client can hand over the secret half
 * and cannot redirect the run at a different account — the same "make the
 * question not arise" shape as addressing a proof by runId.
 *
 * `env` is consulted because a machine whose own environment already carries
 * `WOWLIDATOR_PERSONAS` needs no asking; `inherited` is the prior job's secret
 * environment, which is why a resume in the SAME panel session never asks.
 */
export function missingPersonaPasswords(
  launch: SuiteLedger['launch'] | null,
  inherited: Record<string, string> | undefined,
  env: NodeJS.ProcessEnv,
  supplied: Readonly<Record<string, string>> = {},
): { missing: MissingPersona[]; personas: Record<string, { email: string; password: string }> } {
  const recorded = launch?.personas ?? {};
  const labels = Object.keys(recorded);
  if (labels.length === 0) return { missing: [], personas: {} };

  // Whatever is already known, in the order a run would resolve it.
  const known = new Map<string, { email: string; password: string }>();
  for (const source of [env['WOWLIDATOR_PERSONAS'], inherited?.['WOWLIDATOR_PERSONAS']]) {
    if (typeof source !== 'string' || source === '') continue;
    try {
      const parsed = JSON.parse(source) as Record<string, { email?: unknown; password?: unknown }>;
      for (const [label, value] of Object.entries(parsed)) {
        if (typeof value?.email === 'string' && typeof value.password === 'string') {
          known.set(label, { email: value.email, password: value.password });
        }
      }
    } catch {
      // A malformed map is "nothing known", never a crash: the worst case is
      // asking for a password the caller already had.
    }
  }

  const personas: Record<string, { email: string; password: string }> = {};
  const missing: MissingPersona[] = [];
  for (const label of labels) {
    const email = recorded[label] ?? '';
    const password = supplied[label];
    if (typeof password === 'string' && password !== '') {
      // The email is the LEDGER's, never the caller's.
      personas[label] = { email, password };
      continue;
    }
    const already = known.get(label);
    if (already !== undefined) {
      personas[label] = already;
      continue;
    }
    missing.push({ label, email });
  }
  return { missing, personas };
}
