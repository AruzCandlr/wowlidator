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
  absoluteDateOf,
  candidateFor,
  fieldLabelOf,
  findUnresolvedValues,
  formatStatedFor,
  fromRelativeDate,
  fromTestData,
  fromUniquePerRun,
  isDatePhrase,
  isReusedKeyValue,
  resolveDatePhrase,
  resolveValues,
  testDataPairsOf,
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

// --- CG-02: the Test data reaches the resolver one pair at a time ------------------

describe('test data pairs', () => {
  it('unpacks packed lines, phase headers, the folded describeCase form, and a draft correction', () => {
    const folded = 'Test data: --Create--; Position = 40106337 Job Code = MKB12.12; Effective Start Date = Today; --Insert R1--; Effective Start Date = Next day';
    assert.deepEqual(testDataPairsOf(folded), [
      { phase: 'Create', key: 'Position', value: '40106337' },
      { phase: 'Create', key: 'Job Code', value: 'MKB12.12' },
      { phase: 'Create', key: 'Effective Start Date', value: 'Today' },
      { phase: 'Insert R1', key: 'Effective Start Date', value: 'Next day' },
    ]);
    const corrected = testDataPairsOf('- Benefit plan ID = TH_MED_001\n- Note: ดราฟต์เดิมระบุ TH_MED_001 ใช้ TH_MED_002');
    assert.equal(corrected[0]!.value, 'TH_MED_002');
    // A bullet is stripped; a phase header is not a bullet.
    assert.deepEqual(testDataPairsOf('- --Delete--\n- Name = QA-Delete'), [{ phase: 'Delete', key: 'Name', value: 'QA-Delete' }]);
  });

  it('fromTestData takes pre-split pairs, matches a key after `*` and parentheticals, and reads a Thai label off the intent', () => {
    const need = findUnresolvedValues([], [tokenStep({ value: '<POSITION>', intent: 'Step 2: กรอก Position = <POSITION>', selector: 'role=textbox[name="Position *" i]' })], CASE)[0]!;
    assert.equal(need.field, 'Position *');
    const pairs = [{ phase: 'Create', key: 'Position (SAP code)', value: '40106337' }];
    const r = fromTestData(need, 'nothing here', pairs);
    assert.equal(r?.value, '40106337');
    assert.match(r!.source.detail, /\[Create\] Position \(SAP code\) = 40106337/);
    // The packed line, read straight from the case text.
    const packed = fromTestData({ ...need, field: 'Job Code' }, 'Test data: Position = 40106337 Job Code = MKB12.12');
    assert.equal(packed?.value, 'MKB12.12');
    // A Thai label after the sheet's verb, when the selector has no name.
    assert.equal(fieldLabelOf({ action: 'fill', selector: '#plan-name', value: '', intent: 'กรอก ชื่อแผน = ประกันสุขภาพ' } as FlowStep), 'ชื่อแผน');
    const thai = fromTestData({ ...need, field: 'ชื่อแผน' }, 'Test data: ชื่อแผน = ประกันสุขภาพ');
    assert.equal(thai?.value, 'ประกันสุขภาพ');
  });
});

// --- CG-06: relative dates, deterministic from an injected now -----------------------

const NOW = new Date(2026, 8, 3, 12); // 3 Sep 2026, local
const env = (known: Record<string, string> = {}) => ({ now: NOW, lookup: (l: string) => known[l.toLowerCase()] ?? null });

