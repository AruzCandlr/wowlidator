/**
 * Per-step evidence — `ScreenshotMode` and what reaches the report.
 *
 * The behaviour under test is **every step that touched the page leaves a
 * screenshot, not only the one that broke** — which is what an unfilmed run
 * still does, and is why these tests pin `video: 'off'` rather than relying on
 * the bare default. A failure screenshot shows the wreckage; the frame before
 * it is usually where the wrong thing actually happened, and it cannot be
 * recovered after the fact — re-running to look changes the very timing that
 * produced it.
 *
 * Since a run is filmed by default, that reasoning is now carried by the
 * recording instead, and stills drop to failures only — see
 * `tests/video.test.ts`. Stills remain the whole story whenever filming is
 * off, so this is the tier that keeps working.
 *
 * Mostly browser-tier, because "did this step capture the page" is only
 * answerable against a real page: `#shoot` calls Playwright's screenshot, and a
 * fixture cannot tell you whether the call site was reached. The two pure
 * pieces — the report's filmstrip markup and its accounting of what the
 * evidence weighs — are rendered from a hand-built bundle and always run.
 *
 *   npm test                                 # unit + browser (if Chrome is up)
 *   WOWLIDATOR_CDP_URL=http://localhost:9222 npm test
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

import { runFlow, type Flow } from '../src/engine/runner.js';
import { renderReport, writeHtmlReport } from '../src/reporter/html-reporter.js';
import type { ProofBundle, ProofStep } from '../src/engine/proof-bundle.js';

const CDP_URL = process.env['WOWLIDATOR_CDP_URL'] ?? 'http://localhost:9222';

const FIXTURE_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>evidence fixture</title></head>
  <body>
    <h1 id="heading">Before</h1>
    <button id="reveal" type="button">Reveal</button>
    <input id="name" aria-label="Name">
    <div id="panel" style="display:none;">Now visible</div>
    <script>
      document.getElementById('reveal').addEventListener('click', () => {
        document.getElementById('panel').style.display = 'block';
        document.getElementById('heading').textContent = 'After';
      });
    </script>
  </body>
</html>`;

async function cdpAvailable(url: string): Promise<boolean> {
  try {
    const response = await fetch(new URL('/json/version', url), {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const browserReady = await cdpAvailable(CDP_URL);
const skipBrowser = browserReady
  ? false
  : `no CDP endpoint at ${CDP_URL} — start Chrome with --remote-debugging-port=9222 (npm run chrome)`;

/** A flow that exercises one of each step shape the runner records. */
function mixedFlow(origin: string): Flow {
  return {
    name: 'evidence coverage',
    baseUrl: origin,
    steps: [
      { action: 'goto', url: '/' },
      // #bareStep, passing — the path that never captured anything before.
      { action: 'expectHidden', selector: '#panel', intent: 'The panel starts hidden.' },
      { action: 'fill', selector: '#name', value: 'Ada', intent: 'Type a name.' },
      { action: 'click', selector: '#reveal', intent: 'Reveal the panel.' },
      { action: 'expectText', selector: '#heading', value: 'After', intent: 'The heading updates.' },
      // Another bare step, and one with no selector at all.
      { action: 'expectUrl', value: '/', intent: 'Still on the same page.' },
    ],
  };
}

describe('per-step evidence (CDP)', { skip: skipBrowser }, () => {
  let server: Server;
  let origin: string;
  let dir: string;

  before(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(FIXTURE_HTML);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    dir = await mkdtemp(join(tmpdir(), 'wowlidator-evidence-'));
  });

  after(async () => {
    // Chrome holds keep-alive sockets; without this the hook blocks for ~60s.
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(dir, { recursive: true, force: true });
  });

  it('captures every step of a passing run when the run is not filmed', async () => {
    const bundle = await runFlow(mixedFlow(origin), {
      cdpUrl: CDP_URL,
      cachePath: join(dir, 'default.json'),
      healer: null,
      historyPath: null,
      // `video: 'off'` and *no* `screenshots` option: the mode under test is
      // still the default one, just the default for an unfilmed run. Pinning
      // `screenshots: 'all'` here would let that default regress silently,
      // which is the whole reason this test does not say it.
      video: 'off',
    });

    assert.equal(bundle.status, 'passed', bundle.error ?? 'the fixture flow should pass');
    const missing = bundle.steps.filter((step) => step.screenshot === undefined);
    assert.deepEqual(
      missing.map((step) => step.action),
      [],
      'every step of a passing run must carry evidence, not just the failing ones',
    );
    // Including the two shapes that previously never captured while passing.
    for (const action of ['goto', 'expectHidden', 'expectUrl']) {
      const step = bundle.steps.find((s) => s.action === action);
      assert.ok(step?.screenshot, `${action} must leave evidence`);
    }
  });

  it('keeps the frame before a failure, which is the point of capturing all of them', async () => {
    const flow = mixedFlow(origin);
    flow.name = 'evidence around a failure';
    flow.steps.push({
      action: 'expectVisible',
      selector: '#nothing-here',
      intent: 'Fails on purpose.',
    });

    const bundle = await runFlow(flow, {
      cdpUrl: CDP_URL,
      cachePath: join(dir, 'failure.json'),
      healer: null,
      historyPath: null,
      fastTimeoutMs: 300,
      // The step *before* the failure only carries a still on an unfilmed
      // run; on a filmed one that frame lives in the recording instead.
      video: 'off',
    });

    // An unresolvable selector records as a dead end, not a failed assertion.
    assert.equal(bundle.status, 'dead-end');
    const failed = bundle.steps.at(-1);
    assert.equal(failed?.status, 'dead-end');
    assert.ok(failed?.screenshot, 'the failing step must have evidence');

    const before = bundle.steps.at(-2);
    assert.equal(before?.status, 'passed');
    assert.ok(
      before?.screenshot,
      'the step before the failure must have evidence too — that is where the ' +
        'wrong thing usually happened, and it cannot be recovered afterwards',
    );
  });

  it('honours the cheaper modes: on-failure captures only what broke', async () => {
    const flow = mixedFlow(origin);
    flow.name = 'on-failure only';
    flow.steps.push({ action: 'expectVisible', selector: '#nothing-here' });

    const bundle = await runFlow(flow, {
      cdpUrl: CDP_URL,
      cachePath: join(dir, 'on-failure.json'),
      screenshots: 'on-failure',
      healer: null,
      historyPath: null,
      fastTimeoutMs: 300,
    });

    const withEvidence = bundle.steps.filter((step) => step.screenshot !== undefined);
    assert.equal(withEvidence.length, 1, 'on-failure must capture exactly the failing step');
    assert.equal(withEvidence[0]?.status, 'dead-end');
  });

  it('captures nothing at all when evidence is off', async () => {
    const bundle = await runFlow(mixedFlow(origin), {
      cdpUrl: CDP_URL,
      cachePath: join(dir, 'off.json'),
      screenshots: 'off',
      healer: null,
      historyPath: null,
    });

    assert.ok(
      bundle.steps.every((step) => step.screenshot === undefined),
      'off must mean off',
    );
  });

  it('embeds each frame exactly once, however many places show it', async () => {
    const bundle = await runFlow(mixedFlow(origin), {
      cdpUrl: CDP_URL,
      cachePath: join(dir, 'report.json'),
      healer: null,
      historyPath: null,
      // A filmed run keeps stills for failures only, so a passing one would
      // have no frames to assemble a filmstrip from at all.
      video: 'off',
    });

    const path = await writeHtmlReport(bundle, join(dir, 'evidence.html'));
    const html = await readFile(path, 'utf8');

    const frames = bundle.steps.filter((step) => step.screenshot !== undefined).length;
    assert.ok(frames > 1);
    assert.match(html, /id="filmstrip"/, 'the report must offer the run as a filmstrip');
    assert.equal(
      html.split('data:image/jpeg;base64,').length - 1,
      frames,
      'the filmstrip is assembled in the browser from the images already present — ' +
        'rendering it server-side would double the size of the report',
    );
  });
});

