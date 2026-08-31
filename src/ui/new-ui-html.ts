/**
 * newUI — the control panel and wowUI as ONE page, at `/new`.
 *
 * The design is `docs/one-page-ui-spec.md`. The implementation rule is the
 * spec's frozen boundary: nothing below the page changes. This module is a
 * composition layer over `wow-ui-html.ts` — its script ships here verbatim as a
 * library (the task rows, the checks table, the evidence drawer, the launcher,
 * the Models & keys internals, all of it), and the functions that decided
 * *where things go* — `render`, `show`, `boot`, `renderSidebar`, `pageHead` —
 * are declared again below. A later top-level function declaration replaces an
 * earlier one for the whole script, which is what lets the wowUI code keep
 * calling `render()` and get the one-page version.
 *
 * Four base functions are wrapped rather than replaced (the launcher opener and
 * box, `post`, the data fingerprint): those are renamed at build time with an
 * exact-match replace that throws if the anchor has moved, so a refactor of
 * wowUI cannot silently strip the new behaviour.
 *
 * Same three rules as both surfaces it merges: it runs the CLI, it builds DOM
 * through `el()` only (the manual is parsed into data on the server and built
 * node by node — no `innerHTML` anywhere on this page), and it is one document.
 */

import { MANUAL } from './manual.js';
import { WOW_SCRIPT, WOW_STYLE } from './wow-ui-html.js';

/* ------------------------------------------------------------ the manual */

/** A manual node: text, or a tag with an optional class and its children. */
export type ManualNode = string | { t: string; c?: string; k: ManualNode[] };

const VOID_TAGS = new Set(['br']);
const ENTITIES: Record<string, string> = {
  '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ',
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
 * page boots itself, after its declarations), and the four functions this
 * page wraps renamed so their originals stay reachable. Every anchor is an
 * exact string; a miss throws at render time, which is the first request to
 * `/new` — never a page that silently lost a feature.
 */
function baseScript(): string {
  const renames: Array<[string, string]> = [
    ['function openLauncher() {', 'function wowOpenLauncher() {'],
    ['function launcherBox(M) {', 'function wowLauncherBox(M) {'],
    ['function post(commandId, values, flowPath) {', 'function wowPost(commandId, values, flowPath) {'],
    ['function dataSignature() {', 'function wowDataSignature() {'],
  ];
  let script = WOW_SCRIPT;
  for (const [from, to] of renames) {
    const first = script.indexOf(from);
    if (first === -1 || script.indexOf(from, first + 1) !== -1) {
      throw new Error(`newUI: expected exactly one "${from}" in wowUI's script`);
    }
    script = script.replace(from, to);
  }
  const bootCall = /\nboot\(\);\s*$/;
  if (!bootCall.test(script)) throw new Error('newUI: wowUI\'s script no longer ends with boot()');
  return script.replace(bootCall, '\n');
}

/* ----------------------------------------------------------------- style */

const NEW_STYLE = `
/* ---- newUI: one page ---- */
.topbar {
  position: sticky; top: 0; z-index: 900;
  display: flex; align-items: center; gap: var(--s3); flex-wrap: wrap;
  padding: 8px var(--s5); background: var(--panel); border-bottom: 1px solid var(--line);
}
.topbar .brand { padding: 0; }
.topbar .status { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.topbar .status .chip { cursor: default; }
.topbar .status .chip.jump { cursor: pointer; }
.topbar .search {
  margin-left: auto; min-width: 220px; font: inherit; font-size: var(--fs-sm);
  padding: 5px 10px; border: 1px solid var(--line-strong); border-radius: var(--r-sm);
  background: var(--bg); color: var(--ink);
}
.topbar .search:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
.app { min-height: calc(100vh - 49px); }
.side { top: 49px; min-height: calc(100vh - 49px); }
.side .nav-item { text-decoration: none; }
.main { padding-top: var(--s5); }
.sec { scroll-margin-top: 64px; margin-bottom: var(--s7); padding-bottom: var(--s5); border-bottom: 1px solid var(--line); }
.sec:last-child { border-bottom: 0; }
.sec-head { display: flex; align-items: flex-start; gap: var(--s4); margin-bottom: var(--s4); flex-wrap: wrap; }
.sec-head h2 { font-size: var(--fs-xl); font-weight: 600; letter-spacing: -.02em; line-height: 1.3; margin: 0; }
.sec-head .sub { font-size: var(--fs-sm); color: var(--muted); margin-top: 2px; max-width: 640px; }
.sec-head .spacer { margin-left: auto; }
.sec-head .acts { display: flex; gap: var(--s2); flex-wrap: wrap; align-items: center; }
.sub-head { margin: var(--s4) 0 var(--s3); }
.sub-head h3 { font-size: var(--fs-lg); font-weight: 600; letter-spacing: -.01em; margin: 0; }
.quiet { color: var(--muted); font-size: var(--fs-sm); line-height: 1.6; }
.oneline { padding: var(--s3) var(--s4); background: var(--panel); border: 1px dashed var(--line-strong); border-radius: var(--r-lg); font-size: var(--fs-sm); color: var(--muted); }
.toolbar { display: flex; gap: var(--s2); flex-wrap: wrap; align-items: center; margin-bottom: var(--s3); }
.toolbar .cap { margin-right: 2px; }
.toolbar .gap { width: var(--s3); }
.lib-card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-lg); box-shadow: var(--shadow); margin-bottom: var(--s4); }
.lib-head { display: flex; align-items: center; gap: var(--s3); padding: var(--s3) var(--s4); cursor: pointer; user-select: none; }
.lib-head:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; border-radius: var(--r-lg); }
.lib-head b { font-size: var(--fs-md); }
.lib-head .twist { color: var(--faint); width: 12px; }
.lib-head .sub { color: var(--muted); font-size: var(--fs-xs); }
.lib-head .acts { margin-left: auto; display: flex; gap: var(--s2); flex-wrap: wrap; }
.lib-body { padding: 0 var(--s4) var(--s4); border-top: 1px solid var(--line); }
.lib-body > .page-head, .lib-body .sub-head { display: none; }
.lib-body .card, .lib-body .group { box-shadow: none; }
.lib-body .group:first-child { margin-top: var(--s4); }
.launcher.wide { max-width: 820px; }
.cmd-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 8px; margin-top: var(--s2); }
.cmd-item { text-align: left; font: inherit; background: var(--panel-2); border: 1px solid var(--line); border-radius: var(--r-md, 8px); padding: 10px 12px; cursor: pointer; color: var(--ink); }
.cmd-item:hover { border-color: var(--accent-line); background: var(--accent-soft); }
.cmd-item:focus-visible { outline: 2px solid var(--accent); }
.cmd-item b { display: block; font-size: var(--fs-sm); }
.cmd-item span { display: block; font-size: var(--fs-xs); color: var(--muted); margin-top: 2px; line-height: 1.45; }
.cmd-item .tag { display: inline-block; margin-top: 4px; font-size: 10px; letter-spacing: .06em; text-transform: uppercase; color: var(--faint); }
.cmd-form .field { margin-top: var(--s3); }
.cmd-form .field.err label { color: var(--bad); }
.cmd-form .field.err input, .cmd-form .field.err textarea, .cmd-form .field.err select, .cmd-form .field.err .chips-in { border-color: var(--bad); }
.cmd-form .field-err { color: var(--bad); font-size: var(--fs-xs); margin-top: 3px; }
.cmd-form .help1 { font-size: var(--fs-xs); color: var(--muted); margin-top: 3px; line-height: 1.5; }
.cmd-form .help-full { font-size: var(--fs-xs); color: var(--muted); margin-top: 3px; line-height: 1.6; padding: 6px 10px; background: var(--panel-2); border-radius: var(--r-sm); }
.cmd-form .help-q { font: inherit; font-size: 11px; font-weight: 700; color: var(--accent-ink); background: var(--accent-soft); border: 0; border-radius: 50%; width: 18px; height: 18px; cursor: pointer; margin-left: 6px; vertical-align: middle; }
.cmd-form .switch { display: flex; gap: 10px; align-items: flex-start; margin-top: var(--s3); }
.cmd-form .switch input { width: auto; display: inline-block; margin-top: 3px; }
.cmd-form .switch label { margin: 0; color: var(--ink); font-weight: 500; }
.cmd-form .gate-note { font-size: var(--fs-xs); color: var(--warn); margin-top: 3px; }
.cmd-form details { margin-top: var(--s3); border: 1px solid var(--line); border-radius: var(--r-sm); padding: 4px 10px; }
.cmd-form details summary { cursor: pointer; font-size: var(--fs-xs); font-weight: 600; color: var(--muted); padding: 4px 0; }
.cmd-form details[open] summary { border-bottom: 1px solid var(--line); margin-bottom: 4px; }
.cmd-form .radios { display: flex; gap: var(--s3); flex-wrap: wrap; margin-top: var(--s2); }
.cmd-form .radios label { display: inline-flex; gap: 6px; align-items: center; margin: 0; color: var(--ink); font-weight: 500; }
.cmd-form .radios input { width: auto; display: inline; }
.chips-in { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; border: 1px solid var(--line-strong); border-radius: var(--r-sm); padding: 4px 6px; background: var(--bg); }
.chips-in .chip { font-family: var(--mono); }
.chips-in .chip button { font: inherit; background: none; border: 0; color: inherit; cursor: pointer; margin-left: 4px; padding: 0; }
.chips-in input { border: 0 !important; flex: 1; min-width: 140px; width: auto !important; display: inline-block !important; background: transparent; padding: 3px 4px; }
.form-banner { margin-top: var(--s3); padding: 8px 12px; border-radius: var(--r-sm); background: var(--warn-bg); color: var(--warn); font-size: var(--fs-xs); line-height: 1.5; }
.form-banner.bad { background: var(--bad-bg); color: var(--bad); }
.form-banner .btn { margin-left: 8px; }
.quick { display: flex; gap: var(--s2); flex-wrap: wrap; align-items: center; }
.editor textarea { min-height: 42vh; font-family: var(--mono); font-size: var(--fs-xs); width: 100%; box-sizing: border-box; }
.editor .acts { display: flex; gap: var(--s2); align-items: center; margin-top: var(--s2); flex-wrap: wrap; }
.flow-pick { width: auto !important; display: inline !important; margin: 0; }
.legend-list { display: grid; grid-template-columns: auto 1fr; gap: 6px 12px; font-size: var(--fs-sm); margin-top: var(--s3); }
.legend-list .chip { justify-self: start; }
.legend-list .term { font-family: var(--mono); font-size: var(--fs-xs); color: var(--muted); }
.m-toc { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: var(--s4); }
.m-toc a { font-size: var(--fs-xs); border: 1px solid var(--line); border-radius: var(--r-pill); padding: 3px 10px; color: var(--muted); text-decoration: none; }
.m-toc a:hover { background: var(--panel-2); color: var(--ink); }
.m-sec { max-width: 76ch; margin-bottom: var(--s6); scroll-margin-top: 64px; }
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
.hidden-by-search { display: none !important; }
.modal .field { margin-top: var(--s3); }
.modal .acts { display: flex; gap: var(--s2); justify-content: flex-end; margin-top: var(--s4); }
@media (max-width: 900px) {
  .app { grid-template-columns: 1fr; min-height: 0; }
  .side { display: flex; position: static; min-height: 0; flex-direction: row; flex-wrap: wrap; gap: 4px; padding: var(--s2) var(--s3); border-right: 0; border-bottom: 1px solid var(--line); }
  .side .brand, .side-footer { display: none; }
  .side .nav-item { width: auto; height: 30px; }
  .topbar .search { margin-left: 0; width: 100%; }
}
`;

