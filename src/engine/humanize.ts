/**
 * Performing an action the way a person does — for the film, never for the
 * verdict.
 *
 * A Playwright action is a teleport: `click` moves the pointer to the centre
 * of the control in one event and presses; `fill` sets the whole value in one
 * programmatic insert. On a recording (see `video.ts`) that is a page that
 * changes for no visible reason — the pointer overlay appears on the button
 * in the same frame the button is pressed, and a form's text is there in one
 * frame and not the one before. Measured on PL_07_06's film (2026-09-04): a
 * click step lasts ~405 ms of which nothing is visible until the last frame.
 *
 * **Everything here is a prelude to the author's own action, never a
 * replacement for it.** The pointer travels to the element the ladder's
 * locator resolved and then Playwright's `click` is called on that same
 * locator, with the same actionability checks; a value is put in key by
 * key and then READ BACK, and a field that does not hold exactly the value
 * is filled by the ordinary `fill` — the rung the run had before. So a
 * humanised step succeeds against the element the plain one would have, or
 * fails with the same error: the prelude is best-effort, catches everything,
 * and shares the step's timeout so a missing element still fails in the fast
 * window rather than twice it.
 *
 * Two facts the ladder relies on are preserved on purpose:
 *
 * - **`fill` fires no per-key keydown.** The humanised fill inserts the text
 *   one character at a time through `Keyboard.insertText` — the same
 *   `Input.insertText` Playwright's own `fill` uses, so a page sees `input`
 *   events and never a keystroke. A field whose ARIA says its keystrokes
 *   drive a popup (`combobox`, `aria-autocomplete`, `aria-haspopup`,
 *   `aria-controls`, a `list`) is not typed into at all: it is filled in one
 *   move, as before, because a suggestion list opened by the film's typing
 *   would cover the next control and change what the test exercises.
 * - **`type` fires real keys** and keeps doing so; humanising only jitters
 *   the delay between them.
 *
 * Steered on structure only (`tests/no-hardcode.test.ts`): tag names, input
 * types, ARIA attributes and geometry. Nothing here knows a field, a site or
 * a locale.
 */

import type { Locator, Page } from 'playwright';

/** Whether to perform like a person. Follows the recording unless set. */
export interface HumanizeOptions {
  enabled: boolean;
}

/** A viewport point. */
export interface Point {
  x: number;
  y: number;
}

/** Intermediate pointer positions on the way to a control. */
export const HUMAN_POINTER_STEPS = 14;
/** Pause between two pointer positions, ms — at 25 fps ~one frame every other move. */
export const HUMAN_POINTER_STEP_MS = 16;
/** Hover on the control before pressing, ms. */
export const HUMAN_HOVER_MS = 120;
/** Per-key delay while putting a value in, ms (jittered between the two). */
export const HUMAN_KEY_DELAY_MIN_MS = 30;
export const HUMAN_KEY_DELAY_MAX_MS = 80;
/**
 * Longest a value may take to go in, ms. A 200-character value at 55 ms a
 * key is eleven seconds of film nobody needs; over the budget the delays
 * shrink uniformly.
 */
export const HUMAN_TYPING_BUDGET_MS = 2_500;
/** The beat after a scroll, ms — the browser's smooth scroll takes about this long. */
export const HUMAN_SCROLL_SETTLE_MS = 450;
/**
 * How long the prelude may wait for the element to have a box before giving
 * up on the approach and leaving the action to Playwright, ms. Deducted from
 * the action's own timeout, so a missing element fails within one window.
 */
export const HUMAN_LOOK_MS = 250;
/** Least the action itself keeps after the prelude, ms. */
const MIN_ACTION_TIMEOUT_MS = 100;
/** How far the pointer's path bows away from the straight line, px at most. */
const ARC_MAX_PX = 24;

/** Where the pointer was last left on each page — the next path starts there. */
const lastPointer = new WeakMap<Page, Point>();

