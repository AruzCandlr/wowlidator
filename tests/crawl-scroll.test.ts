/**
 * Link crawling with self-healing, and scrollability (`src/crawl/crawler.ts`,
 * the scroll and history actions).
 *
 * Browser-tier by nature: both features ask what a live layout does — "can a
 * user reach the content below the fold", "does this link come back" — and
 * neither has a meaningful answer without a real renderer.
 *
 * The tests that matter most are the negative ones: a crawl must never follow a
 * button, `expectScrollable` must fail on overflow a user cannot reach, and a
 * healed crawl must still be *reported* as healed rather than as a clean tick.
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';

import { CacheManager } from '../src/cache/cache-manager.js';
import { crawlFrom, discoverLinks, formatCrawlReport } from '../src/crawl/crawler.js';
import { JitHealer, type HealRequest, type HealSuggestion, type HealerModel } from '../src/healer/jit-healer.js';
import { ProofBundleBuilder } from '../src/engine/proof-bundle.js';
import { runFlow, type Flow } from '../src/engine/runner.js';

const CDP_URL = process.env['WOWLIDATOR_CDP_URL'] ?? 'http://localhost:9222';

/**
 * A hub page in miniature: good links, a dead route, an external link, a
 * mailto, a destructive *button*, a route that traps you, and one card whose
 * accessible name is deliberately unusable so the healer has to earn its keep.
 */
const PAGES: Record<string, string> = {
  '/': `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>hub</title></head><body>
    <h1>Hub</h1>
    <a href="/alpha">Alpha service</a>
    <a href="/beta">Beta service</a>
    <a href="/empty">Empty page</a>
    <a href="/trap">One way street</a>
    <a href="https://example.com/away">External</a>
    <a href="mailto:someone@example.com">Mail us</a>
    <a href="/">Home again</a>
    <button id="danger">Delete everything</button>
    <p id="damage" hidden>DELETED</p>
    <script>document.getElementById('danger').addEventListener('click',()=>{document.getElementById('damage').hidden=false});</script>
  </body></html>`,
  '/alpha': `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>alpha</title></head>
    <body><h1>Alpha</h1><button>Do alpha</button></body></html>`,
  '/beta': `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>beta</title></head>
    <body><h1>Beta</h1><a href="/">Back to hub</a></body></html>`,
  // Renders nothing operable — a blank route or a dead error boundary, which
  // any status-code check would call healthy.
  '/empty': `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>empty</title></head><body></body></html>`,
  '/trap': `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>trap</title></head>
    <body><h1>Trap</h1><a href="/trap">stay</a>
    <script>
      history.pushState({}, '', '/trap');
      history.pushState({}, '', '/trap');
      history.pushState({}, '', '/trap');
    </script></body></html>`,
};

/**
 * A hub whose card cannot be clicked where it is: a transparent overlay sits
 * on top of it, so the selector resolves and the click never lands — the shape
 * of a sticky banner, a toast, or a modal that forgot to close. The crawl's own
 * free rungs cannot get past that; a repair pointing at an unobstructed control
 * can.
 */
const HEAL_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>heal hub</title>
<style>
  #veil { position: fixed; inset: 0; z-index: 10; background: rgba(0,0,0,.01) }
  #escape { position: relative; z-index: 20 }
</style></head><body>
  <h1>Heal hub</h1>
  <a id="covered" href="/alpha">Ghost card</a>
  <a id="escape" href="/alpha">Reachable twin</a>
  <div id="veil"></div>
  </body></html>`;

const SCROLL_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>scroll</title>
<style>
  body { margin: 0 }
  #tall { height: 3000px; background: linear-gradient(#fff, #ddd) }
  /* Overflowing content nobody can reach: exactly the case that passes every
     functional assertion while being unusable. */
  #locked { height: 120px; overflow: hidden }
  #locked .inner { height: 900px }
  #pane { height: 120px; overflow-y: auto }
  #pane .inner { height: 900px }
  #short { height: 40px; overflow-y: auto }
</style></head>
<body>
  <div id="pane"><div class="inner">scrollable pane</div></div>
  <div id="locked"><div class="inner">unreachable overflow</div></div>
  <div id="short">fits</div>
  <div id="tall">long page</div>
  <a id="bottom" href="/alpha">Bottom link</a>
</body></html>`;

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

