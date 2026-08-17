/**
 * The capture pilot: an agent at the controls while the page is captured.
 *
 * Unit tier: the goal's contract — steady, never change. CDP tier: a stub
 * agent dismisses the overlay covering the content, and the capture that
 * follows sees what a human would have seen — the accuracy the deterministic
 * settles cannot provide, proven end to end without a model key (same
 * scripted-stub reasoning as `modal.test.ts`).
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

import { CAPTURE_PILOT_GOAL, CAPTURE_PILOT_MAX_STEPS, pilotCapture } from '../src/context/capture-pilot.js';
import { captureAxTree } from '../src/healer/jit-healer.js';
import { withPage } from '../src/engine/runner.js';
import { WorkflowAgent, type AgentDecision } from '../src/orchestrator/workflow-agent.js';

describe('the capture pilot goal', () => {
  it('steadies the camera and forbids everything else', () => {
    assert.match(CAPTURE_PILOT_GOAL, /Do NOT navigate/);
    assert.match(CAPTURE_PILOT_GOAL, /do NOT submit any form/i);
    assert.match(CAPTURE_PILOT_GOAL, /do NOT change any data/i);
    // Disclosures belong to the probe; two features clicking the same menus
    // would double every risk the probe's design already paid for once.
    assert.match(CAPTURE_PILOT_GOAL, /do NOT open menus/i);
    assert.ok(CAPTURE_PILOT_MAX_STEPS <= 8, 'a pre-flight check, not an exploration');
  });
});

/** The content generation needs is behind a loading overlay a heuristic cannot judge. */
const VEILED_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>veiled fixture</title></head>
  <body>
    <div id="veil" style="position:fixed;inset:0;background:#fff;z-index:10">
      <p>Loading your workspace…</p>
      <button id="dismiss" type="button">Continue</button>
    </div>
    <main>
      <h1>Quarterly Numbers</h1>
      <button id="export" type="button">Export report</button>
    </main>
    <script>
      document.getElementById('dismiss').addEventListener('click', () => {
        document.getElementById('veil').remove();
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

const CDP_URL = process.env['WOWLIDATOR_CDP_URL'] ?? 'http://localhost:9222';
const browserReady = await cdpAvailable(CDP_URL);
const skipBrowser = browserReady
  ? false
  : `no CDP endpoint at ${CDP_URL} — start Chrome with --remote-debugging-port=9222 (npm run chrome)`;

describe('pilotCapture (CDP)', { skip: skipBrowser }, () => {
  let server: Server;
  let origin: string;

  before(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(VEILED_HTML);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it('lets the agent clear the veil, so the capture shows the real page', async () => {
    let turn = 0;
    const agent = new WorkflowAgent({
      model: {
        id: 'stub:pilot',
        async decide(): Promise<AgentDecision> {
          turn += 1;
          return turn === 1
            ? { action: 'click', selector: '#dismiss', value: '', url: '', reasoning: 'clear the loading veil' }
            : { action: 'finish', selector: '', value: '', url: '', reasoning: 'the content is visible' };
        },
      },
      maxSteps: CAPTURE_PILOT_MAX_STEPS,
    });

    const { record, tree } = await withPage(CDP_URL, async (page) => {
      await page.goto(origin, { waitUntil: 'domcontentloaded' });
      const piloted = await pilotCapture(page, agent);
      return { record: piloted, tree: await captureAxTree(page, 60) };
    });

    assert.equal(record?.success, true);
    assert.match(tree, /Export report/, 'the capture must see what the veil was hiding');
    assert.doesNotMatch(tree, /Loading your workspace/);
  });

  it('never lets a broken pilot break the capture', async () => {
    const agent = new WorkflowAgent({
      model: {
        id: 'stub:broken',
        async decide(): Promise<AgentDecision> {
          throw new Error('model outage');
        },
      },
      maxSteps: 2,
    });

    const tree = await withPage(CDP_URL, async (page) => {
      await page.goto(origin, { waitUntil: 'domcontentloaded' });
      const record = await pilotCapture(page, agent);
      // run() reports failure in the record rather than throwing.
      assert.equal(record?.success, false);
      return captureAxTree(page, 60);
    });

    // Unpiloted capture — the veil is still there, but the capture happened.
    assert.match(tree, /Loading your workspace/);
  });
});
