/**
 * Integration smoke test.
 *
 * Unit-level assertions (cache, proof bundle) always run. The browser-backed
 * tests exercise the real escalation ladder — fast path, JIT heal, cache hit —
 * against a live page, and are skipped when no CDP endpoint is listening.
 *
 *   npm test                                 # unit + browser (if Chrome is up)
 *   WOWLIDATOR_CDP_URL=http://localhost:9222 npm test
 *   GROQ_API_KEY=... npm test                # also runs the live-model test
 *
 * Single test: npx tsx --test --test-name-pattern "heals a drifted" tests/smoke.test.ts
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

import { jsonModel, nonJsonModel } from './helpers.js';

import { CacheManager, type HealedSelectorCacheFile } from '../src/cache/cache-manager.js';
import { PROVIDER_META, loadConfig } from '../src/config.js';
import { ProofBundleBuilder, formatStepLine, isPassing, type ProofStep } from '../src/engine/proof-bundle.js';
import {
  NATIVE_SUBMIT_UNNAMED,
  StepResolutionError,
  fillsLostToHydration,
  nativeFormResubmitDetected,
  signInDidNotTakeMessage,
  parseInterception,
  runFlow,
  scriptMismatchNote,
  type Flow,
  type FlowStep,
} from '../src/engine/runner.js';
import {
  LlmHealerModel,
  JitHealer,
  type HealRequest,
  type HealSuggestion,
  type HealerModel,
} from '../src/healer/jit-healer.js';

const CDP_URL = process.env['WOWLIDATOR_CDP_URL'] ?? 'http://localhost:9222';

const FIXTURE_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>wowlidator fixture</title></head>
  <body>
    <h1>wowlidator fixture</h1>
    <button id="signin" type="button">Sign in</button>
    <input id="username" aria-label="Username" placeholder="Username">
    <p id="status">Signed out</p>
    <script>
      document.getElementById('signin').addEventListener('click', () => {
        document.getElementById('status').textContent = 'Signed in as alice';
      });
    </script>
  </body>
</html>`;

/** Deterministic, $0 stand-in for the configured healer provider. */
class StubHealerModel implements HealerModel {
  readonly id = 'stub-healer';
  readonly calls: HealRequest[] = [];

  readonly #reply: (request: HealRequest) => HealSuggestion;

  constructor(reply: (request: HealRequest) => HealSuggestion) {
    this.#reply = reply;
  }

  async suggest(request: HealRequest): Promise<HealSuggestion> {
    this.calls.push(request);
    return this.#reply(request);
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

// --- Control plane never touched -------------------------------------------

describe('cache-manager', () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wowlidator-cache-'));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips a repair through disk and scopes keys by url path', async () => {
    const path = join(dir, 'healed-selectors.json');
    const key = CacheManager.key('https://example.test/login?next=/home', '#login');

    assert.equal(key, 'https://example.test/login :: #login', 'query string must not affect key');
    assert.notEqual(key, CacheManager.key('https://example.test/settings', '#login'));

    const writer = new CacheManager({ filePath: path });
    await writer.load();
    writer.set({
      key,
      original: '#login',
      healed: 'role=button[name="Sign in"]',
      strategy: 'role',
      url: 'https://example.test/login',
      confidence: 0.92,
      reasoning: 'only button with that accessible name',
      model: 'stub-healer',
    });
    await writer.flush();

    const reader = new CacheManager({ filePath: path });
    await reader.load();
    const entry = reader.get(key);
    assert.ok(entry, 'entry should survive a reload');
    assert.equal(entry.healed, 'role=button[name="Sign in"]');
    assert.equal(entry.hits, 0);

    reader.recordUse(key);
    await reader.flush();

    const parsed = JSON.parse(await readFile(path, 'utf8')) as HealedSelectorCacheFile;
    assert.equal(parsed.entries[key]?.hits, 1);

    assert.equal(reader.delete(key), true);
    await reader.flush();
    const afterDelete = new CacheManager({ filePath: path });
    await afterDelete.load();
    assert.equal(afterDelete.size, 0);
  });

  // Two cases of one suite, running side by side, each holding its own
  // manager loaded at its own start. Before the merge-on-flush, the second
  // flush wrote its snapshot over the first's and a repair that had just been
  // paid for vanished; and the temp file was named by pid, identical for both.
  it('two concurrent managers on one file keep each other\'s repairs', async () => {
    const path = join(dir, 'shared.json');
    const entry = (key: string, healed: string) => ({
      key,
      original: key.split(' :: ')[1]!,
      healed,
      strategy: 'role',
      url: 'https://example.test/p',
      confidence: 0.9,
      reasoning: 'r',
      model: 'stub',
    });
    const a = new CacheManager({ filePath: path });
    const b = new CacheManager({ filePath: path });
    await a.load();
    await b.load();
    a.set(entry('https://example.test/p :: #a', 'role=button[name="A"]'));
    b.set(entry('https://example.test/p :: #b', 'role=button[name="B"]'));
    // Flushed together, as siblings finishing at once do.
    await Promise.all([a.flush(), b.flush()]);

    const reader = new CacheManager({ filePath: path });
    await reader.load();
    assert.equal(reader.size, 2, 'neither repair may clobber the other');
    assert.equal(reader.get('https://example.test/p :: #a')?.healed, 'role=button[name="A"]');
    assert.equal(reader.get('https://example.test/p :: #b')?.healed, 'role=button[name="B"]');

    // A later delete by one side must not resurrect from the other's stale view.
    assert.equal(a.delete('https://example.test/p :: #a'), true);
    await a.flush();
    b.recordUse('https://example.test/p :: #b');
    await b.flush();
    const after = new CacheManager({ filePath: path });
    await after.load();
    assert.equal(after.has('https://example.test/p :: #a'), false, 'the delete must hold');
    assert.equal(after.get('https://example.test/p :: #b')?.hits, 1);
  });

  it('starts empty rather than throwing on a corrupt cache file', async () => {
    const path = join(dir, 'corrupt.json');
    await (await import('node:fs/promises')).writeFile(path, '{ not json', 'utf8');
    const cache = new CacheManager({ filePath: path, warn: false });
    await cache.load();
    assert.equal(cache.size, 0);
  });
});

describe('scriptMismatchNote', () => {
  it('flags a Latin expectation against a Thai rendering, in both directions', () => {
    assert.match(scriptMismatchNote('Somchai Sukjai', 'พนักงาน สมชาย สุขใจ'), /different script/);
    assert.match(scriptMismatchNote('สมชาย สุขใจ', 'Employee Somchai Sukjai'), /different script/);
  });

  it('stays silent when the scripts agree — most failures are not language', () => {
    assert.equal(scriptMismatchNote('Somchai Sukjai', 'Employee Alice Anders'), '');
    assert.equal(scriptMismatchNote('4 days', 'Overdue 54 days'), '');
    // Mixed-script expected text makes no single-language claim to cross.
    assert.equal(scriptMismatchNote('ไม่มีสิทธิ์ · Access Denied', 'anything'), '');
  });
});

describe('parseInterception', () => {
  const LOG = [
    'locator.click: Timeout 2000ms exceeded.',
    'Call log:',
    '  - waiting for locator(\'role=link[name="Contact"]\')',
    '    - locator resolved to <a target="_blank" href="/contactus">Contact</a>',
    '  - attempting click action',
    '    - <div class="ui dimmer modals page animating transition fade in">…</div> intercepts pointer events',
  ].join('\n');

  it('names the blocker from the interception line, never the resolved element', () => {
    // A lazy match across the whole log names the <a> the click resolved to
    // — the exact opposite of the blocker. Found live on homepro.co.th.
    const parsed = parseInterception(LOG);
    assert.equal(parsed?.css, 'div.ui.dimmer.modals', 'animation-state classes are filtered out');
    assert.equal(parsed?.label, 'div.ui.dimmer.modals');
  });

  it('returns null for a failure that names no interception', () => {
    assert.equal(parseInterception('locator.click: Timeout 2000ms exceeded.'), null);
  });

  it('falls back to an Escape-only descriptor for a classless blocker', () => {
    const parsed = parseInterception('  - <div>x</div> intercepts pointer events');
    assert.equal(parsed?.css, null);
    assert.equal(parsed?.label, '<div> overlay');
  });
});

