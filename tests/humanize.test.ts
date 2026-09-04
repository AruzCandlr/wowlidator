/**
 * Performing like a person (`src/engine/humanize.ts`).
 *
 * Pure half, always: the pointer path planner and the key-delay planner
 * are arithmetic, and "off yields the single call the step always made" is
 * a contract about which Playwright method is called. Browser half, CDP:
 * that a humanised fill fires no keydown (the fact the ladder relies on),
 * reads back the value it typed, and that a humanised click lands on the
 * element the plain one would — measured against a real page, because a
 * mouse path and an `insertText` are facts about Chrome, not about a stub.
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

import { chromium } from 'playwright';

import {
  HUMAN_KEY_DELAY_MAX_MS,
  HUMAN_KEY_DELAY_MIN_MS,
  HUMAN_POINTER_STEPS,
  HUMAN_TYPING_BUDGET_MS,
  humanClick,
  humanFill,
  isPlainTextField,
  keyDelays,
  pointerPath,
  remainingTimeout,
} from '../src/engine/humanize.js';
import { runFlow } from '../src/engine/runner.js';

const CDP_URL = process.env['WOWLIDATOR_CDP_URL'] ?? 'http://localhost:9222';

async function cdpAvailable(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/json/version`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}
const browserReady = await cdpAvailable(CDP_URL);
const skipBrowser = browserReady ? false : `no CDP endpoint at ${CDP_URL} — start Chrome with --remote-debugging-port=9222`;

describe('the pointer path planner', () => {
  it('eases from start to target, advances monotonically, and ends exactly on the target', () => {
    const from = { x: 100, y: 500 };
    const to = { x: 700, y: 120 };
    const path = pointerPath(from, to);
    assert.equal(path.length, HUMAN_POINTER_STEPS);
    assert.deepEqual(path[path.length - 1], to, 'the last point is the target, exactly');
    // Progress along the line from `from` to `to` never goes backwards.
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy);
    let last = -1;
    for (const p of path) {
      const progress = ((p.x - from.x) * dx + (p.y - from.y) * dy) / len;
      assert.ok(progress > last, 'the pointer never doubles back');
      assert.ok(progress <= len + 1e-6, 'and never overshoots');
      last = progress;
    }
    // Eased: the first and last strides are shorter than the middle one.
    const stride = (i: number) => Math.hypot(path[i]!.x - path[i - 1]!.x, path[i]!.y - path[i - 1]!.y);
    const mid = Math.floor(path.length / 2);
    assert.ok(stride(1) < stride(mid) && stride(path.length - 1) < stride(mid), 'slow off the mark and slow to arrive');
  });

  it('bows away from the straight line, but stays near it', () => {
    const path = pointerPath({ x: 0, y: 0 }, { x: 400, y: 0 });
    const offLine = path.map((p) => Math.abs(p.y));
    assert.ok(Math.max(...offLine) > 0, 'a hand does not move on a rail');
    assert.ok(Math.max(...offLine) <= 24, 'and does not wander');
  });

  it('is a single arrival when there is nowhere to go', () => {
    assert.deepEqual(pointerPath({ x: 5, y: 5 }, { x: 5, y: 5 }), [{ x: 5, y: 5 }]);
    assert.deepEqual(pointerPath({ x: 0, y: 0 }, { x: 9, y: 9 }, 0), [{ x: 9, y: 9 }]);
  });
});

describe('the key-delay planner', () => {
  it('jitters every delay inside the bounds', () => {
    let seed = 7;
    const random = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
    const delays = keyDelays(20, random);
    assert.equal(delays.length, 20);
    for (const d of delays) assert.ok(d >= HUMAN_KEY_DELAY_MIN_MS && d <= HUMAN_KEY_DELAY_MAX_MS, `${d} ms is out of bounds`);
    assert.ok(new Set(delays).size > 1, 'jittered, not a metronome');
  });

  it('shrinks uniformly to the typing budget for a long value', () => {
    const delays = keyDelays(400, () => 1);
    assert.ok(delays.reduce((a, b) => a + b, 0) <= HUMAN_TYPING_BUDGET_MS + delays.length, 'a 400-character value is not 32 s of film');
    assert.ok(delays.every((d) => d <= HUMAN_KEY_DELAY_MAX_MS));
    assert.deepEqual(keyDelays(0), []);
  });

  it('leaves the action a floor of its window after the prelude', () => {
    assert.equal(remainingTimeout(2000, 300), 1700);
    assert.equal(remainingTimeout(2000, 2500), 100, 'never zero — Playwright reads 0 as "forever"');
  });
});

describe('what the film may type into', () => {
  const shape = (over: Record<string, unknown>) => ({ tag: 'INPUT', type: 'text', readOnly: false, disabled: false, drivesPopup: false, ...over });
  it('is a writable text-like input or textarea whose ARIA promises no popup', () => {
    assert.equal(isPlainTextField(shape({})), true);
    assert.equal(isPlainTextField(shape({ type: 'email' })), true);
    assert.equal(isPlainTextField(shape({ type: 'password' })), true);
    assert.equal(isPlainTextField(shape({ tag: 'TEXTAREA', type: '' })), true);
    assert.equal(isPlainTextField(shape({ type: 'date' })), false, 'a date is not typed');
    assert.equal(isPlainTextField(shape({ type: 'number' })), false);
    assert.equal(isPlainTextField(shape({ readOnly: true })), false, 'a read-only shell is the ladder\'s rung, not the film\'s');
    assert.equal(isPlainTextField(shape({ drivesPopup: true })), false, 'a combobox\'s keystrokes would open a list over the next control');
    assert.equal(isPlainTextField(shape({ tag: 'DIV', type: '' })), false, 'a label Playwright retargets is filled the ordinary way');
    assert.equal(isPlainTextField(null), false);
  });
});

describe('humanize off is the single call the step always made', () => {
  it('click calls locator.click once with the timeout, and reports no performance', async () => {
    const calls: unknown[] = [];
    const locator = { click: async (o: unknown) => { calls.push(['click', o]); } } as never;
    const page = { mouse: { move: async () => { calls.push(['move']); } } } as never;
    assert.equal(await humanClick(page, locator, 2000, { enabled: false }), undefined);
    assert.deepEqual(calls, [['click', { timeout: 2000 }]]);
  });

  it('fill calls locator.fill once with the value and the timeout', async () => {
    const calls: unknown[] = [];
    const locator = { fill: async (v: string, o: unknown) => { calls.push(['fill', v, o]); } } as never;
    assert.equal(await humanFill({} as never, locator, 'hello', 2000, { enabled: false }), undefined);
    assert.deepEqual(calls, [['fill', 'hello', { timeout: 2000 }]]);
  });
});

const FIXTURE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>humanize fixture</title>
<style>body{margin:0;font:16px system-ui;height:2000px}#go{position:absolute;left:600px;top:300px;padding:12px 20px}</style></head>
<body>
  <label for="email">Work email</label><input id="email" type="email">
  <label for="q">Search</label><input id="q" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false">
  <button id="go" type="button">Go</button>
  <p id="status">idle</p>
  <script>
    let keydowns = 0, moves = 0, inputs = 0;
    document.getElementById('email').addEventListener('keydown', () => { keydowns += 1; });
    document.getElementById('email').addEventListener('input', () => { inputs += 1; });
    document.getElementById('q').addEventListener('input', () => { inputs += 1000; });
    window.addEventListener('mousemove', () => { moves += 1; }, true);
    document.getElementById('go').addEventListener('click', () => { document.getElementById('status').textContent = 'went'; });
    window.__facts = () => ({ keydowns, moves, inputs, value: document.getElementById('email').value, q: document.getElementById('q').value });
  </script>
</body></html>`;

describe('performing on a real page (CDP)', { skip: skipBrowser }, () => {
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
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });

  it('a humanised fill fires no keydown, reads back the value, and a combobox is filled in one move', async () => {
    const browser = await chromium.connectOverCDP(CDP_URL);
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/`);
      const performed = await humanFill(page, page.locator('#email'), 'ada@example.test', 2000, { enabled: true });
      assert.ok(performed && performed.performedMs > 200, 'the value went in over time');
      const facts = await page.evaluate('window.__facts()') as { keydowns: number; inputs: number; value: string; moves: number; q: string };
      assert.equal(facts.value, 'ada@example.test');
      assert.equal(facts.keydowns, 0, 'fill fires no per-key keydown — humanised or not');
      assert.ok(facts.inputs >= 'ada@example.test'.length, 'the page saw the value arrive as input events');
      assert.ok(facts.moves > 3, 'the pointer travelled to the field');
      await humanFill(page, page.locator('#q'), 'abc', 2000, { enabled: true });
      const after = await page.evaluate('window.__facts()') as { inputs: number; q: string };
      assert.equal(after.q, 'abc');
      assert.equal(after.inputs - facts.inputs, 1000, 'a combobox got one fill, not three keystrokes');
    } finally {
      await context.close();
      await browser.close();
    }
  });

  it('a humanised click lands on the element the plain click would, and a missing one fails in one window', async () => {
    const browser = await chromium.connectOverCDP(CDP_URL);
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/`);
      const performed = await humanClick(page, page.locator('role=button[name="Go"]'), 2000, { enabled: true });
      assert.ok(performed && performed.performedMs >= 200);
      assert.equal(await page.locator('#status').innerText(), 'went');
      const started = Date.now();
      await assert.rejects(humanClick(page, page.locator('#nope'), 1000, { enabled: true }), /Timeout|waiting for/);
      assert.ok(Date.now() - started < 1800, `a missing element must fail inside the step's one window (${Date.now() - started} ms)`);
    } finally {
      await context.close();
      await browser.close();
    }
  });

  it('a filmed run performs; an unfilmed run does not pay for it', async () => {
    const flow = {
      name: 'humanize',
      steps: [
        { action: 'goto' as const, url: `${origin}/` },
        { action: 'fill' as const, selector: '#email', value: 'ada@example.test' },
        { action: 'click' as const, selector: 'role=button[name="Go"]' },
        { action: 'expectText' as const, selector: '#status', value: 'went' },
        { action: 'expectValue' as const, selector: '#email', value: 'ada@example.test' },
      ],
    };
    const filmed = await runFlow(flow, { cdpUrl: CDP_URL, historyPath: null, coverage: false });
    assert.equal(filmed.status, 'passed', filmed.error);
    assert.ok(typeof filmed.steps[1]?.detail?.['performedMs'] === 'number', 'a filmed fill records its performance');
    assert.ok(typeof filmed.steps[2]?.detail?.['performedMs'] === 'number', 'a filmed click records its performance');
    const plain = await runFlow(flow, { cdpUrl: CDP_URL, historyPath: null, coverage: false, video: 'off' });
    assert.equal(plain.status, 'passed', plain.error);
    assert.equal(plain.steps[1]?.detail?.['performedMs'], undefined, 'an unfilmed run performs nothing');
    assert.equal(plain.steps[2]?.detail?.['performedMs'], undefined);
    assert.equal(plain.steps.map((s) => s.resolution).join(), filmed.steps.map((s) => s.resolution).join(), 'the ladder resolves identically');
  });
});
