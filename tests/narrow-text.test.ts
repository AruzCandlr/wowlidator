/**
 * The narrow rung: an ambiguous `text=` selector must not fail an assertion
 * about text that is genuinely on the page.
 *
 * The real-world shape (PB_04_01, run against a live app): the row under test
 * says exactly "4 days", and the same page also shows "≤ 14 days · near due",
 * "Overdue 54 days" and "Overdue 34 days". Playwright's unquoted `text=` is a
 * substring match, so `text=4 days` resolved all four, strict mode refused to
 * pick one, and a correct application was reported as a failed step — with the
 * healer unable to help, because it would propose the same text and reject its
 * own multi-match answer at the verify step.
 *
 * Unit tier covers the pure narrowing helper; the CDP tier proves the ladder
 * rung end to end, healer off, same reasoning as `selector-case.test.ts`.
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

import { exactTextSelector, isTextSelector } from '../src/engine/selector.js';
import { runFlow, type Flow } from '../src/engine/runner.js';

const CDP_URL = process.env['WOWLIDATOR_CDP_URL'] ?? 'http://localhost:9222';

describe('exactTextSelector', () => {
  it('quotes an unquoted text selector into its exact form', () => {
    assert.equal(exactTextSelector('text=4 days'), 'text="4 days"');
    assert.equal(exactTextSelector('  text=Due soon'), '  text="Due soon"');
  });

  it('escapes quotes and backslashes in the text', () => {
    assert.equal(exactTextSelector('text=say "hi"'), 'text="say \\"hi\\""');
    assert.equal(exactTextSelector('text=a\\b'), 'text="a\\\\b"');
  });

  it('returns null when there is nothing to narrow', () => {
    // Already exact, a regex, or not a text selector at all.
    assert.equal(exactTextSelector('text="4 days"'), null);
    assert.equal(exactTextSelector("text='4 days'"), null);
    assert.equal(exactTextSelector('text=/4 days/'), null);
    assert.equal(exactTextSelector('role=button[name="4 days"]'), null);
    assert.equal(exactTextSelector('.row .days'), null);
  });

  it('isTextSelector only claims text-engine selectors', () => {
    assert.equal(isTextSelector('text=4 days'), true);
    assert.equal(isTextSelector('role=button[name="x"]'), false);
    assert.equal(isTextSelector('#days'), false);
  });
});

/**
 * The PB_04_01 page, reduced. `text=4 days` substring-matches four elements;
 * exactly one says "4 days". "7 days" is exact-ambiguous on top of that: two
 * elements carry the exact text, the first of them hidden, so only the
 * presence half of the rung can resolve it. "99 days" appears nowhere.
 */
const TIER_FIXTURE_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>urgency tier fixture</title></head>
  <body>
    <button type="button">URGENT 6 ≤ 14 days · near due</button>
    <span>Overdue 54 days</span>
    <span id="row-emp058">4 days</span>
    <span>Overdue 34 days</span>

    <span style="display:none">7 days</span>
    <span id="row-emp070">7 days</span>
    <span>Overdue 57 days</span>
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
  : `no CDP endpoint at ${CDP_URL} — start Chrome with --remote-debugging-port`;

describe('narrow-text resolution (CDP)', { skip: skipBrowser }, () => {
  let server: Server;
  let origin: string;
  let dir: string;

  before(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(TIER_FIXTURE_HTML);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    origin = `http://127.0.0.1:${address.port}`;
    dir = await mkdtemp(join(tmpdir(), 'wowlidator-narrow-'));
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(dir, { recursive: true, force: true });
  });

  it('passes an assertion whose text is unique once matched exactly', async () => {
    const flow: Flow = {
      name: 'substring-ambiguous text',
      baseUrl: origin,
      steps: [
        { action: 'goto', url: '/' },
        // Exactly what the generated PB_04_01 flow contained.
        { action: 'expectText', selector: 'text=4 days', value: '4 days' },
      ],
    };
    const bundle = await runFlow(flow, {
      cdpUrl: CDP_URL,
      cachePath: join(dir, 'narrow.json'),
      // No healer: the rung has to be free and deterministic.
      healer: null,
    });

    assert.equal(bundle.status, 'passed', bundle.error ?? 'narrow rung should resolve the text');
    const step = bundle.steps.find((s) => s.action === 'expectText');
    assert.equal(step?.resolution, 'narrow');
    assert.equal(step?.resolvedSelector, 'text="4 days"');
    assert.equal(bundle.summary.jitHeals, 0);
  });

  it('satisfies a presence assertion with the first visible of several exact matches', async () => {
    const flow: Flow = {
      name: 'exact-ambiguous text',
      baseUrl: origin,
      steps: [
        { action: 'goto', url: '/' },
        { action: 'expectText', selector: 'text=7 days', value: '7 days' },
      ],
    };
    const bundle = await runFlow(flow, {
      cdpUrl: CDP_URL,
      cachePath: join(dir, 'narrow-any.json'),
      healer: null,
    });

    assert.equal(bundle.status, 'passed', bundle.error ?? 'presence should accept any exact match');
    const step = bundle.steps.find((s) => s.action === 'expectText');
    assert.equal(step?.resolution, 'narrow');
    // The record is a real selector, replayable as written.
    assert.equal(step?.resolvedSelector, 'text="7 days" >> visible=true >> nth=0');
  });

  it('still fails text that is genuinely absent — narrowing needs a strict-mode violation', async () => {
    const flow: Flow = {
      name: 'absent text',
      baseUrl: origin,
      steps: [
        { action: 'goto', url: '/' },
        { action: 'expectText', selector: 'text=99 days', value: '99 days' },
      ],
    };
    const bundle = await runFlow(flow, {
      cdpUrl: CDP_URL,
      cachePath: join(dir, 'narrow-absent.json'),
      healer: null,
    });

    // A selector no rung could resolve is a dead end, not a plain failure —
    // the distinction the ladder already draws. The point here is only that
    // narrowing did not turn absence into a pass.
    assert.equal(bundle.status, 'dead-end');
    const step = bundle.steps.find((s) => s.action === 'expectText');
    assert.equal(step?.resolution, null);
  });
});
