/**
 * The catalog report — one self-contained HTML file per catalog RUN, written
 * into the local `reports/` folder (asked for 2026-08-31).
 *
 * What makes it different from the per-case report and the suite index:
 * - **Every planned case of the catalog is on it**, grouped by scenario —
 *   including the ones that never ran (a report of 13 rows for a 108-row
 *   catalog reads as a 13-row catalog).
 * - **It is one file with the evidence inside**: screenshots are embedded as
 *   data URIs, so the file can be mailed or archived whole. Failure stills
 *   are always embedded; routine stills are embedded until a size budget is
 *   spent, then omitted with a note naming where they live (the proof
 *   bundle) — a 200MB report helps nobody.
 * - **The film is here too, and it is the evidence a passing case has**
 *   (2026-08-31). The runner's screenshot default is video-aware: while it is
 *   filming, stills are taken only at failures, because the film covers the
 *   rest. Measured on be100-rip, that is exactly what the bundles hold — all
 *   13 non-passing cases carry stills and 18 of 19 passing ones carry none —
 *   so a report that dropped the recording left a reader with no evidence at
 *   all for every case that worked. Same budget rule as the stills, same
 *   priority: a case that did not pass keeps its recording first.
 * - **A case opens into a two-pane view**: LEFT the steps, each expandable
 *   into its full detail (intent, selector, resolution, error, heal, agent
 *   turns, screenshot) plus an explanation drawn from the run history (trend,
 *   how long it has been broken, whether the same step shape failed before);
 *   RIGHT the time record — one bar per step against the fast-path budget,
 *   with the slowest steps called out.
 * - **Export from the page itself**: every case has an Export button that
 *   downloads a standalone HTML of just that case (styles and evidence
 *   included), and the header exports the whole catalog file. Client-side
 *   Blob + anchor download — no server involved.
 *
 * Pure render (`renderCatalogReport`) + one writer (`writeCatalogReport`), the
 * `html-reporter.ts` split, so `tests/catalog-report.test.ts` runs at the
 * unit tier against strings.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import type { ProofBundle, ProofStep } from '../engine/proof-bundle.js';
import { verdictFamily } from '../engine/proof-bundle.js';
import { grimTheme } from './theme.js';
import { slugify } from './html-reporter.js';

export const CATALOG_REPORT_DIR = 'reports';
/** Routine screenshots are embedded until this many bytes of base64 are spent. */
export const SCREENSHOT_BUDGET_BYTES = 15_000_000;
/**
 * Recordings are embedded until this many bytes of base64 are spent.
 *
 * Measured on be100-rip's 32 bundles: median recording 55 KB of base64, but the
 * tail reaches 6 MB and the set totals 22 MB. A whole 108-row catalog would
 * therefore be somewhere near 75 MB embedded whole, which is past the point a
 * browser opens it pleasantly. 25 MB fits every recording of a normal run and
 * still bounds the pathological one; what does not fit is named, not dropped
 * in silence.
 */
export const VIDEO_BUDGET_BYTES = 25_000_000;
/** A step at or over the fast-path budget is worth a reader's eye. */
const SLOW_STEP_MS = 2_000;

export interface CatalogReportCase {
  /** `PL_06_05` — the planned id. */
  id: string;
  /** Full name when known (`PL_06_05 ตรวจสอบ…`); the id stands in otherwise. */
  name: string;
  /** Scenario the sheet groups it under (`PL_06`). */
  scenario: string;
  /** `passed | failed | blocked | review | never-ran`. */
  verdict: string;
  /** The bundle's own status when there was a bundle (`dead-end`, `error`…). */
  status: string | null;
  reason: string | null;
  bundle: ProofBundle | null;
  /**
   * Explanations drawn from the generated history, one line each — trend
   * ("broken for the last 5 runs"), prior failure shapes, heal pressure.
   */
  history: readonly string[];
}

