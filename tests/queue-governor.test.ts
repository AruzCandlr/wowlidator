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
  fixtureTokens,
  governorHoldsConsumed,
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

// ---------------------------------------------------------------------------
// Fixture holds (OA-16, 2026-09-03): a consumable a case's Test data names —
// a Position a hire takes, a plan a delete removes — is held by one case at
// a time. The data locks serialise by TABLE; two hires on one Position have
// different sections and dispatched together. Pure rules over facts.
// ---------------------------------------------------------------------------

describe('the rules governor holds a shared fixture', () => {
  it('fixtureTokens reads Position codes, plan/document codes, persona tokens and TD sets, once each', () => {
    const text =
      'HIR-EC-072 Login ด้วย <HR_ADMIN_ACCOUNT> (HRBP). Test data: ชุดข้อมูล TD-01 Position = 40106337 ' +
      'Department = 30000123 Benefit Plan ID = TH_MED_005 เอกสาร SIT_DUP_DOC; Position = 40106337 again; ' +
      'amount 1,234.56 ref 12345678.9';
    assert.deepEqual(fixtureTokens(text), [
      '<HR_ADMIN_ACCOUNT>',
      '40106337',
      '30000123',
      'HIR-EC-072',
      'TD-01',
      'TH_MED_005',
      'SIT_DUP_DOC',
    ]);
    assert.deepEqual(fixtureTokens('no fixtures here, just prose'), []);
  });

  it('holds a pending case that names a fixture an in-flight WRITER names, and releases it when the writer ends', async () => {
    const gov = new RuleGovernorModel();
    const writer = { name: 'HIR-EC-072', writes: true, sections: ['table:employee'], fixtures: ['40106337', 'TD-01'] };
    const obs: GovernorObservation = {
      ...observation(),
      event: 'suite-start',
      flyingFacts: [writer],
      pendingFacts: [
        { name: 'PL_03_01', writes: true, sections: ['table:plan'], fixtures: ['TH_MED_005'] },
        { name: 'HIR-EC-073', writes: true, sections: ['table:employee_2'], fixtures: ['40106337'] },
      ],
    };
    const first = await gov.decide(obs, null);
    assert.deepEqual(first, { kind: 'hold', caseId: 'HIR-EC-073', reason: 'shares fixture 40106337 with HIR-EC-072 in flight' });
    // The same picture again: the case is already held, nothing else to do.
    assert.equal((await gov.decide(obs, null)).kind, 'idle');
    // The writer is gone from the lanes: the hold is lifted, on any event.
    const after = await gov.decide({ ...obs, event: 'queue-blocked', flyingFacts: [] }, null);
    assert.equal(after.kind, 'release');
    assert.equal((after as { caseId?: string }).caseId, 'HIR-EC-073');
    assert.match(after.reason, /fixture 40106337 is free/);
  });

  it('a reader in flight holds nobody, and a case without fixtures is never held', async () => {
    const gov = new RuleGovernorModel();
    const action = await gov.decide(
      {
        ...observation(),
        event: 'suite-start',
        flyingFacts: [{ name: 'HIR-EC-001', writes: false, sections: ['route:hire'], fixtures: ['40106337'] }],
        pendingFacts: [
          { name: 'HIR-EC-073', writes: true, sections: ['table:employee'], fixtures: ['40106337'] },
          { name: 'PL_01_01', writes: true, sections: ['table:plan'] },
        ],
      },
      null,
    );
    assert.equal(action.kind, 'idle');
  });

  it('a case that ended without passing warns the cases naming its fixture — once — and holds only when asked to', async () => {
    const ended = { name: 'HIR-EC-072', writes: true, sections: ['table:employee'], fixtures: ['40106337'], detail: 'expectText "Hired" timed out' };
    const obs: GovernorObservation = {
      ...observation(),
      event: 'case-ended',
      endedFact: ended,
      flyingFacts: [],
      pendingFacts: [{ name: 'HIR-EC-073', writes: true, sections: ['table:employee'], fixtures: ['40106337'] }],
    };
    const noting = new RuleGovernorModel({ holdConsumed: false });
    const note = await noting.decide(obs, null);
    assert.equal(note.kind, 'note');
    assert.match(note.reason, /"HIR-EC-073" likely blocked: fixture 40106337 consumed\/poisoned by HIR-EC-072 \(expectText "Hired" timed out\)/);
    assert.equal((await noting.decide(obs, null)).kind, 'idle', 'said once');
    // A pass consumes nothing worth a warning.
    assert.equal((await new RuleGovernorModel().decide({ ...obs, endedFact: { ...ended, detail: '' } }, null)).kind, 'idle');

    const holding = new RuleGovernorModel({ holdConsumed: true });
    const hold = await holding.decide(obs, null);
    assert.equal(hold.kind, 'hold');
    assert.equal((hold as { caseId?: string }).caseId, 'HIR-EC-073');
    assert.equal(governorHoldsConsumed({}), false);
    assert.equal(governorHoldsConsumed({ WOWLIDATOR_GOVERNOR_HOLD_CONSUMED: '1' }), true);
  });
});