/** Ease in and out: slow off the mark, fast in the middle, slow to arrive. */
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * The points a pointer visits from `from` to `to`.
 *
 * Progress along the line is eased and strictly increasing — the pointer
 * never doubles back — and the path bows slightly to one side, as a hand
 * does. The last point is `to` exactly: the press that follows lands where
 * Playwright will move the mouse anyway, so the film shows one arrival, not
 * a hop. Two identical points yield the single destination.
 */
export function pointerPath(from: Point, to: Point, steps = HUMAN_POINTER_STEPS): Point[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (!(steps >= 1) || distance < 0.5) return [{ x: to.x, y: to.y }];
  // Perpendicular unit vector; the arc scales with distance and is capped.
  const nx = -dy / distance;
  const ny = dx / distance;
  const bow = Math.min(ARC_MAX_PX, distance * 0.08);
  const points: Point[] = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const p = easeInOutCubic(t);
    const side = Math.sin(Math.PI * t) * bow;
    points.push({ x: from.x + dx * p + nx * side, y: from.y + dy * p + ny * side });
  }
  points[points.length - 1] = { x: to.x, y: to.y };
  return points;
}

/**
 * One delay per key, jittered inside the bounds, shrunk uniformly when the
 * value would otherwise take longer than the budget. `random` is injectable
 * so the planner is testable; the default is `Math.random`.
 */
export function keyDelays(
  count: number,
  random: () => number = Math.random,
  minMs = HUMAN_KEY_DELAY_MIN_MS,
  maxMs = HUMAN_KEY_DELAY_MAX_MS,
  budgetMs = HUMAN_TYPING_BUDGET_MS,
): number[] {
  if (!(count >= 1)) return [];
  const delays: number[] = [];
  for (let i = 0; i < count; i++) delays.push(minMs + random() * (maxMs - minMs));
  const total = delays.reduce((a, b) => a + b, 0);
  if (total <= budgetMs) return delays.map((d) => Math.round(d));
  const scale = budgetMs / total;
  return delays.map((d) => Math.round(d * scale));
}

/**
 * How long the action itself may still take once the prelude has spent
 * some of the step's window — never below a floor, so a prelude that ran
 * long cannot turn a present element into a timeout of its own.
 */
export function remainingTimeout(timeoutMs: number, spentMs: number): number {
  return Math.max(MIN_ACTION_TIMEOUT_MS, timeoutMs - spentMs);
}

function sleep(page: Page, ms: number): Promise<void> {
  return ms > 0 ? page.waitForTimeout(ms).catch(() => undefined) : Promise.resolve();
}

/**
 * Where the pointer starts on a page it has not moved on yet: off the
 * control, the way a hand enters from the side, rather than from (0,0)
 * where Playwright's mouse begins — the top-left corner of every first
 * click is not what a person does.
 */
function startPoint(page: Page): Point {
  const known = lastPointer.get(page);
  if (known) return known;
  const viewport = page.viewportSize();
  return viewport ? { x: Math.round(viewport.width * 0.4), y: Math.round(viewport.height * 0.6) } : { x: 200, y: 300 };
}

/**
 * Move the pointer onto the element along an eased path and rest there.
 *
 * Best-effort: any failure (no box within `HUMAN_LOOK_MS`, several matches,
 * a page mid-navigation) returns silently and the action that follows
 * behaves exactly as it would have without the approach — including its
 * error. Returns the time spent, so the caller can shorten the action's
 * own window by it.
 */
export async function approach(page: Page, locator: Locator, timeoutMs: number): Promise<number> {
  const started = Date.now();
  try {
    const box = await locator.boundingBox({ timeout: Math.min(HUMAN_LOOK_MS, timeoutMs) });
    if (!box || box.width <= 0 || box.height <= 0) return Date.now() - started;
    const to = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    for (const point of pointerPath(startPoint(page), to)) {
      await page.mouse.move(point.x, point.y);
      lastPointer.set(page, point);
      await sleep(page, HUMAN_POINTER_STEP_MS);
    }
    await sleep(page, HUMAN_HOVER_MS);
  } catch {
    // The overlay and the film are evidence; a prelude that cannot run is not a reason a step fails.
  }
  return Date.now() - started;
}

