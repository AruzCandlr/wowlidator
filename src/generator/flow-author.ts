/**
 * Prompt-driven flow authoring.
 *
 * `TestGenerator` answers "what should this page be tested for" — the model
 * chooses the cases. This module answers a different question: *the author*
 * already knows what they want tested, and describes it in a sentence. The
 * model's only job is to turn that intent into a valid, runnable flow.
 *
 * The difference that matters is **grounding**. A prompt alone can only produce
 * guessed selectors, and a guessed selector is a test that fails on the first
 * run for a reason that has nothing to do with the application. So when a live
 * page is supplied, its accessibility tree is sent along and the model is held
 * to selectors that actually appear in it. Without a page we still emit a flow,
 * but it is explicitly marked ungrounded and its selectors are placeholders to
 * be edited — never something to trust into CI.
 *
 * Routing reuses the existing `generator` role rather than introducing a fourth:
 * this is the same job (write tests) against the same shape of prompt (a page
 * plus instructions), so it wants the same large-context model, and `wowlidator
 * doctor` keeps covering it for free.
 */

import type { LanguageModel } from 'ai';
import type { Page } from 'playwright';
import { z } from 'zod';

import { lenientObject } from '../providers/model-output.js';

import { SELECTOR_SYNTAX_RULES, captureAxTree } from '../healer/jit-healer.js';
import { withQualifiedRole, withRelaxedRoleName } from '../engine/selector.js';
import { formatProbeReport, probeInteractions } from '../context/page-probe.js';
import {
  LlmFactory,
  generateStructuredForModel,
  type ModelSource,
} from '../providers/llm-factory.js';
import { hasAssertion } from '../engine/runner.js';
import type { Flow, FlowStep } from '../engine/runner.js';
import { DEFAULT_MUTATION_POLICY, type MutationPolicy } from './test-generator.js';

/** Same budget as the generator: the AX tree dominates the prompt either way. */
export const DEFAULT_AUTHOR_MAX_NODES = 200;

/**
 * Total authoring attempts, including the first. Same shape and same reason
 * as the healer's `HEAL_ATTEMPTS`: the failure that actually happens is a
 * model ignoring one rule of a long prompt, and the one ask that knows what
 * was refused is worth far more than the first. Two, not three — an
 * authoring call carries the biggest prompt in the system, and a model that
 * ignores explicit named feedback once will usually ignore it twice.
 */
export const AUTHOR_ATTEMPTS = 2;

/**
 * Actions the author may emit.
 *
 * A deliberate subset of `FlowStep`. `fillEach` and `expectTabOrder` are absent
 * because both carry a nested array, and a flat object with every field required
 * is what free-tier models can actually produce reliably (the same reasoning
 * that shapes `GeneratedStepSchema`). Both remain available when hand-writing a
 * flow — see `examples/template.flow.json`.
 */
export const AUTHOR_ACTIONS = [
  'goto',
  'click',
  'fill',
  'selectOption',
  'check',
  'uncheck',
  'type',
  'waitFor',
  'press',
  'workflow',
  'setLocalStorage',
  'clearStorage',
  'back',
  'forward',
  'scrollTo',
  'expectScrollable',
  'snapshot',
  'expectText',
  'expectVisible',
  'expectHidden',
  'expectEnabled',
  'expectDisabled',
  'expectCount',
  'expectUrl',
  'expectValue',
  'expectAttribute',
  'expectFocused',
] as const;

export type AuthorAction = (typeof AUTHOR_ACTIONS)[number];

/**
 * Flat on purpose — see the module note in `test-generator.ts`. Every field is
 * required and unused ones come back as empty strings, then get narrowed in
 * `toFlowStep`.
 */
const AuthoredStepFields = {
  action: z.enum(AUTHOR_ACTIONS),
  // The one field a step may decline to fill. It is organisational — it decides
  // how the body is *divided*, not what any step does — so a model that has no
  // case in mind should cost the isolation between cases, never the whole
  // authoring call. No case anywhere means one case, which is exactly what this
  // produced before cases existed.
  //
  // Nullable rather than `.default('')`, and the difference is not stylistic:
  // zod emits a *defaulted* field as absent from `required`, and strict
  // structured-output providers (Groq's `openai/gpt-oss-*`, and OpenAI's own)
  // reject any object schema whose `required` omits a key of `properties` —
  // failing the whole authoring call before the model is ever asked, with an
  // error naming this field. Nullable keeps the key in `required` while still
  // giving the model a way to say "no case". Every other field here keeps the
  // flat empty-string convention; this one cannot, because "" is a legitimate
  // case name to a constrained decoder.
  case: z
    .string()
    .nullable()
    .describe(
      'Short name of the discrete case this step belongs to. Steps that stand or fall together share one name. Null when the whole body is one case.',
    ),
  selector: z.string().describe('Playwright selector. Empty when the action takes none.'),
  value: z
    .string()
    .describe(
      'Text to fill or type, the visible label of the option to select, expected substring, expected count as digits, storage value, or the goal for a workflow step. Else empty.',
    ),
  url: z.string().describe('URL or path for goto. Else empty.'),
  key: z.string().describe('Key name for press, or storage key for setLocalStorage. Else empty.'),
  name: z.string().describe('Snapshot name, or attribute name for expectAttribute. Else empty.'),
  intent: z.string().describe('What this step is for, in plain language. Always fill this in.'),
};

