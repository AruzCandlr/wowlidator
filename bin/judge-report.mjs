#!/usr/bin/env node
/**
 * Two confusion matrices over one suite, side by side.
 *
 * The suite grades itself against the sheet's recorded Actual Result. An
 * independent judge (`judge-cases.mjs`) grades the same evidence without
 * seeing either that answer or the suite's verdict. Both are scored the same
 * way, so the comparison means something:
 *
 *   TP  the case says the application is broken, and the sheet agrees
 *   TN  the case says the application is fine, and the sheet agrees
 *   FP  the case cries wolf — a failure against an application that works
 *   FN  the case sails green past something the sheet records as broken
 *
 * FN is the expensive one. A suite full of FPs wastes a person's morning; a
 * suite with FNs tells them a broken thing is fine.
 *
 * Rows where the sheet never recorded a result are `unscored` and are counted
 * apart — with no ground truth there is nothing to be right or wrong about,
 * and folding them in either direction would invent an accuracy.
 *
 *   node bin/judge-report.mjs <ledger.progress.json> <judged.jsonl> [out.html]
 */
import { readFile, writeFile } from 'node:fs/promises';

const [, , ledgerPath, judgedPath, outPath] = process.argv;
if (!ledgerPath || !judgedPath) {
  console.error('usage: judge-report.mjs <ledger.progress.json> <judged.jsonl> [out.html]');
  process.exit(2);
}

const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
const judged = new Map(
  (await readFile(judgedPath, 'utf8'))
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
    .map((one) => [one.case, one]),
);

/** The one classification both judges are scored by (mirrors reporter/truth-table.ts). */
function classify(verdict, known) {
  if (known === null || known === undefined) return 'unscored';
  if (verdict === 'blocked' || verdict === 'no-evidence') return 'no-verdict';
  if (verdict === 'review') return 'review';
  if (verdict === 'failed') return known === 'failed' ? 'TP' : 'FP';
  return known === 'passed' ? 'TN' : 'FN';
}

const rows = [];
for (const [id, outcome] of Object.entries(ledger.outcomes ?? {})) {
  let known = null;
  let title = outcome.name ?? id;
  if (outcome.proofPath) {
    try {
      const bundle = JSON.parse(await readFile(outcome.proofPath, 'utf8'));
      known = bundle.generatedBy?.knownResult ?? null;
      title = bundle.generatedBy?.caseTitle ?? title;
    } catch {
      /* the bundle is gone; the row stays unscored */
    }
  }
  const judge = judged.get(id);
  rows.push({
    id,
    title,
    known,
    system: outcome.verdict,
    systemCls: classify(outcome.verdict, known),
    judge: judge?.verdict ?? null,
    judgeCls: judge ? classify(judge.verdict, known) : 'unscored',
    why: judge?.why ?? '',
    costUsd: judge?.costUsd ?? null,
  });
}

function tally(rows, key) {
  const of = (cls) => rows.filter((r) => r[key] === cls).length;
  const tp = of('TP');
  const tn = of('TN');
  const fp = of('FP');
  const fn = of('FN');
  const scored = tp + tn + fp + fn;
  const pct = (n) => (scored === 0 ? null : (n / scored) * 100);
  return {
    tp, tn, fp, fn, scored,
    noVerdict: of('no-verdict'),
    unscored: of('unscored'),
    tpPct: pct(tp), tnPct: pct(tn), fpPct: pct(fp), fnPct: pct(fn),
    accuracy: scored === 0 ? null : ((tp + tn) / scored) * 100,
    precision: tp + fp === 0 ? null : (tp / (tp + fp)) * 100,
    recall: tp + fn === 0 ? null : (tp / (tp + fn)) * 100,
  };
}

const system = tally(rows, 'systemCls');
const judge = tally(rows, 'judgeCls');
// Agreement is measured only where BOTH delivered a verdict on a scored row:
// counting "both declined" as agreement would flatter them both.
const comparable = rows.filter(
  (r) => ['TP', 'TN', 'FP', 'FN'].includes(r.systemCls) && ['TP', 'TN', 'FP', 'FN'].includes(r.judgeCls),
);
const agreed = comparable.filter((r) => r.systemCls === r.judgeCls);
const cost = rows.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);

const n = (v, d = 1) => (v === null ? '—' : `${v.toFixed(d)}%`);
const line = (label, t) =>
  `${label.padEnd(10)} TP ${String(t.tp).padStart(3)} ${n(t.tpPct).padStart(7)}   ` +
  `TN ${String(t.tn).padStart(3)} ${n(t.tnPct).padStart(7)}   ` +
  `FP ${String(t.fp).padStart(3)} ${n(t.fpPct).padStart(7)}   ` +
  `FN ${String(t.fn).padStart(3)} ${n(t.fnPct).padStart(7)}   ` +
  `| acc ${n(t.accuracy)}  prec ${n(t.precision)}  rec ${n(t.recall)}`;

console.log(`cases recorded: ${rows.length}   scored by the sheet: system ${system.scored}, judge ${judge.scored}`);
console.log(`no verdict: system ${system.noVerdict}, judge ${judge.noVerdict}   unscored rows: ${system.unscored}`);
console.log('');
console.log(line('system', system));
console.log(line('judge', judge));
console.log('');
console.log(
  `agreement where both ruled: ${agreed.length}/${comparable.length}` +
    (comparable.length ? ` (${((agreed.length / comparable.length) * 100).toFixed(1)}%)` : ''),
);
console.log(`judge cost: $${cost.toFixed(2)}`);

