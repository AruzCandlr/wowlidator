/**
 * Wave 2 of the HR-workbook programme (2026-09-03), the author's half: the
 * sheet's own shapes — persona tokens, record-only lines, +1 / -1 counters,
 * either/or outcomes, option sets, field-scoped errors, wait-until claims,
 * attachments, rounds and the menu route — authored as steps the engine
 * has, and refused when they are not.
 *
 * Entirely unit-tier: every rail is a pure function over a `describeCase`
 * rendering and a step list, the model is a stub, and each fixture line is
 * the workbook's own wording (EC Hiring / Probation, BE Plan / Rule, PY,
 * TM) — a rail phrased in words the sheet never uses is a rail that never
 * fires.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildAuthoringPrompt } from '../src/catalog/catalog.js';
import { describeCase, type TestCaseRow } from '../src/catalog/test-case-table.js';
import type { FlowStep } from '../src/engine/runner.js';
import { riskSignals, type RiskRequest } from '../src/generator/dead-end-risk.js';
import { diagnosisSignals } from '../src/generator/error-diagnosis.js';
import type { ProofBundle, ProofStep } from '../src/engine/proof-bundle.js';
import {
  AuthoringError,
  FlowAuthor,
  LlmFlowAuthorModel,
  MAX_STEP_TIMEOUT_MS,
  assertsRecordOnlyLine,
  buildUserPrompt,
  countPinnedName,
  dropReasonFor,
  expectedItemsIn,
  fieldErrorAssertedPageWide,
  groundPersonaSignIns,
  handTypedPersonaSignIn,
  hedgedAlternatives,
  ignoresMenuPath,
  inventedControlInternals,
  multiPersonaWorkflow,
  recordOnlyCase,
  recordOnlyLines,
  selectorsOf,
  signInAsUnknownPersona,
  skipsAuthoredScript,
  switchesPersona,
  testDataPairsOfCaseText,
  unassertedExpectedItems,
  unassertedForbiddenOption,
  unbudgetedStatusWait,
  undefinedVariableRef,
  ungroundedSelectorRole,
  ungroundedTextExpectation,
  unmeasuredDeltaClaim,
  unperformedScriptSteps,
  unpinnedDateEntry,
  unreconciledMatchClaim,
  type AuthorRequest,
  type AuthorResult,
  type FlowAuthorModel,
} from '../src/generator/flow-author.js';
import { applyReview, auditGrounding, type ReviewEvidence } from '../src/generator/flow-review.js';
import { observationSteps, vacuousClaim } from '../src/generator/vacuous.js';
import { jsonModel } from './helpers.js';

/** A sheet row with every text column, so `describeCase` renders it exactly as the catalog path does. */
function row(overrides: Partial<TestCaseRow>): TestCaseRow {
  return {
    no: '1', scenarioId: '', scenario: '', caseId: 'X_01', polarity: '', priority: '', testCase: 'a case',
    persona: '', preconditions: '', testData: '', menu: '', steps: '', expected: '', actual: '', testDate: '',
    testBy: '', bugTicket: '', note: '',
    ...overrides,
  };
}

/** A stub that returns whatever the test hands it, and records the request. */
function stubModel(result: Partial<AuthorResult>): FlowAuthorModel & { seen?: AuthorRequest } {
  const model: FlowAuthorModel & { seen?: AuthorRequest } = {
    id: 'stub:author',
    async author(request) {
      model.seen = request;
      return { name: 'stub flow', rationale: 'because', setup: [], steps: [], teardown: [], notes: '', droppedSteps: 0, ...result };
    },
  };
  return model;
}

/** The raw wire shape the model returns — every field a string, `case` nullable. */
function wire(step: Partial<Record<'action' | 'selector' | 'value' | 'url' | 'key' | 'name' | 'intent' | 'timeoutMs', string>>) {
  return { action: 'click', case: null, selector: '', value: '', url: '', key: '', name: '', intent: 'i', timeoutMs: '', ...step };
}

/** Author one raw body through the real narrowing (`LlmFlowAuthorModel` over a JSON mock). */
async function narrow(steps: ReturnType<typeof wire>[]): Promise<AuthorResult> {
  const mock = jsonModel('mock-author', { name: 'x', rationale: '', setup: [], steps, teardown: [], notes: '' }, { inputTokens: 0, outputTokens: 0 });
  return new LlmFlowAuthorModel({ model: mock, id: 'mock:author' }).author({ prompt: 'p', policy: 'mutations' });
}

const PERSONAS = {
  HR_ADMIN_ACCOUNT: { email: 'admin@cnext.test', password: 'admin2026' },
  MANAGER_ACCOUNT: { email: 'manager@cnext.test', password: 'manager2026' },
  HRBP_ACCOUNT: { email: 'hrbp@cnext.test', password: 'hrbp2026' },
};

const loginAs = (email: string, password: string): FlowStep[] => [
  { action: 'goto', url: 'http://x.test/en/login' },
  { action: 'fill', selector: 'role=textbox[name="Work email" i]', value: email },
  { action: 'click', selector: 'role=button[name="Next" i]' },
  { action: 'fill', selector: 'input[type="password"]', value: password },
  { action: 'click', selector: 'role=button[name="Sign in" i]' },
  { action: 'expectHidden', selector: 'role=button[name="Sign in" i]' },
];

