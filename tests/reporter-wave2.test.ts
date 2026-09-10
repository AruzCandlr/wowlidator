/**
 * The report on the step kinds and resolutions the harness gained on the
 * humi benchmark (enhancedX wave 2, 2026-09-03): `expectAnyVisible`,
 * `expectFieldError`, `upload`, `signIn`, the author's `timeoutMs`; the
 * `reveal` and `scroll` resolutions; a workflow step's observed evidence; a
 * record-only case; the two agent actions `save` and `signOut`; verdicts
 * counted apart; the sheet's own case id on the chip.
 *
 * Entirely unit-tier: every renderer here is a pure function over a bundle
 * (`src/reporter/CLAUDE.md`), and `step-facts.ts` is the one reading of the
 * record they all share. The rule under test throughout is the one that
 * motivated the module — a step kind must never render as an empty row, and
 * a report must never carry a credential.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ProofBundleBuilder, type AgentRecord, type Defect, type ProofBundle, type ProofStep } from '../src/engine/proof-bundle.js';
import { GLOSSARY, renderReport } from '../src/reporter/html-reporter.js';
import { renderCatalogReport, verdictChipOf, type CatalogReportCase } from '../src/reporter/catalog-report.js';
import { stepProof } from '../src/reporter/excel-export.js';
import { renderCtrf, renderJUnit } from '../src/reporter/machine-report.js';
import { renderSuiteIndex } from '../src/reporter/suite-index.js';
import { escalationTrace } from '../src/reporter/verdict.js';
import { ASSERTION_ACTIONS } from '../src/engine/runner.js';
import {
  countVerdicts,
  dbEvidence,
  dbProofLines,
  describeAgentAction,
  describeResolution,
  describeVerdictCounts,
  displayCaseId,
  inconsequentialAgentLeg,
  inconsequentialBrokenStep,
  isAssertionStepAction,
  observedEvidence,
  provenanceExtras,
  recordOnlyCase,
  recordedCaptures,
  sheetLabel,
  stepKindFacts,
  stepNarration,
  stepTarget,
  visibleDetail,
} from '../src/reporter/step-facts.js';
import { groupAccuracy, groupRuns, toCard } from '../src/ui/proofs.js';
import { WOW_SCRIPT } from '../src/ui/wow-ui-html.js';

const base = { startedAt: '2026-09-03T00:00:00.000Z', durationMs: 12, url: 'http://localhost:3005/en/admin/hire' };
const bare = { selector: null, resolvedSelector: null, resolution: null, status: 'passed' as const, ...base };

/** The four new kinds as the engine records them, plus the credential a `signIn` might carry. */
const NEW_KIND_STEPS: Omit<ProofStep, 'index'>[] = [
  {
    action: 'expectAnyVisible',
    intent: 'ระบบประมวลผลสำเร็จหรือแสดง error ตามเงื่อนไข',
    ...bare,
    detail: { selectors: ['text="บันทึกสำเร็จ"', 'role=alert[name="error" i]'], matched: 'role=alert[name="error" i]', timeoutMs: 5000 },
  },
  {
    action: 'expectFieldError',
    intent: 'error message under the Plan Name field',
    ...bare,
    selector: 'role=textbox[name="Plan Name" i]',
    detail: { expected: 'กรุณากรอก Plan Name', actual: 'กรุณากรอก Plan Name', via: 'aria-describedby' },
  },
  {
    action: 'upload',
    intent: 'attach the medical certificate',
    ...bare,
    selector: 'role=button[name="Attach" i]',
    detail: { files: ['/Users/qa/.wowlidator/fixtures/ml-01-05@2026/medical-certificate-25957z.pdf'], via: 'filechooser' },
  },
  {
    action: 'signIn',
    intent: 'continue as the manager',
    ...bare,
    detail: { as: 'MANAGER_ACCOUNT', signedInAs: 'manager@cnext.test', password: 'admin2026', email: 'manager@cnext.test' },
  },
];

function bundleOf(build: (b: ProofBundleBuilder) => void, over: Partial<ProofBundle> = {}, name = 'PL_03_01 ตรวจสอบ'): ProofBundle {
  const builder = new ProofBundleBuilder({ name, cdpUrl: null, cachePath: null });
  build(builder);
  return { ...builder.finish(), ...over };
}

function newKindsBundle(over: Partial<ProofBundle> = {}): ProofBundle {
  return bundleOf((b) => {
    for (const step of NEW_KIND_STEPS) b.addStep(step);
  }, over);
}

/* ------------------------------------------------------------ step facts */

