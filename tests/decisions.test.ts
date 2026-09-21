/**
 * The decisions route (`src/providers/decisions.ts`): TypeSafe's Jev, natively
 * or through OpenRouter. Unit tier, always: the transport is an injected
 * fetch, the failover a real `LlmFactory` over a two-key config, the doctor
 * probe the real `probeRole`. Nothing here calls a network.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { APICallError } from 'ai';

import { ConfigError, isDecisionModel, loadConfig } from '../src/config.js';
import {
  DecisionsAnswerError,
  OPENROUTER_DECISIONS_URL,
  PROBE_DECISION_REQUEST,
  TYPESAFE_DECISIONS_URL,
  askDecisions,
  asText,
  decisionsRouteFor,
  postDecisions,
  validateChoice,
  validateNoul,
  type DecisionsRequest,
} from '../src/providers/decisions.js';
import { AllKeysExhaustedError, LlmFactory, generateStructuredForModel } from '../src/providers/llm-factory.js';
import { z } from 'zod';
import { jsonModel } from './helpers.js';
import { setLlmLogSink } from '../src/providers/llm-log.js';
import { probeRole } from '../src/providers/probe.js';
import { ModelSelection } from '../src/ui/models.js';

const QUIET = { WOWLIDATOR_LLM_LOG: 'off' };
process.env['WOWLIDATOR_LLM_LOG'] = QUIET.WOWLIDATOR_LLM_LOG;

const ROUTE = decisionsRouteFor({ provider: 'openrouter', modelId: '~typesafe/jev-latest' })!;

const REQUEST: DecisionsRequest = {
  state: { page: { url: 'http://x.test/login' }, elements: [{ index: 1, role: 'button', label: 'Sign in' }] },
  questions: {
    operation: { type: 'choice', instructions: asText({ goal: 'sign in' }), criteria: { CLICK: 'press', DONE: null } },
    click_target: { type: 'choice', instructions: 'which', criteria: { '1': asText({ element: '[1] button Sign in' }) } },
  },
};

const GOOD = {
  model: 'typesafe/jev-1.13-20260917',
  answers: {
    operation: { type: 'choice', choice: 'CLICK', probabilities: { CLICK: 0.97, DONE: 0.03 }, confidence: 0.95 },
    click_target: { type: 'choice', choice: '1', probabilities: { '1': 1 }, confidence: 0.99 },
  },
  usage: { input_tokens: 1200, output_tokens: 130, cost: 0.00005 },
};

interface Call {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fetch that answers a script of responses in order and records every call. */
function scriptedFetch(replies: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: Call[] = [];
  let n = 0;
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const reply = replies[Math.min(n, replies.length - 1)]!;
    n += 1;
    const headers = init?.headers as Record<string, string>;
    calls.push({ url: String(url), headers, body: JSON.parse(String(init?.body)) });
    return new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json', ...(reply.headers ?? {}) },
    });
  }) as unknown as typeof fetch;
  return { fetch: fetchFn, calls };
}

const noSleep = async (): Promise<void> => undefined;