/**
 * `case` is required *on the wire* and optional *in what we accept back*, and
 * no single zod field expresses both: `.nullable()` puts the key in `required`
 * but then rejects a payload that omits it, and `.default()`/`.optional()` do
 * the reverse. `lenientObject` is what separates the two — the emitted schema
 * is byte-for-byte the strict one, so strict providers stay satisfied, while a
 * lenient provider that drops the key is read as "no case" instead of failing
 * the call. That degradation is the whole reason this field is not an ordinary
 * required string; see the note on `case` above.
 *
 * This was hand-written here for `case` alone, and it is now the shared rule —
 * because z.ai turned out to drop `selector`, `value` and `url` on exactly the
 * same reasoning, and fixing that one field at a time is how a class of bug
 * gets rediscovered once per field. See `providers/model-output.ts`.
 */
const AuthoredStepSchema = lenientObject(AuthoredStepFields);

/**
 * Exported for the contract test in `tests/flow-author.test.ts`, which asserts
 * the emitted JSON Schema stays acceptable to a strict provider. Same reason
 * `GENERATOR_ACTIONS` is exported from `test-generator.ts`: the invariant is
 * only checkable from outside, and it is the kind that breaks silently.
 */
export const AuthoredFlowSchema = z.object({
  name: z.string().describe('Short, stable name for the flow.'),
  rationale: z.string().describe('One sentence: what this flow proves.'),
  setup: z.array(AuthoredStepSchema).describe('Preconditions. Empty array if none needed.'),
  steps: z.array(AuthoredStepSchema).describe('The test body. Must contain an assertion.'),
  teardown: z.array(AuthoredStepSchema).describe('Cleanup. Empty array if none needed.'),
  notes: z
    .string()
    .describe(
      'Anything the author must check or fill in by hand — a guessed selector, an assumed credential, an ambiguity in the request. Empty if none.',
    ),
});

export interface AuthorRequest {
  /** The author's description of the test they want. */
  prompt: string;
  /** URL the AX tree was captured from, when grounded. */
  url?: string | undefined;
  /** Accessibility tree of the live page. Absent means ungrounded. */
  axTree?: string | undefined;
  /**
   * Controls that exist only after an interaction, from `probeInteractions`.
   * Separate from `axTree` on purpose — "behind a menu" is a different claim
   * from "on the page", and a flow that confuses them clicks a menu item
   * without opening the menu.
   */
  interactions?: string | undefined;
  policy?: MutationPolicy | undefined;
  /**
   * Why earlier attempts at this same flow were refused — the validation
   * errors, verbatim. Same seam as `HealRequest.rejected`: a model has no way
   * to know it is repeating a mistake unless the next ask says what the last
   * answer got wrong, and the value of a retry is entirely in that knowledge.
   */
  feedback?: readonly string[] | undefined;
}

/**
 * A discrete case inside an authored body: a run of steps that proves one thing
 * and can be run on its own, from `setup`, without any other case having run.
 *
 * This is what lets one failure be *noted* rather than fatal. A flat step list
 * stops at its first failure — correctly, because everything after it is in an
 * unknown state — so a catalog of six independent claims would report on one and
 * say nothing about five. Split into cases, each is its own run: a failure ends
 * that case and nothing else.
 */
export interface AuthoredCase {
  /** Short name, from the model. Used in the flow name and the report. */
  name: string;
  steps: FlowStep[];
}

export interface AuthorResult {
  name: string;
  rationale: string;
  setup: FlowStep[];
  steps: FlowStep[];
  /**
   * `steps`, partitioned. Always concatenates back to `steps` exactly, so a
   * caller that ignores this sees the flow it always saw. Absent from a stub
   * that predates cases; `FlowAuthor` then treats the body as one case.
   */
  cases?: AuthoredCase[] | undefined;
  teardown: FlowStep[];
  notes: string;
  /**
   * Steps the model emitted that could not be narrowed into a valid `FlowStep`
   * — a `click` with no selector, an `expectCount` whose value was not a number.
   * Reported rather than silently swallowed: a rising count is a prompt problem.
   */
  droppedSteps: number;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
}

/** Pluggable backend, so authoring can be tested without a network call. */
export interface FlowAuthorModel {
  readonly id: string;
  author(request: AuthorRequest): Promise<AuthorResult>;
}

const POLICY_RULES: Record<MutationPolicy, string> = {
  'read-only':
    '- Read-only and navigational actions ONLY. Do NOT submit any form, create, update, or delete.',
  forms:
    '- You MAY submit forms with EMPTY or INVALID input to exercise validation.\n' +
    '- Do NOT submit VALID data that would create or modify a record.\n' +
    '- NEVER delete, purchase, or perform a bulk operation.',
  mutations:
    '- You MAY submit valid data to create or update records.\n' +
    '- NEVER delete, purchase, or perform a bulk or irreversible operation.',
};

const GROUNDED_RULES = `You have been given the accessibility tree of the live page.

- Every selector you emit MUST correspond to a node in that tree. Do not invent
  an id, class, or test id that does not appear there.
- If the request asks for something the tree does not contain, do NOT fabricate a
  selector for it. Emit the steps you can support and say plainly in "notes"
  which part could not be expressed and why.`;

const UNGROUNDED_RULES = `You have NOT been given a page — you are working from the request alone.

- You cannot know this application's real selectors, so do not pretend to. Use
  readable role-based placeholders (role=button[name="Save"]) that an author will
  correct, and list every one of them in "notes" as needing verification.
- Keep the shape right even where the details must be guessed: correct actions,
  correct ordering, a real assertion.`;

