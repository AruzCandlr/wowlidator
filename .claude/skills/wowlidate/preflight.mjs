#!/usr/bin/env npx tsx
/**
 * What would this catalog run actually prove, before it spends a browser on it?
 *
 * The costly failure this exists to prevent, measured 2026-09-07: a 309-case EC
 * run launched with eight Chromes and five model roles refused 308 of its cases
 * before a single model call, because no persona credentials were supplied. The
 * refusal is written at AUTHORING_REFUSAL_CAP, so a later plain `--resume`
 * honours it as final. Forty minutes of setup produced one verdict.
 *
 * Every answer here comes from the project's own readers — `parseTestCaseTable`,
 * `parseWorkbookCases`, `tablePersonas` — never a second parser. A preflight
 * that disagrees with the run it is predicting is worse than no preflight.
 *
 * Usage:
 *   npx tsx .claude/skills/wowlidate/preflight.mjs <catalog> [--as <email>:<pw>]
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(new URL('../../../', import.meta.url).pathname);
const { parseTestCaseTable, parseWorkbookCases, tablePersonas, personasOf, sheetGateReason } =
  await import(resolve(root, 'src/catalog/test-case-table.ts'));
const { extractWorkbookSheets } = await import(resolve(root, 'src/catalog/extract.ts'));
const { parsePersonas } = await import(resolve(root, 'src/cli/options.ts'));

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (file === undefined) {
  console.error('usage: preflight.mjs <catalog> [--as <email>:<pw>] [--include-blocked]');
  process.exit(2);
}
const asAt = args.indexOf('--as');
const asFlag = asAt < 0 ? undefined : args[asAt + 1];
const includeBlocked = args.includes('--include-blocked');

// `.env` is where WOWLIDATOR_PERSONAS is documented to live, and the CLI loads
// it before the persona parser runs (src/cli.ts, `loadDotEnv`). Read it the
// same way, or the preflight reports a gap the real run would not have.
try {
  const env = await readFile(resolve(root, '.env'), 'utf8');
  for (const line of env.split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq <= 0 || line.trimStart().startsWith('#')) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length > 1 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
} catch { /* no .env is normal */ }

let bytes;
try {
  bytes = await readFile(resolve(file));
} catch {
  console.error(`cannot read the catalog: ${file}`);
  process.exit(2);
}
let rows = null;
if (/\.xlsx$/i.test(file)) rows = parseWorkbookCases(extractWorkbookSheets(bytes));
else rows = parseTestCaseTable(bytes.toString('utf8'));

if (rows === null || rows.length === 0) {
  console.log(`${file} is not this project's test-case table — the claims phase will read it with a model.`);
  console.log('Persona coverage cannot be predicted for it; run `--claims-only` first and review the claims.');
  process.exit(0);
}

const parsed = parsePersonas(asFlag === undefined ? [] : [], process.env);
if (!parsed.ok) {
  console.error(`WOWLIDATOR_PERSONAS is malformed: ${parsed.error}`);
  process.exit(1);
}
const have = new Set(Object.keys(parsed.personas));
const asAccount = asFlag ?? process.env['WOWLIDATOR_AS'];

// The gate rows never reach: the sheet's own testers marked them Cancelled or
// Blocked, and authoring drops them before personas are even looked at.
const gated = [];
const live = [];
for (const row of rows) {
  const reason = sheetGateReason(row, { includeBlocked });
  if (reason !== null) gated.push({ row, reason });
  else live.push(row);
}

// A row's FIRST persona may fall back to the unlabelled --as account; a second
// may not, because one session cannot be two people (CG-05).
let ready = 0;
const blockedBy = new Map();
const blockedCases = [];
for (const row of live) {
  const labels = personasOf(row);
  const missing = labels.filter((label, index) => {
    if (have.has(label)) return false;
    return !(index === 0 && asAccount !== undefined);
  });
  if (missing.length === 0) ready++;
  else {
    blockedCases.push(row.caseId || row.scenarioId);
    for (const label of missing) blockedBy.set(label, (blockedBy.get(label) ?? 0) + 1);
  }
}

const pct = (n) => `${((n / live.length) * 100).toFixed(0)}%`;
console.log(`catalog       : ${file}`);
console.log(`rows read     : ${rows.length}  (the project's own table format — no model call)`);
console.log(`sheet-gated   : ${gated.length}${includeBlocked ? '' : '  (pass --include-blocked to author Blocked/Pending rows)'}`);
console.log(`live rows     : ${live.length}`);
console.log(`credentials   : ${have.size === 0 ? '(none)' : [...have].sort().join(', ')}${asAccount === undefined ? '' : `  + --as fallback (${asAccount.split(':')[0]})`}`);
console.log('');
console.log(`WOULD AUTHOR  : ${ready} of ${live.length}  (${pct(ready)})`);
console.log(`WOULD BLOCK   : ${live.length - ready}  (${pct(live.length - ready)})`);

if (blockedBy.size > 0) {
  console.log('');
  console.log('missing persona credentials, by rows blocked:');
  for (const [label, n] of [...blockedBy].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${label}`);
  }
  console.log('');
  console.log('Add them to .env (gitignored, and loaded before the persona parser):');
  const example = [...blockedBy.keys()]
    .map((label) => `"${label}":{"email":"…","password":"…"}`)
    .join(',');
  console.log(`  WOWLIDATOR_PERSONAS={${example}}`);
  console.log('');
  console.log('A blocked row is refused at AUTHORING_REFUSAL_CAP — a later plain --resume');
  console.log('will NOT re-author it. Fix credentials before the run, not after.');
}

process.exit(ready === 0 ? 1 : 0);
