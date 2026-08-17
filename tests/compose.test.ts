/**
 * Flow composition (`use`), conditional branches (`when`), and runtime
 * `{{variable}}` interpolation in UI steps — the three things a multi-role
 * journey needs that a flat step list cannot express.
 *
 * Expansion is pure and runs always; branching needs a real page, because the
 * whole question is what the DOM says right now.
 *
 *   npm test                                 # unit + browser (if Chrome is up)
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

import { expandFlow, hasIncludes, FlowCompositionError } from '../src/engine/compose.js';
import { runFlow, type Flow } from '../src/engine/runner.js';

const CDP_URL = process.env['WOWLIDATOR_CDP_URL'] ?? 'http://localhost:9222';

/** In-memory fragment loader, so expansion tests never touch the disk. */
function loader(files: Record<string, unknown>) {
  return async (path: string): Promise<string> => {
    for (const [name, body] of Object.entries(files)) {
      if (path.endsWith(name)) return JSON.stringify(body);
    }
    throw new Error(`no such file: ${path}`);
  };
}

describe('flow composition', () => {
  it('splices a fragment into the caller, in place', async () => {
    const flow: Flow = {
      name: 'uses a fragment',
      steps: [
        { action: 'use', flow: 'act-as.flow.json' },
        { action: 'expectVisible', selector: '#queue' },
      ],
    };
    const expanded = await expandFlow(flow, {
      read: loader({
        'act-as.flow.json': {
          name: 'act as',
          steps: [
            { action: 'click', selector: '#identity' },
            { action: 'click', selector: '#proxy' },
          ],
        },
      }),
    });

    assert.deepEqual(
      expanded.steps.map((s) => s.action),
      ['click', 'click', 'expectVisible'],
    );
    assert.equal(hasIncludes(expanded), false, 'no use steps survive expansion');
  });

  it('substitutes the parameters it was given and leaves the rest for runtime', async () => {
    const flow: Flow = {
      name: 'parameterised',
      steps: [{ action: 'use', flow: 'act-as.flow.json', with: { role: 'HRB001' } }],
    };
    const expanded = await expandFlow(flow, {
      read: loader({
        'act-as.flow.json': {
          name: 'act as',
          steps: [
            { action: 'click', selector: 'role=button[name=/{{role}}/i]' },
            // Not a parameter — this one belongs to the runtime variable store,
            // and substituting it here would break `save` from a request step.
            { action: 'expectText', selector: '#who', value: '{{savedName}}' },
          ],
        },
      }),
    });

    assert.equal(
      (expanded.steps[0] as { selector: string }).selector,
      'role=button[name=/HRB001/i]',
    );
    assert.equal((expanded.steps[1] as { value: string }).value, '{{savedName}}');
  });

  it('expands fragments used inside a when branch', async () => {
    const flow: Flow = {
      name: 'nested',
      steps: [
        {
          action: 'when',
          visible: '#switcher',
          then: [{ action: 'use', flow: 'act-as.flow.json' }],
          else: [{ action: 'goto', url: '/login' }],
        },
      ],
    };
    const expanded = await expandFlow(flow, {
      read: loader({ 'act-as.flow.json': { name: 'act as', steps: [{ action: 'click', selector: '#x' }] } }),
    });

    const when = expanded.steps[0] as { then: { action: string }[]; else: { action: string }[] };
    assert.deepEqual(when.then.map((s) => s.action), ['click']);
    assert.deepEqual(when.else.map((s) => s.action), ['goto']);
  });

  it('runs a fragment setup before its steps', async () => {
    const expanded = await expandFlow(
      { name: 'x', steps: [{ action: 'use', flow: 'f.flow.json' }] },
      {
        read: loader({
          'f.flow.json': {
            name: 'f',
            setup: [{ action: 'goto', url: '/' }],
            steps: [{ action: 'click', selector: '#a' }],
          },
        }),
      },
    );
    assert.deepEqual(expanded.steps.map((s) => s.action), ['goto', 'click']);
  });

  it('refuses a fragment with a teardown rather than dropping or misplacing it', async () => {
    await assert.rejects(
      expandFlow(
        { name: 'x', steps: [{ action: 'use', flow: 'f.flow.json' }] },
        {
          read: loader({
            'f.flow.json': {
              name: 'f',
              steps: [{ action: 'click', selector: '#a' }],
              teardown: [{ action: 'clearStorage' }],
            },
          }),
        },
      ),
      (error: Error) => error instanceof FlowCompositionError && /teardown/.test(error.message),
    );
  });

  it('detects a cycle instead of recursing forever', async () => {
    await assert.rejects(
      expandFlow(
        { name: 'x', steps: [{ action: 'use', flow: 'a.flow.json' }] },
        {
          read: loader({
            'a.flow.json': { name: 'a', steps: [{ action: 'use', flow: 'b.flow.json' }] },
            'b.flow.json': { name: 'b', steps: [{ action: 'use', flow: 'a.flow.json' }] },
          }),
        },
      ),
      (error: Error) => error instanceof FlowCompositionError && /cycle/.test(error.message),
    );
  });

  it('names the fragment it could not load', async () => {
    await assert.rejects(
      expandFlow({ name: 'x', steps: [{ action: 'use', flow: 'missing.flow.json' }] }, { read: loader({}) }),
      (error: Error) => error instanceof FlowCompositionError && /missing\.flow\.json/.test(error.message),
    );
  });
});

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