const buildSystemPrompt = (policy: MutationPolicy, grounded: boolean): string =>
  `You turn a plain-language test request into ONE runnable UI test flow.

The author has already decided what to test. Your job is to express their intent
faithfully as steps — not to redesign the test, broaden it, or add cases they did
not ask for. If the request is narrow, the flow is narrow.

DO NOT TRUNCATE OR OMIT REQUESTED ACTIONS:
If the request describes multiple actions (e.g. fill inputs, select dates, click buttons, submit form), you MUST emit explicit steps for EVERY requested interaction. Never collapse form interactions or submissions into a single generic workflow step.

A flow has three parts:
- setup     preconditions (navigate, seed auth, clear storage). A failure here
            aborts the flow, because a test whose preconditions did not hold
            cannot produce a meaningful result.
- steps     the test body.
- teardown  cleanup. Always runs, even after a failure.

Actions available:
- goto            navigate. URL or path in "url".
- click           press a control.
- fill            type into a field. Text in "value".
- selectOption    choose a dropdown option. The option's VISIBLE LABEL in
                  "value", the dropdown control itself in "selector". Works on
                  a native select and on a custom combobox alike — never fill
                  a dropdown, and never click it open to guess at its items:
                  this one step opens it and picks.
- check / uncheck tick or untick a checkbox, radio, or toggle. Prefer these
                  over click when the point is the resulting state — they
                  verify the state actually changed.
- type            type key by key, firing real keyboard events. Use INSTEAD of
                  fill only for fields that react per keystroke (autocomplete,
                  typeahead, masked input); fill is faster everywhere else.
- waitFor         wait for an element to become visible.
- press           press a key. Key name in "key" (e.g. Enter, Escape, Tab).
                  Optional "selector" focuses that element first.
- workflow        hand the browser to a navigation agent until a goal is met.
                  Goal in "value". Use ONLY for complex navigation to reach a initial
                  page when the route is unknown. NEVER use workflow to perform
                  form-filling, element selection, or submission tasks requested
                  in the prompt — decompose EVERY requested user action (fill, click,
                  expect) into explicit grounded steps.
- setLocalStorage seed a key. "key" and "value". Must follow a goto — storage is
                  origin-scoped. If the key is what signs the user in, follow it
                  with ANOTHER goto to the page under test: an application reads
                  its session once, at load, so a token seeded into a page that
                  has already rendered changes nothing and the next step lands on
                  the sign-in screen.
- clearStorage    clear localStorage and sessionStorage. Must follow a goto, for
                  the same reason: before one, there is no origin to clear. Do
                  not open a flow with it as hygiene — a fresh page has nothing
                  in it.
- snapshot        visual regression baseline. Name in "name", optional selector.
- expectText      element's text CONTAINS "value".
- expectVisible / expectHidden      element is / is not visible.
- expectEnabled / expectDisabled    control is / is not interactive.
- expectCount     exactly "value" matches. "value" must be digits.
- back / forward  move through history. Use "back" to return to a list page
                  after checking a detail page, instead of navigating again.
- scrollTo        scroll a control into view. Selector required.
- expectScrollable  the page (or a container, if you give a selector) can really
                  be scrolled by a user — content overflows AND the scroll
                  position moves. Use it where content continues past the fold.
- expectUrl       current URL CONTAINS "value". Take the path from the link's
                  url= in the tree, never from its visible label — they often differ.
- expectValue     an input's value EQUALS "value".
- expectAttribute attribute "name" EQUALS "value".
- expectFocused   element currently holds keyboard focus.

**The body MUST contain at least one expect* step.** A flow that only clicks and
navigates passes whether or not the feature works, which is worse than no test:
it displaces the manual check that would have caught the bug.

An assertion must be able to FAIL. Never assert that a selector contains the very
text used to find it (expectText on text=Saved with value "Saved" proves nothing),
and prefer asserting the observable consequence of an action over asserting that
the control you just clicked still exists.

**Group the body into discrete cases with "case".** A case is one thing being
proved: the steps that reach it, and the assertion that settles it, under one
short name. Every case is run on its own, so:

- A case must never depend on an earlier case having run. Whatever they all need
  — navigating, signing in, seeding storage — goes in "setup", which runs again
  before each one.
- Every case must contain an assertion of its own. Steps that only prepare the
  next case belong to that case, not to one of their own.
- Set "case" to null on setup and teardown steps, and on every body step when
  the whole body really is one case.

This is what lets one failure be recorded and the rest still checked. Putting
six independent claims in one case means the second failure hides four claims
nobody will ever get an answer about.

- Leave every unused field as an empty string.
- Always write "intent" — it is what lets a broken selector be repaired later.
${POLICY_RULES[policy]}

${grounded ? GROUNDED_RULES : UNGROUNDED_RULES}

SIGNING IN
If the page you were given is a sign-in page, or the flow needs a signed-in
user, log in explicitly and completely before anything else:
  1. goto the sign-in page.
  2. Fill EVERY field the form has. A password field usually has no accessible
     name of its own — if the tree shows a nameless textbox next to the email
     one, that is the password, and "role=textbox >> nth=1" addresses it.
     A form missing one field never submits, and every later step then runs
     against the sign-in page.
  3. Click the submit control, then goto the page under test.
  4. After submitting, assert WHO is signed in — the account name or role the
     page's chrome shows — before testing anything that depends on it. A flow
     that proceeds as the wrong persona fails later, somewhere confusing, or
     worse: passes against a page the persona should never have seen.
Never assume a session already exists, and never switch user by filling the
login form from another page — go back to the sign-in page first. A login
form only exists on the sign-in page; filling "the password field" anywhere
else fills nothing, three steps in a row.
Claims about DIFFERENT personas belong in SEPARATE cases, each starting with
its own complete sign-in (goto the sign-in page, fill, submit). Setup runs
again before every case, so each persona gets a clean start — one case that
switches identity three times mid-stream is how a whole verification dies on
its second login.

LANGUAGE
The application may render content in a different language or script than the
request quotes — a requirement written in English against a UI that shows Thai
(or both). Unless the claim is explicitly about language or locale:
- Prefer language-neutral anchors: IDs, codes, numbers, hrefs (EMP042,
  PB-001, a count, a URL path). They read the same in every locale.
- When asserting user-facing text, quote what the ACCESSIBILITY TREE actually
  renders, never the request's own wording. The tree is the page speaking its
  own language; the request's wording may be a translation of it. Asserting
  "Somchai Sukjai" against a page that renders "สมชาย สุขใจ" fails a working
  feature and files a false defect.
- If the request insists on specific wording and the tree shows a different
  rendering, assert the neutral anchor and note the discrepancy in the
  rationale rather than writing an assertion that can only fail.

${SELECTOR_SYNTAX_RULES}`;