// ---------------------------------------------------------------- CG-02

describe('CG-02 — the Test data reaches the resolver one pair per line, as the parser rendered it', () => {
  // BE PL_08_19's shape: phases, a packed line the parser unpacked, a correction kept as prose.
  const text = describeCase(row({
    caseId: 'PL_08_19',
    testData: '--Create--\nPosition = 40106337 Job Code = MKB12.12\n--Insert R1--\nEffective Start Date = Next day\nดราฟต์เดิมระบุ Department = 30001142 ใช้ 30042174\nDepartment = 30001142',
  }));

  it('reads [phase] Key = value lines back without re-splitting, and skips the correction prose', () => {
    const pairs = testDataPairsOfCaseText(text);
    assert.deepEqual(
      pairs.map((p) => `${p.phase ?? ''}|${p.key}|${p.value}`),
      ['Create|Position|40106337', 'Create|Job Code|MKB12.12', 'Insert R1|Effective Start Date|Next day', 'Insert R1|Department|30042174'],
    );
  });

  it('yields nothing for a case with no Test data block', () => {
    assert.deepEqual(testDataPairsOfCaseText('X_01: a case\nSteps:\n  1. go'), []);
  });
});

// ---------------------------------------------------------------- CG-06

describe('CG-06 — a date the resolver computed is pinned by construction', () => {
  it('unpinnedDateEntry exempts a relative-date value and still refuses a hand-typed ISO date', () => {
    const resolved: FlowStep[] = [
      { action: 'fill', selector: 'role=textbox[name="Hire Date" i]', value: '2026-09-03', valueSource: { kind: 'relative-date', detail: 'Today = 2026-09-03' } as never },
    ];
    assert.equal(unpinnedDateEntry([], resolved), null);
    const typed: FlowStep[] = [{ action: 'fill', selector: 'role=textbox[name="Hire Date" i]', value: '2026-09-03' }];
    assert.equal(unpinnedDateEntry([], typed)?.value, '2026-09-03');
  });

  it('the pipeline converts "Today" from the described case and hands the flow over without a setClock refusal', async () => {
    const caseText = describeCase(row({ caseId: 'HIR-EC-001', testData: 'Hire Date = Today', steps: '1. กรอก Hire Date', expected: '1.1 ระบบบันทึกวันที่' }));
    const author = new FlowAuthor({
      model: stubModel({
        steps: [
          { action: 'fill', selector: 'role=textbox[name="Hire Date" i]', value: 'Today', intent: 'Step 1: กรอก Hire Date' },
          { action: 'expectVisible', selector: 'text="Hire Date"', intent: '1.1 saved' },
        ],
      }),
      valueResolution: { model: null },
    });
    const authored = await author.author('HIR-EC-001', undefined, { caseText, now: new Date(2026, 8, 3, 12) });
    const fill = authored.flow.steps[0] as FlowStep & { value: string; valueSource?: { kind: string } };
    assert.equal(fill.value, '2026-09-03');
    assert.equal(fill.valueSource?.kind, 'relative-date');
  });
});

// ---------------------------------------------------------------- CG-05 / EH-10 / OA-15

