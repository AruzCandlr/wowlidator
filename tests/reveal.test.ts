/**
 * Controls folded inside collapsed sections, and state contradictions that
 * end the ladder — the two engine gaps ec10's HIR-EC-002 and HIR-EC-029
 * exposed on 2026-09-02.
 *
 * `includeHidden`, `isStateContradiction` and the classification of a
 * `StepResolutionError` are pure and run always. Whether a disclosure click
 * actually unfolds a section, and whether a wrong count stops the ladder in
 * seconds rather than minutes, are facts about a real browser and CDP-gated.
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { includeHidden, revealHidden } from '../src/engine/reveal.js';
import { containsRoleName } from '../src/engine/selector.js';
import { captureAxTree } from '../src/healer/jit-healer.js';
import {
  endedInStateContradiction,
  isStateContradiction,
  optionNamePatterns,
  runFlow,
  StepResolutionError,
  type Flow,
} from '../src/engine/runner.js';

const CDP_URL = process.env['WOWLIDATOR_CDP_URL'] ?? 'http://localhost:9222';

// --- Unit tier -------------------------------------------------------------

describe('reveal: widening a selector to hidden elements', () => {
  it('adds include-hidden to every role= segment, once', () => {
    assert.equal(includeHidden('role=button[name="Gender" i]'), 'role=button[name="Gender" i][include-hidden]');
    assert.equal(
      includeHidden('role=region[name="Personal" i] >> role=button[name="Gender" i]'),
      'role=region[name="Personal" i][include-hidden] >> role=button[name="Gender" i][include-hidden]',
    );
    assert.equal(includeHidden('role=option[include-hidden]'), 'role=option[include-hidden]');
  });

  it('leaves css and text selectors alone — they already match hidden elements', () => {
    assert.equal(includeHidden('#gender'), '#gender');
    assert.equal(includeHidden('text="Gender"'), 'text="Gender"');
  });
});

describe('state contradictions end the ladder as a verdict', () => {
  it('recognises a wrong non-zero count, a wrong enabled state and focus elsewhere', () => {
    assert.ok(isStateContradiction('late "role=option" (10000ms): expected 3 matches, found 51'));
    assert.ok(isStateContradiction('fast "role=button[name="Save" i]": expected element to be disabled, but it is enabled'));
    assert.ok(isStateContradiction('fast "#x": expected element to have focus, but it does not'));
  });

  it('does not mistake absence or a timeout for a contradiction', () => {
    // Zero matches may be selector drift — the ladder must keep trying.
    assert.equal(isStateContradiction('fast "role=option": expected 3 matches, found 0'), false);
    assert.equal(isStateContradiction('fast "role=option": locator.waitFor: Timeout 2000ms exceeded.'), false);
    assert.equal(isStateContradiction('fast "role=main": expected text to contain "X", got "Y"'), false);
  });

  it('a fast timeout followed by a late count mismatch is the HIR-EC-029 shape — a verdict, not a dead end', () => {
    const attempts = [
      'fast "role=option": locator.waitFor: Timeout 2000ms exceeded.',
      'late "role=option" (10000ms): expected 3 matches, found 51',
    ];
    assert.equal(endedInStateContradiction(attempts), true);
    const error = new StepResolutionError('role=option', attempts);
    assert.equal(error.contentOnly, true);
    assert.match(error.message, /^"role=option" resolved, but the claim did not hold/);
  });

  it('a memoed repeat of a state contradiction stays a verdict', () => {
    const error = new StepResolutionError('role=option', [
      'fast "role=option": expected 3 matches, found 51',
      "known content mismatch: step 9 already read this element on this same page — not repaid; the text has not changed, and the wording is the judge's to rule on",
    ]);
    assert.equal(error.contentOnly, true);
  });

  it('a contradiction the ladder then walked past is not the last word', () => {
    // If a healer or agent line follows, some rung DID change the answer —
    // the classification must not pretend the contradiction still stands.
    assert.equal(
      endedInStateContradiction([
        'fast "role=option": expected 3 matches, found 51',
        'jit "listbox >> role=option": locator.waitFor: Timeout 10000ms exceeded.',
      ]),
      false,
    );
  });
});

describe('over-exact accessible names', () => {
  it('loosens a quoted role name to a whole word inside a longer name', () => {
    assert.equal(
      containsRoleName('role=option[name="New Hire" i]'),
      'role=option[name=/(^|[^\\p{L}\\p{N}])New\\s+Hire([^\\p{L}\\p{N}]|$)/iu]',
    );
    assert.equal(containsRoleName('role=button[name="Save (draft)"]'), 'role=button[name=/(^|[^\\p{L}\\p{N}])Save\\s+\\(draft\\)([^\\p{L}\\p{N}]|$)/iu]');
  });

  it('refuses what it cannot loosen safely', () => {
    assert.equal(containsRoleName('text="New Hire"'), null);
    assert.equal(containsRoleName('role=option'), null);
    assert.equal(containsRoleName('role=option[name=/x/]'), null);
    assert.equal(containsRoleName('role=option[name="a/b" i]'), null);
  });

  it('matches an option by its whole name first, then as a whole word — never inside another word', () => {
    const [exact, contains] = optionNamePatterns('Male');
    assert.ok(exact.test(' Male '));
    assert.equal(exact.test('Female'), false);
    assert.equal(contains.test('Female'), false);
    assert.ok(contains.test('M — Male'));
    const [, thai] = optionNamePatterns('ลาป่วย');
    assert.ok(thai.test('ลาป่วย (Sick)'));
    assert.ok(optionNamePatterns('New Hire')[1].test('H_NEWHIRE — New Hire'));
    assert.ok(optionNamePatterns('A - Permanent')[0].test('A — Permanent'), 'a hyphen in the sheet is an em dash on the page');
    assert.ok(optionNamePatterns('A-Permanent')[1].test('A — Permanent'));
  });
});

// --- Browser tier ----------------------------------------------------------

const FIXTURE_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>reveal fixture</title></head>
  <body>
    <!-- humi-SIT's hire form idiom: a card whose content is [hidden] and whose
         header holds a bare "Expand" button (the section name sits beside it). -->
    <section id="who.biographical">
      <div class="header"><span>Personal Information*</span>
        <button type="button" aria-expanded="false" aria-controls="who.biographical-content">Expand</button>
      </div>
      <div id="who.biographical-content" hidden>
        <label for="gender">Gender<span aria-hidden="true">*</span></label>
        <button id="gender" type="button" aria-haspopup="listbox" aria-expanded="false">Select Gender</button>
        <ul id="gender-list" role="listbox" hidden>
          <li role="option">Male</li><li role="option">Female</li>
        </ul>
      </div>
    </section>

    <!-- a disclosure with no aria-controls: only the header beside the fold -->
    <section>
      <div><button type="button" aria-expanded="false">Show contact</button></div>
      <div hidden><label for="phone">Phone</label><input id="phone" type="text"></div>
    </section>

    <details><summary>Notes</summary><textarea id="notes" aria-label="Notes"></textarea></details>

    <!-- humi's hire wizard bug: the first click on a never-touched section
         sets collapsed = !undefined = true, so only the second click opens it -->
    <section>
      <div><span>Employment Details*</span><button id="emp-toggle" type="button" aria-expanded="false" aria-controls="emp-content">Expand</button></div>
      <div id="emp-content" hidden>
        <label for="emp-group">Employee Group<span aria-hidden="true">*</span></label>
        <button id="emp-group" type="button" aria-haspopup="listbox" aria-expanded="false">Select Employee Group</button>
      </div>
    </section>

    <!-- humi's Event Reason: a toggling trigger, options named "CODE — Label" -->
    <label for="reason">Event Reason</label>
    <button id="reason" type="button" aria-haspopup="listbox" aria-expanded="false">Select Event Reason</button>
    <ul id="reason-list" role="listbox" hidden>
      <li role="option">H_NEWHIRE — New Hire</li>
      <li role="option">H_RPLMENT — Replacement</li>
      <li role="option">HIREDM — Hire - Data Migration</li>
      <li role="option">DM — DATA MIGRATION</li>
    </ul>

    <!-- an exact-count claim the page contradicts: 5 rows where 3 are claimed -->
    <table><tbody>
      <tr><td>a</td></tr><tr><td>b</td></tr><tr><td>c</td></tr><tr><td>d</td></tr><tr><td>e</td></tr>
    </tbody></table>

    <p id="status">idle</p>
    <script>
      let empState; // undefined at first, like the wizard store
      document.getElementById('emp-toggle').addEventListener('click', () => {
        empState = !empState; // first click: !undefined === true → stays collapsed
        document.getElementById('emp-content').hidden = empState;
        document.getElementById('emp-toggle').setAttribute('aria-expanded', String(!empState));
      });
      for (const btn of document.querySelectorAll('button[aria-expanded]')) {
        if (btn.id === 'gender' || btn.id === 'emp-toggle' || btn.id === 'reason' || btn.id === 'emp-group') continue;
        btn.addEventListener('click', () => {
          const target = btn.getAttribute('aria-controls')
            ? document.getElementById(btn.getAttribute('aria-controls'))
            : btn.parentElement.nextElementSibling;
          target.hidden = !target.hidden;
          btn.setAttribute('aria-expanded', String(!target.hidden));
        });
      }
      for (const [bid, lid, key] of [['gender', 'gender-list', 'gender'], ['reason', 'reason-list', 'reason']]) {
        const g = document.getElementById(bid), gl = document.getElementById(lid);
        g.addEventListener('click', () => { gl.hidden = !gl.hidden; g.setAttribute('aria-expanded', String(!gl.hidden)); });
        for (const o of gl.querySelectorAll('[role=option]')) o.addEventListener('click', () => {
          g.textContent = o.textContent; gl.hidden = true; g.setAttribute('aria-expanded', 'false');
          document.getElementById('status').textContent = key + ':' + o.textContent;
        });
      }
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

describe('reveal against a real page (CDP)', { skip: skipBrowser }, () => {
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
    dir = await mkdtemp(join(tmpdir(), 'wowlidator-reveal-'));
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(dir, { recursive: true, force: true });
  });

  it('opens the disclosure that owns the hidden ancestor — aria-controls, header sibling, <details>', async () => {
    const browser = await chromium.connectOverCDP(CDP_URL);
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(origin);
      assert.equal(await revealHidden(page, 'role=button[name="Missing" i]'), null, 'nothing matched → null');
      assert.equal(await revealHidden(page, '#status'), null, 'already visible → null');

      const gender = await revealHidden(page, 'role=button[name="Gender" i]');
      assert.ok(gender?.revealed, 'the card should unfold');
      assert.match(gender.disclosures.join(','), /Expand \(Personal Information\*/);
      assert.equal(await page.locator('role=button[name="Gender" i]').count(), 1);

      const phone = await revealHidden(page, 'role=textbox[name="Phone" i]');
      assert.ok(phone?.revealed, 'the header-sibling disclosure should unfold');
      assert.equal(phone.disclosures[0], 'Show contact');

      const notes = await revealHidden(page, '#notes');
      assert.ok(notes?.revealed, '<details> should open via its summary');
      assert.equal(notes.disclosures[0], 'Notes');

      const twice = await revealHidden(page, 'role=button[name="Employee Group" i]');
      assert.ok(twice?.revealed, 'a disclosure whose first click does nothing is clicked again');
      assert.equal(twice.disclosures.length, 2);
      assert.match(twice.disclosures[1] ?? '', /clicked again/);
    } finally {
      await context.close();
      await browser.close();
    }
  });

  it('the ladder reaches a control inside a collapsed section by its own selector (HIR-EC-002)', async () => {
    const flow: Flow = {
      name: 'collapsed section',
      baseUrl: origin,
      steps: [
        { action: 'goto', url: '/' },
        { action: 'selectOption', selector: 'role=button[name="Gender" i]', value: 'Female' },
        { action: 'expectText', selector: '#status', value: 'gender:Female' },
      ],
    };
    const started = Date.now();
    const bundle = await runFlow(flow, { cdpUrl: CDP_URL, cachePath: join(dir, 'reveal.json'), healer: null });
    assert.equal(bundle.status, 'passed', bundle.error ?? 'the reveal rung should unfold the card');
    const pick = bundle.steps.find((s) => s.action === 'selectOption');
    assert.equal(pick?.resolution, 'reveal');
    assert.equal(pick?.resolvedSelector, 'role=button[name="Gender" i]', 'the author\'s own selector, never another');
    assert.ok((bundle.notes ?? []).some((n) => n.includes('collapsed section') && n.includes('Personal Information')));
    assert.ok(Date.now() - started < 20_000, `took ${Date.now() - started}ms`);
  });

  it('a wrong count is a failed verdict in seconds, not a dead end after the healer and agent (HIR-EC-029)', async () => {
    const flow: Flow = {
      name: 'count contradiction',
      baseUrl: origin,
      steps: [
        { action: 'goto', url: '/' },
        { action: 'expectCount', selector: 'role=row', count: 3 },
      ],
    };
    const started = Date.now();
    const bundle = await runFlow(flow, { cdpUrl: CDP_URL, cachePath: join(dir, 'count.json'), healer: null });
    assert.equal(bundle.status, 'failed');
    const count = bundle.steps.find((s) => s.action === 'expectCount');
    assert.equal(count?.status, 'failed', `a contradiction is a verdict, got ${count?.status}: ${count?.error}`);
    assert.match(count?.error ?? '', /resolved, but the claim did not hold/);
    assert.match(count?.error ?? '', /expected 3 matches, found 5/);
    assert.ok(Date.now() - started < 20_000, `took ${Date.now() - started}ms — the fast and patience rungs only`);
  });

  it('an option named "CODE — Label" satisfies a presence check on the label, without a re-click closing the list (HIR-EC-029)', async () => {
    const flow: Flow = {
      name: 'coded options',
      baseUrl: origin,
      steps: [
        { action: 'goto', url: '/' },
        { action: 'click', selector: '#reason', intent: 'open the Event Reason dropdown to inspect its values' },
        { action: 'expectCount', selector: 'role=option', count: 4 },
        { action: 'expectVisible', selector: 'role=option[name="New Hire" i]' },
        { action: 'click', selector: '#reason', intent: 'open the Event Reason dropdown again to check the rest' },
        { action: 'expectVisible', selector: 'role=option[name="Replacement" i]' },
        { action: 'expectVisible', selector: 'role=option[name="Migration" i]' },
        { action: 'selectOption', selector: '#reason', value: 'New Hire' },
        { action: 'expectText', selector: '#status', value: 'reason:H_NEWHIRE — New Hire' },
      ],
    };
    const started = Date.now();
    const bundle = await runFlow(flow, { cdpUrl: CDP_URL, cachePath: join(dir, 'coded.json'), healer: null });
    assert.equal(bundle.status, 'passed', bundle.error ?? 'coded option names should satisfy the label');
    const presence = bundle.steps.find((s) => s.action === 'expectVisible' && (s.selector ?? '').includes('New Hire'));
    assert.equal(presence?.resolution, 'narrow');
    assert.match(presence?.resolvedSelector ?? '', /name=\/\(\^\|/);
    const ambiguous = bundle.steps.find((s) => (s.selector ?? '').includes('Migration'));
    assert.equal(ambiguous?.status, 'passed', `a label shared by two options still satisfies presence: ${ambiguous?.error}`);
    assert.match(ambiguous?.resolvedSelector ?? '', />> nth=0$/);
    const reclick = bundle.steps.filter((s) => s.action === 'click')[1];
    assert.equal((reclick?.detail as Record<string, unknown> | undefined)?.['skipped'], 'already open');
    assert.ok(Date.now() - started < 20_000, `took ${Date.now() - started}ms`);
  });

  it('the tree shows a popup button\'s visible text as its value (HIR-EC-002)', async () => {
    const browser = await chromium.connectOverCDP(CDP_URL);
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(origin);
      let tree = await captureAxTree(page);
      assert.match(tree, /button "Event Reason" value="Select Event Reason"/);
      await page.locator('#reason').click();
      await page.getByRole('option', { name: /Replacement/ }).click();
      tree = await captureAxTree(page);
      assert.match(tree, /button "Event Reason" value="H_RPLMENT — Replacement"/);
    } finally {
      await context.close();
      await browser.close();
    }
  });

  it('selectOption picks the whole name before a containing one — "Male" is not "Female"', async () => {
    const flow: Flow = {
      name: 'male not female',
      baseUrl: origin,
      steps: [
        { action: 'goto', url: '/' },
        { action: 'selectOption', selector: 'role=button[name="Gender" i]', value: 'Male' },
        { action: 'expectText', selector: '#status', value: 'gender:Male' },
      ],
    };
    const bundle = await runFlow(flow, { cdpUrl: CDP_URL, cachePath: join(dir, 'male.json'), healer: null });
    assert.equal(bundle.status, 'passed', bundle.error ?? 'Male must pick Male');
  });
});
