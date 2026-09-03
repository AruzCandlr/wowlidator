/**
 * Ledger — the panel's home page, at `/`.
 *
 * The one surface that replaced the command-first panel (2026-09-03): wowUI's
 * nouns — a flow, its runs, the evidence behind each step — on a top bar, in
 * one column, with the evidence as a side sheet. It also absorbs the two things
 * only the old panel offered: every CLI command as a form rendered from
 * `commands.ts` (the Commands tab) and the manual (the Help tab, built as data
 * so the page needs no `innerHTML` at all).
 *
 * It composes wowUI, it does not fork it. `WOW_SCRIPT` ships here verbatim as a
 * library — the task rows, the checks table, the evidence drawer, the launcher
 * and its claims gate, the Models & keys internals — and the functions that
 * decide *where things go* (`render`, `show`, `renderSidebar`, `pageHead`,
 * `renderRuns`, `boot`) are declared again below: a later top-level function
 * declaration replaces an earlier one for the whole script. Two base functions
 * are wrapped instead (`post` and `dataSignature`), renamed at build time with an
 * exact-match replace that throws on the first request if the anchor moved.
 *
 * `/wow` still serves wowUI unchanged, so the two can be compared side by side
 * until it is retired.
 */

import { MANUAL } from './manual.js';
import { WOW_SCRIPT, WOW_STYLE } from './wow-ui-html.js';

/* ------------------------------------------------------------ the manual */

/** A manual node: text, or a tag with an optional class and its children. */
export type ManualNode = string | { t: string; c?: string; k: ManualNode[] };

const VOID_TAGS = new Set(['br']);
const ENTITIES: Record<string, string> = {
  '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ',
  '&rarr;': '→', '&larr;': '←', '&mdash;': '—', '&ndash;': '–', '&hellip;': '…',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole) => {
    if (whole.startsWith('&#x')) return String.fromCodePoint(parseInt(whole.slice(3, -1), 16));
    if (whole.startsWith('&#')) return String.fromCodePoint(parseInt(whole.slice(2, -1), 10));
    return ENTITIES[whole] ?? whole;
  });
}

/**
 * The manual's HTML, as a tree the page can build with `el()`. The manual is
 * our own static content and uses a dozen tags; this is not a general parser
 * and does not need to be — an unknown tag becomes a `span`, an attribute
 * other than `class` is dropped, and nothing here is ever interpreted as
 * markup on the client.
 */
export function parseManualHtml(html: string): ManualNode[] {
  const root: { t: string; k: ManualNode[] } = { t: 'root', k: [] };
  const stack: Array<{ t: string; k: ManualNode[] }> = [root];
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g;
  let last = 0;
  let match: RegExpExecArray | null;
  const pushText = (raw: string): void => {
    if (raw) stack[stack.length - 1]!.k.push(decodeEntities(raw));
  };
  while ((match = tagRe.exec(html))) {
    pushText(html.slice(last, match.index));
    last = tagRe.lastIndex;
    const closing = match[1] === '/';
    const name = match[2]!.toLowerCase();
    const attrs = match[3] ?? '';
    if (closing) {
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if (stack[i]!.t === name) { stack.length = i; break; }
      }
      continue;
    }
    const cls = /class="([^"]*)"/.exec(attrs)?.[1];
    const node: { t: string; c?: string; k: ManualNode[] } = cls ? { t: name, c: cls, k: [] } : { t: name, k: [] };
    stack[stack.length - 1]!.k.push(node);
    if (!VOID_TAGS.has(name) && !attrs.trim().endsWith('/')) stack.push(node);
  }
  pushText(html.slice(last));
  return root.k;
}

/** JSON that is safe inside a `<script>` element: no `</script`, no U+2028/9. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/* ---------------------------------------------------------- the base script */

/**
 * wowUI's script, prepared as a library: its own `boot()` call removed (this
 * page boots itself, after its declarations), and the two functions this page
 * wraps renamed so their originals stay reachable. Every anchor is an exact
 * string; a miss throws at render time — the first request to `/` — never a
 * page that silently lost a feature.
 */
function baseScript(): string {
  const renames: Array<[string, string]> = [
    ['function post(commandId, values, flowPath) {', 'function wowPost(commandId, values, flowPath) {'],
    ['function dataSignature() {', 'function wowDataSignature() {'],
  ];
  let script = WOW_SCRIPT;
  for (const [from, to] of renames) {
    const first = script.indexOf(from);
    if (first === -1 || script.indexOf(from, first + 1) !== -1) {
      throw new Error(`ledger: expected exactly one "${from}" in wowUI's script`);
    }
    script = script.replace(from, to);
  }
  const bootCall = /\nboot\(\);\s*$/;
  if (!bootCall.test(script)) throw new Error('ledger: wowUI\'s script no longer ends with boot()');
  return script.replace(bootCall, '\n');
}

/* ----------------------------------------------------------------- style */

/* GRIM's tokens and wowUI's components, unchanged. What follows is layout:
   the top bar, the one column, the flatter surfaces. Two radii, one shadow. */
