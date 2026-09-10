/**
 * A click-catcher is the element a popover library lays over the whole page so
 * that a click anywhere outside the popover closes it: `position: fixed;
 * inset: 0`, no name, no text, usually `aria-hidden`. It has no action of its
 * own — the ONLY thing clicking it can do is dismiss what it belongs to — which
 * is what makes clicking it a safe restore gesture where Escape is not one: a
 * popover that closes on "click outside" need not listen for Escape at all.
 *
 * Live (be-sit-high-fixed-20260910-141440, four lanes): a top-bar popover of
 * exactly this shape ignored Escape, so the healer's disclosure probe left it
 * open, and its catcher then swallowed every later click in the case —
 * Playwright names the catcher's ancestor as the interceptor and never
 * dispatches a click it sees intercepted, so the ladder could not even close
 * it by accident. Both the probe (`src/context/page-probe.ts`) and the
 * overlay rung (`src/engine/runner.ts`) decide "is this a catcher" here, from
 * measured facts, so the two cannot disagree.
 */

import type { Page } from 'playwright';

/** What is measured about a candidate before it may be clicked. */
export interface ClickCatcherFacts {
  viewport: { width: number; height: number };
  /** The element's bounding rect in viewport CSS px. */
  rect: { x: number; y: number; width: number; height: number };
  /** Computed `position`. */
  position: string;
  ariaHidden: boolean;
  /** Accessible name as far as `aria-label`/`title`/`alt` give one. */
  name: string;
  /** Visible text inside it, trimmed. */
  text: string;
  /** Tag name, upper-case. */
  tag: string;
}

/**
 * Share of the viewport a catcher must cover on each axis. A sticky bar or a
 * side rail covers the whole width OR the whole height, never both.
 */
export const CLICK_CATCHER_COVERAGE = 0.95;

const NEVER_A_CATCHER = new Set(['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA', 'IFRAME', 'VIDEO', 'CANVAS']);

/**
 * True only for an element that is a click-catcher by construction: fixed or
 * absolute positioning, covering (almost) the entire viewport on both axes,
 * with no accessible name and no visible text. A named or worded element is
 * something a person reads or acts on, and is never clicked blind.
 */
export function isClickCatcher(facts: ClickCatcherFacts): boolean {
  if (NEVER_A_CATCHER.has(facts.tag)) return false;
  if (facts.name.trim() !== '' || facts.text.trim() !== '') return false;
  if (facts.position !== 'fixed' && facts.position !== 'absolute') return false;
  const { viewport, rect } = facts;
  if (viewport.width <= 0 || viewport.height <= 0) return false;
  const coversWidth = rect.width >= viewport.width * CLICK_CATCHER_COVERAGE;
  const coversHeight = rect.height >= viewport.height * CLICK_CATCHER_COVERAGE;
  const startsAtTop = rect.y <= viewport.height * (1 - CLICK_CATCHER_COVERAGE);
  const startsAtLeft = rect.x <= viewport.width * (1 - CLICK_CATCHER_COVERAGE);
  return coversWidth && coversHeight && startsAtTop && startsAtLeft;
}

export interface ClickCatcher {
  /** A point on the catcher that hits it and nothing above it. */
  point: { x: number; y: number };
  /** Tag and class, for the record. */
  label: string;
}

/**
 * The page-side probe: sample a few viewport points and return the first whose
 * topmost element is a click-catcher. Reads only; never throws (a page that
 * cannot be read simply has no catcher).
 */
export async function findClickCatcher(page: Page): Promise<ClickCatcher | null> {
  try {
    return await page.evaluate((coverage) => {
      const g = globalThis as unknown as {
        innerWidth: number;
        innerHeight: number;
        document: { elementFromPoint(x: number, y: number): Element | null };
        getComputedStyle(el: Element): { position: string };
      };
      type Element = {
        tagName: string;
        className: unknown;
        getAttribute(name: string): string | null;
        getBoundingClientRect(): { x: number; y: number; width: number; height: number };
        textContent: string | null;
      };
      const viewport = { width: g.innerWidth, height: g.innerHeight };
      const samples = [
        [0.5, 0.5],
        [0.2, 0.3],
        [0.8, 0.7],
        [0.5, 0.15],
        [0.5, 0.85],
      ];
      for (const [fx, fy] of samples) {
        const x = Math.round(viewport.width * (fx as number));
        const y = Math.round(viewport.height * (fy as number));
        const el = g.document.elementFromPoint(x, y);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        const facts = {
          viewport,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          position: g.getComputedStyle(el).position,
          ariaHidden: el.getAttribute('aria-hidden') === 'true',
          name: el.getAttribute('aria-label') ?? el.getAttribute('title') ?? el.getAttribute('alt') ?? '',
          text: (el.textContent ?? '').trim(),
          tag: el.tagName.toUpperCase(),
        };
        // Inlined copy of `isClickCatcher`: a page callback cannot call into the
        // module, so the rule is restated here verbatim and pinned by the same test.
        const never = ['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA', 'IFRAME', 'VIDEO', 'CANVAS'];
        const catcher =
          !never.includes(facts.tag) &&
          facts.name.trim() === '' &&
          facts.text === '' &&
          (facts.position === 'fixed' || facts.position === 'absolute') &&
          rect.width >= viewport.width * coverage &&
          rect.height >= viewport.height * coverage &&
          rect.y <= viewport.height * (1 - coverage) &&
          rect.x <= viewport.width * (1 - coverage);
        if (!catcher) continue;
        const cls = typeof el.className === 'string' && el.className !== '' ? `.${el.className.split(/\s+/)[0]}` : '';
        return { point: { x, y }, label: `${el.tagName.toLowerCase()}${cls}` };
      }
      return null;
    }, CLICK_CATCHER_COVERAGE);
  } catch {
    return null;
  }
}
