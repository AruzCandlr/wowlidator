/**
 * Contract tests for prompt-driven flow authoring.
 *
 * All offline: `FlowAuthorModel` is one method, so the interesting behaviour —
 * refusing an assertion-free flow, narrowing the flat schema, reporting what was
 * dropped — is testable without a key or a browser.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { zodSchema } from 'ai';

import {
  AUTHOR_ATTEMPTS,
  AuthoredFlowSchema,
  AuthoringError,
  FlowAuthor,
  LlmFlowAuthorModel,
  caseFlows,
  groundCredentialFills,
  groundCredentialValues,
  strandedCredentialFill,
  MAX_REPORTED_VIOLATIONS,
  composeRefusal,
  type Violation,
  countPinnedName,
  volatileCountAssertion,
  duplicateCredentialSubmit,
  notEndToEnd,
  loginProofCannotFail,
  unsettledWorkflowClaim,
  interruptedCredentialSubmit,
  ungroundedCountRole,
  unpinnedDateEntry,
  ungroundedUrlExpectation,
  unsynchronizedLoginSubmit,
  dbClaimWithoutDbCheck,
  BACKEND_OFF_REASON,
  buildUserPrompt,
  loginProofAssertsLoginPage,
  ungroundedGoto,
  unindexedRequestMethod,
  wordingClaimAssertsDataValue,
  type AuthorRequest,
  type AuthorResult,
  type FlowAuthorModel,
  groundLoginProof,
  fromTreeNotation,
  typedCredentialValues,
  credentialEchoAssertions,
  switchesPersona,
  groundPersonaSwitches,
} from '../src/generator/flow-author.js';
import {
  fillRouteIds,
  journeyCaptureNote,
  literalDestinations,
  shouldSignInForCapture,
} from '../src/cli/commands/authoring.js';
import { vacuousFlow } from '../src/generator/vacuous.js';
import type { FlowStep } from '../src/engine/runner.js';
import { jsonModel } from './helpers.js';

/** A stub that returns whatever the test hands it, and records the request. */
function stubModel(result: Partial<AuthorResult>): FlowAuthorModel & { seen?: AuthorRequest } {
  const model: FlowAuthorModel & { seen?: AuthorRequest } = {
    id: 'stub:author',
    async author(request) {
      model.seen = request;
      return {
        name: 'stub flow',
        rationale: 'because',
        setup: [],
        steps: [],
        teardown: [],
        notes: '',
        droppedSteps: 0,
        ...result,
      };
    },
  };
  return model;
}

describe('FlowAuthor', () => {
  it('builds a flow from a prompt', async () => {
    const author = new FlowAuthor({
      model: stubModel({
        name: 'pagination is disabled on a single page',
        setup: [{ action: 'goto', url: '/rules' }],
        steps: [
          { action: 'expectDisabled', selector: 'role=button[name="Next"]', intent: 'next button' },
        ],
        teardown: [{ action: 'clearStorage' }],
      }),
    });

    const authored = await author.author('check pagination is disabled with one page');

    assert.equal(authored.flow.name, 'pagination is disabled on a single page');
    assert.equal(authored.flow.setup?.length, 1);
    assert.equal(authored.flow.steps.length, 1);
    assert.equal(authored.flow.teardown?.length, 1);
    assert.equal(authored.grounded, false, 'no page was supplied');
  });

  it('forwards a saved repository’s prompt section to the model', async () => {
    // The `--repo` path: cmdCatalog/cmdAuthor hand the repo's route-centred
    // section in as `projectContext`, and it must reach the model as its own
    // request field — buildUserPrompt labels it apart from the tree there.
    const model = stubModel({
      steps: [
        { action: 'expectVisible', selector: 'role=heading[name="Plans"]', intent: 'the page shows' },
      ],
    });
    const author = new FlowAuthor({
      model,
      projectContext: 'route /admin/benefits/plans renders PlansPage',
    });
    await author.author('check the plans page lists the catalog');
    assert.equal(model.seen?.projectContext, 'route /admin/benefits/plans renders PlansPage');
  });

  it('omits empty setup and teardown rather than emitting empty arrays', async () => {
    const author = new FlowAuthor({
      model: stubModel({
        steps: [{ action: 'expectVisible', selector: 'role=table', intent: 'the table' }],
      }),
    });

    const authored = await author.author('check the table renders');

    assert.equal(authored.flow.setup, undefined);
    assert.equal(authored.flow.teardown, undefined);
  });

  it('refuses a flow with no assertion instead of returning a test that proves nothing', async () => {
    const author = new FlowAuthor({
      model: stubModel({
        name: 'click around',
        steps: [
          { action: 'goto', url: '/' },
          { action: 'click', selector: 'role=button[name="Next"]' },
        ],
      }),
    });

    await assert.rejects(
      () => author.author('click the next button'),
      (error: unknown) =>
        error instanceof AuthoringError && /no assertion/.test((error as Error).message),
    );
  });

  it('refuses when no usable steps survived', async () => {
    const author = new FlowAuthor({ model: stubModel({ steps: [] }) });

    await assert.rejects(
      () => author.author('do something vague'),
      (error: unknown) =>
        error instanceof AuthoringError && /no usable steps/.test((error as Error).message),
    );
  });

  it('rejects an empty prompt without spending a call', async () => {
    const model = stubModel({});
    const author = new FlowAuthor({ model });

    await assert.rejects(() => author.author('   '), AuthoringError);
    assert.equal(model.seen, undefined, 'the model must not be called');
  });

  it('passes the policy through to the model', async () => {
    const model = stubModel({
      steps: [{ action: 'expectVisible', selector: 'role=alert', intent: 'validation error' }],
    });
    const author = new FlowAuthor({ model, policy: 'read-only' });

    await author.author('check the table renders');

    assert.equal(model.seen?.policy, 'read-only');
  });

  it('defaults to the forms policy — validation is the negative-testing surface', async () => {
    const model = stubModel({
      steps: [{ action: 'expectVisible', selector: 'role=alert', intent: 'validation error' }],
    });

    await new FlowAuthor({ model }).author('submit the form empty and check validation');

    assert.equal(model.seen?.policy, 'forms');
  });

  it('repairs a stranded persona switch mechanically instead of refusing the case', async () => {
    // The PB-02-01 authoring failure: the model switches identity mid-flow
    // without navigating back to the sign-in page it itself used at step 0.
    // The system knows the exact fix the refusal would ask a human to type,
    // so it applies it — disclosed on notes — and no model call is repaid.
    const model = stubModel({
      name: 'persona switch',
      steps: [
        { action: 'goto', url: '/en/login' },
        { action: 'fill', selector: 'role=textbox[name="Work email" i]', value: 'manager@x' },
        { action: 'fill', selector: 'role=textbox >> nth=1', value: 'pw' },
        { action: 'click', selector: 'role=button[name="Sign in" i]' },
        { action: 'goto', url: '/en/workflows/probation' },
        { action: 'expectCount', selector: 'role=radio', count: 4, intent: 'four outcome cards' },
        { action: 'fill', selector: 'role=textbox[name="Work email" i]', value: 'hradmin@x' },
        { action: 'fill', selector: 'role=textbox >> nth=1', value: 'pw' },
        { action: 'click', selector: 'role=button[name="Sign in" i]' },
        { action: 'expectVisible', selector: 'text=Probation Exemption', intent: 'exemption surface' },
      ],
    });
    let calls = 0;
    const inner = model.author.bind(model);
    model.author = async (request) => {
      calls += 1;
      return inner(request);
    };
    const author = new FlowAuthor({ model });

    const authored = await author.author('verify outcome cards and the exemption surface');

    assert.equal(calls, 1, 'a mechanical omission must not cost a second model call');
    // Two mechanical repairs compose: the goto to the sign-in page the flow
    // itself named, and — because the identities differ — a signOut in front
    // of it, so the switch travels the application's own sign-out path.
    assert.equal(authored.flow.steps[6]?.action, 'signOut');
    assert.deepEqual(authored.flow.steps[7], { action: 'goto', url: '/en/login' });
    assert.match(authored.notes, /inserted 1 goto/);
    assert.match(authored.notes, /signOut step\(s\) before persona switches/);
    assert.equal(strandedCredentialFill(authored.flow.steps), null);
  });

  it('re-asks once with the refusal as feedback before giving up', async () => {
    // No sign-in URL anywhere in the flow, so the mechanical repair cannot
    // apply — the next cheapest move is one informed re-ask, the healer's
    // own "the value is entirely in the second ask" rule.
    const bad: Partial<AuthorResult> = {
      steps: [
        { action: 'fill', selector: 'role=textbox >> nth=1', value: 'pw', intent: 'the password field' },
        { action: 'expectVisible', selector: 'text=Dashboard', intent: 'landed' },
      ],
    };
    const good: Partial<AuthorResult> = {
      steps: [
        { action: 'goto', url: '/en/login' },
        { action: 'fill', selector: 'role=textbox >> nth=1', value: 'pw', intent: 'the password field' },
        { action: 'expectVisible', selector: 'text=Dashboard', intent: 'landed' },
      ],
    };
    const requests: AuthorRequest[] = [];
    const model: FlowAuthorModel = {
      id: 'stub:author',
      async author(request) {
        requests.push(request);
        const result = requests.length === 1 ? bad : good;
        return {
          name: 'retry flow', rationale: '', setup: [{ action: 'goto', url: '/en/home' }],
          steps: [], teardown: [], notes: '', droppedSteps: 0, ...result,
        };
      },
    };

    const authored = await new FlowAuthor({ model }).author('sign in and check the dashboard');

    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.feedback, undefined, 'the first ask carries no feedback');
    assert.match(requests[1]?.feedback?.[0] ?? '', /credential field without first navigating/);
    assert.equal(authored.flow.steps.length, 3);
  });

  it(`refuses for real after ${AUTHOR_ATTEMPTS} attempts that ignore the feedback`, async () => {
    let calls = 0;
    const model: FlowAuthorModel = {
      id: 'stub:author',
      async author() {
        calls += 1;
        return {
          name: 'stubborn', rationale: '', setup: [{ action: 'goto', url: '/en/home' }],
          steps: [
            { action: 'fill', selector: 'role=textbox >> nth=1', value: 'pw', intent: 'the password field' },
            { action: 'expectVisible', selector: 'text=x', intent: 'x' },
          ],
          teardown: [], notes: '', droppedSteps: 0,
        };
      },
    };

    await assert.rejects(
      () => new FlowAuthor({ model }).author('sign in somehow'),
      (error: unknown) => error instanceof AuthoringError && /credential field/.test((error as Error).message),
    );
    assert.equal(calls, AUTHOR_ATTEMPTS, 'the budget is spent, then the refusal is loud');
  });
});

describe('strandedCredentialFill', () => {
  const signIn: FlowStep[] = [
    { action: 'goto', url: '/en/login' },
    { action: 'fill', selector: 'role=textbox[name="Work email" i]', value: 'a@b.c' },
    { action: 'fill', selector: 'role=textbox >> nth=1', value: 'hunter2', intent: 'the password field' },
    { action: 'click', selector: 'role=button[name="Sign in" i]' },
  ];

  it('accepts a login block grounded on a sign-in page, and a flow that starts on one', () => {
    assert.equal(strandedCredentialFill(signIn), null);
    // No goto at all: the page the author was given may BE the login screen.
    assert.equal(strandedCredentialFill(signIn.slice(1)), null);
  });

  it('refuses the PB-02-01 shape: credentials filled after navigating somewhere else', () => {
    const steps: FlowStep[] = [
      ...signIn,
      { action: 'goto', url: '/en/workflows/probation/PB-001' },
      { action: 'expectVisible', selector: 'text=Outcome', value: '' } as FlowStep,
      // The persona switch with no navigation — every fill below runs
      // against a page with no login form on it.
      { action: 'fill', selector: 'role=textbox[name="Work email" i]', value: 'hr@b.c' },
      { action: 'fill', selector: 'role=textbox >> nth=1', value: 'hunter2' },
    ];
    assert.equal(strandedCredentialFill(steps), 7);
  });

  it('does not mistake an ordinary form field for a credential', () => {
    const steps: FlowStep[] = [
      { action: 'goto', url: '/en/profile' },
      { action: 'fill', selector: 'role=textbox[name="Display name" i]', value: 'Alice' },
      { action: 'fill', selector: '#bio', value: 'hello' },
    ];
    assert.equal(strandedCredentialFill(steps), null);
  });
});

describe('ungroundedCountRole', () => {
  const TREE = [
    'radiogroup',
    'button "Pass probation (normal)"',
    'button "Extend"',
    'heading "ผลการประเมิน"',
  ].join('\n');

  it('flags a count of a role the tree never lists, in both selector spellings', () => {
    // PB-02-01: the model saw a radiogroup and inferred radio children; the
    // app renders aria-pressed buttons, so the count resolves zero forever.
    const roleForm: FlowStep[] = [{ action: 'expectCount', selector: 'role=radio', count: 4 }];
    const cssForm: FlowStep[] = [{ action: 'expectCount', selector: '[role="radio"]', count: 4 }];
    assert.deepEqual(ungroundedCountRole(roleForm, TREE), { index: 0, role: 'radio' });
    assert.deepEqual(ungroundedCountRole(cssForm, TREE), { index: 0, role: 'radio' });
  });

  it('accepts a count of a role the tree actually lists', () => {
    const steps: FlowStep[] = [{ action: 'expectCount', selector: 'role=button', count: 2 }];
    assert.equal(ungroundedCountRole(steps, TREE), null);
  });

  it('declines to judge a truncated tree — absence of evidence is not evidence of absence', () => {
    const steps: FlowStep[] = [{ action: 'expectCount', selector: 'role=radio', count: 4 }];
    const truncated = `${TREE}\n[TREE TRUNCATED: showing 4 of 90 nodes...]`;
    assert.equal(ungroundedCountRole(steps, truncated), null);
    assert.equal(ungroundedCountRole(steps, undefined), null, 'ungrounded authoring has no tree to check');
  });

  it('ignores counts that are not role-shaped', () => {
    const steps: FlowStep[] = [{ action: 'expectCount', selector: '.card', count: 3 }];
    assert.equal(ungroundedCountRole(steps, TREE), null);
  });
});

describe('ungroundedUrlExpectation', () => {
  const TREE = 'link "OT Request" url="http://localhost:3000/en/overtime"\nlink "Leave" url="http://localhost:3000/en/leave"';

  it('refuses a URL derived from a label — the live time-attendance shape', () => {
    // The card is LABELLED "Time & Attendance" but ROUTES to /en/overtime;
    // asserting the label's slug filed a high defect against an app that
    // navigated correctly.
    const steps: FlowStep[] = [
      { action: 'goto', url: '/en/home' },
      { action: 'click', selector: 'role=link[name="OT Request" i]' },
      { action: 'expectUrl', value: 'time-attendance' },
    ];
    assert.deepEqual(ungroundedUrlExpectation(steps, TREE), { index: 2, expected: 'time-attendance' });
  });

  it('accepts a URL grounded in the tree, or in the flow’s own gotos', () => {
    const viaTree: FlowStep[] = [
      { action: 'click', selector: 'role=link[name="OT Request" i]' },
      { action: 'expectUrl', value: 'overtime' },
    ];
    const viaGoto: FlowStep[] = [
      { action: 'goto', url: '/en/custom-page' },
      { action: 'expectUrl', value: 'custom-page' },
    ];
    assert.equal(ungroundedUrlExpectation(viaTree, TREE), null);
    assert.equal(ungroundedUrlExpectation(viaGoto, TREE), null);
  });

  it('exempts expectations after a workflow step — the agent’s journey ends off-tree', () => {
    const steps: FlowStep[] = [
      { action: 'workflow', goal: 'reach the OT page via the sidebar' },
      { action: 'expectUrl', value: 'anything-at-all' },
    ];
    assert.equal(ungroundedUrlExpectation(steps, TREE), null);
  });

  it('declines to judge a truncated or absent tree', () => {
    const steps: FlowStep[] = [{ action: 'expectUrl', value: 'nowhere' }];
    assert.equal(ungroundedUrlExpectation(steps, `${TREE}\n[TREE TRUNCATED: ...]`), null);
    assert.equal(ungroundedUrlExpectation(steps, undefined), null);
  });
});