describe('CG-05 — personas reach the model by label and email, never by password', () => {
  it('renders a PERSONAS section with no password in it, and none at all when absent', () => {
    const text = buildUserPrompt({ prompt: 'PRB-EC-001', personas: PERSONAS });
    assert.match(text, /PERSONAS/);
    assert.match(text, /MANAGER_ACCOUNT: manager@cnext\.test/);
    assert.doesNotMatch(text, /manager2026|admin2026|hrbp2026/);
    assert.doesNotMatch(buildUserPrompt({ prompt: 'PRB-EC-001' }), /PERSONAS/);
  });

  it('narrows signIn by label from "name", strips the sheet\'s <TOKEN> form, and drops a label-less one', async () => {
    const result = await narrow([
      wire({ action: 'signIn', name: 'HR_ADMIN_ACCOUNT' }),
      wire({ action: 'signIn', value: '<HRBP_ACCOUNT>', url: '/en/login' }),
      wire({ action: 'signIn' }),
    ]);
    assert.deepEqual(result.steps.map((s) => (s as { as?: string }).as), ['HR_ADMIN_ACCOUNT', 'HRBP_ACCOUNT']);
    assert.equal((result.steps[1] as { url?: string }).url, '/en/login');
    assert.equal(result.droppedSteps, 1);
    assert.match(dropReasonFor(wire({ action: 'signIn' }) as never, false), /persona LABEL in "name"/);
  });

  it('groundPersonaSignIns replaces a typed sign-in for a known persona with one signIn, keeping a business email fill', () => {
    const steps: FlowStep[] = [
      ...loginAs('manager@cnext.test', 'whatever-the-model-guessed'),
      { action: 'goto', url: '/en/employees' },
      { action: 'fill', selector: 'role=textbox[name="Manager email" i]', value: 'hrbp@cnext.test' },
      { action: 'click', selector: 'role=button[name="Save" i]' },
    ];
    const fixed = groundPersonaSignIns(steps, PERSONAS);
    assert.equal(fixed.replaced, 1);
    assert.deepEqual(fixed.steps.map((s) => s.action), ['signIn', 'goto', 'fill', 'click']);
    assert.equal((fixed.steps[0] as { as: string }).as, 'MANAGER_ACCOUNT');
    assert.equal((fixed.steps[0] as { url?: string }).url, 'http://x.test/en/login');
    assert.equal(JSON.stringify(fixed.steps).includes('whatever-the-model-guessed'), false, 'the guessed password leaves the flow');
  });

  it('the pipeline replaces the block, marks two personas e2e, and says so', async () => {
    const author = new FlowAuthor({
      model: stubModel({
        name: 'manager assesses, hrbp approves',
        steps: [
          ...loginAs('manager@cnext.test', 'x'),
          { action: 'click', selector: 'role=button[name="Submit" i]', intent: 'Step 3: submit' },
          { action: 'signIn', as: 'HRBP_ACCOUNT', intent: 'Step 4: Login ด้วย <HRBP_ACCOUNT>' },
          { action: 'click', selector: 'role=button[name="Approve" i]', intent: 'Step 4: Approve' },
          { action: 'expectVisible', selector: 'text="Approved"', intent: '4.1' },
        ],
      }),
      personas: PERSONAS,
    });
    const authored = await author.author('PRB-EC-001 manager submits, HRBP approves');
    assert.deepEqual(authored.flow.steps.filter((s) => s.action === 'signIn').map((s) => (s as { as: string }).as), ['MANAGER_ACCOUNT', 'HRBP_ACCOUNT']);
    assert.equal(authored.flow.steps.some((s) => s.action === 'fill'), false);
    assert.equal(authored.flow.scope, 'e2e');
    assert.match(authored.notes, /replaced 1 typed sign-in block/);
    assert.deepEqual(switchesPersona([], authored.flow.steps), ['manager_account', 'hrbp_account']);
  });

  it('refuses a sign-in typed for an account the run does not hold, naming the labels', async () => {
    const author = new FlowAuthor({
      model: stubModel({ steps: [...loginAs('employee2@cnext.test', 'Password123!'), { action: 'expectVisible', selector: 'text="Consent"', intent: '1.1' }] }),
      personas: PERSONAS,
      attempts: 1,
    });
    await assert.rejects(author.author('CNS-EC-028'), (error: unknown) => {
      assert.ok(error instanceof AuthoringError);
      assert.match(error.message, /types a sign-in by hand/);
      assert.match(error.message, /HR_ADMIN_ACCOUNT, MANAGER_ACCOUNT, HRBP_ACCOUNT/);
      return true;
    });
    assert.equal(handTypedPersonaSignIn(loginAs('employee2@cnext.test', 'p'), PERSONAS)?.value, 'employee2@cnext.test');
  });

  it('refuses a signIn as a label the run lacks, and accepts a literal email that matches one', () => {
    const unknown = signInAsUnknownPersona([{ action: 'signIn', as: 'EMPLOYEE_ACCOUNT' }], PERSONAS);
    assert.equal(unknown?.as, 'EMPLOYEE_ACCOUNT');
    assert.deepEqual(unknown?.available, ['HR_ADMIN_ACCOUNT', 'MANAGER_ACCOUNT', 'HRBP_ACCOUNT']);
    assert.equal(signInAsUnknownPersona([{ action: 'signIn', as: 'hrbp@cnext.test' }], PERSONAS), null);
    assert.equal(signInAsUnknownPersona([{ action: 'signIn', as: 'hr_admin_account' }], PERSONAS), null, 'labels compare case-insensitively');
  });

  it('OA-15 — a workflow goal naming two people is refused; two legs with a signIn between are the authored form', async () => {
    // PRB-EC: "ผู้ทดสอบ <MANAGER_ACCOUNT> ผู้ประเมิน และ <HRBP_ACCOUNT> ผู้อนุมัติ"
    const goal = 'as <MANAGER_ACCOUNT> submit the probation result, then as <HRBP_ACCOUNT> open the case and click Approve';
    assert.deepEqual(multiPersonaWorkflow([{ action: 'workflow', goal }])?.personas.length, 2);
    const author = new FlowAuthor({
      model: stubModel({ steps: [{ action: 'workflow', goal }, { action: 'expectVisible', selector: 'text="Approved"', intent: '4.1' }] }),
      attempts: 1,
    });
    await assert.rejects(author.author('PRB-EC-001'), /one session cannot be both people/);
  });

  it('the system prompt carries the persona rules', async () => {
    const mock = jsonModel('mock-author', { name: 'x', rationale: '', setup: [], steps: [], teardown: [], notes: '' }, { inputTokens: 0, outputTokens: 0 });
    await new LlmFlowAuthorModel({ model: mock, id: 'mock:author' }).author({ prompt: 'p', policy: 'forms', personas: PERSONAS });
    const sent = JSON.stringify((mock as unknown as { doGenerateCalls: unknown[] }).doGenerateCalls[0]).replace(/\\n/g, ' ').replace(/\s+/g, ' ');
    assert.match(sent, /A PERSONA IS SIGNED IN BY ITS LABEL, NEVER BY TYPING ITS PASSWORD/);
    assert.match(sent, /Login ด้วย <HR_ADMIN_ACCOUNT>/);
    assert.match(sent, /never one workflow goal that names two people/);
    assert.match(sent, /HR_ADMIN_ACCOUNT: admin@cnext\.test/);
    assert.doesNotMatch(sent, /admin2026/);
  });
});

