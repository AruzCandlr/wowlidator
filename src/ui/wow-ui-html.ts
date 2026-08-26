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
.main { padding: var(--s6) var(--s7) 56px; }
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
.chip.doubt { background: var(--warn-bg); color: var(--warn); border: 1px dashed var(--warn); }
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
.autoheal-row { display: flex; align-items: center; gap: 8px; margin-top: 10px; cursor: pointer; font-size: 13px; }
.autoheal-row input { accent-color: var(--accent); }
.claims-summary { border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; margin-bottom: 12px; background: var(--panel-2); }
.cs-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.cs-row { display: flex; align-items: baseline; gap: 8px; padding: 4px 0; flex-wrap: wrap; }
.cs-row .cd { width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto; align-self: center; }
.cs-row .cd.pass { background: var(--ok); }
.cs-row .cd.fail { background: var(--bad); }
.cs-claim { font-size: 13px; }
.cs-cmp { font-size: 11px; color: var(--muted); margin-left: auto; text-align: right; }
.cs-cmp b { font-weight: 600; color: var(--fg); }
.why-block { border: 1px solid var(--line); border-left: 3px solid var(--bad); border-radius: 10px; padding: 12px 14px; margin-top: 12px; background: var(--panel-2); }
.why-headline { font-weight: 700; font-size: 13px; margin: 6px 0 4px; }
.why-line { font-size: 12.5px; line-height: 1.55; margin-top: 4px; }
.why-line.muted2 { color: var(--muted); }

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
.group-head { display: flex; align-items: center; gap: var(--s2); padding: 0 var(--s1) var(--s2); flex-wrap: wrap; row-gap: 4px; }
.avatar {
  width: 24px; height: 24px; border-radius: 6px; background: var(--ink); color: var(--panel);
  font-family: var(--mono); font-size: 11px; font-weight: 700; display: grid; place-items: center; flex: 0 0 auto;
}
.group-head b { font-size: var(--fs-md); font-weight: 600; color: var(--ink); }
.group-head .meta { font-size: var(--fs-xs); color: var(--faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.group-head .state { margin-left: auto; font-size: var(--fs-xs); color: var(--muted); display: inline-flex; align-items: center; gap: 6px; }
.group-head .state::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--line-strong); }
.group-head .state.busy::before { background: var(--info); }
/* A group header you can shut. Only the ones that collapse get the cursor and
   the affordance — the three static section labels using .group-head keep
   looking exactly as they did. */
.suite-acts { display: inline-flex; gap: 6px; flex: none; }
.meta.cost { flex: none; white-space: nowrap; }
.x.mini {
  width: 16px; height: 16px; font-size: 10px; line-height: 1; margin-left: 4px; opacity: .55;
  border: 0; background: none; color: var(--faint); border-radius: var(--r-sm);
  display: inline-grid; place-items: center; cursor: pointer; padding: 0; flex: 0 0 auto;
}
.x.mini:hover { opacity: 1; color: var(--bad); background: var(--panel-2); }
.btn.danger { color: var(--bad); border-color: var(--bad); }
.btn.danger:hover:not(:disabled) { background: var(--bad); color: var(--panel); }
.btn.danger:disabled { opacity: .45; cursor: not-allowed; }
.group-head.clickable { cursor: pointer; border-radius: var(--r-md); }
.group-head.clickable:hover { background: var(--panel-2); }
.group-head.clickable:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.group-head .twist { color: var(--muted); font-size: var(--fs-sm); width: 12px; }

.rows { overflow: hidden; border-radius: var(--r-lg); }

