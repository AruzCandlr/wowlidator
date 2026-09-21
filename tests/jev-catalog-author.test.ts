/**
 * The catalog generator for the indexed engine (`src/generator/jev-catalog-author.ts`).
 * Unit tier, always: the plan is pure over a described row, the fallback a
 * stub, `FlowAuthor` the real one with its lints. What is proved: a row's
 * cells become the steps the plan says, every goal parses back to its
 * pairs through the engine's own `goalOutcomes`, a readable row pays no
 * model, and an unread line pays one call whose non-assertions are dropped.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';

import { describeCase, parseTestCaseTable, type TestCaseRow } from '../src/catalog/test-case-table.js';
import { FlowAuthor, type AuthorRequest, type AuthorResult, type FlowAuthorModel } from '../src/generator/flow-author.js';
import { JevCatalogAuthorModel, attachPairs, legsRoundTrip, pairClause, planCatalogCase, writablePairs } from '../src/generator/jev-catalog-author.js';
import { loadConfig } from '../src/config.js';
import { LlmFactory } from '../src/providers/llm-factory.js';
import { authorModeOf } from '../src/cli/runtime.js';
import { menuPathOf } from '../src/orchestrator/agent-guards.js';

process.env['WOWLIDATOR_LLM_LOG'] = 'off';

const FIXTURE = readFileSync(new URL('./fixtures/master-data-cases.csv', import.meta.url), 'utf8');
const rows = parseTestCaseTable(FIXTURE)!;

const thaiRow: TestCaseRow = {
  ...rows[0]!,
  caseId: 'HIR-EC-001',
  scenarioId: 'E2E-01',
  scenario: 'New hire',
  testCase: 'สร้างพนักงานใหม่',
  persona: 'Login ด้วย <HR_ADMIN_ACCOUNT>',
  menu: 'EC > Hire & Onboard (New Hire)',
  testData: 'Employee Group = A - Permanent\nEmployee Sub Group = 10\nHire Date = Today\nFirst Name = สมชาย',
  steps: '1. Login ด้วย <HR_ADMIN_ACCOUNT>\n2. เข้าเมนู EC > Hire & Onboard\n3. กรอกข้อมูล Employee Group และ Employee Sub Group\n4. กรอก First Name แล้วกด Submit\n5. ตรวจสอบว่าระบบแสดงข้อความสำเร็จ',
  expected: '4.1 ระบบแสดงข้อความ "บันทึกสำเร็จ"\n5. ระบบไปที่หน้า /en/admin/employees\n5.1 ยังไม่มีคำตอบ ให้บันทึกค่าที่ระบบแสดงจริง',
};

/** A fallback that records the ask and answers a scripted result. */
function stubFallback(answer: Partial<AuthorResult>): FlowAuthorModel & { asks: AuthorRequest[] } {
  const asks: AuthorRequest[] = [];
  return {
    id: 'stub:llm',
    asks,
    async author(request) {
      asks.push(request);
      return { name: 'stub', rationale: '', setup: [], steps: [], teardown: [], notes: '', droppedSteps: 0, ...answer };
    },
  };
}

