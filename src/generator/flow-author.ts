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
import { CONSENT_ACCEPT_NAME } from '../engine/sign-in.js';
import type { Page } from 'playwright';
import { z } from 'zod';

import { lenientObject } from '../providers/model-output.js';
import { parseExpectedCallEntry, type ExpectedCall } from '../api/expect-calls.js';
import { parseDbConditions } from '../db/db-actions.js';
import { BACKEND_TIER_ACTIONS } from '../engine/proof-bundle.js';

import { SELECTOR_SYNTAX_RULES, captureAxTree } from '../healer/jit-healer.js';
import { DETERMINISM_RULES, procedure, selfCheck } from '../providers/prompt-discipline.js';
import { withQualifiedRole, withRelaxedRoleName } from '../engine/selector.js';
import { matchesRoutePattern } from '../context/context-engine.js';
import { nearestRoutes, pathnameOf, routeIsDeclared } from '../context/route-match.js';
import { formatProbeReport, probeInteractions } from '../context/page-probe.js';
import { focusTreeText } from '../context/retriever.js';
import {
  LlmFactory,
  generateStructuredForModel,
  type ModelSource,
} from '../providers/llm-factory.js';
import { hasAssertion } from '../engine/runner.js';
import { vacuousClaim } from './vacuous.js';
import type { Flow, FlowStep } from '../engine/runner.js';
import { DEFAULT_MUTATION_POLICY, type MutationPolicy } from './test-generator.js';
import type { FlowReviewer, ReviewRecord } from './flow-review.js';

/** Same budget as the generator: the AX tree dominates the prompt either way. */
export const DEFAULT_AUTHOR_MAX_NODES = 200;

/**
 * Journey-tree lines kept after ranking against the row's own request —
 * see the narrowing in `author()`. The start tree is never narrowed this way:
 * it is the page the flow's first steps are written against, and on a catalog
 * it is the one section shared across rows.
 */
export const JOURNEY_TREE_MAX_LINES = 80;

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
 * How many distinct refusal shapes a suite carries forward into later rows'
 * FIRST attempt.
 *
 * Measured on be100-rip (2026-08-31): the run's refusals were the same two or
 * three families over and over — an `expectDbRows` on the case's own test data,
 * a `workflow` goal naming controls the repository declares. Each cost a full
 * authoring attempt (57 s, ~$0.44 on opus), per row, to teach the model a rule
 * it had already been taught on the row before. The feedback text already
 * exists and already works; it just never leaves the row that earned it.
 *
 * Six, and by frequency rather than recency: a lint that fired twenty times is
 * the one worth pre-empting, and a long list of near-misses would crowd the
 * request itself out of the model's attention — the failure mode this bound
 * exists to prevent.
 */
export const SUITE_REFUSAL_MEMORY = 6;

/**
 * A refusal's SHAPE — the rule it broke, with this row's particulars removed.
 *
 * Two refusals of the same lint differ only in the quoted names, the step
 * index and the numbers, so those are exactly what is stripped. Without this
 * the memory would fill with six variants of one lint and teach nothing.
 * Pure, so `tests/flow-author.test.ts` can pin it without a model.
 */
export function refusalShape(message: string): string {
  return message
    .split('\n')[0]!
    .toLowerCase()
    .replace(/"[^"]*"/g, '""')
    .replace(/\(step \d+\)/g, '(step)')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

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
  // Click a control only if it is on the page; otherwise carry on. Narrows to
  // the engine's `when { visible } then [click]`, whose condition is a probe
  // that never heals — so a consent gate, a "remember this device" prompt or
  // a cookie banner that appears on some runs and not others is one authored
  // step rather than a `workflow` leg (a model call per run) or a `click`
  // that fails setup on the runs where the gate does not show.
  'clickIfVisible',
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
  // End the session through the application's own sign-out control — the
  // persona-switch step. Deterministic engine procedure, no selector needed.
  'signOut',
  'back',
  'forward',
  'scrollTo',
  'expectScrollable',
  // Read a COUNT of matching elements / an element's TEXT into a named
  // variable (`value` = the name), for a later expectCount/expectText that
  // carries `{{name}}`. This is how "A matches B" is authored as a real
  // check: save the table's count, then expect the tile's text to hold it —
  // and how "no change after the action" is authored: save before, act,
  // expect the same reading after. EN-2 audit: ten missed bugs were
  // reconciliation claims asserted as mere presence.
  'saveCount',
  'saveText',
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
   * Whether backend steps may be written at all — see
   * `FlowAuthorOptions.backend`. Absent means yes, which is what every caller
   * meant before the toggle existed.
   */
  backend?: boolean | undefined;
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
  /**
   * Rules OTHER rows in this suite have already been refused for — see
   * `SUITE_REFUSAL_MEMORY`. Kept apart from `feedback` because the two are
   * different claims and the prompt must not conflate them: `feedback` says
   * "your previous answer to THIS question was wrong", which is a fact; this
   * says "the suite keeps making this mistake", which is a warning about a
   * pattern, and wording it as the former on a first attempt would be a lie
   * the model would then try to fix.
   */
  commonRefusals?: readonly string[] | undefined;
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
  /** Each dropped step with the reason, so the re-ask can say what to fix. */
  dropped?: DroppedStep[] | undefined;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
}

export interface DroppedStep {
  action: string;
  reason: string;
  intent: string;
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
  dialogs are not in it — for those legs, ground each step in WHAT THE
  REPOSITORY DECLARES when it names the control's rendered string (role +
  declared label), and reach for a workflow step ONLY where neither a tree nor
  the repository declares the control (see the workflow entry), with the claim
  settled by agent-independent evidence. Where a tree and the repository
  disagree, the tree wins — it is the live page.`;

const UNGROUNDED_RULES = `You have NOT been given a page — you are working from the request alone.

- You cannot know this application's real selectors, so do not pretend to. When
  WHAT THE REPOSITORY DECLARES names a control's rendered string, quote it —
  role=button[name="Create Plan" i] grounded in the code is a real selector,
  not a placeholder. Otherwise use readable role-based placeholders
  (role=button[name="Save"]) that an author will correct, and list every
  placeholder in "notes" as needing verification.
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

${DETERMINISM_RULES}

${procedure('HOW TO BUILD THE FLOW', [
  'Read the request and write down, for yourself: the persona and its exact credentials; the page or route under test; each CLAIM the request makes (one per line of its Expected output, or one per sentence that asserts something); any date the claim depends on; anything the request says is already true.',
  'setup = sign in (SIGNING IN, below), reach the page under test, and assert WHO is signed in. Nothing else goes in setup. If a date matters, setClock is the FIRST step of setup, before the first goto.',
  'EVERY TEST CASE HAS SOMETHING TO TEST — always. A body step that runs against the sign-in page is YOUR error, never a fact about the feature: the sign-in in setup must be complete (fill every field the form has, submit, prove it took) and the flow must have navigated to the page under test before the first body step. And never conclude a case cannot be tested: when the exact expected value is out of reach, assert the closest observable fact the page offers — the named element exists, the count reads as a number, the label the spec owns is rendered — and say in "notes" what was narrowed and why. A flow that tests nothing is not an answer.',
  'One case per claim. The case name is the request\'s own case id VERBATIM (TC_01_01, API_02_03 …); when the request lists several independent claims under one id, suffix them " / 1", " / 2" in the order the request states them. Never invent a case name when the request has an id, and never merge two claims into one case.',
  'For each case: the fewest steps that reach the claim, then the assertion(s) that would FAIL if the claim were false — nothing that passes either way. The sign-in proof and an expectUrl are PREPARATION, never the claim: EVERY numbered line of the Expected output (6.1, 6.2, …) gets its own assertion in the page terms that line names — the very element the line speaks of (the count box it names, the message it quotes, the option list it lists) — and the step\'s intent cites that line\'s number. A backend check may CORROBORATE a line, never replace it: a line about an on-screen number is proved by reading that number on screen. A case whose only assertions are the sign-in proof and a URL is refused.',
  'Every selector comes from a tree you were given, in the canonical form. When the control appears in NO tree but WHAT THE REPOSITORY DECLARES names its rendered string (a component\'s words, a message catalog\'s value), write the step deterministically against that string — role + declared label, e.g. role=button[name="Create Plan" i], expectText quoting the declared value. Only when neither a tree nor the repository declares the control may the leg be a workflow step (WORKFLOW GOALS, below) — deterministic steps cost $0 and run in milliseconds; an agent leg costs model calls per turn.',
  'EXPECTED VALUES ARE QUOTED, NEVER INVENTED: every value an assertion carries comes verbatim from the case (its Expected output, Test data or Note), from a document section, or from WHAT THE REPOSITORY DECLARES — in that order of authority. When the Expected output is too vague to assert (no value, no label, no message), take the anchor from the Note or the documents; when none of them holds one, say so in "notes" and assert the observable shape (the named element exists and holds a number) rather than inventing a value.',
  'A CLAIM THAT TWO READINGS AGREE IS TWO READINGS, COMPARED: "the tile matches the table", "the summary equals the column count", "the number does not change after the action" is NEVER proved by asserting one side exists. Author it as saveCount (or saveText) of one surface into a named variable — the variable NAME goes in the step\'s "value" field — then expectCount/expectText on the other surface carrying {{that-name}} — and for a no-change claim, save BEFORE the action and compare the same reading AFTER. A number printed in the Expected output ("1-15 of 43") is an illustration from the sheet-writer\'s data, never a value to assert; the saved reading is the value.',
  'Run the checklist at the end of these instructions and fix what fails.',
])}

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
- clickIfVisible  press a control ONLY if it is on the page right now, and
                  carry on either way. For an interstitial that appears on
                  some runs and not others — a consent page after sign-in, a
                  cookie banner, a "remember this device" prompt. Never for a
                  control the journey depends on: an optional click cannot
                  fail, so nothing after it may rely on it having happened.
