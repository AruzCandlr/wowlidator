/**
 * Video evidence: the run as a recording, with a visible pointer.
 *
 * `evidence.ts` answers "what did the page look like at this step". This
 * answers the question a still cannot: **what did the test actually do.** A
 * screenshot of a page after a click and a screenshot of the same page after
 * nothing happened are the same image; the click itself — where the pointer
 * went, what it landed on, what moved — exists only between frames.
 *
 * Two things had to be established by running it rather than by reading the
 * documentation, and both shape everything below:
 *
 * 1. **Playwright records video over a CDP connection, but only on a context
 *    it created.** `recordVideo` is a `newContext` option and there is no way
 *    to turn it on for the context a browser already has. `SmartRunner.connect`
 *    therefore stops reusing `browser.contexts()[0]` when recording — which
 *    means a fresh cookie jar, and that is a real cost, not a detail. It is
 *    why `VideoMode` has an `off`.
 * 2. **Playwright videos contain no mouse pointer.** The browser composites the
 *    page, not the cursor the operating system draws on top of it, so a
 *    recording of a perfectly good click is a recording of a page that changes
 *    for no visible reason. The pointer in these videos is drawn *by the page*,
 *    from an injected overlay — see `CURSOR_OVERLAY_SOURCE`.
 */

import type { BrowserContext, Page } from 'playwright';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { trimWebm } from './webm.js';

/**
 * Whether to record.
 *
 * `on` is the default. `off` restores exactly the behaviour that existed
 * before video: the browser's existing context is reused, with its cookies,
 * and evidence is stills alone.
 */
/**
 * `on`     — film every run, keep the recording only when a step fails
 *            (cut to the failure). The default.
 * `always` — keep the whole recording whatever the outcome: the film of the
 *            mock user performing the task, end to end. This is what "view
 *            actual flow" records on demand for a run that passed.
 * `off`    — no filming; stills on every step instead.
 */
export type VideoMode = 'on' | 'always' | 'off';

export const VIDEO_MODES: readonly VideoMode[] = ['on', 'always', 'off'];

export function parseVideoMode(raw: string | undefined): VideoMode | null {
  if (raw === undefined) return null;
  return (VIDEO_MODES as readonly string[]).includes(raw) ? (raw as VideoMode) : null;
}

/** A sealed recording, ready to embed. */
export interface VideoRecording {
  /** Base64 webm. Embedded as a `data:` URI so the report stays one file. */
  data?: string | undefined;
  /** Frame size actually recorded, which is not necessarily the viewport. */
  width: number;
  height: number;
  /** Bytes on disk before base64 — what the recording actually weighs. */
  bytes: number;
  /**
   * Set instead of `data` when the recording was too large to embed. The
   * report says so rather than silently showing no video: "we recorded it and
   * it is over there" and "there is no recording" are different facts.
   */
  omitted?: string | undefined;
  /** Index of the step the recording was cut at — the one that failed. */
  endsAtStep?: number | undefined;
  /** Playing time of the kept segment. */
  durationMs?: number | undefined;
}

/**
 * How much to keep past the end of the failing step.
 *
 * The step is recorded as failed the moment its last attempt gives up, but the
 * page usually finishes reacting a beat later — an error banner rendering, a
 * spinner stopping. Cutting exactly on the step boundary tends to end the
 * video just before the thing it was kept to show.
 */
const FAILURE_TAIL_MS = 750;

/**
 * Longest side of a recorded frame.
 *
 * The viewport is 1920×1080 by default and a 1920-wide recording of a run of
 * any length does not belong inside a single self-contained HTML file. Video
 * compresses across time rather than within one image, so halving the
 * dimensions is worth far more here than a JPEG quality tier is for a still.
 * A pointer, a button and the shape of a page all survive 960 wide; reading
 * small text is what the failure screenshot is still for.
 */
const MAX_VIDEO_EDGE = 960;

/**
 * Ceiling on an embedded recording.
 *
 * The report is one file that has to open off a USB stick, and base64 inflates
 * by a third on top of this. A long run against a busy page can exceed it, and
 * the honest response is to keep the run's verdict and say the video was too
 * large — never to fail the run, and never to quietly produce a report with a
 * video element that plays nothing.
 */
const MAX_EMBED_BYTES = 24 * 1024 * 1024;

/**
 * Frame size for a given viewport.
 *
 * Aspect ratio is preserved, and the result is rounded to even numbers because
 * the VP8 encoder wants even dimensions and a browser asked for an odd one
 * quietly records a frame that is off by a pixel against the page inside it.
 */
export function videoSize(viewport: { width: number; height: number } | null): {
  width: number;
  height: number;
} {
  const source = viewport ?? { width: 1280, height: 720 };
  const scale = Math.min(1, MAX_VIDEO_EDGE / Math.max(source.width, source.height));
  const even = (n: number) => Math.max(2, Math.round((n * scale) / 2) * 2);
  return { width: even(source.width), height: even(source.height) };
}

