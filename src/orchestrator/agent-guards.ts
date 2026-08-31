/**
 * The deterministic half of the workflow agent — what is checked BEFORE a
 * model's decision is acted on, and what the model is shown.
 *
 * The agent loop already owned budgeting and origin checks. What it left to
 * the prompt was everything that decides whether a turn is spent well: does
 * the selector name something the tree actually shows, has this exact action
 * already been done with the page unchanged since, is a `finish` true of the
 * page the agent is on. A prompt instruction is a request; each of these is
 * now a guarantee, applied in code, with one informed re-ask before the
 * cheaper outcome (a fast failure, a stall, an unverified finish) is
 * recorded. Same seam the healer's echo check uses, same reason: the commonest
 * thing a weak model does is hand back the thing that did not work, and the
 * value of a second ask is entirely in telling it so.
 *
 * Everything here is pure, so it is tested without a browser or a model.
 */

import { formatAxNode, INTERACTIVE_ROLES, type AxNode } from '../healer/jit-healer.js';
import { tokenize } from '../context/relevance.js';

/** The shape of a decision the guards read. Kept structural to avoid a cycle. */
export interface DecisionLike {
  action: string;
  selector: string;
  value: string;
  url: string;
}

/** The accessible name a role selector asks for, if it asks for one. */
export function selectorName(selector: string): string | null {
  // The FIRST segment only. A Playwright selector chains with `>>`, and the
  // bare-text pattern below is greedy: on `text=PL_03_18 >> xpath=.. >>
  // role=button[name="Delete"]` it used to read the whole string as the name,
  // which of course appears in no tree — so a correctly scoped click was
  // refused as ungrounded and the agent talked itself into finishing instead
  // (caught 2026-08-25 by the destructive-scope test, which asked for exactly
  // that shape). Grounding asks "does the thing this selector starts from
  // exist", and the first segment is that thing; `targetName` below walks the
  // segments itself for the control the click lands ON.
  const trimmed = (selector.split('>>')[0] ?? selector).trim();
  const m = /^role=[a-z]+\s*\[name=(?:"([^"]+)"|'([^']+)')/i.exec(trimmed);
  if (m) return (m[1] ?? m[2]) as string;
  const quoted = /^text="([^"]+)"$/.exec(trimmed);
  if (quoted) return quoted[1] as string;
  const bare = /^text=(.+)$/.exec(trimmed);
  return bare ? (bare[1] as string) : null;
}

/**
 * Is the control this selector names in the tree the model was shown?
 *
 * Only role-with-name and text selectors can be checked — a CSS selector or
 * a nameless role says nothing the tree text could contradict, and is left
 * alone (the action's own fast-fail covers it). Matching is case-insensitive
 * and word-wise: Chrome's names carry CSS text-transform and the tree may
 * show a longer name than the model quoted, and neither of those is an
 * invention. `null` means "could not say"; `false` means the name is not
 * anywhere in the tree and the click was going to wait eight seconds for
 * nothing.
 */
export function selectorGrounded(selector: string, axTree: string): boolean | null {
  const name = selectorName(selector);
  if (name === null || name.trim() === '') return null;
  const hay = axTree.toLowerCase();
  const needle = name.toLowerCase().trim();
  if (hay.includes(needle)) return true;
  const words = needle.split(/\s+/).filter((w) => w.length > 1);
  if (words.length === 0) return null;
  return words.every((w) => hay.includes(w));
}

/** The one thing about a decision that makes it "the same" as an earlier one. */
export function decisionKey(d: DecisionLike): string {
  return `${d.action} ${d.selector.trim()} ${d.value} ${d.url.trim()}`;
}

/**
 * Keep the nodes a goal is about inside the model's budget.
 *
 * `captureAxTreeDetailed` keeps interactive controls first when it has to
 * cut, which is right for a healer that does not know what it is looking for.
 * The agent does know — the goal names the control — so a node whose name
 * shares a word with the goal outranks an unrelated button, and is never the
 * one that falls past the cut. Document order is restored after ranking so
 * the tree still reads as the page.
 */