const LEDGER_STYLE = `
/* ---- ledger: shell ---- */
:root { --r-lg: 8px; --top-h: 56px; }
body { background: var(--bg); }
.topbar {
  position: sticky; top: 0; z-index: 900; height: var(--top-h);
  display: flex; align-items: center; gap: var(--s4);
  padding: 0 var(--s5); background: var(--panel); border-bottom: 1px solid var(--line);
}
.topbar .brand { padding: 0; gap: var(--s2); flex: 0 0 auto; }
.topbar .brand-word { font-size: var(--fs-md); }
.tabs { display: flex; align-items: stretch; gap: 2px; height: var(--top-h); overflow-x: auto; scrollbar-width: none; }
.tabs::-webkit-scrollbar { display: none; }
.tab {
  display: inline-flex; align-items: center; gap: 6px; padding: 0 var(--s3); height: 100%;
  font: inherit; font-size: var(--fs-sm); color: var(--muted); background: none; border: 0; cursor: pointer;
  white-space: nowrap; border-bottom: 2px solid transparent; margin-bottom: -1px;
}
.tab:hover { color: var(--ink); }
.tab[aria-current="page"] { color: var(--ink); font-weight: 600; border-bottom-color: var(--accent); }
.tab:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.tab .nav-count { margin-left: 0; }
.topstatus { margin-left: auto; display: flex; gap: 6px; align-items: center; flex-wrap: nowrap; }
.topstatus .chip { cursor: default; white-space: nowrap; flex: 0 0 auto; }
.topstatus .chip.jump { cursor: pointer; }
.topstatus .chip.ok { background: var(--ok-bg); color: var(--ok); }
.topstatus .chip.warn { background: var(--warn-bg); color: var(--warn); }
.topstatus .chip.bad { background: var(--bad-bg); color: var(--bad); }
#start-host { flex: 0 0 auto; }
.main { max-width: 1120px; margin: 0 auto; padding: var(--s6) var(--s5) 72px; }
.page-head { margin-bottom: var(--s5); align-items: center; }
.page-head h1 { font-size: var(--fs-lg); }
.page-head .sub { max-width: 72ch; }

/* ---- ledger: flatter surfaces ---- */
.card, .launcher, .claims-summary, .req-card, .run-group { box-shadow: none; }
.rows { border-radius: var(--r-lg); }
.group { margin-bottom: var(--s6); }
.group-head { position: sticky; top: var(--top-h); z-index: 5; background: var(--bg); padding-top: var(--s2); padding-bottom: var(--s2); }
.group-head.clickable:hover { background: var(--panel-2); }

/* Stats are one line of figures, not four tiles: the number, its unit, its denominator. */
.stats-line { display: flex; flex-wrap: wrap; gap: var(--s2) var(--s6); padding: var(--s3) 0 var(--s4); margin-bottom: var(--s4); border-bottom: 1px solid var(--line); }
.stats-line .stat { padding: 0; border: 0; display: flex; align-items: baseline; gap: 6px; }
.stats-line .stat .v { font-size: var(--fs-xl); margin: 0; }
.stats-line .stat .k { font-size: var(--fs-sm); font-weight: 500; letter-spacing: 0; text-transform: none; color: var(--ink); }
.stats-line .stat .n { font-size: var(--fs-xs); color: var(--muted); margin: 0; }
.stats-line .stat .n::before { content: "· "; color: var(--faint); }

/* Banners are a list, not stacked amber cards: one bordered box, a stripe for
   the state, the run key and the cause on one line each. */
.banners { border: 1px solid var(--line); background: var(--panel); border-radius: var(--r-lg); margin-bottom: var(--s5); }
.banners .warn-banner { margin: 0; border: 0; border-bottom: 1px solid var(--line); border-radius: 0; background: var(--panel); padding: var(--s4) var(--s5); }
.banners .warn-banner:last-child { border-bottom: 0; }
.banners .warn-banner svg { display: none; }
.banners .warn-banner b { color: var(--ink); }
.banners .warn-banner .state { font-family: var(--mono); font-size: var(--fs-cap); text-transform: uppercase; letter-spacing: .06em; padding: 2px 8px; border-radius: var(--r-xs); background: var(--warn-bg); color: var(--warn); margin-right: var(--s2); vertical-align: 1px; }
.banners .warn-banner .state.done { background: var(--panel-2); color: var(--muted); }
.banners .warn-banner .acts { flex-wrap: wrap; }
.banners .more { padding: var(--s2) var(--s5); font-size: var(--fs-xs); color: var(--muted); border-top: 1px solid var(--line); }
.warn-banner.wq { box-shadow: none; }
.offline { margin-bottom: var(--s4); }
.req-card { min-width: 0; }
.req-card > div { min-width: 0; }
.req-card .mono { overflow-wrap: anywhere; }
.req-card .note { flex-wrap: wrap; }
.req-card .mono.fold { display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; cursor: pointer; }
.req-card .mono.fold.open { display: block; }

/* ---- ledger: the evidence sheet ---- */
.drawer { width: 520px; }
.launcher { max-width: 640px; }

/* ---- ledger: sub-tabs (Learned), jump list (Machinery), command list ---- */
.subtabs { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: var(--s5); }
.jump { display: flex; gap: 6px; flex-wrap: wrap; margin: -6px 0 var(--s5); }
.jump a { font-size: var(--fs-xs); border: 1px solid var(--line); border-radius: var(--r-pill); padding: 3px 10px; color: var(--muted); text-decoration: none; }
.jump a:hover { background: var(--panel-2); color: var(--ink); }
.sec { scroll-margin-top: calc(var(--top-h) + var(--s4)); margin-bottom: var(--s7); }
.sec + .sec { padding-top: var(--s5); border-top: 1px solid var(--line); }
.cmd-layout { display: grid; grid-template-columns: 260px minmax(0, 1fr); gap: var(--s6); align-items: start; }
.cmd-list { display: flex; flex-direction: column; gap: 4px; }
.cmd-list .cap { margin: var(--s3) 0 var(--s1); }
.cmd-item { text-align: left; font: inherit; background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-sm); padding: 8px 10px; cursor: pointer; color: var(--ink); }
.cmd-item:hover { border-color: var(--accent-line); background: var(--accent-soft); }
.cmd-item[aria-current="true"] { border-color: var(--accent); background: var(--accent-soft); }
.cmd-item:focus-visible { outline: 2px solid var(--accent); }
.cmd-item b { display: block; font-size: var(--fs-sm); }
.cmd-item span { display: block; font-size: var(--fs-xs); color: var(--muted); margin-top: 2px; line-height: 1.45; }
.cmd-item .tag { display: inline-block; margin-top: 4px; font-size: 10px; letter-spacing: .06em; text-transform: uppercase; color: var(--faint); border: 0; padding: 0; }
.cmd-pane { background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-lg); padding: var(--s5) var(--s6); }
.cmd-pane h2 { font-size: var(--fs-lg); font-weight: 600; letter-spacing: -.01em; margin: 0 0 var(--s1); }
.cmd-pane .sub { font-size: var(--fs-xs); color: var(--muted); margin-bottom: var(--s4); line-height: 1.6; }
.cmd-pane .argv { font-family: var(--mono); font-size: var(--fs-mono); color: var(--muted); background: var(--code-bg); border-radius: var(--r-xs); padding: 6px 10px; margin-top: var(--s4); overflow-x: auto; white-space: nowrap; }
.cmd-form label { display: block; font-size: var(--fs-xs); font-weight: 600; color: var(--muted); margin: 0 0 var(--s1); }
.cmd-form input, .cmd-form select, .cmd-form textarea { width: 100%; font: inherit; font-size: var(--fs-sm); padding: 8px 10px; border: 1px solid var(--line-strong); border-radius: var(--r-sm); background: var(--bg); color: var(--ink); box-sizing: border-box; }
.cmd-form input:focus, .cmd-form select:focus, .cmd-form textarea:focus { outline: 2px solid var(--accent); outline-offset: 1px; border-color: var(--accent); }
.cmd-form input[type=checkbox], .cmd-form input[type=radio] { width: auto; }
.cmd-form .field { margin-top: var(--s4); }
.cmd-form .field.err label { color: var(--bad); }
.cmd-form .field.err input, .cmd-form .field.err textarea, .cmd-form .field.err select, .cmd-form .field.err .chips-in { border-color: var(--bad); }
.cmd-form .field-err { color: var(--bad); font-size: var(--fs-xs); margin-top: 3px; }
.cmd-form .help1 { font-size: var(--fs-xs); color: var(--muted); margin-top: 3px; line-height: 1.5; }
.cmd-form .help-full { font-size: var(--fs-xs); color: var(--muted); margin-top: 3px; line-height: 1.6; padding: 6px 10px; background: var(--panel-2); border-radius: var(--r-sm); }
.cmd-form .help-q { font: inherit; font-size: 11px; font-weight: 700; color: var(--accent-ink); background: var(--accent-soft); border: 0; border-radius: 50%; width: 18px; height: 18px; cursor: pointer; margin-left: 6px; vertical-align: middle; }
.cmd-form .switch { display: flex; gap: 10px; align-items: flex-start; margin-top: var(--s3); }
.cmd-form .switch input { margin-top: 3px; }
.cmd-form .switch label { margin: 0; color: var(--ink); font-weight: 500; }
.cmd-form .gate-note { font-size: var(--fs-xs); color: var(--warn); margin-top: 3px; }
.cmd-form details { margin-top: var(--s4); border: 1px solid var(--line); border-radius: var(--r-sm); padding: 4px 12px; }
.cmd-form details summary { cursor: pointer; font-size: var(--fs-xs); font-weight: 600; color: var(--muted); padding: 6px 0; }
.cmd-form details[open] summary { border-bottom: 1px solid var(--line); margin-bottom: 4px; }
.cmd-form .radios { display: flex; gap: var(--s3); flex-wrap: wrap; margin-top: var(--s2); }
.cmd-form .radios label { display: inline-flex; gap: 6px; align-items: center; margin: 0; color: var(--ink); font-weight: 500; }
.cmd-form .acts { display: flex; gap: var(--s2); margin-top: var(--s5); justify-content: flex-end; }
.chips-in { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; border: 1px solid var(--line-strong); border-radius: var(--r-sm); padding: 4px 6px; background: var(--bg); }
.chips-in .chip { font-family: var(--mono); }
.chips-in .chip button { font: inherit; background: none; border: 0; color: inherit; cursor: pointer; margin-left: 4px; padding: 0; }
.chips-in input { border: 0 !important; flex: 1; min-width: 140px; width: auto !important; background: transparent; padding: 3px 4px; }
.form-banner { margin-top: var(--s3); padding: 8px 12px; border-radius: var(--r-sm); background: var(--warn-bg); color: var(--warn); font-size: var(--fs-xs); line-height: 1.5; }
.form-banner.bad { background: var(--bad-bg); color: var(--bad); }
.form-banner .btn { margin-left: 8px; }
.quiet { color: var(--muted); font-size: var(--fs-sm); line-height: 1.6; }

/* ---- ledger: machinery in two columns, provider keys folded ---- */
.two-col { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: var(--s6); align-items: start; margin-bottom: var(--s6); }
.two-col > * { min-width: 0; }
.two-col .tbl { display: block; overflow-x: auto; margin-bottom: var(--s4) !important; }
.two-col .group { margin-bottom: 0; }
.two-col .col-h { font-size: var(--fs-md); font-weight: 600; margin: 0 0 var(--s3); }
.fold-head { cursor: pointer; user-select: none; }
.fold-head .twist { color: var(--muted); font-size: var(--fs-sm); width: 12px; }
.fold-head:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: var(--r-sm); }
.providers .group { margin-bottom: var(--s3); }

/* ---- ledger: the claims gate — searchable, filterable, expandable ---- */
.gate.claims { max-height: 320px; position: relative; }
.gate.claims.open { max-height: none; }
.gate-tools { display: flex; flex-wrap: wrap; gap: 6px 8px; align-items: center; margin: 8px 0 4px; }
.gate-tools input[type=search] { flex: 1 1 180px; min-width: 140px; margin: 0; height: 30px; padding: 0 10px; font-size: var(--fs-xs); }
.gate-tools .f-pill { height: 26px; }
.gate-tools .link { font-size: var(--fs-xs); }
.gate-note { font-size: var(--fs-xs); color: var(--muted); margin: 4px 0 6px; }
.gate .line.hidden { display: none; }

/* ---- ledger: help ---- */
.legend-list { display: grid; grid-template-columns: auto 1fr; gap: 6px 12px; font-size: var(--fs-sm); margin-top: var(--s3); align-items: start; }
.legend-list .chip { justify-self: start; }
.legend-list .term { font-family: var(--mono); font-size: var(--fs-xs); color: var(--muted); }
.m-sec { max-width: 76ch; margin-bottom: var(--s6); scroll-margin-top: calc(var(--top-h) + var(--s4)); }
.m-sec h3 { font-size: var(--fs-lg); font-weight: 600; margin: var(--s5) 0 var(--s2); letter-spacing: -.01em; }
.m-sec h4 { font-size: var(--fs-md); font-weight: 600; margin: var(--s4) 0 var(--s2); }
.m-sec p { margin: 0 0 var(--s3); line-height: 1.6; font-size: var(--fs-sm); }
.m-sec p.lead { font-size: var(--fs-md); color: var(--muted); }
.m-sec ul, .m-sec ol { padding-left: 22px; margin: 0 0 var(--s3); font-size: var(--fs-sm); line-height: 1.6; }
.m-sec table { border-collapse: collapse; width: 100%; font-size: var(--fs-sm); margin: 0 0 var(--s4); }
.m-sec th { text-align: left; font-size: var(--fs-cap); text-transform: uppercase; letter-spacing: .08em; color: var(--faint); padding: 6px 10px; border-bottom: 1px solid var(--line); }
.m-sec td { padding: 6px 10px; border-bottom: 1px solid var(--line); vertical-align: top; line-height: 1.5; }
.m-sec pre { background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-sm); padding: 10px 12px; font-family: var(--mono); font-size: var(--fs-xs); overflow-x: auto; margin: 0 0 var(--s3); line-height: 1.5; }
.m-sec code { font-family: var(--mono); font-size: .92em; background: var(--panel-2); border: 1px solid var(--line); border-radius: 3px; padding: 0 4px; }
.m-sec .tab-ref { font-weight: 600; color: var(--accent-ink); }
.m-sec .muted { color: var(--muted); }
.m-sec .paths td:first-child { font-family: var(--mono); color: var(--muted); white-space: nowrap; }
.m-sec .paths td:last-child { font-family: var(--mono); word-break: break-all; }
.m-table { overflow-x: auto; }
.modal .field { margin-top: var(--s3); }
.modal .field-err { color: var(--bad); font-size: var(--fs-xs); margin-top: 3px; }
.modal .why-line { font-size: var(--fs-sm); color: var(--muted); line-height: 1.6; white-space: pre-line; }

/* ---- ledger: responsive ---- */
@media (max-width: 1280px) {
  .topstatus .chip.cdp, .topstatus .chip.conn { display: none; }
}
@media (max-width: 1040px) {
  .two-col { grid-template-columns: 1fr; }
  .cmd-layout { grid-template-columns: 1fr; }
  .drawer { width: 480px; }
}
@media (max-width: 720px) {
  .topbar { height: auto; flex-wrap: wrap; gap: var(--s2) var(--s3); padding: var(--s2) var(--s3); }
  .topbar .brand-sub { display: none; }
  .topstatus { margin-left: auto; order: 2; }
  .status .chip:not(.browser):not(.jump) { display: none; }
  #start-host { order: 3; }
  .tabs { order: 4; flex-basis: 100%; min-width: 0; height: 40px; }
  .group-head { top: 0; position: static; }
  .main { padding: var(--s4) var(--s3) 56px; }
  .page-head { flex-wrap: wrap; }
  .page-head > div { flex-wrap: wrap; min-width: 0; }
  .page-head .spacer { display: none; }
  .card, .group, .rows { max-width: 100%; min-width: 0; }
  .card { overflow-x: auto; }
  .cycles { max-width: 100%; }
  .tbl { display: block; overflow-x: auto; }
  .drawer { width: 100vw; }
  /* A row becomes a wrapping line: rail, name, then chip · counts · when, then the buttons. */
  .row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; }
  .row > * { min-width: 0; }
  .row .task-cell { flex: 1 1 200px; }
  .row .actions { flex-basis: 100%; justify-content: flex-start; flex-wrap: wrap; }
  .counts { max-width: none; text-align: left; }
  .when { text-align: left; min-width: 0; }
  .meta.cost { white-space: normal; }
  .scenario-head b { white-space: normal; }
  /* The history group head: one column, its tally allowed to wrap. */
  .run-group { grid-template-columns: minmax(0, 1fr); min-width: 0; }
  .run-group .group-tally, .run-group .pct, .group-tally, .pct { white-space: normal; }
  .group-tally { flex-wrap: wrap; }
  .stats-line { gap: var(--s2) var(--s4); }
  .launcher { max-width: none; }
}
`;

/* ---------------------------------------------------------------- script */