function buildUserPrompt(request: AuthorRequest): string {
  const lines = [`Test request: ${request.prompt}`];
  if (request.url) lines.push(`Page URL: ${request.url}`);
  if (request.feedback?.length) {
    lines.push(
      '',
      'Your previous attempt at this flow was REFUSED. Fix exactly this — do not repeat it:',
      ...request.feedback.map((entry) => `  - ${entry}`),
    );
  }
  if (request.axTree) lines.push('', 'Accessibility tree:', request.axTree);
  if (request.interactions) lines.push('', request.interactions);
  return lines.join('\n');
}

export interface LlmFlowAuthorModelOptions {
  /** A concrete AI SDK model. Omit to resolve the `generator` role from config. */
  model?: LanguageModel | undefined;
  id?: string | undefined;
  maxOutputTokens?: number | undefined;
  maxRetries?: number | undefined;
  factory?: LlmFactory | undefined;
}

/**
 * The only place this module constructs a `LanguageModel`. Everything else
 * depends on the `FlowAuthorModel` interface, which is what keeps the tests
 * offline and the provider swappable from config.
 */
export class LlmFlowAuthorModel implements FlowAuthorModel {
  readonly id: string;

  readonly #source: ModelSource;
  readonly #maxOutputTokens: number;
  readonly #maxRetries: number;

  constructor(options: LlmFlowAuthorModelOptions = {}) {
    if (options.model) {
      this.#source = { model: options.model };
      this.id = options.id ?? 'custom:author';
      this.#maxRetries = options.maxRetries ?? 2;
    } else {
      const factory = options.factory ?? new LlmFactory();
      this.#source = { factory, role: 'generator' };
      this.id = options.id ?? factory.forRole('generator').id;
      this.#maxRetries = options.maxRetries ?? factory.maxRetries;
    }
    this.#maxOutputTokens = options.maxOutputTokens ?? 8192;
  }

  async author(request: AuthorRequest): Promise<AuthorResult> {
    const { object, inputTokens, outputTokens } = await generateStructuredForModel(this.#source, {
      modelLabel: this.id,
      schema: AuthoredFlowSchema,
      system: buildSystemPrompt(request.policy ?? DEFAULT_MUTATION_POLICY, request.axTree !== undefined),
      prompt: buildUserPrompt(request),
      maxOutputTokens: this.#maxOutputTokens,
      maxRetries: this.#maxRetries,
    });

    let dropped = 0;
    // Narrow and keep each surviving step next to the case it was labelled with:
    // `toFlowStep` returns the runner's own union, which has no room for a label
    // that means nothing at execution time.
    const narrow = (steps: z.infer<typeof AuthoredStepSchema>[]): LabelledStep[] => {
      const narrowed = steps.map((raw) => ({ step: toFlowStep(raw), label: (raw.case ?? '').trim() }));
      dropped += narrowed.filter(({ step }) => step === null).length;
      return narrowed.filter((entry): entry is LabelledStep => entry.step !== null);
    };

    const body = narrow(object.steps);

    return {
      name: object.name,
      rationale: object.rationale,
      setup: narrow(object.setup).map(({ step }) => step),
      steps: body.map(({ step }) => step),
      cases: splitIntoCases(body, object.name),
      teardown: narrow(object.teardown).map(({ step }) => step),
      notes: object.notes,
      droppedSteps: dropped,
      inputTokens,
      outputTokens,
    };
  }
}

interface LabelledStep {
  step: FlowStep;
  /** The model's `case` value, trimmed. Empty means it named no case. */
  label: string;
}

/**
 * Partition an authored body into discrete cases.
 *
 * Two rules, and both are about not producing a case that lies:
 *
 * - **Consecutive steps with the same label are one case, and order is never
 *   changed.** Re-ordering to gather a label that appears twice would move steps
 *   past ones they depend on; two runs of the same name are two cases and get
 *   told apart by `uniqueNames`.
 * - **A case with no assertion is not a case.** It is preparation for the case
 *   that follows (or, at the end of the body, cleanup for the one before), so it
 *   is folded into that neighbour rather than run on its own — a case that
 *   asserts nothing passes whether or not the feature works, which is the exact
 *   false-confidence `hasAssertion` exists to stop.
 *
 * The concatenation of the returned cases always equals the input, so nothing is
 * dropped or duplicated by grouping.
 */
