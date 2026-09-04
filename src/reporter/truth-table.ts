/**
 * The truth table: a suite's verdicts graded against the sheet's own record.
 *
 * A test-case table that carries an *Actual Result* column is ground truth —
 * a person ran every case by hand and wrote down what happened — and a suite
 * run over such a catalog can therefore be scored: TP (wowlidator failed a
 * case the human failed — a bug correctly caught), TN (both passed), FP
 * (wowlidator failed a case the human passed — a false alarm), FN (wowlidator
 * passed a case the human failed — a bug missed). A case that produced no
 * verdict (`blocked` — the harness's own gap) agrees with nothing and is
 * bucketed separately, never counted against either side; rows the sheet
 * itself left unscored (Cancelled, Pending, blank) are disclosed as
 * `unscored`, never invented into a verdict.
 *
 * One catalog run → one self-contained HTML page listing every case. The
 * classification is pure arithmetic over verdicts already earned — it costs
 * zero model tokens, which is the point: accuracy is a free by-product of a
 * run, not a second run.
 *
 * The verdict graded is the suite's own acted-on
 * contract (a human ruling outranks needs-review; harness-only errors score
 * `blocked`) — with the bundle's raw status shown beside it so a dead-end
 * that scored as a failure is never hidden behind the grade.
 */

import { writeFile } from 'node:fs/promises';

import type { ProofBundle } from '../engine/proof-bundle.js';

/**
 * The slice of a suite outcome this module reads — structural on purpose:
 * `cli/` depends on `reporter/`, never the reverse, so the CLI's own
 * `CaseOutcome` satisfies this shape without this file importing it.
 */
export interface TruthOutcome {
  name: string;
  verdict: 'passed' | 'failed' | 'blocked' | 'review';
  bundle: ProofBundle | null;
  reason?: string | undefined;
}

/**
 * The sheet's own verdict for a row (CG-01): `passed` / `failed` from an
 * Actual Result or Test Status column, or `blocked` when the sheet's testers
 * recorded that they could not run it (Blocked, Pending deploy — 114 rows of
 * the HR workbook, most with a bug ticket). Blocked is a class of its own on
 * the page, never a blank: a suite verdict about such a row agrees with
 * nothing and is graded against nothing, but the reader must see that the
 * sheet said so rather than wonder why the row is unscored.
 */
export type KnownResult = 'passed' | 'failed' | 'blocked';

export type TruthClass = 'TP' | 'TN' | 'FP' | 'FN' | 'no-verdict' | 'review' | 'sheet-blocked' | 'unscored';

export interface TruthRow {
  name: string;
  scenario: string | null;
  polarity: string | null;
  /** The sheet's recorded result — the ground truth. Null = the sheet never scored the row. */
  known: KnownResult | null;
  verdict: TruthOutcome['verdict'];
  /** The bundle's raw status, so a dead-end graded as failed stays visible. */
  status: string | null;
  reason: string | null;
  durationMs: number | null;
  cls: TruthClass;
}

export function classifyTruth(
  verdict: TruthOutcome['verdict'],
  known: KnownResult | null,
): TruthClass {
  if (known === null) return 'unscored';
  // The sheet could not run it: nothing to agree or disagree with, whatever
  // this run found — excluded from accuracy like an unscored row, shown apart.
  if (known === 'blocked') return 'sheet-blocked';
  if (verdict === 'blocked') return 'no-verdict';
  if (verdict === 'review') return 'review';
  if (verdict === 'failed') return known === 'failed' ? 'TP' : 'FP';
  return known === 'passed' ? 'TN' : 'FN';
}

/**
 * Ground truth comes from the bundle's provenance stamp; a case that never
 * produced a bundle (blocked before it began) falls back to the flow's own
 * stamp via `knownByName`, so a scored case is never misfiled as unscored
 * just because the harness fell over first.
 */
export function truthRows(
  outcomes: readonly TruthOutcome[],
  knownByName?: ReadonlyMap<string, KnownResult>,
): TruthRow[] {
  return outcomes.map((outcome) => {
    const generated = outcome.bundle?.generatedBy;
    const known: KnownResult | null = generated?.knownResult ?? knownByName?.get(outcome.name) ?? null;
    return {
      name: outcome.name,
      scenario: generated?.scenario ?? null,
      polarity: outcome.bundle?.polarity ?? null,
      known,
      verdict: outcome.verdict,
      status: outcome.bundle?.status ?? null,
      reason: outcome.reason ?? null,
      durationMs: outcome.bundle?.durationMs ?? null,
      cls: classifyTruth(outcome.verdict, known),
    };
  });
}

