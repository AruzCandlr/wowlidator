/**
 * wowUI — wowlidator's runs and evidence, in GRIM's QA Command Center layout.
 *
 * The control panel in `app-html.ts` is organised around *commands*: pick one,
 * fill the form, watch it run. That is the right shape for driving a CLI and
 * the wrong shape for the question asked afterwards — "this flow has run
 * eleven times, which run broke it, and what is the proof?" GRIM's command
 * centre already answers exactly that question about a different system, so
 * wowUI is that layout with wowlidator's own nouns in it:
 *
 *   GRIM                            wowUI
 *   builder / catalog               where the flow came from (authored, or generated from a page)
 *   task                            a flow
 *   cycle (loop 1..3)               a run of that flow
 *   check (claim + verdict)         a step (intent + passed/failed)
 *   evidence (screenshot, repro)    the step's screenshot, selector and calls
 *   fix targets (AI proposals)      the heal the healer proposed, and the agent's turns
 *
 * The mapping is one-way and honest: nothing here invents a GRIM concept
 * wowlidator does not have. There is no "oracle", so the panel that would show
 * one shows defects instead; there is no builder to send feedback to, so the
 * button that would is `run --repair`, which is what sending it back for a fix
 * actually means here.
 *
 * ## What this file is allowed to do
 *
 * The same three rules the control panel is built on, unchanged, because they
 * are what make a page bound to a port safe to leave running:
 *
 * - **It runs the CLI, it does not reimplement it.** Every action posts to
 *   `/api/jobs` with a command id from `commands.ts`, and the command line it
 *   produced is displayed. A second execution path would be a second thing to
 *   keep correct.
 * - **DOM is built through `el()`, never from HTML strings.** Everything shown
 *   — flow names, selectors, model reasoning, application text quoted back by a
 *   failing step — comes from somewhere else, and `textContent` cannot be
 *   talked into executing any of it. Unlike `app-html.ts` there is no
 *   `trustedHtml` escape hatch at all, because there is no manual here.
 * - **One document.** Markup, styles and behaviour ship together, so there are
 *   no asset paths to resolve and it behaves identically under `tsx src/` and
 *   from `dist/` after a build.
 *
 * The stylesheet is GRIM's, ported onto the shared tokens in `reporter/theme.ts`
 * rather than pasted with its literal colours: `--teal` becomes `--accent`,
 * `--paper` becomes `--bg`, and so on. That is what makes wowUI follow the same
 * light/dark system as the report and the control panel instead of being a
 * third dialect of nearly-the-same. The inline `url(data:image/svg+xml…)` marks
 * for the loop rail and verdict dots stay here rather than moving into the
 * shared theme, which has a test asserting it contains no `url(` at all — an
 * artefact that must open off a USB stick cannot afford the habit.
 */

import { GRIM_BASE, GRIM_TOKENS } from '../reporter/theme.js';

/**
 * GRIM's QA Command Center, on wowlidator's tokens.
 *
 * Ported from `grimval/apps/qa_command_center/src/styles/theme.css`. Class
 * names are kept verbatim — `.side`, `.row`, `.rail`, `.chip`, `.tbl`,
 * `.drawer` — so the two surfaces can be diffed against each other by anyone
 * who knows either one.
 */
