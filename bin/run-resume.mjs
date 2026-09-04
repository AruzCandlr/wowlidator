#!/usr/bin/env node
/**
 * Resume a catalog run that stopped short, under its original run key.
 *
 * Uses the panel's own `/api/catalog-runs/resume`, which replays the prior
 * job's argv with the resume flags stripped and the chosen mode added. That is
 * the faithful path and the only one that cannot silently change the terms of
 * a suite half-way through: the ledger's own `launch` record holds catalog,
 * claims and url and NOT the context documents or `--no-backend`, so
 * reconstructing a command from it would quietly author the rest of the run
 * against different evidence.
 *
 * The endpoint also refuses while a run is going, so a supervisor that fires
 * twice cannot start two runs over one ledger.
 *
 *   node bin/run-resume.mjs <ledger.progress.json> [mode] [uiOrigin]
 *
 * `mode` is continue (default) | errors | failed | vacuous.
 */
import { resolve } from 'node:path';

const ledgerPath = process.argv[2];
const mode = process.argv[3] ?? 'continue';
const uiOrigin = process.argv[4] ?? 'http://127.0.0.1:4600';
if (!ledgerPath) {
  console.error('usage: run-resume.mjs <ledger.progress.json> [mode] [uiOrigin]');
  process.exit(2);
}

const response = await fetch(`${uiOrigin}/api/catalog-runs/resume`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ ledgerPath: resolve(ledgerPath), mode }),
  signal: AbortSignal.timeout(15_000),
});
const body = await response.json().catch(() => ({}));
if (!response.ok) {
  console.error(`resume refused (${response.status}): ${body.error ?? 'unknown'}`);
  process.exit(3);
}
console.log(body.job?.id ?? JSON.stringify(body));