/** What a humanised action reports to the step's record. */
export interface Performance {
  /** Wall time of the whole performance, prelude included — the film's lead for this step. */
  performedMs: number;
}

/**
 * Click like a person: approach, hover, press. The press is Playwright's own
 * `click` on the same locator, with what is left of the step's timeout.
 */
export async function humanClick(
  page: Page,
  locator: Locator,
  timeoutMs: number,
  options: HumanizeOptions,
): Promise<Performance | undefined> {
  if (!options.enabled) {
    await locator.click({ timeout: timeoutMs });
    return undefined;
  }
  const started = Date.now();
  const spent = await approach(page, locator, timeoutMs);
  await locator.click({ timeout: remainingTimeout(timeoutMs, spent) });
  return { performedMs: Date.now() - started };
}

/**
 * The shape of the element a value is about to go into, read in one
 * bounded evaluate. `null` when it could not be read, which the callers
 * treat as "not plain": fill it the ordinary way.
 */
interface FieldShape {
  tag: string;
  type: string;
  readOnly: boolean;
  disabled: boolean;
  /** ARIA says keystrokes drive a popup or a list — never typed into on film. */
  drivesPopup: boolean;
}

async function fieldShape(locator: Locator, timeoutMs: number): Promise<FieldShape | null> {
  try {
    return await locator.evaluate(
      (el) => {
        const input = el as unknown as { readOnly?: boolean; disabled?: boolean };
        const role = el.getAttribute('role') ?? '';
        return {
          tag: el.tagName,
          type: (el.getAttribute('type') ?? '').toLowerCase(),
          readOnly: Boolean(input.readOnly),
          disabled: Boolean(input.disabled),
          drivesPopup:
            role === 'combobox' ||
            role === 'searchbox' ||
            el.hasAttribute('aria-autocomplete') ||
            el.hasAttribute('aria-haspopup') ||
            el.hasAttribute('aria-controls') ||
            el.hasAttribute('list'),
        };
      },
      undefined,
      { timeout: Math.min(HUMAN_LOOK_MS, timeoutMs) },
    );
  } catch {
    return null;
  }
}

/** Input types whose value is plain text a person types. */
const PLAIN_TEXT_TYPES = new Set(['', 'text', 'email', 'password', 'search', 'tel', 'url']);

/**
 * Is this a field the film may show being typed into? Textareas and plain
 * text-like inputs that are writable and whose ARIA promises no popup.
 * Anything else — a date, a number, a select, a contenteditable, a label
 * Playwright would retarget — is filled the ordinary way.
 */
export function isPlainTextField(shape: FieldShape | null): boolean {
  if (shape === null || shape.readOnly || shape.disabled || shape.drivesPopup) return false;
  if (shape.tag === 'TEXTAREA') return true;
  return shape.tag === 'INPUT' && PLAIN_TEXT_TYPES.has(shape.type);
}

/**
 * Put a value in the way a person appears to: approach the field, click
 * into it, clear it, then insert the text character by character with a
 * jittered pause — `Keyboard.insertText`, so no keydown is ever fired (the
 * fact `fill` gives the ladder). Then READ IT BACK: a field that does not
 * hold exactly `value` is handed to Playwright's `fill`, the rung the step
 * always had, whose result — or error — is the step's. Fields the film may
 * not type into (see `isPlainTextField`) go straight to `fill`.
 */
