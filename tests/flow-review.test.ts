/**
 * The authoring review — a second look at an authored flow against the
 * codebase and documents, before it runs. Entirely unit-tier: the audit is a
 * string check, the model is stubbed, and the verify-then-apply step is pure.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { FlowStep } from '../src/engine/runner.js';
import { FlowAuthor } from '../src/generator/flow-author.js';
import {
  applyReview,
  auditGrounding,
  FlowReviewer,
  settleableFindings,
  type ReviewDecision,
  type ReviewEvidence,
  type ReviewModel,
} from '../src/generator/flow-review.js';

const TREE = [
  'link "Benefits Admin" url="/en/benefits-admin"',
  'button "Create Benefit Plan"',
  'heading "Benefit Plan Catalog"',
  'textbox "Email"',
].join('\n');

const evidence: ReviewEvidence = {
  url: 'http://app.test/en/login',
  axTree: TREE,
  declaredRoutes: ['/:locale/benefits-admin', '/:locale/benefits-admin/plans/:id'],
  projectContext: 'route /:locale/benefits-admin/plans/:id renders PlanDetail (button "Save plan")',
  prompt: 'PL_02_03 Create Benefit Plan — the modal is titled "Create Benefit Plan"',
};

function decision(partial: Partial<ReviewDecision> & Pick<ReviewDecision, 'section' | 'index' | 'verdict'>): ReviewDecision {
  return { selector: '', url: '', goal: '', action: '', value: '', reasoning: 'because', evidence: 'quoted', ...partial };
}

describe('auditGrounding — what the author wrote with nothing behind it', () => {
  it('flags a name in no tree, a path no route declares, and a workflow destination off the map', () => {
    const setup: FlowStep[] = [
      { action: 'goto', url: '/en/login' }, // the captured page itself
      { action: 'goto', url: '/en/somewhere-else' }, // a goto is not its own evidence
    ];
    const steps: FlowStep[] = [
      { action: 'click', selector: 'role=button[name="Create Benefit Plan"]' },
      { action: 'click', selector: 'role=button[name="New Plan"]' },
      { action: 'expectUrl', value: '/en/benefits-admin/plans/7' },
      { action: 'expectUrl', value: '/en/plan-editor' },
      { action: 'workflow', goal: 'open the plan, end on /en/plans/archive' },
      { action: 'expectVisible', selector: 'role=heading[name="Archived"]' },
    ];
    const findings = auditGrounding(setup, steps, evidence);
    assert.deepEqual(
      findings.map((f) => `${f.section}[${f.index}]`),
      ['setup[1]', 'steps[1]', 'steps[3]', 'steps[4]', 'steps[5]'],
    );
    assert.equal(findings.at(-1)?.afterWorkflow, true, 'a step after a workflow leg is marked as on an uncaptured page');
    assert.match(findings[0]!.reason, /not a route/);
  });

  it('declines to judge selectors against a truncated tree, but still judges paths', () => {
    const findings = auditGrounding(
      [],
      [
        { action: 'click', selector: 'role=button[name="Nowhere"]' },
        { action: 'goto', url: '/en/nowhere' },
      ],
      { ...evidence, axTree: `${TREE}\n[TREE TRUNCATED at 400 nodes]` },
    );
    assert.deepEqual(findings.map((f) => f.step.action), ['goto']);
  });

  it('accepts a page the flow itself visits as grounding for a later expectUrl', () => {
    const findings = auditGrounding(
      [{ action: 'goto', url: '/en/benefits-admin' }],
      [{ action: 'expectUrl', value: '/en/benefits-admin' }],
      { ...evidence, declaredRoutes: [] },
    );
    assert.equal(findings.length, 0);
  });
});

describe('applyReview — the model\'s answer is never the evidence', () => {
  function flagged() {
    const setup: FlowStep[] = [];
    const steps: FlowStep[] = [
      { action: 'click', selector: 'role=button[name="New Plan"]', intent: 'open the form' },
      { action: 'expectUrl', value: '/en/plan-editor' },
      { action: 'expectText', selector: 'role=heading[name="Plans"]', value: 'Benefit Plan Catalog' },
    ];
    const findings = auditGrounding(setup, steps, evidence);
    assert.equal(findings.length, 3);
    return { setup, steps, findings };
  }

  it('applies a replacement whose name is in the tree, and only repoints — never re-claims', () => {
    const { setup, steps, findings } = flagged();
    const record = applyReview(
      {
        decisions: [
          decision({ section: 'steps', index: 0, verdict: 'replace', selector: 'role=button[name="Create Benefit Plan"]' }),
          decision({ section: 'steps', index: 2, verdict: 'replace', selector: 'role=heading[name="Benefit Plan Catalog"]' }),
        ],
      },
      { findings, setup, steps, evidence },
    );
    assert.equal(record.replaced, 2);
    assert.equal((steps[0] as { selector: string }).selector, 'role=button[name="Create Benefit Plan" i]');
    assert.equal((steps[0] as { intent?: string }).intent, 'open the form', 'the intent is untouched');
    assert.equal((steps[2] as { value: string }).value, 'Benefit Plan Catalog', 'the asserted text is the claim, and stays');
    assert.equal(record.unsure, 1, 'the undecided step is unsure by omission');
  });

  it('rejects a replacement the evidence does not contain, and one with no evidence quoted', () => {
    const { setup, steps, findings } = flagged();
    const record = applyReview(
      {
        decisions: [
          decision({ section: 'steps', index: 0, verdict: 'replace', selector: 'role=button[name="Add Plan"]' }),
          decision({ section: 'steps', index: 1, verdict: 'replace', url: '/en/benefits-admin', evidence: '' }),
        ],
      },
      { findings, setup, steps, evidence },
    );
    assert.equal(record.replaced, 0);
    assert.equal(record.rejected.length, 2);
    assert.equal((steps[0] as { selector: string }).selector, 'role=button[name="New Plan"]', 'left as authored');
    assert.match(record.rejected[1]!, /no evidence quoted/);
  });

  it('accepts a path backed by a declared route, filled from the request, on goto and expectUrl alike', () => {
    const { setup, steps, findings } = flagged();
    const record = applyReview(
      { decisions: [decision({ section: 'steps', index: 1, verdict: 'replace', url: '/en/benefits-admin/plans/12' })] },
      { findings, setup, steps, evidence },
    );
    assert.equal(record.replaced, 1);
    assert.equal((steps[1] as { value: string }).value, '/en/benefits-admin/plans/12');
  });

  it('inserts a grounded preparation step before the flagged one, in the section and in its case', () => {
    const { setup, steps, findings } = flagged();
    const cases = [{ steps: [steps[0]!, steps[1]!, steps[2]!] }];
    const record = applyReview(
      {
        decisions: [
          decision({ section: 'steps', index: 2, verdict: 'insertBefore', action: 'click', selector: 'role=link[name="Benefits Admin"]' }),
          decision({ section: 'steps', index: 0, verdict: 'insertBefore', action: 'fill', selector: 'role=textbox[name="Email"]', value: 'x' }),
        ],
      },
      { findings, setup, steps, evidence },
      cases,
    );
    assert.equal(record.inserted, 1);
    assert.equal(record.rejected.length, 1, 'a fill is not preparation');
    assert.equal(steps.length, 4);
    assert.equal(steps[2]!.action, 'click');
    assert.equal(cases[0]!.steps.length, 4, 'the case sees the same insertion');
    assert.equal(cases[0]!.steps[2], steps[2], 'the very same step object');
  });

  it('ignores decisions about steps it was never asked about', () => {
    const { setup, steps, findings } = flagged();
    const record = applyReview(
      { decisions: [decision({ section: 'setup', index: 9, verdict: 'replace', selector: 'role=button[name="Create Benefit Plan"]' })] },
      { findings, setup, steps, evidence },
    );
    assert.equal(record.replaced, 0);
    assert.equal(record.unsure, 3);
  });
});

describe('FlowReviewer', () => {
  it('asks nothing when every step is grounded', async () => {
    let asked = 0;
    const model: ReviewModel = { id: 'stub', review: async () => { asked += 1; return { decisions: [] }; } };
    const reviewer = new FlowReviewer({ model });
    const outcome = await reviewer.review([], [{ action: 'click', selector: 'role=button[name="Create Benefit Plan"]' }], evidence);
    assert.equal(asked, 0);
    assert.equal(outcome.record, null);
  });

  it('a model fault leaves the flow as authored and says so, never throwing', async () => {
    const model: ReviewModel = { id: 'stub', review: async () => { throw new Error('circuit is open'); } };
    const lines: string[] = [];
    const reviewer = new FlowReviewer({ model, onLog: (l) => lines.push(l) });
    const steps: FlowStep[] = [{ action: 'click', selector: 'role=button[name="New Plan"]' }];
    const outcome = await reviewer.review([], steps, evidence);
    assert.equal((outcome.steps[0] as { selector: string }).selector, 'role=button[name="New Plan"]');
    assert.equal(outcome.record?.unsure, 1);
    assert.ok(lines.some((l) => /could not be asked/.test(l)));
  });

  it('runs inside FlowAuthor after the lints, and the authored flow carries the record', async () => {
    const model: ReviewModel = {
      id: 'stub-reviewer',
      review: async (request) => ({
        decisions: request.findings.map((f) =>
          decision({ section: f.section, index: f.index, verdict: 'replace', selector: 'role=button[name="Create Benefit Plan"]' }),
        ),
        inputTokens: 10,
        outputTokens: 5,
      }),
    };
    const author = new FlowAuthor({
      model: {
        id: 'stub-author',
        author: async () => ({
          name: 'create a plan',
          setup: [],
          steps: [
            { action: 'click', selector: 'role=button[name="New Plan"]' },
            { action: 'expectVisible', selector: 'role=heading[name="Benefit Plan Catalog"]' },
          ],
          teardown: [],
          rationale: '',
          notes: '',
          droppedSteps: 0,
        }),
      },
      reviewer: new FlowReviewer({ model }),
      declaredRoutes: evidence.declaredRoutes as string[],
      projectContext: evidence.projectContext,
    });
    // No page: the audit has no tree to judge selectors by, so nothing is
    // flagged and the review is silent — the ungrounded path is byte-for-byte.
    const ungrounded = await author.author('create a plan');
    assert.equal(ungrounded.review, undefined);
    assert.equal((ungrounded.flow.steps[0] as { selector: string }).selector, 'role=button[name="New Plan"]');
  });
});

/**
 * P5 (2026-08-31): a finding no evidence could settle is not worth a model
 * call. Measured on be100-rip, where the review's answer to a wall of these
 * was `unsure` every time — which the audit already knew.
 */
