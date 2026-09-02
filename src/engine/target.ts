/**
 * The step's TARGET — what a step actually acted on or checked, as evidence.
 *
 * A proof step already records which selector resolved; this records what
 * that selector WAS at the moment of the step — the element's role and
 * accessible name (or tag and visible text), where it sat on the page — and
 * draws a red rectangle around it in the step's screenshot, so a reader of
 * the evidence sees the thing the claim was proved on rather than a whole
 * page and a selector string to reconcile by eye.
 *
 * Two rules, both load-bearing:
 * - **Never a cost the step can feel.** Every read is bounded by a short
 *   timeout and wrapped; a target that cannot be read is simply absent.
 * - **The highlight is not part of the page.** It is appended right before
 *   the shutter and removed in a `finally` right after, so it cannot be
 *   counted by coverage, intercept a pointer, or appear in the next step's
 *   evidence. It is drawn from the element's own live rectangle in document
 *   coordinates, because the screenshot is full-page and a viewport-fixed box
 *   would land at the top of a tall image.
 */

import type { Locator, Page } from 'playwright';

import type { StepTarget } from './proof-bundle.js';

/** How long any one target read may take before it is abandoned. */
export const TARGET_READ_BUDGET_MS = 1_000;
/** The attribute the highlight box carries — how it is found and removed. */
export const HIGHLIGHT_ATTR = 'data-wowlidator-highlight';
const TEXT_LIMIT = 120;

/** Roles the browser implies from a tag, when none is written. */
const IMPLICIT_ROLE: Record<string, string> = {
  a: 'link',
  button: 'button',
  select: 'combobox',
  textarea: 'textbox',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  img: 'img',
  nav: 'navigation',
  main: 'main',
  table: 'table',
  li: 'listitem',
  ul: 'list',
  ol: 'list',
  option: 'option',
  dialog: 'dialog',
};

interface ElementFacts {
  tag: string;
  role: string | null;
  name: string | null;
  text: string | null;
  box: { x: number; y: number; width: number; height: number } | null;
}

/**
 * Minimal shapes of the browser globals the `evaluate` callbacks touch —
 * declared locally rather than pulling in the DOM lib, the same rule as
 * `BrowserGlobals` in runner.ts. The element itself comes typed from
 * Playwright; only what hangs off `globalThis` needs naming.
 */
