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
import { parseExpectedCallEntry, type ExpectedCall } from '../api/expect-calls.js';
import { parseDbConditions } from '../db/db-actions.js';

import { SELECTOR_SYNTAX_RULES, captureAxTree } from '../healer/jit-healer.js';
import { withQualifiedRole, withRelaxedRoleName } from '../engine/selector.js';
import { matchesRoutePattern } from '../context/context-engine.js';
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
 * was refused is worth far more than the first.
 *
 * It was two — one informed re-ask — on the argument that a model ignoring
 * explicit named feedback once will ignore it twice. That held while the lint
 * set was small. It stopped holding as the set grew (`countPinnedName`,
 * `interruptedCredentialSubmit`, `unpinnedDateEntry`, `loginProofCannotFail`,
 * plus the CLI's DB-inventory gate): measured, one prompt ended with **no flow
 * at all** in 1 of 2 attempts, refused for "contains no assertion", because
 * removing the model's easiest assertion left it with nothing and there was
 * exactly one ask left to recover in. Three costs one more call on the runs
 * that were going to fail anyway, and is the difference between a weak test
 * and no test on the runs that were not.
 */
export const AUTHOR_ATTEMPTS = 3;

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
  // Backend claims. `expectCalls` entries and the DB conditions ride in the
  // existing flat string fields (see the field descriptions) — a nested array
  // here would break the very convention this list's absentees exist for.
  'expectCalls',
  'dbSnapshot',
  'expectDbRow',
  'expectDbDelta',
  'expectDbUnchanged',
  // The deliberate-HTTP family. Without it, an API-level claim (a health
  // endpoint, a seed endpoint, a JSON contract) could only be authored as a
  // goto to the endpoint or as an expectCalls the page never fires — both
  // seen live, both guaranteed-false against a working app.
  'request',
  'expectStatus',
  'expectJson',
  // Narrows to the runner's `expectDbRow` with an exact count and no/partial
  // where — the API-number-vs-database-number cross-check spelled flat.
  'expectDbCount',
  // A pinned clock is what makes "days remaining"-style claims checkable at
  // all; see the vocabulary entry.
  'setClock',
  // Deliberate modal interaction: assert the dialog opened before filling
  // its fields, close it when the journey is done.
  'expectModal',
  'closeModal',
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
      'Text to fill or type, the visible label of the option to select, expected substring, ' +
        'expected count as digits, storage value, or the goal for a workflow step. For ' +
        'expectCalls: the expected entries, ";"-separated, each "METHOD /path" with optional ' +
        '"-> status" and a "never:" prefix for forbidden calls. For expectDbRow: the expected ' +
        'column values as "col = value AND col = value" (may be empty). For expectDbDelta: ' +
        'the signed row-count change as digits. For request: the JSON body, or empty for none. ' +
        'For expectStatus: the expected status as digits. For expectJson: the expected value ' +
        '(empty asserts the path merely exists). For expectDbCount: the exact row count — ' +
        'digits or a saved {{variable}}. For setClock: the ISO date or date-time to pin the ' +
        'page clock to. Else empty.',
    ),
  url: z.string().describe('URL or path for goto. Else empty.'),
  key: z
    .string()
    .describe(
      'Key name for press, or storage key for setLocalStorage. For DB checks: the WHERE ' +
        'conditions as "col = value AND col = value" (expectDbRow, and optionally ' +
        'expectDbCount), or the snapshot name (dbSnapshot/expectDbDelta/expectDbUnchanged). ' +
        'For request: values to save from the response as "var = $.json.path AND var2 = $.x" ' +
        '(may be empty). For expectJson: the JSON path to read, e.g. "$.counts.persons". ' +
        'Else empty.',
    ),
  name: z
    .string()
    .describe(
      'Snapshot name, attribute name for expectAttribute, or the table name for DB checks ' +
        '(comma-separated tables for dbSnapshot/expectDbUnchanged; single table for ' +
        'expectDbRow/expectDbCount). For request: "METHOD /path", e.g. "POST /api/db/seed". ' +
        'For expectModal: the dialog\'s accessible name, or empty for any. Else empty.',
    ),
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

/** One declared table, formatted for the prompt's inventory section. */
export interface TableInventoryEntry {
  name: string;
  /** `id:uuid pk · status:text · …` — from the schema ingester's meta. */
  summary: string;
}

/**
 * How far the test is meant to reach.
 *
 * `unit` — one page, one thing proved. What authoring has always done, so it
 * stays the default: a default that silently changed what every existing
 * invocation produces would be wrong.
 *
 * `e2e` — the journey. Reach the page the way a user does, act, and verify on
 * the page that results. Asking for this is not a hint: it turns the journey
 * capture on regardless of `--capture-journey` (an end-to-end test whose
 * destination page was never read cannot be grounded — measured, 9 of 9 runs
 * without the journey tree handed the middle to a `workflow` step, 0 of 3
 * with it), and `notEndToEnd` refuses a flow that never leaves its first page.
 * A prompt instruction is a request; those two are the guarantee.
 */
export type TestScope = 'unit' | 'e2e';

export const TEST_SCOPES = ['unit', 'e2e'] as const;

export interface AuthorRequest {
  /** The author's description of the test they want. */
  prompt: string;
  /** URL the AX tree was captured from, when grounded. */
  url?: string | undefined;
  /** Accessibility tree of the live page. Absent means ungrounded. */
  axTree?: string | undefined;
  /**
   * The application's declared database tables, from the indexed schema.
   * Presence is the permission: with no inventory the prompt never mentions
   * DB checks and `toFlowStep` drops any the model emits anyway — the model
   * chooses among declared tables or not at all, the OpenAPI rule pointed at
   * state.
   */
  tables?: readonly TableInventoryEntry[] | undefined;
  /**
   * Controls that exist only after an interaction, from `probeInteractions`.
   * Separate from `axTree` on purpose — "behind a menu" is a different claim
   * from "on the page", and a flow that confuses them clicks a menu item
   * without opening the menu.
   */
  interactions?: string | undefined;
  /**
   * The accessibility tree of a page further along the journey, captured
   * because the description named its route — see `--capture-journey`.
   *
   * Its own field, never merged into `axTree`. The tree the flow's selectors
   * are checked against is the page the run STARTS on; this is a different
   * page, and a model that conflates them writes a click for a control that is
   * three navigations away. Same separation as `interactions`, and for a
   * sharper reason: the probe's controls are at least on the current page.
   *
   * It exists because the start page is frequently a login screen, so the
   * journey's real controls were structurally invisible: 9 of 9 measured
   * authoring runs delegated the middle of the test to a `workflow` step, one
   * of them saying so in its own notes.
   */
  journeyTree?: string | undefined;
  /**
   * What the application's repository declares — routes, components, API
   * operations, existing coverage — from a saved repo's indexed graph
   * (`toPromptContext`). Its own labelled section, apart from the tree and the
   * catalog: "declared in the code" is a different claim from "on the page",
   * and the page outranks it wherever they disagree.
   */
  projectContext?: string | undefined;
  /**
   * The account to sign in as, when the person running the command supplied
   * one. Its own labelled section in the prompt, and the only place a password
   * may come from: measured over nine authoring runs, a model with no
   * credentials invented one nine times out of nine, and a flow that cannot
   * sign in proves nothing about anything behind the login.
   */
  credentials?: { email: string; password: string } | undefined;
  /**
   * How far the test should reach — see `TestScope`. Absent means `unit`,
   * and an absent scope leaves the prompt byte-for-byte what it was before
   * this existed.
   */
  scope?: TestScope | undefined;
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
    '- NEVER purchase or perform a bulk or irreversible operation.\n' +
    '- Deleting is allowed ONLY when the request itself explicitly asks for the deletion ' +
    'AND names how the data comes back (a seed endpoint, a fixture reset). The claims ' +
    'gate approved that request; with no named restoration, do not delete — an ' +
    'irrecoverable delete is an irreversible operation whatever the claim says.',
};

const GROUNDED_RULES = `You have been given the accessibility tree of the live page.

- Every selector you emit MUST correspond to a node in that tree. Do not invent
  an id, class, or test id that does not appear there.
- If the request asks for something the tree does not contain, do NOT fabricate a
  selector for it. Emit the steps you can support and say plainly in "notes"
  which part could not be expressed and why.
- The tree describes ONE page state. Controls on the journey's other pages and
  dialogs are not in it — for those legs, a workflow step may act (see the
  workflow entry) with the claim settled by agent-independent evidence.`;