/* ---- a suite's cases, each with its own bar and its own output ---- */
.cases { margin-top: var(--s3); border: 1px solid var(--line); border-radius: var(--r-lg); overflow: hidden; }
.cases-head {
  display: flex; align-items: baseline; gap: var(--s2);
  padding: var(--s2) var(--s4); background: var(--panel-2); border-bottom: 1px solid var(--line);
}
.cases-head b { font-size: var(--fs-sm); font-weight: 600; }
.cases-head .meta { font-size: var(--fs-xs); color: var(--faint); }
.case { border-bottom: 1px solid var(--line); }
.case:last-child { border-bottom: 0; }
.case.live { background: color-mix(in srgb, var(--info) 6%, transparent); }
.case-head {
  display: grid; grid-template-columns: 16px 30px minmax(0, 1fr) auto;
  align-items: center; gap: 10px; padding: var(--s2) var(--s4);
  cursor: pointer; color: inherit;
}
.case-head:hover { background: var(--panel-2); }
.case-head:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.case-head .twist { color: var(--muted); font-size: var(--fs-xs); }
.case-n { font-size: var(--fs-xs); color: var(--faint); font-variant-numeric: tabular-nums; }
.case-cell { min-width: 0; }
.case-name { font-size: var(--fs-sm); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.case-sub { font-size: var(--fs-xs); color: var(--faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.case .prog { padding: 0 var(--s4) var(--s2); }
.case-out {
  max-height: 260px; overflow: auto; padding: 8px 12px;
  white-space: pre-wrap; font-size: var(--fs-xs);
  border-top: 1px solid var(--line); background: var(--panel-2);
}
@media (max-width: 720px) {
  .case-head { grid-template-columns: 16px 30px minmax(0, 1fr); row-gap: 4px; }
}

/* A run group: one authoring pass, with its runs beneath it. Its own class
   rather than the existing .group-head, which is a plain section label and is
   already used by three other sections. */
.run-group {
  display: grid; grid-template-columns: 18px minmax(0, 1fr) auto auto;
  align-items: center; gap: 12px;
  margin: var(--s4) 0 var(--s2); padding: var(--s3) var(--s5);
  background: var(--panel-2); border: 1px solid var(--line); border-radius: var(--r-lg);
  cursor: pointer; color: inherit; transition: background .12s ease;
}
.run-group:hover { background: var(--panel); }
.run-group:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.run-group .twist { color: var(--muted); font-size: var(--fs-sm); }
.group-cell { min-width: 0; }
.group-name { font-size: var(--fs-md); font-weight: 600; line-height: 1.4; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.group-sub { font-size: var(--fs-xs); color: var(--faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.group-tally { font-size: var(--fs-sm); color: var(--muted); white-space: nowrap; }
.group-tally b { font-weight: 600; color: var(--ink); }
.group-tally b.ok { color: var(--ok); }
.group-tally b.bad { color: var(--bad); }
/* A grouped list is indented under its header, so the nesting is visible
   without a second border fighting the group's own. */
.rows.in-group { margin-left: var(--s5); }
/* A scenario inside a catalog group: one sheet scenario, its cases beneath. */
.scenario-head { display: flex; align-items: center; gap: var(--s2); padding: var(--s2) var(--s3); cursor: pointer; border-bottom: 1px solid var(--line); background: var(--panel-2); flex-wrap: wrap; row-gap: 4px; }
.scenario-head:hover { background: var(--panel); }
.scenario-head:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.scenario-head .twist { color: var(--muted); font-size: var(--fs-sm); width: 12px; }
.scenario-head b { font-size: var(--fs-sm); font-weight: 600; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.scenario-head .pct { margin-left: auto; }
/* The verdict split as percentages — each kind a count and its share. */
.pct { font-size: var(--fs-xs); color: var(--muted); display: inline-flex; flex-wrap: wrap; gap: 4px 8px; }
.pct span { white-space: nowrap; }
.pct span b { font-weight: 600; }
.pct .ok b { color: var(--ok); }
.pct .bad b { color: var(--bad); }
.pct .warn b { color: var(--warn); }
.pct .info b { color: var(--info); }
.rows.in-scenario .row { padding-left: var(--s5); }
.task-sub .case-title { color: var(--muted); }
@media (max-width: 720px) {
  .run-group { grid-template-columns: 18px minmax(0, 1fr); row-gap: 6px; }
  .rows.in-group { margin-left: 0; }
}
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
.counts { font-size: var(--fs-xs); color: var(--muted); white-space: normal; text-align: right; font-variant-numeric: tabular-nums; }
.counts b { white-space: nowrap; }
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

/* ---- modal (kept for the flow player) and the inline launcher ---- */
.overlay-backdrop { position: fixed; inset: 0; background: rgba(28,33,38,.32); z-index: 1000; display: grid; place-items: center; padding: var(--s6); }
.modal {
  background: var(--panel); border-radius: var(--r-lg); padding: var(--s6); width: 460px;
  max-width: 90vw; max-height: 88vh; overflow-y: auto; box-shadow: var(--shadow-over);
  border: 1px solid var(--line);
}
/* The start-verification form, inline in the page flow rather than an overlay:
   a card like every other, so it reuses the modal's field styles below and the
   GRIM card dialect instead of growing a third one. Width-capped because a
   form stretched across the whole main column reads as a page, not a form. */
.launcher {
  background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-lg);
  box-shadow: var(--shadow); padding: var(--s6); margin-bottom: var(--s6); max-width: 560px;
}
.launcher .top { display: flex; align-items: center; gap: var(--s2); }
.launcher .top h2 { flex: 1; }
.modal h2, .launcher h2 { font-size: var(--fs-lg); font-weight: 600; letter-spacing: -.01em; margin: 0 0 var(--s1); }
/* ---- actual-flow player ---- */
.flow-subtitle { margin-top: var(--s3); padding: var(--s2) var(--s3); border-radius: var(--r-md, 8px);
  background: var(--panel-2); border: 1px solid var(--line); font-size: var(--fs-sm); line-height: 1.5; }
.flow-subtitle .sub-step { font-weight: 700; font-variant-numeric: tabular-nums; color: var(--muted); margin-right: 8px; }
.flow-subtitle.failed { border-color: var(--bad); background: var(--bad-bg); color: var(--bad); }
.flow-subtitle.failed .sub-step { color: var(--bad); }
.flow-subtitle .sub-how { display: block; margin-top: 3px; font-family: var(--mono); font-size: var(--fs-xs); opacity: .9; }
.flow-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: var(--s3); }
.flow-chips .chip { cursor: pointer; }
.modal .sub, .launcher .sub { font-size: var(--fs-xs); color: var(--muted); margin-bottom: var(--s5); line-height: 1.6; }
.modal label, .launcher label { display: block; font-size: var(--fs-xs); font-weight: 600; color: var(--muted); margin: var(--s4) 0 var(--s2); }
.modal select, .modal input, .modal textarea,
.launcher select, .launcher input, .launcher textarea {
  display: block; width: 100%; font: inherit; font-size: var(--fs-sm);
  border: 1px solid var(--line-strong); border-radius: var(--r-sm); padding: var(--s2) var(--s3);
  color: var(--ink); background: var(--panel); line-height: 1.5;
}
.modal input[type=checkbox], .modal input[type=radio],
.launcher input[type=checkbox], .launcher input[type=radio] { display: inline-block; width: auto; }
.modal select, .launcher select { height: 38px; padding: 0 var(--s3); }
.modal textarea, .launcher textarea { min-height: 72px; resize: vertical; line-height: 1.6; font-family: var(--mono); font-size: var(--fs-mono); }
.modal input:focus, .modal select:focus, .modal textarea:focus,
.launcher input:focus, .launcher select:focus, .launcher textarea:focus { outline: 2px solid var(--accent); outline-offset: 2px; border-color: var(--accent-line); }
/* A field that does not apply to the chosen mode has to look inert, or it
   reads as a field you forgot to fill in. Its title says why. */
.modal input:disabled, .modal select:disabled, .modal textarea:disabled,
.launcher input:disabled, .launcher select:disabled, .launcher textarea:disabled {
  background: var(--panel-2); color: var(--faint); cursor: not-allowed;
}
.modal .optional, .launcher .optional { font-weight: 400; color: var(--faint); }
.modal .acts, .launcher .acts { display: flex; gap: var(--s2); margin-top: var(--s6); justify-content: flex-end; }
.modal .inline, .launcher .inline { display: flex; align-items: center; gap: 6px; font-weight: 400; color: var(--ink); cursor: pointer; margin: 0; }
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
.drawer .x, .launcher .x {
  margin-left: auto; display: grid; place-items: center; width: 28px; height: 28px;
  border: 0; background: none; border-radius: var(--r-sm); color: var(--faint);
  font-size: 16px; line-height: 1; cursor: pointer;
}
.drawer .x:hover, .launcher .x:hover { background: var(--panel-2); color: var(--ink); }
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
  /* Statistics must never be the thing a narrow window cuts: counts and
     cost lines become ordinary wrapped text, full width, left-aligned. */
  .counts { max-width: none; text-align: left; }
  .when { text-align: left; min-width: 0; }
  .meta.cost { white-space: normal; }
  .scenario-head b { white-space: normal; }
}
@media (max-width: 480px) {
  .stats { grid-template-columns: 1fr; }
  .stat { border-left: 0; border-top: 1px solid var(--line); }
  .stat:first-child { border-top: 0; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: .001ms !important; animation-iteration-count: 1 !important; transition-duration: .001ms !important; }
}
`;

const WOW_SCRIPT = String.raw`
'use strict';

/* ------------------------------------------------------------------ state */

/* Did a run's claims hold? Mirrors isPassing() in engine/proof-bundle.ts —
   the client is a template string and cannot import it. 'passed-with-issues'
   is a pass whose path broke: green where green means "the claims held",
   and marked everywhere it is shown so nobody mistakes it for a clean run. */
function isPassing(status) { return status === 'passed' || status === 'passed-with-issues'; }

/* The status a reader should act on: a human ruling on a proved-? run
   outranks the machine's deferral. Mirrors effectiveStatus in
   engine/proof-bundle.ts — the page script cannot import it. */
function effStatus(x) {
  if (x && x.status === 'needs-review' && x.review) {
    return x.review.verdict === 'proved' ? 'passed' : 'failed';
  }
  return x ? x.status : '';
}

/* Which tally bucket a run lands in. Mirrors verdictKind in ui/proofs.ts — the
   flows view tallies client-side over the latest run of each flow, where the
   server's per-run grouping does not apply. A quarantined run is in none. */
function verdictKindOf(x) {
  if (!x || x.quarantined) return null;
  var st = effStatus(x);
  if (isPassing(st)) return 'passed';
  if (st === 'dead-end') return 'deadEnd';
  if (st === 'error') return 'error';
  if (st === 'needs-review') return 'needsReview';
  return 'failed';
}

function tallyOf(items) {
  var counts = { passed: 0, failed: 0, deadEnd: 0, error: 0, needsReview: 0 };
  items.forEach(function (x) { var k = verdictKindOf(x); if (k) counts[k] += 1; });
  var total = items.length;
  var out = {};
  Object.keys(counts).forEach(function (k) {
    out[k] = { count: counts[k], percent: total === 0 ? 0 : Math.round(counts[k] / total * 100) };
  });
  return out;
}

/* "proved 67% (4) · failed 17% (1) · dead-end 17% (1)". Zero buckets are left
   out except proved, so a clean group reads "proved 100%" and nothing else. */
var TALLY_LABELS = [
  ['passed', 'proved', 'ok'], ['failed', 'failed', 'bad'], ['deadEnd', 'dead-end', 'bad'],
  ['error', 'error', 'warn'], ['needsReview', 'proved-?', 'info']
];
function tallyLine(tally, total) {
  var node = el('span', { class: 'pct', title: 'share of the ' + total + ' run(s) in this group' });
  TALLY_LABELS.forEach(function (t) {
    var v = tally[t[0]] || { count: 0, percent: 0 };
    if (v.count === 0 && t[0] !== 'passed') return;
    var span = el('span', { class: t[2] });
    span.appendChild(document.createTextNode(t[1] + ' '));
    span.appendChild(el('b', { text: v.percent + '%' }));
    span.appendChild(document.createTextNode(' (' + v.count + ')'));
    node.appendChild(span);
  });
  return node;
}

/* Accuracy = agreement with the sheet's own recorded results. The
   Positive/Negative column says what a case MEANS to prove and cannot score
   a run; the ground truth is the Actual Result column — a person ran every
   case by hand — carried per case as generatedBy.knownResult. A case agrees
   when its latest verdict matches theirs: passed where they saw Passed,
   failed where they saw Failed. A dead-end or error run agrees with nothing:
   it delivered no verdict. Rows the sheet left unverdicted (Cancelled,
   Pending, blank) are disclosed as unscored, never invented into either
   side. One verdict per case — the lists arrive newest-first, so the first
   run seen under a name stands. Mirrors groupAccuracy in ui/proofs.ts;
   computed here client-side because the flows view tallies over the latest
   run of each flow, where the server's per-run grouping does not apply. */
function accuracyOf(items) {
  var seen = {}, cases = [];
  items.forEach(function (x) {
    var key = (x && x.name) || (x && x.runId) || '';
    if (!seen[key]) { seen[key] = true; cases.push(x); }
  });
  var agreed = 0, scored = 0, unscored = 0;
  cases.forEach(function (x) {
    var known = x.generatedBy && x.generatedBy.knownResult;
    if (known !== 'passed' && known !== 'failed') { unscored += 1; return; }
    scored += 1;
    var v = verdictKindOf(x);
    if ((v === 'passed' && known === 'passed') || (v === 'failed' && known === 'failed')) agreed += 1;
  });
  return { agreed: agreed, scored: scored, unscored: unscored, percent: scored === 0 ? 0 : Math.round(agreed / scored * 100) };
}

/* "accuracy 40% (39/98 vs sheet · 10 unscored)". Shown only when the sheet
   recorded results to compare against — a catalog with no Actual Result
   column has no ground truth, and a percentage over nothing would be a lie
   wearing a number. */
function accuracyLine(items) {
  var a = accuracyOf(items);
  if (a.scored === 0) return null;
  var node = el('span', {
    class: 'pct',
    title: 'agreement with the sheet’s recorded Actual Result: verdicts matching what a person found running the same case by hand (' + a.agreed + ' of ' + a.scored + ' recorded case(s); dead-end/error runs deliver no verdict and agree with nothing' + (a.unscored > 0 ? '; ' + a.unscored + ' case(s) have no recorded result and are not scored' : '') + ')'
  });
  var span = el('span', { class: a.percent === 100 ? 'ok' : '' });
  span.appendChild(document.createTextNode('accuracy '));
  span.appendChild(el('b', { text: a.percent + '%' }));
  span.appendChild(document.createTextNode(' (' + a.agreed + '/' + a.scored + ' vs sheet' + (a.unscored > 0 ? ' · ' + a.unscored + ' unscored' : '') + ')'));
  node.appendChild(span);
  return node;
}

/* Humanize a token count: 950, 12.3k, 2.1M. */
function fmtTok(n) {
  if (!n) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

/* Total runtime and runtime-model tokens over a set of runs — the cost line a
   scenario or catalog header wears next to its verdict tally. Sums EVERY run
   given (retries included): the cost of a pass is what was actually spent,
   not what its latest verdicts spent. */
function costLine(runs) {
  var ms = 0, tin = 0, tout = 0;
  runs.forEach(function (r) { ms += r.durationMs || 0; tin += r.inputTokens || 0; tout += r.outputTokens || 0; });
  var node = el('span', {
    class: 'meta cost',
    title: 'total wall clock · runtime model tokens (heals, agent turns, data retries, reconstructions) across ' + runs.length + ' run(s)'
  });
  node.appendChild(document.createTextNode(fmtMs(ms)));
  if (tin > 0 || tout > 0) {
    node.appendChild(document.createTextNode(' · ' + fmtTok(tin) + ' in / ' + fmtTok(tout) + ' out tok'));
  }
  return node;
}

/* The sheet scenario a run came from. The stamp when the run carries one;
   otherwise the case id at the head of its name less its last segment
   (PL_02_03 -> PL_02), which is how a sheet numbers cases inside a scenario.
   Mirrors inferredScenario / inferredCaseTitle in ui/proofs.ts. */
var CASE_ID_RE = /^([A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z0-9]+)+)(?=\s|$)/;
function caseIdOf(name) { var m = CASE_ID_RE.exec(name || ''); return m ? m[1] : null; }
function scenarioOf(x) {
  if (x && x.generatedBy && x.generatedBy.scenario) return x.generatedBy.scenario;
  var id = caseIdOf(x && x.name);
  if (!id) return 'ungrouped';
  var cut = Math.max(id.lastIndexOf('_'), id.lastIndexOf('-'));
  return cut <= 0 ? 'ungrouped' : id.slice(0, cut);
}
function caseTitleOf(x) {
  if (x && x.generatedBy && x.generatedBy.caseTitle) return x.generatedBy.caseTitle;
  var id = caseIdOf(x && x.name);
  if (!id) return null;
  var rest = (x.name || '').slice(id.length).trim();
  return rest === '' ? null : rest;
}

/* A collapsible scenario header. Keyed on the group and scenario, so a poll
   never springs a shut one open. */
function scenarioHead(id, title, items, body, allRuns) {
  var shut = !!S.shutGroups[id];
  function toggle() { S.shutGroups[id] = !shut; render(); }
  var head = el('div', {
    class: 'scenario-head', role: 'button', tabindex: '0', 'aria-expanded': shut ? 'false' : 'true',
    onclick: function (e) { e.stopPropagation(); toggle(); },
    onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }
  }, [
    el('span', { class: 'twist', text: shut ? '\u25B8' : '\u25BE' }),
    el('b', { text: title + ' · ' + items.length + ' case(s)' }),
    tallyLine(tallyOf(items), items.length),
    /* Every run of the scenario, retries included — the tally reads the
       latest verdicts, the cost reads what was spent getting them. */
    costLine(allRuns || items),
    // One click reruns or heals the scenario's cases as one job — never a
    // job per case against a browser that refuses a second one.
    suiteRunButtons(items)
  ]);
  body.appendChild(head);
  return !shut;
}

var S = {
  meta: null, online: true,
  view: 'runs',
  proofs: [], flows: [], jobs: [], reports: [], cache: [], failedRuns: [],
  catalogRuns: [],   /* catalog run ledgers on disk — the resumable record, survives a panel restart */
  groups: [],        /* runs grouped by the authoring pass that made them */
  shutGroups: {},    /* group id -> collapsed. Open is the default: a group
                        nobody has touched must show its runs. */
  openCase: {},      /* 'case:<job>:<n>' -> its output pane is expanded */
  keys: { providers: [], roles: [] },
  models: { providers: [], roles: [], checks: [], checking: [] },  /* the model catalogue, each role's pick, and its last readiness check */
  contextDocs: [],   /* stored background documents — see the launcher */
  repos: [],         /* saved repositories (context add) — see Machinery › Repositories */
  bundles: {},       /* runId -> the full bundle, fetched when a run is opened */
  verdicts: {},      /* runId -> the server-computed verdict (same pure function the report leads with) */
  openTask: null,    /* which flow's detail is expanded */
  cycleOf: {},       /* flow name -> the run being shown in its detail */
  filter: 'all',
  runningFor: {},    /* flow name -> job id, for runs started from this page */
  signature: null,   /* fingerprint of the last data drawn — see dataSignature */
  bars: [],          /* live progress bars on screen — see progressBar */
  jobsAt: 0,         /* when /api/jobs last answered, for counting the eta down */
  outOpen: {},       /* section key -> whether its command-output section is expanded */
  jobLines: {},      /* jobId -> output lines, fetched once or streamed live */
  jobArts: {},       /* jobId -> artifacts streamed so far, for the live section */
  streams: {},       /* jobId -> EventSource, live while that job runs */
  outLive: [],       /* mounted live output panes, written in place — see streamJob */
  launcher: null,    /* the inline start-verification section's state, null = collapsed */
  drawer: null
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
/* Whether the test means to prove acceptance or refusal. Without the label a
   negative test's green run reads as "the feature works" when it says the
   opposite: "the application refused it, as required". Rendered for both
   readings — a reader scanning a mixed catalog needs the positives labelled
   too, or absence is ambiguous. */
function polarityTag(polarity, source) {
  if (!polarity) return null;
  var negative = polarity === 'negative';
  var how = source === 'stated' ? 'stated by the catalog' : 'inferred from the test\u2019s own words and assertions';
  return el('span', {
    class: 'tag' + (negative ? ' warn' : ''),
    title: negative
      ? 'a NEGATIVE test \u2014 it passes by proving the application refuses or blocks the attempt (' + how + ')'
      : 'a POSITIVE test \u2014 it passes by proving the intended path works (' + how + ')',
    text: negative ? 'negative' : 'positive'
  });
}

/* The expected-vs-actual line an assertion recorded, pass or fail \u2014 "it
   passed" and "it passed and the page really held 119 days" are different
   amounts of evidence. */
function expectedActualOf(step) {
  var d = step.detail;
  if (!d || d.expected === undefined) return null;
  var render = function (v) { return typeof v === 'string' ? v : JSON.stringify(v); };
  var out = 'expected ' + render(d.expected);
  if (d.actual !== undefined) out += ' \u00b7 actual ' + render(d.actual);
  return out;
}

/**
 * The agent's action log, turn by turn — the evidence behind its summary.
 *
 * One formatter for both places that show it (the step row's inline
 * expansion and the evidence drawer), so the two cannot drift. A
 * password-shaped fill shows its length, never its characters.
 */
function agentActionLog(acts) {
  return acts.map(function (a, i) {
    var target = a.selector || a.url || '';
    var value = a.value
      ? ' = ' + (/password|passwd|pwd/i.test(a.selector || '') ? '\u2022\u2022\u2022\u2022 (' + a.value.length + ' chars)' : JSON.stringify(a.value))
      : '';
    return (a.ok ? '\u2713' : '\u2717') + ' ' + (i + 1) + '. ' + a.action + ' ' + target + value +
      (a.durationMs !== undefined && a.durationMs !== null ? ' (' + fmtMs(a.durationMs) + ')' : '') +
      (a.reasoning ? '\n     ' + a.reasoning : '') +
      (a.error ? '\n     FAILED: ' + String(a.error).split('\n')[0] : '');
  }).join('\n');
}

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
function flowPathFor(name, renamedFrom) {
  var candidates = renamedFrom ? [name, renamedFrom] : [name];
  for (var i = 0; i < candidates.length; i++) {
    var want = candidates[i];
    var exact = S.flows.filter(function (f) { return f.name === want; })[0];
    if (exact) return exact.path;
    var byFile = S.flows.filter(function (f) {
      return f.path.split('/').pop().replace(/\.flow\.json$/i, '') === want;
    })[0];
    if (byFile) return byFile.path;
  }
  return null;
}

/* -------------------------------------------------------------- grouping */

/**
 * Runs, grouped the way GRIM groups cycles: one row per flow, and one chip per
 * run of it, oldest to newest. S.proofs arrives newest first.
 */
/**
 * Which authoring pass produced this run — the identity of a batch.
 *
 * A catalog becomes a case per approved claim, and every case of one pass
 * carries the same generatedAt. Running that catalog again produces a new one,
 * which is what makes "the same catalog, run twice" two things rather than one
 * thing with twelve runs. Anything nobody authored as a batch is its own.
 */
function batchOf(proof) {
  return proof.generatedBy && proof.generatedBy.generatedAt
    ? 'batch:' + proof.generatedBy.generatedAt
    : 'run';
}

/** What to call a batch: the document it came from, or the best thing left. */
function batchTitle(proof) {
  if (!proof.generatedBy) return 'Authored flows';
  return proof.generatedBy.source || proof.generatedBy.sourceUrl;
}

function tasks() {
  var byName = {};
  var order = [];
  S.proofs.forEach(function (proof) {
    // Keyed by batch AND name: two runs of PB_01_01 from two different
    // catalog passes are two results about two different authorings, and
    // stacking them as cycles of one flow hid which pass a verdict belonged
    // to — the rail showed three chips spanning three catalogs.
    var key = batchOf(proof) + '\u0000' + proof.name;
    if (!byName[key]) { byName[key] = []; order.push(key); }
    byName[key].push(proof);
  });
  return order.map(function (key) {
    var cycles = byName[key].slice().reverse();
    var latest = cycles[cycles.length - 1];
    return {
      key: key,
      name: latest.name,
      cycles: cycles,
      latest: latest,
      batch: batchOf(latest),
      origin: batchTitle(latest),
      generated: latest.generatedBy
    };
  });
}

/** Consecutive failures at the end of a flow's history — GRIM's escalation. */
function failStreak(task) {
  var streak = 0;
  for (var i = task.cycles.length - 1; i >= 0; i -= 1) {
    if (!isPassing(task.cycles[i].status)) streak += 1; else break;
  }
  return streak;
}

function groups() {
  var map = {};
  var order = [];
  tasks().forEach(function (task) {
    // Grouped on the batch, never on generatedBy.sourceUrl: for a catalog that
    // is the page every case was grounded against, which is the same login
    // screen for every catalog anyone has ever run — so every document
    // collapsed into one group titled with a URL, and a second run of the same
    // catalog vanished into the first.
    if (!map[task.batch]) { map[task.batch] = []; order.push(task.batch); }
    map[task.batch].push(task);
  });
  return order.map(function (batch) {
    var first = map[batch][0];
    return {
      batch: batch,
      origin: first.origin,
      generated: first.generated,
      tasks: map[batch],
      runs: map[batch].reduce(function (n, t) { return n + t.cycles.length; }, 0)
    };
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
function progressBar(job, caseNumber) {
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

  var live = {
    jobId: job.id, node: node, bar: bar, fill: fill, steps: steps, eta: eta, etaText: etaText,
    caseNumber: caseNumber || null
  };
  S.bars.push(live);
  paintProgress(live, job, 0);
  return node;
}

/*
 * Mirror of formatProgressReadout in ui/jobs.ts — the client is a template
 * string and cannot import it. The algorithm and the format are tqdm's (the
 * Python progress library): "done/total [elapsed<remaining, rate]", the rate
 * flipping to it/s past one step per second, the remaining side fed by the
 * EMA-smoothed pace the server computed.
 */
function tqdmReadout(done, total, elapsedMs, leftMs, rateMsPerStep) {
  if (rateMsPerStep === null || rateMsPerStep === undefined) return null;
  var rate = rateMsPerStep > 0 && rateMsPerStep < 1000
    ? (1000 / rateMsPerStep).toFixed(1) + 'it/s'
    : (rateMsPerStep / 1000).toFixed(1) + 's/it';
  var remaining = leftMs === null || leftMs === undefined ? '?' : clockMs(leftMs);
  return done + '/' + total + ' [' + clockMs(elapsedMs) + '<' + remaining + ', ' + rate + ']';
}

/* tqdm's clock: MM:SS under an hour, H:MM:SS over it. */
function clockMs(ms) {
  var t = Math.max(0, Math.round(ms / 1000));
  var base = String(Math.floor(t / 60) % 60).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
  return t >= 3600 ? Math.floor(t / 3600) + ':' + base : base;
}

/** Write one bar's current state. "age" is ms since the server last spoke. */
/** One case of a job, by the number its tag carries. */
function caseOf(job, number) {
  var found = (job.cases || []).filter(function (c) { return c.number === number; });
  return found[0] || null;
}

function paintProgress(live, job, age) {
  // A bar bound to a case reads that case's own denominator. The job's own
  // progress describes the command as a whole and would be the average of
  // several runs, which is not a thing anybody is waiting for.
  var progress = live.caseNumber ? (caseOf(job, live.caseNumber) || {}).progress : job.progress;
  var done = (progress && progress.done) || 0;
  var total = progress && progress.total;

  if (total) {
    var pct = Math.max(0, Math.min(100, Math.round((done / total) * 100)));
    live.bar.classList.remove('wait');
    live.fill.style.width = pct + '%';
    // tqdm's readout, ticking locally between polls: elapsed from the job's
    // own start time, remaining counted down by "age" like the eta text.
    var elapsedMs = Math.max(0, Date.now() - new Date(job.startedAt).getTime());
    var leftNow = progress.etaMs === null || progress.etaMs === undefined ? null : Math.max(0, progress.etaMs - age);
    var readout = done > 0 ? tqdmReadout(done, total, elapsedMs, leftNow, progress.rateMsPerStep) : null;
    live.steps.textContent = readout !== null ? readout : pct + '% · ' + done + ' / ' + total + ' steps';
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
    paintProgress(live, job, age);
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
  var slots = task.cycles.slice(-3).map(function (c) { return c.status === 'passed' ? 'ok' : c.status === 'passed-with-issues' ? 'warn' : 'bad'; });
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
  { id: 'repos', label: 'Repositories', count: function () { return S.repos.length; },
    icon: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'] },
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
    'aria-expanded': S.launcher ? 'true' : 'false',
    onclick: toggleLauncher, text: '+ Start verification'
  });
}

function render() {
  var main = byId('main');
  clear(main);
  // Every node below is about to be rebuilt, so anything registered against the
  // old ones is gone. They re-register as they are built.
  S.bars = [];
  S.outLive = [];
  if (S.view === 'runs') renderRuns(main);
  else if (S.view === 'history') renderHistory(main);
  else if (S.view === 'healed') renderHealed(main);
  else if (S.view === 'attention') renderAttention(main);
  else if (S.view === 'reports') renderReports(main);
  else if (S.view === 'keys') renderKeys(main);
  else if (S.view === 'repos') renderRepos(main);
}

/* ------------------------------------------------------- runs and proof */

function renderRuns(main) {
  main.appendChild(pageHead(
    'Runs and proof',
    'Every flow wowlidator has run, with its latest verdict and the evidence behind it — the last three runs are the rail on the left.',
    startButton('md')
  ));

  // The launcher lives in the page flow, directly under the header — an
  // expandable section, not an overlay. Its host is always present so
  // renderLauncher() can rebuild it in place from input handlers without a
  // full render.
  var launcherHost = el('div', { id: 'launcher' });
  main.appendChild(launcherHost);
  if (S.launcher) launcherHost.appendChild(launcherBox(S.launcher));

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

  // A catalog run that ended before every case had a verdict — stopped,
  // killed, paused, or blocked on the machinery — says why and offers to
  // continue rather than start the hundred rows over. Read from the ledgers
  // on disk (each catalog run keeps one, under its unique key of catalog
  // name + timestamp), so the offer survives a panel restart: continuing
  // resumes the remaining cases and pulls the ones already tested under the
  // same key back in as finished tests.
  (S.catalogRuns || []).filter(function (run) {
    return !run.running && (run.resumable || run.errors > 0 || run.failed > 0);
  })
    .slice(0, 3)
    .forEach(function (run) {
      var e = run.ended;
      var cause = e && e.cause;
      var head = run.resumable
        ? (/^paused\b/.test(cause || '') ? 'Paused — ' : 'Stopped — ') + run.title + ' has ' + run.left + ' of ' + run.summary.planned + ' case(s) still to run'
        : run.title + ' finished — ' + run.errors + ' runtime error(s), ' + run.failed + ' failed';
      var acts = [];
      if (run.resumable) acts.push(el('button', { type: 'button', class: 'btn md accent', text: 'Continue testing (' + run.left + ' left)', onclick: function () { resumeCatalog(run.ledgerPath, 'continue'); } }));
      if (run.errors > 0) acts.push(el('button', { type: 'button', class: 'btn md', title: 'A runtime error is the harness, not a verdict — those cases run again (plus anything still unfinished).', text: 'Rerun all errors (' + run.errors + ')', onclick: function () { resumeCatalog(run.ledgerPath, 'errors'); } }));
      if (run.failed > 0) acts.push(el('button', { type: 'button', class: 'btn md', title: 'Failed and dead-end cases run again with autoheal on (plus anything still unfinished).', text: 'Heal all failed (' + run.failed + ')', onclick: function () { resumeCatalog(run.ledgerPath, 'failed'); } }));
      acts.push(el('button', { type: 'button', class: 'btn', title: 'Cases whose flow only asserted the sign-in and a URL are re-authored and run.', text: 'Re-author vacuous', onclick: function () { resumeCatalog(run.ledgerPath, 'vacuous'); } }));
      acts.push(el('button', {
        type: 'button', class: 'btn',
        title: 'Rerun the plan from one case ONWARD in sheet order — earlier verdicts are kept, everything from that case (passes included) runs again in a fresh process on the CURRENT config (.env, models, code).',
        text: 'Resume from case…',
        onclick: function () {
          var caseId = window.prompt('Rerun from which case id? (plan order — that case and everything after it run again on current config)', '');
          if (caseId === null) return;
          caseId = caseId.trim();
          if (caseId === '') return;
          resumeCatalog(run.ledgerPath, 'from', caseId);
        }
      }));
      main.appendChild(el('div', { class: 'warn-banner', role: 'status' }, [
        svg(['M12 9v4', 'M12 17h.01', 'M10.36 3.6 2.32 17a2 2 0 0 0 1.71 3h15.94a2 2 0 0 0 1.71-3L13.64 3.6a2 2 0 0 0-3.28 0z']),
        el('div', {}, [
          el('b', { text: head }),
          run.runKey ? el('span', { class: 'fix mono', text: 'run key: ' + run.runKey }) : null,
          el('span', { class: 'fix mono', text: 'cause: ' + (cause || (run.resumable ? 'the run never recorded how it ended' : 'the run completed')) }),
          el('span', { class: 'fix', text: 'Every button continues this catalog run under the same key: cases already tested are pulled in as finished tests unless the button says otherwise, and the resumed cases join the original group.' }),
          el('div', { class: 'acts' }, acts)
        ])
      ]));
    });

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
        'aria-expanded': outIsOpen(job.id, job) ? 'true' : 'false',
        onclick: function () { toggleOut(job.id, job); }
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
          el('button', { type: 'button', class: 'btn', text: 'Output', onclick: function (e) { e.stopPropagation(); toggleOut(job.id, job); } }),
          /* Pause is only offered where a resume can pick up: a suite with a
             progress ledger. It is instant — in-flight cases are interrupted
             and keep no verdict; Continue testing re-runs them from their
             first step and keeps every finished verdict. */
          job.commandId === 'catalog-run' ? el('button', {
            type: 'button', class: 'btn',
            title: 'Pause immediately: in-flight cases are interrupted and keep no verdict. Continue testing later re-runs them from their first step and keeps everything already finished — on whatever the code says then, not a pre-pause copy.',
            text: 'Pause', onclick: function (e) { e.stopPropagation(); pauseJob(job.id); }
          }) : null,
          el('button', { type: 'button', class: 'btn', text: 'Stop', onclick: function (e) { e.stopPropagation(); stopJob(job.id); } })
        ])
      ]));
      // The console lives under the card it explains, not in a side pane —
      // and above it, one row per case, because a suite running six at once
      // has six things happening and one bar cannot describe them.
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

function statsStrip() {
  var startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  var today = S.proofs.filter(function (p) { return new Date(p.finishedAt || p.startedAt).getTime() >= startOfDay.getTime(); });
  var recent = S.proofs.slice(0, 7);
  var passed = recent.filter(function (p) { return isPassing(p.status); }).length;
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
  var shut = !!S.shutGroups[group.batch];
  function toggle() { S.shutGroups[group.batch] = !shut; render(); }
  var head = el('div', {
    class: 'group-head clickable' + (shut ? ' shut' : ''),
    role: 'button', tabindex: '0', 'aria-expanded': shut ? 'false' : 'true',
    onclick: toggle,
    onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }
  });
  // The affordance first, so what to click is not a guess. Collapsed state is
  // keyed on the batch, which is stable across polls — a group someone shut
  // must not spring open because the list was fetched again.
  head.appendChild(el('span', { class: 'twist', text: shut ? '\u25B8' : '\u25BE' }));

  if (group.generated) {
    head.appendChild(el('span', { class: 'badge gen', text: group.generated.kind || 'generated' }));
    head.appendChild(el('b', { text: group.origin }));
    head.appendChild(el('span', { class: 'chip plain', text: group.generated.model }));
    // The catalog run's unique key (catalog name + init timestamp) — the same
    // identity the resumable-runs record lists, so the two can be matched by
    // eye. Only catalog passes mint one.
    if (group.generated.runKey) {
      head.appendChild(el('span', { class: 'chip plain mono', title: 'catalog run key — a resume continues under the same key', text: group.generated.runKey }));
    }
    // Which pass this is. Two groups can carry the same document name — that is
    // the same catalog run twice — so the time is what tells them apart.
    head.appendChild(el('span', {
      class: 'meta', style: 'margin-left:auto',
      text: group.tasks.length + ' flow(s) · authored ' + shortTime(group.generated.generatedAt)
    }));
    // The split of the latest verdicts across the catalog, as percentages.
    var latests = group.tasks.map(function (t) { return t.latest; });
    head.appendChild(tallyLine(tallyOf(latests), group.tasks.length));
    // A catalog authored from a sheet may carry the sheet's own recorded
    // results (Actual Result); when it does, agreement with them is shown.
    if ((group.generated.kind || '') === 'catalog') {
      var acc = accuracyLine(latests);
      if (acc) head.appendChild(acc);
    }
    /* The pass's whole bill: every run of every case, retries included. */
    head.appendChild(costLine(group.tasks.reduce(function (acc, t) { return acc.concat(t.cycles); }, [])));
    // Rerun or heal the whole pass in one click — one job, one roll-up,
    // every re-run landing back in this group via the flows' own provenance.
    head.appendChild(suiteRunButtons(latests));
    head.appendChild(el('button', {
      type: 'button', class: 'btn',
      title: 'Rename this catalog group. Rewrites the recorded document title on every run of the pass; grouping is keyed on the pass stamp, so nothing regroups.',
      text: 'Rename',
      onclick: function (e) { e.stopPropagation(); renameGroup(group); }
    }));
    head.appendChild(el('button', {
      type: 'button', class: 'btn danger',
      title: 'Permanently delete every proof file of this catalog result. Asks for confirmation first.',
      text: 'Delete',
      onclick: function (e) { e.stopPropagation(); confirmDeleteGroup(group); }
    }));
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
  if (shut) return section;

  var rows = el('div', { class: 'card rows' });
  // A catalog authored from a sheet carries each row's scenario; group on it,
  // in first-seen (sheet) order. A pass with no scenarios at all renders flat.
  var byScenario = {}, scenarioOrder = [];
  group.tasks.forEach(function (task) {
    var sc = scenarioOf(task.latest);
    if (!byScenario[sc]) { byScenario[sc] = []; scenarioOrder.push(sc); }
    byScenario[sc].push(task);
  });
  var flat = scenarioOrder.length === 1 && scenarioOrder[0] === 'ungrouped';
  scenarioOrder.forEach(function (sc) {
    var list = byScenario[sc];
    if (!flat) {
      var open = scenarioHead(
        group.batch + '|' + sc, sc,
        list.map(function (t) { return t.latest; }), rows,
        list.reduce(function (acc, t) { return acc.concat(t.cycles); }, [])
      );
      if (!open) return;
    }
    list.forEach(function (task) {
      rows.appendChild(taskRow(task));
      if (S.openTask === task.key) rows.appendChild(taskDetail(task));
    });
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
  var flowPath = flowPathFor(task.name, task.latest && task.latest.renamedFrom);

  var chip;
  var latestEff = effStatus(latest);
  if (isRunning) chip = verdictChip('running', 'running');
  else if (latest.status === 'needs-review' && !latest.review) chip = verdictChip('doubt', 'proved-? · confirm below');
  else if (latest.status === 'needs-review' && latest.review) chip = verdictChip(latestEff === 'passed' ? 'verified' : 'feedback', latestEff === 'passed' ? 'proved (human-confirmed)' : 'failed (human-confirmed)');
  else if (escalated) chip = verdictChip('escalated', 'needs a human');
  else if (latest.status === 'passed-with-issues') chip = verdictChip('doubt', 'pass**');
  else if (!isPassing(latest.status)) chip = verdictChip('feedback', latest.status);
  else if (latest.quarantined) chip = verdictChip('blocked', 'quarantined');
  else {
    chip = verdictChip('verified', latest.coverage === null
      ? 'proved'
      : 'proved · ' + Math.round(latest.coverage * 100) + '% covered');
  }

  var sub;
  if (isRunning) sub = el('div', { class: 'task-sub live', text: 'running ' + job.commandLine });
  else if (escalated) sub = el('div', { class: 'task-sub fail', text: 'failed ' + streak + ' runs in a row: ' + (latest.error || firstFailure(latest) || 'still broken') });
  else {
    sub = el('div', { class: 'task-sub' });
    // The sheet's own test-case title first, when the run carries one: the
    // flow name is the case id plus title and can be cut short by the column.
    var title = caseTitleOf(latest);
    if (title) {
      sub.appendChild(el('span', { class: 'case-title', text: title }));
      sub.appendChild(document.createTextNode(' · '));
    }
    sub.appendChild(document.createTextNode(flowPath ? tail(flowPath) : latest.runId));
  }

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
    /* The latest run's own cost: wall clock always, tokens when any runtime
       model was paid. "It passed" and "it passed in 4m for 12k tokens" are
       different facts, and only the second predicts next week's bill. */
    counts.appendChild(document.createTextNode(' · ' + fmtMs(latest.durationMs)));
    if (latest.inputTokens > 0 || latest.outputTokens > 0) {
      counts.appendChild(document.createTextNode(' · '));
      counts.appendChild(el('b', {
        style: 'color:var(--info)',
        title: 'runtime model tokens this run: heals, agent turns, data retries, reconstructions',
        text: fmtTok(latest.inputTokens) + ' in / ' + fmtTok(latest.outputTokens) + ' out'
      }));
    }
    /* What the person own Claude session was charged for this run, when a
       session-billed provider ran it. A token count says how much work the
       control plane did; this says what it cost the account they can go and
       check. Only ever this run share — the meter is read as a delta. */
    if (latest.session && latest.session.calls > 0) {
      counts.appendChild(document.createTextNode(' · '));
      counts.appendChild(el('b', {
        style: 'color:var(--accent)',
        title: latest.session.calls + ' ' + latest.session.provider + ' call(s) for this run — '
          + fmtTok(latest.session.inputTokens) + ' in (' + fmtTok(latest.session.cachedInputTokens)
          + ' of it served from cache, billed at a fraction) / ' + fmtTok(latest.session.outputTokens)
          + ' out, ' + fmtMs(latest.session.wallMs) + ' spent inside the provider',
        text: '$' + latest.session.costUsd.toFixed(2) + ' session'
      }));
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
    el('div', { class: 'task-cell' }, [
      el('div', { class: 'task-name' }, [
        document.createTextNode(task.name),
        polarityTag(latest.polarity, latest.polaritySource)
      ]),
      sub
    ]),
    chip,
    counts,
    el('span', { class: 'when', text: isRunning ? 'started ' + shortTime(job.startedAt) : timeAgo(latest.finishedAt) }),
    el('div', { class: 'actions', onclick: function (e) { e.stopPropagation(); } }, [
      el('button', {
        type: 'button', class: 'btn', disabled: isRunning || !flowPath, title: runAgainTitle,
        text: 'Run again', onclick: function () { startRun(task.key, { flow: flowPath }); }
      }),
      el('button', {
        type: 'button', class: 'btn' + (!isPassing(latest.status) && flowPath && !isRunning ? ' accent' : ''),
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
  var flowPath = flowPathFor(task.name, task.latest && task.latest.renamedFrom);

  var detail = el('div', { class: 'detail' });
  detail.appendChild(el('div', { class: 'dh' }, [
    el('span', { class: 'cap', text: 'Run timeline' }),
    el('span', { class: 'mono', text: flowPath || task.name }),
    el('button', {
      type: 'button', class: 'btn', style: 'margin-left:auto', text: 'Rename',
      title: 'Rename every recorded run of this flow. The original name is kept on the record (renamedFrom), so Run again still finds the flow file.',
      onclick: function () { renameTask(task); }
    })
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
        index === task.cycles.length - 1 ? el('span', { class: 'now', text: 'latest' }) : null,
        el('button', {
          type: 'button', class: 'x mini', 'aria-label': 'Hide this run',
          title: 'Hide this run from the panel. The proof file moves to archived/ inside the proof directory - move it back to undo.',
          text: '\u2715',
          onclick: function (e) { e.stopPropagation(); hideRun(c.runId); }
        })
      ]),
      el('div', { class: 'cm', text: c.passed + ' passed / ' + c.failed + ' failed · ' + timeAgo(c.finishedAt) +
        (c.inputTokens > 0 || c.outputTokens > 0 ? ' · ' + fmtTok(c.inputTokens) + ' in / ' + fmtTok(c.outputTokens) + ' out tok' : '') })
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
    var summary = claimsSummary(bundle);
    if (summary) detail.appendChild(summary);
    detail.appendChild(checksTable(bundle));
    var review = reviewBlock(bundle);
    if (review) detail.appendChild(review);
    var why = whyBlock(bundle);
    if (why) detail.appendChild(why);
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

/**
 * The one way command output is shown: an expandable section under the card it
 * belongs to — the running job's row while it runs, the finished run's report
 * card afterwards. Auto-expanded while the job is running, because until the
 * proof lands the console IS the run; collapsed once it has finished, because
 * then the evidence is the point and the console is the receipts. The section
 * key differs between the two homes (job id live, run id finished), which is
 * what makes the finished section start collapsed regardless of how the live
 * one was left.
 */
function outIsOpen(key, job) {
  var running = job.status === 'running';
  return S.outOpen[key] === undefined ? running : S.outOpen[key] === true;
}

function toggleOut(key, job) {
  S.outOpen[key] = !outIsOpen(key, job);
  render();
}

function outLine(line) {
  return el('div', { style: line.stream === 'err' ? 'color:var(--bad)' : null, text: line.text || ' ' });
}

function artifactButton(artifact) {
  return el('button', {
    type: 'button', class: 'btn', title: artifact.path,
    text: artifact.kind + ' · ' + artifact.path.split('/').pop(),
    onclick: function (e) { e.stopPropagation(); window.open('/view?path=' + encodeURIComponent(artifact.path), '_blank'); }
  });
}

/**
 * The cases of a suite, each with its own bar and its own output.
 *
 * A catalog runs its cases concurrently, so one bar and one output pane can
 * only describe the command; these describe the runs. Each row collapses
 * independently, and a case that has not started yet is listed rather than
 * hidden — the roster arrives before anything runs, so what is waiting is
 * evidence too.
 */
function caseSections(job) {
  if (!job.cases || job.cases.length === 0) return null;
  var wrap = el('div', { class: 'cases', onclick: function (e) { e.stopPropagation(); } });

  var done = job.cases.filter(function (c) { return c.status !== 'waiting' && c.status !== 'running'; }).length;
  var running = job.cases.filter(function (c) { return c.status === 'running'; }).length;
  wrap.appendChild(el('div', { class: 'cases-head' }, [
    el('b', { text: job.cases.length + ' case' + (job.cases.length === 1 ? '' : 's') }),
    el('span', { class: 'meta', text: done + ' finished · ' + running + ' running' })
  ]));

  job.cases.forEach(function (entry) { wrap.appendChild(caseRow(job, entry)); });
  return wrap;
}

/* What a status is called on screen. 'passed-with-issues' IS a pass; the
   asterisks point at the broken action step, and nothing about validation
   changes. 'error' is the machinery, never a verdict about the application. */
function caseLabel(status) {
  if (status === 'passed-with-issues') return 'pass**';
  if (status === 'error') return 'runtime error';
  return status;
}

var CASE_CHIP = {
  waiting: 'plain', running: 'run', passed: 'verified', 'passed-with-issues': 'doubt',
  'needs-review': 'doubt',
  failed: 'feedback', error: 'feedback', 'dead-end': 'feedback', blocked: 'plain'
};

function caseRow(job, entry) {
  var key = 'case:' + job.id + ':' + entry.number;
  var open = !!S.openCase[key];
  var row = el('div', { class: 'case' + (entry.status === 'running' ? ' live' : '') });

  var head = el('div', {
    class: 'case-head', role: 'button', tabindex: '0',
    'aria-expanded': open ? 'true' : 'false',
    onclick: function () { S.openCase[key] = !open; render(); },
    onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); S.openCase[key] = !open; render(); } }
  }, [
    el('span', { class: 'twist', text: open ? '\u25BE' : '\u25B8' }),
    el('span', { class: 'case-n', text: 'c' + entry.number }),
    el('div', { class: 'case-cell' }, [
      el('div', { class: 'case-name', text: entry.name }),
      el('div', { class: 'case-sub', text: (entry.exclusive ? 'runs alone (changes data)' : 'runs beside others') + ' · ' + (entry.lineCount || (entry.lines || []).length) + ' line(s)' })
    ]),
    el('span', { class: 'chip ' + (CASE_CHIP[entry.status] || 'plain'), text: caseLabel(entry.status),
      title: entry.status === 'passed-with-issues' ? 'pass: every claim held. ** = a step that only acted (a click, a navigation, an agent leg) broke on the way; it does not affect the verdict' : null })
  ]);
  row.appendChild(head);

  // The bar belongs to the case whether or not its output is open: watching
  // six of them move is the whole point of running them together.
  if (entry.status === 'running' || (entry.progress && entry.progress.done > 0)) {
    row.appendChild(progressBar(job, entry.number));
  }

  if (open) {
    var pane = el('div', { class: 'case-out mono' });
    var lines = caseLines(job, entry);
    if (lines.length === 0) {
      pane.appendChild(el('div', { style: 'color:var(--faint)', text: 'nothing yet' }));
    } else {
      lines.forEach(function (line) { pane.appendChild(outLine(line)); });
    }
    row.appendChild(pane);
  }
  return row;
}

/**
 * One case's output.
 *
 * The polled list and the live stream both shed per-case lines — they would be
 * the same scrollback twice — so a running case's output is demultiplexed here
 * from the job lines the page already holds. A finished job fetched in full
 * carries them on the case itself, and that wins when it is there.
 */
function caseLines(job, entry) {
  if (entry.lines && entry.lines.length > 0) return entry.lines;
  var prefix = '[c' + entry.number + '] ';
  return (S.jobLines[job.id] || [])
    .filter(function (line) { return line.text.indexOf(prefix) === 0; })
    .map(function (line) { return { stream: line.stream, text: line.text.slice(prefix.length) }; });
}

function outputSection(key, job) {
  var running = job.status === 'running';
  var open = outIsOpen(key, job);
  var lines = S.jobLines[job.id];
  var count = lines ? lines.length : (job.lineCount || 0);
  var section = el('div', { class: 'card', style: 'margin-top:var(--s3)', onclick: function (e) { e.stopPropagation(); } });
  var toggle = el('button', {
    type: 'button', class: 'btn', 'aria-expanded': open ? 'true' : 'false',
    text: (open ? '▾' : '▸') + ' Command output (' + count + ' lines)',
    onclick: function () {
      // A finished job's lines are fetched once, on first expand — the jobs
      // poll deliberately strips them, so the list stays light.
      if (!open && !running && !S.jobLines[job.id]) {
        api('/api/jobs/' + encodeURIComponent(job.id)).then(function (body) {
          S.jobLines[job.id] = (body.job && body.job.lines) || [];
          render();
        })['catch'](function () {
          S.jobLines[job.id] = [{ stream: 'err', text: 'output no longer available — the panel has restarted since this run' }];
          render();
        });
      }
      toggleOut(key, job);
    }
  });
  section.appendChild(toggle);
  if (open) {
    var pane = el('div', { class: 'mono', style: 'max-height:300px;overflow:auto;padding:8px 12px;white-space:pre-wrap;font-size:var(--fs-xs)' });
    if (!lines && !running) {
      pane.appendChild(el('div', { style: 'color:var(--faint)', text: 'reading the output…' }));
    } else {
      (lines || []).forEach(function (line) { pane.appendChild(outLine(line)); });
    }
    section.appendChild(pane);
    if (running) {
      // Live: subscribe once, and let the stream write onto this pane in
      // place. The artifacts the run announces land as buttons as they arrive.
      var arts = el('div', { class: 'acts', style: 'padding:8px 12px' });
      artifactsFor(job).forEach(function (artifact) { arts.appendChild(artifactButton(artifact)); });
      section.appendChild(arts);
      S.outLive.push({ jobId: job.id, pane: pane, toggle: toggle, arts: arts });
      streamJob(job.id);
      setTimeout(function () { pane.scrollTop = pane.scrollHeight; }, 0);
    }
  }
  return section;
}

function artifactsFor(job) {
  return S.jobArts[job.id] || job.artifacts || [];
}

/** The live panes currently on screen for one job; stale ones fall away here. */
function mountedOut(jobId) {
  S.outLive = S.outLive.filter(function (out) { return out.pane.isConnected; });
  return S.outLive.filter(function (out) { return out.jobId === jobId; });
}

/** Rebuild every mounted pane for a job from the buffered lines (after a replay). */
function repaintOut(jobId) {
  mountedOut(jobId).forEach(function (out) {
    clear(out.pane);
    (S.jobLines[jobId] || []).forEach(function (line) { out.pane.appendChild(outLine(line)); });
    out.pane.scrollTop = out.pane.scrollHeight;
    out.toggle.textContent = '▾ Command output (' + (S.jobLines[jobId] || []).length + ' lines)';
    clear(out.arts);
    (S.jobArts[jobId] || []).forEach(function (artifact) { out.arts.appendChild(artifactButton(artifact)); });
  });
}

/**
 * One EventSource per running job, opened when its output section is on
 * screen and closed when the job finishes. The replay event fills in whatever
 * a reloaded page missed; every later line is appended straight onto the
 * mounted pane — never through render(), because lines arrive far faster than
 * the poll and rebuilding the page per line would steal the click that lands
 * in the same tick. Same reasoning that keeps progress outside dataSignature().
 */
function streamJob(jobId) {
  if (S.streams[jobId]) return;
  var es = new EventSource('/api/jobs/' + encodeURIComponent(jobId) + '/events');
  S.streams[jobId] = es;
  es.addEventListener('replay', function (event) {
    var data = JSON.parse(event.data);
    S.jobLines[jobId] = data.lines.slice();
    S.jobArts[jobId] = data.artifacts.slice();
    repaintOut(jobId);
  });
  es.addEventListener('line', function (event) {
    var line = JSON.parse(event.data);
    (S.jobLines[jobId] = S.jobLines[jobId] || []).push(line);
    mountedOut(jobId).forEach(function (out) {
      out.pane.appendChild(outLine(line));
      out.pane.scrollTop = out.pane.scrollHeight;
      out.toggle.textContent = '▾ Command output (' + S.jobLines[jobId].length + ' lines)';
    });
  });
  es.addEventListener('artifact', function (event) {
    var artifact = JSON.parse(event.data);
    (S.jobArts[jobId] = S.jobArts[jobId] || []).push(artifact);
    mountedOut(jobId).forEach(function (out) { out.arts.appendChild(artifactButton(artifact)); });
  });
  es.addEventListener('done', function () {
    es.close();
    delete S.streams[jobId];
    // The proof has landed (or the job died); the poll's re-render swaps the
    // live card for the finished one, whose output starts collapsed.
    refresh();
  });
}

/* ------------------------------------------------ saved repositories */

/**
 * Machinery › Repositories: scan a repo once, and every verification can
 * ground itself in it via the launcher's dropdown. Saving runs the
 * whitelisted "context add" — a job like any other, so the scan's output
 * lands in the ordinary drawer and the panel reimplements nothing.
 */
function renderRepos(main) {
  main.appendChild(pageHead('Repositories',
    'Code wowlidator has scanned and remembers. Select one on a run and the authored steps ground themselves in what that code declares — routes, endpoints, tables. Scanning is static: no model call, no browser.',
    startButton()));

  var path = el('input', { type: 'text', class: 'mono', style: 'flex:1',
    placeholder: '/absolute/path/to/the/app-under-test' });
  var save = el('button', {
    type: 'button', class: 'btn accent', text: 'Scan and save',
    onclick: function () {
      var value = path.value.trim();
      if (!value) { toast('give the repository path to scan'); return; }
      post('context-add', { path: value }, null);
    }
  });
  main.appendChild(el('div', { class: 'card', style: 'padding:16px;margin-bottom:16px' }, [
    el('div', { style: 'display:flex;gap:8px;align-items:center' }, [path, save]),
    el('div', { class: 'sub', style: 'margin:8px 0 0', text:
      'Re-scanning the same path updates it in place. An OpenAPI spec or DB schema can be added from the command panel’s "Save a repository" form.' })
  ]));

  if ((S.repos || []).length === 0) {
    main.appendChild(el('div', { class: 'mono', style: 'padding:12px',
      text: 'nothing saved yet — scan the repository of the site under test above' }));
    return;
  }

  var body = el('tbody');
  (S.repos || []).forEach(function (repo) {
    // Documents remembered WITH the repository: uploaded once here, read
    // fresh on every run grounded in this repo. A file re-uploaded under the
    // same name replaces the remembered one — that is how an updated spec
    // supersedes the old copy.
    var pathCell = el('td', { class: 'mono' }, [document.createTextNode(repo.path)]);
    if (repo.contextDocs && repo.contextDocs.length > 0) {
      pathCell.appendChild(el('div', { style: 'margin-top:4px;font-size:11px;color:var(--muted)',
        title: 'context documents remembered with this repository — every run grounded in it reads them automatically',
        text: 'remembers: ' + repo.contextDocs.map(function (d) { return d.split('/').pop(); }).join(', ') }));
    }
    var docPicker = el('input', { type: 'file', accept: DOCUMENT_ACCEPT, style: 'display:none',
      onchange: function (e) {
        var chosen = e.target.files && e.target.files[0];
        if (!chosen) return;
        readFileAsBase64(chosen)
          .then(function (base64) { return saveDocument('context', { name: chosen.name, contentBase64: base64 }); })
          .then(function (doc) {
            toast('remembering ' + chosen.name + ' with ' + repo.slug + '…');
            return post('context-add', { path: repo.path, 'context-doc': [doc.path] }, null);
          })
          ['catch'](function (error) { toast(error.message); });
      } });
    body.appendChild(el('tr', {}, [
      el('td', {}, [el('code', { text: repo.slug })]),
      pathCell,
      el('td', { class: 'col-r mono', text: String(repo.nodes) }),
      el('td', { class: 'mono', text: (repo.indexedAt || '').slice(0, 16).replace('T', ' ') }),
      el('td', { class: 'col-r' }, [
        docPicker,
        el('button', { type: 'button', class: 'link', text: 'Remember document…',
          title: 'markdown, text, PDF, PowerPoint, Excel or CSV — background every run grounded in this repository will read',
          onclick: function () { docPicker.click(); } }),
        document.createTextNode(' '),
        el('button', { type: 'button', class: 'link', text: 'Re-scan',
          onclick: function () { post('context-add', { path: repo.path }, null); } })
      ])
    ]));
  });
  main.appendChild(el('table', { class: 'tbl' }, [
    el('thead', {}, [el('tr', {}, [
      el('th', { text: 'Repository' }),
      el('th', { text: 'Path' }),
      el('th', { class: 'col-r', style: 'width:90px', text: 'Nodes' }),
      el('th', { style: 'width:150px', text: 'Scanned' }),
      el('th', { style: 'width:90px' })
    ])]),
    body
  ]));
}

/* --------------------------------------------------------- checks table */

/* Mirror of BACKEND_TIER_ACTIONS in engine/proof-bundle.ts — the client is a
   template string and cannot import it, so tests/wow-ui.test.ts pins every
   member of the real set against this page to stop the two drifting apart. */
var BACKEND_ACTIONS = { request: 1, expectStatus: 1, expectJson: 1, expectHeader: 1,
  expectCalls: 1, dbSnapshot: 1, expectDbRow: 1, expectDbDelta: 1, expectDbUnchanged: 1, expectDbCalled: 1 };

/* The claims at a glance, above the table: the test's polarity and every
   assertion's expected-vs-actual, so a reader sees what was demanded and what
   the page really held before scrolling a step list. Only assertions that
   recorded a comparison appear — an action step has nothing to compare. */
function claimsSummary(bundle) {
  var rows = (bundle.steps || []).filter(function (step) {
    return !step.superseded && step.detail && step.detail.expected !== undefined;
  });
  var tag = polarityTag(bundle.polarity, bundle.polaritySource);
  if (rows.length === 0 && !tag) return null;

  var box = el('div', { class: 'claims-summary' });
  var head = el('div', { class: 'cs-head' }, [
    el('span', { class: 'cap', text: 'Expected vs actual' }),
    tag
  ]);
  box.appendChild(head);
  rows.forEach(function (step) {
    var passed = step.status === 'passed';
    var render = function (v) { return typeof v === 'string' ? v : JSON.stringify(v); };
    var line = el('div', { class: 'cs-row' }, [
      el('span', { class: 'cd ' + (passed ? 'pass' : 'fail') }),
      el('span', { class: 'cs-claim', text: stepClaim(step) })
    ]);
    var cmp = el('div', { class: 'cs-cmp mono' });
    cmp.appendChild(document.createTextNode('expected '));
    cmp.appendChild(el('b', { text: render(step.detail.expected) }));
    if (step.detail.actual !== undefined) {
      cmp.appendChild(document.createTextNode(' \u00b7 actual '));
      cmp.appendChild(el('b', { style: passed ? null : 'color:var(--bad)', text: render(step.detail.actual) }));
    }
    line.appendChild(cmp);
    box.appendChild(line);
  });
  return box;
}

/* Why the run is red, under the table — the same pure verdict the HTML report
   leads with, served alongside the bundle so the two surfaces cannot disagree
   about the same run. Rendered only for failed / error / dead-end: a green
   run's why is the table itself. */
function whyBlock(bundle) {
  if (bundle.status !== 'failed' && bundle.status !== 'error' && bundle.status !== 'dead-end') return null;
  var verdict = S.verdicts[bundle.runId];
  var box = el('div', { class: 'why-block' });
  box.appendChild(el('div', { class: 'cap', text: 'Why it ' + (bundle.status === 'failed' ? 'failed' : bundle.status === 'dead-end' ? 'dead-ended' : 'errored') }));
  if (verdict) {
    box.appendChild(el('div', { class: 'why-headline', text: verdict.headline }));
    if (verdict.what) box.appendChild(el('div', { class: 'why-line', text: verdict.what }));
    if (verdict.side) box.appendChild(el('div', { class: 'why-line', text: verdict.side }));
    if (verdict.history) box.appendChild(el('div', { class: 'why-line muted2', text: verdict.history }));
    if (verdict.firstFailingStep !== null && verdict.firstFailingStep !== undefined) {
      box.appendChild(el('div', { class: 'why-line muted2', text: 'First broken step: ' + verdict.firstFailingStep + ' \u2014 its row above carries the evidence.' }));
    }
  } else {
    // The verdict travels with the bundle fetch; a bundle read before this
    // build (or a fetch that failed) still gets the honest floor.
    var step = (bundle.steps || []).filter(function (s) { return s.status !== 'passed' && !s.superseded; })[0];
    box.appendChild(el('div', { class: 'why-line', text: bundle.error || (step ? stepClaim(step) + ' \u2014 ' + ((step.error || '').split('\n')[0] || 'did not hold') : 'the run did not complete') }));
  }
  return box;
}

/* proved-? — the run defers to a human. The block carries the proof of each
   unsure part (the exact expected-vs-actual pair) and the two rulings; the
   POST writes the review ruling into the bundle file beside the machine's status. */
function reviewBlock(bundle) {
  if (bundle.status !== 'needs-review') return null;
  var box = el('div', { class: 'why-block', style: 'border-left-color:var(--warn)' });
  box.appendChild(el('div', { class: 'cap', text: 'Proved-? — needs a human ruling' }));
  box.appendChild(el('div', { class: 'why-line', text:
    'Every broken step failed only on wording, and closely: the page produced the right kind of thing under a name the claim does not quite match. Whether that is a spec violation or an acceptable rendering is your call, not the machine\u2019s.' }));
  (bundle.steps || []).forEach(function (step) {
    if (!step.unsure || step.superseded) return;
    var row = el('div', { class: 'why-line' });
    row.appendChild(el('b', { text: stepClaim(step) + ': ' }));
    row.appendChild(el('span', { class: 'mono', style: 'font-size:11px', text: step.unsure }));
    box.appendChild(row);
  });
  if (bundle.review) {
    var byModel = !!bundle.review.by;
    box.appendChild(el('div', { class: 'why-line', style: 'margin-top:8px' }, [
      el('b', { text: 'Ruled ' + (bundle.review.verdict === 'proved' ? 'PROVED' : 'FAILED') }),
      document.createTextNode(
        byModel
          ? ' automatically by ' + bundle.review.by +
            (bundle.review.confidence !== undefined ? ' at confidence ' + Number(bundle.review.confidence).toFixed(2) : '') +
            ' \u00b7 ' + timeAgo(bundle.review.at)
          : ' by a human \u00b7 ' + timeAgo(bundle.review.at)
      )
    ]));
    if (byModel && bundle.review.reasoning) {
      box.appendChild(el('div', { class: 'why-line mono', style: 'font-size:11px', text: bundle.review.reasoning }));
    }
    /* A model ruling is replaceable by a human \u2014 never the reverse. */
    if (!byModel) return box;
    box.appendChild(el('div', { class: 'why-line', style: 'margin-top:6px', text: 'Disagree? Your ruling replaces the model\u2019s.' }));
  }
  var rule = function (verdict, label, cls) {
    return el('button', { type: 'button', class: 'btn ' + cls, text: label, onclick: function () {
      api('/api/proofs/' + encodeURIComponent(bundle.runId) + '/review', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ verdict: verdict })
      }).then(function () {
        toast('ruled ' + verdict);
        delete S.bundles[bundle.runId];
        return loadBundle(bundle.runId);
      }).then(render)['catch'](function (e) { toast(e.message); });
    } });
  };
  box.appendChild(el('div', { class: 'acts', style: 'margin-top:10px' }, [
    rule('proved', 'Confirm proved', 'accent'),
    rule('failed', 'Confirm failed', '')
  ]));
  return box;
}

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
    var compare = expectedActualOf(step);
    if (compare) {
      what.appendChild(el('div', {
        class: 'mono',
        style: 'margin-top:4px;font-size:11px;color:' + (passed ? 'var(--muted)' : 'var(--bad)'),
        text: compare
      }));
    }
    // "It failed" routes to different people depending on the side it
    // exercised — same split summary.frontend/backend makes for the run.
    if (BACKEND_ACTIONS[step.action] === 1) {
      what.appendChild(el('span', { class: 'tag',
        title: 'a backend step — it exercised HTTP, observed traffic, or the database, not the page',
        text: 'backend' }));
    }
    if (family) what.appendChild(el('span', { class: 'tag', title: 'the kind of problem this is — a label from the run, not the raw evidence', text: family }));
    if (step.unsure) {
      what.appendChild(el('span', { class: 'tag warn',
        title: step.unsure,
        text: 'proved-?' }));
    }
    /* Proved on screen, when the backend could have proved it better. Not a
       warning and not a verdict — the visual check really did pass; this says
       a stronger proof exists and this run was told not to take it. */
    if (step.backendHint) {
      what.appendChild(el('span', { class: 'tag',
        title: 'backend testing was off for this run — a backend check could prove this more directly: ' + step.backendHint,
        text: 'visual only' }));
    }

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

    /* A workflow step is the one step whose work is invisible from its row:
       the agent took the browser for N turns and the row can only say
       "workflow". Expanding it inline shows the turn-by-turn log right where
       the step is, without leaving for the drawer — asked for directly, and
       the same evidence the drawer's Trace tab holds. */
    var acts = (step.agent && step.agent.actions) || [];
    var expandKey = 'agent:' + bundle.runId + ':' + step.index;
    var expanded = S.openTask === expandKey;
    var lastCell = el('td', { class: 'col-r' }, [
      step.agent
        ? el('button', {
            type: 'button', class: 'link',
            title: 'the agent drove the browser here — see every action it took',
            text: (expanded ? '▾ ' : '▸ ') + acts.length + ' agent action' + (acts.length === 1 ? '' : 's'),
            onclick: function () { S.openTask = expanded ? null : expandKey; render(); }
          })
        : null,
      el('button', { type: 'button', class: 'link', text: 'See evidence', onclick: function () { openEvidence(bundle, step, null); } })
    ]);

    body.appendChild(el('tr', {}, [what, how, took, verdict, lastCell]));

    if (step.agent && expanded) {
      var inner = el('td', { colspan: '5', style: 'padding:10px 12px;background:var(--sunken,rgba(0,0,0,.04))' });
      inner.appendChild(el('div', { class: 'cap', text: 'The goal the agent was given' }));
      inner.appendChild(el('div', { class: 'repro', text: step.agent.goal }));
      inner.appendChild(el('div', { class: 'cap', text: 'What it reported' }));
      inner.appendChild(el('div', { class: 'repro', text: step.agent.summary }));
      inner.appendChild(el('div', { class: 'kv' }, [
        el('b', { text: 'turns: ' }),
        document.createTextNode(
          step.agent.turns + (step.agent.maxSteps == null ? ' (no ceiling)' : ' of ' + step.agent.maxSteps) +
          ' \u00b7 ' + step.agent.model + ' \u00b7 ' + fmtMs(step.agent.latencyMs) +
          ' \u00b7 ' + (step.agent.inputTokens || 0) + ' in / ' + (step.agent.outputTokens || 0) + ' out tokens')
      ]));
      if (step.detail && step.detail.settledBy) {
        inner.appendChild(el('div', { class: 'kv', style: 'color:var(--faint)' }, [
          el('b', { text: 'settled by ' + step.detail.settledBy + ': ' }),
          document.createTextNode(String(step.detail.evidence || ''))
        ]));
      }
      if (acts.length === 0) {
        inner.appendChild(el('div', { class: 'muted2', text: 'the agent took no action at all' }));
      } else {
        inner.appendChild(el('div', { class: 'cap', text: 'Every action it took, in order' }));
        inner.appendChild(el('div', { class: 'repro', text: agentActionLog(acts) }));
      }
      body.appendChild(el('tr', {}, [inner]));
    }
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
  S.drawer = null;
  renderDrawer();
}

/* The drawer shows step evidence only. A job's console lives under its own
   card — see outputSection — so there is exactly one way output is shown. */
function renderDrawer() {
  var host = byId('drawer');
  clear(host);
  if (!S.drawer) return;
  var panel = evidencePanel(S.drawer);
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
  var flowPath = flowPathFor(bundle.name, bundle.renamedFrom);
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
  var flowPath = flowPathFor(bundle.name, bundle.renamedFrom);
  panel.appendChild(el('div', {
    class: 'repro',
    text: flowPath
      ? 'wowlidator run ' + flowPath
      : 'the flow file is not visible from here; this step was:\n' +
        JSON.stringify({ action: step.action, selector: step.selector || undefined }, null, 2)
  }));

  // The database check this step made, when it was one. Everything shown was
  // redacted before it reached the bundle (redact-row.ts).
  if (step.db) {
    panel.appendChild(el('div', { class: 'cap', text: 'Database check' }));
    var dbMeta = el('div', {});
    [
      ['check', step.db.kind + (step.db.table ? ' \u2014 ' + step.db.table : step.db.tables ? ' \u2014 ' + step.db.tables.join(', ') : '')],
      step.db.where ? ['where', step.db.where] : null,
      step.db.expected ? ['expected', step.db.expected] : null,
      step.db.observed ? ['observed', step.db.observed] : null,
      step.db.polledMs ? ['polled', step.db.polledMs + 'ms \u2014 eventual consistency, on the record'] : null
    ].forEach(function (pair) {
      if (!pair) return;
      dbMeta.appendChild(el('div', { class: 'kv' }, [el('b', { text: pair[0] + ': ' }), document.createTextNode(String(pair[1]))]));
    });
    panel.appendChild(dbMeta);
    if (step.db.note) panel.appendChild(el('div', { class: 'callout', text: step.db.note }));
    if (step.db.rows && step.db.rows.length) {
      var sample = el('div', { class: 'calls' });
      step.db.rows.forEach(function (row) {
        sample.appendChild(el('div', { text: Object.keys(row).map(function (column) { return column + ' = ' + row[column]; }).join('  \u00b7  ') }));
      });
      panel.appendChild(sample);
    }
  }

  // expectCalls carries its match table on the step's detail — one line per
  // expected entry, matched or NOT OBSERVED, plus any forbidden call it saw.
  var asserted = step.detail && step.detail.calls;
  if (asserted && asserted.length) {
    panel.appendChild(el('div', { class: 'cap', text: 'Traffic this step asserted' }));
    var table = el('div', { class: 'calls' });
    asserted.forEach(function (line) {
      table.appendChild(el('div', {
        style: line.indexOf('NOT OBSERVED') >= 0 ? 'color:var(--bad)' : '',
        title: line, text: line }));
    });
    panel.appendChild(table);
  }
  var forbidden = step.detail && step.detail.violations;
  if (forbidden && forbidden.length) {
    panel.appendChild(el('div', { class: 'cap', text: 'Forbidden calls it observed' }));
    var hits = el('div', { class: 'calls' });
    forbidden.forEach(function (line) {
      hits.appendChild(el('div', { style: 'color:var(--bad)', title: line, text: line }));
    });
    panel.appendChild(hits);
  }

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
      document.createTextNode(step.agent.turns + (step.agent.maxSteps == null ? ' (no ceiling)' : ' of ' + step.agent.maxSteps) + ' · ' + step.agent.model)
    ]));
    /* The action log: what the agent actually DID with the browser, turn by
       turn — the evidence behind the summary above. A password-shaped fill
       shows its length, never its characters. */
    var acts = step.agent.actions || [];
    if (acts.length > 0) {
      panel.appendChild(el('div', { class: 'cap', text: 'What the agent did (' + acts.length + ' action(s))' }));
      panel.appendChild(el('div', { class: 'repro', text: agentActionLog(acts) }));
    }
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

/* -------------------------------------------------------------- history */

/**
 * Failed runs: jobs that finished without producing a proof. Each row is the
 * job's own account — command line, exit code, the last lines it printed —
 * because the reason ("cannot reach http://localhost:3000") is the evidence.
 */
function renderFailedRuns(main) {
  var list = S.failedRuns || [];
  if (list.length === 0) return;
  main.appendChild(el('div', { class: 'group-head' }, [
    el('div', { class: 'group-title', text: 'Failed runs — no proof was produced (' + list.length + ')' }),
    el('div', { class: 'muted2', text: 'The run ended before it could assert anything. Nothing here is a verdict about the application.' })
  ]));
  var rows = el('div', { class: 'card rows in-group' });
  list.forEach(function (run) {
    var key = 'failed-run:' + run.id;
    var open = S.openTask === key;
    var kind = run.status === 'failed' ? 'escalated' : 'blocked';
    var label = run.status === 'stopped' ? 'stopped' : run.status === 'failed' ? 'failed' : 'did not run';
    var last = run.reason.length ? run.reason[run.reason.length - 1] : 'no output';
    rows.appendChild(el('div', {
      class: 'row' + (open ? ' open' : ''), role: 'button', tabindex: '0', 'aria-expanded': open ? 'true' : 'false',
      onclick: function () { S.openTask = open ? null : key; render(); },
      onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); S.openTask = open ? null : key; render(); } }
    }, [
      loopRail(['bad', 'empty', 'empty']),
      el('div', { class: 'task-cell' }, [
        el('div', { class: 'task-name', text: run.title }),
        el('div', { class: 'task-sub', text: last })
      ]),
      verdictChip(kind, label),
      el('span', { class: 'when', text: shortTime(run.finishedAt) + (run.exitCode === null ? '' : ' · exit ' + run.exitCode) })
    ]));
    if (open) {
      var detail = el('div', { class: 'detail' });
      detail.appendChild(el('div', { class: 'why-line muted2', text: run.commandLine }));
      var pane = el('div', { class: 'mono', style: 'margin-top:var(--s2);max-height:300px;overflow:auto;padding:8px 12px;white-space:pre-wrap;font-size:var(--fs-xs)' });
      run.reason.forEach(function (text) { pane.appendChild(el('div', { text: text })); });
      detail.appendChild(pane);
      rows.appendChild(detail);
    }
  });
  main.appendChild(rows);
}

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
        'aria-expanded': outIsOpen(job.id, job) ? 'true' : 'false',
        onclick: function () { toggleOut(job.id, job); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleOut(job.id, job); } }
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
          el('button', { type: 'button', class: 'btn', text: 'Output', onclick: function () { toggleOut(job.id, job); } })
        ])
      ]));
      var pendingDetail = el('div', { class: 'detail' });
      var pendingCases = caseSections(job);
      if (pendingCases) pendingDetail.appendChild(pendingCases);
      pendingDetail.appendChild(outputSection(job.id, job));
      pending.appendChild(pendingDetail);
    });
    main.appendChild(pending);
  }

  // Runs that ended without a proof — the app was down, Chrome would not
  // attach, someone stopped it. No bundle, so no row below; remembered by the
  // server instead, and shown here under the verdicts they never reached.
  if (S.filter === 'all' || S.filter === 'failed') renderFailedRuns(main);

  var counts = {
    all: S.proofs.length,
    passed: S.proofs.filter(function (p) { return isPassing(p.status); }).length,
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
    if (S.filter === 'passed') return isPassing(p.status);
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

  // Runs are grouped by the authoring pass that produced them. The key is the
  // pass, never the document's name — running the same catalog again makes a
  // NEW group, so this morning's six cases never pile on top of last night's
  // six under one averaged pass rate. See groupRuns() in proofs.ts.
  var kept = {};
  shown.forEach(function (p) { kept[p.runId] = true; });
  var groups = (S.groups || []).map(function (group) {
    return { group: group, runs: group.runs.filter(function (r) { return kept[r.runId]; }) };
  }).filter(function (entry) { return entry.runs.length > 0; });

  // A proof directory written before grouping existed has no provenance to
  // group on. One flat list is the honest fallback: better than a page that
  // renders nothing because every group came back empty.
  if (groups.length === 0) groups = [{ group: null, runs: shown }];

  groups.forEach(function (entry) {
    if (entry.group) main.appendChild(groupHeader(entry.group, entry.runs));
    if (entry.group && S.shutGroups[entry.group.id]) return;
    var rows = el('div', { class: 'card rows' + (entry.group ? ' in-group' : '') });
    var scenarios = entry.group ? entry.group.scenarios || [] : [];
    var flat = scenarios.length <= 1 && (scenarios.length === 0 || scenarios[0].title === 'ungrouped');
    if (flat) {
      entry.runs.forEach(function (card) { appendHistoryRow(rows, card); });
    } else {
      // The server's scenario split, narrowed to the runs the filter kept.
      scenarios.forEach(function (sc) {
        var list = sc.runs.filter(function (r) { return kept[r.runId]; });
        if (list.length === 0) return;
        if (!scenarioHead(sc.id, sc.title, list, rows)) return;
        list.forEach(function (card) { appendHistoryRow(rows, card); });
      });
    }
    main.appendChild(rows);
  });
}

