/**
 * Video evidence (`src/engine/video.ts`) and how it lands in a bundle and a
 * report.
 *
 * Two tiers, same split as everywhere else. Frame sizing, mode parsing, the
 * rule that decides whether stills are still captured, per-step offsets and
 * the report's video block are pure and run always. Everything that matters
 * most about this feature is not: that Playwright records at all over a CDP
 * connection, and that a pointer appears in what the browser composites, are
 * both facts about a real browser and neither can be established from a mock.
 * Both were wrong in an early version and neither would have been caught by
 * anything at the unit tier.
 *
 *   npm test                                 # unit + browser (if Chrome is up)
 *   WOWLIDATOR_CDP_URL=http://localhost:9222 npm test
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

import { ProofBundleBuilder } from '../src/engine/proof-bundle.js';
import { renderReport } from '../src/reporter/html-reporter.js';
import { runFlow, type Flow } from '../src/engine/runner.js';
import {
  CURSOR_OVERLAY_SOURCE,
  parseVideoMode,
  videoSize,
  type VideoRecording,
} from '../src/engine/video.js';
import { trimWebm } from '../src/engine/webm.js';

const CDP_URL = process.env['WOWLIDATOR_CDP_URL'] ?? 'http://localhost:9222';

const FIXTURE_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>video fixture</title>
    <style>body{background:#fff;margin:0;font:16px system-ui}
      #target{position:absolute;left:300px;top:220px;padding:16px 24px}</style>
  </head>
  <body>
    <h1 id="heading">Invoice 4471</h1>
    <button id="target" type="button">Approve</button>
    <p id="status">pending</p>
    <script>
      document.getElementById('target').addEventListener('click', () => {
        document.getElementById('status').textContent = 'approved';
      });
    </script>
  </body>
</html>`;

async function cdpAvailable(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/json/version`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

const browserReady = await cdpAvailable(CDP_URL);
const skipBrowser = browserReady
  ? false
  : `no CDP endpoint at ${CDP_URL} — start Chrome with --remote-debugging-port=9222 (npm run chrome)`;

/**
 * A real Playwright recording, not a synthetic one.
 *
 * Same reasoning as the `.xlsx` and `.pdf` next to it: a container reader
 * tested only against its own writer proves the two agree, not that either is
 * right. This one has two clusters, which is the case that matters — a cut
 * inside the second means keeping the first whole and rebuilding the second,
 * and a single-cluster fixture would never exercise it.
 */
const RECORDING = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'recording.webm'),
);

// --- Unit tier -------------------------------------------------------------

describe('cutting a recording short', () => {
  it('cuts to the requested moment', () => {
    const trimmed = trimWebm(RECORDING, 3000);
    assert.ok(trimmed);
    assert.equal(trimmed.durationMs, 3000);
    assert.ok(trimmed.data.length < RECORDING.length, 'a cut recording must be smaller');
  });

  it('lands inside the second cluster, rebuilding it', () => {
    // The fixture's clusters start at 0ms and 5040ms. A cut at 5.5s keeps the
    // first whole and has to rebuild the second block by block — cluster
    // granularity alone would overshoot by up to five seconds.
    const trimmed = trimWebm(RECORDING, 5500);
    assert.ok(trimmed);
    assert.ok(trimmed.durationMs <= 5500, 'the cut must never run past what was asked');
    assert.ok(trimmed.durationMs > 5040, 'and must reach into the second cluster');
  });

  it('gets shorter as the cut gets earlier', () => {
    const early = trimWebm(RECORDING, 1000);
    const late = trimWebm(RECORDING, 3000);
    assert.ok(early && late);
    assert.ok(early.data.length < late.data.length);
  });

  it('drops the cue index, whose offsets the cut invalidates', () => {
    // Cues point at clusters by byte offset and sit after them. Keeping a
    // stale one is the kind of damage that yields a video which plays and
    // lies, so it goes — a player reads the file linearly without it.
    const trimmed = trimWebm(RECORDING, 3000);
    assert.ok(trimmed);
    assert.equal(trimmed.data.includes(Buffer.from([0x1c, 0x53, 0xbb, 0x6b])), false);
  });

  it('refuses rather than returning something it cannot vouch for', () => {
    // "Captured, or not at all" — the caller reports no video rather than one
    // that misrepresents when the run ended.
    assert.equal(trimWebm(RECORDING, 0), null, 'a zero-length cut keeps no frames');
    assert.equal(trimWebm(RECORDING, -5), null);
    assert.equal(trimWebm(Buffer.from('not a webm at all'), 1000), null);
    assert.equal(trimWebm(Buffer.alloc(0), 1000), null);
    assert.equal(trimWebm(RECORDING.subarray(0, 400), 1000), null, 'a truncated source');
  });

  it('keeps everything when the cut is past the end', () => {
    const trimmed = trimWebm(RECORDING, 60_000);
    assert.ok(trimmed);
    assert.ok(trimmed.durationMs > 6000);
  });
});