describe('settleableFindings — what is worth asking about', () => {
  const bare: ReviewEvidence = { axTree: TREE, prompt: 'PL_06_07 check the field' };

  const auditOf = (steps: FlowStep[], ev: ReviewEvidence): ReturnType<typeof auditGrounding> =>
    auditGrounding([], steps, ev);

  it('drops a selector after a workflow leg when no tree, no repo index and no document names it', () => {
    const steps: FlowStep[] = [
      { action: 'workflow', goal: 'open the plan editor' },
      { action: 'expectVisible', selector: 'role=button[name="ePatient"]' },
    ];
    const findings = auditOf(steps, bare);
    assert.equal(findings.length, 1);
    const { askable, unanswerable } = settleableFindings(findings, bare);
    assert.equal(askable.length, 0);
    assert.equal(unanswerable.length, 1);
  });

  it('keeps it the moment ANY evidence source could answer — a repo index…', () => {
    const withRepo: ReviewEvidence = { ...bare, projectContext: 'route /:locale/plans renders PlanEditor' };
    const findings = auditOf(
      [
        { action: 'workflow', goal: 'open the plan editor' },
        { action: 'expectVisible', selector: 'role=button[name="ePatient"]' },
      ],
      withRepo,
    );
    assert.equal(settleableFindings(findings, withRepo).askable.length, 1);
  });

  it('…or the control being named in a document the author saw', () => {
    const withDoc: ReviewEvidence = { ...bare, prompt: 'PL_06_07 the ePatient tag must disappear' };
    const findings = auditOf(
      [
        { action: 'workflow', goal: 'open the plan editor' },
        { action: 'expectVisible', selector: 'role=button[name="ePatient"]' },
      ],
      withDoc,
    );
    assert.equal(settleableFindings(findings, withDoc).askable.length, 1);
  });

  it('always asks about a path finding — a route needs no tree', () => {
    const steps: FlowStep[] = [
      { action: 'workflow', goal: 'open the editor' },
      { action: 'expectUrl', value: '/en/nowhere-declared' },
    ];
    const findings = auditOf(steps, bare);
    assert.equal(findings.length, 1);
    assert.equal(settleableFindings(findings, bare).askable.length, 1);
  });

  it('a selector on a CAPTURED page is always asked — a tree can settle it', () => {
    const findings = auditOf([{ action: 'click', selector: 'role=button[name="New Plan"]' }], bare);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.afterWorkflow, false);
    assert.equal(settleableFindings(findings, bare).askable.length, 1);
  });
});