/** A page whose navigation is client-side and not instant. */
const NAV_FIXTURE_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>nav fixture</title></head>
  <body>
    <!-- Labelled one thing, pointing at another: exactly the case that makes a
         URL guessed from a label wrong. -->
    <a id="card" href="#/destination-route">E-Patient</a>
    <script>
      document.getElementById('card').addEventListener('click', (e) => {
        e.preventDefault();
        // Client-side, and not instant — a router, a transition, a tick.
        setTimeout(() => { location.hash = '#/destination-route'; }, 250);
      });
    </script>
  </body>
</html>`;

/**
 * A page with a role switcher that is only *sometimes* needed — the shape the
 * `when` step exists for. `?role=hrbp` starts already switched.
 */
const ROLE_FIXTURE_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>role fixture</title></head>
  <body>
    <button id="identity" aria-haspopup="menu" aria-expanded="false">Active role: <span id="role">ADMIN</span></button>
    <div id="menu" role="menu" hidden>
      <button id="be-hrbp" role="menuitem">Act as HRBP</button>
    </div>
    <p id="queue" hidden>Review queue</p>
    <script>
      const params = new URLSearchParams(location.search);
      if (params.get('role') === 'hrbp') document.getElementById('role').textContent = 'HRBP';
      document.getElementById('identity').addEventListener('click', () => {
        const menu = document.getElementById('menu');
        menu.hidden = !menu.hidden;
        document.getElementById('identity').setAttribute('aria-expanded', String(!menu.hidden));
      });
      document.getElementById('be-hrbp').addEventListener('click', () => {
        document.getElementById('role').textContent = 'HRBP';
        document.getElementById('menu').hidden = true;
        document.getElementById('queue').hidden = false;
      });
    </script>
  </body>
</html>`;