describe('the decisions route is chosen by (provider, model)', () => {
  it('routes typesafe natively and a ~typesafe/ id on openrouter to the Decisions endpoint', () => {
    assert.deepEqual(decisionsRouteFor({ provider: 'typesafe', modelId: 'jev-latest' }), {
      provider: 'typesafe',
      url: TYPESAFE_DECISIONS_URL,
      model: 'jev-latest',
      label: 'typesafe:jev-latest',
    });
    assert.equal(ROUTE.url, OPENROUTER_DECISIONS_URL);
    assert.equal(ROUTE.label, 'openrouter:~typesafe/jev-latest');
    assert.equal(decisionsRouteFor({ provider: 'openrouter', modelId: 'typesafe/jev-1.13' })?.url, OPENROUTER_DECISIONS_URL);
  });

  it('leaves every chat model alone', () => {
    assert.equal(decisionsRouteFor({ provider: 'openrouter', modelId: 'google/gemini-3.6-flash' }), null);
    assert.equal(decisionsRouteFor({ provider: 'groq', modelId: 'openai/gpt-oss-120b' }), null);
    assert.equal(isDecisionModel('claude-cli', 'typesafe/jev'), false, 'the id alone is not the route');
  });

  it('config accepts the agent role on Jev and refuses every other role at startup', () => {
    const config = loadConfig({
      WOWLIDATOR_AGENT_PROVIDER: 'openrouter',
      WOWLIDATOR_AGENT_MODEL: '~typesafe/jev-latest',
      OPENROUTER_API_KEY: 'sk-or-v1-abcdefghijkl',
      TYPESAFE_API_KEY: 'ts-key-abcdefghij',
    });
    assert.equal(config.roles.agent.modelId, '~typesafe/jev-latest');
    assert.deepEqual(config.apiKeys.typesafe, ['ts-key-abcdefghij']);
    assert.equal(loadConfig({ WOWLIDATOR_AGENT_PROVIDER: 'typesafe' }).roles.agent.modelId, 'jev-latest', 'the alias is the default');
    assert.throws(
      () => loadConfig({ WOWLIDATOR_HEALER_PROVIDER: 'typesafe' }),
      (error: unknown) => error instanceof ConfigError && /decision model.*"agent" role/.test(error.message),
    );
    assert.throws(
      () => loadConfig({ WOWLIDATOR_GENERATOR_PROVIDER: 'openrouter', WOWLIDATOR_GENERATOR_MODEL: 'typesafe/jev-1.13' }),
      ConfigError,
    );
  });

  it('a decision model resolved as a LanguageModel refuses to be asked, naming the seam', async () => {
    const factory = new LlmFactory(loadConfig({ WOWLIDATOR_AGENT_PROVIDER: 'typesafe', TYPESAFE_API_KEY: 'ts-key-abcdefghij' }));
    const resolved = factory.forRole('agent');
    assert.equal(resolved.id, 'typesafe:jev-latest');
    const model = resolved.model as unknown as { doGenerate: (call: unknown) => Promise<unknown> };
    await assert.rejects(model.doGenerate({}), /decision model.*decisions\.ts/);
  });
});

describe('the answer contract (jev-ultrafast validate_choice, ported)', () => {
  it('accepts a distribution over exactly the offered options', () => {
    const answer = validateChoice(GOOD.answers.operation, ['CLICK', 'DONE']);
    assert.equal(answer.choice, 'CLICK');
    assert.equal(answer.confidence, 0.95);
  });

  it('accepts a choice within the two-decimal rounding of the maximum, and still refuses one clearly below it (HUMI 1.001)', () => {
    // Live: CLICK at 0.39 beside SCROLL_DOWN at 0.40 ended a whole leg as a model failure.
    const tie = { choice: 'CLICK', probabilities: { CLICK: 0.39, SCROLL_DOWN: 0.4, DONE: 0.21 }, confidence: 0.27 };
    assert.equal(validateChoice(tie, ['CLICK', 'SCROLL_DOWN', 'DONE']).choice, 'CLICK', 'the model\'s own choice stands within rounding');
    const below = { choice: 'CLICK', probabilities: { CLICK: 0.3, SCROLL_DOWN: 0.5, DONE: 0.2 }, confidence: 0.2 };
    assert.throws(() => validateChoice(below, ['CLICK', 'SCROLL_DOWN', 'DONE']), DecisionsAnswerError);
  });

  it('refuses a choice outside the offer, a distribution over other options, a bad sum, and a non-argmax choice', () => {
    const base = GOOD.answers.operation;
    assert.throws(() => validateChoice({ ...base, choice: 'TYPE_TEXT' }, ['CLICK', 'DONE']), DecisionsAnswerError);
    assert.throws(() => validateChoice(base, ['CLICK', 'DONE', 'BLOCKED']), DecisionsAnswerError);
    assert.throws(() => validateChoice({ ...base, probabilities: { CLICK: 0.6, DONE: 0.6 } }, ['CLICK', 'DONE']), DecisionsAnswerError);
    assert.throws(() => validateChoice({ ...base, choice: 'DONE' }, ['CLICK', 'DONE']), DecisionsAnswerError);
    assert.throws(() => validateChoice({ ...base, probabilities: { CLICK: '0.97', DONE: 0.03 } }, ['CLICK', 'DONE']), DecisionsAnswerError);
    assert.throws(() => validateChoice(null, ['CLICK']), DecisionsAnswerError);
  });

  it('clamps confidence instead of voiding a correct pick, and reads a noul', () => {
    assert.equal(validateChoice({ ...GOOD.answers.operation, confidence: 1.4 }, ['CLICK', 'DONE']).confidence, 1);
    assert.equal(validateChoice({ ...GOOD.answers.operation, confidence: 'high' }, ['CLICK', 'DONE']).confidence, 0);
    assert.equal(validateNoul({ type: 'noul', noul: 0.92 }).noul, 0.92);
    assert.throws(() => validateNoul({ noul: 2 }), DecisionsAnswerError);
  });

  it('asText leaves a string alone and JSON-encodes a structure', () => {
    assert.equal(asText('plain'), 'plain');
    assert.equal(asText({ a: 1 }), '{"a":1}');
  });
});