describe('groundCredentialFills', () => {
  it('splices the flow’s own sign-in goto in front of each stranded login block', () => {
    // The PB-02-01 authoring shape: the flow names its sign-in page once,
    // then switches persona twice with no navigation. The mechanical repair
    // is the exact fix the refusal message asks a human to type.
    const steps: FlowStep[] = [
      { action: 'goto', url: '/en/login' },
      { action: 'fill', selector: 'role=textbox[name="Work email" i]', value: 'manager@x' },
      { action: 'fill', selector: 'role=textbox >> nth=1', value: 'pw' },
      { action: 'click', selector: 'role=button[name="Sign in" i]' },
      { action: 'goto', url: '/en/workflows/probation/PB-001' },
      { action: 'expectCount', selector: 'role=radio', count: 4 },
      // Persona switch, no navigation — the block starts at the email fill.
      { action: 'fill', selector: 'role=textbox[name="Work email" i]', value: 'hr@x' },
      { action: 'fill', selector: 'role=textbox >> nth=1', value: 'pw' },
      { action: 'click', selector: 'role=button[name="Sign in" i]' },
    ];

    const repaired = groundCredentialFills([], steps, '/en/login');
    assert.equal(repaired.grounded, 1);
    // The goto lands before the whole credential block (the email fill), not
    // just before the password fill the detector flags.
    assert.deepEqual(repaired.steps[6], { action: 'goto', url: '/en/login' });
    assert.equal(repaired.steps.length, steps.length + 1);
    // And the repaired flow passes the lint that refused the original.
    assert.equal(strandedCredentialFill(repaired.steps), null);
  });

  it('touches nothing when every credential fill is already grounded', () => {
    const steps: FlowStep[] = [
      { action: 'goto', url: '/en/login' },
      { action: 'fill', selector: 'role=textbox >> nth=1', value: 'pw' },
    ];
    const repaired = groundCredentialFills([], steps, '/en/login');
    assert.equal(repaired.grounded, 0);
    assert.deepEqual(repaired.steps, steps);
  });

  it('reads the prefix (setup) to know where the flow already is', () => {
    const setup: FlowStep[] = [{ action: 'goto', url: '/en/workflows' }];
    const steps: FlowStep[] = [
      { action: 'fill', selector: 'role=textbox >> nth=1', value: 'pw' },
    ];
    const repaired = groundCredentialFills(setup, steps, '/en/login');
    assert.equal(repaired.grounded, 1);
    assert.deepEqual(repaired.steps[0], { action: 'goto', url: '/en/login' });
  });
});

describe('groundCredentialValues', () => {
  const AS = { email: 'admin@cnext.test', password: 'admin2026' };
  const login = (password: string): FlowStep[] => [
    { action: 'goto', url: '/en/login' },
    { action: 'fill', selector: 'role=textbox[name="Work email" i]', value: 'admin@cnext.test' },
    { action: 'click', selector: 'role=button[name="Next" i]' },
    { action: 'fill', selector: 'input[type="password"]', value: password, intent: 'Fill password field' },
    { action: 'click', selector: 'role=button[name="Sign in" i]' },
    { action: 'expectHidden', selector: 'role=button[name="Sign in" i]' },
  ];

  it('replaces an invented password with the supplied one', () => {
    // The be100 shape (19 of 107 flows, live): the model was handed the
    // account and typed `AdminPass123!` anyway — a whole red run per flow.
    const steps = login('AdminPass123!');
    assert.equal(groundCredentialValues(steps, AS), 1);
    assert.equal((steps[3] as { value: string }).value, 'admin2026');
  });

  it('touches nothing when the flow already types the supplied password', () => {
    const steps = login('admin2026');
    assert.equal(groundCredentialValues(steps, AS), 0);
  });

  it('leaves another persona’s sign-in alone', () => {
    // A single --as must not overwrite a multi-persona catalog.
    const steps: FlowStep[] = [
      { action: 'goto', url: '/en/login' },
      { action: 'fill', selector: 'role=textbox[name="Work email" i]', value: 'hrbp@cnext.test' },
      { action: 'fill', selector: 'input[type="password"]', value: 'hrbp2026' },
      { action: 'click', selector: 'role=button[name="Sign in" i]' },
      { action: 'expectHidden', selector: 'role=button[name="Sign in" i]' },
    ];
    assert.equal(groundCredentialValues(steps, AS), 0);
    assert.equal((steps[2] as { value: string }).value, 'hrbp2026');
  });

  it('leaves a deliberate wrong-password test alone', () => {
    // A negative login test asserts an error message, not the login proof —
    // no expectHidden in the segment means the flow never claims success.
    const steps: FlowStep[] = [
      { action: 'goto', url: '/en/login' },
      { action: 'fill', selector: 'role=textbox[name="Work email" i]', value: 'admin@cnext.test' },
      { action: 'fill', selector: 'input[type="password"]', value: 'wrong-on-purpose' },
      { action: 'click', selector: 'role=button[name="Sign in" i]' },
      { action: 'expectText', selector: 'body', value: 'Invalid credentials' },
    ];
    assert.equal(groundCredentialValues(steps, AS), 0);
    assert.equal((steps[2] as { value: string }).value, 'wrong-on-purpose');
  });

  it('never overwrites the email fill itself, however its intent reads', () => {
    const steps: FlowStep[] = [
      { action: 'goto', url: '/en/login' },
      { action: 'fill', selector: 'role=textbox[name="Work email" i]', value: 'admin@cnext.test', intent: 'Fill password credentials email' },
      { action: 'fill', selector: 'input[type="password"]', value: 'guess' },
      { action: 'expectHidden', selector: 'role=button[name="Sign in" i]' },
    ];
    assert.equal(groundCredentialValues(steps, AS), 1);
    assert.equal((steps[1] as { value: string }).value, 'admin@cnext.test');
    assert.equal((steps[2] as { value: string }).value, 'admin2026');
  });
});

describe('LlmFlowAuthorModel', () => {
  const payload = {
    name: 'search returns results',
    rationale: 'proves the search filters the table',
    setup: [
      { action: 'goto', selector: '', value: '', url: '/rules', key: '', name: '', intent: 'open the page' },
    ],
    steps: [
      {
        action: 'fill',
        selector: 'role=textbox[name="Search"]',
        value: 'leave',
        url: '',
        key: '',
        name: '',
        intent: 'the search box',
      },
      {
        action: 'press',
        selector: 'role=textbox[name="Search"]',
        value: '',
        url: '',
        key: 'Enter',
        name: '',
        intent: 'submit the search',
      },
      {
        action: 'expectCount',
        selector: 'role=row',
        value: '3',
        url: '',
        key: '',
        name: '',
        intent: 'matching rows',
      },
      {
        action: 'expectAttribute',
        selector: 'role=textbox[name="Search"]',
        value: 'false',
        url: '',
        key: '',
        name: 'aria-invalid',
        intent: 'not flagged invalid',
      },
      // Malformed on purpose: a click with no selector cannot be run.
      { action: 'click', selector: '', value: '', url: '', key: '', name: '', intent: 'nothing' },
      // Malformed on purpose: expectCount needs a numeric value.
      {
        action: 'expectCount',
        selector: 'role=row',
        value: 'several',
        url: '',
        key: '',
        name: '',
        intent: 'rows',
      },
    ],
    teardown: [],
    notes: 'assumed the search submits on Enter',
  };

  it('narrows the flat schema into real steps and counts what it dropped', async () => {
    const model = new LlmFlowAuthorModel({
      model: jsonModel('mock-author', payload, { inputTokens: 900, outputTokens: 210 }),
      id: 'mock:author',
    });

    const result = await model.author({ prompt: 'search for leave', policy: 'read-only' });

    assert.equal(result.name, 'search returns results');
    assert.equal(result.setup.length, 1);
    assert.equal(result.steps.length, 4, 'two malformed steps must be dropped');
    assert.equal(result.droppedSteps, 2);
    assert.equal(result.notes, 'assumed the search submits on Enter');
    assert.equal(result.inputTokens, 900);
    assert.equal(result.outputTokens, 210);

    // expectCount must arrive as a number, not the schema's string.
    const count = result.steps.find((s) => s.action === 'expectCount');
    assert.deepEqual(count, {
      action: 'expectCount',
      selector: 'role=row',
      count: 3,
      intent: 'matching rows',
    });

    // press carries its key, and keeps the optional selector.
    const press = result.steps.find((s) => s.action === 'press');
    assert.equal(press?.action === 'press' && press.key, 'Enter');

    // expectAttribute needs all three of selector, name, value.
    const attr = result.steps.find((s) => s.action === 'expectAttribute');
    assert.equal(attr?.action === 'expectAttribute' && attr.name, 'aria-invalid');
  });

  it('is usable end to end through FlowAuthor', async () => {
    const author = new FlowAuthor({
      model: new LlmFlowAuthorModel({
        model: jsonModel('mock-author', payload, { inputTokens: 900, outputTokens: 210 }),
        id: 'mock:author',
      }),
    });

    const authored = await author.author('search for leave and check the rows');

    assert.equal(authored.flow.steps.length, 4);
    assert.equal(authored.droppedSteps, 2);
    assert.equal(authored.model, 'mock:author');
    assert.match(authored.notes, /Enter/);
  });

  it('leaves a body the model did not divide as exactly one case', async () => {
    // The payload above labels nothing, which is also what a model that ignores
    // the field produces. That must cost the isolation between cases and nothing
    // else — not the authoring call, and not the flow.
    const model = new LlmFlowAuthorModel({
      model: jsonModel('mock-author', payload, { inputTokens: 0, outputTokens: 0 }),
      id: 'mock:author',
    });

    const result = await model.author({ prompt: 'search for leave' });

    assert.equal(result.cases?.length, 1);
    assert.equal(result.cases?.[0]?.name, 'search returns results', 'takes the flow’s own name');
    assert.deepEqual(result.cases?.[0]?.steps, result.steps);
  });
});

/**
 * A strict structured-output provider (Groq's `openai/gpt-oss-*`, OpenAI's own)
 * validates the schema before it asks the model, and rejects any object whose
 * `required` omits a key of `properties`. That failure is invisible to every
 * other test here — the stubs never build a wire schema — and it takes down the
 * whole authoring call rather than degrading, so it is pinned directly.
 */
describe('the wire schema', () => {
  /** Every object in the schema, including the ones nested inside arrays. */
  const objectsIn = (node: unknown, found: Record<string, unknown>[] = []): Record<string, unknown>[] => {
    if (node === null || typeof node !== 'object') return found;
    const schema = node as Record<string, unknown>;
    if (schema['type'] === 'object' && schema['properties']) found.push(schema);
    for (const value of Object.values(schema)) {
      if (Array.isArray(value)) value.forEach((entry) => objectsIn(entry, found));
      else objectsIn(value, found);
    }
    return found;
  };

  it('lists every property in required, so a strict provider accepts it', () => {
    const emitted = (zodSchema(AuthoredFlowSchema) as { jsonSchema: unknown }).jsonSchema;
    const objects = objectsIn(emitted);
    assert.ok(objects.length >= 2, 'expected the flow and its step objects');

    for (const schema of objects) {
      const properties = Object.keys(schema['properties'] as Record<string, unknown>);
      const required = (schema['required'] as string[] | undefined) ?? [];
      const missing = properties.filter((key) => !required.includes(key));
      assert.deepEqual(
        missing,
        [],
        `every property must be in required — .optional()/.default() produce exactly this gap`,
      );
    }
  });

  it('still reads a step that omits case, so a lenient provider degrades', () => {
    // The other half of the same decision: required on the wire, tolerated on
    // the way in. A plain `.nullable()` would pass the test above and fail here.
    const parsed = AuthoredFlowSchema.safeParse({
      name: 'catalog',
      rationale: 'r',
      setup: [],
      steps: [{ action: 'expectVisible', selector: 'role=table', value: '', url: '', key: '', name: '', intent: 'the table' }],
      teardown: [],
      notes: '',
    });

    assert.ok(parsed.success, 'a step with no case at all must parse');
    assert.equal(parsed.data?.steps[0]?.case, null, 'and read as no case, not as a name');
  });
});

/**
 * Splitting a body into cases is what lets one failure be noted instead of
 * fatal: each case is run on its own, so the ones after a failure still get
 * answered. Everything here is a property of the split itself.
 */
