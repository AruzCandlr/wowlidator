/**
 * Pacing for Google's per-minute / per-day metering, and the request log.
 *
 * Pure: the pacer takes a clock, the log takes a sink. The integration test
 * drives `generateStructuredForModel` through a mock that 429s once with a
 * Google-shaped body, so the path a real run takes is the path proved.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';

import { loadConfig } from '../src/config.js';
import {
  LlmFactory,
  generateStructuredForModel,
  resetStructuredBreaker,
} from '../src/providers/llm-factory.js';
import { llmTally, resetLlmTally, setLlmLogSink } from '../src/providers/llm-log.js';
import {
  PACER_MAX_WAIT_MS,
  RateBudgetExhaustedError,
  RatePacer,
  googleLimitsFor,
  isRateLimitError,
  parseRateLimitNotice,
  resetPacers,
} from '../src/providers/rate-pacer.js';
import { jsonModel } from './helpers.js';

const GOOGLE_429_BODY = JSON.stringify({
  error: {
    code: 429,
    message: 'You exceeded your current quota, please check your plan and billing details.',
    status: 'RESOURCE_EXHAUSTED',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [
          {
            quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
            quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier',
            quotaDimensions: { model: 'gemini-2.5-flash', location: 'global' },
            quotaValue: '8',
          },
        ],
      },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '3s' },
    ],
  },
});

function google429(): APICallError {
  return new APICallError({
    message: `Too Many Requests: ${GOOGLE_429_BODY}`,
    url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=SECRET',
    requestBodyValues: {},
    statusCode: 429,
    responseHeaders: {},
    responseBody: GOOGLE_429_BODY,
    isRetryable: false,
  });
}

describe('parseRateLimitNotice', () => {
  it('reads retryDelay, the metric that tripped and its ceiling from a Google 429', () => {
    const notice = parseRateLimitNotice(google429());
    assert.deepEqual(notice, { retryAfterS: 3, metric: 'rpm', quotaValue: 8 });
  });

  it('reads a daily metric and a retry-after header', () => {
    const body = GOOGLE_429_BODY.replace('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', 'GenerateRequestsPerDayPerProjectPerModel-FreeTier')
      .replace('"quotaValue":"8"', '"quotaValue":"250"')
      .replace(/,\{"@type":"type.googleapis.com\/google.rpc.RetryInfo","retryDelay":"3s"\}/, '');
    const notice = parseRateLimitNotice({ message: 'x', responseBody: body, responseHeaders: { 'Retry-After': '42' } });
    assert.deepEqual(notice, { retryAfterS: 42, metric: 'rpd', quotaValue: 250 });
  });

  it('yields nulls for an error that says nothing', () => {
    assert.deepEqual(parseRateLimitNotice(new Error('socket hang up')), { retryAfterS: null, metric: null, quotaValue: null });
  });

  it('recognises a 429 by status or by wording', () => {
    assert.equal(isRateLimitError(google429()), true);
    assert.equal(isRateLimitError(new Error('RESOURCE_EXHAUSTED')), true);
    assert.equal(isRateLimitError(new Error('invalid api key')), false);
  });
});

describe('googleLimitsFor', () => {
  it('knows the documented tier and lets the environment override it', () => {
    assert.deepEqual(googleLimitsFor('gemini-2.5-flash', {}), { rpm: 10, tpm: 250_000, rpd: 250 });
    assert.deepEqual(googleLimitsFor('gemini-2.5-flash', { WOWLIDATOR_GOOGLE_RPM: '1000', WOWLIDATOR_GOOGLE_RPD: 'nope' }), {
      rpm: 1000,
      tpm: 250_000,
      rpd: 250,
    });
    // An id not in the table gets the default, never "no limit".
    assert.deepEqual(googleLimitsFor('gemini-9-ultra', {}), { rpm: 10, tpm: 250_000, rpd: 250 });
  });
});

describe('RatePacer', () => {
  function clock(start = 1_000_000) {
    let now = start;
    return { now: () => now, advance: (ms: number) => (now += ms) };
  }

  it('lets calls through until headroom is reached, then waits for the oldest to age out', async () => {
    const c = clock();
    const lines: string[] = [];
    const pacer = new RatePacer('t', { rpm: 10, tpm: null, rpd: null }, { now: c.now, log: (l) => lines.push(l) });
    // 90% of 10 = 9 requests fit in the minute.
    for (let i = 0; i < 9; i++) {
      assert.equal(pacer.waitFor(10), 0, `call ${i} fits`);
      await pacer.reserve(10, 'healer');
      pacer.record({ inputTokens: 10, outputTokens: 1 }, 10);
      c.advance(1000);
    }
    const wait = pacer.waitFor(10);
    assert.ok(wait > 50_000 && wait <= 60_000, `waits for the oldest sample to leave the minute, got ${wait}`);
    c.advance(wait);
    assert.equal(pacer.waitFor(10), 0);
  });

  it('counts tokens per minute, so one large prompt can be the whole budget', () => {
    const c = clock();
    const pacer = new RatePacer('t', { rpm: null, tpm: 1000, rpd: null }, { now: c.now });
    assert.equal(pacer.waitFor(899), 0);
    assert.ok(pacer.waitFor(901) === 0, 'nothing sent yet: an oversized call is sent, not waited on forever');
    pacer.record({ inputTokens: 600, outputTokens: 0 }, 600);
    assert.ok(pacer.waitFor(400) > 0, 'the next 400 would cross 90% of 1000');
  });

  it('treats the believed day cap as advisory, and stops only when the server says the day is spent', async () => {
    // Live: a model id missing from the table fell back to 250 RPD on a
    // 500-RPD tier, and seventy cases were blocked by the pacer, not by
    // Google. A guess warns once and keeps going.
    const c = clock();
    const lines: string[] = [];
    const pacer = new RatePacer('t', { rpm: null, tpm: null, rpd: 10 }, { now: c.now, log: (l) => lines.push(l) });
    for (let i = 0; i < 9; i++) pacer.record({ inputTokens: 1, outputTokens: 1 }, 1);
    assert.equal(await pacer.reserve(1, 'generator'), 0, 'still sends');
    assert.equal(lines.filter((l) => /believed to have/.test(l)).length, 1, 'warned once');
    pacer.record({ inputTokens: 1, outputTokens: 1 }, 1);
    await pacer.reserve(1, 'generator');
    assert.equal(lines.filter((l) => /believed to have/.test(l)).length, 1, 'not again');
    // The server names the DAILY quota: now the day is over.
    const body = GOOGLE_429_BODY.replace('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', 'GenerateRequestsPerDayPerProjectPerModel-FreeTier');
    pacer.learnFrom({ message: 'x', responseBody: body }, 'generator');
    await assert.rejects(pacer.reserve(1, 'generator'), RateBudgetExhaustedError);

    const slow = new RatePacer('t2', { rpm: 2, tpm: null, rpd: null }, { now: c.now, log: () => {} });
    slow.record({ inputTokens: 1, outputTokens: 1 }, 1);
    slow.record({ inputTokens: 1, outputTokens: 1 }, 1);
    // Two in the minute against an rpm of 2 (headroom floor = 1): must wait ~60s, under the cap.
    assert.ok(slow.waitFor(1) <= PACER_MAX_WAIT_MS);
  });

  it('learns the ceiling a 429 names and blocks for the delay it states', () => {
    const c = clock();
    const lines: string[] = [];
    const pacer = new RatePacer('t', { rpm: 10, tpm: null, rpd: null }, { now: c.now, log: (l) => lines.push(l) });
    const delay = pacer.learnFrom(google429(), 'generator');
    assert.equal(delay, 3250);
    assert.equal(pacer.limits.rpm, 8);
    assert.ok(pacer.waitFor(1) >= 3000, 'blocked until the retryDelay has passed');
    assert.match(lines[0]!, /RPM is 8 \(the server said so\); was 10/);
    c.advance(4000);
    assert.equal(pacer.waitFor(1), 0);
  });

  it('persists the day across processes and keeps the larger count on merge', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wow-pacer-'));
    const store = join(dir, 'llm-usage.json');
    const a = new RatePacer('google:m@…abcd', { rpm: null, tpm: null, rpd: 100 }, { store });
    a.record({ inputTokens: 5, outputTokens: 5 }, 5);
    a.record({ inputTokens: 5, outputTokens: 5 }, 5);
    await new Promise((r) => setTimeout(r, 50));
    const b = new RatePacer('google:m@…abcd', { rpm: null, tpm: null, rpd: 100 }, { store });
    await b.load();
    assert.equal(b.snapshot().day.requests, 2);
    const saved = JSON.parse(await readFile(store, 'utf8'));
    assert.ok(Object.keys(saved)[0]!.endsWith('…abcd'), 'only the key tail is stored');
  });
});

describe('a paced Google role through generateStructuredForModel', () => {
  const lines: string[] = [];
  // Never the real usage file: a mock 429 must not count against today's tally.
  process.env['WOWLIDATOR_LLM_USAGE_STORE'] = 'off';
  afterEach(() => {
    resetPacers();
    resetStructuredBreaker();
    resetLlmTally();
    setLlmLogSink(null);
    lines.length = 0;
  });

  function factoryWith(model: MockLanguageModelV4) {
    const config = loadConfig({
      WOWLIDATOR_HEALER_PROVIDER: 'google',
      WOWLIDATOR_HEALER_MODEL: 'gemini-2.5-flash',
      GROQ_API_KEY: 'k',
      GOOGLE_GENERATIVE_AI_API_KEY: 'AIzaSyTESTKEY1234',
    } as NodeJS.ProcessEnv);
    return new LlmFactory(config, { google: () => model });
  }

  it('waits out a 429 for the stated delay, retries on the same key, and logs request and response', async () => {
    setLlmLogSink((l) => lines.push(l));
    let calls = 0;
    const model = new MockLanguageModelV4({
      provider: 'mock',
      modelId: 'gemini-2.5-flash',
      doGenerate: async () => {
        calls++;
        if (calls === 1) throw google429();
        return {
          content: [{ type: 'text', text: JSON.stringify({ answer: 'ok' }) }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: {
            inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 3, text: 3, reasoning: 0 },
          },
          warnings: [],
        };
      },
    });
    const factory = factoryWith(model);
    const started = Date.now();
    const response = await generateStructuredForModel(
      { factory, role: 'healer' },
      {
        modelLabel: 'google:gemini-2.5-flash',
        schema: z.object({ answer: z.string() }),
        system: 'sys',
        prompt: 'repair role=button[name="Go"]',
        maxRetries: 0,
        task: 'step 3',
      },
    );
    assert.deepEqual(response.object, { answer: 'ok' });
    assert.equal(calls, 2);
    assert.ok(Date.now() - started >= 3000, 'honoured the 3s retryDelay');
    assert.equal(factory.activeKeyIndex('google'), 0, 'did not rotate keys over a minute limit');

    const text = lines.join('\n');
    assert.match(text, /→ healer · step 3 · google:gemini-2.5-flash · request #1/);
    assert.match(text, /ask: repair role=button/);
    assert.match(text, /✗ healer · step 3 .* retrying in 3s/);
    assert.match(text, /request #2 \(attempt 2\)/);
    assert.match(text, /← healer · step 3 .* 12 in \/ 3 out .* session: 2 req, 12 in \/ 3 out/);
    assert.match(text, /response: \{"answer":"ok"\}/);
    assert.doesNotMatch(text, /AIzaSyTESTKEY1234|key=SECRET/, 'no key and no keyed URL reaches the log');
    assert.match(text, /RPM is 8 \(the server said so\)/);
    assert.equal(llmTally().requests, 2);
  });

  it('is silent with WOWLIDATOR_LLM_LOG=off and untouched for a non-paced provider', async () => {
    setLlmLogSink((l) => lines.push(l));
    const prev = process.env['WOWLIDATOR_LLM_LOG'];
    process.env['WOWLIDATOR_LLM_LOG'] = 'off';
    try {
      const model = jsonModel('m', { answer: 'x' }, { inputTokens: 1, outputTokens: 1 });
      const config = loadConfig({ GROQ_API_KEY: 'k', GOOGLE_GENERATIVE_AI_API_KEY: 'k' } as NodeJS.ProcessEnv);
      const factory = new LlmFactory(config, { groq: () => model, google: () => model });
      await generateStructuredForModel(
        { factory, role: 'healer' },
        { modelLabel: 'groq:m', schema: z.object({ answer: z.string() }), system: 's', prompt: 'p' },
      );
      assert.deepEqual(lines, []);
    } finally {
      if (prev === undefined) delete process.env['WOWLIDATOR_LLM_LOG'];
      else process.env['WOWLIDATOR_LLM_LOG'] = prev;
    }
  });
});