export function focusTree(nodes: readonly AxNode[], goal: string, maxNodes: number): AxNode[] {
  if (nodes.length <= maxNodes) return [...nodes];
  // A NUMBER in the goal survives the length filter. `tokenize` returns "75"
  // and the old `length > 2` cut it — so on "verify the Total Plans summary
  // card shows count 75" the one term that names the answer scored nothing,
  // the node named "75" ranked below every sidebar link, and the agent was
  // shown the label with the value removed. Live (be100 PL_03_01,
  // 2026-08-25): five turns of scrolling for a number that was on screen,
  // "the required numeric values are not present in the accessibility tree",
  // and the very next step's `expectText "75"` passed.
  const goalTerms = new Set(tokenize(goal).filter((t) => t.length > 2 || /^\d+$/.test(t)));
  const score = (n: AxNode): number => {
    const text = `${n.name} ${n.value} ${n.description}`.toLowerCase();
    let hits = 0;
    for (const term of goalTerms) if (text.includes(term)) hits += 1;
    return hits * 10 + (INTERACTIVE_ROLES.has(n.role) ? 1 : 0);
  };
  const order = new Map(nodes.map((n, i) => [n, i]));
  const ranked = [...nodes].sort(
    (a, b) => score(b) - score(a) || (order.get(a) ?? 0) - (order.get(b) ?? 0),
  );
  // A matched node's DOCUMENT NEIGHBOURS come with it. A summary card is a
  // label and a value as sibling nodes — `StaticText "TOTAL PLANS"` then
  // `StaticText "75"` — and neither reads as the card alone: keeping the
  // label and cutting the number is exactly the shape that sent PL_03_01
  // hunting. The neighbour rides in on the match's own rank, so it cannot
  // push out a higher-scoring node; it only fills the budget ahead of
  // unrelated ones.
  const kept = new Set<AxNode>();
  for (const node of ranked) {
    if (kept.size >= maxNodes) break;
    kept.add(node);
    if (score(node) < 10) continue; // only a goal MATCH earns neighbours
    const at = order.get(node) ?? -1;
    for (const near of [nodes[at - 1], nodes[at + 1]]) {
      if (near !== undefined && kept.size < maxNodes) kept.add(near);
    }
  }
  return [...kept].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
}

/** Render a focused tree the same way the healer renders its own. */
export function renderTree(nodes: readonly AxNode[], total: number): string {
  if (nodes.length === 0) return '(no accessible elements found)';
  const body = nodes.map(formatAxNode).join('\n');
  if (nodes.length >= total) return body;
  return (
    `${body}\n[TREE TRUNCATED: showing ${nodes.length} of ${total} nodes, the ones closest to the ` +
    `goal kept. Elements may exist that are not listed — scroll or navigate before concluding ` +
    `anything is missing.]`
  );
}

/** A control whose accessible name says it destroys something. */
export const DESTRUCTIVE_NAME = /^(delete|remove|destroy|purge|discard|erase|ลบ)\b/i;
/** The identifier-shaped tokens a goal names: PL_03_15_16_17_18, TH_MED_001, BE-CYC-001. */
const GOAL_IDENTIFIER = /\b[A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z0-9]+){1,}\b/g;

/** The accessible name of the LAST role segment — the control the click lands on. */
function targetName(selector: string): string | null {
  const segments = selector.split('>>').map((seg) => seg.trim());
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const name = selectorName(segments[i] ?? '');
    if (name !== null) return name;
    if (/^role=/.test(segments[i] ?? '')) return null;
  }
  return null;
}