describe('discrete cases', () => {
  const step = (
    action: string,
    caseName: string,
    intent: string,
  ): Record<string, string> => ({
    action,
    case: caseName,
    selector: action === 'goto' ? '' : 'role=table',
    value: '',
    url: action === 'goto' ? '/rules' : '',
    key: '',
    name: '',
    intent,
  });

  const authorOf = async (steps: Record<string, string>[]) =>
    new LlmFlowAuthorModel({
      model: jsonModel('mock-author', {
        name: 'catalog',
        rationale: 'r',
        setup: [step('goto', '', 'open the page')],
        steps,
        teardown: [],
        notes: '',
      }, { inputTokens: 0, outputTokens: 0 }),
      id: 'mock:author',
    }).author({ prompt: 'prove the catalog' });

  it('groups consecutive steps sharing a name, in the order they were written', async () => {
    const result = await authorOf([
      step('click', 'filtering', 'open the filter'),
      step('expectVisible', 'filtering', 'the filtered table'),
      step('click', 'export', 'press export'),
      step('expectVisible', 'export', 'the download appears'),
    ]);

    assert.deepEqual(result.cases?.map((one) => one.name), ['filtering', 'export']);
    assert.deepEqual(result.cases?.map((one) => one.steps.length), [2, 2]);
    // Nothing is dropped or duplicated by grouping.
    assert.deepEqual(result.cases?.flatMap((one) => one.steps), result.steps);
  });

  it('folds a case that asserts nothing into the one it prepares', async () => {
    // A run of steps with no assertion is not a case — run on its own it would
    // pass whether or not the feature works. It is preparation for what follows.
    const result = await authorOf([
      step('click', 'sign in', 'press continue'),
      step('click', 'filtering', 'open the filter'),
      step('expectVisible', 'filtering', 'the filtered table'),
    ]);

    assert.deepEqual(result.cases?.map((one) => one.name), ['filtering']);
    assert.equal(result.cases?.[0]?.steps.length, 3);
    const first = result.cases?.[0]?.steps[0];
    assert.equal(first?.action === 'click' ? first.intent : undefined, 'press continue');
  });

  it('folds a trailing case that asserts nothing back into the previous one', async () => {
    const result = await authorOf([
      step('expectVisible', 'filtering', 'the filtered table'),
      step('click', 'tidy up', 'close the panel'),
    ]);

    assert.deepEqual(result.cases?.map((one) => one.name), ['filtering']);
    assert.equal(result.cases?.[0]?.steps.length, 2);
  });

  it('keeps two runs of the same name apart instead of re-ordering the body', async () => {
    // Gathering them would move steps past ones they depend on. They are two
    // cases; the report has to be able to tell them apart.
    const result = await authorOf([
      step('expectVisible', 'rows', 'rows before'),
      step('expectVisible', 'export', 'the download appears'),
      step('expectVisible', 'rows', 'rows after'),
    ]);

    assert.deepEqual(result.cases?.map((one) => one.name), ['rows', 'export', 'rows (2)']);
  });

  it('gives every case the shared setup and teardown, so none depends on another', async () => {
    const authored = await new FlowAuthor({
      model: {
        id: 'stub',
        author: async () => ({
          name: 'catalog',
          rationale: 'r',
          setup: [{ action: 'goto', url: '/rules' }],
          steps: [
            { action: 'expectVisible', selector: 'role=table', intent: 'the table' },
            { action: 'expectVisible', selector: 'role=alert', intent: 'the banner' },
          ],
          cases: [
            { name: 'the table', steps: [{ action: 'expectVisible', selector: 'role=table', intent: 'the table' }] },
            { name: 'the banner', steps: [{ action: 'expectVisible', selector: 'role=alert', intent: 'the banner' }] },
          ],
          teardown: [{ action: 'clearStorage' }],
          notes: '',
          droppedSteps: 0,
        }),
      },
    }).author('prove the catalog');

    const flows = caseFlows(authored);

    assert.deepEqual(flows.map((one) => one.name), ['the table', 'the banner']);
    // Setup runs again before each: that is what makes case 2 independent of
    // whatever case 1 left behind.
    for (const { flow } of flows) {
      assert.deepEqual(flow.setup, [{ action: 'goto', url: '/rules' }]);
      assert.deepEqual(flow.teardown, [{ action: 'clearStorage' }]);
      assert.equal(flow.steps.length, 1);
    }
    assert.deepEqual(flows.map((one) => one.flow.name), ['catalog — the table', 'catalog — the banner']);
  });

  it('leaves an undivided flow’s name alone, so its history is not split in two', async () => {
    const authored = await new FlowAuthor({
      model: {
        id: 'stub',
        author: async () => ({
          name: 'catalog',
          rationale: 'r',
          setup: [],
          steps: [{ action: 'expectVisible', selector: 'role=table', intent: 'the table' }],
          teardown: [],
          notes: '',
          droppedSteps: 0,
        }),
      },
    }).author('prove the catalog');

    const flows = caseFlows(authored);

    assert.equal(flows.length, 1);
    assert.equal(flows[0]?.flow.name, 'catalog');
  });

  it('hands a body that asserts nothing at all back whole, for FlowAuthor to refuse', async () => {
    // Inventing a case here would turn "this proves nothing" into a green run.
    const steps = [step('click', 'a', 'press one'), step('click', 'b', 'press two')];
    const result = await authorOf(steps);

    assert.equal(result.cases?.length, 1);
    assert.equal(result.cases?.[0]?.steps.length, 2);

    await assert.rejects(
      () =>
        new FlowAuthor({
          model: { id: 'stub', author: async () => result },
        }).author('prove the catalog'),
      (error: unknown) => error instanceof AuthoringError && /no assertion/.test((error as Error).message),
    );
  });
});

// --- the post-submit synchronization lint -----------------------------------

describe('unsynchronizedLoginSubmit', () => {
  const fillPassword: FlowStep = {
    action: 'fill',
    selector: 'role=textbox >> nth=1',
    value: 'admin2026',
    intent: 'Fill admin password',
  };
  const click: FlowStep = { action: 'click', selector: 'role=button[name="Sign in" i]' };
  const goto: FlowStep = { action: 'goto', url: '/en/admin/benefits/plans' };

  it('flags a credential submit followed immediately by a goto', () => {
    // The live failure shape: the click can land before hydration, the form
    // submits natively, and nothing between click and goto would notice.
    const at = unsynchronizedLoginSubmit([
      { action: 'goto', url: '/en/login' },
      { action: 'fill', selector: 'input[type=email]', value: 'admin@cnext.test', intent: 'email' },
      fillPassword,
      click,
      goto,
    ]);
    assert.equal(at, 3, 'the click is the offender, by index');
  });

  it('is satisfied by any check between the click and the goto', () => {
    for (const guard of [
      { action: 'expectUrl', value: '/en/admin' } as FlowStep,
      { action: 'expectVisible', selector: 'role=button[name="Sign out"]' } as FlowStep,
      { action: 'waitFor', selector: 'role=navigation' } as FlowStep,
    ]) {
      assert.equal(
        unsynchronizedLoginSubmit([fillPassword, click, guard, goto]),
        null,
        `${guard.action} between click and goto must satisfy the rule`,
      );
    }
  });

  it('never fires without a credential-shaped fill', () => {
    const search: FlowStep = { action: 'fill', selector: 'role=searchbox', value: 'leave', intent: 'search' };
    assert.equal(unsynchronizedLoginSubmit([search, click, goto]), null);
  });

  it('a non-click step between the fill and a later click ends the block', () => {
    const wait: FlowStep = { action: 'waitFor', selector: 'role=main' };
    assert.equal(unsynchronizedLoginSubmit([fillPassword, wait, click, goto]), null);
  });

  it('feeds the informed re-ask through FlowAuthor', async () => {
    // Two-shot model: the first answer navigates straight off the submit, the
    // second (which must have been told why) adds the check. Same seam as the
    // healer's `rejected` — the value of a retry is in the ask that knows.
    const asked: AuthorRequest[] = [];
    const bad: Partial<AuthorResult> = {
      setup: [],
      steps: [
        { action: 'goto', url: '/en/login' },
        { action: 'fill', selector: 'input[type=email]', value: 'a@b.c', intent: 'email' },
        { action: 'fill', selector: 'input[type=password]', value: 's3cret', intent: 'password' },
        { action: 'click', selector: 'role=button[name="Sign in" i]' },
        { action: 'goto', url: '/en/plans' },
        { action: 'expectVisible', selector: 'role=table', intent: 'the table' },
      ],
    };
    const good: Partial<AuthorResult> = {
      steps: [
        { action: 'goto', url: '/en/login' },
        { action: 'fill', selector: 'input[type=email]', value: 'a@b.c', intent: 'email' },
        { action: 'fill', selector: 'input[type=password]', value: 's3cret', intent: 'password' },
        { action: 'click', selector: 'role=button[name="Sign in" i]' },
        { action: 'expectUrl', value: '/en/home', intent: 'the login took' },
        { action: 'goto', url: '/en/plans' },
        { action: 'expectVisible', selector: 'role=table', intent: 'the table' },
      ],
    };
    const model: FlowAuthorModel = {
      id: 'stub:two-shot',
      async author(request) {
        asked.push(request);
        return {
          name: 'login then plans',
          rationale: '',
          setup: [],
          teardown: [],
          notes: '',
          droppedSteps: 0,
          steps: [],
          ...(asked.length === 1 ? bad : good),
        } as AuthorResult;
      },
    };

    const authored = await new FlowAuthor({ model }).author('check the plans page as admin');

    assert.equal(asked.length, 2, 'one informed re-ask');
    assert.match(
      asked[1]?.feedback?.join(' ') ?? '',
      /sign-in submit|hydrat/i,
      'the second ask carries the refusal',
    );
    assert.equal(authored.flow.steps.some((s) => s.action === 'expectUrl'), true);
  });
});

// --- the deliberate-HTTP family and friends, authored flat -------------------

describe('authoring request / expectStatus / expectJson / expectDbCount / setClock / modals', () => {
  const flat = (over: Record<string, string>) => ({
    action: '',
    selector: '',
    value: '',
    url: '',
    key: '',
    name: '',
    intent: 'step',
    ...over,
  });

  const authorWith = async (
    steps: Record<string, string>[],
    options: { policy?: 'read-only' | 'forms' | 'mutations'; tables?: boolean } = {},
  ) => {
    const model = new LlmFlowAuthorModel({
      model: jsonModel(
        'mock-author',
        {
          name: 'backend claims',
          rationale: '',
          setup: [],
          steps,
          teardown: [],
          notes: '',
        },
        { inputTokens: 0, outputTokens: 0 },
      ),
      id: 'mock:author',
    });
    return model.author({
      prompt: 'prove the backend claims',
      policy: options.policy ?? 'mutations',
      ...(options.tables === false
        ? {}
        : { tables: [{ name: 'benefit_management.benefit_plan', summary: 'id, status' }] }),
    });
  };

  it('narrows a request with saves, and parses a JSON body into the object', async () => {
    const result = await authorWith([
      flat({ action: 'request', name: 'POST /api/db/seed', key: 'n = $.plans.updated' }),
      flat({ action: 'request', name: 'POST /api/echo', value: '{"a":1}' }),
    ]);
    assert.equal(result.droppedSteps, 0);
    const [seed, echo] = result.steps;
    assert.deepEqual(seed, {
      action: 'request',
      method: 'POST',
      url: '/api/db/seed',
      save: { n: '$.plans.updated' },
      intent: 'step',
    });
    assert.equal(echo?.action === 'request' && (echo.body as { a: number }).a, 1);
  });

  it('DELETE is dropped at every policy tier, and writes need more than read-only', async () => {
    for (const policy of ['read-only', 'forms', 'mutations'] as const) {
      const result = await authorWith(
        [flat({ action: 'request', name: 'DELETE /api/x' })],
        { policy },
      );
      assert.equal(result.steps.length, 0, `DELETE must be dropped under ${policy}`);
    }
    const readOnly = await authorWith(
      [
        flat({ action: 'request', name: 'POST /api/db/seed' }),
        flat({ action: 'request', name: 'GET /api/db/health' }),
      ],
      { policy: 'read-only' },
    );
    assert.equal(readOnly.steps.length, 1, 'only the GET survives read-only');
    assert.equal(readOnly.steps[0]?.action === 'request' && readOnly.steps[0].method, 'GET');
  });

  it('a save that is not a JSON path drops the step rather than saving nothing', async () => {
    const result = await authorWith([
      flat({ action: 'request', name: 'GET /api/db/health', key: 'n = counts.persons' }),
    ]);
    assert.equal(result.steps.length, 0);
    assert.equal(result.droppedSteps, 1);
  });

  it('narrows expectStatus and expectJson, and refuses what it cannot use', async () => {
    const result = await authorWith([
      flat({ action: 'expectStatus', value: '200' }),
      flat({ action: 'expectStatus', value: 'ok' }),
      flat({ action: 'expectJson', key: '$.counts.persons', value: '98' }),
      flat({ action: 'expectJson', key: '$.ok' }),
      flat({ action: 'expectJson', key: 'counts.persons', value: '98' }),
    ]);
    assert.deepEqual(result.steps, [
      { action: 'expectStatus', status: 200, intent: 'step' },
      { action: 'expectJson', path: '$.counts.persons', value: '98', intent: 'step' },
      { action: 'expectJson', path: '$.ok', intent: 'step' },
    ]);
    assert.equal(result.droppedSteps, 2);
  });

  it('expectDbCount narrows to an exact-count expectDbRow, variables surviving as strings', async () => {
    const result = await authorWith([
      flat({ action: 'expectDbCount', name: 'benefit_management.benefit_plan', value: '36' }),
      flat({ action: 'expectDbCount', name: 'benefit_management.benefit_plan', value: '{{n}}' }),
      flat({ action: 'expectDbCount', name: 'benefit_management.benefit_plan', value: 'lots' }),
    ]);
    assert.deepEqual(result.steps, [
      { action: 'expectDbRow', table: 'benefit_management.benefit_plan', where: {}, count: 36, intent: 'step' },
      { action: 'expectDbRow', table: 'benefit_management.benefit_plan', where: {}, count: '{{n}}', intent: 'step' },
    ]);
    assert.equal(result.droppedSteps, 1);
  });

  it('expectDbCount obeys the same structural DB permission as every DB step', async () => {
    const result = await authorWith(
      [flat({ action: 'expectDbCount', name: 'benefit_plan', value: '36' })],
      { tables: false },
    );
    assert.equal(result.steps.length, 0, 'no inventory, no DB step — filter, not sentence');
  });

  it('narrows setClock and refuses a time the clock cannot be pinned to', async () => {
    const result = await authorWith([
      flat({ action: 'setClock', value: '2026-08-01' }),
      flat({ action: 'setClock', value: 'the day before the demo' }),
    ]);
    assert.deepEqual(result.steps, [{ action: 'setClock', time: '2026-08-01', intent: 'step' }]);
    assert.equal(result.droppedSteps, 1);
  });

  it('narrows expectModal and closeModal', async () => {
    const result = await authorWith([
      flat({ action: 'expectModal', name: 'Edit rule' }),
      flat({ action: 'expectModal' }),
      flat({ action: 'closeModal', selector: 'role=button[name="Close"]' }),
    ]);
    assert.deepEqual(result.steps, [
      { action: 'expectModal', name: 'Edit rule', intent: 'step' },
      { action: 'expectModal', intent: 'step' },
      // The button selector rides the same accessible-name case relaxation as
      // every other selector written from a tree name.
      { action: 'closeModal', button: 'role=button[name="Close" i]', intent: 'step' },
    ]);
  });
});

// --- the uncaptured-page teachings must actually reach the model -------------

describe('the system prompt teaches the uncaptured-page rules', () => {
  it('workflow-for-uncaptured-legs, the disclosure corollaries, and the one-page rule are sent', async () => {
    // DB_04_01/DB_06_01/DB_07_01: the capture only ever sees the login page,
    // so modal fields and row buttons are structurally absent from the tree —
    // these teachings are what let such claims be authored honestly instead
    // of asserted-but-never-performed. A prompt edit that silently fails to
    // reach the wire is a teaching that never happened.
    const mock = jsonModel(
      'mock-author',
      { name: 'x', rationale: '', setup: [], steps: [], teardown: [], notes: '' },
      { inputTokens: 0, outputTokens: 0 },
    );
    const model = new LlmFlowAuthorModel({ model: mock, id: 'mock:author' });
    await model.author({ prompt: 'edit the rule', policy: 'forms', axTree: 'button "Sign in"' });

    // The prompt hard-wraps at the vocabulary column, so phrases span line
    // breaks — normalise the whole recorded call to single spaces before
    // matching, or every assertion is hostage to where a line happens to wrap.
    const sent = JSON.stringify(
      (mock as unknown as { doGenerateCalls: unknown[] }).doGenerateCalls[0],
    )
      .replace(/\\n/g, ' ')
      .replace(/\s+/g, ' ');
    assert.match(sent, /evidence INDEPENDENT of the agent/);
    assert.match(sent, /never use workflow where the tree shows them/i);
    assert.match(sent, /NEVER follow a disclosure with an assertion/);
    assert.match(sent, /a request is a real HTTP call/i);
    assert.match(sent, /The tree describes ONE page state/);
  });
});