/**
 * The pointer, drawn by the page.
 *
 * **This is a source string, not a function, and that is load-bearing.**
 * `BrowserContext.addInitScript` accepts either, and the function form is
 * serialised with `Function.prototype.toString` — so what actually reaches the
 * browser is whatever the *build* left behind, not what was written. Under
 * `tsx` the transpiled arrow silently fails to install the overlay and the
 * recording comes out with no pointer at all: no error, no warning, just a
 * feature that does nothing. Passing the source verbatim removes the build
 * from the path entirely.
 *
 * Three rules the overlay obeys, because it is injected into the application
 * under test and must not become part of what the test measures:
 *
 * - **A closed shadow root.** The page's own `querySelectorAll('div')` count,
 *   and every selector a flow or the healer writes, sees one anonymous host
 *   element and nothing inside it. There is a test asserting the internals do
 *   not leak.
 * - **`aria-hidden` and `pointer-events: none`.** It is absent from the AX tree
 *   the healer and the coverage inventory read, and it can never intercept a
 *   click meant for the application.
 * - **It installs itself late and repeatedly.** At document-start — when init
 *   scripts run — `document.documentElement` does not exist yet, so a single
 *   attempt is guaranteed to be too early. `boot()` is idempotent and is
 *   retried on `DOMContentLoaded` and on the first input event, which covers a
 *   page that replaced its own document element after load.
 */
export const CURSOR_OVERLAY_SOURCE = `(() => {
  var g = globalThis;
  if (g.__wowCursorInstalled) return;
  g.__wowCursorInstalled = true;
  var cur = null, ring = null, cap = null;
  function boot() {
    try {
      var d = g.document;
      if (!d || !d.documentElement || cur) return;
      var host = d.createElement('div');
      host.setAttribute('aria-hidden', 'true');
      host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483647';
      var root = host.attachShadow({ mode: 'closed' });
      root.innerHTML =
        '<style>' +
        '#c{position:fixed;left:-999px;top:-999px;width:20px;height:20px;margin:-10px 0 0 -10px;' +
        'border-radius:50%;background:rgba(20,20,20,.35);border:2px solid #fff;' +
        'box-shadow:0 1px 4px rgba(0,0,0,.5);transition:transform .08s ease-out,background .08s}' +
        '#r{position:fixed;left:-999px;top:-999px;width:20px;height:20px;margin:-10px 0 0 -10px;' +
        'border-radius:50%;border:2px solid #21c07a;opacity:0}' +
        '#r.go{animation:w .5s ease-out}' +
        '@keyframes w{from{transform:scale(1);opacity:.9}to{transform:scale(4);opacity:0}}' +
        '#p{position:fixed;left:0;bottom:0;max-width:100%;box-sizing:border-box;' +
        'padding:6px 12px;font:600 13px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;' +
        'color:#fff;background:rgba(15,15,18,.82);opacity:0;transition:opacity .15s}' +
        '#p.on{opacity:1}' +
        '</style><div id="r"></div><div id="c"></div><div id="p"></div>';
      cur = root.getElementById('c');
      ring = root.getElementById('r');
      cap = root.getElementById('p');
      d.documentElement.appendChild(host);
      // Covers a same-document re-boot, where the window survived and the
      // caption text with it. It cannot cover a navigation — that replaces the
      // window and everything on it — which is what keepCaption is for.
      if (g.__wowCaptionText) setCaption(g.__wowCaptionText);
    } catch (e) { /* the overlay is evidence, never a reason a run behaves differently */ }
  }
  function at(e) {
    boot();
    if (!cur || typeof e.clientX !== 'number') return;
    cur.style.left = e.clientX + 'px';
    cur.style.top = e.clientY + 'px';
    ring.style.left = e.clientX + 'px';
    ring.style.top = e.clientY + 'px';
  }
  function setCaption(text) {
    g.__wowCaptionText = text;
    boot();
    if (!cap) return;
    cap.textContent = text || '';
    if (text) cap.classList.add('on'); else cap.classList.remove('on');
  }
  g.addEventListener('mousemove', at, true);
  g.addEventListener('mousedown', function (e) {
    at(e);
    if (!cur) return;
    cur.style.transform = 'scale(.72)';
    cur.style.background = 'rgba(33,192,122,.6)';
    ring.classList.remove('go');
    void ring.offsetWidth;
    ring.classList.add('go');
  }, true);
  g.addEventListener('mouseup', function (e) {
    at(e);
    if (!cur) return;
    cur.style.transform = 'scale(1)';
    cur.style.background = 'rgba(20,20,20,.35)';
  }, true);
  g.addEventListener('DOMContentLoaded', boot, true);
  g.__wowCaption = setCaption;
  boot();
})()`;

/**
 * Install the pointer overlay on every page this context opens, now and after
 * every navigation.
 *
 * Never throws: a context that refuses the init script gives a recording with
 * no pointer, which is worse evidence and not a reason to abandon a run.
 */
export async function installCursorOverlay(context: BrowserContext): Promise<void> {
  await context.addInitScript({ content: CURSOR_OVERLAY_SOURCE }).catch(() => undefined);
}