interface BrowserHighlightNode {
  setAttribute(name: string, value: string): void;
  style: { cssText: string };
  remove(): void;
}
interface BrowserWindow {
  scrollX: number;
  scrollY: number;
  document: {
    getElementById(id: string): { textContent: string | null } | null;
    createElement(tag: string): BrowserHighlightNode;
    documentElement: { appendChild(node: BrowserHighlightNode): void };
    querySelectorAll(selector: string): ArrayLike<BrowserHighlightNode>;
  };
}
/** The input-ish members read for a name; absent on other elements. */
interface LabelledInput {
  labels?: ArrayLike<{ textContent: string | null }> | null | undefined;
  value?: string | undefined;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`target read exceeded ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Read what the selector resolved to. `undefined` when it cannot be read in
 * time — a detached element, a selector that no longer matches, a page that
 * navigated away. Never throws.
 */
export async function captureTarget(
  page: Page,
  selector: string | null,
  timeoutMs: number = TARGET_READ_BUDGET_MS,
): Promise<StepTarget | undefined> {
  if (selector === null || selector === '') return undefined;
  try {
    const locator = page.locator(selector).first();
    const facts = await withTimeout(
      // No named inner functions in here: tsx/esbuild's keepNames wraps
      // `const f = () => …` in a `__name` helper that does not exist in the
      // page, and Playwright ships the function's SOURCE — the read then
      // fails on every element with "__name is not defined".
      locator.evaluate((el, limit: number): ElementFacts => {
        const g = globalThis as unknown as BrowserWindow;
        const tag = el.tagName.toLowerCase();
        const attrs: Record<string, string | null> = {};
        for (const n of ['role', 'type', 'aria-label', 'aria-labelledby', 'alt', 'title', 'placeholder']) {
          const v = el.getAttribute(n);
          attrs[n] = v === null || v.trim() === '' ? null : v.trim();
        }
        const input = el as unknown as LabelledInput;
        const type = tag === 'input' ? (attrs['type'] ?? 'text').toLowerCase() : null;
        let implicit: string | null = null;
        if (type !== null) {
          implicit =
            type === 'submit' || type === 'reset' || type === 'button'
              ? 'button'
              : type === 'checkbox' || type === 'radio'
                ? type
                : 'textbox';
        }
        const role = attrs['role'] ?? implicit;
        let byId: string | null = null;
        const labelledBy = attrs['aria-labelledby'] ?? null;
        if (labelledBy !== null) {
          const parts: string[] = [];
          for (const id of labelledBy.split(/\s+/)) {
            const t = g.document.getElementById(id)?.textContent?.trim() ?? '';
            if (t !== '') parts.push(t);
          }
          byId = parts.length === 0 ? null : parts.join(' ');
        }
        let label: string | null = null;
        if (input.labels && input.labels.length > 0) {
          const parts: string[] = [];
          for (let i = 0; i < input.labels.length; i += 1) {
            const t = input.labels[i]?.textContent?.trim() ?? '';
            if (t !== '') parts.push(t);
          }
          label = parts.length === 0 ? null : parts.join(' ');
        }
        const own = (el.textContent ?? '').replace(/\s+/g, ' ').trim() || null;
        const buttonValue =
          tag === 'input' && (type === 'button' || type === 'submit' || type === 'reset') ? input.value || null : null;
        const formField = tag === 'select' || tag === 'textarea' || tag === 'input';
        const name =
          attrs['aria-label'] ?? byId ?? label ?? attrs['alt'] ?? attrs['title'] ?? attrs['placeholder'] ?? buttonValue ?? (formField ? null : own);
        const r = el.getBoundingClientRect();
        const box =
          r.width === 0 && r.height === 0
            ? null
            : {
                x: Math.round(r.left + g.scrollX),
                y: Math.round(r.top + g.scrollY),
                width: Math.round(r.width),
                height: Math.round(r.height),
              };
        const clippedName = name === null ? null : name.length > limit ? `${name.slice(0, limit - 1)}…` : name;
        const text = own === null || own === name ? null : own.length > limit ? `${own.slice(0, limit - 1)}…` : own;
        return { tag, role, name: clippedName, text, box };
      }, TEXT_LIMIT, { timeout: timeoutMs }),
      timeoutMs,
    );
    const role = facts.role ?? IMPLICIT_ROLE[facts.tag];
    const target: StepTarget = {
      selector,
      tag: facts.tag,
      ...(role === undefined ? {} : { role }),
      ...(facts.name === null ? {} : { name: facts.name }),
      ...(facts.text === null ? {} : { text: facts.text }),
      ...(facts.box === null ? {} : { box: facts.box }),
    };
    return target;
  } catch (error) {
    // Silent by contract; the one diagnostic is opt-in, for the case where
    // every target comes back absent and nobody can see why.
    if (process.env['WOWLIDATOR_DEBUG_TARGET']) {
      process.stderr.write(`target read failed for ${selector}: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    return undefined;
  }
}

/**
 * Draw the red rectangle around the locator's element. Returns true when a
 * box was added — the caller's `finally` uses that to know there is one to
 * remove. Drawn in document coordinates from the element's LIVE rectangle,
 * read at draw time, so it is right even if the page moved since the target
 * was captured.
 */
export async function drawTargetHighlight(
  locator: Locator,
  timeoutMs: number = TARGET_READ_BUDGET_MS,
): Promise<boolean> {
  try {
    return await withTimeout(
      locator.first().evaluate((el, attr: string): boolean => {
        const g = globalThis as unknown as BrowserWindow;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return false;
        const pad = 4;
        const box = g.document.createElement('div');
        box.setAttribute(attr, '');
        box.setAttribute('aria-hidden', 'true');
        box.style.cssText =
          `position:absolute;left:${r.left + g.scrollX - pad}px;top:${r.top + g.scrollY - pad}px;` +
          `width:${r.width + pad * 2}px;height:${r.height + pad * 2}px;box-sizing:border-box;` +
          'border:3px solid #e53935;border-radius:3px;box-shadow:0 0 0 2px rgba(255,255,255,.85);' +
          'pointer-events:none;z-index:2147483647;margin:0;padding:0;';
        g.document.documentElement.appendChild(box);
        return true;
      }, HIGHLIGHT_ATTR, { timeout: timeoutMs }),
      timeoutMs,
    );
  } catch {
    return false;
  }
}

/** Remove every highlight box. Idempotent; never throws. */
export async function removeTargetHighlight(page: Page): Promise<void> {
  try {
    await withTimeout(
      page.evaluate((attr: string) => {
        const g = globalThis as unknown as BrowserWindow;
        const nodes = g.document.querySelectorAll(`[${attr}]`);
        for (let i = nodes.length - 1; i >= 0; i -= 1) nodes[i]?.remove();
      }, HIGHLIGHT_ATTR),
      TARGET_READ_BUDGET_MS,
    );
  } catch {
    // The page may be gone — then so is the box.
  }
}