/**
 * One group's header: what produced these runs, and how they went.
 *
 * Clicking collapses it. Open is the default and the state is remembered only
 * for the groups someone has actually shut, so a run that lands in a new group
 * while the page is polling shows up rather than arriving pre-hidden.
 */
function groupHeader(group, runs) {
  var shut = !!S.shutGroups[group.id];
  var passed = 0, failed = 0, quarantined = 0;
  runs.forEach(function (r) {
    if (r.quarantined) { quarantined += 1; return; }
    if (isPassing(r.status)) passed += 1; else failed += 1;
  });
  var sub = group.kind + ' · ' + runs.length + ' run' + (runs.length === 1 ? '' : 's');
  if (group.authoredAt) sub += ' · authored ' + shortTime(group.authoredAt);
  if (quarantined) sub += ' · ' + quarantined + ' quarantined';
  function toggle() { S.shutGroups[group.id] = !shut; render(); }
  return el('div', {
    class: 'run-group' + (shut ? ' shut' : ''), role: 'button', tabindex: '0',
    'aria-expanded': shut ? 'false' : 'true',
    onclick: toggle,
    onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }
  }, [
    el('span', { class: 'twist', text: shut ? '\u25B8' : '\u25BE' }),
    el('div', { class: 'group-cell' }, [
      el('div', { class: 'group-name', text: group.title }),
      el('div', { class: 'group-sub', text: sub })
    ]),
    el('span', { class: 'group-tally' }, [
      el('b', { class: passed === runs.length ? 'ok' : '', text: String(passed) }),
      document.createTextNode(' passed'),
      failed ? el('b', { class: 'bad', text: ' · ' + failed + ' failed' }) : document.createTextNode(''),
      group.defects ? el('span', { class: 'muted', text: ' · ' + group.defects + ' defect(s)' }) : document.createTextNode(''),
      document.createTextNode(' · '),
      tallyLine(tallyOf(runs), runs.length),
      (function () {
        if (group.kind !== 'catalog') return document.createTextNode('');
        var acc = accuracyLine(runs);
        if (!acc) return document.createTextNode('');
        var wrap = el('span', {});
        wrap.appendChild(document.createTextNode(' · '));
        wrap.appendChild(acc);
        return wrap;
      })()
    ]),
    el('span', { class: 'when', text: timeAgo(group.finishedAt) })
  ]);
}