describe('proof-bundle', () => {
  it('summarises resolution sources and token cost', () => {
    const builder = new ProofBundleBuilder({ name: 'demo', healerModel: 'stub-healer' });
    const base = { startedAt: new Date().toISOString(), durationMs: 5, url: 'https://example.test' };

    builder.addStep({ action: 'click', selector: '#a', resolvedSelector: '#a', resolution: 'fast', status: 'passed', ...base });
    builder.addStep({ action: 'click', selector: '#b', resolvedSelector: '#b2', resolution: 'cache', status: 'passed', ...base });
    builder.addStep({
      action: 'click',
      selector: '#c',
      resolvedSelector: 'role=button[name="C"]',
      resolution: 'jit',
      status: 'passed',
      ...base,
      heal: {
        from: '#c',
        to: 'role=button[name="C"]',
        strategy: 'role',
        confidence: 0.9,
        reasoning: 'matched by name',
        model: 'stub-healer',
        latencyMs: 320,
        inputTokens: 800,
        outputTokens: 60,
      },
    });
    builder.addStep({ action: 'click', selector: '#d', resolvedSelector: null, resolution: null, status: 'failed', ...base, error: 'boom' });

    const bundle = builder.finish();
    assert.equal(bundle.status, 'failed');
    assert.deepEqual(bundle.summary, {
      totalSteps: 4,
      passed: 3,
      failed: 1,
      // No API steps in this bundle, so every step lands on the frontend side.
      frontend: { steps: 4, passed: 3, failed: 1, defects: 0 },
      backend: { steps: 0, passed: 0, failed: 0, defects: 0 },
      fastPath: 1,
      caseRetries: 0,
      cacheHits: 1,
      jitHeals: 1,
      dialogsDismissed: 0,
      agentTakeovers: 0,
      visualChecks: 0,
      visualFailures: 0,
      dataRetries: 0,
      apiRequests: 0,
      apiFailures: 0,
      dbChecks: 0,
      dbFailures: 0,
      // No observer was attached to this builder, so the network totals stay
      // at zero — which is the honest answer for "nothing was watching",
      // distinct from a run that watched and saw nothing.
      networkCalls: 0,
      networkFailures: 0,
      backendBlocked: 0,
      healUnavailable: 0,
      networkDropped: 0,
      healLatencyMs: 320,
      agentLatencyMs: 0,
      inputTokens: 800,
      outputTokens: 60,
      defects: 0,
    });
    assert.equal(bundle.steps[0]?.index, 0);
    assert.equal(bundle.steps[3]?.index, 3);
  });

  it('clusters identical runtime defects instead of filing one per occurrence', () => {
    const builder = new ProofBundleBuilder({ name: 'clustered' });
    const defect = (stepIndex: number) => ({
      id: `d${stepIndex}`,
      severity: 'high' as const,
      category: 'functional' as const,
      title: 'Step failed: fill role=textbox >> nth=1',
      detail: 'could not resolve',
      selector: 'role=textbox >> nth=1',
      stepIndex,
      source: 'runtime' as const,
    });
    builder.addDefect(defect(2));
    builder.addDefect(defect(7));
    builder.addDefect(defect(12));
    // A different selector is a different finding — it must not fold in.
    builder.addDefect({ ...defect(20), id: 'other', title: 'Step failed: expectVisible text=X', selector: 'text=X' });
    // Generator findings never cluster: each is its own static observation.
    builder.addDefect({ ...defect(0), id: 'g1', source: 'generator' });
    builder.addDefect({ ...defect(0), id: 'g2', source: 'generator' });

    const bundle = builder.finish();
    assert.equal(bundle.defects.length, 4);
    const clustered = bundle.defects[0]!;
    assert.equal(clustered.occurrences, 3);
    assert.deepEqual(clustered.stepIndexes, [2, 7, 12]);
    // The summary counts clusters, and the halves still reconcile.
    assert.equal(bundle.summary.defects, 4);
    assert.equal(
      bundle.summary.frontend.defects + bundle.summary.backend.defects,
      bundle.summary.defects,
    );
  });

  it('marks failures after the first as downstream — consequences, not findings', () => {
    const builder = new ProofBundleBuilder({ name: 'downstream' });
    const base = { selector: null, resolvedSelector: null, resolution: null, startedAt: new Date().toISOString(), durationMs: 5, url: 'https://x.test' };
    builder.addStep({ action: 'goto', status: 'passed', ...base });
    builder.addStep({ action: 'click', status: 'failed', ...base });
    builder.addStep({ action: 'expectText', status: 'passed', ...base });
    builder.addStep({ action: 'expectVisible', status: 'failed', ...base });

    const bundle = builder.finish();
    assert.equal(bundle.steps[1]?.downstream, undefined, 'the first failure is the finding');
    assert.equal(bundle.steps[3]?.downstream, true, 'later failures may be consequences');
    assert.equal(bundle.steps[2]?.downstream, undefined, 'a pass is never downstream');
  });

  it('strips video offsets that point past the end of the cut recording', () => {
    // PB-02-01: the recording was cut at the first failure (23.8s) but fifteen
    // later steps carried offsets up to 128s — every one a dead "play from
    // here". Offsets are reconciled when the recording is sealed.
    const builder = new ProofBundleBuilder({ name: 'cut' });
    const started = Date.now();
    builder.setVideoStart(started);
    const step = (offsetMs: number, status: 'passed' | 'failed' = 'passed') => ({
      action: 'click',
      selector: '#x',
      resolvedSelector: '#x',
      resolution: 'fast' as const,
      status,
      startedAt: new Date(started + offsetMs).toISOString(),
      durationMs: 5,
      url: 'https://x.test',
    });
    builder.addStep(step(100));
    builder.addStep(step(5_000, 'failed'));
    builder.addStep(step(60_000));
    builder.setVideo({ width: 960, height: 540, bytes: 1000, durationMs: 24_000, endsAtStep: 1 });

    const bundle = builder.finish();
    assert.equal(bundle.steps[0]?.videoOffsetMs, 100);
    assert.equal(bundle.steps[1]?.videoOffsetMs, 5_000);
    assert.equal(bundle.steps[2]?.videoOffsetMs, undefined, 'no offset may outlive the cut');
  });

  it('calls onStep live, once per addStep, with the recorded step', () => {
    const seen: ProofStep[] = [];
    const builder = new ProofBundleBuilder({ name: 'demo', onStep: (step) => seen.push(step) });
    const base = { startedAt: new Date().toISOString(), durationMs: 5, url: 'https://example.test' };

    builder.addStep({ action: 'click', selector: '#a', resolvedSelector: '#a', resolution: 'fast', status: 'passed', ...base });
    builder.addStep({ action: 'click', selector: '#b', resolvedSelector: null, resolution: null, status: 'failed', ...base, error: 'boom' });

    assert.equal(seen.length, 2, 'onStep must fire synchronously, not only once the bundle is sealed');
    assert.equal(seen[0]?.status, 'passed');
    assert.equal(seen[1]?.status, 'failed');
    assert.equal(seen[1]?.index, 1);
  });
});

