/**
 * Integration tests for modal/dialog detection and interaction
 * (`src/engine/modal.ts`) — both the explicit `expectModal`/`closeModal`
 * actions and the automatic blocking-dialog recovery rung in `#resolve`.
 *
 * Entirely browser-tier: detection is Locator-based (`page.locator(...)`),
 * so there's no pure function to unit test in isolation — same reasoning as
 * `JitHealer`'s verify step not being separately unit-tested.
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

const CDP_URL = process.env['WOWLIDATOR_CDP_URL'] ?? 'http://localhost:9222';

const DIALOG_FIXTURE_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>dialog fixture</title></head>
  <body>
    <button id="open-modal" type="button">Open</button>
    <div id="confirm-dialog" role="dialog" aria-label="Confirm" style="display:none;">
      <p>Are you sure?</p>
      <button type="button" id="confirm-yes">Yes</button>
      <button type="button" aria-label="Close" id="dialog-close">×</button>
    </div>

    <button id="open-tricky" type="button">Open tricky</button>
    <div id="tricky-dialog" role="dialog" aria-label="Tricky" style="display:none;">
      <p>No recognizable dismiss control here.</p>
      <button type="button" id="proceed-btn">Proceed</button>
    </div>

    <p id="status">idle</p>
    <script>
      document.getElementById('open-modal').addEventListener('click', () => {
        document.getElementById('confirm-dialog').style.display = 'block';
      });
      document.getElementById('dialog-close').addEventListener('click', () => {
        document.getElementById('confirm-dialog').style.display = 'none';
        document.getElementById('status').textContent = 'closed';
      });
      document.getElementById('confirm-yes').addEventListener('click', () => {
        document.getElementById('confirm-dialog').style.display = 'none';
        document.getElementById('status').textContent = 'confirmed';
      });
      document.getElementById('open-tricky').addEventListener('click', () => {
        document.getElementById('tricky-dialog').style.display = 'block';
      });
    </script>
  </body>
</html>`;

const PROMO_FIXTURE_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>promo fixture</title></head>
  <body>
    <!-- Intrusive, unrequested — open the moment the page loads, the case
         automatic recovery exists for. Covers the whole viewport so it
         genuinely intercepts pointer events on whatever is underneath. -->
    <div role="dialog" aria-label="Special offer"
         style="position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;">
      <div style="background:#fff;padding:20px;">
        <p>Get 10% off!</p>
        <button type="button" id="promo-close">Close</button>
      </div>
    </div>
    <button id="real-target" type="button">Real target</button>
    <p id="status">idle</p>
    <script>
      document.getElementById('promo-close').addEventListener('click', (e) => {
        e.currentTarget.closest('[role="dialog"]').remove();
      });
      document.getElementById('real-target').addEventListener('click', () => {
        document.getElementById('status').textContent = 'clicked';
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

describe('expectModal / closeModal (CDP)', { skip: skipBrowser }, () => {
  let server: Server;
  let origin: string;
  let dir: string;

  before(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(DIALOG_FIXTURE_HTML);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    origin = `http://127.0.0.1:${address.port}`;
    dir = await mkdtemp(join(tmpdir(), 'wowlidator-modal-'));
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(dir, { recursive: true, force: true });
  });

  it('asserts a dialog is open and checks it mentions a name', async () => {
    const flow: Flow = {
      name: 'expect modal',
      baseUrl: origin,
      steps: [
        { action: 'goto', url: '/' },
        { action: 'click', selector: '#open-modal' },
        { action: 'expectModal', name: 'Confirm' },
      ],
    };
    const bundle = await runFlow(flow, { cdpUrl: CDP_URL, cachePath: join(dir, 'expect.json') });
    assert.equal(bundle.status, 'passed', bundle.error ?? 'expectModal should find the open dialog');
  });

  it('fails cleanly when no dialog is open', async () => {
    const flow: Flow = {
      name: 'expect modal absent',
      baseUrl: origin,
      steps: [
        { action: 'goto', url: '/' },
        { action: 'expectModal' },
      ],
    };
    const bundle = await runFlow(flow, {
      cdpUrl: CDP_URL,
      cachePath: join(dir, 'expect-absent.json'),
      healedTimeoutMs: 500,
    });
    assert.equal(bundle.status, 'failed');
    const step = bundle.steps.find((s) => s.action === 'expectModal');
    assert.match(step?.error ?? '', /no dialog or modal is currently visible/);
  });

  it('rejects an open dialog that does not mention the expected name', async () => {
    const flow: Flow = {
      name: 'expect modal wrong name',
      baseUrl: origin,
      steps: [
        { action: 'goto', url: '/' },
        { action: 'click', selector: '#open-modal' },
        { action: 'expectModal', name: 'Checkout' },
      ],
    };
    const bundle = await runFlow(flow, {
      cdpUrl: CDP_URL,
      cachePath: join(dir, 'expect-wrong-name.json'),
      healedTimeoutMs: 500,
    });
    assert.equal(bundle.status, 'failed');
    const step = bundle.steps.find((s) => s.action === 'expectModal');
    assert.match(step?.error ?? '', /does not mention "Checkout"/);
  });

  it('closes a dialog via an auto-matched dismiss button', async () => {
    const flow: Flow = {
      name: 'close modal auto',
      baseUrl: origin,
      steps: [
        { action: 'goto', url: '/' },
        { action: 'click', selector: '#open-modal' },
        { action: 'closeModal' },
        { action: 'expectText', selector: '#status', value: 'closed' },
      ],
    };
    const bundle = await runFlow(flow, { cdpUrl: CDP_URL, cachePath: join(dir, 'close-auto.json') });
    assert.equal(bundle.status, 'passed', bundle.error ?? 'closeModal should find the × close button');
  });

  it('closes a dialog via an explicit button selector', async () => {
    const flow: Flow = {
      name: 'close modal explicit',
      baseUrl: origin,
      steps: [
        { action: 'goto', url: '/' },
        { action: 'click', selector: '#open-modal' },
        { action: 'closeModal', button: '#confirm-yes' },
        { action: 'expectText', selector: '#status', value: 'confirmed' },
      ],
    };
    const bundle = await runFlow(flow, { cdpUrl: CDP_URL, cachePath: join(dir, 'close-explicit.json') });
    assert.equal(bundle.status, 'passed', bundle.error ?? 'closeModal should use the explicit button');
  });

  it('fails cleanly when no dismiss button can be matched', async () => {
    const flow: Flow = {
      name: 'close modal no match',
      baseUrl: origin,
      steps: [
        { action: 'goto', url: '/' },
        { action: 'click', selector: '#open-tricky' },
        { action: 'closeModal' },
      ],
    };
    const bundle = await runFlow(flow, {
      cdpUrl: CDP_URL,
      cachePath: join(dir, 'close-no-match.json'),
      healedTimeoutMs: 500,
    });
    // closeModal is not an assertion, so its failure is an `error` in the run
    // taxonomy — the harness could not do what the step asked.
    assert.equal(bundle.status, 'error');
    const step = bundle.steps.find((s) => s.action === 'closeModal');
    assert.match(step?.error ?? '', /no dismiss button found/);
  });
});

describe('automatic blocking-dialog recovery (CDP)', { skip: skipBrowser }, () => {
  let server: Server;
  let origin: string;
  let dir: string;

  before(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PROMO_FIXTURE_HTML);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    origin = `http://127.0.0.1:${address.port}`;
    dir = await mkdtemp(join(tmpdir(), 'wowlidator-modal-recover-'));
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(dir, { recursive: true, force: true });
  });

  it('dismisses an unrequested modal blocking a click, then retries and succeeds', async () => {
    const flow: Flow = {
      name: 'promo blocks target',
      baseUrl: origin,
      steps: [
        { action: 'goto', url: '/' },
        { action: 'click', selector: '#real-target' },
        { action: 'expectText', selector: '#status', value: 'clicked' },
      ],
    };

    const bundle = await runFlow(flow, {
      cdpUrl: CDP_URL,
      cachePath: join(dir, 'promo.json'),
      fastTimeoutMs: 500,
    });

    assert.equal(bundle.status, 'passed', bundle.error ?? 'should recover past the blocking promo modal');
    assert.equal(bundle.summary.dialogsDismissed, 1);

    const step = bundle.steps.find((s) => s.action === 'click');
    assert.equal(step?.resolution, 'dialog');
    assert.equal(step?.dialog?.name, 'Special offer');
    assert.equal(step?.dialog?.button, 'Close');

    const defect = bundle.defects.find((d) => d.category === 'usability');
    assert.ok(defect, 'an unexpected-dialog defect should be recorded');
    assert.equal(defect?.severity, 'medium');
  });
});
