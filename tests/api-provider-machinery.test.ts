/**
 * An HTTP API provider gets what `claude-cli` has (2026-09-11).
 *
 * The measured case behind every assertion here: a BE catalog on
 * `emmiedev:default` at four lanes, 2026-09-10. The provider takes two calls
 * per key and answered the third `too_many_concurrent`; the SDK spent four
 * attempts inside one authoring call, the row sealed as an authoring refusal —
 * the sticky kind a `--resume` will not pick back up — and the monitor's model
 * panel was empty, because only `claude-cli` wrote a usage ledger.
 *
 * Unit tier: no browser, no model, temp files only. Every fixture is
 * hand-written — a reader tested only against its own writer proves nothing.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  API_PRESSURE_BASE_MS,
  API_PRESSURE_MAX_MS,
  apiPressureHolding,
  apiPressureHolds,
  describeApiPressure,
  noteApiRefusal,
  noteApiSuccess,
  resetApiPressure,
  statedRetryMs,
} from '../src/providers/api-pressure.js';
import {
  apiUsageEnabled,
  apiUsagePath,
  readApiUsage,
  recordApiCall,
  summarizeApiUsage,
  type ApiCallRecord,
} from '../src/providers/api-usage-log.js';
import { PROVIDER_CONCURRENCY, providerConcurrency } from '../src/config.js';
import { apiSection, buildRunState, resetApiSectionCache } from '../src/monitor/run-state.js';
import { monitorPage } from '../src/ui/monitor.js';

let dir = '';

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wow-api-'));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

// The ledger refuses to write from a test process (`NODE_TEST_CONTEXT`), which
// is the point — `npm test` must not append to the machine's real ledger. A
// test ABOUT the ledger clears that one variable for its own temp file.
const envAt = (file: string): NodeJS.ProcessEnv => ({
  WOWLIDATOR_API_USAGE_PATH: join(dir, file),
  NODE_TEST_CONTEXT: '',
});

/** The refusal emmiedev actually sends, verbatim from the 2026-09-10 ledger. */
function tooManyConcurrent(): Error & { responseBody: string } {
  const error = new Error('rate limited') as Error & { responseBody: string };
  error.responseBody = JSON.stringify({
    error: {
      message: 'key นี้กำลังมีงานวิ่งอยู่ 2 รายการแล้ว รอให้เสร็จก่อนหนึ่งรายการ',
      type: 'rate_limit_error',
      code: 'too_many_concurrent',
    },
  });
  return error;
}

describe('the ceiling a provider states', () => {
  it('names emmiedev at two calls per key, and nothing for a provider that meters by the minute', () => {
    assert.equal(PROVIDER_CONCURRENCY.emmiedev, 2);
    assert.equal(providerConcurrency('emmiedev', {}), 2);
    assert.equal(providerConcurrency('groq', {}), undefined);
    assert.equal(providerConcurrency('google', {}), undefined);
  });

  it('lets the environment raise, lower or remove one', () => {
    assert.equal(providerConcurrency('emmiedev', { WOWLIDATOR_EMMIEDEV_CONCURRENCY: '4' }), 4);
    assert.equal(providerConcurrency('emmiedev', { WOWLIDATOR_EMMIEDEV_CONCURRENCY: 'off' }), undefined);
    assert.equal(providerConcurrency('emmiedev', { WOWLIDATOR_EMMIEDEV_CONCURRENCY: '0' }), undefined);
    // A provider whose name carries a dash still has one env var.
    assert.equal(providerConcurrency('claude-cli', { WOWLIDATOR_CLAUDE_CLI_CONCURRENCY: '3' }), 3);
    // Nonsense falls back to the table rather than uncapping the provider.
    assert.equal(providerConcurrency('emmiedev', { WOWLIDATOR_EMMIEDEV_CONCURRENCY: 'lots' }), 2);
  });
});