describe('relative dates', () => {
  it('the sheet\'s English and Thai anchors', () => {
    const at = (p: string, k: Record<string, string> = {}) => resolveDatePhrase(p, env(k))?.iso ?? null;
    assert.equal(at('Today'), '2026-09-03');
    assert.equal(at('วันนี้'), '2026-09-03');
    assert.equal(at('Next day'), '2026-09-04');
    assert.equal(at('Next Day'), '2026-09-04');
    assert.equal(at('Tomorrow'), '2026-09-04');
    assert.equal(at('วันถัดไป'), '2026-09-04');
    assert.equal(at('Next day+1'), '2026-09-05');
    assert.equal(at('Next day + 1'), '2026-09-05');
    assert.equal(at('Today + 30 Days'), '2026-10-03');
    assert.equal(at('ย้อนหลัง 3 วัน'), '2026-08-31');
    assert.equal(at('3 วันก่อน'), '2026-08-31');
    assert.equal(at('วันที่ 25 ของเดือนปัจจุบัน'), '2026-09-25');
    assert.equal(at('วันที่ 5 ของเดือนถัดไป'), '2026-10-05');
    assert.equal(at('วันสุดท้ายของเดือน'), '2026-09-30');
    assert.equal(at('วันสุดท้ายของเดือนถัดไป'), '2026-10-31');
    assert.equal(at('last day of next month'), '2026-10-31');
    assert.equal(at('01/01 ของปีก่อนหน้า'), '2025-01-01');
    assert.equal(at('31 Dec 9999'), '9999-12-31');
    assert.equal(at('31/12/9999'), '9999-12-31');
    assert.equal(at('Dec 31, 9999'), '9999-12-31');
    assert.equal(at('today พอดี'), '2026-09-03');
  });

  it('Thai month names and Buddhist years', () => {
    assert.deepEqual(absoluteDateOf('25 ธันวาคม 2569'), { y: 2026, m: 12, d: 25 });
    assert.deepEqual(absoluteDateOf('25 ธ.ค. 69'), { y: 2026, m: 12, d: 25 });
    assert.deepEqual(absoluteDateOf('1 Sep 2027'), { y: 2027, m: 9, d: 1 });
    assert.equal(absoluteDateOf('01/09/2027'), null, 'day/month order is the writer\'s, so it is left alone');
    assert.equal(absoluteDateOf('31 Feb 2026'), null);
  });

  it('a later field leans on an earlier one by label, and month arithmetic clamps', () => {
    const r = resolveDatePhrase('Hire Date + 119 Day', env({ 'hire date': '2026-09-03' }));
    assert.equal(r?.iso, '2026-12-31');
    assert.equal(r?.detail, 'Hire Date + 119 Day = 2026-12-31 (Hire Date = 2026-09-03)');
    assert.equal(resolveDatePhrase('Hire Date + 1 Year - 1 Day', env({ 'hire date': '2026-09-03' }))?.iso, '2027-09-02');
    assert.equal(resolveDatePhrase('Hire Date + 119 Day', env())?.iso ?? null, null, 'an unknown label is a refusal, not today');
    assert.equal(resolveDatePhrase('Today + 1 Month', { now: new Date(2026, 0, 31, 12), lookup: () => null })?.iso, '2026-02-28');
    assert.equal(resolveDatePhrase('Effective Start Date', env()), null, 'a bare label with no date behind it is nothing');
    assert.equal(resolveDatePhrase('Somchai', env()), null);
  });

  it('an age is a date of birth at the hire date, half a year inside a strict bound, exact on a boundary', () => {
    const k = { 'hire date': '2026-09-03' };
    assert.equal(resolveDatePhrase('Age < 60', env(k))?.iso, '1967-03-03');
    assert.match(resolveDatePhrase('Age < 60', env(k))!.detail, /age 59 y 6 m at hire date 2026-09-03/);
    assert.equal(resolveDatePhrase('อายุน้อยกว่า 60 ปี', env(k))?.iso, '1967-03-03');
    assert.equal(resolveDatePhrase('Age >= 60', env(k))?.iso, '1966-09-03');
    assert.equal(resolveDatePhrase('อายุ 60 ปีขึ้นไป', env(k))?.iso, '1966-09-03');
    assert.equal(resolveDatePhrase('อายุพอดี 60 ปีเป๊ะ', env(k))?.iso, '1966-09-03');
    assert.equal(resolveDatePhrase('Age > 60', env(k))?.iso, '1966-03-03');
    assert.equal(resolveDatePhrase('35 ปี 6 เดือน', env(k))?.iso, '1991-03-03');
    // No hire date resolved: today is the anchor, and the detail says so.
    assert.match(resolveDatePhrase('Age < 60', env())!.detail, /at today 2026-09-03/);
  });

  it('isDatePhrase gates on shape, and `N ปี M เดือน` only on a birth-date field', () => {
    for (const p of ['Today', 'Next day', 'Age < 60', 'Hire Date + 119 Day', 'วันที่ 25 ของเดือนปัจจุบัน', '31 Dec 9999', '25 ธ.ค. 69']) assert.equal(isDatePhrase(p), true, p);
    for (const p of ['Somchai', '20001234', '2026-09-03', 'A - Permanent', 'Effective Start Date', '']) assert.equal(isDatePhrase(p), false, p);
    assert.equal(isDatePhrase('6 เดือน', 'Claim Period'), false);
    assert.equal(isDatePhrase('35 ปี 6 เดือน', 'Date of Birth'), true);
  });

  it('is the FIRST source, and needs no model: a phrase typed as written, or stated in the Test data', async () => {
    const calls: string[] = [];
    const db = new StubDb();
    const caseText = [
      'HIR-EC-001: New hire',
      'Test data: Hire Date = Today; Date of Birth = Age < 60; Period End Date* = Hire Date + 119 Day; Replaced Employee ID = 20001234',
    ].join('\n');
    const out = await resolveValues(
      [],
      [
        { action: 'fill', selector: 'role=textbox[name="Hire Date" i]', value: 'Today', intent: 'Step 2: key Hire Date = Today' } as FlowStep,
        { action: 'fill', selector: 'role=textbox[name="Date of Birth" i]', value: 'Age < 60', intent: 'Step 3: key Date of Birth' } as FlowStep,
        { action: 'fill', selector: 'role=textbox[name="Period End Date" i]', value: '<PERIOD_END>', intent: 'Step 4: key Period End Date' } as FlowStep,
        tokenStep({ value: '<VALID_EMPLOYEE_ID>', intent: 'Step 5: กรอก Replaced Employee ID = <VALID_EMPLOYEE_ID>' }),
      ],
      { caseText, model: model({ calls }), db: async () => db, now: NOW },
    );
    const steps = out.steps as { value: string; intent: string; valueSource?: { kind: string; detail: string } }[];
    assert.equal(steps[0]!.value, '2026-09-03');
    assert.deepEqual(steps[0]!.valueSource, { kind: 'relative-date', detail: 'Today = 2026-09-03' });
    assert.match(steps[0]!.intent, /value from relative-date: Today = 2026-09-03/);
    assert.equal(steps[1]!.value, '1967-03-03', 'the DOB is relative to the Hire Date resolved just before');
    assert.equal(steps[2]!.value, '2026-12-31', 'a token whose Test data line is a phrase is computed too');
    assert.equal(steps[2]!.valueSource?.kind, 'relative-date');
    assert.equal(steps[3]!.value, '20001234', 'a plain value still comes from test data');
    assert.equal(steps[3]!.valueSource?.kind, 'test-data');
    assert.deepEqual(calls, [], 'no model was consulted');
    assert.equal(db.queries.length, 0);
    assert.equal(out.resolved.length, 4);
  });

  it('a phrase in the Test data resolves the field even when the sheet lists it after the one that leans on it', () => {
    const caseText = 'Test data: Period End Date = Hire Date + 119 Day; Hire Date = Today';
    const need = { section: 'steps' as const, index: 0, field: 'Period End Date', token: null, nonExisting: false, format: null };
    assert.equal(fromRelativeDate(need, caseText, NOW)?.value, '2026-12-31');
  });

  it('a phrase nothing understands is left as written — never a stand-in', async () => {
    const log: string[] = [];
    const out = await resolveValues([], [{ action: 'fill', selector: 'role=textbox[name="Hire Date" i]', value: 'Nonexistent Label + 3 Day', intent: 'x' } as FlowStep], {
      caseText: 'nothing',
      model: model({}),
      now: NOW,
      onLog: (l) => log.push(l),
    });
    assert.equal(out.resolved.length, 0);
    assert.equal((out.steps[0] as { value: string }).value, 'Nonexistent Label + 3 Day');
    assert.ok(log.some((l) => /was not understood — left as written/.test(l)));
  });

  it('a selectOption whose option label reads like a phrase is not a need', () => {
    const needs = findUnresolvedValues([], [{ action: 'selectOption', selector: 'role=combobox[name="Repeat" i]', value: 'Next day' } as FlowStep], '');
    assert.equal(needs.length, 0);
  });
});

