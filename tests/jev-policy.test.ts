/**
 * The jev policy (`src/orchestrator/jev-policy.ts`) and its element table
 * (`indexElements`, `agent-guards.ts`). Unit tier, always: the decisions
 * transport is a scripted function, the text helper a `jsonModel`, and the
 * loop — where it is driven at all — runs against a fake page with no
 * browser, so what is proved is the policy's own contract: an index becomes
 * the row's canonical selector, only the chosen operation's head is consumed,
 * a value comes from the goal before any model is paid, and an invalid answer
 * executes nothing.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Page } from 'playwright';

import type { AxNode } from '../src/healer/jit-healer.js';
import { indexElements } from '../src/orchestrator/agent-guards.js';
import {
  JEV_OPERATIONS,
  JevAgentModel,
  goalValueFor,
  jevChoice,
  jevQuestions, inventedIdentifier } from '../src/orchestrator/jev-policy.js';
import { WorkflowAgent, type AgentObservation } from '../src/orchestrator/workflow-agent.js';
import { DecisionsAnswerError, type ChoiceQuestion, type DecisionsRequest, type DecisionsResponse } from '../src/providers/decisions.js';
import { callsTo, jsonModel } from './helpers.js';

process.env['WOWLIDATOR_LLM_LOG'] = 'off';

const node = (role: string, name: string, extra: Partial<AxNode> = {}): AxNode => ({
  role,
  name,
  value: '',
  description: '',
  disabled: false,
  checked: false,
  url: '',
  ...extra,
});

const LOGIN: AxNode[] = [
  node('heading', 'Sign in'),
  node('textbox', 'Email', { required: true }),
  node('textbox', 'Password', { required: true }),
  node('checkbox', 'Remember me'),
  node('button', 'Sign in'),
  node('button', 'Sign in'),
  node('link', 'Forgot password?', { url: 'http://x.test/reset' }),
  node('combobox', 'Language', { value: 'English' }),
  node('textbox', 'Select date', { readonly: true }),
  node('button', 'Disabled thing', { disabled: true }),
  node('StaticText', 'Plan ID already exists.'),
];

function observation(goal: string, extra: Partial<AgentObservation> = {}): AgentObservation {
  const elements = indexElements(LOGIN);
  return {
    goal,
    url: 'http://x.test/login',
    axTree: '(rendered elsewhere)',
    history: [],
    stepsRemaining: 10,
    elements,
    ...extra,
  };
}

/** A decisions transport answering a script of answers, recording every request. */
function scriptedAsk(replies: Array<Record<string, unknown>>) {
  const requests: DecisionsRequest[] = [];
  let n = 0;
  const ask = async (request: DecisionsRequest): Promise<DecisionsResponse> => {
    requests.push(request);
    const answers = replies[Math.min(n, replies.length - 1)]!;
    n += 1;
    return { model: 'typesafe/jev-1.13-test', answers: answers as DecisionsResponse['answers'], usage: { inputTokens: 100, outputTokens: 10, costUsd: null }, latencyMs: 5 };
  };
  return { ask, requests };
}

const choice = (pick: string, over: readonly string[], confidence = 0.9) => ({
  type: 'choice' as const,
  choice: pick,
  probabilities: Object.fromEntries(over.map((o) => [o, over.length === 1 ? 1 : o === pick ? 0.9 : 0.1 / (over.length - 1)])),
  confidence,
});