describe('postDecisions', () => {
  it('sends the bearer, the model and the questions, and reads model, answers and usage back', async () => {
    const { fetch, calls } = scriptedFetch([{ status: 200, body: GOOD }]);
    const answer = await postDecisions(ROUTE, 'sk-or-v1-abcdefghijkl', REQUEST, { fetch, sleep: noSleep });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, OPENROUTER_DECISIONS_URL);
    assert.equal(calls[0]!.headers['Authorization'], 'Bearer sk-or-v1-abcdefghijkl');
    const body = calls[0]!.body as { model: string; state: unknown; questions: Record<string, { criteria: unknown }> };
    assert.equal(body.model, '~typesafe/jev-latest');
    assert.deepEqual(body.state, REQUEST.state);
    assert.equal(typeof (body.questions['click_target']!.criteria as Record<string, unknown>)['1'], 'string', 'criteria travel as text');
    assert.equal(answer.model, 'typesafe/jev-1.13-20260917');
    assert.deepEqual(answer.usage, { inputTokens: 1200, outputTokens: 130, costUsd: 0.00005 });
    assert.equal(validateChoice(answer.answers['operation'], ['CLICK', 'DONE']).choice, 'CLICK');
  });

  it('waits out a 429 for retry-after and asks again on the same key', async () => {
    const { fetch, calls } = scriptedFetch([{ status: 429, headers: { 'retry-after': '3' } }, { status: 200, body: GOOD }]);
    const waited: number[] = [];
    const answer = await postDecisions(ROUTE, 'sk-or-v1-abcdefghijkl', REQUEST, {
      fetch,
      sleep: async (ms) => {
        waited.push(ms);
      },
    });
    assert.equal(calls.length, 2);
    assert.deepEqual(waited, [3000]);
    assert.equal(answer.model, GOOD.model);
  });

  it('a retry-after past the cap is not waited for: the 429 is thrown at once so the factory can rotate', async () => {
    const { fetch, calls } = scriptedFetch([{ status: 429, headers: { 'retry-after': '3600' } }, { status: 200, body: GOOD }]);
    const waited: number[] = [];
    await assert.rejects(
      postDecisions(ROUTE, 'sk-or-v1-abcdefghijkl', REQUEST, { fetch, sleep: async (ms) => { waited.push(ms); } }),
      (error: unknown) => APICallError.isInstance(error) && error.statusCode === 429 && error.isRetryable === true,
    );
    assert.deepEqual(waited, [], 'no hour-long sleep');
    assert.equal(calls.length, 1);
  });

  it('an already-aborted caller is not retried on, and a fetch that never arrived is not re-sent', async () => {
    const { fetch, calls } = scriptedFetch([{ status: 503 }, { status: 200, body: GOOD }]);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(postDecisions(ROUTE, 'k-abcdefghij', REQUEST, { fetch, signal: controller.signal, sleep: noSleep }), (e: unknown) => APICallError.isInstance(e) && e.statusCode === 503);
    assert.equal(calls.length, 1);
    const dead = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    await assert.rejects(postDecisions(ROUTE, 'k-abcdefghij', REQUEST, { fetch: dead, sleep: noSleep }), /fetch failed/);
  });

  it('a response without usage reports null tokens, never zeros', async () => {
    const { fetch } = scriptedFetch([{ status: 200, body: { model: 'm', answers: GOOD.answers } }]);
    const answer = await postDecisions(ROUTE, 'k-abcdefghij', REQUEST, { fetch, sleep: noSleep });
    assert.deepEqual(answer.usage, { inputTokens: null, outputTokens: null, costUsd: null });
  });

  it('no configured key reaches a log line, even when the provider echoes it back', async () => {
    const lines: string[] = [];
    setLlmLogSink((line) => { lines.push(line); });
    const before = process.env['WOWLIDATOR_LLM_LOG'];
    process.env['WOWLIDATOR_LLM_LOG'] = 'full';
    try {
      const { fetch } = scriptedFetch([{ status: 401, body: { error: { message: 'bad key sk-or-v1-abcdefghijkl' } } }]);
      await postDecisions(ROUTE, 'sk-or-v1-abcdefghijkl', REQUEST, { fetch, sleep: noSleep }).catch(() => undefined);
    } finally {
      process.env['WOWLIDATOR_LLM_LOG'] = before;
      setLlmLogSink(null);
    }
    assert.ok(lines.length >= 2, 'the request and the failure were logged');
    assert.ok(lines.every((l) => !l.includes('sk-or-v1-abcdefghijkl')), lines.join('\n'));
  });

  it('a refused key is an APICallError with the status, and the key is in no message', async () => {
    const { fetch } = scriptedFetch([{ status: 401, body: { error: { message: 'bad key sk-or-v1-abcdefghijkl' } } }]);
    await assert.rejects(
      postDecisions(ROUTE, 'sk-or-v1-abcdefghijkl', REQUEST, { fetch, sleep: noSleep }),
      (error: unknown) =>
        APICallError.isInstance(error) &&
        error.statusCode === 401 &&
        !error.message.includes('sk-or-v1-abcdefghijkl') &&
        error.message.includes('<key 1>'),
    );
  });

  it('a body without answers is a typed answer error, never an action', async () => {
    const { fetch } = scriptedFetch([{ status: 200, body: { model: 'x' } }]);
    await assert.rejects(postDecisions(ROUTE, 'k-abcdefghij', REQUEST, { fetch, sleep: noSleep }), DecisionsAnswerError);
  });
});