describe('formatStepLine', () => {
  const base = {
    index: 2,
    selector: 'role=button[name="Edit"]',
    startedAt: new Date().toISOString(),
    durationMs: 42,
    url: 'https://example.test',
  };

  it('marks a passing fast-path step, with intent on its own line', () => {
    const line = formatStepLine({
      ...base,
      action: 'click',
      intent: 'Open the edit dialog',
      resolvedSelector: 'role=button[name="Edit"]',
      resolution: 'fast',
      status: 'passed',
    });
    assert.match(line, /^✓ \[2\] click role=button\[name="Edit"\] \(42ms\)$/m);
    assert.match(line, /^ {6}Open the edit dialog$/m);
  });

  it('tags a healed step with its resolution source', () => {
    const line = formatStepLine({
      ...base,
      action: 'click',
      resolvedSelector: 'role=button[name="Edit"] >> nth=0',
      resolution: 'jit',
      status: 'passed',
    });
    assert.match(line, /\(jit, 42ms\)/);
  });

  it('marks a failing step and includes the first line of its error', () => {
    const line = formatStepLine({
      ...base,
      action: 'click',
      resolvedSelector: null,
      resolution: null,
      status: 'failed',
      error: 'could not resolve "role=button[name=\\"Edit\\"]" after 2 attempt(s):\n  - fast: timed out',
    });
    assert.match(line, /^✗ \[2\]/m);
    assert.match(line, /could not resolve .*after 2 attempt\(s\):$/m);
    assert.doesNotMatch(line, /- fast: timed out/, 'only the first line of a multi-line error belongs in a live log line');
  });

  it('omits the intent line entirely when there is none', () => {
    const line = formatStepLine({
      ...base,
      action: 'goto',
      selector: null,
      resolvedSelector: null,
      resolution: null,
      status: 'passed',
    });
    assert.equal(line.split('\n').length, 1);
  });
});

describe('LlmHealerModel', () => {
  /**
   * Pins the healer's contract with the AI SDK without spending tokens: the
   * mock model stands in for whichever free provider the `healer` role points
   * at, so the schema, the prompt contents, and the usage mapping are all
   * exercised for real.
   */
  it('sends a structured request and clamps an out-of-range confidence', async () => {
    const model = jsonModel(
      'mock-healer',
      {
              selector: 'role=button[name="Sign in"]',
              strategy: 'role',
              // Deliberately out of range — smaller models do this constantly.
              confidence: 1.4,
              reasoning: 'only button with that accessible name',
      },
      { inputTokens: 640, outputTokens: 48 },
    );

    const healer = new LlmHealerModel({ model, id: 'mock:healer' });
    const suggestion = await healer.suggest({
      failedSelector: '#login',
      intent: 'the sign in button',
      action: 'click',
      url: 'https://example.test/login',
      axTree: 'button "Sign in"',
    });

    assert.equal(suggestion.selector, 'role=button[name="Sign in"]');
    assert.equal(suggestion.strategy, 'role');
    assert.equal(suggestion.confidence, 1, 'confidence must be clamped into 0-1');
    assert.equal(suggestion.inputTokens, 640);
    assert.equal(suggestion.outputTokens, 48);

    // The AX tree and the failed selector must actually reach the model.
    const call = model.doGenerateCalls[0];
    assert.ok(call);
    assert.equal(call.responseFormat?.type, 'json', 'must request schema-constrained JSON');
    const prompt = JSON.stringify(call.prompt);
    assert.match(prompt, /#login/);
    assert.match(prompt, /Sign in/);
    assert.match(prompt, /the sign in button/);
  });

  it('surfaces the model label when structured output fails', async () => {
    const model = nonJsonModel('mock-healer');

    const healer = new LlmHealerModel({ model, id: 'groq:some-free-model', maxRetries: 0 });
    await assert.rejects(
      () =>
        healer.suggest({
          failedSelector: '#login',
          action: 'click',
          url: 'https://example.test/login',
          axTree: 'button "Sign in"',
        }),
      // The error must name the model, or you cannot tell which role broke.
      /groq:some-free-model failed to produce a valid structured response/,
    );
  });
});

// --- Browser-backed escalation ladder --------------------------------------

const browserReady = await cdpAvailable(CDP_URL);
const skipBrowser = browserReady
  ? false
  : `no CDP endpoint at ${CDP_URL} — start Chrome with --remote-debugging-port=9222 (npm run chrome)`;

describe('runner (CDP)', { skip: skipBrowser }, () => {
  let server: Server;
  let origin: string;
  let dir: string;

  before(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(FIXTURE_HTML);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    origin = `http://127.0.0.1:${address.port}`;
    dir = await mkdtemp(join(tmpdir(), 'wowlidator-run-'));
  });

  after(async () => {
    // Chrome holds keep-alive sockets open; without this close() blocks for ~60s.
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(dir, { recursive: true, force: true });
  });

  it('runs a standard flow entirely on the fast path', async () => {
    const healerModel = new StubHealerModel(() => {
      throw new Error('healer must not be reached on a standard run');
    });

    const flow: Flow = {
      name: 'standard',
      baseUrl: origin,
      steps: [
        { action: 'goto', url: '/' },
        { action: 'fill', selector: '#username', value: 'alice' },
        { action: 'click', selector: '#signin' },
        { action: 'expectText', selector: '#status', value: 'Signed in as alice' },
      ],
    };

    const bundle = await runFlow(flow, {
      cdpUrl: CDP_URL,
      cachePath: join(dir, 'standard.json'),
      makeHealer: (cache) => new JitHealer({ model: healerModel, cache }),
    });

    assert.equal(bundle.status, 'passed', bundle.error ?? 'run should pass');
    assert.equal(bundle.summary.failed, 0);
    assert.equal(bundle.summary.jitHeals, 0);
    assert.equal(bundle.summary.cacheHits, 0);
    // goto has no selector, so only the three selector steps count as fast path.
    assert.equal(bundle.summary.fastPath, 3);
    assert.equal(healerModel.calls.length, 0, 'control plane must stay idle');
  });

  it("carries the author's intent from flow.json onto the proof bundle, for both ladder and bare steps", async () => {
    const flow: Flow = {
      name: 'intent-carry',
      baseUrl: origin,
      steps: [
        { action: 'goto', url: '/' },
        { action: 'click', selector: '#signin', intent: 'Sign the user in' },
        { action: 'expectUrl', value: origin, intent: 'Stay on the same origin after signing in' },
      ],
    };

    const bundle = await runFlow(flow, { cdpUrl: CDP_URL, cachePath: join(dir, 'intent.json') });

    assert.equal(bundle.status, 'passed', bundle.error ?? 'run should pass');
    // `click` goes through the escalation ladder (#step).
    const click = bundle.steps.find((step) => step.action === 'click');
    assert.equal(click?.intent, 'Sign the user in');
    // `expectUrl` has no selector to heal, so it goes through #bareStep instead —
    // a different code path that must carry intent through just as faithfully.
    const expectUrl = bundle.steps.find((step) => step.action === 'expectUrl');
    assert.equal(expectUrl?.intent, 'Stay on the same origin after signing in');
    // goto carries no intent field on the Flow schema — must stay unset, not "".
    const goto = bundle.steps.find((step) => step.action === 'goto');
    assert.equal(goto?.intent, undefined);
  });

  it('heals a drifted selector, then serves the repair from cache', async () => {
    const cachePath = join(dir, 'healed.json');
    const healerModel = new StubHealerModel((request) => {
      assert.equal(request.failedSelector, '#login');
      assert.match(request.axTree, /Sign in/, 'AX tree should carry the accessible name');
      return {
        selector: 'role=button[name="Sign in"]',
        strategy: 'role',
        confidence: 0.95,
        reasoning: 'single button whose accessible name matches the intent',
        inputTokens: 640,
        outputTokens: 48,
      };
    });

    const flow: Flow = {
      name: 'healed',
      baseUrl: origin,
      steps: [
        { action: 'goto', url: '/' },
        // #login no longer exists — the page renamed it to #signin.
        { action: 'click', selector: '#login', intent: 'the sign in button' },
        { action: 'expectText', selector: '#status', value: 'Signed in as alice' },
      ],
    };

    const first = await runFlow(flow, {
      cdpUrl: CDP_URL,
      cachePath,
      fastTimeoutMs: 1000,
      makeHealer: (cache) => new JitHealer({ model: healerModel, cache }),
    });

    assert.equal(first.status, 'passed', first.error ?? 'healed run should pass');
    assert.equal(first.summary.jitHeals, 1);
    assert.equal(healerModel.calls.length, 1);

    const healedStep = first.steps.find((step) => step.selector === '#login');
    assert.ok(healedStep);
    assert.equal(healedStep.resolution, 'jit');
    assert.equal(healedStep.resolvedSelector, 'role=button[name="Sign in" i]');
    assert.equal(healedStep.heal?.model, 'stub-healer');
    assert.equal(healedStep.heal?.inputTokens, 640);

    // The repair must be on disk for the next run.
    const persisted = JSON.parse(await readFile(cachePath, 'utf8')) as HealedSelectorCacheFile;
    const key = Object.keys(persisted.entries)[0];
    assert.ok(key?.endsWith(':: #login'), `unexpected cache key: ${key}`);

    // Second run: same drift, but now it costs nothing.
    const second = await runFlow(flow, {
      cdpUrl: CDP_URL,
      cachePath,
      fastTimeoutMs: 1000,
      makeHealer: (cache) => new JitHealer({ model: healerModel, cache }),
    });

    assert.equal(second.status, 'passed', second.error ?? 'cached run should pass');
    assert.equal(second.summary.cacheHits, 1);
    assert.equal(second.summary.jitHeals, 0);
    assert.equal(healerModel.calls.length, 1, 'cached repair must not re-enter the control plane');
  });

  it('fails with a full escalation trace when healing is disabled', async () => {
    const bundle = await runFlow(
      {
        name: 'no-heal',
        baseUrl: origin,
        steps: [
          { action: 'goto', url: '/' },
          { action: 'click', selector: '#login' },
        ],
      },
      { cdpUrl: CDP_URL, cachePath: join(dir, 'noheal.json'), fastTimeoutMs: 500, healer: null },
    );

    assert.equal(bundle.status, 'dead-end');
    assert.equal(bundle.summary.jitHeals, 0);
    const failed = bundle.steps.find((step) => step.status !== 'passed');
    assert.ok(failed?.error);
    assert.match(failed.error, /could not resolve "#login"/);
    // The step's recorded error carries the whole rung-by-rung trace, not just
    // the first line — the reporter's escalationTrace() parses exactly this.
    assert.match(failed.error, /jit: healer disabled/);
  });
});