export interface CatalogReportInput {
  title: string;
  runKey: string | null;
  generatedAt: string | null;
  cases: readonly CatalogReportCase[];
}

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 120) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s`;
}

/** The chip class + label a verdict renders as — the two-family taxonomy. */
export function verdictChipOf(c: CatalogReportCase): { cls: string; label: string } {
  if (c.verdict === 'never-ran') return { cls: 'never', label: 'never ran' };
  if (c.verdict === 'blocked') return { cls: 'never', label: 'blocked' };
  if (c.verdict === 'review') return { cls: 'review', label: 'needs review' };
  if (c.verdict === 'passed') return { cls: 'pass', label: c.status === 'passed-with-issues' ? 'pass**' : 'passed' };
  const family = c.status === null ? 'test-failed' : verdictFamily(c.status);
  return family === 'system-error'
    ? { cls: 'error', label: 'system error' }
    : { cls: 'fail', label: c.status === 'dead-end' ? 'test failed (dead-end)' : 'test failed' };
}

/* ------------------------------------------------------------ step detail */

interface ShotBudget {
  left: number;
  omitted: number;
}

function stepDetail(step: ProofStep, budget: ShotBudget): string {
  const rows: string[] = [];
  const row = (label: string, value: string | null | undefined, mono = true): void => {
    if (value === null || value === undefined || value === '') return;
    rows.push(`<div class="kv"><span>${esc(label)}</span><${mono ? 'code' : 'span'}>${esc(value)}</${mono ? 'code' : 'span'}></div>`);
  };
  row('intent', step.intent, false);
  row('selector', step.selector);
  if (step.resolvedSelector && step.resolvedSelector !== step.selector) row('resolved as', step.resolvedSelector);
  row('resolution', step.resolution ?? undefined);
  row('url', step.url);
  if (step.error) rows.push(`<div class="kv err"><span>error</span><code>${esc(step.error)}</code></div>`);
  if (step.heal) {
    rows.push(
      `<div class="kv heal"><span>healed</span><code>${esc(step.heal.to)}</code>` +
        `<em>${esc(step.heal.strategy)} · confidence ${(step.heal.confidence * 100).toFixed(0)}%</em></div>`,
    );
  }
  if (step.agent) {
    const a = step.agent;
    const turns = (a.actions ?? [])
      .map((t) => `<li class="${t.ok ? 'ok' : 'no'}">${esc(t.action)}${t.selector ? ` <code>${esc(t.selector)}</code>` : ''}${t.error ? ` — ${esc(t.error)}` : ''}</li>`)
      .join('');
    rows.push(
      `<div class="agent"><div class="kv"><span>agent</span><span>${esc(a.summary ?? '')} (${a.turns} turn(s))</span></div>` +
        (turns === '' ? '' : `<ol class="turns">${turns}</ol>`) +
        '</div>',
    );
  }
  if (step.screenshot) {
    const isFailure = step.status !== 'passed';
    const size = step.screenshot.length;
    if (isFailure || budget.left >= size) {
      if (!isFailure) budget.left -= size;
      rows.push(
        `<figure class="shot"><img loading="lazy" alt="step ${step.index} screenshot" src="data:image/jpeg;base64,${step.screenshot}"/></figure>`,
      );
    } else {
      budget.omitted += 1;
      rows.push('<div class="kv muted"><span>screenshot</span><span>omitted for size — it stays in the proof bundle</span></div>');
    }
  }
  return rows.join('');
}

/**
 * Which recordings this file will carry.
 *
 * Decided in a pass of its own, BEFORE any case renders, because the priority
 * is not document order: a catalog is mostly passes, and spending the budget
 * on the first twenty of them would leave the failures — the cases a reader
 * actually opens — with nothing. Non-passing cases are served first, and
 * within each group the smallest recordings first, so the budget buys the most
 * cases rather than the longest ones.
 *
 * Returns the set of case ids whose recording is embedded; everything else
 * gets the honest note instead.
 */
export function chooseEmbeddedVideos(
  cases: readonly CatalogReportCase[],
  budgetBytes: number = VIDEO_BUDGET_BYTES,
): Set<string> {
  const withVideo = cases
    .filter((c) => typeof c.bundle?.video?.data === 'string' && c.bundle.video.data !== '')
    .map((c) => ({ id: c.id, passed: c.verdict === 'passed', size: (c.bundle!.video!.data as string).length }))
    .sort((a, b) => Number(a.passed) - Number(b.passed) || a.size - b.size);
  const keep = new Set<string>();
  let left = budgetBytes;
  for (const entry of withVideo) {
    if (entry.size > left) continue;
    left -= entry.size;
    keep.add(entry.id);
  }
  return keep;
}

/**
 * The run on film, inside the case that produced it.
 *
 * **The base64 rides on an attribute and becomes a Blob URL in the page**, as
 * it does in `html-reporter.ts`: Chrome's media stack will not load a `data:`
 * video — the element sits at `readyState 0` forever with no error, which
 * reads exactly like a corrupt recording. The same bytes play instantly from a
 * Blob. Keep the indirection.
 *
 * **Hydrated when the case is opened, not at load.** A catalog holds dozens of
 * these; decoding every one into a Blob on first paint would stall the page
 * for seconds to build players nobody opened. The case's own `toggle` is the
 * signal, so a reader still does nothing but click the case.
 */
function videoBlock(c: CatalogReportCase, embedded: boolean): string {
  const video = c.bundle?.video;
  if (!video) return '';
  if (!video.data) {
    return `<figure class="rec"><figcaption>Recording</figcaption><div class="muted">${esc(
      video.omitted ?? 'the recording could not be embedded',
    )}</div></figure>`;
  }
  if (!embedded) {
    return `<figure class="rec"><figcaption>Recording</figcaption><div class="muted">${(
      video.data.length / 1_000_000
    ).toFixed(1)} MB — left out to keep this file portable; it stays in the proof bundle${
      c.bundle?.runId ? ` (run ${esc(c.bundle.runId)})` : ''
    }.</div></figure>`;
  }
  const steps = c.bundle?.steps ?? [];
  const failing = steps.find((s) => s.status !== 'passed' && !s.superseded && s.videoOffsetMs !== undefined);
  return (
    `<figure class="rec">` +
    `<figcaption>Recording — the run as it happened<span class="hint">each step has “play from here”</span></figcaption>` +
    `<video controls preload="none" width="${esc(video.width)}" height="${esc(video.height)}"` +
    ` data-webm="${esc(video.data)}"` +
    (failing?.videoOffsetMs !== undefined
      ? ` data-failure-offset="${(failing.videoOffsetMs / 1000).toFixed(2)}"`
      : '') +
    `></video></figure>`
  );
}

/**
 * The control that turns one recording into per-step evidence: every step in
 * the list is a cue point into the same file, so a reader never scrubs.
 *
 * It lives on the step's SUMMARY, not in its body. Measured in a browser: in
 * the body it is inside a collapsed `<details>`, so a reader has to expand
 * every step to discover that seeking exists at all — a control nobody can see
 * is not a control. The click handler calls `preventDefault`, which is what
 * stops a button inside a `<summary>` from toggling the step open as a side
 * effect of playing the film.
 */
function seekControl(step: ProofStep, hasVideo: boolean): string {
  if (!hasVideo || step.videoOffsetMs === undefined) return '';
  return `<button class="seek" type="button" data-seek="${(step.videoOffsetMs / 1000).toFixed(2)}">▶ play from here (${esc(
    fmtMs(step.videoOffsetMs),
  )} in)</button>`;
}

/* ------------------------------------------------------------- one case */

function historyBlock(lines: readonly string[]): string {
  if (lines.length === 0) return '';
  return (
    '<div class="history"><div class="cap">From the run history</div>' +
    lines.map((l) => `<div class="hline">${esc(l)}</div>`).join('') +
    '</div>'
  );
}

function timePane(steps: readonly ProofStep[]): string {
  const counted = steps.filter((s) => !s.superseded);
  const max = Math.max(1, ...counted.map((s) => s.durationMs));
  const total = counted.reduce((sum, s) => sum + s.durationMs, 0);
  const bars = counted
    .map((s) => {
      const width = Math.max(2, Math.round((s.durationMs / max) * 100));
      const slow = s.durationMs >= SLOW_STEP_MS ? ' slow' : '';
      const failed = s.status !== 'passed' ? ' broke' : '';
      return (
        `<div class="trow" data-step="${s.index}"><span class="tname">${s.index} ${esc(s.action)}</span>` +
        `<span class="tbar${slow}${failed}" style="width:${width}%"></span>` +
        `<span class="tms${slow}">${esc(fmtMs(s.durationMs))}</span></div>`
      );
    })
    .join('');
  const slowest = [...counted].sort((a, b) => b.durationMs - a.durationMs).slice(0, 3);
  return (
    `<div class="cap">Time record — ${esc(fmtMs(total))} across ${counted.length} step(s)</div>${bars}` +
    `<div class="tfoot">slowest: ${slowest.map((s) => `#${s.index} ${esc(s.action)} ${esc(fmtMs(s.durationMs))}`).join(' · ')}` +
    ` · amber = at/over the ${SLOW_STEP_MS / 1000}s fast-path budget</div>`
  );
}

function caseSection(c: CatalogReportCase, budget: ShotBudget, embeddedVideo: boolean): string {
  const chip = verdictChipOf(c);
  const anchor = `case-${slugify(c.id)}`;
  const bundle = c.bundle;
  const steps = bundle?.steps ?? [];
  const film = videoBlock(c, embeddedVideo);
  // Seek buttons only where there is something to seek IN: an unembedded
  // recording would give a reader a control that silently does nothing.
  const hasVideo = embeddedVideo && typeof bundle?.video?.data === 'string' && bundle.video.data !== '';
  const left =
    steps.length === 0
      ? `<div class="muted">No steps were recorded${c.reason ? ` — ${esc(c.reason)}` : ''}.</div>`
      : steps
          .filter((s) => !s.superseded)
          .map((s) => {
            const ok = s.status === 'passed';
            return (
              `<details class="step ${ok ? 'ok' : 'no'}"><summary><b class="dot"></b>` +
              `<span class="sname">${s.index} ${esc(s.action)}</span>` +
              `<span class="ssub">${esc(s.intent ?? s.selector ?? '')}</span>` +
              `<span class="sms">${esc(fmtMs(s.durationMs))}</span>` +
              seekControl(s, hasVideo) +
              '</summary>' +
              `<div class="sbody">${stepDetail(s, budget)}</div></details>`
            );
          })
          .join('');
  const notes = (bundle?.notes ?? []).map((n) => `<div class="hline">${esc(n)}</div>`).join('');
  return (
    `<details class="case" id="${anchor}" data-name="${esc(c.name)}">` +
    `<summary><span class="chip ${chip.cls}">${esc(chip.label)}</span>` +
    `<span class="cname">${esc(c.name)}</span>` +
    (bundle ? `<span class="cms">${esc(fmtMs(bundle.caseDurationMs ?? bundle.durationMs))}</span>` : '') +
    `<button class="btn export-case" data-case="${anchor}" onclick="exportCase(event,'${anchor}')">Export case</button>` +
    '</summary>' +
    `<div class="split"><div class="steps-pane">${film}${historyBlock(c.history)}${left}` +
    (notes === '' ? '' : `<div class="history"><div class="cap">Run notes</div>${notes}</div>`) +
    `</div><div class="time-pane">${steps.length === 0 ? '<div class="muted">no timing — the case never ran</div>' : timePane(steps)}</div></div>` +
    '</details>'
  );
}

/* ------------------------------------------------------------- the page */

/**
 * The player script, shared by this page and by every case exported from it.
 *
 * Kept as its own string precisely so the export can carry it: an exported
 * case is a `<video data-webm="…">` with no `src`, and without this it is a
 * dead player in a file someone was told holds the evidence.
 */
const PLAYER_SCRIPT = `
function wowHydrateVideo(v) {
  if (!v || v.dataset.wowReady) return;
  var b64 = v.getAttribute('data-webm') || '';
  if (!b64) return;
  v.dataset.wowReady = '1';
  var bin = atob(b64);
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  v.src = URL.createObjectURL(new Blob([bytes], { type: 'video/webm' }));
  /* data-webm deliberately STAYS. A hydrated player's src is a Blob URL, which
     means nothing in another document — and every export here is another
     document. Leaving the bytes on the attribute is what makes an exported
     case playable whether or not it had been opened first. */
  /* On a case that broke, the player opens ON the failure: the recording is
     kept because a step failed, and that is the frame worth showing first. */
  var at = parseFloat(v.getAttribute('data-failure-offset') || '');
  if (!isNaN(at)) {
    v.addEventListener('loadedmetadata', function () {
      if (at < (v.duration || Infinity)) v.currentTime = at;
    });
  }
}
/* Decoded when the case is opened, never at load: a catalog holds dozens of
   recordings and building every Blob on first paint would stall the page to
   make players nobody opened. */