describe('a CSS comment is not a selector', () => {
  it('drops a step whose selector is commentary about a missing control', async () => {
    // The live shape (DB_08_01): the model "declined" by emitting
    // `/* selector for RULE-FUEL-002 row not found */`, which reached
    // Playwright as a parse error, three times, plus the reconstruction
    // budget. A comment has no selector; the step must be dropped and
    // counted, like every other unusable emission.
    const model = new LlmFlowAuthorModel({
      model: jsonModel(
        'mock-author',
        {
          name: 'comments are not selectors',
          rationale: '',
          setup: [],
          steps: [
            {
              action: 'expectHidden',
              selector: '/* selector for RULE-FUEL-002 row not found in accessibility tree */',
              value: '',
              url: '',
              key: '',
              name: '',
              intent: 'cannot be asserted',
            },
            {
              action: 'expectVisible',
              selector: 'role=table',
              value: '',
              url: '',
              key: '',
              name: '',
              intent: 'the manager renders',
            },
          ],
          teardown: [],
          notes: '',
        },
        { inputTokens: 0, outputTokens: 0 },
      ),
      id: 'mock:author',
    });
    const result = await model.author({ prompt: 'check the rule manager' });
    assert.deepEqual(result.steps, [
      { action: 'expectVisible', selector: 'role=table', intent: 'the manager renders' },
    ]);
    assert.equal(result.droppedSteps, 1);
  });
});

describe('the backend toggle', () => {
  /** The flat authored shape, as the model actually returns it. */
  const authored = {
    name: 'PL_03_03 count check',
    rationale: 'the card must agree with the data behind it',
    notes: '',
    setup: [],
    steps: [
      { action: 'request', selector: '', value: '', url: '', key: 'n = $.counts.hr', name: 'GET /api/benefit-plans', intent: 'read the count' },
      { action: 'expectStatus', selector: '', value: '200', url: '', key: '', name: '', intent: 'the endpoint answers' },
      { action: 'expectDbRow', selector: '', value: '', url: '', key: 'benefit_type = REIMBURSEMENT_HR', name: 'benefit_management.benefit_plan', intent: 'the row count' },
      { action: 'expectVisible', selector: 'text=REIMBURSEMENT BY HR', value: '', url: '', key: '', name: '', intent: 'backend could prove this: the count on screen should equal the benefit_plan rows of that type' },
    ],
    teardown: [],
  };
  const tables = [{ name: 'benefit_management.benefit_plan', summary: 'benefit_plan_id, benefit_type, status' }];
  const authorModel = () =>
    new LlmFlowAuthorModel({
      model: jsonModel('mock-author', authored, { inputTokens: 100, outputTokens: 40 }),
      id: 'mock:author',
    });

  it('writes no backend step when the run says backend is off, and says why', async () => {
    // The person turned the backend off; the claim is still proved, on screen.
    const result = await authorModel().author({
      prompt: 'check the Reimbursement by HR count',
      backend: false,
      tables,
    });

    assert.deepEqual(
      result.steps.map((step) => step.action),
      ['expectVisible'],
      'every HTTP and database step is dropped',
    );
    assert.equal(result.droppedSteps, 3);
    // The model is told WHY, in words it can act on next attempt — and all
    // three get the same reason, because they were dropped for one.
    assert.ok(
      result.dropped.every((one) => one.reason === BACKEND_OFF_REASON),
      JSON.stringify(result.dropped),
    );
    // The claim still has a proof, so this is not a vacuous flow.
    assert.equal(vacuousFlow({ steps: result.steps, setup: result.setup }), null);
  });

  it('leaves the backend family alone when the toggle is on (the default)', async () => {
    const result = await authorModel().author({
      prompt: 'check the Reimbursement by HR count against the database',
      tables,
    });
    assert.deepEqual(
      result.steps.map((step) => step.action),
      ['request', 'expectStatus', 'expectDbRow', 'expectVisible'],
      'absent means yes — what every caller meant before the toggle existed',
    );
  });

  it('names the backend rule in the prompt only when the toggle is off', () => {
    const off = buildUserPrompt({ prompt: 'a claim', backend: false });
    assert.match(off, /BACKEND TESTING IS OFF/);
    assert.match(off, /backend could prove this: /, 'and how to mark the step it settles visually');
    assert.doesNotMatch(buildUserPrompt({ prompt: 'a claim' }), /BACKEND TESTING IS OFF/);
  });
});

describe('wordingClaimAssertsDataValue', () => {
  const claim = 'PL_02_02 ตรวจสอบความถูกต้องของข้อความในหน้า Benefit Plan Catalog — menu: HR > Benefits Admin > Benefit Plans; expected: 2.1 ข้อความสะกดถูกต้องตรงตาม Spec';
  const tree = [
    'heading "Benefit Plan Catalog"',
    'link "Benefits Admin" url="/en/admin/benefits"',
    'columnheader "Benefit Name"',
    'button "Create Plan"',
    'cell "TH_MED_001"',
    'cell "Medical Reimbursement"',
  ].join('\n');

  it('refuses a wording claim asserted on a row value the sheet never states (PL_02_02)', () => {
    const steps: FlowStep[] = [
      { action: 'goto', url: '/en/admin/benefits/plans' },
      { action: 'expectVisible', selector: 'text=Medical Reimbursement' },
    ];
    assert.deepEqual(wordingClaimAssertsDataValue(claim, steps, tree), { index: 1, value: 'Medical Reimbursement' });
    // expectText carries the value in `value`.
    assert.equal(
      wordingClaimAssertsDataValue(claim, [{ action: 'expectText', selector: 'role=table', value: 'Medical Reimbursement' }], tree)?.value,
      'Medical Reimbursement',
    );
  });

  it('accepts labels the sheet names or the tree shows outside a data row', () => {
    const steps: FlowStep[] = [
      { action: 'expectVisible', selector: 'text="Benefit Plans"' },
      { action: 'expectVisible', selector: 'text="Benefits Admin"' },
      { action: 'expectVisible', selector: 'text=Create Plan' },
      { action: 'expectText', selector: 'role=columnheader', value: 'Benefit Name' },
      { action: 'expectVisible', selector: 'role=heading[name="Benefit Plan Catalog" i]' },
    ];
    assert.equal(wordingClaimAssertsDataValue(claim, steps, tree), null);
  });

  it('never fires for a claim that is not about wording', () => {
    const steps: FlowStep[] = [{ action: 'expectVisible', selector: 'text=Medical Reimbursement' }];
    assert.equal(wordingClaimAssertsDataValue('PL_04_03 filter by benefit name shows the matching plan', steps, tree), null);
  });
});

describe('wordingClaimAssertsDataValue', () => {
  const claim =
    'PL_02_02 ตรวจสอบความถูกต้องของข้อความในหน้า Benefit Plan Catalog — expected: 2.1 ข้อความสะกดถูกต้องตรงตาม Spec';
  const tree = [
    'heading "Benefit Plan Catalog"',
    'link "Benefits Admin" url="/en/admin/benefits"',
    'columnheader "Benefit Name"',
    'button "Create Plan"',
    'cell "TH_MED_001"',
    'cell "Medical Reimbursement"',
  ].join('\n');

  it('refuses a wording claim asserted on a row value (PL_02_02)', () => {
    // The plan name is in the tree — as a CELL. A row is data: a sibling
    // delete case removed TH_MED_001 45 minutes after this was authored, and
    // the case dead-ended against a correctly worded page.
    const steps: FlowStep[] = [
      { action: 'goto', url: '/en/admin/benefits/plans' },
      { action: 'expectVisible', selector: 'text=Medical Reimbursement' },
    ];
    assert.deepEqual(wordingClaimAssertsDataValue(claim, steps, tree), {
      index: 1,
      value: 'Medical Reimbursement',
    });
    assert.equal(
      wordingClaimAssertsDataValue(
        claim,
        [{ action: 'expectText', selector: 'role=table', value: 'Medical Reimbursement' }],
        tree,
      )?.value,
      'Medical Reimbursement',
    );
  });

  it('accepts labels the spec owns — heading, breadcrumb, column, button', () => {
    // The shape the earlier authorings of PL_02_02 used, which proved.
    const steps: FlowStep[] = [
      { action: 'expectVisible', selector: 'text="Benefit Plan Catalog"' },
      { action: 'expectVisible', selector: 'text="Benefits Admin"' },
      { action: 'expectVisible', selector: 'text=Create Plan' },
      { action: 'expectText', selector: 'role=columnheader', value: 'Benefit Name' },
    ];
    assert.equal(wordingClaimAssertsDataValue(claim, steps, tree), null);
  });

  it('says nothing for a non-wording claim, or with no tree to judge against', () => {
    const steps: FlowStep[] = [{ action: 'expectVisible', selector: 'text=Medical Reimbursement' }];
    assert.equal(wordingClaimAssertsDataValue('PL_04_03 filter by benefit name', steps, tree), null);
    // Ungrounded authoring cannot tell a label from a row — silence, never a
    // refusal of every honest wording flow.
    assert.equal(wordingClaimAssertsDataValue(claim, steps, ''), null);
  });
});

describe('ungroundedGoto', () => {
  const routes = ['/:locale/admin/benefits/plans', '/:locale/admin/benefits', '/:locale/login'];

  it('refuses a navigation to a page the codebase does not declare, and names the near miss', () => {
    // be100 PL_02_03: the flow went to a path that answered 404, and every
    // step after it failed against the error page — attributed to the app.
    const found = ungroundedGoto(
      [
        { action: 'goto', url: '/en/login' },
        { action: 'goto', url: '/en/admin/benefits/plans/create' },
      ],
      routes,
    );
    assert.equal(found?.index, 1);
    assert.equal(found?.url, '/en/admin/benefits/plans/create');
    assert.equal(found?.near[0], '/:locale/admin/benefits/plans', 'the refusal carries what they meant');
  });

  it('accepts a declared route, whatever its concrete parameters', () => {
    assert.equal(
      ungroundedGoto([{ action: 'goto', url: 'http://localhost:3000/en/admin/benefits/plans' }], routes, 'http://localhost:3000'),
      null,
    );
    assert.equal(ungroundedGoto([{ action: 'goto', url: '/th/login' }], routes), null, ':locale matches any locale');
  });

  it('keeps no opinion without an index, or about another origin', () => {
    // Silence is the rule everywhere the evidence runs out: a repo that
    // declares nothing cannot contradict anything.
    assert.equal(ungroundedGoto([{ action: 'goto', url: '/en/whatever' }], []), null);
    assert.equal(
      ungroundedGoto([{ action: 'goto', url: 'https://accounts.google.com/signin' }], routes, 'http://localhost:3000'),
      null,
      "another origin is not this application's routing table's business",
    );
  });
});

describe('unindexedRequestMethod', () => {
  // What the repository declares once its file-convention router is read for
  // methods: `/api/benefit-plans` answers writes only.
  const declared = [
    'POST /api/benefit-plans',
    'PUT /api/benefit-plans',
    'DELETE /api/benefit-plans',
    'GET /api/db/health',
  ];

  it('refuses the PL_03_03 shape: GET on a path that declares only writes', () => {
    const steps: FlowStep[] = [
      { action: 'goto', url: '/en/admin/benefits/plans' },
      { action: 'request', method: 'GET', url: 'http://localhost:3000/api/benefit-plans' },
    ];
    assert.deepEqual(unindexedRequestMethod(steps, declared), {
      index: 1,
      method: 'GET',
      path: '/api/benefit-plans',
      declared: ['DELETE', 'POST', 'PUT'],
    });
  });

  it('accepts a declared method, and ignores the origin and query string', () => {
    assert.equal(
      unindexedRequestMethod(
        [{ action: 'request', method: 'POST', url: 'http://localhost:3000/api/benefit-plans?dry=1' }],
        declared,
      ),
      null,
    );
    assert.equal(
      unindexedRequestMethod([{ action: 'request', method: 'get', url: '/api/db/health' }], declared),
      null,
      'the method is compared case-insensitively',
    );
    // A GET handler answers HEAD in every framework this indexes.
    assert.equal(
      unindexedRequestMethod([{ action: 'request', method: 'HEAD', url: '/api/db/health' }], declared),
      null,
    );
  });

  it('says nothing about a path the index does not declare, or with no index at all', () => {
    // Silence is the rule: an endpoint outside the index may be a proxy, a
    // service on another host, or an unindexed repo — and a refusal there
    // would block honest tests.
    assert.equal(
      unindexedRequestMethod([{ action: 'request', method: 'GET', url: '/api/not-indexed' }], declared),
      null,
    );
    assert.equal(
      unindexedRequestMethod([{ action: 'request', method: 'GET', url: '/api/benefit-plans' }], []),
      null,
    );
  });
});

describe('run-4 vacuity lints', () => {
  it('dbClaimWithoutDbCheck fires only for a DB-comparison claim with tables and no DB step', () => {
    const steps: FlowStep[] = [
      { action: 'request', method: 'GET', url: '/api/db/health' },
      { action: 'expectJson', path: '$.counts', intent: 'counts exist' },
    ];
    assert.equal(
      dbClaimWithoutDbCheck('counts must match the database exactly', steps, true),
      'unused',
    );
    // With a DB check present the claim is being compared for real.
    assert.equal(
      dbClaimWithoutDbCheck('counts must match the database exactly', [
        ...steps,
        { action: 'expectDbRow', table: 't', where: {}, count: '{{n}}' },
      ], true),
      false,
    );
    // No inventory now REFUSES rather than passing through. The old reasoning
    // here — "the disclosure in cmdCatalog covers that case" — was disproved
    // live: cmdCatalog's warning is a stdout line, and DB_01_01 still reported
    // a green pass for "counts match the database exactly" having read no
    // count at all. A warning that does not change the verdict is not cover.
    assert.equal(
      dbClaimWithoutDbCheck('counts must match the database exactly', steps, false),
      'no-schema',
    );
    // A claim with no DB comparison never fires.
    assert.equal(dbClaimWithoutDbCheck('the table renders its rows', steps, true), false);
  });

  it('loginProofAssertsLoginPage flags a post-submit expectUrl of the sign-in path itself', () => {
    const login: FlowStep[] = [
      { action: 'goto', url: '/en/login' },
      { action: 'fill', selector: 'input[type=email]', value: 'a@b.c', intent: 'email' },
      { action: 'fill', selector: 'input[type=password]', value: 'pw', intent: 'password' },
      { action: 'click', selector: 'role=button[name="Sign in" i]' },
    ];
    assert.equal(
      loginProofAssertsLoginPage([
        ...login,
        { action: 'expectUrl', value: '/en/login', intent: 'redirected away (sic)' },
      ]),
      4,
    );
    assert.equal(
      loginProofAssertsLoginPage([
        ...login,
        { action: 'expectUrl', value: '/en/admin', intent: 'redirected away' },
      ]),
      null,
    );
  });

  it('normalizes the non-breaking hyphen a model typesets into ids', async () => {
    const model = new LlmFlowAuthorModel({
      model: jsonModel(
        'mock-author',
        {
          name: 'hyphens',
          rationale: '',
          setup: [],
          steps: [
            {
              action: 'expectVisible',
              selector: 'text=RULE‑FUEL‑002',
              value: '',
              url: '',
              key: '',
              name: '',
              intent: 'the fuel rule renders',
            },
          ],
          teardown: [],
          notes: '',
        },
        { inputTokens: 0, outputTokens: 0 },
      ),
      id: 'mock:author',
    });
    const result = await model.author({ prompt: 'check the fuel rule' });
    assert.deepEqual(result.steps[0], {
      action: 'expectVisible',
      selector: 'text=RULE-FUEL-002',
      intent: 'the fuel rule renders',
    });
  });
});