const UNGROUNDED_RULES = `You have NOT been given a page — you are working from the request alone.

- You cannot know this application's real selectors, so do not pretend to. Use
  readable role-based placeholders (role=button[name="Save"]) that an author will
  correct, and list every one of them in "notes" as needing verification.
- Keep the shape right even where the details must be guessed: correct actions,
  correct ordering, a real assertion.`;

/**
 * The scope halves. Deliberately four lines each: this prompt is already
 * ~6,500 tokens and every word of it is paid on every authoring call.
 */
const UNIT_SCOPE_RULES = `SCOPE: UNIT
Prove ONE thing on ONE page. Do not navigate away from the page you were given,
and do not sign in unless that page itself demands it. A short flow that proves
its one claim is the right answer here — do not widen it into a journey.`;

const E2E_SCOPE_RULES = `SCOPE: END-TO-END
Carry the WHOLE journey: reach the page the way a user reaches it, act, and
verify on the page that results. The flow must leave the page it starts on — a
flow confined to one page is not an end-to-end test and will be refused. Write
explicit grounded steps against every tree you were given, including a further
page's; keep workflow for a leg no captured tree covers.`;

/**
 * The scope block, or nothing at all.
 *
 * Nothing is what an absent scope must produce: every caller that predates
 * this feature passes no scope, and their prompt has to stay byte-for-byte
 * what it was — the `projectGraph` contract, applied again.
 */
const scopeRules = (scope: TestScope | undefined): string =>
  scope === undefined ? '' : `${scope === 'e2e' ? E2E_SCOPE_RULES : UNIT_SCOPE_RULES}\n\n`;