/* ---------------------------------------------------------------- script */

const NEW_SCRIPT = String.raw`
/* ================================================================ newUI ==
   Everything above this line is wowUI's script, unchanged apart from four
   renames. Everything below composes it into one page. A function declared
   here replaces the one above for the whole script. */

/* ------------------------------------------------------------ vocabulary */

/* Shown → meant. The chip shows the plain word; the tooltip and the glossary
   carry the exact term the proof file uses, because that term is what the CLI
   prints and what grep finds. The data is never rewritten — only the label. */
var VOCAB = [
  { term: 'passed', shown: 'proved', kind: 'ok', meaning: 'every step passed, first time' },
  { term: 'proved', shown: 'proved', kind: 'ok', hide: true, meaning: 'every step passed, first time' },
  { term: 'pass**', alias: ['passed-with-issues'], shown: 'proved after a repair', kind: 'warn', meaning: 'passed, but only after the healer replaced a selector — check the heal' },
  { term: 'proved-?', alias: ['needs-review', 'proved-? · confirm below'], shown: 'needs your ruling', kind: 'violet', meaning: 'a step could not be sure; confirm proved or failed in the run detail' },
  /* Two verdict families over the machine statuses (src/ui/CLAUDE.md, "Two
     verdict families"): TEST FAILED — the subject missed the case's
     expectation (a contradicted assertion, or a control/content the case
     needed that the page never offered); SYSTEM ERROR — the harness or its
     models broke with no verdict delivered. The chip says the family; the
     tooltip keeps the mechanism, e.g. "test-failed (dead-end)". */
  { term: 'failed', shown: 'test failed', kind: 'bad', chip: 'escalated', family: 'test-failed', meaning: "a step's claim was false in the application — the subject missed the case's expectation" },
  { term: 'dead-end', shown: 'test failed', kind: 'bad', chip: 'escalated', family: 'test-failed (dead-end)', meaning: 'a control or content the case needed never resolved — the page did not offer what the case expected' },
  { term: 'error', alias: ['runtime error'], shown: 'system error', kind: 'warn', chip: 'feedback', family: 'system error', meaning: 'the harness, a model, a key or the environment broke — no verdict about the application was delivered' },
  { term: 'blocked', shown: 'blocked', kind: 'info', meaning: 'needed something not configured (a database, a key) — not run, not failed' },
  { term: 'quarantined', shown: 'quarantined', kind: 'faint', meaning: 'a known-flaky failure, recorded but not counted against the run' },
  { term: 'needs a human', alias: ['failStreak ≥ 3'], shown: 'streak — needs a human', kind: 'bad', meaning: 'failed three or more runs in a row; a person should look' },
  { term: 'cycle', shown: 'Run 1, 2, 3…', kind: 'plain', meaning: 'one execution of a flow; the rail shows the last three' },
  { term: 'authoring pass', alias: ['batch', 'pass', 'group'], shown: 'authoring pass', kind: 'plain', meaning: 'the one generation or catalog run that wrote these flows together' },
  { term: 'run key', shown: 'run key', kind: 'plain', meaning: 'the id a paused catalog run resumes under (<catalog>@<stamp>); shown beside Continue' },
  { term: 'ledger', shown: 'progress file', kind: 'plain', meaning: '<claims>.progress.json — what Continue testing reads' },
  { term: 'bundle', shown: 'proof file', kind: 'plain', meaning: 'the JSON a run leaves behind; "Open the raw proof" opens it' },
  { term: 'rung', shown: 'settled at', kind: 'plain', meaning: 'which strategy on the escalation ladder made the step pass: fast · case · dialog · cache · backend · heal' },
  { term: 'polarity', shown: 'checks that it does / checks that it doesn’t', kind: 'plain', meaning: 'whether the claim asserts presence (positive) or absence (negative)' },
  { term: 'failure family', shown: 'why it failed — family', kind: 'plain', meaning: 'the one-word class of the failure, with its gloss on the Error tab' },
  { term: 'vacuous', shown: 'vacuous', kind: 'plain', meaning: 'a case that passed without checking anything — re-author it' },
  { term: 'consent gate', alias: ['interstitial'], shown: 'waiting for the page', kind: 'plain', meaning: 'the agent is clearing a cookie or sign-in screen first' }
];

function vocabFor(label) {
  var key = String(label || '').toLowerCase();
  for (var i = 0; i < VOCAB.length; i += 1) {
    var v = VOCAB[i];
    if (v.term.toLowerCase() === key) return v;
    if (v.alias && v.alias.map(function (a) { return a.toLowerCase(); }).indexOf(key) !== -1) return v;
  }
  if (key.indexOf('proved-?') === 0) return vocabFor('proved-?');
  if (key.indexOf('proved ·') === 0 || key.indexOf('proved (') === 0) return null;
  return null;
}

function verdictChip(kind, label) {
  var v = vocabFor(label);
  if (!v || v.hide) return el('span', { class: 'chip ' + kind, text: label });
  /* A family entry also fixes the colour: test failed is red, system error
     is amber, whatever kind the base code passed for a bare status. */
  return el('span', { class: 'chip ' + (v.chip || kind), title: (v.family ? v.family + ' · ' : '') + v.term + ' — ' + v.meaning, text: v.shown });
}

function caseLabel(status) {
  var v = vocabFor(status === 'passed-with-issues' ? 'pass**' : status);
  return v && !v.hide ? v.shown : status;
}

function legendModal() {
  var overlay = el('div', { class: 'overlay-backdrop', onclick: function () { overlay.remove(); } });
  var box = el('div', { class: 'modal', role: 'dialog', 'aria-label': 'What the verdicts mean', style: 'max-width:640px;width:640px', onclick: function (e) { e.stopPropagation(); } });
  box.appendChild(el('div', { class: 'top' }, [
    el('h2', { text: 'What the words mean' }),
    el('button', { type: 'button', class: 'x', 'aria-label': 'Close', text: '✕', onclick: function () { overlay.remove(); } })
  ]));
  box.appendChild(el('div', { class: 'sub', text: 'The chip shows the plain word. The exact term is what the proof file and the CLI print, and what you would grep for.' }));
  var list = el('div', { class: 'legend-list' });
  VOCAB.filter(function (v) { return !v.hide; }).forEach(function (v) {
    list.appendChild(el('span', { class: 'chip ' + (v.chip || (v.kind === 'plain' ? 'plain' : v.kind)), text: v.shown }));
    list.appendChild(el('span', {}, [
      el('span', { class: 'term', text: (v.family ? v.family + ' · ' : '') + v.term + (v.alias ? ' · ' + v.alias.join(' · ') : '') }),
      el('div', { text: v.meaning })
    ]));
  });
  box.appendChild(list);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  trapFocus(box);
}

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

/* One idiom for anything destructive: the action is named in the button,
   Escape cancels, focus is trapped and first lands on Cancel. */
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
      el('button', { type: 'button', class: 'btn' + (spec.danger === false ? ' accent' : ' danger'), text: spec.button, onclick: function () { finish(true); } })
    ]));
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    trapFocus(box);
  });
}

/* A modal with one input — what the browser's own prompt() cannot be: styled,
   validated, or given a list to pick from. */
function promptModal(spec) {
  return new Promise(function (resolve) {
    var done = false;
    function finish(value) { if (done) return; done = true; overlay.remove(); resolve(value); }
    var overlay = el('div', { class: 'overlay-backdrop', onclick: function () { finish(null); } });
    var box = el('div', { class: 'modal', role: 'dialog', 'aria-label': spec.title, style: 'max-width:480px', onclick: function (e) { e.stopPropagation(); } });
    var listId = spec.options ? 'pm-list-' + Math.random().toString(36).slice(2) : null;
    var input = el('input', { type: 'text', value: spec.value || '', placeholder: spec.placeholder || '', list: listId,
      onkeydown: function (e) { if (e.key === 'Enter') { e.preventDefault(); submit(); } } });
    var err = el('div', { class: 'field-err' });
    function submit() {
      var value = input.value.trim();
      if (spec.validate) { var problem = spec.validate(value); if (problem) { err.textContent = problem; return; } }
      finish(value);
    }
    box.appendChild(el('div', { class: 'top' }, [
      el('b', { text: spec.title }),
      el('button', { type: 'button', class: 'x', 'aria-label': 'Cancel', text: '✕', onclick: function () { finish(null); } })
    ]));
    if (spec.text) box.appendChild(el('div', { class: 'why-line', text: spec.text }));
    box.appendChild(el('div', { class: 'field' }, [el('label', { text: spec.label }), input, err]));
    if (spec.options) box.appendChild(el('datalist', { id: listId }, spec.options.map(function (o) { return el('option', { value: o.value, label: o.label || null }); })));
    box.appendChild(el('div', { class: 'acts' }, [
      el('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: function () { finish(null); } }),
      el('button', { type: 'button', class: 'btn accent', text: spec.button, onclick: submit })
    ]));
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    trapFocus(box);
    input.focus();
    input.select();
  });
}

/* The destructive command ids, and what their confirmation says. Applied in
   post() so every button that reaches them — Forget, Forget everything, Clear
   history — gets the same dialog without each button knowing. */
var DESTRUCTIVE = {
  'cache-forget': function (values) {
    return values && values.all
      ? { title: 'Forget every healed selector?', text: 'The healer relearns each one the next time that selector fails — one model call per repair.', button: 'Forget ' + S.cache.length + ' healed selector(s)' }
      : { title: 'Forget this repair?', text: (values && values.key ? values.key + '\n' : '') + 'The healer relearns it the next time the selector fails.', button: 'Forget it' };
  },
  'history-clear': function () {
    return { title: 'Clear the run history?', text: 'Every proof file is deleted and every trend forgotten. Reports already written are kept. This cannot be undone.', button: 'Clear ' + S.proofs.length + ' run(s) — reports are kept' };
  }
};

function post(commandId, values, flowPath) {
  var gate = DESTRUCTIVE[commandId];
  var ask = gate ? confirmModal(gate(values)) : Promise.resolve(true);
  return ask.then(function (ok) {
    /* Cancelled: the callers chain toasts on success and nothing on failure,
       so a promise that never settles is the quiet outcome. Nothing waits. */
    if (!ok) return new Promise(function () {});
    return wowPost(commandId, values, flowPath).then(function (job) {
      goTo('now');
      return job;
    });
  });
}

function clearHistoryButton() {
  return el('button', {
    type: 'button', class: 'btn', disabled: S.proofs.length === 0, text: 'Clear history',
    title: 'Delete every proof file and forget every trend. Reports already written are kept.',
    onclick: function () { S.openTask = null; post('history-clear', {}, null); }
  });
}

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
    title: 'Rename this authoring pass', label: 'New title', value: group.origin, button: 'Rename',
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

/* ---------------------------------------------------------------- layout */

var SECTIONS = [
  { id: 'now', label: 'Now', count: function () { return runningJobs().length + attentionItems().length + resumableRuns().length; },
    alert: function () { return attentionItems().length > 0 || resumableRuns().length > 0; },
    icon: ['M12 6v6l4 2', 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z'] },
  { id: 'start', label: 'Start', icon: ['M12 5v14', 'M5 12h14'] },
  { id: 'runs', label: 'Runs', count: function () { return tasks().length; },
    icon: ['m3 17 2 2 4-4', 'm3 7 2 2 4-4', 'M13 6h8', 'M13 12h8', 'M13 18h8'] },
  { id: 'library', label: 'Library', count: function () { return S.reports.length + S.flows.length + S.cache.length; },
    icon: ['M4 4h11l5 5v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z', 'M14 4v6h6', 'M8 14h8', 'M8 18h5'] },
  { id: 'machinery', label: 'Machinery', count: function () { return keyCount(); }, alert: function () { return unkeyedRoles().length > 0; },
    icon: ['M15.5 7.5a3.5 3.5 0 1 1-4.6 3.32L4 18l-1.5-1.5L4 15l1.5 1.5L7 15l1.5 1.5 2.4-2.4A3.5 3.5 0 0 1 15.5 7.5z'] },
  { id: 'help', label: 'Help', icon: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3', 'M12 17h.01'] }
];

/* Old addresses still land: every hash either surface ever wrote. */
var LEGACY_HASH = {
  runs: 'runs', history: 'runs', healed: 'library', attention: 'now', reports: 'library', keys: 'machinery', repos: 'machinery',
  flows: 'library', cache: 'library', manual: 'help', panel: 'start'
};

function sectionOf(id) { return SECTIONS.filter(function (s) { return s.id === id; })[0] || null; }

function goTo(id) {
  if (!sectionOf(id)) return;
  S.section = id;
  if (location.hash !== '#' + id) history.replaceState(null, '', '#' + id);
  var node = byId('sec-' + id);
  if (node) node.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
  paintNav();
}

function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/* wowUI's views become anchors. A command id (the classic panel's hashes)
   opens that command's form. S.view stays 'runs' for good: several base
   functions ask "am I on the runs view?" before doing the right thing. */
function show(view) {
  S.view = 'runs';
  if (view === 'history') { S.density = 'every'; pref('density', 'every'); }
  if (S.meta && commandById(view)) { openLauncher('more', view); return; }
  var target = LEGACY_HASH[view] || (sectionOf(view) ? view : 'runs');
  render();
  goTo(target);
}

function commandById(id) {
  return (S.meta && S.meta.commands || []).filter(function (c) { return c.id === id; })[0] || null;
}

function pageHead(title, sub, action) {
  return el('div', { class: 'page-head sub-head' }, [
    el('div', {}, [el('h3', { text: title }), sub ? el('div', { class: 'sub', text: sub }) : null]),
    el('span', { class: 'spacer' }),
    action
  ]);
}

function secHead(title, sub, actions) {
  return el('div', { class: 'sec-head' }, [
    el('div', {}, [el('h2', { text: title }), sub ? el('div', { class: 'sub', text: sub }) : null]),
    el('span', { class: 'spacer' }),
    el('div', { class: 'acts' }, actions || [])
  ]);
}

function renderSidebar() {
  var side = byId('nav');
  clear(side);
  SECTIONS.forEach(function (s) {
    var count = s.count ? s.count() : null;
    side.appendChild(el('a', {
      href: '#' + s.id, class: 'nav-item' + (S.section === s.id ? ' active' : ''), 'data-sec': s.id,
      'aria-current': S.section === s.id ? 'true' : null,
      onclick: function (e) { e.preventDefault(); goTo(s.id); }
    }, [
      svg(s.icon),
      el('span', { class: 'txt', text: s.label }),
      count === null ? null : el('span', { class: 'nav-count' + (s.alert && s.alert() ? ' alert' : ''), text: String(count) })
    ]));
  });
  var foot = byId('foot');
  clear(foot);
  foot.appendChild(el('span', { class: S.online ? 'dot' : 'dot off' }));
  foot.appendChild(el('div', {}, [
    document.createTextNode(S.online ? 'panel connected · ' + location.port : 'panel unreachable · showing stale data'),
    el('span', { class: 'paths', text: S.meta ? tail(S.meta.paths.proofDir) : '' })
  ]));
  renderStatus();
}

function paintNav() {
  var items = document.querySelectorAll('#nav .nav-item');
  for (var i = 0; i < items.length; i += 1) {
    var on = items[i].getAttribute('data-sec') === S.section;
    items[i].classList.toggle('active', on);
    if (on) items[i].setAttribute('aria-current', 'true'); else items[i].removeAttribute('aria-current');
  }
}

function browserBusyJob() {
  return S.jobs.filter(function (j) { return j.status === 'running' && j.browser; })[0] || null;
}

function keyedRoles() {
  var roles = (S.keys && S.keys.roles && S.keys.roles.length) ? S.keys.roles : (S.meta ? S.meta.roles : []);
  return { keyed: roles.filter(function (r) { return r.keyed; }).length, total: roles.length };
}

/* The header answers what a person checks before pressing Start, and is
   repainted on every poll — the classic panel's chips were computed once. */
function renderStatus() {
  var box = byId('status');
  if (!box) return;
  clear(box);
  box.appendChild(el('span', { class: 'chip ' + (S.online ? 'ok' : 'warn'), text: S.online ? 'connected · ' + location.port : 'unreachable — showing stale data' }));
  var busy = browserBusyJob();
  box.appendChild(el('span', {
    class: 'chip ' + (busy ? 'warn' : 'plain'), title: busy ? busy.commandLine : 'no browser command is running',
    text: busy ? 'browser in use — one run at a time' : 'browser free'
  }));
  if (S.meta) box.appendChild(el('span', { class: 'chip plain mono', text: 'CDP ' + String(S.meta.cdpUrl || '').replace(/^https?:\/\//, '') }));
  var k = keyedRoles();
  if (k.total > 0) {
    box.appendChild(el('span', {
      class: 'chip jump ' + (k.keyed === k.total ? 'ok' : k.keyed === 0 ? 'bad' : 'warn'),
      title: 'model roles with a key — click for Models and keys', role: 'button', tabindex: '0',
      text: k.keyed + '/' + k.total + ' roles keyed',
      onclick: function () { goTo('machinery'); }
    }));
  }
  var cap = S.claude && S.claude.usageCap;
  if (cap && cap.enabled) {
    var worst = cap.worst;
    box.appendChild(el('span', {
      class: 'chip jump ' + (cap.tripped ? 'bad' : cap.nearing ? 'warn' : 'plain'), role: 'button', tabindex: '0',
      title: (worst ? worst.label + ' at ' + Math.round(worst.percent) + '%' : 'no window reported') + ' — click for the usage cap',
      text: cap.tripped ? 'cap tripped — runs held' : 'cap ' + (worst ? Math.round(worst.percent) + '% of ' + cap.capPercent + '%' : cap.capPercent + '%'),
      onclick: function () { goTo('machinery'); }
    }));
  }
}

function render() {
  S.bars = [];
  S.outLive = [];
  renderInto('now', nowSection);
  renderInto('start', startSection);
  renderInto('runs', runsSection);
  renderInto('library', librarySection);
  renderInto('machinery', machinerySection);
  if (!S.helpDrawn) { renderInto('help', helpSection); S.helpDrawn = true; }
  else refreshPathsTable();
  renderSidebar();
  applyQuery();
}

function renderInto(id, build) {
  var host = byId('sec-' + id);
  if (!host) return;
  clear(host);
  build(host);
}

/* ------------------------------------------------------------------- now */

function resumableRuns() {
  return (S.catalogRuns || []).filter(function (run) {
    return !run.running && (run.resumable || run.errors > 0 || run.failed > 0);
  });
}

/* Scans EVERY proof the index carries, not the first twelve. */
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

function warnIcon() {
  return svg(['M12 9v4', 'M12 17h.01', 'M10.36 3.6 2.32 17a2 2 0 0 0 1.71 3h15.94a2 2 0 0 0 1.71-3L13.64 3.6a2 2 0 0 0-3.28 0z']);
}

function caseIdsFor(run) {
  var ids = [];
  (S.groups || []).forEach(function (g) {
    if (run.runKey && g.runKey === run.runKey) (g.runs || []).forEach(function (r) { if (ids.indexOf(r.name) === -1) ids.push(r.name); });
  });
  return ids;
}

function nowSection(host) {
  var live = runningJobs();
  var resumable = resumableRuns();
  var items = attentionItems();
  var cap = S.claude && S.claude.usageCap;

  host.appendChild(secHead('Now', 'What is running, what stopped early, and what is waiting on you.', []));

  if (!S.online) {
    host.appendChild(el('div', { class: 'warn-banner', role: 'status' }, [
      warnIcon(),
      el('div', {}, [
        el('b', { text: 'The panel cannot reach its own server' }),
        el('span', { class: 'fix', text: 'What you see is the last data that arrived. Restart it with "wowlidator ui" and this page reconnects by itself.' }),
        el('div', { class: 'acts' }, [el('button', { type: 'button', class: 'btn', text: 'Try again', onclick: function () { refresh(); } })])
      ])
    ]));
  }

  if (cap && cap.tripped) {
    var t = cap.tripped;
    host.appendChild(el('div', { class: 'warn-banner', role: 'status' }, [
      warnIcon(),
      el('div', {}, [
        el('b', { text: 'Usage cap reached — runs are held' }),
        el('span', { class: 'fix', text: t.reason + (t.stoppedJobs && t.stoppedJobs.length ? ' Stopped: ' + t.stoppedJobs.join(', ') + '.' : '') + (t.resetsAt ? ' The window resets ' + untilTime(t.resetsAt) + '.' : '') }),
        el('div', { class: 'acts' }, [
          el('button', { type: 'button', class: 'btn accent', text: 'Reset hold', onclick: function () {
            api('/api/usage-cap/reset', { method: 'POST' }).then(function (view) {
              if (S.claude) S.claude.usageCap = view;
              toast(view.tripped ? 'still over the cap — raise it, turn it off, or wait' : 'hold reset');
              refresh();
            })['catch'](function (e) { toast(e.message); });
          } }),
          el('button', { type: 'button', class: 'btn', text: 'Raise or turn off the cap', onclick: function () { goTo('machinery'); } })
        ])
      ])
    ]));
  }

  if (live.length === 0 && resumable.length === 0 && items.length === 0 && S.online && !(cap && cap.tripped)) {
    host.appendChild(el('div', { class: 'oneline', text: 'Nothing running · nothing stopped early · nothing waiting on you' }));
    return;
  }

  if (live.length > 0) {
    var section = el('section', { class: 'group' });
    section.appendChild(el('div', { class: 'group-head' }, [
      el('span', { class: 'avatar', text: 'W' }),
      el('b', { text: 'Running now' }),
      el('span', { class: 'meta', text: live.length + ' job(s) started from this panel' })
    ]));
    var rows = el('div', { class: 'card rows' });
    live.forEach(function (job) {
      rows.appendChild(el('div', {
        class: 'row', role: 'button', tabindex: '0', 'aria-expanded': outIsOpen(job.id, job) ? 'true' : 'false',
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
        el('div', { class: 'actions', onclick: function (e) { e.stopPropagation(); } }, [
          el('button', { type: 'button', class: 'btn', text: 'Output', onclick: function () { toggleOut(job.id, job); } }),
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
    host.appendChild(section);
  }

  if (resumable.length > 0) {
    var shown = S.showAllResumable ? resumable : resumable.slice(0, 3);
    shown.forEach(function (run) { host.appendChild(resumableBanner(run)); });
    if (resumable.length > shown.length) {
      host.appendChild(el('div', { class: 'quiet', style: 'margin:-4px 0 12px' }, [
        el('button', { type: 'button', class: 'link', text: 'and ' + (resumable.length - shown.length) + ' more stopped catalog run(s) — show all',
          onclick: function () { S.showAllResumable = true; render(); } })
      ]));
    } else if (S.showAllResumable && resumable.length > 3) {
      host.appendChild(el('div', { class: 'quiet', style: 'margin:-4px 0 12px' }, [
        el('button', { type: 'button', class: 'link', text: 'show the latest three only', onclick: function () { S.showAllResumable = false; render(); } })
      ]));
    }
  }

  if (items.length > 0) {
    host.appendChild(el('div', { class: 'sub-head' }, [el('h3', { text: 'Needs a human' }), el('div', { class: 'sub', text: items.length + ' item(s), from every run on disk — a flow failing repeatedly, a run waiting for your ruling, a defect a run filed.' })]));
    items.forEach(function (item) {
      var acts = el('div', { class: 'note' });
      if (item.task) {
        var flowPath = flowPathFor(item.task.name, item.task.latest && item.task.latest.renamedFrom);
        acts.appendChild(el('button', {
          type: 'button', class: 'btn accent', disabled: !flowPath, text: 'Repair it',
          title: flowPath ? 'run it again, letting the generator rewrite the flow around the break' : 'the .flow.json is not visible from here',
          onclick: function () { startRun(item.task.key, { flow: flowPath, repair: true }); }
        }));
        acts.appendChild(el('button', {
          type: 'button', class: 'btn', text: 'Show the evidence',
          onclick: function () { openTaskAt(item.task); }
        }));
      } else if (item.ruling) {
        acts.appendChild(el('button', { type: 'button', class: 'btn accent', text: 'Open the run', onclick: function () { openCardAt(item.card); } }));
      } else {
        acts.appendChild(el('button', { type: 'button', class: 'btn', text: 'Open the run', onclick: function () { openCardAt(item.card); } }));
        acts.appendChild(el('button', { type: 'button', class: 'btn', text: 'Open the raw proof', onclick: function () { window.open('/view?path=' + encodeURIComponent(item.card.path), '_blank'); } }));
      }
      host.appendChild(el('div', { class: 'req-card' }, [
        el('span', { class: 'sev ' + item.severity, text: item.severity }),
        el('div', {}, [
          el('div', { class: 'what', text: item.title }),
          el('div', { class: 'mono', style: 'margin-top:4px', text: item.detail }),
          acts
        ])
      ]));
    });
  }
}

function resumableBanner(run) {
  var e = run.ended;
  var cause = e && e.cause;
  var head = run.resumable
    ? (/^paused\b/.test(cause || '') ? 'Paused — ' : 'Stopped — ') + run.title + ' has ' + run.left + ' of ' + run.summary.planned + ' case(s) still to run'
    : run.title + ' finished — ' + run.errors + ' could not run, ' + run.failed + ' failed';
  var acts = [];
  if (run.resumable) acts.push(el('button', { type: 'button', class: 'btn md accent', text: 'Continue testing (' + run.left + ' left)', title: 'mode: continue — the cases never reached, blocked or vacuous', onclick: function () { resumeCatalog(run.ledgerPath, 'continue'); } }));
  if (run.errors > 0) acts.push(el('button', { type: 'button', class: 'btn md', title: 'mode: errors — a case that could not run is the harness, not a verdict; those run again (plus anything unfinished).', text: 'Rerun all that could not run (' + run.errors + ')', onclick: function () { resumeCatalog(run.ledgerPath, 'errors'); } }));
  if (run.failed > 0) acts.push(el('button', { type: 'button', class: 'btn md', title: 'mode: failed — failed and stuck cases run again with autoheal on (plus anything unfinished).', text: 'Heal all failed (' + run.failed + ')', onclick: function () { resumeCatalog(run.ledgerPath, 'failed'); } }));
  acts.push(el('button', { type: 'button', class: 'btn', title: 'mode: vacuous — cases whose flow only asserted the sign-in and a URL are re-authored and run.', text: 'Re-author vacuous', onclick: function () { resumeCatalog(run.ledgerPath, 'vacuous'); } }));
  acts.push(el('button', {
    type: 'button', class: 'btn',
    title: 'mode: from — rerun the plan from one case onward in sheet order; earlier verdicts are kept, everything from that case runs again on the current config.',
    text: 'Resume from case…',
    onclick: function () {
      var ids = caseIdsFor(run);
      promptModal({
        title: 'Resume from which case?', label: 'Case id (plan order)', button: 'Resume from here',
        placeholder: ids[0] || 'PL_06_2',
        text: ids.length ? ids.length + ' case id(s) are known from this run’s proofs — start typing to pick one. That case and everything after it run again.' : 'That case and everything after it run again on the current config.',
        options: ids.map(function (id) { return { value: id }; }),
        validate: function (v) { return v === '' ? 'a case id is needed' : !/^[A-Za-z0-9._-]{1,80}$/.test(v) ? 'letters, digits, . _ - only' : null; }
      }).then(function (caseId) { if (caseId) resumeCatalog(run.ledgerPath, 'from', caseId); });
    }
  }));
  return el('div', { class: 'warn-banner', role: 'status' }, [
    warnIcon(),
    el('div', {}, [
      el('b', { text: head }),
      run.runKey ? el('span', { class: 'fix mono', title: 'run key — the id a resume continues under', text: 'run key: ' + run.runKey }) : null,
      el('span', { class: 'fix mono', text: 'cause: ' + (cause || (run.resumable ? 'the run never recorded how it ended' : 'the run completed')) }),
      el('span', { class: 'fix', text: 'Every button continues this catalog run under the same key: cases already tested are pulled in as finished tests unless the button says otherwise.' }),
      el('div', { class: 'acts' }, acts)
    ])
  ]);
}

function openTaskAt(task) {
  S.openTask = task.key;
  var runId = S.cycleOf[task.key] || task.latest.runId;
  S.cycleOf[task.key] = runId;
  render();
  goTo('runs');
  loadBundle(runId).then(render);
}

function openCardAt(card) {
  var task = tasks().filter(function (t) { return t.cycles.some(function (c) { return c.runId === card.runId; }); })[0];
  if (!task) { window.open('/view?path=' + encodeURIComponent(card.path), '_blank'); return; }
  S.cycleOf[task.key] = card.runId;
  openTaskAt(task);
}

/* ----------------------------------------------------------------- start */

var MORE_EXCLUDED = ['go', 'catalog-claims', 'catalog-run', 'run'];
var TEST_COMMANDS = ['generate', 'author', 'draft', 'crawl', 'watch'];

function openLauncher(mode, cmdId, prefill, lock) {
  wowOpenLauncher();
  var M = S.launcher;
  if (!M) return;
  M.more = { cmd: cmdId || null, prefill: prefill || {}, lock: lock || {}, lists: {}, goMode: 'describe' };
  if (mode) M.mode = mode;
  if (cmdId && !mode) M.mode = 'more';
  renderLauncher();
  goTo('start');
  var focus = byId('launcher') && byId('launcher').querySelector('input, textarea, select, button.cmd-item');
  if (focus) focus.focus();
}

function launcherBox(M) {
  if (!M.more) M.more = { cmd: null, prefill: {}, lock: {}, lists: {}, goMode: 'describe' };
  if (M.mode === 'more') return moreBox(M);
  var box = wowLauncherBox(M);
  var seg = box.querySelector('.segmented');
  if (seg) seg.appendChild(moreSegButton(M));
  return box;
}

function moreSegButton(M) {
  return el('button', {
    type: 'button', class: 'btn' + (M.mode === 'more' ? ' primary' : ''), text: 'More commands',
    onclick: function () { M.mode = 'more'; M.error = ''; renderLauncher(); }
  });
}

function startSection(host) {
  host.appendChild(secHead('Start', 'Say what must be true; wowlidator writes the test and runs it. Every action runs the CLI, and the command it builds is shown while it runs.', []));
  var launcherHost = el('div', { id: 'launcher' });
  host.appendChild(launcherHost);
  if (S.launcher) { launcherHost.appendChild(launcherBox(S.launcher)); return; }
  host.appendChild(el('div', { class: 'quick' }, [
    startButton('md'),
    el('span', { class: 'quiet', text: 'or straight to' }),
    el('button', { type: 'button', class: 'btn', text: 'Add Catalog', title: 'a document’s claims, ticked before anything costs tokens', onclick: function () { openLauncher('catalog'); } }),
    el('button', { type: 'button', class: 'btn', text: 'Describe', title: 'one sentence, or a URL to write tests for a page', onclick: function () { openLauncher('describe'); } }),
    el('button', { type: 'button', class: 'btn', text: 'Add Context', title: 'background a run may read; starts nothing', onclick: function () { openLauncher('context'); } }),
    el('button', { type: 'button', class: 'btn', text: 'More commands', title: 'every wowlidator command, as a form', onclick: function () { openLauncher('more'); } })
  ]));
}

function moreBox(M) {
  var box = el('section', { class: 'launcher wide', 'aria-labelledby': 'lt' });
  box.appendChild(el('div', { class: 'top' }, [
    el('h2', { id: 'lt', text: 'Start verification' }),
    el('button', { type: 'button', class: 'x', 'aria-label': 'Close', text: '✕', disabled: M.busy, onclick: closeLauncher })
  ]));
  box.appendChild(el('div', { class: 'sub', text: 'Every command the CLI has, as a form rendered from the same declaration the server validates against — a flag offered here is a flag it accepts.' }));
  var seg = el('div', { class: 'segmented' });
  [['context', 'Add Context'], ['catalog', 'Add Catalog'], ['describe', 'Describe']].forEach(function (pair) {
    seg.appendChild(el('button', { type: 'button', class: 'btn', text: pair[1], onclick: function () { M.mode = pair[0]; M.error = ''; renderLauncher(); } }));
  });
  seg.appendChild(moreSegButton(M));
  box.appendChild(seg);

  var spec = M.more.cmd ? commandById(M.more.cmd) : null;
  if (!spec) { box.appendChild(commandList(M)); return box; }

  box.appendChild(el('div', { class: 'toolbar' }, [
    el('button', { type: 'button', class: 'link', text: '‹ all commands', onclick: function () { M.more.cmd = null; M.more.lock = {}; M.more.prefill = {}; renderLauncher(); } }),
    el('span', { class: 'cap', text: spec.browser ? 'uses the browser' : 'no browser' }),
    spec.roles && spec.roles.length ? el('span', { class: 'cap', text: 'model: ' + spec.roles.join(', ') }) : null
  ]));
  box.appendChild(cmdForm(spec, M));
  return box;
}

function commandList(M) {
  var all = (S.meta && S.meta.commands || []).filter(function (c) { return MORE_EXCLUDED.indexOf(c.id) === -1; });
  var wrap = el('div', {});
  [['Test', function (c) { return TEST_COMMANDS.indexOf(c.id) !== -1; }],
   ['Maintain', function (c) { return TEST_COMMANDS.indexOf(c.id) === -1; }]].forEach(function (pair) {
    var list = all.filter(pair[1]);
    if (list.length === 0) return;
    wrap.appendChild(el('div', { class: 'cap', style: 'margin-top:12px', text: pair[0] }));
    var grid = el('div', { class: 'cmd-list' });
    list.forEach(function (c) {
      grid.appendChild(el('button', { type: 'button', class: 'cmd-item', onclick: function () { M.more.cmd = c.id; renderLauncher(); } }, [
        el('b', { text: c.title }),
        el('span', { text: c.blurb }),
        el('i', { class: 'tag', text: (c.browser ? 'browser' : 'no browser') + (c.longRunning ? ' · keeps running' : '') })
      ]));
    });
    wrap.appendChild(grid);
  });
  wrap.appendChild(el('div', { class: 'quiet', style: 'margin-top:12px', text: 'Running a flow that already exists is an action on that flow: Library › Flows › Run…, or Run again on any row above. Proving a catalog and describing a test are the other three tabs.' }));
  return wrap;
}

/* ---- the command form, rendered from the spec (docs/one-page-ui-spec.md §4.1) ---- */

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
  'no-agent-capture': 'Let the agent capture the page first'
};
var ADV_GROUPS = [
  ['Recording', ['video', 'screenshots', 'capture-delay', 'step-delay']],
  ['Behaviour', ['no-heal', 'no-agent', 'no-agent-early-stop', 'no-reconstruct', 'no-network', 'no-history', 'quarantine-flaky', 'update-baselines', 'no-author-review', 'no-agent-capture']],
  ['Chrome', ['headless', 'no-ensure-chrome', 'stop-chrome', 'wait-for', 'cdp']],
  ['Output', ['report', 'no-report', 'junit', 'ctrf', 'suite', 'flow', 'catalog-out', 'claims-out', 'context-out', 'cache', 'out']]
];
var VERB = { doctor: 'Run the doctor', 'context-list': 'List saved repositories', 'cache-list': 'List healed selectors', 'history-clear': 'Clear run history', 'context-build': 'Build the index', 'context-show': 'Show the index', 'context-add': 'Scan and save', 'cache-forget': 'Forget', watch: 'Start watching' };
var GO_MODES = [
  ['url', 'A page URL', 'http://localhost:3000/orders'],
  ['flow', 'A flow file', 'examples/login.flow.json'],
  ['describe', 'A description', 'check pagination is disabled when there is a single page']
];

function firstSentence(text) {
  var m = /^(.*?[.!?])(\s|$)/.exec(text || '');
  return m ? m[1] : (text || '');
}

function fieldLabel(field) {
  return field.label + (field.required ? ' *' : '');
}

function cmdForm(spec, M) {
  var form = el('form', { class: 'cmd-form', onsubmit: function (e) { e.preventDefault(); submitCmd(spec, M, form); } });
  var byName = {};
  spec.fields.forEach(function (f) { byName[f.name] = f; });
  var gates = {};

  var missing = (spec.roles || []).map(function (role) {
    return (S.meta.roles || []).filter(function (r) { return r.role === role; })[0];
  }).filter(function (r) { return r && !r.keyed; });
  if (missing.length > 0) {
    form.appendChild(el('div', { class: 'form-banner' }, [
      el('b', { text: 'Needs a model key. ' }),
      'The ' + missing.map(function (r) { return r.role; }).join(' and ') + ' role has no key — set ' + missing.map(function (r) { return r.envKey; }).join(' and ') + ' in .env, then re-read it under Machinery. ',
      el('a', { href: missing[0].consoleUrl, target: '_blank', rel: 'noreferrer', text: 'Get one' })
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

  if (spec.id === 'go') form.appendChild(goModeRadios(M, form));

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
  if (spec.id === 'go') applyGoMode(form, M);

  var label = spec.longRunning ? 'Start watching' : (VERB[spec.id] || spec.title);
  var err = el('div', { class: 'form-banner bad', style: 'display:none' });
  form.appendChild(err);
  form.appendChild(el('div', { class: 'acts', style: 'margin-top:14px' }, [
    el('button', { type: 'button', class: 'btn', text: 'Close', disabled: M.busy, onclick: closeLauncher }),
    el('button', { type: 'submit', class: 'btn primary', disabled: M.busy || !!busy, title: busy ? 'the browser is in use — stop the running job first' : null, text: label })
  ]));
  form.appendChild(el('datalist', { id: 'flowlist' }, S.flows.map(function (f) { return el('option', { value: f.path }); })));
  if (spec.fields.length === 0) form.insertBefore(el('div', { class: 'quiet', style: 'margin-top:8px', text: spec.blurb }), form.firstChild);
  return form;
}

function goModeRadios(M, form) {
  var radios = el('div', { class: 'radios', role: 'radiogroup', 'aria-label': 'What is the box below?' });
  GO_MODES.forEach(function (mode) {
    var input = el('input', { type: 'radio', name: 'go-mode', value: mode[0], checked: M.more.goMode === mode[0],
      onchange: function () { M.more.goMode = mode[0]; applyGoMode(form, M); } });
    radios.appendChild(el('label', {}, [input, el('span', { text: mode[1] })]));
  });
  return el('div', { class: 'field' }, [el('label', { text: 'What are you giving it?' }), radios]);
}

function applyGoMode(form, M) {
  var mode = GO_MODES.filter(function (m) { return m[0] === M.more.goMode; })[0];
  var target = form.querySelector('[data-field="target"]');
  if (target && mode) target.placeholder = mode[2];
  var urlField = form.querySelector('[data-wrap="url"]');
  if (urlField) urlField.style.display = M.more.goMode === 'describe' ? '' : 'none';
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
  var prefill = M.more.prefill;
  var locked = !!M.more.lock[field.name];
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
  var list = M.more.lists[field.name] = M.more.lists[field.name] || (Array.isArray(value) ? value.slice() : value ? [String(value)] : []);
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

function submitCmd(spec, M, form) {
  var values = {};
  var problems = [];
  spec.fields.forEach(function (field) {
    var wrap = form.querySelector('[data-wrap="' + field.name + '"]');
    if (wrap) { wrap.classList.remove('err'); var fe = wrap.querySelector('.field-err'); if (fe) fe.textContent = ''; }
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
      var list = M.more.lists[field.name] || [];
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
  if (problems.length) { problems.forEach(function (p) { markField(form, p[0], p[1]); }); return; }

  var banner = form.querySelector('.form-banner.bad');
  banner.style.display = 'none';
  M.busy = true;
  var flowPath = spec.id === 'run' && values.flow && values.flow.length === 1 ? values.flow[0] : null;
  wowPost(spec.id, values, flowPath).then(function () {
    M.busy = false;
    closeLauncher();
    goTo('now');
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

function openRunForm(flowPaths) {
  openLauncher('more', 'run', { flow: flowPaths }, { flow: true });
}

/* ------------------------------------------------------------------ runs */

function pref(key, value) {
  try {
    if (value === undefined) { var raw = localStorage.getItem('newui.' + key); return raw === null ? undefined : JSON.parse(raw); }
    localStorage.setItem('newui.' + key, JSON.stringify(value));
  } catch (e) { /* private window, blocked storage: the default stands */ }
  return value;
}

function matchesFilter(card) {
  if (S.filter === 'passed') return isPassing(card.status);
  if (S.filter === 'failed') return card.status === 'failed';
  if (S.filter === 'healed') return card.jitHeals > 0;
  return true;
}

function sortTasks(list) {
  if (S.sort !== 'name') return list;
  return list.slice().sort(function (a, b) { return a.name.localeCompare(b.name, undefined, { numeric: true }); });
}

/* Every number says what it is a number of. */
function statsStrip() {
  var startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  var today = S.proofs.filter(function (p) { return new Date(p.finishedAt || p.startedAt).getTime() >= startOfDay.getTime(); });
  var recent = S.proofs.slice(0, 7);
  var passed = recent.filter(function (p) { return isPassing(p.status); }).length;
  var live = runningJobs();
  var streaks = tasks().filter(function (t) { return failStreak(t) >= 3; }).length;
  var rulings = S.proofs.filter(function (p) { return p.status === 'needs-review' && !p.review; }).length;
  return el('div', { class: 'stats' }, [
    el('div', { class: 'stat' }, [
      el('div', { class: 'k', text: 'Runs today' }),
      el('div', { class: 'v' }, [document.createTextNode(String(today.length)), el('small', { text: 'of ' + S.proofs.length + ' on disk' })]),
      el('div', { class: 'n', text: S.proofs[0] ? 'latest ' + shortTime(S.proofs[0].finishedAt) : 'nothing yet' })
    ]),
    el('div', { class: 'stat' }, [
      el('div', { class: 'k', text: 'Proved' }),
      el('div', { class: 'v', style: 'color:var(--ok)' }, [document.createTextNode(String(passed)), el('small', { text: 'of the last ' + recent.length })]),
      el('div', { class: 'n', text: recent.length ? Math.round((passed / recent.length) * 100) + '% of the last ' + recent.length + ' runs' : 'no runs yet' })
    ]),
    el('div', { class: 'stat' }, [
      el('div', { class: 'k', text: 'Running' }),
      el('div', { class: 'v', style: 'color:var(--info)', text: String(live.length) }),
      el('div', { class: 'n', text: live[0] ? live[0].title + ' · in flight' : 'nothing running' })
    ]),
    el('div', { class: 'stat' }, [
      el('div', { class: 'k', text: 'Needs a human' }),
      el('div', { class: 'v', style: streaks + rulings > 0 ? 'color:var(--warn)' : null, text: String(streaks + rulings) }),
      el('div', { class: 'n', text: streaks + ' streak(s) · ' + rulings + ' ruling(s) waiting' })
    ])
  ]);
}

function runsSection(host) {
  var counts = {
    all: S.proofs.length,
    passed: S.proofs.filter(function (p) { return isPassing(p.status); }).length,
    failed: S.proofs.filter(function (p) { return p.status === 'failed'; }).length,
    healed: S.proofs.filter(function (p) { return p.jitHeals > 0; }).length
  };
  host.appendChild(secHead('Runs and proof',
    'Every flow wowlidator has run, with its latest verdict and the evidence behind each step. The rail on the left is the last three runs.',
    [
      el('button', { type: 'button', class: 'btn', text: 'What the words mean', title: 'the verdict chips, and the exact term behind each', onclick: legendModal }),
      clearHistoryButton()
    ]));
  host.appendChild(statsStrip());

  var bar = el('div', { class: 'toolbar' });
  bar.appendChild(el('span', { class: 'cap', text: 'Show' }));
  [['all', 'All'], ['passed', 'Passed'], ['failed', 'Failed'], ['healed', 'Needed a repair']].forEach(function (pair) {
    bar.appendChild(el('button', { type: 'button', class: 'f-pill' + (S.filter === pair[0] ? ' on' : ''), text: pair[1] + ' · ' + counts[pair[0]],
      onclick: function () { S.filter = pair[0]; render(); } }));
  });
  bar.appendChild(el('span', { class: 'gap' }));
  bar.appendChild(el('span', { class: 'cap', text: 'As' }));
  [['flow', 'By flow'], ['every', 'Every run']].forEach(function (pair) {
    bar.appendChild(el('button', { type: 'button', class: 'f-pill' + (S.density === pair[0] ? ' on' : ''), text: pair[1],
      title: pair[0] === 'flow' ? 'one row per flow, its latest verdict, the run timeline inside' : 'one row per run, newest first',
      onclick: function () { S.density = pair[0]; pref('density', pair[0]); render(); } }));
  });
  bar.appendChild(el('span', { class: 'gap' }));
  bar.appendChild(el('span', { class: 'cap', text: 'Sort' }));
  [['latest', 'Latest'], ['name', 'Name']].forEach(function (pair) {
    bar.appendChild(el('button', { type: 'button', class: 'f-pill' + (S.sort === pair[0] ? ' on' : ''), text: pair[1],
      onclick: function () { S.sort = pair[0]; pref('sort', pair[0]); render(); } }));
  });
  host.appendChild(bar);

  if (S.density === 'every') { everyRunList(host); }
  else { byFlowList(host); }

  if (S.filter === 'all' || S.filter === 'failed') renderFailedRuns(host);
}

function byFlowList(host) {
  var all = groups();
  if (all.length === 0) {
    host.appendChild(el('div', { class: 'box' }, [
      el('span', { class: 'mark', 'aria-hidden': 'true' }, [el('i'), el('i'), el('i')]),
      el('div', { class: 'big', text: 'Nothing has been proved yet' }),
      el('div', { class: 'why', text: 'Run a flow and its proof lands here — every step, the screenshot taken at it, the calls the page made, and the repair the healer proposed if it needed one.' }),
      startButton('md')
    ]));
    return;
  }
  var total = 0, shown = 0;
  var filtered = all.map(function (group) {
    var keep = sortTasks(group.tasks.filter(function (t) { total += 1; return matchesFilter(t.latest); }));
    shown += keep.length;
    var copy = {};
    Object.keys(group).forEach(function (k) { copy[k] = group[k]; });
    copy.tasks = keep;
    copy.hiddenCount = group.tasks.length - keep.length;
    return copy;
  });
  if (S.filter !== 'all' || S.sort !== 'latest') host.appendChild(el('div', { class: 'quiet', style: 'margin-bottom:8px', text: shown + ' of ' + total + ' flow(s) shown' + (S.sort === 'name' ? ' · sorted by name' : '') }));
  if (shown === 0) {
    host.appendChild(el('div', { class: 'box' }, [el('div', { class: 'big', text: 'No flows match' }), el('div', { class: 'why', text: 'Try another filter.' })]));
    return;
  }
  filtered.forEach(function (group) {
    if (group.tasks.length === 0) return;
    host.appendChild(renderGroup(group));
    if (group.hiddenCount > 0) host.appendChild(el('div', { class: 'quiet', style: 'margin:-14px 0 16px 6px', text: group.hiddenCount + ' flow(s) in this pass hidden by the filter' }));
  });
}

function everyRunList(host) {
  var shown = S.proofs.filter(matchesFilter);
  if (S.sort === 'name') shown = shown.slice().sort(function (a, b) { return a.name.localeCompare(b.name, undefined, { numeric: true }); });
  if (shown.length === 0) {
    host.appendChild(el('div', { class: 'box' }, [
      el('div', { class: 'big', text: 'No runs match' }),
      el('div', { class: 'why', text: S.proofs.length === 0 ? 'Proof files land in the proof directory as soon as anything runs.' : 'Try another filter.' })
    ]));
    return;
  }
  host.appendChild(el('div', { class: 'quiet', style: 'margin-bottom:8px', text: shown.length + ' of ' + S.proofs.length + ' run(s), newest first' }));
  var kept = {};
  shown.forEach(function (p) { kept[p.runId] = true; });
  var list = (S.groups || []).map(function (group) {
    return { group: group, runs: group.runs.filter(function (r) { return kept[r.runId]; }) };
  }).filter(function (entry) { return entry.runs.length > 0; });
  if (list.length === 0) list = [{ group: null, runs: shown }];
  list.forEach(function (entry) {
    if (entry.group) host.appendChild(groupHeader(entry.group, entry.runs));
    if (entry.group && S.shutGroups[entry.group.id]) return;
    var rows = el('div', { class: 'card rows' + (entry.group ? ' in-group' : '') });
    var scenarios = entry.group ? entry.group.scenarios || [] : [];
    var flat = scenarios.length <= 1 && (scenarios.length === 0 || scenarios[0].title === 'ungrouped');
    if (flat) {
      entry.runs.forEach(function (card) { appendHistoryRow(rows, card); });
    } else {
      scenarios.forEach(function (sc) {
        var inner = sc.runs.filter(function (r) { return kept[r.runId]; });
        if (inner.length === 0) return;
        if (!scenarioHead(sc.id, sc.title, inner, rows)) return;
        inner.forEach(function (card) { appendHistoryRow(rows, card); });
      });
    }
    host.appendChild(rows);
  });
}

/* --------------------------------------------------------------- library */

function libCard(id, title, count, sub, build, actions) {
  var open = S.cards[id] !== false;
  var card = el('section', { class: 'lib-card', id: 'lib-' + id });
  function toggle() { S.cards[id] = !open; pref('cards', S.cards); render(); }
  var head = el('div', { class: 'lib-head', role: 'button', tabindex: '0', 'aria-expanded': open ? 'true' : 'false',
    onclick: toggle, onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } } }, [
    el('span', { class: 'twist', text: open ? '▾' : '▸' }),
    el('b', { text: title }),
    el('span', { class: 'nav-count', text: String(count) }),
    el('span', { class: 'sub', text: sub }),
    el('div', { class: 'acts', onclick: function (e) { e.stopPropagation(); }, onkeydown: function (e) { e.stopPropagation(); } }, actions || [])
  ]);
  card.appendChild(head);
  if (open) {
    var body = el('div', { class: 'lib-body' });
    build(body, head.querySelector('.acts'));
    card.appendChild(body);
  }
  return card;
}

/* wowUI's page renderers draw their own head with the page's action buttons
   in it. Inside a card the head is the card's; the actions are lifted up. */
function liftHead(body, acts) {
  var head = body.querySelector('.page-head');
  if (!head) return;
  var action = head.lastElementChild;
  if (action && !action.classList.contains('spacer') && action.tagName !== 'H3') acts.appendChild(action);
  head.remove();
}

function librarySection(host) {
  host.appendChild(secHead('Library', 'Reports, flows and healed selectors — everything a run wrote that you might open, edit or forget.', []));
  host.appendChild(libCard('reports', 'Reports', S.reports.length, 'every HTML report rendered so far, newest first', function (body, acts) {
    var tmp = el('div', {});
    renderReports(tmp);
    liftHead(tmp, acts);
    body.appendChild(tmp);
  }));
  host.appendChild(libCard('flows', 'Flows', S.flows.length, 'every .flow.json wowlidator can see — run one, run several as a suite, edit in place', flowsCard, [
    el('button', { type: 'button', class: 'btn accent', text: pickedFlows().length ? 'Run ' + pickedFlows().length + ' selected…' : 'Run selected…', disabled: pickedFlows().length === 0,
      title: 'the selected flows as one suite — the browser is held once', onclick: function () { openRunForm(pickedFlows()); } })
  ]));
  host.appendChild(libCard('healed', 'Healed selectors', S.cache.length, 'every repair the healer has cached, and what it would cost to learn again', function (body, acts) {
    var tmp = el('div', {});
    renderHealed(tmp);
    liftHead(tmp, acts);
    body.appendChild(tmp);
  }));
}

function pickedFlows() { return Object.keys(S.pick).filter(function (p) { return S.pick[p]; }); }

function flowsCard(body) {
  if (S.flows.length === 0) {
    body.appendChild(el('div', { class: 'box', style: 'margin-top:14px' }, [
      el('div', { class: 'big', text: 'No .flow.json files found yet' }),
      el('div', { class: 'why', text: 'wowlidator writes them. Generate tests from a page, or author one from a sentence.' }),
      el('div', { class: 'quick', style: 'justify-content:center' }, [
        el('button', { type: 'button', class: 'btn accent', text: 'Generate tests', onclick: function () { openLauncher('more', 'generate'); } }),
        el('button', { type: 'button', class: 'btn', text: 'Author one test', onclick: function () { openLauncher('more', 'author'); } })
      ])
    ]));
    return;
  }
  var table = el('table', { class: 'tbl', style: 'margin-top:12px' });
  table.appendChild(el('thead', {}, [el('tr', {}, [
    el('th', { style: 'width:32px' }), el('th', { text: 'Flow' }), el('th', { text: 'Steps', style: 'width:70px' }), el('th', { text: 'Modified', style: 'width:150px' }), el('th', { style: 'width:220px' })
  ])]));
  var tbody = el('tbody', {});
  S.flows.forEach(function (flow) {
    var editing = S.editing && S.editing.path === flow.path;
    var pick = el('input', { type: 'checkbox', class: 'flow-pick', 'aria-label': 'select ' + flow.name, checked: !!S.pick[flow.path],
      onchange: function () { S.pick[flow.path] = pick.checked; render(); } });
    tbody.appendChild(el('tr', {}, [
      el('td', {}, [pick]),
      el('td', {}, [
        el('div', { text: flow.name }),
        el('div', { class: 'mono muted2', style: 'font-size:var(--fs-xs)', text: flow.path }),
        !flow.valid ? el('div', { class: 'mono', style: 'color:var(--bad);font-size:var(--fs-xs)', text: 'not a valid flow — needs "name" and "steps"' }) : null,
      ]),
      el('td', { class: 'mono', text: flow.steps ? String(flow.steps) : '—' }),
      el('td', { class: 'mono', text: flow.modified ? flow.modified.slice(0, 16).replace('T', ' ') : '' }),
      el('td', { class: 'col-r' }, [
        el('button', { type: 'button', class: 'link', text: 'Run…', title: 'run this flow, with the repair options', onclick: function () { openRunForm([flow.path]); } }),
        document.createTextNode('  '),
        el('button', { type: 'button', class: 'link', text: editing ? 'Close editor' : 'Edit', onclick: function () { editing ? closeEditor() : openEditor(flow.path); } })
      ])
    ]));
    if (editing) {
      var cell = el('td', { colspan: '5', style: 'background:var(--panel-2)' });
      cell.appendChild(editorBox());
      tbody.appendChild(el('tr', {}, [cell]));
    }
  });
  table.appendChild(tbody);
  body.appendChild(el('div', { style: 'overflow-x:auto' }, [table]));
}

function openEditor(path) {
  if (S.editing && S.editing.dirty && S.editing.path !== path) {
    confirmModal({ title: 'Discard unsaved changes?', text: S.editing.path + ' has unsaved edits.', button: 'Discard and open the other' }).then(function (ok) { if (ok) { S.editing = null; openEditor(path); } });
    return;
  }
  S.editing = { path: path, content: null, dirty: false, status: '' };
  render();
  api('/api/file?path=' + encodeURIComponent(path)).then(function (body) {
    if (!S.editing || S.editing.path !== path) return;
    S.editing.content = body.content;
    render();
  })['catch'](function (error) { if (S.editing) { S.editing.status = 'Could not open: ' + error.message; S.editing.content = ''; render(); } });
}

function closeEditor() {
  if (S.editing && S.editing.dirty) {
    confirmModal({ title: 'Discard unsaved changes?', text: S.editing.path, button: 'Discard' }).then(function (ok) { if (ok) { S.editing = null; render(); } });
    return;
  }
  S.editing = null;
  render();
}

function editorBox() {
  var E = S.editing;
  var wrap = el('div', { class: 'editor' });
  if (E.content === null) { wrap.appendChild(el('div', { class: 'quiet', text: 'opening…' })); return wrap; }
  var dirtyTag = el('span', { class: 'tag', style: 'color:var(--warn);display:' + (E.dirty ? '' : 'none'), text: 'unsaved' });
  var area = el('textarea', { spellcheck: 'false', 'aria-label': 'flow file', oninput: function () { E.content = area.value; E.dirty = true; dirtyTag.style.display = ''; } });
  area.value = E.content;
  var status = el('span', { class: 'quiet', text: E.status });
  function save() {
    return api('/api/file?path=' + encodeURIComponent(E.path), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: area.value }) })
      .then(function () { E.dirty = false; dirtyTag.style.display = 'none'; E.status = 'saved'; status.style.color = 'var(--ok)'; status.textContent = 'saved'; refresh(); })
      ['catch'](function (error) { E.status = error.message; status.style.color = 'var(--bad)'; status.textContent = error.message; throw error; });
  }
  wrap.appendChild(area);
  wrap.appendChild(el('div', { class: 'acts' }, [
    el('button', { type: 'button', class: 'btn accent', text: 'Save', onclick: function () { save()['catch'](function () {}); } }),
    el('button', { type: 'button', class: 'btn', text: 'Save and run…', onclick: function () { save().then(function () { openRunForm([E.path]); })['catch'](function () {}); } }),
    el('button', { type: 'button', class: 'btn', text: 'Close', onclick: closeEditor }),
    dirtyTag,
    status
  ]));
  return wrap;
}

/* ------------------------------------------------------------- machinery */

function machinerySection(host) {
  host.appendChild(secHead('Machinery', 'Models, keys, the Claude session, the database, and the repositories a run can ground itself in. Every control here is about the runs this panel starts next; nothing in flight is re-pointed.', []));
  host.appendChild(libCard('keys', 'Models and keys', keyedRoles().keyed + '/' + keyedRoles().total, 'which model each role calls, which key it starts on, and whether that is ready right now', function (body, acts) {
    var tmp = el('div', {});
    renderKeys(tmp);
    var head = tmp.querySelector('.page-head');
    if (head) {
      var action = head.lastElementChild;
      if (action && action.tagName === 'DIV') { while (action.firstChild) acts.appendChild(action.firstChild); }
      head.remove();
    }
    body.appendChild(tmp);
  }));
  host.appendChild(libCard('repos', 'Repositories', S.repos.length, 'code wowlidator has scanned and remembers — Machinery › Repositories on the old page', function (body, acts) {
    var tmp = el('div', {});
    renderRepos(tmp);
    liftHead(tmp, acts);
    body.appendChild(tmp);
  }));
}

/* ------------------------------------------------------------------ help */

var MANUAL_TAGS = ['h3', 'h4', 'p', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'code', 'b', 'strong', 'em', 'i', 'span', 'ul', 'ol', 'li', 'pre', 'br', 'small'];

function manualNode(node) {
  if (typeof node === 'string') return document.createTextNode(node);
  var tag = MANUAL_TAGS.indexOf(node.t) === -1 ? 'span' : node.t;
  return el(tag, { class: node.c || null }, node.k.map(manualNode));
}

function helpSection(host) {
  host.appendChild(secHead('Help', 'What all of this is and how to use it — the manual, the words on the chips, and where everything lands on this machine.', []));
  var toc = el('nav', { class: 'm-toc', 'aria-label': 'Manual sections' });
  MANUAL_DATA.forEach(function (sec) { toc.appendChild(el('a', { href: '#m-' + sec.id, text: sec.title, onclick: function (e) { e.preventDefault(); byId('m-' + sec.id).scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' }); } })); });
  toc.appendChild(el('a', { href: '#m-glossary', text: 'What the words mean', onclick: function (e) { e.preventDefault(); byId('m-glossary').scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' }); } }));
  toc.appendChild(el('a', { href: '#m-paths', text: 'Paths on this machine', onclick: function (e) { e.preventDefault(); byId('m-paths').scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' }); } }));
  host.appendChild(toc);

  host.appendChild(el('section', { class: 'm-sec', id: 'm-page' }, [
    el('h3', { text: 'This page' }),
    el('p', { text: 'One page, six sections. Now is what is running and what waits on you. Start is where anything begins — a catalog’s claims, a sentence, or any CLI command as a form. Runs and proof is every flow with its latest verdict and the evidence under it; filter, sort, or switch to one row per run. Library holds reports, flow files (editable in place) and healed selectors. Machinery is models, keys, the Claude session, the database and saved repositories. The chips at the top are refreshed on every poll, so what they say is what the next run gets.' }),
    el('p', {}, [document.createTextNode('The older two surfaces are still served: '), el('code', { text: '/' }), document.createTextNode(' (the command panel) and '), el('code', { text: '/wow' }), document.createTextNode(' (wowUI). Their addresses land here: a command’s hash opens its form, '), el('code', { text: '#history' }), document.createTextNode(' is Runs in the every-run density, '), el('code', { text: '#keys' }), document.createTextNode(' is Machinery.')])
  ]));

  MANUAL_DATA.forEach(function (sec) {
    var section = el('section', { class: 'm-sec', id: 'm-' + sec.id });
    section.appendChild(el('h3', { text: sec.title }));
    sec.body.forEach(function (node) { section.appendChild(manualNode(node)); });
    host.appendChild(section);
  });

  var glossary = el('section', { class: 'm-sec', id: 'm-glossary' });
  glossary.appendChild(el('h3', { text: 'What the words mean' }));
  glossary.appendChild(el('p', { text: 'The chip shows the plain word; the exact term is what the proof file and the CLI print. Both are on screen: hover a chip for the term, or read them here.' }));
  var list = el('div', { class: 'legend-list' });
  VOCAB.filter(function (v) { return !v.hide; }).forEach(function (v) {
    list.appendChild(el('span', { class: 'chip ' + (v.chip || (v.kind === 'plain' ? 'plain' : v.kind)), text: v.shown }));
    list.appendChild(el('span', {}, [el('span', { class: 'term', text: (v.family ? v.family + ' · ' : '') + v.term + (v.alias ? ' · ' + v.alias.join(' · ') : '') }), el('div', { text: v.meaning })]));
  });
  glossary.appendChild(list);
  host.appendChild(glossary);

  var paths = el('section', { class: 'm-sec', id: 'm-paths' });
  paths.appendChild(el('h3', { text: 'Paths on this machine' }));
  paths.appendChild(el('div', { id: 'paths-table' }));
  host.appendChild(paths);
  refreshPathsTable();
}

function refreshPathsTable() {
  var box = byId('paths-table');
  if (!box) return;
  clear(box);
  if (!S.meta) { box.appendChild(el('p', { class: 'quiet', text: 'waiting for the panel…' })); return; }
  var rows = [['here', S.meta.cwd], ['reports', S.meta.paths.reportDir], ['proofs', S.meta.paths.proofDir], ['cache', S.meta.paths.cachePath], ['history', S.meta.paths.historyPath], ['project index', S.meta.paths.contextGraph], ['CDP', S.meta.cdpUrl]];
  var table = el('table', { class: 'paths' });
  rows.forEach(function (r) { table.appendChild(el('tr', {}, [el('td', { text: r[0] }), el('td', { text: r[1] || '—' })])); });
  box.appendChild(table);
}

/* ---------------------------------------------------------------- search */

function applyQuery() {
  var q = (S.query || '').trim().toLowerCase();
  var candidates = document.querySelectorAll('#sec-runs .row, #sec-runs .group, #sec-library tbody tr, #sec-help .m-sec, #sec-now .req-card, #sec-machinery tbody tr');
  for (var i = 0; i < candidates.length; i += 1) {
    var node = candidates[i];
    var hit = q === '' || node.textContent.toLowerCase().indexOf(q) !== -1;
    node.classList.toggle('hidden-by-search', !hit);
    if (node.classList.contains('row')) {
      var next = node.nextElementSibling;
      if (next && next.classList.contains('detail')) next.classList.toggle('hidden-by-search', !hit);
    }
  }
  var note = byId('search-note');
  if (note) note.textContent = q ? 'filtering by “' + q + '” — clear the box to see everything' : '';
}

/* ------------------------------------------------------------------ data */

function dataSignature() {
  return wowDataSignature() + '|' + JSON.stringify([
    S.failedRuns.map(function (r) { return r.id + r.status; }),
    S.flows.map(function (f) { return f.path + f.modified; }),
    S.db && [S.db.configured, S.db.maskedUrl, S.db.probe && S.db.probe.at, S.db.checking],
    S.online
  ]);
}

/* ------------------------------------------------------------------ boot */

function handleHash() {
  var raw = (location.hash || '').replace('#', '');
  if (!raw) return;
  if (sectionOf(raw)) { goTo(raw); return; }
  if (LEGACY_HASH[raw]) { show(raw); return; }
  if (S.meta && commandById(raw)) { openLauncher('more', raw); return; }
  if (/^m-/.test(raw)) { var m = byId(raw); if (m) { goTo('help'); m.scrollIntoView({ block: 'start' }); } }
}

function boot() {
  S.view = 'runs';
  S.section = 'now';
  S.density = pref('density') || 'flow';
  S.sort = pref('sort') || 'latest';
  S.cards = pref('cards') || {};
  S.query = '';
  S.pick = {};
  S.editing = null;
  S.showAllResumable = false;
  S.helpDrawn = false;
  S.db = S.db || null;

  byId('start-top').addEventListener('click', toggleLauncher);
  var search = byId('search');
  search.addEventListener('input', function () { S.query = search.value; applyQuery(); });
  search.addEventListener('keydown', function (e) { if (e.key === 'Escape') { search.value = ''; S.query = ''; applyQuery(); search.blur(); } });

  api('/api/meta').then(function (meta) { S.meta = meta; renderSidebar(); refreshPathsTable(); handleHash(); })['catch'](function () {});
  refresh().then(function () { if (!S.hashHandled) { S.hashHandled = true; handleHash(); } });

  window.addEventListener('hashchange', handleHash);
  window.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    var overlays = document.querySelectorAll('.overlay-backdrop');
    if (overlays.length) { overlays[overlays.length - 1].remove(); return; }
    if (S.launcher) closeLauncher();
    else if (S.drawer) closeDrawer();
  });

  if (window.IntersectionObserver) {
    var seen = {};
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) { seen[entry.target.id.replace('sec-', '')] = entry.isIntersecting ? entry.boundingClientRect.top : null; });
      var best = null;
      SECTIONS.forEach(function (s) { var top = seen[s.id]; if (top === null || top === undefined) return; if (best === null || Math.abs(top) < Math.abs(seen[best])) best = s.id; });
      if (best && best !== S.section) { S.section = best; paintNav(); if (location.hash !== '#' + best) history.replaceState(null, '', '#' + best); }
    }, { rootMargin: '-64px 0px -60% 0px', threshold: [0, 0.1] });
    SECTIONS.forEach(function (s) { var node = byId('sec-' + s.id); if (node) observer.observe(node); });
  }

  setInterval(function () { if (document.visibilityState === 'visible') refresh(); }, 5000);
  setInterval(function () { if (document.visibilityState === 'visible') tickProgress(); }, 1000);
}

boot();
`;

