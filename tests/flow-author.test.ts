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
  strandedCredentialFill,
  ungroundedCountRole,
  ungroundedUrlExpectation,
  type AuthorRequest,
  type AuthorResult,
  type FlowAuthorModel,
} from '../src/generator/flow-author.js';
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
    assert.deepEqual(authored.flow.steps[6], { action: 'goto', url: '/en/login' });
    assert.match(authored.notes, /inserted 1 goto/);
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