describe('a refusal is the only reading an API key offers', () => {
  before(() => resetApiPressure());

  it('holds the provider, quoting the provider — never a paraphrase', () => {
    resetApiPressure();
    const state = noteApiRefusal('emmiedev', tooManyConcurrent(), 1_000);
    assert.equal(state.provider, 'emmiedev');
    assert.equal(state.until, 1_000 + API_PRESSURE_BASE_MS);
    assert.equal(state.stated, false);
    assert.match(state.reason, /too_many_concurrent/);
    assert.match(state.reason, /2 รายการ/);
    assert.ok(apiPressureHolding(1_000));
    assert.match(describeApiPressure(1_000) ?? '', /^emmiedev refused the call/);
  });

  it('obeys a stated retry-after to the second, in the header and in the body', () => {
    assert.equal(statedRetryMs({ responseHeaders: { 'retry-after': '42' } }), 42_000);
    assert.equal(statedRetryMs({ responseBody: '{"error":{"retry_after":7}}' }), 7_000);
    assert.equal(statedRetryMs(new Error('no idea')), null);
    resetApiPressure();
    const state = noteApiRefusal('groq', { responseHeaders: { 'retry-after': '30' } }, 0);
    assert.equal(state.until, 30_000);
    assert.equal(state.stated, true);
  });

  it('backs off further on each consecutive refusal, and never past the ceiling', () => {
    resetApiPressure();
    assert.equal(noteApiRefusal('zai', new Error('429'), 0).until, API_PRESSURE_BASE_MS);
    assert.equal(noteApiRefusal('zai', new Error('429'), 0).until, API_PRESSURE_BASE_MS * 2);
    assert.equal(noteApiRefusal('zai', new Error('429'), 0).until, API_PRESSURE_BASE_MS * 4);
    for (let i = 0; i < 12; i++) noteApiRefusal('zai', new Error('429'), 0);
    assert.equal(noteApiRefusal('zai', new Error('429'), 0).until, API_PRESSURE_MAX_MS);
  });

  it('reopens the moment a call answers — a limit that is open must not cost the wait', () => {
    resetApiPressure();
    noteApiRefusal('emmiedev', tooManyConcurrent(), 0);
    assert.ok(apiPressureHolding(0));
    noteApiSuccess('emmiedev');
    assert.equal(apiPressureHolding(0), false);
    assert.equal(describeApiPressure(0), null);
  });

  it('expires on its own clock, and a provider never held is never holding', () => {
    resetApiPressure();
    noteApiRefusal('emmiedev', new Error('429'), 0);
    assert.ok(apiPressureHolding(API_PRESSURE_BASE_MS - 1));
    assert.equal(apiPressureHolding(API_PRESSURE_BASE_MS + 1), false);
    assert.deepEqual(apiPressureHolds(API_PRESSURE_BASE_MS + 1), []);
  });
});

describe('every API call lands on a ledger', () => {
  it('round-trips a call and a refusal, and counts them apart', async () => {
    const env = envAt('round-trip.jsonl');
    await recordApiCall(
      {
        ts: '2026-09-10T17:49:10.171Z',
        provider: 'emmiedev',
        modelId: 'default',
        inputTokens: 3428,
        outputTokens: 317,
        wallMs: 4200,
        pid: 1,
        role: 'generator',
      },
      env,
    );
    await recordApiCall(
      {
        ts: '2026-09-10T17:51:57.770Z',
        provider: 'emmiedev',
        modelId: 'default',
        inputTokens: 0,
        outputTokens: 0,
        wallMs: 900,
        pid: 1,
        role: 'generator',
        finish: 'refused',
        detail: 'too_many_concurrent',
      },
      env,
    );
    const records = await readApiUsage(env);
    assert.equal(records.length, 2);
    const summary = summarizeApiUsage(records, new Date('2026-09-10T18:00:00.000Z'));
    assert.equal(summary.total.calls, 2);
    assert.equal(summary.total.refusals, 1);
    assert.equal(summary.total.errors, 0);
    assert.equal(summary.today.calls, 2);
    assert.equal(summary.byProvider[0]?.provider, 'emmiedev');
    assert.equal(summary.byRole[0]?.role, 'generator');
    assert.equal(summary.lastCallAt, '2026-09-10T17:51:57.770Z');
  });

  it('records no cost — an OpenAI-compatible endpoint states tokens and never a price', async () => {
    const env = envAt('no-cost.jsonl');
    await recordApiCall(
      { ts: new Date().toISOString(), provider: 'groq', modelId: 'x', inputTokens: 1, outputTokens: 1, wallMs: 1, pid: 1 },
      env,
    );
    const raw = await readFile(apiUsagePath(env), 'utf8');
    assert.equal(raw.includes('cost'), false);
  });

  it('skips a corrupt line and keeps the ledger', async () => {
    const path = join(dir, 'corrupt.jsonl');
    await writeFile(
      path,
      [
        '{"ts":"2026-09-10T01:00:00.000Z","provider":"emmiedev","modelId":"default","inputTokens":1,"outputTokens":1,"wallMs":1,"pid":1}',
        '{"ts":"2026-09-10T02:00:00',
        '{"modelId":"no-provider"}',
        '{"ts":"2026-09-10T03:00:00.000Z","provider":"groq","modelId":"y","inputTokens":2,"outputTokens":2,"wallMs":2,"pid":2}',
        '',
      ].join('\n'),
      'utf8',
    );
    const records = await readApiUsage({ WOWLIDATOR_API_USAGE_PATH: path });
    assert.equal(records.length, 2);
    assert.deepEqual(records.map((r) => r.provider), ['emmiedev', 'groq']);
  });

  it('is a missing file, not an error, and can be switched off', async () => {
    assert.deepEqual(await readApiUsage({ WOWLIDATOR_API_USAGE_PATH: join(dir, 'nothing-here.jsonl') }), []);
    const off = { WOWLIDATOR_API_USAGE: 'off', WOWLIDATOR_API_USAGE_PATH: join(dir, 'off.jsonl') };
    assert.equal(apiUsageEnabled(off), false);
    await recordApiCall(
      { ts: new Date().toISOString(), provider: 'groq', modelId: 'x', inputTokens: 1, outputTokens: 1, wallMs: 1, pid: 1 },
      off,
    );
    assert.deepEqual(await readApiUsage(off), []);
  });
});