/** A detail page that renders its content in Thai — the PB-05-01 shape. */
const BILINGUAL_HTML = `<!doctype html>
<html lang="th">
  <head><meta charset="utf-8"><title>bilingual fixture</title></head>
  <body>
    <h1>Probation Review · EMP042</h1>
    <p id="employee">สมชาย สุขใจ</p>
    <script>window.__FLIGHT__ = "SECRETPAYLOAD123 not visible to any user";</script>
  </body>
</html>`;

const NEWTAB_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>new-tab fixture</title></head>
  <body>
    <h1>Portal</h1>
    <a href="/contact" target="_blank">Contact us</a>
    <button id="opener" type="button">Open help</button>
    <script>
      document.getElementById('opener').addEventListener('click', () => {
        window.open('/contact', '_blank');
      });
    </script>
  </body>
</html>`;

const CONTACT_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>contact fixture</title></head>
  <body><h1>Contact us</h1><p id="phone">1284</p></body>
</html>`;

/** A non-ARIA promo veil (no role=dialog) that only Escape clears. */
const VEIL_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>veil fixture</title></head>
  <body>
    <a href="/contact" target="_blank">Contact us</a>
    <div id="veil" class="promo dimmer overlay" style="position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:50">
      <p>Todays deal!</p>
    </div>
    <script>
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') document.getElementById('veil')?.remove();
      });
    </script>
  </body>
</html>`;

const DENIED_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>denied fixture</title></head>
  <body><h1>ไม่มีสิทธิ์เข้าถึง · Access Denied</h1><p>You do not have permission to view this page.</p></body>
</html>`;

const LATE_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>late fixture</title></head>
  <body>
    <h1>Loading shell</h1>
    <script>
      setTimeout(() => {
        const p = document.createElement('p');
        p.id = 'late';
        p.textContent = 'finally here';
        document.body.appendChild(p);
      }, 500);
    </script>
  </body>