/**
 * The three lints written from a hand-authored flow that was run against a
 * real application until it passed. Each refuses a shape that costs a run
 * something real, and each names the measurement in its own doc comment.
 */
describe('countPinnedName', () => {
  it('refuses a live count pinned inside an accessible name', () => {
    const steps: FlowStep[] = [
      { action: 'expectVisible', selector: 'role=tab[name="Status (1)" i]' },
    ];
    assert.deepEqual(countPinnedName(steps), { index: 0, name: 'Status (1)' });
  });

  it('leaves a name that merely contains a number alone', () => {
    // "OT Day 1" and "Step 2 of 4" are identities, not counts. Only the
    // trailing parenthesised form is the count idiom.
    const steps: FlowStep[] = [
      { action: 'fill', selector: 'role=textbox[name="Start date OT day 1" i]', value: '2026-08-18' },
      { action: 'click', selector: 'role=button[name="Step 2 of 4" i]' },
      { action: 'click', selector: 'role=tab >> text=Status' },
    ];
    assert.equal(countPinnedName(steps), null);
  });
});

describe('volatileCountAssertion', () => {
  it('refuses a bare number read off the tree that the request never states', () => {
    const steps: FlowStep[] = [
      { action: 'goto', url: '/en/admin/benefits/plans' },
      { action: 'expectVisible', selector: 'text="75"' },
    ];
    assert.deepEqual(
      volatileCountAssertion(steps, 'ตรวจสอบจำนวน Total plans ปัจจุบัน'),
      { index: 1, value: '75' },
    );
  });

  it('a number the request itself states is the claim, and stands', () => {
    // The sheet's word is the claim — refusing it would untest the case.
    const steps: FlowStep[] = [{ action: 'expectText', selector: 'role=status', value: '120' }];
    assert.equal(volatileCountAssertion(steps, 'the days-remaining tile shows 120'), null);
  });

  it('ignores expectCount, labeled text, and non-expect steps', () => {
    const steps: FlowStep[] = [
      { action: 'expectCount', selector: 'role=row', count: 15 } as unknown as FlowStep,
      { action: 'expectVisible', selector: 'text=Total plans' },
      { action: 'fill', selector: 'role=textbox[name="Amount" i]', value: '500' },
      { action: 'expectText', selector: 'role=heading', value: 'Benefit Plan Catalog' },
    ];
    assert.equal(volatileCountAssertion(steps, 'check the catalog'), null);
  });

  it('catches the unquoted selector form too', () => {
    const steps: FlowStep[] = [{ action: 'expectVisible', selector: 'text=68' }];
    assert.deepEqual(volatileCountAssertion(steps, 'reimbursement tile is present'), {
      index: 0,
      value: '68',
    });
  });
});

describe('interruptedCredentialSubmit', () => {
  const fillEmail: FlowStep = { action: 'fill', selector: 'role=textbox[name="Work email" i]', value: 'a@b.test' };
  const fillPassword: FlowStep = { action: 'fill', selector: 'role=textbox >> nth=1', value: 'pw', intent: 'password' };
  const submit: FlowStep = { action: 'click', selector: 'role=button[name="Sign in" i]' };

  it('refuses an assertion wedged between the credentials and the submit', () => {
    // Measured: one expectValue in this gap stopped the hydration replay from
    // firing and the login stopped working entirely.
    const steps: FlowStep[] = [
      fillEmail,
      fillPassword,
      { action: 'expectValue', selector: 'role=textbox >> nth=1', value: 'pw' },
      submit,
    ];
    assert.deepEqual(interruptedCredentialSubmit(steps), { index: 2, click: 3 });
  });

  it('accepts the adjacent form the engine can replay', () => {
    const steps: FlowStep[] = [
      fillEmail,
      fillPassword,
      submit,
      { action: 'expectUrl', value: '/en/home' },
    ];
    assert.equal(interruptedCredentialSubmit(steps), null);
  });

  it('does not fire when no click follows before the next navigation', () => {
    const steps: FlowStep[] = [
      fillEmail,
      fillPassword,
      { action: 'expectVisible', selector: 'role=button[name="Sign in" i]' },
      { action: 'goto', url: '/en/home' },
    ];
    assert.equal(interruptedCredentialSubmit(steps), null);
  });
});

describe('unpinnedDateEntry', () => {
  const typesADate: FlowStep[] = [
    { action: 'fill', selector: '[data-testid="ot-start-date-0"]', value: '2026-08-18' },
  ];

  it('refuses a typed date when no clock is pinned', () => {
    assert.deepEqual(unpinnedDateEntry([], typesADate), { index: 0, value: '2026-08-18' });
  });

  it('accepts it once setup pins the clock', () => {
    const setup: FlowStep[] = [{ action: 'setClock', time: '2026-08-18T09:00:00Z' }];
    assert.equal(unpinnedDateEntry(setup, typesADate), null);
  });

  it('says nothing about a value that is not a date', () => {
    const steps: FlowStep[] = [
      { action: 'fill', selector: 'textarea', value: 'covering the 2026-08 close' },
      { action: 'fill', selector: 'role=textbox[name="Work email" i]', value: 'a@b.test' },
    ];
    assert.equal(unpinnedDateEntry([], steps), null);
  });
});


describe('unsettledWorkflowClaim', () => {
  const workflow: FlowStep = { action: 'workflow', goal: 'submit the overtime request' };

  it('refuses an agent leg that only an expectUrl follows', () => {
    // Measured: teaching the author not to claim a database it has no evidence
    // for correctly deleted an unfounded expectDbDelta — and left the flow
    // ending on expectUrl "/en", which passes whether or not anything was
    // submitted. Removing a wrong check is not an improvement by itself.
    const steps: FlowStep[] = [workflow, { action: 'expectUrl', value: '/en' }];
    assert.equal(unsettledWorkflowClaim(steps), 0);
  });

  it('accepts one settled by what the page shows', () => {
    const steps: FlowStep[] = [
      workflow,
      { action: 'expectText', selector: 'role=list', value: 'wowlidator evidence run' },
    ];
    assert.equal(unsettledWorkflowClaim(steps), null);
  });

  it('accepts one settled by the database', () => {
    const steps: FlowStep[] = [
      workflow,
      { action: 'expectDbDelta', table: 'ot_request', delta: 1, since: 'before' },
    ];
    assert.equal(unsettledWorkflowClaim(steps), null);
  });

  it('says nothing about a flow with no agent leg', () => {
    assert.equal(unsettledWorkflowClaim([{ action: 'expectUrl', value: '/en' }]), null);
  });
});


describe('loginProofCannotFail', () => {
  const signIn = (proof: string): FlowStep[] => [
    { action: 'goto', url: 'http://localhost:3200/en/login' },
    { action: 'fill', selector: 'role=textbox[name="Work email" i]', value: 'a@b.test' },
    { action: 'fill', selector: 'role=textbox >> nth=1', value: 'pw', intent: 'password' },
    { action: 'click', selector: 'role=button[name="Sign in" i]' },
    { action: 'expectUrl', value: proof },
  ];

  it('refuses a proof the login page itself satisfies', () => {
    // The one that shipped: "/en/login" contains "/en", so this passes exactly
    // as well when the sign-in was rejected. Measured — an authored flow with
    // an invented password reported 12/12 passed on the strength of it.
    assert.deepEqual(loginProofCannotFail(signIn('/en')), {
      index: 4,
      expected: '/en',
      loginUrl: 'http://localhost:3200/en/login',
    });
  });

  it('accepts a path the login page does not contain', () => {
    assert.equal(loginProofCannotFail(signIn('/en/home')), null);
  });

  it('says nothing when the proof is not a URL check at all', () => {
    const steps = [...signIn('/en/home').slice(0, 4), {
      action: 'expectVisible' as const,
      selector: 'role=button[name="Sign out" i]',
    }];
    assert.equal(loginProofCannotFail(steps), null);
  });

  it('says nothing about an expectUrl that follows no sign-in', () => {
    const steps: FlowStep[] = [
      { action: 'goto', url: 'http://localhost:3200/en/overtime' },
      { action: 'expectUrl', value: '/en' },
    ];
    assert.equal(loginProofCannotFail(steps), null);
  });
});


/**
 * The account an authored flow signs in as.
 *
 * Measured over nine authoring runs: with nothing in the prompt to say
 * otherwise, the model invented a password nine times out of nine. One run
 * died on "Sign-in failed with 'Incorrect password'"; a worse one reported
 * 12/12 passed, having failed the login and finished the journey on a session
 * an earlier run had left behind. So the credentials must reach the wire, as
 * their own block, and their absence must change nothing.
 */
describe('supplied credentials reach the model as their own labelled block', () => {
  function recordingModel() {
    const mock = jsonModel(
      'mock-author',
      { name: 'x', rationale: '', setup: [], steps: [], teardown: [], notes: '' },
      { inputTokens: 0, outputTokens: 0 },
    );
    const call = () =>
      (mock as unknown as { doGenerateCalls: { prompt: { role: string; content: unknown }[] }[] })
        .doGenerateCalls[0] ?? { prompt: [] };
    return {
      mock,
      model: new LlmFlowAuthorModel({ model: mock, id: 'mock:author' }),
      /** The whole call — system prompt included. */
      full: () => JSON.stringify(call()),
      /**
       * Just the user message. The system prompt names the section so the
       * model knows what to do with it, so a whole-call check could never tell
       * "the section was sent" from "the rule that mentions it was sent".
       */
      user: () => JSON.stringify(call().prompt.filter((part) => part.role !== 'system')),
    };
  }

  it('sends them verbatim, apart from the tree, with the never-invent rule', async () => {
    const { model, user, full } = recordingModel();
    await model.author({
      prompt: 'submit an overtime request',
      policy: 'forms',
      axTree: 'button "Sign in"',
      credentials: { email: 'employee@cnext.test', password: 'employee2026' },
    });
    const wire = user().replace(/\\n/g, ' ').replace(/\s+/g, ' ');

    assert.match(wire, /SIGN IN AS/, 'its own labelled section, like the tables and the repo index');
    assert.match(wire, /employee@cnext\.test/);
    assert.match(wire, /employee2026/, 'the password must arrive unaltered or it cannot be used');
    assert.match(wire, /use these characters exactly/i);
    assert.match(
      full().replace(/\\n/g, ' ').replace(/\s+/g, ' '),
      /never substitute one source's address for the other's/i,
      'and the system prompt forbids improving on them',
    );
  });

  it('keeps a password with colons in it whole', async () => {
    // The reason `parseCredentials` splits on the FIRST colon: truncating here
    // would hand the model a password that is wrong in a way nothing catches
    // until the sign-in fails.
    const { model, user } = recordingModel();
    await model.author({
      prompt: 'sign in',
      policy: 'forms',
      credentials: { email: 'a@b.test', password: 'p:a:ss' },
    });
    assert.match(user(), /p:a:ss/);
  });

  it('changes nothing at all when none were supplied', async () => {
    // The `projectGraph` contract: omit it and the prompt is byte-for-byte
    // what it was before this existed.
    const request = { prompt: 'submit an overtime request', policy: 'forms' as const, axTree: 'button "Sign in"' };
    const bare = recordingModel();
    await bare.model.author({ ...request });
    const explicitlyNone = recordingModel();
    await explicitlyNone.model.author({ ...request, credentials: undefined });

    assert.equal(explicitlyNone.user(), bare.user());
    assert.equal(explicitlyNone.full(), bare.full(), 'the system prompt does not move either');
    assert.doesNotMatch(bare.user(), /SIGN IN AS/);
  });

  it('forwards what the FlowAuthor was constructed with', async () => {
    const model = stubModel({
      steps: [{ action: 'expectVisible', selector: 'role=table', intent: 'the table' }],
    });
    const author = new FlowAuthor({
      model,
      credentials: { email: 'employee@cnext.test', password: 'employee2026' },
    });
    await author.author('check the table renders');
    assert.deepEqual(model.seen?.credentials, {
      email: 'employee@cnext.test',
      password: 'employee2026',
    });
  });
});

/**
 * The journey tree — the page the DESCRIPTION is about, not the page the run
 * starts on.
 *
 * It exists because the start page is so often a login screen that the
 * journey's real controls were structurally invisible: 9 of 9 measured
 * authoring runs delegated the middle of the test to a `workflow` step. The
 * risk it introduces is mislabelling, so what these pin is the separation, not
 * the content.
 */
describe('a further page reaches the model as its own labelled section', () => {
  function recordingModel() {
    const mock = jsonModel(
      'mock-author',
      { name: 'x', rationale: '', setup: [], steps: [], teardown: [], notes: '' },
      { inputTokens: 0, outputTokens: 0 },
    );
    const call = () =>
      (mock as unknown as { doGenerateCalls: { prompt: { role: string; content: unknown }[] }[] })
        .doGenerateCalls[0] ?? { prompt: [] };
    return {
      model: new LlmFlowAuthorModel({ model: mock, id: 'mock:author' }),
      user: () => JSON.stringify(call().prompt.filter((part) => part.role !== 'system')),
    };
  }

  const base = {
    prompt: 'log in, then create an overtime request',
    policy: 'forms' as const,
    axTree: 'RootWebArea "Sign in"\nbutton "Sign in"',
  };

  it('keeps it apart from the start page tree, and says which page it is', async () => {
    const { model, user } = recordingModel();
    await model.author({
      ...base,
      journeyTree: 'ANOTHER PAGE IN THIS JOURNEY — the accessibility tree of http://app.test/en/overtime, which the request describes. It is NOT the page this run starts on.\n\nbutton "Submit"',
    });
    const wire = user().replace(/\\n/g, ' ').replace(/\s+/g, ' ');

    assert.match(wire, /Accessibility tree:/, 'the start page keeps its own heading');
    assert.match(wire, /ANOTHER PAGE IN THIS JOURNEY/);
    assert.match(wire, /http:\/\/app\.test\/en\/overtime/, 'the section names the page it read');
    assert.match(wire, /NOT the page this run starts on/);

    // Order is part of the separation: the start page's tree is what the early
    // steps are written against, so it must not be buried under a second one.
    assert.ok(
      wire.indexOf('Accessibility tree:') < wire.indexOf('ANOTHER PAGE IN THIS JOURNEY'),
      'the start page tree comes first',
    );
  });

  it('changes nothing at all when there is no second page', async () => {
    const withNone = recordingModel();
    await withNone.model.author(base);
    const explicitlyNone = recordingModel();
    await explicitlyNone.model.author({ ...base, journeyTree: undefined });

    assert.equal(explicitlyNone.user(), withNone.user());
    assert.doesNotMatch(withNone.user(), /ANOTHER PAGE/);
  });

  it('is forwarded by FlowAuthor from what it was constructed with', async () => {
    const { model, user } = recordingModel();
    const author = new FlowAuthor({
      model,
      journeyTree: 'ANOTHER PAGE IN THIS JOURNEY — tree of http://app.test/en/leave\n\nbutton "Apply"',
    });
    await author.author('submit a leave request').catch(() => undefined);
    assert.match(user(), /app\.test\/en\/leave/);
  });
});