/* ---- pure: the report's own handling of evidence -------------------------- */

function step(index: number, overrides: Partial<ProofStep> = {}): ProofStep {
  return {
    index,
    action: 'click',
    selector: '#a',
    resolvedSelector: '#a',
    resolution: 'fast',
    status: 'passed',
    startedAt: '2026-01-01T00:00:00.000Z',
    durationMs: 5,
    url: 'http://localhost/x',
    ...overrides,
  } as ProofStep;
}

function bundleWith(steps: ProofStep[]): ProofBundle {
  return {
    runId: 'evidence-run',
    name: 'evidence',
    status: steps.some((s) => s.status === 'failed') ? 'failed' : 'passed',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    durationMs: 1000,
    cdpUrl: 'http://localhost:9222',
    cachePath: 'cache.json',
    healerModel: null,
    steps,
    defects: [],
    summary: {
      totalSteps: steps.length,
      passed: steps.filter((s) => s.status === 'passed').length,
      failed: steps.filter((s) => s.status === 'failed').length,
      fastPath: steps.length,
      cacheHits: 0,
      jitHeals: 0,
      dialogsDismissed: 0,
      agentTakeovers: 0,
      healLatencyMs: 0,
      agentLatencyMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      defects: 0,
      visualChecks: 0,
      visualFailures: 0,
      frontend: { steps: steps.length, passed: steps.length, failed: 0, defects: 0 },
      backend: { steps: 0, passed: 0, failed: 0, defects: 0 },
    },
  } as unknown as ProofBundle;
}

// A one-pixel JPEG, so the accounting has something real to weigh.
const PIXEL =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

describe('the report and per-step evidence', () => {
  it('says how many steps carry evidence and what it weighs', () => {
    const html = renderReport(
      bundleWith([step(0, { screenshot: PIXEL }), step(1, { screenshot: PIXEL }), step(2)]),
    );
    assert.match(html, /steps with evidence/);
    assert.match(html, /2\/3/, 'the count must be honest about which steps have none');
    assert.match(html, /MB embedded/, 'the size of the evidence is the cost, so it is stated');
  });

  it('does not badge a screenshot, now that every step has one', () => {
    const html = renderReport(bundleWith([step(0, { screenshot: PIXEL })]));
    assert.doesNotMatch(
      html,
      /badge shot/,
      'a badge on every step marks the ordinary case and says nothing — same ' +
        'reason `fast` is unbadged',
    );
  });

  it('offers no filmstrip when there is nothing to compare', () => {
    const one = renderReport(bundleWith([step(0, { screenshot: PIXEL })]));
    assert.doesNotMatch(one, /id="filmstrip"/, 'a strip of one frame is not a strip');

    const none = renderReport(bundleWith([step(0), step(1)]));
    assert.doesNotMatch(none, /id="filmstrip"/);
  });

  it('marks the failing frame so the eye lands on it', () => {
    const html = renderReport(
      bundleWith([
        step(0, { screenshot: PIXEL }),
        step(1, { screenshot: PIXEL, status: 'failed', error: 'nope' }),
      ]),
    );
    assert.match(html, /id="filmstrip"/);
    // The class is applied in the browser from the step's own state, so what
    // the file must carry is the styling that makes it visible.
    assert.match(html, /\.filmstrip \.frame\.broke/);
  });
});