</html>`;

describe('ladder guards: dead ends, denial, timing (CDP)', { skip: skipBrowser }, () => {
  let server: Server;
  let origin: string;
  let dir: string;

  before(async () => {
    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      const url = req.url ?? '/';
      res.end(
        url.startsWith('/veil')
          ? VEIL_HTML
          : url.startsWith('/newtab')
          ? NEWTAB_HTML
          : url.startsWith('/contact')
            ? CONTACT_HTML
            : url.startsWith('/denied')
              ? DENIED_HTML
          : url.startsWith('/late')
            ? LATE_HTML
            : url.startsWith('/bilingual')
              ? BILINGUAL_HTML
              : FIXTURE_HTML,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    dir = await mkdtemp(join(tmpdir(), 'wowlidator-guards-'));
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(dir, { recursive: true, force: true });
  });

  it('never repays an identical dead end — one fast attempt, no second heal', async () => {
    // PB-02-01 walked the same broken login block through the full ladder
    // three times: nine ladder walks and nine model calls for one fact.
    const healerModel = new StubHealerModel(() => ({
      selector: '#still-not-there',
      strategy: 'css',
      confidence: 0.9,
      reasoning: 'a guess that will not verify',
    }));

    const bundle = await runFlow(
      {
        name: 'repeated dead end',
        baseUrl: origin,
        steps: [
          { action: 'goto', url: '/' },
          { action: 'click', selector: '#nope', intent: 'a control that does not exist' },
          { action: 'click', selector: '#nope', intent: 'the same control, again' },
        ],
      },
      {
        cdpUrl: CDP_URL,
        cachePath: join(dir, 'dead-end.json'),
        fastTimeoutMs: 400,
        makeHealer: (cache) => new JitHealer({ model: healerModel, cache }),
      },
    );

    assert.notEqual(bundle.status, 'passed');
    // One heal() budget (up to HEAL_ATTEMPTS asks) is spent on the FIRST
    // failure only; the second identical failure never re-enters the control
    // plane — the call count would double otherwise.
    assert.equal(healerModel.calls.length, 3, 'the second identical failure must not pay the healer again');
    const second = bundle.steps[2];
    assert.match(second?.error ?? '', /known dead end: identical failure at step 1/);
    const first = bundle.steps[1];
    assert.ok(
      (second?.durationMs ?? Infinity) < (first?.durationMs ?? 0) / 2,
      'the repeat must cost one fast attempt, not the whole ladder',
    );
    // And the two identical failures cluster into one defect.
    const stepDefects = bundle.defects.filter((d) => d.selector === '#nope');
    assert.equal(stepDefects.length, 1);
    assert.equal(stepDefects[0]?.occurrences, 2);
  });

  it('recognises an Access Denied page: no heal, an authorization defect, the heading as evidence', async () => {
    const healerModel = new StubHealerModel(() => {
      throw new Error('the healer must not be reached on a denial surface');
    });

    const bundle = await runFlow(
      {
        name: 'denied surface',
        baseUrl: origin,
        steps: [
          { action: 'goto', url: '/denied' },
          { action: 'click', selector: 'text=Probation Exemption', intent: 'the exemption card' },
        ],
      },
      {
        cdpUrl: CDP_URL,
        cachePath: join(dir, 'denied.json'),
        fastTimeoutMs: 400,
        makeHealer: (cache) => new JitHealer({ model: healerModel, cache }),
      },
    );

    assert.notEqual(bundle.status, 'passed');
    assert.equal(healerModel.calls.length, 0, 'no token may be spent repairing around a denial');
    const failed = bundle.steps.find((s) => s.status !== 'passed');
    assert.deepEqual(failed?.pageContext, ['ไม่มีสิทธิ์เข้าถึง · Access Denied']);
    assert.match(failed?.error ?? '', /authorization: the page is showing/);
    const defect = bundle.defects.find((d) => d.category === 'authorization');
    assert.ok(defect, 'the denial is the finding, and it gets its own category');
    assert.equal(defect?.severity, 'high');
  });

  it('clears a non-ARIA overlay named by the interception log, then follows the click', async () => {
    // The full homepro shape in one fixture: a promo veil with no role=dialog
    // swallows the click; Playwright names it; the overlay rung presses
    // Escape; the retried click opens a new tab; the runner adopts it.
    const bundle = await runFlow(
      {
        name: 'veiled contact',
        baseUrl: origin,
        steps: [
          { action: 'goto', url: '/veil' },
          { action: 'click', selector: 'role=link[name="Contact us"]', intent: 'the contact link behind the veil' },
          { action: 'expectUrl', value: '/contact' },
        ],
      },
      { cdpUrl: CDP_URL, cachePath: join(dir, 'veil.json'), fastTimeoutMs: 600, healer: null },
    );

    assert.equal(bundle.status, 'passed', bundle.error ?? 'Escape must clear the veil and the click must be followed');
    const click = bundle.steps.find((s) => s.action === 'click');
    assert.equal(click?.resolution, 'dialog');
    assert.equal(click?.dialog?.button, 'Escape');
    assert.match(click?.dialog?.name ?? '', /div\.promo\.dimmer\.overlay/);
    assert.match(String(click?.detail?.['openedNewTab'] ?? ''), /\/contact$/);
    // The blocker is a finding for human users too.
    assert.ok(bundle.defects.some((d) => d.category === 'usability'));
  });

  it('follows a click into the new tab it opened — target=_blank is a navigation too', async () => {
    // homepro.co.th's "Contact us" link, live: the click lands, the watched
    // page never changes, and every later step asserts against the page the
    // user left. The runner now adopts the popup and the flow continues on
    // the journey the click started.
    const bundle = await runFlow(
      {
        name: 'new tab adoption',
        baseUrl: origin,
        steps: [
          { action: 'goto', url: '/newtab' },
          { action: 'click', selector: 'role=link[name="Contact us"]', intent: 'open the contact page' },
          { action: 'expectUrl', value: '/contact', intent: 'the contact page is where we are now' },
          { action: 'expectText', selector: 'body', value: '1284', intent: 'the hotline renders' },
        ],
      },
      { cdpUrl: CDP_URL, cachePath: join(dir, 'newtab.json'), fastTimeoutMs: 800, healer: null },
    );

    assert.equal(bundle.status, 'passed', bundle.error ?? 'the flow must continue in the adopted tab');
    const click = bundle.steps.find((s) => s.action === 'click');
    assert.match(String(click?.detail?.['openedNewTab'] ?? ''), /\/contact$/);
  });

  it('adopts a window.open popup too, with no target attribute to declare it', async () => {
    const bundle = await runFlow(
      {
        name: 'window.open adoption',
        baseUrl: origin,
        steps: [
          { action: 'goto', url: '/newtab' },
          { action: 'click', selector: 'role=button[name="Open help"]', intent: 'open help in a new window' },
          { action: 'expectUrl', value: '/contact' },
        ],
      },
      { cdpUrl: CDP_URL, cachePath: join(dir, 'winopen.json'), fastTimeoutMs: 800, healer: null },
    );

    assert.equal(bundle.status, 'passed', bundle.error ?? 'the grace window must catch a handler-fired popup');
  });

  it('records a provider failure as unavailability, never as page truth', async () => {
    // PB-02-01's first heal died on "No object generated" and the dead-end
    // read as "the control is absent". The machinery failing must say so.
    const healerModel = new StubHealerModel(() => {
      throw new Error('rate limited by the provider');
    });

    const bundle = await runFlow(
      {
        name: 'healer outage',
        baseUrl: origin,
        steps: [
          { action: 'goto', url: '/' },
          { action: 'click', selector: '#nowhere', intent: 'a control that does not exist' },
        ],
      },
      {
        cdpUrl: CDP_URL,
        cachePath: join(dir, 'outage.json'),
        fastTimeoutMs: 400,
        makeHealer: (cache) => new JitHealer({ model: healerModel, cache }),
      },
    );

    assert.equal(bundle.summary.healUnavailable, 1);
    const failed = bundle.steps.find((s) => s.status !== 'passed');
    assert.match(failed?.error ?? '', /jit: unavailable — healer unavailable: rate limited/);
    assert.match(failed?.error ?? '', /a provider fact, not a page fact/);
  });

  it('recognises a low-confidence echo as an echo, and keeps every refusal as data', async () => {
    // The C7 ordering fix: an echo used to hit the confidence gate first and
    // be reported as "confidence too low" after a single ask. Echo-first
    // means the model gets its full budget of informed re-asks, and every
    // refused candidate survives onto the step as `rejectedHeals`.
    const healerModel = new StubHealerModel(() => ({
      // The authored selector minus its case flag — the PB-02-01 echo shape.
      selector: 'role=button[name="Vanished"]',
      strategy: 'role',
      confidence: 0.1,
      reasoning: 'nothing else on the page resembles the intent',
    }));

    const bundle = await runFlow(
      {
        name: 'echoing healer',
        baseUrl: origin,
        steps: [
          { action: 'goto', url: '/' },
          { action: 'click', selector: 'role=button[name="Vanished" i]', intent: 'the vanished control' },
        ],
      },
      {
        cdpUrl: CDP_URL,
        cachePath: join(dir, 'echo.json'),
        fastTimeoutMs: 400,
        makeHealer: (cache) => new JitHealer({ model: healerModel, cache }),
      },
    );

    assert.equal(healerModel.calls.length, 3, 'an echo earns the full re-ask budget, not a one-shot decline');
    const failed = bundle.steps.find((s) => s.status !== 'passed');
    assert.match(failed?.error ?? '', /nothing on this page serves the author's intent/);
    assert.equal(failed?.rejectedHeals?.length, 3);
    assert.equal(failed?.rejectedHeals?.[0]?.rejectedBecause, 'this is the selector that already failed');
    assert.equal(failed?.rejectedHeals?.[0]?.confidence, 0.1);
  });

  it('keeps a declined repair proposal on the step — the refusal is the diagnosis', async () => {
    const healerModel = new StubHealerModel(() => ({
      selector: 'role=heading[name="wowlidator fixture"]',
      strategy: 'role',
      confidence: 0.15,
      reasoning: 'only a heading matches, and it is not clickable',
    }));

    const bundle = await runFlow(
      {
        name: 'declined heal',
        baseUrl: origin,
        steps: [
          { action: 'goto', url: '/' },
          { action: 'click', selector: '#gone', intent: 'a control the page does not offer' },
        ],
      },
      {
        cdpUrl: CDP_URL,
        cachePath: join(dir, 'declined.json'),
        fastTimeoutMs: 400,
        makeHealer: (cache) => new JitHealer({ model: healerModel, cache }),
      },
    );

    const failed = bundle.steps.find((s) => s.status !== 'passed');
    assert.equal(failed?.rejectedHeals?.length, 1);
    assert.match(failed?.rejectedHeals?.[0]?.proposed ?? '', /wowlidator fixture/);
    assert.match(failed?.rejectedHeals?.[0]?.rejectedBecause ?? '', /confidence 0\.15 below threshold/);
    assert.equal(failed?.rejectedHeals?.[0]?.reasoning, 'only a heading matches, and it is not clickable');
  });

  it('accepts an equivalent language rendering via anyOf, and records which one matched', async () => {
    // PB-05-01: the requirement said "Somchai Sukjai", the page rendered
    // "สมชาย สุขใจ", and a working feature failed on language. anyOf is the
    // explicit fix — the author lists the accepted renderings; the engine
    // never invents an equivalence.
    const bundle = await runFlow(
      {
        name: 'bilingual pass',
        baseUrl: origin,
        steps: [
          { action: 'goto', url: '/bilingual' },
          {
            action: 'expectText',
            selector: 'body',
            value: 'Somchai Sukjai',
            anyOf: ['สมชาย สุขใจ'],
            intent: 'the employee name renders, in either language',
          },
        ],
      },
      { cdpUrl: CDP_URL, cachePath: join(dir, 'bilingual.json'), fastTimeoutMs: 800, healer: null },
    );

    assert.equal(bundle.status, 'passed', bundle.error ?? 'the Thai rendering satisfies the claim');
    const step = bundle.steps[1];
    assert.equal(step?.detail?.['matchedRendering'], 'สมชาย สุขใจ');
    assert.deepEqual(step?.detail?.['anyOf'], ['สมชาย สุขใจ']);
  });

  it('still fails a single-rendering assertion, but names the script mismatch', async () => {
    // Without anyOf the check is strict — a case that MEANS to check the
    // English rendering keeps its teeth — and the failure explains itself
    // instead of reading as a missing feature.
    const bundle = await runFlow(
      {
        name: 'bilingual strict',
        baseUrl: origin,
        steps: [
          { action: 'goto', url: '/bilingual' },
          { action: 'expectText', selector: '#employee', value: 'Somchai Sukjai' },
        ],
      },
      { cdpUrl: CDP_URL, cachePath: join(dir, 'bilingual-strict.json'), fastTimeoutMs: 500, healer: null },
    );

    assert.notEqual(bundle.status, 'passed');
    const failed = bundle.steps.find((s) => s.status !== 'passed');
    assert.match(failed?.error ?? '', /renders content in a different script/);
    assert.match(failed?.error ?? '', /language-neutral anchor|anyOf/);
  });

  it('asserts what the page shows, not what its script tags carry', async () => {
    // PB-05-01's "got …" text was mostly Next.js flight data: textContent on
    // body reads <script> payloads. Visible text is what a claim is about.
    const bundle = await runFlow(
      {
        name: 'no script text',
        baseUrl: origin,
        steps: [
          { action: 'goto', url: '/bilingual' },
          { action: 'expectText', selector: 'body', value: 'SECRETPAYLOAD123' },
        ],
      },
      { cdpUrl: CDP_URL, cachePath: join(dir, 'script-text.json'), fastTimeoutMs: 500, healer: null },
    );

    assert.notEqual(bundle.status, 'passed', 'script payload text must not satisfy a visible-text claim');
  });

  it('passes a slow presence assertion via the patience rung, and still files the timing finding', async () => {
    // PB-05-01's endgame: the detail content renders ~3s after the route
    // commits, and a single fast-budget read saw only the app shell. The
    // patience rung gives the author's own selector one window at the healed
    // timeout — free, deterministic, before any model is paid — and the pass
    // still records that the page is slower than the budget.
    const bundle = await runFlow(
      {
        name: 'slow render, patient assertion',
        baseUrl: origin,
        steps: [
          { action: 'goto', url: '/late' },
          { action: 'expectText', selector: 'body', value: 'finally here', intent: 'the late content renders' },
        ],
      },
      {
        cdpUrl: CDP_URL,
        cachePath: join(dir, 'late-patience.json'),
        fastTimeoutMs: 300,
        healer: null,
      },
    );

    assert.equal(bundle.status, 'passed', bundle.error ?? 'patience must beat a heal for late content');
    const step = bundle.steps[1];
    assert.equal(step?.resolution, 'late');
    const defect = bundle.defects.find((d) => d.selector === 'body');
    assert.equal(defect?.severity, 'medium');
    assert.match(defect?.title ?? '', /Slower than the fast-path budget/);
  });

  it('reclassifies a dead end as timing when the control exists by the end of the run', async () => {
    // A click gets no patience rung — acting late is not observing late — so
    // a late-rendering target still dead-ends, and the close-time re-check is
    // what turns "missing" into "timing" in the defect table.
    const bundle = await runFlow(
      {
        name: 'slow render',
        baseUrl: origin,
        steps: [
          { action: 'goto', url: '/late' },
          { action: 'click', selector: '#late', intent: 'the late content' },
        ],
      },
      {
        cdpUrl: CDP_URL,
        cachePath: join(dir, 'late.json'),
        fastTimeoutMs: 300,
        healer: null,
      },
    );

    assert.notEqual(bundle.status, 'passed', 'the step still failed honestly at the time it ran');
    const defect = bundle.defects.find((d) => d.selector === '#late');
    assert.equal(defect?.severity, 'medium', 'a control that renders late is a timing finding, not an absence');
    assert.match(defect?.detail ?? '', /TIMING, not absence/);
  });
});

const REPEATED_BUTTON_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>repeated button fixture</title></head>
  <body>
    <button type="button">Edit</button>
    <button type="button">Edit</button>
    <button type="button">Edit</button>
    <p id="status">idle</p>
    <script>
      document.querySelectorAll('button').forEach((btn, i) => {
        btn.addEventListener('click', () => {
          document.getElementById('status').textContent = 'clicked ' + i;
        });
      });
    </script>
  </body>
</html>`;