describe('planCatalogCase — a row becomes legs the engine reads at $0', () => {
  it('a persona token is the setup signIn, a menu path rides the first leg, pairs ride the step that names them', async () => {
    const plan = await planCatalogCase(describeCase(thaiRow), { now: new Date('2026-09-18T00:00:00Z'), signInUrl: 'https://app.test/humi/th/login' });
    assert.deepEqual(plan.setup, [{ action: 'signIn', as: 'HR_ADMIN_ACCOUNT', url: 'https://app.test/humi/th/login', intent: "sign in as HR_ADMIN_ACCOUNT (the sheet's Login / persona)" }]);
    const goals = plan.steps.filter((s) => s.action === 'workflow').map((s) => (s as { goal: string }).goal);
    assert.equal(goals.length, 3, `steps 2, 3, 4 are legs; 1 is the sign-in and 5 a verification:\n${goals.join('\n')}`);
    assert.ok(menuPathOf(goals[0]!) !== null, `the first leg carries a menu path the walker reads: ${goals[0]}`);
    assert.match(goals[1]!, /set "Employee Group" = "A - Permanent", "Employee Sub Group" = "10"/);
    assert.match(goals[2]!, /set "First Name" = "สมชาย"/);
    assert.ok(goals.every((g) => /\(test step \d\)$/.test(g)), 'every leg is annotated with its sheet step');
    // Hire Date = Today was named by no step: it rides the first input step, resolved to a date.
    assert.match(goals[1]!, /"Hire Date" = "2026-09-18"/, 'a relative date is resolved by the $0 source before the goal is written');
    assert.deepEqual(legsRoundTrip(plan), [], 'every pair parses back out of its goal through goalOutcomes');
  });

  it('a quoted literal is an expectVisible, a path an expectUrl, a record-only line is left unread', async () => {
    const plan = await planCatalogCase(describeCase(thaiRow));
    const asserts = plan.steps.filter((s) => s.action !== 'workflow');
    assert.deepEqual(asserts.map((s) => s.action), ['expectVisible', 'expectUrl']);
    assert.equal((asserts[0] as { selector: string }).selector, 'text="บันทึกสำเร็จ"');
    assert.equal((asserts[1] as { value: string }).value, '/en/admin/employees');
    assert.equal(plan.unread.length, 1);
    assert.equal(plan.unread[0]!.observeOnly, true);
  });

  it('the fixture row with no persona signs in as DEFAULT when the run has --as, and its expectation is unread', async () => {
    const plan = await planCatalogCase(describeCase(rows[0]!), { hasCredentials: true });
    assert.deepEqual(plan.setup.map((s) => (s as { as: string }).as), ['DEFAULT']);
    const goals = plan.steps.filter((s) => s.action === 'workflow').map((s) => (s as { goal: string }).goal);
    assert.equal(goals.length, 1);
    assert.match(goals[0]!, /^Open Hiring — open HR > Hiring via the menu: set "Company" = "ACME", "Position" = "P-001" \(test step 1\)$/);
    assert.equal(plan.unread.map((l) => l.text).join(), 'The form opens');
    assert.deepEqual(legsRoundTrip(plan), []);
  });

  it('a row with no persona and no --as has no sign-in, and says so', async () => {
    const plan = await planCatalogCase(describeCase(rows[0]!));
    assert.deepEqual(plan.setup, []);
    assert.ok(plan.rationale.some((r) => /no sign-in/.test(r)));
  });

  it('attachPairs keys a pair to the step naming its field, either way round, and strays to the first input step', () => {
    const steps = [{ n: 1, text: 'Open the form' }, { n: 2, text: 'กรอก Email address และ Password' }, { n: 3, text: 'กด Submit' }];
    const map = attachPairs(steps, [
      { phase: null, key: 'Email', value: 'a@x.test' },
      { phase: null, key: 'Password', value: 'pw' },
      { phase: null, key: 'Remember me', value: 'Yes' },
    ]);
    assert.deepEqual([...map.byStep.keys()], [2]);
    assert.equal(map.byStep.get(2)!.length, 3, 'Email matches "Email address"; the stray rides the input step');
    assert.deepEqual(map.derived, []);
    assert.equal(pairClause({ phase: null, key: 'Name', value: 'A (B)' }), '"Name" = "A (B)"');
  });

  it('a field is named in the bullets under a step, a verification step is no home, and an Expected-only field is derived (HIR-EC-001)', async () => {
    const row: TestCaseRow = {
      ...thaiRow,
      testData: 'Event Reason = New Hire\nProvince = กรุงเทพมหานคร\nPosition = 40106337\nCost Center = C00132653\nO.T. Flag = yes\nGender = Male\nHire Date = 01 Sep 2027',
      steps: [
        '1. Login ด้วย <HR_ADMIN_ACCOUNT>',
        '- ไปที่ EC > New Hire (Manual Key-in)',
        '',
        '2. กรอกข้อมูล Identity ตาม Test Data',
        '- กรอก Salutation, First Name, Hire Date และ Event Reason',
        '',
        '3. กรอกและตรวจสอบ Home Address',
        '- เลือก Province = กรุงเทพมหานคร และตรวจสอบรายการ District',
        '',
        '4. กรอกข้อมูล Position & Organization',
        '- เลือก Department / Position ตาม Test Data',
        '',
        '5. ตรวจสอบ Time Management Status และ O.T. Flag',
        '- ตรวจสอบว่าทั้งสองฟิลด์เป็น Read-only',
        '',
        '6. กด Submit เพื่อสร้างพนักงานใหม่',
      ].join('\n'),
      expected: '- Hire Date = Today ตามค่าที่กรอก\n- ระบบ Auto-Derive Time Management Status = 01 - Clocking และ O.T. Flag = Yes ตาม Rule Table\n- ระบบดึงข้อมูลจาก Department ได้แก่ Cost Center / SSO Location / Work Location',
    };
    const plan = await planCatalogCase(describeCase(row), { now: new Date('2026-09-18T00:00:00Z') });
    const goals = plan.steps.filter((s) => s.action === 'workflow').map((s) => (s as { goal: string }).goal);
    const byStep = (n: number): string => goals.find((g) => g.endsWith(`(test step ${n})`)) ?? '';
    assert.match(byStep(2), /"Event Reason" = "New Hire"/, 'named in the bullet under step 2');
    assert.match(byStep(2), /"Gender" = "Male"/, 'named nowhere: rides the first input step');
    assert.match(byStep(2), /"Hire Date" = "2027-09-01"/, 'an Expected line that echoes a keyed value marks nothing: still typed');
    assert.match(byStep(3), /"Province" = "กรุงเทพมหานคร"/, 'named in the bullet under step 3');
    assert.match(byStep(4), /"Position" = "40106337"/);
    assert.equal(byStep(5), '', 'a verification step names fields it reads, so it is neither a home nor a leg');
    assert.ok(!goals.some((g) => /Cost Center|O\.T\. Flag/.test(g)), `derived values are never set:\n${goals.join('\n')}`);
    assert.ok(plan.rationale.some((r) => /Cost Center, O\.T\. Flag — named by no step and by the Expected output/.test(r)), plan.rationale.join('\n'));
    assert.deepEqual(legsRoundTrip(plan), []);
  });

  it('the source a value is pulled FROM is the tester\'s input, never itself derived', () => {
    const { byStep, derived } = attachPairs(
      [{ n: 1, text: 'กรอกข้อมูล', block: 'กรอกข้อมูล' }],
      [
        { phase: null, key: 'Department', value: '30042174' },
        { phase: null, key: 'Cost Center', value: 'C00132653' },
      ],
      '- ระบบดึงข้อมูลจาก Department ได้แก่ Cost Center / SSO Location',
    );
    assert.deepEqual(derived.map((p) => p.key), ['Cost Center'], 'the listed value is derived');
    assert.equal(byStep.get(1)?.[0]?.key, 'Department', 'the source it is pulled from is still typed');
  });
});

