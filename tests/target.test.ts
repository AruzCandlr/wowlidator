/**
 * The step TARGET (`src/engine/target.ts`, `ProofStep.target`) and the red
 * rectangle drawn around it in the step's screenshot.
 *
 * Two tiers. The pure half runs always: what `describeTarget` says, how the
 * target reaches the CLI line, the per-case report, the catalog report and
 * the workbook. The browser half is CDP-gated, because what a step's target
 * IS — the role Chrome exposes, the box the element occupies — and whether an
 * overlay appended to a page for the shutter is really gone afterwards are
 * facts about a real browser that no fixture can assert.
 *
 *   npm test                                 # unit + browser (if Chrome is up)
 *   WOWLIDATOR_CDP_URL=http://localhost:9222 npm test
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

import {
  describeTarget,
  formatStepLine,
  type ProofBundle,
  type ProofStep,
  type StepTarget,
} from '../src/engine/proof-bundle.js';
import { HIGHLIGHT_ATTR } from '../src/engine/target.js';
import { runFlow, type Flow } from '../src/engine/runner.js';
import { renderReport } from '../src/reporter/html-reporter.js';
import { renderCatalogReport, type CatalogReportCase } from '../src/reporter/catalog-report.js';

const CDP_URL = process.env['WOWLIDATOR_CDP_URL'] ?? 'http://localhost:9222';

const TARGET: StepTarget = {
  selector: 'role=button[name="Sign in"]',
  tag: 'button',
  role: 'button',
  name: 'Sign in',
  box: { x: 30, y: 200, width: 120, height: 40 },
};

function step(over: Partial<ProofStep>): ProofStep {
  return {
    index: 0, action: 'click', intent: undefined, selector: 'role=button[name="Sign in"]',
    resolvedSelector: 'role=button[name="Sign in"]', resolution: 'fast', status: 'passed',
    startedAt: '2026-09-02T04:00:00.000Z', durationMs: 350, url: 'http://localhost:3000/en/login',
    ...over,
  } as ProofStep;
}

function bundle(steps: ProofStep[]): ProofBundle {
  return {
    runId: 'r1', name: 'target fixture', status: 'passed',
    startedAt: '2026-09-02T04:00:00.000Z', finishedAt: '2026-09-02T04:01:00.000Z',
    durationMs: 60_000, cdpUrl: null, cachePath: null, healerModel: null,
    summary: {
      totalSteps: steps.length, passed: steps.length, failed: 0, fastPath: steps.length, cacheHits: 0, jitHeals: 0,
      agentTakeovers: 0, healLatencyMs: 0, agentLatencyMs: 0, inputTokens: 0, outputTokens: 0, defects: 0,
      visualChecks: 0, visualFailures: 0, dialogsDismissed: 0, networkFailures: 0, backendBlocked: 0,
      apiRequests: 0, apiFailures: 0,
      frontend: { steps: steps.length, passed: steps.length, failed: 0, defects: 0 },
      backend: { steps: 0, passed: 0, failed: 0, defects: 0 },
    } as ProofBundle['summary'],
    defects: [], steps,
  } as ProofBundle;
}

describe('describing a target', () => {
  it('names the role, the accessible name and the box in one line, the same everywhere', () => {
    assert.equal(describeTarget(TARGET), 'button "Sign in" · 120×40 at (30,200)');
  });

  it('falls back from role to tag, from name to text, and omits a box it does not have', () => {
    assert.equal(describeTarget({ selector: 'div.card', tag: 'div', text: 'Total plans 75' }), 'div "Total plans 75"');
    assert.equal(describeTarget({ selector: '#x', tag: 'span' }), 'span');
    assert.equal(describeTarget(undefined), null);
  });

  it('reaches the CLI step line as its own row', () => {
    const line = formatStepLine(step({ target: TARGET }));
    assert.match(line, /\n {6}target: button "Sign in" · 120×40 at \(30,200\)/);
    assert.ok(!formatStepLine(step({})).includes('target:'));
  });

  it('survives a round trip through JSON as plain data', () => {
    const back = JSON.parse(JSON.stringify(step({ target: TARGET }))) as ProofStep;
    assert.deepEqual(back.target, TARGET);
  });
});

describe('the target in the reports', () => {
  it('the per-case report shows it beside the selector and in the step facts, and says the still outlines it', () => {
    const html = renderReport(bundle([step({ target: TARGET, screenshot: 'QUJD' })]));
    assert.match(html, /→ button &quot;Sign in&quot; · 120×40 at \(30,200\)/);
    assert.match(html, /<dt>target<\/dt><dd>button &quot;Sign in&quot; · 120×40 at \(30,200\) <span class="muted">\(outlined in red in the screenshot\)<\/span>/);
    // No target, no row — and no claim about an outline.
    const bare = renderReport(bundle([step({ screenshot: 'QUJD' })]));
    assert.ok(!bare.includes('<dt>target</dt>'));
    assert.ok(!bare.includes('outlined in red'));
  });

  it('the catalog report carries it as a step detail row', () => {
    const c: CatalogReportCase = {
      id: 'PL_01_01', name: 'PL_01_01 sign in', scenario: 'PL_01', verdict: 'passed', status: 'passed', reason: null,
      bundle: bundle([step({ target: TARGET })]), history: [],
    };
    const html = renderCatalogReport({ title: 't', runKey: null, generatedAt: null, cases: [c] });
    assert.match(html, /<div class="kv"><span>target<\/span><span>button &quot;Sign in&quot; · 120×40 at \(30,200\)<\/span><\/div>/);
  });

  it('application text in a target cannot become markup', () => {
    const html = renderReport(bundle([step({ target: { ...TARGET, name: '<img src=x onerror=alert(1)>' } })]));
    assert.ok(!html.includes('<img src=x'));
  });
});

/* ------------------------------------------------------ the real browser */

