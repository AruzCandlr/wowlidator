/**
 * The step-level evidence lookup (`src/generator/step-evidence.ts`).
 *
 * Entirely unit-tier: hand-written trees, hand-written index nodes and a
 * scripted `DbClient` stand in for the page, the repository and the database.
 * Every fixture is the shape of a live be-cycle1-sit row — RU_10_11's
 * `ส่งออก CSV` on a page no capture reached, RU_09_54's `BE-XXX-999` mask —
 * because a lookup tested only against its own writer proves nothing.
 *
 * What is pinned is the honesty, not the plumbing: nothing answers without a
 * source that states it, a truncated or absent tree declines, a document is
 * never a source for a control, and a database that holds no such row leaves
 * the refusal exactly where it was.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { DbClient, DbResult, DbSchema } from '../src/db/client.js';
import type { FlowStep } from '../src/engine/runner.js';
import { auditGrounding } from '../src/generator/flow-review.js';
import {
  assertedFixtures,
  declaredStringsOf,
  fromDatabase,
  fromRepository,
  resolveStepEvidence,
  unaccountedControls,
  MAX_DB_LOOKUPS,
} from '../src/generator/step-evidence.js';
import type { ValueResolverModel } from '../src/generator/value-resolution.js';

/** The page the run starts on — a sign-in screen, which is every catalog row's start tree. */
const START_TREE = ['textbox "Email"', 'textbox "Password"', 'button "Sign in"'].join('\n');

/** Two nodes of an indexed repository: a message namespace with words, a route without. */
const NODES = [
  {
    kind: 'message',
    name: 'admin_benefits_rules',
    file: 'messages/th.json',
    detail: 'exportCsv: "ส่งออก CSV" · title: "กฎเงื่อนไขสิทธิ์" · empty: "1"',
  },
  {
    kind: 'component',
    name: 'RulesScreen',
    file: 'src/screens/RulesScreen.tsx',
    detail: '"Export all rules to CSV" · "Cancel"',
  },
  {
    kind: 'route',
    name: '/:locale/admin/benefits/rules',
    file: 'app/[locale]/admin/benefits/rules/page.tsx',
    detail: 'renders "RulesScreen"',
  },
];

const DECLARED = declaredStringsOf(NODES);

/** RU_10_11's flow: an agent leg to a page no capture reached, then its export button. */
const afterLeg = (): FlowStep[] =>
  [
    { action: 'workflow', goal: 'open กฎเงื่อนไขสิทธิ์ from the งานบุคคล menu', intent: 'Step 1' },
    { action: 'expectEnabled', selector: 'role=button[name="ส่งออก CSV" i]', intent: 'Expected 1' },
  ] as FlowStep[];

const SCHEMA: DbSchema = {
  source: 'introspection',
  tables: [
    {
      name: 'benefit_management.benefit_plan',
      columns: [
        { name: 'plan_code', type: 'text', nullable: false, pk: true },
        { name: 'name', type: 'text', nullable: false, pk: false },
      ],
      pk: ['plan_code'],
      references: [],
    },
  ],
};

class StubDb implements DbClient {
  readonly id = 'stub';
  readonly queries: { sql: string; params: readonly unknown[] }[] = [];
  existing = new Set<string>(['BE-MED-001', 'QA260908_BE_137']);
  /** The spelling the connection's own `current_schema()` produces — bare under a `search_path` DSN. */
  readonly #schema: DbSchema;
  constructor(schema: DbSchema = SCHEMA) {
    this.#schema = schema;
  }
  async query(sql: string, params: readonly unknown[]): Promise<DbResult> {
    this.queries.push({ sql, params });
    return {
      rows: [{ n: this.existing.has(String(params[0])) ? '2' : '0' }],
      rowCount: 1,
      durationMs: 1,
    };
  }
  async introspect(): Promise<DbSchema> {
    return this.#schema;
  }
  async close(): Promise<void> {}
}