describe('a pair the engine cannot read back never reaches a goal', () => {
  it('drops a blank value, notes an over-long key, and keeps the rest; a generated stand-in is never substituted', async () => {
    const { kept, blank, unreadable, overridden, meta, tokens } = writablePairs([
      { phase: null, key: 'Replaced Employee ID', value: '<NON_EXISTING_EMPLOYEE_ID>' },
      { phase: null, key: 'Entry Route', value: 'Keyin' },
      { phase: null, key: 'Menu', value: 'Team > Probation Reviews' },
      { phase: null, key: 'DVT Project', value: '' },
      { phase: null, key: 'A'.repeat(61), value: 'x' },
      { phase: 'TD-01', key: 'ตารางกำหนด Time Status', value: '01' },
      { phase: null, key: 'Branch code', value: 'TA57_1001' },
      { phase: null, key: 'Branch Code', value: 'T153_1733' },
    ]);
    assert.deepEqual([kept.length, blank.length, unreadable.length, overridden.length, meta.length, tokens.length], [2, 1, 1, 1, 2, 1], 'metadata and an unresolved token are never pairs');
    assert.equal(kept[1]!.value, 'T153_1733', 'the later line of the sheet is the one written');
    const row: TestCaseRow = { ...thaiRow, testData: 'Sub-District = เลือกจาก dropdown\nDVT Project = null\nHire Date = Today', steps: '1. กรอกข้อมูล Sub-District' };
    const plan = await planCatalogCase(describeCase(row), { now: new Date('2026-09-18T00:00:00Z') });
    const goal = (plan.steps.find((s) => s.action === 'workflow') as { goal: string }).goal;
    assert.ok(!/29999999|99999999/.test(goal), `no invented stand-in in a goal: ${goal}`);
    assert.ok(!/DVT Project/.test(goal), 'a blank pair is not written');
    assert.match(goal, /"Hire Date" = "2026-09-18"/, 'a relative date still resolves');
    assert.ok(plan.rationale.some((r) => /DVT Project left blank/.test(r)));
    assert.deepEqual(legsRoundTrip(plan), []);
  });
});