describe('askDecisions rotates keys through the factory', () => {
  const config = loadConfig({
    WOWLIDATOR_AGENT_PROVIDER: 'openrouter',
    WOWLIDATOR_AGENT_MODEL: '~typesafe/jev-latest',
    OPENROUTER_API_KEY: 'sk-or-v1-firstkey0001,sk-or-v1-secondkey002',
    ...QUIET,
  });

  it('a 401 on the first key is answered on the second, and the failure is on the trail', async () => {
    const { fetch, calls } = scriptedFetch([{ status: 401, body: { error: 'nope' } }, { status: 200, body: GOOD }]);
    const factory = new LlmFactory(config);
    const failed: number[] = [];
    const answer = await askDecisions(factory, 'agent', REQUEST, {
      fetch,
      sleep: noSleep,
      onAttemptFailure: (keyIndex) => {
        failed.push(keyIndex);
      },
    });
    assert.equal(answer.model, GOOD.model);
    assert.deepEqual(failed, [0]);
    assert.equal(calls[1]!.headers['Authorization'], 'Bearer sk-or-v1-secondkey002');
    assert.equal(factory.activeKeyIndex('openrouter'), 1, 'the rotation sticks');
  });

  it('every configured key is scrubbed from a body, not only the one that sent the call', async () => {
    const { fetch } = scriptedFetch([{ status: 401, body: {} }, { status: 401, body: { error: 'first key was sk-or-v1-firstkey0001' } }]);
    await assert.rejects(
      askDecisions(new LlmFactory(config), 'agent', REQUEST, { fetch, sleep: noSleep }),
      (error: unknown) => error instanceof AllKeysExhaustedError && !JSON.stringify(error.attempts.map((a) => String((a.error as Error).message))).includes('firstkey0001'),
    );
  });

  it('every key refused is AllKeysExhaustedError; a chat role is refused outright', async () => {
    const { fetch } = scriptedFetch([{ status: 403, body: {} }]);
    await assert.rejects(askDecisions(new LlmFactory(config), 'agent', REQUEST, { fetch, sleep: noSleep }), AllKeysExhaustedError);
    await assert.rejects(askDecisions(new LlmFactory(loadConfig(QUIET)), 'agent', REQUEST, { fetch }), /not a decision model/);
  });
});

