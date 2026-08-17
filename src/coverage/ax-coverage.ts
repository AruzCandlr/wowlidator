/**
 * UI coverage, measured against the accessibility tree.
 *
 * Code coverage answers "which lines ran". UI testing has no equivalent — you
 * cannot normally ask "which controls has no test ever touched", so suites
 * drift into testing the same three buttons forever (the pesticide paradox,
 * with no instrument to detect it).
 *
 * wowlidator already captures the AX tree for healing. That tree *is* an inventory
 * of every interactive control on the page, so the question becomes answerable:
 * enumerate the controls, subtract the ones steps resolved, and report the
 * remainder.
 *
 * The honest caveat is attribution. A step that resolved
 * `role=button[name="Next"]` maps cleanly onto a tree node; a step that used
 * `.pagination__next` does not, because a CSS selector carries no role or
 * name. Those are counted separately as `unattributed` rather than being
 * silently dropped or silently credited — an over-reported coverage number is
 * worse than none.
 */

import type { Page } from 'playwright';

import { captureAxNodes, type AxNode } from '../healer/jit-healer.js';

/** Roles that represent something a user can actually operate. */
const INTERACTIVE_ROLES = new Set([
  'button',
  'checkbox',
  'combobox',
  'link',
  'listbox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
]);

export interface CoveredControl {
  role: string;
  name: string;
  /** Canonical selector for this control, e.g. `role=button[name="Next"]`. */
  selector: string;
  disabled: boolean;
}

export interface CoverageReport {
  url: string;
  /** Interactive controls found on the page. */
  total: number;
  /** How many a step resolved. */
  exercised: number;
  /** `exercised / total`, 0–1. `null` when the page has no controls. */
  ratio: number | null;
  /** Controls no step touched — the actionable half of the report. */
  untouched: CoveredControl[];
  /**
   * Selectors that ran but could not be matched to a control (CSS selectors,
   * mostly). Coverage is understated by at most this many.
   */
  unattributed: string[];
}

/** Canonical `role=ROLE[name="NAME"]` form for an AX node. */
export function canonicalSelector(role: string, name: string): string {
  return name === '' ? `role=${role}` : `role=${role}[name="${name}"]`;
}

/**
 * Parse a `role=...[name="..."]` selector back into its parts.
 * Returns null for anything that isn't role-based — CSS, text=, testid.
 *
 * The optional trailing ` i` is Playwright's case-insensitive name flag, which
 * wowlidator emits on every generated selector (see `src/engine/selector.ts`).
 * Failing to accept it here would push every generated step into
 * `unattributed` and understate coverage to zero.
 */
export function parseRoleSelector(selector: string): { role: string; name: string } | null {
  const match = /^role=([a-zA-Z]+)(?:\[name=(?:"([^"]*)"|'([^']*)')(?:\s+i)?\])?/.exec(
    selector.trim(),
  );
  if (!match) return null;
  return { role: match[1] ?? '', name: match[2] ?? match[3] ?? '' };
}

/**
 * Key used to decide whether a step touched a control.
 *
 * Case-folded for the same reason the selectors carry ` i`: the inventory's
 * names come from Chrome (CSS `text-transform` applied) while a hand-authored
 * selector carries the untransformed text. Comparing them case-sensitively
 * would both miss the attribution *and* add the same control to the inventory
 * a second time as a phantom "transient" — overstating the denominator while
 * understating the numerator.
 */
function attributionKey(role: string, name: string): string {
  return canonicalSelector(role, name).toLowerCase();
}

/** Enumerate the operable controls on the page. */
export function interactiveControls(nodes: readonly AxNode[]): CoveredControl[] {
  const seen = new Set<string>();
  const controls: CoveredControl[] = [];

  for (const node of nodes) {
    if (!INTERACTIVE_ROLES.has(node.role)) continue;
    const selector = canonicalSelector(node.role, node.name);
    // Two identical role+name pairs are indistinguishable to a selector, so
    // they count once — matching what a test could actually target.
    if (seen.has(selector)) continue;
    seen.add(selector);
    controls.push({
      role: node.role,
      name: node.name,
      selector,
      disabled: node.disabled,
    });
  }

  return controls;
}

/**
 * Compare the controls on `page` against the selectors a run resolved.
 *
 * `resolvedSelectors` should be the selectors that actually *worked* — the
 * healed form where a step healed, since that is what touched the element.
 */
export async function measureCoverage(
  page: Page,
  resolvedSelectors: readonly string[],
  maxNodes = 400,
): Promise<CoverageReport> {
  const controls = interactiveControls(await captureAxNodes(page, maxNodes));

  const touched = new Map<string, { role: string; name: string }>();
  const unattributed: string[] = [];

  for (const raw of new Set(resolvedSelectors)) {
    const parsed = parseRoleSelector(raw);
    if (parsed === null) {
      unattributed.push(raw);
      continue;
    }
    touched.set(attributionKey(parsed.role, parsed.name), parsed);
  }

  // A control the run demonstrably resolved may be absent from the *final*
  // tree — a toggle that replaces itself, a dialog that closed, a row that
  // re-rendered. It existed and was exercised, so it belongs in both the
  // numerator and the denominator. Without this, a flow that clicks a
  // disclosure button reports 0% while having genuinely covered it.
  const known = new Set(controls.map((c) => attributionKey(c.role, c.name)));
  const transient: CoveredControl[] = [];
  for (const [key, parsed] of touched) {
    if (known.has(key)) continue;
    if (!INTERACTIVE_ROLES.has(parsed.role)) continue;
    transient.push({
      role: parsed.role,
      name: parsed.name,
      selector: canonicalSelector(parsed.role, parsed.name),
      disabled: false,
    });
  }
  const inventory = [...controls, ...transient];

  const untouched = inventory.filter(
    (control) => !touched.has(attributionKey(control.role, control.name)),
  );
  const exercised = inventory.length - untouched.length;

  return {
    url: page.url(),
    total: inventory.length,
    exercised,
    ratio: inventory.length === 0 ? null : exercised / inventory.length,
    untouched,
    unattributed,
  };
}

// Lives in `proof-bundle.ts` to keep this module import-light — the reporter
// needs it, and reporter ← coverage ← healer ← config ← reporter was a cycle.
export { meaningfulCoverage } from '../engine/proof-bundle.js';

/** One-line summary for the CLI. */
export function formatCoverage(report: CoverageReport): string {
  if (report.total === 0) return 'coverage   no interactive controls found';
  const pct = Math.round((report.ratio ?? 0) * 100);
  const tail =
    report.unattributed.length > 0
      ? ` (${report.unattributed.length} selector(s) unattributed)`
      : '';
  return `coverage   ${report.exercised}/${report.total} controls exercised (${pct}%)${tail}`;
}