// ---------------------------------------------------------------- CG-07

describe('CG-07 — +1 / -1 / no change is a reading taken before and after', () => {
  // PL_03_07, verbatim.
  const plans = describeCase(row({
    caseId: 'PL_03_07',
    steps: '1. กด Create Plan\n6. ตรวจสอบกล่องสรุป',
    expected: '6.1 จำนวนเพิ่มขึ้น +1 ใน Total Plans\n6.2 จำนวนเพิ่มขึ้น +1 ใน Reimbursement by Employee and HR',
  }));
  const pending = describeCase(row({ caseId: 'PRB-EC-030', expected: '6.3 เมื่ออนุมัติแล้วรายการหายจากรายการค้างและจำนวนลดลง 1 รายการ' }));

  it('narrows the delta form {{before+1}} on expectCount, and the variable lint reads the name under it', async () => {
    const result = await narrow([
      wire({ action: 'saveText', selector: 'text="Total plans"', value: 'before_total_plans' }),
      wire({ action: 'expectCount', selector: 'role=row', value: '{{before_total_plans+1}}' }),
      wire({ action: 'expectCount', selector: 'role=row', value: '{{before_total_plans - 1}}' }),
    ]);
    assert.deepEqual(result.steps.map((s) => (s as { count?: unknown }).count), [undefined, '{{before_total_plans+1}}', '{{before_total_plans - 1}}']);
    assert.equal(undefinedVariableRef(result.steps), null);
    assert.equal(undefinedVariableRef([{ action: 'expectText', selector: 'x', value: '{{nothing+1}}' }])?.name, 'nothing');
  });

  it('refuses presence-only proof of +1, and is satisfied by save + {{x+1}}', () => {
    const presence: FlowStep[] = [
      { action: 'click', selector: 'role=button[name="Create Plan" i]' },
      { action: 'expectVisible', selector: 'text="Total plans"', intent: '6.1' },
    ];
    assert.match(unmeasuredDeltaClaim(presence, plans) ?? '', /เพิ่มขึ้น \+1/);
    const measured: FlowStep[] = [
      { action: 'saveText', selector: 'text="Total plans"', as: 'before_total_plans' },
      { action: 'click', selector: 'role=button[name="Create Plan" i]' },
      { action: 'expectText', selector: 'text="Total plans"', value: '{{before_total_plans+1}}', intent: '6.1' },
    ];
    assert.equal(unmeasuredDeltaClaim(measured, plans), null);
    assert.equal(unreconciledMatchClaim(measured, 'Expected output: the Total Plans tile matches the table row count'), null, 'the delta form also settles a match claim');
  });

  it('reads "ลดลง 1 รายการ" too, and ignores a date or a range', () => {
    assert.ok(unmeasuredDeltaClaim([], pending) !== null);
    const dated = describeCase(row({ caseId: 'X', expected: '1.1 Effective Start Date = 2026-09-01\n1.2 แสดง 1-15 of 43 รายการ' }));
    assert.equal(unmeasuredDeltaClaim([], dated), null);
  });
});

// ---------------------------------------------------------------- CG-08

