/**
 * Form interaction actions — `selectOption`, `check`/`uncheck`, `type`
 * (`src/engine/runner.ts`), and their narrowing in the generator/author
 * vocabularies.
 *
 * Two tiers, same rule as everywhere else:
 *   - unit: the vocabulary contract and `toFlowStep` narrowing are pure and
 *     run always.
 *   - browser: that a native select, a custom listbox, an ARIA toggle and a
 *     per-keystroke field actually respond is a fact about a real browser —
 *     `fill` fires no per-key keydown and `click` cannot pick an option, which
 *     is exactly the gap these actions close, and only a page can prove it.
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
import {
  GENERATOR_ACTIONS,
  toFlowStep,
  vacuousFormAssertion,
} from '../src/generator/test-generator.js';
import { AUTHOR_ACTIONS } from '../src/generator/flow-author.js';

const CDP_URL = process.env['WOWLIDATOR_CDP_URL'] ?? 'http://localhost:9222';

// --- Unit tier -------------------------------------------------------------

describe('form actions: vocabulary contract', () => {
  it('generator and author can both emit the form actions', () => {
    for (const action of ['selectOption', 'check', 'uncheck', 'type'] as const) {
      assert.ok(
        (GENERATOR_ACTIONS as readonly string[]).includes(action),
        `GENERATOR_ACTIONS is missing ${action}`,
      );
      assert.ok(
        (AUTHOR_ACTIONS as readonly string[]).includes(action),
        `AUTHOR_ACTIONS is missing ${action}`,
      );
    }
  });
});

describe('form actions: toFlowStep narrowing', () => {
  const raw = (partial: Record<string, string>) => ({
    action: 'fill',
    selector: '',
    value: '',
    url: '',
    intent: '',
    ...partial,
  });

  it('narrows selectOption, qualifying and case-relaxing the selector', () => {
    const step = toFlowStep(
      raw({ action: 'selectOption', selector: 'combobox[name="HRBP"]', value: 'Anna', intent: 'pick' }) as never,
    );
    assert.ok(step && step.action === 'selectOption');
    assert.ok(step.selector.startsWith('role=combobox'), step.selector);
    assert.ok(step.selector.includes('" i]'), step.selector);
    assert.equal(step.value, 'Anna');
  });

  it('narrows check, uncheck and type', () => {
    const checked = toFlowStep(raw({ action: 'check', selector: '#agree' }) as never);
    assert.deepEqual(checked, { action: 'check', selector: '#agree', intent: undefined });
    const unchecked = toFlowStep(raw({ action: 'uncheck', selector: '#agree' }) as never);
    assert.deepEqual(unchecked, { action: 'uncheck', selector: '#agree', intent: undefined });
    const typed = toFlowStep(raw({ action: 'type', selector: '#search', value: 'abc' }) as never);
    assert.deepEqual(typed, { action: 'type', selector: '#search', value: 'abc', intent: undefined });
  });

  it('drops a selectOption or type with nothing to select or type', () => {
    assert.equal(toFlowStep(raw({ action: 'selectOption', selector: '#dept' }) as never), null);
    assert.equal(toFlowStep(raw({ action: 'type', selector: '#search' }) as never), null);
    assert.equal(toFlowStep(raw({ action: 'check' }) as never), null);
  });

  it('counts a selectOption toward the vacuous-form lint like a fill', () => {
    const reason = vacuousFormAssertion([
      { action: 'selectOption', selector: 'role=combobox[name="HRBP" i]', value: 'Anna' },
      { action: 'click', selector: 'role=button[name="Save" i]' },
      { action: 'expectValue', selector: 'role=combobox[name="HRBP" i]', value: 'Anna' },
    ]);
    assert.ok(reason, 'selecting, submitting and asserting your own selection is vacuous');
  });
});

// --- Browser tier ----------------------------------------------------------

const FORM_FIXTURE_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>form actions fixture</title></head>
  <body>
    <label for="dept">Department</label>
    <select id="dept">
      <option value="">— choose —</option>
      <option value="eng">Engineering</option>
      <option value="sales">Sales</option>
    </select>

    <button id="city-btn" type="button" aria-haspopup="listbox" aria-expanded="false">City</button>
    <ul id="city-list" role="listbox" aria-label="City" hidden>
      <li role="option" tabindex="-1">Bangkok</li>
      <li role="option" tabindex="-1">Chiang Mai</li>
    </ul>

    <label><input id="agree" type="checkbox"> I agree</label>
    <button id="notify" type="button" aria-pressed="false">Notify me</button>

    <label for="search">Search</label>
    <input id="search" type="text" autocomplete="off">
    <div id="suggestions" hidden>Suggested: matches</div>

    <p id="status">idle</p>
    <script>
      const status = (t) => { document.getElementById('status').textContent = t; };
      document.getElementById('dept').addEventListener('change', (e) => status('dept:' + e.target.value));
      const btn = document.getElementById('city-btn');
      const list = document.getElementById('city-list');
      btn.addEventListener('click', () => { list.hidden = !list.hidden; });
      for (const el of list.querySelectorAll('[role="option"]')) {
        el.addEventListener('click', () => { status('city:' + el.textContent.trim()); list.hidden = true; });
      }
      document.getElementById('agree').addEventListener('change', (e) => status(e.target.checked ? 'agreed' : 'unagreed'));
      const notify = document.getElementById('notify');
      notify.addEventListener('click', () => {
        const next = notify.getAttribute('aria-pressed') !== 'true';
        notify.setAttribute('aria-pressed', String(next));
        status('notify:' + next);
      });
      // A field that only reacts per keystroke: fill() sets the value in one
      // programmatic move and fires no per-key keydown, so only real typing
      // can ever reveal the suggestions.
      let keydowns = 0;
      document.getElementById('search').addEventListener('keydown', () => {
        keydowns += 1;
        if (keydowns >= 3) document.getElementById('suggestions').hidden = false;
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

describe('form actions against a real page (CDP)', { skip: skipBrowser }, () => {
  let server: Server;
  let origin: string;
  let dir: string;

  before(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(FORM_FIXTURE_HTML);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    origin = `http://127.0.0.1:${address.port}`;
    dir = await mkdtemp(join(tmpdir(), 'wowlidator-form-'));
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(dir, { recursive: true, force: true });
  });

  it('selects a native <select> option by its visible label', async () => {
    const flow: Flow = {
      name: 'native select',
      baseUrl: origin,
      steps: [
        { action: 'goto', url: '/' },
        { action: 'selectOption', selector: '#dept', value: 'Engineering' },
        { action: 'expectText', selector: '#status', value: 'dept:eng' },
      ],
    };
    const bundle = await runFlow(flow, { cdpUrl: CDP_URL, cachePath: join(dir, 'native.json') });
    assert.equal(bundle.status, 'passed', bundle.error ?? 'native select should pick by label');
  });

  it('opens a custom listbox and picks its option in one step', async () => {
    const flow: Flow = {
      name: 'custom listbox',
      baseUrl: origin,
      steps: [
        { action: 'goto', url: '/' },
        { action: 'selectOption', selector: '#city-btn', value: 'Chiang Mai' },
        { action: 'expectText', selector: '#status', value: 'city:Chiang Mai' },
      ],
    };
    const bundle = await runFlow(flow, { cdpUrl: CDP_URL, cachePath: join(dir, 'custom.json') });
    assert.equal(bundle.status, 'passed', bundle.error ?? 'custom listbox should open and pick');
  });

  it('fails with the option named when the dropdown has no such option', async () => {
    const flow: Flow = {
      name: 'missing option',
      baseUrl: origin,
      steps: [
        { action: 'goto', url: '/' },
        { action: 'selectOption', selector: '#city-btn', value: 'Phuket' },
      ],
    };
    const bundle = await runFlow(flow, {
      cdpUrl: CDP_URL,
      cachePath: join(dir, 'missing.json'),
      fastTimeoutMs: 500,
      healedTimeoutMs: 500,
    });
    assert.notEqual(bundle.status, 'passed');
    const step = bundle.steps.find((s) => s.action === 'selectOption');
    assert.match(step?.error ?? '', /no option named "Phuket"/);
  });

  it('checks and unchecks a native checkbox, verifying the state moved', async () => {
    const flow: Flow = {
      name: 'checkbox',
      baseUrl: origin,
      steps: [
        { action: 'goto', url: '/' },
        { action: 'check', selector: '#agree' },
        { action: 'expectText', selector: '#status', value: 'agreed' },
        { action: 'uncheck', selector: '#agree' },
        { action: 'expectText', selector: '#status', value: 'unagreed' },
      ],
    };
    const bundle = await runFlow(flow, { cdpUrl: CDP_URL, cachePath: join(dir, 'checkbox.json') });
    assert.equal(bundle.status, 'passed', bundle.error ?? 'checkbox should check and uncheck');
  });

  it('checks an aria-pressed toggle through the ARIA fallback, idempotently', async () => {
    const flow: Flow = {
      name: 'aria toggle',
      baseUrl: origin,
      steps: [
        { action: 'goto', url: '/' },
        { action: 'check', selector: '#notify' },
        { action: 'expectAttribute', selector: '#notify', name: 'aria-pressed', value: 'true' },
        // Already on — a second check must be a no-op, not a toggle-off.
        { action: 'check', selector: '#notify' },
        { action: 'expectAttribute', selector: '#notify', name: 'aria-pressed', value: 'true' },
        { action: 'uncheck', selector: '#notify' },
        { action: 'expectAttribute', selector: '#notify', name: 'aria-pressed', value: 'false' },
      ],
    };
    const bundle = await runFlow(flow, { cdpUrl: CDP_URL, cachePath: join(dir, 'toggle.json') });
    assert.equal(bundle.status, 'passed', bundle.error ?? 'aria toggle should honour check/uncheck');
  });

  it('type fires the per-keystroke events fill cannot', async () => {
    const flow: Flow = {
      name: 'typeahead',
      baseUrl: origin,
      steps: [
        { action: 'goto', url: '/' },
        { action: 'type', selector: '#search', value: 'abc' },
        { action: 'expectVisible', selector: '#suggestions' },
        { action: 'expectValue', selector: '#search', value: 'abc' },
      ],
    };
    const bundle = await runFlow(flow, { cdpUrl: CDP_URL, cachePath: join(dir, 'type.json') });
    assert.equal(bundle.status, 'passed', bundle.error ?? 'typing should reveal the suggestions');
  });
});