const disagreements = comparable.filter((r) => r.systemCls !== r.judgeCls);
if (disagreements.length > 0) {
  console.log('\nwhere they differ — one of the two is wrong about each of these:');
  for (const r of disagreements) {
    console.log(`  ${r.id.padEnd(10)} sheet=${String(r.known).padEnd(6)} system=${r.system}/${r.systemCls}  judge=${r.judge}/${r.judgeCls}  — ${r.why.slice(0, 90)}`);
  }
}

if (!outPath) process.exit(0);

const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const cell = (t, k, p) => `<td class="num ${k.toLowerCase()}"><b>${t[k.toLowerCase()]}</b><span>${n(t[p])}</span></td>`;
const matrix = (label, t) => `<tr><th>${label}</th>
  ${cell(t, 'TP', 'tpPct')}${cell(t, 'TN', 'tnPct')}${cell(t, 'FP', 'fpPct')}${cell(t, 'FN', 'fnPct')}
  <td class="num">${n(t.accuracy)}</td><td class="num">${n(t.precision)}</td><td class="num">${n(t.recall)}</td>
  <td class="num muted">${t.noVerdict}</td></tr>`;

await writeFile(
  outPath,
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Suite accuracy — two judges</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><style>
 :root{--bg:#fbfaf8;--fg:#1a1a1a;--muted:#6b6b6b;--line:#e3e0da;--card:#fff;
   --tp:#1f6f43;--tn:#2a5d9f;--fp:#8a5a00;--fn:#b4232b}
 @media (prefers-color-scheme:dark){:root{--bg:#151513;--fg:#eceae6;--muted:#9a978f;--line:#2c2c28;--card:#1d1d1a}}
 *{box-sizing:border-box}
 body{margin:0;padding:32px 20px;background:var(--bg);color:var(--fg);
  font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
 main{max-width:960px;margin:0 auto}h1{font-size:24px;margin:0 0 4px}
 .sub{color:var(--muted);margin:0 0 24px}
 table{width:100%;border-collapse:collapse;background:var(--card);
  border:1px solid var(--line);border-radius:10px;overflow:hidden;margin-bottom:22px}
 th,td{padding:10px 12px;text-align:left;border-bottom:1px solid var(--line);font-size:14px}
 thead th{font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted)}
 tr:last-child td{border-bottom:0}
 .num{text-align:right;font-variant-numeric:tabular-nums}
 .num b{display:block;font-size:17px}.num span{font-size:12px;color:var(--muted)}
 .tp b{color:var(--tp)}.tn b{color:var(--tn)}.fp b{color:var(--fp)}.fn b{color:var(--fn)}
 .muted{color:var(--muted)}
 .note{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-bottom:22px}
 code{font-size:13px}
</style></head><body><main>
<h1>Suite accuracy — two judges, one set of evidence</h1>
<p class="sub">${esc(rows.length)} cases recorded · ground truth is the sheet's own recorded Actual Result · judge: ${esc([...judged.values()][0]?.model ?? 'n/a')}, blind to both the sheet and the suite's verdict</p>
<div class="note"><b>How to read it.</b> <b>TP</b> — said broken, and the sheet agrees. <b>TN</b> — said fine, and the sheet agrees.
<b>FP</b> — cried wolf against a working application. <b>FN</b> — sailed green past something the sheet records as broken.
FN is the expensive one: an FP wastes a morning, an FN tells you a broken thing is fine.
Percentages are of the cases that produced a verdict against a scored row; rows the sheet never scored are counted apart.</div>
<table><thead><tr><th></th><th class="num">TP</th><th class="num">TN</th><th class="num">FP</th><th class="num">FN</th>
<th class="num">accuracy</th><th class="num">precision</th><th class="num">recall</th><th class="num">no verdict</th></tr></thead>
<tbody>${matrix('This system', system)}${matrix('Claude judge', judge)}</tbody></table>
<div class="note"><b>Agreement where both ruled:</b> ${esc(agreed.length)}/${esc(comparable.length)}${comparable.length ? ` (${((agreed.length / comparable.length) * 100).toFixed(1)}%)` : ''}.
Measured only where both delivered a verdict on a scored row — counting "both declined" as agreement would flatter them both. Judge cost: $${cost.toFixed(2)}.</div>
${disagreements.length ? `<table><thead><tr><th>case</th><th>sheet</th><th>system</th><th>judge</th><th>the judge's reason</th></tr></thead><tbody>
${disagreements.map((r) => `<tr><td><code>${esc(r.id)}</code></td><td>${esc(r.known)}</td>
<td class="${r.systemCls.toLowerCase()}">${esc(r.system)} <b>${esc(r.systemCls)}</b></td>
<td class="${r.judgeCls.toLowerCase()}">${esc(r.judge)} <b>${esc(r.judgeCls)}</b></td>
<td class="muted">${esc(r.why)}</td></tr>`).join('\n')}</tbody></table>` : ''}
</main></body></html>
`,
  'utf8',
);
console.log(`\nwrote ${outPath}`);