describe('the monitor reads the ledger the run wrote', () => {
  it('is empty without a ledger, so a claude-only run grows no card', async () => {
    resetApiPressure();
    resetApiSectionCache();
    const section = await apiSection({ WOWLIDATOR_API_USAGE_PATH: join(dir, 'absent.jsonl') });
    assert.equal(section.total, null);
    assert.deepEqual(section.holds, []);
    assert.deepEqual(section.recentCalls, []);
  });

  it('carries the refusal and the hold that explain a run gone quiet', async () => {
    const env = envAt('monitor.jsonl');
    const calls: ApiCallRecord[] = [
      { ts: '2026-09-10T17:49:10.171Z', provider: 'emmiedev', modelId: 'default', inputTokens: 10, outputTokens: 5, wallMs: 100, pid: 1, role: 'agent' },
      { ts: '2026-09-10T17:50:10.171Z', provider: 'emmiedev', modelId: 'default', inputTokens: 0, outputTokens: 0, wallMs: 20, pid: 1, role: 'generator', finish: 'refused', detail: 'too_many_concurrent' },
    ];
    for (const call of calls) await recordApiCall(call, env);
    resetApiPressure();
    noteApiRefusal('emmiedev', tooManyConcurrent());
    resetApiSectionCache();
    const section = await apiSection(env);
    assert.equal(section.total?.calls, 2);
    assert.equal(section.total?.refusals, 1);
    assert.equal(section.byProvider[0]?.provider, 'emmiedev');
    assert.equal(section.recentCalls[0]?.finish, 'refused');
    assert.equal(section.recentCalls[0]?.detail, 'too_many_concurrent');
    assert.equal(section.holds[0]?.provider, 'emmiedev');
    assert.ok((section.holds[0]?.seconds ?? 0) > 0);
    resetApiPressure();
  });
});

describe('one monitor page, two front ends', () => {
  it('serves the skill\'s own page with its one state tag re-pointed at the route', async () => {
    const page = await monitorPage();
    // The page the skill plants in a run folder, unchanged but for the tag.
    assert.match(page, /__WOW_STATE__/);
    assert.match(page, /'\/monitor\/run-state\.js\?t=' \+ Date\.now\(\)/);
    // Its own cache-buster is kept — the page's timer is the page's.
    assert.equal(page.includes("'run-state.js?t='"), false);
  });

  it('carries a chosen ledger as a query the route re-checks, never as a path the page dictates', async () => {
    const page = await monitorPage('/tmp/whatever.claims.progress.json');
    assert.match(page, /ledger=%2Ftmp%2Fwhatever/);
  });

  it('reads a run with no ledger yet as exactly that, never as another run\'s counts', async () => {
    const state = await buildRunState({
      ledgerPath: join(dir, 'never-sealed.claims.progress.json'),
      logPath: null,
      env: envAt('state.jsonl'),
    });
    assert.equal(state.counts.planned, 0);
    assert.match(state.note ?? '', /has not sealed its first case yet/);
    // The phase is deliberately not asserted: it folds in the machine's own
    // process table, and this suite runs beside whatever else is on it.
    assert.deepEqual(state.outcomes, []);
  });
});