describe('CG-08 — either/or is one expectAnyVisible', () => {
  // TC_PY_* negatives, verbatim.
  const eitherOr = describeCase(row({ caseId: 'TC_PY_REC_010', expected: '2. ตรวจสอบ ระบบประมวลผลสำเร็จหรือแสดง error ตามเงื่อนไขที่ทดสอบ ไม่ crash กลางคัน' }));
  const single = describeCase(row({ caseId: 'PL_03_01', expected: '6.1 ระบบแสดงข้อความ "Plan created"' }));

  it('narrows ";"-separated selectors, rewriting each, and drops fewer than two', async () => {
    const result = await narrow([
      wire({ action: 'expectAnyVisible', value: 'text="Completed"; StaticText[text="Error"]', timeoutMs: '120000' }),
      wire({ action: 'expectAnyVisible', value: 'text="Completed"' }),
    ]);
    const step = result.steps[0] as FlowStep & { selectors: string[]; timeoutMs?: number };
    assert.deepEqual(step.selectors, ['text="Completed"', 'text="Error"']);
    assert.equal(step.timeoutMs, 120000);
    assert.equal(result.droppedSteps, 1);
    assert.match(dropReasonFor(wire({ action: 'expectAnyVisible', value: 'text="x"' }) as never, false), /two or more selectors/);
  });

  it('counts as a substantive assertion, and every alternative is judged by the grounding lints', () => {
    const step: FlowStep = { action: 'expectAnyVisible', selectors: ['role=alert', 'role=combobox[name="Status (3)"]'] };
    assert.equal(vacuousClaim([step]), null);
    assert.deepEqual(selectorsOf(step), ['role=alert', 'role=combobox[name="Status (3)"]']);
    assert.equal(countPinnedName([step])?.name, 'Status (3)');
    assert.equal(ungroundedSelectorRole([step], 'alert "Saved"\nbutton "Status"')?.role, 'combobox');
    assert.equal(ungroundedTextExpectation([{ action: 'expectAnyVisible', selectors: ['text="Saved"', 'text="Nope"'] }], 'alert "Saved"')?.text, 'Nope');
    assert.equal(inventedControlInternals([{ action: 'expectAnyVisible', selectors: ['text="ok"', 'select:has(option)'] }])?.fragment, '<select>');
  });

  it('refuses a hedge on a single stated outcome and accepts it on a หรือ line', () => {
    const step: FlowStep = { action: 'expectAnyVisible', selectors: ['text="Completed"', 'role=alert'] };
    assert.equal(hedgedAlternatives([step], single), 0);
    assert.equal(hedgedAlternatives([step], eitherOr), null);
    assert.equal(hedgedAlternatives([step], describeCase(row({ caseId: 'HIR-EC-020', expected: '- กรณีสร้างสำเร็จ ค้นหาพนักงานด้วย Employee ID / กรณีปฏิเสธ ระบบแสดงข้อความ' }))), null);
  });

  it('the review audits each alternative and repoints the whole list', () => {
    const evidence: ReviewEvidence = { url: 'http://app.test/en/login', axTree: 'alert "Completed"\nheading "Payroll"', prompt: 'TC_PY_REC_010' };
    const steps: FlowStep[] = [{ action: 'expectAnyVisible', selectors: ['role=alert[name="Completed"]', 'role=heading[name="Payroll Results"]'] }];
    const findings = auditGrounding([], steps, evidence);
    assert.equal(findings.length, 1);
    assert.match(findings[0]!.reason, /Payroll Results/);
    const applied = applyReview(
      { decisions: [{ section: 'steps', index: 0, verdict: 'replace', selector: 'role=alert[name="Completed"]; role=heading[name="Payroll"]', url: '', goal: '', action: '', value: '', reasoning: 'the tree says Payroll', evidence: 'heading "Payroll"' }] },
      { findings, setup: [], steps, evidence },
    );
    assert.equal(applied.replaced, 1);
    assert.deepEqual((steps[0] as { selectors: string[] }).selectors, ['role=alert[name="Completed" i]', 'role=heading[name="Payroll" i]']);
  });
});

// ---------------------------------------------------------------- CG-09

describe('CG-09 — a [RECORD ONLY] line is observed, never asserted', () => {
  // HIR-EC-009's shape, verbatim lines.
  const mixed = describeCase(row({
    caseId: 'HIR-EC-009',
    steps: '1. Login ด้วย <HR_ADMIN_ACCOUNT>\n2. กรอกข้อมูล',
    expected: '3.1 ระบบแสดง Notice\n3.2 ข้อความ Notice ที่แน่นอน = ? OQ-HIR-140\n4. ระบบสร้าง Employee ID เป็นตัวเลข 8 หลัก',
    note: 'จุดที่ยังไม่มีคำตอบในเคสนี้ ให้รันจริงแล้วบันทึกค่าที่ระบบแสดงลงช่อง Actual Result Image',
  }));
  const wholly = describeCase(row({
    caseId: 'HIR-EC-060',
    steps: '1. Login ด้วย <HR_ADMIN_ACCOUNT>\n2. เปิดใบร่าง',
    expected: '- สถานะของใบร่าง = DRAFT โดยคำที่ระบบเก็บจริง = ? OQ-HIR-91\n- สูตร/เงื่อนไข Rule Table = ? OQ-HIR-13',
  }));

  it('expectedItemsIn skips the record-only line and counts a bare "4." line', () => {
    assert.deepEqual(expectedItemsIn(mixed), ['3.1', '4']);
    assert.deepEqual(recordOnlyLines(mixed).map((l) => l.no), ['3.2']);
    assert.deepEqual(unassertedExpectedItems([{ action: 'expectVisible', selector: 'text=Notice', intent: '3.1 and step 4' }], mixed), []);
  });

  it('refuses an assertion whose only cited line is record-only, weakly', () => {
    const hit = assertsRecordOnlyLine([{ action: 'expectText', selector: 'role=alert', value: 'something', intent: '3.2 — the notice text' }], mixed);
    assert.equal(hit?.line, '3.2');
    assert.equal(assertsRecordOnlyLine([{ action: 'expectVisible', selector: 'role=alert', intent: '3.1 / 3.2 — the notice' }], mixed), null, 'an assertable line cited beside it keeps the step');
    assert.equal(assertsRecordOnlyLine([{ action: 'saveText', selector: 'role=alert', as: 'record_3_2', intent: '3.2' }], mixed), null);
  });

  it('recognises a wholly record-only case, and the pipeline hands its observations over as review', async () => {
    assert.equal(recordOnlyCase(wholly), true);
    assert.equal(recordOnlyCase(mixed), false);
    const author = new FlowAuthor({
      model: stubModel({
        steps: [
          { action: 'click', selector: 'role=button[name="เปิดใบร่าง" i]', intent: 'Step 2: เปิดใบร่าง' },
          { action: 'saveText', selector: 'role=status', as: 'record_1', intent: 'record the draft status shown (OQ-HIR-91)' },
        ],
      }),
    });
    const authored = await author.author('HIR-EC-060', undefined, { caseText: wholly });
    assert.equal(authored.recordOnly, true);
    assert.equal(observationSteps(authored.flow.steps).length, 1);
    assert.match(authored.notes, /record-only case/);
    // The same body for a case WITH an oracle is still refused.
    const strict = new FlowAuthor({ model: stubModel({ steps: [{ action: 'saveText', selector: 'role=status', as: 'r' }] }), attempts: 1 });
    await assert.rejects(strict.author('HIR-EC-009', undefined, { caseText: mixed }), /contains no assertion/);
  });
});