describe('ambiguous selector repair (CDP)', { skip: skipBrowser }, () => {
  let server: Server;
  let origin: string;
  let dir: string;

  before(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(REPEATED_BUTTON_HTML);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    origin = `http://127.0.0.1:${address.port}`;
    dir = await mkdtemp(join(tmpdir(), 'wowlidator-ambiguous-'));
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(dir, { recursive: true, force: true });
  });

  it('lets a counting step heal onto a group — several matches are the point', async () => {
    // PB-02-01: `expectCount role=radio, 4` against outcome "cards" that are
    // really aria-pressed buttons. The correct repair matches all of them,
    // which the exactly-one verification used to reject as ambiguous —
    // making a count selector structurally unhealable.
    const healerModel = new StubHealerModel((request) => {
      assert.equal(request.action, 'expectCount');
      return {
        selector: 'role=button[name="Edit"]',
        strategy: 'role',
        confidence: 0.85,
        reasoning: 'the counted items are the repeated Edit buttons',
      };
    });

    const flow: Flow = {
      name: 'count heals to a group',
      baseUrl: origin,
      steps: [
        { action: 'goto', url: '/' },
        { action: 'expectCount', selector: 'role=radio', count: 3, intent: 'three row actions' },
      ],
    };

    const bundle = await runFlow(flow, {
      cdpUrl: CDP_URL,
      cachePath: join(dir, 'count-heal.json'),
      fastTimeoutMs: 400,
      makeHealer: (cache) => new JitHealer({ model: healerModel, cache }),
    });

    assert.equal(bundle.status, 'passed', bundle.error ?? 'the repaired group selector must count 3');
    const step = bundle.steps[1];
    assert.equal(step?.resolution, 'jit');
    assert.equal(step?.resolvedSelector, 'role=button[name="Edit" i]');
  });

  it('tells the healer WHY the selector failed, and accepts a valid nth= disambiguation', async () => {
    const healerModel = new StubHealerModel((request) => {
      // This is the actual bug this test guards: without failureReason, the
      // model (in production) proposed `role=button[name="Edit"].first()` —
      // a Locator *method* appended to selector text, which is not valid
      // Playwright selector syntax and can never resolve.
      assert.match(request.failureReason ?? '', /strict mode violation/);
      assert.match(request.failureReason ?? '', /resolved to 3 elements/);
      return {
        selector: 'role=button[name="Edit"] >> nth=0',
        strategy: 'role',
        confidence: 0.8,
        reasoning: 'three identical rows; intent does not name a specific one, so the first is a reasonable pick',
      };
    });

    const flow: Flow = {
      name: 'ambiguous',
      baseUrl: origin,
      steps: [
        { action: 'goto', url: '/' },
        { action: 'click', selector: 'role=button[name="Edit"]', intent: 'edit the item' },
        { action: 'expectText', selector: '#status', value: 'clicked 0' },
      ],
    };

    const bundle = await runFlow(flow, {
      cdpUrl: CDP_URL,
      cachePath: join(dir, 'ambiguous.json'),
      fastTimeoutMs: 500,
      makeHealer: (cache) => new JitHealer({ model: healerModel, cache }),
    });

    assert.equal(bundle.status, 'passed', bundle.error ?? 'the nth= disambiguation should resolve and pass');
    const healed = bundle.steps.find((step) => step.action === 'click');
    assert.equal(healed?.resolution, 'jit');
    assert.equal(healed?.resolvedSelector, 'role=button[name="Edit" i] >> nth=0');
  });

  it('rejects a healed selector using invalid .first()-style syntax rather than silently failing the whole step unexplained', async () => {
    const healerModel = new StubHealerModel(() => ({
      // The exact hallucination observed in production.
      selector: 'role=button[name="Edit"].first()',
      strategy: 'role',
      confidence: 0.8,
      reasoning: 'picking the first match',
    }));

    const bundle = await runFlow(
      {
        name: 'invalid-heal-syntax',
        baseUrl: origin,
        steps: [
          { action: 'goto', url: '/' },
          { action: 'click', selector: 'role=button[name="Edit"]', intent: 'edit the item' },
        ],
      },
      {
        cdpUrl: CDP_URL,
        cachePath: join(dir, 'invalid-syntax.json'),
        fastTimeoutMs: 500,
        makeHealer: (cache) => new JitHealer({ model: healerModel, cache }),
      },
    );

    assert.equal(bundle.status, 'dead-end');
    // The full attempts trail — including *why* the heal itself failed — is
    // recorded on the step, so the report can show the whole account.
    const failed = bundle.steps.find((step) => step.status !== 'passed');
    assert.match(failed?.error ?? '', /did not resolve/);
  });
});

