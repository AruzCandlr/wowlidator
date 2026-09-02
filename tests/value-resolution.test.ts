/**
 * Value resolution at authoring time (`src/generator/value-resolution.ts`).
 *
 * Entirely unit-tier: a scripted resolver model, a scripted `DbClient` (the
 * `tests/db.test.ts` pattern) and plain text stand in for the sheet, the
 * documents and the database. What is pinned is the ORDER of the sources and
 * the honesty rules — a model answer is accepted only when the evidence holds
 * it, a sensitive column is never used, a stand-in is always flagged.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { DbClient, DbResult, DbSchema } from '../src/db/client.js';
import type { FlowStep } from '../src/engine/runner.js';
import { describeValueSource, formatStepLine, valueWasGenerated, type ProofStep } from '../src/engine/proof-bundle.js';
import { typesPlaceholderToken } from '../src/generator/flow-author.js';
import {
  PLACEHOLDER_TOKEN,
  candidateFor,
  findUnresolvedValues,
  formatStatedFor,
  fromTestData,
  resolveValues,
  type ValueResolverModel,
} from '../src/generator/value-resolution.js';

const CASE = [
  'HIR-EC-012: ตรวจสอบการจ้างพนักงานแบบ Replacement ผ่าน Key-in',
  'Test data: - Replaced Employee ID = Employee ID ของพนักงานที่มีอยู่จริงและสามารถใช้สำหรับ Replacement; - Invalid Replaced Employee ID = <NON_EXISTING_EMPLOYEE_ID>; - Employee Group = A - Permanent',
  'Steps:',
  '  3. ตรวจสอบ Replaced Employee ID ที่ไม่มีอยู่จริง',
  '  - กรอก Replaced Employee ID = <NON_EXISTING_EMPLOYEE_ID>',
  '  4. ตรวจสอบ Replaced Employee ID ที่ถูกต้อง',
  'Expected output:',
  '  - ระบบสร้าง Employee ID เป็นตัวเลข 8 หลัก โดยหลักแรกเป็น 2',
].join('\n');

const SCHEMA: DbSchema = {
  source: 'introspection',
  tables: [
    {
      name: 'employee_center.employee',
      columns: [
        { name: 'employee_id', type: 'text', nullable: false, pk: true },
        { name: 'status', type: 'text', nullable: false, pk: false },
        { name: 'password_hash', type: 'text', nullable: true, pk: false },
      ],
      pk: ['employee_id'],
      references: [],
    },
  ],
};

class StubDb implements DbClient {
  readonly id = 'stub';
  readonly queries: { sql: string; params: readonly unknown[] }[] = [];
  rows: Record<string, unknown>[] = [{ employee_id: '20004512', status: 'active', password_hash: 'x' }];
  existing = new Set(['20004512']);
  async query(sql: string, params: readonly unknown[]): Promise<DbResult> {
    this.queries.push({ sql, params });
    if (sql.includes('count(*)')) {
      return { rows: [{ n: this.existing.has(String(params[0])) ? '1' : '0' }], rowCount: 1, durationMs: 1 };
    }
    const col = /SELECT "([^"]+)"/.exec(sql)?.[1] ?? 'employee_id';
    return { rows: this.rows.map((r) => ({ v: r[col] })), rowCount: this.rows.length, durationMs: 1 };
  }
  async introspect(): Promise<DbSchema> {
    return SCHEMA;
  }
  async close(): Promise<void> {}
}

function model(script: Partial<ValueResolverModel> & { calls?: string[] }): ValueResolverModel {
  const calls = script.calls ?? [];
  return {
    id: 'scripted',
    fromPassages: async (q) => {
      calls.push('repo');
      return script.fromPassages ? script.fromPassages(q) : { value: null, evidence: '' };
    },
    chooseDbLookup: async (q) => {
      calls.push('db');
      return script.chooseDbLookup ? script.chooseDbLookup(q) : null;
    },
    generate: async (q) => {
      calls.push('generated');
      return script.generate ? script.generate(q) : { value: '29999999' };
    },
  };
}

const tokenStep = (over: Partial<Record<string, unknown>> = {}): FlowStep =>
  ({
    action: 'fill',
    selector: 'role=textbox[name="Replaced Employee ID" i]',
    value: '<NON_EXISTING_EMPLOYEE_ID>',
    intent: 'Step 3: กรอก Replaced Employee ID = <NON_EXISTING_EMPLOYEE_ID>',
    ...over,
  }) as FlowStep;

const describedStep = (): FlowStep =>
  ({
    action: 'fill',
    selector: 'role=textbox[name="Replaced Employee ID" i]',
    value: 'Employee ID ของพนักงานที่มีอยู่จริง',
    intent: 'Step 4: กรอก Replaced Employee ID ของพนักงานที่มีอยู่จริง',
  }) as FlowStep;

describe('finding what needs a value', () => {
  it('sees a token, a described value, and nothing else', () => {
    const needs = findUnresolvedValues(
      [],
      [
        tokenStep(),
        describedStep(),
        { action: 'fill', selector: 'role=textbox[name="First Name (EN)" i]', value: 'Somchai' } as FlowStep,
        { action: 'expectVisible', selector: 'text=<NON_EXISTING_EMPLOYEE_ID>' } as FlowStep,
        { action: 'fill', selector: 'role=textbox[name="Note" i]', value: 'see OQ-HIR-78' } as FlowStep,
      ],
      CASE,
    );
    assert.deepEqual(needs.map((n) => [n.index, n.field, n.token, n.nonExisting]), [
      [0, 'Replaced Employee ID', '<NON_EXISTING_EMPLOYEE_ID>', true],
      [1, 'Replaced Employee ID', null, false],
    ]);
  });

  it('reads the format the case states — digits and the leading digit', () => {
    assert.deepEqual(formatStatedFor('Employee ID', CASE), { digits: 8, leading: '2' });
    assert.equal(formatStatedFor('Nickname', 'nothing about digits here'), null);
    assert.deepEqual(formatStatedFor('National ID', 'Thailand Format = N-NNNN-NNNNN-NN-N'), { mask: 'N-NNNN-NNNNN-NN-N' });
  });

  it('a candidate follows the format and steps on retry', () => {
    assert.match(candidateFor({ digits: 8, leading: '2' }), /^2\d{7}$/);
    assert.notEqual(candidateFor({ digits: 8, leading: '2' }, 0), candidateFor({ digits: 8, leading: '2' }, 1));
    assert.match(candidateFor({ mask: 'N-NNNN-NNNNN-NN-N' }), /^\d-\d{4}-\d{5}-\d{2}-\d$/);
    assert.match(candidateFor(null), /^\d{8}$/);
  });
});

describe('the sources, in order', () => {
  it('test data wins when the case states the value — no model, no db touched', async () => {
    const calls: string[] = [];
    const db = new StubDb();
    const out = await resolveValues(
      [],
      [tokenStep({ value: '<VALID_EMPLOYEE_ID>', intent: 'Step 4: กรอก Replaced Employee ID = <VALID_EMPLOYEE_ID>' })],
      { caseText: `${CASE}\n- Replaced Employee ID = 20001234`, model: model({ calls }), db: async () => db },
    );
    assert.equal(out.resolved.length, 1);
    assert.equal(out.resolved[0]!.source.kind, 'test-data');
    assert.equal((out.steps[0] as { value: string }).value, '20001234');
    assert.deepEqual(calls, []);
    assert.equal(db.queries.length, 0);
  });

  it('a non-existing token never takes the VALID id\'s line from the test data', () => {
    const need = findUnresolvedValues([], [tokenStep()], `${CASE}\n- Replaced Employee ID = 20001234`)[0]!;
    assert.equal(fromTestData(need, `${CASE}\n- Replaced Employee ID = 20001234`), null);
  });

  it('repo beats db, and only when the value really is in a passage', async () => {
    const calls: string[] = [];
    const db = new StubDb();
    const grounded = await resolveValues([], [describedStep()], {
      caseText: CASE,
      promptText: 'BACKGROUND\n\nDemo users: HR admin employee 20007777 (active) is the replacement fixture.',
      model: model({ calls, fromPassages: async () => ({ value: '20007777', evidence: 'Demo users: HR admin employee 20007777' }) }),
      db: async () => db,
    });
    assert.equal(grounded.resolved[0]!.source.kind, 'repo');
    assert.equal((grounded.steps[0] as { value: string }).value, '20007777');
    assert.equal(db.queries.length, 0, 'the db is not asked when the repo answered');

    // The same model answer with nothing behind it is refused, and the db is next.
    const calls2: string[] = [];
    const ungrounded = await resolveValues([], [describedStep()], {
      caseText: CASE,
      promptText: 'BACKGROUND\n\nnothing numeric here',
      model: model({
        calls: calls2,
        fromPassages: async () => ({ value: '20007777', evidence: 'made up' }),
        chooseDbLookup: async () => ({ table: 'employee_center.employee', column: 'employee_id', where: { status: 'active' } }),
      }),
      db: async () => db,
    });
    assert.equal(ungrounded.resolved[0]!.source.kind, 'db');
    assert.equal((ungrounded.steps[0] as { value: string }).value, '20004512');
    assert.match(ungrounded.resolved[0]!.source.detail, /employee_center\.employee\.employee_id where status=active/);
    assert.ok(db.queries.some((q) => /SELECT "employee_id" AS v FROM "employee_center"\."employee" WHERE "status" = \$1/.test(q.sql)));
  });

  it('a NON_EXISTING token is proved absent in the db, stepping past a value that exists', async () => {
    const db = new StubDb();
    db.existing = new Set(['29999999', '29999998']);
    const out = await resolveValues([], [tokenStep()], {
      caseText: CASE,
      model: model({ chooseDbLookup: async () => ({ table: 'employee_center.employee', column: 'employee_id', where: {} }) }),
      db: async () => db,
    });
    const r = out.resolved[0]!;
    assert.equal(r.source.kind, 'db');
    assert.match(r.value, /^2\d{7}$/);
    assert.ok(!db.existing.has(r.value), 'the chosen candidate is one the table does not hold');
    assert.match(r.source.detail, /count = 0/);
    assert.equal(db.queries.length, 3, 'two existing candidates were stepped past');
  });

  it('refuses a lookup the schema does not ground, and falls through to a flagged stand-in', async () => {
    const db = new StubDb();
    const log: string[] = [];
    const out = await resolveValues([], [describedStep()], {
      caseText: CASE,
      model: model({ chooseDbLookup: async () => ({ table: 'employee_center.employee', column: 'ssn', where: {} }) }),
      db: async () => db,
      onLog: (l) => log.push(l),
    });
    assert.equal(out.resolved[0]!.source.kind, 'generated');
    assert.ok(log.some((l) => /db: the model named column "ssn"/.test(l)));
    assert.equal(db.queries.length, 0, 'no SQL ran for an ungrounded column');
  });

  it('never hands out a sensitive column\'s value', async () => {
    const db = new StubDb();
    const out = await resolveValues([], [describedStep()], {
      caseText: CASE,
      model: model({ chooseDbLookup: async () => ({ table: 'employee_center.employee', column: 'password_hash', where: {} }) }),
      db: async () => db,
    });
    assert.equal(out.resolved[0]!.source.kind, 'generated');
    assert.ok(!(out.steps[0] as { value: string }).value.includes('x'));
  });

  it('the generated stand-in is flagged on the step, in the intent, and matches the stated format', async () => {
    const out = await resolveValues([], [tokenStep()], { caseText: CASE, model: model({}) });
    const step = out.steps[0] as { value: string; intent: string; valueSource?: { kind: string; detail: string } };
    assert.match(step.value, /^\d{8}$/);
    assert.equal(step.valueSource?.kind, 'generated');
    assert.match(step.intent, /value GENERATED by the author/);
    assert.match(step.valueSource!.detail, /8 digits/);
    // The lint that used to refuse the token has nothing left to refuse.
    assert.equal(typesPlaceholderToken(out.steps), null);
  });

  it('with no model at all, test data and the deterministic stand-in still work', async () => {
    const out = await resolveValues([], [tokenStep()], { caseText: CASE, model: null });
    assert.equal(out.resolved[0]!.source.kind, 'generated');
    assert.match(out.resolved[0]!.value, /^2\d{7}$/);
  });

  it('the stage off leaves the token, and the lint fires as before', () => {
    const steps = [tokenStep()];
    assert.ok(PLACEHOLDER_TOKEN.test((steps[0] as { value: string }).value));
    assert.deepEqual(typesPlaceholderToken(steps), { index: 0, token: '<NON_EXISTING_EMPLOYEE_ID>', action: 'fill' });
  });
});

describe('the flag in the proof', () => {
  const proofStep = (valueSource: unknown): ProofStep =>
    ({
      index: 7,
      action: 'fill',
      selector: 'role=textbox[name="Replaced Employee ID" i]',
      resolvedSelector: 'role=textbox[name="Replaced Employee ID" i]',
      resolution: 'fast',
      status: 'passed',
      startedAt: '2026-09-02T00:00:00.000Z',
      durationMs: 12,
      url: 'http://localhost:3005/en/admin/hire',
      detail: { value: '29999999', valueSource },
    }) as unknown as ProofStep;

  it('describes a generated value as such, and a sourced one by its source', () => {
    assert.equal(describeValueSource(proofStep({ kind: 'generated', detail: 'GENERATED from 8 digits' })), 'generated — GENERATED from 8 digits');
    assert.equal(describeValueSource(proofStep({ kind: 'db', detail: 'employee.employee_id' })), 'from db: employee.employee_id');
    assert.equal(describeValueSource(proofStep(undefined)), null);
    assert.equal(valueWasGenerated(proofStep({ kind: 'generated', detail: '' })), true);
    assert.equal(valueWasGenerated(proofStep({ kind: 'repo', detail: '' })), false);
  });

  it('the CLI step line says so', () => {
    const line = formatStepLine(proofStep({ kind: 'generated', detail: 'GENERATED from 8 digits' }));
    assert.match(line, /value generated — GENERATED from 8 digits/);
    assert.ok(!formatStepLine(proofStep(undefined)).includes('value generated'));
  });
});