/**
 * Caption the recording with the step now running.
 *
 * The report can already seek to a step, so this is not about navigation — it
 * is about the video being evidence on its own, in a bug report, detached from
 * the HTML around it. A recording of a pointer clicking things is a recording
 * of a pointer clicking things; the same recording captioned "step 4 — check
 * the invoice total updates" is an account of a test.
 *
 * Best-effort and silent, on the same rule as everything else here.
 */
export async function captionVideo(page: Page, text: string): Promise<void> {
  try {
    await page.evaluate(
      (value) => {
        const fn = (globalThis as unknown as { __wowCaption?: (t: string) => void }).__wowCaption;
        if (fn) fn(value);
      },
      text,
    );
  } catch {
    // A page mid-navigation has no overlay yet; the next step captions it.
  }
}

/**
 * Re-apply the current caption after every navigation.
 *
 * A caption is set once per step, before the step runs — and a step that
 * navigates destroys the window holding it, so without this the film goes
 * uncaptioned from the moment a page loads until the *next* step starts. That
 * is precisely the stretch a `goto` is on screen for, so the one step whose
 * caption matters most would be the one that never showed it.
 *
 * `framenavigated` rather than a re-caption inside `goto`, because a click can
 * navigate too, and there is no list of actions that might.
 */
export function keepCaption(page: Page, current: () => string): void {
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return;
    const text = current();
    if (text) void captionVideo(page, text);
  });
}

/**
 * Where to cut the recording, or `null` for "keep nothing".
 *
 * `null` is the ordinary outcome: most runs pass. The rule is that video is
 * evidence *of a failure* — captured from the start of the flow so the state
 * leading up to it is there, and ending at the step that broke.
 */
export type VideoCut = {
  stepIndex: number;
  /** End of the failing step, in ms from the first frame. */
  atMs: number;
  /**
   * Start of the next step that was filmed, when the run carried on past the
   * failure. The tail below may not reach it: a recording that shows the step
   * *after* the failure is no longer a recording up to the failure.
   */
  noLaterThanMs?: number | undefined;
} | 'full' | null;

/** A directory for Playwright to write recordings into, removed once sealed. */
export async function videoTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'wowlidator-video-'));
}

/**
 * Read the finished recording and clean up after it.
 *
 * **Only call this after the recording context is closed.** Playwright
 * finalises a video when its context closes; asked before that, `path()` names
 * a file that is still being written and reading it yields a truncated webm
 * that no player will open.
 *
 * Returns `undefined` when there is nothing to report — recording was off, the
 * page never had a video, the file vanished. Never throws: evidence follows the
 * same rule as coverage and history, and a run's verdict must not depend on
 * whether the recording survived.
 */
export async function sealVideo(
  page: Page,
  dir: string,
  size: { width: number; height: number },
  cut: VideoCut,
): Promise<VideoRecording | undefined> {
  try {
    const video = page.video();
    if (!video) return undefined;
    // Nothing went wrong, so there is nothing to look at. A recording of a run
    // that passed is weight in every report and every proof bundle, for a
    // question nobody asked — unless the caller asked exactly that question
    // (`'full'`, from `--video always`): the film of the whole task, kept
    // whatever the outcome, untrimmed.
    if (cut === null) return undefined;

    const path = await video.path();
    const original = await readFile(path);
    let buffer: Buffer;
    let durationMs: number | undefined;
    let endsAtStep: number | undefined;
    if (cut === 'full') {
      const whole = trimWebm(original, Number.MAX_SAFE_INTEGER);
      // Even "keep everything" goes through the parser: the duration is what
      // lets subtitles and per-step seeks address the film, and a recording
      // the parser cannot read is not evidence anyone can verify.
      if (!whole) return undefined;
      buffer = whole.data;
      durationMs = whole.durationMs;
    } else {
      const end =
        cut.noLaterThanMs === undefined
          ? cut.atMs + FAILURE_TAIL_MS
          : Math.max(cut.atMs, Math.min(cut.atMs + FAILURE_TAIL_MS, cut.noLaterThanMs));
      const trimmed = trimWebm(original, end);
      // "Captured, or not at all." A recording that cannot be cut to the failure
      // would have to be handed over whole, and a video that runs past the thing
      // it was kept for misrepresents when the run ended — so it is dropped, and
      // the report says nothing was captured rather than showing something
      // misleading. See `webm.ts` for what "cannot" covers.
      if (!trimmed) return undefined;
      buffer = trimmed.data;
      durationMs = trimmed.durationMs;
      endsAtStep = cut.stepIndex;
    }

    const recording: VideoRecording = {
      width: size.width,
      height: size.height,
      bytes: buffer.byteLength,
      endsAtStep,
      durationMs,
    };
    if (buffer.byteLength > MAX_EMBED_BYTES) {
      recording.omitted =
        `recording was ${Math.round(buffer.byteLength / 1024 / 1024)}MB, over the ` +
        `${Math.round(MAX_EMBED_BYTES / 1024 / 1024)}MB limit for embedding in a self-contained report`;
    } else {
      recording.data = buffer.toString('base64');
    }
    return recording;
  } catch {
    return undefined;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