const WOW_STYLE = `
${GRIM_TOKENS}
${GRIM_BASE}

/* ---- shell ---- */
html, body { height: 100%; }
.app { display: grid; grid-template-columns: 232px minmax(0, 1fr); min-height: 100vh; align-items: start; }

.side {
  position: sticky; top: 0; align-self: stretch;
  background: var(--panel); border-right: 1px solid var(--line);
  padding: var(--s5) var(--s3);
  display: flex; flex-direction: column; gap: 2px; min-height: 100vh;
}
.brand { display: flex; align-items: center; gap: var(--s2); padding: var(--s1) var(--s2) var(--s5); }
.brand-mark {
  width: 28px; height: 28px; flex: 0 0 auto; border-radius: 7px;
  background: var(--ink); color: var(--panel);
  font-family: var(--mono); font-weight: 800; font-size: 13px;
  display: grid; place-items: center;
}
.brand-word { font-family: var(--mono); font-weight: 700; font-size: var(--fs-lg); letter-spacing: .04em; line-height: 1.2; }
.brand-word .slash { color: var(--accent); }
.brand-sub { font-size: var(--fs-cap); color: var(--faint); line-height: 1.4; margin-top: 2px; }

.nav-label {
  font-size: var(--fs-cap); font-weight: 600; letter-spacing: .08em;
  color: var(--faint); text-transform: uppercase; padding: var(--s4) var(--s2) var(--s1);
}
.nav-item {
  display: flex; align-items: center; gap: var(--s2); height: 34px; padding: 0 var(--s2);
  border-radius: var(--r-sm); color: var(--muted); font: inherit; font-size: var(--fs-sm);
  cursor: pointer; transition: background .12s ease, color .12s ease;
  border: 0; background: transparent; width: 100%; text-align: left; outline: none;
}
.nav-item:hover { background: var(--panel-2); color: var(--ink); }
.nav-item.active { background: var(--panel-2); color: var(--ink); font-weight: 600; box-shadow: inset 2px 0 0 var(--accent); }
.nav-item:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.nav-item svg {
  width: 16px; height: 16px; flex: 0 0 auto; fill: none; stroke: currentColor;
  stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round;
}
.nav-item .txt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nav-count {
  margin-left: auto; min-width: 20px; text-align: center; font-size: var(--fs-cap);
  font-weight: 500; font-variant-numeric: tabular-nums; background: var(--bg);
  border: 1px solid var(--line); border-radius: var(--r-pill); padding: 1px 6px; color: var(--muted);
}
.nav-item.active .nav-count { background: var(--panel); color: var(--ink); }
.nav-count.alert { background: var(--warn-bg); border-color: transparent; color: var(--warn); font-weight: 600; }
.side-footer {
  margin-top: auto; padding: var(--s2); font-size: var(--fs-xs); color: var(--muted);
  display: flex; align-items: center; gap: var(--s2);
}
.side-footer .paths { display: block; font-size: var(--fs-cap); color: var(--faint); }
.dot {
  width: 7px; height: 7px; border-radius: 50%; background: var(--ok); flex: 0 0 auto;
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 14%, transparent);
}
.dot.off { background: var(--warn); box-shadow: 0 0 0 3px color-mix(in srgb, var(--warn) 14%, transparent); }

/* ---- main ---- */
.main { padding: var(--s6) var(--s7) 56px; max-width: 1120px; }
.page-head { display: flex; align-items: flex-start; gap: var(--s4); margin-bottom: var(--s7); }
h1 { font-size: var(--fs-xl); font-weight: 600; letter-spacing: -.02em; line-height: 1.3; margin: 0; }
.page-head .sub { font-size: var(--fs-sm); color: var(--muted); margin-top: 2px; max-width: 640px; }
.page-head .spacer { margin-left: auto; }
.cap { font-size: var(--fs-cap); font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--faint); }

/* ---- buttons ---- */
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  font: inherit; font-size: var(--fs-xs); font-weight: 500; height: 28px; padding: 0 12px;
  border: 1px solid var(--line-strong); background: var(--panel); border-radius: var(--r-sm);
  cursor: pointer; color: var(--ink); white-space: nowrap;
  transition: background .12s ease, border-color .12s ease;
}
.btn:hover:not(:disabled) { background: var(--bg); }
.btn:disabled { opacity: .45; cursor: not-allowed; }
.btn.md { height: 36px; font-size: var(--fs-sm); padding: 0 var(--s4); }
.btn.accent:not(:disabled) { border-color: var(--accent-line); color: var(--accent-ink); font-weight: 600; }
.btn.accent:hover:not(:disabled) { background: var(--accent-soft); border-color: var(--accent); }
/* Armed, not decorative: the only buttons wearing this are one click from
   destroying something, and they say what they are about to destroy. */
.btn.danger:not(:disabled) { border-color: var(--bad); color: var(--bad); font-weight: 600; }
.btn.danger:hover:not(:disabled) { background: var(--bad-bg); }
.btn.primary {
  background: var(--accent-strong); border-color: var(--accent-strong); color: var(--on-accent);
  font-weight: 600; box-shadow: var(--shadow);
}
/* The background is restated rather than only filtered: \`.btn:hover\` is one
   pseudo-class more specific than \`.btn.primary\`, so a filter alone leaves the
   plain hover background to win and the button loses its fill under the
   cursor. */
.btn.primary:hover:not(:disabled) { background: var(--accent-strong); filter: brightness(1.12); }
.btn.primary:active:not(:disabled) { background: var(--accent-strong); filter: brightness(.94); }
.link {
  font: inherit; font-size: var(--fs-xs); font-weight: 600; color: var(--accent-ink);
  background: none; border: 0; padding: 0; cursor: pointer; white-space: nowrap;
}
.link:hover { text-decoration: underline; }
.link:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: var(--r-xs); }

/* ---- loop rail: three runs, at a glance ---- */
.rail { position: relative; display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto; width: 54px; }
.rail::before {
  content: ""; position: absolute; left: 7px; right: 7px; top: 50%; height: 2px;
  margin-top: -1px; background: var(--line-strong); border-radius: 1px;
}
.rail i {
  position: relative; width: 14px; height: 14px; border-radius: var(--r-xs);
  background-color: var(--bg); border: 1.5px solid var(--line-strong);
  background-repeat: no-repeat; background-position: center; background-size: 11px;
}
.rail i.ok {
  background-color: var(--ok); border-color: var(--ok);
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'><path d='M2.8 6.3 4.9 8.4 9.2 3.9' fill='none' stroke='%23ffffff' stroke-width='1.9' stroke-linecap='round' stroke-linejoin='round'/></svg>");
}
.rail i.bad {
  background-color: var(--bad); border-color: var(--bad);
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'><path d='M3.7 3.7 8.3 8.3M8.3 3.7 3.7 8.3' fill='none' stroke='%23ffffff' stroke-width='1.9' stroke-linecap='round'/></svg>");
}
.rail i.warn {
  background-color: var(--warn); border-color: var(--warn);
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'><path d='M3.4 6h5.2' fill='none' stroke='%23ffffff' stroke-width='1.9' stroke-linecap='round'/></svg>");
}
.rail i.run { background-color: var(--info); border-color: var(--info); animation: railpulse 1.6s ease-out infinite; }
@keyframes railpulse {
  0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--info) 34%, transparent); }
  70%, 100% { box-shadow: 0 0 0 6px transparent; }
}

/* ---- chips ---- */
.chip {
  display: inline-flex; align-items: center; gap: 6px; justify-self: start;
  font-size: 12px; font-weight: 500; letter-spacing: .01em; line-height: 1.5;
  padding: 2px 10px; border-radius: var(--r-pill); white-space: nowrap;
}
.chip::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: 0 0 auto; }
.chip.verified { background: var(--ok-bg); color: var(--ok); }
.chip.running { background: var(--info-bg); color: var(--info); }
.chip.feedback { background: var(--warn-bg); color: var(--warn); }
.chip.escalated { background: var(--bad-bg); color: var(--bad); }
.chip.blocked { background: var(--warn-bg); color: var(--warn); }
.chip.plain { background: var(--panel-2); color: var(--muted); }
.badge {
  font-size: 11px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase;
  border-radius: var(--r-xs); padding: 2px 8px; color: var(--on-accent); background: var(--info);
}
.badge.gen { background: var(--violet); color: #fff; }

/* ---- cards & tables ---- */
.card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-lg); box-shadow: var(--shadow); }
.tbl {
  width: 100%; border-collapse: separate; border-spacing: 0; background: var(--panel);
  border: 1px solid var(--line); border-radius: var(--r-lg); overflow: hidden;
  font-size: var(--fs-sm); box-shadow: var(--shadow);
}
.tbl th {
  text-align: left; font-size: var(--fs-cap); font-weight: 600; letter-spacing: .1em;
  text-transform: uppercase; color: var(--faint); padding: var(--s3) var(--s4);
  border-bottom: 1px solid var(--line); white-space: nowrap;
}
.tbl td { padding: 14px var(--s4); border-bottom: 1px solid var(--line); vertical-align: middle; line-height: 1.5; }
.tbl tbody tr:last-child td { border-bottom: 0; }
.tbl tbody tr:hover td { background: var(--panel-2); }
.tbl tfoot td {
  border-top: 1px solid var(--line-strong); border-bottom: 0;
  padding: var(--s2) var(--s4); color: var(--faint); background: var(--panel-2);
}
.tbl code, code.m {
  font-family: var(--mono); font-size: var(--fs-mono); color: var(--ink); background: var(--code-bg);
  border: 1px solid var(--line); padding: 1px 6px; border-radius: var(--r-xs); overflow-wrap: anywhere;
}
.col-r { text-align: right; }
.verdict { display: inline-flex; align-items: center; gap: 6px; font-size: var(--fs-xs); font-weight: 700; white-space: nowrap; }
.verdict::before {
  content: ""; width: 14px; height: 14px; border-radius: 50%; flex: 0 0 auto;
  background-repeat: no-repeat; background-position: center; background-size: 11px;
}
.verdict.pass { color: var(--ok); }
.verdict.pass::before {
  background-color: var(--ok);
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'><path d='M2.8 6.3 4.9 8.4 9.2 3.9' fill='none' stroke='%23ffffff' stroke-width='1.9' stroke-linecap='round' stroke-linejoin='round'/></svg>");
}
.verdict.fail { color: var(--bad); }
.verdict.fail::before {
  background-color: var(--bad);
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'><path d='M3.7 3.7 8.3 8.3M8.3 3.7 3.7 8.3' fill='none' stroke='%23ffffff' stroke-width='1.9' stroke-linecap='round'/></svg>");
}
.verdict.warn { color: var(--warn); }
.verdict.warn::before {
  background-color: var(--warn);
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'><path d='M3.4 6h5.2' fill='none' stroke='%23ffffff' stroke-width='1.9' stroke-linecap='round'/></svg>");
}
.mono { font-family: var(--mono); font-size: var(--fs-mono); color: var(--faint); }
.tag {
  display: inline-block; font-family: var(--mono); font-size: 10.5px; padding: 1px 8px;
  border-radius: 10px; border: 1px solid var(--line); color: var(--muted); white-space: nowrap; margin-left: 8px;
}
.tag.warn { border-color: var(--warn); color: var(--warn); }

/* ---- stats ---- */
.stats {
  display: grid; grid-template-columns: repeat(4, 1fr); background: var(--panel);
  border: 1px solid var(--line); border-radius: var(--r-lg); box-shadow: var(--shadow);
  overflow: hidden; margin-bottom: var(--s7);
}
.stat { padding: var(--s4) var(--s5); border-left: 1px solid var(--line); }
.stat:first-child { border-left: 0; }
.stat .k { font-size: var(--fs-cap); font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--faint); }
.stat .v { font-size: 26px; font-weight: 600; letter-spacing: -.02em; line-height: 1.25; margin-top: var(--s1); font-variant-numeric: tabular-nums; }
.stat .v small { font-size: var(--fs-sm); font-weight: 600; color: var(--muted); margin-left: var(--s1); }
.stat .n { font-size: var(--fs-xs); color: var(--faint); margin-top: 1px; }

/* ---- groups & rows ---- */
.group { margin-bottom: var(--s6); }
.group-head { display: flex; align-items: center; gap: var(--s2); padding: 0 var(--s1) var(--s2); }
.avatar {
  width: 24px; height: 24px; border-radius: 6px; background: var(--ink); color: var(--panel);
  font-family: var(--mono); font-size: 11px; font-weight: 700; display: grid; place-items: center; flex: 0 0 auto;
}
.group-head b { font-size: var(--fs-md); font-weight: 600; color: var(--ink); }
.group-head .meta { font-size: var(--fs-xs); color: var(--faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.group-head .state { margin-left: auto; font-size: var(--fs-xs); color: var(--muted); display: inline-flex; align-items: center; gap: 6px; }
.group-head .state::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--line-strong); }
.group-head .state.busy::before { background: var(--info); }

.rows { overflow: hidden; border-radius: var(--r-lg); }
.row {
  display: grid; grid-template-columns: 54px minmax(0, 1fr) auto auto auto auto;
  align-items: center; gap: 12px; padding: var(--s3) var(--s5);
  border-bottom: 1px solid var(--line); cursor: pointer; transition: background .12s ease; color: inherit;
}
.row:last-child { border-bottom: 0; }
.row:hover { background: var(--panel-2); }
.row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; background: var(--panel-2); }
.row.open { background: var(--panel-2); }
.task-cell { min-width: 0; width: 100%; }
.task-name { font-size: var(--fs-md); font-weight: 600; line-height: 1.4; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.task-sub {
  font-family: var(--mono); font-size: var(--fs-mono); color: var(--faint); line-height: 1.5;
  margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.task-sub.fail { font-family: var(--sans); font-size: var(--fs-xs); color: var(--bad); }
.task-sub.live { font-family: var(--sans); font-size: var(--fs-xs); color: var(--info); }
.counts { font-size: var(--fs-xs); color: var(--muted); white-space: nowrap; text-align: right; font-variant-numeric: tabular-nums; }
.counts b { color: var(--ink); font-weight: 600; }
.counts.none { color: var(--faint); }
.when { font-size: var(--fs-xs); color: var(--faint); white-space: nowrap; text-align: right; font-variant-numeric: tabular-nums; min-width: 92px; }

/* Pointing a role at a provider and a model, in the Machinery tab. The model is
   an input rather than a select because OpenRouter alone serves several hundred
   — see modelPicker() for why typing an unlisted id has to stay possible. */
.picker { display: flex; gap: var(--s2); align-items: center; }
.picker .sel, .picker .inp {
  font: inherit; font-size: var(--fs-xs); height: 30px; padding: 0 var(--s2);
  border: 1px solid var(--line-strong); border-radius: var(--r-sm);
  color: var(--ink); background: var(--panel); min-width: 0;
}
.picker .sel { flex: 0 0 auto; max-width: 190px; }
.picker .inp { flex: 1 1 auto; font-family: var(--mono); font-size: var(--fs-mono); }
.picker .sel:focus, .picker .inp:focus { outline: 2px solid var(--accent); outline-offset: 1px; border-color: var(--accent-line); }
.picker-note { margin-top: 4px; font-size: var(--fs-xs); color: var(--faint); }
.picker-note .mono { font-family: var(--mono); font-size: var(--fs-mono); }

/* Live progress. The bar is a run in flight, so it is only ever on screen while
   something is actually moving — there is no finished state to style. */
.prog { display: flex; align-items: center; gap: var(--s2); min-width: 200px; }
.prog .pbar {
  position: relative; flex: 1; height: 5px; border-radius: 999px;
  background: var(--line); overflow: hidden;
}
.prog .pbar i {
  display: block; height: 100%; width: 0; border-radius: 999px;
  background: var(--accent-strong);
  transition: width .4s ease;
}
/* No denominator yet — a crawl discovers its destinations as it goes, and a run
   has not announced its plan until the first line arrives. A bar that sat at 0%
   would read as stuck, and one at 100% would be a lie, so it paces instead. */
.prog .pbar.wait i {
  width: 35%; background: color-mix(in srgb, var(--accent-strong) 55%, transparent);
  animation: prog-wait 1.4s ease-in-out infinite; transition: none;
}
@keyframes prog-wait {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(285%); }
}
.prog .eta {
  display: inline-flex; align-items: center; gap: 4px; white-space: nowrap;
  font-size: var(--fs-xs); color: var(--muted); font-variant-numeric: tabular-nums;
}
.prog .eta svg {
  width: 13px; height: 13px; flex: 0 0 auto; fill: none; stroke: currentColor;
  stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round;
}
.prog .steps { font-size: var(--fs-xs); color: var(--faint); white-space: nowrap; font-variant-numeric: tabular-nums; }
@media (prefers-reduced-motion: reduce) {
  .prog .pbar i { transition: none; }
  .prog .pbar.wait i { animation: none; }
}
.actions { display: flex; gap: var(--s2); justify-content: flex-end; }

.detail { border-bottom: 1px solid var(--line); background: var(--panel-2); padding: var(--s5); }
.detail:last-child { border-bottom: 0; }
.detail .dh { display: flex; align-items: center; gap: var(--s2); margin-bottom: var(--s3); }
.cycles { display: flex; gap: var(--s2); margin-bottom: var(--s4); overflow-x: auto; padding-bottom: 2px; }
.cycle {
  background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-sm);
  padding: var(--s2) var(--s3); box-shadow: var(--shadow); cursor: pointer;
  transition: border-color .12s ease; white-space: nowrap;
}
.cycle .ct { display: flex; align-items: center; gap: 6px; font-size: var(--fs-sm); font-weight: 600; line-height: 1.4; }
.cycle .cd { width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto; }
.cycle .cd.pass { background: var(--ok); }
.cycle .cd.warn { background: var(--warn); }
.cycle .cd.fail { background: var(--bad); }
.cycle .cm { font-size: var(--fs-xs); color: var(--muted); font-variant-numeric: tabular-nums; margin-top: 1px; }
.cycle.active { border-color: var(--accent-line); box-shadow: 0 0 0 3px var(--accent-soft); }
.cycle .now { font-size: 10px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--accent-ink); margin-left: var(--s1); }
.cycle .drift { font-family: var(--mono); font-size: 10.5px; color: var(--violet); margin-top: 1px; }
.detail-foot { display: flex; align-items: center; gap: var(--s3); margin-top: var(--s3); flex-wrap: wrap; }
.detail-foot .why { font-size: var(--fs-xs); color: var(--faint); }

/* ---- empty, warning, filters ---- */
.box { background: var(--panel); border: 1px dashed var(--line-strong); border-radius: var(--r-lg); padding: var(--s7) var(--s6); text-align: center; }
.box .mark { position: relative; display: inline-flex; align-items: center; gap: var(--s2); margin-bottom: var(--s4); }
.box .mark::before {
  content: ""; position: absolute; left: 9px; right: 9px; top: 50%; height: 2px;
  margin-top: -1px; background: var(--line-strong); border-radius: 1px;
}
.box .mark i { position: relative; width: 18px; height: 18px; border-radius: 6px; background: var(--bg); border: 1.5px solid var(--line-strong); }
.box .big { font-size: var(--fs-lg); font-weight: 600; letter-spacing: -.01em; margin-bottom: var(--s1); }
.box .why { font-size: var(--fs-sm); color: var(--muted); max-width: 460px; margin: 0 auto var(--s4); line-height: 1.6; }

.warn-banner {
  background: var(--warn-bg); border: 1px solid color-mix(in srgb, var(--warn) 30%, transparent);
  border-radius: var(--r-lg); padding: var(--s4); display: flex; gap: var(--s3);
  align-items: flex-start; margin-bottom: var(--s6);
}
.warn-banner svg { width: 16px; height: 16px; flex: 0 0 auto; margin-top: 3px; fill: none; stroke: var(--warn); stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.warn-banner b { font-size: var(--fs-sm); color: var(--warn); }
.warn-banner .fix { display: block; font-size: var(--fs-xs); color: var(--muted); margin-top: var(--s1); line-height: 1.6; }
.warn-banner .acts { margin-top: var(--s3); display: flex; gap: var(--s2); }

.filters { display: flex; gap: var(--s2); margin-bottom: var(--s4); flex-wrap: wrap; }
.f-pill {
  font: inherit; font-size: var(--fs-xs); border: 1px solid var(--line-strong); background: var(--panel);
  border-radius: var(--r-pill); padding: 4px 13px; cursor: pointer; color: var(--muted); transition: all .12s ease;
}
.f-pill.on { background: var(--accent-soft); border-color: transparent; color: var(--accent-ink); font-weight: 600; }
.f-pill:hover:not(.on) { background: var(--panel-2); color: var(--ink); }

/* stability bars — five notches of confidence, GRIM's ledger mark */
.stab { display: inline-flex; gap: 2px; margin-left: 8px; vertical-align: middle; }
.stab i { width: 6px; height: 11px; border-radius: 2px; background: var(--ok); }
.stab i.off { background: var(--line-strong); }

.req-card {
  background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-lg);
  padding: 15px 18px; margin-bottom: 10px; display: grid; grid-template-columns: auto 1fr;
  gap: 14px; align-items: start; box-shadow: var(--shadow);
}
.req-card .sev { font-size: 11px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; border-radius: var(--r-pill); padding: 3px 10px; background: var(--warn-bg); color: var(--warn); }
.req-card .sev.high { background: var(--bad-bg); color: var(--bad); }
.req-card .sev.low { background: var(--panel-2); color: var(--faint); }
.req-card .what { font-size: var(--fs-sm); line-height: 1.5; }
.req-card .note { margin-top: 9px; display: flex; gap: 8px; align-items: center; }

/* ---- modal ---- */
.overlay-backdrop { position: fixed; inset: 0; background: rgba(28,33,38,.32); z-index: 1000; display: grid; place-items: center; padding: var(--s6); }
.modal {
  background: var(--panel); border-radius: var(--r-lg); padding: var(--s6); width: 460px;
  max-width: 90vw; max-height: 88vh; overflow-y: auto; box-shadow: var(--shadow-over);
  border: 1px solid var(--line);
}
.modal h2 { font-size: var(--fs-lg); font-weight: 600; letter-spacing: -.01em; margin: 0 0 var(--s1); }
/* ---- actual-flow player ---- */
.flow-subtitle { margin-top: var(--s3); padding: var(--s2) var(--s3); border-radius: var(--r-md, 8px);
  background: var(--panel-2); border: 1px solid var(--line); font-size: var(--fs-sm); line-height: 1.5; }
.flow-subtitle .sub-step { font-weight: 700; font-variant-numeric: tabular-nums; color: var(--muted); margin-right: 8px; }
.flow-subtitle.failed { border-color: var(--bad); background: var(--bad-bg); color: var(--bad); }
.flow-subtitle.failed .sub-step { color: var(--bad); }
.flow-subtitle .sub-how { display: block; margin-top: 3px; font-family: var(--mono); font-size: var(--fs-xs); opacity: .9; }
.flow-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: var(--s3); }
.flow-chips .chip { cursor: pointer; }
.modal .sub { font-size: var(--fs-xs); color: var(--muted); margin-bottom: var(--s5); line-height: 1.6; }
.modal label { display: block; font-size: var(--fs-xs); font-weight: 600; color: var(--muted); margin: var(--s4) 0 var(--s2); }
.modal select, .modal input, .modal textarea {
  display: block; width: 100%; font: inherit; font-size: var(--fs-sm);
  border: 1px solid var(--line-strong); border-radius: var(--r-sm); padding: var(--s2) var(--s3);
  color: var(--ink); background: var(--panel); line-height: 1.5;
}
.modal input[type=checkbox], .modal input[type=radio] { display: inline-block; width: auto; }
.modal select { height: 38px; padding: 0 var(--s3); }
.modal textarea { min-height: 72px; resize: vertical; line-height: 1.6; font-family: var(--mono); font-size: var(--fs-mono); }
.modal input:focus, .modal select:focus, .modal textarea:focus { outline: 2px solid var(--accent); outline-offset: 2px; border-color: var(--accent-line); }
/* A field that does not apply to the chosen mode has to look inert, or it
   reads as a field you forgot to fill in. Its title says why. */
.modal input:disabled, .modal select:disabled, .modal textarea:disabled {
  background: var(--panel-2); color: var(--faint); cursor: not-allowed;
}
.modal .optional { font-weight: 400; color: var(--faint); }
.modal .acts { display: flex; gap: var(--s2); margin-top: var(--s6); justify-content: flex-end; }
.modal .inline { display: flex; align-items: center; gap: 6px; font-weight: 400; color: var(--ink); cursor: pointer; margin: 0; }
.segmented { display: flex; gap: 6px; margin-bottom: var(--s4); }
.segmented .btn { flex: 1; }
.gate { margin-top: 10px; border: 1px solid var(--line); border-radius: var(--r-sm); padding: 10px 12px; max-height: 220px; overflow-y: auto; }
.gate .line { display: flex; align-items: baseline; gap: 8px; padding: 3px 0; cursor: pointer; font-size: var(--fs-xs); }
.gate .line.cut span { text-decoration: line-through; opacity: .5; }
.err { color: var(--bad); font-size: var(--fs-xs); margin-top: var(--s2); }

/* ---- drawer ---- */
.drawer-backdrop { position: fixed; inset: 0; background: rgba(28,33,38,.24); z-index: 1050; display: flex; justify-content: flex-end; }
.drawer {
  width: 460px; max-width: 100vw; height: 100vh; background: var(--panel);
  border-left: 1px solid var(--line); padding: var(--s5); box-shadow: var(--shadow-over);
  overflow-y: auto; display: flex; flex-direction: column;
}
.drawer .top { display: flex; align-items: center; gap: var(--s2); margin-bottom: var(--s3); }
.drawer .top b { font-size: var(--fs-lg); font-weight: 600; letter-spacing: -.01em; }
.drawer .x {
  margin-left: auto; display: grid; place-items: center; width: 28px; height: 28px;
  border: 0; background: none; border-radius: var(--r-sm); color: var(--faint);
  font-size: 16px; line-height: 1; cursor: pointer;
}
.drawer .x:hover { background: var(--panel-2); color: var(--ink); }
.drawer .claim { font-size: var(--fs-md); font-weight: 600; line-height: 1.5; }
.drawer .cap { margin: var(--s5) 0 var(--s2); }
.drawer .tabs { display: flex; gap: 6px; margin: 10px 0; }
.drawer .tabs .btn { flex: 1; }
.drawer .shot-container {
  border: 1px solid var(--line); border-radius: var(--r-sm); max-height: 260px;
  overflow: hidden; background: var(--panel-2); display: flex; align-items: center; justify-content: center;
}
.drawer .shot-img { width: 100%; height: auto; max-height: 260px; object-fit: contain; display: block; }
.drawer .path { font-family: var(--mono); font-size: var(--fs-mono); color: var(--faint); word-break: break-all; margin-top: var(--s2); line-height: 1.5; }
.drawer .repro {
  font-family: var(--mono); font-size: var(--fs-mono); color: var(--ink); background: var(--panel-2);
  border: 1px solid var(--line); border-radius: var(--r-sm); padding: var(--s3);
  white-space: pre-wrap; word-break: break-word; line-height: 1.6; max-height: 260px; overflow-y: auto;
}
.drawer .acts { display: flex; gap: var(--s2); margin-top: var(--s4); flex-wrap: wrap; }
.drawer .callout { margin: 8px 0 4px; padding: 8px 12px; border-left: 3px solid var(--warn); background: var(--warn-bg); border-radius: 6px; font-size: var(--fs-xs); color: var(--ink); }
.drawer .callout.ai { border-left-color: var(--violet); background: var(--violet-bg); color: var(--muted); }
.drawer .calls { max-height: 180px; overflow-y: auto; }
.drawer .calls div { font-family: var(--mono); font-size: var(--fs-mono); padding: 2px 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.drawer .kv { font-size: var(--fs-xs); color: var(--muted); padding: 2px 0; }
.drawer .kv b { color: var(--ink); font-weight: 600; }

/* ---- toast ---- */
.toast-container { position: fixed; bottom: 20px; right: 20px; z-index: 1200; display: flex; flex-direction: column; gap: 8px; pointer-events: none; }
.toast-msg {
  background: var(--ink); color: var(--panel); font-size: var(--fs-xs); font-family: var(--mono);
  padding: 8px 14px; border-radius: var(--r-sm); box-shadow: var(--shadow-over);
  pointer-events: auto; animation: fadeIn .15s ease-out;
}
@keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }

@media (max-width: 900px) {
  .app { grid-template-columns: 1fr; }
  .side { display: none; }
  .main { padding: var(--s5) var(--s4) 48px; }
  .stats { grid-template-columns: repeat(2, 1fr); }
  .row { grid-template-columns: 54px minmax(0, 1fr); row-gap: 6px; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: .001ms !important; animation-iteration-count: 1 !important; transition-duration: .001ms !important; }
}
`;

