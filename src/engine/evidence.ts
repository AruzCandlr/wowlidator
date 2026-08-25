/**
 * What a step leaves behind to look at afterwards.
 *
 * One definition, two users: `SmartRunner` captures per action, and the crawler
 * captures per destination it visits. They had to agree, and the way to make
 * two things agree is not to write the rule twice.
 *
 * The principle: **evidence on every step, not only the one that broke.** A
 * failure screenshot shows the wreckage. It cannot show the step before it,
 * which is usually where the wrong thing actually happened — and that frame is
 * unrecoverable after the fact, because re-running to have a look changes the
 * very timing that produced it. So the run is recorded as it happens.
 */

import type { Page } from 'playwright';

/**
 * When to spend time on a screenshot.
 *
 * `all` is the default. The cheaper modes remain, in cost order:
 *   `off`        — nothing, ever.
 *   `on-failure` — only the step that failed.
 *   `on-event`   — failures, plus passing steps where something happened worth
 *                  seeing (a heal, a dismissed dialog, an agent turn).
 *   `all`        — the above, plus one for every other step.
 */
export type ScreenshotMode = 'off' | 'on-failure' | 'on-event' | 'all';

/**
 * What a step's evidence is *for*, which decides both whether it is captured
 * and how many bytes it is worth.
 *
 * - `failure` — the step that broke. What someone is actually here for.
 * - `notable` — it passed, but something happened worth seeing: a heal, a
 *   dismissed dialog, the agent driving, a data value regenerated.
 * - `routine` — it passed, uneventfully. Individually dull; collectively the
 *   filmstrip, which is the thing that answers "when did this stop looking
 *   right".
 */
export type EvidenceKind = 'failure' | 'notable' | 'routine';

/** JPEG quality for a screenshot someone is going to look at closely. */
const EXAMINED_QUALITY = 55;
/** …and for a filmstrip frame, which only has to show what was on screen. */
const ROUTINE_QUALITY = 38;

/**
 * How long to let the page paint before the shutter opens.
 *
 * Every navigation in the engine waits for `domcontentloaded`, which fires when
 * the HTML is parsed — before stylesheets have applied, before images decode,
 * and long before a client-rendered app has put anything on screen. Capturing
 * on that event photographs the empty shell: a blank frame, or a page of
 * skeleton loaders, for a step that went on to pass. The evidence then argues
 * with the verdict, and the screenshot is the part a person believes.
 *
 * So a capture settles first. The wait is *inside* the capture rather than
 * after each navigation because both callers — `SmartRunner` per action and the
 * crawler per destination — need it, and a rule written twice drifts.
 */
export const DEFAULT_CAPTURE_DELAY_MS = 250;

/**
 * Ceiling on the settle wait.
 *
 * `networkidle` never arrives on a page that polls or holds a websocket open,
 * and this runs once per captured step, so the budget is small on purpose:
 * a late frame is a cost paid on every step of every run, while the thing it
 * buys — the page having rendered — almost always lands in the first few
 * hundred milliseconds. Anything slower is a slow page, and a screenshot of a
 * slow page mid-load is itself worth seeing.
 */
const SETTLE_BUDGET_MS = 750;

/**
 * Shutter timeout for a full-page capture. A viewport shot fit in 5s; a page
 * tens of thousands of pixels tall takes Chrome genuinely longer to composite
 * and encode, and a timeout here loses the evidence entirely.
 */
const FULL_PAGE_SHUTTER_MS = 30_000;

/** Pause per viewport while walking down, for lazy content to start loading. */
const SCROLL_STEP_DELAY_MS = 120;
/** Ceiling on the walk — a feed that grows while scrolled must not trap it. */
const MAX_SCROLL_STEPS = 60;

/**
 * Scroll to the very bottom one viewport at a time, then back to where the
 * page was. Stepping (rather than one jump) is what fires the intersection
 * observers lazy images and infinite lists actually hang off. Never throws —
 * same rule as the capture itself.
 */
