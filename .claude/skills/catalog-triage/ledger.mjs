#!/usr/bin/env node
// Print the state of a stopped catalog run from its ledger.
// Usage: node .claude/skills/catalog-triage/ledger.mjs [<ledger path> | <run folder or its name> | latest] [--reasons]
//
// The ledger is found the way `wowlidate`'s own scripts find it (`paths.mjs`):
// a run launched through `newrun.mjs` keeps its ledger in
// `<report-dir>/runs/<slug>-<stamp>/catalogs/`, which a fresh shell cannot
// see through WOWLIDATOR_REPORT_DIR alone — that is the "no ledger" a triage
// used to print about a run with a perfectly good one (2026-09-10).

import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { describeLedgerSearch, findLedger, loadDotEnv } from '../wowlidate/paths.mjs';

const args = process.argv.slice(2);
const ref = args.find((a) => !a.startsWith('--'));
const rest = args.filter((a) => a.startsWith('--'));
loadDotEnv();
const path = findLedger(ref);
if (path === null) {
  console.error(ref === undefined || ref === 'latest' ? 'no ledger found anywhere a run on this machine writes' : `no ledger matches ${ref}`);
  console.error(describeLedgerSearch());
  console.error('a run launched with newrun.mjs keeps its ledger in <report-dir>/runs/<slug>-<stamp>/catalogs/;');
  console.error('one launched by hand keeps it in <report-dir>/catalogs/, where <report-dir> is');
  console.error("WOWLIDATOR_REPORT_DIR when .env sets it (grep -E '^WOWLIDATOR_REPORT_DIR=' .env), else .wowlidator/reports.");
  console.error('a folder with a log and no ledger is a run that has not sealed its first case yet, or died before it.');
  process.exit(2);
}

let led;
try {
  led = JSON.parse(readFileSync(path, 'utf8'));
} catch (err) {
  console.error(`${basename(path)} is not readable JSON: ${err.message}`);
  process.exit(2);
}

const planned = Array.isArray(led.planned) ? led.planned : [];
const outcomes = led.outcomes && typeof led.outcomes === 'object' ? led.outcomes : {};
const authored = led.authored && typeof led.authored === 'object' ? led.authored : {};
const sealed = Object.entries(outcomes);
const neverRan = planned.filter((id) => !(id in outcomes));

const tally = {};
for (const [, o] of sealed) {
  const v = o?.verdict ?? o?.status ?? 'unknown';
  tally[v] = (tally[v] ?? 0) + 1;
}

const pad = (s, n) => String(s).padEnd(n);
console.log(`ledger        : ${basename(path)}`);
console.log(`runKey        : ${led.runKey ?? '(none)'}`);
// `ended: null` means either "still running" or "stopped short"; the only way to
// tell them apart from the file alone is how recently it was written.
const ageMin = led.updatedAt ? (Date.now() - Date.parse(led.updatedAt)) / 60000 : Infinity;
const endedText = typeof led.ended === 'object' && led.ended !== null
  ? JSON.stringify(led.ended)
  : led.ended;
const endedLabel = endedText
  ? endedText
  : ageMin < 5
    ? `null  — written ${ageMin.toFixed(1)} min ago, so probably STILL RUNNING`
    : `null  — it STOPPED, it did not finish (last written ${ageMin.toFixed(0)} min ago)`;
console.log(`ended         : ${endedLabel}`);
console.log(`started       : ${led.startedAt ?? '?'}`);
console.log(`last updated  : ${led.updatedAt ?? '?'}`);
console.log('');
console.log(`planned       : ${planned.length}`);
console.log(`sealed        : ${sealed.length}`);
for (const [v, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
  console.log(`   ${pad(v, 11)}: ${n}`);
}
console.log(`never ran     : ${neverRan.length}   (no entry in outcomes — reached by nobody, usually cheap)`);
console.log(`authored      : ${Object.keys(authored).length}   (reused free on --resume)`);

// Authored flows must resolve on THIS machine; flowPath is absolute.
const missing = Object.entries(authored).filter(([, a]) => !a?.flowPath || !existsSync(a.flowPath));
if (missing.length) {
  console.log('');
  console.log(`!! ${missing.length} authored flowPath(s) do not resolve here.`);
  console.log('   flowPath is absolute. If this ledger came from another checkout,');
  console.log('   copy the flow tree and rewrite the prefix before resuming —');
  console.log('   otherwise every one of these rows is authored again from scratch.');
  for (const [id, a] of missing.slice(0, 5)) console.log(`   ${id}  ${a?.flowPath ?? '(no path)'}`);
  if (missing.length > 5) console.log(`   … and ${missing.length - 5} more`);
}

const launch = led.launch ?? {};
console.log('');
console.log('launch it actually used (match these on the resume):');
for (const k of ['catalog', 'url', 'persona', 'includeBlocked', 'policy']) {
  if (launch[k] !== undefined) console.log(`   ${pad(k, 15)} ${JSON.stringify(launch[k])}`);
}
if (launch.personas) console.log(`   ${pad('personas', 15)} ${Object.keys(launch.personas).join(', ')}`);

if (rest.includes('--reasons')) {
  console.log('');
  console.log('sealed reasons, most common first:');
  const byReason = {};
  for (const [id, o] of sealed) {
    const r = (o?.reason ?? '(no reason recorded)').slice(0, 90).replace(/\s+/g, ' ');
    (byReason[r] ??= []).push(id);
  }
  for (const [r, ids] of Object.entries(byReason).sort((a, b) => b[1].length - a[1].length).slice(0, 20)) {
    console.log(`   ${String(ids.length).padStart(4)}  ${r}`);
    console.log(`         e.g. ${ids.slice(0, 6).join(', ')}`);
  }
}