// ---------------------------------------------------------------- CG-10 / CG-11

describe('CG-10 / CG-11 — rounds become labelled cases; the route is the first leg', () => {
  it('the catalog prompt carries the ROUNDS and MENU PATH rails in the table branch only', () => {
    const withCases = buildAuthoringPrompt([], { cases: ['HIR-EC-002: …'] });
    assert.match(withCases, /ROUNDS: when a case lists "Rounds \(N\):"/);
    assert.match(withCases, /"<caseId> รอบ k"/);
    assert.match(withCases, /a per-field loop is ONE case per field/);
    assert.match(withCases, /MENU PATH AND DESTINATION/);
    assert.match(withCases, /a collapsed group is expanded by clicking its header first/);
    const claimsOnly = buildAuthoringPrompt([{ claim: 'x', priority: 'high', source: 's', testable: true }]);
    assert.doesNotMatch(claimsOnly, /ROUNDS:/);
  });

  it('ignoresMenuPath — a Destination never visited, then honoured by a goto', () => {
    // PY, verbatim: the URL and tab live in Steps.
    const py = describeCase(row({ caseId: 'TC_SSO_001', steps: '1. Login เข้าระบบด้วย SPD Admin -> Navigate ไปที่ https://payroll-cnext-dev.central.co.th/admin/config/sso -> เลือกแท็บ "SSO Branch Registration"' }));
    assert.equal(ignoresMenuPath([{ action: 'expectVisible', selector: 'text="SSO"' }], py)?.kind, 'destination');
    assert.equal(ignoresMenuPath([{ action: 'goto', url: 'https://payroll-cnext-dev.central.co.th/admin/config/sso' }, { action: 'click', selector: 'role=tab[name="SSO Branch Registration" i]' }], py), null);
    assert.equal(ignoresMenuPath([{ action: 'goto', url: '/admin/config/sso' }], py), null, 'a relative goto to the same path counts');
  });

  it('ignoresMenuPath — a Menu path with no crumb clicked, then a crumb clicked or a workflow taking the leg', () => {
    const be = describeCase(row({ caseId: 'PL_01_01', menu: '1. HR\n2. Benefits Admin\n3. Benefit Plans' }));
    assert.equal(ignoresMenuPath([{ action: 'expectVisible', selector: 'text="Plans"' }], be)?.wanted, 'HR > Benefits Admin > Benefit Plans');
    assert.equal(ignoresMenuPath([{ action: 'click', selector: 'role=link[name="Benefits Admin" i]' }], be), null);
    assert.equal(ignoresMenuPath([{ action: 'workflow', goal: 'open HR > Benefits Admin' }], be), null);
    assert.equal(ignoresMenuPath([{ action: 'expectVisible', selector: 'text="x"' }], describeCase(row({ caseId: 'X', menu: 'N/A' }))), null);
  });

  it('the system prompt says the first leg is the menu path', async () => {
    const mock = jsonModel('mock-author', { name: 'x', rationale: '', setup: [], steps: [], teardown: [], notes: '' }, { inputTokens: 0, outputTokens: 0 });
    await new LlmFlowAuthorModel({ model: mock, id: 'mock:author' }).author({ prompt: 'p', policy: 'forms' });
    const sent = JSON.stringify((mock as unknown as { doGenerateCalls: unknown[] }).doGenerateCalls[0]).replace(/\\n/g, ' ').replace(/\s+/g, ' ');
    assert.match(sent, /THE FIRST LEG IS THE MENU PATH/);
    assert.match(sent, /TEST DATA ARRIVES ONE PAIR PER LINE/);
    assert.match(sent, /A DATE PHRASE IS LEFT AS WRITTEN/);
    assert.match(sent, /AN EXPECTED LINE MARKED \[RECORD ONLY\] IS OBSERVED, NEVER ASSERTED/);
    assert.match(sent, /AN OPTION SET IS CHECKED WITH THE LIST OPEN ONCE/);
    assert.match(sent, /A WAIT-UNTIL CLAIM DECLARES ITS WAIT/);
    assert.match(sent, /AN ERROR UNDER A FIELD IS expectFieldError ON THAT FIELD/);
    assert.match(sent, /EITHER\/OR IS ONE expectAnyVisible/);
  });
});

// ---------------------------------------------------------------- CG-14

