/**
 * Contract and integration tests for the mock-data engine (`src/data/`).
 *
 * `mock-data.ts`'s deterministic generators and `LlmDataModel`'s AI SDK
 * contract are pure/offline. Only the `fillRetry` regenerate-and-retry loop
 * itself needs a real page — same `runFlow` + fixture-HTTP-server pattern as
 * `smoke.test.ts`.
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

import { jsonModel } from './helpers.js';

import { runFlow, type Flow } from '../src/engine/runner.js';
import {
  LlmDataModel,
  type DataGenerateRequest,
  type DataGenerateResult,
  type DataModel,
} from '../src/data/data-model.js';
import { DATA_KINDS, generateValue, isDeterministicKind } from '../src/data/mock-data.js';

// --- mock-data: pure functions, no browser -----------------------------------

describe('mock-data', () => {
  it('generates a plausible value for every deterministic kind', () => {
    for (const kind of DATA_KINDS) {
      if (kind === 'custom') continue;
      const value = generateValue(kind);
      assert.equal(typeof value, 'string');
      assert.notEqual(value, '');
    }
  });

  it('embeds a uniqueness suffix from the second attempt onward', () => {
    const first = generateValue('email', 1);
    const second = generateValue('email', 2);
    assert.notEqual(first, second);
    assert.match(second, /^[^@]+\+[a-z0-9]+@/, 'suffix should land before the @, not after');
  });

  it('never repeats a username across attempts', () => {
    const a = generateValue('username', 1);
    const b = generateValue('username', 2);
    assert.notEqual(a, b);
  });

  it('has no deterministic generator for "custom"', () => {
    assert.equal(isDeterministicKind('custom'), false);
    assert.throws(() => generateValue('custom'), /no deterministic generator/);
  });

  it('confirms every other kind is deterministic', () => {
    for (const kind of DATA_KINDS) {
      if (kind === 'custom') continue;
      assert.equal(isDeterministicKind(kind), true);
    }
  });
});

// --- LlmDataModel: AI SDK contract, no browser -------------------------------

describe('LlmDataModel', () => {
  it('generates a value and carries model usage through', async () => {
    const model = jsonModel(
      'mock-data',
      { value: 'ACME-042', reasoning: 'a plausible SKU distinct from the conflicting one' },
      { inputTokens: 120, outputTokens: 15 },
    );

    const dataModel = new LlmDataModel({ model, id: 'groq:mock-data' });
    const result: DataGenerateResult = await dataModel.generate({
      description: 'product SKU',
      observedError: 'SKU already exists',
      previousValue: 'ACME-041',
      attempt: 2,
    });

    assert.equal(result.value, 'ACME-042');
    assert.equal(result.inputTokens, 120);
    assert.equal(result.outputTokens, 15);
  });
});

// --- Browser-backed integration ----------------------------------------------

const CDP_URL = process.env['WOWLIDATOR_CDP_URL'] ?? 'http://localhost:9222';

const RETRY_FIXTURE_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>retry fixture</title></head>
  <body>
    <input id="field" aria-label="Value">
    <button id="submit-btn" type="button">Submit</button>
    <p id="conflict" style="display:none">Value already taken</p>
    <script>
      document.getElementById('submit-btn').addEventListener('click', () => {
        const value = document.getElementById('field').value;
        document.getElementById('conflict').style.display = value === 'taken@example.com' ? 'block' : 'none';
      });
    </script>
  </body>
</html>`;

class StubDataModel implements DataModel {
  readonly id = 'stub-data';
  readonly calls: DataGenerateRequest[] = [];
  readonly #reply: (request: DataGenerateRequest) => DataGenerateResult;
  constructor(reply: (request: DataGenerateRequest) => DataGenerateResult) {
    this.#reply = reply;
  }
  async generate(request: DataGenerateRequest): Promise<DataGenerateResult> {
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

const browserReady = await cdpAvailable(CDP_URL);
const skipBrowser = browserReady
  ? false
  : `no CDP endpoint at ${CDP_URL} — start Chrome with --remote-debugging-port=9222 (npm run chrome)`;

describe('fillRetry (CDP)', { skip: skipBrowser }, () => {
  let server: Server;
  let origin: string;
  let dir: string;

  before(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(RETRY_FIXTURE_HTML);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    origin = `http://127.0.0.1:${address.port}`;
    dir = await mkdtemp(join(tmpdir(), 'wowlidator-retry-'));
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(dir, { recursive: true, force: true });
  });

  it('regenerates via the custom kind until the conflict clears', async () => {
    const dataModel = new StubDataModel((request) => ({
      value: request.attempt === 1 ? 'taken@example.com' : 'fresh@example.com',
      reasoning: 'stub',
    }));

    const flow: Flow = {
      name: 'data retry',
      baseUrl: origin,
      steps: [
        { action: 'goto', url: '/' },
        {
          action: 'fillRetry',
          selector: '#field',
          kind: 'custom',
          failureSelector: '#conflict',
          submit: '#submit-btn',
          maxAttempts: 3,
          description: 'a unique value',
        },
      ],
    };

    const bundle = await runFlow(flow, { cdpUrl: CDP_URL, cachePath: join(dir, 'retry.json'), dataModel });

    assert.equal(bundle.status, 'passed', bundle.error ?? 'retry should eventually succeed');
    assert.equal(bundle.summary.dataRetries, 1);
    assert.equal(dataModel.calls.length, 2);

    const step = bundle.steps.find((s) => s.action === 'fillRetry');
    assert.equal(step?.dataRetry?.attempts.length, 2);
    assert.equal(step?.dataRetry?.succeeded, true);
    assert.equal(step?.dataRetry?.attempts[0]?.succeeded, false);
    assert.equal(step?.dataRetry?.attempts[1]?.succeeded, true);
  });

  it('fails cleanly, with every attempt recorded, when the conflict never clears', async () => {
    const alwaysConflicting = new StubDataModel(() => ({ value: 'taken@example.com', reasoning: 'stuck' }));

    const flow: Flow = {
      name: 'stuck retry',
      baseUrl: origin,
      steps: [
        { action: 'goto', url: '/' },
        {
          action: 'fillRetry',
          selector: '#field',
          kind: 'custom',
          failureSelector: '#conflict',
          submit: '#submit-btn',
          maxAttempts: 2,
        },
      ],
    };

    const bundle = await runFlow(flow, {
      cdpUrl: CDP_URL,
      cachePath: join(dir, 'stuck.json'),
      dataModel: alwaysConflicting,
    });

    assert.equal(bundle.status, 'failed');
    const step = bundle.steps.find((s) => s.action === 'fillRetry');
    assert.equal(step?.dataRetry?.attempts.length, 2);
    assert.equal(step?.dataRetry?.succeeded, false);
    assert.equal(alwaysConflicting.calls.length, 2);
  });

  it('succeeds on the first attempt for a deterministic kind, with no DataModel at all', async () => {
    const flow: Flow = {
      name: 'no conflict',
      baseUrl: origin,
      steps: [
        { action: 'goto', url: '/' },
        { action: 'fillRetry', selector: '#field', kind: 'email', failureSelector: '#conflict', submit: '#submit-btn' },
      ],
    };

    // No `dataModel` passed — a deterministic kind must never need one.
    const bundle = await runFlow(flow, { cdpUrl: CDP_URL, cachePath: join(dir, 'no-conflict.json') });

    assert.equal(bundle.status, 'passed', bundle.error ?? 'a fresh faker email should never collide');
    const step = bundle.steps.find((s) => s.action === 'fillRetry');
    assert.equal(step?.dataRetry?.attempts.length, 1);
    assert.equal(step?.dataRetry?.model, undefined);
  });
});