function splitIntoCases(body: readonly LabelledStep[], flowName: string): AuthoredCase[] {
  if (body.length === 0) return [];

  const runs: AuthoredCase[] = [];
  for (const { step, label } of body) {
    const current = runs[runs.length - 1];
    if (current !== undefined && current.name === label) current.steps.push(step);
    else runs.push({ name: label, steps: [step] });
  }

  // Fold every assertion-free run into a neighbour: forward by preference, since
  // a preamble belongs to what it prepares; backward for a trailing one, which
  // has nothing left to prepare.
  const merged: AuthoredCase[] = [];
  let pending: FlowStep[] = [];
  for (const run of runs) {
    if (!hasAssertion(run.steps)) {
      pending.push(...run.steps);
      continue;
    }
    merged.push({ name: run.name, steps: [...pending, ...run.steps] });
    pending = [];
  }
  if (pending.length > 0) {
    const last = merged[merged.length - 1];
    // No case asserted anything at all: hand the body back as one unnamed case
    // and let `FlowAuthor` refuse it, rather than inventing a case here.
    if (last === undefined) return [{ name: '', steps: [...pending] }];
    last.steps.push(...pending);
  }

  // An unlabelled single case takes the flow's own name; several unlabelled ones
  // would be indistinguishable in a report, so they are numbered.
  return uniqueNames(merged, flowName);
}