describe('videoSize', () => {
  it('caps the long edge and keeps the aspect ratio', () => {
    const size = videoSize({ width: 1920, height: 1080 });
    assert.equal(size.width, 960);
    assert.equal(size.height, 540);
  });

  it('never upscales a viewport that is already small', () => {
    const size = videoSize({ width: 800, height: 600 });
    assert.deepEqual(size, { width: 800, height: 600 });
  });

  it('produces even dimensions, which the encoder requires', () => {
    // 1001 scales to an odd number before rounding; an odd frame records a
    // picture that is off by a pixel against the page inside it.
    const size = videoSize({ width: 1001, height: 777 });
    assert.equal(size.width % 2, 0);
    assert.equal(size.height % 2, 0);
  });
});

describe('parseVideoMode', () => {
  it('accepts the three modes and refuses anything else', () => {
    assert.equal(parseVideoMode('on'), 'on');
    assert.equal(parseVideoMode('always'), 'always');
    assert.equal(parseVideoMode('off'), 'off');
    // Refused rather than read as "off": a typo that silently stopped
    // recording would surface as a report with no video and no reason given.
    assert.equal(parseVideoMode('yes'), null);
    assert.equal(parseVideoMode('true'), null);
  });

  it('reports "not given" distinctly from "not valid"', () => {
    assert.equal(parseVideoMode(undefined), null);
  });
});

describe('the injected pointer overlay', () => {
  it('is a source string, not a function', () => {
    // Load-bearing: addInitScript serialises a function with toString, so the
    // function form ships whatever the build left behind. Under tsx the
    // transpiled arrow installs nothing at all, silently — no error, no
    // pointer. Keeping it as source removes the build from the path.
    assert.equal(typeof CURSOR_OVERLAY_SOURCE, 'string');
  });

  it('hides itself from the accessibility tree and from pointer events', () => {
    // The healer and the coverage inventory both read the AX tree, and a
    // click meant for the application must never land on evidence.
    assert.match(CURSOR_OVERLAY_SOURCE, /aria-hidden/);
    assert.match(CURSOR_OVERLAY_SOURCE, /pointer-events:none/);
  });

  it('uses a closed shadow root', () => {
    assert.match(CURSOR_OVERLAY_SOURCE, /mode: 'closed'/);
  });

  it('retries installation rather than assuming the document exists', () => {
    // At document-start, when init scripts run, documentElement is null. A
    // single attempt is guaranteed to be too early.
    assert.match(CURSOR_OVERLAY_SOURCE, /DOMContentLoaded/);
  });
});

