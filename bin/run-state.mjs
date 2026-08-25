#!/usr/bin/env node
/**
 * One honest reading of a catalog run's state, as JSON.
 *
 * The supervisor's eyes. Every judgement it makes — is the run alive, is it
 * progressing, has it finished — comes from here, so there is exactly one
 * definition of each and a human can run it by hand and see the same thing.
 *
 *   node bin/run-state.mjs <ledger.progress.json> [uiOrigin]
 */
import { readFile } from 'node:fs/promises';

const ledgerPath = process.argv[2];
const uiOrigin = process.argv[3] ?? 'http://127.0.0.1:4600';
if (!ledgerPath) {
  console.error('usage: run-state.mjs <ledger.progress.json> [uiOrigin]');
  process.exit(2);
}

const reachable = async (url) => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2500) });
    return response.ok;
  } catch {
    return false;
  }
};

let ledger = null;
try {
  ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
} catch (error) {
  ledger = { error: String(error?.message ?? error) };
}

const planned = Array.isArray(ledger?.planned) ? ledger.planned : [];
const outcomes = ledger?.outcomes ?? [];
const list = Array.isArray(outcomes) ? outcomes : Object.values(outcomes);
// A case with a verdict is a case that ran. `blocked` counts as reached —
// nothing was proved, but the suite did get to it and will not revisit it
// without an explicit --rerun flag.
const byVerdict = {};
for (const one of list) {
  const verdict = one?.verdict ?? 'unknown';
  byVerdict[verdict] = (byVerdict[verdict] ?? 0) + 1;
}

// Jobs, when the panel is up. A run started from a terminal has none, so the
// process check below is the fallback and neither is required.
let jobs = [];
try {
  const response = await fetch(`${uiOrigin}/api/jobs`, { signal: AbortSignal.timeout(2500) });
  if (response.ok) jobs = (await response.json()).jobs ?? [];
} catch {
  /* the panel is not up; the process check answers instead */
}
// Sorted by when they started, oldest first — the panel returns newest-first
// and "the last catalog job" must not depend on which end that is.
const catalogJobs = jobs
  .filter((job) => (job.commandLine ?? '').includes('catalog'))
  .sort((a, b) => Date.parse(a.startedAt ?? 0) - Date.parse(b.startedAt ?? 0));
const runningJob = catalogJobs.find((job) => job.status === 'running' || job.status === 'queued');
const lastJob = catalogJobs[catalogJobs.length - 1] ?? null;

const updatedAt = ledger?.updatedAt ? Date.parse(ledger.updatedAt) : null;
const staleMs = updatedAt === null ? null : Date.now() - updatedAt;

console.log(
  JSON.stringify(
    {
      ledgerPath,
      runKey: ledger?.runKey ?? null,
      planned: planned.length,
      recorded: list.length,
      remaining: Math.max(0, planned.length - list.length),
      byVerdict,
      complete: planned.length > 0 && list.length >= planned.length,
      ended: ledger?.ended ?? null,
      updatedAt: ledger?.updatedAt ?? null,
      staleMs,
      running: runningJob !== undefined,
      runningJobId: runningJob?.id ?? null,
      lastJob: lastJob && {
        id: lastJob.id,
        status: lastJob.status,
        exitCode: lastJob.exitCode ?? null,
        finishedAt: lastJob.finishedAt ?? null,
      },
      env: {
        cdp: await reachable('http://localhost:9222/json/version'),
        app: await reachable('http://localhost:3000/en/login'),
        ui: jobs.length > 0 || (await reachable(`${uiOrigin}/api/meta`)),
      },
    },
    null,
    2,
  ),
);