function wowWireCase(node) {
  node.addEventListener('toggle', function () {
    if (node.open) node.querySelectorAll('video[data-webm]').forEach(wowHydrateVideo);
  });
}
document.addEventListener('click', function (e) {
  var b = e.target.closest && e.target.closest('.seek');
  if (!b) return;
  e.preventDefault();
  var scope = b.closest('.case') || document;
  var v = scope.querySelector('video');
  if (!v) return;
  wowHydrateVideo(v);
  v.currentTime = parseFloat(b.getAttribute('data-seek') || '0') || 0;
  v.play();
  v.scrollIntoView({ block: 'nearest' });
});
document.querySelectorAll('details.case').forEach(wowWireCase);
/* An exported single case is already open, so its toggle never fires. */
document.querySelectorAll('body.single video[data-webm]').forEach(wowHydrateVideo);
`;

const EXPORT_SCRIPT = `
function download(name, html) {
  var blob = new Blob([html], { type: 'text/html' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
}
/* One case as its own standalone page: this document's <style> plus the
   case's own section, open, with the export buttons stripped. */
function exportCase(event, anchor) {
  event.preventDefault(); event.stopPropagation();
  var node = document.getElementById(anchor).cloneNode(true);
  node.setAttribute('open', '');
  /* Only the export control goes; the seek buttons are evidence controls and
     the exported file carries the player that makes them work. */
  node.querySelectorAll('button.export-case').forEach(function (b) { b.remove(); });
  wowStripBlobs(node);
  var styles = Array.prototype.map.call(document.querySelectorAll('style'), function (s) { return s.outerHTML; }).join('');
  var title = node.getAttribute('data-name') || anchor;
  download(anchor + '.html',
    '<!doctype html><html><head><meta charset="utf-8"><title>' + title.replace(/</g, '&lt;') +
    '</title>' + styles + '</head><body class="single">' + node.outerHTML +
    '<scr' + 'ipt>' + WOW_PLAYER + '</scr' + 'ipt></body></html>');
}
/* A Blob URL is scoped to THIS document, so it must never be written into an
   exported one; the base64 on data-webm is what travels. */
function wowStripBlobs(root) {
  root.querySelectorAll('video').forEach(function (v) {
    v.removeAttribute('src');
    delete v.dataset.wowReady;
  });
}
function exportCatalog() {
  var doc = document.documentElement.cloneNode(true);
  wowStripBlobs(doc);
  download((document.title || 'catalog-report') + '.html', '<!doctype html>' + doc.outerHTML);
}
`;

const STYLE = `
body { max-width: 1200px; margin: 0 auto; padding: 24px; font: 14px/1.5 system-ui, sans-serif; background: var(--bg); color: var(--fg); }
h1 { font-size: 20px; margin: 0 0 4px; }
.meta { color: var(--muted); font-size: 12px; margin-bottom: 18px; }
.tally { display: flex; gap: 14px; flex-wrap: wrap; margin: 10px 0 22px; font-size: 13px; }
.scenario { margin: 22px 0 8px; }
.scenario > .shead { font-weight: 600; font-size: 15px; padding: 6px 0; border-bottom: 1px solid var(--line); display: flex; gap: 10px; align-items: baseline; }
.scenario > .shead .scount { color: var(--muted); font-weight: 400; font-size: 12px; }
.chip { font-size: 11px; border-radius: 999px; padding: 2px 9px; white-space: nowrap; }
.chip.pass { background: color-mix(in srgb, var(--pass, #2e7d32) 15%, transparent); color: var(--pass, #2e7d32); }
.chip.fail { background: color-mix(in srgb, #c0392b 14%, transparent); color: #c0392b; }
.chip.error { background: color-mix(in srgb, #b8860b 16%, transparent); color: #b8860b; }
.chip.review { background: color-mix(in srgb, #6a5acd 14%, transparent); color: #6a5acd; }
.chip.never { background: color-mix(in srgb, var(--muted) 18%, transparent); color: var(--muted); }
details.case { border: 1px solid var(--line); border-radius: 10px; margin: 8px 0; background: var(--panel, transparent); }
details.case > summary { display: flex; align-items: center; gap: 10px; padding: 9px 12px; cursor: pointer; list-style: none; }
details.case > summary .cname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
details.case > summary .cms { color: var(--muted); font-variant-numeric: tabular-nums; }
.btn { font: inherit; font-size: 12px; border: 1px solid var(--line); background: transparent; color: inherit; border-radius: 7px; padding: 3px 10px; cursor: pointer; }
.split { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 18px; padding: 4px 14px 16px; }
@media (max-width: 900px) { .split { grid-template-columns: 1fr; } }
.cap { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 10px 0 6px; }
details.step { border-left: 3px solid var(--line); margin: 4px 0; }
details.step.no { border-left-color: #c0392b; }
details.step.ok .dot { background: var(--pass, #2e7d32); }
details.step.no .dot { background: #c0392b; }
details.step > summary { display: flex; gap: 8px; align-items: baseline; padding: 4px 8px; cursor: pointer; list-style: none; }
.dot { width: 8px; height: 8px; border-radius: 50%; flex: none; align-self: center; }
.sname { font-weight: 600; white-space: nowrap; }
.ssub { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--muted); font-size: 12px; }
.sms { color: var(--muted); font-variant-numeric: tabular-nums; font-size: 12px; }
.sbody { padding: 6px 10px 10px 22px; }
.kv { display: flex; gap: 10px; font-size: 12px; margin: 3px 0; }
.kv > span:first-child { color: var(--muted); flex: none; width: 82px; }
.kv code { word-break: break-all; white-space: pre-wrap; }
.kv.err code { color: #c0392b; }
.kv.heal code { color: #b8860b; }
.muted { color: var(--muted); }
.shot img { max-width: 100%; border: 1px solid var(--line); border-radius: 6px; margin-top: 6px; }
.history { background: color-mix(in srgb, var(--muted) 7%, transparent); border-radius: 8px; padding: 8px 12px; margin: 8px 0; }
.hline { font-size: 12px; margin: 3px 0; }
.turns { font-size: 12px; margin: 4px 0 0 14px; padding: 0; }
.turns li.no { color: #c0392b; }
.time-pane { border-left: 1px solid var(--line); padding-left: 16px; }
.trow { display: grid; grid-template-columns: 110px 1fr 52px; gap: 8px; align-items: center; margin: 3px 0; font-size: 11px; }
.tname { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--muted); }
.tbar { height: 8px; border-radius: 4px; background: var(--pass, #2e7d32); opacity: .75; min-width: 2px; }
.tbar.slow { background: #b8860b; }
.tbar.broke { background: #c0392b; }
.tms { text-align: right; font-variant-numeric: tabular-nums; color: var(--muted); }
.tms.slow { color: #b8860b; }
.tfoot { font-size: 11px; color: var(--muted); margin-top: 10px; }
body.single .split { grid-template-columns: minmax(0, 1fr) 340px; }
.rec { margin: 0 0 14px; padding: 10px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; }
.rec figcaption { display: flex; gap: 10px; align-items: baseline; font-size: 11px; text-transform: uppercase;
  letter-spacing: .06em; color: var(--muted); margin-bottom: 8px; }
.rec figcaption .hint { text-transform: none; letter-spacing: 0; margin-left: auto; }
.rec video { display: block; width: 100%; height: auto; max-height: 60vh; border-radius: 4px; background: #000; }
.seek { font: inherit; font-size: 11px; cursor: pointer; padding: 2px 8px; border-radius: 999px;
  border: 1px solid var(--line); background: transparent; color: var(--muted); white-space: nowrap; margin-left: 8px; }
.seek:hover { border-color: var(--fg); color: var(--fg); }
`;

export function renderCatalogReport(input: CatalogReportInput): string {
  const budget: ShotBudget = { left: SCREENSHOT_BUDGET_BYTES, omitted: 0 };
  // Decided up front, across the whole catalog — see `chooseEmbeddedVideos`.
  const embeddedVideos = chooseEmbeddedVideos(input.cases);
  const byScenario = new Map<string, CatalogReportCase[]>();
  for (const c of input.cases) {
    const key = c.scenario || 'ungrouped';
    if (!byScenario.has(key)) byScenario.set(key, []);
    byScenario.get(key)!.push(c);
  }
  const tally = new Map<string, number>();
  for (const c of input.cases) {
    const { label } = verdictChipOf(c);
    tally.set(label, (tally.get(label) ?? 0) + 1);
  }
  const sections = [...byScenario.entries()]
    .map(([scenario, cases]) => {
      const passed = cases.filter((c) => c.verdict === 'passed').length;
      return (
        `<section class="scenario"><div class="shead">${esc(scenario)}` +
        `<span class="scount">${passed} of ${cases.length} passed</span></div>` +
        cases.map((c) => caseSection(c, budget, embeddedVideos.has(c.id))).join('') +
        '</section>'
      );
    })
    .join('');
  const withVideo = input.cases.filter((c) => c.bundle?.video?.data).length;
  const omittedVideos = withVideo - embeddedVideos.size;
  const omittedNote =
    budget.omitted === 0
      ? ''
      : `<div class="meta">${budget.omitted} routine screenshot(s) omitted to keep this file portable — every one stays in its proof bundle.</div>`;
  const videoNote =
    omittedVideos <= 0
      ? ''
      : `<div class="meta">${omittedVideos} recording(s) left out to keep this file portable — cases that did not pass keep theirs first; every one stays in its proof bundle.</div>`;
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8"/>' +
    `<meta name="viewport" content="width=device-width, initial-scale=1"/>` +
    `<title>${esc(input.title)}</title>` +
    `<style>${grimTheme()}</style><style>${STYLE}</style></head><body>` +
    `<h1>${esc(input.title)}</h1>` +
    `<div class="meta">${esc(input.runKey ?? '')}${input.generatedAt ? ` · authored ${esc(input.generatedAt)}` : ''} · ${input.cases.length} case(s)` +
    ` <button class="btn" onclick="exportCatalog()">Export catalog</button></div>` +
    `<div class="tally">${[...tally.entries()].map(([label, n]) => `<span>${esc(label)}: <b>${n}</b></span>`).join('')}</div>` +
    omittedNote +
    videoNote +
    sections +
    // The player source is also a VALUE in the page, because `exportCase`
    // writes it into the file it downloads — see `PLAYER_SCRIPT`.
    `<script>var WOW_PLAYER = ${JSON.stringify(PLAYER_SCRIPT)};</script>` +
    `<script>${EXPORT_SCRIPT}</script>` +
    `<script>${PLAYER_SCRIPT}</script></body></html>`
  );
}

/** `reports/<runKey slug>.html` — stable per run key, so a resume overwrites its own file. */
export function catalogReportPath(runKey: string | null, title: string, cwd = process.cwd()): string {
  const base = slugify((runKey ?? title).replace(/@/g, '-')) || 'catalog-report';
  return resolve(cwd, CATALOG_REPORT_DIR, `${base}.html`);
}

export async function writeCatalogReport(path: string, html: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, html, 'utf8');
  return path;
}
