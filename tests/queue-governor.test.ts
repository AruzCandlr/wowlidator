/**
 * The queue governor (`src/orchestrator/queue-governor.ts`) — unit-tier: the
 * write/read gates are pure, the loop runs against a stubbed model and hooks,
 * and the model shape goes through the same `generateStructured` path every
 * role uses (`jsonModel`).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_GOVERNOR_TURNS,
  RuleGovernorModel,
  governorMode,
  LlmGovernorModel,
  QueueGovernor,
  governorEnabled,
  governorTurnBudget,
  validateGovernorRead,
  validateGovernorWrite,
  type GovernorHooks,
  type GovernorModel,
  type GovernorObservation,
} from '../src/orchestrator/queue-governor.js';
import { jsonModel } from './helpers.js';

const TABLES = ['benefit_management.benefit_plan', 'benefit_management.benefit_enrollment'];

function observation(): GovernorObservation {
  return {
    event: 'queue-blocked',
    queue: ['PL_07_01 [writer table:benefit_management.benefit_plan] waiting'],
    lanes: ['PL_04_02 [reader route:admin/benefits] 42s'],
    tally: 'passed 10 · failed 2 · blocked 0 · left 30',
    health: ['pool 5 (ceiling 5)', 'held cases: none', 'interference stamps so far: 0'],
    pool: { current: 5, max: 5 },
  };
}

function hooks(overrides: Partial<GovernorHooks> = {}): GovernorHooks & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    hold: (id) => (calls.push(`hold ${id}`), true),
    release: (id) => (calls.push(`release ${id}`), true),
    resizePool: (n) => (calls.push(`pool ${n}`), n),
    rerunAlone: (id) => (calls.push(`rerun ${id}`), false),
    dbRead: async (sql) => (calls.push(`read ${sql}`), '1 row(s)'),
    dbWrite: async (sql) => (calls.push(`write ${sql}`), '1 row(s)'),
    ...overrides,
  };
}

describe('switches and budget', () => {
  it('on unless off; budget from env within 1-100', () => {
    assert.equal(governorEnabled({}), true);
    assert.equal(governorEnabled({ WOWLIDATOR_GOVERNOR: 'off' }), false);
    assert.equal(governorTurnBudget({}), DEFAULT_GOVERNOR_TURNS);
    assert.equal(governorTurnBudget({ WOWLIDATOR_GOVERNOR_TURNS: '3' }), 3);
    assert.equal(governorTurnBudget({ WOWLIDATOR_GOVERNOR_TURNS: '900' }), DEFAULT_GOVERNOR_TURNS);
  });
});

describe('the write gate — defect #14 of the spec', () => {
  it('accepts one INSERT/UPDATE on a declared table', () => {
    assert.deepEqual(
      validateGovernorWrite("INSERT INTO benefit_management.benefit_plan (id) VALUES ('x');", TABLES),
      { ok: true, table: 'benefit_management.benefit_plan' },
    );
    assert.equal(validateGovernorWrite('UPDATE benefit_management.benefit_plan SET x = 1', TABLES).ok, true);
  });

  it('refuses DELETE, DDL, multiple statements, and undeclared tables — each by name', () => {
    const del = validateGovernorWrite('DELETE FROM benefit_management.benefit_plan', TABLES);
    assert.equal(del.ok, false);
    assert.match((del as { reason: string }).reason, /DELETE.*refused|only INSERT or UPDATE/);
    const ddl = validateGovernorWrite('DROP TABLE x', TABLES);
    assert.equal(ddl.ok, false);
    const multi = validateGovernorWrite("INSERT INTO benefit_management.benefit_plan (id) VALUES ('x'); DROP TABLE y", TABLES);
    assert.equal(multi.ok, false);
    const foreign = validateGovernorWrite("INSERT INTO pg_catalog.pg_tables (x) VALUES ('y')", TABLES);
    assert.equal(foreign.ok, false);
    assert.match((foreign as { reason: string }).reason, /not in the indexed schema/);
  });

  it('db-read takes exactly one SELECT', () => {
    assert.equal(validateGovernorRead('SELECT count(*) FROM x').ok, true);
    assert.equal(validateGovernorRead('UPDATE x SET y = 1').ok, false);
    assert.equal(validateGovernorRead('SELECT 1; SELECT 2').ok, false);
  });
});

describe('the loop', () => {
  it('applies one action per event and burns the budget', async () => {
    const lines: string[] = [];
    const h = hooks();
    const model: GovernorModel = {
      id: 'stub',
      decide: async () => ({ kind: 'pool', size: 3, reason: 'timeouts rising' }),
    };
    const governor = new QueueGovernor({ model, hooks: h, budget: 2, log: (l) => lines.push(l) });
    await governor.onEvent(observation());
    await governor.onEvent(observation());
    await governor.onEvent(observation());
    assert.deepEqual(h.calls, ['pool 3', 'pool 3'], 'the third event is over budget and free');
    assert.equal(governor.turnsLeft, 0);
    assert.ok(lines.every((l) => l.startsWith('governor')), lines.join('\n'));
  });

  it('a model fault is one logged line and nothing changes — the scheduler carries on', async () => {
    const lines: string[] = [];
    const h = hooks();
    const governor = new QueueGovernor({
      model: { id: 'broken', decide: async () => { throw new Error('rate limited\nmore'); } },
      hooks: h,
      budget: 5,
      log: (l) => lines.push(l),
    });
    await governor.onEvent(observation());
    assert.deepEqual(h.calls, []);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /turn skipped .*rate limited.*deterministic scheduler carries on/);
  });

  it('a db-write is logged BEFORE it runs, and its result feeds the next turn', async () => {
    const lines: string[] = [];
    const order: string[] = [];
    const asked: (string | null)[] = [];
    const model: GovernorModel = {
      id: 'stub',
      decide: async (_o, last) => {
        asked.push(last);
        return asked.length === 1
          ? { kind: 'db-write', sql: "INSERT INTO t (id) VALUES ('x')", reason: 'seed the fixture' }
          : { kind: 'idle', reason: 'done' };
      },
    };
    const governor = new QueueGovernor({
      model,
      hooks: hooks({
        dbWrite: async () => {
          order.push('executed');
          return '1 row(s) in 3ms';
        },
      }),
      budget: 5,
      log: (l) => {
        if (l.includes('db-write (audited)')) order.push('logged');
        lines.push(l);
      },
    });
    await governor.onEvent(observation());
    await governor.onEvent(observation());
    assert.deepEqual(order, ['logged', 'executed'], 'the audit line exists even if the write hangs');
    assert.equal(asked[0], null);
    assert.match(asked[1] ?? '', /1 row\(s\) in 3ms/);
  });

  it('the model shape survives generateStructured — clamping and defaults included', async () => {
    const model = new LlmGovernorModel({
      model: jsonModel('m', { kind: 'hold', caseId: ' PL_07_01 ', size: 0, sql: '', reason: 'starved fixture' }, { inputTokens: 200, outputTokens: 20 }),
      id: 'mock:governor',
    });
    const action = await model.decide(observation(), null);
    assert.deepEqual(action, { kind: 'hold', caseId: 'PL_07_01', reason: 'starved fixture' });
  });
});

describe('the rules governor — deterministic, $0', () => {
  it('mode: rules is the default, model and off are explicit', () => {
    assert.equal(governorMode({}), 'rules');
    assert.equal(governorMode({ WOWLIDATOR_GOVERNOR: 'on' }), 'rules');
    assert.equal(governorMode({ WOWLIDATOR_GOVERNOR: 'model' }), 'model');
    assert.equal(governorMode({ WOWLIDATOR_GOVERNOR: 'off' }), 'off');
  });

  it('a fully-conflicting queue is named a real conflict ONCE, then idle', async () => {
    const gov = new RuleGovernorModel();
    const obs: GovernorObservation = {
      ...observation(),
      event: 'queue-blocked',
      flyingFacts: [{ name: 'A', writes: true, sections: ['table:plan'] }],
      pendingFacts: [
        { name: 'B', writes: true, sections: ['table:plan'] },
        { name: 'C', writes: false, sections: ['table:plan'] },
      ],
    };
    const first = await gov.decide(obs, null);
    assert.equal(first.kind, 'note');
    assert.match(first.reason, /correctly serialising a real data conflict/);
    const second = await gov.decide(obs, null);
    assert.equal(second.kind, 'idle');
  });

  it('a compatible case stuck behind the queue is called out by name', async () => {
    const gov = new RuleGovernorModel();
    const action = await gov.decide({
      ...observation(),
      event: 'queue-blocked',
      flyingFacts: [{ name: 'A', writes: true, sections: ['table:plan'] }],
      pendingFacts: [{ name: 'D', writes: false, sections: ['route:orders'] }],
    }, null);
    assert.equal(action.kind, 'note');
    assert.match(action.reason, /"D" looks compatible/);
  });

  it('three timeout-shaped failures inside five minutes shrink the pool one step, never below 2', async () => {
    let t = 0;
    const gov = new RuleGovernorModel({ now: () => t });
    const ended = (reason: string): GovernorObservation => ({
      ...observation(),
      event: 'case-ended',
      recentFailures: [reason],
      pool: { current: 5, max: 5 },
    });
    t = 1000; assert.equal((await gov.decide(ended('locator.click: Timeout 2000ms exceeded'), null)).kind, 'idle');
    t = 2000; assert.equal((await gov.decide(ended('waitFor timed out'), null)).kind, 'idle');
    t = 3000;
    const third = await gov.decide(ended('Timeout 1500ms exceeded'), null);
    assert.deepEqual({ kind: third.kind, size: (third as { size?: number }).size }, { kind: 'pool', size: 4 });
    // a non-timeout failure never counts
    t = 4000; assert.equal((await gov.decide(ended('expected text to contain "x"'), null)).kind, 'idle');
  });
});