const healerRole = loadConfig().roles.healer;
const healerKeyEnv = PROVIDER_META[healerRole.provider].envKey;

describe(`healer (live ${healerRole.provider} API)`, {
  skip: process.env[healerKeyEnv]
    ? skipBrowser
    : `set ${healerKeyEnv} to run the live healer test (role "healer" -> ${healerRole.provider}:${healerRole.modelId})`,
}, () => {
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
    dir = await mkdtemp(join(tmpdir(), 'wowlidator-live-'));
  });

  after(async () => {
    // Chrome holds keep-alive sockets open; without this close() blocks for ~60s.
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(dir, { recursive: true, force: true });
  });

  it('repairs a drifted selector against the real model', async () => {
    const bundle = await runFlow(
      {
        name: 'live-heal',
        baseUrl: origin,
        steps: [
          { action: 'goto', url: '/' },
          { action: 'click', selector: '#login', intent: 'the sign in button' },
          { action: 'expectText', selector: '#status', value: 'Signed in as alice' },
        ],
      },
      {
        cdpUrl: CDP_URL,
        cachePath: join(dir, 'live.json'),
        fastTimeoutMs: 1000,
        makeHealer: (cache) => new JitHealer({ model: new LlmHealerModel(), cache }),
      },
    );

    assert.equal(bundle.status, 'passed', bundle.error ?? 'live healed run should pass');
    assert.equal(bundle.summary.jitHeals, 1);
    assert.ok((bundle.summary.inputTokens ?? 0) > 0, 'usage should be reported');
  });
});

describe('a failure message must describe the failure it carries', () => {
  it('all-content-mismatch attempts headline as content, not resolution', () => {
    // "Could not resolve" over attempts that each RESOLVED and failed on text
    // reads as "the control is missing" and files the wrong defect.
    const error = new StepResolutionError('role=main', [
      'fast "role=main": expected text to contain "PB-001", got "Probation Review…"',
      'late "role=main": expected text to contain "PB-001", got "Probation Review…"',
    ]);
    assert.match(error.message, /^"role=main" resolved, but its content did not hold/);
  });

  it('mixed attempts keep the resolution header', () => {
    const error = new StepResolutionError('role=main', [
      'fast "role=main": locator.waitFor: Timeout 2000ms exceeded.',
      'late "role=main": expected text to contain "PB-001", got "…"',
    ]);
    assert.match(error.message, /^could not resolve "role=main"/);
  });
});

describe('native form resubmit detection', () => {
  const passwordFill: FlowStep = {
    action: 'fill',
    selector: 'role=textbox >> nth=1',
    value: 's3cret',
    intent: 'Fill admin password',
  };

  it('reads a password parameter off the URL', async () => {
    const param = await nativeFormResubmitDetected(
      () => 'http://x/en/login?email=a%40b.c&password=s3cret',
      [passwordFill],
      50,
    );
    assert.equal(param, 'password', 'the first parameter carrying evidence names the submit');
  });

  it('recognises a typed value under any parameter name', async () => {
    const param = await nativeFormResubmitDetected(
      () => 'http://x/en/login?user_secret=s3cret',
      [passwordFill],
      50,
    );
    assert.equal(param, 'user_secret');
  });

  it('never fires without a credential-shaped fill — and returns without waiting', async () => {
    const started = Date.now();
    const param = await nativeFormResubmitDetected(
      () => 'http://x/search?q=anything',
      [{ action: 'fill', selector: 'role=searchbox', value: 'anything', intent: 'search' }],
      600,
    );
    assert.equal(param, null);
    assert.ok(Date.now() - started < 100, 'ordinary clicks must not pay the recheck window');
  });

  it('a clean URL after the recheck window is a clean submit', async () => {
    const param = await nativeFormResubmitDetected(() => 'http://x/en/home', [passwordFill], 50);
    assert.equal(param, null);
  });

  it('a bare "?" that appeared across the click is the unnamed-fields submit', async () => {
    // The signature this missed for a whole catalog run: the app's login
    // inputs carry no name attribute, so its pre-hydration GET submitted
    // "/en/login?" — no parameters, no evidence, no replay, and a silently
    // failed login behind 21 of the 25 defects DB_01_01…DB_09_01 filed.
    const param = await nativeFormResubmitDetected(
      () => 'http://x/en/login?',
      [passwordFill],
      50,
      'http://x/en/login',
    );
    assert.equal(param, NATIVE_SUBMIT_UNNAMED);
  });

  it('does not fire when the login URL already carried a query string', async () => {
    // /login?redirect=/somewhere is an ordinary way to arrive. The evidence is
    // that the search APPEARED, never that a login URL has one.
    const param = await nativeFormResubmitDetected(
      () => 'http://x/en/login?redirect=%2Fadmin',
      [passwordFill],
      50,
      'http://x/en/login?redirect=%2Fadmin',
    );
    assert.equal(param, null);
  });

  it('does not fire once the submit has left the sign-in page', async () => {
    const param = await nativeFormResubmitDetected(
      () => 'http://x/en/home?welcome=1',
      [passwordFill],
      50,
      'http://x/en/login',
    );
    assert.equal(param, null);
  });

  it('needs the baseline — without it the third signature is off', async () => {
    const param = await nativeFormResubmitDetected(() => 'http://x/en/login?', [passwordFill], 50);
    assert.equal(param, null);
  });
});

