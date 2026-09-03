/**
 * The index page for a multi-case run (spec R3).
 *
 * A generated suite writes one HTML file per case. Five cases on one page means
 * five files, no ordering, and no way to tell from the outside that case 04 is
 * the red one — so nobody opens any of them. The index is the missing front
 * door: one row per case, failures first, roll-up at the top.
 *
 * Same constraints as the case reports, for the same reason: self-contained (no
 * external anything) and **relatively linked**, so the whole folder can be
 * zipped, emailed, or published as a CI artifact and still work. Absolute paths
 * would break the moment the folder moved, which is the only thing folders like
 * this ever do.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';

import type { ProofBundle } from '../engine/proof-bundle.js';
import { effectiveStatus, isPassing, verdictFamily } from '../engine/proof-bundle.js';
import { displayCaseId, provenanceExtras, sheetLabel } from './step-facts.js';
import { buildVerdict } from './verdict.js';

export const DEFAULT_INDEX_FILENAME = 'index.html';

export interface IndexEntry {
  bundle: ProofBundle;
  /** Absolute path to that case's own report. */
  reportPath: string;
}

/**
 * A case that produced no verdict at all — the browser went away, the report
 * could not be written, something threw before there was a result.
 *
 * It has no bundle and no report, and it is still listed. An index that shows
 * seven rows for a suite of ten is the silent truncation this codebase refuses
 * everywhere else: the three that vanished look exactly like cases nobody wrote,
 * and the roll-up reads "7/7 passed". **Blocked is not failed** — the same
 * distinction `proofs-to-artifacts.py` makes for a step that never ran. Nothing
 * was learned about the application either way, and scoring it as a failure
 * would file the harness's own gap as a defect in the product.
 */
export interface BlockedEntry {
  name: string;
  /** What stopped it, in the words the caller saw. */
  reason: string;
  /**
   * Its report, when one was written. A run that attached to nothing still
   * produced a bundle saying so, and that is the evidence of what went wrong —
   * it is just not evidence about the application.
   */
  reportPath?: string | undefined;
}

/** Failures first, then flaky, then the rest — ordered by what needs attention. */
export function rankEntries(entries: readonly IndexEntry[]): IndexEntry[] {
  const rank = (entry: IndexEntry): number => {
    if (!isPassing(entry.bundle.status) && !entry.bundle.quarantined) return 0;
    if (entry.bundle.trend?.verdict === 'flaky' || entry.bundle.quarantined) return 1;
    return 2;
  };
  return [...entries].sort((a, b) => rank(a) - rank(b) || a.bundle.name.localeCompare(b.bundle.name));
}