// --- CG-13: a key that IS the case id becomes unique per run ---------------------------

describe('unique per run', () => {
  const BE = [
    'PL_06_21: ตรวจสอบการสร้าง Benefit Plan',
    'Test data: Benefit Plan ID = PL_06_21; Benefit name = QA-Create Plan Success/History; Country = TH',
    'Expected output:',
    '  1.1 ระบบสร้าง Plan สำเร็จ',
  ].join('\n');
  const planStep = (value: string, intent = 'Step 2: key Benefit Plan ID'): FlowStep =>
    ({ action: 'fill', selector: 'role=textbox[name="Benefit Plan ID" i]', value, intent }) as FlowStep;

  it('recognises the case id in any spelling, the sheet\'s _R1 tail, and QA-/SIT_ names — on key fields only', () => {
    assert.equal(isReusedKeyValue('PL_06_21', 'Benefit Plan ID', 'PL_06_21'), true);
    assert.equal(isReusedKeyValue('pl-06-21', 'Benefit Plan ID', 'PL_06_21'), true);
    assert.equal(isReusedKeyValue('PL_06_21_R3', 'Benefit Plan ID', 'PL_06_21'), true);
    assert.equal(isReusedKeyValue('QA-Insert', 'Benefit name', 'PL_08_19'), true);
    assert.equal(isReusedKeyValue('SIT_CNS_01', 'Document Code', 'CNS-EC-003'), true);
    assert.equal(isReusedKeyValue('TH_MED_001', 'Benefit Plan ID', 'PL_10_05'), false, 'a value chosen for its meaning stays');
    assert.equal(isReusedKeyValue('PL_06_21', 'Description', 'PL_06_21'), false, 'not a key field');
    assert.equal(isReusedKeyValue('PL_06_21', 'Benefit Plan ID', undefined), false, 'no case id, only QA-/SIT_ qualify');
  });

  it('rewrites the typed value with the run suffix and flags the source', async () => {
    const out = await resolveValues([], [planStep('PL_06_21')], { caseText: BE, model: null, runKey: 'be100@2026-08-31t07-20-25-957z', caseId: 'PL_06_21' });
    const step = out.steps[0] as { value: string; intent: string; valueSource?: { kind: string; detail: string } };
    assert.equal(step.value, 'PL_06_21_25957z');
    assert.deepEqual(step.valueSource, { kind: 'unique-per-run', detail: 'unique per run: PL_06_21 → PL_06_21_25957z' });
    assert.match(step.intent, /value unique per run: PL_06_21 → PL_06_21_25957z/);
    assert.equal(out.resolved[0]!.source.kind, 'unique-per-run');
  });

  it('a value reached through the Test data gets the suffix too, and the detail keeps the sheet line', async () => {
    const out = await resolveValues([], [planStep('<PLAN_ID>')], { caseText: BE, model: null, runKey: 'be100@2026-08-31t07-20-25-957z', caseId: 'PL_06_21' });
    const step = out.steps[0] as { value: string; valueSource?: { kind: string; detail: string } };
    assert.equal(step.value, 'PL_06_21_25957z');
    assert.equal(step.valueSource?.kind, 'unique-per-run');
    assert.match(step.valueSource!.detail, /the case states "Benefit Plan ID = PL_06_21"/);
  });

  it('a duplicate case keeps the value: the text says it already exists', async () => {
    const dup = `${BE}\n- Benefit plan ID = PL_06_21 (มีอยู่แล้วในระบบ)\n  1.2 แสดง Error: Plan ID นี้มีอยู่แล้วในระบบ`;
    const log: string[] = [];
    const out = await resolveValues([], [planStep('PL_06_21')], { caseText: dup, model: null, runKey: 'be100@x', caseId: 'PL_06_21', onLog: (l) => log.push(l) });
    assert.equal((out.steps[0] as { value: string }).value, 'PL_06_21');
    assert.equal(out.resolved.length, 0);
    assert.ok(log.some((l) => /kept as written \(the case says it already exists\)/.test(l)));
    // The intent alone can say so.
    const need = findUnresolvedValues([], [planStep('PL_06_21', 'Step 3: key the existing Plan ID again')], BE, { caseId: 'PL_06_21' })[0]!;
    assert.equal(fromUniquePerRun(need, BE, 'be100@x', 'Step 3: key the existing Plan ID again'), null);
  });

  it('without a run key nothing is rewritten, and a value that is not a key is never a need', async () => {
    const out = await resolveValues([], [planStep('PL_06_21')], { caseText: BE, model: null, caseId: 'PL_06_21' });
    assert.equal((out.steps[0] as { value: string }).value, 'PL_06_21');
    assert.equal(out.resolved.length, 0);
    assert.equal(findUnresolvedValues([], [planStep('TH_MED_001')], BE, { caseId: 'PL_06_21' }).length, 0);
  });
});