describe('JevCatalogAuthorModel — programmatic first, the model for the unread lines only', () => {
  it('a row whose every line is readable never asks the fallback', async () => {
    const fallback = stubFallback({});
    const model = new JevCatalogAuthorModel({ fallback });
    const text = describeCase({ ...thaiRow, expected: '4.1 ระบบแสดงข้อความ "บันทึกสำเร็จ"' });
    const result = await model.author({ prompt: text, caseText: text, url: 'https://app.test/humi/th/login', personas: { HR_ADMIN_ACCOUNT: { email: 'a@x.test', password: 'p' } } });
    assert.equal(fallback.asks.length, 0);
    assert.equal(result.setup[0]!.action, 'signIn');
    assert.equal((result.setup[0] as { url?: string }).url, 'https://app.test/humi/th/login', 'the run\'s sign-in page is the page the signIn opens');
    assert.equal(result.steps.at(-1)!.action, 'expectVisible');
    assert.equal(result.cases!.length, 1);
    assert.match(result.rationale, /one workflow leg/);
  });

  it('an unread line is one ask naming only that line, and only the answer\'s assertions are kept', async () => {
    const fallback = stubFallback({
      steps: [
        { action: 'click', selector: 'role=button[name="Next" i]' },
        { action: 'expectVisible', selector: 'role=heading[name="Hiring" i]', intent: 'the form opens' },
      ],
      inputTokens: 900,
      outputTokens: 40,
    });
    const model = new JevCatalogAuthorModel({ fallback });
    const text = describeCase(rows[0]!);
    const result = await model.author({ prompt: text, caseText: text, credentials: { email: 'a@x.test', password: 'p' } });
    assert.equal(fallback.asks.length, 1);
    const ask = fallback.asks[0]!.prompt;
    assert.match(ask, /WRITE ONLY the assertion steps/);
    assert.match(ask, /The form opens/);
    assert.match(ask, /ALREADY WRITTEN[\s\S]*workflow: Open Hiring/);
    assert.deepEqual(result.steps.map((s) => s.action), ['workflow', 'expectVisible'], 'the click the model wrote is dropped');
    assert.match(result.notes, /1 non-assertion step/);
    assert.equal(result.inputTokens, 900);
  });

  it('a request that is not a catalog row goes to the fallback whole', async () => {
    const fallback = stubFallback({ steps: [{ action: 'expectUrl', value: '/x' }] });
    const model = new JevCatalogAuthorModel({ fallback });
    const result = await model.author({ prompt: 'check the plans page' });
    assert.equal(fallback.asks.length, 1);
    assert.equal(result.steps[0]!.action, 'expectUrl');
  });
});

describe('through FlowAuthor, with its lints', () => {
  it('a readable Thai row authors with no model call and passes the lints under indexed mode', async () => {
    const fallback = stubFallback({});
    const author = new FlowAuthor({
      model: new JevCatalogAuthorModel({ fallback }),
      indexed: true,
      personas: { HR_ADMIN_ACCOUNT: { email: 'hr@x.test', password: 'p' } },
      projectContext: 'component NewHireForm renders "Employee Group" and "Submit"',
    });
    const text = describeCase({ ...thaiRow, expected: '4.1 ระบบแสดงข้อความ "บันทึกสำเร็จ"' });
    const authored = await author.author(text, undefined, { caseText: text, caseId: thaiRow.caseId });
    assert.equal(fallback.asks.length, 0, 'no model call for a readable row');
    assert.equal(authored.flow.setup?.[0]?.action, 'signIn');
    assert.ok(authored.flow.steps.some((s) => s.action === 'workflow' && /Employee Group/.test((s as { goal: string }).goal)), 'a goal naming a declared control is allowed under indexed mode');
    assert.equal(authored.flow.steps.at(-1)?.action, 'expectVisible');
  });
});

describe('authorModeOf — one config decides both halves', () => {
  it('follows the agent role under auto, and an explicit mode wins', () => {
    const jev = new LlmFactory(loadConfig({ WOWLIDATOR_AGENT_PROVIDER: 'openrouter', WOWLIDATOR_AGENT_MODEL: '~typesafe/jev-latest', WOWLIDATOR_LLM_LOG: 'off' }));
    const chat = new LlmFactory(loadConfig({ WOWLIDATOR_LLM_LOG: 'off' }));
    assert.equal(authorModeOf({ authorMode: 'auto', factory: jev }), 'jev');
    assert.equal(authorModeOf({ authorMode: 'auto', factory: chat }), 'llm');
    assert.equal(authorModeOf({ authorMode: 'llm', factory: jev }), 'llm');
    assert.equal(authorModeOf({ authorMode: 'jev', factory: chat }), 'jev');
  });
});