/**
 * What happens when the attempt budget runs out.
 *
 * The lint set grew (count-pinned names, interrupted credential submits,
 * unpinned dates, vacuous login proofs, the CLI's DB-inventory gate) and the
 * measured cost was a prompt ending with NO flow at all — run B3, refused for
 * "contains no assertion" in 1 of 2 attempts, because removing the model's
 * easiest assertion left it nothing and there was one ask left to recover in.
 * These pin the two halves of the fix: more room to recover, and a thin answer
 * kept rather than thrown away.
 */
describe('best-attempt-wins across the authoring budget', () => {
  /** A model that answers differently on each attempt, and counts them. */
  function scripted(answers: Partial<AuthorResult>[]): FlowAuthorModel & { calls: number } {
    const model: FlowAuthorModel & { calls: number } = {
      id: 'scripted:author',
      calls: 0,
      async author() {
        const answer = answers[Math.min(model.calls, answers.length - 1)] ?? {};
        model.calls += 1;
        return {
          name: 'scripted flow',
          rationale: '',
          setup: [],
          steps: [],
          teardown: [],
          notes: '',
          droppedSteps: 0,
          ...answer,
        };
      },
    };
    return model;
  }

  /**
   * Refused as WEAK: an agent leg that nothing but a URL check follows. The
   * heading check in front of it is what keeps the flow a claim at all — a
   * flow whose ONLY assertions are a URL (or the sign-in proof) is the
   * vacuous shape, refused as fatal below, never accepted as thin.
   */
  const thin: Partial<AuthorResult> = {
    steps: [
      { action: 'expectVisible', selector: 'role=heading[name="Overtime"]' },
      { action: 'workflow', goal: 'submit the overtime request' },
      { action: 'expectUrl', value: '/en/overtime' },
    ],
  };

  it('accepts a thin flow at once, with the note, rather than re-asking', async () => {
    // A weak-only refusal used to spend the whole re-ask budget and then take
    // the first answer anyway — measured, the model could not see the page the
    // workflow leg ends on and came back with the same leg every time. Now the
    // workflow step records the page before and after the agent acted, so the
    // thin flow is accepted on the first call and the thinness is on `notes`.
    const model = scripted([thin, { steps: [{ action: 'click', selector: 'role=button' }] }]);
    const authored = await new FlowAuthor({ model }).author('submit an overtime request');

    assert.equal(model.calls, 1, 'a weak-only refusal costs one call, not the budget');
    assert.equal(authored.flow.steps.length, 3, 'the thin answer is kept');
    assert.match(
      authored.notes,
      /nothing checks what it did/,
      'and what it does not prove is recorded, not silently accepted',
    );
  });

  it('still refuses outright when every attempt was false rather than thin', async () => {
    // No assertion anywhere is a claim that cannot fail, and emitting it is
    // worse than emitting nothing — the one thing leniency must never reach.
    const model = scripted([{ steps: [{ action: 'click', selector: 'role=button' }] }]);
    await assert.rejects(
      new FlowAuthor({ model }).author('click the button'),
      (error: unknown) => error instanceof AuthoringError && /no assertion/.test((error as Error).message),
    );
    assert.equal(model.calls, AUTHOR_ATTEMPTS);
  });

  it('stops asking the moment an answer passes every lint', async () => {
    const model = scripted([
      { steps: [{ action: 'expectVisible', selector: 'role=heading[name="Overtime"]' }] },
    ]);
    const authored = await new FlowAuthor({ model }).author('check the overtime page');
    assert.equal(model.calls, 1, 'a clean answer costs one call, not the whole budget');
    assert.equal(authored.notes, '');
  });

  it('a weak refusal alongside a fatal one still refuses and re-asks', async () => {
    // Leniency is for thinness only. A flow that is thin AND says something
    // untrue (here: no assertion at all is fatal) goes back to the model with
    // both complaints, and the thin-but-true answer wins the budget.
    const model = scripted([
      { steps: [{ action: 'workflow', goal: 'submit it' }, { action: 'click', selector: 'role=button' }] },
      thin,
    ]);
    const authored = await new FlowAuthor({ model }).author('submit an overtime request');
    assert.equal(model.calls, 2, 'the fatal first answer is re-asked; the thin second is accepted');
    assert.equal(authored.flow.steps.length, 3);
    assert.match(authored.notes, /nothing checks what it did/);
  });

  it("refuses be100's vacuous shape outright: a workflow leg followed only by a URL check", async () => {
    // Measured, 2026-08-21: 20 of 22 `pass**` cases were login + goto +
    // workflow + expectUrl — green about rows whose Expected Output they never
    // touched. That shape is fatal through the whole budget; the case is
    // blocked and re-authored on a resume, never handed over.
    const model = scripted([
      {
        steps: [
          { action: 'workflow', goal: 'open the Type filter' },
          { action: 'expectUrl', value: '/en/admin/benefits/plans' },
        ],
      },
    ]);
    await assert.rejects(
      new FlowAuthor({ model }).author('PL_04_05 the Type filter lists Record and Reimbursement'),
      (error: unknown) => error instanceof AuthoringError && /proves nothing about its claim/.test((error as Error).message),
    );
    assert.equal(model.calls, AUTHOR_ATTEMPTS, 'every attempt was asked, with the reason');
  });
});

describe('the system prompt teaches that a captured second page is not absent', () => {
  it('names the ANOTHER PAGE IN THIS JOURNEY section as a source of grounded steps', async () => {
    // 9 of 9 measured authoring runs delegated the middle of the journey to a
    // workflow step, and the last one said why in its own notes: the later
    // pages "are absent from the initial login accessibility tree". Once
    // `--capture-journey` puts one of those pages IN the prompt, the workflow
    // guidance has to stop reading as licence to delegate anyway.
    const mock = jsonModel(
      'mock-author',
      { name: 'x', rationale: '', setup: [], steps: [], teardown: [], notes: '' },
      { inputTokens: 0, outputTokens: 0 },
    );
    const model = new LlmFlowAuthorModel({ model: mock, id: 'mock:author' });
    await model.author({ prompt: 'submit overtime', policy: 'forms', axTree: 'button "Sign in"' });

    const sent = JSON.stringify(
      (mock as unknown as { doGenerateCalls: unknown[] }).doGenerateCalls[0],
    )
      .replace(/\\n/g, ' ')
      .replace(/\s+/g, ' ');
    assert.match(sent, /ANOTHER PAGE IN THIS JOURNEY is present, that page is NOT absent/);
    assert.match(sent, /Write explicit grounded steps against its controls/);
  });
});


/**
 * The journey capture's sign-in: the decision to act, and the account of why
 * it declined to. The DOM half is browser-tier and has no fixture here — what
 * is unit-testable is the predicate that decides whether a login is attempted
 * at all, and the wording a person reads when it gives up. Both are pure, and
 * both are the parts that must not be got wrong: one guards a click on
 * someone's application, the other is the only record that a click happened.
 */
describe('a tree-notation selector is rewritten, not shipped', () => {
  it('turns StaticText[text="…"] into the text engine', async () => {
    // glm-4.5-flash writes the AX tree's own notation as a selector; as CSS it
    // matches a tag named StaticText, i.e. nothing, ever.
    const model = new LlmFlowAuthorModel({
      model: jsonModel('m', {
        name: 'f', rationale: '', notes: '',
        setup: [], teardown: [],
        steps: [
          { action: 'expectText', case: null, selector: 'StaticText[text="20 Jul 2026"]', value: '20 Jul 2026', url: '', key: '', name: '', intent: 'read the hire date' },
        ],
      }, { inputTokens: 0, outputTokens: 0 }),
      id: 'mock:author',
    });
    const result = await model.author({ prompt: 'x', policy: 'forms' });
    assert.deepEqual(result.steps[0], {
      action: 'expectText',
      selector: 'text="20 Jul 2026"',
      value: '20 Jul 2026',
      intent: 'read the hire date',
    });
  });
});

describe('fromTreeNotation', () => {
  it('reads single quotes too, and the DOM-attribute spellings of a name', () => {
    // A 7B model's whole catalog, 2026-08-21: every selector a guaranteed miss.
    assert.equal(fromTreeNotation("StaticText[text='HR']"), 'text="HR"');
    assert.equal(fromTreeNotation("textbox[placeholder='Work email']"), 'input[placeholder="Work email"]');
    assert.equal(fromTreeNotation("role=textbox[placeholder='Work email']"), 'input[placeholder="Work email"]');
    assert.equal(fromTreeNotation("heading[title='Benefit Plan Catalog']"), 'role=heading[name="Benefit Plan Catalog"]');
    assert.equal(fromTreeNotation("role=button[aria-label='Menu']"), 'role=button[name="Menu"]');
    // A real CSS selector is never touched.
    assert.equal(fromTreeNotation("input[placeholder='x']"), "input[placeholder='x']");
    assert.equal(fromTreeNotation('.card[title="x"]'), '.card[title="x"]');
  });
  it('rewrites each tree-notation shape to real selector syntax', () => {
    assert.equal(fromTreeNotation('StaticText[text="20 Jul 2026"]'), 'text="20 Jul 2026"');
    assert.equal(
      fromTreeNotation('role=link[url*="/en/workflows/probation/PB-002"]'),
      'a[href*="/en/workflows/probation/PB-002"]',
    );
    assert.equal(fromTreeNotation('role=cell[text="Somchai Sukjai"]'), 'role=cell[name="Somchai Sukjai"]');
  });

  it('carries a chained tail through the rewrite', () => {
    assert.equal(
      fromTreeNotation('role=link[text="Review"] >> nth=0'),
      'role=link[name="Review"] >> nth=0',
    );
  });

  it('leaves real selectors exactly as written', () => {
    for (const sel of ['role=button[name="Sign in" i]', 'text="extended"', 'a[href*="/x"]', '.card > span']) {
      assert.equal(fromTreeNotation(sel), sel);
    }
  });
});

describe('an absence check on a bare word is quoted, not shipped', () => {
  it('narrows expectHidden text=extended to the exact form', async () => {
    const model = new LlmFlowAuthorModel({
      model: jsonModel('m', {
        name: 'f', rationale: '', notes: '', setup: [], teardown: [],
        steps: [
          { action: 'expectHidden', case: null, selector: 'text=extended', value: '', url: '', key: '', name: '', intent: 'raw code must not leak' },
          { action: 'expectHidden', case: null, selector: 'text=pending_hr', value: '', url: '', key: '', name: '', intent: 'raw code must not leak' },
        ],
      }, { inputTokens: 0, outputTokens: 0 }),
      id: 'mock:author',
    });
    const result = await model.author({ prompt: 'x', policy: 'forms' });
    assert.equal((result.steps[0] as { selector: string }).selector, 'text="extended"');
    // A snake_case token is safe either way and stays as written.
    assert.equal((result.steps[1] as { selector: string }).selector, 'text=pending_hr');
  });
});

describe('notEndToEnd counts a link click as travel', () => {
  it('a flow that navigates by clicking links is end-to-end', () => {
    assert.equal(
      notEndToEnd(
        [],
        [
          { action: 'click', selector: 'role=tab[name="Team" i]' },
          { action: 'click', selector: 'role=link[name="Probation Reviews" i]' },
          { action: 'expectVisible', selector: 'role=heading[name="Probation Reviews" i]' },
        ] as FlowStep[],
        'http://x.test/en/login',
      ),
      null,
    );
  });

  it('a flow that only clicks buttons on its start page still is not', () => {
    assert.equal(
      notEndToEnd(
        [],
        [{ action: 'click', selector: 'role=button[name="Next" i]' }] as FlowStep[],
        'http://x.test/en/login',
      ),
      'one-page',
    );
  });
});

describe('groundLoginProof', () => {
  const login = (proof: FlowStep): FlowStep[] => [
    { action: 'goto', url: 'http://x.test/en/login' },
    { action: 'fill', selector: 'role=textbox[name="Work email" i]', value: 'a@b.test' },
    { action: 'click', selector: 'role=button[name="Next" i]' },
    { action: 'fill', selector: 'input[type="password"]', value: 'pw' },
    { action: 'click', selector: 'role=button[name="Sign in" i]' },
    proof,
  ];

  it('replaces a proof the sign-in URL already contains with the submit control gone', () => {
    const setup = login({ action: 'expectUrl', value: '/en/' });
    const note = groundLoginProof(setup, []);
    assert.match(note ?? '', /could not fail/);
    assert.deepEqual(setup[5], {
      action: 'expectHidden',
      selector: 'role=button[name="Sign in" i]',
      intent: 'the sign-in took: the submit control "role=button[name="Sign in" i]" is no longer on the page',
    });
    assert.equal(loginProofCannotFail(setup), null, 'and the lint no longer fires');
  });

  it('leaves a proof that can fail alone', () => {
    const setup = login({ action: 'expectUrl', value: '/en/admin/system' });
    assert.equal(groundLoginProof(setup, []), null);
    assert.equal(setup[5]?.action, 'expectUrl');
  });

  // Live: a sheet said "HR Admin", the shell renders "ผู้ดูแลระบบ HR", and
  // the model asserted text="HRIS ADMIN" — in no tree, not in the request.
  it('replaces a text proof that quotes what nothing showed', () => {
    const setup = login({ action: 'expectVisible', selector: 'text="HRIS ADMIN"' });
    const note = groundLoginProof(setup, [], 'button "ผู้ดูแลระบบ HR"\nSign in as the HR Admin');
    assert.match(note ?? '', /appears in no tree/);
    assert.equal(setup[5]?.action, 'expectHidden');
  });

  it('keeps a text proof the tree or the request grounds', () => {
    const setup = login({ action: 'expectVisible', selector: 'text="ผู้ดูแลระบบ HR"' });
    assert.equal(groundLoginProof(setup, [], 'button "ผู้ดูแลระบบ HR"'), null);
    assert.equal(setup[5]?.action, 'expectVisible');
  });

  it('looks past the consent gate for the proof', () => {
    const setup = login({ action: 'when', visible: 'role=button[name="Accept and continue" i]', then: [] } as unknown as FlowStep);
    setup.push({ action: 'expectUrl', value: '/en/' });
    assert.match(groundLoginProof(setup, []) ?? '', /could not fail/);
    assert.equal(setup[6]?.action, 'expectHidden');
  });
});

