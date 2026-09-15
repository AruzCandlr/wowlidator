/**
 * Contract and integration tests for the mock-data engine (`src/data/`).
 *
 * `mock-data.ts`'s generators are pure. Only the `fillRetry`
 * regenerate-and-retry loop itself needs a real page — same `runFlow` +
 * fixture-HTTP-server pattern as `smoke.test.ts`.
 *
 * The `custom` kind and the `data` model role it escalated to were retired on
 * 2026-09-11 (unused across 1,429 authored flows), so the retry loop is now
 * exercised the way it actually runs: a deterministic kind whose FIRST value
 * the page rejects, cleared by the uniqueness suffix attempt 2 embeds. The
 * old test proved the same loop against a stub that no flow ever reached.
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

import { runFlow, type Flow } from '../src/engine/runner.js';
import { DATA_KINDS, generateValue } from '../src/data/mock-data.js';

// --- mock-data: pure functions, no browser -----------------------------------

describe('mock-data', () => {
  it('generates a plausible value for every kind', () => {
    for (const kind of DATA_KINDS) {
      const value = generateValue(kind);
      assert.equal(typeof value, 'string');
      assert.notEqual(value, '');
    }
  });

  it('embeds a uniqueness suffix from the second attempt onward', () => {
    const first = generateValue('email', 1);
    const second = generateValue('email', 2);
    assert.notEqual(first, second);
    assert.match(second, /^[^@]+\+[a-z0-9]+@/, 'suffix should land before the @, not after');
  });

  it('never repeats a username across attempts', () => {
    const a = generateValue('username', 1);
    const b = generateValue('username', 2);
    assert.notEqual(a, b);
  });

  it('has no kind that needs a model — every one of them generates for free', () => {
    // The retired `custom` kind was the only escalation path; a kind that is
    // not in this list cannot be written into a flow at all.
    assert.deepEqual([...DATA_KINDS], ['email', 'username', 'name', 'phone', 'text']);
    for (const kind of DATA_KINDS) {
      assert.doesNotThrow(() => generateValue(kind));
    }
  });
});

// --- Browser-backed integration ----------------------------------------------

const CDP_URL = process.env['WOWLIDATOR_CDP_URL'] ?? 'http://localhost:9222';

/**
 * The page rejects the FIRST value it is given and accepts anything after it
 * — which is what a real uniqueness constraint does, and what the retry loop
 * exists for. `?mode=always` never accepts; `?mode=never` accepts at once.
 */
const RETRY_FIXTURE_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>retry fixture</title></head>
  <body>
    <input id="field" aria-label="Value">
    <button id="submit-btn" type="button">Submit</button>
    <p id="conflict" style="display:none">Value already taken</p>
    <script>
      var mode = new URLSearchParams(location.search).get('mode') || 'first';
      var taken = null;
      document.getElementById('submit-btn').addEventListener('click', () => {
        var value = document.getElementById('field').value;
        if (taken === null) taken = value;
        var conflicts = mode === 'always' ? true : mode === 'never' ? false : value === taken;
        document.getElementById('conflict').style.display = conflicts ? 'block' : 'none';
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

describe('fillRetry (CDP)', { skip: skipBrowser }, () => {
  let server: Server;
  let origin: string;
  let dir: string;

  before(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(RETRY_FIXTURE_HTML);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    origin = `http://127.0.0.1:${address.port}`;
    dir = await mkdtemp(join(tmpdir(), 'wowlidator-retry-'));
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(dir, { recursive: true, force: true });
  });

  it('regenerates until the page stops rejecting the value', async () => {
    // A deterministic kind, the page rejecting whatever it is given first:
    // exactly the shape a real uniqueness constraint takes, and the only
    // shape a flow has ever been authored in.
    const flow: Flow = {
      name: 'data retry',
      baseUrl: origin,
      steps: [
        { action: 'goto', url: '/' },
        {
          action: 'fillRetry',
          selector: '#field',
          kind: 'email',
          failureSelector: '#conflict',
          submit: '#submit-btn',
          maxAttempts: 3,
        },
      ],
    };

    const bundle = await runFlow(flow, { cdpUrl: CDP_URL, cachePath: join(dir, 'retry.json') });

    assert.equal(bundle.status, 'passed', bundle.error ?? 'retry should eventually succeed');
    assert.equal(bundle.summary.dataRetries, 1);

    const step = bundle.steps.find((s) => s.action === 'fillRetry');
    assert.equal(step?.dataRetry?.attempts.length, 2);
    assert.equal(step?.dataRetry?.succeeded, true);
    assert.equal(step?.dataRetry?.attempts[0]?.succeeded, false);
    assert.equal(step?.dataRetry?.attempts[1]?.succeeded, true);
    // Nothing was spent: regeneration has no model behind it any more.
    assert.equal(step?.dataRetry?.model, undefined);
    assert.equal(step?.dataRetry?.inputTokens, undefined);
  });

  it('fails cleanly, with every attempt recorded, when the conflict never clears', async () => {
    const flow: Flow = {
      name: 'stuck retry',
      baseUrl: origin,
      steps: [
        { action: 'goto', url: '/?mode=always' },
        {
          action: 'fillRetry',
          selector: '#field',
          kind: 'email',
          failureSelector: '#conflict',
          submit: '#submit-btn',
          maxAttempts: 2,
        },
      ],
    };

    const bundle = await runFlow(flow, { cdpUrl: CDP_URL, cachePath: join(dir, 'stuck.json') });

    assert.equal(bundle.status, 'failed');
    const step = bundle.steps.find((s) => s.action === 'fillRetry');
    assert.equal(step?.dataRetry?.attempts.length, 2);
    assert.equal(step?.dataRetry?.succeeded, false);
  });

  it('succeeds on the first attempt when nothing conflicts', async () => {
    const flow: Flow = {
      name: 'no conflict',
      baseUrl: origin,
      steps: [
        { action: 'goto', url: '/?mode=never' },
        { action: 'fillRetry', selector: '#field', kind: 'email', failureSelector: '#conflict', submit: '#submit-btn' },
      ],
    };

    // Nothing to pass and nothing to spend: the loop has no model behind it.
    const bundle = await runFlow(flow, { cdpUrl: CDP_URL, cachePath: join(dir, 'no-conflict.json') });

    assert.equal(bundle.status, 'passed', bundle.error ?? 'a fresh faker email should never collide');
    const step = bundle.steps.find((s) => s.action === 'fillRetry');
    assert.equal(step?.dataRetry?.attempts.length, 1);
    assert.equal(step?.dataRetry?.model, undefined);
  });
});