/** One run inside a group — the row, plus its detail when it is open. */
function appendHistoryRow(rows, card) {
  {
    var open = S.openTask === 'history:' + card.runId;
    rows.appendChild(el('div', {
      class: 'row' + (open ? ' open' : ''), role: 'button', tabindex: '0',
      onclick: function () { toggleHistory(card); },
      onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleHistory(card); } }
    }, [
      loopRail([isPassing(card.status) ? 'ok' : 'bad', 'empty', 'empty']),
      el('div', { class: 'task-cell' }, [
        el('div', { class: 'task-name' }, [
          document.createTextNode(card.name),
          polarityTag(card.polarity, card.polaritySource)
        ]),
        el('div', { class: 'task-sub', text: (caseTitleOf(card) ? caseTitleOf(card) + ' · ' : '') + card.runId + ' · ' + fmtMs(card.durationMs) + (card.trend ? ' · ' + card.trend : '') })
      ]),
      card.status === 'needs-review'
        ? (card.review
            ? verdictChip(effStatus(card) === 'passed' ? 'verified' : 'feedback',
                effStatus(card) === 'passed' ? 'proved (human-confirmed)' : 'failed (human-confirmed)')
            : verdictChip('doubt', 'proved-?'))
        : card.status === 'passed'
          ? verdictChip('verified', card.quarantined ? 'quarantined' : 'proved')
          : card.status === 'passed-with-issues'
            ? verdictChip('doubt', 'pass**')
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
      rows.appendChild(el('div', { class: 'detail' }, bundle
        ? [claimsSummary(bundle), checksTable(bundle), reviewBlock(bundle), whyBlock(bundle)].filter(Boolean)
        : [el('div', { class: 'mono', style: 'padding:12px', text: 'reading the proof bundle…' })]));
    }
  }
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
      var flowPath = flowPathFor(item.task.name, item.task.latest && item.task.latest.renamedFrom);
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
      // A fixed-model provider has no id to pick: the server answers with
      // whatever it loaded, so the first (only) listed alias is the choice.
      if (first === '' && !(next && next.fixedModel)) {
        toast('pick a model for ' + provider.value + ' — its catalogue could not be read');
        model.value = '';
        model.focus();
        return;
      }
      // Moving onto local keeps whichever port the field shows.
      selectModel(role, provider.value, first, provider.value === 'local' ? port.value : null);
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

  // A local server is chosen by port, not by model id: two rerise
  // instances differ only by the port they listen on. Shown only for local;
  // for every other provider there is no server on this machine to point at.
  var port = el('input', {
    class: 'inp mono', type: 'number', min: '1', max: '65535', step: '1',
    value: entry.port === null ? '' : String(entry.port),
    'aria-label': role + ' local server port', placeholder: 'port',
    style: 'flex: 0 0 auto; width: 7em',
    onchange: function () {
      var value = port.value.trim();
      if (value !== '' && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535)) {
        toast('a port is a number from 1 to 65535');
        port.value = entry.port === null ? '' : String(entry.port);
        return;
      }
      selectModel(role, provider.value, entry.modelId, value === '' ? null : Number(value));
    }
  });

  // No model field for a provider that ignores the model in a request — the
  // model was chosen where the server was started, and a box here would
  // invite an id the run would record and the server would never honour.
  var row = el('div', { class: 'picker' },
    entry.provider === 'local' ? [provider, el('span', { class: 'mono', text: 'localhost :' }), port]
      : catalogue.fixedModel ? [provider] : [provider, model, datalist]);
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
  } else if (entry.provider === 'local') {
    below.appendChild(el('span', { class: 'mono', text: 'the server on ' + (entry.baseUrl || '') + ' decides the model' }));
  } else if (catalogue.fixedModel) {
    below.appendChild(el('span', { class: 'mono', text: 'the server decides the model' }));
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

/**
 * Is this role's model ready — the last real call the panel made to find out.
 *
 * The catalogue cannot answer it (a listed id can be rate-limited into
 * uselessness) and neither can the key mask (a present key can be out of
 * quota). Only a call can, so there is a button, and it spends one small
 * call — never on a poll. The verdict is chosen by cause: out of quota, key
 * refused, model missing and provider unreachable are fixed in different
 * places, and one red "failed" would send someone to the wrong one.
 */
function CHECK_CHIP(status) {
  if (status === 'ready') return ['verified', 'ready'];
  if (status === 'empty') return ['feedback', 'empty reply'];
  if (status === 'exhausted') return ['escalated', 'out of quota'];
  if (status === 'rejected') return ['escalated', 'key refused'];
  if (status === 'model-missing') return ['escalated', 'model missing'];
  if (status === 'unreachable') return ['blocked', 'unreachable'];
  if (status === 'no-key') return ['feedback', 'no key'];
  return ['escalated', 'failed'];
}

function fmtInt(n) {
  return typeof n === 'number' ? n.toLocaleString() : String(n);
}

function checkCell(role) {
  var checking = (S.models.checking || []).indexOf(role) !== -1;
  var check = (S.models.checks || []).filter(function (c) { return c.role === role; })[0];
  var top = el('div', { style: 'display:flex; gap:8px; align-items:center; justify-content:flex-end' });

  if (checking) {
    top.appendChild(verdictChip('running', 'checking…'));
  } else if (check) {
    var chip = CHECK_CHIP(check.status);
    top.appendChild(el('span', {
      class: 'chip ' + chip[0], text: chip[1],
      title: 'checked ' + timeAgo(check.checkedAt) + ' — ' + check.detail
    }));
  } else {
    top.appendChild(el('span', { class: 'counts none', text: 'not checked' }));
  }
  top.appendChild(el('button', {
    type: 'button', class: 'btn' + (check || checking ? '' : ' accent'), disabled: checking,
    title: 'Make one small real call (~10 tokens) through the key this role would start on and the model it points at, and report whether it is ready, out of quota, refused, missing or unreachable',
    text: checking ? 'checking…' : check ? 'Re-check' : 'Check',
    onclick: function () { checkRole(role); }
  }));

  var note = el('div', { class: 'picker-note', style: 'text-align:right' });
  if (check && !checking) {
    var lines = [];
    if (check.status === 'ready' || check.status === 'empty') {
      var line = 'answered in ' + check.latencyMs + 'ms';
      if (check.usage) line += ', ' + fmtInt(check.usage.inputTokens) + ' in / ' + fmtInt(check.usage.outputTokens) + ' out';
      if (check.keyMask && check.keyCount > 1) line += ', on ' + check.keyMask;
      if (check.status === 'empty') line += ' — empty reply; the model may not suit this role';
      lines.push(line);
      if (check.quota && check.quota.remainingTokens !== null) {
        var q = fmtInt(check.quota.remainingTokens) + ' tokens left';
        if (check.quota.limitTokens !== null) q += ' of ' + fmtInt(check.quota.limitTokens);
        if (check.quota.resetTokens) q += ' · refills in ' + check.quota.resetTokens;
        if (check.quota.remainingRequests !== null) q += ' · ' + fmtInt(check.quota.remainingRequests) + ' requests left';
        lines.push(q);
      }
    } else {
      lines.push(check.detail);
      if (check.status === 'exhausted' && check.quota && check.quota.resetTokens) {
        lines.push('token bucket refills in ' + check.quota.resetTokens);
      }
    }
    // The failover trail: which keys were tried and abandoned before the
    // answer. That is the evidence for clicking "Start here" on another key.
    // On a failure the last attempt IS the headline, so it is not repeated.
    var trail = check.attempts || [];
    if (check.keyIndex === null) trail = trail.slice(0, -1);
    trail.forEach(function (a) {
      lines.push('key ' + (a.keyIndex + 1) + ': ' + a.detail);
    });
    lines.push('checked ' + timeAgo(check.checkedAt));
    lines.forEach(function (text) { note.appendChild(el('div', { class: 'mono', text: text })); });
  } else if (!checking) {
    note.appendChild(el('span', { class: 'mono', text: 'one small call tells you if it is ready or out of quota' }));
  }
  return el('div', {}, [top, note]);
}

/** Probe one role (or every role when role is empty) and redraw from what came back. */
function checkRole(role) {
  // Mark it running at once, so the button cannot be clicked twice before the
  // server answers — the server joins duplicate checks anyway, this just
  // keeps the page honest during the round trip.
  S.models.checking = (S.models.checking || []).concat(role ? [role] : (S.models.roles || []).map(function (r) { return r.role; }));
  render();
  api('/api/models/check', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(role ? { role: role } : {})
  }).then(function (body) {
    S.models = body;
    var checks = (body.checks || []).filter(function (c) { return !role || c.role === role; });
    var bad = checks.filter(function (c) { return c.status !== 'ready' && c.status !== 'empty'; });
    toast(bad.length === 0
      ? (role ? role + ' is ready' : 'all roles ready')
      : bad.map(function (c) { return c.role + ': ' + CHECK_CHIP(c.status)[1]; }).join(' · '));
    render();
  })['catch'](function (error) {
    S.models.checking = [];
    toast(error.message);
    render();
  });
}