describe('the doctor probes a decisions route with one noul', () => {
  const config = loadConfig({
    WOWLIDATOR_AGENT_PROVIDER: 'openrouter',
    WOWLIDATOR_AGENT_MODEL: '~typesafe/jev-latest',
    OPENROUTER_API_KEY: 'sk-or-v1-abcdefghijkl',
    ...QUIET,
  });

  it('reports ready with the versioned model, the usage and the probability', async () => {
    const { fetch, calls } = scriptedFetch([
      { status: 200, body: { model: 'typesafe/jev-1.13-20260917', answers: { probe: { type: 'noul', noul: 0.97 } }, usage: { input_tokens: 40, output_tokens: 8 } } },
    ]);
    const probe = await probeRole(new LlmFactory(config), 'agent', { fetch });
    assert.equal(probe.status, 'ready');
    assert.equal(probe.reply, 'noul=0.97');
    assert.match(probe.detail, /typesafe\/jev-1\.13-20260917 \(decisions route\)/);
    assert.deepEqual(probe.usage, { inputTokens: 40, outputTokens: 8 });
    assert.deepEqual((calls[0]!.body as { questions: unknown }).questions, PROBE_DECISION_REQUEST.questions);
  });

  it('classifies a refused key and an out-of-quota key by status, with no key in the line', async () => {
    const rejected = await probeRole(new LlmFactory(config), 'agent', { fetch: scriptedFetch([{ status: 401, body: {} }]).fetch });
    assert.equal(rejected.status, 'rejected');
    assert.ok(!rejected.detail.includes('abcdefghijkl'));
    const exhausted = await probeRole(new LlmFactory(config), 'agent', {
      fetch: scriptedFetch([{ status: 429, body: {}, headers: { 'retry-after': '0' } }]).fetch,
    });
    assert.equal(exhausted.status, 'exhausted');
  });

  it('a role the config refuses is failed with that sentence before any call, and the panel picker refuses it too', async () => {
    const built = loadConfig({ OPENROUTER_API_KEY: 'sk-or-v1-abcdefghijkl', ...QUIET });
    built.roles.healer = { ...built.roles.healer, provider: 'openrouter', modelId: '~typesafe/jev-latest' };
    const { fetch, calls } = scriptedFetch([{ status: 200, body: {} }]);
    const probe = await probeRole(new LlmFactory(built), 'healer', { fetch });
    assert.equal(probe.status, 'failed');
    assert.match(probe.detail, /decision model.*"agent" role/);
    assert.equal(calls.length, 0);
    const picker = new ModelSelection();
    assert.throws(() => picker.select('healer', 'openrouter', '~typesafe/jev-latest'), /decision model/);
    assert.doesNotThrow(() => picker.select('agent', 'openrouter', '~typesafe/jev-latest'), 'a leading ~ is a model id here');
  });

  it('a structured question asked of a decision-model role is answered by the data role', async () => {
    const built = loadConfig({
      WOWLIDATOR_AGENT_PROVIDER: 'openrouter',
      WOWLIDATOR_AGENT_MODEL: '~typesafe/jev-latest',
      OPENROUTER_API_KEY: 'sk-or-v1-abcdefghijkl',
      GROQ_API_KEY: 'gsk_test_abcdefghij',
      ...QUIET,
    });
    const factory = new LlmFactory(built, { groq: () => jsonModel('data-stub', { value: 'from-data' }, { inputTokens: 3, outputTokens: 1 }) });
    const { object } = await generateStructuredForModel({ factory, role: 'agent' }, {
      modelLabel: 'agent',
      schema: z.object({ value: z.string() }),
      system: 'answer',
      prompt: 'what value',
      maxOutputTokens: 64,
      maxRetries: 0,
    });
    assert.equal(object.value, 'from-data', 'the data role answered what the agent role could not');
  });

  it('the factory resolves a decision model on the openrouter route to the refusing stub too', async () => {
    const factory = new LlmFactory(config);
    const model = factory.forRole('agent').model as unknown as { doGenerate: (call: unknown) => Promise<unknown> };
    await assert.rejects(model.doGenerate({}), /decision model.*decisions\.ts/);
  });

  it('reports no-key when the route has none', async () => {
    const probe = await probeRole(new LlmFactory(loadConfig({ WOWLIDATOR_AGENT_PROVIDER: 'typesafe', ...QUIET })), 'agent', {
      fetch: scriptedFetch([{ status: 200, body: {} }]).fetch,
    });
    assert.equal(probe.status, 'no-key');
    assert.match(probe.detail, /TYPESAFE_API_KEY/);
  });
});