describe('CG-14 — an option set\'s forbidden names are asserted absent', () => {
  // HIR-EC-027, verbatim.
  const text = describeCase(row({ caseId: 'HIR-EC-027', expected: '- dropdown Event Reason ไม่มี RE_REHIRE_GE1 และไม่มี RE_REHIRE_LT1' }));

  it('names the first forbidden option with no expectHidden, and is satisfied by one per name', () => {
    assert.equal(unassertedForbiddenOption([{ action: 'click', selector: 'role=button[name="Event Reason" i]' }], text)?.name, 'RE_REHIRE_GE1');
    const hidden: FlowStep[] = [
      { action: 'expectHidden', selector: 'role=option[name="RE_REHIRE_GE1" i]' },
      { action: 'expectHidden', selector: 'role=option[name="RE_REHIRE_LT1" i]' },
    ];
    assert.equal(unassertedForbiddenOption(hidden, text), null);
    assert.equal(unassertedForbiddenOption([], describeCase(row({ caseId: 'X', expected: '1.1 แสดงหน้า' }))), null);
  });
});

// ---------------------------------------------------------------- CG-15

describe('CG-15 — the lints cut the described row on the parser\'s own headings', () => {
  it('a Note saying "กด Submit" is no longer read as the script', () => {
    const readOnly = describeCase(row({ caseId: 'PL_01_01', steps: '1. ไปที่ HR > Benefits Admin\n2. ตรวจสอบว่าเมนู Benefit Plans แสดง', expected: '- เมนู Benefit Plans แสดง', note: 'เคสอื่นให้กด Submit ก่อน' }));
    assert.equal(skipsAuthoredScript(readOnly, [{ action: 'expectVisible', selector: 'text="Benefit Plans"' }]), null);
  });

  it('unperformedScriptSteps stops at the Expected block, and expectedItemsIn stops at an Option set heading', () => {
    const text = describeCase(row({
      caseId: 'HIR-EC-029',
      steps: '1. Login\n2. เปิด Event Reason\n3. ตรวจสอบตัวเลือก',
      expected: '1.1 dropdown แสดง 3 ค่า : Event Reason บนหน้า Key-in แสดงเฉพาะ New Hire / Replacement / Migration\n1.2 ไม่แสดง H_CORENTRY',
    }));
    const flow: FlowStep[] = [{ action: 'expectCount', selector: 'role=option', count: 3, intent: 'Step 3: 1.1 count' }];
    assert.equal(unperformedScriptSteps(text, flow), null, 'steps 1 and 2 come before the highest cited step');
    assert.deepEqual(expectedItemsIn(text), ['1.1', '1.2']);
  });
});

// ---------------------------------------------------------------- CG-19

describe('CG-19 — upload is authorable with a fixture spec', () => {
  it('narrows a spec into files[], drops a non-spec with the vocabulary named, and performs "กดแนบเอกสาร"', async () => {
    const result = await narrow([
      wire({ action: 'upload', selector: 'role=button[name="Attach" i]', value: 'pdf:medical-certificate' }),
      wire({ action: 'upload', selector: 'role=button[name="Import" i]', value: 'csv:benefit-plans@template!blank=Country' }),
      wire({ action: 'upload', selector: 'role=button[name="Attach" i]', value: '/tmp/some-file.pdf' }),
    ]);
    assert.deepEqual(result.steps.map((s) => (s as { files?: string[] }).files), [['pdf:medical-certificate'], ['csv:benefit-plans@template!blank=Country']]);
    assert.equal(result.droppedSteps, 1);
    assert.match(result.dropped?.[0]?.reason ?? '', /kind:name\[@template\]\[!mutation\]/);
    // TM ML_01_*: "7. กดแนบเอกสาร (Attach)" is input, and an upload performs it.
    const text = describeCase(row({ caseId: 'ML_01_03', steps: '7. กดแนบเอกสาร (Attach)\n8. กด Submit', expected: '8.1 ระบบบันทึก' }));
    assert.equal(skipsAuthoredScript(text, [{ action: 'upload', selector: 'role=button[name="Attach" i]', files: ['pdf:medical-certificate'] }]), null);
    assert.ok(skipsAuthoredScript(text, [{ action: 'expectVisible', selector: 'text="Attach"' }]) !== null);
  });
});

// ---------------------------------------------------------------- EH-07