/** The whole of newUI: markup, styles and behaviour, in one document. */
export function renderNewUi(): string {
  const manual = MANUAL.map((section) => ({ id: section.id, title: section.title, body: parseManualHtml(section.html) }));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>wowlidator — one page</title>
<style>${WOW_STYLE}${NEW_STYLE}</style>
</head>
<body>
<header class="topbar">
  <div class="brand">
    <span class="brand-mark" aria-hidden="true">W</span>
    <div>
      <div class="brand-word">wow<span class="slash">//</span>UI</div>
      <div class="brand-sub">flows claim · wowlidator proves</div>
    </div>
  </div>
  <div class="status" id="status" aria-live="polite"></div>
  <input class="search" id="search" type="search" placeholder="search everything…" aria-label="Search runs, library, machinery and help">
  <button type="button" class="btn primary md" id="start-top">+ Start verification</button>
</header>
<div class="app">
  <aside class="side">
    <nav id="nav" aria-label="Sections"></nav>
    <div class="side-footer" id="foot"></div>
  </aside>
  <main class="main" id="main">
    <div id="search-note" class="quiet" aria-live="polite"></div>
    <section class="sec" id="sec-now" aria-label="Now"></section>
    <section class="sec" id="sec-start" aria-label="Start"></section>
    <section class="sec" id="sec-runs" aria-label="Runs and proof"></section>
    <section class="sec" id="sec-library" aria-label="Library"></section>
    <section class="sec" id="sec-machinery" aria-label="Machinery"></section>
    <section class="sec" id="sec-help" aria-label="Help"></section>
  </main>
</div>
<div id="drawer"></div>
<div class="toast-container" id="toasts"></div>
<script>var MANUAL_DATA = ${scriptJson(manual)};</script>
<script>${baseScript()}${NEW_SCRIPT}</script>
</body>
</html>
`;
}