/** Send one role's choice, and redraw from what came back. */
function selectModel(role, provider, modelId, port) {
  var payload = { role: role, provider: provider, modelId: modelId };
  // The port is a property of a local server: sent only for local, and
  // only when a number was typed — an empty field means the default port.
  if (provider === 'local' && port !== undefined && port !== null && port !== '') payload.port = port;
  api('/api/models', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  }).then(function (body) {
    S.models = body;
    // Only the next run is affected — nothing in flight is re-pointed.
    toast(role + ' → ' + provider + ':' + modelId + (payload.port ? ' on :' + payload.port : '') + ' (next run)');
    render();
  })['catch'](function (error) { toast(error.message); render(); });
}

function renderKeys(main) {
  main.appendChild(pageHead(
    'Models and keys',
    'Which model each role calls, which key it starts on, and whether that is ready right now. The first two are choices about the runs this panel starts; the third is one small real call, made when you ask, that says ready, out of quota, key refused, model missing or unreachable — nothing already running is re-pointed.',
    el('div', { style: 'display:flex; gap:8px' }, [
      el('button', {
        type: 'button', class: 'btn md accent', text: 'Check all roles',
        disabled: (S.models.checking || []).length > 0,
        title: 'One small real call per role (~10 tokens each), through the key it would start on. The same probe as wowlidator doctor.',
        onclick: function () { checkRole(''); }
      }),
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
        role.keyed ? checkCell(role.role) : verdictChip('feedback', 'no key')
      ])
    ]));
  });
  main.appendChild(el('table', { class: 'tbl', style: 'margin-bottom:24px' }, [
    el('thead', {}, [el('tr', {}, [
      el('th', { style: 'width:130px', text: 'Role' }),
      el('th', { text: 'Provider and model' }),
      el('th', { style: 'width:150px', text: 'Key in use' }),
      el('th', { text: 'Fallback' }),
      el('th', { class: 'col-r', style: 'width:280px', text: 'Ready?' })
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

  renderDbSection(main);

  main.appendChild(el('div', { class: 'box', style: 'text-align:left;margin-top:8px' }, [
    el('div', { class: 'big', text: 'What “Check” actually does' }),
    el('div', { class: 'why', style: 'max-width:none;margin:0 0 14px' }, [
      document.createTextNode('It makes one real call — “reply with the single word: ok” — through the exact key-failover path a run takes, against the model the row shows and starting on the key the row shows. That is the same probe wowlidator doctor runs, and it is the only thing that can tell a listed model from a usable one: a catalogue says an id exists, not that your key has quota left for it. The verdict is chosen by cause. Out of quota (429) or out of credit (402) means wait for the reset or start on another key; key refused (401/403) means the key itself; model missing means the id in the row; unreachable means the provider. Where the provider states its rate-limit headroom, the tokens left are shown too. If the first key was dead and a later one answered, the trail says so — the check never moves where runs start; that stays your click.')
    ]),
    el('div', { class: 'big', text: 'How a key gets swapped without you' }),
    el('div', { class: 'why', style: 'max-width:none;margin:0' }, [
      document.createTextNode('When a call comes back unauthorised, out of quota or rate-limited, wowlidator moves to the next key for that provider and carries on — for every role sharing it, so a dead key is only discovered once. It stays there; it never goes back to re-probe a key it already knows is dead. Each move is printed into the run’s output, so the run drawer is where you see one happen. A failure that is not about the key — a model that cannot emit JSON, a malformed prompt — never rotates, because spending a second key on a call that was never going to work would only hide which model failed.')
    ])
  ]));
}

/**
 * The database card: wowlidator's own WOWLIDATOR_DB_URL (masked), whether it
 * answers (on a click, never on a poll — a probe is a real connection to
 * someone's database), and what the scanned repositories' own files say
 * their database is when nothing is configured. The password never reaches
 * this page in any form — the DSN arrives masked, a repo hint carries only
 * WHERE a password is defined, and the suggestion is built without one.
 */
function renderDbSection(main) {
  var db = S.db;
  var section = el('section', { class: 'group' });
  section.appendChild(el('div', { class: 'group-head' }, [
    el('span', { class: 'avatar', text: 'D' }),
    el('b', { text: 'Database' }),
    el('span', { class: 'mono', text: 'WOWLIDATOR_DB_URL' }),
    el('span', { class: 'meta', style: 'margin-left:auto', text: 'what expectDbRow and the DB evidence verify against' })
  ]));
  var card = el('div', { class: 'card', style: 'padding:16px 20px' });
  if (!db) {
    card.appendChild(el('div', { class: 'mono', text: 'reading…' }));
  } else if (db.configured) {
    var head = el('div', { style: 'display:flex; align-items:center; gap:10px' }, [
      el('span', { class: 'mono', text: db.maskedUrl || '' }),
      el('span', { class: 'meta', text: db.passwordSet ? 'password set (never shown)' : 'no password in the DSN' }),
      el('button', {
        type: 'button', class: 'btn sm accent', style: 'margin-left:auto',
        text: db.checking ? 'Checking…' : 'Check',
        disabled: !!db.checking,
        title: 'Open one read-only session, count the visible tables, close. The same check as wowlidator doctor\u2019s db line.',
        onclick: checkDb
      })
    ]);
    card.appendChild(head);
    var facts = [];
    if (db.host) facts.push(db.host + (db.port ? ':' + db.port : ''));
    if (db.database) facts.push('database ' + db.database);
    if (db.user) facts.push('as ' + db.user);
    if (facts.length > 0) card.appendChild(el('div', { class: 'mono', style: 'margin-top:6px', text: facts.join(' · ') }));
    if (db.probe) {
      card.appendChild(el('div', { class: 'mono', style: 'margin-top:6px', text: (db.probe.ok ? '✓ ' : '✗ ') + db.probe.detail + ' · checked ' + timeAgo(db.probe.at) }));
    } else if (!db.checking) {
      card.appendChild(el('div', { class: 'meta', style: 'margin-top:6px', text: 'one read-only connection tells you if it answers and how many tables it can see' }));
    }
  } else {
    card.appendChild(el('div', { class: 'mono', text: 'nothing set. Database checks in flows will be blocked (not failed) until WOWLIDATOR_DB_URL is in .env.' }));
  }
  // What the scanned repositories say — shown whether or not a DSN is set, so
  // a configured DSN pointing somewhere the repo does not name is visible too.
  (db && db.hints || []).forEach(function (hint) {
    var where = (hint.host || '?') + (hint.port ? ':' + hint.port : '') + (hint.database ? '/' + hint.database : '');
    card.appendChild(el('div', { style: 'margin-top:10px' }, [
      el('div', { class: 'mono', text: 'repo ' + hint.repo + ' declares ' + hint.engine + ' at ' + where + ' (from ' + hint.source + ')' + (hint.passwordAt ? ' · password lives in ' + hint.passwordAt : '') }),
      hint.suggestedUrl ? el('div', { class: 'meta', text: 'suggestion: WOWLIDATOR_DB_URL=' + hint.suggestedUrl + ' — add the password yourself; wowlidator never reads one out of a repo' }) : el('span', {})
    ]));
  });
  section.appendChild(card);
  main.appendChild(section);
}

/** One real read-only connection, on a click. */
function checkDb() {
  if (S.db) S.db.checking = true;
  render();
  api('/api/db/check', { method: 'POST' }).then(function (body) {
    S.db = body;
    toast(body.probe && body.probe.ok ? 'database answers — ' + body.probe.tables + ' table(s) visible' : (body.probe ? body.probe.detail : 'no answer'));
    render();
  })['catch'](function (error) {
    if (S.db) S.db.checking = false;
    toast(error.message);
    render();
  });
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
 * The launcher — an inline, expandable section in the page flow, directly
 * under the "Runs and proof" header. It used to be a modal; the same form now
 * opens in place, because starting a verification is part of working the page,
 * not an interruption of it — and an overlay hid the runs it was about to add
 * to. Collapsing it resets everything, exactly as closing the modal did.
 *
 * Nobody picks a flow file here, and that is the point: a flow is something
 * wowlidator writes, not something a person maintains by hand. What a team
 * already has is documents, so the three ways in are all documents:
 *
 *   Add Context   background the model may read — an API doc, a design note,
 *                 a page saved as HTML. Stored, reusable, and never a source of
 *                 claims. Saving one starts nothing. (The app's repository is
 *                 context too, but it is MEMORY, not an upload: Machinery ›
 *                 Repositories scans and remembers it, and the Catalog and
 *                 Describe tabs offer the saved repos in a dropdown.)
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
function toggleLauncher() {
  if (S.launcher) { closeLauncher(); return; }
  openLauncher();
}

function openLauncher() {
  S.launcher = {
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
    scope: 'unit',     /* unit | e2e — see --scope; e2e is enforced, not hinted */
    // shared
    focus: '',
    url: '',
    repo: '',          /* slug of a saved repository to ground the run in */
    as: '',            /* email:password the run may sign in with — env-carried, never argv */
    autoheal: false,   /* --repair: a failed / error / dead-end case reruns itself after a fix */
    backend: false,    /* --backend: may this run call HTTP and read the database at all? */
    dbUrl: '',         /* WOWLIDATOR_DB_URL — env-carried like the sign-in pair, never argv */
    advanced: false,
    video: 'on',
    screenshots: 'auto',
    policy: 'forms',
    waitFor: '',
    error: '',
    busy: false
  };
  loadDocuments();
  // The section lives on the runs view; a start button pressed anywhere else
  // (the empty repos page, say) goes there, where the form actually is.
  if (S.view !== 'runs') { show('runs'); return; }
  render();
}

/** Collapsing resets the whole form — the same clean slate closing the modal gave. */
function closeLauncher() {
  S.launcher = null;
  render();
}

function loadDocuments() {
  return api('/api/documents?kind=context').then(function (body) {
    S.contextDocs = body.documents;
    renderLauncher();
  })['catch'](function () {});
}

function formField(label, optional, control, hint) {
  return el('div', {}, [
    el('label', {}, [
      document.createTextNode(label),
      optional ? el('span', { class: 'optional', text: ' — optional' }) : null
    ]),
    control,
    hint ? el('div', { class: 'mono', style: 'margin-top:4px', text: hint }) : null
  ]);
}

var DOCUMENT_ACCEPT = '.md,.markdown,.csv,.tsv,.html,.htm,.txt,.text,.log,.json,.yaml,.yml,.xlsx,.xlsm,.pptx,.ppsx,.pdf,.mmd,.mermaid,.puml,.plantuml';
/* Catalogs additionally take an IMAGE (or SVG render) of a sequence diagram —
   a model transcribes it to Mermaid text first (pixels for rasters, markup
   for .svg), and the transcript (not the picture) is what the gate reviews
   and the run reads. Context documents stay text: the server refuses an
   image there, so the picker must not offer one. */
var CATALOG_ACCEPT = DOCUMENT_ACCEPT + ',.png,.jpg,.jpeg,.webp,.svg';

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
      M.busy = true; M.error = ''; renderLauncher();
      readFileAsBase64(chosen)
        .then(function (base64) { return saveDocument('context', { name: chosen.name, contentBase64: base64 }); })
        .then(function () { M.busy = false; toast('context added'); return loadDocuments(); })
        ['catch'](function (error) { M.busy = false; M.error = error.message; renderLauncher(); });
    }
  });
  box.appendChild(formField('Upload a document', false, file,
    'md · csv · html · txt · json · yaml · xlsx · pptx · pdf · mmd · puml'));

  var name = el('input', { type: 'text', placeholder: 'leave-balance-api', value: M.ctxName,
    oninput: function (e) { M.ctxName = e.target.value; syncSubmit(); } });
  box.appendChild(formField('…or name some text and paste it', false, name));

  var text = el('textarea', { rows: '5', placeholder: 'Paste anything that explains the application: endpoints, terms, rules.',
    oninput: function (e) { M.ctxText = e.target.value; syncSubmit(); } });
  text.value = M.ctxText;
  box.appendChild(formField('The text', false, text));

  // The code itself is context too, but it is remembered rather than
  // re-uploaded: save it once under Machinery › Repositories, then ground any
  // run in it from the dropdown on the Catalog and Describe tabs.
  box.appendChild(el('div', { class: 'sub', style: 'margin-top:8px', text:
    'The repository of the site under test is saved elsewhere — Machinery › Repositories scans and remembers it, and any run can then select it.' }));

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
        renderLauncher();
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
    type: 'file', accept: CATALOG_ACCEPT,
    onchange: function (e) {
      var chosen = e.target.files && e.target.files[0];
      if (!chosen) return;
      M.busy = true; M.error = ''; M.claims = null; renderLauncher();
      readFileAsBase64(chosen)
        .then(function (base64) { return saveDocument('catalog', { name: chosen.name, contentBase64: base64 }); })
        .then(function (doc) {
          M.catalog = doc; M.catName = doc.name; M.busy = false; renderLauncher();
        })
        ['catch'](function (error) { M.busy = false; M.error = error.message; renderLauncher(); });
    }
  });
  box.appendChild(formField('The catalog', false, file,
    'md · csv · html · txt · json · yaml · xlsx · pdf · mmd · puml — text is read out of it and sent to the model. A png/jpg/webp/svg of a sequence diagram works too: a model transcribes it to Mermaid first (pixels for pictures, markup for svg), and the claims below come from that transcript.'));

  var name = el('input', { type: 'text', placeholder: 'leave-balance-checks', value: M.catName,
    oninput: function (e) { M.catName = e.target.value; syncSubmit(); } });
  box.appendChild(formField('…or name some text and paste it', false, name));

  var text = el('textarea', { rows: '4', placeholder: '- the balance table renders with one row per leave type\n- filtering by month narrows the rows',
    oninput: function (e) { M.catText = e.target.value; M.claims = null; syncSubmit(); } });
  text.value = M.catText;
  box.appendChild(formField('The text', false, text));

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
  if (M.reading) box.appendChild(readingProgress(M));

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
function readingProgress(M) {
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

  // Sequence-diagram catalogs carry a participant table, and the planes on it
  // decide which claims are checkable at all — wowlidator can see what the user
  // and the page do, never what happens behind the API. Guessed lanes are the
  // gate's to confirm, and correcting one recomputes the list live.
  if (M.claims.sequence && M.claims.sequence.participants && M.claims.sequence.participants.length) {
    gate.appendChild(el('div', { class: 'sub', style: 'margin:10px 0 4px; font-weight:600',
      text: 'Lanes — who is who in this diagram' }));
    gate.appendChild(el('div', { class: 'sub', style: 'margin-bottom:6px',
      text: 'Checkability follows the planes: user and page lanes are observable from the browser; backend and external lanes are held as assumptions. Correct a guessed lane and the claims below update.' }));
    M.claims.sequence.participants.forEach(function (lane) {
      var row = el('div', { class: 'gate line', style: 'cursor:default; display:flex; align-items:center; gap:8px' });
      row.appendChild(el('span', { class: 'mono',
        text: lane.name + (lane.label && lane.label !== lane.name ? ' (' + lane.label + ')' : '') }));
      var planeSelect = el('select', { onchange: function (e) {
        lane.plane = e.target.value;
        lane.guessed = false;
        recomputeLanes(M);
        renderLauncher();
      } });
      ['user', 'page', 'backend', 'external'].forEach(function (plane) {
        planeSelect.appendChild(el('option', { value: plane, selected: plane === lane.plane, text: plane }));
      });
      row.appendChild(planeSelect);
      if (lane.guessed) row.appendChild(el('span', { class: 'chip', text: 'guessed — confirm' }));
      gate.appendChild(row);
    });
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
      renderLauncher();
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

/**
 * Mirror of isObservable in src/catalog/sequence.ts — this script cannot
 * import it, so a change to the rule there must change this too. A message is
 * checkable when the browser can see it: sent by the user or the page, or a
 * reply coming back to either. Older claims files without the message map
 * degrade to a read-only lane display — the honest fallback.
 */
function recomputeLanes(M) {
  var seq = M.claims && M.claims.sequence;
  if (!seq || !seq.messages) return;
  var planes = {};
  (seq.participants || []).forEach(function (lane) { planes[lane.name] = lane.plane; });
  var visible = function (plane) { return plane === 'user' || plane === 'page'; };
  seq.messages.forEach(function (m) {
    var claim = M.claims.claims[m.claim];
    if (!claim) return;
    var observable = visible(planes[m.from]) || (m.reply === true && visible(planes[m.to]));
    claim.testable = observable;
    claim.source = claim.source.replace(/ \(beyond the browser boundary:[^)]*\)$/, '') +
      (observable ? '' : ' (beyond the browser boundary: ' + (planes[m.from] || '?') + ' \u2192 ' + (planes[m.to] || '?') + ' \u2014 held as an assumption)');
  });
}

function countApproved(M) {
  if (!M.claims) return 0;
  return M.claims.claims.filter(function (claim, index) {
    return claim.testable && !M.cut[index];
  }).length;
}

/** Phase one: ask the CLI what the document claims, then read the file it wrote. */
function readClaims() {
  var M = S.launcher;
  M.error = '';

  ensureCatalogStored()
    .then(function (doc) {
      M.catalog = doc;
      M.claimsPath = '.wowlidator/catalogs/' + doc.name.replace(/\.[^.]+$/, '') + '.claims.json';
      M.reading = true;
      M.progress = { percent: null, phase: 'reading the catalog…' };
      renderLauncher();
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
        if (M.reading) renderLauncher();
      });
    })
    .then(function (job) {
      if (job.status !== 'passed') {
        throw new Error('reading the catalog failed — open Runs and proof to see the output of "' + job.title + '"');
      }
      M.progress = { percent: 95, phase: 'reading the claims it wrote' };
      renderLauncher();
      return api('/api/file?path=' + encodeURIComponent(M.claimsPath));
    })
    .then(function (body) {
      M.claims = JSON.parse(body.content);
      M.cut = {};
      M.reading = false;
      M.progress = null;
      renderLauncher();
    })
    ['catch'](function (error) {
      M.reading = false;
      M.progress = null;
      M.error = error.message;
      renderLauncher();
    });
}

/** The catalog as a file on disk, whether it was uploaded or typed. */
function ensureCatalogStored() {
  var M = S.launcher;
  if (M.catalog && M.catText.trim() === '') return Promise.resolve(M.catalog);
  if (M.catText.trim() === '') return Promise.reject(new Error('choose a file or paste the catalog text'));
  if (M.catName.trim() === '') return Promise.reject(new Error('give the catalog a name'));
  return saveDocument('catalog', { name: M.catName.trim() + '.md', text: M.catText });
}

function attachedContext(M) {
  return Object.keys(M.attach).filter(function (path) { return M.attach[path]; });
}

/**
 * Poll one job to the end. The launcher stays put, so there is no stream to join.
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

/* ----------------------------------------------- the inline launcher form */

/**
 * Rebuild the launcher host in place. Input handlers call this instead of
 * render() so a keystroke never rebuilds the rest of the page; the host is
 * only present on the runs view, and state simply waits when it is not.
 */
function renderLauncher() {
  var host = byId('launcher');
  if (!host) return;
  clear(host);
  if (!S.launcher) return;
  host.appendChild(launcherBox(S.launcher));
}

function launcherBox(M) {
  var box = el('section', { class: 'launcher', 'aria-labelledby': 'lt' });
  box.appendChild(el('div', { class: 'top' }, [
    el('h2', { id: 'lt', text: 'Start verification' }),
    el('button', { type: 'button', class: 'x', 'aria-label': 'Close', text: '✕', disabled: M.busy, onclick: closeLauncher })
  ]));
  box.appendChild(el('div', { class: 'sub', text: 'wowlidator writes the test; you say what must be true. Everything here runs the CLI — the command it builds is shown while it runs.' }));

  var seg = el('div', { class: 'segmented' });
  [['context', 'Add Context'], ['catalog', 'Add Catalog'], ['describe', 'Describe']].forEach(function (pair) {
    seg.appendChild(el('button', {
      type: 'button', class: 'btn' + (M.mode === pair[0] ? ' primary' : ''),
      text: pair[1], onclick: function () { M.mode = pair[0]; M.error = ''; renderLauncher(); }
    }));
  });
  box.appendChild(seg);

  if (M.mode === 'context') renderContextTab(box, M);
  if (M.mode === 'catalog') renderCatalogTab(box, M);
  if (M.mode === 'describe') {
    var describe = el('textarea', { rows: '3', placeholder: 'check that pagination is disabled when there is a single page — or paste a URL to write tests for the whole page',
      oninput: function (e) { M.describe = e.target.value; syncSubmit(); } });
    describe.value = M.describe;
    box.appendChild(formField('What should be proved?', false, describe,
      'A URL generates tests for that page; anything else is one test to write, against the page below.'));

    /* Radios, not a select: two mutually exclusive answers where the choice
       changes what the run DOES — e2e reads a second page and refuses a flow
       that never leaves the first — so both options stay on screen with their
       consequence next to them, rather than one hiding behind a dropdown. */
    var scopes = el('div', {});
    [['unit', 'Unit test', 'One thing, on the page below. Nothing navigates away.'],
     ['e2e', 'End-to-end', 'The whole journey: reach the page as a user does, act, verify where it lands. Reads the destination page too, and refuses a flow that stays put.']
    ].forEach(function (choice) {
      var input = el('input', {
        type: 'radio', name: 'launch-scope', value: choice[0],
        checked: M.scope === choice[0],
        onchange: function () { M.scope = choice[0]; renderLauncher(); }
      });
      scopes.appendChild(el('label', { style: 'display:flex;gap:8px;align-items:flex-start;margin-top:6px;font-weight:400' }, [
        input,
        el('span', {}, [
          el('span', { text: choice[1] }),
          el('span', { class: 'mono', style: 'display:block;opacity:.75', text: choice[2] })
        ])
      ]));
    });
    box.appendChild(formField('How far should it reach?', false, scopes));
  }

  if (M.mode !== 'context') {
    var focus = el('textarea', { rows: '2', placeholder: 'the filter controls',
      oninput: function (e) { M.focus = e.target.value; } });
    focus.value = M.focus;
    box.appendChild(formField('Anything to look at especially', true, focus));

    var url = el('input', { type: 'text', class: 'mono', placeholder: 'http://localhost:3000/some/page',
      value: M.url, oninput: function (e) { M.url = e.target.value; } });
    box.appendChild(formField('Page to prove it against', true, url,
      'Strongly recommended: with it the selectors come from the page, not from the document.'));

    /* A password box, deliberately: the value must not sit readable on screen
       or in a screenshot of this panel. It reaches the CLI as WOWLIDATOR_AS —
       an environment variable, never the command line — so it appears in no
       ps output and no job record, and the engine masks it in every proof. */
    var who = el('input', { type: 'password', class: 'mono', placeholder: 'email:password',
      value: M.as, oninput: function (e) { M.as = e.target.value; } });
    box.appendChild(formField('Sign in as', true, who,
      'The account the run may use. A flow that lands on the sign-in page then establishes the session itself, and authored steps fill these exact characters instead of guessing a password.'));

    // Any run type can ground itself in scanned code — the memory lives under
    // Machinery › Repositories, selection lives here, per run.
    if ((S.repos || []).length > 0) {
      var repoSel = el('select', { onchange: function (e) { M.repo = e.target.value; } });
      repoSel.appendChild(el('option', { value: '', selected: M.repo === '',
        text: 'none — the page and the document alone' }));
      (S.repos || []).forEach(function (repo) {
        repoSel.appendChild(el('option', { value: repo.slug, selected: M.repo === repo.slug,
          text: repo.slug + ' · ' + repo.nodes + ' nodes' }));
      });
      box.appendChild(formField('Ground in a saved repository', true, repoSel,
        'The repo’s indexed routes, endpoints and tables ride along in the authoring prompt, clearly labelled as what the code declares. Save one under Machinery › Repositories.'));
    }

    // Autoheal, in front of the fold: the one run option someone reaches for
    // every time, so it is a click before starting rather than a fold away.
    var autohealBox = el('input', { type: 'checkbox', onchange: function (e) { M.autoheal = e.target.checked; } });
    autohealBox.checked = M.autoheal;
    box.appendChild(el('label', { class: 'autoheal-row', title:
      'On a failed, error or dead-end result the repair model rewrites the flow around the break and the case reruns itself, up to 3 total runs. Every rewrite lands as its own reviewable .attempt-N.flow.json plus a .patch; assertions always keep their claim — a test is never rewritten until it merely passes.' }, [
      autohealBox,
      el('span', { text: 'Autoheal enabled' }),
      el('span', { class: 'mono', style: 'color:var(--muted);font-size:11px',
        text: 'fix broken steps with the repair model, then rerun — costs tokens on failure only' })
    ]));

    /* In front of the fold, beside autoheal, because it changes what gets
       WRITTEN rather than how a written test runs: off, the author proves
       every claim through the page and marks the ones a backend check would
       prove better; on, it may call HTTP and read the database, and then it
       needs somewhere to read it FROM — so the field appears only then, and
       the run refuses to start without it. */
    var backendBox = el('input', { type: 'checkbox', onchange: function (e) { M.backend = e.target.checked; renderLauncher(); } });
    backendBox.checked = M.backend;
    box.appendChild(el('label', { class: 'autoheal-row', title:
      'On: the test may call HTTP endpoints and read the database directly, and a database URL is required. Off: nothing but the page is used — a claim that wants the backend is still proved visually, and the step is marked as one a backend check could prove more directly.' }, [
      backendBox,
      el('span', { text: 'Include backend steps' }),
      el('span', { class: 'mono', style: 'color:var(--muted);font-size:11px',
        text: M.backend ? 'HTTP and database assertions may be written — needs a database URL' : 'page only — backend-shaped claims are proved visually and marked' })
    ]));
    if (M.backend) {
      /* A password box for the same reason as "Sign in as": a connection
         string carries a credential, must not sit readable in a screenshot of
         this panel, and reaches the CLI as WOWLIDATOR_DB_URL — an environment
         variable, never the command line. */
      var dbUrl = el('input', { type: 'password', class: 'mono', placeholder: 'postgres://user@localhost:5432/database',
        value: M.dbUrl, oninput: function (e) { M.dbUrl = e.target.value; } });
      box.appendChild(formField('Database URL', false, dbUrl,
        'Read-only access for database checks. Leave it blank only if this machine already sets WOWLIDATOR_DB_URL.'));
    }

    box.appendChild(el('button', {
      type: 'button', class: 'btn', style: 'margin-top:8px',
      text: (M.advanced ? '▾' : '▸') + ' Options for this run only — nothing here is stored',
      onclick: function () { M.advanced = !M.advanced; renderLauncher(); }
    }));
    if (M.advanced) {
      var adv = el('div', { class: 'gate', style: 'max-height:none' });
      var film = el('select', { onchange: function (e) { M.video = e.target.value; } });
      ['on', 'off'].forEach(function (mode) {
        film.appendChild(el('option', { value: mode, selected: mode === M.video, text: mode }));
      });
      adv.appendChild(formField('Record the run', false, film,
        'Films the run with a pointer drawn into the page, so you can see the clicks — a still only shows the page either side of one. Recording needs its own browser context, so a filmed run does not inherit cookies from a session you signed into by hand.'));

      var shots = el('select', { onchange: function (e) { M.screenshots = e.target.value; } });
      ['auto', 'all', 'on-event', 'on-failure', 'off'].forEach(function (mode) {
        shots.appendChild(el('option', { value: mode, selected: mode === M.screenshots, text: mode }));
      });
      adv.appendChild(formField('Stills', false, shots,
        'auto follows the recording: failures only while filming, every step when not. all gives both — the same run twice, at several times the size.'));

      var policy = el('select', { onchange: function (e) { M.policy = e.target.value; } });
      ['read-only', 'forms', 'mutations'].forEach(function (mode) {
        policy.appendChild(el('option', { value: mode, selected: mode === M.policy, text: mode }));
      });
      adv.appendChild(formField('What the written test may do', false, policy,
        'read-only never submits. forms submits invalid input to exercise validation. Nothing deletes, at any tier.'));

      var wait = el('input', { type: 'text', class: 'mono', placeholder: 'http://localhost:3000', value: M.waitFor,
        oninput: function (e) { M.waitFor = e.target.value; } });
      adv.appendChild(formField('Wait for this to answer first', true, wait, 'For a dev server that is still booting.'));
      box.appendChild(adv);
    }
  }

  if (M.error) box.appendChild(el('div', { class: 'err', text: M.error }));

  var submit = el('button', {
    type: 'button', class: 'btn primary', disabled: M.busy || M.reading || submitBlocked() !== null,
    title: submitBlocked(), text: submitLabel(M),
    onclick: submitLauncher
  });
  M.submitNode = submit;
  box.appendChild(el('div', { class: 'acts' }, [
    el('button', { type: 'button', class: 'btn', text: 'Close', disabled: M.busy, onclick: closeLauncher }),
    submit
  ]));

  return box;
}

/**
 * Keep the submit button honest while someone types.
 *
 * Its label and its disabled state are derived from fields that change on every
 * keystroke, and re-rendering the launcher to update them would take the caret and
 * the focus with it. So the button — the only node whose state depends on what
 * is currently typed — is updated in place instead. Every oninput that can
 * change the answer calls this.
 */
function syncSubmit() {
  var M = S.launcher;
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
  var M = S.launcher;
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

function submitLauncher() {
  var M = S.launcher;
  M.error = '';

  if (M.mode === 'context') {
    M.busy = true; renderLauncher();
    saveDocument('context', { name: M.ctxName.trim() + '.md', text: M.ctxText })
      .then(function (doc) {
        M.busy = false; M.ctxText = ''; M.ctxName = '';
        toast('stored ' + doc.name);
        return loadDocuments();
      })
      ['catch'](function (error) { M.busy = false; M.error = error.message; renderLauncher(); });
    return;
  }

  var extras = {};
  if (M.video !== 'on') extras.video = M.video;
  if (M.screenshots !== 'auto') extras.screenshots = M.screenshots;
  if (M.waitFor.trim()) extras['wait-for'] = M.waitFor.trim();
  if (M.repo) extras.repo = M.repo;
  if (M.as.trim()) extras.as = M.as.trim();
  if (M.autoheal) extras.repair = true;
  /* Stated either way, never left to a default: the CLI keeps backend testing
     ON so existing scripts are unchanged, and this panel offers it as opt-in.
     commands.ts turns the false into --no-backend. */
  extras.backend = M.backend === true;
  if (M.backend && M.dbUrl.trim()) extras['db-url'] = M.dbUrl.trim();

  if (M.mode === 'describe') {
    var go = { target: M.describe.trim() };
    if (M.url.trim()) go.url = M.url.trim();
    if (M.focus.trim()) go.target = go.target + ' — ' + M.focus.trim();
    if (M.policy !== 'forms') go.policy = M.policy;
    /* Sent only when it is not the default, exactly as policy is: the argv a
       run announces should carry what was chosen, not what was left alone. */
    if (M.scope !== 'unit') go.scope = M.scope;
    M.busy = true; renderLauncher();
    fire('go', Object.assign(go, extras), null);
    return;
  }

  // Catalog. The first press reads the claims; the second proves the ones that
  // survived the gate. One button, because "show me" and "go" are one decision
  // taken twice, not two features.
  if (!M.claims) { readClaims(); return; }

  M.busy = true; renderLauncher();
  var approved = { catalog: M.claims.catalog, summary: M.claims.summary,
    documentNote: M.claims.documentNote, model: M.claims.model, extractedAt: M.claims.extractedAt,
    // The participant table rides along, edits included — dropping it here
    // would silently discard the lane corrections the gate just collected.
    sequence: M.claims.sequence || undefined,
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
  })['catch'](function (error) { M.busy = false; M.error = error.message; renderLauncher(); });
}

function fire(commandId, values, flowPath) {
  post(commandId, values, flowPath).then(function () {
    closeLauncher();
  })['catch'](function (error) {
    if (S.launcher) { S.launcher.busy = false; S.launcher.error = error.message; renderLauncher(); }
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
    // The run's card appears in "Running now" with its output auto-expanded,
    // so a job started from a view that has no such section moves to one that
    // does — the console must never start somewhere it cannot be seen.
    if (S.view !== 'runs' && S.view !== 'history') show('runs');
    refresh();
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

/* Every listed flow as ONE run job — the flow field is a repeatable
   positional, so the suite holds the browser once instead of a refused job
   per case. With repair, runCases' ordinary autoheal rewrites each broken
   flow around its break and retries it. */
function startSuiteRun(flowPaths, repair) {
  var values = { flow: flowPaths };
  if (repair) values.repair = true;
  post('run', values, null).then(function () {
    toast((repair ? 'healing ' : 'rerunning ') + flowPaths.length + ' flow(s) as one suite');
  });
}

/* "Rerun all" / "Heal all" for a catalog group or one scenario of it — so
   re-running a whole pass is one click, not a click per case. items are the
   latest proof cards; only flows whose .flow.json is visible from here can be
   re-run, and the button says when any were left out. Heal covers the runs
   without a passing verdict, except proved-? — that one is waiting on a human
   ruling, not on a repair. */
function suiteRunButtons(items) {
  var all = [], broken = [], missing = 0;
  items.forEach(function (p) {
    var path = flowPathFor(p.name, p.renamedFrom);
    if (!path) { missing += 1; return; }
    all.push(path);
    var k = verdictKindOf(p);
    if (k === 'failed' || k === 'deadEnd' || k === 'error') broken.push(path);
  });
  var left = missing > 0 ? ' — ' + missing + ' flow file(s) are not visible from here and are left out' : '';
  var node = el('span', { class: 'suite-acts' });
  if (all.length > 0) {
    node.appendChild(el('button', {
      type: 'button', class: 'btn', text: 'Rerun all (' + all.length + ')',
      title: 'Run every flow here again, as one job with one roll-up' + left,
      onclick: function (e) { e.stopPropagation(); startSuiteRun(all, false); }
    }));
  }
  if (broken.length > 0) {
    node.appendChild(el('button', {
      type: 'button', class: 'btn accent', text: 'Heal all (' + broken.length + ')',
      title: 'Re-run the failed, dead-end and error flows with autoheal: the repair model rewrites each around its break and retries, every rewrite landing as a reviewable .attempt-N file' + left,
      onclick: function (e) { e.stopPropagation(); startSuiteRun(broken, true); }
    }));
  }
  return node;
}

/* Continue a catalog run from its ledger on disk — works after a panel
   restart too, because the ledger (not the in-memory job) is the record.
   The resumed run keeps the catalog's unique run key, so cases already
   tested under it are pulled into the resumed roll-up as finished tests. */
function resumeCatalog(ledgerPath, mode, caseId) {
  api('/api/catalog-runs/resume', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(caseId ? { ledgerPath: ledgerPath, mode: mode, caseId: caseId } : { ledgerPath: ledgerPath, mode: mode || 'continue' })
  })
    .then(function () { toast(mode === 'failed' ? 'healing failed cases' : mode === 'errors' ? 'rerunning errored cases' : mode === 'vacuous' ? 're-authoring vacuous cases' : mode === 'from' ? 'rerunning from ' + caseId + ' on current config' : 'continuing where it stopped'); refresh(); })
    ['catch'](function (error) { toast(error.message); });
}

function stopJob(id) {
  api('/api/jobs/' + encodeURIComponent(id) + '/stop', { method: 'POST' })
    .then(refresh)['catch'](function (error) { toast(error.message); });
}

/* Hide one run from every list. The bundle file MOVES to archived/ inside the
   proof directory - nothing is deleted, and moving it back is the undo. */
function hideRun(runId) {
  api('/api/proofs/' + encodeURIComponent(runId) + '/hide', { method: 'POST' })
    .then(function (b) {
      delete S.bundles[runId];
      toast('run hidden - proof file moved to ' + (b.movedTo ? tail(b.movedTo) : 'archived/') + ' (move it back to undo)');
      refresh();
    })['catch'](function (e) { toast(e.message); });
}

/* Rename EVERY recorded run of the flow, so the group stays one group - a
   single renamed cycle would split off as its own row. The server keeps the
   original on renamedFrom, once, so the flow-file lookup still matches. */
function renameTask(task) {
  var next = window.prompt('Rename this flow (applies to all ' + task.cycles.length + ' recorded run(s)):', task.name);
  if (next === null) return;
  next = next.trim();
  if (next === '' || next === task.name) return;
  Promise.all(task.cycles.map(function (c) {
    return api('/api/proofs/' + encodeURIComponent(c.runId) + '/rename', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: next })
    });
  })).then(function () {
    S.bundles = {};
    S.openTask = null;
    toast('renamed to "' + next + '"');
    refresh();
  })['catch'](function (e) { toast(e.message); });
}