// PL_02_02, live (2026-08-20): setup asserted `expectVisible
// text="admin@cnext.test"` — the very email the flow had just typed — against
// an identity plate that renders a display name, role label and user id and
// never the email. 42 seconds of ladder, patience, healer ("does not appear
// anywhere in the accessibility tree") and reconstruction to disprove a
// string that was input, not output; then a high defect against a working
// application. A check generated out of the scope of the test is re-judged
// for necessity: dropped when the claim's own assertions carry the proof,
// refused with the informed re-ask when it is all the proof there is.
describe('credential echo assertions', () => {
  const signIn: FlowStep[] = [
    { action: 'goto', url: 'http://x.test/en/login' },
    { action: 'fill', selector: 'role=textbox[name="Work email" i]', value: 'admin@cnext.test' },
    { action: 'click', selector: 'role=button[name="Next" i]' },
    { action: 'fill', selector: 'input[type="password"]', value: 'admin2026' },
    { action: 'click', selector: 'role=button[name="Sign in" i]' },
    { action: 'expectHidden', selector: 'role=button[name="Sign in" i]' },
    { action: 'goto', url: '/en/admin/benefits/plans' },
  ];

  it('collects the values typed on a sign-in page, email and password alike', () => {
    assert.deepEqual(typedCredentialValues(signIn, []), ['admin@cnext.test', 'admin2026']);
  });

  it('does not treat a business-form fill as a credential', () => {
    const body: FlowStep[] = [
      { action: 'goto', url: 'http://x.test/en/employees' },
      { action: 'fill', selector: 'role=textbox[name="Manager email" i]', value: 'boss@cnext.test' },
    ];
    assert.deepEqual(typedCredentialValues([], body), []);
  });

  it('flags the PL_02_02 shape: expectVisible of the typed email', () => {
    const setup: FlowStep[] = [
      ...signIn,
      { action: 'expectVisible', selector: 'text="admin@cnext.test"' },
    ];
    const typed = typedCredentialValues(setup, []);
    assert.deepEqual(credentialEchoAssertions(setup, typed), [7]);
  });

  it('a tree that really renders the value rescues the assertion', () => {
    const setup: FlowStep[] = [
      ...signIn,
      { action: 'expectVisible', selector: 'text="admin@cnext.test"' },
    ];
    const typed = typedCredentialValues(setup, []);
    const tree = 'StaticText "Signed in as admin@cnext.test"';
    assert.deepEqual(credentialEchoAssertions(setup, typed, tree), []);
  });

  it('never flags expectHidden — a credential NOT displayed is a legitimate claim', () => {
    const steps: FlowStep[] = [{ action: 'expectHidden', selector: 'text="admin2026"' }];
    const typed = typedCredentialValues(signIn, steps);
    assert.deepEqual(credentialEchoAssertions(steps, typed), []);
  });

  it('flags an expectText whose value echoes the credential', () => {
    const steps: FlowStep[] = [
      { action: 'expectText', selector: 'body', value: 'admin@cnext.test' },
    ];
    const typed = typedCredentialValues(signIn, steps);
    assert.deepEqual(credentialEchoAssertions(steps, typed), [0]);
  });

  it('flags nothing when no credential was typed', () => {
    const steps: FlowStep[] = [{ action: 'expectVisible', selector: 'text="admin@cnext.test"' }];
    assert.deepEqual(credentialEchoAssertions(steps, []), []);
  });

  it('the pipeline drops the echo when the claim’s own assertions carry the proof', async () => {
    const author = new FlowAuthor({
      model: stubModel({
        name: 'PL_02_02 Benefit Plan Catalog wording',
        setup: [
          ...signIn,
          { action: 'expectVisible', selector: 'text="admin@cnext.test"', intent: 'user email shown in chrome' },
        ],
        steps: [
          { action: 'expectVisible', selector: 'role=heading[name="Benefit Plans" i]', intent: 'the title' },
          { action: 'expectVisible', selector: 'text="Benefits Admin"', intent: 'the breadcrumb' },
        ],
      }),
    });
    const authored = await author.author('check the Benefit Plan Catalog wording matches the spec');
    assert.equal(authored.flow.setup?.length, signIn.length, 'the echo left setup');
    assert.equal(
      authored.flow.setup?.some((s) => JSON.stringify(s).includes('admin@cnext.test') && s.action.startsWith('expect')),
      false,
    );
    assert.equal(authored.flow.steps.length, 2, 'the claim’s own assertions are untouched');
    assert.match(authored.notes, /out-of-scope check/);
  });

  it('the pipeline refuses when the echo is all the proof there is', async () => {
    const author = new FlowAuthor({
      model: stubModel({
        name: 'who am i',
        setup: [],
        steps: [
          // The sign-in block WITHOUT its expectHidden proof: the echo is the
          // only assertion anywhere, so dropping it would leave a flow that
          // proves nothing — the informed re-ask is the honest outcome.
          ...signIn.filter((s) => s.action !== 'expectHidden'),
          { action: 'expectVisible', selector: 'text="admin@cnext.test"', intent: 'user email shown' },
        ],
      }),
    });
    await assert.rejects(
      () => author.author('check the signed-in user'),
      (error: unknown) =>
        error instanceof AuthoringError && /credential .*input, not expected output/.test((error as Error).message),
    );
  });
});

// A flow that signs in as two different people is an end-to-end journey
// across the application's session machinery, and every switch must travel
// the app's own sign-out path — never fill a login form while signed in
// (the app hides it), never fake the switch with clearStorage (a
// cookie-backed session survives the wipe).
describe('persona switches', () => {
  const loginAs = (email: string, password: string): FlowStep[] => [
    { action: 'goto', url: 'http://x.test/en/login' },
    { action: 'fill', selector: 'role=textbox[name="Work email" i]', value: email },
    { action: 'click', selector: 'role=button[name="Next" i]' },
    { action: 'fill', selector: 'input[type="password"]', value: password },
    { action: 'click', selector: 'role=button[name="Sign in" i]' },
    { action: 'expectHidden', selector: 'role=button[name="Sign in" i]' },
  ];

  it('switchesPersona sees two identities across two sign-in segments', () => {
    const steps = [
      ...loginAs('admin@cnext.test', 'admin2026'),
      { action: 'goto', url: '/en/admin' } as FlowStep,
      ...loginAs('hrbp@cnext.test', 'hrbp2026'),
    ];
    assert.deepEqual(switchesPersona([], steps), ['admin@cnext.test', 'hrbp@cnext.test']);
  });

  it('one persona, even re-signed-in, is not a switch — and a business fill never counts', () => {
    const steps = [
      ...loginAs('admin@cnext.test', 'admin2026'),
      { action: 'goto', url: '/en/employees' } as FlowStep,
      { action: 'fill', selector: 'role=textbox[name="Manager email" i]', value: 'boss@cnext.test' } as FlowStep,
      ...loginAs('admin@cnext.test', 'admin2026'),
    ];
    assert.deepEqual(switchesPersona([], steps), ['admin@cnext.test']);
  });

  it('groundPersonaSwitches puts a signOut in front of the second sign-in goto', () => {
    const steps = [...loginAs('admin@cnext.test', 'a'), ...loginAs('hrbp@cnext.test', 'b')];
    const fixed = groundPersonaSwitches([], steps);
    assert.equal(fixed.inserted, 1);
    const at = fixed.steps.findIndex((s) => s.action === 'signOut');
    assert.equal(at, loginAs('x', 'y').length, 'immediately before the second login goto');
    assert.equal(fixed.steps[at + 1]?.action, 'goto');
  });

  it('a switch that already signs out is left alone', () => {
    const steps = [
      ...loginAs('admin@cnext.test', 'a'),
      { action: 'signOut' } as FlowStep,
      ...loginAs('hrbp@cnext.test', 'b'),
    ];
    assert.equal(groundPersonaSwitches([], steps).inserted, 0);
  });

  it('a setup identity counts as the previous persona for the body', () => {
    const fixed = groundPersonaSwitches(loginAs('admin@cnext.test', 'a'), loginAs('hrbp@cnext.test', 'b'));
    assert.equal(fixed.inserted, 1);
    assert.equal(fixed.steps[0]?.action, 'signOut');
  });

  it('the pipeline marks the flow e2e, inserts the signOut, and says so', async () => {
    const author = new FlowAuthor({
      model: stubModel({
        name: 'admin creates, hrbp approves',
        steps: [
          ...loginAs('admin@cnext.test', 'a'),
          ...loginAs('hrbp@cnext.test', 'b'),
          { action: 'expectVisible', selector: 'role=heading[name="Approvals" i]', intent: 'the queue' },
        ],
      }),
    });
    const authored = await author.author('admin creates a request, then the HRBP approves it');
    assert.equal(authored.flow.scope, 'e2e');
    assert.equal(authored.flow.steps.filter((s) => s.action === 'signOut').length, 1);
    assert.match(authored.notes, /signOut step\(s\) before persona switches/);
  });

  it('a single-persona flow is not marked e2e', async () => {
    const author = new FlowAuthor({
      model: stubModel({
        steps: [
          ...loginAs('admin@cnext.test', 'a'),
          { action: 'expectVisible', selector: 'role=heading[name="Plans" i]', intent: 'the page' },
        ],
      }),
    });
    const authored = await author.author('check the plans page');
    assert.equal(authored.flow.scope, undefined);
  });
});

describe('the journey capture reads where the request says it goes', () => {
  const start = 'http://localhost:3000/en/login';

  it('takes a URL the request names outright, on the run\'s own origin', () => {
    assert.deepEqual(
      literalDestinations(
        '2. Go to the probation screen for employee EMP-0005 (http://localhost:3000/en/admin/employees/EMP-0005/probation).',
        start,
      ),
      ['http://localhost:3000/en/admin/employees/EMP-0005/probation'],
    );
  });

  it('reads a bare path too, and never the sign-in, consent or API paths', () => {
    assert.deepEqual(
      literalDestinations(
        'open /en/workflows/probation; the login is /en/login; consent at /en/consent; seed via /api/db/seed',
        start,
      ),
      ['http://localhost:3000/en/workflows/probation'],
    );
  });

  it('ignores another origin — that page is not this application', () => {
    assert.deepEqual(literalDestinations('see https://docs.example.com/guide/x', start), []);
  });

  it('fills a route id from an id-shaped token in the request, and nothing else', () => {
    assert.equal(
      fillRouteIds('/:locale/admin/employees/:id/probation', 'the probation screen for employee EMP-0005'),
      '/:locale/admin/employees/EMP-0005/probation',
    );
    assert.equal(
      fillRouteIds('/:locale/admin/employees/:id/probation', 'the probation screen for the employee'),
      '/:locale/admin/employees/:id/probation',
      'an ordinary word is never substituted for an id',
    );
  });
});

describe('shouldSignInForCapture', () => {
  const credentials = { email: 'employee@cnext.test', password: 'employee2026' };

  it('signs in when credentials were supplied and the capture landed on a login page', () => {
    assert.equal(
      shouldSignInForCapture({
        landedUrl: 'http://localhost:3200/en/login',
        credentials,
        alreadyTried: false,
      }),
      true,
    );
  });

  it('never invents a login: no credentials, no attempt', () => {
    // --as / WOWLIDATOR_AS is the only source. Borrowing a value from anywhere
    // else would be this tool typing a password nobody handed it.
    assert.equal(
      shouldSignInForCapture({
        landedUrl: 'http://localhost:3200/en/login',
        credentials: undefined,
        alreadyTried: false,
      }),
      false,
    );
  });

  it('never tries twice', () => {
    // One attempt is the whole budget: a retry loop against an unfamiliar
    // login form is how an unattended tool locks an account.
    assert.equal(
      shouldSignInForCapture({
        landedUrl: 'http://localhost:3200/en/login',
        credentials,
        alreadyTried: true,
      }),
      false,
    );
  });

  it('does nothing on a page that is not a sign-in', () => {
    assert.equal(
      shouldSignInForCapture({
        landedUrl: 'http://localhost:3200/en/overtime',
        credentials,
        alreadyTried: false,
      }),
      false,
    );
  });
});

describe('journeyCaptureNote', () => {
  it('names the fix when there is no session', () => {
    const note = journeyCaptureNote({
      kind: 'no-session',
      target: 'http://localhost:3200/en/overtime',
      landed: 'http://localhost:3200/en/login',
    });
    assert.match(note, /--as <email>:<password>/, 'a dead end that does not name its fix is a dead end');
    assert.match(note, /sign-in page under another name/);
  });

  it('says plainly that nothing was clicked when the form could not be read', () => {
    const note = journeyCaptureNote({ kind: 'no-form-field', missing: 'no visible password field' });
    assert.match(note, /nothing was clicked/);
    assert.match(note, /no visible password field/);
  });

  it('reports a refused sign-in as refused, not as a missing page', () => {
    const note = journeyCaptureNote({
      kind: 'sign-in-refused',
      email: 'employee@cnext.test',
      landed: 'http://localhost:3200/en/login',
    });
    assert.match(note, /employee@cnext\.test/);
    assert.match(note, /credentials\s+were refused/);
  });
});


/**
 * `--scope e2e` is a promise, and the only way to keep one is to check it.
 * Both refused shapes below were produced by the live author this session.
 */
describe('notEndToEnd', () => {
  const START = 'http://localhost:3200/en/login';
  const signIn: FlowStep[] = [
    { action: 'goto', url: 'http://localhost:3200/en/login' },
    { action: 'fill', selector: 'role=textbox[name="Work email" i]', value: 'a@b.test' },
    { action: 'click', selector: 'role=button[name="Sign in" i]' },
  ];

  it('refuses a flow that never leaves the page it starts on', () => {
    const steps: FlowStep[] = [
      { action: 'expectVisible', selector: 'role=heading[name="Sign in" i]' },
    ];
    assert.equal(notEndToEnd(signIn, steps, START), 'one-page');
  });

  it('accepts a flow that navigates to a second page', () => {
    const steps: FlowStep[] = [
      { action: 'goto', url: 'http://localhost:3200/en/overtime' },
      { action: 'expectVisible', selector: 'role=heading[name="Overtime Requests" i]' },
    ];
    assert.equal(notEndToEnd(signIn, steps, START), null);
  });

  it('accepts travel proved by an expectUrl, which is how a CLICK navigates', () => {
    const steps: FlowStep[] = [
      { action: 'click', selector: 'a:has-text("OT request")' },
      { action: 'expectUrl', value: '/en/overtime' },
      { action: 'expectVisible', selector: 'role=heading[name="Overtime Requests" i]' },
    ];
    assert.equal(notEndToEnd(signIn, steps, START), null);
  });

  it('does not count the clearStorage reload as travel', () => {
    // goto login, clear, goto login again is two gotos to ONE page — the
    // known-state idiom, not a journey.
    const setup: FlowStep[] = [
      { action: 'goto', url: 'http://localhost:3200/en/login' },
      { action: 'clearStorage' },
      { action: 'goto', url: 'http://localhost:3200/en/login' },
    ];
    const steps: FlowStep[] = [{ action: 'expectVisible', selector: 'role=button[name="Sign in" i]' }];
    assert.equal(notEndToEnd(setup, steps, START), 'one-page');
  });

  it('does not count a query string as another page', () => {
    const steps: FlowStep[] = [
      { action: 'goto', url: 'http://localhost:3200/en/login?next=%2Fen%2Fhome' },
      { action: 'expectVisible', selector: 'role=button[name="Sign in" i]' },
    ];
    assert.equal(notEndToEnd(signIn, steps, START), 'one-page');
  });

  it('names an agent-handled journey as its own failure', () => {
    // The exact degradation measured 9 times out of 9 before the journey
    // capture existed: the whole middle handed to the agent, settled by a URL.
    const steps: FlowStep[] = [
      { action: 'workflow', goal: 'go to overtime, submit a request, check the status list' },
      { action: 'expectUrl', value: '/en/login' },
    ];
    assert.equal(notEndToEnd(signIn, steps, START), 'agent-journey');
  });

  it('does not refuse a workflow leg inside a flow that really travels', () => {
    const steps: FlowStep[] = [
      { action: 'goto', url: 'http://localhost:3200/en/overtime' },
      { action: 'workflow', goal: 'open the create dialog and submit it' },
      { action: 'expectText', selector: 'role=list', value: 'evidence run' },
    ];
    assert.equal(notEndToEnd(signIn, steps, START), null);
  });
});