const LEDGER_SCRIPT = String.raw`
/* ================================================================ ledger ==
   Everything above this line is wowUI's script, unchanged apart from two
   renames. Everything below lays it out as the home page. A function declared
   here replaces the one above for the whole script. */

/* ---------------------------------------------------------------- modals */

function trapFocus(box) {
  var focusable = box.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])');
  var first = focusable[0], last = focusable[focusable.length - 1];
  var back = document.activeElement;
  if (first) first.focus();
  box.addEventListener('keydown', function (e) {
    if (e.key !== 'Tab' || focusable.length === 0) return;
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  var observer = new MutationObserver(function () {
    if (!document.body.contains(box)) { observer.disconnect(); if (back && back.focus) back.focus(); }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

/* One idiom for anything destructive or spend-shaped: the action is named in
   the button, Escape cancels, focus is trapped and first lands on Cancel. */
function confirmModal(spec) {
  return new Promise(function (resolve) {
    var done = false;
    function finish(ok) { if (done) return; done = true; overlay.remove(); resolve(ok); }
    var overlay = el('div', { class: 'overlay-backdrop', onclick: function () { finish(false); } });
    var box = el('div', { class: 'modal', role: 'dialog', 'aria-label': spec.title, style: 'max-width:480px', onclick: function (e) { e.stopPropagation(); } });
    box.appendChild(el('div', { class: 'top' }, [
      el('b', { text: spec.title }),
      el('button', { type: 'button', class: 'x', 'aria-label': 'Cancel', text: '✕', onclick: function () { finish(false); } })
    ]));
    if (spec.text) box.appendChild(el('div', { class: 'why-line', text: spec.text }));
    box.appendChild(el('div', { class: 'acts' }, [
      el('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: function () { finish(false); } }),
      el('button', { type: 'button', class: 'btn' + (spec.danger ? ' danger' : ' accent'), text: spec.button, onclick: function () { finish(true); } })
    ]));
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    trapFocus(box);
  });
}

/* A modal with one input — what the browser's own dialog cannot be: styled,
   validated, a password box, or given a list to pick from. */
function promptModal(spec) {
  return new Promise(function (resolve) {
    var done = false;
    function finish(value) { if (done) return; done = true; overlay.remove(); resolve(value); }
    var overlay = el('div', { class: 'overlay-backdrop', onclick: function () { finish(null); } });
    var box = el('div', { class: 'modal', role: 'dialog', 'aria-label': spec.title, style: 'max-width:480px', onclick: function (e) { e.stopPropagation(); } });
    var listId = spec.options ? 'pm-list-' + Math.random().toString(36).slice(2) : null;
    var input = el('input', { type: spec.type || 'text', value: spec.value || '', placeholder: spec.placeholder || '', list: listId,
      autocomplete: spec.type === 'password' ? 'off' : null,
      onkeydown: function (e) { if (e.key === 'Enter') { e.preventDefault(); submit(); } } });
    var err = el('div', { class: 'field-err' });
    function submit() {
      var value = spec.type === 'password' ? input.value : input.value.trim();
      if (spec.validate) { var problem = spec.validate(value); if (problem) { err.textContent = problem; return; } }
      finish(value);
    }
    box.appendChild(el('div', { class: 'top' }, [
      el('b', { text: spec.title }),
      el('button', { type: 'button', class: 'x', 'aria-label': 'Cancel', text: '✕', onclick: function () { finish(null); } })
    ]));
    if (spec.text) box.appendChild(el('div', { class: 'why-line', text: spec.text }));
    box.appendChild(el('div', { class: 'field' }, [el('label', { text: spec.label }), input, err]));
    if (spec.options) box.appendChild(el('datalist', { id: listId }, spec.options.map(function (o) { return el('option', { value: o.value }); })));
    box.appendChild(el('div', { class: 'acts' }, [
      el('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: function () { finish(null); } }),
      el('button', { type: 'button', class: 'btn accent', text: spec.button, onclick: submit })
    ]));
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    trapFocus(box);
    input.focus();
    if (spec.type !== 'password') input.select();
  });
}

/* The destructive command ids, and what their confirmation says. Applied in
   post() so every button that reaches them — Forget, Forget everything — gets
   the same dialog without each button knowing. Clear history keeps its own
   two-click arming button, which is the same idea in place. */
var DESTRUCTIVE = {
  'cache-forget': function (values) {
    return values && values.all
      ? { title: 'Forget every healed selector?', text: 'The healer relearns each one the next time that selector fails — one model call per repair.', button: 'Forget ' + S.cache.length + ' healed selector(s)', danger: true }
      : { title: 'Forget this repair?', text: (values && values.key ? values.key + '\n' : '') + 'The healer relearns it the next time the selector fails.', button: 'Forget it', danger: true };
  }
};

function post(commandId, values, flowPath) {
  var gate = DESTRUCTIVE[commandId];
  var ask = gate ? confirmModal(gate(values)) : Promise.resolve(true);
  return ask.then(function (ok) {
    /* Cancelled: callers chain toasts on success and nothing on failure, so a
       promise that never settles is the quiet outcome. Nothing waits. */
    if (!ok) return new Promise(function () {});
    return wowPost(commandId, values, flowPath);
  });
}

/* -------------------------------- the prompts wowUI makes with the browser's own dialogs */

function renameTask(task) {
  promptModal({
    title: 'Rename this flow', label: 'New name', value: task.name, button: 'Rename',
    text: 'Applies to all ' + task.cycles.length + ' recorded run(s), so the flow stays one row. The original name is kept on the proof file once, so the flow file is still found.',
    validate: function (v) { return v === '' ? 'give it a name' : v.length > 200 ? 'at most 200 characters' : null; }
  }).then(function (next) {
    if (next === null || next === task.name) return;
    Promise.all(task.cycles.map(function (c) {
      return api('/api/proofs/' + encodeURIComponent(c.runId) + '/rename', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: next })
      });
    })).then(function () { S.bundles = {}; S.openTask = null; toast('renamed to "' + next + '"'); refresh(); })['catch'](function (e) { toast(e.message); });
  });
}

function renameGroup(group) {
  var runs = group.tasks.reduce(function (acc, t) { return acc.concat(t.cycles); }, []);
  promptModal({
    title: 'Rename this catalog group', label: 'New title', value: group.origin, button: 'Rename',
    text: 'Written onto all ' + runs.length + ' recorded run(s) of the pass. Grouping is keyed on when the pass ran, never on the title, so nothing regroups.',
    validate: function (v) { return v === '' ? 'give it a title' : v.length > 200 ? 'at most 200 characters' : null; }
  }).then(function (next) {
    if (next === null || next === group.origin) return;
    Promise.all(runs.map(function (c) {
      return api('/api/proofs/' + encodeURIComponent(c.runId) + '/rename', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ group: next })
      });
    })).then(function () { S.bundles = {}; toast('group renamed to "' + next + '"'); refresh(); })['catch'](function (e) { toast(e.message); });
  });
}

/* Continue a catalog run from its ledger on disk. Same contract as wowUI's:
   a 409 that names the persona asks for the password once, in a password box,
   and the pair rides the job's env — never argv, never the ledger. */
function resumeCatalog(ledgerPath, mode, caseId, caseIds, as) {
  var body = { ledgerPath: ledgerPath, mode: mode || 'continue' };
  if (caseId) body.caseId = caseId;
  if (caseIds && caseIds.length) body.caseIds = caseIds;
  if (as) body.as = as;
  api('/api/catalog-runs/resume', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
    .then(function () {
      toast(mode === 'failed' ? 'healing failed cases' : mode === 'errors' ? 'rerunning errored cases' : mode === 'vacuous' ? 're-authoring vacuous cases' : mode === 'from' ? 'rerunning from ' + caseId + ' on current config' : mode === 'cases' ? 're-authoring ' + caseIds.length + ' case(s) from their sheet rows' : 'continuing where it stopped');
      if (S.view !== 'runs') show('runs');
      refresh();
    })
    ['catch'](function (error) {
      var b = error.body || {};
      if (b.needsCredentials && !as) {
        promptModal({
          title: 'Sign-in password', label: b.persona, type: 'password', button: 'Resume with it',
          text: 'This run signs in as ' + b.persona + '. The password is carried to the job as an environment variable — not stored, asked once per panel session.',
          validate: function (v) { return v === '' ? 'the run cannot resume without it' : null; }
        }).then(function (pw) {
          if (pw === null) { toast('not resumed — the run needs its sign-in password'); return; }
          resumeCatalog(ledgerPath, mode, caseId, caseIds, b.persona + ':' + pw);
        });
        return;
      }
      toast(error.message);
    });
}

function reauthorCase(caseId) {
  var ledger = ledgerForCase(caseId);
  if (!ledger) { toast('no catalog run plans ' + caseId + ' — re-authoring needs its ledger'); return; }
  confirmModal({ title: 'Re-author ' + caseId + '?', text: 'It is re-authored from its sheet row on the current code and run again now. Its recorded verdict is replaced by the new run\'s.', button: 'Re-author and run' })
    .then(function (ok) { if (ok) resumeCatalog(ledger, 'cases', null, [caseId]); });
}
function queueAdd(caseId) {
  var q = queueLoad();
  if (q.indexOf(caseId) >= 0) { toast(caseId + ' is already in the work queue'); return; }
  confirmModal({ title: 'Add ' + caseId + ' to the work queue?', text: 'Queued cases are re-authored from their sheet rows and run together when you press Run queue.', button: 'Queue it' })
    .then(function (ok) {
      if (!ok) return;
      q.push(caseId); queueSave(q);
      toast(caseId + ' queued — ' + q.length + ' in the work queue');
      render();
    });
}
function queueRemove(caseId) {
  confirmModal({ title: 'Remove ' + caseId + ' from the work queue?', button: 'Remove', danger: true })
    .then(function (ok) { if (!ok) return; queueSave(queueLoad().filter(function (id) { return id !== caseId; })); render(); });
}
function queueRun() {
  var q = queueLoad();
  if (q.length === 0) return;
  confirmModal({ title: 'Re-author and run ' + q.length + ' queued case(s) now?', text: q.join(', ') + '\nEach is re-authored from its sheet row; recorded verdicts are replaced.', button: 'Run the queue' })
    .then(function (ok) {
      if (!ok) return;
      var byLedger = {}, missing = [];
      q.forEach(function (id) {
        var l = ledgerForCase(id);
        if (!l) { missing.push(id); return; }
        (byLedger[l] = byLedger[l] || []).push(id);
      });
      Object.keys(byLedger).forEach(function (l) { resumeCatalog(l, 'cases', null, byLedger[l]); });
      queueSave(missing);
      if (missing.length) toast(missing.length + ' case(s) stay queued — no catalog run plans them');
      render();
    });
}

/* ------------------------------------------------------------------ shell */

var TABS = [
  { id: 'runs', label: 'Runs', count: function () { return tasks().length; } },
  { id: 'history', label: 'History', count: function () { return S.proofs.length; } },
  { id: 'learned', label: 'Learned', count: function () { return attentionItems().length; }, alert: function () { return attentionItems().length > 0; } },
  { id: 'machinery', label: 'Machinery', count: function () { var k = keyedRoles(); return k.total ? k.keyed + '/' + k.total : ''; }, alert: function () { return unkeyedRoles().length > 0; } },
  { id: 'commands', label: 'Commands', count: function () { return S.meta ? commandsOffered().length : ''; } },
  { id: 'help', label: 'Help' }
];

/* Old addresses still land: every hash either surface ever wrote. A command
   id opens that command's form. */
var LEGACY_HASH = {
  healed: ['learned', 'healed'], attention: ['learned', 'attention'], reports: ['learned', 'reports'], cache: ['learned', 'healed'],
  keys: ['machinery', 'keys'], repos: ['machinery', 'repos'], manual: ['help'], panel: ['commands'], flows: ['commands']
};

function tabOf(id) { return TABS.filter(function (t) { return t.id === id; })[0] || null; }

function commandById(id) {
  return (S.meta && S.meta.commands || []).filter(function (c) { return c.id === id; })[0] || null;
}

function keyedRoles() {
  var roles = (S.keys && S.keys.roles && S.keys.roles.length) ? S.keys.roles : (S.meta ? S.meta.roles || [] : []);
  return { keyed: roles.filter(function (r) { return r.keyed; }).length, total: roles.length };
}

function browserBusyJob() {
  return S.jobs.filter(function (j) { return j.status === 'running' && j.browser; })[0] || null;
}

function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function pref(key, value) {
  try {
    if (value === undefined) { var raw = localStorage.getItem('ledger.' + key); return raw === null ? undefined : JSON.parse(raw); }
    localStorage.setItem('ledger.' + key, JSON.stringify(value));
  } catch (e) { /* private window, blocked storage: the default stands */ }
  return value;
}

/* show(view[, sub]) — the router. Base code calls show('runs') and sets
   S.view = 'keys' in one place; both land here and are mapped. */
function show(view, sub) {
  var legacy = LEGACY_HASH[view];
  if (legacy) { view = legacy[0]; sub = sub || legacy[1]; }
  if (S.meta && commandById(view)) { sub = view; view = 'commands'; }
  if (!tabOf(view)) view = 'runs';
  S.view = view;
  if (view === 'learned' && sub) { S.learnedTab = sub; pref('learned', sub); }
  if (view === 'commands' && sub) openCommand(sub, {}, {});
  var hash = '#' + view;
  if (location.hash !== hash) history.replaceState(null, '', hash);
  renderSidebar();
  render();
  if (view === 'machinery' && sub === 'repos') { var r = byId('sec-repos'); if (r) r.scrollIntoView({ block: 'start' }); }
  else window.scrollTo({ top: 0 });
}

function pageHead(title, sub, action) {
  return el('div', { class: 'page-head' }, [
    el('div', {}, [el('h1', { text: title }), sub ? el('div', { class: 'sub', text: sub }) : null]),
    el('span', { class: 'spacer' }),
    action
  ]);
}

/* The top bar: tabs with their counts, the status a person checks before
   pressing Start, and the Start button. Repainted on every poll. */
function renderSidebar() {
  var tabs = byId('tabs');
  if (!tabs) return;
  clear(tabs);
  TABS.forEach(function (t) {
    var count = t.count ? t.count() : '';
    var current = S.view === t.id || (S.view === 'keys' && t.id === 'machinery');
    tabs.appendChild(el('button', {
      type: 'button', class: 'tab', 'aria-current': current ? 'page' : null,
      onclick: function () { show(t.id); }
    }, [
      el('span', { class: 'txt', text: t.label }),
      count === '' || count === 0 ? null : el('span', { class: 'nav-count' + (t.alert && t.alert() ? ' alert' : ''), text: String(count) })
    ]));
  });
  renderStatus();
  var host = byId('start-host');
  if (host) { clear(host); host.appendChild(startButton()); }
}

function renderStatus() {
  var box = byId('status');
  if (!box) return;
  clear(box);
  box.appendChild(el('span', { class: 'chip conn ' + (S.online ? 'ok' : 'bad'), title: S.meta ? 'proofs in ' + S.meta.paths.proofDir : null,
    text: S.online ? 'connected · ' + location.port : 'unreachable — showing stale data' }));
  var busy = browserBusyJob();
  box.appendChild(el('span', {
    class: 'chip browser ' + (busy ? 'warn' : 'plain'), title: busy ? busy.commandLine : 'no browser command is running',
    text: busy ? 'browser in use — one run at a time' : 'browser free'
  }));
  if (S.meta) box.appendChild(el('span', { class: 'chip plain mono cdp', text: 'CDP ' + String(S.meta.cdpUrl || '').replace(/^https?:\/\//, '') }));
  var k = keyedRoles();
  if (k.total > 0) {
    box.appendChild(el('span', {
      class: 'chip jump ' + (k.keyed === k.total ? 'ok' : k.keyed === 0 ? 'bad' : 'warn'),
      title: 'model roles with a key — click for Models and keys', role: 'button', tabindex: '0',
      text: k.keyed + '/' + k.total + ' roles keyed',
      onclick: function () { show('machinery'); }
    }));
  }
  var cap = S.claude && S.claude.usageCap;
  if (cap && cap.enabled) {
    var worst = cap.worst;
    box.appendChild(el('span', {
      class: 'chip jump ' + (cap.tripped ? 'bad' : cap.nearing ? 'warn' : 'plain'), role: 'button', tabindex: '0',
      title: (worst ? worst.label + ' at ' + Math.round(worst.percent) + '%' : 'no window reported') + ' — click for the usage cap',
      text: cap.tripped ? 'cap tripped — runs held' : 'cap ' + (worst ? Math.round(worst.percent) + '% of ' + cap.capPercent + '%' : cap.capPercent + '%'),
      onclick: function () { show('machinery'); }
    }));
  }
}

function render() {
  var main = byId('main');
  clear(main);
  S.bars = [];
  S.outLive = [];
  if (S.view === 'keys') S.view = 'machinery';
  if (S.view === 'runs') renderRuns(main);
  else if (S.view === 'history') renderHistory(main);
  else if (S.view === 'learned') renderLearned(main);
  else if (S.view === 'machinery') renderMachinery(main);
  else if (S.view === 'commands') renderCommands(main);
  else if (S.view === 'help') renderHelp(main);
}

/* ------------------------------------------------------------------- runs */

function offlineBanner() {
  return el('div', { class: 'warn-banner offline', role: 'status' }, [
    svg(['M12 9v4', 'M12 17h.01', 'M10.36 3.6 2.32 17a2 2 0 0 0 1.71 3h15.94a2 2 0 0 0 1.71-3L13.64 3.6a2 2 0 0 0-3.28 0z']),
    el('div', {}, [
      el('b', { text: 'The panel cannot reach its own server' }),
      el('span', { class: 'fix', text: 'What you see below is the last data that arrived. Restart it with "wowlidator ui" and this page reconnects by itself.' }),
      el('div', { class: 'acts' }, [el('button', { type: 'button', class: 'btn', text: 'Try again', onclick: function () { refresh(); } })])
    ])
  ]);
}

function resumableRuns() {
  return (S.catalogRuns || []).filter(function (run) {
    return !run.running && (run.resumable || run.errors > 0 || run.failed > 0);
  });
}

function caseIdsFor(run) {
  var ids = [];
  (S.groups || []).forEach(function (g) {
    if (run.runKey && g.runKey === run.runKey) (g.runs || []).forEach(function (r) { if (ids.indexOf(r.name) === -1) ids.push(r.name); });
  });
  return ids;
}

/* One catalog run that ended before every case had a verdict, or finished
   with errors or failures — what it is, why, and what continues it. Every
   button continues the run under the same key (src/ui/CLAUDE.md, "The
   resumable-runs record is the ledgers on disk"). */
function resumableBanner(run) {
  var e = run.ended;
  var cause = e && e.cause;
  var state = run.resumable ? (/^paused\b/.test(cause || '') ? 'paused' : 'stopped') : 'finished';
  var head = run.resumable
    ? run.title + ' has ' + run.left + ' of ' + run.summary.planned + ' case(s) still to run'
    : run.title + ' finished — ' + run.errors + ' runtime error(s), ' + run.failed + ' failed';
  var acts = [];
  if (run.reportFile) acts.push(catalogReportButton(run, 'md'));
  if (run.resumable) acts.push(el('button', { type: 'button', class: 'btn md accent', text: 'Continue testing (' + run.left + ' left)', title: 'the cases never reached, blocked or vacuous', onclick: function () { resumeCatalog(run.ledgerPath, 'continue'); } }));
  if (run.errors > 0) acts.push(el('button', { type: 'button', class: 'btn md', title: 'A runtime error is the harness, not a verdict — those cases run again (plus anything still unfinished).', text: 'Rerun all errors (' + run.errors + ')', onclick: function () { resumeCatalog(run.ledgerPath, 'errors'); } }));
  if (run.failed > 0) acts.push(el('button', { type: 'button', class: 'btn md', title: 'Failed and dead-end cases run again with autoheal on (plus anything still unfinished).', text: 'Heal all failed (' + run.failed + ')', onclick: function () { resumeCatalog(run.ledgerPath, 'failed'); } }));
  acts.push(el('button', { type: 'button', class: 'btn', title: 'Cases whose flow only asserted the sign-in and a URL are re-authored and run.', text: 'Re-author vacuous', onclick: function () { resumeCatalog(run.ledgerPath, 'vacuous'); } }));
  acts.push(el('button', {
    type: 'button', class: 'btn',
    title: 'Rerun the plan from one case ONWARD in sheet order — earlier verdicts are kept, everything from that case (passes included) runs again in a fresh process on the CURRENT config.',
    text: 'Resume from case…',
    onclick: function () {
      var ids = caseIdsFor(run);
      promptModal({
        title: 'Resume from which case?', label: 'Case id (plan order)', button: 'Resume from here',
        placeholder: ids[0] || 'PL_06_2',
        text: (ids.length ? ids.length + ' case id(s) are known from this run’s proofs — start typing to pick one. ' : '') + 'That case and everything after it run again on the current config.',
        options: ids.map(function (id) { return { value: id }; }),
        validate: function (v) { return v === '' ? 'a case id is needed' : !/^[A-Za-z0-9._-]{1,80}$/.test(v) ? 'letters, digits, . _ - only' : null; }
      }).then(function (caseId) { if (caseId) resumeCatalog(run.ledgerPath, 'from', caseId); });
    }
  }));
  return el('div', { class: 'warn-banner', role: 'status' }, [
    el('div', {}, [
      el('span', { class: 'state' + (run.resumable ? '' : ' done'), text: state }),
      el('b', { text: head }),
      run.runKey ? el('span', { class: 'fix mono', title: 'run key — the id a resume continues under', text: 'run key: ' + run.runKey }) : null,
      run.persona ? el('span', { class: 'fix mono', text: 'signs in as ' + run.persona + ' — a resume from a restarted panel asks for the password once' }) : null,
      el('span', { class: 'fix mono', text: 'cause: ' + (cause || (run.resumable ? 'the run never recorded how it ended' : 'the run completed')) }),
      el('span', { class: 'fix', text: 'Every button continues this catalog run under the same key: cases already tested are pulled in as finished tests unless the button says otherwise, and the resumed cases join the original group.' }),
      el('div', { class: 'acts' }, acts)
    ])
  ]);
}

function renderRuns(main) {
  main.appendChild(pageHead(
    'Runs and proof',
    'Every flow wowlidator has run, with its latest verdict and the evidence behind it — the last three runs are the rail on the left.',
    null
  ));

  // The launcher lives in the page flow under the head. Its host is always
  // present so renderLauncher() can rebuild it in place from input handlers.
  var launcherHost = el('div', { id: 'launcher' });
  main.appendChild(launcherHost);
  if (S.launcher) launcherHost.appendChild(launcherBox(S.launcher));

  if (!S.online) main.appendChild(offlineBanner());

  main.appendChild(statsStrip());

  var wq = workQueueBox();
  if (wq) main.appendChild(wq);

  var resumable = resumableRuns();
  if (resumable.length > 0) {
    var shown = S.showAllResumable ? resumable : resumable.slice(0, 3);
    var list = el('div', { class: 'banners' });
    shown.forEach(function (run) { list.appendChild(resumableBanner(run)); });
    if (resumable.length > shown.length) {
      list.appendChild(el('div', { class: 'more' }, [
        el('button', { type: 'button', class: 'link', text: 'and ' + (resumable.length - shown.length) + ' more stopped or finished catalog run(s) — show all',
          onclick: function () { S.showAllResumable = true; render(); } })
      ]));
    } else if (S.showAllResumable && resumable.length > 3) {
      list.appendChild(el('div', { class: 'more' }, [
        el('button', { type: 'button', class: 'link', text: 'show the latest three only', onclick: function () { S.showAllResumable = false; render(); } })
      ]));
    }
    main.appendChild(list);
  }

  var live = runningJobs();
  if (live.length > 0) {
    var section = el('section', { class: 'group' });
    section.appendChild(el('div', { class: 'group-head' }, [
      el('span', { class: 'avatar', text: 'W' }),
      el('b', { text: 'Running now' }),
      el('span', { class: 'meta', text: live.length + ' job(s) started from this panel · one browser run at a time' })
    ]));
    var rows = el('div', { class: 'card rows' });
    live.forEach(function (job) {
      rows.appendChild(el('div', {
        class: 'row', role: 'button', tabindex: '0',
        'aria-expanded': outIsOpen(job.id, job) ? 'true' : 'false',
        onclick: function () { toggleOut(job.id, job); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleOut(job.id, job); } }
      }, [
        loopRail(['run', 'empty', 'empty']),
        el('div', { class: 'task-cell' }, [
          el('div', { class: 'task-name', text: job.title }),
          el('div', { class: 'task-sub', text: job.commandLine })
        ]),
        verdictChip('running', 'running'),
        progressBar(job),
        el('span', { class: 'when', text: 'started ' + shortTime(job.startedAt) }),
        el('div', { class: 'actions', onclick: function (e) { e.stopPropagation(); }, onkeydown: function (e) { e.stopPropagation(); } }, [
          el('button', { type: 'button', class: 'btn', text: 'Output', onclick: function () { toggleOut(job.id, job); } }),
          job.commandId === 'catalog-run' ? catalogReportButtonForJob(job) : null,
          job.commandId === 'catalog-run' ? el('button', {
            type: 'button', class: 'btn',
            title: 'Pause immediately: in-flight cases are interrupted and keep no verdict. Continue testing later re-runs them from their first step and keeps everything already finished.',
            text: 'Pause', onclick: function () { pauseJob(job.id); }
          }) : null,
          el('button', { type: 'button', class: 'btn', text: 'Stop', onclick: function () { stopJob(job.id); } })
        ])
      ]));
      var detail = el('div', { class: 'detail' });
      var cases = caseSections(job);
      if (cases) detail.appendChild(cases);
      detail.appendChild(outputSection(job.id, job));
      rows.appendChild(detail);
    });
    section.appendChild(rows);
    main.appendChild(section);
  }

  var all = groups();
  if (all.length === 0 && live.length === 0) {
    main.appendChild(el('div', { class: 'box' }, [
      el('span', { class: 'mark', 'aria-hidden': 'true' }, [el('i'), el('i'), el('i')]),
      el('div', { class: 'big', text: 'Nothing has been proved yet' }),
      el('div', { class: 'why', text: 'Run a flow and its proof bundle lands here — every step, the screenshot taken at it, the calls the page made, and the repair the healer proposed if it needed one.' }),
      startButton('md')
    ]));
    return;
  }

  all.forEach(function (group) { main.appendChild(renderGroup(group)); });
}

/* One line of figures. Every number says what it is a number of. */
function statsStrip() {
  var startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  var today = S.proofs.filter(function (p) { return new Date(p.finishedAt || p.startedAt).getTime() >= startOfDay.getTime(); });
  var recent = S.proofs.slice(0, 7);
  var passed = recent.filter(function (p) { return isPassing(p.status); }).length;
  var pct = recent.length > 0 ? Math.round((passed / recent.length) * 100) : 0;
  var live = runningJobs();
  var stuck = tasks().filter(function (t) { return failStreak(t) >= 3; }).length;
  var rulings = S.proofs.filter(function (p) { return p.status === 'needs-review' && !p.review; }).length;
  var defects = attentionItems().filter(function (i) { return i.card && !i.ruling; }).length;
  function stat(v, k, n, colour) {
    return el('div', { class: 'stat' }, [
      el('span', { class: 'v', style: colour ? 'color:' + colour : null, text: v }),
      el('span', { class: 'k', text: k }),
      el('span', { class: 'n', text: n })
    ]);
  }
  return el('div', { class: 'stats-line', role: 'group', 'aria-label': 'Totals' }, [
    stat(String(today.length), 'runs today', S.proofs[0] ? 'latest ' + shortTime(S.proofs[0].finishedAt) : 'nothing yet'),
    stat(pct + '%', 'proved', recent.length ? passed + ' of the last ' + recent.length + ' runs' : 'no runs yet', 'var(--ok)'),
    stat(String(live.length), 'running', live[0] ? live[0].title : 'nothing running', 'var(--info)'),
    stat(String(stuck + rulings + defects), 'need a human', stuck + ' failing repeatedly · ' + rulings + ' ruling(s) waiting · ' + defects + ' defect(s)', stuck + rulings + defects > 0 ? 'var(--warn)' : null)
  ]);
}

/* Scans EVERY proof the index carries, not the first twelve, and includes
   the runs waiting for a ruling. */
function attentionItems() {
  var items = [];
  tasks().forEach(function (task) {
    if (failStreak(task) >= 3) {
      items.push({
        severity: 'high',
        title: task.name + ' has failed ' + failStreak(task) + ' runs in a row',
        detail: 'Three attempts is where the loop stops and asks a person. ' + (task.latest.error || 'The run reports no error of its own, so the evidence is in the steps.'),
        task: task
      });
    }
  });
  S.proofs.forEach(function (card) {
    if (card.status === 'needs-review' && !card.review) {
      items.push({ severity: 'medium', title: card.name + ' needs your ruling', detail: 'Run ' + card.runId + ' — a step could not be sure. Open the run and confirm proved or failed.', card: card, ruling: true });
    }
    if (card.defects > 0 && card.status === 'failed') {
      items.push({
        severity: card.failed > 0 ? 'medium' : 'low',
        title: card.defects + ' defect(s) in ' + card.name,
        detail: 'Run ' + card.runId + ' · ' + card.failed + ' failed step(s), ' + (card.backend ? card.backend.failed : 0) + ' of them on the API side.',
        card: card
      });
    }
  });
  return items;
}

function openTaskAt(task) {
  S.openTask = task.key;
  var runId = S.cycleOf[task.key] || task.latest.runId;
  S.cycleOf[task.key] = runId;
  show('runs');
  loadBundle(runId).then(render);
}

function openCardAt(card) {
  var task = tasks().filter(function (t) { return t.cycles.some(function (c) { return c.runId === card.runId; }); })[0];
  if (!task) { window.open('/view?path=' + encodeURIComponent(card.path), '_blank'); return; }
  S.cycleOf[task.key] = card.runId;
  openTaskAt(task);
}

function renderAttention(main) {
  main.appendChild(pageHead(
    'Needs a human',
    'Where the machinery stops and says so: a flow that keeps failing, a run waiting for your ruling, and defects a run filed but nothing repaired.',
    null
  ));
  var items = attentionItems();
  if (items.length === 0) {
    main.appendChild(el('div', { class: 'box' }, [
      el('div', { class: 'big', text: 'Nothing is waiting on you' }),
      el('div', { class: 'why', text: 'A flow that fails three runs in a row, a run that needs a ruling, or a defect a run filed would appear here.' })
    ]));
    return;
  }
  items.forEach(function (item) {
    var acts = el('div', { class: 'note' });
    if (item.task) {
      var flowPath = flowPathFor(item.task.name, item.task.latest && item.task.latest.renamedFrom);
      acts.appendChild(el('button', {
        type: 'button', class: 'btn accent', disabled: !flowPath, text: 'Repair it',
        title: flowPath ? 'run it again, letting the generator rewrite the flow around the break' : 'the .flow.json is not visible from here',
        onclick: function () { startRun(item.task.key, { flow: flowPath, repair: true }); }
      }));
      acts.appendChild(el('button', { type: 'button', class: 'btn', text: 'Show the evidence', onclick: function () { openTaskAt(item.task); } }));
    } else if (item.ruling) {
      acts.appendChild(el('button', { type: 'button', class: 'btn accent', text: 'Open the run', onclick: function () { openCardAt(item.card); } }));
    } else {
      acts.appendChild(el('button', { type: 'button', class: 'btn', text: 'Open the run', onclick: function () { openCardAt(item.card); } }));
      if (item.card.reportPath) acts.appendChild(el('button', { type: 'button', class: 'btn', text: 'Open the report', onclick: function () { window.open('/view?path=' + encodeURIComponent(item.card.reportPath), '_blank'); } }));
      acts.appendChild(el('button', { type: 'button', class: 'btn', text: 'Open the raw proof', onclick: function () { window.open('/view?path=' + encodeURIComponent(item.card.path), '_blank'); } }));
    }
    main.appendChild(el('div', { class: 'req-card' }, [
      el('span', { class: 'sev ' + item.severity, text: item.severity }),
      el('div', {}, [
        el('div', { class: 'what', text: item.title }),
        el('div', { class: 'mono' + (item.detail.length > 240 ? ' fold' : ''), style: 'margin-top:4px', text: item.detail,
          title: item.detail.length > 240 ? 'click to show all of it' : null,
          onclick: function (e) { e.currentTarget.classList.toggle('open'); } }),
        acts
      ])
    ]));
  });
}

/* ---------------------------------------------------------------- learned */

var LEARNED_TABS = [
  ['attention', 'Needs a human', function () { return attentionItems().length; }],
  ['healed', 'Healed selectors', function () { return S.cache.length; }],
  ['reports', 'Reports', function () { return S.reports.length; }]
];

function renderLearned(main) {
  var current = S.learnedTab || 'attention';
  var bar = el('div', { class: 'subtabs', role: 'tablist' });
  LEARNED_TABS.forEach(function (t) {
    bar.appendChild(el('button', {
      type: 'button', role: 'tab', class: 'f-pill' + (current === t[0] ? ' on' : ''), 'aria-selected': current === t[0] ? 'true' : 'false',
      text: t[1] + ' · ' + t[2](), onclick: function () { show('learned', t[0]); }
    }));
  });
  main.appendChild(bar);
  if (current === 'healed') renderHealed(main);
  else if (current === 'reports') renderReports(main);
  else renderAttention(main);
}

/* -------------------------------------------------------------- machinery */

function renderMachinery(main) {
  var jump = el('nav', { class: 'jump', 'aria-label': 'On this page' });
  [['sec-keys', 'Models and keys'], ['sec-claude', 'Claude session'], ['sec-db', 'Database'], ['sec-repos', 'Repositories']].forEach(function (pair) {
    jump.appendChild(el('a', { href: '#' + pair[0], text: pair[1], onclick: function (e) {
      e.preventDefault();
      var node = byId(pair[0]) || document.querySelector('[data-sec="' + pair[0] + '"]');
      if (node) node.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
    } }));
  });
  main.appendChild(jump);
  var keys = el('section', { class: 'sec', id: 'sec-keys' });
  renderKeys(keys);
  layoutKeys(keys);
  main.appendChild(keys);
  var repos = el('section', { class: 'sec', id: 'sec-repos' });
  renderRepos(repos);
  main.appendChild(repos);
}

/* renderKeys draws the role table, one section per provider, the Claude
   session and the Database, top to bottom. Here the role table and the Claude
   session sit side by side, and each provider's keys fold under its head — the
   question is "which key is my healer on", and that is the table's answer;
   the cards are what else it could use. */
function layoutKeys(host) {
  var table = host.querySelector('table.tbl');
  if (!table) return;
  var providerKeys = {};
  ((S.keys && S.keys.providers) || []).forEach(function (p) { providerKeys[p.envKey] = p; });
  var claude = null, db = null, providers = [];
  var sections = host.querySelectorAll(':scope > section.group');
  for (var i = 0; i < sections.length; i += 1) {
    var sec = sections[i];
    var b = sec.querySelector('.group-head b');
    var label = b ? b.textContent.trim() : '';
    var env = sec.querySelector('.group-head .mono');
    if (label === 'Claude session') claude = sec;
    else if (label === 'Database') db = sec;
    else if (env && providerKeys[env.textContent.trim()]) providers.push([sec, providerKeys[env.textContent.trim()]]);
  }
  if (claude) claude.setAttribute('data-sec', 'sec-claude');
  if (db) db.setAttribute('data-sec', 'sec-db');

  var left = el('div', {}, [el('div', { class: 'col-h', text: 'Roles' })]);
  table.parentNode.removeChild(table);
  left.appendChild(table);
  if (providers.length) {
    var list = el('div', { class: 'providers' });
    list.appendChild(el('div', { class: 'col-h', text: 'API keys', style: 'margin-top:4px' }));
    providers.forEach(function (pair) {
      var sec = pair[0], provider = pair[1];
      var head = sec.querySelector('.group-head');
      var body = [];
      for (var c = head.nextSibling; c; c = c.nextSibling) body.push(c);
      var key = provider.provider || provider.envKey;
      var open = !!S.keysOpen[key];
      function paint() {
        body.forEach(function (n) { n.style.display = open ? '' : 'none'; });
        var tw = head.querySelector('.twist');
        if (tw) tw.textContent = open ? '\u25BE' : '\u25B8';
        head.setAttribute('aria-expanded', open ? 'true' : 'false');
      }
      head.classList.add('fold-head');
      head.setAttribute('role', 'button');
      head.setAttribute('tabindex', '0');
      head.insertBefore(el('span', { class: 'twist' }), head.firstChild);
      var meta = head.querySelector('.meta');
      if (meta) meta.textContent = provider.keys.length + ' key(s) · ' + meta.textContent;
      head.addEventListener('click', function () { open = !open; S.keysOpen[key] = open; pref('keysOpen', S.keysOpen); paint(); });
      head.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); head.click(); } });
      paint();
      sec.parentNode.removeChild(sec);
      list.appendChild(sec);
    });
    left.appendChild(list);
  }
  var right = el('div', {}, [el('div', { class: 'col-h', text: 'Claude session' })]);
  if (claude) { claude.parentNode.removeChild(claude); claude.querySelector('.group-head').style.display = 'none'; right.appendChild(claude); }
  var grid = el('div', { class: 'two-col' }, [left, right]);
  var anchor = db || host.querySelector('.box');
  if (anchor) host.insertBefore(grid, anchor); else host.appendChild(grid);
}

/* --------------------------------------------------------------- commands */

/* Running a flow is an action on its row, proving a catalog and describing a
   test are the launcher; the rest of the CLI is here, as forms rendered from
   the same declaration the server validates against. */
var COMMANDS_EXCLUDED = ['go', 'catalog-claims', 'catalog-run', 'run'];
var TEST_COMMANDS = ['generate', 'author', 'draft', 'crawl', 'watch'];

function commandsOffered() {
  return (S.meta && S.meta.commands || []).filter(function (c) { return COMMANDS_EXCLUDED.indexOf(c.id) === -1; });
}

function openCommand(id, prefill, lock) {
  S.cmd = { id: id, prefill: prefill || {}, lock: lock || {}, lists: {}, busy: false, goMode: 'describe' };
}

function renderCommands(main) {
  main.appendChild(pageHead(
    'Commands',
    'Every wowlidator command, as a form rendered from the same declaration the server validates against — a flag offered here is a flag it accepts, and the command line it builds is shown before it runs.',
    null
  ));
  if (!S.meta) { main.appendChild(el('div', { class: 'quiet', text: 'waiting for the panel…' })); return; }
  var layout = el('div', { class: 'cmd-layout' });
  var list = el('div', { class: 'cmd-list' });
  var all = commandsOffered();
  var chosen = S.cmd && S.cmd.id ? commandById(S.cmd.id) : null;
  [['Test', function (c) { return TEST_COMMANDS.indexOf(c.id) !== -1; }], ['Maintain', function (c) { return TEST_COMMANDS.indexOf(c.id) === -1; }]].forEach(function (pair) {
    var members = all.filter(pair[1]);
    if (members.length === 0) return;
    list.appendChild(el('div', { class: 'cap', text: pair[0] }));
    members.forEach(function (c) {
      list.appendChild(el('button', { type: 'button', class: 'cmd-item', 'aria-current': chosen && chosen.id === c.id ? 'true' : null,
        onclick: function () { openCommand(c.id, {}, {}); render(); if (window.innerWidth <= 1040) { var p = byId('cmd-pane'); if (p) p.scrollIntoView({ block: 'start' }); } } }, [
        el('b', { text: c.title }),
        el('span', { text: c.blurb }),
        el('i', { class: 'tag', text: (c.browser ? 'browser' : 'no browser') + (c.longRunning ? ' · keeps running' : '') })
      ]));
    });
  });
  layout.appendChild(list);
  var pane = el('div', { class: 'cmd-pane', id: 'cmd-pane' });
  if (!chosen) {
    pane.appendChild(el('h2', { text: 'Pick a command' }));
    pane.appendChild(el('div', { class: 'sub', text: 'Proving a catalog and describing a test live under Start verification. Running a flow again is Run again, Repair or Re-author on its row. Everything else the CLI does is on the left.' }));
  } else {
    pane.appendChild(el('h2', { text: chosen.title }));
    pane.appendChild(el('div', { class: 'sub', text: chosen.blurb + (chosen.browser ? ' Uses the browser.' : ' No browser.') + (chosen.roles && chosen.roles.length ? ' Model: ' + chosen.roles.join(', ') + '.' : '') }));
    pane.appendChild(cmdForm(chosen, S.cmd));
  }
  layout.appendChild(pane);
  main.appendChild(layout);
}

/* A no-* flag reads the right way round as a switch that is ON by default.
   Off sends { 'no-heal': true }; on sends nothing — exactly the CLI's own
   "absent means not stated" semantics, only the checkbox is the other way up. */
var POSITIVE = {
  'no-heal': 'Heal broken selectors',
  'no-agent': 'Let the agent navigate',
  'no-network': 'Watch the page’s HTTP traffic',
  'no-history': 'Record run history',
  'no-report': 'Write the HTML report',
  'no-reconstruct': 'Reconstruct steps in-run',
  'no-agent-early-stop': 'Let the agent give up early',
  'no-ensure-chrome': 'Start or repair Chrome',
  'no-author-review': 'Review authored tests before running them',
  'no-agent-capture': 'Let the agent capture the page first',
  'no-target-highlight': 'Outline the step target in red in every screenshot',
  'no-value-resolution': 'Resolve authoring values from context, repository and database'
};
var ADV_GROUPS = [
  ['Recording', ['video', 'screenshots', 'capture-delay', 'step-delay', 'no-target-highlight']],
  ['Behaviour', ['no-heal', 'no-agent', 'no-agent-early-stop', 'no-reconstruct', 'no-network', 'no-history', 'quarantine-flaky', 'update-baselines', 'no-author-review', 'no-agent-capture', 'no-value-resolution', 'concurrency', 'author-concurrency', 'author-attempts', 'db-baseline']],
  ['Chrome', ['headless', 'browsers', 'no-ensure-chrome', 'stop-chrome', 'wait-for', 'cdp']],
  ['Output', ['report', 'no-report', 'junit', 'ctrf', 'suite', 'flow', 'catalog-out', 'claims-out', 'context-out', 'cache', 'out']]
];
var VERB = { doctor: 'Run the doctor', 'context-list': 'List saved repositories', 'cache-list': 'List healed selectors', 'history-clear': 'Clear run history', 'context-build': 'Build the index', 'context-show': 'Show the index', 'context-add': 'Scan and save', 'cache-forget': 'Forget', watch: 'Start watching' };

function firstSentence(text) {
  var m = /^(.*?[.!?])(\s|$)/.exec(text || '');
  return m ? m[1] : (text || '');
}

function fieldLabel(field) {
  return field.label + (field.required ? ' *' : '');
}

function cmdForm(spec, M) {
  var form = el('form', { class: 'cmd-form', onsubmit: function (e) { e.preventDefault(); submitCmd(spec, M, form); } });
  var gates = {};

  var missing = (spec.roles || []).map(function (role) {
    return (S.meta.roles || []).filter(function (r) { return r.role === role; })[0];
  }).filter(function (r) { return r && !r.keyed; });
  if (missing.length > 0) {
    form.appendChild(el('div', { class: 'form-banner' }, [
      el('b', { text: 'Needs a model key. ' }),
      'The ' + missing.map(function (r) { return r.role; }).join(' and ') + ' role has no key — set ' + missing.map(function (r) { return r.envKey; }).join(' and ') + ' in .env, then re-read it under Machinery. ',
      missing[0].consoleUrl ? el('a', { href: missing[0].consoleUrl, target: '_blank', rel: 'noreferrer', text: 'Get one' }) : null
    ]));
  }
  var busy = spec.browser ? browserBusyJob() : null;
  if (busy) {
    form.appendChild(el('div', { class: 'form-banner' }, [
      el('b', { text: 'The browser is in use. ' }),
      '“' + busy.title + '” is still running and also needs it. Two runs sharing one Chrome interleave their clicks, so this one waits until you stop that one.',
      el('button', { type: 'button', class: 'btn', text: 'Stop it', onclick: function () { stopJob(busy.id); } })
    ]));
  }

  var primary = spec.fields.filter(function (f) { return !f.advanced; });
  var advanced = spec.fields.filter(function (f) { return f.advanced; });
  primary.forEach(function (f) { form.appendChild(renderCmdField(spec, f, M, gates)); });

  if (advanced.length > 0) {
    var placed = {};
    ADV_GROUPS.forEach(function (group) {
      var members = advanced.filter(function (f) { return group[1].indexOf(f.name) !== -1; });
      if (members.length === 0) return;
      var body = el('div', {});
      members.forEach(function (f) { placed[f.name] = true; body.appendChild(renderCmdField(spec, f, M, gates)); });
      form.appendChild(el('details', {}, [el('summary', { text: group[0] + ' (' + members.length + ')' }), body]));
    });
    var rest = advanced.filter(function (f) { return !placed[f.name]; });
    if (rest.length > 0) {
      var restBody = el('div', {});
      rest.forEach(function (f) { restBody.appendChild(renderCmdField(spec, f, M, gates)); });
      form.appendChild(el('details', {}, [el('summary', { text: 'Other options (' + rest.length + ')' }), restBody]));
    }
  }

  Object.keys(gates).forEach(function (name) { gates[name](); });

  var label = spec.longRunning ? 'Start watching' : (VERB[spec.id] || spec.title);
  var err = el('div', { class: 'form-banner bad', style: 'display:none' });
  form.appendChild(err);
  var argv = el('div', { class: 'argv', 'aria-live': 'polite', title: 'the command this form runs — what you learn here transfers to a script' });
  form.appendChild(argv);
  form.addEventListener('input', function () { argv.textContent = commandLineFor(spec, M, form); });
  form.addEventListener('change', function () { argv.textContent = commandLineFor(spec, M, form); });
  form.appendChild(el('div', { class: 'acts' }, [
    el('button', { type: 'button', class: 'btn', text: 'Close', disabled: M.busy, onclick: function () { S.cmd = null; render(); } }),
    el('button', { type: 'submit', class: 'btn primary', disabled: M.busy || !!busy, title: busy ? 'the browser is in use — stop the running job first' : null, text: label })
  ]));
  form.appendChild(el('datalist', { id: 'flowlist' }, S.flows.map(function (f) { return el('option', { value: f.path }); })));
  if (spec.fields.length === 0) form.insertBefore(el('div', { class: 'quiet', style: 'margin-top:8px', text: spec.blurb }), form.firstChild);
  argv.textContent = commandLineFor(spec, M, form);
  return form;
}

function helpFor(field) {
  var one = firstSentence(field.help);
  if (!field.help || one === field.help) return el('div', { class: 'help1', text: field.help || '' });
  var full = el('div', { class: 'help-full', style: 'display:none', text: field.help });
  var q = el('button', { type: 'button', class: 'help-q', 'aria-label': 'more about ' + field.label, 'aria-expanded': 'false', text: '?',
    onclick: function () { var open = full.style.display === 'none'; full.style.display = open ? '' : 'none'; q.setAttribute('aria-expanded', open ? 'true' : 'false'); } });
  return el('div', {}, [el('div', { class: 'help1' }, [document.createTextNode(one), q]), full]);
}

function renderCmdField(spec, field, M, gates) {
  var prefill = M.prefill;
  var locked = !!M.lock[field.name];
  var value = prefill[field.name] !== undefined ? prefill[field.name] : field['default'];
  var id = 'cf-' + spec.id + '-' + field.name;

  if (field.type === 'boolean') {
    var positive = POSITIVE[field.name];
    var box = el('input', { type: 'checkbox', id: id, 'data-field': field.name, 'data-invert': positive ? '1' : null });
    box.checked = positive ? !(value === true) : value === true;
    if (positive && prefill[field.name] === true) box.checked = false;
    box.addEventListener('change', function () { if (gates[field.name]) gates[field.name](); });
    return el('div', { class: 'switch', 'data-wrap': field.name }, [
      box,
      el('div', {}, [
        el('label', { 'for': id, text: positive || field.label }),
        helpFor(field)
      ])
    ]);
  }

  var control;
  if (field.repeatable) {
    control = chipsInput(field, M, value, locked);
  } else if (field.type === 'enum') {
    control = el('select', { id: id, 'data-field': field.name, disabled: locked }, (field.choices || []).map(function (choice) {
      return el('option', { value: choice, text: choice, selected: choice === value });
    }));
  } else if (field.type === 'textarea') {
    control = el('textarea', { id: id, 'data-field': field.name, rows: '3', placeholder: field.placeholder || '', readonly: locked });
    if (value !== undefined) control.value = value;
  } else {
    control = el('input', {
      /* A secret renders as a password box: the value must not sit readable on
         screen, in a screenshot of the panel, or in the DOM as plain text. */
      type: field.type === 'number' ? 'number' : field.type === 'secret' ? 'password' : 'text',
      id: id, 'data-field': field.name, placeholder: field.placeholder || '',
      min: field.min !== undefined ? String(field.min) : null,
      list: (field.name === 'flow' || field.name === 'target') ? 'flowlist' : null,
      readonly: locked, autocomplete: field.type === 'secret' ? 'off' : null
    });
    if (value !== undefined) control.value = value;
  }

  var wrap = el('div', { class: 'field', 'data-wrap': field.name }, [
    el('label', { 'for': id, text: fieldLabel(field) + (field.requiredWhen ? ' *' : '') + (locked ? ' (from the row you picked)' : '') }),
    control,
    helpFor(field),
    el('div', { class: 'field-err' })
  ]);

  /* Visible and disabled until its gate is on, with the gate named — never
     absent from the form a person is reading top to bottom. */
  if (field.requiredWhen) {
    var gateName = field.requiredWhen.field;
    var note = el('div', { class: 'gate-note' });
    wrap.appendChild(note);
    gates[gateName] = function () {
      var gate = document.querySelector('[data-field="' + gateName + '"]');
      var on = !!(gate && gate.checked);
      var gateField = spec.fields.filter(function (f) { return f.name === gateName; })[0];
      control.disabled = !on;
      note.textContent = on ? '' : 'turn on “' + (gateField ? gateField.label : gateName) + '” to fill this';
    };
  }
  return wrap;
}

/* A repeatable field is a chip list: type, Enter, chip; ✕ removes; the
   server gets an array — the only shape it accepts for one. */
function chipsInput(field, M, value, locked) {
  var list = M.lists[field.name] = M.lists[field.name] || (Array.isArray(value) ? value.slice() : value ? [String(value)] : []);
  var wrap = el('div', { class: 'chips-in', 'data-chips': field.name });
  function paint() {
    clear(wrap);
    list.forEach(function (item, i) {
      wrap.appendChild(el('span', { class: 'chip plain' }, [
        document.createTextNode(item),
        locked ? null : el('button', { type: 'button', 'aria-label': 'remove ' + item, text: '✕', onclick: function () { list.splice(i, 1); paint(); } })
      ]));
    });
    if (!locked) {
      var input = el('input', { type: 'text', placeholder: list.length ? 'add another…' : (field.placeholder || ''), list: field.name === 'flow' ? 'flowlist' : null,
        onkeydown: function (e) {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            var v = input.value.trim();
            if (v && list.indexOf(v) === -1) { list.push(v); paint(); wrap.querySelector('input').focus(); }
          } else if (e.key === 'Backspace' && input.value === '' && list.length) { list.pop(); paint(); wrap.querySelector('input').focus(); }
        },
        onblur: function () { var v = input.value.trim(); if (v && list.indexOf(v) === -1) { list.push(v); paint(); } }
      });
      wrap.appendChild(input);
    }
  }
  paint();
  return wrap;
}

/* The values the form would submit, in the shape POST /api/jobs accepts. */
function collectCmd(spec, M, form) {
  var values = {};
  var problems = [];
  spec.fields.forEach(function (field) {
    var wrap = form.querySelector('[data-wrap="' + field.name + '"]');
    if (wrap && wrap.style.display === 'none') return;
    if (field.type === 'boolean') {
      var box = form.querySelector('[data-field="' + field.name + '"]');
      if (!box) return;
      if (box.getAttribute('data-invert')) { if (!box.checked) values[field.name] = true; }
      else if (box.checked) values[field.name] = true;
      else if (field.offFlag) values[field.name] = false;
      return;
    }
    if (field.repeatable) {
      var list = M.lists[field.name] || [];
      if (list.length) values[field.name] = list.slice();
      else if (field.required) problems.push([field.name, 'needed']);
      return;
    }
    var input = form.querySelector('[data-field="' + field.name + '"]');
    if (!input || input.disabled) return;
    var v = String(input.value).trim();
    if (v !== '') values[field.name] = v;
    else if (field.required) problems.push([field.name, 'needed']);
  });
  return { values: values, problems: problems };
}

/* What the server will spawn, as a person would type it. Secrets never show:
   they travel as env, and the line says so. The server builds the real argv
   from the same spec; this is the preview, not the source of truth. */
function commandLineFor(spec, M, form) {
  var got = collectCmd(spec, M, form);
  var parts = ['wowlidator'].concat(spec.argv || [spec.id]);
  (spec.fixedFlags || []).forEach(function (f) { parts.push(f); });
  var env = [];
  spec.fields.forEach(function (field) {
    var v = got.values[field.name];
    if (v === undefined) return;
    if (field.type === 'secret') { env.push(field.envVar || field.name.toUpperCase()); return; }
    if (field.positional) { [].concat(v).forEach(function (x) { parts.push(quoteArg(x)); }); return; }
    if (field.type === 'boolean') { parts.push(v === false ? '--' + (field.offFlag || 'no-' + field.name) : '--' + field.name); return; }
    [].concat(v).forEach(function (x) { parts.push('--' + field.name + ' ' + quoteArg(x)); });
  });
  return parts.join(' ') + (env.length ? '   # ' + env.join(', ') + ' carried as env, never argv' : '');
}

function quoteArg(v) {
  v = String(v);
  return /[\s"'$]/.test(v) ? '"' + v.replace(/"/g, '\\"') + '"' : v;
}

function submitCmd(spec, M, form) {
  var got = collectCmd(spec, M, form);
  spec.fields.forEach(function (field) {
    var wrap = form.querySelector('[data-wrap="' + field.name + '"]');
    if (wrap) { wrap.classList.remove('err'); var fe = wrap.querySelector('.field-err'); if (fe) fe.textContent = ''; }
  });
  if (got.problems.length) { got.problems.forEach(function (p) { markField(form, p[0], p[1]); }); return; }

  var banner = form.querySelector('.form-banner.bad');
  banner.style.display = 'none';
  M.busy = true;
  var flowPath = spec.id === 'run' && got.values.flow && got.values.flow.length === 1 ? got.values.flow[0] : null;
  post(spec.id, got.values, flowPath).then(function () {
    M.busy = false;
    S.cmd = null;
    if (S.view !== 'runs') show('runs');
  })['catch'](function (error) {
    M.busy = false;
    var m = /"([a-z0-9-]+)"/i.exec(error.message || '');
    if (m && form.querySelector('[data-wrap="' + m[1] + '"]')) { markField(form, m[1], error.message); return; }
    banner.textContent = error.message;
    banner.style.display = '';
    banner.scrollIntoView({ block: 'nearest' });
  });
}

function markField(form, name, message) {
  var wrap = form.querySelector('[data-wrap="' + name + '"]');
  if (!wrap) return;
  wrap.classList.add('err');
  var fe = wrap.querySelector('.field-err');
  if (fe) fe.textContent = message;
  var details = wrap.closest('details');
  if (details) details.open = true;
  wrap.scrollIntoView({ block: 'nearest' });
}

/* ---------------------------------------------------------- claims gate */

/* A claim's scenario, by the sheet's own numbering: PL_02_03 → PL_02,
   HIR-EC-029 → HIR-EC. The same rule the run list groups by (scenarioOf). */
function claimScenario(claim) {
  var id = caseIdOf(claim.claim);
  if (!id) return 'other';
  var cut = Math.max(id.lastIndexOf('_'), id.lastIndexOf('-'));
  return cut <= 0 ? 'other' : id.slice(0, cut);
}

function claimShown(M, claim) {
  if (M.claimScenario && M.claimScenario !== claimScenario(claim)) return false;
  var q = (M.claimQuery || '').trim().toLowerCase();
  if (!q) return true;
  return (claim.claim + ' ' + (claim.source || '') + ' ' + claim.priority).toLowerCase().indexOf(q) !== -1;
}

/* The gate, kept in place: ticking a claim updates that row, the count line
   and the submit button — never the whole launcher, so the list keeps its
   scroll position and the search box keeps its focus. */
function claimsGate(M) {
  var claims = M.claims.claims;
  var testable = claims.filter(function (claim) { return claim.testable; });
  var scenarios = [];
  testable.forEach(function (c) { var sc = claimScenario(c); if (scenarios.indexOf(sc) === -1) scenarios.push(sc); });

  var wrap = el('div', {});
  var count = el('div', { class: 'sub', style: 'margin-bottom:8px' });
  function paintCount() {
    count.textContent = countApproved(M) + ' of ' + testable.length + ' claims will be proved — untick anything you do not want before it costs tokens and a browser.';
  }
  paintCount();
  wrap.appendChild(count);
  if (M.claims.summary) wrap.appendChild(el('div', { class: 'mono', style: 'margin-bottom:8px', text: M.claims.summary }));
  if (M.claims.documentNote) wrap.appendChild(el('div', { class: 'err', style: 'margin-bottom:8px', text: M.claims.documentNote }));

  var gate = el('div', { class: 'gate claims' + (M.claimsOpen ? ' open' : '') });

  if (M.claims.sequence && M.claims.sequence.participants && M.claims.sequence.participants.length) {
    gate.appendChild(el('div', { class: 'sub', style: 'margin:10px 0 4px; font-weight:600', text: 'Lanes — who is who in this diagram' }));
    gate.appendChild(el('div', { class: 'sub', style: 'margin-bottom:6px',
      text: 'Checkability follows the planes: user and page lanes are observable from the browser; backend and external lanes are held as assumptions. Correct a guessed lane and the claims below update.' }));
    M.claims.sequence.participants.forEach(function (lane) {
      var row = el('div', { class: 'gate line', style: 'cursor:default; display:flex; align-items:center; gap:8px' });
      row.appendChild(el('span', { class: 'mono', text: lane.name + (lane.label && lane.label !== lane.name ? ' (' + lane.label + ')' : '') }));
      var planeSelect = el('select', { onchange: function (e) { lane.plane = e.target.value; lane.guessed = false; recomputeLanes(M); renderLauncher(); } });
      ['user', 'page', 'backend', 'external'].forEach(function (plane) { planeSelect.appendChild(el('option', { value: plane, selected: plane === lane.plane, text: plane })); });
      row.appendChild(planeSelect);
      if (lane.guessed) row.appendChild(el('span', { class: 'chip', text: 'guessed — confirm' }));
      gate.appendChild(row);
    });
  }

  var rows = [];
  var note = el('div', { class: 'gate-note' });
  function applyFilter() {
    var shown = 0;
    rows.forEach(function (r) { var on = claimShown(M, r.claim); r.node.classList.toggle('hidden', !on); if (on && r.claim.testable) shown += 1; });
    var parts = [];
    if (M.claimScenario) parts.push('scenario ' + M.claimScenario);
    if ((M.claimQuery || '').trim()) parts.push('matching “' + M.claimQuery.trim() + '”');
    note.textContent = parts.length ? shown + ' of ' + testable.length + ' claims ' + parts.join(', ') + ' — Select shown / Clear shown act on these only' : '';
  }

  var tools = el('div', { class: 'gate-tools' });
  var search = el('input', { type: 'search', placeholder: 'search claims…', 'aria-label': 'Search claims', value: M.claimQuery || '',
    oninput: function () { M.claimQuery = search.value; applyFilter(); } });
  tools.appendChild(search);
  if (scenarios.length > 1) {
    var pills = el('div', { style: 'display:flex; flex-wrap:wrap; gap:4px' });
    function pill(id, label) {
      var b = el('button', { type: 'button', class: 'f-pill' + ((M.claimScenario || '') === id ? ' on' : ''), text: label,
        onclick: function () { M.claimScenario = id; var all = pills.querySelectorAll('.f-pill'); for (var i = 0; i < all.length; i += 1) all[i].classList.toggle('on', all[i] === b); applyFilter(); } });
      return b;
    }
    pills.appendChild(pill('', 'All · ' + testable.length));
    scenarios.forEach(function (sc) { pills.appendChild(pill(sc, sc + ' · ' + testable.filter(function (c) { return claimScenario(c) === sc; }).length)); });
    tools.appendChild(pills);
  }
  function setShown(keep) {
    rows.forEach(function (r) { if (r.claim.testable && claimShown(M, r.claim)) { M.cut[r.index] = !keep; r.paint(); } });
    paintCount(); syncSubmit();
  }
  tools.appendChild(el('button', { type: 'button', class: 'link', text: 'Select shown', onclick: function () { setShown(true); } }));
  tools.appendChild(el('button', { type: 'button', class: 'link', text: 'Clear shown', onclick: function () { setShown(false); } }));
  tools.appendChild(el('button', { type: 'button', class: 'link', text: M.claimsOpen ? 'Collapse' : 'Expand', onclick: function (e) {
    M.claimsOpen = !M.claimsOpen; gate.classList.toggle('open', M.claimsOpen); e.currentTarget.textContent = M.claimsOpen ? 'Collapse' : 'Expand';
  } }));
  wrap.appendChild(tools);
  wrap.appendChild(note);

  claims.forEach(function (claim, index) {
    if (!claim.testable) {
      var ctx = el('div', { class: 'gate line', style: 'cursor:default' }, [el('span', { class: 'mono', text: 'context · ' + claim.claim })]);
      rows.push({ claim: claim, index: index, node: ctx, paint: function () {} });
      gate.appendChild(ctx);
      return;
    }
    var row = el('label', { class: 'gate line' });
    var tick = el('input', { type: 'checkbox', onchange: function () { M.cut[index] = !M.cut[index]; paint(); paintCount(); syncSubmit(); } });
    function paint() { tick.checked = !M.cut[index]; row.classList.toggle('cut', !!M.cut[index]); }
    row.appendChild(tick);
    row.appendChild(el('span', {}, [
      el('span', { class: 'mono', text: '[' + claim.priority + '] ' }),
      document.createTextNode(claim.claim),
      claim.source ? el('span', { class: 'mono', text: '  ← ' + claim.source }) : null
    ]));
    paint();
    rows.push({ claim: claim, index: index, node: row, paint: paint });
    gate.appendChild(row);
  });
  applyFilter();
  wrap.appendChild(gate);
  return wrap;
}

/* ------------------------------------------------------------------- help */

/* Shown → meant. The chip shows the plain word; this list carries the exact
   term the proof file uses, because that term is what the CLI prints and
   what grep finds. The data is never rewritten — only explained. */
var VOCAB = [
  { term: 'passed', shown: 'proved', chip: 'verified', meaning: 'every step passed, first time' },
  { term: 'pass**', alias: ['passed-with-issues'], shown: 'pass**', chip: 'doubt', meaning: 'proved, but only after the healer replaced a selector — check the heal' },
  { term: 'proved-?', alias: ['needs-review'], shown: 'proved-? · confirm below', chip: 'blocked', meaning: 'a step could not be sure; confirm proved or failed in the run detail' },
  { term: 'failed', shown: 'test failed', chip: 'escalated', family: 'test-failed', meaning: "a step's claim was false in the application — the subject missed the case's expectation" },
  { term: 'dead-end', shown: 'test failed (dead-end)', chip: 'escalated', family: 'test-failed', meaning: 'a control or content the case needed never resolved — the page did not offer what the case expected' },
  { term: 'error', alias: ['runtime error'], shown: 'system error', chip: 'feedback', family: 'system error', meaning: 'the harness, a model, a key or the environment broke — no verdict about the application was delivered' },
  { term: 'blocked', shown: 'blocked', chip: 'blocked', meaning: 'needed something not configured (a database, a key) — not run, not failed' },
  { term: 'quarantined', shown: 'quarantined', chip: 'plain', meaning: 'a known-flaky failure, recorded but not counted against the run' },
  { term: 'needs a human', alias: ['failStreak ≥ 3'], shown: 'needs a human', chip: 'escalated', meaning: 'failed three or more runs in a row; a person should look' },
  { term: 'spec?', alias: ['specQuestion'], shown: 'spec?', chip: 'doubt', meaning: 'a needs-review whose disputed expectations quote the sheet’s own wording while the page renders it differently — a triage marker for the BA, never a verdict' },
  { term: 'cycle', shown: 'Run 1, 2, 3…', chip: 'plain', meaning: 'one execution of a flow; the rail shows the last three' },
  { term: 'run key', shown: 'run key', chip: 'plain', meaning: 'the id a paused catalog run resumes under (<catalog>@<stamp>); shown beside Continue' },
  { term: 'ledger', shown: 'progress file', chip: 'plain', meaning: '<claims>.progress.json — what Continue testing reads' },
  { term: 'bundle', shown: 'proof file', chip: 'plain', meaning: 'the JSON a run leaves behind; "Open the raw proof" opens it' },
  { term: 'rung', shown: 'settled at', chip: 'plain', meaning: 'which strategy on the escalation ladder made the step pass: fast · case · dialog · cache · backend · heal' },
  { term: 'polarity', shown: 'positive / negative', chip: 'plain', meaning: 'whether the claim asserts presence (positive) or absence (negative); stated by the sheet, or inferred' },
  { term: 'vacuous', shown: 'vacuous', chip: 'plain', meaning: 'a case that passed without checking anything — re-author it' },
  { term: 'consent gate', alias: ['interstitial'], shown: 'waiting for the page', chip: 'plain', meaning: 'the agent is clearing a cookie or sign-in screen first' }
];

var MANUAL_TAGS = ['h3', 'h4', 'p', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'code', 'b', 'strong', 'em', 'i', 'span', 'ul', 'ol', 'li', 'pre', 'br', 'small'];

function manualNode(node) {
  if (typeof node === 'string') return document.createTextNode(node);
  var tag = MANUAL_TAGS.indexOf(node.t) === -1 ? 'span' : node.t;
  var built = el(tag, { class: node.c || null }, node.k.map(manualNode));
  return tag === 'table' ? el('div', { class: 'm-table' }, [built]) : built;
}

function scrollToId(id) {
  var node = byId(id);
  if (node) node.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
}

function renderHelp(main) {
  main.appendChild(pageHead('Help', 'What all of this is and how to use it — the manual, the words on the chips, and where everything lands on this machine.', null));
  var toc = el('nav', { class: 'jump', 'aria-label': 'Manual sections' });
  toc.appendChild(el('a', { href: '#m-page', text: 'This page', onclick: function (e) { e.preventDefault(); scrollToId('m-page'); } }));
  MANUAL_DATA.forEach(function (sec) { toc.appendChild(el('a', { href: '#m-' + sec.id, text: sec.title, onclick: function (e) { e.preventDefault(); scrollToId('m-' + sec.id); } })); });
  toc.appendChild(el('a', { href: '#m-glossary', text: 'What the words mean', onclick: function (e) { e.preventDefault(); scrollToId('m-glossary'); } }));
  toc.appendChild(el('a', { href: '#m-paths', text: 'Paths on this machine', onclick: function (e) { e.preventDefault(); scrollToId('m-paths'); } }));
  main.appendChild(toc);

  main.appendChild(el('section', { class: 'm-sec', id: 'm-page' }, [
    el('h3', { text: 'This page' }),
    el('p', { text: 'Six tabs. Runs is every flow with its latest verdict and the evidence under it — the launcher opens there. History is one row per run, newest first. Learned is what the runs taught: what needs a human, the selectors the healer repaired, and the reports on disk. Machinery is models, keys, the Claude session, the database and saved repositories. Commands is every other CLI command as a form. The chips in the top bar are repainted on every poll, so what they say is what the next run gets.' }),
    el('p', {}, [document.createTextNode('Every action runs the CLI and shows the command it built. The older wowUI is still served at '), el('code', { text: '/wow' }), document.createTextNode(' for comparison; its addresses land here.')])
  ]));

  MANUAL_DATA.forEach(function (sec) {
    var section = el('section', { class: 'm-sec', id: 'm-' + sec.id });
    section.appendChild(el('h3', { text: sec.title }));
    sec.body.forEach(function (node) { section.appendChild(manualNode(node)); });
    main.appendChild(section);
  });

  var glossary = el('section', { class: 'm-sec', id: 'm-glossary' });
  glossary.appendChild(el('h3', { text: 'What the words mean' }));
  glossary.appendChild(el('p', { text: 'The chip shows the plain word; the exact term is what the proof file and the CLI print. Both are on screen: hover a chip for the machine status, or read them here.' }));
  var list = el('div', { class: 'legend-list' });
  VOCAB.forEach(function (v) {
    list.appendChild(el('span', { class: 'chip ' + v.chip, text: v.shown }));
    list.appendChild(el('span', {}, [el('span', { class: 'term', text: (v.family ? v.family + ' · ' : '') + v.term + (v.alias ? ' · ' + v.alias.join(' · ') : '') }), el('div', { text: v.meaning })]));
  });
  glossary.appendChild(list);
  main.appendChild(glossary);

  var paths = el('section', { class: 'm-sec', id: 'm-paths' });
  paths.appendChild(el('h3', { text: 'Paths on this machine' }));
  if (!S.meta) paths.appendChild(el('p', { class: 'quiet', text: 'waiting for the panel…' }));
  else {
    var rows = [['here', S.meta.cwd], ['reports', S.meta.paths.reportDir], ['proofs', S.meta.paths.proofDir], ['cache', S.meta.paths.cachePath], ['history', S.meta.paths.historyPath], ['project index', S.meta.paths.contextGraph], ['CDP', S.meta.cdpUrl]];
    var table = el('table', { class: 'paths' });
    rows.forEach(function (r) { table.appendChild(el('tr', {}, [el('td', { text: r[0] }), el('td', { text: r[1] || '—' })])); });
    paths.appendChild(el('div', { class: 'm-table' }, [table]));
  }
  main.appendChild(paths);
}

/* ------------------------------------------------------------------- data */

function dataSignature() {
  return wowDataSignature() + '|' + JSON.stringify([
    S.failedRuns.map(function (r) { return r.id + r.status; }),
    S.db && [S.db.configured, S.db.maskedUrl, S.db.probe && S.db.probe.at, S.db.checking],
    S.online, S.view, S.learnedTab, S.cmd && S.cmd.id
  ]);
}

/* ------------------------------------------------------------------- boot */

function handleHash() {
  var raw = (location.hash || '').replace('#', '');
  if (!raw) { if (S.view !== 'runs') show('runs'); return; }
  if (tabOf(raw)) { if (S.view !== raw) show(raw); return; }
  if (LEGACY_HASH[raw]) { show(raw); return; }
  if (S.meta && commandById(raw)) { show('commands', raw); return; }
  if (/^m-/.test(raw)) { if (S.view !== 'help') show('help'); scrollToId(raw); }
}

function boot() {
  S.view = 'runs';
  S.learnedTab = pref('learned') || 'attention';
  S.keysOpen = pref('keysOpen') || {};
  S.cmd = null;
  S.showAllResumable = false;
  S.db = S.db || null;

  api('/api/meta').then(function (meta) { S.meta = meta; renderSidebar(); if (!S.hashHandled) { S.hashHandled = true; handleHash(); } })['catch'](function () {});
  refresh();

  window.addEventListener('hashchange', handleHash);
  window.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    var overlays = document.querySelectorAll('.overlay-backdrop');
    if (overlays.length) { overlays[overlays.length - 1].remove(); return; }
    if (S.launcher) closeLauncher();
    else if (S.drawer) closeDrawer();
  });
  // Polling, not a socket: the page has to be right after a CLI run finishes in
  // another terminal too, and that produces no event this server could see.
  setInterval(function () { if (document.visibilityState === 'visible') refresh(); }, 5000);
  setInterval(function () { if (document.visibilityState === 'visible') tickProgress(); }, 1000);
}

boot();
`;