describe('a run whose session guard fired cannot pass', () => {
  const base = { startedAt: new Date().toISOString(), durationMs: 1, url: 'http://x/en/login' };

  it('turns an otherwise clean run into an error', () => {
    // DB_04_02 finalised passed, 7/7, carrying the high defect "the session
    // is not established, so nothing after this point can say anything about
    // the feature under test". Its SessionLostError was swallowed on a path
    // that is right to swallow it, so no step failed and no run error was
    // recorded — the verdict has to come from the guard itself.
    const builder = new ProofBundleBuilder({ name: 'stranded' });
    builder.addStep({
      action: 'expectCount', selector: 'text="BE-MED-001"', resolvedSelector: 'text="BE-MED-001"',
      resolution: 'fast', status: 'passed', ...base,
    });
    assert.equal(builder.finish().status, 'passed', 'the premise: nothing else fails this run');

    const stranded = new ProofBundleBuilder({ name: 'stranded' });
    stranded.addStep({
      action: 'expectCount', selector: 'text="BE-MED-001"', resolvedSelector: 'text="BE-MED-001"',
      resolution: 'fast', status: 'passed', ...base,
    });
    stranded.noteSessionLost();
    assert.equal(
      stranded.finish().status,
      'error',
      'the application was never reached — an environment fact, not a verdict about the feature',
    );
  });

  it('leaves a worse status alone', () => {
    const builder = new ProofBundleBuilder({ name: 'stranded-and-broken' });
    builder.addStep({
      action: 'click', selector: '#a', resolvedSelector: '#a', resolution: 'fast',
      status: 'dead-end', ...base,
    });
    builder.noteSessionLost();
    assert.equal(builder.finish().status, 'dead-end', 'worst-first still decides');
  });
});

describe('the sign-in that never took effect', () => {
  it('fires once the flow asks for a page that needs a session', () => {
    // DB_04_01/DB_06_01/DB_07_01/DB_08_01: the login silently failed and the
    // run carried on, filing 19 high "functional" defects between them about
    // an application that was working. The existing stranded guard cannot see
    // this — it asks "were we bounced away from what we asked for?", and here
    // the most recent goto WAS the login page.
    const message = signInDidNotTakeMessage({
      signInDidNotTake: true,
      lastGotoAskedSignIn: false,
      lastGotoPath: '/en/admin/benefits/rules',
    });
    assert.match(message ?? '', /the sign-in did not take effect/);
    assert.match(message ?? '', /\/en\/admin\/benefits\/rules/);
    assert.match(message ?? '', /not a redirect/, 'the wording must not claim a bounce');
  });

  it('never fires for a flow that stays on the sign-in page', () => {
    // A negative sign-in test asserting "Incorrect password" is a legitimate
    // flow and must not be stopped.
    assert.equal(
      signInDidNotTakeMessage({
        signInDidNotTake: true,
        lastGotoAskedSignIn: true,
        lastGotoPath: '/en/login',
      }),
      null,
    );
  });

  it('never fires without positive evidence that the submit failed', () => {
    assert.equal(
      signInDidNotTakeMessage({
        signInDidNotTake: false,
        lastGotoAskedSignIn: false,
        lastGotoPath: '/en/admin',
      }),
      null,
    );
  });

  it('never fires before the flow has navigated anywhere', () => {
    assert.equal(
      signInDidNotTakeMessage({
        signInDidNotTake: true,
        lastGotoAskedSignIn: false,
        lastGotoPath: null,
      }),
      null,
    );
  });
});

describe('lost-fill detection — the hydration race, second signature', () => {
  const emailFill: FlowStep = {
    action: 'fill',
    selector: 'input[type=email]',
    value: 'admin@cnext.test',
    intent: 'Enter work email',
  };
  const passwordFill: FlowStep = {
    action: 'fill',
    selector: 'input[type=password]',
    value: 'admin2026',
    intent: 'Enter password',
  };

  it('a credential field that reads back different is the evidence', async () => {
    // DB_04_01/DB_06_01/DB_07_01 live: the click landed pre-hydration, the
    // form did not navigate, and React reset the password to empty.
    const lost = await fillsLostToHydration(
      async (selector) => (selector.includes('password') ? '' : 'admin@cnext.test'),
      [emailFill, passwordFill],
    );
    assert.equal(lost, 'input[type=password]');
  });

  it('fields that kept their values are a clean submit', async () => {
    const lost = await fillsLostToHydration(
      async (selector) => (selector.includes('password') ? 'admin2026' : 'admin@cnext.test'),
      [emailFill, passwordFill],
    );
    assert.equal(lost, null);
  });

  it('a non-credential block never reads the page at all', async () => {
    let reads = 0;
    const lost = await fillsLostToHydration(
      async () => {
        reads += 1;
        return '';
      },
      [{ action: 'fill', selector: 'role=searchbox', value: 'leave', intent: 'search' }],
    );
    assert.equal(lost, null);
    assert.equal(reads, 0, 'ordinary form interactions must not pay a page round-trip');
  });

  it('an unreadable field is skipped, never guessed lost', async () => {
    const lost = await fillsLostToHydration(async () => null, [passwordFill]);
    assert.equal(lost, null);
  });
});

describe('passed-with-issues: the claims held, the path did not', () => {
  const base = { startedAt: new Date().toISOString(), durationMs: 5, url: 'https://x.test/app' };
  const step = (action: string, status: ProofStep['status'], selector = '#s') => ({
    action, selector, resolvedSelector: selector, resolution: 'fast' as const, status, ...base,
  });

  // The live shape (BE_Test2 PL_02_03): a click dead-ends, a later click on
  // the same control passes, every assertion passes.
  it('is the verdict when every assertion passed and only actions broke', () => {
    const b = new ProofBundleBuilder({ name: 'pl_02_03' });
    b.addStep(step('goto', 'passed'));
    b.addStep(step('click', 'dead-end', 'role=button[name="Create Plan" i]'));
    b.addStep(step('click', 'passed', 'role=button[name="Create Plan" i]'));
    b.addStep(step('expectVisible', 'passed', 'heading="Benefit Plan Catalog"'));
    const bundle = b.finish();
    assert.equal(bundle.status, 'passed-with-issues');
    assert.equal(isPassing(bundle.status), true);
    assert.equal(bundle.summary.failed, 1, 'the broken action is still counted as an issue');
  });

  it('is NOT the verdict when an assertion itself failed', () => {
    const b = new ProofBundleBuilder({ name: 'x' });
    b.addStep(step('click', 'dead-end'));
    b.addStep(step('expectVisible', 'failed'));
    assert.equal(b.finish().status, 'dead-end');
  });

  it('is NOT the verdict when the run made no assertion at all', () => {
    // A flow that only acts proves nothing; a broken action in it is a failure.
    const b = new ProofBundleBuilder({ name: 'x' });
    b.addStep(step('click', 'error'));
    b.addStep(step('click', 'passed'));
    assert.equal(b.finish().status, 'error');
  });

  it('never outranks a run-level error', () => {
    const b = new ProofBundleBuilder({ name: 'x' });
    b.addStep(step('click', 'dead-end'));
    b.addStep(step('expectVisible', 'passed'));
    b.recordRunError('the run is on the sign-in page after asking for /app');
    assert.notEqual(b.finish().status, 'passed-with-issues');
  });

  it('is NOT the verdict over an error step — the harness itself could not proceed', () => {
    // A request whose save path missed, then an assertion that happens to
    // hold: the claim is proved, the run is not what it said it was.
    const b = new ProofBundleBuilder({ name: 'x' });
    b.addStep(step('request', 'error'));
    b.addStep(step('expectStatus', 'passed'));
    assert.equal(b.finish().status, 'error');
  });

  it('a clean run is plain passed, never qualified', () => {
    const b = new ProofBundleBuilder({ name: 'x' });
    b.addStep(step('click', 'passed'));
    b.addStep(step('expectVisible', 'passed'));
    assert.equal(b.finish().status, 'passed');
  });
});
