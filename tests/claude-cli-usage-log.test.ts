import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  claudeCliUsageEnabled,
  readClaudeCliUsage,
  recordClaudeCliCall,
  summarizeClaudeCliUsage,
  type ClaudeCliCallRecord,
} from '../src/providers/claude-cli-usage-log.js';

function call(overrides: Partial<ClaudeCliCallRecord>): ClaudeCliCallRecord {
  return {
    ts: '2026-08-27T05:00:00.000Z',
    modelId: 'sonnet',
    path: 'cold',
    costUsd: 0.01,
    inputTokens: 100,
    cachedInputTokens: 1000,
    cacheWriteTokens: 50,
    outputTokens: 20,
    wallMs: 2000,
    pid: 123,
    ...overrides,
  };
}

describe('the claude -p usage ledger', () => {
  it('round-trips: what was recorded is what is read back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wow-cli-usage-'));
    const env = { WOWLIDATOR_CLAUDE_CLI_USAGE_PATH: join(dir, 'ledger.jsonl') } as NodeJS.ProcessEnv;
    await recordClaudeCliCall(call({ modelId: 'fable' }), env);
    await recordClaudeCliCall(call({ modelId: 'sonnet', path: 'warm' }), env);
    const records = await readClaudeCliUsage(env);
    assert.equal(records.length, 2);
    assert.equal(records[0]?.modelId, 'fable');
    assert.equal(records[1]?.path, 'warm');
  });

  it('is off when said so, and a missing file is an empty ledger, not an error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wow-cli-usage-'));
    const env = {
      WOWLIDATOR_CLAUDE_CLI_USAGE: 'off',
      WOWLIDATOR_CLAUDE_CLI_USAGE_PATH: join(dir, 'ledger.jsonl'),
    } as NodeJS.ProcessEnv;
    assert.equal(claudeCliUsageEnabled(env), false);
    await recordClaudeCliCall(call({}), env);
    assert.deepEqual(await readClaudeCliUsage(env), []);
  });

  it('skips a corrupt line rather than sinking the history', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wow-cli-usage-'));
    const path = join(dir, 'ledger.jsonl');
    const env = { WOWLIDATOR_CLAUDE_CLI_USAGE_PATH: path } as NodeJS.ProcessEnv;
    await recordClaudeCliCall(call({}), env);
    const good = await readFile(path, 'utf8');
    await writeFile(path, `${good}{"half a rec\n`, 'utf8');
    await recordClaudeCliCall(call({ modelId: 'haiku' }), env);
    const records = await readClaudeCliUsage(env);
    assert.equal(records.length, 2);
  });

  it('never lets an unwritable ledger fail the call it records', async () => {
    const env = {
      WOWLIDATOR_CLAUDE_CLI_USAGE_PATH: '/dev/null/not-a-dir/ledger.jsonl',
    } as NodeJS.ProcessEnv;
    await assert.doesNotReject(recordClaudeCliCall(call({}), env));
  });
});

describe('summarizeClaudeCliUsage', () => {
  it('totals overall, per UTC day, and per model — largest spender first', () => {
    const now = new Date('2026-08-27T09:00:00Z');
    const summary = summarizeClaudeCliUsage(
      [
        call({ ts: '2026-08-27T05:00:00.000Z', modelId: 'sonnet', costUsd: 0.01, path: 'warm' }),
        call({ ts: '2026-08-27T06:00:00.000Z', modelId: 'fable', costUsd: 0.2 }),
        call({ ts: '2026-08-26T23:59:00.000Z', modelId: 'sonnet', costUsd: 0.02 }),
      ],
      now,
    );
    assert.equal(summary.total.calls, 3);
    assert.equal(summary.total.warmCalls, 1);
    assert.equal(summary.today.calls, 2);
    assert.ok(Math.abs(summary.today.costUsd - 0.21) < 1e-9);
    assert.deepEqual(
      summary.byModel.map((m) => m.modelId),
      ['fable', 'sonnet'],
    );
    assert.equal(summary.byModel[1]?.calls, 2);
    assert.equal(summary.lastCallAt, '2026-08-27T06:00:00.000Z');
  });

  it('answers an empty ledger with zeros, not with an error', () => {
    const summary = summarizeClaudeCliUsage([]);
    assert.equal(summary.total.calls, 0);
    assert.equal(summary.byModel.length, 0);
    assert.equal(summary.byRole.length, 0);
    assert.equal(summary.lastCallAt, null);
  });

  // The slice that answers "what is authoring costing, and is its session
  // carrying context it never needed" — the measurement `sessionTurnBudget`
  // exists to move, so it has to be readable without a shell pipeline.
  it('breaks down by role, carrying the cache-write and turn counts', () => {
    const summary = summarizeClaudeCliUsage([
      call({ ts: '2026-08-31T08:50:00.000Z', role: 'generator', costUsd: 0.44, cachedInputTokens: 126_616, cacheWriteTokens: 26_651, turns: 0 }),
      call({ ts: '2026-08-31T08:51:00.000Z', role: 'generator', costUsd: 0.40, cachedInputTokens: 120_000, cacheWriteTokens: 20_000, turns: 4 }),
      call({ ts: '2026-08-31T08:52:00.000Z', role: 'agent', costUsd: 0.10, cachedInputTokens: 9_000, cacheWriteTokens: 1_000, turns: 2 }),
    ]);
    assert.deepEqual(
      summary.byRole.map((r) => r.role),
      ['generator', 'agent'],
      'largest spender first',
    );
    const generator = summary.byRole[0]!;
    assert.equal(generator.calls, 2);
    assert.equal(generator.cacheWriteTokens, 46_651);
    assert.equal(generator.cachedInputTokens, 246_616);
    assert.equal(generator.turns, 4);
    assert.equal(summary.total.cacheWriteTokens, 47_651);
  });

  it('buckets a call the ledger recorded without a role rather than dropping it', () => {
    const summary = summarizeClaudeCliUsage([call({ ts: '2026-08-31T08:50:00.000Z', costUsd: 0.5 })]);
    assert.deepEqual(
      summary.byRole.map((r) => r.role),
      ['unattributed'],
    );
  });
});
