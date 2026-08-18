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

import { exactTextSelector, isTextSelector, relaxTextSelector } from '../src/engine/selector.js';
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

describe('relaxTextSelector', () => {
  it('unquotes an exact text selector into its substring form', () => {
    // DB_07_01, live: the flow asserted `text="75,000"` and the page renders
    // `฿75,000.00`, so the exact form matched nothing while the number was on
    // screen — and two `high` defects were filed at a working application.
    assert.equal(relaxTextSelector('text="75,000"'), 'text=75,000');
    assert.equal(relaxTextSelector("  text='Awaiting manager'"), '  text=Awaiting manager');
  });

  it('unescapes what the quoted form escaped', () => {
    assert.equal(relaxTextSelector('text="say \\"hi\\""'), 'text=say "hi"');
  });

  it('returns null when there is nothing to relax', () => {
    // Already a substring match, a regex, or not a text selector at all.
    assert.equal(relaxTextSelector('text=75,000'), null);
    assert.equal(relaxTextSelector('text=/75,000/'), null);
    assert.equal(relaxTextSelector('role=button[name="75,000"]'), null);
    assert.equal(relaxTextSelector('.amount'), null);
    assert.equal(relaxTextSelector('text=""'), null);
  });

  it('refuses text that would be re-parsed as something else unquoted', () => {
    // `>>` is Playwright's chaining operator: unquoted, `text=a >> b` stops
    // being one selector and becomes two. A leading quote or slash would be
    // re-read as a quoted string or a regex.
    assert.equal(relaxTextSelector('text="a >> b"'), null);
    assert.equal(relaxTextSelector('text="/rules/"'), null);
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

/**
 * DB_07_01's page, reduced to the one fact that mattered: the amount is
 * rendered with a currency prefix and two decimals, so the flow's
 * `text="75,000"` matches the WHOLE text of nothing at all.
 */
const AMOUNT_FIXTURE_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>entitlement fixture</title></head>
  <body>
    <table><tbody>
      <tr><td>RULE-TRV-001</td><td id="amt">\u0e3f75,000.00</td></tr>
      <tr><td>RULE-FUEL-002</td><td>\u0e3f12,000.00</td></tr>
    </tbody></table>
    <button type="button">\u0e3f75,000.00</button>
  </body>
</html>`;

/**
 * DB_06_01's page, reduced: the save was refused and the application said so
 * in a live region. The step still fails — the row really is not there — but
 * the report has to lead with what the page said, not "could not resolve".
 */
const TOAST_FIXTURE_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>refused save fixture</title></head>
  <body>
    <div role="alert">Entitlement amount is required</div>
    <div role="status">   </div>
    <table><tbody><tr><td>RULE-TRV-001</td></tr></tbody></table>
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
    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      if (req.url?.startsWith('/amount')) return void res.end(AMOUNT_FIXTURE_HTML);
      if (req.url?.startsWith('/toast')) return void res.end(TOAST_FIXTURE_HTML);
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
  it('resolves a presence assertion the page renders with formatting around it', async () => {
    // The false `high` defect this rung exists to remove: the claim ("the
    // entitlement shows 75,000") is TRUE and was reported as an application
    // failure because the selector demanded the element's whole text.
    const flow: Flow = {
      name: 'over-exact text',
      baseUrl: origin,
      steps: [
        { action: 'goto', url: '/amount' },
        { action: 'expectText', selector: 'text="75,000"', value: '75,000' },
      ],
    };
    const bundle = await runFlow(flow, {
      cdpUrl: CDP_URL,
      cachePath: join(dir, 'relax.json'),
      healer: null,
    });

    assert.equal(bundle.status, 'passed', bundle.error ?? 'relax rung should resolve the text');
    const step = bundle.steps.find((s) => s.action === 'expectText');
    assert.equal(step?.resolution, 'narrow');
    assert.equal(bundle.summary.jitHeals, 0);

    // A rescue, not an absolution: the flow still quoted a rendering the page
    // does not use, and the finding names what it actually shows.
    const finding = bundle.defects.find((d) => /more exact than the page/.test(d.title));
    assert.ok(finding, 'the over-exact selector must be reported');
    assert.equal(finding?.severity, 'low');
    assert.match(finding?.detail ?? '', /\u0e3f75,000\.00/);
  });

  it('never relaxes for an action that does something', async () => {
    // Acting on a loosened match changes what the test exercises — the same
    // rule rung 1.3 states for its own any-of half. The click must fail.
    const flow: Flow = {
      name: 'over-exact click',
      baseUrl: origin,
      steps: [
        { action: 'goto', url: '/amount' },
        { action: 'click', selector: 'text="75,000"' },
      ],
    };
    const bundle = await runFlow(flow, {
      cdpUrl: CDP_URL,
      cachePath: join(dir, 'relax-click.json'),
      healer: null,
    });

    assert.notEqual(bundle.status, 'passed');
    const step = bundle.steps.find((s) => s.action === 'click');
    assert.equal(step?.resolution, null);
    assert.ok(
      !bundle.defects.some((d) => /more exact than the page/.test(d.title)),
      'a click must not be rescued by relaxing',
    );
  });

  it("carries what the page told the user into the failure's context", async () => {
    // DB_06_01: the save was refused for a missing required field, the row
    // never appeared, and the report said "could not resolve" about an
    // application that was working correctly and saying so on screen.
    const flow: Flow = {
      name: 'refused save',
      baseUrl: origin,
      steps: [
        { action: 'goto', url: '/toast' },
        { action: 'expectVisible', selector: 'text="QA-DB-RULE GRP"' },
      ],
    };
    const bundle = await runFlow(flow, {
      cdpUrl: CDP_URL,
      cachePath: join(dir, 'toast.json'),
      healer: null,
    });

    assert.notEqual(bundle.status, 'passed', 'the row really is absent — this must still fail');
    const step = bundle.steps.find((s) => s.action === 'expectVisible');
    assert.deepEqual(step?.pageContext, ['Entitlement amount is required']);
  });

  it('leaves a failure on a quiet page exactly as it was', async () => {
    const flow: Flow = {
      name: 'no live region',
      baseUrl: origin,
      steps: [
        { action: 'goto', url: '/' },
        { action: 'expectVisible', selector: 'text="99 days"' },
      ],
    };
    const bundle = await runFlow(flow, {
      cdpUrl: CDP_URL,
      cachePath: join(dir, 'quiet.json'),
      healer: null,
    });

    const step = bundle.steps.find((s) => s.action === 'expectVisible');
    assert.equal(step?.pageContext, undefined);
  });
});