/** A healer whose answers are scripted — no key, no network, no flake. */
class StubHealer implements HealerModel {
  readonly id = 'stub-crawl-healer';
  readonly calls: HealRequest[] = [];
  constructor(private readonly answers: HealSuggestion[]) {}

  async suggest(request: HealRequest): Promise<HealSuggestion> {
    this.calls.push(request);
    const answer = this.answers[Math.min(this.calls.length - 1, this.answers.length - 1)];
    if (!answer) throw new Error('no scripted answer');
    return answer;
  }
}

describe('crawl (CDP)', { skip: skipBrowser }, () => {
  let server: Server;
  let origin: string;
  let browser: Browser;
  let page: Page;

  before(async () => {
    server = createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0] ?? '/';
      const body = path === '/heal' ? HEAL_PAGE : PAGES[path];
      if (body === undefined) {
        res.writeHead(404, { 'content-type': 'text/html' });
        res.end('<!doctype html><html lang="en"><body>not found</body></html>');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.connectOverCDP(CDP_URL);
    page = await (browser.contexts()[0] ?? (await browser.newContext())).newPage();
  });

  after(async () => {
    await page.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    server.closeAllConnections();
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  });

  it('discovers same-origin page links and says why it skipped the rest', async () => {
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    const { links, skipped } = await discoverLinks(page);

    const names = links.map((l) => l.name);
    assert.ok(names.includes('Alpha service'));
    assert.ok(names.includes('Beta service'));

    const reasons = skipped.map((s) => `${s.name}: ${s.reason}`).join(' | ');
    assert.match(reasons, /External: different origin/);
    assert.match(reasons, /Mail us: not a page/);
    // A link back to the page we are already on teaches nothing.
    assert.match(reasons, /Home again: points at this same page/);
  });

  it('never follows a button, however tempting its label', async () => {
    // The safety model: links are GETs, buttons are where Delete and Approve
    // live. If this ever fails, a crawl has become able to mutate an app.
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await crawlFrom(page, { maxPages: 10, timeoutMs: 10_000 });
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    assert.equal(await page.locator('#damage').isVisible(), false, 'the crawl clicked a button');
  });

  it('reports a destination that renders nothing as unreachable', async () => {
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    const report = await crawlFrom(page, { maxPages: 10, timeoutMs: 10_000 });

    const empty = report.visited.find((v) => v.link.url.endsWith('/empty'));
    assert.ok(empty, 'the empty route should have been visited');
    assert.equal(empty.ok, false);
    assert.match(empty.error ?? '', /no accessible content/);

    const alpha = report.visited.find((v) => v.link.url.endsWith('/alpha'));
    assert.equal(alpha?.ok, true);
    assert.ok((alpha?.controls ?? 0) > 0);
    assert.equal(alpha?.via, 'click', 'a working link needs no repair');
  });

  it('checks that each page can be left again', async () => {
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    const report = await crawlFrom(page, { maxPages: 10, timeoutMs: 10_000 });

    // A page you can enter but not leave is a real defect, and invisible to a
    // test that navigates by URL instead of by clicking.
    const trap = report.visited.find((v) => v.link.url.endsWith('/trap'));
    assert.ok(trap);
    assert.equal(trap.returned, false, 'the history trap should have been caught');
    assert.equal(trap.recovered, true, 'and the crawl should recover to keep going');

    const good = report.visited.find((v) => v.link.url.endsWith('/alpha'));
    assert.equal(good?.returned, true);
  });

  it('records every visit as a step, and never hides a budget it did not spend', async () => {
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    const bundle = new ProofBundleBuilder({ name: 'crawl', cdpUrl: null, cachePath: null });
    const report = await crawlFrom(page, { maxPages: 2, timeoutMs: 10_000 }, bundle);

    assert.equal(report.visited.length, 2);
    assert.equal(bundle.finish().steps.length, 2, 'each visit is a step in the bundle');
    assert.ok(report.notVisited.length > 0, 'links beyond the budget must be reported');
    // A truncated crawl otherwise reads exactly like a clean sweep.
    assert.match(formatCrawlReport(report), /not visited \d+ link\(s\) beyond the page budget/);
  });

  it('heals a link it cannot click, and says so in the report', async () => {
    // The crawl writes its own selectors from accessible names, so when one
    // does not resolve the author has nothing to fix — this is the one place
    // healing is load-bearing rather than a convenience.
    await page.goto(`${origin}/heal`, { waitUntil: 'domcontentloaded' });
    const model = new StubHealer([
      { selector: '#escape', strategy: 'css', confidence: 0.9, reasoning: 'the twin nothing covers', inputTokens: 100, outputTokens: 20 },
    ]);
    const healer = new JitHealer({
      model,
      cache: new CacheManager({ filePath: join(tmpdir(), 'wowlidator-crawl-heal.cache.json') }),
    });

    const bundle = new ProofBundleBuilder({ name: 'healed crawl', cdpUrl: null, cachePath: null });
    // Short budgets: two rungs have to time out before the healer is asked, and
    // this test is about what happens after that, not about waiting.
    const report = await crawlFrom(page, { maxPages: 1, timeoutMs: 1_500, healer, maxHealAttempts: 5 }, bundle);

    const visit = report.visited[0];
    assert.ok(visit, 'the ambiguous link should have been attempted');
    assert.equal(visit.via, 'healed-click', 'it should have been reached via a repair');
    assert.equal(visit.heals.length, 1);
    assert.equal(visit.heals[0]?.ok, true);
    assert.equal(model.calls.length, 1, 'one repair was enough');

    // The report must show the repair, not a clean tick: the crawl passed
    // *and* the page has drifted, and a reader needs both halves.
    const step = bundle.finish().steps[0];
    assert.equal(step?.heal?.to, '#escape');
    assert.equal(step?.heal?.model, 'stub-crawl-healer');
    assert.match(formatCrawlReport(report), /self-heal {2}1 repair call\(s\), 1 link\(s\) recovered/);
  });

  it('stops asking after the attempt budget, and degrades honestly', async () => {
    await page.goto(`${origin}/heal`, { waitUntil: 'domcontentloaded' });
    // Every answer is wrong, so no attempt can succeed.
    const model = new StubHealer([
      { selector: '#nope-1', strategy: 'css', confidence: 0.9, reasoning: 'wrong' },
    ]);
    const healer = new JitHealer({
      model,
      cache: new CacheManager({ filePath: join(tmpdir(), 'wowlidator-crawl-dead.cache.json') }),
      verifyTimeoutMs: 500,
    });

    const report = await crawlFrom(
      page,
      { maxPages: 1, timeoutMs: 1_500, healer, maxHealAttempts: 3 },
      undefined,
    );

    const visit = report.visited[0];
    assert.ok(visit);
    // Reaching the route by URL is a *degraded* success: the page exists, the
    // control does not work, and calling that a clean pass would let a hub
    // full of broken cards report a sweep.
    assert.equal(visit.via, 'url');
    assert.ok(visit.heals.length > 0 && visit.heals.every((h) => !h.ok));
    assert.ok(model.calls.length <= 3, `the budget must cap the calls, made ${model.calls.length}`);
    assert.match(formatCrawlReport(report), /degraded {3}1 link\(s\) could not be clicked/);
  });
});