/* Rename a catalog group: the displayed title is generatedBy.source on each
   bundle, so the new title is written onto every run of the pass. Grouping is
   keyed on generatedAt, never the title, so nothing regroups. */
function renameGroup(group) {
  var runs = group.tasks.reduce(function (acc, t) { return acc.concat(t.cycles); }, []);
  var next = window.prompt('Rename this catalog group (all ' + runs.length + ' recorded run(s)):', group.origin);
  if (next === null) return;
  next = next.trim();
  if (next === '' || next === group.origin) return;
  Promise.all(runs.map(function (c) {
    return api('/api/proofs/' + encodeURIComponent(c.runId) + '/rename', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ group: next })
    });
  })).then(function () {
    S.bundles = {};
    toast('group renamed to "' + next + '"');
    refresh();
  })['catch'](function (e) { toast(e.message); });
}

/* Permanently delete every proof of a catalog result — the destructive
   sibling of Hide, so it is gated twice: a modal, and a checkbox inside it
   that must be ticked before the delete button arms. */
function confirmDeleteGroup(group) {
  var runs = group.tasks.reduce(function (acc, t) { return acc.concat(t.cycles); }, []);
  var overlay = el('div', { class: 'overlay-backdrop', onclick: function () { overlay.remove(); } });
  var box = el('div', {
    class: 'modal', role: 'dialog', 'aria-label': 'Delete proofs',
    style: 'max-width:480px', onclick: function (e) { e.stopPropagation(); }
  });
  box.appendChild(el('div', { class: 'top' }, [
    el('b', { text: 'Delete this catalog result?' }),
    el('button', { type: 'button', class: 'x', 'aria-label': 'Cancel', text: '\u2715', onclick: function () { overlay.remove(); } })
  ]));
  box.appendChild(el('div', { class: 'why-line', text:
    '\u201C' + group.origin + '\u201D \u2014 ' + runs.length + ' recorded run(s). This permanently deletes the proof files from disk: ' +
    'every step, screenshot and recording in them. Reports already written stay where they are. This cannot be undone \u2014 to merely clear runs from the screen, use the \u2715 on a run instead.' }));
  var ticked = false;
  var doDelete;
  var check = el('input', { type: 'checkbox', id: 'del-confirm' });
  check.addEventListener('change', function () { ticked = check.checked; doDelete.disabled = !ticked; });
  box.appendChild(el('label', { class: 'autoheal-row', for: 'del-confirm' }, [
    check,
    el('span', { text: 'I understand: permanently delete ' + runs.length + ' proof file(s)' })
  ]));
  doDelete = el('button', {
    type: 'button', class: 'btn danger', text: 'Delete permanently', disabled: true,
    onclick: function () {
      doDelete.disabled = true;
      Promise.all(runs.map(function (c) {
        return api('/api/proofs/' + encodeURIComponent(c.runId) + '/delete', { method: 'POST' });
      })).then(function () {
        runs.forEach(function (c) { delete S.bundles[c.runId]; });
        overlay.remove();
        toast('deleted ' + runs.length + ' proof file(s)');
        refresh();
      })['catch'](function (e) { overlay.remove(); toast(e.message); refresh(); });
    }
  });
  box.appendChild(el('div', { class: 'acts', style: 'margin-top:12px; justify-content:flex-end' }, [
    el('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: function () { overlay.remove(); } }),
    doDelete
  ]));
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

function pauseJob(id) {
  api('/api/jobs/' + encodeURIComponent(id) + '/pause', { method: 'POST' })
    .then(function (b) {
      toast(b.paused ? 'pausing — cases in flight will finish, then Continue testing resumes at the exact case' : 'could not pause this job');
      refresh();
    })['catch'](function (error) { toast(error.message); });
}

/* ------------------------------------------------------------------ data */

function loadBundle(runId) {
  if (S.bundles[runId]) return Promise.resolve(S.bundles[runId]);
  return api('/api/proofs/' + encodeURIComponent(runId)).then(function (body) {
    S.bundles[runId] = body.proof;
    S.verdicts[runId] = body.verdict || null;
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
    // A case changing state redraws; a case merely advancing does not. The
    // bars are repainted every second from the polled job without a render,
    // so step-by-step progress costs no DOM churn and an open output pane
    // keeps its scroll position.
    S.jobs.map(function (j) {
      return j.id + j.status + (j.cases || []).map(function (c) { return c.number + c.status; }).join();
    }),
    S.flows.length, S.reports.length, S.cache.length,
    S.catalogRuns.map(function (r) { return r.ledgerPath + r.updatedAt + r.left + r.running; }),
    S.repos.map(function (r) { return r.slug + r.indexedAt; }),
    S.keys.providers && S.keys.providers.map(function (p) { return p.provider + p.activeIndex + p.keys.length; }),
    S.models.roles && S.models.roles.map(function (r) { return r.role + r.provider + r.modelId; }),
    S.models.providers && S.models.providers.map(function (p) { return p.provider + p.models.length + p.note; }),
    S.models.checks && S.models.checks.map(function (c) { return c.role + c.status + c.checkedAt + c.running; }),
    S.models.checking
  ]);
}

function refresh() {
  return Promise.all([
    api('/api/proofs').then(function (b) { S.proofs = b.proofs; S.groups = b.groups || []; }),
    api('/api/jobs').then(function (b) { S.jobs = b.jobs; S.jobsAt = Date.now(); }),
    api('/api/failed-runs').then(function (b) { S.failedRuns = b.failedRuns || []; }).catch(function () {}),
    api('/api/catalog-runs').then(function (b) { S.catalogRuns = b.runs || []; })['catch'](function () {}),
    api('/api/flows').then(function (b) { S.flows = b.flows; }),
    api('/api/reports').then(function (b) { S.reports = b.reports; })['catch'](function () {}),
    api('/api/cache').then(function (b) { S.cache = b.entries || []; })['catch'](function () {}),
    api('/api/keys').then(function (b) { S.keys = b; })['catch'](function () {}),
    api('/api/models').then(function (b) { S.models = b; })['catch'](function () {}),
    api('/api/repos').then(function (b) { S.repos = b.repos || []; })['catch'](function () {}),
    api('/api/db').then(function (b) { S.db = b; })['catch'](function () {})
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
    if (S.launcher) closeLauncher();
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
<div id="drawer"></div>
<div class="toast-container" id="toasts"></div>
<script>${WOW_SCRIPT}</script>
</body>
</html>
`;
}