const WOW_SCRIPT = String.raw`
'use strict';

/* ------------------------------------------------------------------ state */

var S = {
  meta: null, online: true,
  view: 'runs',
  proofs: [], flows: [], jobs: [], reports: [], cache: [],
  keys: { providers: [], roles: [] },
  models: { providers: [], roles: [] },  /* the model catalogue, and each role's pick */
  contextDocs: [],   /* stored background documents — see the launch modal */
  bundles: {},       /* runId -> the full bundle, fetched when a run is opened */
  openTask: null,    /* which flow's detail is expanded */
  cycleOf: {},       /* flow name -> the run being shown in its detail */
  filter: 'all',
  runningFor: {},    /* flow name -> job id, for runs started from this page */
  signature: null,   /* fingerprint of the last data drawn — see dataSignature */
  bars: [],          /* live progress bars on screen — see progressBar */
  jobsAt: 0,         /* when /api/jobs last answered, for counting the eta down */
  outOpen: {},       /* runId -> whether its command-output section is expanded */
  jobLines: {},      /* jobId -> fetched output lines, so expanding twice is free */
  modal: null, drawer: null, es: null
};

/* ------------------------------------------------------------------ dom */

function el(tag, props, children) {
  var node = document.createElement(tag);
  if (props) {
    Object.keys(props).forEach(function (k) {
      var v = props[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    });
  }
  (children || []).forEach(function (c) {
    if (c === null || c === undefined || c === false) return;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  });
  return node;
}

function svg(paths) {
  var node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  node.setAttribute('viewBox', '0 0 24 24');
  node.setAttribute('aria-hidden', 'true');
  paths.forEach(function (d) {
    var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    node.appendChild(p);
  });
  return node;
}

function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
function byId(id) { return document.getElementById(id); }

function api(path, options) {
  return fetch(path, options).then(function (r) {
    return r.json().then(function (body) {
      if (!r.ok) throw new Error(body && body.error ? body.error : 'request failed');
      return body;
    });
  });
}

function toast(message) {
  var box = byId('toasts');
  var node = el('div', { class: 'toast-msg', text: message });
  box.appendChild(node);
  setTimeout(function () { node.remove(); }, 2600);
}

function copy(value, what) {
  navigator.clipboard.writeText(value).then(
    function () { toast('copied the ' + what); },
    function () { toast('could not copy'); }
  );
}

/* --------------------------------------------------------------- formats */

function timeAgo(iso) {
  if (!iso) return '';
  var mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  var hours = Math.floor(mins / 60);
  if (hours < 24) return hours + 'h ago';
  return Math.floor(hours / 24) + 'd ago';
}

function shortTime(iso) {
  if (!iso) return '';
  var d = new Date(iso);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function fmtMs(ms) {
  if (!ms && ms !== 0) return '';
  return ms < 1000 ? ms + 'ms' : (Math.round(ms / 100) / 10) + 's';
}

function tail(path) {
  var parts = String(path).split('/');
  return parts.length < 3 ? String(path) : '…/' + parts.slice(-2).join('/');
}

/** What a step checked, in the author's words when there are any. */
function stepClaim(step) {
  if (step.intent) return step.intent;
  return step.action + (step.selector ? ' ' + step.selector : '');
}

/**
 * The label GRIM calls a "failure family": which kind of problem this is.
 * Taken from the defect the run already attributed to this step, never guessed
 * — an unclassified failure says so rather than being filed somewhere.
 */
function familyOf(bundle, step) {
  var defect = (bundle.defects || []).filter(function (d) { return d.stepIndex === step.index; })[0];
  if (defect) return defect.category;
  if (step.status !== 'passed') return 'unclassified';
  return null;
}

var FAMILY_NOTE = {
  functional: 'the test and the application disagree about what the page does',
  usability: 'the page worked, but something got in the way of using it',
  accessibility: 'the control is there but cannot be reached the way a test — or a screen reader — reaches it',
  backend: 'a request the page made did not succeed; no amount of selector work repairs this',
  unclassified: 'the step failed without a defect being attributed to it'
};

/** Every call the page made during this run, flattened for the trace tab. */
function allCalls(bundle) {
  var calls = [];
  (bundle.steps || []).forEach(function (step) {
    (step.network || []).forEach(function (call) { calls.push(call); });
    if (step.request) {
      calls.push({
        method: step.request.method, url: step.request.url,
        status: step.request.status, durationMs: step.request.durationMs, mine: true
      });
    }
  });
  return calls;
}

/** The failed calls that explain a step, if any — GRIM's "blocked_by". */
function blockers(step) {
  return (step.network || []).filter(function (c) {
    return c.errorText !== undefined || (typeof c.status === 'number' && c.status >= 400);
  });
}

/** The flow file this run came from, when the panel can see one. */
function flowPathFor(name) {
  var exact = S.flows.filter(function (f) { return f.name === name; })[0];
  if (exact) return exact.path;
  var byFile = S.flows.filter(function (f) {
    return f.path.split('/').pop().replace(/\.flow\.json$/i, '') === name;
  })[0];
  return byFile ? byFile.path : null;
}

/* -------------------------------------------------------------- grouping */

/**
 * Runs, grouped the way GRIM groups cycles: one row per flow, and one chip per
 * run of it, oldest to newest. S.proofs arrives newest first.
 */
function tasks() {
  var byName = {};
  var order = [];
  S.proofs.forEach(function (proof) {
    if (!byName[proof.name]) { byName[proof.name] = []; order.push(proof.name); }
    byName[proof.name].push(proof);
  });
  return order.map(function (name) {
    var cycles = byName[name].slice().reverse();
    var latest = cycles[cycles.length - 1];
    return {
      key: name,
      name: name,
      cycles: cycles,
      latest: latest,
      origin: latest.generatedBy ? latest.generatedBy.sourceUrl : 'authored',
      generated: latest.generatedBy
    };
  });
}

/** Consecutive failures at the end of a flow's history — GRIM's escalation. */
function failStreak(task) {
  var streak = 0;
  for (var i = task.cycles.length - 1; i >= 0; i -= 1) {
    if (task.cycles[i].status !== 'passed') streak += 1; else break;
  }
  return streak;
}

function groups() {
  var map = {};
  var order = [];
  tasks().forEach(function (task) {
    if (!map[task.origin]) { map[task.origin] = []; order.push(task.origin); }
    map[task.origin].push(task);
  });
  return order.map(function (origin) {
    return { origin: origin, generated: map[origin][0].generated, tasks: map[origin] };
  });
}

function runningJobs() {
  return S.jobs.filter(function (job) { return job.status === 'running'; });
}

/* ------------------------------------------------------------ live progress */

/**
 * The bar and the time estimate for a run in flight.
 *
 * Built once per render and then updated *in place* — never re-created. The
 * page deliberately re-renders only when the data fingerprint changes, because
 * replacing every node on a five-second poll steals the click that lands in the
 * same tick. Progress changes every step, so putting it in that fingerprint
 * would reintroduce exactly the problem the fingerprint exists to solve. The
 * nodes register here instead, and tickProgress() writes to them.
 */
function progressBar(job) {
  var fill = el('i');
  var bar = el('div', { class: 'pbar' }, [fill]);
  var steps = el('span', { class: 'steps' });
  var etaText = el('span', {});
  var eta = el('span', { class: 'eta' }, [
    // A clock: the face, and the hands at a readable angle.
    svg(['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3.5 2']),
    etaText
  ]);
  var node = el('div', { class: 'prog', role: 'progressbar', 'aria-label': 'run progress' }, [
    steps, bar, eta
  ]);

  var live = { jobId: job.id, node: node, bar: bar, fill: fill, steps: steps, eta: eta, etaText: etaText };
  S.bars.push(live);
  paintProgress(live, job.progress, 0);
  return node;
}

/** Write one bar's current state. "age" is ms since the server last spoke. */
function paintProgress(live, progress, age) {
  var done = (progress && progress.done) || 0;
  var total = progress && progress.total;

  if (total) {
    var pct = Math.max(0, Math.min(100, Math.round((done / total) * 100)));
    live.bar.classList.remove('wait');
    live.fill.style.width = pct + '%';
    live.steps.textContent = pct + '% · ' + done + ' / ' + total + ' steps';
    live.node.setAttribute('aria-valuenow', String(pct));
  } else if (typeof (progress && progress.percent) === 'number') {
    // No steps to divide, but the command names the phase it has reached — see
    // PHASE_LINES in ui/jobs.ts. Coarse, and it only moves when the work does.
    var phasePct = Math.max(0, Math.min(100, Math.round(progress.percent)));
    live.bar.classList.remove('wait');
    live.fill.style.width = phasePct + '%';
    live.steps.textContent = phasePct + '%';
    live.node.setAttribute('aria-valuenow', String(phasePct));
  } else {
    // Nothing to divide by. Say what is known — the count — and let the bar
    // pace rather than claim a fraction it cannot support.
    live.bar.classList.add('wait');
    live.fill.style.width = '';
    live.steps.textContent = done > 0 ? done + ' steps' : 'starting…';
    live.node.removeAttribute('aria-valuenow');
  }

  var etaMs = progress && progress.etaMs;
  if (etaMs === null || etaMs === undefined) {
    // A phase name is a better answer than "estimating…" — it says what is
    // happening rather than admitting we cannot say when it ends.
    live.etaText.textContent = (progress && progress.phase) || 'estimating…';
    return;
  }
  // Counted down locally between polls, so the number moves at the rate a
  // person expects instead of jumping every five seconds.
  var left = Math.max(0, etaMs - age);
  live.etaText.textContent = left < 1000 ? 'finishing' : '~' + fmtLeft(left) + ' left';
}

/** A duration a person reads at a glance: "40s", "~2m 10s", "~1h 4m". */
function fmtLeft(ms) {
  var total = Math.round(ms / 1000);
  if (total < 60) return total + 's';
  var minutes = Math.floor(total / 60);
  var seconds = total % 60;
  if (minutes < 60) return seconds === 0 ? minutes + 'm' : minutes + 'm ' + seconds + 's';
  var hours = Math.floor(minutes / 60);
  return hours + 'h ' + (minutes % 60) + 'm';
}

/**
 * Repaint every live bar, once a second.
 *
 * Two things change between polls and only one of them comes from the server:
 * the step count arrives with the next /api/jobs poll, and the estimate ticks down
 * by itself. Both are written straight onto the existing nodes, so nothing in
 * the page is replaced and no click is lost.
 */
function tickProgress() {
  if (S.bars.length === 0) return;
  var age = Date.now() - S.jobsAt;
  S.bars = S.bars.filter(function (live) {
    if (!live.node.isConnected) return false;
    var job = S.jobs.filter(function (j) { return j.id === live.jobId; })[0];
    if (!job || job.status !== 'running') return false;
    paintProgress(live, job.progress, age);
    return true;
  });
}

/* ---------------------------------------------------------------- shared */

function verdictChip(kind, label) {
  return el('span', { class: 'chip ' + kind, text: label });
}

function loopRail(slots, size) {
  var rail = el('span', {
    class: 'rail' + (size === 'lg' ? ' lg' : ''), role: 'img',
    'aria-label': 'the last three runs: ' + slots.join(', ')
  });
  for (var i = 0; i < 3; i += 1) {
    rail.appendChild(el('i', { class: slots[i] && slots[i] !== 'empty' ? slots[i] : null }));
  }
  return rail;
}

function railFor(task, isRunning) {
  var slots = task.cycles.slice(-3).map(function (c) { return c.status === 'passed' ? 'ok' : 'bad'; });
  if (isRunning && slots.length < 3) slots.push('run');
  while (slots.length < 3) slots.push('empty');
  return loopRail(slots);
}

/* ------------------------------------------------------------- the shell */

var NAV = [
  { section: 'Operations' },
  { id: 'runs', label: 'Runs and proof', count: function () { return tasks().length; },
    icon: ['m3 17 2 2 4-4', 'm3 7 2 2 4-4', 'M13 6h8', 'M13 12h8', 'M13 18h8'] },
  { id: 'history', label: 'Run history', count: function () { return S.proofs.length; },
    icon: ['M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8', 'M3 3v5h5', 'M12 7v5l4 2'] },
  { section: 'What the runs taught' },
  { id: 'healed', label: 'Healed selectors', count: function () { return S.cache.length; },
    icon: ['M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z', 'm9 12 2 2 4-4'] },
  { id: 'attention', label: 'Needs a human', count: function () { return attentionItems().length; },
    alert: function () { return attentionItems().length > 0; },
    icon: ['M18 11V6a2 2 0 0 0-4 0', 'M14 10V4a2 2 0 0 0-4 0v2', 'M10 10.5V6a2 2 0 0 0-4 0v8', 'M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15'] },
  { id: 'reports', label: 'Reports', count: function () { return S.reports.length; },
    icon: ['M4 4h11l5 5v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z', 'M14 4v6h6', 'M8 14h8', 'M8 18h5'] },
  { section: 'Machinery' },
  { id: 'keys', label: 'Models and keys', count: function () { return keyCount(); },
    alert: function () { return unkeyedRoles().length > 0; },
    icon: ['M15.5 7.5a3.5 3.5 0 1 1-4.6 3.32L4 18l-1.5-1.5L4 15l1.5 1.5L7 15l1.5 1.5 2.4-2.4A3.5 3.5 0 0 1 15.5 7.5z'] },
  { section: 'Elsewhere' },
  { id: 'panel', label: 'Command panel', href: '/', count: function () { return S.meta ? S.meta.commands.length : 0; },
    icon: ['M4 17h6', 'm4 7 4 4-4 4', 'M14 7h6', 'M14 12h6', 'M14 17h6'] }
];

function renderSidebar() {
  var side = byId('nav');
  clear(side);
  NAV.forEach(function (item) {
    if (item.section) {
      side.appendChild(el('div', { class: 'nav-label', text: item.section }));
      return;
    }
    var count = item.count();
    side.appendChild(el('button', {
      type: 'button',
      class: 'nav-item' + (!item.href && S.view === item.id ? ' active' : ''),
      'aria-current': !item.href && S.view === item.id ? 'page' : null,
      title: item.href ? 'the command-first panel: every wowlidator command, with its manual' : null,
      onclick: function () { if (item.href) location.href = item.href; else show(item.id); }
    }, [
      svg(item.icon),
      el('span', { class: 'txt', text: item.label }),
      el('span', { class: 'nav-count' + (item.alert && item.alert() ? ' alert' : ''), text: String(count) })
    ]));
  });

  var foot = byId('foot');
  clear(foot);
  foot.appendChild(el('span', { class: S.online ? 'dot' : 'dot off' }));
  foot.appendChild(el('div', {}, [
    document.createTextNode(S.online ? 'panel connected · ' + location.port : 'panel unreachable · showing stale data'),
    el('span', { class: 'paths', text: S.meta ? tail(S.meta.paths.proofDir) : '' })
  ]));
}

function show(view) {
  S.view = view;
  location.hash = view;
  renderSidebar();
  render();
}

function pageHead(title, sub, action) {
  return el('div', { class: 'page-head' }, [
    el('div', {}, [el('h1', { text: title }), el('div', { class: 'sub', text: sub })]),
    el('span', { class: 'spacer' }),
    action
  ]);
}

function startButton(size) {
  return el('button', {
    type: 'button', class: 'btn primary' + (size === 'md' ? ' md' : ''),
    disabled: !S.online, title: S.online ? null : 'the panel cannot reach its own server — nothing can be started',
    onclick: openStartModal, text: '+ Start verification'
  });
}

function render() {
  var main = byId('main');
  clear(main);
  // Every node below is about to be rebuilt, so anything registered against the
  // old ones is gone. They re-register as they are built.
  S.bars = [];
  if (S.view === 'runs') renderRuns(main);
  else if (S.view === 'history') renderHistory(main);
  else if (S.view === 'healed') renderHealed(main);
  else if (S.view === 'attention') renderAttention(main);
  else if (S.view === 'reports') renderReports(main);
  else if (S.view === 'keys') renderKeys(main);
}

/* ------------------------------------------------------- runs and proof */

function renderRuns(main) {
  main.appendChild(pageHead(
    'Runs and proof',
    'Every flow wowlidator has run, with its latest verdict and the evidence behind it — the last three runs are the rail on the left.',
    startButton('md')
  ));

  if (!S.online) {
    main.appendChild(el('div', { class: 'warn-banner', role: 'status' }, [
      svg(['M12 9v4', 'M12 17h.01', 'M10.36 3.6 2.32 17a2 2 0 0 0 1.71 3h15.94a2 2 0 0 0 1.71-3L13.64 3.6a2 2 0 0 0-3.28 0z']),
      el('div', {}, [
        el('b', { text: 'The panel cannot reach its own server' }),
        el('span', { class: 'fix', text: 'What you see below is the last data that arrived. Restart it with "wowlidator ui" and this page reconnects by itself.' }),
        el('div', { class: 'acts' }, [
          el('button', { type: 'button', class: 'btn', text: 'Try again', onclick: function () { refresh(); } })
        ])
      ])
    ]));
  }

  main.appendChild(statsStrip());

  var live = runningJobs();
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
        class: 'row', role: 'button', tabindex: '0',
        onclick: function () { openJobDrawer(job); }
      }, [
        loopRail(['run', 'empty', 'empty']),
        el('div', { class: 'task-cell' }, [
          el('div', { class: 'task-name', text: job.title }),
          el('div', { class: 'task-sub', text: job.commandLine })
        ]),
        verdictChip('running', 'running'),
        progressBar(job),
        el('span', { class: 'when', text: 'started ' + shortTime(job.startedAt) }),
        el('div', { class: 'actions' }, [
          el('button', { type: 'button', class: 'btn', text: 'Output', onclick: function (e) { e.stopPropagation(); openJobDrawer(job); } }),
          el('button', { type: 'button', class: 'btn', text: 'Stop', onclick: function (e) { e.stopPropagation(); stopJob(job.id); } })
        ])
      ]));
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

function statsStrip() {
  var startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  var today = S.proofs.filter(function (p) { return new Date(p.finishedAt || p.startedAt).getTime() >= startOfDay.getTime(); });
  var recent = S.proofs.slice(0, 7);
  var passed = recent.filter(function (p) { return p.status === 'passed'; }).length;
  var pct = recent.length > 0 ? Math.round((passed / recent.length) * 100) : 100;
  var live = runningJobs();
  var stuck = tasks().filter(function (t) { return failStreak(t) >= 3; }).length;
  var open = attentionItems().length;

  return el('div', { class: 'stats' }, [
    el('div', { class: 'stat' }, [
      el('div', { class: 'k', text: 'Runs today' }),
      el('div', { class: 'v' }, [document.createTextNode(String(today.length)), el('small', { text: 'runs' })]),
      el('div', { class: 'n', text: S.proofs[0] ? 'latest ' + shortTime(S.proofs[0].finishedAt) : 'nothing yet' })
    ]),
    el('div', { class: 'stat' }, [
      el('div', { class: 'k', text: 'Proved' }),
      el('div', { class: 'v', style: 'color:var(--ok)', text: pct + '%' }),
      el('div', { class: 'n', text: passed + ' of the last ' + recent.length + ' runs' })
    ]),
    el('div', { class: 'stat' }, [
      el('div', { class: 'k', text: 'Running' }),
      el('div', { class: 'v', style: 'color:var(--info)', text: String(live.length) }),
      el('div', { class: 'n', text: live[0] ? live[0].title + ' · in flight' : 'nothing running' })
    ]),
    el('div', { class: 'stat' }, [
      el('div', { class: 'k', text: 'Needs a human' }),
      el('div', { class: 'v', style: 'color:var(--warn)', text: String(stuck + open) }),
      el('div', { class: 'n', text: stuck + ' flow(s) failing repeatedly · ' + open + ' defect(s)' })
    ])
  ]);
}

function renderGroup(group) {
  var section = el('section', { class: 'group' });
  var head = el('div', { class: 'group-head' });

  if (group.generated) {
    head.appendChild(el('span', { class: 'badge gen', text: 'generated' }));
    head.appendChild(el('b', { text: group.origin }));
    head.appendChild(el('span', { class: 'chip plain', text: group.generated.model }));
    head.appendChild(el('span', { class: 'meta', style: 'margin-left:auto', text: group.tasks.length + ' flow(s)' }));
  } else {
    head.appendChild(el('span', { class: 'avatar', text: 'F' }));
    head.appendChild(el('b', { text: 'Authored flows' }));
    head.appendChild(el('span', { class: 'meta', text: 'written by hand · ' + group.tasks.length + ' flow(s)' }));
    var busy = runningJobs().filter(function (j) { return j.browser; }).length > 0;
    head.appendChild(el('span', {
      class: 'state' + (busy ? ' busy' : ''),
      text: busy ? 'the browser is in use — one run at a time' : 'the browser is free'
    }));
  }
  section.appendChild(head);

  var rows = el('div', { class: 'card rows' });
  group.tasks.forEach(function (task) {
    rows.appendChild(taskRow(task));
    if (S.openTask === task.key) rows.appendChild(taskDetail(task));
  });
  section.appendChild(rows);
  return section;
}

function taskRow(task) {
  var latest = task.latest;
  var jobId = S.runningFor[task.key];
  var job = S.jobs.filter(function (j) { return j.id === jobId && j.status === 'running'; })[0];
  var isRunning = job !== undefined;
  var streak = failStreak(task);
  var escalated = streak >= 3;
  var open = S.openTask === task.key;
  var flowPath = flowPathFor(task.name);

  var chip;
  if (isRunning) chip = verdictChip('running', 'running');
  else if (escalated) chip = verdictChip('escalated', 'needs a human');
  else if (latest.status !== 'passed') chip = verdictChip('feedback', latest.status);
  else if (latest.quarantined) chip = verdictChip('blocked', 'quarantined');
  else {
    chip = verdictChip('verified', latest.coverage === null
      ? 'proved'
      : 'proved · ' + Math.round(latest.coverage * 100) + '% covered');
  }

  var sub;
  if (isRunning) sub = el('div', { class: 'task-sub live', text: 'running ' + job.commandLine });
  else if (escalated) sub = el('div', { class: 'task-sub fail', text: 'failed ' + streak + ' runs in a row: ' + (latest.error || firstFailure(latest) || 'still broken') });
  else sub = el('div', { class: 'task-sub', text: flowPath ? tail(flowPath) : latest.runId });

  var counts = el('span', { class: 'counts' + (isRunning ? ' none' : '') });
  if (isRunning) counts.textContent = '—';
  else {
    counts.appendChild(el('b', { text: String(latest.passed) }));
    counts.appendChild(document.createTextNode(' passed · '));
    if (latest.failed > 0) counts.appendChild(el('b', { style: 'color:var(--bad)', text: latest.failed + ' failed' }));
    else counts.appendChild(document.createTextNode('0 failed'));
    if (latest.jitHeals > 0) {
      counts.appendChild(document.createTextNode(' · '));
      counts.appendChild(el('b', { style: 'color:var(--warn)', text: latest.jitHeals + ' healed' }));
    }
  }

  var runAgainTitle = null;
  if (isRunning) runAgainTitle = 'this flow is running — wait for the result';
  else if (!flowPath) runAgainTitle = 'the .flow.json for this run is not visible from here, so there is nothing to re-run';

  return el('div', {
    class: 'row' + (open ? ' open' : ''), role: 'button', tabindex: '0',
    'aria-expanded': open ? 'true' : 'false',
    onclick: function () { toggleTask(task); },
    onkeydown: function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleTask(task); }
    }
  }, [
    railFor(task, isRunning),
    el('div', { class: 'task-cell' }, [el('div', { class: 'task-name', text: task.name }), sub]),
    chip,
    counts,
    el('span', { class: 'when', text: isRunning ? 'started ' + shortTime(job.startedAt) : timeAgo(latest.finishedAt) }),
    el('div', { class: 'actions', onclick: function (e) { e.stopPropagation(); } }, [
      el('button', {
        type: 'button', class: 'btn', disabled: isRunning || !flowPath, title: runAgainTitle,
        text: 'Run again', onclick: function () { startRun(task.key, { flow: flowPath }); }
      }),
      el('button', {
        type: 'button', class: 'btn' + (latest.status !== 'passed' && flowPath && !isRunning ? ' accent' : ''),
        disabled: isRunning || !flowPath || latest.status !== 'failed',
        title: latest.status !== 'failed' ? 'nothing failed — there is nothing to repair' : runAgainTitle,
        text: 'Repair', onclick: function () { startRun(task.key, { flow: flowPath, repair: true }); }
      })
    ])
  ]);
}

function firstFailure(card) {
  var bundle = S.bundles[card.runId];
  if (!bundle) return null;
  var step = bundle.steps.filter(function (s) { return s.status !== 'passed'; })[0];
  return step ? stepClaim(step) : null;
}

function toggleTask(task) {
  if (S.openTask === task.key) {
    S.openTask = null;
    render();
    return;
  }
  S.openTask = task.key;
  var runId = S.cycleOf[task.key] || task.latest.runId;
  S.cycleOf[task.key] = runId;
  render();
  loadBundle(runId).then(render);
}

function taskDetail(task) {
  var runId = S.cycleOf[task.key] || task.latest.runId;
  var card = task.cycles.filter(function (c) { return c.runId === runId; })[0] || task.latest;
  var bundle = S.bundles[card.runId];
  var flowPath = flowPathFor(task.name);

  var detail = el('div', { class: 'detail' });
  detail.appendChild(el('div', { class: 'dh' }, [
    el('span', { class: 'cap', text: 'Run timeline' }),
    el('span', { class: 'mono', text: flowPath || task.name })
  ]));

  var cycles = el('div', { class: 'cycles' });
  task.cycles.forEach(function (c, index) {
    var selected = c.runId === card.runId;
    var chip = el('div', {
      class: 'cycle' + (selected ? ' active' : ''),
      onclick: function () { S.cycleOf[task.key] = c.runId; render(); loadBundle(c.runId).then(render); }
    }, [
      el('div', { class: 'ct' }, [
        el('span', { class: 'cd ' + (c.status === 'passed' ? (c.jitHeals > 0 ? 'warn' : 'pass') : 'fail') }),
        document.createTextNode('Run ' + (index + 1) + ' · ' + fmtMs(c.durationMs)),
        index === task.cycles.length - 1 ? el('span', { class: 'now', text: 'latest' }) : null
      ]),
      el('div', { class: 'cm', text: c.passed + ' passed / ' + c.failed + ' failed · ' + timeAgo(c.finishedAt) })
    ]);
    // The trend line is GRIM's "the code moved between these two cycles", with
    // the signal wowlidator actually has: how this run compares to the last.
    if (c.trend && c.trend !== 'stable' && c.trend !== 'first-run') {
      chip.appendChild(el('div', { class: 'drift', title: c.trendMessage || '', text: c.trend }));
    }
    cycles.appendChild(chip);
  });
  detail.appendChild(cycles);

  if (!bundle) {
    detail.appendChild(el('div', { class: 'mono', style: 'padding:12px', text: 'reading the proof bundle…' }));
  } else {
    detail.appendChild(checksTable(bundle));
  }

  // The console output of the job that produced this run, collapsed under the
  // report card. Without this, a finished job's output was orphaned: the live
  // row disappears the moment the proof lands, and the stream it carried —
  // authoring narration, agent turns, download/progress lines — became
  // unreachable from the page that shows the run it produced.
  var producedBy = jobForRun(card.runId);
  if (producedBy) detail.appendChild(outputSection(card.runId, producedBy));

  var hasFilm = bundle && bundle.video && bundle.video.data;
  detail.appendChild(el('div', { class: 'detail-foot' }, [
    hasFilm
      ? el('button', {
          type: 'button', class: 'btn accent', text: 'View actual flow',
          title: 'Play the recording of the mock user performing this task, with each step subtitled and the failure highlighted.',
          onclick: function () { openFlowPlayer(bundle); }
        })
      : el('button', {
          type: 'button', class: 'btn', disabled: !flowPath, text: 'Record actual flow',
          title: flowPath
            ? 'Re-runs this flow with the recording kept end to end (video: always), so the film of the mock user exists even when everything passes.'
            : 'the .flow.json for this run is not visible from here',
          onclick: function () { startRun(task.key, { flow: flowPath, video: 'always' }); }
        }),
    el('button', {
      type: 'button', class: 'btn accent', text: 'Open the raw proof',
      onclick: function () { window.open('/view?path=' + encodeURIComponent(card.path), '_blank'); }
    }),
    el('button', {
      type: 'button', class: 'btn', disabled: !flowPath, text: 'Run again',
      title: flowPath ? null : 'the .flow.json for this run is not visible from here',
      onclick: function () { startRun(task.key, { flow: flowPath }); }
    }),
    el('span', { class: 'why', text: 'Every step here can be re-run by hand — the evidence panel carries the command.' })
  ]));

  return detail;
}

/* -------------------------------------------------- command output section */

/**
 * The job whose output produced this run, found by matching the run id
 * against the artifact paths the job announced ("proof <dir>/<runId>.json").
 * Null for a run started from a terminal — this server never saw its output,
 * and an empty section would be a control that does nothing.
 */
function jobForRun(runId) {
  for (var i = S.jobs.length - 1; i >= 0; i--) {
    var job = S.jobs[i];
    var artifacts = job.artifacts || [];
    for (var j = 0; j < artifacts.length; j++) {
      if (artifacts[j].path && artifacts[j].path.indexOf(runId) !== -1) return job;
    }
  }
  return null;
}

/** Collapsed by default: the evidence above is the point, the console is the receipts. */
function outputSection(runId, job) {
  var open = S.outOpen[runId] === true;
  var section = el('div', { class: 'card', style: 'margin-top:var(--s3)' });
  section.appendChild(el('button', {
    type: 'button', class: 'btn', 'aria-expanded': open ? 'true' : 'false',
    text: (open ? '▾' : '▸') + ' Command output (' + (job.lineCount || 0) + ' lines)',
    onclick: function () {
      S.outOpen[runId] = !open;
      if (!open && !S.jobLines[job.id]) {
        api('/api/jobs/' + encodeURIComponent(job.id)).then(function (body) {
          S.jobLines[job.id] = (body.job && body.job.lines) || [];
          render();
        })['catch'](function () {
          S.jobLines[job.id] = [{ stream: 'err', text: 'output no longer available — the panel has restarted since this run' }];
          render();
        });
      }
      render();
    }
  }));
  if (open) {
    var lines = S.jobLines[job.id];
    var pane = el('div', { class: 'mono', style: 'max-height:300px;overflow:auto;padding:8px 12px;white-space:pre-wrap;font-size:var(--fs-xs)' });
    if (!lines) {
      pane.appendChild(el('div', { style: 'color:var(--faint)', text: 'reading the output…' }));
    } else {
      lines.forEach(function (line) {
        pane.appendChild(el('div', {
          style: line.stream === 'err' ? 'color:var(--bad)' : null,
          text: line.text
        }));
      });
    }
    section.appendChild(pane);
  }
  return section;
}

/* --------------------------------------------------------- checks table */

function checksTable(bundle) {
  if (!bundle.steps || bundle.steps.length === 0) {
    return el('div', { class: 'mono', style: 'padding:12px', text: 'this run recorded no steps' });
  }

  var body = el('tbody');
  bundle.steps.forEach(function (step) {
    var passed = step.status === 'passed';
    var family = familyOf(bundle, step);
    var failedCalls = blockers(step);

    var what = el('td', {}, [document.createTextNode(stepClaim(step))]);
    if (family) what.appendChild(el('span', { class: 'tag', title: 'the kind of problem this is — a label from the run, not the raw evidence', text: family }));

    var how = el('td', { style: 'color:var(--muted)' });
    var repro = step.resolvedSelector || step.selector ||
      (step.request ? step.request.method + ' ' + step.request.url : null);
    how.appendChild(repro ? el('code', { text: repro }) : document.createTextNode('—'));
    if (failedCalls.length > 0) {
      how.appendChild(el('button', {
        type: 'button', class: 'link', style: 'margin-left:8px;color:var(--warn)',
        text: 'backend → ' + (failedCalls[0].status || 'no response'),
        onclick: function (e) { e.stopPropagation(); openEvidence(bundle, step, 'trace'); }
      }));
    }

    var verdict = el('td', {}, [
      el('span', { class: 'verdict ' + (passed ? 'pass' : 'fail'), text: passed ? 'passed' : 'failed' })
    ]);
    // A pass that only happened because a selector was repaired is a pass to
    // look at: the test and the page have drifted apart, and the next change
    // breaks it for real. GRIM marks the same doubt on a vacuous PASS.
    if (passed && step.heal) {
      verdict.appendChild(el('span', {
        class: 'tag warn',
        title: 'this step only passed after the healer rewrote its selector — the flow and the page have drifted apart',
        text: 'healed'
      }));
    }

    // How long the step took, next to what it checked. A step that passed in
    // 4s is a step that nearly failed: the fast path is 2s, so anything much
    // above it means a rung beyond the fast path was walked, or the page was slow
    // enough that the next change breaks it.
    var slow = step.durationMs >= 2000;
    var took = el('td', { class: 'col-r' }, [
      el('span', {
        class: 'mono',
        style: slow ? 'color:var(--warn)' : null,
        title: slow ? 'longer than the 2s fast-path budget — this step is close to the edge' : null,
        text: fmtMs(step.durationMs)
      })
    ]);

    body.appendChild(el('tr', {}, [
      what, how, took, verdict,
      el('td', { class: 'col-r' }, [
        el('button', { type: 'button', class: 'link', text: 'See evidence', onclick: function () { openEvidence(bundle, step, null); } })
      ])
    ]));
  });

  var total = bundle.steps.reduce(function (sum, step) { return sum + (step.durationMs || 0); }, 0);

  return el('table', { class: 'tbl' }, [
    el('thead', {}, [
      el('tr', {}, [
        el('th', { style: 'width:34%', text: 'What was checked' }),
        el('th', { text: 'How to prove it again' }),
        el('th', { class: 'col-r', style: 'width:90px', text: 'Took' }),
        el('th', { style: 'width:110px', text: 'Result' }),
        el('th', { style: 'width:112px' })
      ])
    ]),
    body,
    el('tfoot', {}, [
      el('tr', {}, [
        el('td', { colspan: '2', class: 'mono', text: bundle.steps.length + ' steps' }),
        el('td', { class: 'col-r mono', title: 'the sum of the steps; the run itself also spends time connecting and reporting', text: fmtMs(total) }),
        el('td', { colspan: '2', class: 'mono', text: 'wall clock ' + fmtMs(bundle.durationMs) })
      ])
    ])
  ]);
}

/* ------------------------------------------------------- evidence drawer */

function openEvidence(bundle, step, tab) {
  S.drawer = { kind: 'evidence', bundle: bundle, step: step, tab: tab || (step.status === 'passed' ? 'trace' : 'error') };
  renderDrawer();
}

function closeDrawer() {
  if (S.es) { S.es.close(); S.es = null; }
  S.drawer = null;
  renderDrawer();
}

function renderDrawer() {
  var host = byId('drawer');
  clear(host);
  if (!S.drawer) return;
  var panel = S.drawer.kind === 'evidence' ? evidencePanel(S.drawer) : jobPanel(S.drawer);
  var backdrop = el('div', { class: 'drawer-backdrop', onclick: function (e) { if (e.target === backdrop) closeDrawer(); } }, [panel]);
  host.appendChild(backdrop);
}

function drawerTab(id, label) {
  return el('button', {
    type: 'button', class: 'btn' + (S.drawer.tab === id ? ' primary' : ''),
    text: label, onclick: function () { S.drawer.tab = id; renderDrawer(); }
  });
}

function evidencePanel(view) {
  var bundle = view.bundle;
  var step = view.step;
  var passed = step.status === 'passed';
  var flowPath = flowPathFor(bundle.name);
  var reproCommand = flowPath
    ? 'wowlidator run ' + flowPath
    : JSON.stringify({ action: step.action, selector: step.selector || undefined }, null, 2);

  var panel = el('aside', { class: 'drawer', role: 'dialog', 'aria-label': 'Evidence', onclick: function (e) { e.stopPropagation(); } });
  panel.appendChild(el('div', { class: 'top' }, [
    el('b', { text: 'Evidence' }),
    el('span', { class: 'chip ' + (passed ? 'verified' : 'feedback'), text: passed ? 'passed' : 'failed' }),
    el('button', { type: 'button', class: 'x', 'aria-label': 'Close', text: '✕', onclick: closeDrawer })
  ]));
  panel.appendChild(el('div', { class: 'claim', text: stepClaim(step) }));
  panel.appendChild(el('div', { class: 'tabs' }, [
    drawerTab('error', 'Error'),
    drawerTab('trace', 'Trace'),
    drawerTab('fix', 'Fix' + (fixCount(bundle, step) > 0 ? ' (' + fixCount(bundle, step) + ')' : ''))
  ]));

  if (view.tab === 'error') evidenceError(panel, bundle, step);
  else if (view.tab === 'trace') evidenceTrace(panel, bundle, step);
  else evidenceFix(panel, bundle, step);

  panel.appendChild(el('div', { class: 'acts' }, [
    el('button', { type: 'button', class: 'btn', text: 'Copy the command', onclick: function () { copy(reproCommand, 'command'); } }),
    step.selector ? el('button', { type: 'button', class: 'btn', text: 'Copy the selector', onclick: function () { copy(step.resolvedSelector || step.selector, 'selector'); } }) : null,
    el('button', { type: 'button', class: 'btn', text: 'Copy the run id', onclick: function () { copy(bundle.runId, 'run id'); } })
  ]));
  return panel;
}

function fixCount(bundle, step) {
  var count = 0;
  if (step.heal) count += 1;
  if (step.agent) count += 1;
  count += (bundle.defects || []).filter(function (d) { return d.stepIndex === step.index; }).length;
  return count;
}

function evidenceError(panel, bundle, step) {
  var family = familyOf(bundle, step);
  if (family) {
    panel.appendChild(el('div', { class: 'callout' }, [
      el('span', { class: 'mono', style: 'font-weight:700', text: family }),
      document.createTextNode(FAMILY_NOTE[family] ? ' — ' + FAMILY_NOTE[family] : ''),
      el('div', { style: 'font-size:10.5px;opacity:.75;margin-top:2px', text: 'a label put on it by the run — the raw evidence below is untouched' })
    ]));
  }

  panel.appendChild(el('div', { class: 'cap', text: 'Raw output (the facts)' }));
  panel.appendChild(el('div', { class: 'repro', text: step.error || (step.status === 'passed' ? 'this step passed — nothing was reported' : 'the step failed without an error message') }));

  panel.appendChild(el('div', { class: 'cap', text: 'How this step resolved' }));
  var kv = el('div', {});
  [
    ['action', step.action],
    ['selector as written', step.selector || '—'],
    ['selector that resolved', step.resolvedSelector || '—'],
    ['rung', step.resolution || 'no selector to resolve'],
    ['took', fmtMs(step.durationMs)],
    ['page', step.url || '—']
  ].forEach(function (pair) {
    kv.appendChild(el('div', { class: 'kv' }, [el('b', { text: pair[0] + ': ' }), document.createTextNode(String(pair[1]))]));
  });
  panel.appendChild(kv);

  if (step.detail && Object.keys(step.detail).length > 0) {
    panel.appendChild(el('div', { class: 'cap', text: 'What the step recorded' }));
    panel.appendChild(el('div', { class: 'repro', text: JSON.stringify(step.detail, null, 2) }));
  }
}

function webmObjectUrl(base64) {
  var bin = atob(base64);
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: 'video/webm' }));
}

function evidenceTrace(panel, bundle, step) {
  // The recording first: a still shows the page either side of a click, and
  // those two images are the same whether the click landed on the right
  // control or on nothing at all. Opened at this step's own moment, so the
  // drawer answers "what did this step do" rather than "here is the run".
  if (bundle.video && bundle.video.data && step.videoOffsetMs !== undefined && step.videoOffsetMs !== null) {
    panel.appendChild(el('div', { class: 'cap', text: 'The run, from this step' }));
    var clip = el('video', { class: 'shot-img', controls: 'controls', preload: 'metadata' });
    // Chrome will not load a data: video — the element sits at readyState 0
    // forever with no error, which reads exactly like a corrupt recording. The
    // same bytes play immediately from a Blob. The URL is cached on the bundle
    // so reopening a step does not decode megabytes of base64 again.
    if (!bundle.__videoUrl) bundle.__videoUrl = webmObjectUrl(bundle.video.data);
    clip.src = bundle.__videoUrl;
    var at = step.videoOffsetMs / 1000;
    clip.addEventListener('loadedmetadata', function () { clip.currentTime = at; });
    panel.appendChild(el('div', { class: 'shot-container' }, [clip]));
  }

  panel.appendChild(el('div', { class: 'cap', text: 'Screenshot taken at this step' }));
  if (step.screenshot) {
    panel.appendChild(el('div', { class: 'shot-container' }, [
      el('img', { class: 'shot-img', alt: 'The page at ' + stepClaim(step), src: 'data:image/jpeg;base64,' + step.screenshot })
    ]));
  } else if (bundle.video && bundle.video.data) {
    panel.appendChild(el('div', { class: 'repro', style: 'color:var(--muted)', text: 'no still — this run was filmed, so stills are kept for failures only' }));
  } else {
    panel.appendChild(el('div', { class: 'repro', style: 'color:var(--muted)', text: 'no screenshot — either evidence was off for this run, or this step never touched the page' }));
  }
  if (step.url) panel.appendChild(el('div', { class: 'path', text: step.url }));

  panel.appendChild(el('div', { class: 'cap', text: 'How to prove it again yourself' }));
  var flowPath = flowPathFor(bundle.name);
  panel.appendChild(el('div', {
    class: 'repro',
    text: flowPath
      ? 'wowlidator run ' + flowPath
      : 'the flow file is not visible from here; this step was:\n' +
        JSON.stringify({ action: step.action, selector: step.selector || undefined }, null, 2)
  }));

  var calls = allCalls(bundle);
  // "Recorded", not "every": the page's traffic is only kept when it is
  // evidence — the step failed, or one of the calls did. A busy SPA issues
  // dozens per interaction, and claiming a quiet page here would be a lie the
  // report itself never tells.
  panel.appendChild(el('div', { class: 'cap', text: 'Calls recorded in this run — ' + bundle.steps.length + ' steps, ' + calls.length + ' calls' }));
  if (calls.length === 0) {
    panel.appendChild(el('div', { class: 'mono', style: 'font-size:12px', text: 'nothing was kept: the page’s traffic is recorded only when it is evidence — when a step failed, or a call did. The test made no HTTP of its own either.' }));
  } else {
    var list = el('div', { class: 'calls' });
    calls.forEach(function (call) {
      var status = call.status === undefined || call.status === null ? null : call.status;
      list.appendChild(el('div', { title: call.url }, [
        el('b', { text: call.method + ' ' }),
        document.createTextNode(call.url + ' '),
        status === null
          ? el('span', { style: 'color:var(--bad)', text: call.errorText || 'no response' })
          : el('span', { style: 'color:' + (status >= 400 ? 'var(--bad)' : 'var(--ok)'), text: String(status) }),
        call.durationMs !== undefined && call.durationMs !== null
          ? el('span', { style: 'color:var(--muted)', text: ' · ' + call.durationMs + 'ms' })
          : null,
        call.mine ? el('span', { style: 'color:var(--muted)', text: ' · made by the test' }) : null
      ]));
    });
    panel.appendChild(list);
  }
}

function evidenceFix(panel, bundle, step) {
  panel.appendChild(el('div', { class: 'callout ai', text: 'What a model proposed — kept apart from the facts in Error and Trace, always.' }));

  var defects = (bundle.defects || []).filter(function (d) { return d.stepIndex === step.index; });
  if (!step.heal && !step.agent && defects.length === 0) {
    panel.appendChild(el('div', { class: 'mono', style: 'font-size:12.5px;color:var(--muted)', text: 'no model was asked about this step. wowlidator only pays for one when determinism runs out.' }));
    return;
  }

  if (step.heal) {
    panel.appendChild(el('div', { class: 'cap', text: 'The repair the healer proposed' }));
    panel.appendChild(el('div', { class: 'repro', text: step.heal.from + '\n  →  ' + step.heal.to }));
    var meta = el('div', {});
    [
      ['strategy', step.heal.strategy],
      ['confidence', Number(step.heal.confidence).toFixed(2)],
      ['model', step.heal.model],
      ['cost', fmtMs(step.heal.latencyMs) + ' · ' + (step.heal.inputTokens || 0) + ' in / ' + (step.heal.outputTokens || 0) + ' out tokens']
    ].forEach(function (pair) {
      meta.appendChild(el('div', { class: 'kv' }, [el('b', { text: pair[0] + ': ' }), document.createTextNode(String(pair[1]))]));
    });
    panel.appendChild(meta);
    if (step.heal.reasoning) {
      panel.appendChild(el('div', { class: 'cap', text: 'Why it says so' }));
      panel.appendChild(el('div', { class: 'repro', text: step.heal.reasoning }));
    }
  }

  if (step.agent) {
    panel.appendChild(el('div', { class: 'cap', text: 'The navigation agent' }));
    panel.appendChild(el('div', { class: 'repro', text: step.agent.goal + '\n\n' + step.agent.summary }));
    panel.appendChild(el('div', { class: 'kv' }, [
      el('b', { text: 'turns: ' }),
      document.createTextNode(step.agent.turns + ' of ' + step.agent.maxSteps + ' · ' + step.agent.model)
    ]));
  }

  if (defects.length > 0) {
    panel.appendChild(el('div', { class: 'cap', text: 'Defects filed against this step' }));
    defects.forEach(function (defect) {
      panel.appendChild(el('div', { class: 'kv' }, [
        el('b', { text: defect.severity + ' · ' + defect.category + ' — ' }),
        document.createTextNode(defect.title)
      ]));
      panel.appendChild(el('div', { class: 'kv', style: 'color:var(--faint)', text: defect.detail }));
    });
  }
}

/* ------------------------------------------------------------ job drawer */

function openJobDrawer(job) {
  S.drawer = { kind: 'job', job: job, lines: [], status: job.status, artifacts: [] };
  renderDrawer();

  if (S.es) S.es.close();
  var es = new EventSource('/api/jobs/' + encodeURIComponent(job.id) + '/events');
  S.es = es;
  es.addEventListener('replay', function (event) {
    var data = JSON.parse(event.data);
    if (!S.drawer || S.drawer.kind !== 'job') return;
    S.drawer.lines = data.lines.slice();
    S.drawer.artifacts = data.artifacts.slice();
    S.drawer.status = data.status;
    renderDrawer();
  });
  es.addEventListener('line', function (event) {
    if (!S.drawer || S.drawer.kind !== 'job') return;
    S.drawer.lines.push(JSON.parse(event.data));
    renderDrawer();
  });
  es.addEventListener('artifact', function (event) {
    if (!S.drawer || S.drawer.kind !== 'job') return;
    S.drawer.artifacts.push(JSON.parse(event.data));
    renderDrawer();
  });
  es.addEventListener('done', function (event) {
    var data = JSON.parse(event.data);
    if (S.drawer && S.drawer.kind === 'job') { S.drawer.status = data.status; renderDrawer(); }
    es.close();
    if (S.es === es) S.es = null;
    refresh();
  });
}

function jobPanel(view) {
  var job = view.job;
  var panel = el('aside', { class: 'drawer', role: 'dialog', 'aria-label': 'Run output', onclick: function (e) { e.stopPropagation(); } });
  panel.appendChild(el('div', { class: 'top' }, [
    el('b', { text: 'Run output' }),
    el('span', { class: 'chip ' + (view.status === 'running' ? 'running' : view.status === 'passed' ? 'verified' : 'feedback'), text: view.status }),
    el('button', { type: 'button', class: 'x', 'aria-label': 'Close', text: '✕', onclick: closeDrawer })
  ]));
  panel.appendChild(el('div', { class: 'claim', text: job.title }));

  panel.appendChild(el('div', { class: 'cap', text: 'How this would have been typed' }));
  panel.appendChild(el('div', { class: 'repro', text: job.commandLine }));

  panel.appendChild(el('div', { class: 'cap', text: 'Output' }));
  var out = el('div', { class: 'repro', style: 'max-height:46vh' });
  view.lines.forEach(function (line) {
    out.appendChild(el('div', { style: line.stream === 'err' ? 'color:var(--bad)' : null, text: line.text || ' ' }));
  });
  panel.appendChild(out);
  // Follow the tail: the interesting line of a live run is the last one.
  setTimeout(function () { out.scrollTop = out.scrollHeight; }, 0);

  if (view.artifacts.length > 0) {
    panel.appendChild(el('div', { class: 'cap', text: 'What it wrote' }));
    var acts = el('div', { class: 'acts' });
    view.artifacts.forEach(function (artifact) {
      acts.appendChild(el('button', {
        type: 'button', class: 'btn', title: artifact.path,
        text: artifact.kind + ' · ' + artifact.path.split('/').pop(),
        onclick: function () { window.open('/view?path=' + encodeURIComponent(artifact.path), '_blank'); }
      }));
    });
    panel.appendChild(acts);
  }

  panel.appendChild(el('div', { class: 'acts' }, [
    el('button', { type: 'button', class: 'btn', text: 'Copy the command', onclick: function () { copy(job.commandLine, 'command'); } }),
    view.status === 'running'
      ? el('button', { type: 'button', class: 'btn', text: 'Stop', onclick: function () { stopJob(job.id); } })
      : null
  ]));
  return panel;
}

/* -------------------------------------------------------------- history */

function renderHistory(main) {
  main.appendChild(pageHead(
    'Run history',
    'Every run, newest first. Click one to see its steps and the evidence behind each of them.',
    clearHistoryButton()
  ));

  // A run in flight has no proof bundle yet, so it cannot be one of the rows
  // below — but it is the run someone just started and the one they are here to
  // watch. It sits above the list until it finishes and becomes a row.
  var live = runningJobs();
  if (live.length > 0) {
    var pending = el('div', { class: 'card rows' });
    live.forEach(function (job) {
      pending.appendChild(el('div', {
        class: 'row', role: 'button', tabindex: '0',
        onclick: function () { openJobDrawer(job); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openJobDrawer(job); } }
      }, [
        loopRail(['run', 'empty', 'empty']),
        el('div', { class: 'task-cell' }, [
          el('div', { class: 'task-name', text: job.title }),
          el('div', { class: 'task-sub', text: 'running — its proof lands here when it finishes' })
        ]),
        verdictChip('running', 'running'),
        progressBar(job),
        el('span', { class: 'when', text: 'started ' + shortTime(job.startedAt) }),
        el('div', { class: 'actions', onclick: function (e) { e.stopPropagation(); } }, [
          el('button', { type: 'button', class: 'btn', text: 'Output', onclick: function () { openJobDrawer(job); } })
        ])
      ]));
    });
    main.appendChild(pending);
  }

  var counts = {
    all: S.proofs.length,
    passed: S.proofs.filter(function (p) { return p.status === 'passed'; }).length,
    failed: S.proofs.filter(function (p) { return p.status === 'failed'; }).length,
    healed: S.proofs.filter(function (p) { return p.jitHeals > 0; }).length
  };
  var filters = el('div', { class: 'filters' });
  [['all', 'All'], ['passed', 'Passed'], ['failed', 'Failed'], ['healed', 'Needed a repair']].forEach(function (pair) {
    filters.appendChild(el('button', {
      type: 'button', class: 'f-pill' + (S.filter === pair[0] ? ' on' : ''),
      text: pair[1] + ' · ' + counts[pair[0]],
      onclick: function () { S.filter = pair[0]; render(); }
    }));
  });
  main.appendChild(filters);

  var shown = S.proofs.filter(function (p) {
    if (S.filter === 'passed') return p.status === 'passed';
    if (S.filter === 'failed') return p.status === 'failed';
    if (S.filter === 'healed') return p.jitHeals > 0;
    return true;
  });

  if (shown.length === 0) {
    main.appendChild(el('div', { class: 'box' }, [
      el('div', { class: 'big', text: 'No runs match' }),
      el('div', { class: 'why', text: S.proofs.length === 0 ? 'Proof bundles land in the proof directory as soon as anything runs.' : 'Try another filter.' })
    ]));
    return;
  }

  var rows = el('div', { class: 'card rows' });
  shown.forEach(function (card) {
    var open = S.openTask === 'history:' + card.runId;
    rows.appendChild(el('div', {
      class: 'row' + (open ? ' open' : ''), role: 'button', tabindex: '0',
      onclick: function () { toggleHistory(card); },
      onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleHistory(card); } }
    }, [
      loopRail([card.status === 'passed' ? 'ok' : 'bad', 'empty', 'empty']),
      el('div', { class: 'task-cell' }, [
        el('div', { class: 'task-name', text: card.name }),
        el('div', { class: 'task-sub', text: card.runId + ' · ' + fmtMs(card.durationMs) + (card.trend ? ' · ' + card.trend : '') })
      ]),
      card.status === 'passed'
        ? verdictChip('verified', card.quarantined ? 'quarantined' : 'proved')
        : verdictChip('feedback', 'failed'),
      el('span', { class: 'counts' }, [
        el('b', { text: String(card.passed) }),
        document.createTextNode(' / ' + card.totalSteps + ' steps')
      ]),
      el('span', { class: 'when', text: timeAgo(card.finishedAt) }),
      el('div', { class: 'actions', onclick: function (e) { e.stopPropagation(); } }, [
        el('button', {
          type: 'button', class: 'btn', text: 'Raw proof',
          onclick: function () { window.open('/view?path=' + encodeURIComponent(card.path), '_blank'); }
        })
      ])
    ]));
    if (open) {
      var bundle = S.bundles[card.runId];
      rows.appendChild(el('div', { class: 'detail' }, [
        bundle ? checksTable(bundle) : el('div', { class: 'mono', style: 'padding:12px', text: 'reading the proof bundle…' })
      ]));
    }
  });
  main.appendChild(rows);
}

/**
 * Clear history, behind a confirm the button holds itself.
 *
 * The click arms it and the second one within a few seconds runs it, rather
 * than a confirm() dialog: a modal dialog blocks this page's event loop, and
 * the panel is polling a run that may be in flight while someone reads it. The
 * armed state is local to the button and forgotten on any re-render, so a stray
 * first click expires instead of waiting to be completed by an unrelated one.
 */
function clearHistoryButton() {
  var armed = false;
  var timer = null;
  var button = el('button', {
    type: 'button', class: 'btn md', disabled: S.proofs.length === 0,
    text: 'Clear history',
    title: 'Delete every proof bundle and forget every trend. Reports already written are kept.',
    onclick: function () {
      if (!armed) {
        armed = true;
        button.textContent = 'Clear ' + S.proofs.length + ' run(s)?';
        button.classList.add('danger');
        timer = setTimeout(function () {
          armed = false;
          button.textContent = 'Clear history';
          button.classList.remove('danger');
        }, 4000);
        return;
      }
      if (timer) clearTimeout(timer);
      armed = false;
      button.disabled = true;
      button.textContent = 'Clearing…';
      // The open run belongs to a bundle that is about to stop existing.
      S.openTask = null;
      post('history-clear', {}, null);
    }
  });
  return button;
}

function toggleHistory(card) {
  var key = 'history:' + card.runId;
  if (S.openTask === key) { S.openTask = null; render(); return; }
  S.openTask = key;
  render();
  loadBundle(card.runId).then(render);
}

/* ------------------------------------------------------ healed selectors */

function renderHealed(main) {
  main.appendChild(pageHead(
    'Healed selectors',
    'Every repair the healer has cached, and what it would cost to learn again. A cached selector that fails is deleted, never retried — a stale repair is worse than none.',
    el('button', {
      type: 'button', class: 'btn md', disabled: S.cache.length === 0, text: 'Forget everything',
      onclick: function () { post('cache-forget', { all: true }, null); }
    })
  ));

  if (S.cache.length === 0) {
    main.appendChild(el('div', { class: 'box' }, [
      el('div', { class: 'big', text: 'Nothing has needed repairing' }),
      el('div', { class: 'why', text: 'Either every selector still resolves on the fast path, or healing is switched off. Both are good outcomes; only one of them is free.' })
    ]));
    return;
  }

  var body = el('tbody');
  S.cache.forEach(function (entry) {
    var confidence = Number(entry.confidence || 0);
    var bars = el('span', { class: 'stab', title: 'confidence ' + confidence.toFixed(2) });
    for (var i = 0; i < 5; i += 1) bars.appendChild(el('i', { class: confidence * 5 > i ? null : 'off' }));

    body.appendChild(el('tr', {}, [
      el('td', {}, [
        el('div', {}, [el('code', { text: entry.key })]),
        el('div', { class: 'mono', style: 'margin-top:4px', text: '→ ' + entry.healed })
      ]),
      el('td', { style: 'color:var(--muted)' }, [document.createTextNode(entry.strategy || '—'), bars]),
      el('td', { text: entry.hits === undefined ? '—' : String(entry.hits) }),
      el('td', { class: 'col-r' }, [
        el('button', { type: 'button', class: 'link', text: 'Forget', onclick: function () { post('cache-forget', { key: entry.key }, null); } })
      ])
    ]));
  });

  main.appendChild(el('table', { class: 'tbl' }, [
    el('thead', {}, [el('tr', {}, [
      el('th', { style: 'width:52%', text: 'Selector, and what replaced it' }),
      el('th', { text: 'Strategy' }),
      el('th', { style: 'width:80px', text: 'Hits' }),
      el('th', { style: 'width:100px' })
    ])]),
    body
  ]));
}

/* --------------------------------------------------------- needs a human */

/**
 * What a person has to decide, rather than what a model can.
 *
 * Two sources, both from the runs themselves: a defect the run filed, and a
 * flow that has failed three times running — GRIM's escalation rule, and the
 * same reasoning. Nothing here is inferred; if the bundles say nothing, this
 * list is empty rather than speculative.
 */
function attentionItems() {
  var items = [];
  tasks().forEach(function (task) {
    if (failStreak(task) >= 3) {
      items.push({
        severity: 'high',
        title: task.name + ' has failed ' + failStreak(task) + ' runs in a row',
        detail: 'Three attempts is where GRIM stops looping and asks a person. ' +
          (task.latest.error || 'The run reports no error of its own, so the evidence is in the steps.'),
        task: task
      });
    }
  });
  S.proofs.slice(0, 12).forEach(function (card) {
    if (card.defects > 0 && card.status === 'failed') {
      items.push({
        severity: card.failed > 0 ? 'medium' : 'low',
        title: card.defects + ' defect(s) in ' + card.name,
        detail: 'Run ' + card.runId + ' · ' + card.failed + ' failed step(s), ' +
          card.backend.failed + ' of them on the API side.',
        card: card
      });
    }
  });
  return items;
}

function renderAttention(main) {
  main.appendChild(pageHead(
    'Needs a human',
    'Where the machinery stops and says so: a flow that keeps failing, and defects a run filed but nothing repaired.',
    null
  ));

  var items = attentionItems();
  if (items.length === 0) {
    main.appendChild(el('div', { class: 'box' }, [
      el('span', { class: 'mark', 'aria-hidden': 'true' }, [el('i'), el('i'), el('i')]),
      el('div', { class: 'big', text: 'Nothing is waiting on you' }),
      el('div', { class: 'why', text: 'No flow has failed three runs in a row, and no failing run filed a defect. This list stays empty rather than finding something to say.' })
    ]));
    return;
  }

  items.forEach(function (item) {
    var acts = el('div', { class: 'note' });
    if (item.task) {
      var flowPath = flowPathFor(item.task.name);
      acts.appendChild(el('button', {
        type: 'button', class: 'btn accent', disabled: !flowPath, text: 'Repair it',
        title: flowPath ? 'run it again, letting the generator rewrite the flow around the break' : 'the .flow.json is not visible from here',
        onclick: function () { startRun(item.task.key, { flow: flowPath, repair: true }); }
      }));
      acts.appendChild(el('button', {
        type: 'button', class: 'btn', text: 'Show the evidence',
        onclick: function () { S.openTask = item.task.key; show('runs'); loadBundle(item.task.latest.runId).then(render); }
      }));
    } else {
      acts.appendChild(el('button', {
        type: 'button', class: 'btn', text: 'Open the raw proof',
        onclick: function () { window.open('/view?path=' + encodeURIComponent(item.card.path), '_blank'); }
      }));
    }
    main.appendChild(el('div', { class: 'req-card' }, [
      el('span', { class: 'sev ' + item.severity, text: item.severity }),
      el('div', {}, [
        el('div', { class: 'what', text: item.title }),
        el('div', { class: 'mono', style: 'margin-top:4px', text: item.detail }),
        acts
      ])
    ]));
  });
}

/* ----------------------------------------------------------- model keys */

function keyCount() {
  return (S.keys.providers || []).reduce(function (total, p) { return total + p.keys.length; }, 0);
}

function unkeyedRoles() {
  return (S.keys.roles || []).filter(function (role) { return !role.keyed; });
}

/**
 * Which key each role would start on, and how to move it.
 *
 * Two mechanisms meet on this page and they are deliberately described as two
 * things, because confusing them would make the page lie:
 *
 * - **Failover happens by itself, inside a run.** When a call comes back with
 *   an auth, quota or rate-limit failure, wowlidator moves to the next key and
 *   carries on, and stays there for every role sharing that provider. Nobody
 *   presses anything, and the move is printed into the run's output.
 * - **The selection here is where a run *starts*.** It reorders what the next
 *   run inherits; the other keys stay behind it, so failover still works from
 *   wherever you point it.
 *
 * The key values themselves are never sent to this page — only a mask and an
 * index. Selecting one posts the index.
 */
/** What each role is for, in one line — the reason its model choice matters. */
function roleBlurb(role) {
  if (role === 'healer') return 'repairs a selector that already failed';
  if (role === 'generator') return 'writes the tests, and repairs whole flows';
  if (role === 'agent') return 'drives the browser through unknown pages';
  if (role === 'data') return 'regenerates a field value that was rejected';
  return '';
}

/**
 * Point one role at a provider and a model.
 *
 * A text input with a datalist, not a select, and the reason is the same one
 * that makes the server accept an unlisted id: OpenRouter alone serves several
 * hundred models, a select is unusable at that size, and a brand-new id is
 * exactly what someone would be here to type. The fetched catalogue is offered
 * as completions — the useful nine-tenths of a dropdown — while typing anything
 * stays possible.
 *
 * Committed on change rather than on every keystroke, so a half-typed id never
 * reaches the server.
 */
function modelPicker(role) {
  var entry = (S.models.roles || []).filter(function (r) { return r.role === role; })[0];
  if (!entry) return el('span', { class: 'mono', text: '—' });

  var catalogue = (S.models.providers || []).filter(function (p) {
    return p.provider === entry.provider;
  })[0] || { models: [], note: '' };

  var listId = 'models-' + role;
  var datalist = el('datalist', { id: listId });
  catalogue.models.forEach(function (id) {
    datalist.appendChild(el('option', { value: id }));
  });

  var provider = el('select', {
    class: 'sel',
    'aria-label': role + ' provider',
    onchange: function () {
      // The model belongs to the provider, so changing one invalidates the
      // other: a Groq id sent to Google fails inside the run, not here. The
      // provider's first listed model is the only defensible default, and
      // when the catalogue is unreachable the field is left for a person.
      var next = (S.models.providers || []).filter(function (p) {
        return p.provider === provider.value;
      })[0];
      var first = next && next.models.length > 0 ? next.models[0] : '';
      if (first === '') {
        toast('pick a model for ' + provider.value + ' — its catalogue could not be read');
        model.value = '';
        model.focus();
        return;
      }
      selectModel(role, provider.value, first);
    }
  });
  (S.models.providers || []).forEach(function (p) {
    provider.appendChild(el('option', {
      value: p.provider, text: p.label, selected: p.provider === entry.provider
    }));
  });

  var model = el('input', {
    class: 'inp mono', type: 'text', list: listId, value: entry.modelId,
    spellcheck: 'false', autocomplete: 'off', 'aria-label': role + ' model',
    placeholder: 'model id',
    onchange: function () {
      var value = model.value.trim();
      if (value === '' || value === entry.modelId) { model.value = entry.modelId; return; }
      selectModel(role, provider.value, value);
    }
  });

  var row = el('div', { class: 'picker' }, [provider, model, datalist]);
  var below = el('div', { class: 'picker-note' });

  if (entry.overridden) {
    below.appendChild(el('span', {
      class: 'mono',
      text: '.env says ' + entry.configuredProvider + ':' + entry.configuredModelId + ' · '
    }));
    below.appendChild(el('button', {
      type: 'button', class: 'link', text: 'put it back',
      onclick: function () {
        api('/api/models', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ role: role, reset: true })
        }).then(function (body) { S.models = body; render(); })
          ['catch'](function (error) { toast(error.message); });
      }
    }));
  } else if (catalogue.note) {
    // Why the completions are missing. The field still works.
    below.appendChild(el('span', { class: 'mono', text: catalogue.note }));
  } else {
    below.appendChild(el('span', {
      class: 'mono', text: catalogue.models.length + ' models offered'
    }));
  }

  return el('div', {}, [row, below]);
}

/** Send one role's choice, and redraw from what came back. */
function selectModel(role, provider, modelId) {
  api('/api/models', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role: role, provider: provider, modelId: modelId })
  }).then(function (body) {
    S.models = body;
    // Only the next run is affected — nothing in flight is re-pointed, and
    // nothing is written to .env.
    toast(role + ' → ' + provider + ':' + modelId + ' (next run)');
    render();
  })['catch'](function (error) { toast(error.message); render(); });
}

function renderKeys(main) {
  main.appendChild(pageHead(
    'Models and keys',
    'Which model each role calls, and which key it starts on. Both are choices about the runs this panel starts — nothing here is written to .env, and nothing already running is re-pointed.',
    el('div', { style: 'display:flex; gap:8px' }, [
      el('button', {
        type: 'button', class: 'btn md', text: 'Refresh models',
        title: 'Ask each provider what it serves right now. Model ids move faster than any list this repo could ship.',
        onclick: function () {
          api('/api/models/refresh', { method: 'POST' }).then(function (body) {
            S.models = body;
            toast('re-read the model catalogues');
            render();
          })['catch'](function (error) { toast(error.message); });
        }
      }),
      el('button', {
        type: 'button', class: 'btn md', text: 'Re-read .env',
        title: 'Pick up a key added or replaced in .env without restarting the panel',
        onclick: function () {
          api('/api/keys/reload', { method: 'POST' }).then(function (body) {
            S.keys = body; toast('re-read .env'); render(); renderSidebar();
          })['catch'](function (error) { toast(error.message); });
        }
      })
    ])
  ));

  var missing = unkeyedRoles();
  if (missing.length > 0) {
    main.appendChild(el('div', { class: 'warn-banner', role: 'status' }, [
      svg(['M12 9v4', 'M12 17h.01', 'M10.36 3.6 2.32 17a2 2 0 0 0 1.71 3h15.94a2 2 0 0 0 1.71-3L13.64 3.6a2 2 0 0 0-3.28 0z']),
      el('div', {}, [
        el('b', { text: missing.length + ' role(s) have no key at all' }),
        el('span', {
          class: 'fix',
          text: missing.map(function (r) { return r.role + ' → ' + r.provider; }).join(', ') +
            '. Anything needing them fails at the moment it needs them, not at startup — a run that never heals never asks for a key.'
        })
      ])
    ]));
  }

  // Role table first: the question is "which key is my healer using", and the
  // provider cards below are the answer to "and what else could it use".
  var roleBody = el('tbody');
  (S.keys.roles || []).forEach(function (role) {
    roleBody.appendChild(el('tr', {}, [
      el('td', {}, [
        el('div', { style: 'font-weight:600', text: role.role }),
        el('div', { class: 'mono', text: roleBlurb(role.role) })
      ]),
      el('td', {}, [modelPicker(role.role)]),
      el('td', {}, [
        role.activeMask
          ? el('code', { title: 'the key this role would start on — shown masked; the value never leaves the panel’s own process', text: role.activeMask })
          : el('span', { class: 'mono', text: 'no key configured' })
      ]),
      el('td', { class: 'mono', text: role.keyCount > 1 ? role.keyCount + ' keys · failover on' : role.keyCount === 1 ? '1 key · no fallback' : '—' }),
      el('td', { class: 'col-r' }, [
        role.keyed ? verdictChip('verified', 'keyed') : verdictChip('feedback', 'no key')
      ])
    ]));
  });
  main.appendChild(el('table', { class: 'tbl', style: 'margin-bottom:24px' }, [
    el('thead', {}, [el('tr', {}, [
      el('th', { style: 'width:130px', text: 'Role' }),
      el('th', { text: 'Provider and model' }),
      el('th', { style: 'width:150px', text: 'Key in use' }),
      el('th', { text: 'Fallback' }),
      el('th', { class: 'col-r', style: 'width:110px' })
    ])]),
    roleBody
  ]));

  (S.keys.providers || []).forEach(function (provider) {
    var section = el('section', { class: 'group' });
    section.appendChild(el('div', { class: 'group-head' }, [
      el('span', { class: 'avatar', text: provider.label.charAt(0).toUpperCase() }),
      el('b', { text: provider.label }),
      el('span', { class: 'mono', text: provider.envKey }),
      el('span', {
        class: 'meta', style: 'margin-left:auto',
        text: provider.roles.length > 0 ? 'used by ' + provider.roles.join(', ') : 'no role points here'
      })
    ]));

    if (provider.keys.length === 0) {
      section.appendChild(el('div', { class: 'card', style: 'padding:16px 20px' }, [
        el('div', { class: 'mono', text: 'nothing set. Add ' + provider.envKey + '=key to .env — several keys as ' + provider.envKey + '=key1,key2 and wowlidator moves between them by itself.' }),
        el('div', { style: 'margin-top:8px' }, [
          el('a', { href: provider.consoleUrl, target: '_blank', rel: 'noreferrer', text: 'Get a key' }),
          el('span', { class: 'mono', text: ' · ' + provider.freeTier })
        ])
      ]));
      main.appendChild(section);
      return;
    }

    var rows = el('div', { class: 'card rows' });
    provider.keys.forEach(function (key) {
      rows.appendChild(el('div', { class: 'row' + (key.active ? ' open' : ''), style: 'grid-template-columns: 54px minmax(0,1fr) auto auto;cursor:default' }, [
        loopRail([key.active ? 'ok' : 'empty', 'empty', 'empty']),
        el('div', { class: 'task-cell' }, [
          el('div', { class: 'task-name' }, [el('code', { text: key.mask })]),
          el('div', { class: 'task-sub', text: 'key ' + (key.index + 1) + ' of ' + provider.keys.length + ' in ' + provider.envKey })
        ]),
        key.active ? verdictChip('verified', 'runs start here') : el('span', { class: 'counts none', text: 'standby' }),
        el('div', { class: 'actions' }, [
          el('button', {
            type: 'button', class: 'btn' + (key.active ? '' : ' accent'), disabled: key.active,
            title: key.active ? 'already where runs start' : 'start the next run on this key; the others stay behind it as fallbacks',
            text: key.active ? 'in use' : 'Start here',
            onclick: function () { selectKey(provider.provider, key.index); }
          })
        ])
      ]));
    });
    section.appendChild(rows);
    main.appendChild(section);
  });

  main.appendChild(el('div', { class: 'box', style: 'text-align:left;margin-top:8px' }, [
    el('div', { class: 'big', text: 'How a key gets swapped without you' }),
    el('div', { class: 'why', style: 'max-width:none;margin:0' }, [
      document.createTextNode('When a call comes back unauthorised, out of quota or rate-limited, wowlidator moves to the next key for that provider and carries on — for every role sharing it, so a dead key is only discovered once. It stays there; it never goes back to re-probe a key it already knows is dead. Each move is printed into the run’s output, so the run drawer is where you see one happen. A failure that is not about the key — a model that cannot emit JSON, a malformed prompt — never rotates, because spending a second key on a call that was never going to work would only hide which model failed.')
    ])
  ]));
}

function selectKey(provider, index) {
  api('/api/keys', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: provider, index: index })
  }).then(function (body) {
    S.keys = body;
    toast('runs will start on key ' + (index + 1));
    render();
    renderSidebar();
  })['catch'](function (error) { toast(error.message); });
}

/* -------------------------------------------------------------- reports */

function renderReports(main) {
  main.appendChild(pageHead(
    'Reports',
    'The rendered HTML reports, newest first. Each one is self-contained — it opens off a USB stick, screenshots and all.',
    null
  ));

  if (S.reports.length === 0) {
    main.appendChild(el('div', { class: 'box' }, [
      el('div', { class: 'big', text: 'No reports yet' }),
      el('div', { class: 'why', text: 'Run anything and one appears here, alongside the proof bundle it was rendered from.' })
    ]));
    return;
  }

  var body = el('tbody');
  S.reports.forEach(function (report) {
    body.appendChild(el('tr', {}, [
      el('td', {}, [
        el('div', { text: report.name }),
        el('div', { class: 'mono', text: report.path })
      ]),
      el('td', { class: 'mono', text: String(report.modified).slice(0, 16).replace('T', ' ') }),
      el('td', { class: 'mono', text: Math.round(report.size / 1024) + ' KB' }),
      el('td', { class: 'col-r' }, [
        el('button', {
          type: 'button', class: 'link', text: 'Open',
          onclick: function () { window.open('/view?path=' + encodeURIComponent(report.path), '_blank'); }
        })
      ])
    ]));
  });

  main.appendChild(el('table', { class: 'tbl' }, [
    el('thead', {}, [el('tr', {}, [
      el('th', { text: 'Report' }), el('th', { style: 'width:150px', text: 'Rendered' }),
      el('th', { style: 'width:90px', text: 'Size' }), el('th', { style: 'width:80px' })
    ])]),
    body
  ]));
}

/* --------------------------------------------------------- start a check */

/**
 * The launch modal.
 *
 * Nobody picks a flow file here, and that is the point: a flow is something
 * wowlidator writes, not something a person maintains by hand. What a team
 * already has is documents, so the three ways in are all documents:
 *
 *   Add Context   background the model may read — an API doc, a design note,
 *                 a page saved as HTML. Stored, reusable, and never a source of
 *                 claims. Saving one starts nothing.
 *   Add Catalog   the document that says what must be true. Its claims are
 *                 listed first, in a gate you tick through, and only what
 *                 survives becomes steps and a run.
 *   Describe      one sentence, when the document is in your head.
 *
 * The gate between "what does this document claim" and "here is a browser
 * running tests" is the load-bearing part. Claims cost one cheap model call
 * and no browser; steps cost tokens, a page and a report. Putting a list of
 * sentences in front of a person in between is what stops a claim the model
 * read out of a heading from quietly becoming a green test.
 */
function openStartModal() {
  S.modal = {
    mode: 'catalog',
    // Add Context
    ctxName: '',
    ctxText: '',
    // Add Catalog
    catName: '',
    catText: '',
    catalog: null,       /* the stored document: { name, path, format, bytes } */
    claimsPath: null,
    claims: null,        /* the parsed claims file, once the gate has run */
    progress: null,      /* { percent, phase } while the catalog job runs */
    cut: {},             /* claim index -> struck out */
    attach: {},          /* context document path -> attached to this run */
    reading: false,
    // Describe
    describe: '',
    // shared
    focus: '',
    url: '',
    advanced: false,
    video: 'on',
    screenshots: 'auto',
    policy: 'forms',
    waitFor: '',
    error: '',
    busy: false
  };
  loadDocuments();
  renderModal();
}

function closeModal() { S.modal = null; renderModal(); }

function loadDocuments() {
  return api('/api/documents?kind=context').then(function (body) {
    S.contextDocs = body.documents;
    renderModal();
  })['catch'](function () {});
}

function modalField(label, optional, control, hint) {
  return el('div', {}, [
    el('label', {}, [
      document.createTextNode(label),
      optional ? el('span', { class: 'optional', text: ' — optional' }) : null
    ]),
    control,
    hint ? el('div', { class: 'mono', style: 'margin-top:4px', text: hint }) : null
  ]);
}

var DOCUMENT_ACCEPT = '.md,.markdown,.csv,.tsv,.html,.htm,.txt,.text,.log,.json,.yaml,.yml,.xlsx,.xlsm,.pdf';

/** Read a picked file as base64 without ever holding it as a string twice. */
function readFileAsBase64(file) {
  return new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onerror = function () { reject(new Error('could not read that file')); };
    reader.onload = function () {
      var result = String(reader.result || '');
      var comma = result.indexOf(',');
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

function saveDocument(kind, payload) {
  return api('/api/documents', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(Object.assign({ kind: kind }, payload))
  }).then(function (body) { return body.document; });
}

/* ------------------------------------------------------------ Add Context */

function renderContextTab(box, M) {
  box.appendChild(el('div', { class: 'sub', style: 'margin-bottom:0' , text:
    'Background wowlidator may read while it writes tests — an API doc, a page saved as HTML, notes on what a term means. It is never a source of claims, and saving one runs nothing.' }));

  var file = el('input', {
    type: 'file', accept: DOCUMENT_ACCEPT,
    onchange: function (e) {
      var chosen = e.target.files && e.target.files[0];
      if (!chosen) return;
      M.busy = true; M.error = ''; renderModal();
      readFileAsBase64(chosen)
        .then(function (base64) { return saveDocument('context', { name: chosen.name, contentBase64: base64 }); })
        .then(function () { M.busy = false; toast('context added'); return loadDocuments(); })
        ['catch'](function (error) { M.busy = false; M.error = error.message; renderModal(); });
    }
  });
  box.appendChild(modalField('Upload a document', false, file,
    'md · csv · html · txt · json · yaml · xlsx · pdf'));

  var name = el('input', { type: 'text', placeholder: 'leave-balance-api', value: M.ctxName,
    oninput: function (e) { M.ctxName = e.target.value; syncSubmit(); } });
  box.appendChild(modalField('…or name some text and paste it', false, name));

  var text = el('textarea', { rows: '5', placeholder: 'Paste anything that explains the application: endpoints, terms, rules.',
    oninput: function (e) { M.ctxText = e.target.value; syncSubmit(); } });
  text.value = M.ctxText;
  box.appendChild(modalField('The text', false, text));

  box.appendChild(contextList(M, false));
}

/** Everything already stored, with a tick box when a catalog run can use it. */
function contextList(M, attachable) {
  var wrap = el('div', { class: 'gate', style: 'max-height:180px' });
  wrap.appendChild(el('div', { class: 'sub', style: 'margin-bottom:8px',
    text: (S.contextDocs || []).length === 0
      ? 'Nothing stored yet.'
      : attachable
        ? 'Tick what this run may read as background.'
        : 'Stored context — available to every catalog run.' }));

  (S.contextDocs || []).forEach(function (doc) {
    var row = el('label', { class: 'gate line' });
    if (attachable) {
      var tick = el('input', { type: 'checkbox', onchange: function () {
        M.attach[doc.path] = !M.attach[doc.path];
        renderModal();
      } });
      tick.checked = M.attach[doc.path] === true;
      row.appendChild(tick);
    }
    row.appendChild(el('span', {}, [
      el('code', { text: doc.name }),
      el('span', { class: 'mono', text: '  ' + doc.format + ' · ' + Math.max(1, Math.round(doc.bytes / 1024)) + ' KB' })
    ]));
    if (!attachable) {
      row.appendChild(el('button', {
        type: 'button', class: 'link', style: 'margin-left:auto', text: 'remove',
        onclick: function (e) {
          e.preventDefault();
          api('/api/documents?kind=context&path=' + encodeURIComponent(doc.path), { method: 'DELETE' })
            .then(function () { toast('removed ' + doc.name); return loadDocuments(); })
            ['catch'](function (error) { toast(error.message); });
        }
      }));
    }
    wrap.appendChild(row);
  });
  return wrap;
}

/* ------------------------------------------------------------ Add Catalog */

function renderCatalogTab(box, M) {
  box.appendChild(el('div', { class: 'sub', style: 'margin-bottom:0', text:
    'A document of things that must be true. wowlidator reads out its claims first — nothing is tested until you have seen them.' }));

  var file = el('input', {
    type: 'file', accept: DOCUMENT_ACCEPT,
    onchange: function (e) {
      var chosen = e.target.files && e.target.files[0];
      if (!chosen) return;
      M.busy = true; M.error = ''; M.claims = null; renderModal();
      readFileAsBase64(chosen)
        .then(function (base64) { return saveDocument('catalog', { name: chosen.name, contentBase64: base64 }); })
        .then(function (doc) {
          M.catalog = doc; M.catName = doc.name; M.busy = false; renderModal();
        })
        ['catch'](function (error) { M.busy = false; M.error = error.message; renderModal(); });
    }
  });
  box.appendChild(modalField('The catalog', false, file,
    'md · csv · html · txt · json · yaml · xlsx · pdf — text is read out of it and sent to the model'));

  var name = el('input', { type: 'text', placeholder: 'leave-balance-checks', value: M.catName,
    oninput: function (e) { M.catName = e.target.value; syncSubmit(); } });
  box.appendChild(modalField('…or name some text and paste it', false, name));

  var text = el('textarea', { rows: '4', placeholder: '- the balance table renders with one row per leave type\n- filtering by month narrows the rows',
    oninput: function (e) { M.catText = e.target.value; M.claims = null; syncSubmit(); } });
  text.value = M.catText;
  box.appendChild(modalField('The text', false, text));

  if (M.catalog) {
    box.appendChild(el('div', { class: 'mono', style: 'margin-top:6px' }, [
      document.createTextNode('stored as '),
      el('code', { text: M.catalog.name }),
      document.createTextNode(' · ' + M.catalog.format)
    ]));
  }

  box.appendChild(el('div', { style: 'margin-top:10px' }, [
    el('button', {
      type: 'button', class: 'btn primary', disabled: M.reading || M.busy,
      text: M.reading ? 'Processing…' : M.claims ? 'Process it again' : 'Process catalog',
      title: 'Reads the catalog and lists what it claims. No browser, nothing tested — the list comes back here for you to tick through.',
      onclick: function () { readClaims(); }
    })
  ]));

  // While it runs, and only while it runs. A bar left on screen after the work
  // finished is furniture; this one is replaced by the claims it produced.
  if (M.reading) box.appendChild(modalProgress(M));

  if (M.claims) box.appendChild(claimsGate(M));

  box.appendChild(contextList(M, true));
}

/**
 * The bar for the catalog job, with the number on it.
 *
 * Reading a catalog has no steps to count — it is a file read and one model
 * call — so the percentage comes from the phases the command announces as it
 * reaches them (see PHASE_LINES in ui/jobs.ts). It moves when the work
 * moves and not on a timer, which is why it steps rather than creeps: a bar
 * that animates smoothly while nothing is happening is a lie that costs
 * nothing to tell and is believed every time.
 *
 * Before the first phase line arrives there is nothing to divide, so it says
 * so and paces instead of claiming a fraction.
 */
function modalProgress(M) {
  var progress = M.progress || {};
  var pct = typeof progress.percent === 'number' ? progress.percent : null;

  var fill = el('i');
  if (pct !== null) fill.style.width = pct + '%';
  var bar = el('div', { class: 'pbar' + (pct === null ? ' wait' : '') }, [fill]);

  return el('div', {
    class: 'prog', style: 'margin-top:10px',
    role: 'progressbar', 'aria-label': 'reading the catalog',
    'aria-valuenow': pct === null ? null : String(pct)
  }, [
    el('span', { class: 'steps', text: pct === null ? 'starting…' : pct + '%' }),
    bar,
    el('span', { class: 'eta', text: progress.phase || 'reading the catalog…' })
  ]);
}

/**
 * The gate: every claim the model found, tickable.
 *
 * Claims marked as context by the model are shown but never counted — they set
 * up the ones around them ("the user is signed in as an admin") and turning one
 * into a check would report a failure about a precondition.
 */
function claimsGate(M) {
  var claims = M.claims.claims;
  var testable = claims.filter(function (claim) { return claim.testable; });
  var kept = testable.filter(function (_, index) { return !M.cut[indexOf(claims, testable[index])]; });

  var gate = el('div', { class: 'gate' });
  gate.appendChild(el('div', { class: 'sub', style: 'margin-bottom:8px',
    text: countApproved(M) + ' of ' + testable.length + ' claims will be proved — untick anything you do not want before it costs tokens and a browser.' }));

  if (M.claims.summary) {
    gate.appendChild(el('div', { class: 'mono', style: 'margin-bottom:8px', text: M.claims.summary }));
  }
  if (M.claims.documentNote) {
    gate.appendChild(el('div', { class: 'err', style: 'margin-bottom:8px', text: M.claims.documentNote }));
  }

  claims.forEach(function (claim, index) {
    if (!claim.testable) {
      gate.appendChild(el('div', { class: 'gate line', style: 'cursor:default' }, [
        el('span', { class: 'mono', text: 'context · ' + claim.claim })
      ]));
      return;
    }
    var row = el('label', { class: 'gate line' + (M.cut[index] ? ' cut' : '') });
    var tick = el('input', { type: 'checkbox', onchange: function () {
      M.cut[index] = !M.cut[index];
      renderModal();
    } });
    tick.checked = !M.cut[index];
    row.appendChild(tick);
    row.appendChild(el('span', {}, [
      el('span', { class: 'mono', text: '[' + claim.priority + '] ' }),
      document.createTextNode(claim.claim),
      claim.source ? el('span', { class: 'mono', text: '  ← ' + claim.source }) : null
    ]));
    gate.appendChild(row);
  });

  return gate;
}

function indexOf(list, item) { return list.indexOf(item); }

function countApproved(M) {
  if (!M.claims) return 0;
  return M.claims.claims.filter(function (claim, index) {
    return claim.testable && !M.cut[index];
  }).length;
}

/** Phase one: ask the CLI what the document claims, then read the file it wrote. */
function readClaims() {
  var M = S.modal;
  M.error = '';

  ensureCatalogStored()
    .then(function (doc) {
      M.catalog = doc;
      M.claimsPath = '.wowlidator/catalogs/' + doc.name.replace(/\.[^.]+$/, '') + '.claims.json';
      M.reading = true;
      M.progress = { percent: null, phase: 'reading the catalog…' };
      renderModal();
      return api('/api/jobs', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          commandId: 'catalog-claims',
          values: {
            catalog: doc.path,
            'claims-out': M.claimsPath,
            'context-doc': attachedContext(M)
          }
        })
      });
    })
    .then(function (body) {
      return awaitJob(body.job.id, function (progress) {
        M.progress = progress;
        if (M.reading) renderModal();
      });
    })
    .then(function (job) {
      if (job.status !== 'passed') {
        throw new Error('reading the catalog failed — open Runs and proof to see the output of "' + job.title + '"');
      }
      M.progress = { percent: 95, phase: 'reading the claims it wrote' };
      renderModal();
      return api('/api/file?path=' + encodeURIComponent(M.claimsPath));
    })
    .then(function (body) {
      M.claims = JSON.parse(body.content);
      M.cut = {};
      M.reading = false;
      M.progress = null;
      renderModal();
    })
    ['catch'](function (error) {
      M.reading = false;
      M.progress = null;
      M.error = error.message;
      renderModal();
    });
}

/** The catalog as a file on disk, whether it was uploaded or typed. */
function ensureCatalogStored() {
  var M = S.modal;
  if (M.catalog && M.catText.trim() === '') return Promise.resolve(M.catalog);
  if (M.catText.trim() === '') return Promise.reject(new Error('choose a file or paste the catalog text'));
  if (M.catName.trim() === '') return Promise.reject(new Error('give the catalog a name'));
  return saveDocument('catalog', { name: M.catName.trim() + '.md', text: M.catText });
}

function attachedContext(M) {
  return Object.keys(M.attach).filter(function (path) { return M.attach[path]; });
}

/**
 * Poll one job to the end. The modal stays put, so there is no stream to join.
 *
 * onProgress fires on every poll, including the last: a job that finishes
 * between two polls would otherwise leave the bar showing whatever it read
 * before the work it was measuring completed.
 */
function awaitJob(id, onProgress) {
  return new Promise(function (resolve, reject) {
    var tries = 0;
    var tick = function () {
      api('/api/jobs/' + encodeURIComponent(id)).then(function (body) {
        if (onProgress) onProgress(body.job.progress || {});
        if (body.job.status !== 'running') { resolve(body.job); return; }
        tries += 1;
        if (tries > 300) { reject(new Error('that is taking too long — check Runs and proof')); return; }
        setTimeout(tick, 700);
      })['catch'](reject);
    };
    tick();
  });
}

/* -------------------------------------------------------------- the modal */

function renderModal() {
  var host = byId('modal');
  clear(host);
  if (!S.modal) return;
  var M = S.modal;

  var box = el('div', { class: 'modal', role: 'dialog', 'aria-labelledby': 'mt', onclick: function (e) { e.stopPropagation(); } });
  box.appendChild(el('h2', { id: 'mt', text: 'Start verification' }));
  box.appendChild(el('div', { class: 'sub', text: 'wowlidator writes the test; you say what must be true. Everything here runs the CLI — the command it builds is shown while it runs.' }));

  var seg = el('div', { class: 'segmented' });
  [['context', 'Add Context'], ['catalog', 'Add Catalog'], ['describe', 'Describe']].forEach(function (pair) {
    seg.appendChild(el('button', {
      type: 'button', class: 'btn' + (M.mode === pair[0] ? ' primary' : ''),
      text: pair[1], onclick: function () { M.mode = pair[0]; M.error = ''; renderModal(); }
    }));
  });
  box.appendChild(seg);

  if (M.mode === 'context') renderContextTab(box, M);
  if (M.mode === 'catalog') renderCatalogTab(box, M);
  if (M.mode === 'describe') {
    var describe = el('textarea', { rows: '3', placeholder: 'check that pagination is disabled when there is a single page — or paste a URL to write tests for the whole page',
      oninput: function (e) { M.describe = e.target.value; syncSubmit(); } });
    describe.value = M.describe;
    box.appendChild(modalField('What should be proved?', false, describe,
      'A URL generates tests for that page; anything else is one test to write, against the page below.'));
  }

  if (M.mode !== 'context') {
    var focus = el('textarea', { rows: '2', placeholder: 'the filter controls',
      oninput: function (e) { M.focus = e.target.value; } });
    focus.value = M.focus;
    box.appendChild(modalField('Anything to look at especially', true, focus));

    var url = el('input', { type: 'text', class: 'mono', placeholder: 'http://localhost:3000/some/page',
      value: M.url, oninput: function (e) { M.url = e.target.value; } });
    box.appendChild(modalField('Page to prove it against', true, url,
      'Strongly recommended: with it the selectors come from the page, not from the document.'));

    box.appendChild(el('button', {
      type: 'button', class: 'btn', style: 'margin-top:8px',
      text: (M.advanced ? '▾' : '▸') + ' Options for this run only — nothing here is stored',
      onclick: function () { M.advanced = !M.advanced; renderModal(); }
    }));
    if (M.advanced) {
      var adv = el('div', { class: 'gate', style: 'max-height:none' });
      var film = el('select', { onchange: function (e) { M.video = e.target.value; } });
      ['on', 'off'].forEach(function (mode) {
        film.appendChild(el('option', { value: mode, selected: mode === M.video, text: mode }));
      });
      adv.appendChild(modalField('Record the run', false, film,
        'Films the run with a pointer drawn into the page, so you can see the clicks — a still only shows the page either side of one. Recording needs its own browser context, so a filmed run does not inherit cookies from a session you signed into by hand.'));

      var shots = el('select', { onchange: function (e) { M.screenshots = e.target.value; } });
      ['auto', 'all', 'on-event', 'on-failure', 'off'].forEach(function (mode) {
        shots.appendChild(el('option', { value: mode, selected: mode === M.screenshots, text: mode }));
      });
      adv.appendChild(modalField('Stills', false, shots,
        'auto follows the recording: failures only while filming, every step when not. all gives both — the same run twice, at several times the size.'));

      var policy = el('select', { onchange: function (e) { M.policy = e.target.value; } });
      ['read-only', 'forms', 'mutations'].forEach(function (mode) {
        policy.appendChild(el('option', { value: mode, selected: mode === M.policy, text: mode }));
      });
      adv.appendChild(modalField('What the written test may do', false, policy,
        'read-only never submits. forms submits invalid input to exercise validation. Nothing deletes, at any tier.'));

      var wait = el('input', { type: 'text', class: 'mono', placeholder: 'http://localhost:3000', value: M.waitFor,
        oninput: function (e) { M.waitFor = e.target.value; } });
      adv.appendChild(modalField('Wait for this to answer first', true, wait, 'For a dev server that is still booting.'));
      box.appendChild(adv);
    }
  }

  if (M.error) box.appendChild(el('div', { class: 'err', text: M.error }));

  var submit = el('button', {
    type: 'button', class: 'btn primary', disabled: M.busy || M.reading || submitBlocked() !== null,
    title: submitBlocked(), text: submitLabel(M),
    onclick: submitModal
  });
  M.submitNode = submit;
  box.appendChild(el('div', { class: 'acts' }, [
    el('button', { type: 'button', class: 'btn', text: 'Close', disabled: M.busy, onclick: closeModal }),
    submit
  ]));

  var backdrop = el('div', { class: 'overlay-backdrop', onclick: function (e) { if (e.target === backdrop) closeModal(); } }, [box]);
  host.appendChild(backdrop);
}

/**
 * Keep the submit button honest while someone types.
 *
 * Its label and its disabled state are derived from fields that change on every
 * keystroke, and re-rendering the modal to update them would take the caret and
 * the focus with it. So the button — the only node whose state depends on what
 * is currently typed — is updated in place instead. Every oninput that can
 * change the answer calls this.
 */
function syncSubmit() {
  var M = S.modal;
  if (!M || !M.submitNode) return;
  var blocked = submitBlocked();
  M.submitNode.disabled = M.busy || M.reading || blocked !== null;
  M.submitNode.title = blocked || '';
  M.submitNode.textContent = submitLabel(M);
}

function submitLabel(M) {
  if (M.busy) return 'starting…';
  if (M.mode === 'context') return 'Save context';
  if (M.reading) return 'Processing…';
  // Before the gate has run this is the same action as the button in the panel,
  // so it carries the same name — two labels for one thing reads as two things.
  if (M.mode === 'catalog') return M.claims ? 'Prove ' + countApproved(M) + ' claim(s)' : 'Process catalog';
  return 'Start';
}

function submitBlocked() {
  var M = S.modal;
  if (M.mode === 'context') {
    if (M.ctxText.trim() === '') return 'paste some text, or upload a file above';
    if (M.ctxName.trim() === '') return 'give it a name';
    return null;
  }
  if (M.mode === 'catalog') {
    if (!M.catalog && M.catText.trim() === '') return 'choose a file or paste the catalog text';
    if (M.claims && countApproved(M) === 0) return 'at least one claim has to survive';
    return null;
  }
  return M.describe.trim() ? null : 'say what should be proved';
}

function submitModal() {
  var M = S.modal;
  M.error = '';

  if (M.mode === 'context') {
    M.busy = true; renderModal();
    saveDocument('context', { name: M.ctxName.trim() + '.md', text: M.ctxText })
      .then(function (doc) {
        M.busy = false; M.ctxText = ''; M.ctxName = '';
        toast('stored ' + doc.name);
        return loadDocuments();
      })
      ['catch'](function (error) { M.busy = false; M.error = error.message; renderModal(); });
    return;
  }

  var extras = {};
  if (M.video !== 'on') extras.video = M.video;
  if (M.screenshots !== 'auto') extras.screenshots = M.screenshots;
  if (M.waitFor.trim()) extras['wait-for'] = M.waitFor.trim();

  if (M.mode === 'describe') {
    var go = { target: M.describe.trim() };
    if (M.url.trim()) go.url = M.url.trim();
    if (M.focus.trim()) go.target = go.target + ' — ' + M.focus.trim();
    if (M.policy !== 'forms') go.policy = M.policy;
    M.busy = true; renderModal();
    fire('go', Object.assign(go, extras), null);
    return;
  }

  // Catalog. The first press reads the claims; the second proves the ones that
  // survived the gate. One button, because "show me" and "go" are one decision
  // taken twice, not two features.
  if (!M.claims) { readClaims(); return; }

  M.busy = true; renderModal();
  var approved = { catalog: M.claims.catalog, summary: M.claims.summary,
    documentNote: M.claims.documentNote, model: M.claims.model, extractedAt: M.claims.extractedAt,
    claims: M.claims.claims.map(function (claim, index) {
      return Object.assign({}, claim, { approved: claim.testable ? !M.cut[index] : true });
    }) };

  api('/api/file?path=' + encodeURIComponent(M.claimsPath), {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: JSON.stringify(approved, null, 2) + '\n' })
  }).then(function () {
    var values = {
      catalog: M.catalog.path,
      claims: M.claimsPath,
      run: true,
      'context-doc': attachedContext(M)
    };
    if (M.url.trim()) values.url = M.url.trim();
    if (M.policy !== 'forms') values.policy = M.policy;
    fire('catalog-run', Object.assign(values, extras), null);
  })['catch'](function (error) { M.busy = false; M.error = error.message; renderModal(); });
}

function fire(commandId, values, flowPath) {
  post(commandId, values, flowPath).then(function () {
    S.modal = null;
    renderModal();
  })['catch'](function (error) {
    if (S.modal) { S.modal.busy = false; S.modal.error = error.message; renderModal(); }
  });
}

function post(commandId, values, flowPath) {
  return api('/api/jobs', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commandId: commandId, values: values })
  }).then(function (body) {
    if (flowPath) {
      var name = (S.flows.filter(function (f) { return f.path === flowPath; })[0] || {}).name;
      if (name) S.runningFor[name] = body.job.id;
    }
    refresh();
    openJobDrawer(body.job);
    return body.job;
  })['catch'](function (error) {
    toast(error.message);
    throw error;
  });
}

/* --------------------------------------------------- actual-flow player */

/**
 * "View actual flow": the recording of the mock user performing the task,
 * subtitled step by step from the bundle's own offsets. The failing step's
 * chip and subtitle turn red and carry the error — the film shows WHERE it
 * broke, the subtitle says HOW.
 */
function openFlowPlayer(bundle) {
  var segments = (bundle.steps || [])
    .filter(function (s) { return s.videoOffsetMs !== undefined && s.videoOffsetMs !== null; })
    .map(function (s) {
      return {
        at: s.videoOffsetMs / 1000, step: s.index,
        text: s.intent || (s.action + (s.selector ? ' ' + s.selector : '')),
        failed: s.status !== 'passed' && !s.superseded,
        error: s.status !== 'passed' ? String(s.error || '').split('\n')[0] : ''
      };
    });

  var overlay = el('div', { class: 'overlay-backdrop', onclick: function () { overlay.remove(); } });
  var box = el('div', {
    class: 'modal', role: 'dialog', 'aria-label': 'Actual flow',
    style: 'max-width:1040px', onclick: function (e) { e.stopPropagation(); }
  });
  box.appendChild(el('div', { class: 'top' }, [
    el('b', { text: 'Actual flow — ' + bundle.name }),
    el('button', { type: 'button', class: 'x', 'aria-label': 'Close', text: '✕', onclick: function () { overlay.remove(); } })
  ]));

  var video = el('video', { controls: true, style: 'width:100%;border-radius:8px;background:#000' });
  var bin = atob(bundle.video.data);
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  video.src = URL.createObjectURL(new Blob([bytes], { type: 'video/webm' }));

  var subtitle = el('div', { class: 'flow-subtitle', hidden: true });
  var chips = el('div', { class: 'flow-chips' });
  segments.forEach(function (seg) {
    chips.appendChild(el('button', {
      type: 'button',
      class: 'chip' + (seg.failed ? ' feedback' : ''),
      title: seg.text + (seg.failed && seg.error ? ' — ' + seg.error : ''),
      text: (seg.failed ? '✗ ' : '') + seg.step,
      onclick: function () { video.currentTime = seg.at; video.play(); }
    }));
  });

  var shown = -1;
  function updateSubtitle() {
    var t = video.currentTime;
    var active = null;
    for (var j = 0; j < segments.length; j++) {
      if (segments[j].at <= t + 0.05) active = segments[j]; else break;
    }
    if (!active || active.step === shown) return;
    shown = active.step;
    subtitle.hidden = false;
    subtitle.className = 'flow-subtitle' + (active.failed ? ' failed' : '');
    subtitle.textContent = '';
    subtitle.appendChild(el('span', { class: 'sub-step', text: (active.failed ? '✗ ' : '') + 'step ' + active.step }));
    subtitle.appendChild(document.createTextNode(active.text));
    if (active.failed && active.error) {
      subtitle.appendChild(el('span', { class: 'sub-how', text: active.error }));
    }
  }
  video.addEventListener('timeupdate', updateSubtitle);
  video.addEventListener('seeked', updateSubtitle);
  video.addEventListener('loadedmetadata', function () {
    // A film kept for a failure opens on the failure.
    var broken = segments.filter(function (s) { return s.failed; })[0];
    if (broken && broken.at < (video.duration || Infinity)) video.currentTime = broken.at;
    updateSubtitle();
  }, { once: true });

  box.appendChild(video);
  box.appendChild(subtitle);
  if (segments.length > 0) box.appendChild(chips);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

function startRun(taskKey, options) {
  var values = { flow: options.flow };
  if (options.repair) values.repair = true;
  if (options.video) values.video = options.video;
  post('run', values, options.flow).then(function (job) { S.runningFor[taskKey] = job.id; });
}

function stopJob(id) {
  api('/api/jobs/' + encodeURIComponent(id) + '/stop', { method: 'POST' })
    .then(refresh)['catch'](function (error) { toast(error.message); });
}

/* ------------------------------------------------------------------ data */

function loadBundle(runId) {
  if (S.bundles[runId]) return Promise.resolve(S.bundles[runId]);
  return api('/api/proofs/' + encodeURIComponent(runId)).then(function (body) {
    S.bundles[runId] = body.proof;
    return body.proof;
  })['catch'](function () { return null; });
}

/**
 * A cheap fingerprint of everything the page draws from.
 *
 * The poll is what keeps wowUI right about a run started in another terminal,
 * and re-rendering on every poll was quietly making the page hostile: each
 * render replaces every node, so a click that lands in the same tick as a poll
 * hits an element that is being removed and does nothing. Losing a click on
 * "Start verification" every five seconds is not a rendering nicety.
 *
 * So the fingerprint decides. Nothing changed on disk, nothing is rebuilt, and
 * the DOM under the cursor stays the DOM that was there a moment ago.
 */
function dataSignature() {
  return JSON.stringify([
    S.proofs.map(function (p) { return p.runId + p.status + p.finishedAt; }),
    S.jobs.map(function (j) { return j.id + j.status; }),
    S.flows.length, S.reports.length, S.cache.length,
    S.keys.providers && S.keys.providers.map(function (p) { return p.provider + p.activeIndex + p.keys.length; }),
    S.models.roles && S.models.roles.map(function (r) { return r.role + r.provider + r.modelId; }),
    S.models.providers && S.models.providers.map(function (p) { return p.provider + p.models.length + p.note; })
  ]);
}

function refresh() {
  return Promise.all([
    api('/api/proofs').then(function (b) { S.proofs = b.proofs; }),
    api('/api/jobs').then(function (b) { S.jobs = b.jobs; S.jobsAt = Date.now(); }),
    api('/api/flows').then(function (b) { S.flows = b.flows; }),
    api('/api/reports').then(function (b) { S.reports = b.reports; })['catch'](function () {}),
    api('/api/cache').then(function (b) { S.cache = b.entries || []; })['catch'](function () {}),
    api('/api/keys').then(function (b) { S.keys = b; })['catch'](function () {}),
    api('/api/models').then(function (b) { S.models = b; })['catch'](function () {})
  ]).then(function () {
    var wasOffline = !S.online;
    S.online = true;
    var signature = dataSignature();
    if (signature === S.signature && !wasOffline) {
      // Progress is deliberately not in the fingerprint — it changes every step
      // and would rebuild the page under the cursor. The bars take the new
      // numbers directly instead.
      tickProgress();
      return;
    }
    S.signature = signature;
    renderSidebar();
    render();
  })['catch'](function () {
    if (!S.online) return;
    S.online = false;
    renderSidebar();
    render();
  });
}

/* ------------------------------------------------------------------ boot */

function boot() {
  var known = ['runs', 'history', 'healed', 'attention', 'reports', 'keys'];
  var initial = (location.hash || '').replace('#', '');
  S.view = known.indexOf(initial) === -1 ? 'runs' : initial;

  api('/api/meta').then(function (meta) { S.meta = meta; renderSidebar(); })['catch'](function () {});
  refresh();

  window.addEventListener('hashchange', function () {
    var next = (location.hash || '').replace('#', '');
    if (known.indexOf(next) !== -1 && next !== S.view) show(next);
  });
  window.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (S.modal) closeModal();
    else if (S.drawer) closeDrawer();
  });
  // Polling, not a socket: the page has to be right after a CLI run finishes in
  // another terminal too, and that produces no event this server could see.
  setInterval(function () {
    if (document.visibilityState === 'visible') refresh();
  }, 5000);
  // The estimate counts down between polls; the poll only corrects it.
  setInterval(function () {
    if (document.visibilityState === 'visible') tickProgress();
  }, 1000);
}

boot();
`;

/** The whole of wowUI: markup, styles and behaviour, in one document. */
export function renderWowUi(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>wowUI — wowlidator runs and proof</title>
<style>${WOW_STYLE}</style>
</head>
<body>
<div class="app">
  <aside class="side">
    <div class="brand">
      <span class="brand-mark" aria-hidden="true">W</span>
      <div>
        <div class="brand-word">wow<span class="slash">//</span>UI</div>
        <div class="brand-sub">flows claim · wowlidator proves</div>
      </div>
    </div>
    <nav id="nav" aria-label="Sections"></nav>
    <div class="side-footer" id="foot"></div>
  </aside>
  <main class="main" id="main"></main>
</div>
<div id="modal"></div>
<div id="drawer"></div>
<div class="toast-container" id="toasts"></div>
<script>${WOW_SCRIPT}</script>
</body>
</html>
`;
}