describe('scrolling and history (CDP)', { skip: skipBrowser }, () => {
  let server: Server;
  let origin: string;
  let dir: string;

  before(async () => {
    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end((req.url ?? '/').startsWith('/alpha') ? PAGES['/alpha'] : SCROLL_HTML);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    dir = await mkdtemp(join(tmpdir(), 'wowlidator-scroll-'));
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
    await rm(dir, { recursive: true, force: true });
  });

  const run = (flow: Flow, name: string) =>
    runFlow(flow, {
      cdpUrl: CDP_URL,
      cachePath: join(dir, `${name}.json`),
      healer: null,
      historyPath: null,
    });

  it('passes when the page really scrolls', async () => {
    const bundle = await run(
      {
        name: 'page scrolls',
        baseUrl: origin,
        steps: [
          { action: 'goto', url: '/' },
          { action: 'expectScrollable', intent: 'The page continues past the fold.' },
        ],
      },
      'page',
    );
    assert.equal(bundle.status, 'passed', bundle.error ?? 'the page is 3000px tall');
  });

  it('passes for a container that scrolls', async () => {
    const bundle = await run(
      {
        name: 'pane scrolls',
        baseUrl: origin,
        steps: [
          { action: 'goto', url: '/' },
          { action: 'expectScrollable', selector: '#pane', intent: 'The pane scrolls.' },
        ],
      },
      'pane',
    );
    assert.equal(bundle.status, 'passed', bundle.error ?? 'the pane has 900px in 120px');
  });

  it('fails on overflow a user cannot reach', async () => {
    // The whole point of the assertion. `#locked` has 900px of content in
    // 120px with `overflow: hidden` — every functional test against it passes
    // while the content is unreachable.
    const bundle = await run(
      {
        name: 'locked overflow',
        baseUrl: origin,
        steps: [
          { action: 'goto', url: '/' },
          { action: 'expectScrollable', selector: '#locked', intent: 'Users can reach the rest.' },
        ],
      },
      'locked',
    );
    assert.equal(bundle.status, 'failed');
    const step = bundle.steps.find((s) => s.action === 'expectScrollable');
    assert.match(step?.error ?? '', /the overflow is unreachable/);
    assert.match(step?.error ?? '', /900px in 120px/, 'the sizes are the diagnostic');
  });

  it('says so plainly when the content simply fits', async () => {
    const bundle = await run(
      {
        name: 'fits',
        baseUrl: origin,
        steps: [
          { action: 'goto', url: '/' },
          { action: 'expectScrollable', selector: '#short', intent: 'Expect scrolling here.' },
        ],
      },
      'short',
    );
    assert.equal(bundle.status, 'failed');
    assert.match(
      bundle.steps.find((s) => s.action === 'expectScrollable')?.error ?? '',
      /its content fits/,
    );
  });

  it('names a container that does not exist instead of measuring nothing', async () => {
    const bundle = await run(
      {
        name: 'missing container',
        baseUrl: origin,
        steps: [
          { action: 'goto', url: '/' },
          { action: 'expectScrollable', selector: '#not-here', intent: 'Check a pane.' },
        ],
      },
      'missing',
    );
    assert.equal(bundle.status, 'failed');
    assert.match(
      bundle.steps.find((s) => s.action === 'expectScrollable')?.error ?? '',
      /no element matches/,
    );
  });

  it('scrolls to a control, follows it, and comes back with history', async () => {
    const bundle = await run(
      {
        name: 'scroll then back',
        baseUrl: origin,
        steps: [
          { action: 'goto', url: '/' },
          { action: 'scrollTo', selector: '#bottom', intent: 'Reach the link below the fold.' },
          { action: 'click', selector: '#bottom', intent: 'Follow it.' },
          { action: 'expectUrl', value: '/alpha', intent: 'We arrived.' },
          { action: 'back', intent: 'Return the way a user would.' },
          { action: 'expectVisible', selector: '#pane', intent: 'The original page is back.' },
        ],
      },
      'back',
    );
    assert.equal(bundle.status, 'passed', bundle.error ?? 'scroll → click → back should work');
    assert.ok(bundle.steps.some((s) => s.action === 'back' && s.status === 'passed'));
  });

  it('leaves the scroll position where it found it', async () => {
    // An assertion that moves the page changes what the next step is testing.
    const bundle = await run(
      {
        name: 'position restored',
        baseUrl: origin,
        steps: [
          { action: 'goto', url: '/' },
          { action: 'expectScrollable', intent: 'Probe the page.' },
          // Only true if the probe put the page back at the top.
          { action: 'expectVisible', selector: '#pane', intent: 'Still looking at the top.' },
        ],
      },
      'restore',
    );
    assert.equal(bundle.status, 'passed', bundle.error ?? 'the probe should restore scrollTop');
  });
});