// ---------------------------------------------------------------------------
// A dependency wait is the scheduler's, and the governor explains it as such
// (CG-12, 2026-09-04). The gate that parks a dependent lives in the run loop
// (`dependencyStanding`); the observation carries the prerequisite on
// `waitingOn`, and the rules governor names it — never "a compatible case
// that has not dispatched", which is what it read before.
// ---------------------------------------------------------------------------

describe('the rules governor explains a dependency wait', () => {
  it('names the prerequisite and the lane it is in flight in, once per pair', async () => {
    const gov = new RuleGovernorModel();
    const obs: GovernorObservation = {
      ...observation(),
      event: 'queue-blocked',
      flyingFacts: [
        { name: 'X other', writes: false, sections: ['route:home'] },
        { name: 'HIR-1 hire the employee', writes: true, sections: ['table:employee'] },
      ],
      pendingFacts: [{ name: 'PRB-1 probation of that employee', writes: true, sections: ['table:probation'], waitingOn: 'HIR-1' }],
    };
    const first = await gov.decide(obs, null);
    assert.equal(first.kind, 'note');
    assert.match(first.reason, /"PRB-1 probation of that employee" is waiting on prerequisite HIR-1, in flight in lane 2/);
    assert.match(first.reason, /dependency gate, not starvation/);
    const second = await gov.decide(obs, null);
    assert.equal(second.kind, 'idle', 'said once');
    assert.doesNotMatch(second.reason, /looks compatible/, 'a parked dependent is never misread as a stuck compatible case');
  });

  it('a prerequisite parked ahead in the queue, or not yet queued, is said as such', async () => {
    const gov = new RuleGovernorModel();
    const ahead = await gov.decide({
      ...observation(),
      event: 'queue-blocked',
      flyingFacts: [{ name: 'A', writes: true, sections: ['table:plan'] }],
      pendingFacts: [
        { name: 'B', writes: false, sections: ['route:x'], waitingOn: 'A' },
        { name: 'C', writes: false, sections: ['route:y'], waitingOn: 'B' },
      ],
    }, null);
    assert.equal(ahead.kind, 'note');
    assert.match(ahead.reason, /"B" is waiting on prerequisite A, in flight in lane 1/);
    const next = await gov.decide({
      ...observation(),
      event: 'queue-blocked',
      flyingFacts: [{ name: 'A', writes: true, sections: ['table:plan'] }],
      pendingFacts: [
        { name: 'B', writes: false, sections: ['route:x'], waitingOn: 'A' },
        { name: 'C', writes: false, sections: ['route:y'], waitingOn: 'B' },
      ],
    }, null);
    assert.match(next.reason, /"C" is waiting on prerequisite B, queued ahead of it and not yet started/);
    const gov2 = new RuleGovernorModel();
    const unqueued = await gov2.decide({
      ...observation(),
      event: 'queue-blocked',
      flyingFacts: [{ name: 'A', writes: true, sections: ['table:plan'] }],
      pendingFacts: [{ name: 'D', writes: false, sections: ['route:x'], waitingOn: 'Z' }],
    }, null);
    assert.match(unqueued.reason, /waiting on prerequisite Z, not yet queued/);
  });

  it('a queue that is entirely parked on prerequisites is idle, and one with a real conflict beside a parked case still names the conflict', async () => {
    const gov = new RuleGovernorModel();
    const parked: GovernorObservation = {
      ...observation(),
      event: 'queue-blocked',
      flyingFacts: [{ name: 'A', writes: true, sections: ['table:plan'] }],
      pendingFacts: [{ name: 'B', writes: false, sections: ['route:x'], waitingOn: 'A' }],
    };
    await gov.decide(parked, null); // the once-only note
    const again = await gov.decide(parked, null);
    assert.deepEqual(again, { kind: 'idle', reason: 'every waiting case is parked on a prerequisite — nothing to change' });
    const mixed = await gov.decide({
      ...parked,
      pendingFacts: [
        { name: 'B', writes: false, sections: ['route:x'], waitingOn: 'A' },
        { name: 'W', writes: true, sections: ['table:plan'] },
      ],
    }, null);
    assert.equal(mixed.kind, 'note');
    assert.match(mixed.reason, /correctly serialising a real data conflict/);
  });
});