/**
 * Why a destructive click must not run as written, or null.
 *
 * Live (be100 PL_03_18, 2026-08-25 06:28): the goal named the row to delete
 * (PL_03_15_16_17_18), the agent could not find it, clicked
 * `role=button[name="Delete" i] >> nth=0` — the first Delete button on a
 * 75-row table — confirmed the dialog, and the network shows
 * `DELETE /api/benefit-plans?planId=TH_MED_001`: a plan the goal never named,
 * gone for good on an authoritative database, and every later case that
 * asserted on it dead-ended. Its reasoning said it was the right row. The
 * rule "no destructive action unless the goal asks" was met on paper.
 *
 * So: when the goal names an identifier and the click's target is a
 * destructive control, the selector must carry one of those identifiers —
 * the row scoped by the thing the goal is about — or be inside a dialog
 * (the confirmation of a delete already scoped). A goal that names no
 * identifier has nothing to scope to and is left to the prompt's rule.
 */
export function unscopedDestructiveClick(decision: DecisionLike, goal: string): string | null {
  if (decision.action !== 'click' || decision.selector.trim() === '') return null;
  const name = targetName(decision.selector);
  if (name === null || !DESTRUCTIVE_NAME.test(name.trim())) return null;
  const ids = [...new Set(goal.match(GOAL_IDENTIFIER) ?? [])].filter((id) => /\d/.test(id));
  if (ids.length === 0) return null;
  const selector = decision.selector.toLowerCase();
  if (/^role=(alert)?dialog\b/.test(selector)) return null;
  if (ids.some((id) => selector.includes(id.toLowerCase()))) return null;
  return (
    `destructive: "${decision.selector}" presses "${name}" without naming which row — the goal is about ` +
    `${ids.join(' / ')}, and this would act on whatever row comes first. Scope the click to that row ` +
    `(role=row[name="${ids[0]}" i] >> role=button[name="${name}" i]), or call fail if the row is not on the page`
  );
}

/**
 * How many ok clicks on the SAME selector one run tolerates before the next
 * one is refused. Three, not two: a multi-select legitimately re-opens its
 * dropdown once per pick (be100 PL_03_17 needed three), and the page-changed
 * guard already lets those through — the pathology this exists for starts at
 * the fourth.
 */
export const TOGGLE_CLICK_LIMIT = 3;

/**
 * Why a click that keeps re-pressing the same control must not run again, or
 * null.
 *
 * Live (PL_03_02, 2026-08-27): a filter button whose listbox options never
 * appeared in the truncated tree was clicked EIGHT times across 38 turns —
 * each toggle changed the tree (open ↔ closed), so the repeated-on-unchanged-
 * page guard never fired, the URL even changed mid-thrash, and the per-URL
 * done-set restarted. 310 s of wall time on one leg, ok every time, learning
 * nothing. Counted per run and per selector, across URLs, exactly because
 * that is the shape the existing guards cannot see.
 */
export function repeatedToggleClick(
  decision: DecisionLike,
  okClicksThisRun: ReadonlyMap<string, number>,
): string | null {
  if (decision.action !== 'click' || decision.selector.trim() === '') return null;
  const count = okClicksThisRun.get(decision.selector.trim()) ?? 0;
  if (count < TOGGLE_CLICK_LIMIT) return null;
  return (
    `circling: you have already clicked "${decision.selector}" ${count} times this run and it has not ` +
    `produced what the goal needs — it likely toggles open and closed. Do something different: press a ` +
    `key into it (ArrowDown/Enter), act on another control the tree shows, or call fail and say what ` +
    `the page will not reveal`
  );
}

/**
 * The named thing a goal says should be SHOWING when it is done.
 *
 * Goals in a catalog are written to a shape: an action, then the state it
 * produces — "click Create Plan **so that the Create Plan dialog opens**",
 * "click its Insert action **so that the popup titled \"Insert New Changes\"
 * opens**". The second half is a checkable claim about the page, and when it
 * is already true the whole leg is already done.
 *
 * Returns the names to look for, best first. Empty when the goal names no
 * such state — which is most goals, and they fall through to the model
 * exactly as before.
 */