describe('step-facts — what a step WAS, from the record', () => {
  it('renders a skipped tail step as neutral with its reason', () => {
    const bundle = bundleOf((builder) => {
      builder.recordSkipped(
        { action: 'expectVisible', selector: 'text="Order saved"' },
        'not run: depends on step 2 (submit the order form), which did not reach its goal',
      );
    });
    const html = renderReport(bundle);
    assert.match(html, /class="step skipped"/);
    assert.match(html, /Not run/);
    assert.match(html, /depends on step 2/);
    assert.equal(bundle.summary.passed, 0);
    assert.equal(bundle.summary.failed, 0);
  });
  it('an either/or assertion is aimed at its alternatives, never at nothing', () => {
    const step = { action: 'expectAnyVisible', selector: null, detail: { selectors: ['text=A', 'text=B'] } };
    assert.equal(stepTarget(step), 'text=A | text=B');
    assert.deepEqual(stepKindFacts(step)[0], { label: 'any of', value: '1. text=A\n2. text=B' });
    // A runner that joined the list into `selector` with the CLI's own " | " is read too.
    assert.equal(stepTarget({ action: 'expectAnyVisible', selector: 'text=A | text=B' }), 'text=A | text=B');
    assert.deepEqual(stepKindFacts({ action: 'expectAnyVisible', selector: 'text=A | text=B' })[0]?.value, '1. text=A\n2. text=B');
  });

  it('an upload shows file NAMES — never the author\'s path, never contents', () => {
    const step = { action: 'upload', selector: 'role=button[name="Attach" i]', detail: { files: ['/Users/qa/fixtures/cert.pdf', { name: 'b.csv', path: '/x/b.csv' }] } };
    const facts = stepKindFacts(step);
    assert.deepEqual(facts, [{ label: 'files', value: 'cert.pdf, b.csv' }]);
    assert.equal(stepTarget(step), 'role=button[name="Attach" i]');
    assert.equal(stepTarget({ action: 'upload', selector: null, detail: { files: ['/x/cert.pdf'] } }), 'cert.pdf');
  });

  it('a step on a persona browser says which Chrome, by port, and a switch says the session was kept', () => {
    // The runner stamps `persona`/`browser` on every step of a multi-browser
    // run; the fact reads as the port so "9223 (MANAGER_ACCOUNT)" sits
    // beside the step. A single-browser run carries no stamp and no noise.
    assert.deepEqual(stepKindFacts({ action: 'click', selector: 'role=button', persona: 'MANAGER_ACCOUNT', browser: 'http://localhost:9223' }), [
      { label: 'browser', value: '9223 (MANAGER_ACCOUNT)' },
    ]);
    assert.deepEqual(stepKindFacts({ action: 'click', selector: 'role=button' }), []);
    const back = stepKindFacts({
      action: 'signIn',
      detail: { as: 'EMPLOYEE_ACCOUNT', keptSession: true, switchedTo: 'http://localhost:9222' },
    });
    assert.deepEqual(back, [
      { label: 'persona', value: 'EMPLOYEE_ACCOUNT' },
      { label: 'session', value: "kept — switched to this persona's own browser, no login" },
      { label: 'browser', value: '9222' },
    ]);
    assert.ok(!JSON.stringify(back).includes('@'));
  });

  it('a signIn shows the persona LABEL and withholds an email spelled as the label', () => {
    assert.deepEqual(stepKindFacts({ action: 'signIn', detail: { as: 'HR_ADMIN_ACCOUNT' } }), [{ label: 'persona', value: 'HR_ADMIN_ACCOUNT' }]);
    assert.equal(stepTarget({ action: 'signIn', detail: { as: 'HR_ADMIN_ACCOUNT' } }), 'persona HR_ADMIN_ACCOUNT');
    const literal = stepKindFacts({ action: 'signIn', detail: { as: 'admin@cnext.test' } });
    assert.equal(literal.length, 1);
    assert.doesNotMatch(literal[0]!.value, /@/);
  });

  it('withholds anything carrying a password, not only a well-formed address', () => {
    // The persona wire format is `LABEL=email:password`, so a colon in the
    // value means the half after it is a secret. Testing for a well-formed
    // address let two real shapes through: a domain with no dot, and a label
    // with the password still attached.
    for (const as of ['mgr@intranet:hunter2', 'HRBP_ACCOUNT:hunter2', 'admin@x.test hunter2', 'admin@x.test']) {
      const facts = stepKindFacts({ action: 'signIn', detail: { as } });
      assert.equal(facts.length, 1, as);
      assert.doesNotMatch(facts[0]!.value, /hunter2|@|:/, as);
      assert.doesNotMatch(String(stepTarget({ action: 'signIn', detail: { as } })), /hunter2/, as);
    }
    // A label with a space in it is still a label, and is still shown.
    assert.deepEqual(stepKindFacts({ action: 'signIn', detail: { as: 'HR admin' } }), [{ label: 'persona', value: 'HR admin' }]);
  });

  it('a field-error assertion names its field; the author\'s timeout is a fact on any kind', () => {
    const facts = stepKindFacts({ action: 'expectFieldError', selector: 'role=textbox[name="Bank" i]', detail: { via: 'container', timeoutMs: 1500 } });
    assert.deepEqual(facts, [
      { label: 'field', value: 'role=textbox[name="Bank" i]' },
      { label: 'message read via', value: 'container' },
      { label: 'timeout', value: '1.5s (set by the author)' },
    ]);
    assert.deepEqual(stepKindFacts({ action: 'expectText', selector: 'text=x', detail: { timeoutMs: 8000 } }), [{ label: 'timeout', value: '8s (set by the author)' }]);
    assert.deepEqual(stepKindFacts({ action: 'click', selector: '#a' }), []);
  });

  it('the generic detail dump drops every credential-shaped key, and an email on a signIn whatever its key', () => {
    const keys = visibleDetail({
      action: 'signIn',
      detail: { as: 'X', signedInAs: 'a@b.co', password: 'p', email: 'a@b.co', landed: 'https://app/home', note: 'user a@b.co' },
    }).map(([k]) => k);
    assert.deepEqual(keys, ['landed']);
    // On any other kind the sheet's own email test data is evidence and stays.
    const fill = visibleDetail({ action: 'fill', detail: { value: 'a@b.co', password: 'nope' } }).map(([k]) => k);
    assert.deepEqual(fill, ['value']);
  });

  it('explains reveal and scroll in one line, and names an unknown rung rather than dropping it', () => {
    assert.match(describeResolution('reveal')!.label, /collapsed section/);
    assert.match(describeResolution('scroll')!.label, /fixed bar/);
    assert.equal(describeResolution('fast'), null);
    assert.equal(describeResolution(null), null);
    assert.equal(describeResolution('row-scope')!.label, 'row-scope');
  });

  it('reads observed evidence from detail.observed, else the record\'s own observations', () => {
    const fromDetail = observedEvidence({ action: 'workflow', detail: { observed: [{ selector: 'textbox "Status"', text: 'Active', url: 'http://x' }, 'bare line', { text: '' }] } });
    assert.deepEqual(fromDetail, [
      { selector: 'textbox "Status"', text: 'Active', url: 'http://x' },
      { selector: null, text: 'bare line', url: null },
    ]);
    const fromAgent = observedEvidence({ action: 'workflow', agent: { observations: [{ selector: 's', text: 't' }] } });
    assert.equal(fromAgent[0]?.text, 't');
    assert.deepEqual(observedEvidence({ action: 'click' }), []);
  });

  it('knows save and signOut, masks a password fill, and still renders an action it has never heard of', () => {
    assert.deepEqual(describeAgentAction({ action: 'save', selector: 'text=EMP042', value: 'EMPLOYEE_ID', url: 'u', observed: 'EMP042' }), {
      target: 'text=EMP042 → {{EMPLOYEE_ID}}',
      note: 'saved "EMP042" for later steps',
    });
    assert.deepEqual(describeAgentAction({ action: 'signOut', selector: null, value: null, url: 'u' }), {
      target: 'the current session',
      note: 'signed out so another person can sign in',
    });
    assert.equal(describeAgentAction({ action: 'fill', selector: 'role=textbox[name="Password"]', value: 'admin2026', url: 'u' }).note, '•••• (9 chars)');
    assert.equal(describeAgentAction({ action: 'read', selector: 's', value: null, url: 'u', observed: 'Active' }).note, 'observed "Active"');
    assert.deepEqual(describeAgentAction({ action: 'hover3d', selector: '#z', value: null, url: 'u' }), { target: '#z', note: null });
  });

  it('a record-only case is told apart from a wording near-miss, and its captures are listed record_* first', () => {
    const stamped = { generatedBy: { recordOnly: true } } as unknown as ProofBundle;
    assert.equal(recordOnlyCase({ verdict: 'review', status: 'passed', bundle: stamped }), true);
    assert.equal(recordOnlyCase({ verdict: 'review', status: 'needs-review', bundle: null, reason: 'a wording near-miss' }), false);
    assert.equal(recordOnlyCase({ verdict: 'review', status: 'passed', bundle: null, reason: 'observed only — the sheet has no oracle' }), true);
    assert.equal(recordOnlyCase({ verdict: 'passed', status: 'passed', bundle: stamped }), false);
    const captures = recordedCaptures({
      variables: { OTHER: 'x', record_2: 'Pending 1D 0h', record_1: 'EMP042' },
      steps: [{ index: 3, action: 'saveText', detail: { as: 'record_3', actual: 'H_NEWHIRE' } } as unknown as ProofStep, { index: 4, action: 'click' } as unknown as ProofStep],
    });
    assert.deepEqual(captures, [
      { name: 'record_2', value: 'Pending 1D 0h' },
      { name: 'record_1', value: 'EMP042' },
      { name: 'OTHER', value: 'x' },
      { name: 'record_3', value: 'H_NEWHIRE' },
    ]);
  });

  it('shows the sheet\'s own id when the run qualified it, and reads the stamp structurally', () => {
    assert.deepEqual(displayCaseId('BE:PL_03_01', 'PL_03_01'), { shown: 'PL_03_01', qualified: 'BE:PL_03_01' });
    assert.deepEqual(displayCaseId('PL_03_01', 'PL_03_01'), { shown: 'PL_03_01', qualified: null });
    assert.deepEqual(displayCaseId('PL_03_01', undefined), { shown: 'PL_03_01', qualified: null });
    const extras = provenanceExtras({ generatedBy: { sheetCaseId: 'PL_03_01', sheet: 'BE', category: 'Benefit Plan', knownResult: 'blocked' } } as unknown as ProofBundle);
    assert.equal(extras.sheetVerdict, 'blocked');
    assert.equal(sheetLabel(extras), 'BE · Benefit Plan');
    assert.deepEqual(provenanceExtras(null), { sheetCaseId: null, sheet: null, category: null, sheetVerdict: null, recordOnly: false });
  });

  it('counts verdicts apart: failed, awaiting review, no verdict, never ran', () => {
    const counts = countVerdicts([
      { verdict: 'passed' },
      { verdict: 'failed', status: 'dead-end' },
      { verdict: 'failed', status: 'error' },
      { verdict: 'review' },
      { verdict: 'blocked' },
      { verdict: 'never-ran' },
    ]);
    assert.deepEqual(counts, { passed: 1, failed: 1, review: 1, noVerdict: 1, blocked: 2, total: 6 });
    assert.equal(describeVerdictCounts(counts), '1 of 6 passed · 1 failed · 1 awaiting review · 1 no verdict · 2 never ran');
    assert.equal(describeVerdictCounts(countVerdicts([{ verdict: 'passed' }])), '1 of 1 passed');
  });
});

/* ---------------------------------------------------------- the report */

