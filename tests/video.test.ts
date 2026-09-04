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
import { chromium } from 'playwright';
import { runFlow, type Flow } from '../src/engine/runner.js';
import {
  CURSOR_OVERLAY_SOURCE,
  VIDEO_ACTION_DWELL_MS,
  VIDEO_ACTION_LEAD_MS,
  VIDEO_LEAD_CAP_MS,
  actionWindows,
  leadOf,
  parseVideoMode,
  videoSize,
  type VideoRecording,
} from '../src/engine/video.js';
import { BRIDGE_MS, CUT_HOLD_MS, IDLE_BURST_MS, condenseWebm, frameIndex, mapToCondensed, trimWebm } from '../src/engine/webm.js';

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

describe('condensing a recording to its action moments', () => {
  // The fixture is 6.3 s at 25 fps with keyframes at 0 and 5120 ms (libvpx's
  // 128-frame interval), so a moment at 2.5 s must open on the first
  // keyframe and one at 6 s on the second — the pre-roll a codec forces is
  // the case that matters, and a single-keyframe fixture would never show it.
  const moments = [2500, 6000];

  it('keeps each moment at real speed and drops the idle between them', () => {
    const short = condenseWebm(RECORDING, actionWindows(moments));
    assert.ok(short, 'a Playwright recording must condense');
    assert.ok(short.data.length < RECORDING.length, 'the condensed film weighs less');
    assert.ok(short.durationMs < short.sourceDurationMs, 'and plays shorter');
    assert.ok(short.frames < short.sourceFrames);
    // The 5.12 → 2.1 s stretch between the two moments is gone: nothing in
    // the output maps to it.
    assert.equal(short.segments.some((s) => s.sourceFromMs > 3600 && s.sourceToMs < 5100), false);
    const held = short.segments.filter((s) => !s.idle);
    assert.equal(held.length, 2, 'one real-time stretch per moment');
    for (const seg of held) {
      const source = seg.sourceToMs - seg.sourceFromMs;
      const output = seg.outputToMs - seg.outputFromMs;
      assert.equal(output, source, 'a moment plays at the speed it happened');
      // Held for the dwell, unless the film itself ended first (6 s + 1 s > 6.28 s).
      const remaining = short.sourceDurationMs - (seg.sourceFromMs + VIDEO_ACTION_LEAD_MS);
      assert.ok(source >= Math.min(VIDEO_ACTION_DWELL_MS, remaining) - 40, `a moment is held for the dwell (got ${source} ms)`);
    }
  });

  it('opens every kept span on a keyframe and packs the forced pre-roll into a burst', () => {
    const short = condenseWebm(RECORDING, actionWindows(moments));
    assert.ok(short);
    const idle = short.segments.filter((s) => s.idle);
    assert.equal(idle.length, 2, 'one pre-roll per keyframe-anchored span');
    assert.equal(idle[0]?.sourceFromMs, 0, 'the first span opens on the first keyframe');
    assert.equal(idle[1]?.sourceFromMs, 5120, 'the second on the keyframe before 6 s');
    for (const seg of idle) {
      const output = seg.outputToMs - seg.outputFromMs;
      // Bounded, whatever the pre-roll's source length (0–5.12 s): a cut,
      // not the 8× scrub that PL_07_06's film showed as 5 ms frames.
      assert.ok(output <= IDLE_BURST_MS, `pre-roll is packed into ${IDLE_BURST_MS} ms (got ${output} ms)`);
    }
  });

  it('never emits a frame spacing under one unit, and never a sliver between two moments', () => {
    // The film PL_07_06 (2026-09-04): 188 of 511 frames were 5 ms apart —
    // the 8× pre-roll — and a 2-frame "idle" between two windows 40 ms
    // apart became a 5 ms sliver. Timestamps must advance by whole units,
    // and moments closer than the bridge are one stretch at real speed.
    const short = condenseWebm(RECORDING, actionWindows([1000, 2600], 200));
    assert.ok(short);
    const frames = frameIndex(short.data);
    assert.ok(frames && frames.length > 1);
    for (let i = 1; i < frames.length; i++) {
      assert.ok(frames[i]!.timeMs > frames[i - 1]!.timeMs, `frame ${i} must be later than frame ${i - 1}`);
    }
    // Windows 600–1200 and 2200–2800 are 1000 ms apart — inside the bridge —
    // so the travel between them is kept at real pace, not cut to a sliver.
    const held = short.segments.filter((s) => !s.idle);
    assert.equal(held.length, 1, 'bridged moments are one real-time stretch');
    assert.ok(held[0]!.sourceFromMs <= 600 && held[0]!.sourceToMs >= 2800);
    const unbridged = condenseWebm(RECORDING, actionWindows([1000, 2600], 200), { bridgeMs: 0 });
    assert.ok(unbridged);
    assert.equal(unbridged.segments.filter((s) => !s.idle).length, 2, 'without the bridge they are two');
    assert.ok(BRIDGE_MS >= 1000);
  });

  it('holds the last frame before every cut, and every cut lands on a keyframe', () => {
    const short = condenseWebm(RECORDING, actionWindows(moments));
    assert.ok(short);
    const frames = frameIndex(short.data);
    assert.ok(frames);
    // The clock map: where a span changes, or a moment gives way to idle,
    // the previous frame is held for the cut hold and no shorter.
    for (let i = 1; i < short.segments.length; i++) {
      const prev = short.segments[i - 1]!;
      const next = short.segments[i]!;
      const gap = next.outputFromMs - prev.outputToMs;
      const cut = next.sourceFromMs - prev.sourceToMs > 40 || (!prev.idle && next.idle);
      if (cut) assert.ok(gap >= CUT_HOLD_MS - 1, `a cut at ${prev.outputToMs} ms is held ${CUT_HOLD_MS} ms (got ${gap})`);
      else assert.ok(gap <= 40, `a continuous stretch has no hold (got ${gap})`);
    }
    // And the frame that opens each held gap is a keyframe: every span is
    // decodable from what is kept, nothing refers to a frame that is gone.
    for (let i = 1; i < frames.length; i++) {
      const gap = frames[i]!.timeMs - frames[i - 1]!.timeMs;
      if (gap >= CUT_HOLD_MS - 1) assert.equal(frames[i]!.key, true, `the frame after the hold at ${frames[i - 1]!.timeMs} ms must be a keyframe`);
    }
    assert.equal(frames[0]!.key, true, 'the film opens on a keyframe');
  });

  it('keeps a performed step\'s whole performance ahead of its moment, bounded', () => {
    // A humanised click (`humanize.ts`) spends ~400 ms travelling to the
    // control; the film keeps that on top of the fixed lead.
    assert.deepEqual(actionWindows([{ at: 5000, leadMs: 800 }]), [{ fromMs: 4200, toMs: 6000 }]);
    assert.deepEqual(actionWindows([{ at: 5000 }]), actionWindows([5000]), 'no lead given: the fixed lead');
    assert.equal(leadOf({ at: 0, leadMs: 100 }), VIDEO_ACTION_LEAD_MS, 'never less than the fixed lead');
    assert.equal(leadOf({ at: 0, leadMs: 60_000 }), VIDEO_LEAD_CAP_MS, 'never more than the cap');
  });

  it('produces a whole WebM the trimmer can re-read, on its own clock', () => {
    // Never reordered, never fabricated: every frame in the output is one of
    // the source's, in source order, and the container re-parses cleanly
    // with a duration equal to the last kept frame.
    const short = condenseWebm(RECORDING, actionWindows(moments));
    assert.ok(short);
    const reread = trimWebm(short.data, Number.MAX_SAFE_INTEGER);
    assert.ok(reread, 'the condensed film is a WebM in its own right');
    assert.equal(reread.durationMs, short.durationMs);
    const outputs = short.segments.map((s) => s.outputFromMs);
    assert.deepEqual(outputs, [...outputs].sort((a, b) => a - b), 'segments advance monotonically');
    const sources = short.segments.map((s) => s.sourceFromMs);
    assert.deepEqual(sources, [...sources].sort((a, b) => a - b), 'in source order');
  });

  it('merges moments that share a keyframe into one contiguous span', () => {
    const short = condenseWebm(RECORDING, actionWindows([1000, 1800, 2600]));
    assert.ok(short);
    assert.equal(short.segments.filter((s) => s.idle).length, 1, 'one pre-roll, not three');
    const held = short.segments.filter((s) => !s.idle);
    assert.equal(held.length, 1, 'the overlapping dwells are one stretch');
    assert.equal(held[0]?.outputToMs, short.durationMs);
  });

  it('refuses rather than returning something it cannot vouch for', () => {
    assert.equal(condenseWebm(RECORDING, []), null, 'no moment keeps no frames');
    assert.equal(condenseWebm(RECORDING, actionWindows([90_000])), null, 'a moment past the film');
    assert.equal(condenseWebm(Buffer.from('not a webm'), actionWindows([1000])), null);
    assert.equal(condenseWebm(RECORDING.subarray(0, 400), actionWindows([1000])), null);
  });

  it('maps a source moment onto the condensed clock', () => {
    const short = condenseWebm(RECORDING, actionWindows(moments));
    assert.ok(short);
    const held = short.segments.filter((s) => !s.idle);
    // Inside a kept stretch: linear.
    assert.equal(mapToCondensed(short.segments, held[0]!.sourceFromMs), held[0]!.outputFromMs);
    assert.equal(mapToCondensed(short.segments, held[0]!.sourceToMs), held[0]!.outputToMs);
    // Dropped idle: the next thing that happened.
    assert.equal(mapToCondensed(short.segments, 4500), short.segments.find((s) => s.sourceFromMs >= 4500)!.outputFromMs);
    // Past the end: the end.
    assert.equal(mapToCondensed(short.segments, 99_999), short.durationMs);
    assert.equal(mapToCondensed([], 1234), 0);
  });

  it('actionWindows: lead before, dwell after, clipped to the cut', () => {
    assert.deepEqual(actionWindows([5000]), [{ fromMs: 5000 - VIDEO_ACTION_LEAD_MS, toMs: 5000 + VIDEO_ACTION_DWELL_MS }]);
    assert.deepEqual(actionWindows([100]), [{ fromMs: 0, toMs: 100 + VIDEO_ACTION_DWELL_MS }], 'never before the first frame');
    assert.deepEqual(actionWindows([5000], 1000, 5300), [{ fromMs: 4600, toMs: 5300 }], 'a failure cut ends the last window');
    assert.deepEqual(actionWindows([-1, Number.NaN]), []);
  });
});