describe('when + use against a real page (CDP)', { skip: skipBrowser }, () => {
  let server: Server;
  let origin: string;
  let dir: string;

  before(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(ROLE_FIXTURE_HTML);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    dir = await mkdtemp(join(tmpdir(), 'wowlidator-compose-'));

    // A fragment on disk, exactly as a project would keep it.
    await writeFile(
      join(dir, 'act-as.flow.json'),
      JSON.stringify({
        name: 'act as {{role}}',
        steps: [
          {
            action: 'when',
            hidden: 'text={{role}}',
            then: [
              { action: 'click', selector: '#identity', intent: 'Open the identity menu.' },
              { action: 'click', selector: '#be-hrbp', intent: 'Switch role.' },
            ],
          },
        ],
      }),
      'utf8',
    );
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(dir, { recursive: true, force: true });
  });

  it('runs the switch when the role is not already active', async () => {
    const flow: Flow = {
      name: 'needs the switch',
      baseUrl: origin,
      steps: [
        { action: 'goto', url: '/' },
        { action: 'use', flow: 'act-as.flow.json', with: { role: 'HRBP' } },
        { action: 'expectText', selector: '#role', value: 'HRBP' },
      ],
    };
    const bundle = await runFlow(flow, {
      cdpUrl: CDP_URL,
      cachePath: join(dir, 'a.json'),
      flowDir: dir,
      healer: null,
    });

    assert.equal(bundle.status, 'passed', bundle.error ?? 'the switch should have run');
    const when = bundle.steps.find((s) => s.action === 'when');
    assert.equal(when?.detail?.['branch'], 'then');
    // The fragment's two clicks are in the bundle as ordinary steps — a report
    // shows what happened, not "used a fragment".
    assert.equal(bundle.steps.filter((s) => s.action === 'click').length, 2);
  });

  it('skips the switch when the role is already active', async () => {
    const flow: Flow = {
      name: 'already there',
      baseUrl: origin,
      steps: [
        { action: 'goto', url: '/?role=hrbp' },
        { action: 'use', flow: 'act-as.flow.json', with: { role: 'HRBP' } },
        { action: 'expectText', selector: '#role', value: 'HRBP' },
      ],
    };
    const bundle = await runFlow(flow, {
      cdpUrl: CDP_URL,
      cachePath: join(dir, 'b.json'),
      flowDir: dir,
      healer: null,
    });

    assert.equal(bundle.status, 'passed', bundle.error ?? 'the flow should pass without switching');
    const when = bundle.steps.find((s) => s.action === 'when');
    assert.equal(when?.detail?.['branch'], 'else');
    assert.equal(bundle.steps.filter((s) => s.action === 'click').length, 0, 'no clicks needed');
  });

  it('never fails on a condition selector that resolves to nothing', async () => {
    const flow: Flow = {
      name: 'absent condition',
      baseUrl: origin,
      steps: [
        { action: 'goto', url: '/' },
        {
          action: 'when',
          visible: '#nothing-like-this-exists',
          then: [{ action: 'click', selector: '#identity' }],
        },
        { action: 'expectVisible', selector: '#identity' },
      ],
    };
    const bundle = await runFlow(flow, {
      cdpUrl: CDP_URL,
      cachePath: join(dir, 'c.json'),
      flowDir: dir,
      healer: null,
    });

    // A probe is not an assertion: an unresolvable condition is "false", not a
    // failure, and emphatically not something to heal onto another element.
    assert.equal(bundle.status, 'passed', bundle.error ?? 'an absent condition is just false');
    const when = bundle.steps.find((s) => s.action === 'when');
    assert.equal(when?.status, 'passed');
    assert.equal(when?.detail?.['matched'], false);
    assert.equal(bundle.summary.jitHeals, 0, 'a condition must never reach the healer');
  });
});

describe('expectUrl waits for navigation (CDP)', { skip: skipBrowser }, () => {
  let server: Server;
  let origin: string;
  let dir: string;

  before(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(NAV_FIXTURE_HTML);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    dir = await mkdtemp(join(tmpdir(), 'wowlidator-nav-'));
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(dir, { recursive: true, force: true });
  });

  it('waits for a client-side navigation instead of reading the old URL', async () => {
    // Found against a real app: `click` returns when the click lands, not when
    // the router finishes, so a synchronous `page.url()` read lost this race
    // every time — in under a millisecond, blaming the old URL.
    const flow: Flow = {
      name: 'navigate then assert',
      baseUrl: origin,
      steps: [
        { action: 'goto', url: '/' },
        { action: 'click', selector: '#card', intent: 'Open the destination.' },
        { action: 'expectUrl', value: 'destination-route', intent: 'The URL is the destination.' },
      ],
    };
    const bundle = await runFlow(flow, {
      cdpUrl: CDP_URL,
      cachePath: join(dir, 'nav.json'),
      healer: null,
      historyPath: null,
    });

    assert.equal(bundle.status, 'passed', bundle.error ?? 'expectUrl should wait for the router');
  });

  it('still fails, naming the current URL, when the navigation never happens', async () => {
    const flow: Flow = {
      name: 'never navigates',
      baseUrl: origin,
      steps: [
        { action: 'goto', url: '/' },
        { action: 'expectUrl', value: 'somewhere-else', intent: 'A place this app never goes.' },
      ],
    };
    const bundle = await runFlow(flow, {
      cdpUrl: CDP_URL,
      cachePath: join(dir, 'nav2.json'),
      healer: null,
      historyPath: null,
    });

    assert.equal(bundle.status, 'failed');
    const step = bundle.steps.find((s) => s.action === 'expectUrl');
    // The diagnostic value of this step is "expected X, got Y" — a bare
    // timeout message would be a regression even though it fails either way.
    assert.match(step?.error ?? '', /expected url to contain "somewhere-else", got "http/);
  });
});