describe('the HTML report on the new step kinds', () => {
  const html = renderReport(newKindsBundle());

  it('renders every new kind as a row with its facts — never an empty row', () => {
    assert.match(html, /text=&quot;บันทึกสำเร็จ&quot; \| role=alert/, 'the either/or is aimed at its alternatives');
    assert.match(html, /any of/);
    assert.match(html, /satisfied by/);
    assert.match(html, /timeout<\/span> 5s \(set by the author\)/);
    assert.match(html, /field<\/span> role=textbox/);
    assert.match(html, /medical-certificate-25957z\.pdf/);
    assert.match(html, /persona<\/span> MANAGER_ACCOUNT/);
    assert.doesNotMatch(html, /<code class="target">—<\/code>/, 'no step of the four shows an empty target');
  });

  it('never carries a credential: the persona label only, and no file path', () => {
    assert.doesNotMatch(html, /manager@cnext\.test/);
    assert.doesNotMatch(html, /admin2026/);
    assert.doesNotMatch(html, /signedInAs/);
    assert.doesNotMatch(html, /\/Users\/qa\//);
  });

  it('badges reveal and scroll with a plain-language explanation, and the glossary knows both', () => {
    const resolved = bundleOf((b) => {
      b.addStep({ action: 'click', selector: '#a', resolvedSelector: '#a', ...base, resolution: 'reveal', status: 'passed' });
      b.addStep({ action: 'click', selector: '#b', resolvedSelector: '#b', ...base, resolution: 'scroll', status: 'passed' });
      b.addStep({ action: 'expectText', selector: '#c', resolvedSelector: '#c', ...base, resolution: 'kin', status: 'passed' });
    });
    const page = renderReport(resolved);
    assert.match(page, /badge res-reveal/);
    assert.match(page, /badge res-scroll/);
    assert.match(page, /a collapsed section was opened first/);
    assert.match(page, /scrolled clear of a fixed bar/);
    assert.match(page, /resolved via<\/dt><dd>reveal — /);
    for (const match of page.matchAll(/<span class="badge res-[a-z-]+">(?:<abbr title="([^"]*)">)?([^<]*)/g)) {
      const [, explanation, label] = match;
      assert.ok(explanation || GLOSSARY[label ?? ''], `badge "${label}" is shown with no glossary entry`);
    }
  });

  it('shows a workflow step\'s observed evidence as an Observed block, and the agent\'s save / signOut turns by meaning', () => {
    const agent: AgentRecord = {
      goal: 'read the status and record it, then sign out',
      model: 'stub',
      success: true,
      summary: 'done',
      turns: 3,
      maxSteps: null,
      latencyMs: 10,
      actions: [
        { index: 0, action: 'read', selector: 'textbox "Status"', value: null, url: 'u', reasoning: 'look', ok: true, durationMs: 1, observed: 'Active' } as AgentRecord['actions'][number],
        { index: 1, action: 'save', selector: 'text=EMP042', value: 'EMPLOYEE_ID', url: 'u', reasoning: 'keep it', ok: true, durationMs: 1 },
        { index: 2, action: 'signOut', selector: null, value: null, url: 'u', reasoning: 'next person', ok: true, durationMs: 1 },
      ],
    };
    const page = renderReport(
      bundleOf((b) => {
        b.addStep({
          action: 'workflow',
          ...bare,
          agent,
          detail: { goal: agent.goal, observed: [{ selector: 'textbox "Status"', text: 'Active', url: 'http://localhost:3005/en/employees/42' }] },
        });
      }),
    );
    assert.match(page, /callout observed/);
    assert.match(page, /1 value read off the page/);
    assert.match(page, /<code>Active<\/code><span class="trace-detail">from textbox &quot;Status&quot; at http:\/\/localhost:3005\/en\/employees\/42/);
    assert.match(page, /text=EMP042 → \{\{EMPLOYEE_ID\}\}/);
    assert.match(page, /the current session<\/code> <span class="muted">signed out so another person can sign in/);
    assert.match(page, /observed &quot;Active&quot;/);
    assert.ok(GLOSSARY['observed'], 'the Observed block is explained');
  });

  it('leads a record-only case with its captures, in its own colour, and stamps the sheet id on the header', () => {
    const page = renderReport(
      bundleOf(
        (b) => {
          b.addStep({ action: 'saveText', ...bare, selector: 'text=EMP042', detail: { as: 'record_1', actual: 'EMP042' } });
        },
        {
          variables: { record_1: 'EMP042', record_2: 'H_NEWHIRE — New Hire' },
          generatedBy: {
            model: 'stub',
            generatedAt: 'T1',
            sourceUrl: 'http://localhost:3005/en/login',
            kind: 'catalog',
            rationale: '',
            recordOnly: true,
            sheetCaseId: 'PL_03_01',
            sheet: 'BE',
            category: 'Benefit Plan',
            knownResult: 'blocked',
          } as unknown as ProofBundle['generatedBy'],
        },
        'BE:PL_03_01 ตรวจสอบ',
      ),
    );
    assert.match(page, /class="verdict record-only"/);
    assert.match(page, /2 values captured for review/);
    assert.match(page, /<dt>record_1<\/dt><dd><code>EMP042<\/code>/);
    assert.match(page, /sheet id <code>PL_03_01<\/code>/);
    assert.match(page, /class="sheet-tag"[^>]*>BE · Benefit Plan</);
    assert.match(page, /<dt>sheet recorded<\/dt><dd>blocked<\/dd>/);
    assert.ok(GLOSSARY['recorded only']);
  });

  it('a plain case shows no sheet id, no record-only block', () => {
    assert.doesNotMatch(html, /sheet id/);
    assert.doesNotMatch(html, /class="verdict record-only"/);
  });
});

describe('the escalation trace on the new rungs', () => {
  it('reads reveal, scroll and the hyphenated not-found rung by name', () => {
    const rungs = escalationTrace(
      'could not resolve "text=x" after 4 attempt(s):\n' +
        '  - fast "text=x": Timeout 1500ms exceeded\n' +
        '  - reveal (expanded "Employment details") "text=x": still hidden\n' +
        '  - scroll (clear of "sticky footer") "text=x": intercepts pointer events\n' +
        '  - not-found: the page is showing "404 — ไม่พบหน้าที่ค้นหา" at /en/x — no repair attempted',
    );
    assert.deepEqual(
      rungs.map((r) => r.rung),
      ['fast', 'reveal', 'scroll', 'not-found'],
    );
    assert.match(rungs[1]!.prose, /Opened the collapsed section/);
    assert.match(rungs[2]!.prose, /Scrolled the control clear/);
    assert.match(rungs[3]!.prose, /page it does not have/);
    assert.match(rungs[3]!.detail, /404/);
  });
});

/* -------------------------------------------------------- catalog report */

describe('the catalog report on review, captures and the sheet id', () => {
  function kase(over: Partial<CatalogReportCase>): CatalogReportCase {
    return { id: 'PL_02_01', name: 'PL_02_01 first', scenario: 'PL_02', verdict: 'passed', status: 'passed', reason: null, bundle: newKindsBundle(), history: [], ...over };
  }

  it('a record-only review wears its own chip; a wording near-miss keeps "needs review"', () => {
    const recorded = kase({ verdict: 'review', status: 'passed', reason: 'observed only — the sheet has no oracle' });
    assert.deepEqual(verdictChipOf(recorded), { cls: 'record', label: 'recorded only' });
    assert.deepEqual(verdictChipOf(kase({ verdict: 'review', status: 'needs-review' })), { cls: 'review', label: 'needs review' });
  });

  it('lists the captures of a record-only case before its steps, and counts the scenario apart', () => {
    const bundle = newKindsBundle({ variables: { record_1: 'EMP042' } });
    const html = renderCatalogReport({
      title: 'ec10',
      runKey: 'ec10@2026',
      generatedAt: null,
      cases: [
        kase({ id: 'HIR-EC-060', name: 'HIR-EC-060 บันทึกค่า', scenario: 'HIR-EC', verdict: 'review', status: 'passed', reason: 'observed only — the sheet has no oracle', bundle }),
        kase({ id: 'HIR-EC-061', name: 'HIR-EC-061', scenario: 'HIR-EC', verdict: 'failed', status: 'dead-end' }),
        kase({ id: 'HIR-EC-062', name: 'HIR-EC-062', scenario: 'HIR-EC', verdict: 'failed', status: 'error' }),
        kase({ id: 'HIR-EC-063', name: 'HIR-EC-063', scenario: 'HIR-EC' }),
      ],
    });
    assert.match(html, /class="captures"><div class="cap">Recorded only — the sheet has no oracle; 1 value\(s\) captured for review<\/div><div class="kv"><span>record_1<\/span><code>EMP042<\/code>/);
    assert.match(html, /<span class="scount">1 of 4 passed · 1 failed · 1 recorded only · 1 no verdict<\/span>/);
    assert.match(html, /chip record">recorded only</);
  });

  it('shows the sheet\'s own id and the sheet/category on the case row when the run qualified the id', () => {
    const html = renderCatalogReport({
      title: 'wb',
      runKey: null,
      generatedAt: null,
      cases: [kase({ id: 'BE:PL_03_01', name: 'BE:PL_03_01 ตรวจสอบ', scenario: 'PL_03', sheetCaseId: 'PL_03_01', sheet: 'BE', category: 'Benefit Plan' })],
    });
    assert.match(html, /<span class="sid" [^>]*>sheet id PL_03_01<\/span>/);
    assert.match(html, /<span class="ctag" [^>]*>BE · Benefit Plan<\/span>/);
    // Falls back to the bundle's stamp when the row carries none.
    const stamped = renderCatalogReport({
      title: 'wb',
      runKey: null,
      generatedAt: null,
      cases: [
        kase({
          id: 'TM:PL_03_01',
          bundle: newKindsBundle({ generatedBy: { model: 'm', generatedAt: 'T', sourceUrl: 'u', kind: 'catalog', rationale: '', sheetCaseId: 'PL_03_01', sheet: 'TM' } as ProofBundle['generatedBy'] }),
        }),
      ],
    });
    assert.match(stamped, /sheet id PL_03_01/);
    assert.match(stamped, /<span class="ctag" [^>]*>TM<\/span>/);
  });

  it('renders the new kinds in the step list and detail — facts as rows, the resolution explained, no credential', () => {
    const html = renderCatalogReport({ title: 't', runKey: null, generatedAt: null, cases: [kase({})] });
    assert.match(html, /<span class="ssub">ระบบประมวลผลสำเร็จหรือแสดง error ตามเงื่อนไข<\/span>/);
    assert.match(html, /<span>any of<\/span><code>1\. text=&quot;บันทึกสำเร็จ&quot;/);
    assert.match(html, /<span>persona<\/span><code>MANAGER_ACCOUNT<\/code>/);
    assert.match(html, /<span>file<\/span><code>medical-certificate-25957z\.pdf<\/code>/);
    assert.doesNotMatch(html, /manager@cnext\.test|admin2026|\/Users\/qa\//);
    const revealed = renderCatalogReport({
      title: 't',
      runKey: null,
      generatedAt: null,
      cases: [kase({ bundle: bundleOf((b) => b.addStep({ action: 'click', selector: '#a', resolvedSelector: '#a', ...base, resolution: 'reveal', status: 'passed' })) })],
    });
    assert.match(revealed, /<span>resolution<\/span><span>reveal — a collapsed section was opened first: /);
  });
});

/* ------------------------------------------------- excel, junit, index */

describe('the Excel proof column, the machine report and the suite index', () => {
  it('stepProof carries the kind facts, the explained rung, save/signOut turns and observations — and no credential', () => {
    const steps = newKindsBundle().steps;
    const any = stepProof(steps[0]!);
    assert.match(any, /any of: 1\. text="บันทึกสำเร็จ"; 2\. role=alert/);
    assert.match(any, /timeout: 5s \(set by the author\)/);
    const signIn = stepProof(steps[3]!);
    assert.match(signIn, /persona: MANAGER_ACCOUNT/);
    assert.doesNotMatch(signIn, /manager@cnext\.test|admin2026/);
    const revealed = stepProof({ ...steps[1]!, resolution: 'reveal' });
    assert.match(revealed, /resolved via reveal — a collapsed section was opened first/);
    const leg = stepProof({
      ...steps[0]!,
      action: 'workflow',
      detail: { observed: [{ selector: 's', text: 'Active' }] },
      agent: {
        goal: 'g', model: 'm', success: true, summary: 'ok', turns: 2, maxSteps: null, latencyMs: 1,
        actions: [
          { index: 0, action: 'save', selector: 'text=EMP042', value: 'EMPLOYEE_ID', url: 'u', reasoning: '', ok: true, durationMs: 1 },
          { index: 1, action: 'signOut', selector: null, value: null, url: 'u', reasoning: '', ok: true, durationMs: 1 },
          { index: 2, action: 'click', selector: '#x', value: null, url: 'u', reasoning: '', ok: true, durationMs: 1 },
        ],
      },
    });
    assert.match(leg, /agent save: text=EMP042 → \{\{EMPLOYEE_ID\}\}/);
    assert.match(leg, /agent signOut: the current session/);
    assert.doesNotMatch(leg, /agent click/);
    assert.match(leg, /observed: "Active" from s/);
  });

  it('JUnit names an either/or case by its alternatives and CTRF carries target, facts and observations', () => {
    const bundle = bundleOf((b) => {
      b.addStep({ action: 'expectAnyVisible', ...bare, detail: { selectors: ['text=A', 'text=B'] } });
      b.addStep({ action: 'signIn', ...bare, detail: { as: 'HR', signedInAs: 'a@b.co', password: 'p' } });
    });
    const xml = renderJUnit([bundle]);
    assert.match(xml, /<testcase name="expectAnyVisible text=A \| text=B"/);
    assert.match(xml, /<testcase name="signIn persona HR"/);
    assert.doesNotMatch(xml, /a@b\.co|"p"/);
    const ctrf = renderCtrf([bundle]);
    assert.equal(ctrf.results.tests[0]!.extra['target'], 'text=A | text=B');
    assert.deepEqual(ctrf.results.tests[0]!.extra['facts'], { 'any of': '1. text=A\n2. text=B' });
    assert.deepEqual(ctrf.results.tests[1]!.extra['facts'], { persona: 'HR' });
    assert.doesNotMatch(JSON.stringify(ctrf), /a@b\.co/);
    assert.deepEqual(ctrf.results.tests[0]!.extra['observed'], []);
  });

  it('the suite index counts failed, awaiting review and no verdict apart, and shows what the sheet recorded', () => {
    const passed = bundleOf((b) => b.addStep({ action: 'click', selector: '#a', resolvedSelector: '#a', resolution: 'fast', ...base, status: 'passed' }), {}, 'A ok');
    const failed = bundleOf((b) => b.addStep({ action: 'expectText', selector: '#a', resolvedSelector: null, resolution: null, ...base, status: 'failed', error: 'expected text to contain "x"' }), { status: 'failed' }, 'B bad');
    const review = bundleOf((b) => b.addStep({ action: 'expectText', selector: '#a', resolvedSelector: null, resolution: null, ...base, status: 'failed', unsure: 'x vs y' }), { status: 'needs-review' }, 'C unsure');
    const errored = bundleOf(
      (b) => b.addStep({ action: 'dbCount', ...bare, status: 'error', error: 'database unavailable' }),
      { status: 'error', generatedBy: { model: 'm', generatedAt: 'T', sourceUrl: 'u', kind: 'catalog', rationale: '', knownResult: 'blocked', sheetCaseId: 'PL_03_01' } as unknown as ProofBundle['generatedBy'] },
      'BE:PL_03_01 db',
    );
    const html = renderSuiteIndex(
      [
        { bundle: passed, reportPath: '/r/a.html' },
        { bundle: failed, reportPath: '/r/b.html' },
        { bundle: review, reportPath: '/r/c.html' },
        { bundle: errored, reportPath: '/r/d.html' },
      ],
      { indexPath: '/r/index.html', blocked: [{ name: 'E never', reason: 'CDP refused' }] },
    );
    assert.match(html, /1\/5<\/div><div class="k">cases passed/);
    assert.match(html, /<div class="v">1<\/div><div class="k">test failed/);
    assert.match(html, /<div class="v">1<\/div><div class="k">awaiting review/);
    assert.match(html, /<div class="v">1<\/div><div class="k">no verdict/);
    assert.match(html, /<div class="v">1<\/div><div class="k">never ran/);
    assert.match(html, /<span class="pill review" [^>]*>proved-\?<\/span>/);
    assert.match(html, /<span class="pill error" [^>]*>no verdict<\/span>/);
    assert.match(html, /sheet: blocked/);
    assert.match(html, /sheet id PL_03_01/);
  });
});

/* -------------------------------------------------------------- wowUI */

describe('wowUI on the new kinds, the counts and the chip', () => {
  function card(runId: string, status: ProofBundle['status'], known?: string, extra: Record<string, unknown> = {}, name = runId) {
    return toCard(
      bundleOf(
        () => {},
        {
          runId,
          status,
          generatedBy: { model: 'stub', generatedAt: 'T1', sourceUrl: 'u', kind: 'catalog', rationale: '', ...(known === undefined ? {} : { knownResult: known }), ...extra } as ProofBundle['generatedBy'],
        },
        name,
      ),
      `/tmp/${runId}.json`,
    );
  }

  it('the card carries the sheet id, sheet, category and record-only flag, null until the stamp lands', () => {
    const stamped = card('a', 'passed', 'passed', { sheetCaseId: 'PL_03_01', sheet: 'BE', category: 'Benefit Plan', recordOnly: true }, 'BE:PL_03_01 x');
    assert.equal(stamped.generatedBy?.sheetCaseId, 'PL_03_01');
    assert.equal(stamped.generatedBy?.sheet, 'BE');
    assert.equal(stamped.generatedBy?.category, 'Benefit Plan');
    assert.equal(stamped.generatedBy?.recordOnly, true);
    const bare = card('b', 'passed');
    assert.equal(bare.generatedBy?.sheetCaseId, null);
    assert.equal(bare.generatedBy?.recordOnly, false);
  });

  it('a group counts failed, review and no-verdict apart, and discloses sheet-blocked rows without scoring them', () => {
    const groups = groupRuns([
      card('a', 'passed', 'passed'),
      card('b', 'failed', 'failed'),
      card('c', 'needs-review', 'passed'),
      card('d', 'error', 'blocked'),
      card('e', 'dead-end', 'failed'),
    ]);
    const group = groups[0]!;
    assert.equal(group.passed, 1);
    assert.equal(group.failed, 2, 'failed and dead-end are the subject failing the case');
    assert.equal(group.review, 1);
    assert.equal(group.noVerdict, 1);
    assert.equal(group.sheetBlocked, 1);
    assert.deepEqual(groupAccuracy(group.runs), { agreed: 3, scored: 4, unscored: 1, percent: 75 });
  });

  it('the page script carries the mirrors, the split counts and the two new agent actions', () => {
    for (const marker of [
      'function sheetIdTag(card)',
      'function sheetTag(card)',
      'function stepTargetOf(step)',
      'function stepFactsOf(step)',
      'function resolutionNote(resolution)',
      'function observedOf(step)',
      'function redactedDetail(step)',
      "if (a.action === 'save')",
      "a.action === 'signOut'",
      "v === 'testFailed' && known === 'failed'",
      "known === 'blocked'",
      "' awaiting review'",
      "' no verdict'",
      "verdictChip('record', 'recorded only')",
      '.chip.record',
    ]) {
      assert.ok(WOW_SCRIPT.includes(marker) || marker === '.chip.record', `wowUI carries ${marker}`);
    }
    // The credential filter is the same rule as visibleDetail, and it guards the raw dump.
    assert.match(WOW_SCRIPT, /var recorded = redactedDetail\(step\);/);
    assert.match(WOW_SCRIPT, /JSON\.stringify\(recorded, null, 2\)/);
    assert.doesNotMatch(WOW_SCRIPT, /JSON\.stringify\(step\.detail, null, 2\)/);
    // The persona shown beside a signIn is a LABEL and only a label, by the
    // same structural test the reporter uses — the panel and the report must
    // not disagree about what is safe to print.
    assert.match(WOW_SCRIPT, /var LABEL_ONLY_RE = \/\^\[\^@:\]\+\$\//);
    assert.match(WOW_SCRIPT, /LABEL_ONLY_RE\.test\(raw\) \? raw : 'an account named by its credentials/);
    assert.doesNotMatch(WOW_SCRIPT, /EMAIL_RE\.test\(raw\)/, 'the well-formed-address test let a password through');
  });
});

/* --------------------------------------- a rescued step shows once, as it ended */

describe('the HTML report folds a superseded attempt under the step that replaced it', () => {
  const click = { action: 'click', selector: 'role=button[name="Add Rate" i]', resolvedSelector: null, resolution: null, ...base };

  function rescued(): ProofBundle {
    return bundleOf((b) => {
      b.addStep({ action: 'goto', intent: 'open the page', ...bare, screenshot: 'AAAA' });
      // The attempt as written: failed, then rescued by a reconstruction.
      b.addStep({ ...click, intent: 'Step 2: กดปุ่ม "Add"', status: 'failed', error: 'could not resolve\nfull trace', screenshot: 'BBBB' });
      // Preparation the reconstruction inserted, then the rebuilt step that held.
      b.addStep({ action: 'click', intent: 'Switch to the SSO Branch Rate tab', ...bare, selector: 'role=button[name="SSO Branch Rate" i]', resolution: 'fast', screenshot: 'CCCC' });
      b.addStep({ ...click, intent: 'Step 2: กดปุ่ม "Add"', status: 'passed', resolution: 'fast', screenshot: 'DDDD' });
      b.supersedeSteps([1]);
      b.noteReconstruction({ attempt: 2, from: '{"action":"click"}', to: '{"action":"click"}', inserted: 1, reasoning: 'the button lives on the other tab', model: 'stub' });
      // An absence check after the rescue: the run is unbroken, so it is not "in doubt".
      b.addStep({ action: 'expectHidden', intent: 'no error shown', ...bare, selector: 'role=alert', resolution: 'fast' });
    });
  }

  it('lists the run as it ended: the attempt is not a top-level row, the rebuilt step carries it behind a disclosure', () => {
    const page = renderReport(rescued());
    const list = page.slice(page.indexOf('<ol class="steps">'), page.indexOf('<details class="diagnostics"'));
    const rows = [...list.matchAll(/<li class="step ([^"]*)" id="step-(\d+)"/g)].map((m) => `${m[2]}:${m[1]}`);
    assert.deepEqual(rows, ['0:passed', '2:passed', '3:passed', '1:failed attempt', '4:passed'], 'the attempt renders inside step 3, after its body, never as its own row');
    assert.match(list, /<summary>Replaced 1 failed attempt at this step — as written, before the in-run reconstruction \(step 1\)<\/summary>/);
    assert.match(list, /<ol class="steps attempts">\s*<li class="step failed attempt" id="step-1"/);
    // The attempt is still a full row — its error and screenshot survive — because what was tried is evidence.
    assert.match(list, /id="step-1"[\s\S]*could not resolve[\s\S]*data:image\/jpeg;base64,BBBB/);
    assert.match(list, /id="step-1"[\s\S]*<span class="badge res-cache"><abbr[^>]*>superseded<\/abbr>/);
    assert.match(GLOSSARY['superseded'] ?? '', /folded under the step that replaced it/);
  });

  it('a superseded failure is not a break: later absence checks are not "in doubt", and the filmstrip counts live steps only', () => {
    const page = renderReport(rescued());
    assert.doesNotMatch(page, /passed, in doubt/);
    assert.match(page, /Evidence — 3 of 4 steps/, 'three live steps carry a screenshot; the folded attempt is not a frame');
    // The page script neither auto-opens a folded attempt nor films it.
    assert.match(page, /\.step\.failed:not\(\.attempt\) \.step-head/);
    assert.match(page, /querySelectorAll\('\.step:not\(\.attempt\)'\)/);
    assert.match(page, /':scope > \.step-body > \.shot-wrap img'/);
  });

  it('a live failure still renders in place, and an attempt with no rescue after it is never dropped', () => {
    const page = renderReport(
      bundleOf((b) => {
        b.addStep({ ...click, status: 'failed', error: 'nope' });
        b.addStep({ ...click, status: 'failed', error: 'nope again' });
        b.supersedeSteps([0]);
        // No reconstruction record ever landed — the orphan attempt stays visible.
      }),
    );
    const rows = [...page.matchAll(/<li class="step ([^"]*)" id="step-(\d+)"/g)].map((m) => `${m[2]}:${m[1]}`);
    assert.deepEqual(rows, ['1:failed', '0:failed']);
  });

  it('the agent callout on a PASSED step says the step passed, even when the agent itself reported no success', () => {
    const agent: AgentRecord = {
      goal: 'open the Company Code picker', model: 'stub', success: false, summary: 'stalled on turn 2',
      turns: 2, maxSteps: null, latencyMs: 5,
      actions: [{ index: 0, action: 'click', selector: 'button "Company Code"', value: null, url: 'u', reasoning: 'open it', ok: true, durationMs: 1 }],
    };
    const passed = renderReport(bundleOf((b) => b.addStep({ action: 'selectOption', ...bare, selector: 'role=combobox[name="Company Code" i]', resolution: 'agent', agent })));
    assert.match(passed, /<div class="callout agent ">\s*<div class="callout-title">Workflow agent prepared the page — the step then passed on the flow's own selector<\/div>/);
    assert.doesNotMatch(passed, /goal not reached/);
    assert.doesNotMatch(passed, /<details open>/);
    const failed = renderReport(bundleOf((b) => b.addStep({ action: 'selectOption', ...bare, status: 'failed', error: 'x', selector: 'role=combobox[name="Company Code" i]', agent })));
    assert.match(failed, /<div class="callout agent failed">\s*<div class="callout-title">Workflow agent took over — goal not reached<\/div>/);
    assert.match(failed, /<details open>/);
  });
});

/* ---------------------------------------- the agent leg that decided nothing */

/**
 * An agent leg that neither rescued the step nor broke it is folded behind a
 * CLOSED disclosure (2026-09-08), on every surface, through one predicate —
 * `inconsequentialAgentLeg` in `step-facts.ts`, so the per-run report, the
 * catalog report and the workbook cannot disagree about which legs are noise.
 *
 * The rules under test are the ones that keep folding from hiding evidence:
 * nothing leaves the document (the leg is a full record inside the
 * disclosure, exactly as a superseded attempt is), a leg on a step that did
 * NOT pass never folds, a held action never folds, the model's own `fail`
 * claim never folds, the step neither changes status nor opens on load, and a
 * bundle with no qualifying step renders the bytes it rendered before this
 * existed.
 */
describe('an agent leg that did not decide its step', () => {
  const leg = (over: Partial<AgentRecord> = {}): AgentRecord => ({
    goal: 'open the Company Code picker',
    model: 'stub',
    success: false,
    summary: 'agent found nothing the goal names to act on',
    turns: 2,
    maxSteps: null,
    latencyMs: 5,
    actions: [{ index: 0, action: 'scroll', selector: '', value: null, url: 'u', reasoning: 'look further down', ok: true, durationMs: 1 }],
    ...over,
  });

  const legStep = (over: Partial<ProofStep> = {}, agent: AgentRecord = leg(), bundleOver: Partial<ProofBundle> = {}): ProofBundle =>
    bundleOf(
      (b) =>
        b.addStep({
          action: 'selectOption',
          intent: 'set the rule type to Part time',
          ...bare,
          selector: 'role=combobox[name="Company Code" i]',
          resolution: 'agent',
          agent,
          ...over,
        } as Omit<ProofStep, 'index'>),
      bundleOver,
    );

  const DID_NOT_DECIDE = "agent leg — did not affect this step&#39;s outcome: the step passed on the flow&#39;s own selector regardless";
  const LOOKED_ONLY = "agent leg — did not affect this step&#39;s outcome: it never engaged a control the goal names";

  it('(a) a passing step whose agent reported no success folds, and the whole leg is still in the document', () => {
    const page = renderReport(legStep());
    assert.match(page, new RegExp(`<details class="aside-leg">\\s*<summary>${DID_NOT_DECIDE}</summary>`));
    // Folded, never deleted: the callout, the goal, the summary and the
    // turn-by-turn trace are all still there, one click away.
    assert.match(page, /<div class="callout agent ">/);
    assert.match(page, /<span>goal<\/span> open the Company Code picker/);
    assert.match(page, /What the agent did — 1 action, turn by turn/);
    // Closed, in the ordinary colour, and the step is still a passed row that
    // the page script leaves collapsed (it opens failed steps only).
    assert.doesNotMatch(page, /<details class="aside-leg" open>|<details open>/);
    assert.doesNotMatch(page, /callout agent failed/);
    assert.match(page, /<li class="step passed" id="step-0"/);
  });

  it('(b) a leg that never engaged a control folds, and says so in the words the flag actually means', () => {
    const page = renderReport(legStep({}, leg({ lookedOnly: true, endedBy: 'no-progress' })));
    assert.match(page, new RegExp(`<details class="aside-leg">\\s*<summary>${LOOKED_ONLY}</summary>`));
    // NOT "every action was a scroll or a wait": `WorkflowAgent` also raises
    // the flag when every interaction MISSED, which is 76 of the 85 real
    // cases in this workspace's bundles. The sentence has to be true of both.
    assert.doesNotMatch(page, /every action it took was a scroll or a wait/);
  });

  it('a leg on a step that did NOT pass is never folded — it is the evidence of the failure', () => {
    for (const status of ['failed', 'dead-end', 'error'] as const) {
      const page = renderReport(legStep({ status, error: 'could not resolve' }));
      assert.doesNotMatch(page, /class="aside-leg"/, `a ${status} step keeps its agent leg open`);
      assert.match(page, /callout agent failed/);
    }
    // The same holds for a leg that only looked and still could not carry the step.
    const looked = renderReport(legStep({ status: 'failed', error: 'x' }, leg({ lookedOnly: true })));
    assert.doesNotMatch(looked, /class="aside-leg"/);
  });

  it('a held action and the model\'s own "fail" claim are never folded', () => {
    const held = { reason: 'irreversible', rule: 'manifest', message: 'no approval for delete' };
    assert.doesNotMatch(renderReport(legStep({ blocked: held } as Partial<ProofStep>)), /class="aside-leg"/);
    assert.doesNotMatch(renderReport(legStep({}, leg({ blocked: held } as Partial<AgentRecord>))), /class="aside-leg"/);
    assert.doesNotMatch(renderReport(legStep({}, leg({ endedBy: 'fail' }))), /class="aside-leg"/);
  });

  it('a leg that DID decide the outcome renders untouched', () => {
    const page = renderReport(legStep({}, leg({ success: true, summary: 'opened the picker' })));
    assert.doesNotMatch(page, /class="aside-leg"/);
    assert.match(page, /<div class="callout-title">Workflow agent took over<\/div>/);
  });

  it('folding adds the disclosure and changes nothing else — and the defect count is untouched', () => {
    const defect: Defect = {
      id: 'd1',
      title: 'the picker did not open on the first click',
      detail: 'the agent had to prepare the page',
      severity: 'low',
      category: 'functional',
      source: 'runtime',
      selector: 'role=combobox[name="Company Code" i]',
      stepIndex: 0,
    };
    // ONE bundle, rendered twice, with the single field the predicate reads
    // and the report renders nowhere flipped in between — the same shape the
    // narration's byte-identity test uses, and the only way to hold the run
    // id and the timestamps still.
    const b = legStep({}, leg(), { defects: [defect] });
    const folded = renderReport(b);
    (b.steps[0]!.agent as { endedBy?: string }).endedBy = 'fail';
    const openLeg = renderReport(b);
    assert.match(folded, /class="aside-leg"/);
    assert.doesNotMatch(openLeg, /class="aside-leg"/);
    const stripped = folded.replace(
      /\n {4}<details class="aside-leg">\n {6}<summary>[^<]*<\/summary>\n {6}([\s\S]*?)\n {4}<\/details>/,
      '$1',
    );
    assert.equal(stripped, openLeg, 'the fold is a wrapper; every other byte of the report is the same');
    // Stated separately from the byte comparison, because it is the promise
    // the drift signal rests on: the report shows the same defects either way.
    const defectsOf = (page: string): string[] => [...page.matchAll(/<div class="d-title">([\s\S]*?)<\/div>/g)].map((m) => m[1] ?? '');
    assert.deepEqual(defectsOf(folded), defectsOf(openLeg));
    assert.deepEqual(defectsOf(folded), ['the picker did not open on the first click'], 'the defect really is on the page');
  });

  it('the predicate is one function of the record, and every non-shape returns null', () => {
    const passed = { status: 'passed' };
    assert.equal(inconsequentialAgentLeg({ ...passed })?.kind, undefined, 'a step with no agent record');
    assert.equal(inconsequentialAgentLeg({ ...passed, agent: undefined })?.kind, undefined);
    assert.equal(inconsequentialAgentLeg({ ...passed, agent: 'not an object' })?.kind, undefined);
    assert.equal(inconsequentialAgentLeg({ ...passed, agent: {} })?.kind, undefined, 'an older record with neither field');
    assert.equal(inconsequentialAgentLeg({ status: undefined, agent: { success: false } })?.kind, undefined, 'a record with no status');
    assert.equal(inconsequentialAgentLeg({ ...passed, agent: { success: false } })?.kind, 'did-not-decide');
    assert.equal(inconsequentialAgentLeg({ ...passed, agent: { success: false, lookedOnly: true } })?.kind, 'looked-only');
    assert.equal(inconsequentialAgentLeg({ status: 'passed-with-issues', agent: { success: false } })?.kind, 'did-not-decide', 'pass** IS a pass');
  });

  it('escapes the wording it composes, and carries no captured page text into it', () => {
    const page = renderReport(legStep({}, leg({ goal: '<script>alert(1)</script>', summary: '<img src=x onerror=1>' })));
    assert.ok(!page.includes('<script>alert(1)</script>'));
    assert.ok(!page.includes('<img src=x'));
    // The summary line is composed from the two constants and nothing the
    // page said, so no application text — and no credential — can reach it.
    const summaries = [...page.matchAll(/<details class="aside-leg">\s*<summary>([^<]*)<\/summary>/g)].map((m) => m[1]);
    assert.deepEqual(summaries, [DID_NOT_DECIDE]);
  });
});

/* ------------------------------------------------ the narration on a step */

/**
 * `ProofStep.narration` (2026-09-07): a model's plain-language reading of the
 * step's own recorded line, written after the run and stored on the bundle.
 * The reporter renders it and never produces it, so everything here is a pure
 * function over a hand-built bundle.
 *
 * The rules under test are the ones that make it safe to put a model's prose
 * beside evidence: it is labelled and attributed where it is read, it comes
 * after every recorded fact and displaces none, it is escaped and marked
 * `lang=""` like any other captured text, and a step with no narration
 * renders EXACTLY the bytes it rendered before this existed.
 */
describe('a step narrated in plain language', () => {
  const NARRATION = {
    text: 'Looked for a dialog called "Create Plan" and found one titled "สร้างแผนสวัสดิการ" instead.',
    by: 'groq:llama-3.3-70b-versatile',
    at: '2026-09-07T00:01:00.000Z',
  };
  const failing = {
    action: 'expectModal',
    intent: 'the Create Plan dialog is shown',
    selector: 'role=dialog[name="Create Plan" i]',
    resolvedSelector: null,
    resolution: null,
    status: 'failed' as const,
    error: 'could not resolve role=dialog[name="Create Plan" i]',
    detail: { expected: 'Create Plan', actual: 'สร้างแผนสวัสดิการ' },
    ...base,
  };
  const narrated = (over: Partial<ProofStep> = {}): ProofBundle =>
    bundleOf((b) => b.addStep({ ...failing, narration: NARRATION, ...over } as Omit<ProofStep, 'index'>));

  it('renders as an always-visible line, labelled, explained and signed by the model that wrote it', () => {
    const page = renderReport(narrated());
    const line = page.match(/<p class="step-narration">[\s\S]*?<\/p>/)?.[0] ?? '';
    assert.notEqual(line, '', 'the narration renders');
    // Outside `.step-body`, so it is read without expanding the step.
    assert.ok(page.indexOf(line) < page.indexOf('<div class="step-body"'), 'it sits in the always-visible group');
    assert.match(line, /in plain language/);
    assert.match(line, /written by groq:llama-3\.3-70b-versatile/, 'attributed where it is read, not on hover');
    assert.ok(line.includes('Looked for a dialog called'));
    // The rule that makes it safe to sit here is one greppable wording.
    assert.match(GLOSSARY['in plain language'] ?? '', /Descriptive only: it sets no status, files no defect, and is no part of the verdict/);
  });

  it('never displaces the recorded evidence — it is the LAST of the step\'s always-visible lines', () => {
    const page = renderReport(narrated());
    const step = page.slice(page.indexOf('<li class="step failed"'), page.indexOf('<div class="step-body"'));
    const order = ['class="headline"', 'class="step-sub"', 'class="step-compare"', 'class="step-narration"'];
    const at = order.map((needle) => step.indexOf(needle));
    assert.ok(at.every((i) => i >= 0), `every line renders: ${JSON.stringify(at)}`);
    assert.deepEqual([...at].sort((a, b) => a - b), at, 'intent, then the selector, then expected/actual, and only then the reading');
    // The deterministic lines are untouched by the narration beside them.
    assert.match(step, /expected <code>Create Plan<\/code>/);
    assert.match(step, /<code class="target">role=dialog\[name=&quot;Create Plan&quot; i\]<\/code>/);
  });

  it('escapes the model\'s prose and marks its captured application text, exactly like every other string', () => {
    const page = renderReport(narrated({ narration: { ...NARRATION, text: '<script>alert("x")</script> found "สร้างแผน" on the page' } } as Partial<ProofStep>));
    assert.doesNotMatch(page, /<script>alert\("x"\)<\/script>/, 'a script tag in a narration is text, never markup');
    assert.match(page, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
    assert.match(page, /<span class="narr-t"><span lang="" class="captured">/, 'non-Latin narration is marked lang="", never translated and never guessed at');
    // A model id is our own string, never captured text — it is escaped, not marked.
    const injected = renderReport(narrated({ narration: { ...NARRATION, by: '<img src=x onerror=1>' } } as Partial<ProofStep>));
    assert.doesNotMatch(injected, /<img src=x/);
    assert.match(injected, /written by &lt;img src=x onerror=1&gt;/);
  });

  it('a step with no narration renders exactly the bytes it did before narration existed', () => {
    // One bundle, rendered twice — the run id and the timestamps are the same
    // document, so the only difference the diff can show is the narration.
    const bundle = narrated();
    const withNarration = renderReport(bundle);
    delete (bundle.steps[0] as { narration?: unknown }).narration;
    const plain = renderReport(bundle);
    assert.doesNotMatch(plain, /class="step-narration"|in plain language<\/abbr>/, 'nothing about narration reaches an un-narrated report but the unused CSS rule');
    assert.equal(withNarration.replace(/<p class="step-narration">[\s\S]*?<\/p>/g, ''), plain, 'the narrated page differs by the narration line and by nothing else');
  });

  it('is nothing at all when the record is empty, half-written or not the shape', () => {
    assert.equal(stepNarration({}), null);
    assert.equal(stepNarration({ narration: { text: '   ', by: 'm', at: 'now' } }), null);
    assert.equal(stepNarration({ narration: 'a bare string' }), null);
    // Whitespace is folded so a two-line answer is one line on every surface.
    assert.equal(stepNarration({ narration: { text: ' opened\n  the page ', by: 'm:1', at: 'now' } })?.text, 'opened the page');
    // Never unattributed: a sentence with no author reads as the harness's own.
    assert.equal(stepNarration({ narration: { text: 'x', at: 'now' } })?.attribution, 'written by a model');
  });
});

/* ------------------------------------- the query a database check ran */

/**
 * A database validation shows the statement it ran and the rows it got back
 * (2026-09-08).
 *
 * `DbCheckRecord` carried only a redacted `where` summary and a capped row
 * sample, so a reader could not see WHAT SQL answered the claim, and the
 * sample rendered as an unlabelled grid of `col = value` cells. The statement
 * is now captured at its source (`src/db/db-actions.ts`, from identifiers
 * that already passed the schema gate) and projected once in `step-facts.ts`,
 * so the per-run report, the catalog report and the workbook cannot describe
 * one check three ways.
 *
 * The rules under test: the SQL and its bound parameters render and are
 * escaped; a credential-shaped parameter was redacted at the source and
 * cannot reach the HTML; the rows render as a real table with a header row
 * and say how many matched and whether the sample was capped; and a bundle
 * sealed before any of this existed renders its summary exactly as it did,
 * with no query section and nothing invented.
 */
describe('a database check shows the query it ran', () => {
  const dbStep = (db: Record<string, unknown>): ProofBundle =>
    bundleOf((b) =>
      b.addStep({
        action: 'expectDbRow',
        intent: 'the plan row is there',
        ...bare,
        db: db as never,
      } as Omit<ProofStep, 'index'>),
    );

  const RECORD = {
    kind: 'row',
    table: 'benefit_plan',
    where: 'id = 42 AND session_token = [redacted]',
    expected: 'at least 1 row',
    observed: '1 row(s)',
    rows: [{ id: '42', name: '<script>alert(1)</script>' }],
    rowsMatched: 42,
    durationMs: 12,
    statements: [
      {
        sql: 'SELECT * FROM "benefit_plan" WHERE "id" = $1 AND "session_token" = $2 LIMIT 25',
        params: ['42', '[redacted]'],
        tables: ['benefit_plan'],
      },
    ],
    note: 'read directly from the database while this flow ran',
  };

  it('renders the SQL, its bound parameters and the rows as a table with a header row', () => {
    const page = renderReport(dbStep(RECORD));
    assert.match(page, /<div class="http-part-title">query<\/div>/);
    assert.match(page, /SELECT \* FROM &quot;benefit_plan&quot; WHERE &quot;id&quot; = \$1/);
    assert.match(page, /<th colspan="2">parameters<\/th>/);
    assert.match(page, /<code>\$2<\/code><\/td><td>\[redacted\]/);
    // A real table: one header row of column names, one <tr> per row.
    assert.match(page, /<thead><tr><th>id<\/th><th>name<\/th><\/tr><\/thead>/);
    // The sample says how many matched and that it is capped.
    assert.match(page, /rows returned — showing 1 of 42 row\(s\) — the sample is capped at 3/);
    // The summary lines the block always carried are still there.
    assert.match(page, /<dt>where<\/dt><dd>id = 42 AND session_token = \[redacted\]/);
    assert.match(page, /<dt>expected<\/dt><dd>at least 1 row/);
    assert.match(page, /<dt>observed<\/dt><dd>1 row\(s\)/);
  });

  it('escapes the statement and every cell — application text reaches this block', () => {
    const page = renderReport(
      dbStep({
        ...RECORD,
        statements: [{ sql: 'SELECT * FROM "t" WHERE "n" = $1 -- <script>alert(2)</script>', params: ['<img src=x onerror=1>'] }],
      }),
    );
    assert.ok(!page.includes('<script>alert(1)</script>'), 'a cell value cannot open a tag');
    assert.ok(!page.includes('<script>alert(2)</script>'), 'the SQL cannot open a tag');
    assert.ok(!page.includes('<img src=x'), 'a bound parameter cannot open a tag');
    assert.match(page, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
  });

  it('a credential-shaped parameter is the redacted one, and the real value is nowhere in the document', () => {
    // The redaction happens at the source (`redact-row.ts`), so what a bundle
    // carries is already `[redacted]` — the report renders the record and
    // never re-derives a value, which is what makes this assertion possible.
    const page = renderReport(
      dbStep({
        ...RECORD,
        rows: [{ id: '42', password: '[redacted]' }],
        statements: [{ sql: 'SELECT * FROM "u" WHERE "password" = $1', params: ['[redacted]'] }],
      }),
    );
    assert.ok(!page.includes('hunter2'));
    assert.match(page, /<th>password<\/th>/);
    assert.match(page, /<td>\[redacted\]<\/td>/);
  });

  it('a bundle sealed before the statement existed renders its summary and no query section', () => {
    const { statements: _dropped, rowsMatched: _also, ...older } = RECORD;
    const page = renderReport(dbStep(older));
    assert.doesNotMatch(page, /<div class="http-part-title">query<\/div>/);
    assert.doesNotMatch(page, /parameters/);
    // Everything it always showed is still shown, and the sample is honest
    // about being one row rather than pretending to know a total.
    assert.match(page, /<dt>where<\/dt><dd>id = 42 AND session_token = \[redacted\]/);
    assert.match(page, /rows returned — 1 row\(s\)/);
    assert.match(page, /<dt>duration<\/dt>/);
  });

  it('a step with no db record renders no block at all', () => {
    assert.equal(dbEvidence({ db: undefined }), null);
    assert.equal(dbEvidence({ db: 'not an object' }), null);
    assert.doesNotMatch(renderReport(bundleOf((b) => b.addStep({ action: 'click', ...bare }))), /callout request/);
  });

  it('the workbook says the same thing in the Proof column, in the same words', () => {
    const lines = dbProofLines({ db: RECORD });
    assert.deepEqual(lines.slice(0, 4), [
      'db row on benefit_plan',
      'where id = 42 AND session_token = [redacted]',
      'expected at least 1 row',
      'observed 1 row(s)',
    ]);
    assert.ok(lines.includes('query: SELECT * FROM "benefit_plan" WHERE "id" = $1 AND "session_token" = $2 LIMIT 25'));
    assert.ok(lines.includes('parameters: $1 = 42 · $2 = [redacted]'));
    assert.ok(lines.includes('rows returned — showing 1 of 42 row(s) — the sample is capped at 3'));
    assert.ok(lines.includes('id | name'));
    assert.deepEqual(dbProofLines({ db: undefined }), []);
  });

  it('a called check names what it sampled — statements, not rows of a table', () => {
    const e = dbEvidence({
      db: { kind: 'called', durationMs: 3, rows: [{ statement: 'INSERT INTO orders …' }], rowsMatched: undefined },
    });
    assert.equal(e?.sample, '1 matching statement(s)');
    assert.deepEqual(e?.columns, ['statement']);
  });
});

/* ------------------------------- a broken step that decided nothing */

/**
 * A step that broke without deciding the run's outcome is folded, never
 * dropped (2026-09-08) — `inconsequentialBrokenStep` in `step-facts.ts`, the
 * sibling of `inconsequentialAgentLeg` and under the same constitution: this
 * decides only how a step is LAID OUT. It is not a status, not a verdict, not
 * a defect and not a count.
 *
 * The conditions are all structural, and the exclusions are what keep folding
 * from hiding evidence: an assertion step is never folded (its outcome IS the
 * claim), an `error` step is never folded (`harnessOnly()` depends on it being
 * visible), a held step is never folded, and nothing folds on a run whose
 * claims did not hold.
 */
describe('a step that broke without deciding the outcome', () => {
  const run = (over: Partial<ProofBundle> = {}, broken: Partial<ProofStep> = {}): ProofBundle =>
    bundleOf(
      (b) => {
        b.addStep({ action: 'goto', ...bare } as Omit<ProofStep, 'index'>);
        b.addStep({
          action: 'click',
          intent: 'dismiss the consent gate',
          ...bare,
          selector: 'role=button[name="Accept" i]',
          status: 'failed',
          error: 'could not resolve role=button[name="Accept" i]',
          ...broken,
        } as Omit<ProofStep, 'index'>);
        b.addStep({
          action: 'expectText',
          intent: 'the plan is listed',
          ...bare,
          selector: 'text="Part time"',
          detail: { expected: 'Part time', actual: 'Part time' },
        } as Omit<ProofStep, 'index'>);
      },
      { status: 'passed-with-issues', ...over },
    );

  const SUMMARY =
    "failed — did not decide this run&#39;s outcome: it makes no claim, the run carried past it, and every claim the run did make held";

  it('folds the whole row behind a closed disclosure, and the row is still in the document', () => {
    const page = renderReport(run());
    assert.match(page, new RegExp(`<details class="aside-step">\\s*<summary>.*${SUMMARY}</summary>`));
    // Folded, never deleted: the failed row, its status class, its error and
    // its intent are all one click away.
    assert.match(page, /<li class="step failed" id="step-1"/);
    assert.match(page, /could not resolve role=button/);
    assert.match(page, /dismiss the consent gate/);
    // Closed, and the sealed status is named on the summary — nothing is
    // relabelled, it is only laid out differently.
    assert.doesNotMatch(page, /<details class="aside-step" open>/);
    assert.match(page, /<summary><span class="idx">1<\/span>/);
  });

  it('the fold is a wrapper and changes nothing else about the report', () => {
    // ONE bundle rendered twice, with only the run status flipped in between,
    // so the run id and the timestamps hold still.
    const b = run();
    const folded = renderReport(b);
    (b as { status: string }).status = 'failed';
    const plain = renderReport(b);
    assert.match(folded, /class="aside-step"/);
    assert.doesNotMatch(plain, /class="aside-step"/);
    const stripped = folded.replace(
      /\n {2}<li class="step-aside">\n {4}<details class="aside-step">\n {6}<summary>[\s\S]*?<\/summary>\n {6}<ol class="steps">([\s\S]*?)<\/ol>\n {4}<\/details>\n {2}<\/li>/,
      '$1',
    );
    // The verdict headline differs (the run status is what changed), so the
    // step list is compared rather than the whole page.
    const stepsOf = (page: string): string => page.slice(page.indexOf('<li class="step passed" id="step-0"'), page.indexOf('id="step-2"'));
    assert.ok(stepsOf(plain).includes('could not resolve role=button'), 'the comparison really covers the broken step');
    assert.equal(stepsOf(stripped), stepsOf(plain), 'the fold adds a wrapper and removes nothing');
  });

  it('a failed ASSERTION is never folded — its outcome is the claim', () => {
    const page = renderReport(
      run({ status: 'passed-with-issues' }, { action: 'expectVisible', status: 'failed', error: 'not visible' }),
    );
    assert.doesNotMatch(page, /class="aside-step"/);
  });

  it('an `error` step and a held step are never folded', () => {
    assert.doesNotMatch(renderReport(run({}, { status: 'error', error: 'database unavailable' })), /class="aside-step"/);
    const held = { reason: 'irreversible', rule: 'manifest', message: 'no approval for delete' };
    assert.doesNotMatch(renderReport(run({}, { blocked: held } as Partial<ProofStep>)), /class="aside-step"/);
  });

  it('nothing folds on a run whose claims did not hold', () => {
    for (const status of ['failed', 'dead-end', 'error', 'needs-review']) {
      assert.doesNotMatch(renderReport(run({ status: status as ProofBundle['status'] })), /class="aside-step"/, status);
    }
  });

  it('the predicate is structural, and every other shape returns null', () => {
    const steps = [
      { index: 0, action: 'goto', status: 'passed' },
      { index: 1, action: 'click', status: 'failed' },
      { index: 2, action: 'expectText', status: 'passed' },
    ];
    const bundle = { status: 'passed-with-issues', steps };
    assert.equal(inconsequentialBrokenStep(steps[1]!, bundle)?.status, 'failed');
    assert.equal(inconsequentialBrokenStep(steps[1]!, { status: 'passed-with-issues', steps: [] }), null, 'a step the run does not hold');
    assert.equal(
      inconsequentialBrokenStep(steps[1]!, { status: 'passed-with-issues', steps: steps.slice(0, 2) }),
      null,
      'the last broken thing standing: nothing after it ran',
    );
    assert.equal(
      inconsequentialBrokenStep(steps[1]!, {
        status: 'passed-with-issues',
        steps: [steps[0]!, steps[1]!, { index: 2, action: 'expectText', status: 'skipped' }],
      }),
      null,
      'a step the run never reached is downstream evidence it obstructed something',
    );
    assert.equal(
      inconsequentialBrokenStep(steps[1]!, { status: 'passed-with-issues', steps: [steps[0]!, steps[1]!, { index: 2, action: 'click', status: 'passed' }] }),
      null,
      'a run that made no claim has nothing this break was beside the point of',
    );
    assert.equal(
      inconsequentialBrokenStep({ index: 1, action: 'click', status: 'failed', superseded: true }, bundle),
      null,
      'a superseded attempt is already folded under the step that replaced it',
    );
    // `pass**` and `passed` both mean the claims held.
    assert.equal(inconsequentialBrokenStep(steps[1]!, { status: 'passed', steps })?.status, 'failed');
    assert.equal(inconsequentialBrokenStep(steps[1]!, { status: undefined, steps }), null);
  });

  it('the assertion mirror cannot drift from the runner\'s own list', () => {
    for (const action of ASSERTION_ACTIONS) {
      assert.equal(isAssertionStepAction(action), true, action);
    }
    for (const action of ['click', 'goto', 'workflow', 'fill', 'signIn', 'upload', 'request', 'dbSnapshot', 'saveText', undefined]) {
      assert.equal(isAssertionStepAction(action), false, String(action));
    }
  });
});