const FIXTURE_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>target fixture</title></head>
  <body style="margin:0">
    <div style="height:900px">tall spacer so the target sits below the first viewport</div>
    <button id="go" type="button" style="display:block;width:160px;height:48px">Proceed</button>
    <p id="status">idle</p>
    <label for="who">Who</label><input id="who">
    <script>
      document.getElementById('go').addEventListener('click', () => {
        document.getElementById('status').textContent = 'clicked';
      });
    </script>
  </body>
</html>`;

async function cdpAvailable(url: string): Promise<boolean> {
  try {
    const response = await fetch(new URL('/json/version', url), { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

const browserReady = await cdpAvailable(CDP_URL);
const skipBrowser = browserReady
  ? false
  : `no CDP endpoint at ${CDP_URL} — start Chrome with --remote-debugging-port=9222 (npm run chrome)`;

describe('the target and its red rectangle (CDP)', { skip: skipBrowser }, () => {
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
    dir = await mkdtemp(join(tmpdir(), 'wowlidator-target-'));
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(dir, { recursive: true, force: true });
  });

  const flow = (name: string): Flow => ({
    name,
    steps: [
      { action: 'goto', url: `${origin}/` },
      { action: 'click', selector: 'role=button[name="Proceed"]', intent: 'press Proceed' },
      { action: 'fill', selector: 'role=textbox[name="Who"]', value: 'Ada' },
      { action: 'expectText', selector: '#status', value: 'clicked' },
      { action: 'expectHidden', selector: '#nope' },
    ],
  });

  const run = (name: string, highlightTarget: boolean): Promise<ProofBundle> =>
    runFlow(flow(name), {
      cdpUrl: CDP_URL,
      cachePath: join(dir, `${name}.json`),
      healer: null,
      historyPath: null,
      video: 'off',
      screenshots: 'all',
      highlightTarget,
    });

  it('records what each step acted on — role, name and a real box — and nothing for steps with no element', async () => {
    const bundle = await run('target-shape', true);
    assert.equal(bundle.status, 'passed', bundle.error ?? 'the fixture flow should pass');
    const click = bundle.steps.find((s) => s.action === 'click')!;
    assert.equal(click.target?.role, 'button');
    assert.equal(click.target?.name, 'Proceed');
    assert.equal(click.target?.tag, 'button');
    assert.equal(click.target?.selector, 'role=button[name="Proceed"]');
    assert.ok(click.target?.box && click.target.box.width > 100 && click.target.box.height > 30, 'a real box');
    // Document coordinates, not viewport: the button sits below a 900px spacer.
    assert.ok(click.target!.box!.y >= 900, `y=${click.target!.box!.y} should be below the spacer`);
    const fill = bundle.steps.find((s) => s.action === 'fill')!;
    assert.equal(fill.target?.role, 'textbox');
    assert.equal(fill.target?.name, 'Who', 'the <label for> names the field');
    const text = bundle.steps.find((s) => s.action === 'expectText')!;
    assert.equal(text.target?.tag, 'p');
    assert.equal(text.target?.name, 'clicked');
    for (const action of ['goto', 'expectHidden']) {
      assert.equal(bundle.steps.find((s) => s.action === action)!.target, undefined, `${action} has no element to target`);
    }
  });

  it('leaves no highlight box in the page after the step — the next step sees the page as it was', async () => {
    // Asserted from INSIDE the run, on the runner's own page: every step
    // before this one took a still with the rectangle drawn, and the
    // rectangle must be gone by the time the next step looks.
    const clean: Flow = {
      name: 'target-clean',
      steps: [
        { action: 'goto', url: `${origin}/` },
        { action: 'click', selector: 'role=button[name="Proceed"]' },
        { action: 'expectCount', selector: `[${HIGHLIGHT_ATTR}]`, count: 0 },
        { action: 'expectHidden', selector: `[${HIGHLIGHT_ATTR}]` },
      ],
    };
    const bundle = await runFlow(clean, {
      cdpUrl: CDP_URL, cachePath: join(dir, 'clean.json'), healer: null, historyPath: null, video: 'off', screenshots: 'all',
    });
    assert.equal(bundle.status, 'passed', bundle.error ?? 'no highlight box may survive its screenshot');
    assert.ok(bundle.steps.find((s) => s.action === 'click')?.screenshot, 'the click was photographed (with the box)');
  });

  it('draws the rectangle only when asked: the marked still differs from the unmarked one', async () => {
    const marked = await run('target-marked', true);
    const plain = await run('target-plain', false);
    const a = marked.steps.find((s) => s.action === 'click')!;
    const b = plain.steps.find((s) => s.action === 'click')!;
    assert.ok(a.screenshot && b.screenshot, 'both runs capture the step');
    assert.notEqual(a.screenshot, b.screenshot, 'the red rectangle must be visible in the marked still');
    // The target itself is recorded either way — the option only marks the still.
    assert.equal(b.target?.name, 'Proceed');
  });

  it('marks a failed assertion that found its element, and records no target for one that found nothing', async () => {
    const failing: Flow = {
      name: 'target-failure',
      steps: [
        { action: 'goto', url: `${origin}/` },
        { action: 'expectText', selector: '#status', value: 'never' },
      ],
    };
    const bundle = await runFlow(failing, {
      cdpUrl: CDP_URL, cachePath: join(dir, 'f.json'), healer: null, historyPath: null, video: 'off', screenshots: 'all',
      fastTimeoutMs: 300, healedTimeoutMs: 300,
    });
    const s = bundle.steps.find((st) => st.action === 'expectText')!;
    assert.notEqual(s.status, 'passed');
    assert.equal(s.target?.tag, 'p', 'the element was there — the content disagreed');
    const missing: Flow = {
      name: 'target-missing',
      steps: [
        { action: 'goto', url: `${origin}/` },
        { action: 'click', selector: 'role=button[name="Nowhere"]' },
      ],
    };
    const gone = await runFlow(missing, {
      cdpUrl: CDP_URL, cachePath: join(dir, 'g.json'), healer: null, historyPath: null, video: 'off', screenshots: 'all',
      fastTimeoutMs: 300, healedTimeoutMs: 300,
    });
    assert.equal(gone.steps.find((st) => st.action === 'click')!.target, undefined);
  });
});