function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function ms(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${Math.round(value)}ms`;
}

const STYLES = `
:root{--bg:#fbfaf7;--panel:#fff;--ink:#1b1a17;--muted:#6b675e;--line:#e5e1d8;
  --ok:#1f7a4d;--ok-bg:#e8f5ee;--bad:#b3261e;--bad-bg:#fdecea;--warn:#8a5a00;--warn-bg:#fdf1dc;--radius:10px}
@media (prefers-color-scheme:dark){:root{--bg:#14130f;--panel:#1c1a16;--ink:#f2efe6;--muted:#a09a8c;
  --line:#2f2b24;--ok:#5cc98d;--ok-bg:#16311f;--bad:#ff8b81;--bad-bg:#3a1d1a;--warn:#e8b45c;--warn-bg:#3a2c12}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 ui-sans-serif,-apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:960px;margin:0 auto;padding:32px 22px 64px}
h1{margin:0 0 4px;font-size:22px;letter-spacing:-.01em}
.sub{color:var(--muted);font-size:13px;margin-bottom:22px}
.rollup{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:24px}
.chip{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:12px 16px;min-width:120px}
.chip .v{font-size:22px;font-weight:650;letter-spacing:-.02em}
.chip .k{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.05em}
.chip.bad .v{color:var(--bad)}
.chip.ok .v{color:var(--ok)}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);
  border-radius:var(--radius);overflow:hidden}
th,td{text-align:left;padding:11px 14px;border-bottom:1px solid var(--line);font-size:13.5px;vertical-align:top}
th{font-size:11.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:600}
tr:last-child td{border-bottom:0}
tr.failed td:first-child{box-shadow:inset 3px 0 0 var(--bad)}
tr.passed td:first-child{box-shadow:inset 3px 0 0 var(--ok)}
.pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11.5px;font-weight:600}
.pill.failed{color:var(--bad);background:var(--bad-bg)}
.pill.passed{color:var(--ok);background:var(--ok-bg)}
.pill.quarantined,.pill.flaky{color:var(--warn);background:var(--warn-bg)}
/* Blocked is its own colour: not the green of a pass, and not the red of a
   failure either, because nothing was proved about the application. */
.pill.blocked{color:var(--muted);background:var(--line)}
/* Awaiting review (proved-? or recorded only) and no verdict (the harness
   alone broke) are each their own colour for the same reason: neither is a
   product failure, and painting them red files the harness's gap as a bug. */
.pill.review{color:#6a5acd;background:color-mix(in srgb,#6a5acd 14%,transparent);border:1px dashed #6a5acd}
.pill.error,.pill.no-verdict{color:var(--warn);background:var(--warn-bg)}
.pill.sheet{color:var(--muted);border:1px solid var(--line);margin-left:6px}
.sheet-id{color:var(--muted);font-size:12px;margin-left:6px}
.chip.review .v{color:#6a5acd}
.chip.warn .v{color:var(--warn)}
a.case{color:inherit;font-weight:600;text-decoration:none;border-bottom:1px solid var(--line)}
a.case:hover{border-bottom-color:currentColor}
.why{color:var(--muted);font-size:12.5px;margin-top:3px;max-width:70ch}
.num{text-align:right;white-space:nowrap;color:var(--muted);font-size:12.5px}
footer{margin-top:32px;color:var(--muted);font-size:12px}
`;

export interface SuiteIndexOptions {
  title?: string | undefined;
  /** Where the index will be written — links are made relative to it. */
  indexPath: string;
  /** Cases that never produced a verdict. Listed first; see `BlockedEntry`. */
  blocked?: readonly BlockedEntry[] | undefined;
}

/** Render the index. Pure, like every other renderer here. */
export function renderSuiteIndex(
  entries: readonly IndexEntry[],
  options: SuiteIndexOptions,
): string {
  const ranked = rankEntries(entries);
  const indexDir = dirname(resolve(options.indexPath));
  const blocked = options.blocked ?? [];
  // Every case that was listed, whether or not it produced anything. The
  // denominator is the whole point: "7/7 passed" out of ten cases is a lie the
  // reader has no way to catch.
  const total = ranked.length + blocked.length;

  // The acted-on status (a ruling outranks proved-?), bucketed APART: a
  // wording near-miss awaiting a human and a harness that fell over are not
  // product failures, and counting them under "failed" — as the first cut
  // did — filed the harness's own gap as defects in the application.
  const acted = (e: IndexEntry): string => effectiveStatus(e.bundle);
  const counted = ranked.filter((e) => !e.bundle.quarantined);
  const failed = counted.filter((e) => verdictFamily(acted(e)) === 'test-failed').length;
  const review = counted.filter((e) => acted(e) === 'needs-review').length;
  const noVerdict = counted.filter((e) => acted(e) === 'error').length;
  const quarantined = ranked.filter((e) => e.bundle.quarantined).length;
  const defects = ranked.reduce((n, e) => n + e.bundle.summary.defects, 0);
  const high = ranked.reduce(
    (n, e) => n + e.bundle.defects.filter((d) => d.severity === 'high').length,
    0,
  );
  const duration = ranked.reduce((n, e) => n + e.bundle.durationMs, 0);
  const title = options.title ?? 'wowlidator suite';

  // First: nothing is known about these, which is worse than a known failure.
  // No link, because there is no report to link to.
  const blockedRows = blocked
    .map((entry) => {
      const href =
        entry.reportPath === undefined
          ? null
          : relative(indexDir, resolve(entry.reportPath)) || basename(entry.reportPath);
      return `
      <tr class="blocked">
        <td><span class="pill blocked">blocked</span></td>
        <td>
          ${
            href === null
              ? `<span class="case">${esc(entry.name)}</span>`
              : `<a class="case" href="${esc(href)}">${esc(entry.name)}</a>`
          }
          <div class="why">Never ran, so it proves nothing either way — ${esc(entry.reason)}</div>
        </td>
        <td></td>
        <td class="num">—</td>
        <td class="num"></td>
        <td class="num">—</td>
      </tr>`;
    })
    .join('');

  const rows = ranked
    .map((entry) => {
      const { bundle } = entry;
      const verdict = buildVerdict(bundle);
      // Relative, always: this folder gets zipped and moved.
      const href = relative(indexDir, resolve(entry.reportPath)) || basename(entry.reportPath);
      const status = acted(entry);
      const state = bundle.quarantined ? 'quarantined' : status === 'needs-review' ? 'review' : status;
      const stateLabel = state === 'review' ? 'proved-?' : state === 'error' ? 'no verdict' : state;
      const trend =
        bundle.trend && bundle.trend.verdict !== 'stable'
          ? `<span class="pill ${esc(bundle.trend.verdict === 'flaky' ? 'flaky' : '')}">${esc(bundle.trend.verdict.replace(/-/g, ' '))}</span>`
          : '';
      // What the sheet itself recorded for the row (passed / failed / blocked)
      // beside what the run found, and the sheet's own case id when the run
      // qualified it — so a reader can grade the row without the truth table.
      const extras = provenanceExtras(bundle);
      const caseId = displayCaseId(bundle.name.split(/\s+/)[0] ?? bundle.name, extras.sheetCaseId);
      const sheet = sheetLabel(extras);
      const sheetPill = extras.sheetVerdict
        ? `<span class="pill sheet" title="what the sheet's own Actual Result column recorded for this row">sheet: ${esc(extras.sheetVerdict)}</span>`
        : '';
      return `
      <tr class="${esc(status)}">
        <td><span class="pill ${esc(state)}" title="machine status: ${esc(bundle.status)}">${esc(stateLabel)}</span></td>
        <td>
          <a class="case" href="${esc(href)}">${esc(bundle.name)}</a>${
            caseId.qualified ? `<span class="sheet-id" title="the sheet's own spelling; the run qualified it">sheet id ${esc(caseId.shown)}</span>` : ''
          }${sheet ? `<span class="pill sheet">${esc(sheet)}</span>` : ''}
          <div class="why">${esc(verdict.what)}</div>
        </td>
        <td>${trend}${verdict.owner ? `<span class="pill">${esc(verdict.owner)}</span>` : ''}${sheetPill}</td>
        <td class="num">${bundle.summary.passed}/${bundle.summary.totalSteps}</td>
        <td class="num">${bundle.summary.defects || ''}</td>
        <td class="num">${esc(ms(bundle.durationMs))}</td>
      </tr>`;
    })
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLES}</style>
</head>
<body>
<div class="wrap">
  <h1>${esc(title)}</h1>
  <div class="sub">${total} case${total === 1 ? '' : 's'} &middot; ${blocked.length > 0 ? 'blocked and failing' : 'failures'} listed first</div>

  <section class="rollup">
    <div class="chip ${failed > 0 ? 'bad' : 'ok'}"><div class="v">${ranked.length - failed - review - noVerdict}/${total}</div><div class="k">cases passed</div></div>
    ${failed > 0 ? `<div class="chip bad"><div class="v">${failed}</div><div class="k">test failed</div></div>` : ''}
    ${review > 0 ? `<div class="chip review"><div class="v">${review}</div><div class="k">awaiting review</div></div>` : ''}
    ${noVerdict > 0 ? `<div class="chip warn"><div class="v">${noVerdict}</div><div class="k">no verdict</div></div>` : ''}
    ${blocked.length > 0 ? `<div class="chip bad"><div class="v">${blocked.length}</div><div class="k">never ran</div></div>` : ''}
    <div class="chip"><div class="v">${defects}</div><div class="k">${high > 0 ? `findings (${high} high)` : 'findings'}</div></div>
    ${quarantined > 0 ? `<div class="chip"><div class="v">${quarantined}</div><div class="k">quarantined</div></div>` : ''}
    <div class="chip"><div class="v">${esc(ms(duration))}</div><div class="k">total time</div></div>
  </section>

  ${
    total === 0
      ? '<p class="why">No cases were run.</p>'
      : `<table>
    <thead><tr><th>result</th><th>case</th><th>notes</th><th class="num">steps</th><th class="num">findings</th><th class="num">time</th></tr></thead>
    <tbody>${blockedRows}${rows}</tbody>
  </table>`
  }

  <footer>wowlidator &middot; open any case for its full report</footer>
</div>
</body>
</html>`;
}

/** Write the index next to the case reports. Returns the absolute path. */
export async function writeSuiteIndex(
  entries: readonly IndexEntry[],
  indexPath: string,
  options: { title?: string | undefined; blocked?: readonly BlockedEntry[] | undefined } = {},
): Promise<string> {
  const path = resolve(indexPath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    renderSuiteIndex(entries, { ...options, indexPath: path }),
    'utf8',
  );
  return path;
}