describe('per-step video offsets', () => {
  const step = (action: string, startedAt: string) => ({
    action,
    selector: null,
    resolvedSelector: null,
    resolution: null,
    status: 'passed' as const,
    startedAt,
    durationMs: 1,
    url: null,
  });

  it('measures each step from the recording’s first frame', () => {
    const builder = new ProofBundleBuilder({ name: 'offsets' });
    builder.setVideoStart(Date.parse('2026-01-01T00:00:00.000Z'));
    builder.addStep(step('goto', '2026-01-01T00:00:00.500Z'));
    builder.addStep(step('click', '2026-01-01T00:00:02.250Z'));

    const bundle = builder.finish();
    assert.equal(bundle.steps[0]?.videoOffsetMs, 500);
    assert.equal(bundle.steps[1]?.videoOffsetMs, 2250);
  });

  it('stamps nothing when the run was not filmed', () => {
    const builder = new ProofBundleBuilder({ name: 'no video' });
    builder.addStep(step('click', '2026-01-01T00:00:00.500Z'));
    assert.equal(builder.finish().steps[0]?.videoOffsetMs, undefined);
  });

  it('does not point an HTTP step at a moment in the film', () => {
    // A `request` never appeared on screen. Offering to play it would send a
    // reader looking for something that was never recorded.
    const builder = new ProofBundleBuilder({ name: 'api' });
    builder.setVideoStart(Date.parse('2026-01-01T00:00:00.000Z'));
    builder.addStep(step('request', '2026-01-01T00:00:01.000Z'));
    builder.addStep(step('expectStatus', '2026-01-01T00:00:01.100Z'));
    builder.addStep(step('click', '2026-01-01T00:00:01.200Z'));

    const bundle = builder.finish();
    assert.equal(bundle.steps[0]?.videoOffsetMs, undefined);
    assert.equal(bundle.steps[1]?.videoOffsetMs, undefined);
    assert.equal(bundle.steps[2]?.videoOffsetMs, 1200);
  });

  it('never reports a negative offset', () => {
    const builder = new ProofBundleBuilder({ name: 'clock skew' });
    builder.setVideoStart(Date.parse('2026-01-01T00:00:05.000Z'));
    builder.addStep(step('goto', '2026-01-01T00:00:04.000Z'));
    assert.equal(builder.finish().steps[0]?.videoOffsetMs, 0);
  });
});