async function primeLazyContent(page: Page): Promise<void> {
  try {
    await page.evaluate(
      async ({ stepDelay, maxSteps }) => {
        // Same pattern as `BrowserGlobals` in runner.ts: the DOM lib stays out
        // of the Node build, so the globals this closure uses are typed here.
        interface ScrollRoot {
          scrollTop: number;
          scrollHeight: number;
        }
        const g = globalThis as unknown as {
          document: { scrollingElement: ScrollRoot | null; documentElement: ScrollRoot };
          innerHeight: number;
        };
        const root = g.document.scrollingElement ?? g.document.documentElement;
        const original = root.scrollTop;
        // The pauses are written out rather than factored into a `wait` helper,
        // and that is not a style choice. esbuild — which is what `tsx` runs
        // this repo through — rewrites a function assigned to a name into
        // `__name(fn, "wait")` to preserve `fn.name`. Playwright ships the
        // function's *source* to the browser, where `__name` does not exist, so
        // the whole callback dies with `ReferenceError: __name is not defined`.
        // `captureEvidence` swallows it, so the symptom was not an error but a
        // silence: the lazy-content walk never ran under `tsx`, and full-page
        // captures of a lazy-loading page were the skeleton loaders this
        // function exists to prevent. Keep every function in here anonymous.
        for (let i = 0; i < maxSteps; i++) {
          if (root.scrollTop + g.innerHeight >= root.scrollHeight - 1) break;
          root.scrollTop += g.innerHeight;
          await new Promise((resolve) => setTimeout(resolve, stepDelay));
        }
        root.scrollTop = original;
        await new Promise((resolve) => setTimeout(resolve, stepDelay));
      },
      { stepDelay: SCROLL_STEP_DELAY_MS, maxSteps: MAX_SCROLL_STEPS },
    );
    // Late images the walk set off: one more bounded settle before the shutter.
    await page.waitForLoadState('networkidle', { timeout: SETTLE_BUDGET_MS }).catch(() => undefined);
  } catch {
    // A page that navigated away mid-walk still gets whatever capture follows.
  }
}

/**
 * Wait for the frame the browser is *about* to draw, not the one it already
 * did: web fonts swapping in and CSS transitions finishing are the two things
 * that most often separate the capture from what a user saw a moment later.
 * String source on purpose — the `__name` landmine above applies to anything
 * `tsx` transpiles, and a string reaches the page byte-for-byte. Bounded and
 * silent like every other settle here.
 */
async function settleRendering(page: Page): Promise<void> {
  try {
    await page.evaluate(
      `(async () => {
        const g = globalThis;
        if (g.document && g.document.fonts && g.document.fonts.ready) {
          await Promise.race([g.document.fonts.ready, new Promise((r) => setTimeout(r, 400))]);
        }
        await new Promise((r) => g.requestAnimationFrame(() => g.requestAnimationFrame(r)));
      })()`,
    );
  } catch {
    // A page that navigated away mid-settle still gets whatever capture follows.
  }
}

function wantsEvidence(mode: ScreenshotMode, kind: EvidenceKind): boolean {
  switch (mode) {
    case 'all':
      return true;
    case 'on-event':
      return kind !== 'routine';
    case 'on-failure':
      return kind === 'failure';
    case 'off':
      return false;
  }
}

/**
 * Capture the page, or return nothing.
 *
 * Two size decisions, because a report is one self-contained file and every
 * byte here lands in it:
 *
 * - **`scale: 'device'`.** Full native resolution — on a HiDPI display that
 *   is 2× the CSS pixels and roughly four times the bytes, and it is chosen
 *   deliberately: a capture someone zooms into to read small text or check a
 *   1px border must not have been downsampled first. The size pressure is
 *   taken up by the JPEG quality tiers below instead.
 * - **Routine frames encode lower.** A filmstrip frame is looked at to see
 *   roughly what was on screen; a failure screenshot is looked at closely.
 *
 * Never throws. Evidence is diagnostic — a page that closed underneath us, or
 * a capture that timed out, must not be the reason a run reports a different
 * verdict than it otherwise would. The settle waits are held to the same rule:
 * each is capped and each swallows its own timeout, so a page that never goes
 * quiet costs a fixed delay and still gets photographed.
 *
 * `delayMs` is the pause after the page stops loading, for paint and for any
 * transition still running. Zero skips it and captures as soon as the load
 * states allow.
 */
export async function captureEvidence(
  page: Page,
  mode: ScreenshotMode,
  kind: EvidenceKind,
  delayMs: number = DEFAULT_CAPTURE_DELAY_MS,
): Promise<string | undefined> {
  if (!wantsEvidence(mode, kind)) return undefined;
  try {
    // Ordered by what each one waits for: the document's own resources, then
    // whatever the app fetched once it was running, then the frame it drew.
    await page.waitForLoadState('load', { timeout: SETTLE_BUDGET_MS }).catch(() => undefined);
    await page.waitForLoadState('networkidle', { timeout: SETTLE_BUDGET_MS }).catch(() => undefined);
    if (delayMs > 0) await page.waitForTimeout(delayMs);

    // The whole page, not the viewport. `fullPage` alone photographs whatever
    // has rendered, and content below the fold frequently hasn't: lazy images
    // and infinite lists render on scroll, so an unscrolled capture is a tall
    // image whose bottom half is skeleton loaders. Walking to the bottom first
    // makes the page materialise itself; the scroll position is put back so
    // evidence never changes what the next step sees.
    await primeLazyContent(page);
    await settleRendering(page);

    const buffer = await page.screenshot({
      type: 'jpeg',
      quality: kind === 'routine' ? ROUTINE_QUALITY : EXAMINED_QUALITY,
      scale: 'device',
      fullPage: true,
      timeout: FULL_PAGE_SHUTTER_MS,
    });
    return buffer.toString('base64');
  } catch {
    return undefined;
  }
}