export async function humanFill(
  page: Page,
  locator: Locator,
  value: string,
  timeoutMs: number,
  options: HumanizeOptions,
): Promise<Performance | undefined> {
  if (!options.enabled) {
    await locator.fill(value, { timeout: timeoutMs });
    return undefined;
  }
  const started = Date.now();
  const shape = await fieldShape(locator, timeoutMs);
  if (!isPlainTextField(shape) || value === '') {
    await locator.fill(value, { timeout: remainingTimeout(timeoutMs, Date.now() - started) });
    return { performedMs: Date.now() - started };
  }
  const spent = await approach(page, locator, timeoutMs);
  let remaining = remainingTimeout(timeoutMs, spent);
  try {
    await locator.click({ timeout: remaining });
    // Clear by selecting what is there, so the first character replaces it.
    // Not `fill('')`: Playwright clears an empty value by pressing Delete,
    // which is exactly the keydown this path promises never to fire.
    await locator.evaluate((el) => (el as unknown as { select?: () => void }).select?.(), undefined, { timeout: remaining });
    const chars = Array.from(value);
    const delays = keyDelays(chars.length);
    for (let i = 0; i < chars.length; i++) {
      await page.keyboard.insertText(chars[i]!);
      await sleep(page, delays[i] ?? 0);
    }
  } catch {
    // Whatever the prelude could not do, the ordinary fill below decides.
  }
  const held = await locator.inputValue({ timeout: 1_000 }).catch(() => null);
  if (held !== value) {
    remaining = remainingTimeout(timeoutMs, Date.now() - started);
    await locator.fill(value, { timeout: remaining });
  }
  return { performedMs: Date.now() - started };
}

/**
 * Type key by key — real keystrokes, as the `type` action promises — with
 * the pointer's approach first and a jittered delay between keys when
 * humanised; a fixed delay otherwise. The step's own focus-and-clear is
 * left to the caller, whose semantics this must not change.
 */
export async function humanKeys(
  page: Page,
  locator: Locator,
  value: string,
  fixedDelayMs: number,
  timeoutMs: number,
  options: HumanizeOptions,
): Promise<Performance | undefined> {
  if (!options.enabled) {
    await locator.pressSequentially(value, { delay: fixedDelayMs, timeout: timeoutMs });
    return undefined;
  }
  const started = Date.now();
  const chars = Array.from(value);
  const delays = keyDelays(chars.length);
  for (let i = 0; i < chars.length; i++) {
    await locator.pressSequentially(chars[i]!, { timeout: timeoutMs });
    await sleep(page, delays[i] ?? 0);
  }
  return { performedMs: Date.now() - started };
}

/**
 * Bring an element into view the way a wheel does — the browser's own
 * smooth scroll, then a beat — before the caller's instant
 * `scrollIntoViewIfNeeded`, which stays the action of record (a no-op once
 * the element is already in view). Best-effort, as every prelude.
 */
export async function humanScrollTo(locator: Locator, timeoutMs: number, options: HumanizeOptions): Promise<void> {
  if (!options.enabled) return;
  try {
    await locator.evaluate(
      (el) => el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' }),
      undefined,
      { timeout: Math.min(HUMAN_LOOK_MS, timeoutMs) },
    );
    await locator.page().waitForTimeout(HUMAN_SCROLL_SETTLE_MS).catch(() => undefined);
  } catch {
    // The instant scroll that follows is the action; this was the film's.
  }
}

/** Scroll the window by one screen, smoothly when humanised. */
export async function humanScrollBy(page: Page, options: HumanizeOptions): Promise<void> {
  if (!options.enabled) {
    await page.evaluate('window.scrollBy(0, window.innerHeight)');
    return;
  }
  await page.evaluate("window.scrollBy({ top: window.innerHeight, behavior: 'smooth' })");
  await sleep(page, HUMAN_SCROLL_SETTLE_MS);
}

/**
 * After a navigation: put the pointer back where it was. A new document has
 * a fresh overlay that shows nothing until the mouse moves, so without this
 * the pointer is absent from the film until the next click. No pause here
 * on purpose — the film holds the landing for its dwell already, and a
 * pause moves the ladder's clock for every step after a `goto` (measured:
 * 350 ms flipped the patience rung's fixtures from `late` to `fast`).
 */
export async function humanSettle(page: Page, options: HumanizeOptions): Promise<void> {
  if (!options.enabled) return;
  const at = lastPointer.get(page);
  if (at) await page.mouse.move(at.x, at.y).catch(() => undefined);
}
