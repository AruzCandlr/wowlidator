/**
 * Sequence-diagram testing: the parser, the deterministic claims path, the
 * ordered-subsequence matcher, and the `expectCalls` assertion.
 *
 * Same tiering as the rest of the suite. Parsing, claims compilation and
 * matching are pure and run always — against fixture diagrams written in the
 * shape real tools emit, not in whatever shape this parser happens to like.
 * `expectCalls` against live traffic needs a real page firing real requests,
 * so that half runs only when a CDP endpoint answers.
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  classifyPlanes,
  isObservable,
  looksLikeSequenceDiagram,
  parseSequenceDiagram,
  sequenceToClaims,
} from '../src/catalog/sequence.js';
import { extractDocument, formatFor } from '../src/catalog/extract.js';
import {
  matchExpectedCalls,
  neverViolations,
  parseExpectedCallEntry,
  callSatisfies,
} from '../src/api/expect-calls.js';
import { matchesCall } from '../src/context/route-match.js';
import type { NetworkCall } from '../src/api/network-observer.js';
import { LlmFlowAuthorModel } from '../src/generator/flow-author.js';
import { hasAssertion, isBrowserFree, runFlow, type Flow } from '../src/engine/runner.js';
import { EXIT, classifyError, exitCodeFor } from '../src/cli/exit.js';
import { ObservationUnavailableError } from '../src/api/expect-calls.js';
import { jsonModel } from './helpers.js';

const CDP_URL = process.env['WOWLIDATOR_CDP_URL'] ?? 'http://localhost:9222';
const FIXTURES = join(import.meta.dirname, 'fixtures');

async function cdpAvailable(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/json/version`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

// --- the parser -------------------------------------------------------------

describe('sequence diagram parsing', () => {
  it('reads a Mermaid diagram: participants, messages, alt branches, planes', async () => {
    const text = await readFile(join(FIXTURES, 'order.mmd'), 'utf8');
    assert.equal(looksLikeSequenceDiagram(text), 'mermaid');
    const doc = parseSequenceDiagram(text);

    assert.equal(doc.notation, 'mermaid');
    assert.deepEqual(
      doc.participants.map((p) => p.id),
      ['U', 'W', 'API', 'DB'],
    );

    // Notation facts are not guesses; name heuristics are, and say so.
    const user = doc.participants.find((p) => p.id === 'U')!;
    assert.equal(user.plane, 'user');
    assert.equal(user.guessed, false);
    const web = doc.participants.find((p) => p.id === 'W')!;
    assert.equal(web.plane, 'page', 'a "Web App" label reads as the page');
    assert.equal(web.guessed, true);
    const db = doc.participants.find((p) => p.id === 'DB')!;
    assert.equal(db.plane, 'external', 'PostgreSQL reads as beyond the boundary');

    // alt: one message per branch, labelled with its branch.
    const accepted = doc.messages.find((m) => m.text === '201 order created')!;
    assert.equal(accepted.branch?.label, 'payment accepted');
    const declined = doc.messages.find((m) => m.text === '402 payment required')!;
    assert.equal(declined.branch?.label, 'payment declined');

    // opt is carried as a note, loop is refused with one — never silently lost.
    assert.equal(
      doc.messages.some((m) => m.text.includes('consent')),
      false,
      'an opt message can never fail, so it must not become a claim',
    );
    assert.ok(doc.notes.some((n) => n.includes('opt')));
    assert.ok(doc.notes.some((n) => n.includes('loop')));
    assert.equal(
      doc.messages.some((m) => m.text.includes('status')),
      false,
      'loop contents are refused, not guessed at',
    );
  });

  it('reads a PlantUML diagram: typed participants, quoted labels, notes stripped', async () => {
    const text = await readFile(join(FIXTURES, 'order.puml'), 'utf8');
    const doc = parseSequenceDiagram(text);

    assert.equal(doc.notation, 'plantuml');
    const orders = doc.participants.find((p) => p.id === 'Orders')!;
    assert.equal(orders.kind, 'database');
    assert.equal(orders.plane, 'external');
    assert.equal(orders.guessed, false, 'the notation itself declared it');

    const web = doc.participants.find((p) => p.id === 'Web')!;
    assert.equal(web.label, 'Web App');

    assert.equal(doc.messages.length, 5);
    const insert = doc.messages.find((m) => m.text === 'INSERT order row')!;
    assert.equal(insert.from, 'API');
    assert.equal(insert.to, 'Orders');
    const reply = doc.messages.find((m) => m.text === '201 Created')!;
    assert.equal(reply.reply, true, 'a dashed arrow is a reply');
  });

  it('refuses text that is neither notation, naming the reason', () => {
    assert.throws(
      () => parseSequenceDiagram('just some prose\nwith lines'),
      /neither a Mermaid `sequenceDiagram` header nor a PlantUML/,
    );
  });

  it('refuses a diagram with no readable messages', () => {
    assert.throws(() => parseSequenceDiagram('sequenceDiagram\n  title nothing here'), /no messages/);
  });
});

// --- the observability boundary, as claims ----------------------------------

describe('sequence → claims', () => {
  it('keeps the boundary honest: page lanes testable, backend→db an assumption', async () => {
    const doc = parseSequenceDiagram(await readFile(join(FIXTURES, 'order.mmd'), 'utf8'));
    const { claims, summary } = sequenceToClaims(doc);

    // One claim per kept message, each traceable to its line.
    assert.equal(claims.length, doc.messages.length);
    assert.ok(claims.every((c) => /^line \d+/.test(c.source)));
    assert.match(summary, /alt fork/);

    const post = claims.find((c) => c.claim.includes('POST /api/orders'))!;
    assert.equal(post.testable, true);

    const insert = claims.find((c) => c.claim.includes('INSERT INTO orders'))!;
    assert.equal(insert.testable, false, 'API → DB is beyond the browser boundary');
    assert.match(insert.source, /beyond the browser boundary/);

    // A reply back to the page is observable — it is the response on the record.
    const reply = claims.find((c) => c.claim.includes('200 cart contents'))!;
    assert.equal(reply.testable, true);

    // Branch labels survive into the source, so authoring can split cases.
    const declined = claims.find((c) => c.claim.includes('402'))!;
    assert.match(declined.source, /alt: payment declined/);
  });

  it('marks a reply as observable and a backend-to-backend call as not', () => {
    const doc = parseSequenceDiagram(
      'sequenceDiagram\n  participant W as Browser\n  participant A as API\n  participant Q as Kafka\n  W->>A: POST /x\n  A->>Q: enqueue\n  A-->>W: 202',
    );
    classifyPlanes(doc);
    const [request, enqueue, reply] = doc.messages;
    assert.equal(isObservable(doc, request!), true);
    assert.equal(isObservable(doc, enqueue!), false);
    assert.equal(isObservable(doc, reply!), true);
  });
});

// --- the extract arm --------------------------------------------------------

describe('sequence diagrams as documents', () => {
  it('routes .mmd through the sequence format and surfaces skips on note', async () => {
    assert.equal(formatFor('order.mmd'), 'sequence');
    assert.equal(formatFor('order.puml'), 'sequence');

    const bytes = Buffer.from(await readFile(join(FIXTURES, 'order.mmd')));
    const document = extractDocument('order.mmd', bytes);
    assert.equal(document.format, 'sequence');
    // The loop refusal and the opt note must reach the person, not a log.
    assert.match(document.note, /loop/);
  });

  it('throws on a .mmd that does not parse, rather than handing the model prose', () => {
    assert.throws(
      () => extractDocument('broken.mmd', Buffer.from('this is not a diagram')),
      /could not read the sequence diagram/,
    );
  });
});

// --- the matcher ------------------------------------------------------------

function call(overrides: Partial<NetworkCall>): NetworkCall {
  return {
    id: '1',
    method: 'GET',
    url: 'https://app.test/api/thing',
    resourceType: 'Fetch',
    startedAt: 0,
    status: 200,
    endedAt: 5,
    durationMs: 5,
    ...overrides,
  };
}

describe('ordered-subsequence matching', () => {
  const observed = [
    call({ id: 'a', method: 'GET', url: 'https://app.test/analytics/beat' }),
    call({ id: 'b', method: 'POST', url: 'https://app.test/api/orders', status: 201 }),
    call({ id: 'c', method: 'GET', url: 'https://app.test/analytics/beat' }),
    call({ id: 'd', method: 'GET', url: 'https://app.test/api/orders/42' }),
  ];

  it('matches expected calls in relative order, interleaved traffic ignored', () => {
    const result = matchExpectedCalls(observed, [
      { method: 'POST', url: '/api/orders', status: '2xx' },
      { method: 'GET', url: '/api/orders/:id' },
    ]);
    assert.equal(result.complete, true);
    assert.equal(result.matches[0]?.call?.id, 'b');
    assert.equal(result.matches[1]?.call?.id, 'd');
  });

  it('fails when the relative order is violated', () => {
    const result = matchExpectedCalls(observed, [
      { method: 'GET', url: '/api/orders/{id}' },
      { method: 'POST', url: '/api/orders' },
    ]);
    assert.equal(result.complete, false);
  });

  it('a status pin never matches an in-flight or orphaned-redirect record', () => {
    const inFlight = call({ status: undefined, endedAt: undefined, durationMs: undefined });
    assert.equal(callSatisfies(inFlight, { method: 'GET', url: '/api/thing', status: 200 }), false);
    assert.equal(
      callSatisfies(inFlight, { method: 'GET', url: '/api/thing' }),
      false,
      'omitted status means completed — in-flight is not evidence of anything yet',
    );
  });

  it('accepts both {id} and :id template forms, methods case-insensitively', () => {
    assert.equal(matchesCall('post', 'https://x.test/api/orders/9?page=2', 'POST', '/api/orders/{id}'), true);
    assert.equal(matchesCall('POST', '/api/orders/9', 'post', '/api/orders/:id'), true);
    assert.equal(matchesCall('GET', '/api/orders/9', 'DELETE', '/api/orders/:id'), false);
  });

  it('flags every observed hit of a never template, whatever the status', () => {
    const hits = neverViolations(observed, [{ method: 'GET', url: '/analytics/beat' }]);
    assert.equal(hits.length, 2);
  });
});

describe('the flat authored form of an expected call', () => {
  it('parses method, template, status and the never prefix', () => {
    assert.deepEqual(parseExpectedCallEntry('POST /api/orders -> 2xx'), {
      never: false,
      call: { method: 'POST', url: '/api/orders', status: '2xx' },
    });
    assert.deepEqual(parseExpectedCallEntry('never: DELETE /api/orders/:id'), {
      never: true,
      call: { method: 'DELETE', url: '/api/orders/:id' },
    });
    assert.deepEqual(parseExpectedCallEntry('get /api/cart -> 200')?.call, {
      method: 'GET',
      url: '/api/cart',
      status: 200,
    });
  });

  it('refuses what it cannot parse rather than guessing', () => {
    assert.equal(parseExpectedCallEntry('just words'), null);
    assert.equal(parseExpectedCallEntry('POST /api/x -> banana'), null);
  });
});

// --- authoring: the flat fields narrow into real steps ----------------------

describe('authoring the new actions', () => {
  const blank = { case: null, selector: '', value: '', url: '', key: '', name: '', intent: 'x' };
  const payload = {
    name: 'order is submitted and persisted',
    rationale: 'proves the journey writes what it claims',
    setup: [{ ...blank, action: 'goto', url: '/checkout' }],
    steps: [
      { ...blank, action: 'click', selector: 'role=button[name="Place order"]' },
      {
        ...blank,
        action: 'expectCalls',
        value: 'POST /api/orders -> 2xx; GET /api/orders/:id; never: DELETE /api/orders/:id',
      },
      {
        ...blank,
        action: 'expectDbRow',
        name: 'orders',
        key: 'id = {{orderId}}',
        value: 'status = pending',
      },
      { ...blank, action: 'expectDbDelta', name: 'orders', value: '1', key: 'before' },
    ],
    teardown: [],
    notes: '',
  };

  it('narrows expectCalls entries and DB conditions when tables are declared', async () => {
    const model = new LlmFlowAuthorModel({
      model: jsonModel('mock-author', payload, { inputTokens: 10, outputTokens: 10 }),
      id: 'mock:author',
    });
    const result = await model.author({
      prompt: 'prove the order persists',
      tables: [{ name: 'orders', summary: 'id:uuid pk · status:text' }],
    });

    assert.equal(result.droppedSteps, 0);
    const calls = result.steps.find((s) => s.action === 'expectCalls');
    assert.ok(calls && calls.action === 'expectCalls');
    assert.deepEqual(calls.calls, [
      { method: 'POST', url: '/api/orders', status: '2xx' },
      { method: 'GET', url: '/api/orders/:id' },
    ]);
    assert.deepEqual(calls.never, [{ method: 'DELETE', url: '/api/orders/:id' }]);

    const row = result.steps.find((s) => s.action === 'expectDbRow');
    assert.ok(row && row.action === 'expectDbRow');
    assert.equal(row.table, 'orders');
    assert.deepEqual(row.where, { id: '{{orderId}}' });
    assert.deepEqual(row.values, { status: 'pending' });

    const delta = result.steps.find((s) => s.action === 'expectDbDelta');
    assert.ok(delta && delta.action === 'expectDbDelta');
    assert.equal(delta.delta, 1);
    assert.equal(delta.since, 'before');
  });

  it('drops DB steps when no table inventory was given — the structural half of the permission', async () => {
    const model = new LlmFlowAuthorModel({
      model: jsonModel('mock-author', payload, { inputTokens: 10, outputTokens: 10 }),
      id: 'mock:author',
    });
    const result = await model.author({ prompt: 'prove the order persists' });

    assert.equal(
      result.steps.some((s) => s.action === 'expectDbRow' || s.action === 'expectDbDelta'),
      false,
    );
    assert.equal(result.droppedSteps, 2, 'the refusal is counted, never silent');
    // expectCalls needs no inventory — its endpoints come from the request.
    assert.equal(
      result.steps.some((s) => s.action === 'expectCalls'),
      true,
    );
  });
});

// --- the step's place in the machinery --------------------------------------

describe('expectCalls in the flow model', () => {
  it('counts as an assertion, and keeps a flow on the browser path', () => {
    const steps: Flow['steps'] = [
      { action: 'request', method: 'GET', url: '/api/x' },
      { action: 'expectCalls', calls: [{ method: 'GET', url: '/api/x' }] },
    ];
    assert.equal(hasAssertion(steps), true);
    assert.equal(
      isBrowserFree({ name: 'f', steps }),
      false,
      'expectCalls needs the live observer — dispatching it browser-free would leave it nothing to assert on',
    );
  });

  it('classifies observation problems as environment, never app failures', () => {
    const error = new ObservationUnavailableError('no observer attached');
    assert.equal(classifyError(error), EXIT.environment);
    assert.equal(
      exitCodeFor({ status: 'error', error: 'network observation truncated: dropped 40 call(s)' }),
      EXIT.environment,
    );
  });
});

// --- against a real page ----------------------------------------------------

const browserReady = await cdpAvailable(CDP_URL);
const skipBrowser = browserReady
  ? false
  : `no CDP endpoint at ${CDP_URL} — start Chrome with --remote-debugging-port=9222 (npm run chrome)`;

const FIXTURE_HTML = `<!doctype html>
<html><body>
  <h1>Checkout</h1>
  <button id="place">Place order</button>
  <script>
    fetch('/analytics/beat');
    document.getElementById('place').addEventListener('click', async () => {
      await fetch('/api/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      await fetch('/api/orders/42');
    });
  </script>
</body></html>`;

describe('expectCalls against live traffic (CDP)', { skip: skipBrowser }, () => {
  let server: Server;
  let origin: string;

  before(async () => {
    server = createServer((req, res) => {
      if (req.url?.startsWith('/api/orders') && req.method === 'POST') {
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end('{"id":42}');
        return;
      }
      if (req.url?.startsWith('/api/') || req.url?.startsWith('/analytics/')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(FIXTURE_HTML);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    // Chrome holds keep-alive sockets open; without this close() blocks for ~60s.
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it('proves order and endpoints through interleaved noise, polling out in-flight calls', async () => {
    const flow: Flow = {
      name: 'sequence-live',
      baseUrl: origin,
      steps: [
        { action: 'goto', url: '/' },
        { action: 'click', selector: '#place', intent: 'place the order' },
        {
          action: 'expectCalls',
          calls: [
            { method: 'POST', url: '/api/orders', status: '2xx' },
            { method: 'GET', url: '/api/orders/:id' },
          ],
          never: [{ method: 'DELETE', url: '/api/orders/:id' }],
          intent: 'the journey submits the order and re-reads it, and never deletes',
        },
      ],
    };

    const bundle = await runFlow(flow, { cdpUrl: CDP_URL, video: 'off', historyPath: null });

    assert.equal(bundle.status, 'passed', bundle.error ?? 'run should pass');
    const step = bundle.steps.find((s) => s.action === 'expectCalls')!;
    assert.equal(step.status, 'passed');
    const lines = step.detail?.['calls'] as string[];
    assert.ok(lines.every((line) => line.includes('matched:')));
    // Backend-tier attribution: the traffic claim counts on the backend side.
    assert.ok(bundle.summary.backend.steps >= 1);
  });

  it('fails honestly on a call that never happens, and names the first miss', async () => {
    const flow: Flow = {
      name: 'sequence-miss',
      baseUrl: origin,
      steps: [
        { action: 'goto', url: '/' },
        {
          action: 'expectCalls',
          calls: [{ method: 'POST', url: '/api/refunds' }],
          timeoutMs: 1_500,
          intent: 'a refund is never part of this journey, so this must fail',
        },
      ],
    };

    const bundle = await runFlow(flow, { cdpUrl: CDP_URL, video: 'off', historyPath: null });

    assert.equal(bundle.status, 'failed');
    const step = bundle.steps.find((s) => s.action === 'expectCalls')!;
    assert.equal(step.status, 'failed');
    assert.match(step.error ?? '', /POST \/api\/refunds — not observed/);
  });

  it('fails immediately on a forbidden call, naming it', async () => {
    const flow: Flow = {
      name: 'sequence-never',
      baseUrl: origin,
      steps: [
        { action: 'goto', url: '/' },
        {
          action: 'expectCalls',
          never: [{ method: 'GET', url: '/analytics/beat' }],
          timeoutMs: 4_000,
          intent: 'analytics is forbidden in this build',
        },
      ],
    };

    const bundle = await runFlow(flow, { cdpUrl: CDP_URL, video: 'off', historyPath: null });

    assert.equal(bundle.status, 'failed');
    const step = bundle.steps.find((s) => s.action === 'expectCalls')!;
    assert.match(step.error ?? '', /observed a call the flow forbids/);
  });

  it('is an environment error, not an app failure, when observation is off', async () => {
    const flow: Flow = {
      name: 'sequence-unobserved',
      baseUrl: origin,
      steps: [
        { action: 'goto', url: '/' },
        { action: 'expectCalls', calls: [{ method: 'GET', url: '/api/x' }], timeoutMs: 1_000 },
      ],
    };

    const bundle = await runFlow(flow, {
      cdpUrl: CDP_URL,
      video: 'off',
      historyPath: null,
      network: false,
    });

    const step = bundle.steps.find((s) => s.action === 'expectCalls')!;
    assert.equal(step.status, 'error', 'a harness fact is an error, not a test failure');
    assert.match(step.error ?? '', /network observation unavailable/);
    assert.equal(
      bundle.defects.some((d) => d.title.includes('expectCalls')),
      false,
      'no application defect for a check the harness could not make',
    );
  });
});