function lookupModel(
  choice: { table: string; column: string; where: Record<string, string> } | null,
  calls: string[] = [],
): ValueResolverModel {
  return {
    id: 'scripted',
    fromPassages: async () => ({ value: null, evidence: '' }),
    chooseDbLookup: async () => {
      calls.push('db');
      return choice;
    },
    generate: async () => ({ value: '' }),
  };
}

describe('what the trees do not account for', () => {
  it('names the control a captured tree never renders, and nothing else', () => {
    const needs = unaccountedControls([], afterLeg(), START_TREE);
    assert.deepEqual(needs, [{ section: 'steps', index: 1, name: 'ส่งออก CSV' }]);
  });

  it('a control the tree DOES render is no need at all', () => {
    const steps = [{ action: 'click', selector: 'role=button[name="Sign in" i]' }] as FlowStep[];
    assert.deepEqual(unaccountedControls([], steps, START_TREE), []);
  });

  it('an absence claim needs no rendering — expectHidden and a zero count are exempt', () => {
    const steps = [
      { action: 'expectHidden', selector: 'role=button[name="ส่งออก CSV" i]' },
      { action: 'expectCount', selector: 'role=row', count: 0 },
    ] as FlowStep[];
    assert.deepEqual(unaccountedControls([], steps, START_TREE), []);
  });

  it('declines on a truncated tree and on no tree at all — silence is not evidence either way', () => {
    assert.deepEqual(unaccountedControls([], afterLeg(), `[TREE TRUNCATED]\n${START_TREE}`), []);
    assert.deepEqual(unaccountedControls([], afterLeg(), ''), []);
    assert.deepEqual(unaccountedControls([], afterLeg(), undefined), []);
  });
});

describe('the repository as the second grounding source', () => {
  it('collects the words a message namespace and a component declare, never a route node', () => {
    assert.deepEqual(
      DECLARED.map((d) => d.text),
      ['ส่งออก CSV', 'กฎเงื่อนไขสิทธิ์', 'Export all rules to CSV', 'Cancel'],
    );
    assert.equal(DECLARED[0]?.where, 'admin_benefits_rules (messages/th.json)');
  });

  it('answers exactly for a declared string, and says where', () => {
    const found = fromRepository('ส่งออก CSV', { declared: DECLARED });
    assert.equal(found?.kind, 'repository');
    assert.equal(found?.exact, true);
    assert.match(found?.detail ?? '', /messages\/th\.json.+ส่งออก CSV/);
  });

  it('a longer declaration that CONTAINS the name answers, but never counts as exact', () => {
    const found = fromRepository('Export all rules', { declared: DECLARED });
    assert.equal(found?.exact, false);
    assert.match(found?.detail ?? '', /which contains it/);
  });

  it("the row's own repository slice answers when there is no index", () => {
    const slice = 'RulesScreen renders the admin_benefits_rules strings [th, messages/th.json]: exportCsv: "ส่งออก CSV"';
    assert.equal(fromRepository('ส่งออก CSV', { projectContext: slice })?.exact, true);
  });

  it('nothing declares it — nothing is answered', () => {
    assert.equal(fromRepository('ปุ่มที่ไม่มีอยู่', { declared: DECLARED }), null);
  });
});