describe('EH-07 — a wait-until claim declares its wait', () => {
  it('narrows timeoutMs as digits, capped, on the waitable steps only', async () => {
    const result = await narrow([
      wire({ action: 'expectText', selector: 'role=status', value: 'Complete', timeoutMs: '300000' }),
      wire({ action: 'expectHidden', selector: 'role=alert', timeoutMs: '9000000' }),
      wire({ action: 'waitFor', selector: 'role=cell[name="Completed"]', timeoutMs: '5 minutes' }),
      wire({ action: 'fill', selector: 'role=textbox[name="x"]', value: 'v', timeoutMs: '1000' }),
      wire({ action: 'expectModal', name: 'Confirm', timeoutMs: '15000' }),
    ]);
    assert.deepEqual(result.steps.map((s) => (s as { timeoutMs?: number }).timeoutMs), [300000, MAX_STEP_TIMEOUT_MS, undefined, undefined, 15000]);
    assert.equal('timeoutMs' in result.steps[3]!, false, 'never written as undefined onto a fill');
  });

  it('refuses a "สถานะเปลี่ยนเป็น Complete" claim with no declared wait, weakly, and accepts one with', () => {
    const py = describeCase(row({ caseId: 'TC_PY_REC_001', expected: '2. ตรวจสอบ ระบบประมวลผลสำเร็จ สถานะเปลี่ยนเป็น Complete ไม่มี error ค้าง' }));
    assert.match(unbudgetedStatusWait([{ action: 'expectText', selector: 'role=status', value: 'Complete' }], py) ?? '', /ประมวลผลสำเร็จ|สถานะเปลี่ยนเป็น/);
    assert.equal(unbudgetedStatusWait([{ action: 'expectText', selector: 'role=status', value: 'Complete', timeoutMs: 300000 }], py), null);
    const imp = describeCase(row({ caseId: 'PL_10_24', expected: '4.1 ตาราง Import Job Monitor มีรายการ Job ใหม่เพิ่มขึ้น พร้อม Number, Filename, Status = Completed' }));
    assert.ok(unbudgetedStatusWait([], imp) !== null);
    assert.equal(unbudgetedStatusWait([], describeCase(row({ caseId: 'X', expected: '1.1 แสดงหัวข้อ "Upload"' }))), null);
  });
});

// ---------------------------------------------------------------- EH-12

describe('EH-12 — an error under a field is expectFieldError on that field', () => {
  it('narrows with and without the quoted message, and needs a selector', async () => {
    const result = await narrow([
      wire({ action: 'expectFieldError', selector: 'role=textbox[name="Effective Start Date" i]', value: 'Effective start date must not be greater than effective end date.' }),
      wire({ action: 'expectFieldError', selector: 'role=textbox[name="Country" i]' }),
      wire({ action: 'expectFieldError' }),
    ]);
    assert.deepEqual(result.steps.map((s) => (s as { value?: string }).value), ['Effective start date must not be greater than effective end date.', undefined]);
    assert.equal('value' in result.steps[1]!, false);
    assert.equal(result.droppedSteps, 1);
    assert.equal(vacuousClaim(result.steps), null);
  });

  it('refuses the field-scoped claims proved page-wide, weakly, in the sheet\'s wordings', () => {
    const be = describeCase(row({ caseId: 'PL_06_10', expected: '6.1 ระบบแสดง Error message "Effective start date must not be greater than effective end date." ด้านล่าง Field Effective Start Date' }));
    const py = describeCase(row({ caseId: 'TC_SSO_009', expected: '3.1 ระบบต้อง error ใต้ช่องนั้นทันทีเมื่อกด Save ทุกช่องที่ปล่อยว่าง' }));
    const ec = describeCase(row({ caseId: 'HIR-EC-049', expected: '5.1 ระบบแสดงข้อความที่ช่อง Personal Grade' }));
    const pageWide: FlowStep[] = [{ action: 'expectText', selector: 'body', value: 'must not be greater' }];
    for (const text of [be, py, ec]) assert.ok(fieldErrorAssertedPageWide(pageWide, text) !== null, text.slice(0, 20));
    assert.equal(fieldErrorAssertedPageWide([{ action: 'expectFieldError', selector: 'role=textbox[name="Effective Start Date" i]', value: 'x' }], be), null);
    assert.equal(fieldErrorAssertedPageWide(pageWide, describeCase(row({ caseId: 'X', expected: '1.1 ระบบแสดง Error message "Failed to save changes."' }))), null, 'a message with no field named is a page-wide claim');
  });
});

// ---------------------------------------------------------------- risk + diagnosis

describe('the risk judge and the diagnosis read the new shapes', () => {
  it('a sheet-blocked row is a dead-end signal, and an either/or step\'s alternatives are scanned', () => {
    const request: RiskRequest = {
      caseName: 'PL_10_24', caseText: 'Steps: import; Expected: Status = Completed',
      flow: { name: 'PL_10_24', steps: [{ action: 'expectAnyVisible', selectors: ['text="Completed"', 'role=alert[name="Quota exceeded"]'] }] },
      documents: [], repository: '', declaredRoutes: [], backend: true, knownResult: 'blocked',
    };
    const signals = riskSignals(request);
    assert.ok(signals.some((s) => /BLOCKED/.test(s)));
    assert.ok(signals.some((s) => /"Quota exceeded"/.test(s)));
  });

  it('a persona the run lacks is an environment signal, not a case defect', () => {
    const bundle = {
      runId: 'r', name: 'PRB-EC-001', status: 'error', startedAt: '', finishedAt: '', durationMs: 1, cdpUrl: null, cachePath: null, healerModel: null,
      summary: { totalSteps: 1, passed: 0, failed: 1 }, defects: [], error: 'run completed with 1 error',
      steps: [{ index: 1, action: 'signIn', status: 'error', error: 'persona "HRBP_ACCOUNT" has no credentials (pass --persona HRBP_ACCOUNT=email:password)', durationMs: 1 } as unknown as ProofStep],
    } as unknown as ProofBundle;
    const signals = diagnosisSignals({ caseName: 'PRB-EC-001', caseText: 'x', bundle, declaredRoutes: [] });
    assert.ok(signals.some((s) => /points at environment/.test(s) && /persona/.test(s)));
  });
});
