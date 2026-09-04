/**
 * Wave-2 CLI wiring for the HR workbook (CG-01/04/05/09/10/11/12/13/16/17/18):
 * personas, workbook slicing, rounds as cases, unique keys per run, the
 * dependency order, the opening click's name, and the sheet's own verdict in
 * the truth table. All unit-tier — every function here is pure — except the
 * last block, which drives the CLI as a subprocess against the real workbook
 * when it is on this machine, because "no model call for a table" is only
 * observable from outside.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { caseWrites, goalWrites, orderDependentsAfterSources, orderScenariosFastestFirst } from '../src/cli/case-plan.js';
import { lookupPersona, parsePersonas, personaEmails, personaLabelOf } from '../src/cli/options.js';
import { newLedger, readLedger, recordOutcome, writeLedger } from '../src/cli/suite-progress.js';
import { classifyTruth, renderTruthTable, truthRows, truthTally } from '../src/reporter/truth-table.js';
import type { TestCaseRow } from '../src/catalog/test-case-table.js';
import type { Flow } from '../src/engine/runner.js';

const WORKBOOK = '/Users/ThArus/Downloads/QA_Task_Tracking_Cycle1.xlsx';

const row = (over: Partial<TestCaseRow>): TestCaseRow => ({
  no: '1',
  scenarioId: 'PL_06',
  scenario: 'Create plan',
  caseId: 'PL_06_21',
  polarity: 'Positive',
  priority: 'High',
  testCase: 'Create a plan',
  persona: '',
  preconditions: '',
  testData: '',
  menu: '',
  steps: '',
  expected: '',
  actual: '',
  testDate: '',
  testBy: '',
  bugTicket: '',
  note: '',
  ...over,
});

describe('personas (CG-05)', () => {
  it('reads --persona LABEL=email:password, repeatably, and the WOWLIDATOR_PERSONAS map', () => {
    const parsed = parsePersonas(['MANAGER_ACCOUNT=mgr@x.test:pw:with:colons', '<hrbp account>=hrbp@x.test:h'], {
      WOWLIDATOR_PERSONAS: JSON.stringify({ EMPLOYEE_ACCOUNT: { email: 'emp@x.test', password: 'e' }, SPD_ADMIN: 'spd@x.test:s' }),
    });
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.personas['MANAGER_ACCOUNT'], { email: 'mgr@x.test', password: 'pw:with:colons' });
    assert.deepEqual(parsed.personas['HRBP_ACCOUNT'], { email: 'hrbp@x.test', password: 'h' });
    assert.equal(parsed.personas['EMPLOYEE_ACCOUNT']?.email, 'emp@x.test');
    assert.equal(parsed.personas['SPD_ADMIN']?.password, 's');
    // Labels → emails only: what the ledger may carry.
    assert.deepEqual(personaEmails(parsed.personas)['MANAGER_ACCOUNT'], 'mgr@x.test');
    assert.ok(!JSON.stringify(personaEmails(parsed.personas)).includes('pw:with'));
  });

  it('refuses a malformed entry rather than dropping it, and never echoes the value', () => {
    const noPassword = parsePersonas(['MANAGER_ACCOUNT=mgr@x.test'], {});
    assert.ok(!noPassword.ok);
    assert.match(noPassword.error, /MANAGER_ACCOUNT/);
    assert.ok(!noPassword.error.includes('mgr@x.test'));
    const badJson = parsePersonas([], { WOWLIDATOR_PERSONAS: '{not json' });
    assert.ok(!badJson.ok);
    assert.match(badJson.error, /JSON/);
    assert.ok(parsePersonas(undefined, {}).ok);
  });

  it('a flag outranks the environment for the same label, and lookup tolerates the _ACCOUNT suffix', () => {
    const parsed = parsePersonas(['HR_ADMIN=flag@x.test:f'], {
      WOWLIDATOR_PERSONAS: JSON.stringify({ HR_ADMIN: { email: 'env@x.test', password: 'e' } }),
    });
    assert.ok(parsed.ok);
    assert.equal(parsed.personas['HR_ADMIN']?.email, 'flag@x.test');
    assert.equal(lookupPersona(parsed.personas, '<HR_ADMIN_ACCOUNT>')?.email, 'flag@x.test');
    assert.equal(personaLabelOf('<hr admin account>'), 'HR_ADMIN_ACCOUNT');
  });
});

describe('Thai business verbs classify a writer (CG-16)', () => {
  const flow = (goal: string): Flow => ({ name: 'f', steps: [{ action: 'workflow', goal }] }) as Flow;

  it('a Thai approval, submission, create or delete goal is a writer', () => {
    for (const goal of [
      'เข้าสู่ระบบเป็นหัวหน้า แล้วอนุมัติใบลาของพนักงาน',
      'ยื่นใบลาป่วย 3 รายการ',
      'สร้าง Plan ใหม่ แล้วบันทึก',
      'ลบ Plan PL_06_21 ออกจากรายการ',
      'กดปุ่ม Submit เพื่อส่งคำขอ OT',
    ]) {
      assert.equal(caseWrites(flow(goal)), true, goal);
    }
  });

  it('recording the value the system shows is a read, and so is opening a page', () => {
    assert.equal(goalWrites('บันทึกค่าที่ระบบแสดงจริงในช่อง Employee ID'), false);
    assert.equal(goalWrites('เปิดหน้า Benefit Plans แล้วอ่านจำนวนแถว'), false);
    assert.equal(caseWrites(flow('เข้าสู่ระบบ แล้วเปิดเมนู HR > Benefit Plans')), false);
  });
});

describe('dependents run after their sources (CG-12)', () => {
  type R = { caseId: string; scenarioId: string; steps: string; dependsOn?: string[] };
  const r = (caseId: string, scenarioId: string, dependsOn?: string[], steps = '1. a'): R => ({ caseId, scenarioId, steps, ...(dependsOn ? { dependsOn } : {}) });

  it('moves a dependent behind its source, keeping everything else in order', () => {
    const ordered = orderDependentsAfterSources(
      [r('B', 'S', ['C']), r('A', 'S'), r('C', 'S'), r('D', 'S', ['A'])],
      (x) => x.caseId,
      (x) => x.dependsOn ?? [],
    );
    assert.deepEqual(ordered.map((x) => x.caseId), ['A', 'C', 'B', 'D']);
  });

  it('a source not in the list, a self-reference and a cycle never lose a row', () => {
    const ordered = orderDependentsAfterSources(
      [r('A', 'S', ['E2E-118', 'A']), r('B', 'S', ['C']), r('C', 'S', ['B'])],
      (x) => x.caseId,
      (x) => x.dependsOn ?? [],
    );
    assert.deepEqual(ordered.map((x) => x.caseId), ['A', 'B', 'C']);
  });

  it('fastest-first never queues a scenario before the scenario its rows depend on', () => {
    // RU_07 (one cheap row) depends on PL_08 (three rows): cheapest-first alone
    // would put RU_07 first, and the ScenarioGate would then hold PL_08's
    // authoring until RU_07's case had RUN — while that case waits for PL_08.
    const rows = [
      r('PL_08_01', 'PL_08', undefined, '1. a\n2. b\n3. c'),
      r('PL_08_02', 'PL_08', undefined, '1. a\n2. b\n3. c'),
      r('RU_07_01', 'RU_07', ['PL_08_02']),
      r('ZZ_01', 'ZZ'),
    ];
    const { order } = orderScenariosFastestFirst(rows);
    assert.deepEqual(order.map((o) => o.scenario), ['ZZ', 'PL_08', 'RU_07']);
  });
});

describe('the sheet-blocked class of the truth table (CG-01)', () => {
  it('a row the sheet recorded as Blocked is graded against nothing, and shown as such', () => {
    assert.equal(classifyTruth('passed', 'blocked'), 'sheet-blocked');
    assert.equal(classifyTruth('failed', 'blocked'), 'sheet-blocked');
    const rows = truthRows(
      [
        { name: 'A blocked-by-sheet', verdict: 'passed', bundle: null },
        { name: 'B failed', verdict: 'failed', bundle: null },
      ],
      new Map([
        ['A blocked-by-sheet', 'blocked'],
        ['B failed', 'failed'],
      ]),
    );
    const t = truthTally(rows);
    assert.equal(t.sheetBlocked, 1);
    assert.equal(t.tp, 1);
    assert.equal(t.accuracy, 1, 'the blocked row is outside the accuracy');
    const html = renderTruthTable({ source: 'x', ranAt: 'now' }, rows);
    assert.match(html, /sheet: blocked/);
  });
});

describe('the ledger records the sheet verdict and the dependency edge (CG-01 / CG-12)', () => {
  it('round-trips dependsOn and knownResult', async () => {
    const ledger = newLedger('t', ['PL_03_07', 'PL_03_08']);
    recordOutcome(ledger, { name: 'PL_03_07 create', verdict: 'failed', bundle: null, reason: 'x' }, { knownResult: 'blocked' });
    recordOutcome(
      ledger,
      { name: 'PL_03_08 continue', verdict: 'blocked', bundle: null, reason: 'depends on PL_03_07 which did not pass' },
      { dependsOn: ['PL_03_07'], knownResult: 'passed' },
    );
    const dir = await mkdtemp(join(tmpdir(), 'wow-ledger-'));
    const path = join(dir, 'x.claims.progress.json');
    await writeLedger(path, ledger);
    const back = await readLedger(path);
    assert.deepEqual(back?.outcomes['PL_03_08']?.dependsOn, ['PL_03_07']);
    assert.equal(back?.outcomes['PL_03_08']?.knownResult, 'passed');
    assert.equal(back?.outcomes['PL_03_07']?.knownResult, 'blocked');
    assert.equal(back?.outcomes['PL_03_07']?.dependsOn, undefined);
    await rm(dir, { recursive: true, force: true });
  });
});

// The helpers below live in `cli/commands/authoring.ts`, which imports the
// flow author. Loaded lazily so a generator-side edit in flight fails THESE
// tests with the import error rather than the whole file.
describe('the authoring-side row helpers', () => {
  let helpers: typeof import('../src/cli/commands/authoring.js');
  before(async () => {
    helpers = await import('../src/cli/commands/authoring.js');
  });

  it('personasOf reads the tokens and the role words in order of appearance', () => {
    const labels = helpers.personasOf(
      row({
        persona: 'Login ด้วย <EMPLOYEE_ACCOUNT>',
        steps: '1. ยื่นใบลา\n2. Login ด้วย <MANAGER_ACCOUNT> แล้ว หัวหน้าอนุมัติ\n3. <EMPLOYEE_ACCOUNT> ตรวจสอบสถานะ',
      }),
    );
    assert.deepEqual(labels, ['EMPLOYEE_ACCOUNT', 'MANAGER_ACCOUNT']);
    assert.deepEqual(helpers.personasOf(row({ steps: '1. Login ด้วย SPD Admin\n2. เปิดเมนู Payroll' })), ['SPD_ADMIN']);
    // A field value is not a person.
    assert.deepEqual(helpers.personasOf(row({ testData: 'Approval route = Manager' })), []);
  });

  it('one persona falls back to --as; a second unmapped one refuses with the label', () => {
    const one = helpers.resolveRowPersonas(['HR_ADMIN_ACCOUNT'], { personas: {}, credentials: { email: 'admin@x.test', password: 'a' } });
    assert.deepEqual(one.missing, []);
    assert.equal(one.personas['HR_ADMIN_ACCOUNT']?.email, 'admin@x.test');
    assert.equal(one.fellBack, 'HR_ADMIN_ACCOUNT');
    const two = helpers.resolveRowPersonas(['EMPLOYEE_ACCOUNT', 'MANAGER_ACCOUNT'], {
      personas: {},
      credentials: { email: 'emp@x.test', password: 'e' },
    });
    assert.deepEqual(two.missing, ['MANAGER_ACCOUNT']);
    const mapped = helpers.resolveRowPersonas(['EMPLOYEE_ACCOUNT', 'MANAGER_ACCOUNT'], {
      personas: { MANAGER_ACCOUNT: { email: 'mgr@x.test', password: 'm' } },
      credentials: { email: 'emp@x.test', password: 'e' },
    });
    assert.deepEqual(mapped.missing, []);
    assert.equal(mapped.first?.email, 'emp@x.test');
    assert.equal(mapped.personas['MANAGER_ACCOUNT']?.email, 'mgr@x.test');
  });

  it('describeWithPersonas spells a token as its email, keeps the label, never the password', () => {
    const text = helpers.describeWithPersonas('Login ด้วย <HR_ADMIN_ACCOUNT> then <OTHER_ACCOUNT>', {
      HR_ADMIN_ACCOUNT: { email: 'admin@x.test', password: 'secret' },
    });
    assert.equal(text, 'Login ด้วย admin@x.test (<HR_ADMIN_ACCOUNT>) then <OTHER_ACCOUNT>');
    assert.ok(!text.includes('secret'));
  });

  it('sheetGate refuses Blocked with the ticket unless --include-blocked, and an external reference without a registry', () => {
    const blocked = row({ actual: 'Blocked', bugTicket: '71906' });
    assert.match(helpers.sheetGate(blocked) ?? '', /Blocked.*71906/);
    assert.equal(helpers.sheetGate(blocked, { includeBlocked: true }), null);
    const external = row({ externalRefs: ['E2E-118'] });
    assert.match(helpers.sheetGate(external) ?? '', /depends on E2E-118, which is not in this catalog/);
    assert.equal(helpers.sheetGate(external, { registry: ['E2E-118 created EMP-0042'] }), null);
  });

  it('substituteUniqueKeys rewrites the key value in Test data, Steps and Expected alike, idempotently', () => {
    const r = row({
      testData: 'Benefit Plan ID = PL_06_21\nBenefit name = QA-Create Plan\nCountry = TH',
      steps: '1. กรอก Benefit Plan ID = PL_06_21\n2. กด Save',
      expected: '2.1 แสดง PL_06_21 ในตาราง และ PL_06_21_R3 ไม่ซ้ำ',
    });
    const first = helpers.substituteUniqueKeys(r, 'be100@2026-08-31t07-20-25-957z');
    assert.ok(first.substitutions.some((s) => s.from === 'PL_06_21' && s.to === 'PL_06_21_25957z'));
    assert.match(first.row.testData, /Benefit Plan ID = PL_06_21_25957z/);
    assert.match(first.row.steps, /PL_06_21_25957z/);
    assert.match(first.row.expected, /แสดง PL_06_21_25957z ในตาราง/);
    assert.equal(first.row.testData.includes('Country = TH'), true);
    // The same literal everywhere, and a second pass changes nothing.
    const again = helpers.substituteUniqueKeys(first.row, 'be100@2026-08-31t07-20-25-957z');
    assert.deepEqual(again.substitutions, []);
    assert.deepEqual(helpers.substituteUniqueKeys(r, undefined).substitutions, []);
  });

  it('expandRounds makes one labelled case per round with that round\'s data, chained in order', () => {
    const r = row({
      caseId: 'HIR-EC-002',
      testData: 'Company = C001\nEmployee Group = A',
      steps: '1. กรอกข้อมูล\n2. กด Save\nรอบที่ 2 หน่วยธุรกิจ CU\nCompany = C013\nรอบที่ 3 หน่วยธุรกิจ CG\nCompany = C020\nEmployee Group = B',
    });
    const dependent = row({ caseId: 'PRB-EC-001', dependsOn: ['HIR-EC-002'] });
    const out = helpers.expandRounds([r, dependent]);
    const ids = out.map((x) => x.caseId);
    assert.ok(ids.includes('HIR-EC-002#r2') && ids.includes('HIR-EC-002#r3'), ids.join(','));
    const r2 = out.find((x) => x.caseId === 'HIR-EC-002#r2')!;
    assert.match(r2.testData, /Company = C013/);
    assert.match(r2.testData, /Employee Group = A/);
    assert.match(r2.preconditions, /Round 2 of 3/);
    assert.ok(ids.includes('HIR-EC-002#r1'), 'the implicit first round is a case too');
    assert.equal(r2.sheetCaseId, 'HIR-EC-002');
    assert.ok((r2.dependsOn ?? []).some((id) => id.startsWith('HIR-EC-002#r')));
    const r3 = out.find((x) => x.caseId === 'HIR-EC-002#r3')!;
    assert.match(r3.testData, /Employee Group = B/);
    // A row that cited the expanded case now cites its last round.
    assert.deepEqual(out.find((x) => x.caseId === 'PRB-EC-001')!.dependsOn, ['HIR-EC-002#r3']);
    // A single-round row is returned as it was.
    assert.equal(helpers.expandRounds([dependent])[0], dependent);
    // The EC sheet's own shape: the round's data on the header line. (A lone
    // "รอบที่ 2" is not a multi-round row to the parser, and so not here.)
    const inline = helpers.expandRounds([
      row({
        caseId: 'HIR-EC-003',
        testData: 'Company = C001',
        steps: '1. กรอก\n2. Save\n3. รอบที่ 2 หน่วยธุรกิจ CU ค่าที่ต่างจากรอบอื่นในรอบนี้ Company = C013\n4. รอบที่ 3 หน่วยธุรกิจ CG ค่าที่ต่างจากรอบอื่นในรอบนี้ Company = C020',
      }),
    ]);
    assert.match(inline.find((x) => x.caseId === 'HIR-EC-003#r2')!.testData, /Company = C013/);
    assert.match(inline.find((x) => x.caseId === 'HIR-EC-003#r1')!.testData, /Company = C001/);
  });

  it('openingControlOf names an opening click from the first steps and never a save or delete', () => {
    assert.equal(helpers.openingControlOf('1. เข้าสู่เมนู HR > Benefit Plans\n2. กดปุ่ม "Create Plan"\n3. กรอกข้อมูล'), 'Create Plan');
    assert.equal(helpers.openingControlOf('1. Click Add\n2. Fill the form'), 'Add');
    assert.equal(helpers.openingControlOf('1. กรอกข้อมูล\n2. กด ถัดไป'), 'ถัดไป');
    assert.equal(helpers.openingControlOf('1. กดปุ่ม "Delete"\n2. ยืนยัน'), null);
    assert.equal(helpers.openingControlOf('1. กดปุ่ม "Save"'), null);
    assert.equal(helpers.openingControlOf('1. เปิดหน้า\n2. อ่านค่า\n3. ตรวจสอบ\n4. กดปุ่ม "Add"'), null, 'only the first three steps');
  });

  it('sliceRows filters by sheet and category, case-insensitively', () => {
    const rows = [
      row({ caseId: 'A', sheet: 'EC', category: 'Hiring' }),
      row({ caseId: 'B', sheet: 'EC', category: 'Probation' }),
      row({ caseId: 'C', sheet: 'BE', category: 'Benefit Plan' }),
    ];
    assert.deepEqual(helpers.sliceRows(rows, ['ec'], []).map((r) => r.caseId), ['A', 'B']);
    assert.deepEqual(helpers.sliceRows(rows, ['EC'], ['hiring']).map((r) => r.caseId), ['A']);
    assert.deepEqual(helpers.sliceRows(rows, [], ['be/benefit plan']).map((r) => r.caseId), ['C']);
    assert.deepEqual(helpers.sliceRows(rows, [], []).length, 3);
  });
});

// ---------------------------------------------------------------------------
// The CLI as a subprocess against the real workbook: a slice is read from the
// grid with no model call, and the count is the sheet's.
// ---------------------------------------------------------------------------

const ROOT = resolve(import.meta.dirname, '..');
const CLI = join(ROOT, 'src', 'cli.ts');
const TSX_LOADER = join(ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs');

function runCli(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['--import', TSX_LOADER, CLI, ...args], {
      cwd: ROOT,
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/API_KEY|^WOWLIDATOR_/.test(key))),
        WOWLIDATOR_DISABLE_REPORT: '1',
        ...env,
      } as NodeJS.ProcessEnv,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
  });
}

describe('catalog --sheet --category on the real workbook (CG-11)', { skip: existsSync(WORKBOOK) ? false : `no workbook at ${WORKBOOK}` }, () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wow-slice-'));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads EC/Hiring from the grid — 150 rows, no model call, every id from the sheet', async () => {
    const out = join(dir, 'ec-hiring.claims.json');
    const result = await runCli(['catalog', WORKBOOK, '--sheet', 'EC', '--category', 'Hiring', '--claims-only', '--claims-out', out]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /slice: 150 of 1286 row\(s\)/);
    assert.match(result.stdout, /read 150 claim\(s\)/);
    assert.match(result.stdout, /no model call/);
    const claims = JSON.parse(await readFile(out, 'utf8')) as { claims: { source: string }[] };
    assert.equal(claims.claims.length, 150);
    assert.ok(claims.claims.every((c) => /^HIR-EC-\d+/.test(c.source)), 'every claim is a Hiring row');
  });

  it('an empty slice is a usage error that names the sheets', async () => {
    const result = await runCli(['catalog', WORKBOOK, '--sheet', 'NOPE', '--claims-only', '--claims-out', join(dir, 'x.json')]);
    assert.equal(result.code, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /selects no row/);
    assert.match(result.stderr, /Sheets: .*EC/);
  });
});