describe('the lookup as a stage', () => {
  it('grounds RU_10_11 shape at $0, records the provenance on the step, and the audit stops flagging it', async () => {
    const steps = afterLeg();
    const log: string[] = [];
    const outcome = await resolveStepEvidence([], steps, {
      trees: START_TREE,
      declared: DECLARED,
      caseText: 'RU_10_11',
      onLog: (line) => log.push(line),
    });
    assert.deepEqual(outcome.groundedControls, ['ส่งออก CSV']);
    assert.equal(outcome.declaredLines.length, 1);
    assert.match((steps[1] as { intent?: string }).intent ?? '', /\[evidence: repository — .*messages\/th\.json/);
    assert.ok(log.some((l) => /evidence for "ส่งออก CSV"/.test(l)));

    const before = auditGrounding([], steps, { prompt: 'p', axTree: START_TREE });
    assert.equal(before.length, 1, 'the audit flags it without the lookup');
    const after = auditGrounding([], steps, {
      prompt: 'p',
      axTree: START_TREE,
      declaredControls: outcome.groundedControls,
    });
    assert.equal(after.length, 0, 'and not with it — no model call is needed to be told what the index says');
  });

  it('a containment-only match grounds nothing for the audit — a name the run must match whole', async () => {
    const steps = [
      { action: 'click', selector: 'role=button[name="Export all rules" i]', intent: 'Step 2' },
    ] as FlowStep[];
    const outcome = await resolveStepEvidence([], steps, { trees: START_TREE, declared: DECLARED, caseText: '' });
    assert.deepEqual(outcome.groundedControls, []);
    assert.equal(outcome.declaredLines.length, 1, 'the reviewer still gets the line to judge by');
    assert.equal(
      auditGrounding([], steps, { prompt: 'p', axTree: START_TREE, declaredControls: outcome.groundedControls }).length,
      1,
    );
  });

  it('nothing answers: the name is reported unanswered and the step is left exactly as authored', async () => {
    const steps = afterLeg();
    const outcome = await resolveStepEvidence([], steps, { trees: START_TREE, declared: [], caseText: '' });
    assert.deepEqual(outcome.unanswered, ['ส่งออก CSV']);
    assert.deepEqual(outcome.groundedControls, []);
    assert.equal((steps[1] as { intent?: string }).intent, 'Expected 1');
  });

  it('the same name in several steps is looked up once and annotates each', async () => {
    const steps = [
      { action: 'click', selector: 'role=button[name="ส่งออก CSV" i]', intent: 'a' },
      { action: 'expectEnabled', selector: 'role=button[name="ส่งออก CSV" i]', intent: 'b' },
    ] as FlowStep[];
    const outcome = await resolveStepEvidence([], steps, { trees: START_TREE, declared: DECLARED, caseText: '' });
    assert.deepEqual(outcome.notes.length, 1);
    for (const step of steps) assert.match((step as { intent?: string }).intent ?? '', /\[evidence: repository/);
  });
});

describe('a fixture the application already holds', () => {
  it('reads the fixtures a flow ASSERTS, never the ones it types', () => {
    const steps = [
      { action: 'fill', selector: 'role=textbox[name="Plan ID" i]', value: 'BE-NEW-001' },
      { action: 'expectVisible', selector: 'text="BE-MED-001"' },
    ] as FlowStep[];
    assert.deepEqual(assertedFixtures(steps, ['BE-MED-001', 'BE-NEW-001']), ['BE-MED-001']);
  });

  it('an intent naming a fixture asserts nothing', () => {
    const steps = [
      { action: 'expectVisible', selector: 'text="Error"', intent: 'skipped step 4: no BE-MED-001 seeded' },
    ] as FlowStep[];
    assert.deepEqual(assertedFixtures(steps, ['BE-MED-001']), []);
  });

  it('count > 0 answers; the value goes nowhere near the SQL text', async () => {
    const db = new StubDb();
    const found = await fromDatabase('BE-MED-001', {
      db: async () => db,
      model: lookupModel({ table: 'benefit_management.benefit_plan', column: 'plan_code', where: {} }),
      caseText: 'RU_09_51',
    });
    assert.equal(found?.kind, 'database');
    assert.match(found?.detail ?? '', /benefit_plan\.plan_code holds 2 row\(s\)/);
    assert.equal(db.queries.length, 1);
    assert.match(db.queries[0]!.sql, /count\(\*\)/);
    assert.deepEqual(db.queries[0]!.params, ['BE-MED-001']);
  });

  it('a mask the sheet writes for a value that must NOT exist answers nothing — the refusal stands', async () => {
    const db = new StubDb();
    const found = await fromDatabase('BE-XXX-999', {
      db: async () => db,
      model: lookupModel({ table: 'benefit_management.benefit_plan', column: 'plan_code', where: {} }),
      caseText: 'RU_09_54',
    });
    assert.equal(found, null);
  });

  it('a table or column the schema does not declare is a refusal, never a query', async () => {
    const db = new StubDb();
    await assert.rejects(
      fromDatabase('BE-MED-001', {
        db: async () => db,
        model: lookupModel({ table: 'not_indexed', column: 'plan_code', where: {} }),
      }),
      /the schema does not declare/,
    );
    await assert.rejects(
      fromDatabase('BE-MED-001', {
        db: async () => db,
        model: lookupModel({ table: 'benefit_management.benefit_plan', column: 'nope', where: {} }),
      }),
      /the schema does not declare/,
    );
    assert.equal(db.queries.length, 0);
  });

  it('no database, or a model that names no table, asks nothing', async () => {
    assert.equal(await fromDatabase('BE-MED-001', { model: lookupModel(null) }), null);
    const db = new StubDb();
    assert.equal(await fromDatabase('BE-MED-001', { db: async () => db, model: lookupModel(null) }), null);
    assert.equal(db.queries.length, 0);
  });

  it('a database that throws is a source that did not answer — never fatal, and said in the log', async () => {
    const log: string[] = [];
    const outcome = await resolveStepEvidence(
      [],
      [{ action: 'expectVisible', selector: 'text="BE-MED-001"' }] as FlowStep[],
      {
        trees: START_TREE,
        fixtures: ['BE-MED-001'],
        db: async () => {
          throw new Error('connection refused');
        },
        model: lookupModel({ table: 'benefit_management.benefit_plan', column: 'plan_code', where: {} }),
        onLog: (line) => log.push(line),
      },
    );
    assert.deepEqual(outcome.existingFixtures, []);
    assert.ok(log.some((l) => /the database did not answer/.test(l)));
    // **Unavailable is not absent** (PL_09_01): the lookup that could not run
    // is recorded apart, so the caller can note it instead of refusing as
    // though the application had answered "no such row".
    assert.deepEqual(outcome.unavailableFixtures, [{ fact: 'BE-MED-001', reason: 'connection refused' }]);
  });

  it('a database that answers "no row" is NOT recorded as unavailable', async () => {
    const db = new StubDb();
    const outcome = await resolveStepEvidence(
      [],
      [{ action: 'expectVisible', selector: 'text="BE-XXX-999"' }] as FlowStep[],
      {
        trees: START_TREE,
        fixtures: ['BE-XXX-999'],
        db: async () => db,
        model: lookupModel({ table: 'benefit_management.benefit_plan', column: 'plan_code', where: {} }),
      },
    );
    assert.deepEqual(outcome.existingFixtures, []);
    assert.deepEqual(outcome.unavailableFixtures, []);
  });

  it('the PL_09_01 spelling: a qualified name resolves against a bare introspection', async () => {
    // The live DSN sets `search_path=benefit_management,public`, so
    // `introspect` spells that schema's tables bare while the authoring
    // inventory shows the model the graph's `benefit_management.benefit_plan`.
    const bare = new StubDb({
      source: 'introspection',
      tables: [{ ...SCHEMA.tables[0]!, name: 'benefit_plan' }],
    });
    const found = await fromDatabase('QA260908_BE_137', {
      db: async () => bare,
      model: lookupModel({ table: 'benefit_management.benefit_plan', column: 'plan_code', where: {} }),
      caseText: 'PL_09_01',
    });
    assert.equal(found?.kind, 'database');
    assert.match(bare.queries[0]!.sql, /FROM "benefit_plan"/);
  });

  it('bounded: a row asserting many fixtures asks at most MAX_DB_LOOKUPS times', async () => {
    const db = new StubDb();
    const calls: string[] = [];
    const facts = ['BE-MED-001', 'BE-MED-002', 'BE-MED-003', 'BE-MED-004'];
    const outcome = await resolveStepEvidence(
      [],
      facts.map((f) => ({ action: 'expectVisible', selector: `text="${f}"` })) as FlowStep[],
      {
        trees: START_TREE,
        fixtures: facts,
        db: async () => db,
        model: lookupModel({ table: 'benefit_management.benefit_plan', column: 'plan_code', where: {} }, calls),
      },
    );
    assert.equal(calls.length, MAX_DB_LOOKUPS);
    assert.deepEqual(outcome.existingFixtures, ['BE-MED-001']);
  });
});