export interface TruthTally {
  tp: number;
  tn: number;
  fp: number;
  fn: number;
  noVerdict: number;
  review: number;
  /** Rows the sheet itself recorded as Blocked / Pending — graded against nothing. */
  sheetBlocked: number;
  unscored: number;
  /** Of the cases that delivered a verdict against a scored row: (TP+TN)/(TP+TN+FP+FN). Null when none did. */
  accuracy: number | null;
  precision: number | null;
  recall: number | null;
}

export function truthTally(rows: readonly TruthRow[]): TruthTally {
  const of = (cls: TruthClass): number => rows.filter((r) => r.cls === cls).length;
  const tp = of('TP');
  const tn = of('TN');
  const fp = of('FP');
  const fn = of('FN');
  const scored = tp + tn + fp + fn;
  return {
    tp,
    tn,
    fp,
    fn,
    noVerdict: of('no-verdict'),
    review: of('review'),
    sheetBlocked: of('sheet-blocked'),
    unscored: of('unscored'),
    accuracy: scored === 0 ? null : (tp + tn) / scored,
    precision: tp + fp === 0 ? null : tp / (tp + fp),
    recall: tp + fn === 0 ? null : tp / (tp + fn),
  };
}

/** True when the catalog carries any ground truth at all — the gate for writing the page. */
export function hasGroundTruth(rows: readonly TruthRow[]): boolean {
  return rows.some((r) => r.known !== null);
}

const esc = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

const pct = (v: number | null): string => (v === null ? '–' : `${Math.round(v * 100)}%`);

const CLASS_LABEL: Record<TruthClass, string> = {
  TP: 'TP',
  TN: 'TN',
  FP: 'FP',
  FN: 'FN',
  'no-verdict': 'no verdict',
  review: 'review',
  'sheet-blocked': 'sheet: blocked',
  unscored: 'unscored',
};

export interface TruthTableMeta {
  /** The catalog the suite came from — the page's identity. */
  source: string;
  /** When the suite finished. */
  ranAt: string;
}