function uniqueNames(cases: AuthoredCase[], flowName: string): AuthoredCase[] {
  if (cases.length === 1) return [{ ...cases[0]!, name: cases[0]!.name || flowName }];
  const seen = new Map<string, number>();
  return cases.map((one, index) => {
    const base = one.name || `case ${index + 1}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return { ...one, name: count === 1 ? base : `${base} (${count})` };
  });
}

/** Narrow the flat authored shape back into the runner's step union. */
function toFlowStep(raw: z.infer<typeof AuthoredStepSchema>): FlowStep | null {
  const intent = raw.intent === '' ? undefined : raw.intent;
  const needsSelector = raw.selector === '';
  // Chrome's accessible names carry CSS `text-transform`, Playwright's matcher
  // does not — relax case on the way out so an authored flow resolves. See
  // `src/engine/selector.ts`.
  const selector = needsSelector ? '' : withRelaxedRoleName(withQualifiedRole(raw.selector));

  switch (raw.action) {
    case 'goto':
      return raw.url === '' ? null : { action: 'goto', url: raw.url };
    case 'click':
      return needsSelector ? null : { action: 'click', selector, intent };
    case 'waitFor':
      return needsSelector ? null : { action: 'waitFor', selector, intent };
    case 'fill':
      return needsSelector
        ? null
        : { action: 'fill', selector, value: raw.value, intent };
    case 'selectOption':
      return needsSelector || raw.value === ''
        ? null
        : { action: 'selectOption', selector, value: raw.value, intent };
    case 'check':
      return needsSelector ? null : { action: 'check', selector, intent };
    case 'uncheck':
      return needsSelector ? null : { action: 'uncheck', selector, intent };
    case 'type':
      return needsSelector || raw.value === ''
        ? null
        : { action: 'type', selector, value: raw.value, intent };
    case 'press':
      return raw.key === ''
        ? null
        : {
            action: 'press',
            key: raw.key,
            selector: selector === '' ? undefined : selector,
            intent,
          };
    case 'workflow':
      return raw.value === '' ? null : { action: 'workflow', goal: raw.value };
    case 'setLocalStorage':
      return raw.key === '' ? null : { action: 'setLocalStorage', key: raw.key, value: raw.value };
    case 'clearStorage':
      return { action: 'clearStorage' };
    case 'back':
      return { action: 'back', intent };
    case 'forward':
      return { action: 'forward', intent };
    case 'scrollTo':
      return needsSelector ? null : { action: 'scrollTo', selector, intent };
    case 'expectScrollable':
      // A page-level check needs no selector, so an empty one is valid here
      // rather than a reason to drop the step.
      return { action: 'expectScrollable', selector: selector === '' ? undefined : selector, intent };
    case 'snapshot':
      return raw.name === ''
        ? null
        : {
            action: 'snapshot',
            name: raw.name,
            selector: selector === '' ? undefined : selector,
          };
    case 'expectText':
      return needsSelector || raw.value === ''
        ? null
        : { action: 'expectText', selector, value: raw.value, intent };
    case 'expectVisible':
      return needsSelector ? null : { action: 'expectVisible', selector, intent };
    case 'expectHidden':
      return needsSelector ? null : { action: 'expectHidden', selector, intent };
    case 'expectEnabled':
      return needsSelector ? null : { action: 'expectEnabled', selector, intent };
    case 'expectDisabled':
      return needsSelector ? null : { action: 'expectDisabled', selector, intent };
    case 'expectFocused':
      return needsSelector ? null : { action: 'expectFocused', selector, intent };
    case 'expectCount': {
      // Every field arrives as a string; a non-numeric count is unusable rather
      // than something to guess at.
      const count = Number(raw.value);
      return needsSelector || !Number.isInteger(count) || count < 0
        ? null
        : { action: 'expectCount', selector, count, intent };
    }
    case 'expectUrl':
      return raw.value === '' ? null : { action: 'expectUrl', value: raw.value, intent };
    case 'expectValue':
      return needsSelector || raw.value === ''
        ? null
        : { action: 'expectValue', selector, value: raw.value, intent };
    case 'expectAttribute':
      return needsSelector || raw.name === ''
        ? null
        : {
            action: 'expectAttribute',
            selector,
            name: raw.name,
            value: raw.value,
            intent,
          };
    default:
      return null;
  }
}

export interface AuthoredFlow {
  flow: Flow;
  /**
   * The body, partitioned into cases that can each be run on their own. Never
   * empty: a body the model did not divide is one case. Concatenating them gives
   * back `flow.steps` exactly, so a caller that only wants the whole flow can
   * keep using it and see no change.
   */
  cases: AuthoredCase[];
  rationale: string;
  /** Hand-verification the model itself flagged. Empty string when none. */
  notes: string;
  /**
   * True when a live page's AX tree backed the selectors. False means every
   * selector is a placeholder — useful as a starting point, not as a test.
   */
  grounded: boolean;
  sourceUrl: string | undefined;
  model: string;
  authoredAt: string;
  /** Steps the model produced that could not be narrowed into a valid step. */
  droppedSteps: number;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  latencyMs: number;
}

export class AuthoringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthoringError';
  }
}

export interface FlowAuthorOptions {
  model: FlowAuthorModel;
  maxAxNodes?: number | undefined;
  /** Open the page's menus and disclosures before authoring. Default false. */
  probe?: boolean | undefined;
  maxProbes?: number | undefined;
  policy?: MutationPolicy | undefined;
  /** Called at each authoring lifecycle event — for live progress output. */
  onLog?: ((line: string) => void) | undefined;
}

export class FlowAuthor {
  readonly model: FlowAuthorModel;

  readonly #maxAxNodes: number;
  readonly #policy: MutationPolicy;
  readonly #onLog: ((line: string) => void) | undefined;
  readonly #probe: boolean;
  readonly #maxProbes: number | undefined;

  constructor(options: FlowAuthorOptions) {
    this.model = options.model;
    this.#probe = options.probe ?? false;
    this.#maxProbes = options.maxProbes;
    this.#maxAxNodes = options.maxAxNodes ?? DEFAULT_AUTHOR_MAX_NODES;
    this.#policy = options.policy ?? DEFAULT_MUTATION_POLICY;
    this.#onLog = options.onLog;
  }

  /**
   * Turn a request into a flow.
   *
   * Pass `page` (already navigated) to ground the selectors in what is really
   * on screen. Without it the flow is shape-correct but its selectors are
   * guesses, and `grounded` says so.
   */
  async author(prompt: string, page?: Page): Promise<AuthoredFlow> {
    const trimmed = prompt.trim();
    if (trimmed === '') throw new AuthoringError('prompt is empty — describe the test you want');

    const startedMs = Date.now();
    const url = page?.url();
    if (page) this.#onLog?.(`reading ${url}…`);
    const axTree = page ? await captureAxTree(page, this.#maxAxNodes) : undefined;

    // Opt-in: it clicks the page's disclosures, which costs a second or two and
    // is a mutation of on-screen state even though it never submits anything.
    let interactions: string | undefined;
    if (page && this.#probe) {
      this.#onLog?.('opening menus and disclosures to see what they reveal…');
      const report = await probeInteractions(page, { maxProbes: this.#maxProbes });
      for (const warning of report.warnings) this.#onLog?.(`probe: ${warning}`);
      const formatted = formatProbeReport(report);
      if (formatted) {
        interactions = formatted;
        this.#onLog?.(`found ${report.probes.length} disclosure(s) with hidden controls`);
      }
    }

    // Author → repair → validate → re-ask, in cost order, like the ladder:
    // a $0 mechanical fix first, one *informed* re-ask second (the healer's
    // rule — the value of a retry is entirely in knowing what was refused),
    // and only then the loud refusal, which `runCases` scores as blocked
    // rather than failed.
    const feedback: string[] = [];
    let result!: Awaited<ReturnType<FlowAuthorModel['author']>>;
    for (let attempt = 1; attempt <= AUTHOR_ATTEMPTS; attempt += 1) {
      this.#onLog?.(
        attempt === 1
          ? `asking the generator role to write the flow…`
          : `asking again with the refusal as feedback (attempt ${attempt}/${AUTHOR_ATTEMPTS})…`,
      );
      result = await this.model.author({
        prompt: trimmed,
        url,
        axTree,
        interactions,
        policy: this.#policy,
        ...(feedback.length > 0 ? { feedback } : {}),
      });
      const caseCount = result.cases?.length ?? 1;
      this.#onLog?.(
        `got ${result.steps.length} step(s)` +
          (caseCount > 1 ? ` in ${caseCount} discrete case(s)` : '') +
          (result.droppedSteps > 0 ? `, ${result.droppedSteps} dropped` : ''),
      );

      // $0 repair before any judgement: when the flow itself names its
      // sign-in page, a persona switch that forgot to navigate back to it is
      // a mechanical omission with exactly one fix, and the system applying
      // it (disclosed, never silent) beats refusing the case or re-asking a
      // model to type a `goto` we already know.
      const signInUrl = findSignInUrl([...(result.setup ?? []), ...result.steps]);
      if (signInUrl !== null) {
        const setup = result.setup ?? [];
        const repaired = groundCredentialFills(setup, result.steps, signInUrl);
        if (repaired.grounded > 0) {
          result.steps = repaired.steps;
          if (result.cases?.length) {
            result.cases = result.cases.map((one) => ({
              ...one,
              steps: groundCredentialFills(setup, one.steps, signInUrl).steps,
            }));
          }
          this.#onLog?.(
            `inserted ${repaired.grounded} sign-in navigation(s) before stranded credential fill(s) — ` +
              'the model switched identity without returning to the sign-in page',
          );
          result.notes =
            `${result.notes}${result.notes ? ' ' : ''}wowlidator inserted ${repaired.grounded} ` +
            `goto(s) to ${signInUrl} before credential fills that had no sign-in page to run against.`;
        }
      }

      try {
        // Same bar the generator holds itself to: a flow that asserts nothing
        // passes whether or not the feature works. Refusing is the point —
        // the alternative is handing back a green test that proves nothing.
        if (result.steps.length === 0) {
          throw new AuthoringError(
            'the model produced no usable steps. Try a more specific request, ' +
              'or ground it with --url so it can see the real controls.',
          );
        }
        if (!hasAssertion(result.steps)) {
          throw new AuthoringError(
            `the authored flow "${result.name}" contains no assertion, so it would pass ` +
              'without proving anything. Restate the request in terms of what should be ' +
              'TRUE afterwards (e.g. "...and the row count shows 8").',
          );
        }

        // A prompt instruction is a request; this filter is the guarantee.
        // Reaching it means the mechanical repair could not apply — the flow
        // never named a sign-in page to return to.
        const strandedAt = strandedCredentialFill([...(result.setup ?? []), ...result.steps]);
        if (strandedAt !== null) {
          throw new AuthoringError(
            `the authored flow "${result.name}" fills a credential field without first ` +
              `navigating to a sign-in page (step ${strandedAt}). A login form only exists ` +
              'on the sign-in page — add a goto to it before the fill (and before every ' +
              'persona switch), or the fill runs against whatever page came before.',
          );
        }

        const inventedUrl = ungroundedUrlExpectation(result.steps, axTree);
        if (inventedUrl !== null) {
          throw new AuthoringError(
            `the authored flow "${result.name}" expects the URL to contain ` +
              `"${inventedUrl.expected}" (step ${inventedUrl.index}), but that fragment ` +
              "appears in none of the tree's url= attributes and in no goto of the flow — " +
              'it reads like a path derived from a label. Take the expected URL from the ' +
              'url= of the control being clicked, or assert visible content of the ' +
              'destination instead.',
          );
        }

        const phantom = ungroundedCountRole(result.steps, axTree);
        if (phantom !== null) {
          throw new AuthoringError(
            `the authored flow "${result.name}" counts role "${phantom.role}" (step ` +
              `${phantom.index}), but no element with that role appears anywhere in the ` +
              "page's accessibility tree — the count will resolve zero elements on every " +
              'run. Count a role the tree actually lists (look at what the group ' +
              'container holds — e.g. buttons inside a radiogroup), or assert the ' +
              "items' visible text instead.",
          );
        }
        break;
      } catch (error) {
        if (!(error instanceof AuthoringError) || attempt === AUTHOR_ATTEMPTS) throw error;
        feedback.push(error.message);
        this.#onLog?.(`refused: ${error.message.split('\n')[0]}`);
      }
    }

    const flow: Flow = {
      name: result.name,
      ...(originOf(url) === undefined ? {} : { baseUrl: originOf(url) }),
      ...(result.setup.length > 0 ? { setup: result.setup } : {}),
      steps: result.steps,
      ...(result.teardown.length > 0 ? { teardown: result.teardown } : {}),
    };

    return {
      flow,
      // A model (or a stub) that named no cases still produced one: the body.
      cases:
        result.cases !== undefined && result.cases.length > 0
          ? result.cases
          : [{ name: result.name, steps: result.steps }],
      rationale: result.rationale,
      notes: result.notes,
      grounded: axTree !== undefined,
      sourceUrl: url,
      model: this.model.id,
      authoredAt: new Date().toISOString(),
      droppedSteps: result.droppedSteps,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      latencyMs: Date.now() - startedMs,
    };
  }
}

/** A URL that reads as a sign-in surface. */
const LOGIN_URL_PATTERN = /login|sign-?in|signin|auth|sso/i;

/**
 * A fill (or key-by-key `type`) that reads as a credential: it names a
 * password outright, or it is the nameless-textbox positional idiom the
 * sign-in guidance itself teaches (`role=textbox >> nth=N` — the password
 * field with no accessible name).
 */
function isCredentialFill(step: FlowStep): boolean {
  if (step.action !== 'fill' && step.action !== 'type') return false;
  const intent = 'intent' in step ? (step.intent ?? '') : '';
  if (/password/i.test(step.selector) || /password/i.test(intent)) return true;
  return /^role=textbox\s*>>\s*nth=\d+$/.test(step.selector.trim());
}

/**
 * The index of the first credential fill that no sign-in-page navigation
 * precedes, or null when every one is properly grounded.
 *
 * The walk mirrors execution order (pass `[...setup, ...steps]`): each `goto`
 * updates where the flow is, and a credential fill demands that the most
 * recent `goto` — if there has been one at all — looked like a sign-in page.
 * A flow that starts on the page it was given may legitimately begin with
 * credentials (the page may *be* the login screen); one that navigated to
 * `/workflows/…` and then fills a password is the PB-02-01 shape, and every
 * such fill runs against a page with no login form on it.
 */
export function strandedCredentialFill(steps: readonly FlowStep[]): number | null {
  let lastGoto: string | null = null;
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i]!;
    if (step.action === 'goto') {
      lastGoto = step.url;
      continue;
    }
    if (isCredentialFill(step) && lastGoto !== null && !LOGIN_URL_PATTERN.test(lastGoto)) {
      return i;
    }
  }
  return null;
}

/**
 * An authored `expectCount` that counts a role the page never exposes.
 *
 * The habit this catches: the model reads a `radiogroup` in the tree and
 * *infers* `role=radio` children — but the app renders the options as
 * `<button aria-pressed>` toggles, so `expectCount role=radio, 4` resolves
 * zero elements at any timeout, on every run, forever (PB-02-01, live). The
 * tree's lines each start with the node's role token, so "does this role
 * exist on the page" is a deterministic string check — and a refusal here
 * feeds the ordinary re-ask loop with the reason.
 *
 * Declines to judge a truncated tree: past the node budget, absence of
 * evidence is not evidence of absence — the same rule the tree's own
 * truncation notice states.
 */
export function ungroundedCountRole(
  steps: readonly FlowStep[],
  axTree: string | undefined,
): { index: number; role: string } | null {
  if (!axTree || axTree.includes('TREE TRUNCATED')) return null;
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i]!;
    if (step.action !== 'expectCount') continue;
    const selector = step.selector.trim();
    // Both spellings models actually emit: the role engine (`role=radio`) and
    // the CSS attribute form (`[role="radio"]`) — the same phantom either way.
    const match = /^role=([a-z]+)/i.exec(selector) ?? /^\[role="([a-z]+)"\]$/i.exec(selector);
    if (!match) continue;
    const role = match[1]!.toLowerCase();
    if (!new RegExp(`^${role}\\b`, 'im').test(axTree)) return { index: i, role };
  }
  return null;
}

/**
 * An `expectUrl` whose expected fragment appears in no evidence the author
 * had: not in any `url="…"` the tree carries, and not in any `goto` of the
 * flow itself.
 *
 * The habit this catches: the model derives a path from a control's LABEL —
 * a card reading "Time & Attendance" asserted `expectUrl "time-attendance"`
 * while the card routes to `/en/overtime` (live), filing a high defect
 * against an app that navigated correctly. The tree's `url=` attribute is
 * where a link actually points; the label is marketing.
 *
 * Deliberately exempt when a `workflow` step precedes the expectation in the
 * same list: the agent's journey ends on pages the authoring tree has never
 * seen, so grounding is impossible in principle there — and the agent
 * verifies its goal against the live page at run time anyway. Declines to
 * judge a truncated tree, same rule as `ungroundedCountRole`.
 */
export function ungroundedUrlExpectation(
  steps: readonly FlowStep[],
  axTree: string | undefined,
): { index: number; expected: string } | null {
  if (!axTree || axTree.includes('TREE TRUNCATED')) return null;
  const gotoUrls = steps
    .filter((step) => step.action === 'goto')
    .map((step) => (step as { url: string }).url);
  let afterWorkflow = false;
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i]!;
    if (step.action === 'workflow') {
      afterWorkflow = true;
      continue;
    }
    if (step.action !== 'expectUrl' || afterWorkflow) continue;
    const expected = (step as { value: string }).value;
    if (expected === '') continue;
    const grounded =
      axTree.includes(expected) || gotoUrls.some((url) => url.includes(expected));
    if (!grounded) return { index: i, expected };
  }
  return null;
}

/** The sign-in URL this flow itself names, when it names one. */
export function findSignInUrl(steps: readonly FlowStep[]): string | null {
  for (const step of steps) {
    if (step.action === 'goto' && LOGIN_URL_PATTERN.test(step.url)) return step.url;
  }
  return null;
}

/**
 * Repair stranded credential fills deterministically: splice the flow's own
 * sign-in `goto` back in front of each stranded login block.
 *
 * The refusal in `strandedCredentialFill` tells a human "add a goto to the
 * sign-in page before the fill" — and when the flow already names that page
 * (its first sign-in did), the system knows the exact fix it is asking a
 * human to type. Applying it is the same move `qualifyBareRole` makes for
 * selectors: a mechanical, unambiguous rewrite at narrowing time, disclosed
 * on the result rather than silent, and strictly better than either refusing
 * the case or running three fills against a page with no login form on it.
 *
 * The `goto` lands before the whole credential *block* — the contiguous run
 * of fills the stranded one belongs to — because a login block starts with
 * the email field, not the password field the detector flags. With no
 * sign-in URL to learn from, nothing is touched and the refusal stands: an
 * invented URL would be a guess, and this repo does not guess.
 */
export function groundCredentialFills(
  prefix: readonly FlowStep[],
  steps: readonly FlowStep[],
  signInUrl: string,
): { steps: FlowStep[]; grounded: number } {
  let lastGoto: string | null = null;
  for (const step of prefix) {
    if (step.action === 'goto') lastGoto = step.url;
  }

  const out: FlowStep[] = [];
  let grounded = 0;
  for (const step of steps) {
    if (step.action === 'goto') {
      lastGoto = step.url;
      out.push(step);
      continue;
    }
    if (isCredentialFill(step) && lastGoto !== null && !LOGIN_URL_PATTERN.test(lastGoto)) {
      let insertAt = out.length;
      // Walk back over the contiguous run of field entries (`fill` or `type`)
      // so the goto lands before the whole credential block, not mid-form.
      while (
        insertAt > 0 &&
        (out[insertAt - 1]!.action === 'fill' || out[insertAt - 1]!.action === 'type')
      ) {
        insertAt -= 1;
      }
      // `goto` carries no intent field; the insertion is disclosed on the
      // authored result's notes instead.
      out.splice(insertAt, 0, { action: 'goto', url: signInUrl });
      lastGoto = signInUrl;
      grounded += 1;
    }
    out.push(step);
  }
  return { steps: out, grounded };
}

/**
 * An authored flow, as one runnable flow per discrete case.
 *
 * `setup` and `teardown` are shared rather than divided up: setup is what a case
 * needs in order to start from a known place, so it runs again before each one —
 * which is exactly what stops case 4 inheriting the wreckage of case 3. That
 * repetition is the price of a case that can fail without ending the run, and it
 * is the right price: the alternative is not knowing about cases 4 to 6 at all.
 *
 * A single case keeps the flow's own name, because renaming it would start a new
 * line in the run history and lose everything that flow had proved before.
 */
export function caseFlows(authored: AuthoredFlow): { name: string; flow: Flow }[] {
  return authored.cases.map((one) => ({
    name: one.name,
    flow: {
      ...authored.flow,
      name: authored.cases.length === 1 ? authored.flow.name : `${authored.flow.name} — ${one.name}`,
      steps: one.steps,
    },
  }));
}

function originOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}
