/**
 * The fourth tier: pinned flows against a real application (spec T4).
 *
 * **Opt in with `WOWLIDATOR_E2E_APP_URL`.** Everything else in this suite runs
 * against purpose-built fixture pages — fast, hermetic, and structurally blind
 * to one class of bug. Both of the worst defects wowlidator has shipped were of
 * exactly that class:
 *
 * - Chrome's accessible name applies CSS `text-transform`; Playwright's does
 *   not, so every generated selector for an uppercased control matched nothing.
 * - A `hidden` condition evaluated 17ms after `goto` on a hydrating React page
 *   answered "yes, hidden" for a control that had simply not rendered yet.
 *
 * No fixture would have produced either. A real application does, on the first
 * run, every time.
 *
 * ## The rule that keeps this tier honest
 *
 * **Assert only on invariants, never on content.** A count of table rows, a
 * seeded record id, a label that reads differently after a copy change — those
 * make the suite red when the *application* changed, which is not wowlidator's
 * business and trains people to ignore the tier. What is asserted here is that
 * the page renders, that its structure is navigable, and that wowlidator's own
 * machinery behaves — never what the business data says.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';

import { probeInteractions } from '../src/context/page-probe.js';
import { captureAxNodes } from '../src/healer/jit-healer.js';
import { runFlow, type Flow } from '../src/engine/runner.js';
import { relaxRoleName } from '../src/engine/selector.js';

const CDP_URL = process.env['WOWLIDATOR_CDP_URL'] ?? 'http://localhost:9222';
const APP_URL = process.env['WOWLIDATOR_E2E_APP_URL'];

async function reachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'follow' });
    return response.ok;
  } catch {
    return false;
  }
}

async function cdpAvailable(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/json/version`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

const skip = !APP_URL
  ? 'set WOWLIDATOR_E2E_APP_URL to a running application to enable the real-app tier'
  : !(await cdpAvailable(CDP_URL))
    ? `no CDP endpoint at ${CDP_URL} — start Chrome with --remote-debugging-port=9222`
    : !(await reachable(APP_URL))
      ? `WOWLIDATOR_E2E_APP_URL (${APP_URL}) did not respond`
      : false;

describe('real application (opt-in)', { skip }, () => {
  let browser: Browser;
  let page: Page;

  before(async () => {
    browser = await chromium.connectOverCDP(CDP_URL);
    page = await (browser.contexts()[0] ?? (await browser.newContext())).newPage();
    await page.goto(APP_URL!, { waitUntil: 'domcontentloaded' });
  });

  after(async () => {
    await page.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  });

  it('renders something operable', async () => {
    // Structure, not content: any real page has interactive controls, and a
    // page that suddenly has none is broken however its copy reads.
    const nodes = await captureAxNodes(page);
    assert.ok(nodes.length > 0, 'the accessibility tree was empty');
  });

  it('produces selectors the engine can actually resolve', async () => {
    // The regression that fixtures cannot see. Every named control captured
    // from Chrome must resolve through Playwright's own name matching — if a
    // whole page's worth fails, the two implementations have diverged again.
    const nodes = (await captureAxNodes(page)).filter(
      (node) => node.name && ['button', 'link', 'tab'].includes(node.role),
    );
    if (nodes.length === 0) return;

    let resolved = 0;
    for (const node of nodes.slice(0, 12)) {
      const selector = relaxRoleName(`role=${node.role}[name="${node.name}"]`) ?? '';
      if (!selector) continue;
      if ((await page.locator(selector).count()) > 0) resolved += 1;
    }
    assert.ok(
      resolved > 0,
      'not one captured control could be resolved — the accessible-name implementations have diverged',
    );
  });

  it('probes disclosures without changing anything it should not', async () => {
    const before = page.url();
    const report = await probeInteractions(page, { maxProbes: 3 });
    assert.equal(page.url(), before, 'probing navigated away — it must only open disclosures');
    for (const probe of report.probes) {
      assert.ok(probe.trigger.length > 0);
    }
  });

  it('runs a read-only flow end to end and reports honestly', async () => {
    const flow: Flow = {
      name: 'e2e smoke',
      steps: [
        { action: 'goto', url: APP_URL! },
        // Deliberately absent: the assertion is about how wowlidator *reports* a
        // miss on a real page, not about anything the application should show.
        {
          action: 'expectHidden',
          selector: '#wowlidator-e2e-control-that-should-never-exist',
          intent: 'A control that cannot exist is reported as absent, not healed onto something else.',
        },
      ],
    };

    const bundle = await runFlow(flow, { cdpUrl: CDP_URL, healer: null, historyPath: null });
    assert.equal(bundle.status, 'passed', bundle.error ?? 'the absence assertion should hold');
    assert.equal(bundle.summary.jitHeals, 0, 'an absence assertion must never reach the healer');
    assert.ok(bundle.summary.frontend.steps > 0);
  });
});
