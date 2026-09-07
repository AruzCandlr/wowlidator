#!/usr/bin/env node
// Print the state of a stopped catalog run from its ledger.
// Usage: node .claude/skills/catalog-triage/ledger.mjs <path-to-.claims.progress.json> [--reasons]

import { readFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';

const [, , path, ...rest] = process.argv;
if (!path) {
  console.error('usage: ledger.mjs <path-to-.claims.progress.json> [--reasons]');
  process.exit(2);
}
if (!existsSync(path)) {
  console.error(`no ledger at ${path}`);
  console.error('a catalog run\'s ledger lives beside its claims file, in');
  console.error('<report-dir>/catalogs/ — never .wowlidator/catalogs/.');
  console.error('<report-dir> is WOWLIDATOR_REPORT_DIR when .env sets it,');
  console.error('and .wowlidator/reports otherwise. Check that first:');
  console.error("  grep -E '^WOWLIDATOR_REPORT_DIR=' .env");
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
const endedLabel = led.ended
  ? led.ended
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
