/**
 * Interaction probing (`src/context/page-probe.ts`).
 *
 * Browser-tier by nature: the entire claim is about what a live DOM does when
 * you click it, so there is nothing to unit test in isolation — same reasoning
 * as `modal.test.ts`.
 *
 * The most important test here is the one asserting what a probe does *not*
 * click. Probing is the only part of wowlidator that touches a live application
 * without being told to, so its restraint is the feature.
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';

import { formatProbeReport, probeInteractions } from '../src/context/page-probe.js';

const CDP_URL = process.env['WOWLIDATOR_CDP_URL'] ?? 'http://localhost:9222';

const PROBE_FIXTURE_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>probe fixture</title></head>
  <body>
    <button id="identity" aria-haspopup="menu" aria-expanded="false">Active role</button>
    <div id="menu" role="menu" hidden>
      <button role="menuitem">Take Action on Behalf of…</button>
      <button role="menuitem">Sign out</button>
    </div>

    <!-- No ARIA disclosure markup, and destructive. Must never be clicked. -->
    <button id="danger">Delete everything</button>
    <p id="damage" hidden>DELETED</p>

    <!-- A popover library's shape: a full-viewport click-catcher plus the
         panel, closed ONLY by a click on the catcher. No Escape handler. -->
    <button id="todo" aria-haspopup="dialog" aria-expanded="false" aria-label="Inbox">Inbox</button>
    <div id="scrim" hidden aria-hidden="true" style="position:fixed;inset:0;z-index:40"></div>
    <div id="inbox" role="dialog" aria-label="Inbox panel" hidden style="position:fixed;top:40px;right:40px;z-index:50">
      <p>No tasks</p>
      <a href="#all">View all tasks</a>
    </div>

    <!-- A menu that ignores Escape but toggles closed on its own trigger. -->
    <button id="more" aria-haspopup="menu" aria-expanded="false">More options</button>
    <div id="moremenu" role="menu" hidden>
      <button role="menuitem">Export</button>
    </div>

    <button id="stuck" aria-haspopup="dialog" aria-expanded="false">Open sticky dialog</button>
    <div id="sticky" role="dialog" aria-label="Sticky" hidden>
      <p>This one ignores Escape.</p>
    </div>

    <script>
      document.getElementById('identity').addEventListener('click', () => {
        const m = document.getElementById('menu');
        m.hidden = !m.hidden;
        document.getElementById('identity').setAttribute('aria-expanded', String(!m.hidden));
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') document.getElementById('menu').hidden = true;
      });
      document.getElementById('danger').addEventListener('click', () => {
        document.getElementById('damage').hidden = false;
      });
      document.getElementById('stuck').addEventListener('click', () => {
        document.getElementById('sticky').hidden = false;
      });
      const setInbox = (open) => {
        document.getElementById('scrim').hidden = !open;
        document.getElementById('inbox').hidden = !open;
        document.getElementById('todo').setAttribute('aria-expanded', String(open));
      };
      document.getElementById('todo').addEventListener('click', () => setInbox(true));
      document.getElementById('scrim').addEventListener('click', () => setInbox(false));
      document.getElementById('more').addEventListener('click', () => {
        const m = document.getElementById('moremenu');
        m.hidden = !m.hidden;
        document.getElementById('more').setAttribute('aria-expanded', String(!m.hidden));
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

describe('interaction probe (CDP)', { skip: skipBrowser }, () => {
  let server: Server;
  let origin: string;
  let browser: Browser;
  let page: Page;

  before(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PROBE_FIXTURE_HTML);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.connectOverCDP(CDP_URL);
    page = await (browser.contexts()[0] ?? (await browser.newContext())).newPage();
  });

  after(async () => {
    await page.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it('finds the controls hidden behind a menu', async () => {
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    const report = await probeInteractions(page, { maxProbes: 1 });

    const identity = report.probes.find((p) => /Active role/.test(p.trigger));
    assert.ok(identity, 'the identity menu should have been probed');
    assert.equal(identity.closedVia, 'escape');
    const names = identity.revealed.map((node) => node.name);
    assert.ok(
      names.some((name) => name.includes('Take Action on Behalf of')),
      `expected the menu items, got ${JSON.stringify(names)}`,
    );
  });

  it('never clicks a control that is not marked as a disclosure', async () => {
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await probeInteractions(page);

    // "Delete everything" carries no aria-haspopup and no aria-expanded, so it
    // is not a candidate. If this ever fails, the probe has become capable of
    // writing to a real application.
    assert.equal(await page.locator('#damage').isVisible(), false, 'the probe clicked a destructive button');
  });

  it('leaves the page as it found it', async () => {
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await probeInteractions(page, { maxProbes: 1 });
    assert.equal(await page.locator('#menu').isVisible(), false, 'the menu was left open');
  });

  it('stops and says so when a disclosure will not close', async () => {
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    // Every disclosure is a candidate; the sticky one has no catcher, no
    // dismiss control and a trigger that does not toggle, so nothing can put
    // it back and whatever it opened would be attributed to the next control.
    const report = await probeInteractions(page);
    assert.match(report.warnings.join(' '), /would not close \(tried escape, dismiss-button, click-catcher, trigger\)/);
    const stickyProbe = report.probes.find((p) => /sticky/i.test(p.trigger));
    assert.ok(stickyProbe, 'the sticky dialog should have been probed');
    assert.equal(stickyProbe.leftOpen, true);
    assert.equal(stickyProbe.closedVia, undefined);
  });

  it('puts back a popover that ignores Escape by clicking its click-catcher (2026-09-10)', async () => {
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    const report = await probeInteractions(page, { maxProbes: 6 });
    const inbox = report.probes.find((p) => /Inbox/.test(p.trigger));
    assert.ok(inbox, 'the inbox popover should have been probed');
    assert.equal(inbox.leftOpen, undefined, 'the popover was reported left open');
    assert.equal(inbox.closedVia, 'click-catcher');
    assert.ok(
      inbox.revealed.some((node) => /View all tasks|No tasks/.test(node.name)),
      `the panel's contents should have been recorded, got ${JSON.stringify(inbox.revealed.map((n) => n.name))}`,
    );
    // The page is as it was found: the catcher is gone, so a click on the
    // page lands on the page — the live failure was every later click of a
    // case being swallowed by exactly this element.
    assert.equal(await page.locator('#scrim').isVisible(), false, 'the click-catcher was left over the page');
    assert.equal(await page.locator('#inbox').isVisible(), false, 'the panel was left open');
  });

  it('puts back a menu that ignores Escape by toggling its trigger', async () => {
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    const report = await probeInteractions(page, { maxProbes: 6 });
    const more = report.probes.find((p) => /More options/.test(p.trigger));
    assert.ok(more, 'the menu should have been probed');
    assert.equal(more.closedVia, 'trigger');
    assert.equal(await page.locator('#moremenu').isVisible(), false, 'the menu was left open');
  });

  it('reports the budget it did not spend rather than looking exhaustive', async () => {
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    const report = await probeInteractions(page, { maxProbes: 1 });
    assert.equal(report.skipped, 3, 'the un-probed disclosures should be counted');
    assert.match(formatProbeReport(report), /probe budget reached/);
  });

  it('formats provenance the model cannot misread as "already on the page"', async () => {
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    const text = formatProbeReport(await probeInteractions(page, { maxProbes: 1 }));
    assert.match(text, /only after an interaction/);
    assert.match(text, /click "Active role" reveals:/);
  });
});