/**
 * The name at the END of a phrase, cut at the last connector.
 *
 * "the Create Plan button so the Create Plan" is one match of the bare
 * pattern, and only its tail is the dialog's name — everything up to and
 * including the last `so`/`that`/`the` belongs to the sentence, not the
 * surface. Returns null when what is left does not read like a name.
 */
function trailingName(phrase: string): string | null {
  const words = phrase.trim().split(/\s+/).filter(Boolean);
  const CUT = new Set(['so', 'that', 'the', 'a', 'an', 'and', 'then', 'until', 'button', 'control', 'action', 'link', 'its', 'opens', 'open']);
  let start = 0;
  for (let i = 0; i < words.length; i += 1) {
    if (CUT.has((words[i] ?? '').toLowerCase())) start = i + 1;
  }
  const name = words.slice(start).join(' ').trim();
  // A name is at most a short phrase and starts like one.
  if (name.length < 2 || name.split(/\s+/).length > 5) return null;
  return /^[A-Z]/.test(name) ? name : null;
}

export function goalSurfaceNames(goal: string): string[] {
  const names: string[] = [];
  // A quoted name following the word that says what kind of surface it is.
  const titled = /(?:dialog|popup|modal|panel|drawer|sheet)\s+(?:titled|named|called)?\s*["“]([^"”]{2,80})["”]/gi;
  for (const m of goal.matchAll(titled)) if (m[1]) names.push(m[1].trim());
  // The bare form: "the Create Plan dialog opens", "the Confirm delete plan
  // popup appears". Only the words IMMEDIATELY before the surface noun are
  // the name — a goal usually names the control first ("click the Create Plan
  // button so the Create Plan dialog opens"), and a greedy match swallows the
  // sentence between them and matches nothing on the page.
  const bare = /([A-Za-z0-9][^.,;"”]{0,60}?)\s+(?:dialog|popup|modal)\b/g;
  for (const m of goal.matchAll(bare)) {
    const trimmed = trailingName(m[1] ?? '');
    if (trimmed !== null) names.push(trimmed);
  }
  // A placeholder the author left in ("<plan name>") names nothing.
  return [...new Set(names)].filter((n) => !/[<>]/.test(n) && n.length >= 2);
}

/**
 * Is the state this goal describes ALREADY showing on the page?
 *
 * Live (be100, 2026-08-26): six of ten agent runs in one pass finished in one
 * or two turns having discovered nothing to do — "the tree shows dialog
 * … already present", "the dialog … is already open". The preceding authored
 * step had opened it, and the workflow leg then paid a model call, its
 * process startup and two turns to find that out. Sixty per cent of the
 * agent's work in that pass was rediscovering a fact the tree already stated.
 *
 * Deliberately narrow, and biased to saying no: it fires only when the goal
 * names a surface AND a node of that role carries that name. A goal that
 * names nothing, or a name the tree does not show, falls through to the
 * model exactly as before — the cost of a false yes is a leg that never ran,
 * which is far worse than a leg that ran needlessly.
 */
export function goalAlreadyShowing(goal: string, nodes: readonly AxNode[]): string | null {
  const names = goalSurfaceNames(goal);
  if (names.length === 0) return null;
  const surfaces = nodes.filter((n) => /^(dialog|alertdialog)$/i.test(n.role));
  if (surfaces.length === 0) return null;
  for (const name of names) {
    const needle = name.toLowerCase().trim();
    const words = needle.split(/\s+/).filter((w) => w.length > 1);
    if (words.length === 0) continue;
    const hit = surfaces.find((n) => {
      const shown = n.name.toLowerCase();
      // Word-wise, the rule `selectorGrounded` already uses, and for the same
      // reason: the page's own name is routinely longer than the goal's. The
      // measured pair is a goal saying "the Create Plan dialog" against a
      // dialog the application calls "Create Benefit Plan" — the same
      // surface, one inserted word apart. Substring matching misses it.
      return shown.includes(needle) || words.every((w) => shown.includes(w));
    });
    if (hit !== undefined) return hit.name || name;
  }
  return null;
}

