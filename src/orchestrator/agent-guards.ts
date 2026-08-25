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
  const trimmed = selector.trim();
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
  const goalTerms = new Set(tokenize(goal).filter((t) => t.length > 2));
  const score = (n: AxNode): number => {
    const text = `${n.name} ${n.value} ${n.description}`.toLowerCase();
    let hits = 0;
    for (const term of goalTerms) if (text.includes(term)) hits += 1;
    return hits * 10 + (INTERACTIVE_ROLES.has(n.role) ? 1 : 0);
  };
  const order = new Map(nodes.map((n, i) => [n, i]));
  const kept = [...nodes]
    .sort((a, b) => score(b) - score(a) || (order.get(a) ?? 0) - (order.get(b) ?? 0))
    .slice(0, maxNodes);
  kept.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  return kept;
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