- fill            type into a field. Text in "value".
- selectOption    choose a dropdown option. The option's VISIBLE LABEL in
                  "value", the dropdown control itself in "selector". Works on
                  a native select and on a custom combobox alike — never fill
                  a dropdown, and never click it open to guess at its items:
                  this one step opens it and picks. Name the control by role
                  and visible label (role=combobox[name="…"]), NEVER by DOM
                  internals (select:has(option…), option:checked) — no tree
                  shows those, and an internals selector dead-ends on any
                  custom widget.
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
                  values in it ("open ORD-1042's edit dialog, set
                  quantity to 3, save"), and then settle the
                  claim with evidence INDEPENDENT of the agent — a DB check, a
                  request assertion, or page content read afterwards. An
                  assertion an agent made true proves nothing; an agent-driven
                  edit PROVEN BY the database row is evidence like any other.
WORKFLOW GOALS — a workflow goal is judged by evidence, so write one the
                  evidence can settle. Every goal MUST: (a) cover ONE leg of
                  the journey, not the whole test; (b) name the concrete
                  values (ids, amounts, labels) taken verbatim from the
                  request; (c) when the leg ends on a different page, END with
                  the URL path the page will be on when the goal is met, in
                  the form "… and end on /orders/pending" — a goal
                  that names its destination is proved the moment the page
                  arrives there. NEVER a workflow step for: signing in when a
                  tree shows the sign-in form; accepting a consent page
                  (clickIfVisible); making an assertion true; anything a
                  captured tree already contains the controls for; any control
                  whose rendered string WHAT THE REPOSITORY DECLARES names —
                  write those as explicit steps on the declared strings, and
                  keep the goal to what neither a tree nor the repository
                  declares.
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
- signOut         end the session the way a user does: the engine finds and
                  clicks the application's own Sign out / Log out control
                  (opening the identity menu if it must). No selector. Use it
                  as the FIRST step of every persona switch, before the goto
                  to the sign-in page — never fill a login form while still
                  signed in, and never fake a sign-out with clearStorage: a
                  cookie-backed session survives the wipe.
- snapshot        visual regression baseline. Name in "name", optional selector.
- expectText      element's text CONTAINS "value".
- expectVisible / expectHidden      element is / is not visible.
- expectEnabled / expectDisabled    control is / is not interactive.
- expectCount     exactly "value" matches. "value" must be digits, or a
                  {{variable}} a saveCount/saveText step recorded.
- saveCount       read HOW MANY elements match the selector into a variable.
                  The VARIABLE NAME goes in "value" (e.g. value: "rows-before");
                  a later expectCount carrying {{rows-before}} compares it.
                  THE tool for a "matches" or "no change" claim.
- saveText        read the element's visible text into a variable. The VARIABLE
                  NAME goes in "value"; a later expectText carrying {{that-name}}
                  compares it on the other surface.
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
     one, that is the password, and input[type="password"] addresses it
     (role=textbox >> nth=1 if you must count). A form missing one field never
     submits, and every later step then runs against the sign-in page.
     TWO-STEP SIGN-IN: when the tree shows an identity field (email / work
     email / username) and a Next / Continue button but NO password field,
     the password screen only exists after that button. Write exactly:
       fill the identity field → click Next → fill input[type="password"]
       → click Sign in.
     The password field is not in the tree you were given because it does not
     exist yet — that is expected, and it is NOT a reason for a workflow step.
     If the identity field already shows a value in the tree, fill it anyway:
     fill replaces, and the pre-filled address may be someone else's.
  3. Click the submit control. Then, BEFORE any goto, assert the login took
     effect. THE CANONICAL PROOF, the same for every persona and every
     application: expectHidden of the very submit control you just clicked
     (role=button[name="Sign in" i]) — a sign-in that did not take leaves the
     form standing, one that did removes it, on the landing page and on a
     consent gate alike. Use expectUrl here ONLY with a path the evidence
     states outright (a SIGN-IN LANDING line, or a url= in a tree); never a
     path you infer from a route name or a persona — a guessed landing fails
     every run against a working sign-in, and it fails slowly. A click can
     land before the application has hydrated — the form then submits
     natively, no session is created, and every later step runs against the
     sign-in page; the assertion after the click is what catches that, and
     it is not optional.
     CONSENT GATE: if the request says a consent / terms / PDPA page can
     appear after sign-in (or the tree of a later page shows one), the step
     immediately after the submit click is
       clickIfVisible role=button[name="Accept and continue"]
     (the accept control's name exactly as the request or tree gives it). It
     is clickIfVisible, never click, because the gate shows once per person
     and a plain click fails every run after the first; and never a workflow
     step, because a model call to press one button every run is waste.
     Then the login assertion, which now also proves the gate was passed.
  4. Then goto the page under test, and assert WHO is signed in — the account
     name or role the page's chrome shows — before testing anything that
     depends on it. A flow that proceeds as the wrong persona fails later,
     somewhere confusing, or worse: passes against a page the persona should
     never have seen.
     QUOTE THAT IDENTITY FROM A TREE — the display name, role label or user
     id the chrome actually renders. NEVER assert that a credential the flow
     itself typed is displayed: a credential is what the test PUT IN, not
     what the page shows back — an application signs in with an email but
     renders a name, role or id, so expectVisible text="admin@…" fails on
     every run against a working application. When no tree shows the
     signed-in chrome, the expectHidden login proof above already carries
     the sign-in; do not invent a chrome check. A check the claim does not
     ask for and no tree grounds is out of the test's scope: leave it out.
Never assume a session already exists, and never switch user by filling the
login form from another page — go back to the sign-in page first. A login
form only exists on the sign-in page; filling "the password field" anywhere
else fills nothing, three steps in a row.
Claims about DIFFERENT personas belong in SEPARATE cases, each starting with
its own complete sign-in (goto the sign-in page, fill, submit) IN THAT CASE'S
OWN BODY — and then setup must NOT sign anyone in: setup runs again before
every case, so a sign-in there is the SAME persona for every case, and a case
that then visits the sign-in page as that persona finds no form there. When
cases share one persona, sign in once in setup; when they do not, setup holds
only setClock and the first goto, and each case signs in as its own persona.
SWITCHING PERSONA inside one flow, when unavoidable: signOut first — the
application's own sign-out path, which is itself part of what an end-to-end
test exercises — then goto the sign-in page and fill the NEXT account's
credentials completely. Never fill a login form while still signed in: the
application sends a signed-in user away from that form, and the fill fails
as "control not found" about a form that exists for a signed-out user. Never
substitute clearStorage for signing out: a cookie-backed session survives
the wipe and the login form never appears. A flow that switches personas is
an END-TO-END test and is marked so, whatever scope was asked for. One case
that switches identity three times mid-stream is how a whole verification
dies on its second login.
WHICH CREDENTIALS, in this order of precedence:
  1. The credentials the request ITSELF states for the persona it names (a
     "Login / persona" line, "sign in as X, password Y") — verbatim, character
     for character. A catalog names its own personas, and a case about one
     persona must sign in as that persona.
  2. Otherwise, the "SIGN IN AS" section when one is present — the account the
     person running this supplied. Fill it EXACTLY as given.
  3. Otherwise you have no way to know a working password: use an obvious
     placeholder and say plainly in "notes" that the credentials are a guess
     and the flow will not sign in until they are replaced.
Never invent a password when either source above gives one, and never
substitute one source's address for the other's. A guessed password does not
merely fail: it fails at the login, and every claim the flow makes after that
is about the sign-in page.
NOTHING may be placed between the credential fields and the submit click — not
an assertion, not a wait. The engine recovers a sign-in that landed before the
page hydrated by replaying the fill block and the click together, and it only
recognises that shape when they are adjacent. Every check goes AFTER the click.

WHAT A CLAIM HAS TO BE MADE OF
1. Assert the value the page COMPUTED, never just that the field holding it is
   visible. If the journey enters 18:00 and 20:00 and the page derives "2 h",
   the claim is that it says 2 — a visibility check passes whether the
   arithmetic is right or wrong, which is the whole thing worth testing.
   ANCHORING: a value that renders as its own text is asserted as
   expectVisible text="<the value>" — the value's presence IS the claim. Never
   anchor an expectText at a LABEL and assert the value beside it
   (expectText text=HIRE DATE = "20 Jul 2026" resolves the label's own node,
   which contains the label and not the date — it fails against a correct
   page, every run). Anchor at the node that holds the value, or at a
   container the tree shows holding both.
   WHICH VALUE: the value the CLAIM requires — computed from its own rule —
   never the value a note reports the app currently shows. A row marked
   KNOWN FAIL documents the wrong value on screen precisely so the test can
   assert the right one and report the failure; asserting the observed wrong
   value turns a documented defect into a green run.
2. A record this flow creates is identified by a value THIS flow typed. Put a
   distinctive string in a free-text field (a reason, a note, a title) and
   assert THAT in the list afterwards. "A row appeared" and "MY row appeared"
   are different claims, and only the second one fails when the app drops the
   submission and shows somebody else's.
3. Quote the application's own words for a status. A store that models a state
   as "pending" frequently renders it as something else entirely ("In
   review"); take the label from the accessibility tree, never from the state
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
- A bare number read off the tree — a count tile, a badge, an "x of y" — is
  never asserted as text unless the request itself states that number. The
  tree's number counts the data as it stands this minute; every run that
  creates or deletes a row moves it, and the assertion rots into a false
  defect against a working page. Anchor the claim to the labeled thing (the
  tile's label, a row identified by a value THIS flow typed); when the count
  itself is the claim and database tables are declared, prove it with
  expectDbCount instead.

${SELECTOR_SYNTAX_RULES}

${selfCheck([
  'Every case has at least one expect* step, and each would FAIL if its claim were false.',
  'When the request states an expected concrete value — a date, a number, an amount, an exact label ("the extension date should be 18 Nov 2026", "the tile shows at least 1") — that exact value is what an expect* step asserts; asserting that the field or card is merely visible is the claim going untested. If the request itself says the value currently comes out wrong (a KNOWN FAIL note), assert the value the claim REQUIRES, so the run reports the failure the note describes.',
  'Case names are the request\'s own case ids, verbatim; body steps of one case are contiguous.',
  'Nothing sits between the credential fills and the submit click — no assertion, no wait, no goto.',
  'A two-step sign-in has fill identity → click Next → fill input[type="password"] → click submit; a consent gate is a clickIfVisible right after the submit; then the login proof — expectHidden of the submit control, or an expectUrl of a path the evidence states outright, never one inferred; then goto the page under test.',
  'Every selector token (role, name, text) appears in a tree you were given, in canonical form; no CSS class or id the tree does not show; no live count inside a name.',
  'Every expectUrl fragment appears in a url= in a tree, or in one of this flow\'s own gotos, or in the request verbatim.',
  'setClock is the first setup step whenever a claim depends on today\'s date or a date is typed.',
  'No workflow step exists for a leg whose controls a given tree contains; every workflow goal names its concrete values and, when it changes page, ends with the destination path.',
  'No expect* step asserts a bare number the request does not state.',
  'Every unused field is an empty string, and every step has an intent.',
])}`;

export function buildUserPrompt(request: AuthorRequest): string {
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
  // The toggle, stated before the tables it overrides. A person who turned
  // the backend off gets visual proof with a note, not a wall of blocked
  // cases — and the note is the point: it says a stronger proof exists and
  // this run did not take it.
  if (request.backend === false) {
    lines.push(
      '',
      'BACKEND TESTING IS OFF for this run. Write NO request, expectStatus, expectJson, ' +
        'expectHeader, expectCalls, dbSnapshot or expectDb* step — every one of them will be ' +
        'dropped. Prove each claim through the PAGE: read the number the screen shows, assert the ' +
        'row the table renders, check the message the form displays. When a claim would be proved ' +
        'better against HTTP or the database (a count that must match the database, a status a ' +
        'request returns), still prove it visually AND say so in that step\'s "intent", beginning ' +
        'with "backend could prove this: " and naming what would be checked. Never skip the claim, ' +
        'and never pretend the visual check is the stronger one.',
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
  // Refusal feedback goes LAST, after every byte the retry shares with the
  // first attempt: the trees and context above are then an identical prefix
  // across all three authoring attempts, which is what lets a provider's
  // implicit prompt cache bill the resent capture at cache rates instead of
  // full price. Recency also puts the correction where the model weighs it most.
  // Before the row's own feedback and after every shared byte, for the same
  // caching reason — and because a correction about THIS flow should be the
  // last thing read.
  if (request.commonRefusals?.length) {
    lines.push(
      '',
      'MISTAKES ALREADY REFUSED ON OTHER ROWS OF THIS SUITE. They are not about this flow — ' +
        'they are the rules this catalog keeps breaking. Do not make them here:',
      ...request.commonRefusals.map((entry) => `  - ${entry}`),
    );
  }
  if (request.feedback?.length) {
    lines.push(
      '',
      'Your previous attempt at this flow was REFUSED. Fix exactly this — do not repeat it:',
      ...request.feedback.map((entry) => `  - ${entry}`),
    );
  }
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
    // 16k, not 8k: measured on the live catalog every authoring call of any
    // size was cut at 8k+cap and re-asked at double — the re-ask always
    // succeeded, and always cost a second call. A budget is billed only as
    // far as it is used, so the larger one is the cheaper one.
    this.#maxOutputTokens = options.maxOutputTokens ?? 16_384;
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
    const droppedDetail: DroppedStep[] = [];
    // Backend off (the run's own toggle) removes the whole family, DB
    // checks included: the person said this run does not test the backend,
    // and an indexed schema is permission, not an instruction.
    const allowBackend = request.backend ?? true;
    const allowDb = allowBackend && (request.tables?.length ?? 0) > 0;
    const policy = request.policy ?? DEFAULT_MUTATION_POLICY;
    // Narrow and keep each surviving step next to the case it was labelled with:
    // `toFlowStep` returns the runner's own union, which has no room for a label
    // that means nothing at execution time. A step that does not narrow is
    // kept as a REASON — measured on be100, the dropped steps were the whole
    // middle of the test, and a count alone told nobody what to fix.
    const narrow = (steps: z.infer<typeof AuthoredStepSchema>[]): LabelledStep[] => {
      const kept: LabelledStep[] = [];
      for (const raw of steps) {
        const step = allowBackend || !BACKEND_TIER_ACTIONS.has(raw.action)
          ? toFlowStep(raw, allowDb, policy)
          : null;
        if (step === null) {
          dropped += 1;
          droppedDetail.push({
            action: raw.action,
            reason:
              !allowBackend && BACKEND_TIER_ACTIONS.has(raw.action)
                ? BACKEND_OFF_REASON
                : dropReasonFor(raw, allowDb, policy),
            intent: raw.intent,
          });
          continue;
        }
        kept.push({ step, label: (raw.case ?? '').trim() });
      }
      return kept;
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
      dropped: droppedDetail,
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
/**
 * Rewrite a selector written in the AX TREE'S OWN notation into real selector
 * syntax.
 *
 * A model that reads the tree sometimes answers in the tree's vocabulary
 * (glm-4.5-flash, live, all three shapes in one catalog run):
 *
 * - `StaticText[text="20 Jul 2026"]` — CSS for a tag named StaticText;
 *   matches nothing, ever. The meaning is the text engine: `text="…"`.
 * - `role=cell[text="…"]` — the role engine has no `text` attribute and
 *   throws. A node's accessible name IS its text for these roles: `[name=]`.
 * - `role=link[url*="/en/…"]` — the tree prints `url=` on links; the role
 *   engine has no such attribute. A link's URL is its href: `a[href*="…"]`.
 *
 * Each rewrite is meaning-preserving and deterministic — the same $0 repair
 * `qualifyBareRole` makes for a dropped `role=` prefix, applied to the other
 * direction of the same confusion. Anything not matching these exact shapes
 * is returned untouched.
 */
export function fromTreeNotation(selector: string): string {
  const trimmed = selector.trim();
  // A chained tail (` >> nth=0`) rides along unchanged — seen live on the
  // very next run after the unchained form was handled: the $-anchored match
  // let `role=link[text="Review"] >> nth=0` through to Playwright verbatim.
  const chain = /\s*>>.*$/.exec(trimmed);
  const head = chain === null ? trimmed : trimmed.slice(0, chain.index);
  const tail = chain === null ? '' : trimmed.slice(chain.index);
  // Either quote style: a smaller model writes `[text='HR']` as readily as
  // `[text="HR"]`, and the single-quoted spelling sailed past every rewrite
  // here — seen live 2026-08-21, a whole catalog of `StaticText[text='…']`,
  // `heading[title='…']` and `textbox[placeholder='…']`, each one a guaranteed
  // miss that cost the full ladder and a healer call on a single-lane server.
  const Q = `(?:"([^"]+)"|'([^']+)')`;
  const pick = (m: RegExpExecArray, i: number): string => m[i] ?? m[i + 1] ?? '';
  const rewritten = ((): string | null => {
    const staticText = new RegExp(`^StaticText\\s*\\[text=${Q}\\]$`).exec(head);
    if (staticText !== null) return `text="${pick(staticText, 1)}"`;
    const linkUrl = new RegExp(`^role=link\\s*\\[url(\\*?)=${Q}\\]$`).exec(head);
    if (linkUrl !== null) return `a[href${linkUrl[1]}="${pick(linkUrl, 2)}"]`;
    const textAttr = new RegExp(`^(role=[a-z]+)\\s*\\[text=${Q}\\]$`).exec(head);
    if (textAttr !== null) return `${textAttr[1]}[name="${pick(textAttr, 2)}"]`;
    // `placeholder` is not an accessible name and not a role-engine attribute
    // (`qualifyBareRole` rightly declines it); the CSS form is what resolves.
    const placeholder = new RegExp(`^(?:role=)?(textbox|searchbox|combobox)\\s*\\[placeholder=${Q}\\]$`).exec(head);
    if (placeholder !== null) return `input[placeholder="${pick(placeholder, 2)}"]`;
    // `aria-label` IS the accessible name; `title` is the name of anything
    // with no other — both are the tree's `name`, written under the DOM's
    // attribute instead of the engine's.
    const labelAttr = new RegExp(`^(?:role=)?([a-z]+)\\s*\\[(?:aria-label|title)=${Q}\\]$`).exec(head);
    if (labelAttr !== null) return `role=${labelAttr[1]}[name="${pick(labelAttr, 2)}"]`;
    return null;
  })();
  return rewritten === null ? selector : rewritten + tail;
}

/**
 * Why `toFlowStep` returned null for this step, in words the model can act
 * on. Kept beside `toFlowStep` and derived from the same fields, so the two
 * cannot disagree about what was missing.
 */
/**
 * Why a backend step was dropped when the run's backend toggle is off.
 *
 * Its own constant because three places must say the same thing: the drop
 * detail the model is re-asked with, the step note a reader sees
 * (`backendHint`), and the tests that pin them together.
 */
export const BACKEND_OFF_REASON =
  'this run does not test the backend (the backend toggle is off) — prove the claim through the ' +
  'page instead, and the step will be marked as one a backend check could prove more directly';

export function dropReasonFor(
  raw: z.infer<typeof AuthoredStepSchema>,
  allowDb: boolean,
  policy: MutationPolicy = DEFAULT_MUTATION_POLICY,
): string {
  const noSelector = raw.selector === '' || raw.selector.trimStart().startsWith('/*');
  if (!(AUTHOR_ACTIONS as readonly string[]).includes(raw.action)) {
    return `"${raw.action}" is not an action this harness has — use one of: ${AUTHOR_ACTIONS.join(', ')}`;
  }
  if (/^(dbSnapshot|expectDb)/.test(raw.action) && !allowDb) {
    return 'a database check needs an indexed schema, and none was given — assert on the page instead';
  }
  if (
    raw.action === 'request' &&
    !(REQUEST_VERBS_BY_POLICY[policy] as readonly string[]).includes(raw.name.trim().split(/\s+/)[0]?.toUpperCase() ?? '')
  ) {
    return `the request's verb is not allowed under the ${policy} policy`;
  }
  if (raw.action === 'goto' && raw.url === '') return 'goto needs a url';
  if (raw.action === 'workflow' && raw.value === '' && raw.intent === '') return 'workflow needs a goal in "value"';
  if (noSelector && !/^(goto|workflow|setLocalStorage|clearStorage|signOut|back|forward|expectUrl|snapshot|expectScrollable|dbSnapshot|expectDb|request|expectStatus|expectJson|expectCalls|setClock|press)/.test(raw.action)) {
    return raw.selector.trimStart().startsWith('/*')
      ? 'the selector is a comment, not a selector — name a control from the tree'
      : 'the step names no selector — copy the control from the tree';
  }
  if (/^(fill|type|selectOption|expectText|expectValue|expectCount|expectAttribute|saveCount|saveText)$/.test(raw.action) && raw.value === '') {
    return /^save/.test(raw.action)
      ? `${raw.action} needs the VARIABLE NAME in "value" (e.g. value: "rows-before"; a later expect step compares {{rows-before}})`
      : `${raw.action} needs a value`;
  }
  return 'the step could not be narrowed to a runnable form (a field it needs is missing or malformed)';
}

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
    : withRelaxedRoleName(withQualifiedRole(fromTreeNotation(raw.selector.replace(/‑/g, '-'))));

  switch (raw.action) {
    case 'goto':
      return raw.url === '' ? null : { action: 'goto', url: raw.url };
    case 'click':
      return needsSelector ? null : { action: 'click', selector, intent };
    case 'clickIfVisible':
      return needsSelector
        ? null
        : {
            action: 'when',
            visible: selector,
            then: [{ action: 'click', selector, intent }],
            intent: intent ?? `click ${selector} if it is shown`,
          };
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
    case 'signOut':
      return { action: 'signOut', intent };
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
    case 'expectHidden': {
      if (needsSelector) return null;
      // The prompt's own quoting rule, applied mechanically where ignoring it
      // is guaranteed-false: an UNQUOTED single word in the text engine is a
      // case-insensitive substring match, so `expectHidden text=extended`
      // fires on the page's legitimate "Extended" label and files a leak
      // defect about correct copy (glm-4.5-flash, live, three of seven codes
      // in one flow — the snake_case four passed, the plain-word three could
      // only fail). Quoting narrows to an exact text node, which is what a
      // raw-code leak looks like. Words with spaces or a snake_case shape are
      // left exactly as written.
      const bareWord = /^text=([\p{L}\p{N}]+)$/u.exec(selector);
      return {
        action: 'expectHidden',
        selector: bareWord !== null ? `text="${bareWord[1]}"` : selector,
        intent,
      };
    }
    case 'expectEnabled':
      return needsSelector ? null : { action: 'expectEnabled', selector, intent };
    case 'expectDisabled':
      return needsSelector ? null : { action: 'expectDisabled', selector, intent };
    case 'expectFocused':
      return needsSelector ? null : { action: 'expectFocused', selector, intent };
    case 'expectCount': {
      // Digits, or a `{{variable}}` a saveCount/saveText step recorded — the
      // compare half of a reconciliation claim. Anything else is unusable
      // rather than something to guess at.
      if (/^\{\{[\w.-]+\}\}$/.test(raw.value.trim())) {
        return needsSelector ? null : { action: 'expectCount', selector, count: raw.value.trim(), intent };
      }
      const count = Number(raw.value);
      return needsSelector || !Number.isInteger(count) || count < 0
        ? null
        : { action: 'expectCount', selector, count, intent };
    }
    case 'saveCount':
      // `value` names the variable the reading lands in.
      return needsSelector || raw.value.trim() === ''
        ? null
        : { action: 'saveCount', selector, as: raw.value.trim(), intent };
    case 'saveText':
      return needsSelector || raw.value.trim() === ''
        ? null
        : { action: 'saveText', selector, as: raw.value.trim(), intent };
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
  /** What the authoring review did, when one ran — see `flow-review.ts`. */
  review?: ReviewRecord | undefined;
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
  /**
   * Total authoring attempts including the first (`AUTHOR_ATTEMPTS` when
   * absent). Selectable per run — 1 is "one ask, no re-ask budget": cheaper
   * and faster, at the price of losing the informed retry that the refusal
   * feedback exists for.
   */
  attempts?: number | undefined;
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
  /**
   * `METHOD /path` for every endpoint the selected repository declares — from
   * an OpenAPI document or, since 2026-08-25, from the file-convention
   * router's own exported handlers. The grounding source for an authored
   * `request`'s METHOD, which nothing could check before — see
   * `unindexedRequestMethod`.
   */
  declaredOperations?: readonly string[] | undefined;
  /**
   * Whether this run tests the BACKEND at all.
   *
   * Default `true` — the behaviour every run had before this existed. Set
   * false and the author may write no `request`, `expectStatus`, `expectJson`,
   * `expectHeader`, `expectCalls` or `expectDb*` step: a claim that would have
   * been settled against HTTP or the database is settled through the PAGE
   * instead, and the step says so (`backendHint`), so a reader knows the
   * claim has a stronger proof available and this run did not take it.
   *
   * The toggle exists because "prove it against the database" and "prove it
   * on screen" need different things from the person running it — a reachable
   * database, a spec whose endpoints are indexed — and a run that has neither
   * should produce honest visual proof with a note, not a wall of blocked
   * cases.
   */
  backend?: boolean | undefined;
  /**
   * A second look at the accepted flow against the codebase and documents
   * before it is handed back — the level above the lints. Absent means the
   * flow is exactly what the author wrote. See `flow-review.ts`.
   */
  reviewer?: FlowReviewer | undefined;
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
  readonly #declaredOperations: readonly string[];
  readonly #backend: boolean;
  readonly #reviewer: FlowReviewer | undefined;
  readonly #attempts: number;
  /**
   * Refusals this AUTHOR has already seen, across every row it has written —
   * shape → { exemplar, count }. One author instance writes a whole catalog,
   * so this is suite-scoped by construction. See `SUITE_REFUSAL_MEMORY`.
   */
  readonly #refusals = new Map<string, { exemplar: string; count: number }>();

  constructor(options: FlowAuthorOptions) {
    this.model = options.model;
    // Per-run option first, then the Machinery dial, then the constant.
    const dial = Number((process.env['WOWLIDATOR_AUTHOR_ATTEMPTS'] ?? '').trim());
    const fallback = Number.isInteger(dial) && dial >= 1 && dial <= 5 ? dial : AUTHOR_ATTEMPTS;
    this.#attempts =
      options.attempts !== undefined && Number.isFinite(options.attempts)
        ? Math.max(1, Math.floor(options.attempts))
        : fallback;
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
    this.#declaredOperations = options.declaredOperations ?? [];
    this.#backend = options.backend ?? true;
    this.#reviewer = options.reviewer;
    this.#onLog = options.onLog;
  }

  /** Remember a refusal by its shape, keeping the first message as the exemplar. */
  #rememberRefusals(messages: readonly string[]): void {
    for (const message of messages) {
      const shape = refusalShape(message);
      if (shape === '') continue;
      const held = this.#refusals.get(shape);
      if (held === undefined) this.#refusals.set(shape, { exemplar: message, count: 1 });
      else held.count += 1;
    }
  }

  /**
   * The mistakes this suite keeps making, most frequent first, bounded.
   *
   * Only shapes seen more than once travel: a lint that fired on exactly one
   * row is that row's problem, and pre-loading it onto unrelated rows is how a
   * memory turns into a bias. The second occurrence is the evidence that it is
   * a pattern rather than an accident.
   */
  #recalledRefusals(): string[] {
    return [...this.#refusals.values()]
      .filter((held) => held.count > 1)
      .sort((a, b) => b.count - a.count)
      .slice(0, SUITE_REFUSAL_MEMORY)
      .map((held) => held.exemplar);
  }

  /**
   * Turn a request into a flow.
   *
   * Pass `page` (already navigated) to ground the selectors in what is really
   * on screen. Without it the flow is shape-correct but its selectors are
   * guesses, and `grounded` says so.
   */
  async author(
    prompt: string,
    page?: Page,
    /**
     * Per-call evidence a caller captured for THIS prompt. A catalog authors
     * one row per call against one open page, and each row's journey ends on
     * its own page — so the destination tree cannot be a property of the
     * author; it is a property of the call.
     */
    extra: {
      journeyTree?: string | undefined;
      /**
       * A repository-context slice ranked against THIS row's own words,
       * overriding the author-wide `projectContext` for this call. Same
       * reasoning as `journeyTree`: a catalog authors one row per call, and
       * the routes that matter are the row's, not the whole project's.
       */
      projectContext?: string | undefined;
      /**
       * Evidence to author AGAINST from the first ask (S6): the pre-run risk
       * judge's concrete reasons ("the search box starts disabled", "no
       * Start-date filter exists") from a prior attempt of this same row.
       * The judge already knew the answer; it used to only shorten retries.
       */
      priorFeedback?: readonly string[] | undefined;
    } = {},
  ): Promise<AuthoredFlow> {
    const trimmed = prompt.trim();
    if (trimmed === '') throw new AuthoringError('prompt is empty — describe the test you want');
    // The journey capture ranked against THIS row's request. It is per-row
    // evidence already (each case captures its own destination), so unlike the
    // start tree there is no shared prompt prefix to preserve — and a dense
    // destination page otherwise bills every row for controls its claim never
    // mentions. The label line is always kept (which page this is IS the
    // evidence), the cut is disclosed inside the tree text, and under the cap
    // nothing changes. The narrowed text is also what the grounding lints
    // read, so the model and the lints see one tree, never two.
    const rawJourneyTree = extra.journeyTree ?? this.#journeyTree;
    const journeyTree =
      rawJourneyTree === undefined
        ? undefined
        : focusTreeText(rawJourneyTree, trimmed, JOURNEY_TREE_MAX_LINES, 1).text;

    const startedMs = Date.now();
    const url = page?.url();
    if (page) this.#onLog?.(`reading ${url}…`);
    const axTree = page ? await captureAxTree(page, this.#maxAxNodes) : undefined;
    // What the grounding lints may treat as evidence: EVERY tree the model was
    // given, not only the start page's. A journey tree carries the destination
    // page's `url=` attributes and roles, and a lint that ignored it refused —
    // three times running, live — an expectUrl the queue's own Review link
    // grounded, on the row the capture had been added to help.
    const evidenceTree =
      axTree === undefined && journeyTree === undefined
        ? undefined
        : [axTree ?? '', journeyTree ?? ''].filter((t) => t !== '').join('\n');

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
    // Seeded with the risk judge's prior reasons when the caller has them
    // (S6): the first ask then already authors AGAINST "the search box starts
    // disabled" instead of discovering it in a dead-ended run.
    const feedback: string[] = [...(extra.priorFeedback ?? [])];
    // Read once, before the first attempt: what this suite has already been
    // refused for. A row authored while nothing has been refused yet sends
    // nothing, which is byte-for-byte the prompt it always had.
    const recalled = this.#recalledRefusals();
    if (recalled.length > 0) {
      this.#onLog?.(
        `carrying ${recalled.length} rule(s) this suite has already been refused for into the first attempt`,
      );
    }
    let result!: Awaited<ReturnType<FlowAuthorModel['author']>>;
    // Every attempt that was refused ONLY for being thin, kept in case the
    // budget runs out with nothing better. See `AuthoringErrorSeverity`: the
    // alternative to handing one of these over is handing over nothing, and
    // nothing is the worse answer whenever the refusal was about weakness
    // rather than falsehood.
    let weak: { result: typeof result; note: string } | null = null;
    let accepted = false;
    let lastRefusal: AuthoringError | null = null;
    for (let attempt = 1; attempt <= this.#attempts; attempt += 1) {
      this.#onLog?.(
        attempt === 1
          ? `asking the generator role to write the flow…`
          : `asking again with the refusal as feedback (attempt ${attempt}/${this.#attempts})…`,
      );
      result = await this.model.author({
        prompt: trimmed,
        url,
        axTree,
        interactions,
        policy: this.#policy,
        ...(this.#tables?.length ? { tables: this.#tables } : {}),
        ...(this.#backend ? {} : { backend: false }),
        ...((extra.projectContext ?? this.#projectContext)
          ? { projectContext: extra.projectContext ?? this.#projectContext }
          : {}),
        ...(this.#credentials ? { credentials: this.#credentials } : {}),
        ...(journeyTree ? { journeyTree } : {}),
        ...(this.#scope ? { scope: this.#scope } : {}),
        ...(feedback.length > 0 ? { feedback } : {}),
        // What earlier rows of this suite were refused for. Sent on every
        // attempt: the rules do not stop applying once this row has its own
        // refusal to fix.
        ...(recalled.length > 0 ? { commonRefusals: recalled } : {}),
      });
      const caseCount = result.cases?.length ?? 1;
      this.#onLog?.(
        `got ${result.steps.length} step(s)` +
          (caseCount > 1 ? ` in ${caseCount} discrete case(s)` : '') +
          (result.droppedSteps > 0 ? `, ${result.droppedSteps} dropped` : ''),
      );
      for (const drop of result.dropped ?? []) {
        this.#onLog?.(`  dropped  ${drop.action}${drop.intent ? ` "${drop.intent.slice(0, 60)}"` : ''} — ${drop.reason}`);
      }

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

      // $0 repair, the same move for the VALUE: a sign-in block for the
      // supplied account that types a different password can only be an
      // invention (be100: 19 of 107 flows, each a whole red run). Mutates the
      // step objects in place, so the case lists see it too.
      if (this.#credentials) {
        const corrected = groundCredentialValues(
          [...(result.setup ?? []), ...result.steps],
          this.#credentials,
        );
        if (corrected > 0) {
          this.#onLog?.(
            `replaced ${corrected} invented credential value(s) with the supplied account's — ` +
              'the model typed a password of its own for the sign-in it was given',
          );
          result.notes =
            `${result.notes}${result.notes ? ' ' : ''}wowlidator replaced ${corrected} ` +
            'credential value(s) the model invented with the supplied sign-in password.';
        }
      }

      // A flow that switches personas is an end-to-end test whatever scope
      // was asked for (`Flow.scope` is stamped where the flow is assembled),
      // and every switch must travel the application's own sign-out path —
      // the prompt asks for a signOut step there; this is the guarantee.
      // After `groundCredentialFills`, so a stranded block has its goto by
      // the time this looks for where the signOut belongs.
      {
        const personas = switchesPersona(result.setup ?? [], result.steps);
        if (personas.length > 1) {
          const fixed = groundPersonaSwitches(result.setup ?? [], result.steps);
          let insertedTotal = fixed.inserted;
          if (fixed.inserted > 0) result.steps = fixed.steps;
          if (result.cases?.length) {
            result.cases = result.cases.map((one) => {
              const perCase = groundPersonaSwitches(result.setup ?? [], one.steps);
              if (perCase.inserted === 0) return one;
              insertedTotal += perCase.inserted;
              return { ...one, steps: perCase.steps };
            });
          }
          this.#onLog?.(
            `the flow switches persona (${personas.join(' → ')}) — an end-to-end journey; marked so`,
          );
          if (insertedTotal > 0) {
            this.#onLog?.(
              `inserted ${insertedTotal} signOut step(s) before persona switches — a switch must ` +
                "travel the application's own sign-out path, not fill a form the app hides from " +
                'signed-in users',
            );
            result.notes =
              `${result.notes}${result.notes ? ' ' : ''}wowlidator inserted ${insertedTotal} ` +
              'signOut step(s) before persona switches, so each re-login starts from the ' +
              "application's own signed-out state.";
          }
        }
      }

      // Same move for a consent accept the model placed after the first
      // post-login navigation or assertion — the assertion would run against
      // the gate and the accept would strand the run on the app's home page
      // (PL_02_09, docs/consent-gate-recovery-spec.md F3).
      {
        const early = settleConsentEarly(result.steps);
        let movedTotal = early.moved ? 1 : 0;
        if (early.moved) result.steps = early.steps;
        if (result.cases?.length) {
          result.cases = result.cases.map((one) => {
            const fixed = settleConsentEarly(one.steps);
            if (fixed.moved) movedTotal += 1;
            return fixed.moved ? { ...one, steps: fixed.steps } : one;
          });
        }
        if (movedTotal > 0) {
          this.#onLog?.(
            'moved a consent accept to immediately after the sign-in — it was placed after steps ' +
              'that would have run against the consent gate',
          );
          result.notes =
            `${result.notes}${result.notes ? ' ' : ''}wowlidator moved a consent-accept step to ` +
            'immediately after the sign-in block, so the flow\'s own goto re-navigates after the gate is cleared.';
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
        } else {
          // **A flow whose only assertions are the sign-in proof and a URL is
          // refused as if it asserted nothing** — measured on be100, that
          // exact shape was 20 of 22 `pass**` cases, each green about a row
          // whose Expected Output it never touched. Fatal: on the last
          // attempt the case is blocked (and re-authored on a resume), never
          // handed over as a test that passes whatever the application does.
          const vacuous = vacuousClaim([...(result.setup ?? []), ...result.steps]);
          if (vacuous !== null) {
            refuse(
              `the authored flow "${result.name}" proves nothing about its claim: ${vacuous}. ` +
                'Assert at least one line of the Expected output in the page\'s own terms — ' +
                'the options a dropdown lists, the exact error message, the count the page ' +
                'shows — after the step that reaches it. If that page is in no tree you were ' +
                'given, reach it with a precisely-goaled workflow step and assert what it then ' +
                'shows; if the assertion is impossible, say so in notes rather than omitting it.',
            );
          }
        }
        // Steps the model wrote that could not run ride along as a weak
        // complaint: alone they are a note; beside a refusal they are the
        // reason the refusal exists, and the re-ask must know what to fix.
        if ((result.dropped?.length ?? 0) > 0) {
          const list = (result.dropped ?? [])
            .slice(0, 6)
            .map((d) => `${d.action}${d.intent ? ` ("${d.intent.slice(0, 50)}")` : ''}: ${d.reason}`)
            .join('; ');
          refuse(
            `${result.dropped!.length} step(s) you wrote were dropped before they could run — ${list}. ` +
              'Rewrite each in a form the harness accepts.',
            { severity: 'weak', note: `${result.dropped!.length} step(s) dropped on narrowing: ${list}` },
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

        // **Before the wording lint**, which otherwise catches an undefined
        // placeholder incidentally and blames it on a data row — the
        // misdiagnosis that made three PL_02 rows rename the placeholder
        // instead of removing it. A placeholder is diagnosed as a placeholder.
        const unsaved = undefinedVariableRef([...(result.setup ?? []), ...result.steps]);
        if (unsaved !== null) {
          refuse(
            `the authored flow "${result.name}" reads {{${unsaved.name}}} (step ${unsaved.index}), ` +
              'but nothing in the flow ever saves that variable — the step asserts an unresolvable ' +
              'placeholder and fails on every run. ' +
              (unsaved.available.length > 0
                ? `Saved in this flow: ${unsaved.available.map((n) => `{{${n}}}`).join(', ')}. `
                : 'This flow saves no variables at all. ') +
              'Either save the reading first (saveText/saveCount with the VARIABLE NAME in "value", ' +
              'or a request step\'s save map) and compare against it, or drop the placeholder and ' +
              'assert the literal value quoted from the test case, its Note, the documents or the ' +
              'repository. Never invent a value.',
          );
        }

        const wordingOnData = wordingClaimAssertsDataValue(
          trimmed,
          [...(result.setup ?? []), ...result.steps],
          evidenceTree ?? '',
          extra.projectContext ?? this.#projectContext,
        );
        if (wordingOnData !== null) {
          refuse(
            `the authored flow "${result.name}" is for a claim about the page's WORDING, yet ` +
              `step ${wordingOnData.index} asserts "${wordingOnData.value}" — a value the test case ` +
              'never states and that the page shows only as a data row, if at all. A row is data, ' +
              'not spec: it can be deleted or renamed by another case and the assertion fails against ' +
              'a correctly worded page. Assert the labels the spec owns — the heading, breadcrumb, ' +
              "column headers, button and filter labels — quoting each from the test case's words or " +
              'from a heading/label node of the tree.',
          );
        }

        const wrongMethod = unindexedRequestMethod(
          [...(result.setup ?? []), ...result.steps],
          this.#declaredOperations,
        );
        if (wrongMethod !== null) {
          refuse(
            `the authored flow "${result.name}" calls ${wrongMethod.method} ${wrongMethod.path}, but the ` +
              `application declares that path only as ${wrongMethod.declared.join(', ')}. A handler with no ` +
              `${wrongMethod.method} answers 405 Method Not Allowed — a refusal of the request, never a finding ` +
              'about the application. Use one of the declared methods, or read the value from the page or the ' +
              'database instead of inventing a read endpoint.',
          );
        }

        const invented = ungroundedGoto(
          [...(result.setup ?? []), ...result.steps],
          this.#declaredRoutes,
          url === undefined ? undefined : new URL(url).origin,
        );
        if (invented !== null) {
          refuse(
            `the authored flow "${result.name}" navigates to "${invented.url}" (step ${invented.index}), ` +
              'but the application\'s own codebase declares no route for that path — the page does not ' +
              'exist, and every step after the navigation would be run against a 404. ' +
              (invented.near.length === 0
                ? 'Take the destination from a link in the tree, or reach it by clicking as a user would.'
                : `The nearest routes it does declare: ${invented.near.join(', ')}. Use one of those, ` +
                  'or reach the page by clicking as a user would.'),
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

        // **$0 mechanical repair before the lint**, the `groundCredentialFills`
        // move: the vacuous login proof (`expectUrl "/en/"` after a sign-in
        // from /en/login) was refused on nearly every row of every measured
        // run, and every refusal cost a full authoring call to learn what a
        // string replacement knows. The submit control the flow itself just
        // clicked is the honest witness: still on the page, the sign-in did
        // not take (a native GET resubmit leaves the form standing); gone, it
        // did — on the landing page and on a consent gate alike, and the goto
        // plus who-is-signed-in assertion that follow settle the rest.
        const grounded = groundLoginProof(
          result.setup ?? [],
          result.steps,
          `${evidenceTree ?? ''}\n${trimmed}`,
        );
        if (grounded !== null) {
          this.#onLog?.(`login proof grounded: ${grounded}`);
          result.notes = result.notes === '' ? grounded : `${result.notes}; ${grounded}`;
        }

        // A check generated out of the scope of the test is re-judged for
        // necessity before it can cost anything: an assertion that a
        // credential the flow itself typed is DISPLAYED came from the input
        // side of the test, not from the claim and not from the page, and it
        // fails on every run against a working application (PL_02_02: 42s of
        // ladder, patience, healer and reconstruction to disprove a string
        // the tree never contained, then a high defect). When the claim's own
        // assertions carry the proof, the echo is unnecessary and dropped —
        // the `groundCredentialFills` move, $0, disclosed, never silent. Only
        // when the echo is ALL the proof there is does it earn the informed
        // re-ask.
        {
          const typed = typedCredentialValues(result.setup ?? [], result.steps);
          const setupEchoes = credentialEchoAssertions(result.setup ?? [], typed, evidenceTree ?? '');
          const bodyEchoes = credentialEchoAssertions(result.steps, typed, evidenceTree ?? '');
          if (setupEchoes.length + bodyEchoes.length > 0) {
            const bodyKept = result.steps.filter((_, i) => !bodyEchoes.includes(i));
            if (bodyEchoes.length > 0 && !hasAssertion(bodyKept)) {
              refuse(
                `the authored flow "${result.name}" proves itself only by expecting a ` +
                  'credential the flow itself typed to be displayed on the page. A credential ' +
                  'is input, not expected output — an application signs in with an email but ' +
                  'renders a display name, role label or user id in its chrome, so this ' +
                  'assertion fails on every run against a working application. Assert what the ' +
                  'claim asks for, quoting text a tree actually shows.',
              );
            } else {
              const droppedDescs = [
                ...setupEchoes.map((i) => (result.setup ?? [])[i]),
                ...bodyEchoes.map((i) => result.steps[i]),
              ].map((s) => `${s!.action} ${(s as { selector: string }).selector}`);
              result.setup = (result.setup ?? []).filter((_, i) => !setupEchoes.includes(i));
              result.steps = bodyKept;
              if (result.cases?.length) {
                result.cases = result.cases.map((one) => {
                  const echoes = credentialEchoAssertions(one.steps, typed, evidenceTree ?? '');
                  if (echoes.length === 0) return one;
                  const kept = one.steps.filter((_, i) => !echoes.includes(i));
                  // A case whose only proof is the echo keeps it — the
                  // body-level refusal above is where that shape is judged.
                  return hasAssertion(kept) ? { ...one, steps: kept } : one;
                });
              }
              const droppedNote =
                `wowlidator dropped ${droppedDescs.length} out-of-scope check(s) asserting a ` +
                `credential the flow itself typed (${droppedDescs.join('; ')}) — a credential ` +
                'is input, not expected output; the page renders a name, role or id, never the ' +
                "sign-in email, and the claim's own assertions carry the proof.";
              this.#onLog?.(droppedNote);
              result.notes = result.notes === '' ? droppedNote : `${result.notes}; ${droppedNote}`;
            }
          }
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

        const inventedUrl = ungroundedUrlExpectation(result.steps, evidenceTree, this.#declaredRoutes);
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

        const volatileCount = volatileCountAssertion(
          [...(result.setup ?? []), ...result.steps],
          trimmed,
        );
        if (volatileCount !== null) {
          refuse(
            `the authored flow "${result.name}" asserts the bare number ` +
              `"${volatileCount.value}" (step ${volatileCount.index}), which the request never ` +
              'states — so it was read off the page, and it counts the data as it stands this ' +
              'minute. Every run that creates or deletes a row moves it, and the assertion rots ' +
              'into a false defect. Anchor the claim to the labeled thing instead (the tile\'s ' +
              'label, a row identified by a value THIS flow typed); when the count itself is ' +
              'the claim and tables are declared, prove it with expectDbCount. A number the ' +
              'request itself states may be asserted exactly.',
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

        // Only when the person asked for a journey. A single-page flow is not
        // a thinner end-to-end test, it is a different test, and handing one
        // back would answer a question nobody asked — that stays `fatal`. A
        // journey handed to the agent is `weak`: the flow travels, and it
        // proves less than it could. It was fatal once, and measured on a real
        // catalog the refusal fired three times running on a row whose
        // captured journey page was the WRONG page (the ranker's guess), so
        // the model was right to reach for the agent and the row was lost.
        // The workflow step now records the page before and after the agent
        // acted; the note says what to tighten.
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
              confined === 'agent-journey'
                ? {
                    severity: 'weak',
                    note:
                      'the journey is driven by the navigation agent rather than written as ' +
                      'steps — the workflow step records what the page showed before and ' +
                      'after, and the agent\'s turns are on the report; write the leg as ' +
                      'steps once its page has been captured',
                  }
                : {},
            );
          }
        }

        const codeEvidence = extra.projectContext ?? this.#projectContext;
        const unrendered = ungroundedTextExpectation(result.steps, evidenceTree, codeEvidence, trimmed);
        if (unrendered !== null) {
          refuse(
            `the authored flow "${result.name}" asserts the text ${JSON.stringify(unrendered.text)} ` +
              `(step ${unrendered.index}), but no element in the page's accessibility tree renders it — ` +
              'that is the requirement document\'s wording, and the step will dead-end on every run. ' +
              (unrendered.nearest.length > 0
                ? `The page renders: ${unrendered.nearest.map((n) => JSON.stringify(n)).join(', ')} — quote one of those, with its role from the tree, `
                : 'Quote a name the tree actually shows, with its role, ') +
              'and never the sheet\'s phrasing of it.',
          );
        }

        const unreconciled = unreconciledMatchClaim(result.steps, trimmed);
        if (unreconciled !== null) {
          refuse(
            `the case's Expected output makes a RECONCILIATION claim (${JSON.stringify(unreconciled)}), and the authored ` +
              'flow never compares the two readings — it only asserts that things exist, which passes whether or not they ' +
              'agree (ten such bugs shipped green in the EN-2 audit). Author it as: saveCount (or saveText) of one surface ' +
              'into a variable — the variable NAME goes in the step\'s "value" field (e.g. value: "rows-before") — ' +
              'then expectCount/expectText on the other surface carrying {{that-variable}}; for a ' +
              '"no change" claim, save before the action and compare the same reading after it.',
          );
        }

        const fixture = ungroundedFixtureAssertion(result.steps, fixtureFacts(trimmed));
        if (fixture !== null) {
          refuse(
            `the authored flow "${result.name}" ${fixture.action}s on ${JSON.stringify(fixture.fact)} (step ${fixture.index}) as if it ` +
              'already existed in the application — but that value is the case\'s TEST DATA: something the tester types ' +
              'or creates, not a fact about the app. Nothing earlier in this flow creates it. Either author the creation ' +
              '(the fill/insert steps that put it there) before asserting on it, or assert the SHAPE of the result ' +
              '(a row exists, a count is a number) without naming the fixture value.',
          );
        }

        const wrongRole = ungroundedSelectorRole(result.steps, evidenceTree);
        if (wrongRole !== null) {
          refuse(
            wrongRole.disabled
              ? `the authored flow "${result.name}" ${result.steps[wrongRole.index]?.action ?? 'acts on'}s ${JSON.stringify(wrongRole.name)} (step ${wrongRole.index}), ` +
                `but the tree shows it DISABLED at rest: ${wrongRole.nearest[0]}. Something else must enable it first ` +
                '(a filter chosen, a mode entered) — do that step before this one, or assert its disabled state instead.'
              : `the authored flow "${result.name}" names role "${wrongRole.role}"${wrongRole.name === null ? '' : ` for ${JSON.stringify(wrongRole.name)}`} ` +
                `(step ${wrongRole.index}), but no element of that role is anywhere in the page's accessibility tree — the step will resolve ` +
                'nothing on every run. ' +
                (wrongRole.nearest.length > 0
                  ? `The page exposes it as: ${wrongRole.nearest.map((l) => `\`${l}\``).join(', ')} — use that role and name verbatim.`
                  : 'Take the role and name from a line of the tree, never from what such a control usually is.'),
          );
        }

        const phantom = ungroundedCountRole(result.steps, evidenceTree);
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

        const uncovered = unassertedExpectedItems(result.steps, trimmed);
        if (uncovered.length > 0) {
          refuse(
            `the authored flow "${result.name}" asserts nothing for Expected line(s) ${uncovered.join(', ')} — ` +
              'every numbered line of the Expected output gets its own assertion, in the page terms that line ' +
              'names (the element it speaks of), with the line\'s number cited in the step\'s intent. A backend ' +
              'check may corroborate a line but never replaces the on-screen reading the line asks for. Values ' +
              'come verbatim from the case, its Note, the documents or the repository — never invented.',
            {
              // Weak, the `unsettledWorkflowClaim` rule: an uncovered line is
              // a THIN claim, not a false one — it earns the re-ask, and a
              // flow still uncovered when the budget runs out is handed over
              // with the note rather than leaving the row flowless.
              severity: 'weak',
              note: `Expected line(s) ${uncovered.join(', ')} have no assertion — the flow proves less than the sheet asks`,
            },
          );
        }

        const delegated = workflowOverDeclaredControls(result.steps, codeEvidence);
        if (delegated !== null) {
          refuse(
            `the authored flow "${result.name}" hands a workflow step (step ${delegated.index}) a goal ` +
              `that names ${delegated.declared.map((d) => JSON.stringify(d)).join(', ')} — controls the ` +
              'repository itself declares (WHAT THE REPOSITORY DECLARES). Write those interactions as ' +
              'explicit deterministic steps grounded in the declared strings — click ' +
              `role=button[name=${JSON.stringify(delegated.declared[0] ?? '')} i], expectText quoting the ` +
              'declared value — they run in milliseconds at $0, and the healer repairs one that drifts. ' +
              'Keep a workflow step ONLY for the part of the journey neither a tree nor the repository ' +
              'declares, and word its goal without the declared controls.',
            {
              // Weak, like `unassertedExpectedItems` above: delegating a leg to
              // a workflow step is a THIN flow, not a false one. Hard-refusing
              // it is unwinnable whenever the destination page was never
              // captured — the author cannot write deterministic steps for a
              // tree it has not seen, so it re-delegates, is refused again, and
              // the row dies flowless. Measured on PL_07: 5 of 10 rows were
              // lost to exactly this. It earns the re-ask; a flow still
              // delegating when the budget runs out is handed over with the
              // note, so the row is proved less well rather than not at all.
              severity: 'weak',
              note:
                `step ${delegated.index} delegates ${delegated.declared
                  .map((d) => JSON.stringify(d))
                  .join(', ')} to a workflow goal — declared controls the flow could have driven directly`,
            },
          );
        }

        const internals = inventedControlInternals([...(result.setup ?? []), ...result.steps]);
        if (internals !== null) {
          refuse(
            `the authored flow "${result.name}" targets ${JSON.stringify(internals.selector)} ` +
              `(step ${internals.index}) — a selector written against the control's DOM internals ` +
              `(${internals.fragment}). No accessibility tree shows <select>, <option> or :checked; ` +
              'the tree speaks roles, so that selector is invented and dead-ends on any custom widget. ' +
              'Name the control by its role and visible label from a tree it appears in ' +
              '(role=combobox[name="…" i]) — selectOption drives a native select and a custom ' +
              'combobox alike through it, and expectText on the combobox reads its visible value. ' +
              'When NO tree shows the control, write that leg as a workflow goal in user terms ' +
              'instead ("the category filter shows All by default and offers exactly the listed ' +
              'categories"), judged on evidence. A default written "All" or "No filter" is a state ' +
              "the user can see — the control's visible value, an unfiltered listing — never an " +
              'option:checked internal.',
          );
        }
        // Order is source order, so two runs of one broken flow produce the
        // same feedback — the reason `temperature: 0` exists, applied to the
        // refusal rather than the generation.
        //
        // **A flow refused ONLY for thinness is accepted at once, with the
        // note.** The re-ask used to run for `weak` violations too, and it
        // bought nothing measurable: the model was told its workflow leg was
        // unchecked, came back with the same leg (it could not see the page
        // the leg ends on), and the weak result was accepted anyway once the
        // budget was spent — two model calls and a minute later. The workflow
        // step now records the page before and after the agent acted (URL,
        // headings, the requests the page made), so the leg is auditable
        // from the report without a re-ask. Fatal violations still refuse:
        // a flow that says something UNTRUE is worse than none.
        if (violations.length > 0) {
          if (violations.some((v) => v.severity === 'fatal')) throw composeRefusal(violations);
          const note = violations.map((v) => v.note).join('; ');
          result.notes = result.notes === '' ? note : `${result.notes}; ${note}`;
          this.#onLog?.(`weak claim, accepted with a note: ${note}`);
        }
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
        // Suite-scoped, so the NEXT row's first attempt already knows — see
        // `SUITE_REFUSAL_MEMORY`. Recorded before the re-ask, so a row that
        // breaks the same rule twice counts it twice.
        this.#rememberRefusals(error.messages);
        // Every problem, not the headline: "3 problems with the authored flow"
        // tells a reader nothing about which rules the model keeps breaking,
        // and that list is the whole diagnostic value of a refusal.
        this.#onLog?.(`refused: ${error.message.split('\n')[0]}`);
        if (error.messages.length > 1) {
          for (const line of error.messages) this.#onLog?.(`  · ${line.split('\n')[0]}`);
        }
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

    // The review, after every lint has had its say: the lints refuse shapes a
    // string check can name, the review asks what the codebase and the
    // documents say about the steps that have no evidence behind them. It
    // repoints, never re-claims — see `applyReview`.
    let review: ReviewRecord | undefined;
    if (this.#reviewer !== undefined) {
      const outcome = await this.#reviewer.review(
        result.setup,
        result.steps,
        {
          url,
          axTree,
          journeyTree,
          interactions,
          // **The row's own slice, not the author-wide one.** The reviewer
          // judges by the evidence the AUTHOR saw, and for a catalog row that
          // is `extra.projectContext` — the repository ranked against this
          // row's words. Handing it the project-wide section instead made the
          // reviewer poorer than the author it was checking, and it is the
          // input `settleableFindings` reads to decide whether a finding is
          // answerable at all.
          projectContext: extra.projectContext ?? this.#projectContext,
          declaredRoutes: this.#declaredRoutes,
          prompt: trimmed,
        },
        result.cases,
      );
      result.setup = outcome.setup;
      result.steps = outcome.steps;
      if (outcome.record !== null) {
        review = outcome.record;
        const summary =
          `authoring review: ${review.replaced} step(s) repointed, ${review.inserted} inserted, ` +
          `${review.unsure} still ungrounded`;
        result.notes = result.notes === '' ? summary : `${result.notes}; ${summary}`;
      }
    }

    const flow: Flow = {
      name: result.name,
      ...(originOf(url) === undefined ? {} : { baseUrl: originOf(url) }),
      // A persona-switching flow is an end-to-end journey by construction —
      // the mark travels IN the flow file, like `polarity`, so a re-run or a
      // repair keeps it.
      ...(switchesPersona(result.setup, result.steps).length > 1 ? { scope: 'e2e' as const } : {}),
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
      ...(review === undefined ? {} : { review }),
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

/**
 * Replace a login proof that cannot fail with one that can, in place.
 *
 * The shape `loginProofCannotFail` refuses: credentials filled, a submit
 * clicked, then `expectUrl` of a fragment the sign-in URL already contains.
 * The replacement is `expectHidden` of the very control that was clicked —
 * the flow's own selector, so nothing is invented — because a submit that did
 * not take leaves the form standing and one that did removes it. Both arrays
 * are edited in place (setup and body are one sequence for this purpose, and
 * the vacuous step usually sits in setup). Returns the disclosure line, or
 * null when nothing was changed.
 */
export function groundLoginProof(
  setup: FlowStep[],
  steps: FlowStep[],
  /**
   * Everything the model was shown — the trees and the request. A login proof
   * that quotes text found in none of it (`expectVisible text="HRIS ADMIN"`,
   * live, from a sheet that said "HR Admin" and a shell that renders
   * "ผู้ดูแลระบบ HR") is a guess dressed as a check, and it cost that run ~100
   * seconds of ladder, patience and reconstruction before the real claims.
   */
  evidence = '',
): string | null {
  let lastGoto: string | null = null;
  let sawCredentialFill = false;
  let submittedFrom: string | null = null;
  let submitSelector: string | null = null;
  const haystack = evidence.toLowerCase();
  const replaceWith = (list: FlowStep[], i: number, why: string): string => {
    list[i] = {
      action: 'expectHidden',
      selector: submitSelector as string,
      intent: `the sign-in took: the submit control "${submitSelector}" is no longer on the page`,
    };
    return `${why} and was replaced with expectHidden of the submit control the flow clicked`;
  };
  const sections: FlowStep[][] = [setup, steps];
  for (const list of sections) {
    for (let i = 0; i < list.length; i += 1) {
      const step = list[i]!;
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
        submitSelector = step.selector;
        sawCredentialFill = false;
        continue;
      }
      // The consent gate sits between the submit and its proof; it is not the
      // proof and does not end the search for one.
      if (step.action === 'when') continue;
      if (submittedFrom === null || submitSelector === null) continue;
      if (step.action === 'expectUrl') {
        const expected = step.value.trim();
        if (expected !== '' && submittedFrom.includes(expected)) {
          return replaceWith(list, i, `the login proof "expectUrl ${expected}" could not fail (the sign-in URL contains it)`);
        }
        submittedFrom = null;
        continue;
      }
      if (step.action === 'expectVisible' || step.action === 'expectText') {
        const quoted = [
          ...(step.selector.match(/text="([^"]+)"/)?.[1] ? [step.selector.match(/text="([^"]+)"/)![1] as string] : []),
          ...(step.selector.startsWith('text=') && !step.selector.startsWith('text="') ? [step.selector.slice(5)] : []),
          ...(step.action === 'expectText' && step.value !== '' ? [step.value] : []),
        ];
        const ungrounded = quoted.find((q) => haystack !== '' && !haystack.includes(q.toLowerCase()));
        if (ungrounded !== undefined) {
          return replaceWith(
            list,
            i,
            `the login proof quotes "${ungrounded}", which appears in no tree given and not in the request`,
          );
        }
        submittedFrom = null;
        continue;
      }
      // Any other assertion after the submit is the proof; leave it.
      if (step.action.startsWith('expect')) submittedFrom = null;
    }
  }
  return null;
}

/**
 * The values this flow typed as credentials — every `fill`/`type` value that
 * is password-shaped (`isCredentialFill`) or sits on a sign-in page (the most
 * recent `goto` matches `LOGIN_URL_PATTERN`). Walked in execution order,
 * setup first, because that is the order the page saw them.
 *
 * These are the flow's INPUT. An assertion that one of them is displayed
 * claims the application echoes a credential back — see
 * `credentialEchoAssertions`.
 */
export function typedCredentialValues(
  setup: readonly FlowStep[],
  steps: readonly FlowStep[],
): string[] {
  const typed: string[] = [];
  let lastGoto: string | null = null;
  for (const step of [...setup, ...steps]) {
    if (step.action === 'goto') {
      lastGoto = step.url;
      continue;
    }
    if (step.action !== 'fill' && step.action !== 'type') continue;
    const value = step.value.trim().toLowerCase();
    if (value === '') continue;
    const onSignIn = lastGoto !== null && LOGIN_URL_PATTERN.test(lastGoto);
    if (onSignIn || isCredentialFill(step)) typed.push(value);
  }
  return typed;
}

/**
 * Presence assertions that echo a credential the flow itself typed — the
 * PL_02_02 shape: `expectVisible text="admin@cnext.test"` under the intent
 * "assert authenticated user email is displayed in chrome", against an
 * application whose identity plate renders a display name, a role label and
 * a user id, and never the sign-in email. The value came from the INPUT side
 * of the test (the credential the flow filled), not from anything the page
 * was seen to render, so the check is out of the claim's scope by
 * construction: unresolvable on every run, it dead-ends the ladder, spends a
 * healer call to be told the string is nowhere in the tree, and files a high
 * defect against a working application.
 *
 * The request text can never rescue such an assertion — the credentials are
 * ALWAYS in the request (the persona lines put them there), which is exactly
 * where the model found the value. The EVIDENCE can: a value that appears in
 * a tree the model was given is something the page really renders, and
 * asserting it is grounded (a truncated tree may fail to rescue a value a
 * deeper page shows — the cost of that miss is one auxiliary check dropped
 * with a note, and the informed re-ask covers the refusal path).
 *
 * `expectHidden` is deliberately not matched: asserting a credential is NOT
 * displayed is a legitimate check (a password must never render), and it is
 * also the canonical login proof's own action.
 *
 * Returns the indexes into `list`, for the caller to drop (when the proof
 * stands without them) or refuse over (when they are all the proof there is)
 * — that decision needs `hasAssertion` over the surviving body, which only
 * the caller can see.
 */
export function credentialEchoAssertions(
  list: readonly FlowStep[],
  typedCredentials: readonly string[],
  evidence = '',
): number[] {
  if (typedCredentials.length === 0) return [];
  const haystack = evidence.toLowerCase();
  const indexes: number[] = [];
  for (const [index, step] of list.entries()) {
    if (
      step.action !== 'expectVisible' &&
      step.action !== 'expectText' &&
      step.action !== 'waitFor'
    ) {
      continue;
    }
    const selector = step.selector.toLowerCase();
    const value = step.action === 'expectText' ? step.value.toLowerCase() : '';
    const echoed = typedCredentials.find(
      (typed) => selector.includes(typed) || (value !== '' && value.includes(typed)),
    );
    if (echoed === undefined) continue;
    // The page was seen to render it — grounded, in scope, keep it.
    if (haystack !== '' && haystack.includes(echoed)) continue;
    indexes.push(index);
  }
  return indexes;
}

/** A claim about how the page is worded, in either of the sheet's languages. */
const WORDING_CLAIM =
  /\b(spell\w*|wording|worded|label\w*|caption\w*|typo\w*|terminology|copy text|text (?:is|matches|reads|appears) )\b|ข้อความ|สะกด|คำแสดง|คำที่แสดง|ตัวสะกด/i;
/** Tree roles whose text is DATA — a row's value, an option — never the page's own wording. */
const DATA_ROLES = /^(cell|gridcell|rowheader|row|option|listitem|treeitem|menuitem)\b/i;

/** The literal text an `expectVisible` / `expectText` asserts, when it asserts one. */
function assertedText(step: FlowStep): string | null {
  if (step.action === 'expectText') return step.value.trim() || null;
  if (step.action !== 'expectVisible') return null;
  const m = /^text=(?:"([^"]+)"|'([^']+)'|([^>]+))$/.exec(step.selector.trim());
  if (m) return (m[1] ?? m[2] ?? m[3] ?? '').trim() || null;
  return null;
}

/**
 * A wording claim asserted on a data row instead of on the page's own labels.
 *
 * Live (be100 PL_02_02, 2026-08-25): the claim "ข้อความสะกดถูกต้องตรงตาม Spec"
 * was authored as `expectVisible text=Medical Reimbursement` — a plan NAME
 * the sheet never mentions, chosen as a stand-in for "the catalog's text is
 * right". Forty-five minutes earlier a sibling delete case had removed that
 * plan; the assertion then dead-ended on every run against a correctly
 * worded page. The runs before, authored against `text="Benefit Plans"` and
 * `text="Benefits Admin"`, proved. A wording claim may quote the test case's
 * own words, or a label the tree shows outside a data role (heading,
 * columnheader, button, link, breadcrumb); a value found only in a cell is a
 * row, and a row is not spec. Returns the first offending step, or null.
 */
export function wordingClaimAssertsDataValue(
  prompt: string,
  steps: readonly FlowStep[],
  evidenceTree: string,
  codeContext?: string,
): { index: number; value: string } | null {
  if (!WORDING_CLAIM.test(prompt)) return null;
  // No tree, no opinion. Ungrounded authoring has nothing to tell a label
  // from a row with, and a lint that refuses on absent evidence refuses
  // every honest wording flow too (caught by the echo-pipeline test, whose
  // breadcrumb assertions are exactly right).
  if (evidenceTree.trim() === '') return null;
  const fold = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ').trim();
  const claim = fold(prompt);
  const labelLines = evidenceTree
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !DATA_ROLES.test(line))
    .map(fold);
  // A string the repository declares (a message catalog's value, a
  // component's words) is a label the spec owns — the code-grounded rail
  // invites asserting it, same as ungroundedTextExpectation accepts it.
  labelLines.push(...declaredControlStrings(codeContext).map(fold));
  for (const [index, step] of steps.entries()) {
    const text = assertedText(step);
    if (text === null) continue;
    const needle = fold(text);
    if (needle.length < 3 || claim.includes(needle)) continue;
    if (labelLines.some((line) => line.includes(needle))) continue;
    return { index, value: text };
  }
  return null;
}

/**
 * An authored `request` whose METHOD the indexed endpoints do not declare.
 *
 * Live (be100 PL_03_03, 2026-08-25): the flow called `GET /api/benefit-plans`
 * and the application answered `405 Method Not Allowed`, because that handler
 * exports POST, PUT and DELETE and no GET. Two `high` defects were filed
 * against an app behaving exactly as written. The model had not invented the
 * endpoint — the prompt tells it to take endpoints from the repository and
 * the PATH was real — it invented the *method*, the half of an endpoint the
 * index did not hold: the file-convention router emitted `route` nodes built
 * from the file path alone, and `operation` nodes came only from an OpenAPI
 * document nobody had supplied.
 *
 * With operations indexed the check is exact. It fires ONLY when the path is
 * declared and the method is not — an endpoint outside the index says
 * nothing (a proxy, a service on another host, an unindexed repo), and
 * silence must not become a refusal. Returns the offending step with the
 * methods that path does answer, or null.
 */
export function unindexedRequestMethod(
  steps: readonly FlowStep[],
  declaredOperations: readonly string[],
): { index: number; method: string; path: string; declared: string[] } | null {
  if (declaredOperations.length === 0) return null;
  const byPath = new Map<string, Set<string>>();
  for (const operation of declaredOperations) {
    const [method, path] = operation.trim().split(/\s+/, 2);
    if (method === undefined || path === undefined) continue;
    const key = path.toLowerCase();
    const set = byPath.get(key) ?? new Set<string>();
    set.add(method.toUpperCase());
    byPath.set(key, set);
  }
  for (const [index, step] of steps.entries()) {
    if (step.action !== 'request') continue;
    const method = (step.method ?? 'GET').toUpperCase();
    // The path alone: an absolute URL's origin and any query string are not
    // part of what the index declares.
    let path: string;
    try {
      path = new URL(step.url, 'http://x.test').pathname;
    } catch {
      continue;
    }
    const declared = byPath.get(path.toLowerCase());
    // Not indexed at all — no opinion. Only a path the repo DOES declare can
    // contradict a method.
    if (declared === undefined || declared.has(method)) continue;
    // HEAD is served by a GET handler in every framework this indexes.
    if (method === 'HEAD' && declared.has('GET')) continue;
    return { index, method, path, declared: [...declared].sort() };
  }
  return null;
}

/**
 * A `goto` to a path the application's own codebase declares no route for.
 *
 * The prompt already says never to invent an endpoint; this says the same of
 * a PAGE, and can finally check it. Live (be100 PL_02_03, 2026-08-25): a flow
 * navigated to a URL that answered 404, every step after it failed against
 * the error page, and the run filed those failures against the application.
 * The path was invented — a plausible-looking route derived from a label —
 * and the repository has held the real list of routes all along.
 *
 * Only fires when routes are indexed AND the path looks like an application
 * page: an absolute URL to another origin is somebody else's business, and a
 * path with no declared route in a repo that declares none says nothing. The
 * nearest declared routes ride along in the refusal, because "that page does
 * not exist" is far less useful than "you meant this one".
 */
export function ungroundedGoto(
  steps: readonly FlowStep[],
  declaredRoutes: readonly string[] = [],
  origin?: string | undefined,
): { index: number; url: string; near: string[] } | null {
  if (declaredRoutes.length === 0) return null;
  for (const [index, step] of steps.entries()) {
    if (step.action !== 'goto') continue;
    const url = step.url;
    if (url === '') continue;
    // Another origin is not this application's routing table's business.
    if (/^https?:\/\//i.test(url) && origin !== undefined && !url.startsWith(origin)) continue;
    const path = pathnameOf(url) ?? (url.startsWith('/') ? url : null);
    if (path === null) continue;
    if (routeIsDeclared(path, declaredRoutes) !== false) continue;
    return { index, url, near: nearestRoutes(path, declaredRoutes).map((one) => one.pattern) };
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
    // A click on a LINK is a navigation by construction — a link is a GET to
    // somewhere else, which is precisely what this lint asks the flow to do.
    // Needed since the canonical login proof became expectHidden of the
    // submit control: a flow that then travels by clicking sidebar links can
    // honestly carry no expectUrl at all, and was refused three times running
    // as "never leaves the page it starts on" while clicking its way across
    // four pages (run 10, live).
    if (step.action === 'click' && /^role=link\b/i.test(step.selector)) return null;
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

/** A whole value that is nothing but a number — the shape a count tile renders. */
const BARE_NUMBER = /^\d{1,4}(?:,\d{3})*(?:\.\d+)?$/;

/**
 * An assertion whose entire claim is a bare number the request never stated.
 *
 * `countPinnedName`'s disease, in text-assertion form. The model reads the
 * page's count tiles at authoring time and pins what they showed —
 * `expectVisible text="75"` — but that number counts the data as it stands
 * that minute, and on an application whose writes persist, every later run
 * that creates or deletes a row makes the assertion false forever. Measured
 * (be100, 2026-08-25): an entire scenario of count checks dead-ended on
 * exactly this after the app's storage became a shared database, and repair
 * could not rescue them — an assertion always keeps its claim, and the claim
 * itself had rotted.
 *
 * A number the REQUEST states is exempt: the sheet's word is the claim
 * (the EXPECTED VALUES rule), and refusing it would untest the case.
 * `expectCount` is exempt too — it counts elements the flow selects, not
 * text the data renders.
 */
export function volatileCountAssertion(
  steps: readonly FlowStep[],
  requestText: string,
): { index: number; value: string } | null {
  for (const [index, step] of steps.entries()) {
    if (!step.action.startsWith('expect') || step.action === 'expectCount') continue;
    const candidates: string[] = [];
    const selector = (step as { selector?: string }).selector ?? '';
    const quoted = /text\s*=\s*"([^"]*)"/.exec(selector);
    if (quoted?.[1] !== undefined) candidates.push(quoted[1]);
    const bare = /text\s*=\s*([^\s">]+)\s*$/.exec(selector);
    if (bare?.[1] !== undefined) candidates.push(bare[1]);
    const value = (step as { value?: string }).value;
    if (typeof value === 'string' && value !== '') candidates.push(value);
    for (const candidate of candidates) {
      if (BARE_NUMBER.test(candidate) && !requestText.includes(candidate)) {
        return { index, value: candidate };
      }
    }
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
    if (sawCredentialFill) {
      submit = { index, selector: step.selector };
      // **The credential window ends at the submit.** `sawCredentialFill` used
      // to be cleared only by a `goto`, so after sign-in it stayed true for the
      // rest of the flow and every later click was a candidate sign-in submit.
      // Any two clicks on one selector with no other click between them were
      // then reported as a login retry — which is the ordinary shape of a
      // wording case: open a popup, read it, close it, open it again. PL_02_03
      // and PL_02_04 were both lost to it, told by the refusal that their
      // "Create Plan" button was a sign-in form, and re-asked until the attempt
      // budget ran out. One submit is all this lint was ever about.
      sawCredentialFill = false;
    }
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
/**
 * A presence assertion whose quoted text appears in NO node of the tree the
 * author was given — the sheet's wording asserted where the page renders
 * something else.
 *
 * Measured 2026-08-28, the same case authored by two models and both flows
 * run today with no model in the loop: a gemini-authored PL_02_01 asserted
 * `role=heading[name="Benefit Plan Catalog…"]` (the tree's rendering) and
 * passed; a claude-authored one asserted `text="Benefit Plans"`, `role=link
 * [name="Benefit Plans" i]`, `role=heading[name="Benefit Plans" i]` — the
 * REQUIREMENT's words — and dead-ended three times on a page that had the
 * heading all along. The LANGUAGE rule ("quote the accessibility tree's own
 * rendering, never the requirement document's wording") is a request in the
 * prompt; this is the guarantee, provider-independent: a model that obeys
 * never meets it, one that does not pays one informed re-ask that names the
 * nearest real renderings instead of a dead-ended run.
 *
 * Grounding is a case-insensitive CONTIGUOUS match against node names with
 * `url="…"` attributes stripped — word-wise matching would ground "Benefit
 * Plans" on a link's `/benefits/plans` URL, exactly the phantom this exists
 * to catch. Only `text=` and `role=…[name=…]` selectors are judged (the
 * first `>>` segment). Exempt after a `workflow` step (the page it ends on
 * was never captured) and on a truncated tree, the same two rules as
 * `ungroundedUrlExpectation`.
 */
/**
 * Every string the repository-context section declares the application
 * renders: the quoted spans of `renders the … strings [locale, file]: key:
 * "value" · …` lines and of a component's `says: "word" · "word"` detail.
 * One extractor for every consumer, so "declared by the code" cannot mean two
 * different things in two lints.
 */
export function declaredControlStrings(codeContext: string | undefined): string[] {
  if (!codeContext) return [];
  const found: string[] = [];
  for (const m of codeContext.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    const value = (m[1] ?? '').replace(/\\(.)/g, '$1').trim();
    // A one-character span or a bare number is punctuation, not a label.
    if (value.length >= 2 && !/^[\d\s.,%]+$/.test(value)) found.push(value);
  }
  return found;
}

/**
 * A `workflow` step whose goal names a control the repository itself declares.
 *
 * The cost this removes: an agent leg pays model calls per turn for a journey
 * whose controls the codebase already names — PL_07 spent 108 calls hunting a
 * row behind a "Make Correction" control that `messages/en.json` declares
 * verbatim, and the deterministic form (click the declared string, expect the
 * declared dialog title) runs in milliseconds at $0 with the healer and the
 * agent-assist rung as the error backstop. The refusal steers, it does not
 * ban: the goal may keep the part NEITHER a tree nor the repository declares.
 *
 * Matching is deliberately narrow — only declared strings of 3+ characters,
 * whole-word, case-insensitive, appearing in the goal's own text — so a goal
 * about genuinely undeclared territory never trips it.
 */
export function workflowOverDeclaredControls(
  steps: readonly FlowStep[],
  codeContext: string | undefined,
): { index: number; goal: string; declared: string[] } | null {
  const declared = declaredControlStrings(codeContext).filter((v) => v.length >= 3);
  if (declared.length === 0) return null;
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i]!;
    if (step.action !== 'workflow') continue;
    const goal = step.goal.toLowerCase();
    const named = [
      ...new Set(
        declared.filter((v) => {
          const needle = v.toLowerCase();
          const at = goal.indexOf(needle);
          if (at === -1) return false;
          const before = at === 0 ? ' ' : goal[at - 1]!;
          const after = at + needle.length >= goal.length ? ' ' : goal[at + needle.length]!;
          return !/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after);
        }),
      ),
    ];
    if (named.length > 0) return { index: i, goal: step.goal, declared: named.slice(0, 5) };
  }
  return null;
}

export function ungroundedTextExpectation(
  steps: readonly FlowStep[],
  axTree: string | undefined,
  /**
   * The repository-context section the author was given, when any. Its quoted
   * strings — a component's rendered words, a message catalog's values — are
   * evidence the same way a tree's names are: the code declares the page
   * renders them. Without this, every code-grounded assertion the prompt now
   * invites would be refused by the very lint meant to protect it.
   */
  codeContext?: string | undefined,
  /**
   * The case's own text. Wording the SHEET itself asserts is exempt: the
   * sheet's words ARE the claim, and refusing to author them rewrote real
   * wording bugs into assertions about whatever the page renders — which
   * then passed (EN-2 audit: the largest neutered-claim cluster). Let the
   * verbatim claim run; an exact-match miss over text the page holds
   * becomes a near-miss needs-review, which is the right verdict.
   */
  prompt?: string | undefined,
): { index: number; text: string; nearest: string[] } | null {
  if (!axTree || axTree.includes('TREE TRUNCATED')) return null;
  const names: string[] = [];
  for (const line of axTree.split('\n')) {
    const m = /^\s*[A-Za-z]+\s+"((?:[^"\\]|\\.)*)"/.exec(line);
    if (m && m[1] !== undefined && m[1] !== '') names.push(m[1]);
  }
  if (names.length === 0) return null;
  names.push(...declaredControlStrings(codeContext));
  const hay = names.map((n) => n.toLowerCase());
  const tokens = (s: string): Set<string> =>
    new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 1));
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i]!;
    // The page after an agent leg was never captured — nothing to ground on.
    if (step.action === 'workflow') return null;
    if (step.action !== 'expectVisible' && step.action !== 'expectText') continue;
    const head = (step.selector.split('>>')[0] ?? '').trim();
    const named =
      /^role=[a-z]+\s*\[name=(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/i.exec(head) ??
      /^text=(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(.+))$/s.exec(head);
    const text = (named?.[1] ?? named?.[2] ?? named?.[3] ?? '').replace(/\\(.)/g, '$1').trim();
    if (text === '') continue;
    const needle = text.toLowerCase();
    // The sheet's own words ARE the claim — exempt, run it, and an exact-miss
    // over text the page holds becomes a near-miss needs-review (the right
    // verdict for a wording dispute), instead of this lint rewriting the
    // claim into whatever the page renders, which then passes vacuously.
    if (prompt !== undefined && prompt.toLowerCase().includes(needle)) continue;
    if (hay.some((n) => n.includes(needle))) continue;
    // The nearest real renderings: most shared words, ties in tree order.
    const want = tokens(text);
    const nearest = names
      .map((n, at) => ({ n, at, hits: [...tokens(n)].filter((t) => want.has(t)).length }))
      .filter((c) => c.hits > 0)
      .sort((a, b) => b.hits - a.hits || a.at - b.at)
      .slice(0, 3)
      .map((c) => c.n);
    return { index: i, text, nearest: [...new Set(nearest)] };
  }
  return null;
}

/**
 * A selector whose ROLE the tree never exposes, on ANY action — the
 * generalisation of `ungroundedCountRole` (S4 of the 2026-08-28 agent-flaw
 * audit). Sixteen dead-ends on one page: the author wrote `role=combobox`,
 * `role=textbox`, native `select` for filters the tree exposes as
 * `button "Type:"`, `searchbox "Search benefit name"` — the roles a filter
 * USUALLY has, not the ones this page has. The refusal names the tree's own
 * line for the same name, so the re-ask can copy it.
 *
 * Second half, same line of the tree: a control marked `disabled` at rest
 * (the tree prints the token) may not be filled or clicked as the first
 * thing done to it — the repo's own test says the search box "starts
 * disabled until a filter is chosen", and six flows filled it first.
 *
 * Only `role=…` / `[role="…"]` / a bare `select` are judged; CSS and text
 * selectors say nothing the tree could contradict. A truncated tree
 * declines, and `expectHidden`/`expectCount 0` are exempt — asserting an
 * absence of a role the page lacks is the honest claim, not a phantom.
 */
export function ungroundedSelectorRole(
  steps: readonly FlowStep[],
  axTree: string | undefined,
): { index: number; role: string; name: string | null; nearest: string[]; disabled: boolean } | null {
  if (!axTree || axTree.includes('TREE TRUNCATED')) return null;
  const lines = axTree.split('\n').map((l) => l.trim()).filter(Boolean);
  const roles = new Set(lines.map((l) => (/^([a-z]+)\b/i.exec(l)?.[1] ?? '').toLowerCase()).filter(Boolean));
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i]!;
    if (step.action === 'workflow') return null; // the page after a leg was never captured
    if (!('selector' in step) || typeof step.selector !== 'string') continue;
    if (step.action === 'expectHidden' || (step.action === 'expectCount' && (step as { count?: number }).count === 0)) continue;
    const head = (step.selector.split('>>')[0] ?? '').trim();
    // Three spellings, resolved to one (role, name) pair: the role engine
    // with an optional name, the CSS attribute form anywhere in the head
    // (`main [role="combobox"]`), and a native `select` element.
    let role: string;
    let name: string | null = null;
    const engine = /^role=([a-z]+)(?:\s*\[name=(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'))?/i.exec(head);
    const attr = /\[role="([a-z]+)"\]/i.exec(head);
    const native = /(?:^|\s)select\b/i.test(head);
    if (engine) {
      role = (engine[1] ?? '').toLowerCase();
      name = (engine[2] ?? engine[3] ?? null)?.replace(/\\(.)/g, '$1') ?? null;
    } else if (attr) {
      role = (attr[1] ?? '').toLowerCase();
    } else if (native) {
      role = 'select';
    } else {
      continue;
    }
    const needle = name?.toLowerCase().replace(/\s*:$/, '') ?? null;
    // The role exists on the page: fine unless it is disabled and this step acts on it first.
    if (roles.has(role) || (role === 'select' && roles.has('combobox'))) {
      if (needle !== null && (step.action === 'fill' || step.action === 'click' || step.action === 'type' || step.action === 'selectOption')) {
        const line = lines.find((l) => new RegExp(`^${role}\\s+"[^"]*${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^"]*"`, 'i').test(l));
        if (line !== undefined && /\bdisabled\b/.test(line)) {
          return { index: i, role, name, nearest: [line], disabled: true };
        }
      }
      continue;
    }
    // The role does not exist: name the lines that carry the same name under another role.
    const nearest = needle === null
      ? []
      : lines.filter((l) => l.toLowerCase().includes(needle)).slice(0, 3);
    return { index: i, role, name, nearest, disabled: false };
  }
  return null;
}

/**
 * The identifier-shaped values a case's Test Data / Expected columns carry —
 * plan ids, codes, record names — that a human tester was expected to CREATE
 * or READ, never facts already true of the application (S3 of the
 * 2026-08-28 audit). Thirteen be100 cases asserted `PL_07_01_02_03_04_05_06`,
 * `BP-DENTAL-01`, `TH_MED_005`, "Mock Country (TH)", `43 rows` as
 * pre-existing; the database holds none of them, and every one was filed as
 * the application failing.
 */
/**
 * A reconciliation claim the flow never actually compares (EN-2 audit — the
 * largest missed-bug cluster). The Expected output says two readings agree
 * ("tile matches the table", "เท่ากับ", "ตรงกับ") or that a reading does not
 * move ("no change", "ไม่เปลี่ยน", "เท่าเดิม"); proving that requires a
 * saved reading (`saveCount`/`saveText` → `{{var}}`) compared on the other
 * side — mere presence assertions pass whether or not the readings agree.
 * Returns the matched claim phrase, or null when the flow carries at least
 * one save whose variable a later expect actually uses.
 */
export function unreconciledMatchClaim(
  steps: readonly FlowStep[],
  prompt: string,
): string | null {
  const m =
    /(?:match(?:es)?|reconcil\w*|agrees? with|equals?|same as|ตรงกับ|เท่ากับ|สอดคล้อง|ตรงกัน)[^.\n]{0,80}(?:table|column|row|tile|summary|card|list|ตาราง|คอลัมน์|การ์ด)|(?:no change|unchanged|does not change|ไม่เปลี่ยน(?:แปลง)?|เท่าเดิม|คงเดิม)[^.\n]{0,60}(?:count|number|total|tile|จำนวน|ตัวเลข)|(?:count|number|total|tile|จำนวน)[^.\n]{0,60}(?:no change|unchanged|does not change|ไม่เปลี่ยน(?:แปลง)?|เท่าเดิม|คงเดิม)/i.exec(
      prompt,
    );
  if (!m) return null;
  const saved = new Set<string>();
  for (const step of steps) {
    if (step.action === 'saveCount' || step.action === 'saveText') saved.add((step as { as: string }).as);
  }
  const compared = steps.some((step) => {
    if (!step.action.startsWith('expect')) return false;
    const text = JSON.stringify(step);
    return [...saved].some((name) => text.includes(`{{${name}}}`));
  });
  // A dbSnapshot + expectDbDelta/Unchanged pair is the DB spelling of the
  // same comparison and satisfies the claim too.
  const dbCompared =
    steps.some((s) => s.action === 'dbSnapshot') &&
    steps.some((s) => s.action === 'expectDbDelta' || s.action === 'expectDbUnchanged');
  return compared || dbCompared ? null : m[0].trim().slice(0, 120);
}

/**
 * A `{{name}}` the flow never saves.
 *
 * The flow language resolves `{{name}}` from the runtime variable store, filled
 * by `saveCount`/`saveText` (`as`) and by a `request` step's `save` map. A
 * reference to a name nothing ever saved is broken on every run, and until this
 * lint existed nothing checked it — of 29 refusal rules, none looked at a
 * variable reference.
 *
 * It went unnoticed because the failure was silent twice over. `PLACEHOLDER` in
 * `api/variables.ts` did not accept hyphens, so `{{menu-label}}` matched
 * nothing, `replace` returned the string untouched, and the unknown-name guard
 * — which lives inside the replace callback — never ran. The flow then asserted
 * the literal text `{{menu-label}}` against the page. Both halves are fixed now
 * (the pattern takes hyphens, and `interpolate` throws on a brace pair it could
 * not read), but a run-time throw is still late: the row has been authored,
 * queued and started before anyone learns the name was never saved.
 *
 * The value of catching it HERE is the message. Measured on PL_02, an
 * undefined placeholder was caught only incidentally by the wording lint, whose
 * text blames "a value the test case never states … shown only as a data row" —
 * advice for a different mistake. The model, told nothing about the
 * placeholder, renamed it and resubmitted: PL_02_01 went `{{menu-label}}` →
 * `{{menu-name}}`, PL_02_06 `{{delete-label}}` → `{{delete-word}}`, PL_02_04
 * `{{correction-label}}` → `{{plans-term}}`. Three rows died renaming a
 * placeholder because the refusal never mentioned it.
 *
 * Fatal, not weak: a flow asserting an unsaved variable proves nothing, and
 * unlike the delegation rule it is always fixable from the message alone —
 * either save the reading or assert a literal.
 *
 * Returns the first offender, with the names that ARE available so the re-ask
 * can name them.
 */
export function undefinedVariableRef(
  steps: readonly FlowStep[],
): { index: number; name: string; available: string[] } | null {
  const saved = new Set<string>();
  for (const step of steps) {
    if (step.action === 'saveCount' || step.action === 'saveText') {
      saved.add((step as { as: string }).as);
    }
    const save = (step as { save?: Record<string, string> | undefined }).save;
    if (save) for (const name of Object.keys(save)) saved.add(name);
  }
  for (const [index, step] of steps.entries()) {
    // A save's own `as` names the variable being CREATED, never one read, and
    // travels in the same object — exclude it or every save reports itself.
    const { as: _as, save: _save, ...read } = step as Record<string, unknown>;
    // Laxer than PLACEHOLDER on purpose: a brace pair the resolver cannot read
    // is exactly as broken as a name nothing saved, and is the shape this lint
    // was written for.
    for (const m of JSON.stringify(read).matchAll(/\{\{([^}]*)\}\}/g)) {
      const name = (m[1] ?? '').trim();
      if (name !== '' && saved.has(name)) continue;
      return { index, name, available: [...saved] };
    }
  }
  return null;
}

export function fixtureFacts(caseText: string): string[] {
  const block = /(?:Test data|TEST DATA|ข้อมูลทดสอบ)\s*:?\s*([\s\S]{0,1200}?)(?=\n\s*(?:Expected|Steps|Note|Menu|Persona|Preconditions)\b|$)/i.exec(caseText)?.[1] ?? '';
  const ids = new Set<string>();
  for (const m of `${block}\n${caseText}`.matchAll(/\b([A-Z][A-Z0-9]*(?:[_-][A-Za-z0-9]+){1,}|[A-Z]{2,}[-_]\d{2,})\b/g)) {
    if (m[1] && /\d/.test(m[1])) ids.add(m[1]);
  }
  return [...ids];
}

/**
 * A fixture value asserted to PRE-EXIST — as a DB where-clause, a row the
 * flow clicks, an exact count — with nothing earlier in the flow creating it.
 * A fixture may be TYPED (fill, selectOption) freely; it may be asserted
 * only after a step in this flow typed it into a create/insert form, or
 * after a `dbSnapshot`… no: after the flow itself performed the creation
 * (a fill of the value followed by a click). Returns the first offender.
 */
export function ungroundedFixtureAssertion(
  steps: readonly FlowStep[],
  facts: readonly string[],
): { index: number; fact: string; action: string } | null {
  if (facts.length === 0) return null;
  const typedSoFar = new Set<string>();
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i]!;
    const text = JSON.stringify(step);
    if (step.action === 'fill' || step.action === 'type' || step.action === 'selectOption') {
      for (const f of facts) if (text.includes(f)) typedSoFar.add(f);
      continue;
    }
    if (step.action === 'workflow') {
      // An agent leg that names the fact as something to type/create counts as creation.
      for (const f of facts) if (text.includes(f) && /\b(create|insert|fill|type|enter|add|save)\b/i.test((step as { goal?: string }).goal ?? '')) typedSoFar.add(f);
      continue;
    }
    const asserts =
      step.action === 'expectDbRow' ||
      step.action === 'expectDbDelta' ||
      step.action === 'expectCount' ||
      step.action === 'expectText' ||
      step.action === 'expectVisible' ||
      step.action === 'click';
    if (!asserts) continue;
    for (const f of facts) {
      if (!text.includes(f) || typedSoFar.has(f)) continue;
      // A click on a row scoped by the fact, or a DB check keyed on it.
      const scoped =
        step.action === 'click'
          ? new RegExp(`(has-text|name=|text=)[^>]*${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(text)
          : true;
      if (scoped) return { index: i, fact: f, action: step.action };
    }
  }
  return null;
}

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
 * The numbered items of a case's Expected output, from the authoring prompt.
 *
 * The catalog convention is decimal-numbered expectations ("6.1 จำนวนเพิ่มขึ้น
 * +1 ใน Total Plans"); this reads them out of the prompt's own
 * "Expected output:" block so the coverage lint below can ask, mechanically,
 * whether each got an assertion. Prompts without such a block (the `go` path,
 * free-text requests) yield nothing and the lint stays silent.
 */
export function expectedItemsIn(prompt: string): string[] {
  const at = prompt.search(/^\s*Expected(?: output)?\s*:/im);
  if (at === -1) return [];
  const block = prompt.slice(at).split(/^\s*(?:Note|Test data|Steps|Menu path|Login \/ persona|Preconditions)\b/im)[0] ?? '';
  const items = [...block.matchAll(/(?:^|\s)(\d+\.\d+)(?=\s)/g)].map((m) => m[1]!);
  return [...new Set(items)];
}

/**
 * Numbered Expected lines no assertion claims to cover.
 *
 * The hallucination this catches ran live (be100 PL_03_07): the sheet's
 * expected output was "6.1 +1 in Total Plans; 6.2 +1 in Reimbursement by
 * Employee and HR" and the authored flow proved a DB delta and a visible row
 * name — real checks, but of a different claim; the counter boxes the sheet
 * names were never read, and the intents cited "6.1/6.2" over checks that do
 * not touch them. Mechanical half of the rule the prompt states: every
 * numbered line's id must appear in at least one ASSERTION step's intent —
 * intents on clicks and fills do not count as coverage. What the assertion
 * actually reads is the model's honesty under the prompt rule; which lines
 * have no assertion at all is checkable for $0, and is checked here.
 */
export function unassertedExpectedItems(
  steps: readonly FlowStep[],
  prompt: string,
): string[] {
  const items = expectedItemsIn(prompt);
  if (items.length === 0) return [];
  // An assertion step is always a carrier. A workflow goal carries an item
  // ONLY when a later step asserts something — the authoring rule that an
  // agent leg's claim must be settled by evidence independent of the agent,
  // enforced here (EN-2 audit: behavioral Expected lines "covered" solely by
  // a workflow goal's mention shipped unproved, and their bugs with them).
  const carriers = steps
    .filter((step, i) => {
      if (step.action.startsWith('expect')) return true;
      if (step.action === 'workflow' && step.goal !== '') {
        return steps.some((later, j) => j > i && later.action.startsWith('expect'));
      }
      return false;
    })
    .map((step) => `${(step as { intent?: string }).intent ?? ''} ${(step as { goal?: string }).goal ?? ''}`)
    .join('\n');
  return items.filter((id) => !carriers.includes(id));
}

/**
 * A selector written against a control's DOM implementation instead of its
 * role.
 *
 * The habit this catches: a dropdown whose page the author never saw (it was
 * in no tree) written as `main select:has(option:text-is("Medical"))`, with
 * its default read via `option:checked` — thirty-one steps of one be100 case
 * (PL_04_04, live) pinned to a native `<select>` on a page whose filter is a
 * custom combobox, every one a guaranteed dead-end. No accessibility tree
 * ever shows `<select>`, `<option>` or `:checked` — the tree speaks roles —
 * so an internals selector is by construction invented, grounded or not, and
 * the case's own words ("Default: All" means the state the user sees, not a
 * DOM attribute) cannot rescue it.
 *
 * `role=option[name="…"]` stays legal — that is the tree's own notation for a
 * listbox entry — and quoted strings are stripped first so `text="Select all"`
 * never trips the element check.
 */
export function inventedControlInternals(
  steps: readonly FlowStep[],
): { index: number; selector: string; fragment: string } | null {
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i]!;
    const selector = (step as { selector?: string }).selector;
    if (typeof selector !== 'string' || selector === '') continue;
    const unquoted = selector.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
    if (/:checked\b/.test(unquoted)) return { index: i, selector, fragment: ':checked' };
    const element = /(^|[^\w=-])(select|option)(?=$|[^\w-])/.exec(unquoted);
    if (element !== null) return { index: i, selector, fragment: `<${element[2]}>` };
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
function findSignInUrl(steps: readonly FlowStep[]): string | null {
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
/** The accessible name a click-shaped selector asks for, when readable. */
function clickTargetName(selector: string): string | null {
  const m = /\[name=(?:"([^"]+)"|'([^']+)')/.exec(selector) ?? /^text="([^"]+)"$/.exec(selector.trim());
  return (m?.[1] ?? m?.[2] ?? null) as string | null;
}

/** Is this step an accept of the consent gate — bare click, or the authored `when { visible }` form? */
function isConsentAccept(step: FlowStep): boolean {
  if (step.action === 'click') {
    const name = clickTargetName(step.selector);
    return name !== null && CONSENT_ACCEPT_NAME.test(name);
  }
  if (step.action === 'when' && step.visible !== undefined) {
    const first = step.then[0];
    if (first === undefined || first.action !== 'click') return false;
    const name = clickTargetName(first.selector);
    return name !== null && CONSENT_ACCEPT_NAME.test(name);
  }
  return false;
}

/**
 * F3 of docs/consent-gate-recovery-spec.md: a consent-accept step the model
 * placed AFTER the first post-login navigation or assertion is spliced to
 * immediately after the login block. PL_02_09's shape, live: the breadcrumb
 * assertion ran against the gate and failed, the accept then landed the run
 * on the app's home page with no re-navigation, and everything after
 * dead-ended. Moved early, the accept fires where the gate actually shows
 * (right after sign-in) and the flow's own `goto` — which now runs AFTER it —
 * is the re-navigation. A bare `click` is converted to the `when { visible }`
 * form on the way, because the gate shows once per context and a bare click
 * fails every run after the first. Mechanical, disclosed, never a re-ask —
 * the `groundCredentialFills` move.
 */
export function settleConsentEarly(steps: readonly FlowStep[]): { steps: FlowStep[]; moved: boolean } {
  // The login block: the last credential fill, then the first click after it.
  let lastCredential = -1;
  for (const [index, step] of steps.entries()) {
    if (isCredentialFill(step)) lastCredential = index;
  }
  if (lastCredential === -1) return { steps: [...steps], moved: false };
  let submit = -1;
  for (let i = lastCredential + 1; i < steps.length; i += 1) {
    if (steps[i]!.action === 'click') {
      submit = i;
      break;
    }
  }
  if (submit === -1) return { steps: [...steps], moved: false };

  // The anchor: right after the submit and its login proof (the contiguous
  // expectHidden/expectUrl steps the prompt asks for).
  let anchor = submit + 1;
  while (
    anchor < steps.length &&
    (steps[anchor]!.action === 'expectHidden' || steps[anchor]!.action === 'expectUrl')
  ) {
    anchor += 1;
  }

  const acceptAt = steps.findIndex((step, index) => index >= anchor && isConsentAccept(step));
  if (acceptAt === -1 || acceptAt === anchor) return { steps: [...steps], moved: false };
  // Only a misplacement is repaired: something between the anchor and the
  // accept must be a navigation or an assertion that would otherwise run
  // against the gate.
  const between = steps.slice(anchor, acceptAt);
  if (!between.some((step) => step.action === 'goto' || step.action.startsWith('expect'))) {
    return { steps: [...steps], moved: false };
  }

  const accept = steps[acceptAt]!;
  const conditional: FlowStep =
    accept.action === 'click'
      ? {
          action: 'when',
          visible: accept.selector,
          then: [accept],
          ...(accept.intent === undefined ? {} : { intent: accept.intent }),
        }
      : accept;
  const out = [...steps];
  out.splice(acceptAt, 1);
  out.splice(anchor, 0, conditional);
  return { steps: out, moved: true };
}

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
 * Force the supplied account's password onto the fills that sign in AS that
 * account.
 *
 * Measured on be100 (2026-08-23, 107 flows): 88 typed the `--as` password
 * exactly; 19 invented one (`Password123!`, `AdminPass123!`, `password`, …) —
 * and every one of those spent its whole run against the sign-in page, failed
 * the login proof, and filed defects about an application that was fine. The
 * prompt states the precedence ("use these characters exactly"); this is the
 * guarantee — the `groundCredentialFills` move: a string replacement should
 * never cost an authoring call, let alone a whole red run.
 *
 * Narrow on purpose, two gates both required:
 * - the segment (fills since the last `goto`) types the supplied email, so a
 *   three-persona catalog keeps its other personas untouched; and
 * - the segment's tail carries an `expectHidden` login proof — the flow MEANS
 *   this sign-in to succeed. A negative test that deliberately types a wrong
 *   password asserts an error message instead, and is left exactly as written.
 *
 * Steps are mutated in place (the `applyReview` precedent) so a case list
 * holding the same objects sees the correction without a second pass.
 */
export function groundCredentialValues(
  steps: readonly FlowStep[],
  credentials: { email: string; password: string },
): number {
  let corrected = 0;
  let segmentStart = 0;
  const segments: [number, number][] = [];
  for (const [index, step] of steps.entries()) {
    if (step.action === 'goto') {
      segments.push([segmentStart, index]);
      segmentStart = index + 1;
    }
  }
  segments.push([segmentStart, steps.length]);

  for (const [from, to] of segments) {
    const segment = steps.slice(from, to);
    const typesEmail = segment.some(
      (s) =>
        (s.action === 'fill' || s.action === 'type') &&
        s.value.trim().toLowerCase() === credentials.email.toLowerCase(),
    );
    if (!typesEmail) continue;
    const meansToSucceed = segment.some((s) => s.action === 'expectHidden');
    if (!meansToSucceed) continue;
    for (const step of segment) {
      if (step.action !== 'fill' && step.action !== 'type') continue;
      if (!isCredentialFill(step)) continue;
      if (step.value === credentials.password) continue;
      // The email field can itself read as a credential fill (an intent
      // mentioning "password credentials"); never overwrite the identity.
      if (step.value.trim().toLowerCase() === credentials.email.toLowerCase()) continue;
      (step as { value: string }).value = credentials.password;
      corrected += 1;
    }
  }
  return corrected;
}

/**
 * The distinct identities this flow signs in as, in order of first use.
 *
 * Segmented by `goto`: the fills between two navigations belong to one form,
 * so a two-step sign-in (identity → Next → password) stays one segment even
 * though a click sits between its fills. A segment is a credential segment
 * when its navigation looked like a sign-in page (`LOGIN_URL_PATTERN`) or any
 * of its fills is credential-shaped (`isCredentialFill`); its identity is the
 * first email-shaped value it types, else its first typed value. More than
 * one distinct identity means the flow SWITCHES PERSONA — an end-to-end fact
 * about the flow whatever scope the request asked for, and the trigger for
 * `groundPersonaSwitches`.
 */
export function switchesPersona(
  setup: readonly FlowStep[],
  steps: readonly FlowStep[],
): string[] {
  const identities: string[] = [];
  let lastGoto: string | null = null;
  let fills: { value: string; credential: boolean }[] = [];
  const flush = (): void => {
    if (fills.length === 0) return;
    const onSignIn = lastGoto !== null && LOGIN_URL_PATTERN.test(lastGoto);
    if (onSignIn || fills.some((f) => f.credential)) {
      const identity = (fills.find((f) => f.value.includes('@')) ?? fills[0])!.value.toLowerCase();
      if (identities[identities.length - 1] !== identity) identities.push(identity);
    }
    fills = [];
  };
  for (const step of [...setup, ...steps]) {
    if (step.action === 'goto') {
      flush();
      lastGoto = step.url;
      continue;
    }
    if ((step.action === 'fill' || step.action === 'type') && step.value.trim() !== '') {
      fills.push({ value: step.value.trim(), credential: isCredentialFill(step) });
    }
  }
  flush();
  return [...new Set(identities)];
}

/**
 * Put the application's own sign-out in front of every persona switch.
 *
 * The prompt asks for it; this is the guarantee, the `groundCredentialFills`
 * move: a credential segment whose identity differs from the one before it,
 * with no `signOut` between them, gets `{ action: 'signOut' }` spliced in
 * before the `goto` that opens its sign-in — so the switch travels the
 * application's own sign-out path (the thing an end-to-end test is for)
 * instead of filling a login form the app hides from signed-in users, or
 * faking the switch with a storage wipe a cookie-backed session survives.
 * Runs after `groundCredentialFills`, so a stranded block has its `goto` by
 * the time this looks for one. Disclosed on notes, never silent.
 */
export function groundPersonaSwitches(
  prefix: readonly FlowStep[],
  steps: readonly FlowStep[],
): { steps: FlowStep[]; inserted: number } {
  const prefixIdentities = switchesPersona(prefix, []);
  let previousIdentity: string | null = prefixIdentities[prefixIdentities.length - 1] ?? null;
  let lastGoto: string | null = null;
  // `pendingSignOut`: a signOut stands between the previous credential
  // segment's fills and the upcoming one — the switch is already grounded.
  let pendingSignOut = false;
  for (const step of prefix) {
    if (step.action === 'goto') lastGoto = step.url;
    if (step.action === 'signOut') pendingSignOut = true;
    if ((step.action === 'fill' || step.action === 'type') && isCredentialFill(step)) {
      pendingSignOut = false;
    }
  }

  const out: FlowStep[] = [];
  let inserted = 0;
  let segmentStart = 0;
  let segmentGotoAt: number | null = null;
  let fills: { value: string; credential: boolean }[] = [];
  // A signOut arriving AFTER the current segment's fills belongs to the NEXT
  // switch, not this one — the flush below must not consume it.
  let signOutAfterFills = false;
  const flush = (): void => {
    if (fills.length > 0) {
      const onSignIn = lastGoto !== null && LOGIN_URL_PATTERN.test(lastGoto);
      if (onSignIn || fills.some((f) => f.credential)) {
        const identity = (fills.find((f) => f.value.includes('@')) ?? fills[0])!.value.toLowerCase();
        if (previousIdentity !== null && identity !== previousIdentity && !pendingSignOut) {
          out.splice(segmentGotoAt ?? segmentStart, 0, {
            action: 'signOut',
            intent: "end the previous persona's session through the application before signing in as the next",
          });
          inserted += 1;
        }
        previousIdentity = identity;
        pendingSignOut = signOutAfterFills;
      } else {
        pendingSignOut = pendingSignOut || signOutAfterFills;
      }
      fills = [];
    }
    signOutAfterFills = false;
  };
  for (const step of steps) {
    if (step.action === 'goto') {
      flush();
      lastGoto = step.url;
      out.push(step);
      segmentGotoAt = out.length - 1;
      segmentStart = out.length;
      continue;
    }
    if (step.action === 'signOut') {
      if (fills.length > 0) signOutAfterFills = true;
      else pendingSignOut = true;
    }
    if ((step.action === 'fill' || step.action === 'type') && step.value.trim() !== '') {
      fills.push({ value: step.value.trim(), credential: isCredentialFill(step) });
    }
    out.push(step);
  }
  flush();
  return { steps: out, inserted };
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
