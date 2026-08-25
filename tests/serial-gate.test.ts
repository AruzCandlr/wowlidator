/**
 * Admission control for a one-call-at-a-time provider.
 *
 * Pure: the gate is promises and counters. The one integration test drives
 * `generateStructuredForModel` with a `local` role against a mock model, so
 * the path a real run takes is the path proved here.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { z } from 'zod';

import { loadConfig } from '../src/config.js';
import {
  LlmFactory,
  generateStructuredForModel,
  resetStructuredBreaker,
} from '../src/providers/llm-factory.js';
import {
  SerialGate,
  dedupeKeyFor,
  resetSerialGates,
  serialGateFor,
} from '../src/providers/serial-gate.js';
import { callsTo, jsonModel } from './helpers.js';

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('SerialGate', () => {
  it('admits at most maxInFlight calls and queues the rest', async () => {
    const gate = new SerialGate({ maxInFlight: 2 });
    const holds = [deferred(), deferred(), deferred()];
    const started: number[] = [];
    const runs = holds.map((h, i) =>
      gate.run('healer', 10, async () => {
        started.push(i);
        await h.promise;
        return i;
      }),
    );
    await tick();
    assert.deepEqual(started, [0, 1]);
    assert.equal(gate.snapshot().waiting, 1);
    holds[0]!.resolve();
    await tick();
    assert.deepEqual(started, [0, 1, 2]);
    holds[1]!.resolve();
    holds[2]!.resolve();
    await Promise.all(runs);
    assert.deepEqual(gate.snapshot(), { inFlight: 0, largeInFlight: 0, waiting: 0 });
  });

  it('lets one large prompt in at a time, and small calls ride beside it', async () => {
    const gate = new SerialGate({ maxInFlight: 2, maxLargeInFlight: 1, largePromptChars: 100 });
    const big1 = deferred();
    const big2 = deferred();
    const small = deferred();
    const started: string[] = [];
    const a = gate.run('generator', 500, async () => { started.push('big1'); await big1.promise; });
    const b = gate.run('generator', 500, async () => { started.push('big2'); await big2.promise; });
    const c = gate.run('healer', 20, async () => { started.push('small'); await small.promise; });
    await tick();
    // The second large prompt waits on the large cap; the small one does not.
    assert.deepEqual(started, ['big1', 'small']);
    small.resolve();
    await tick();
    assert.deepEqual(started, ['big1', 'small'], 'a free slot does not admit a second large prompt');
    big1.resolve();
    await tick();
    assert.deepEqual(started, ['big1', 'small', 'big2']);
    big2.resolve();
    await Promise.all([a, b, c]);
  });

  it('serves the role with the most waiting on it first, FIFO within a role', async () => {
    const gate = new SerialGate({ maxInFlight: 1 });
    const hold = deferred();
    const order: string[] = [];
    const first = gate.run('generator', 10, async () => { await hold.promise; });
    await tick();
    const rest = [
      gate.run('generator', 10, async () => { order.push('gen-a'); }),
      gate.run('data', 10, async () => { order.push('data'); }),
      gate.run('healer', 10, async () => { order.push('healer'); }),
      gate.run('generator', 10, async () => { order.push('gen-b'); }),
      gate.run('agent', 10, async () => { order.push('agent'); }),
    ];
    hold.resolve();
    await Promise.all([first, ...rest]);
    assert.deepEqual(order, ['agent', 'healer', 'data', 'gen-a', 'gen-b']);
  });

  it('asks an identical in-flight question once and tells the joiner so', async () => {
    const gate = new SerialGate({ maxInFlight: 4 });
    const hold = deferred<string>();
    let calls = 0;
    const call = async () => { calls++; return hold.promise; };
    const a = gate.run('healer', 10, call, 'k');
    const b = gate.run('healer', 10, call, 'k');
    const c = gate.run('healer', 10, call, 'other');
    await tick();
    assert.equal(calls, 2);
    hold.resolve('answer');
    const [ra, rb, rc] = await Promise.all([a, b, c]);
    assert.deepEqual([ra.joined, rb.joined, rc.joined], [false, true, false]);
    assert.equal(rb.result, 'answer');
    // Once the call has landed, the same question is asked again (the page
    // may have changed) — dedupe is for calls in flight, not a cache.
    await gate.run('healer', 10, call, 'k');
    assert.equal(calls, 3);
  });

  it('releases the slot when the call throws', async () => {
    const gate = new SerialGate({ maxInFlight: 1 });
    await assert.rejects(gate.run('healer', 10, async () => { throw new Error('boom'); }));
    assert.equal(gate.snapshot().inFlight, 0);
    const { result } = await gate.run('healer', 10, async () => 'ok');
    assert.equal(result, 'ok');
  });

  it('keys a gate per server, so two ports are two resources', () => {
    resetSerialGates();
    assert.equal(serialGateFor('http://localhost:8080/v1'), serialGateFor('http://localhost:8080/v1'));
    assert.notEqual(serialGateFor('http://localhost:8080/v1'), serialGateFor('http://localhost:8081/v1'));
  });

  it('dedupe keys differ on any part and are stable', () => {
    assert.equal(dedupeKeyFor(['healer', 'a', 'b']), dedupeKeyFor(['healer', 'a', 'b']));
    assert.notEqual(dedupeKeyFor(['healer', 'a', 'b']), dedupeKeyFor(['agent', 'a', 'b']));
    assert.notEqual(dedupeKeyFor(['healer', 'a', 'b']), dedupeKeyFor(['healer', 'a', 'c']));
  });
});

describe('generateStructuredForModel through the gate', () => {
  afterEach(() => {
    resetSerialGates();
    resetStructuredBreaker();
  });

  it('makes one model call for two identical local questions, charging tokens once', async () => {
    const config = loadConfig({
      WOWLIDATOR_HEALER_PROVIDER: 'local',
      GROQ_API_KEY: 'k',
      GOOGLE_GENERATIVE_AI_API_KEY: 'k',
    } as NodeJS.ProcessEnv);
    const model = jsonModel('default_model', { answer: 'x' }, { inputTokens: 40, outputTokens: 4 });
    const factory = new LlmFactory(config, { local: () => model });
    const schema = z.object({ answer: z.string() });
    const request = { modelLabel: 'local:default_model', schema, system: 's', prompt: 'same question' };
    const source = { factory, role: 'healer' as const };
    const [a, b] = await Promise.all([
      generateStructuredForModel(source, request),
      generateStructuredForModel(source, request),
    ]);
    assert.equal(callsTo(model), 1);
    assert.deepEqual(a.object, { answer: 'x' });
    assert.deepEqual(b.object, { answer: 'x' });
    assert.equal((a.inputTokens ?? 0) + (b.inputTokens ?? 0), 40);
  });

  it('leaves a non-serial provider ungated', async () => {
    const config = loadConfig({
      GROQ_API_KEY: 'k',
      GOOGLE_GENERATIVE_AI_API_KEY: 'k',
    } as NodeJS.ProcessEnv);
    const model = jsonModel('m', { answer: 'x' }, { inputTokens: 1, outputTokens: 1 });
    const factory = new LlmFactory(config, { groq: () => model, google: () => model });
    const schema = z.object({ answer: z.string() });
    const request = { modelLabel: 'groq:m', schema, system: 's', prompt: 'same question' };
    const source = { factory, role: 'healer' as const };
    await Promise.all([
      generateStructuredForModel(source, request),
      generateStructuredForModel(source, request),
    ]);
    assert.equal(callsTo(model), 2);
  });
});