/** One self-contained page: matrix first, then every case. Opens off a USB stick. */
export function renderTruthTable(meta: TruthTableMeta, rows: readonly TruthRow[]): string {
  const t = truthTally(rows);
  const tr = rows
    .map(
      (r) => `<tr class="${r.cls === 'unscored' || r.cls === 'sheet-blocked' ? 'dim' : ''}">
<td class="nm">${esc(r.name)}</td>
<td>${esc(r.polarity ?? '—')}</td>
<td>${r.known === null ? '<span class="mut">—</span>' : esc(r.known)}</td>
<td class="${r.verdict === 'passed' ? 'ok' : r.verdict === 'failed' ? 'ko' : 'mut'}">${esc(r.verdict)}${
        r.status !== null && r.status !== r.verdict ? ` <span class="mut">(${esc(r.status)})</span>` : ''
      }</td>
<td><span class="chip c-${r.cls.replace(' ', '-').toLowerCase()}">${CLASS_LABEL[r.cls]}</span></td>
<td class="mut">${r.reason === null ? '' : esc(r.reason.slice(0, 140))}</td>
</tr>`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Truth table — ${esc(meta.source)}</title>
<style>
:root { --bg:#F4F7F6; --surface:#fff; --ink:#17231F; --muted:#5C6B66; --line:#DCE4E1;
  --good:#1F8A5A; --bad:#BF4238; --warn:#A8770F; --good-bg:#E4F2EA; --bad-bg:#F7E6E3;
  --warn-bg:#F5EDD8; --nv-bg:#E9EDEB; }
@media (prefers-color-scheme: dark) { :root { --bg:#0F1715; --surface:#16211E; --ink:#E6EEEA;
  --muted:#93A39D; --line:#24312D; --good:#3FBF83; --bad:#E06A5F; --warn:#D9A73E;
  --good-bg:#173226; --bad-bg:#33201D; --warn-bg:#2F2712; --nv-bg:#1D2926; } }
* { box-sizing:border-box }
body { background:var(--bg); color:var(--ink); margin:0;
  font:15px/1.55 system-ui, "IBM Plex Sans Thai", sans-serif; }
main { max-width:1060px; margin:0 auto; padding:2rem 1.3rem 4rem }
h1 { font-size:1.5rem; margin:0 0 .2rem } .meta { color:var(--muted); font-size:.85rem }
.mx { display:flex; gap:1rem; flex-wrap:wrap; margin:1.3rem 0 }
.cell { background:var(--surface); border:1px solid var(--line); border-radius:6px;
  padding:.7rem 1rem; min-width:7.5rem }
.cell b { display:block; font-size:1.4rem; font-variant-numeric:tabular-nums }
.cell span { font-size:.75rem; color:var(--muted); text-transform:uppercase; letter-spacing:.05em }
.cell.good { background:var(--good-bg) } .cell.bad { background:var(--bad-bg) }
.cell.warn { background:var(--warn-bg) } .cell.nv { background:var(--nv-bg) }
.stats { color:var(--muted); font-size:.9rem; margin:0 0 1.2rem }
.stats b { color:var(--ink); font-variant-numeric:tabular-nums }
.wrap { overflow-x:auto; background:var(--surface); border:1px solid var(--line); border-radius:6px }
table { border-collapse:collapse; width:100%; min-width:820px; font-size:.84rem }
th, td { text-align:left; padding:.45rem .6rem; border-top:1px solid var(--line); vertical-align:top }
thead th { border-top:0; font-size:.72rem; text-transform:uppercase; letter-spacing:.06em;
  color:var(--muted); position:sticky; top:0; background:var(--surface) }
td.nm { max-width:34ch; overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
tr.dim td { color:var(--muted) }
.ok { color:var(--good); font-weight:600 } .ko { color:var(--bad); font-weight:600 } .mut { color:var(--muted) }
.chip { font:600 .72rem/1 ui-monospace, monospace; padding:.25em .5em; border-radius:3px }
.c-tp,.c-tn { background:var(--good-bg); color:var(--good) }
.c-fp { background:var(--warn-bg); color:var(--warn) }
.c-fn { background:var(--bad-bg); color:var(--bad) }
.c-no-verdict,.c-review,.c-sheet-blocked { background:var(--nv-bg); color:var(--muted) }
.c-unscored { color:var(--muted); border:1px dashed var(--line); background:transparent }
.note { color:var(--muted); font-size:.8rem; max-width:72ch }
</style>
</head>
<body>
<main>
<h1>Truth table — ${esc(meta.source)}</h1>
<p class="meta">${rows.length} case(s) · ground truth: the sheet's recorded Actual Result ·
positive = wowlidator flagged a defect · finished ${esc(meta.ranAt)}</p>
<div class="mx">
<div class="cell good"><b>${t.tp}</b><span>TP · bug caught</span></div>
<div class="cell good"><b>${t.tn}</b><span>TN · pass agreed</span></div>
<div class="cell warn"><b>${t.fp}</b><span>FP · false alarm</span></div>
<div class="cell bad"><b>${t.fn}</b><span>FN · bug missed</span></div>
<div class="cell nv"><b>${t.noVerdict}</b><span>no verdict</span></div>
${t.review > 0 ? `<div class="cell nv"><b>${t.review}</b><span>awaiting review</span></div>` : ''}
${t.sheetBlocked > 0 ? `<div class="cell nv"><b>${t.sheetBlocked}</b><span>sheet: blocked</span></div>` : ''}
<div class="cell"><b>${t.unscored}</b><span>unscored</span></div>
</div>
<p class="stats">accuracy <b>${pct(t.accuracy)}</b> · precision <b>${pct(t.precision)}</b> ·
recall <b>${pct(t.recall)}</b> — over verdict-delivering cases only; a no-verdict case is the
harness's gap, counted against neither side, and a row the sheet itself recorded as blocked is
graded against nothing.</p>
<div class="wrap">
<table>
<thead><tr><th>case</th><th>pos/neg</th><th>sheet</th><th>wowlidator</th><th>class</th><th>detail</th></tr></thead>
<tbody>
${tr}
</tbody>
</table>
</div>
<p class="note">The sheet's verdicts were recorded against the application as it stood when a person
ran the cases — a disagreement can mean the tool is wrong, the app has since changed, or the data
has drifted. Treat FP/FN as a review queue, not a final score.</p>
</main>
</body>
</html>
`;
}

export async function writeTruthTable(path: string, html: string): Promise<string> {
  await writeFile(path, html, 'utf8');
  return path;
}