describe('FlowReviewer — the call it no longer makes', () => {
  const bare: ReviewEvidence = { axTree: TREE, prompt: 'PL_06_07 check the field' };

  it('does not ask when nothing is settleable, and says why in the record', async () => {
    let asked = 0;
    const model: ReviewModel = {
      id: 'stub',
      review: async () => {
        asked += 1;
        return { decisions: [] };
      },
    };
    const setup: FlowStep[] = [];
    const steps: FlowStep[] = [
      { action: 'workflow', goal: 'open the plan editor' },
      { action: 'expectVisible', selector: 'role=button[name="ePatient"]' },
      { action: 'expectHidden', selector: 'role=button[name="Tops care"]' },
    ];
    const outcome = await new FlowReviewer({ model }).review(setup, steps, bare);
    assert.equal(asked, 0, 'a call that could only answer "unsure" is not made');
    assert.equal(outcome.record?.flagged, 2);
    assert.equal(outcome.record?.unsure, 2, 'they are still counted — the problem did not go away');
    assert.equal(outcome.record?.inputTokens, 0);
    assert.match(outcome.record?.notes.join('\n') ?? '', /no evidence could settle this/);
    assert.match(outcome.record?.notes.join('\n') ?? '', /--repo/);
  });

  it('still asks — and still counts the unaskable — when the two are mixed', async () => {
    let flaggedSeen = -1;
    const model: ReviewModel = {
      id: 'stub',
      review: async (request) => {
        flaggedSeen = request.findings.length;
        // Decide the one it WAS given, so the only `unsure` left in the tally
        // is the one this change stopped asking about.
        return {
          decisions: request.findings.map((f) =>
            decision({ section: f.section, index: f.index, verdict: 'keep' }),
          ),
        };
      },
    };
    const steps: FlowStep[] = [
      { action: 'workflow', goal: 'open the plan editor' },
      { action: 'expectVisible', selector: 'role=button[name="ePatient"]' },
      { action: 'expectUrl', value: '/en/nowhere-declared' },
    ];
    const outcome = await new FlowReviewer({ model }).review([], steps, bare);
    assert.equal(flaggedSeen, 1, 'only the path finding is sent');
    assert.equal(outcome.record?.flagged, 2, 'the tally is what the AUDIT found');
    assert.equal(outcome.record?.kept, 1, 'the askable one was answered');
    assert.equal(outcome.record?.unsure, 1, 'the unaskable one is unsure by construction');
  });
});