/**
 * The scope reaches the model, and its absence changes nothing.
 *
 * The prompt half is a request; `notEndToEnd` and the forced journey capture
 * are the guarantee. All three are needed: the rules are what let the model
 * get it right on the first attempt instead of the third.
 */
describe('the test scope reaches the model', () => {
  function recordingModel() {
    const mock = jsonModel(
      'mock-author',
      { name: 'x', rationale: '', setup: [], steps: [], teardown: [], notes: '' },
      { inputTokens: 0, outputTokens: 0 },
    );
    const call = () =>
      (mock as unknown as { doGenerateCalls: { prompt: { role: string; content: unknown }[] }[] })
        .doGenerateCalls[0] ?? { prompt: [] };
    return {
      model: new LlmFlowAuthorModel({ model: mock, id: 'mock:author' }),
      full: () => JSON.stringify(call()).replace(/\\n/g, ' ').replace(/\s+/g, ' '),
    };
  }
  const request = { prompt: 'submit an overtime request', policy: 'forms' as const, axTree: 'button "Sign in"' };

  it('tells the model an e2e test must leave the page it starts on', async () => {
    const { model, full } = recordingModel();
    await model.author({ ...request, scope: 'e2e' });
    assert.match(full(), /SCOPE: END-TO-END/);
    assert.match(full(), /must leave the page it starts on/);
  });

  it('tells the model a unit test stays on one page', async () => {
    const { model, full } = recordingModel();
    await model.author({ ...request, scope: 'unit' });
    assert.match(full(), /SCOPE: UNIT/);
    assert.match(full(), /Prove ONE thing on ONE page/);
  });

  it('changes nothing at all when no scope was given', async () => {
    // Every caller predating this feature passes none — the `projectGraph`
    // contract, applied again.
    const bare = recordingModel();
    await bare.model.author({ ...request });
    const explicitlyNone = recordingModel();
    await explicitlyNone.model.author({ ...request, scope: undefined });

    assert.equal(explicitlyNone.full(), bare.full());
    assert.doesNotMatch(bare.full(), /SCOPE:/);
  });
});


describe('expectUrl grounds against the routes the repository declares', () => {
  const TREE = 'RootWebArea "Login" url="http://localhost:3200/en/login"\nbutton "Sign in"';

  it('accepts a concrete path matching a declared route pattern', () => {
    // The false refusal this fixes: an --scope e2e run was refused for
    // expecting "/en/time", a route the repo declares as "/:locale/time",
    // reached by clicking a hub tile rather than by a goto — so neither the
    // tree nor the flow's own gotos could vouch for it. Three attempts, three
    // different lints, no flow at all.
    const steps: FlowStep[] = [
      { action: 'goto', url: 'http://localhost:3200/en/login' },
      { action: 'expectUrl', value: '/en/time' },
    ];
    assert.notEqual(ungroundedUrlExpectation(steps, TREE), null, 'ungrounded without the graph');
    assert.equal(ungroundedUrlExpectation(steps, TREE, ['/:locale/time', '/:locale/overtime']), null);
  });

  it('accepts a bare fragment that appears in a declared pattern', () => {
    const steps: FlowStep[] = [
      { action: 'goto', url: 'http://localhost:3200/en/login' },
      { action: 'expectUrl', value: 'overtime' },
    ];
    assert.equal(ungroundedUrlExpectation(steps, TREE, ['/:locale/overtime']), null);
  });

  it('still refuses a path no source vouches for', () => {
    const steps: FlowStep[] = [
      { action: 'goto', url: 'http://localhost:3200/en/login' },
      { action: 'expectUrl', value: '/en/time-attendance' },
    ];
    assert.deepEqual(ungroundedUrlExpectation(steps, TREE, ['/:locale/time', '/:locale/overtime']), {
      index: 1,
      expected: '/en/time-attendance',
    });
  });
});


describe('duplicateCredentialSubmit', () => {
  const fillEmail: FlowStep = {
    action: 'fill',
    selector: 'input[type="email"]',
    value: 'admin@cnext.test',
  };
  const fillPassword: FlowStep = {
    action: 'fill',
    selector: 'input[type="password"]',
    value: 'admin2026',
  };
  const submit: FlowStep = { action: 'click', selector: 'role=button[name="Sign in" i]' };

  it('refuses a second submit click with nothing re-typed between', () => {
    // DB_02_01 verbatim: the model wrote a defensive retry. Once the engine's
    // own hydration replay makes the first click work, the second one has no
    // button to press and is filed as a defect against a healthy application.
    const steps: FlowStep[] = [
      { action: 'goto', url: 'http://localhost:3200/en/login' },
      fillEmail,
      fillPassword,
      submit,
      { action: 'expectUrl', value: '/admin' },
      submit,
      { action: 'expectUrl', value: '/admin' },
    ];
    assert.deepEqual(duplicateCredentialSubmit(steps), {
      first: 3,
      repeat: 5,
      selector: 'role=button[name="Sign in" i]',
    });
  });

  it('accepts a single submit followed by ordinary steps', () => {
    const steps: FlowStep[] = [
      { action: 'goto', url: 'http://localhost:3200/en/login' },
      fillEmail,
      fillPassword,
      submit,
      { action: 'expectUrl', value: '/admin' },
      { action: 'goto', url: 'http://localhost:3200/en/admin/benefits/plans' },
      { action: 'expectVisible', selector: 'text=BE-MED-001' },
    ];
    assert.equal(duplicateCredentialSubmit(steps), null);
  });

  it('accepts a persona switch that goes back to the sign-in page first', () => {
    // The documented legitimate shape: never switch user by re-filling the
    // form from another page — go back to the sign-in page. The goto is what
    // says the flow means it.
    const steps: FlowStep[] = [
      { action: 'goto', url: 'http://localhost:3200/en/login' },
      fillEmail,
      fillPassword,
      submit,
      { action: 'expectUrl', value: '/admin' },
      { action: 'goto', url: 'http://localhost:3200/en/login' },
      { action: 'fill', selector: 'input[type="email"]', value: 'hrbp@cnext.test' },
      { action: 'fill', selector: 'input[type="password"]', value: 'hrbp2026' },
      submit,
    ];
    assert.equal(duplicateCredentialSubmit(steps), null);
  });

  it('accepts a genuine second attempt that re-types the credentials', () => {
    // What the engine's own replay emits. A re-fill is a real retry with real
    // input; only the bare re-click is the guaranteed-to-fail shape.
    const steps: FlowStep[] = [
      { action: 'goto', url: 'http://localhost:3200/en/login' },
      fillEmail,
      fillPassword,
      submit,
      fillEmail,
      fillPassword,
      submit,
    ];
    assert.equal(duplicateCredentialSubmit(steps), null);
  });

  it('leaves a different control alone, even right after the submit', () => {
    // "Sign in with Microsoft" is a different path, and may be the point.
    const steps: FlowStep[] = [
      { action: 'goto', url: 'http://localhost:3200/en/login' },
      fillEmail,
      fillPassword,
      submit,
      { action: 'click', selector: 'role=button[name="Sign in with Microsoft" i]' },
    ];
    assert.equal(duplicateCredentialSubmit(steps), null);
  });

  it('says nothing about repeated clicks that follow no credential fill', () => {
    const steps: FlowStep[] = [
      { action: 'goto', url: 'http://localhost:3200/en/admin/benefits/rules' },
      { action: 'click', selector: 'role=button[name="Refresh" i]' },
      { action: 'click', selector: 'role=button[name="Refresh" i]' },
    ];
    assert.equal(duplicateCredentialSubmit(steps), null);
  });
});


describe('dbClaimWithoutDbCheck names WHICH gap it found', () => {
  const claim = 'GET /api/db/health reports live counts that match the database exactly';
  const noDbSteps: FlowStep[] = [
    { action: 'request', method: 'GET', url: '/api/db/health' },
    { action: 'expectJson', path: '$.ok', value: 'true' },
  ];

  it('reports "unused" when tables were offered and none was used', () => {
    assert.equal(dbClaimWithoutDbCheck(claim, noDbSteps, true), 'unused');
  });

  it('reports "no-schema" when no inventory existed at all', () => {
    // The regression: this used to return false here and disarm the lint in
    // exactly the case where the loss is total — with no inventory
    // `toFlowStep` drops every DB step, so the claim degrades silently. Live
    // (DB_01_01): a run grounded in the wrong saved repo (0 table nodes)
    // reported a green pass having read no count.
    assert.equal(dbClaimWithoutDbCheck(claim, noDbSteps, false), 'no-schema');
  });

  it('is satisfied by an actual DB step', () => {
    const withDb: FlowStep[] = [
      ...noDbSteps,
      { action: 'expectDbRow', table: 'employee_center.person_information', where: {}, count: 98 },
    ];
    assert.equal(dbClaimWithoutDbCheck(claim, withDb, true), false);
    assert.equal(dbClaimWithoutDbCheck(claim, withDb, false), false);
  });

  it('says nothing about a claim that never mentions the database', () => {
    assert.equal(dbClaimWithoutDbCheck('the plans catalog lists every plan', noDbSteps, false), false);
  });
});

/**
 * Every complaint in one re-ask, not the first one only.
 *
 * The chain used to stop at the first lint that fired. With 16 fatal lints
 * against a 3-attempt budget that is a denial of service, not a quality gate:
 * measured on one prompt, a `--scope e2e` run was refused by three DIFFERENT
 * lints across its three attempts and produced no flow at all. These pin the
 * composition rule and the fact that the model is told everything at once.
 */
describe('composeRefusal', () => {
  const fatal = (message: string): Violation => ({ message, severity: 'fatal', note: message });
  const weak = (message: string, note: string): Violation => ({ message, severity: 'weak', note });

  it('leaves a lone complaint exactly as its lint wrote it', () => {
    // The common case must read and test identically to before this existed:
    // no wrapper, no numbering, no renaming.
    const only = fatal('the authored flow "x" pins a live count inside an accessible name');
    const error = composeRefusal([only]);
    assert.equal(error.message, only.message);
    assert.deepEqual(error.messages, [only.message]);
    assert.equal(error.severity, 'fatal');
  });

  it('names every problem when there is more than one', () => {
    const error = composeRefusal([fatal('problem one'), fatal('problem two'), fatal('problem three')]);
    assert.match(error.message, /3 problems/);
    assert.match(error.message, /fix all of them, not just the first/);
    for (const each of ['problem one', 'problem two', 'problem three']) {
      assert.match(error.message, new RegExp(each), `${each} must survive into the refusal`);
    }
    assert.deepEqual(error.messages, ['problem one', 'problem two', 'problem three']);
  });

  it('is fatal when any one complaint is fatal', () => {
    // A flow that says something untrue must never become returnable because
    // a thin complaint joined it.
    const error = composeRefusal([weak('thin', 'thin note'), fatal('false')]);
    assert.equal(error.severity, 'fatal');
  });

  it('stays weak only when every complaint is weak, and joins what they mean', () => {
    const error = composeRefusal([weak('thin a', 'note a'), weak('thin b', 'note b')]);
    assert.equal(error.severity, 'weak');
    assert.equal(error.note, 'note a; note b');
  });

  it('caps what it shows and says how much it left out', () => {
    const many = Array.from({ length: MAX_REPORTED_VIOLATIONS + 2 }, (_, i) => fatal(`problem ${i}`));
    const error = composeRefusal(many);
    assert.equal(error.messages.length, MAX_REPORTED_VIOLATIONS, 'the tree must still fit in the prompt');
    assert.match(error.message, /2 further problem\(s\) not listed/, 'never a silent drop');
    assert.doesNotMatch(error.message, /problem 6/, 'and what was cut really is cut');
  });

  it('takes severity from complaints the cap left out', () => {
    // Otherwise a fatal problem past the cap would quietly downgrade the whole
    // refusal to something the loop is willing to hand back.
    const many: Violation[] = [
      ...Array.from({ length: MAX_REPORTED_VIOLATIONS }, (_, i) => weak(`thin ${i}`, `note ${i}`)),
      fatal('the one that matters'),
    ];
    assert.equal(composeRefusal(many).severity, 'fatal');
  });
});

describe('one attempt reports every lint the flow trips', () => {
  /** Trips countPinnedName, duplicateCredentialSubmit and unpinnedDateEntry at once. */
  const threeProblems: FlowStep[] = [
    { action: 'fill', selector: 'input[type=password]', value: 'pw', intent: 'password' },
    { action: 'click', selector: 'role=button[name="Sign in" i]' },
    { action: 'expectUrl', value: '/home' },
    { action: 'click', selector: 'role=button[name="Sign in" i]' },
    { action: 'fill', selector: '[data-testid="start-date"]', value: '2026-08-18' },
    { action: 'expectVisible', selector: 'role=tab[name="Status (1)" i]' },
  ];

  function alwaysAnswers(steps: FlowStep[]): FlowAuthorModel & { feedbacks: string[][] } {
    const model: FlowAuthorModel & { feedbacks: string[][] } = {
      id: 'scripted:author',
      feedbacks: [],
      async author(request) {
        model.feedbacks.push([...(request.feedback ?? [])]);
        return {
          name: 'scripted flow',
          rationale: '',
          setup: [],
          steps,
          teardown: [],
          notes: '',
          droppedSteps: 0,
        };
      },
    };
    return model;
  }

  it('refuses once, naming all three, instead of spending an attempt per problem', async () => {
    const model = alwaysAnswers(threeProblems);
    await assert.rejects(
      new FlowAuthor({ model }).author('sign in and check the status tab'),
      (error: unknown) => {
        assert.ok(error instanceof AuthoringError);
        assert.match(error.message, /3 problems/);
        assert.match(error.message, /pins a live count/, 'countPinnedName');
        assert.match(error.message, /clicks the sign-in submit .* twice/s, 'duplicateCredentialSubmit');
        assert.match(error.message, /with no clock pinned/, 'unpinnedDateEntry');
        return true;
      },
    );
  });

  it('hands the model all three as separate bullets on the very next ask', async () => {
    const model = alwaysAnswers(threeProblems);
    await assert.rejects(new FlowAuthor({ model }).author('sign in and check the status tab'));

    assert.deepEqual(model.feedbacks[0], [], 'the first ask is uninformed by definition');
    const second = model.feedbacks[1] ?? [];
    assert.equal(second.length, 3, 'one entry per problem — buildUserPrompt renders each as a bullet');
    assert.ok(second.some((entry) => /pins a live count/.test(entry)));
    assert.ok(second.some((entry) => /twice/.test(entry)));
    assert.ok(second.some((entry) => /no clock pinned/.test(entry)));
  });

  it('reports the same problems in the same order twice', async () => {
    // Same reason `temperature: 0` exists, applied to the refusal rather than
    // the generation: a flow that is broken the same way must be refused the
    // same way, or the re-ask is a different ask each run.
    const once = alwaysAnswers(threeProblems);
    const twice = alwaysAnswers(threeProblems);
    await assert.rejects(new FlowAuthor({ model: once }).author('sign in and check the status tab'));
    await assert.rejects(new FlowAuthor({ model: twice }).author('sign in and check the status tab'));
    assert.deepEqual(once.feedbacks[1], twice.feedbacks[1]);
  });
});