describe('the action moments of a film', () => {
  const at = (ms: number) => new Date(Date.parse('2026-01-01T00:00:00.000Z') + ms).toISOString();
  const step = (action: string, startMs: number, durationMs: number, extra: Record<string, unknown> = {}) => ({
    action,
    selector: null,
    resolvedSelector: null,
    resolution: null,
    status: 'passed' as const,
    startedAt: at(startMs),
    durationMs,
    url: null,
    ...extra,
  });

  it('is the instant each filmed step completed, and each agent action landed', () => {
    const builder = new ProofBundleBuilder({ name: 'moments' });
    builder.setVideoStart(Date.parse(at(0)));
    builder.addStep(step('goto', 500, 1200));
    builder.addStep(step('request', 2000, 300)); // never on screen
    // A step that walked the ladder: forty seconds of nothing, then the click.
    builder.addStep(step('click', 3000, 40_000));
    builder.addStep(
      step('workflow', 44_000, 9000, {
        agent: {
          observed: '', decided: '', because: '', model: null, turns: 3, latencyMs: 9000, success: true, summary: 'done', maxSteps: null,
          actions: [
            { index: 0, action: 'wait', selector: null, value: null, url: '', reasoning: '', ok: true, durationMs: 100, finishedAt: at(45_000) },
            { index: 1, action: 'click', selector: 'role=button[name="Next"]', value: null, url: '', reasoning: '', ok: true, durationMs: 100, finishedAt: at(47_000) },
            { index: 2, action: 'fill', selector: '#x', value: 'y', url: '', reasoning: '', ok: false, durationMs: 100, finishedAt: at(50_000) },
            { index: 3, action: 'finish', selector: null, value: null, url: '', reasoning: '', ok: true, durationMs: 100, finishedAt: at(53_000) },
          ],
        },
      }),
    );
    assert.deepEqual(builder.videoMoments(), [1700, 43_000, 47_000, 50_000, 53_000]);
    // The lead each is owed: an agent action that landed keeps its
    // performance; a failed one and a plain step keep the fixed lead.
    const leads = builder.videoActionMoments().map((m) => m.leadMs);
    assert.deepEqual(leads, [undefined, undefined, VIDEO_ACTION_LEAD_MS + 100, undefined, undefined], "the step itself and a failed action keep the fixed lead");
  });

  it('keeps a humanised step\'s performance ahead of its moment', () => {
    const builder = new ProofBundleBuilder({ name: 'performed' });
    builder.setVideoStart(Date.parse(at(0)));
    builder.addStep(step('click', 1000, 500, { detail: { performedMs: 450 } }));
    builder.addStep(step('fill', 3000, 2000, { detail: { value: 'x', performedMs: 1900 } }));
    assert.deepEqual(builder.videoActionMoments(), [
      { at: 1500, leadMs: VIDEO_ACTION_LEAD_MS + 450 },
      { at: 5000, leadMs: VIDEO_ACTION_LEAD_MS + 1900 },
    ]);
  });

  it('keeps a persona’s moments on the persona’s own film', () => {
    const builder = new ProofBundleBuilder({ name: 'personas' });
    builder.setVideoStart(Date.parse(at(0)));
    builder.addStep(step('goto', 1000, 500));
    builder.setActor({ persona: 'manager', browser: 'http://localhost:9333' });
    builder.setVideoStart(Date.parse(at(10_000)), 'manager');
    builder.addStep(step('click', 12_000, 250));
    assert.deepEqual(builder.videoMoments(), [1500]);
    assert.deepEqual(builder.videoMoments('manager'), [2250]);
    assert.deepEqual(builder.videoMoments('nobody'), []);
  });

  it('moves every step onto the condensed clock when the film is attached', () => {
    const builder = new ProofBundleBuilder({ name: 'remap' });
    builder.setVideoStart(Date.parse(at(0)));
    builder.addStep(step('goto', 0, 1000)); // moment 1000
    builder.addStep(step('click', 30_000, 12_000)); // moment 42000, began in dropped idle
    const short = condenseWebm(RECORDING, actionWindows([2500, 6000]));
    assert.ok(short);
    // A film with an arbitrary clock map: what matters is that the offsets
    // follow it, not what the map says.
    const segments = [
      { sourceFromMs: 0, sourceToMs: 2000, outputFromMs: 0, outputToMs: 2000, idle: false },
      { sourceFromMs: 41_600, sourceToMs: 43_000, outputFromMs: 2040, outputToMs: 3440, idle: false },
    ];
    builder.setVideo({
      width: 2, height: 2, bytes: 1, durationMs: 3440,
      condensed: { sourceDurationMs: 60_000, sourceBytes: 2, moments: 2, dwellMs: 1000, segments },
    });
    const bundle = builder.finish();
    assert.equal(bundle.steps[0]?.videoOffsetMs, 1000 - VIDEO_ACTION_LEAD_MS, 'a step inside a kept stretch keeps its place');
    assert.equal(bundle.steps[1]?.videoOffsetMs, 2040, 'a step whose idle was dropped lands on its own moment');
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

  it('keeps the whole recording when nothing went wrong — every run has a film', async () => {
    // The rule flipped 2026-08-31, on request: the film of the mock user
    // performing the task is the evidence a reviewer opens first, pass or
    // fail, so "View actual flow" must work on every run — a clean pass
    // keeps its whole recording instead of discarding it.
    const bundle = await runFlow(flow(), {
      cdpUrl: CDP_URL,
      historyPath: null,
      coverage: false,
    });

    assert.equal(bundle.status, 'passed');
    assert.ok(bundle.video, 'a passing run keeps its recording');
    assert.ok((bundle.video?.durationMs ?? 0) > 0, 'the film has length');
    for (const step of bundle.steps) {
      assert.equal(typeof step.videoOffsetMs, 'number', `step ${step.index} has no offset`);
    }
    const offsets = bundle.steps.map((s) => s.videoOffsetMs ?? 0);
    assert.deepEqual(offsets, [...offsets].sort((a, b) => a - b));
    // Since 2026-09-04 the kept film is the run's action moments, not its
    // wall clock: what was filmed is on record, and every offset addresses
    // the condensed clock.
    const condensed = bundle.video.condensed;
    assert.ok(condensed, "video:'on' condenses the film to its action moments");
    assert.equal(condensed.moments, bundle.steps.length);
    assert.ok(bundle.video.durationMs! <= condensed.sourceDurationMs);
    assert.ok(bundle.video.bytes <= condensed.sourceBytes);
    for (const step of bundle.steps) assert.ok(step.videoOffsetMs! <= bundle.video.durationMs!);
  });

  it('the condensed film plays in the browser, for as long as the bundle says', async () => {
    // A container that re-parses is not the same fact as one a browser
    // decodes: the re-timed clusters have to be accepted by Chrome's own
    // demuxer and seekable to their last frame.
    const bundle = await runFlow(flow(), { cdpUrl: CDP_URL, historyPath: null, coverage: false });
    assert.ok(bundle.video?.data && bundle.video.condensed);
    const browser = await chromium.connectOverCDP(CDP_URL);
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/`);
      const played = await page.evaluate(
        async ({ b64 }) => {
          const bin = atob(b64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          // The test tsconfig has no DOM lib; the page does.
          const doc = (globalThis as unknown as { document: any }).document;
          const video = doc.createElement('video');
          video.muted = true;
          video.src = URL.createObjectURL(new Blob([bytes], { type: 'video/webm' }));
          doc.body.appendChild(video);
          await new Promise<void>((resolve, reject) => {
            video.addEventListener('loadedmetadata', () => resolve(), { once: true });
            video.addEventListener('error', () => reject(new Error('the browser refused the film')), { once: true });
          });
          const duration = video.duration;
          video.currentTime = Math.max(0, duration - 0.05);
          await new Promise<void>((resolve, reject) => {
            video.addEventListener('seeked', () => resolve(), { once: true });
            video.addEventListener('error', () => reject(new Error('seek failed')), { once: true });
          });
          return { duration, readyState: video.readyState, width: video.videoWidth, height: video.videoHeight };
        },
        { b64: bundle.video.data },
      );
      assert.ok(played.readyState >= 1, 'metadata decoded');
      assert.equal(played.width, bundle.video.width);
      assert.ok(Math.abs(played.duration * 1000 - bundle.video.durationMs!) < 120, `browser says ${played.duration}s, bundle says ${bundle.video.durationMs} ms`);
    } finally {
      await context.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    }
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
    assert.equal(video.condensed, undefined, "'always' is the opt-out: the wall-clock film, uncondensed");
    // Every filmed step still addresses its moment.
    for (const step of bundle.steps) {
      assert.equal(typeof step.videoOffsetMs, 'number', `step ${step.index} lost its offset`);
    }
  });

  it('keeps the WHOLE run when it carried on past the failure', async () => {
    // The old rule cut the film at the first broken step, on the premise that
    // everything after it happened in a state the test no longer understood.
    // That premise died when steps after a failure started getting their
    // turn: measured on BE_Test2 (2026-08-19), a flow dead-ended clicking
    // "Create Plan" at step 3, clicked it again and passed at step 6, passed
    // both assertions — and its 13-second recording ended at step 1. What the
    // run did ABOUT the break is the evidence; the player still opens on the
    // break (data-failure-offset), so the moment the film was kept for is the
    // first frame seen.
    const bundle = await runFlow(
      {
        name: 'fails midway',
        steps: [
          { action: 'goto', url: `${origin}/` },
          { action: 'expectVisible', selector: 'role=heading[name="Invoice 4471"]' },
          { action: 'expectVisible', selector: 'role=button[name="Nonexistent"]' },
          // Runs after the failure, and must now appear in the recording.
          { action: 'expectVisible', selector: 'role=button[name="Approve"]' },
        ],
      },
      { cdpUrl: CDP_URL, historyPath: null, coverage: false },
    );

    const video = bundle.video;
    assert.ok(video, 'a failing run must be captured');
    assert.ok(video.data, 'a short recording is well under the embed ceiling');
    assert.equal(video.endsAtStep, undefined, 'nothing is cut — the run went on, so does the film');

    const trailing = bundle.steps[3];
    assert.equal(trailing?.status, 'passed', 'the run should have continued past the failure');
    assert.equal(typeof trailing.videoOffsetMs, 'number', 'the step after the failure is on film');
    const failing = bundle.steps[2];
    assert.ok(
      failing?.videoOffsetMs !== undefined && failing.videoOffsetMs < (video.durationMs ?? 0),
      'the failing step must still address its own moment in the recording',
    );
  });

  it('still cuts at the failure when it was the last filmed step', async () => {
    // Nothing after the break to keep: a tail of dead time is not evidence.
    const bundle = await runFlow(
      {
        name: 'fails last',
        steps: [
          { action: 'goto', url: `${origin}/` },
          { action: 'expectVisible', selector: 'role=button[name="Nonexistent"]' },
        ],
      },
      { cdpUrl: CDP_URL, historyPath: null, coverage: false },
    );
    assert.equal(bundle.video?.endsAtStep, 1);
  });

  it('two failures: the film runs through both', async () => {
    // The run carried past the first failure to the second, so both are on
    // film; which one a reader sees first is the report's pre-seek, not a cut.
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
    assert.equal(bundle.video?.endsAtStep, undefined, 'kept whole');
    assert.equal(typeof bundle.steps[2]?.videoOffsetMs, 'number', 'the second failure is on film');
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