describe('indexElements — the numbered table', () => {
  const rows = indexElements(LOGIN);

  it('numbers every named node in document order, and only interactive ones carry operations', () => {
    assert.deepEqual(rows.map((r) => r.index), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    assert.deepEqual(rows[0]!.operations, [], 'a heading is context, not a target');
    assert.deepEqual(rows[1]!.operations, ['CLICK', 'TYPE_TEXT']);
    assert.deepEqual(rows[3]!.operations, ['CLICK'], 'a checkbox is clicked, never typed into');
    assert.deepEqual(rows[7]!.operations, ['CLICK', 'TYPE_TEXT', 'SELECT'], 'a combobox may be typed into or picked from');
    assert.deepEqual(rows[8]!.operations, ['CLICK'], 'a read-only field is not typed into');
    assert.deepEqual(rows[9]!.operations, [], 'a disabled control is listed, and offered nothing');
    assert.equal(rows[9]!.disabled, true);
    assert.equal(rows[10]!.role, 'StaticText');
  });

  it("each row's selector is the loop's canonical name selector, with nth for a duplicate", () => {
    assert.equal(rows[1]!.selector, 'role=textbox[name="Email" i]');
    assert.equal(rows[4]!.selector, 'role=button[name="Sign in" i] >> nth=0', 'a duplicated name is always positioned');
    assert.equal(rows[5]!.selector, 'role=button[name="Sign in" i] >> nth=1');
    assert.equal(rows[0]!.selector, 'role=heading[name="Sign in" i]', 'a different role is not a duplicate');
    assert.equal(rows[6]!.url, 'http://x.test/reset');
    assert.equal(rows[1]!.required, true);
  });

  it('counts nth over the whole page and by substring, the way Playwright matches (review 2026-09-18)', () => {
    const all = [node('button', 'Save as draft'), node('heading', 'Form'), node('button', 'Save'), node('button', 'Edit'), node('button', 'Edit')];
    // The focus cut evicted the first "Edit" and "Save as draft"; the rows keep their document positions.
    const focused = [all[1]!, all[2]!, all[4]!];
    const rows = indexElements(focused, all);
    assert.equal(rows[1]!.selector, 'role=button[name="Save" i] >> nth=1', '"Save as draft" contains "Save" and comes first');
    assert.equal(rows[2]!.selector, 'role=button[name="Edit" i] >> nth=1', 'the evicted first Edit still counts');
    assert.equal(indexElements(all, all)[0]!.selector, 'role=button[name="Save as draft" i]', 'the longer name matches nothing else');
  });

  it('a non-ARIA role is targetable as text, never as a role selector no engine resolves', () => {
    const rows = indexElements([node('StaticText', 'Plan ID already exists.'), node('RootWebArea', 'Sign in', { url: 'http://x.test/' })]);
    assert.equal(rows[0]!.selector, 'text="Plan ID already exists."');
    assert.equal(rows[1]!.selector, 'text="Sign in"');
    assert.deepEqual(rows[0]!.operations, []);
  });

  it('a value-only node is listed without a selector; an unnamed, valueless node is dropped', () => {
    const table = indexElements([node('StaticText', '', { value: '75' }), node('generic', '')]);
    assert.equal(table.length, 1);
    assert.equal(table[0]!.selector, null);
    assert.equal(table[0]!.value, '75');
  });
});

describe('jevQuestions — one request, speculative heads', () => {
  it('offers a head only for an operation the table can serve, DONE and BLOCKED always', () => {
    const set = jevQuestions(observation('sign in'), indexElements(LOGIN));
    assert.deepEqual(Object.keys(set.request.questions), ['operation', 'click_target', 'type_text_target', 'select_target']);
    assert.deepEqual(set.offered.operations, [...JEV_OPERATIONS]);
    assert.deepEqual(set.offered.targets.TYPE_TEXT, ['2', '3', '8']);
    assert.deepEqual(set.offered.targets.SELECT, ['8']);
    const click = set.request.questions['click_target'] as ChoiceQuestion;
    assert.ok(!click.instructions.includes('Advance the whole goal'), 'a head carries the target rules only; the operation question carries the rest');
    assert.ok((set.request.questions['operation'] as ChoiceQuestion).instructions.includes('Advance the whole goal'));
    assert.equal(typeof click.criteria['5'], 'string', 'criteria travel as text');
    assert.match(click.criteria['5'] as string, /\[5\] button Sign in/);
    assert.equal(click.criteria['10'], undefined, 'a disabled control is on no head');
    assert.equal(click.criteria['1'], undefined, 'a heading is on no head');
  });

  it('a table with no editable field offers no TYPE_TEXT and no type_text_target', () => {
    const set = jevQuestions(observation('go'), indexElements([node('button', 'Next'), node('heading', 'Step 1')]));
    assert.deepEqual(set.offered.operations, ['CLICK', 'SCROLL_DOWN', 'WAIT', 'DONE', 'BLOCKED']);
    assert.equal(set.request.questions['type_text_target'], undefined);
  });

  it('the state carries the goal, the rows, the history, the ledger, the gaps and a refusal', () => {
    const set = jevQuestions(
      observation('sign in', { history: ['fill Email — ok'], ledger: 'DONE so far: Email', formGaps: 'REQUIRED AND STILL EMPTY (1): Password', feedback: 'you already did that' }),
      indexElements(LOGIN),
    );
    const state = set.request.state as Record<string, unknown>;
    assert.equal(state['goal'], 'sign in');
    assert.deepEqual(state['recent_actions'], ['fill Email — ok']);
    assert.equal(state['done_so_far'], 'DONE so far: Email');
    assert.match(String(state['required_still_empty']), /Password/);
    assert.equal(state['previous_answer_refused'], 'you already did that');
    const rows = state['elements'] as Array<Record<string, unknown>>;
    assert.equal(rows[9]!['disabled'], true);
    assert.equal(rows[7]!['value'], 'English');
  });

  it('a read-only observation asks the verdict question over every targetable row', () => {
    const set = jevQuestions(observation('is the error shown?', { readOnly: true }), indexElements(LOGIN));
    const questions = set.request.questions as Record<string, ChoiceQuestion>;
    assert.deepEqual(Object.keys(questions), ['verdict', 'proved_target']);
    assert.deepEqual(Object.keys(questions['verdict']!.criteria), ['proved', 'can-heal', 'fail']);
    assert.ok('11' in questions['proved_target']!.criteria, 'a text node can be what proves a claim');
    assert.ok(set.offered.verdictTargets.includes('11'));
    assert.ok(!(questions['click_target'] as ChoiceQuestion | undefined)?.instructions.includes('Advance the whole goal'), 'no action rules on a look');
  });
});

describe("jevChoice — only the chosen operation's head is consumed", () => {
  const elements = indexElements(LOGIN);
  const set = jevQuestions(observation('sign in'), elements);

  it('maps the operation and its target row; an unused head is ignored however it answered', () => {
    const picked = jevChoice(
      {
        model: 'm',
        answers: {
          operation: choice('CLICK', set.offered.operations, 0.97),
          click_target: choice('5', set.offered.targets.CLICK!),
          type_text_target: choice('not-a-row', set.offered.targets.TYPE_TEXT!),
        },
        usage: { inputTokens: 1, outputTokens: 1, costUsd: null },
        latencyMs: 1,
      },
      set,
      elements,
    );
    assert.equal(picked.operation, 'CLICK');
    assert.equal(picked.element?.index, 5);
    assert.equal(picked.confidence, 0.97);
    assert.equal(picked.targetProbability, 0.9);
  });

  it('refuses an operation outside the offer and a target outside its head — nothing to act on', () => {
    const usage = { inputTokens: 1, outputTokens: 1, costUsd: null };
    assert.throws(
      () => jevChoice({ model: 'm', answers: { operation: choice('SAVE', [...set.offered.operations, 'SAVE']) }, usage, latencyMs: 1 }, set, elements),
      DecisionsAnswerError,
    );
    assert.throws(
      () =>
        jevChoice(
          { model: 'm', answers: { operation: choice('CLICK', set.offered.operations), click_target: choice('1', ['1', ...set.offered.targets.CLICK!]) }, usage, latencyMs: 1 },
          set,
          elements,
        ),
      DecisionsAnswerError,
      'a heading was never offered to click',
    );
  });
});

describe('a click on a control the goal gives a date for is an entry (HUMI HIR-EC-001, 2026-09-18)', () => {
  const picker = indexElements([node('button', 'Hire Date'), node('button', 'Next')]);
  const goal = 'fill the identity step: set "Hire Date" = "2027-09-01"';
  const clickHireDate = () => {
    const offered = jevQuestions(observation(goal, { elements: picker }), picker).offered;
    return { operation: choice('CLICK', offered.operations), click_target: choice('1', offered.targets.CLICK!) };
  };

  it('becomes a fill of the goal date on the same control, once; the identical click is then let through', async () => {
    const pick = clickHireDate();
    const { ask } = scriptedAsk([pick, pick, pick]);
    const model = new JevAgentModel({ ask, text: { model: jsonModel('data', { text: null }, { inputTokens: 0, outputTokens: 0 }) }, id: 'jev:test' });
    const first = await model.decide(observation(goal, { elements: picker }));
    assert.equal(first.action, 'fill');
    assert.equal(first.selector, 'role=button[name="Hire Date" i]');
    assert.equal(first.value, '2027-09-01');
    assert.match(first.reasoning, /entered through the date rung/);
    const second = await model.decide(observation(goal, { elements: picker }));
    assert.equal(second.action, 'click', 'the rung is tried once per control and goal');
  });

  it('a dropdown the tree lists as a button is chosen from, not clicked (HUMI 1.001 Event Reason)', async () => {
    const trigger = indexElements([node('button', 'Event Reason'), node('button', 'Next')]);
    const goal = 'fill the identity step: set "Event Reason" = "New Hire"';
    const offered = jevQuestions(observation(goal, { elements: trigger }), trigger).offered;
    const pick = { operation: choice('CLICK', offered.operations), click_target: choice('1', offered.targets.CLICK!) };
    const { ask } = scriptedAsk([pick, pick]);
    const model = new JevAgentModel({ ask, text: { model: jsonModel('data', { text: null }, { inputTokens: 0, outputTokens: 0 }) }, id: 'jev:test' });
    const first = await model.decide(observation(goal, { elements: trigger }));
    assert.equal(first.action, 'selectOption');
    assert.equal(first.selector, 'role=button[name="Event Reason" i]');
    assert.equal(first.value, 'New Hire');
    assert.match(first.reasoning, /chosen from rather than opened/);
    const second = await model.decide(observation(goal, { elements: trigger }));
    assert.equal(second.action, 'click', 'once per control and goal; a genuine button is then clicked as the model chose');
  });

  it('a non-date value is picked through the list rung, and a control the goal names no value for is left as the model chose', async () => {
    // Widened 2026-09-18 (HUMI 1.001): a stated value on a trigger the tree
    // calls a button is chosen from, whether or not it is a date.
    const { ask } = scriptedAsk([clickHireDate(), clickHireDate()]);
    const model = new JevAgentModel({ ask, text: { model: jsonModel('data', { text: null }, { inputTokens: 0, outputTokens: 0 }) }, id: 'jev:test' });
    const picked = await model.decide(observation('set "Hire Date" = "next payroll"', { elements: picker }));
    assert.equal(picked.action, 'selectOption');
    assert.equal(picked.value, 'next payroll');
    const unnamed = await model.decide(observation('open the hire form', { elements: picker }));
    assert.equal(unnamed.action, 'click', 'no value in the goal for this control: the click stands');
  });
});

describe('goalValueFor — the value from the goal, at no cost', () => {
  const rows = indexElements(LOGIN);
  it('matches the goal pair to the field by name, either way round, and refuses ambiguity', () => {
    const email = rows[1]!;
    assert.equal(goalValueFor(email, [{ control: 'Email', value: 'qa@x.test' }]), 'qa@x.test');
    assert.equal(goalValueFor(email, [{ control: 'Email address', value: 'qa@x.test' }]), 'qa@x.test');
    assert.equal(goalValueFor(indexElements([node('textbox', 'Day')])[0]!, [{ control: 'Birthday', value: '1995-01-01' }]), null, 'whole words only');
    assert.equal(goalValueFor(email, [{ control: 'Password', value: 'pw' }]), null);
    assert.equal(goalValueFor(email, [{ control: 'Email', value: 'a' }, { control: 'Email', value: 'b' }]), null);
  });
});

describe('JevAgentModel.decide', () => {
  const elements = indexElements(LOGIN);
  const offered = jevQuestions(observation('sign in'), elements).offered;

  it('a CLICK becomes a click on the row\'s canonical selector, with the model\'s confidence on the decision', async () => {
    const { ask, requests } = scriptedAsk([{ operation: choice('CLICK', offered.operations, 0.93), click_target: choice('6', offered.targets.CLICK!) }]);
    const model = new JevAgentModel({ ask, text: { model: jsonModel('data', { text: 'never' }, { inputTokens: 1, outputTokens: 1 }) }, id: 'jev:test' });
    const decision = await model.decide(observation('sign in'));
    assert.equal(decision.action, 'click');
    assert.equal(decision.selector, 'role=button[name="Sign in" i] >> nth=1', 'the second of two identically named buttons');
    assert.equal(decision.confidence, 0.93);
    assert.equal(decision.inputTokens, 100);
    assert.match(decision.reasoning, /CLICK \[6\] button "Sign in"/);
    assert.equal(requests.length, 1);
  });

  it('a TYPE_TEXT takes its value from the goal and never pays the text helper', async () => {
    const helper = jsonModel('data', { text: 'from-the-helper' }, { inputTokens: 5, outputTokens: 2 });
    const { ask } = scriptedAsk([{ operation: choice('TYPE_TEXT', offered.operations), type_text_target: choice('2', offered.targets.TYPE_TEXT!) }]);
    const model = new JevAgentModel({ ask, text: { model: helper }, id: 'jev:test' });
    const decision = await model.decide(observation('set Email to "qa@x.test" and sign in'));
    assert.equal(decision.action, 'fill');
    assert.equal(decision.selector, 'role=textbox[name="Email" i]');
    assert.equal(decision.value, 'qa@x.test');
    assert.equal(callsTo(helper), 0);
  });

  it('a TYPE_TEXT the goal names no value for asks the helper once, and reuses it on an identical re-ask', async () => {
    const helper = jsonModel('data', { text: 'Zurich' }, { inputTokens: 5, outputTokens: 2 });
    const { ask } = scriptedAsk([{ operation: choice('TYPE_TEXT', offered.operations), type_text_target: choice('2', offered.targets.TYPE_TEXT!) }]);
    const model = new JevAgentModel({ ask, text: { model: helper }, id: 'jev:test' });
    const first = await model.decide(observation('search for the city'));
    const second = await model.decide(observation('search for the city'));
    assert.equal(first.value, 'Zurich');
    assert.match(first.reasoning, /from the text helper/);
    assert.equal(first.inputTokens, 105, 'the helper tokens ride the decision');
    assert.equal(second.value, 'Zurich');
    assert.equal(callsTo(helper), 1, 'the same helper input is not paid twice');
    const third = await model.decide(observation('search for the town'));
    assert.equal(callsTo(helper), 2, 'a different input is a new question');
    assert.equal(third.value, 'Zurich');
  });

  it('a helper that declines re-asks once with the field named, and a second insistence is a HARNESS fail', async () => {
    const helper = jsonModel('data', { text: null }, { inputTokens: 5, outputTokens: 2 });
    const pick = { operation: choice('SELECT', offered.operations), select_target: choice('8', offered.targets.SELECT!) };
    const { ask, requests } = scriptedAsk([pick, pick]);
    const model = new JevAgentModel({ ask, text: { model: helper }, id: 'jev:test' });
    const decision = await model.decide(observation('pick the language'));
    assert.equal(requests.length, 2, 'one re-ask');
    assert.match(String((requests[1]!.state as Record<string, unknown>)['previous_answer_refused']), /no value is known for \[8\] combobox "Language"/);
    assert.equal(decision.action, 'fail');
    assert.equal(decision.origin, 'harness');
    assert.match(decision.reasoning, /names no value for \[8\] combobox "Language"/);
    assert.equal(callsTo(helper), 1, 'the identical helper input is not paid twice');
  });

  it('an identifier the goal never stated is refused, even when the helper answers it (the invented email)', async () => {
    // Live: asked for the email box of a Microsoft sign-in, the helper on a claude-cli role answered the
    // operator's own account email. The prompt forbids it; this is the guarantee.
    const helper = jsonModel('data', { text: 'someone@example.com' }, { inputTokens: 5, outputTokens: 2 });
    const pick = { operation: choice('TYPE_TEXT', offered.operations), type_text_target: choice('3', offered.targets.TYPE_TEXT!) };
    const { ask } = scriptedAsk([pick, pick]);
    const model = new JevAgentModel({ ask, text: { model: helper }, id: 'jev:test' });
    const decision = await model.decide(observation('sign in and open the reports page'));
    assert.equal(decision.action, 'fail');
    assert.equal(decision.origin, 'harness');
    assert.equal(decision.value, '', 'nothing is typed');
    assert.equal(inventedIdentifier('someone@example.com', ['set "Email" = "someone@example.com"']), null, 'a stated value passes');
    assert.equal(inventedIdentifier('call 02-123-4567 now', ['Phone = 021234567']), null, 'digits match through punctuation');
    assert.equal(inventedIdentifier('0812345678', ['nothing']), '0812345678', 'a long digit run is an identifier');
    assert.equal(inventedIdentifier('Zurich', []), null, 'a plain word is never judged');
    assert.equal(inventedIdentifier('x@y.z', ['x@y.z']), null);
  });

  it('after the re-ask the model may choose differently, and that decision stands as its own', async () => {
    const helper = jsonModel('data', { text: null }, { inputTokens: 5, outputTokens: 2 });
    const { ask } = scriptedAsk([
      { operation: choice('SELECT', offered.operations), select_target: choice('8', offered.targets.SELECT!) },
      { operation: choice('BLOCKED', offered.operations) },
    ]);
    const model = new JevAgentModel({ ask, text: { model: helper }, id: 'jev:test' });
    const decision = await model.decide(observation('pick the language'));
    assert.equal(decision.action, 'fail');
    assert.equal(decision.origin, undefined, "BLOCKED is the model's own judgement");
  });

  it('DONE is finish, BLOCKED is fail, SCROLL_DOWN is a bare scroll, WAIT is wait', async () => {
    const answers = ['DONE', 'BLOCKED', 'SCROLL_DOWN', 'WAIT'].map((op) => ({ operation: choice(op, offered.operations) }));
    const model = new JevAgentModel({ ask: scriptedAsk(answers).ask, text: { model: jsonModel('data', {}, { inputTokens: 0, outputTokens: 0 }) }, id: 'jev:test' });
    const got = [];
    for (let i = 0; i < 4; i += 1) got.push(await model.decide(observation('x')));
    assert.deepEqual(got.map((d) => [d.action, d.selector]), [['finish', ''], ['fail', ''], ['scroll', ''], ['wait', '']]);
  });

  it('a read-only look answers finish with the verdict in value and the proving row as selector', async () => {
    const readOnly = observation('the duplicate error is shown', { readOnly: true });
    const set = jevQuestions(readOnly, elements);
    const { ask, requests } = scriptedAsk([{ verdict: choice('proved', ['proved', 'can-heal', 'fail']), proved_target: choice('11', set.offered.verdictTargets) }]);
    const model = new JevAgentModel({ ask, text: { model: jsonModel('data', {}, { inputTokens: 0, outputTokens: 0 }) }, id: 'jev:test' });
    const decision = await model.decide(readOnly);
    assert.equal(decision.action, 'finish');
    assert.equal(decision.value, 'proved');
    assert.equal(decision.selector, 'text="Plan ID already exists."', 'a text node proves through the text engine');
    assert.ok('verdict' in requests[0]!.questions);
  });

  it('an answer outside the offer is a typed error before any decision exists', async () => {
    const { ask } = scriptedAsk([{ operation: choice('CLICK', offered.operations), click_target: choice('1', ['1', ...offered.targets.CLICK!]) }]);
    const model = new JevAgentModel({ ask, text: { model: jsonModel('data', {}, { inputTokens: 0, outputTokens: 0 }) }, id: 'jev:test' });
    await assert.rejects(model.decide(observation('sign in')), DecisionsAnswerError);
  });

  it('refuses an observation without the table, naming the loop as its builder', async () => {
    const model = new JevAgentModel({ ask: scriptedAsk([]).ask, text: { model: jsonModel('data', {}, { inputTokens: 0, outputTokens: 0 }) }, id: 'jev:test' });
    await assert.rejects(model.decide({ ...observation('x'), elements: undefined }), /elements/);
  });
});

// ---------------------------------------------------------------------------
// The loop with the policy behind it, on a page with no browser: the same
// fake-page shape `tests/agent-guards.test.ts` drives — CDP tree + locator
// stubs — so what is proved is the SEAM: the loop builds the table, the
// policy's index becomes a selector the real `#act` clicks, and the record
// carries the confidence.
// ---------------------------------------------------------------------------

function fakePage(url: string, nodes: Array<{ role: string; name: string }>, clicked: string[]): Page {
  const locator = (selector: string): unknown => {
    const self: Record<string, unknown> = {
      first: () => self,
      nth: () => self,
      locator: (inner: string) => locator(inner),
      filter: () => self,
      getByRole: () => locator('__none__'),
      waitFor: async () => undefined,
      click: async () => {
        clicked.push(selector);
      },
      fill: async () => undefined,
      press: async () => undefined,
      hover: async () => undefined,
      scrollIntoViewIfNeeded: async () => undefined,
      count: async () => (selector === '__none__' ? 0 : 1),
      isVisible: async () => true,
      isEnabled: async () => true,
      innerText: async () => '',
      inputValue: async () => '',
      all: async () => [],
      allInnerTexts: async () => [],
      ariaSnapshot: async () => '- button "Next"',
      evaluate: async () => null,
    };
    return self;
  };
  const cdpNodes = nodes.map((n, i) => ({ nodeId: String(i), role: { value: n.role }, name: { value: n.name }, properties: [] }));
  return {
    url: () => url,
    context: () => ({
      newCDPSession: async () => ({
        send: async (method: string) => (method === 'Accessibility.getFullAXTree' ? { nodes: cdpNodes } : {}),
        detach: async () => undefined,
      }),
    }),
    locator,
    mouse: { move: async () => undefined },
    keyboard: { press: async () => undefined, insertText: async () => undefined },
    waitForLoadState: async () => undefined,
    waitForTimeout: async () => undefined,
    goto: async () => undefined,
  } as unknown as Page;
}

describe('the loop drives the jev policy (no browser)', () => {
  it('builds the table each turn, clicks the row the policy chose through the real act path, and records the confidence', async () => {
    const clicked: string[] = [];
    const nodes = [
      { role: 'RootWebArea', name: 'Wizard' },
      { role: 'heading', name: 'Step 1' },
      { role: 'button', name: 'Back' },
      { role: 'button', name: 'Next' },
    ];
    const seen: DecisionsRequest[] = [];
    const ask = async (request: DecisionsRequest): Promise<DecisionsResponse> => {
      seen.push(request);
      const offered = Object.keys((request.questions['operation'] as ChoiceQuestion).criteria);
      const targets = Object.keys((request.questions['click_target'] as ChoiceQuestion).criteria);
      const answers =
        seen.length === 1
          ? { operation: choice('CLICK', offered, 0.88), click_target: choice(targets[targets.length - 1]!, targets) }
          : { operation: choice('DONE', offered, 0.7) };
      return { model: 'typesafe/jev-1.13-test', answers: answers as DecisionsResponse['answers'], usage: { inputTokens: 50, outputTokens: 5, costUsd: null }, latencyMs: 1 };
    };
    const model = new JevAgentModel({ ask, text: { model: jsonModel('data', {}, { inputTokens: 0, outputTokens: 0 }) }, id: 'jev:test' });
    const agent = new WorkflowAgent({ model, maxSteps: 4 });
    const result = await agent.run(fakePage('http://x.test/wizard', nodes, clicked), 'go to the next step of the wizard');

    assert.equal(seen.length, 2);
    const rows = seen[0]!.state as Record<string, unknown>;
    assert.ok(Array.isArray(rows['elements']), 'the loop built the table');
    assert.deepEqual(clicked, ['role=button[name="Next" i]'], 'the real act path clicked the row the policy chose');
    assert.equal(result.success, true);
    assert.equal(result.endedBy, 'finish');
    assert.equal(result.actions[0]!.action, 'click');
    assert.equal(result.actions[0]!.confidence, 0.88);
    assert.equal(result.actions[0]!.selector, 'role=button[name="Next" i]');
    assert.equal(result.inputTokens, 100);
  });
});