const buildSystemPrompt = (
  policy: MutationPolicy,
  grounded: boolean,
  scope: TestScope | undefined,
): string =>
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
                  Goal in "value". Decompose every requested user action (fill,
                  click, expect) into explicit grounded steps WHENEVER the
                  accessibility tree contains the controls — never use workflow
                  where the tree shows them. But the tree describes one page
                  state, and a journey's later pages and dialogs (a create
                  modal's fields, a row's edit button) are structurally absent
                  from it: for exactly those legs a workflow step MAY perform
                  the actions. When a section headed ANOTHER PAGE IN THIS
                  JOURNEY is present, that page is NOT absent — it was captured
                  for you. Write explicit grounded steps against its controls,
                  exactly as you would for the first tree, and keep workflow
                  for the legs no captured tree covers. State the goal precisely, with the concrete
                  values in it ("open RULE-TRV-001's edit dialog, set
                  entitlement amount to 75000, save"), and then settle the
                  claim with evidence INDEPENDENT of the agent — a DB check, a
                  request assertion, or page content read afterwards. An
                  assertion an agent made true proves nothing; an agent-driven
                  edit PROVEN BY the database row is evidence like any other.
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
- expectCalls     assert HTTP calls the page itself makes. Entries in "value",
                  ";"-separated, each "METHOD /path" (path templates like
                  /api/orders/:id are fine) with an optional "-> 2xx" or
                  "-> 201" status, and a "never:" prefix for a call that must
                  NOT happen. Use ONLY when the request itself claims specific
                  traffic (a sequence diagram's "Page -> API: POST /api/orders");
                  never invent endpoints — take them from the request or from
                  the declared operations, and place the step AFTER the user
                  action said to provoke the calls.
- dbSnapshot      record row counts of tables (comma-separated in "name";
                  snapshot name in "key", default "before") so a later DB check
                  can diff. Put it in setup, before the journey.
- expectDbRow     assert a row exists. Table in "name"; WHERE conditions in
                  "key" as "col = value AND col = value"; expected column
                  values (optional) in "value", same syntax. Prefer keying on a
                  {{variable}} a request step saved — that ties the row to THIS
                  run.
- expectDbDelta   assert a table's row count changed by exactly "value" (signed
                  digits) since the snapshot named in "key". Table in "name".
- expectDbUnchanged  assert row counts did not move for the comma-separated
                  tables in "name" since the snapshot in "key" — the
                  accidental-write check.
- expectDbCount   assert the table in "name" holds exactly "value" rows —
                  digits, or a {{variable}} a request saved, which is THE way
                  to check that a number an API reports equals the database's
                  own count. Optional WHERE conditions in "key".
                  DB checks are allowed ONLY when the request lists declared
                  database tables, and ONLY against tables from that list —
                  one not listed there will be refused at run time.
- request         an HTTP call the TEST makes itself. "name" is "METHOD /path"
                  (e.g. "GET /api/db/health", "POST /api/db/seed"); optional
                  JSON body in "value"; optional saves in "key" as
                  "var = $.json.path AND var2 = $.x" — later steps then use
                  {{var}} anywhere a value goes. THE PLANE RULE: use request
                  for any endpoint the claim says to call or verify (health
                  checks, seeds, API contracts); use expectCalls ONLY for
                  traffic the PAGE fires by itself while you drive its UI.
                  An expectCalls for a call nothing on the page makes can
                  never be observed and fails against a perfectly working
                  app. And NEVER goto an API endpoint — a navigation is not a
                  request and a POST endpoint will refuse it.
- expectStatus    assert the LAST request's status equals "value" (digits).
                  Every request that matters should be followed by one.
- expectJson      assert the LAST request's response body at the JSON path in
                  "key" (e.g. "$.counts.persons") equals "value"; with empty
                  "value" it asserts the path exists. This is how a response's
                  CONTENT is verified — a status alone proves reachability,
                  not correctness.
- setClock        pin the page's clock to "value" (ISO date or date-time), in
                  setup BEFORE the first goto. REQUIRED for any claim that
                  depends on what day it is — days remaining, due dates,
                  urgency tiers, expiries. Without a pinned clock such an
                  assertion exercises whatever today happens to be, and a
                  green result proves nothing about the boundary it names.
- expectModal     assert a dialog is open (its accessible name in "name", or
                  empty for any). After clicking a control that opens a
                  modal, assert it with expectModal BEFORE filling fields
                  inside it — fields of a dialog that has not opened resolve
                  nowhere, and the run cannot tell that from a missing
                  feature.
- closeModal      close the open dialog (optional close-button selector in
                  "selector").

**The body MUST contain at least one expect* step.** A flow that only clicks and
navigates passes whether or not the feature works, which is worse than no test:
it displaces the manual check that would have caught the bug.

An assertion must be able to FAIL. Never assert that a selector contains the very
text used to find it (expectText on text=Saved with value "Saved" proves nothing),
and prefer asserting the observable consequence of an action over asserting that
the control you just clicked still exists.

**A computed claim needs the computed value asserted, not a label sighted.**
When the claim states an arithmetic or derived relation — a due date equals
hire date + N days, a total equals the sum of its parts, a count equals what
an API reported — read the operands from the accessibility tree (or save them
from a request), compute the expected result yourself, and assert the CONCRETE
value with expectText / expectValue / expectDbCount. Asserting that the field's
label is visible passes whether the arithmetic is right or wrong, and a pass
that cannot fail is the claim going untested while the report says otherwise.

**Asserting a raw token must NOT appear: quote it exactly.** expectHidden with
unquoted text=extended is a case-insensitive SUBSTRING match — it fires on the
page's legitimate "Extended" label and files a leak defect about correct copy.
Write text="extended" (quoted = exact match) for a literal key, code or token,
and reserve the unquoted form for tokens no real copy could contain (snake_case
keys like pending_manager are safe either way).

**A claim you cannot make true from the browser is disclosed, never faked.**
A precondition no browser step can produce — a stopped database, a server
outage, a redeployed build, direct SQL writes — must not be authored as
assertions that would fail against the healthy environment. Author the
checkable subset, and name what was left out and why in "notes" and in the
first affected step's intent; an unchecked claim someone can read beats a red
defect about an app that is working. Two corollaries: NEVER follow a
disclosure with an assertion only the undisclosed action could make true — an
edit you could not perform, asserted as performed, fails against a working
app and files a false defect. And NEVER attach a note to a spare request step
as a comment carrier: a request is a real HTTP call with real effects, not a
place to write remarks — notes belong in "notes" and in the neighbouring
steps' own intents.

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

${scopeRules(scope)}SIGNING IN
If the page you were given is a sign-in page, or the flow needs a signed-in
user, log in explicitly and completely before anything else:
  1. goto the sign-in page.
  2. Fill EVERY field the form has. A password field usually has no accessible
     name of its own — if the tree shows a nameless textbox next to the email
     one, that is the password, and "role=textbox >> nth=1" addresses it.
     A form missing one field never submits, and every later step then runs
     against the sign-in page.
  3. Click the submit control. Then, BEFORE any goto, assert the login took
     effect: expectUrl of a non-login path, or expectVisible of something only
     a signed-in page shows. A click can land before the application has
     hydrated — the form then submits natively, no session is created, and
     every later step runs against the sign-in page; the assertion after the
     click is what catches that, and it is not optional.
  4. Then goto the page under test, and assert WHO is signed in — the account
     name or role the page's chrome shows — before testing anything that
     depends on it. A flow that proceeds as the wrong persona fails later,
     somewhere confusing, or worse: passes against a page the persona should
     never have seen.
Never assume a session already exists, and never switch user by filling the
login form from another page — go back to the sign-in page first. A login
form only exists on the sign-in page; filling "the password field" anywhere
else fills nothing, three steps in a row.
Claims about DIFFERENT personas belong in SEPARATE cases, each starting with
its own complete sign-in (goto the sign-in page, fill, submit). Setup runs
again before every case, so each persona gets a clean start — one case that
switches identity three times mid-stream is how a whole verification dies on
its second login.
If a "SIGN IN AS" section is present, those are the real credentials: fill them
EXACTLY as given, character for character, and never substitute a different
address or a password of your own. If there is NO such section, you have no way
to know a working password — use an obvious placeholder, and say plainly in
"notes" that the credentials are a guess and the flow will not sign in until
they are replaced. A guessed password does not merely fail: it fails at the
login, and every claim the flow makes after that is about the sign-in page.
NOTHING may be placed between the credential fields and the submit click — not
an assertion, not a wait. The engine recovers a sign-in that landed before the
page hydrated by replaying the fill block and the click together, and it only
recognises that shape when they are adjacent. Every check goes AFTER the click.

WHAT A CLAIM HAS TO BE MADE OF
1. Assert the value the page COMPUTED, never just that the field holding it is
   visible. If the journey enters 18:00 and 20:00 and the page derives "2 h",
   the claim is that it says 2 — a visibility check passes whether the
   arithmetic is right or wrong, which is the whole thing worth testing.
2. A record this flow creates is identified by a value THIS flow typed. Put a
   distinctive string in a free-text field (a reason, a note, a title) and
   assert THAT in the list afterwards. "A row appeared" and "MY row appeared"
   are different claims, and only the second one fails when the app drops the
   submission and shows somebody else's.
3. Quote the application's own words for a status. A store that models a state
   as "pending" frequently renders it as something else entirely ("Awaiting
   manager"); take the label from the accessibility tree, never from the state
   name or from the requirement's wording.
4. Never pin a live count inside a selector — "Status (3)" counts whatever the
   application holds right now, including rows a seed or an earlier run left.
   Match the stable part ("role=tab >> text=Status").
5. A date typed into a form needs setClock in setup. Date fields are gated on a
   window computed from today; unpinned, the flow passes now and fails when the
   window moves.
6. Claim the DATABASE only when the evidence shows the page reaching a backend.
   Plenty of screens persist to client-side storage and make no request at all;
   asserting a row against one of those files a high-severity backend defect
   against an application that is working exactly as built. When nothing in the
   evidence shows a call, assert what the page shows, and prove persistence the
   way the application actually does it — repeat the navigation and check the
   record is still there.
7. If the journey creates something the application keeps, start from a known
   state: clearStorage after the first goto, then goto again so the app
   rehydrates from empty. A form that refuses an overlapping or duplicate
   entry will otherwise fail on the previous run's data.

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
  // One line, next to the request it qualifies. The rules for each scope are
  // in the system prompt; this is only which of them applies to THIS test.
  if (request.scope) {
    lines.push(
      request.scope === 'e2e'
        ? 'Test scope: END-TO-END — the whole journey, and it must leave the page it starts on.'
        : 'Test scope: UNIT — one thing, on this page only.',
    );
  }
  if (request.feedback?.length) {
    lines.push(
      '',
      'Your previous attempt at this flow was REFUSED. Fix exactly this — do not repeat it:',
      ...request.feedback.map((entry) => `  - ${entry}`),
    );
  }
  // Its own labelled section, apart from the tree — "declared in the schema"
  // and "on the page" are different claims, the probe-report separation.
  if (request.tables?.length) {
    lines.push(
      '',
      'DECLARED DATABASE TABLES (from the indexed schema — DB checks may use these and no others):',
      ...request.tables.map((table) => `  ${table.name} (${table.summary})`),
    );
  }
  // Also its own labelled section, and the caveat is part of the label: a
  // static index can lag the deployed page, and a model that trusts it over
  // the tree writes selectors for code that has not shipped.
  if (request.projectContext) {
    lines.push(
      '',
      'WHAT THE REPOSITORY DECLARES (a static index of the application code — routes, endpoints, coverage. It may lag the live page; where they disagree, the accessibility tree wins):',
      request.projectContext,
    );
  }
  // Its own labelled section for the same reason as the two above: what the
  // person supplied is a different kind of claim from what the page shows, and
  // this one is the only fact in the prompt the model is forbidden to improve on.
  if (request.credentials) {
    lines.push(
      '',
      'SIGN IN AS (supplied by the person running this — use these characters exactly, ' +
        'never a variation and never an invention):',
      `  email: ${request.credentials.email}`,
      `  password: ${request.credentials.password}`,
    );
  }
  if (request.axTree) lines.push('', 'Accessibility tree:', request.axTree);
  if (request.interactions) lines.push('', request.interactions);
  // Last, and under a label that says which page it is. The order matters as
  // much as the label: the start page's tree is what the flow's early steps
  // are written against, and burying it under a second tree invites the model
  // to write step 1 for a page it has not navigated to yet.
  if (request.journeyTree) lines.push('', request.journeyTree);
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
      system: buildSystemPrompt(
        request.policy ?? DEFAULT_MUTATION_POLICY,
        request.axTree !== undefined,
        request.scope,
      ),
      prompt: buildUserPrompt(request),
      maxOutputTokens: this.#maxOutputTokens,
      maxRetries: this.#maxRetries,
    });

    let dropped = 0;
    const allowDb = (request.tables?.length ?? 0) > 0;
    const policy = request.policy ?? DEFAULT_MUTATION_POLICY;
    // Narrow and keep each surviving step next to the case it was labelled with:
    // `toFlowStep` returns the runner's own union, which has no room for a label
    // that means nothing at execution time.
    const narrow = (steps: z.infer<typeof AuthoredStepSchema>[]): LabelledStep[] => {
      const narrowed = steps.map((raw) => ({ step: toFlowStep(raw, allowDb, policy), label: (raw.case ?? '').trim() }));
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

/**
 * HTTP verbs an authored `request` may carry, by policy tier — the same
 * filter-not-sentence guarantee `ApiTestGenerator` applies to its operation
 * inventory, applied to the one authored action that reaches a server
 * directly. DELETE appears at no tier, ever.
 */
const REQUEST_VERBS_BY_POLICY: Record<MutationPolicy, readonly string[]> = {
  'read-only': ['GET', 'HEAD'],
  forms: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH'],
  mutations: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH'],
};

/**
 * Narrow the flat authored shape back into the runner's step union.
 *
 * `allowDb` is the structural half of the DB permission: with no table
 * inventory in the request, a DB step the model emitted anyway narrows to
 * null — a prompt instruction is a request, a filter is a guarantee. The
 * `policy` gates authored `request` verbs the same way.
 */
function toFlowStep(
  raw: z.infer<typeof AuthoredStepSchema>,
  allowDb: boolean,
  policy: MutationPolicy = DEFAULT_MUTATION_POLICY,
): FlowStep | null {
  const intent = raw.intent === '' ? undefined : raw.intent;
  // A CSS comment is not a selector, and a model that cannot find a control
  // sometimes "declines" by emitting one — `/* selector for X not found */` —
  // which then reaches Playwright as a parse error and burns the whole
  // reconstruction budget on a step that could never run (seen live,
  // DB_08_01). A step whose selector is commentary has no selector.
  const needsSelector = raw.selector === '' || raw.selector.trimStart().startsWith('/*');
  // Chrome's accessible names carry CSS `text-transform`, Playwright's matcher
  // does not — relax case on the way out so an authored flow resolves. See
  // `src/engine/selector.ts`. The U+2011 non-breaking hyphen is normalized to
  // ASCII first: models typeset ids like RULE‑FUEL‑002 with it (run 4's
  // DB_08_01, live), no DOM renders ids that way, and a selector quoting the
  // fancy glyph can never match the ASCII row it means.
  const selector = needsSelector
    ? ''
    : withRelaxedRoleName(withQualifiedRole(raw.selector.replace(/‑/g, '-')));

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
    case 'expectCalls': {
      if (raw.value === '') return null;
      const calls: ExpectedCall[] = [];
      const never: ExpectedCall[] = [];
      for (const entry of raw.value.split(/[;\n]/)) {
        const line = entry.trim();
        if (line === '') continue;
        const parsed = parseExpectedCallEntry(line);
        // One unparseable entry drops the whole step: a sequence assertion
        // missing one of its calls silently would check a different claim.
        if (parsed === null) return null;
        (parsed.never ? never : calls).push(parsed.call);
      }
      if (calls.length === 0 && never.length === 0) return null;
      return {
        action: 'expectCalls',
        ...(calls.length > 0 ? { calls } : {}),
        ...(never.length > 0 ? { never } : {}),
        intent,
      };
    }
    case 'dbSnapshot': {
      if (!allowDb || raw.name === '') return null;
      const tables = raw.name.split(',').map((t) => t.trim()).filter((t) => t !== '');
      if (tables.length === 0) return null;
      return { action: 'dbSnapshot', tables, as: raw.key === '' ? undefined : raw.key, intent };
    }
    case 'expectDbRow': {
      if (!allowDb || raw.name === '' || raw.key === '') return null;
      const where = parseDbConditions(raw.key);
      if (where === null || Object.keys(where).length === 0) return null;
      const values = raw.value === '' ? undefined : parseDbConditions(raw.value);
      if (values === null) return null;
      return {
        action: 'expectDbRow',
        table: raw.name.trim(),
        where,
        ...(values !== undefined && Object.keys(values).length > 0 ? { values } : {}),
        intent,
      };
    }
    case 'expectDbDelta': {
      if (!allowDb || raw.name === '') return null;
      const delta = Number(raw.value);
      if (!Number.isInteger(delta)) return null;
      return {
        action: 'expectDbDelta',
        table: raw.name.trim(),
        delta,
        since: raw.key === '' ? undefined : raw.key,
        intent,
      };
    }
    case 'expectDbUnchanged': {
      if (!allowDb || raw.name === '') return null;
      const tables = raw.name.split(',').map((t) => t.trim()).filter((t) => t !== '');
      if (tables.length === 0) return null;
      return {
        action: 'expectDbUnchanged',
        tables,
        since: raw.key === '' ? undefined : raw.key,
        intent,
      };
    }
    case 'expectDbCount': {
      // Narrows to the runner's expectDbRow: exact count, optional where. A
      // {{variable}} count survives as a string and interpolates at run time
      // — the API-vs-database cross-check.
      if (!allowDb || raw.name === '' || raw.value === '') return null;
      const where = raw.key === '' ? {} : parseDbConditions(raw.key);
      if (where === null) return null;
      const value = raw.value.trim();
      const isVariable = value.includes('{{');
      const numeric = Number(value);
      if (!isVariable && (!Number.isInteger(numeric) || numeric < 0)) return null;
      return {
        action: 'expectDbRow',
        table: raw.name.trim(),
        where,
        count: isVariable ? value : numeric,
        intent,
      };
    }
    case 'request': {
      const match = /^([A-Za-z]+)\s+(\S+)$/.exec(raw.name.trim());
      if (!match?.[1] || !match[2]) return null;
      const method = match[1].toUpperCase();
      // The policy filter is the guarantee; DELETE is in no tier's list.
      if (!REQUEST_VERBS_BY_POLICY[policy].includes(method)) return null;
      let save: Record<string, string> | undefined;
      if (raw.key !== '') {
        const parsed = parseDbConditions(raw.key);
        if (parsed === null) return null;
        save = {};
        for (const [name, path] of Object.entries(parsed)) {
          // A save that is not a JSON path would silently save nothing and
          // fail three steps later as an unknown variable — unusable, not
          // guessable, same rule as everywhere else in this switch.
          if (typeof path !== 'string' || !path.startsWith('$')) return null;
          save[name] = path;
        }
      }
      // A body that parses as JSON travels as the object (and is sent with a
      // JSON content type); anything else travels verbatim.
      let body: unknown;
      if (raw.value !== '') {
        try {
          body = JSON.parse(raw.value);
        } catch {
          body = raw.value;
        }
      }
      return {
        action: 'request',
        method,
        url: match[2],
        ...(body !== undefined ? { body } : {}),
        ...(save !== undefined && Object.keys(save).length > 0 ? { save } : {}),
        intent,
      };
    }
    case 'expectStatus': {
      const status = Number(raw.value.trim());
      return Number.isInteger(status) && status >= 100 && status <= 599
        ? { action: 'expectStatus', status, intent }
        : null;
    }
    case 'expectJson':
      return raw.key.startsWith('$')
        ? {
            action: 'expectJson',
            path: raw.key,
            ...(raw.value === '' ? {} : { value: raw.value }),
            intent,
          }
        : null;
    case 'setClock':
      return raw.value === '' || Number.isNaN(new Date(raw.value).getTime())
        ? null
        : { action: 'setClock', time: raw.value, intent };
    case 'expectModal':
      return { action: 'expectModal', ...(raw.name === '' ? {} : { name: raw.name }), intent };
    case 'closeModal':
      return { action: 'closeModal', ...(selector === '' ? {} : { button: selector }), intent };
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

/**
 * Whether a refusal is about a claim that is FALSE or one that is merely THIN.
 *
 * The distinction decides what happens when the attempt budget runs out, and
 * it is the whole of `#authorWithRetries`' contract. A `fatal` refusal —
 * no assertion at all, credentials filled on the wrong page, a URL derived
 * from a label, a count of a role the page never exposes — describes a flow
 * that would report something untrue, and emitting it is strictly worse than
 * emitting nothing. A `weak` refusal describes a flow that proves less than
 * it should; refusing that one on the last attempt costs the person the whole
 * flow, which is the outcome "feedback must never make the result worse" (see
 * `vacuousFormAssertion`) exists to forbid. Measured: a hard refusal of a
 * thin-but-runnable flow drew a re-ask that came back with a single step and
 * no assertion, so the person paid for the model's second answer and got
 * nothing.
 *
 * `fatal` is the default precisely so every throw site that predates this
 * keeps its present meaning; a lint opts INTO leniency, it never gets it by
 * omission.
 */
export type AuthoringErrorSeverity = 'fatal' | 'weak';

export class AuthoringError extends Error {
  readonly severity: AuthoringErrorSeverity;
  /**
   * The short form recorded on `AuthoredFlow.notes` when a `weak` refusal is
   * accepted rather than thrown. The message itself is written at the model
   * ("do this instead"); this is written at the person reading the report
   * ("here is what this flow does not prove"). Defaults to the message.
   */
  readonly note: string;
  /**
   * Every complaint this refusal carries, one per lint, unwrapped.
   *
   * `message` composes them for a person; this is what goes back to the model,
   * because `buildUserPrompt` renders `feedback` as a bulleted list and one
   * bullet per problem reads far better than one bullet containing three.
   * Defaults to `[message]`, so a single-lint refusal is byte-for-byte what it
   * always was.
   */
  readonly messages: readonly string[];

  constructor(
    message: string,
    options: {
      severity?: AuthoringErrorSeverity | undefined;
      note?: string | undefined;
      messages?: readonly string[] | undefined;
    } = {},
  ) {
    super(message);
    this.name = 'AuthoringError';
    this.severity = options.severity ?? 'fatal';
    this.note = options.note ?? message;
    this.messages = options.messages ?? [message];
  }
}

/** One lint's complaint about the flow just authored. */
export interface Violation {
  message: string;
  severity: AuthoringErrorSeverity;
  note: string;
}

/**
 * How many complaints one re-ask carries.
 *
 * The validation chain used to stop at the first lint that fired, so a model
 * with three problems needed three attempts merely to *learn about* three
 * problems — and each re-ask was free to trip a lint it had never been told
 * about. Measured on one prompt: a `--scope e2e` run was refused by three
 * DIFFERENT lints across its three attempts and produced no flow at all.
 * With 16 fatal lints against `AUTHOR_ATTEMPTS`, first-only reporting is a
 * denial of service on authoring rather than a quality gate.
 *
 * The cap exists for the opposite failure: ten complaints at once would crowd
 * the accessibility tree out of the prompt, and the tree is the only thing
 * that can actually ground the fix. Over the cap the count is disclosed, never
 * silently dropped — the same rule truncation follows everywhere else here.
 */
export const MAX_REPORTED_VIOLATIONS = 5;

/**
 * Several complaints as one refusal.
 *
 * A single violation composes to exactly the message that lint has always
 * raised — no wrapper, no renumbering — so the common case reads and tests
 * identically to before this existed.
 *
 * **Severity is computed across ALL violations, including any the cap left
 * out**: one fatal complaint makes the whole refusal fatal, and a flow that
 * says something untrue must never become returnable because two thin
 * complaints joined it. Only an all-weak refusal stays weak.
 */
export function composeRefusal(violations: readonly Violation[]): AuthoringError {
  const first = violations[0];
  if (first === undefined) throw new Error('composeRefusal called with no violations');
  const fatal = violations.some((violation) => violation.severity === 'fatal');
  const severity: AuthoringErrorSeverity = fatal ? 'fatal' : 'weak';

  if (violations.length === 1) {
    return new AuthoringError(first.message, { severity, note: first.note });
  }

  const shown = violations.slice(0, MAX_REPORTED_VIOLATIONS);
  const omitted = violations.length - shown.length;
  const header =
    `${violations.length} problems with the authored flow — fix all of them, not just the ` +
    `first${omitted > 0 ? `. The first ${shown.length}` : ''}:`;
  const body = shown.map((violation, index) => `  (${index + 1}) ${violation.message}`);
  const tail =
    omitted > 0
      ? [
          `  (${omitted} further problem(s) not listed — fix these and the rest are reported next.)`,
        ]
      : [];

  return new AuthoringError([header, ...body, ...tail].join('\n'), {
    severity,
    note: violations.map((violation) => violation.note).join('; '),
    messages: shown.map((violation) => violation.message),
  });
}

export interface FlowAuthorOptions {
  model: FlowAuthorModel;
  maxAxNodes?: number | undefined;
  /** Open the page's menus and disclosures before authoring. Default false. */
  probe?: boolean | undefined;
  maxProbes?: number | undefined;
  policy?: MutationPolicy | undefined;
  /**
   * Declared database tables, when a schema is indexed. Presence is the
   * permission to author DB checks — see `AuthorRequest.tables`.
   */
  tables?: readonly TableInventoryEntry[] | undefined;
  /** A saved repository's prompt section — see `AuthorRequest.projectContext`. */
  projectContext?: string | undefined;
  /** The account to sign in as — see `AuthorRequest.credentials`. */
  credentials?: { email: string; password: string } | undefined;
  /** A further page's tree — see `AuthorRequest.journeyTree`. */
  journeyTree?: string | undefined;
  /** How far the test must reach — see `TestScope`. Absent means `unit`. */
  scope?: TestScope | undefined;
  /**
   * Route patterns the selected repository declares. The third grounding
   * source for `expectUrl`, beside the tree's `url=` attributes and the flow's
   * own gotos — see `ungroundedUrlExpectation`.
   */
  declaredRoutes?: readonly string[] | undefined;
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
  readonly #tables: readonly TableInventoryEntry[] | undefined;
  readonly #projectContext: string | undefined;
  readonly #credentials: { email: string; password: string } | undefined;
  readonly #journeyTree: string | undefined;
  readonly #scope: TestScope | undefined;
  /** Route patterns the selected repository declares — grounding for expectUrl. */
  readonly #declaredRoutes: readonly string[];

  constructor(options: FlowAuthorOptions) {
    this.model = options.model;
    this.#probe = options.probe ?? false;
    this.#maxProbes = options.maxProbes;
    this.#maxAxNodes = options.maxAxNodes ?? DEFAULT_AUTHOR_MAX_NODES;
    this.#policy = options.policy ?? DEFAULT_MUTATION_POLICY;
    this.#tables = options.tables;
    this.#projectContext = options.projectContext;
    this.#credentials = options.credentials;
    this.#journeyTree = options.journeyTree;
    this.#scope = options.scope;
    this.#declaredRoutes = options.declaredRoutes ?? [];
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
    // Every attempt that was refused ONLY for being thin, kept in case the
    // budget runs out with nothing better. See `AuthoringErrorSeverity`: the
    // alternative to handing one of these over is handing over nothing, and
    // nothing is the worse answer whenever the refusal was about weakness
    // rather than falsehood.
    let weak: { result: typeof result; note: string } | null = null;
    let accepted = false;
    let lastRefusal: AuthoringError | null = null;
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
        ...(this.#tables?.length ? { tables: this.#tables } : {}),
        ...(this.#projectContext ? { projectContext: this.#projectContext } : {}),
        ...(this.#credentials ? { credentials: this.#credentials } : {}),
        ...(this.#journeyTree ? { journeyTree: this.#journeyTree } : {}),
        ...(this.#scope ? { scope: this.#scope } : {}),
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
        // Every lint runs and every complaint is collected before anything is
        // thrown. Stopping at the first one cost a whole attempt per problem
        // — see `MAX_REPORTED_VIOLATIONS` for the measurement.
        const violations: Violation[] = [];
        const refuse = (
          message: string,
          options: {
            severity?: AuthoringErrorSeverity | undefined;
            note?: string | undefined;
          } = {},
        ): void => {
          violations.push({
            message,
            severity: options.severity ?? 'fatal',
            note: options.note ?? message,
          });
        };

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
          refuse(
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
          refuse(
            `the authored flow "${result.name}" fills a credential field without first ` +
              `navigating to a sign-in page (step ${strandedAt}). A login form only exists ` +
              'on the sign-in page — add a goto to it before the fill (and before every ' +
              'persona switch), or the fill runs against whatever page came before.',
          );
        }

        const dbGap = dbClaimWithoutDbCheck(
          trimmed,
          [...(result.setup ?? []), ...result.steps],
          (this.#tables?.length ?? 0) > 0,
        );
        if (dbGap === 'unused') {
          refuse(
            `the authored flow "${result.name}" is for a claim that compares something to the ` +
              'database, the declared tables were provided, and yet no expectDbRow / ' +
              'expectDbCount / expectDbDelta step exists anywhere in it. Assert the comparison ' +
              'against the database itself (save the number with a request, compare with ' +
              'expectDbCount) — a case that only checks the value exists passes whether or not ' +
              'the numbers agree.',
          );
        }
        if (dbGap === 'no-schema') {
          // Aimed at the person, not the model: no re-ask can conjure an
          // inventory, so the informed retry would burn a call to be refused
          // for the same reason. Refusing is the honest outcome — the case is
          // reported blocked rather than passing on a UI proxy for a database
          // claim nobody checked.
          refuse(
            `the authored flow "${result.name}" is for a claim that compares something to the ` +
              'database, but no database schema is indexed — so no DB check can be written and ' +
              'any that were emitted have been dropped. This case cannot be proven as stated. ' +
              'Index the application\'s schema and select it for the run:\n' +
              '  wowlidator context add <app repo> --db-schema <schema.sql>\n' +
              '  …then pass --repo <slug> to this run.\n' +
              'Check the selected repository is the application under test — a repo with no ' +
              'table nodes silently removes every database claim from the suite.',
          );
        }

        const loginProof = loginProofAssertsLoginPage([...(result.setup ?? []), ...result.steps]);
        if (loginProof !== null) {
          refuse(
            `the authored flow "${result.name}" tries to prove the login took effect by ` +
              `expecting the URL to contain a sign-in path (step ${loginProof}) — an assertion ` +
              'that holds precisely when the login did NOT happen. Expect a non-login path, or ' +
              'expectVisible something only a signed-in page shows.',
          );
        }

        const weakProof = loginProofCannotFail([...(result.setup ?? []), ...result.steps]);
        if (weakProof !== null) {
          refuse(
            `the authored flow "${result.name}" proves the login by expecting the URL to ` +
              `contain "${weakProof.expected}" (step ${weakProof.index}) — but it signed in from ` +
              `"${weakProof.loginUrl}", which already contains that. expectUrl asserts CONTAINS, ` +
              'so this assertion holds just as well when the sign-in was rejected and the page ' +
              'never moved. Expect a path the login page does not contain (the landing route ' +
              'itself), or expectVisible something only a signed-in page shows.',
          );
        }

        const unsynchronized = unsynchronizedLoginSubmit([...(result.setup ?? []), ...result.steps]);
        if (unsynchronized !== null) {
          refuse(
            `the authored flow "${result.name}" clicks a sign-in submit (step ${unsynchronized}) ` +
              'and navigates away on the very next step, with nothing checking the login took ' +
              'effect. A click can land before the application hydrates — the form then submits ' +
              'natively and no session exists. Between the submit click and the next goto, add ' +
              'an expectUrl of a non-login path or an expectVisible of something only a ' +
              'signed-in page shows.',
          );
        }

        const inventedUrl = ungroundedUrlExpectation(result.steps, axTree, this.#declaredRoutes);
        if (inventedUrl !== null) {
          refuse(
            `the authored flow "${result.name}" expects the URL to contain ` +
              `"${inventedUrl.expected}" (step ${inventedUrl.index}), but that fragment ` +
              "appears in none of the tree's url= attributes and in no goto of the flow — " +
              'it reads like a path derived from a label. Take the expected URL from the ' +
              'url= of the control being clicked, or assert visible content of the ' +
              'destination instead.',
          );
        }

        // Weak, not false — so it earns the re-ask and then gets out of the way.
        // The one WEAK refusal in this file: it describes a claim that is thin,
        // not one that is false. It is thrown like every other lint — the
        // re-ask is where the value is — and the attempt loop is what decides
        // that a flow refused only for this is still worth handing over when
        // the budget runs out. That decision used to live here as an
        // `attempt < AUTHOR_ATTEMPTS` special case; it belongs to the loop,
        // which is the only place that can see every attempt.
        const unsettled = unsettledWorkflowClaim(result.steps);
        if (unsettled !== null) {
          refuse(
            `the authored flow "${result.name}" hands step ${unsettled} to the navigation agent ` +
              'and then checks nothing the agent did. The agent reports its own success and that ' +
              'report is not evidence — an expectUrl afterwards only says which page is open, ' +
              'not that the thing happened. After the workflow step, assert what the page now ' +
              'shows: the record in the list identified by a value the flow itself typed, a ' +
              'count that moved, or the status the application renders for it.',
            {
              severity: 'weak',
              note:
                `step ${unsettled} is handed to the navigation agent and nothing checks what it ` +
                'did — the agent reports its own success, and that report is not evidence. Add ' +
                'an assertion after it about what the page then shows.',
            },
          );
        }

        const pinnedCount = countPinnedName([...(result.setup ?? []), ...result.steps]);
        if (pinnedCount !== null) {
          refuse(
            `the authored flow "${result.name}" pins a live count inside an accessible name — ` +
              `"${pinnedCount.name}" (step ${pinnedCount.index}). That number counts whatever ` +
              'the application holds right now, including rows a previous run or a seed left ' +
              'behind, so the selector resolves on one state of the data and drifts on every ' +
              'other. Match the stable part of the control instead (for a tab, "role=tab >> ' +
              'text=Status"), and prove the record exists by asserting a value THIS flow typed.',
          );
        }

        const interrupted = interruptedCredentialSubmit([...(result.setup ?? []), ...result.steps]);
        if (interrupted !== null) {
          refuse(
            `the authored flow "${result.name}" puts step ${interrupted.index} between the ` +
              `credential fields and the submit click at step ${interrupted.click}. Nothing may ` +
              'come between them: the engine recovers a sign-in that landed before the page ' +
              'hydrated by replaying the fill block and the click together, and it only ' +
              'recognises that shape when they are adjacent. Interposed, the click submits the ' +
              'form natively, no session is created, and every later step runs against the ' +
              'sign-in page. Put the assertion AFTER the click.',
          );
        }

        const repeatedSubmit = duplicateCredentialSubmit([
          ...(result.setup ?? []),
          ...result.steps,
        ]);
        if (repeatedSubmit !== null) {
          refuse(
            `the authored flow "${result.name}" clicks the sign-in submit ` +
              `"${repeatedSubmit.selector}" twice (steps ${repeatedSubmit.first} and ` +
              `${repeatedSubmit.repeat}) with nothing re-typed in between. Do not write a retry: ` +
              'the engine already replays a submit that landed before the page hydrated, so by ' +
              'the time the second click runs the login has succeeded and the control is gone — ' +
              'the step fails and reads as a defect in the application. Click the submit once, ' +
              'then assert the login took effect.',
          );
        }

        const unpinnedDate = unpinnedDateEntry(result.setup ?? [], result.steps);
        if (unpinnedDate !== null) {
          refuse(
            `the authored flow "${result.name}" types the date "${unpinnedDate.value}" (step ` +
              `${unpinnedDate.index}) with no clock pinned. Applications gate date fields on a ` +
              'window computed from today — a payroll period, a cut-off, a booking horizon — so ' +
              'this flow passes now and fails on the day the window moves past the date, ' +
              'blaming the field. Add setClock in setup, before the first goto, and choose a ' +
              'date consistent with it.',
          );
        }

        // Only when the person asked for a journey. `fatal`: a single-page
        // flow is not a thinner end-to-end test, it is a different test, and
        // handing one back would answer a question nobody asked.
        if (this.#scope === 'e2e') {
          const confined = notEndToEnd(result.setup ?? [], result.steps, url);
          if (confined !== null) {
            refuse(
              confined === 'agent-journey'
                ? `the authored flow "${result.name}" was asked for an end-to-end test and ` +
                  'handed the journey to the navigation agent instead of writing it. Write the ' +
                  'steps: navigate to the page the test is about, act on its controls, and ' +
                  'assert on the page that results — the trees you were given include that ' +
                  'page. Keep workflow for a leg no captured tree covers.'
                : `the authored flow "${result.name}" was asked for an end-to-end test but never ` +
                  'leaves the page it starts on. An end-to-end test reaches the page the way a ' +
                  'user reaches it, acts, and verifies on the page that results — navigate, ' +
                  'then assert there.',
            );
          }
        }

        const phantom = ungroundedCountRole(result.steps, axTree);
        if (phantom !== null) {
          refuse(
            `the authored flow "${result.name}" counts role "${phantom.role}" (step ` +
              `${phantom.index}), but no element with that role appears anywhere in the ` +
              "page's accessibility tree — the count will resolve zero elements on every " +
              'run. Count a role the tree actually lists (look at what the group ' +
              'container holds — e.g. buttons inside a radiogroup), or assert the ' +
              "items' visible text instead.",
          );
        }
        // Order is source order, so two runs of one broken flow produce the
        // same feedback — the reason `temperature: 0` exists, applied to the
        // refusal rather than the generation.
        if (violations.length > 0) throw composeRefusal(violations);
        accepted = true;
        break;
      } catch (error) {
        // Anything that is not a judgement about the flow — a provider fault,
        // a bug in here — is nobody's second chance and propagates at once.
        if (!(error instanceof AuthoringError)) throw error;
        lastRefusal = error;
        if (error.severity === 'weak' && betterThan(result, weak?.result)) {
          weak = { result, note: error.note };
        }
        // One bullet per problem, not one bullet holding three:
        // `buildUserPrompt` renders each entry on its own line, and a model
        // fixes a list far more reliably than a paragraph.
        feedback.push(...error.messages);
        this.#onLog?.(`refused: ${error.message.split('\n')[0]}`);
      }
    }

    if (!accepted) {
      // Budget spent. A flow refused only for thinness is still a flow; one
      // refused for saying something untrue is not, and the loud refusal is
      // what `runCases` scores as blocked rather than failed.
      if (weak === null) throw lastRefusal ?? new AuthoringError('authoring produced no flow');
      result = weak.result;
      result.notes = result.notes === '' ? weak.note : `${result.notes}; ${weak.note}`;
      this.#onLog?.(`weak claim: ${weak.note}`);
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
/**
 * Exported because the journey capture needs exactly this rule: a capture that
 * bounced to a sign-in page must be discarded, not handed to the model under
 * the destination's name. Two spellings of "is this a login URL" would drift.
 */
export const LOGIN_URL_PATTERN = /login|sign-?in|signin|auth|sso/i;

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
/**
 * A credential submit the flow never checks took effect.
 *
 * The live failure: fill email, fill password, click Sign in, goto the page
 * under test — and the click landed before the app hydrated, so the form
 * submitted natively, no session exists, and the whole body runs against the
 * login page. The missing step is cheap and deterministic to demand: between
 * the submit click and the next `goto` there must be something that would
 * CATCH a login that did not take — an expect* or a waitFor. Returns the
 * 0-based index (into the given list) of the offending click, or null.
 *
 * Narrow on purpose: only a click that follows a password-shaped fill and is
 * immediately followed by a `goto` is flagged — any assertion or wait between
 * the two satisfies the rule, and flows that do not log in never match.
 */
/**
 * A database claim authored without a single database check, while the table
 * inventory was RIGHT THERE. The live failure (run 4's DB_01_01, authored by
 * a weaker model): "counts match the database exactly" became an assertion
 * that `$.counts` merely exists, with an intent confessing the numbers were
 * "verified outside this flow" — a green case about a comparison that never
 * happened. Deterministic trigger: the request's claim text compares
 * something to the database, tables were declared, and no expectDb* step
 * exists anywhere in the flow.
 */
export function dbClaimWithoutDbCheck(
  prompt: string,
  steps: readonly FlowStep[],
  tablesDeclared: boolean,
): false | 'unused' | 'no-schema' {
  const claimsDbComparison =
    /\b(match|equal|same as|identical)\w*\b[^.]*\b(sql|database|db)\b/i.test(prompt) ||
    /\b(sql|database|db)\b[^.]*\b(match|equal|same as|identical)\w*\b/i.test(prompt);
  if (!claimsDbComparison) return false;
  const hasDbStep = steps.some(
    (step) => step.action.startsWith('expectDb') || step.action === 'dbSnapshot',
  );
  if (hasDbStep) return false;
  // The two gaps are different problems for different people, and the second
  // used to disarm this lint entirely — `if (!tablesDeclared) return false`,
  // which is exactly backwards: with no inventory `toFlowStep` DROPS every DB
  // step the model emits, so the claim degrades to a UI or API proxy silently
  // and completely. Measured live (DB_01_01): a catalog run grounded in the
  // WRONG saved repo — one holding 0 table nodes — authored "GET
  // /api/db/health reports live counts that match the database exactly" as two
  // assertions on `$.ok` and `$.db`, read no count at all, and reported a
  // green pass. A claim the harness structurally cannot check must be refused
  // so `runCases` scores it blocked; blocked is not failed, and neither is it
  // a pass.
  return tablesDeclared ? 'unused' : 'no-schema';
}

/**
 * A "login took effect" assertion that can only prove it did NOT: expecting
 * the URL to contain the sign-in page's own path right after submitting
 * credentials. Live shape (run 4's DB_02_01): intent said "redirected away",
 * the assertion said `expectUrl /en/login` — which held precisely because
 * the login never happened, and the case sailed on green against the login
 * screen. Returns the offending step's index or null.
 */
/**
 * A post-login `expectUrl` that the login page itself satisfies.
 *
 * `loginProofAssertsLoginPage` catches the literal version — expecting
 * "/login" after signing in. This is the version that actually shipped:
 * `expectUrl "/en"` after a sign-in on `/en/login`. It reads like "we landed
 * somewhere else"; `expectUrl` asserts *contains*, and "/en/login" contains
 * "/en", so it holds precisely as well when the login failed.
 *
 * Measured: an authored flow with an invented password scored **12/12 passed**
 * — the sign-in was rejected, the engine's hydration replay dutifully retried
 * it, this assertion passed on the login page, and the agent then completed
 * the journey on a session a previous run had left in localStorage. A green
 * run of a test that proved nothing is the single worst thing this system can
 * produce, and it is a substring check away from being impossible.
 *
 * The login URL is taken from the flow's own most recent goto before the
 * credential submit — no guessing about what a sign-in page looks like.
 */
export function loginProofCannotFail(
  steps: readonly FlowStep[],
): { index: number; expected: string; loginUrl: string } | null {
  let lastGoto: string | null = null;
  let sawCredentialFill = false;
  let submittedFrom: string | null = null;
  for (const [index, step] of steps.entries()) {
    if (step.action === 'goto') {
      lastGoto = step.url;
      sawCredentialFill = false;
      submittedFrom = null;
      continue;
    }
    if (step.action === 'fill' || step.action === 'type') {
      if (isCredentialFill(step)) sawCredentialFill = true;
      continue;
    }
    if (step.action === 'click' && sawCredentialFill) {
      submittedFrom = lastGoto;
      sawCredentialFill = false;
      continue;
    }
    if (step.action === 'expectUrl' && submittedFrom !== null) {
      const expected = step.value.trim();
      // Empty is somebody else's problem; a fragment the login URL contains is
      // this one's.
      if (expected !== '' && submittedFrom.includes(expected)) {
        return { index, expected, loginUrl: submittedFrom };
      }
      submittedFrom = null;
    }
  }
  return null;
}

export function loginProofAssertsLoginPage(steps: readonly FlowStep[]): number | null {
  let sawCredentialFill = false;
  let sawSubmitClick = false;
  for (const [index, step] of steps.entries()) {
    if (step.action === 'fill' || step.action === 'type') {
      const text = `${(step as { selector?: string }).selector ?? ''} ${(step as { intent?: string }).intent ?? ''}`;
      if (/password|passwd|pwd/i.test(text)) sawCredentialFill = true;
      continue;
    }
    if (step.action === 'click' && sawCredentialFill) {
      sawSubmitClick = true;
      continue;
    }
    if (step.action === 'expectUrl' && sawSubmitClick) {
      if (/(^|\/)(login|signin|sign-in|auth|sso)(\/|$)/i.test(step.value)) return index;
      // A post-submit expectUrl of a non-login path is exactly right — done.
      sawCredentialFill = false;
      sawSubmitClick = false;
      continue;
    }
    if (step.action === 'goto') {
      sawCredentialFill = false;
      sawSubmitClick = false;
    }
  }
  return null;
}

export function unsynchronizedLoginSubmit(steps: readonly FlowStep[]): number | null {
  let sawCredentialFill = false;
  for (const [index, step] of steps.entries()) {
    if (step.action === 'fill' || step.action === 'type') {
      const text = `${(step as { selector?: string }).selector ?? ''} ${(step as { intent?: string }).intent ?? ''}`;
      if (/password|passwd|pwd/i.test(text)) sawCredentialFill = true;
      continue;
    }
    if (step.action === 'click' && sawCredentialFill) {
      const next = steps[index + 1];
      if (next !== undefined && next.action === 'goto') return index;
      sawCredentialFill = false;
      continue;
    }
    // Any non-fill step between the credential fill and a later click means
    // that click is no longer "the submit of this credential block".
    if (step.action !== 'click') sawCredentialFill = false;
  }
  return null;
}

/**
 * Assertions that read what actually happened, as opposed to where we ended up.
 *
 * `expectUrl` is deliberately absent. A URL says which page is open; it says
 * nothing about whether the thing the step was for took place, and after a
 * `workflow` step that is the entire question.
 */
const OUTCOME_ASSERTIONS = new Set([
  'expectText',
  'expectVisible',
  'expectHidden',
  'expectValue',
  'expectCount',
  'expectAttribute',
  'expectEnabled',
  'expectDisabled',
  'expectCalls',
  'expectStatus',
  'expectJson',
  'expectDbRow',
  'expectDbDelta',
  'expectDbCount',
  'expectDbUnchanged',
]);

/**
 * A `workflow` step whose outcome nothing checks.
 *
 * The agent reports its own success, and that report is not evidence: the
 * prompt has always said to settle an agent-driven leg with something
 * independent. This is the guarantee behind the sentence. It exists because
 * removing a *wrong* independent check is not an improvement — measured on one
 * prompt, teaching the author not to claim a database it has no evidence for
 * correctly deleted an unfounded `expectDbDelta` and left the flow ending on
 * `expectUrl "/en"`, which passes whether or not the request was ever
 * submitted. A weaker claim that cannot fail is the failure mode this whole
 * file exists to prevent.
 *
 * `expectUrl` does not count, on purpose. Navigation is not an outcome.
 */
/**
 * Which of two weakly-refused attempts to keep.
 *
 * Assertions are the point of a test — the rule the whole file is built on —
 * so the attempt that proves the most wins, and an earlier attempt wins a tie.
 * Earliest-on-a-tie matters: it makes the choice deterministic for the same
 * reason `temperature: 0` does, and a later attempt that was told exactly what
 * was wrong and changed nothing has given no evidence it is the better answer.
 */
function betterThan(
  candidate: { steps: readonly FlowStep[] },
  incumbent: { steps: readonly FlowStep[] } | undefined,
): boolean {
  if (incumbent === undefined) return true;
  return assertionCount(candidate.steps) > assertionCount(incumbent.steps);
}

function assertionCount(steps: readonly FlowStep[]): number {
  return steps.filter((step) => hasAssertion([step])).length;
}

export function unsettledWorkflowClaim(steps: readonly FlowStep[]): number | null {
  for (const [index, step] of steps.entries()) {
    if (step.action !== 'workflow') continue;
    const settled = steps
      .slice(index + 1)
      .some((later) => OUTCOME_ASSERTIONS.has(later.action));
    if (!settled) return index;
  }
  return null;
}

/** Why an `e2e` flow is not end to end. Each is a distinct thing to fix. */
export type NotEndToEndReason = 'one-page' | 'agent-journey';

/** The path of a url or a path-ish string, for comparing pages rather than urls. */
function pathOf(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '') return '';
  try {
    return new URL(trimmed).pathname;
  } catch {
    // A relative `goto` — already a path. Drop query and hash so "?tab=2" is
    // not mistaken for travel to another page.
    return (trimmed.split(/[?#]/)[0] ?? trimmed) || trimmed;
  }
}

/**
 * An `e2e` flow that never leaves the page it started on.
 *
 * The scope is a promise to the person who chose it, and the only way to keep
 * a promise like that is to check it. Measured this session: asked for the
 * overtime journey, authoring produced a flow whose entire body was one
 * `workflow` step and an `expectUrl` — nine runs out of nine before the
 * journey capture existed. Both shapes below are that degradation, and both
 * are indistinguishable from a working test until someone reads the flow.
 *
 * Conservative on purpose, because a false refusal costs a flow:
 * - pages are compared by PATH, so a second `goto` to the same page (the
 *   clearStorage-then-reload idiom) is not travel;
 * - a `workflow` step CAN navigate, so a flow containing one is not confined
 *   merely for containing it — only a flow whose journey IS that one step;
 * - the bar is "more than the page it started on", never a page count.
 */
export function notEndToEnd(
  setup: readonly FlowStep[],
  steps: readonly FlowStep[],
  startUrl: string | undefined,
): NotEndToEndReason | null {
  const all = [...setup, ...steps];
  const pages = new Set<string>();
  if (startUrl !== undefined) pages.add(pathOf(startUrl));
  for (const step of all) {
    if (step.action === 'goto') pages.add(pathOf(step.url));
    // An expectUrl is a claim about where the flow now is, so it is evidence
    // of travel exactly as a goto is — and it is the evidence a flow that
    // navigates by CLICKING leaves behind.
    if (step.action === 'expectUrl') {
      const claimed = pathOf(step.value);
      if (claimed !== '' && ![...pages].some((page) => page.includes(claimed))) {
        pages.add(claimed);
      }
    }
  }
  if (pages.size > 1) return null;

  // One page. Was the journey handed to the agent, or simply never written?
  // Different fixes, so different reasons.
  return steps.some((step) => step.action === 'workflow') ? 'agent-journey' : 'one-page';
}

/** A trailing "(3)" in an accessible name: a live count, not an identity. */
const COUNT_SUFFIX = /\(\s*\d+\s*\)\s*$/;

/**
 * A selector that pins a count inside an accessible name.
 *
 * The live case: a "Status (1)" tab. The count is every row the store holds,
 * including whatever a previous run, a seed or another tester left behind — so
 * the selector resolves on exactly one state of the data and drifts the moment
 * anything else exists. It is worse than a plain wrong selector because it
 * *works* the first time and then heals: the run goes green having paid a
 * model call to discover the number changed, which is a repair that will be
 * needed again on the next run and every run after it.
 *
 * Names that merely contain a number ("OT Day 1", "Step 2 of 4") are left
 * alone — the trailing parenthesised form is the count idiom specifically.
 */
export function countPinnedName(
  steps: readonly FlowStep[],
): { index: number; name: string } | null {
  for (const [index, step] of steps.entries()) {
    const selector = (step as { selector?: string }).selector;
    if (selector === undefined) continue;
    const named = /\[name\s*=\s*"([^"]*)"/.exec(selector);
    const name = named?.[1];
    if (name !== undefined && COUNT_SUFFIX.test(name)) return { index, name };
  }
  return null;
}

/**
 * A step wedged between the credential fills and the submit click.
 *
 * Not a style preference — measured. The engine's hydration replay
 * (`nativeFormResubmitDetected`) recovers a sign-in that landed before the
 * application hydrated, and it recognises the shape it repairs as *an adjacent
 * credential fill block followed by the click*. One assertion in between and
 * the replay does not fire: the click degrades to the form's native GET
 * submit, no session is created, and every later step runs against the
 * sign-in page. Proven by inserting a single expectValue into a flow that
 * passed 31/31 and watching the login stop working entirely.
 *
 * Only fires when a click really does follow before the next navigation —
 * otherwise the interposed step is not standing between anything.
 */
export function interruptedCredentialSubmit(
  steps: readonly FlowStep[],
): { index: number; click: number } | null {
  let inBlock = false;
  let sawPassword = false;
  for (const [index, step] of steps.entries()) {
    if (step.action === 'fill' || step.action === 'type') {
      inBlock = true;
      if (isCredentialFill(step)) sawPassword = true;
      continue;
    }
    if (!inBlock) continue;
    if (step.action === 'click') {
      inBlock = false;
      sawPassword = false;
      continue;
    }
    if (sawPassword) {
      for (let j = index + 1; j < steps.length; j += 1) {
        const later = steps[j];
        if (later === undefined || later.action === 'goto') break;
        if (later.action === 'click') return { index, click: j };
      }
    }
    inBlock = false;
    sawPassword = false;
  }
  return null;
}

/**
 * A sign-in submit clicked a second time, with nothing re-typed in between.
 *
 * The live shape (DB_02_01): `fill email · fill password · click "Sign in" ·
 * expectUrl · click "Sign in" · expectUrl`. The model wrote a defensive retry
 * — reasonable-looking, and a guaranteed false failure. The engine already
 * replays a submit that landed before the page hydrated
 * (`nativeFormResubmitDetected`), so by the time the second click runs the
 * login has succeeded and the "Sign in" button is gone: the step fails, and it
 * is filed as a `high` defect against an application that did exactly the
 * right thing.
 *
 * Note this is a repeated CLICK, not a repeated fill block. A second block
 * that re-types the credentials is a different shape and is left alone — it is
 * what a genuine second attempt looks like, and the engine's own replay emits
 * precisely that.
 *
 * Deliberately narrow, so it can only fire on the unambiguous case:
 * - the same submit selector, verbatim. A different control ("Sign in with
 *   Microsoft") is a different path and may be the point of the test.
 * - reset by any `goto` — going back to the sign-in page is how a legitimate
 *   persona switch is spelled, and the flow that does it means it.
 * - reset by any `fill`/`type` — that is a genuine retry with new input, not a
 *   bare re-click.
 * Anything else in between (an assertion, a wait) passes through, because the
 * live case has an `expectUrl` sitting right there.
 */
export function duplicateCredentialSubmit(
  steps: readonly FlowStep[],
): { first: number; repeat: number; selector: string } | null {
  let sawCredentialFill = false;
  let submit: { index: number; selector: string } | null = null;

  for (const [index, step] of steps.entries()) {
    if (step.action === 'goto') {
      sawCredentialFill = false;
      submit = null;
      continue;
    }
    if (step.action === 'fill' || step.action === 'type') {
      if (isCredentialFill(step)) sawCredentialFill = true;
      submit = null;
      continue;
    }
    if (step.action !== 'click') continue;
    if (submit !== null && submit.selector === step.selector) {
      return { first: submit.index, repeat: index, selector: step.selector };
    }
    if (sawCredentialFill) submit = { index, selector: step.selector };
  }
  return null;
}

/** A literal calendar date, the only kind a period gate can be checked against. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A date typed into the application with no clock pinned.
 *
 * A date field is almost never free: applications gate them on a period —
 * a payroll window, a cut-off, a booking horizon — computed from *today*. So
 * a flow that types a fixed date passes this week and fails on the day the
 * window moves, with a report that blames the field. Measured live: an
 * overtime form rejects any date outside the current 21st-to-20th payroll
 * period, computed from the real system date.
 *
 * `setClock` in setup is what makes the answer the same every run, and it is
 * the reason the action exists.
 */
export function unpinnedDateEntry(
  setup: readonly FlowStep[],
  steps: readonly FlowStep[],
): { index: number; value: string } | null {
  if (setup.some((step) => step.action === 'setClock')) return null;
  for (const [index, step] of steps.entries()) {
    if (step.action !== 'fill' && step.action !== 'type') continue;
    const value = String((step as { value?: unknown }).value ?? '').trim();
    if (ISO_DATE.test(value)) return { index, value };
  }
  return null;
}

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
  /**
   * Route patterns the indexed repository declares — the THIRD grounding
   * source, beside the tree's `url=` attributes and the flow's own gotos.
   *
   * Without it this lint refuses a path the application demonstrably has.
   * Measured: an `--scope e2e` run was refused for expecting "/en/time" —
   * a route the repo declares as `/:locale/time`, reached by clicking a hub
   * tile rather than by a goto, so neither of the other two sources could see
   * it. Three attempts, three different lints, no flow at all. A false refusal
   * costs the whole authoring call, so a lint that can consult more evidence
   * must consult it. `docs/repo-context-memory-spec.md` R4 asked for exactly
   * this and it was never wired.
   */
  declaredRoutes: readonly string[] = [],
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
      axTree.includes(expected) ||
      gotoUrls.some((url) => url.includes(expected)) ||
      // A concrete path against a declared pattern ("/en/time" vs
      // "/:locale/time"), or a bare fragment appearing in one ("overtime").
      declaredRoutes.some(
        (pattern) => matchesRoutePattern(expected, pattern) || pattern.includes(expected),
      );
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