/** The whole page: markup, styles and behaviour, in one document. */
export function renderLedger(): string {
  const manual = MANUAL.map((section) => ({ id: section.id, title: section.title, body: parseManualHtml(section.html) }));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>wowlidator</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 32 32%27%3E%3Crect width=%2732%27 height=%2732%27 rx=%277%27 fill=%27%231C2126%27/%3E%3Ctext x=%2716%27 y=%2722%27 text-anchor=%27middle%27 font-family=%27monospace%27 font-weight=%27700%27 font-size=%2718%27 fill=%27%23fff%27%3EW%3C/text%3E%3C/svg%3E">
<style>${WOW_STYLE}${LEDGER_STYLE}</style>
</head>
<body>
<header class="topbar">
  <div class="brand">
    <span class="brand-mark" aria-hidden="true">W</span>
    <div>
      <div class="brand-word">wow<span class="slash">//</span>UI</div>
    </div>
  </div>
  <nav class="tabs" id="tabs" aria-label="Sections"></nav>
  <div class="topstatus" id="status" aria-live="polite"></div>
  <div id="start-host"></div>
</header>
<main class="main" id="main"></main>
<div id="drawer"></div>
<div class="toast-container" id="toasts"></div>
<script>var MANUAL_DATA = ${scriptJson(manual)};</script>
<script>${baseScript()}${LEDGER_SCRIPT}</script>
</body>
</html>
`;
}