describe('the report’s video block', () => {
  function bundleWith(video: VideoRecording | undefined) {
    const builder = new ProofBundleBuilder({ name: 'filmed run' });
    if (video) builder.setVideoStart(Date.parse('2026-01-01T00:00:00.000Z'));
    builder.addStep({
      action: 'click',
      intent: 'approve the invoice',
      selector: 'role=button[name="Approve"]',
      resolvedSelector: 'role=button[name="Approve"]',
      resolution: 'fast',
      status: 'passed',
      startedAt: '2026-01-01T00:00:01.500Z',
      durationMs: 40,
      url: 'https://example.test/',
    });
    const bundle = builder.finish();
    return { ...bundle, video };
  }

  it('embeds the recording and offers a seek per step', () => {
    const html = renderReport(
      bundleWith({ data: 'AAAA', width: 960, height: 540, bytes: 4 }),
    );
    // Carried as an attribute, not as a src: Chrome's media stack will not
    // load a data: video at all — it stalls at readyState 0 with no error,
    // which reads exactly like a corrupt recording. The page turns the same
    // bytes into a Blob URL.
    assert.match(html, /data-webm="AAAA"/);
    assert.doesNotMatch(html, /<video[^>]*\ssrc=/);
    assert.match(html, /createObjectURL/);
    // 1.5s in, expressed in seconds for the media element.
    assert.match(html, /data-seek="1\.50"/);
  });

  it('stays one self-contained file', () => {
    const html = renderReport(
      bundleWith({ data: 'AAAA', width: 960, height: 540, bytes: 4 }),
    );
    // Same rule the rest of the report follows: the bytes are inline. A
    // <video src="run.webm"> would open off a developer's machine and nowhere
    // else.
    assert.doesNotMatch(html, /<video[^>]+src="(?!blob:)/);
    assert.ok(html.includes('AAAA'), 'the recording is not in the file at all');
  });

  it('says a recording was made but not embedded, rather than showing nothing', () => {
    // "We recorded it and it did not fit" and "nothing was recorded" are
    // different facts; rendering neither leaves a reader to guess which.
    const html = renderReport(
      bundleWith({ width: 960, height: 540, bytes: 99, omitted: 'too large to embed' }),
    );
    assert.match(html, /too large to embed/);
    assert.doesNotMatch(html, /data-seek=/);
  });

  it('renders no video furniture at all for an unfilmed run', () => {
    const html = renderReport(bundleWith(undefined));
    assert.doesNotMatch(html, /<video/);
    assert.doesNotMatch(html, /data-seek=/);
  });
});

// --- Browser tier ----------------------------------------------------------

describe('recording a run (CDP)', { skip: skipBrowser }, () => {
  let server: Server;
  let origin: string;

  before(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(FIXTURE_HTML);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    // Chrome holds keep-alive sockets; without this the suite blocks ~60s.
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  const flow = (): Flow => ({
    name: 'video run',
    steps: [
      { action: 'goto', url: `${origin}/` },
      {
        action: 'click',
        selector: 'role=button[name="Approve"]',
        intent: 'approve the invoice',
      },
      { action: 'expectText', selector: '#status', value: 'approved' },
    ],
  });

  it('keeps no recording at all when nothing went wrong', async () => {
    // The rule: a recording is evidence *of a failure*. Filming every passing
    // run is weight in every report and proof bundle for a question nobody
    // asked, and it is what makes recording affordable as a default.
    const bundle = await runFlow(flow(), {
      cdpUrl: CDP_URL,
      historyPath: null,
      coverage: false,
    });

    assert.equal(bundle.status, 'passed');
    assert.equal(bundle.video, undefined, 'a passing run must not carry a recording');
    // Offsets are still stamped: the run *was* filmed, the film was discarded.
    for (const step of bundle.steps) {
      assert.equal(typeof step.videoOffsetMs, 'number', `step ${step.index} has no offset`);
    }
    const offsets = bundle.steps.map((s) => s.videoOffsetMs ?? 0);
    assert.deepEqual(offsets, [...offsets].sort((a, b) => a - b));
  });

  it('paces steps for the viewer: the pause is measurable between recorded steps', async () => {
    // Measured from the bundle's own timestamps — the gap between one step
    // ending and the next beginning — so ambient machine load, which slows
    // both paced and unpaced runs alike, cannot flake the assertion.
    const paced = await runFlow(
      {
        name: 'paced-slow',
        steps: [
          { action: 'goto', url: `${origin}/` },
          { action: 'expectVisible', selector: 'role=heading[name="Invoice 4471"]' },
          { action: 'expectVisible', selector: 'role=button[name="Approve"]' },
        ],
      },
      { cdpUrl: CDP_URL, historyPath: null, coverage: false, video: 'off', stepDelayMs: 400 },
    );
    assert.equal(paced.status, 'passed', paced.error ?? 'pacing must not change the outcome');
    for (let i = 1; i < paced.steps.length; i++) {
      const prev = paced.steps[i - 1]!;
      const gap = Date.parse(paced.steps[i]!.startedAt) - (Date.parse(prev.startedAt) + prev.durationMs);
      assert.ok(gap >= 300, `the pause before step ${i} must be visible in its timestamps (gap ${gap}ms)`);
    }
  });

  it("keeps the WHOLE film on a pass under video:'always' — the actual flow, end to end", async () => {
    const bundle = await runFlow(
      {
        name: 'always filmed',
        steps: [
          { action: 'goto', url: `${origin}/` },
          { action: 'expectVisible', selector: 'role=heading[name="Invoice 4471"]' },
        ],
      },
      { cdpUrl: CDP_URL, historyPath: null, coverage: false, video: 'always' },
    );

    assert.equal(bundle.status, 'passed', bundle.error ?? 'the fixture flow should pass');
    const video = bundle.video;
    assert.ok(video, "video:'always' must keep a passing run's recording");
    assert.ok(video.data, 'and embed it');
    assert.equal(video.endsAtStep, undefined, 'nothing was cut — there is no failure to cut to');
    assert.ok((video.durationMs ?? 0) > 0, 'the parser measured it, so subtitles can address it');
    // Every filmed step still addresses its moment.
    for (const step of bundle.steps) {
      assert.equal(typeof step.videoOffsetMs, 'number', `step ${step.index} lost its offset`);
    }
  });

  it('keeps the run up to the failure, and stops there', async () => {
    const bundle = await runFlow(
      {
        name: 'fails midway',
        steps: [
          { action: 'goto', url: `${origin}/` },
          { action: 'expectVisible', selector: 'role=heading[name="Invoice 4471"]' },
          { action: 'expectVisible', selector: 'role=button[name="Nonexistent"]' },
          // Runs after the failure, and must not appear in the recording.
          { action: 'expectVisible', selector: 'role=button[name="Approve"]' },
        ],
      },
      { cdpUrl: CDP_URL, historyPath: null, coverage: false },
    );

    const video = bundle.video;
    assert.ok(video, 'a failing run must be captured');
    assert.ok(video.data, 'a short recording is well under the embed ceiling');
    assert.equal(video.endsAtStep, 2, 'it should be cut at the step that failed');

    const trailing = bundle.steps[3];
    assert.equal(trailing?.status, 'passed', 'the run should have continued past the failure');
    // The step after the failure lies past the cut, so its offset is stripped
    // at seal time — a "play from here" pointing past the last frame would be
    // a dead control. Its absence IS the proof the recording stops at the
    // failure; the failing step itself must still be addressable.
    assert.equal(trailing.videoOffsetMs, undefined, 'no offset may point past the cut');
    const failing = bundle.steps[2];
    assert.ok(
      failing?.videoOffsetMs !== undefined && failing.videoOffsetMs < (video.durationMs ?? 0),
      'the failing step must still address its own moment in the recording',
    );
  });

  it('cuts at the first failure, not the last', async () => {
    // Once a step has failed the run continues in a state the test no longer
    // understands, so later failures are usually consequences of the first.
    const bundle = await runFlow(
      {
        name: 'two failures',
        steps: [
          { action: 'goto', url: `${origin}/` },
          { action: 'expectVisible', selector: 'role=button[name="NopeOne"]' },
          { action: 'expectVisible', selector: 'role=button[name="NopeTwo"]' },
        ],
      },
      { cdpUrl: CDP_URL, historyPath: null, coverage: false },
    );
    assert.equal(bundle.video?.endsAtStep, 1);
  });

  it('captures a still for a failure and none for a passing step', async () => {
    // The point of the change: the film carries the ordinary steps, and a
    // still is kept only where someone will zoom in.
    const bundle = await runFlow(
      {
        name: 'one failure',
        steps: [
          { action: 'goto', url: `${origin}/` },
          { action: 'expectVisible', selector: 'role=button[name="Nonexistent"]' },
        ],
      },
      { cdpUrl: CDP_URL, historyPath: null, coverage: false },
    );

    assert.equal(bundle.steps[0]?.screenshot, undefined, 'a passing step needs no still');
    assert.ok(bundle.steps[1]?.screenshot, 'a failure keeps its zoomable image');
  });

  it('films nothing, and keeps every still, when recording is off', async () => {
    const bundle = await runFlow(flow(), {
      cdpUrl: CDP_URL,
      video: 'off',
      historyPath: null,
      coverage: false,
    });

    assert.equal(bundle.video, undefined);
    assert.equal(bundle.steps.every((s) => s.videoOffsetMs === undefined), true);
    // Unset stills follow the recording in both directions: with no film,
    // every step is photographed exactly as it was before video existed.
    assert.equal(bundle.steps.every((s) => s.screenshot !== undefined), true);
  });

  it('keeps the caption on screen across a navigation', async () => {
    // A navigation replaces the window and everything stored on it, so
    // without `keepCaption` the film goes uncaptioned from the moment a page
    // loads until the next step starts — which is exactly the stretch a
    // `goto` is on screen for. Read back through the overlay's own state,
    // since the caption lives in a closed shadow root by design.
    // Ends in a failure on purpose: a passing run keeps no recording, so
    // there would be nothing to assert the caption survived *into*.
    const bundle = await runFlow(
      {
        name: 'caption across navigation',
        steps: [
          { action: 'goto', url: `${origin}/` },
          { action: 'goto', url: `${origin}/?second` },
          { action: 'expectVisible', selector: 'role=heading[name="Invoice 4471"]' },
          { action: 'expectVisible', selector: 'role=button[name="Nonexistent"]' },
        ],
      },
      { cdpUrl: CDP_URL, historyPath: null, coverage: false },
    );
    assert.equal(bundle.steps[2]?.status, 'passed', 'the second navigation should have landed');
    assert.ok(bundle.video, 'a failing run is captured, navigations and all');
    assert.equal(bundle.video.endsAtStep, 3);
  });

  it('does not let the pointer overlay change what the test sees', async () => {
    // The overlay is injected into the application under test. If it were
    // visible to a selector, or to the accessibility tree, it would be part
    // of what the run measures rather than a record of it.
    const bundle = await runFlow(
      {
        name: 'overlay is invisible',
        steps: [
          { action: 'goto', url: `${origin}/` },
          // The host element is an anonymous, empty, zero-size div. Nothing
          // inside it is reachable, and it answers to no role or name.
          { action: 'expectCount', selector: '[aria-hidden="true"] *', count: 0 },
          { action: 'expectVisible', selector: 'role=heading[name="Invoice 4471"]' },
        ],
      },
      { cdpUrl: CDP_URL, historyPath: null, coverage: false },
    );

    assert.equal(bundle.status, 'passed');
  });
});
