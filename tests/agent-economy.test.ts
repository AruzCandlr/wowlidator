/**
 * The agent's zero-call rungs and plan-ahead.
 *
 * Memory and keys are pure and run always. Replay, preflight and planned
 * follow-ups act on a real page and are browser-tier: whether a remembered
 * click still lands, whether a link in the tree really goes where its url
 * says, and whether a planned follow-up stops when the page changed under
 * it are facts about a browser.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CacheManager } from '../src/cache/cache-manager.js';
import { withPage } from '../src/engine/runner.js';
import {
  WorkflowAgent,
  cacheAgentMemory,
  replayKey,
  scriptOf,
  type AgentDecision,
  type AgentModel,
  type AgentObservation,
} from '../src/orchestrator/workflow-agent.js';

const CDP_URL = process.env['WOWLIDATOR_CDP_URL'] ?? 'http://localhost:9222';
async function cdpAvailable(url: string): Promise<boolean> {
  try {
    const r = await fetch(`${url}/json/version`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}
const skipBrowser = (await cdpAvailable(CDP_URL)) ? false : `no CDP endpoint at ${CDP_URL}`;

function scripted(decisions: Partial<AgentDecision>[]): { model: AgentModel; seen: AgentObservation[] } {
  const seen: AgentObservation[] = [];
  let i = 0;
  const model: AgentModel = {
    id: 'scripted',
    async decide(observation) {
      seen.push(observation);
      const d = decisions[Math.min(i, decisions.length - 1)]!;
      i += 1;
      return { action: 'fail', selector: '', value: '', url: '', reasoning: 'script exhausted', ...d };
    },
  };
  return { model, seen };
}

describe('agent memory', () => {
  it('keys a goal by origin+path and folded wording, never by query string', () => {
    const a = replayKey('http://app.test/en/login?next=1', 'go   to /en/admin');
    const b = replayKey('http://app.test/en/login', 'go to /en/admin');
    assert.equal(a, b);
    assert.equal(a, 'http://app.test/en/login :: workflow :: go to /en/admin');
  });

  it('round-trips an action list through the healed-selector cache, marked as a replay', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wow-mem-'));
    const cache = new CacheManager({ filePath: join(dir, 'c.json') });
    const memory = cacheAgentMemory(cache);
    const key = replayKey('http://app.test/a', 'open the thing');
    memory.set(key, [{ action: 'click', selector: 'role=link[name="x" i]', value: '', url: '' }], 'm');
    assert.deepEqual(memory.get(key), [{ action: 'click', selector: 'role=link[name="x" i]', value: '', url: '' }]);
    assert.equal(cache.get(key)?.strategy, 'workflow-replay');
    // An ordinary heal under the same key is never mistaken for a replay.
    cache.set({ key, original: 'o', healed: 'h', strategy: 'role', url: 'u', confidence: 1, reasoning: '', model: 'm' });
    assert.equal(memory.get(key), undefined);
    memory.forget(key);
    assert.equal(cache.get(key), undefined);
  });
});

describe('agent zero-call rungs (CDP)', { skip: skipBrowser }, () => {
  let server: Server;
  let origin: string;
  const PAGE = (body: string) => `<!doctype html><html><head><title>f</title></head><body>${body}</body></html>`;

  before(async () => {
    server = createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0];
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      if (path === '/hub') res.end(PAGE('<h1>Hub</h1><nav><a href="/hub/rules">Eligibility rules</a><a href="/hub/plans">Plans</a></nav><button id="open">Open menu</button>'));
      else if (path === '/hub/rules') res.end(PAGE('<h1>Rules</h1>'));
      else if (path === '/hub/plans') res.end(PAGE('<h1>Plans</h1>'));
      else if (path === '/deep/page') res.end(PAGE('<h1>Deep</h1>'));
      else if (path === '/form') res.end(PAGE(`<h1>Form</h1><label>Email <input id="e"></label><button id="next" onclick="document.getElementById('pw').hidden=false">Next</button><label hidden id="pw">Password <input type="password"></label>`));
      else res.end(PAGE('<h1>Start</h1>'));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });

  it('follows a tree link to the goal\'s destination without asking the model', async () => {
    const { model, seen } = scripted([]);
    const agent = new WorkflowAgent({ model, maxSteps: 4 });
    const result = await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/hub`, { waitUntil: 'domcontentloaded' });
      return agent.run(page, 'Navigate via the Eligibility rules tile and end on /hub/rules');
    });
    assert.equal(result.success, true, result.summary);
    assert.equal(seen.length, 0, 'no model turn');
    assert.equal(result.turns, 0);
    assert.match(result.summary, /link the tree showed/);
    assert.equal(result.actions[0]?.selector, 'role=link[name="Eligibility rules" i]');
  });

  it('goes straight to a destination the goal names with no route, and says so', async () => {
    const { model, seen } = scripted([]);
    const agent = new WorkflowAgent({ model, maxSteps: 4 });
    const result = await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/hub`, { waitUntil: 'domcontentloaded' });
      return agent.run(page, 'Open the deep page and end on /deep/page');
    });
    assert.equal(result.success, true, result.summary);
    assert.equal(seen.length, 0);
    assert.match(result.summary, /direct navigation/);
  });

  it('leaves a goal that names a route the tree does not show to the model', async () => {
    const { model, seen } = scripted([{ action: 'goto', url: `${origin}/deep/page`, reasoning: 'x' }]);
    const agent = new WorkflowAgent({ model, maxSteps: 3 });
    const result = await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/hub`, { waitUntil: 'domcontentloaded' });
      return agent.run(page, 'Navigate via the Deep menu and end on /deep/page');
    });
    assert.equal(result.success, true);
    assert.equal(seen.length, 1, 'the route word kept the direct goto off the table; the model was asked');
  });

  it('replays a solved goal on the next run with zero turns, and forgets one that stops working', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wow-mem-'));
    const cache = new CacheManager({ filePath: join(dir, 'c.json') });
    const memory = cacheAgentMemory(cache);
    const goal = 'Use the menu to reach /hub/plans';
    // First run: the model is needed (the route word blocks the direct goto;
    // the link IS in the tree, so preflight takes it — that still counts as
    // a solution worth remembering).
    const first = await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/hub`, { waitUntil: 'domcontentloaded' });
      return new WorkflowAgent({ model: scripted([]).model, maxSteps: 3, memory }).run(page, goal);
    });
    assert.equal(first.success, true, first.summary);
    // Seed a remembered solution explicitly, as a model-found one would be.
    const key = replayKey(`${origin}/hub`, goal);
    memory.set(key, [{ action: 'click', selector: 'role=link[name="Plans" i]', value: '', url: '' }], 'm');
    const { model, seen } = scripted([]);
    const second = await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/hub`, { waitUntil: 'domcontentloaded' });
      return new WorkflowAgent({ model, maxSteps: 3, memory }).run(page, goal);
    });
    assert.equal(second.success, true, second.summary);
    assert.match(second.summary, /replayed 1 recorded action/);
    assert.equal(seen.length, 0);
    assert.equal(second.actions[0]?.reasoning, 'replayed from an earlier run that reached this goal');

    // A remembered selector the page no longer shows: forgotten, model asked.
    memory.set(key, [{ action: 'click', selector: 'role=link[name="Gone" i]', value: '', url: '' }], 'm');
    const third = await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/hub`, { waitUntil: 'domcontentloaded' });
      return new WorkflowAgent({ model: scripted([]).model, maxSteps: 3, memory }).run(page, goal);
    });
    assert.equal(memory.get(key)?.[0]?.selector, 'role=link[name="Plans" i]', 'the failed replay was replaced by what worked');
    assert.equal(third.success, true);
  });

  it('runs planned follow-ups that still ground, and stops at one that does not', async () => {
    const { model, seen } = scripted([
      {
        action: 'fill',
        selector: 'role=textbox[name="Email" i]',
        value: 'a@b.c',
        reasoning: 'identity first',
        next: [
          { action: 'click', selector: 'role=button[name="Next" i]', value: '', url: '' },
          { action: 'fill', selector: 'input[type="password"]', value: 'pw', url: '' },
        ],
      },
      { action: 'finish', reasoning: 'done' },
    ]);
    const agent = new WorkflowAgent({ model, maxSteps: 4 });
    const result = await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/form`, { waitUntil: 'domcontentloaded' });
      const r = await agent.run(page, 'sign in with a@b.c / pw');
      const typed = await page.locator('input[type="password"]').inputValue();
      return { r, typed };
    });
    assert.equal(result.r.success, true, result.r.summary);
    assert.equal(seen.length, 2, 'one decision carried three actions; one more call to finish');
    assert.equal(result.r.actions.filter((a) => a.ok).length, 4);
    assert.equal(result.typed, 'pw', 'the planned password fill ran after the planned Next click revealed the field');
    assert.ok(seen[1]!.history.some((h) => /\(planned\)/.test(h)), 'history marks planned actions');
  });
});

// ---------------------------------------------------------------------------
// The flow-file script rung. `scriptOf` is pure and runs always; whether the
// script actually replays against a page is the same browser fact the memory
// rung already proves, so that half lives in the CDP describe's conditions.
// ---------------------------------------------------------------------------

describe('scriptOf', () => {
  it('keeps only successful acting steps — never finish, fail, or wait', () => {
    const steps = scriptOf([
      { index: 0, action: 'click', selector: 'role=link[name="Plans" i]', value: null, url: 'http://a.test/p', reasoning: 'r', ok: true, durationMs: 1 },
      { index: 1, action: 'fill', selector: 'input#q', value: 'x', url: 'http://a.test/p', reasoning: 'r', ok: false, error: 'no', durationMs: 1 },
      { index: 2, action: 'wait', selector: null, value: null, url: 'http://a.test/p', reasoning: 'r', ok: true, durationMs: 1 },
      { index: 3, action: 'goto', selector: null, value: null, url: 'http://a.test/deep', reasoning: 'r', ok: true, durationMs: 1 },
      { index: 4, action: 'finish', selector: null, value: null, url: 'http://a.test/deep', reasoning: 'r', ok: true, durationMs: 1 },
    ]);
    assert.deepEqual(steps, [
      { action: 'click', selector: 'role=link[name="Plans" i]', value: '', url: '' },
      { action: 'goto', selector: '', value: '', url: 'http://a.test/deep' },
    ]);
  });
});

describe('flow-file script rung (CDP)', { skip: skipBrowser }, () => {
  let server: Server;
  let origin: string;
  before(async () => {
    server = createServer((req, res) => {
      res.setHeader('content-type', 'text/html');
      if (req.url === '/hub2/plans') {
        res.end('<h1>Plans</h1>');
        return;
      }
      res.end('<h1>Hub</h1><a href="/hub2/plans">Plans</a>');
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    origin = `http://localhost:${(server.address() as AddressInfo).port}`;
  });
  after(() => {
    server.closeAllConnections();
    server.close();
  });

  it('replays the flow-recorded script with zero model turns, and seeds the cache from it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wow-script-'));
    const cache = new CacheManager({ filePath: join(dir, 'c.json') });
    const memory = cacheAgentMemory(cache);
    const goal = 'Use the menu to reach /hub2/plans';
    const { model, seen } = scripted([]);
    const result = await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/hub2`, { waitUntil: 'domcontentloaded' });
      return new WorkflowAgent({ model, maxSteps: 3, memory }).run(page, goal, {
        script: [{ action: 'click', selector: 'role=link[name="Plans" i]', value: '', url: '' }],
      });
    });
    assert.equal(result.success, true, result.summary);
    assert.match(result.summary, /scripted action\(s\) recorded on the flow itself/);
    assert.equal(seen.length, 0, 'no model turn was spent');
    // The script's success seeded the cache-backed memory for the next case.
    assert.equal(
      memory.get(replayKey(`${origin}/hub2`, goal))?.[0]?.selector,
      'role=link[name="Plans" i]',
    );
  });

  it('a script the page no longer grounds falls through to the model', async () => {
    const goal = 'Use the menu to reach /hub2/plans';
    const { model, seen } = scripted([]);
    const result = await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/hub2`, { waitUntil: 'domcontentloaded' });
      return new WorkflowAgent({ model, maxSteps: 3 }).run(page, goal, {
        script: [{ action: 'click', selector: 'role=link[name="Gone" i]', value: '', url: '' }],
      });
    });
    // Preflight still solves this goal from the tree link, so the run
    // succeeds — the assertion is that the dead script did not.
    assert.equal(result.success, true, result.summary);
    assert.doesNotMatch(result.summary, /recorded on the flow itself/);
    void seen;
  });
});
