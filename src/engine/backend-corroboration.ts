/**
 * Backend corroboration of a UI assertion, and the rules that keep it from
 * turning a broken page green.
 *
 * Asked for 2026-09-11, after HIR-EC-029: the case claimed "the Event Reason
 * dropdown shows exactly 3 values", the flow proved it by counting
 * `role=option` across the WHOLE page, a native `<option>` from an unrelated
 * postal-code select made it 4, and a correct application was failed three
 * times — twice at `high`. The endpoint that actually answers the claim was
 * declared in the indexed repository, named in the sheet's own
 * `fixture_recipe` ("wait for the event-reason lookup response"), and observed
 * live by the harness eight times during the failing step. Nothing connected
 * those facts to the verdict.
 *
 * The shape of the answer, settled with the operator:
 *
 * 1. The UI reading happens first and is never discarded.
 * 2. A failed assertion is re-checked after a reload — but only where a reload
 *    cannot destroy the state under test (`reloadSafe`).
 * 3. Only then is the backend consulted, and **only an INCONCLUSIVE UI reading
 *    defers to it**. A UI reading that resolved its element and contradicted
 *    the expectation keeps its own verdict: the page spoke, and what the page
 *    says is the evidence a UI test exists to collect.
 * 4. When the backend holds the right answer and the page did not show it,
 *    that is a FRONTEND defect carrying the backend's proof — never a silent
 *    pass, and never a defect filed against the backend.
 *
 * The query and the response are attached to the step either way, because the
 * operator's complaint about HIR-EC-029 was not only the wrong verdict: the
 * report could not say WHAT had been counted.
 */

import type { LanguageModel } from 'ai';
import { z } from 'zod';

import type { NetworkCall } from '../api/network-observer.js';
import { LlmFactory, generateStructuredForModel, type ModelSource } from '../providers/llm-factory.js';
import { DETERMINISM_RULES, procedure, selfCheck } from '../providers/prompt-discipline.js';
import { fence, sanitizeInline } from '../providers/model-fence.js';

/** How long a reloaded page is given to settle before the assertion is re-read. */
export const RELOAD_RECHECK_WAIT_MS = 5_000;

/**
 * Actions that change what the page is showing, and so make a reload destroy
 * the state a later assertion is about.
 *
 * A click is in the list on purpose and is the reason the list is worth
 * having: opening a dropdown is a click, and HIR-EC-029's failing assertion
 * was about an OPEN dropdown. Reloading there closes the list, so the re-check
 * could only fail — a retry that can only fail is worse than no retry, because
 * it costs a page load and then reports a different failure than the real one.
 */
export const STATE_CHANGING_ACTIONS: ReadonlySet<string> = new Set([
  'click',
  'clickIfVisible',
  'fill',
  'fillRetry',
  'type',
  'paste',
  'selectOption',
  'check',
  'uncheck',
  'press',
  'upload',
  'closeModal',
  'scrollTo',
  'setLocalStorage',
  'clearStorage',
]);

/**
 * May this step's failure be re-checked after a reload?
 *
 * `actionsSinceNavigation` is what the flow has done since the last `goto`,
 * in order. Anything state-changing means the page as it stands is the
 * product of those actions, and a reload throws them away.
 */
export function reloadSafe(actionsSinceNavigation: readonly string[]): boolean {
  return !actionsSinceNavigation.some((action) => STATE_CHANGING_ACTIONS.has(action));
}

/** Why a re-check was not attempted — recorded on the step, never inferred by a reader. */
export function reloadSkipReason(actionsSinceNavigation: readonly string[]): string | null {
  const blocker = actionsSinceNavigation.find((action) => STATE_CHANGING_ACTIONS.has(action));
  return blocker === undefined
    ? null
    : `not re-checked after a reload: the flow ran "${blocker}" on this page, and reloading would discard the state this step is about`;
}

/**
 * Whether the UI reading settled the claim on its own.
 *
 * `contradicted` — the selector resolved and the comparison failed — is the
 * page's own answer, and the backend may not overrule it. `inconclusive` — the
 * selector never resolved, the element was unreachable, the action was
 * blocked — means the UI never got to answer, which is the one case the
 * operator asked the backend to decide.
 */
export type UiReading = 'passed' | 'contradicted' | 'inconclusive';

/**
 * @param pageAnswered the engine's own reading that the element RESOLVED and
 * the claim about it was contradicted — `isContentMiss` (its text disagreed)
 * OR `isStateContradiction` (its count, state or focus disagreed), both from
 * `runner.ts`. Computed by the caller so this module never imports the runner
 * that imports it.
 *
 * Both matter. HIR-EC-029's `expected 3 matches, found 4` is a STATE
 * contradiction, not a text miss: the selector resolved and counted. Reading
 * only `isContentMiss` would have called that inconclusive and let the backend
 * decide a question the page had already answered.
 */
export function uiReadingOf(status: string, pageAnswered: boolean): UiReading {
  if (status === 'passed') return 'passed';
  return pageAnswered ? 'contradicted' : 'inconclusive';
}

/** A candidate endpoint the claim might be answerable from. */
export interface BackendCandidate {
  method: string;
  url: string;
  /** Why this call was picked, for the evidence line. */
  because: string;
}

/**
 * The endpoint to re-fetch, in the operator's agreed order.
 *
 * **A** — an endpoint the FLOW ITSELF authored (`request` steps already run in
 * this flow). Deterministic and free: the author named the path, so nothing is
 * being guessed.
 *
 * **B** — otherwise the page's own traffic, observed while the step ran. Only
 * a GET that came back 2xx is a candidate: a mutation must never be replayed
 * to settle a read, and a call that already failed answers nothing. The most
 * recent is preferred — the one the step was waiting on.
 *
 * Returns null when neither exists, which is the documented "backend not
 * available" case: validation ends at the reload re-check.
 */
export function pickBackendCandidate(
  authored: readonly { method: string; url: string }[],
  observed: readonly NetworkCall[],
): BackendCandidate | null {
  const firstAuthored = authored[authored.length - 1];
  if (firstAuthored !== undefined) {
    return { ...firstAuthored, because: 'the flow authored this request, so the path is the author\'s own' };
  }
  const readable = observed.filter(
    (call) =>
      call.method.toUpperCase() === 'GET' &&
      call.status !== undefined &&
      call.status >= 200 &&
      call.status < 300 &&
      (call.resourceType === 'xhr' || call.resourceType === 'fetch'),
  );
  const last = readable[readable.length - 1];
  return last === undefined
    ? null
    : {
        method: 'GET',
        url: last.url,
        because: `the page fetched this while the step ran (${readable.length} call(s) observed)`,
      };
}

/**
 * The B half: locating, inside a response nobody wrote a schema for, the part
 * that answers the claim.
 *
 * One method, the `HealerModel` shape, so the whole plane stubs offline. It is
 * asked for a JSON path and an expected value, never for a verdict — the
 * comparison itself stays in code, because a model that both reads the payload
 * and declares the answer is a model marking its own homework.
 */
export interface CorroborationModel {
  readonly id: string;
  locate(request: CorroborationRequest): Promise<CorroborationLocation>;
  /**
   * Name the table, column and filter that answer the claim — never SQL.
   * Returns null when nothing in the schema does, which is how a corroboration
   * declines instead of guessing at a query.
   */
  chooseDb(request: CorroborationDbRequest): Promise<DbLookupChoice | null>;
}

export interface CorroborationDbRequest {
  intent: string;
  action: string;
  expected: string;
  /** The introspected schema as names only — a model never sees data to choose from. */
  schema: string;
}

export interface CorroborationRequest {
  /** The claim in the author's own words — the step's intent. */
  intent: string;
  action: string;
  /** What the UI step expected, as the engine recorded it. */
  expected: string;
  /** The endpoint that was fetched. */
  url: string;
  /** The response body, clipped. */
  body: string;
}

export interface CorroborationLocation {
  /**
   * A dotted path into the parsed body — `data.picking_lists.event_reason`.
   * Array segments are numeric. Empty means "the model could not locate it".
   */
  path: string;
  /**
   * How to read the located value: its length (a set's size) or the value
   * itself. Anything else is not accepted.
   */
  read: 'count' | 'value';
  reasoning: string;
}

export type CorroborationOutcome =
  | { kind: 'unavailable'; reason: string }
  | { kind: 'confirmed'; query: string; path: string; found: string; expected: string }
  | { kind: 'contradicted'; query: string; path: string; found: string; expected: string };

/** Read a dotted path out of a parsed body. Returns undefined for any miss. */
export function readJsonPath(body: unknown, path: string): unknown {
  if (path.trim() === '') return undefined;
  let current: unknown = body;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Compare the located value to what the UI step expected.
 *
 * **The located path must exist.** A model that names a path the response does
 * not hold produces `unavailable`, never a verdict — the mapping is verified
 * before it is believed, the same rule `#verify` applies to a healed selector.
 */
export function compareToBackend(
  body: string,
  location: CorroborationLocation,
  expected: string,
  query: string,
): CorroborationOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { kind: 'unavailable', reason: 'the response was not JSON, so nothing could be read out of it' };
  }
  const located = readJsonPath(parsed, location.path);
  if (located === undefined) {
    return {
      kind: 'unavailable',
      reason: `the response holds no "${location.path}", so the mapping could not be believed`,
    };
  }
  const found =
    location.read === 'count'
      ? String(Array.isArray(located) ? located.length : Object.keys(located as object).length)
      : String(located);
  const same = found.trim().toLowerCase() === expected.trim().toLowerCase();
  return {
    kind: same ? 'confirmed' : 'contradicted',
    query,
    path: location.path,
    found,
    expected,
  };
}

/**
 * The verdict, given both readings — the whole rule in one pure function.
 *
 * | UI | backend | outcome |
 * |---|---|---|
 * | passed | anything | passed (the backend cannot fail a page that proved its claim) |
 * | contradicted | anything | failed — the page resolved its element and disagreed |
 * | inconclusive | confirmed | **frontend defect**: the data is right, the page never showed it |
 * | inconclusive | contradicted | failed, and the defect is the backend's |
 * | inconclusive | unavailable | failed as the UI failed — validation ended at the reload |
 */
export interface CorroboratedVerdict {
  status: 'passed' | 'failed';
  /** Which plane the defect belongs to, when there is one. */
  defect: 'frontend' | 'backend' | null;
  why: string;
}

export function corroboratedVerdict(
  ui: UiReading,
  backend: CorroborationOutcome | null,
): CorroboratedVerdict {
  if (ui === 'passed') return { status: 'passed', defect: null, why: 'the page proved the claim' };
  if (ui === 'contradicted') {
    return {
      status: 'failed',
      defect: 'frontend',
      why:
        backend === null || backend.kind === 'unavailable'
          ? 'the page resolved the element and its content did not hold'
          : backend.kind === 'confirmed'
            ? 'the page resolved the element and disagreed, while the backend holds the expected value — a rendering fault'
            : 'the page and the backend both disagree with the expectation',
    };
  }
  if (backend === null || backend.kind === 'unavailable') {
    return {
      status: 'failed',
      defect: null,
      why: 'the page never resolved the element, and no backend check was available to settle it',
    };
  }
  if (backend.kind === 'confirmed') {
    return {
      status: 'failed',
      defect: 'frontend',
      why: `the backend holds the expected ${backend.expected} at ${backend.path}; the page never rendered it`,
    };
  }
  return {
    status: 'failed',
    defect: 'backend',
    why: `the backend answered ${backend.found} where ${backend.expected} was expected, at ${backend.path}`,
  };
}

/**
 * A click that did not take, and what may be substituted for it.
 *
 * Asked for alongside the assertion rungs: a click that cannot be made to work
 * is refreshed, waited out and tried again, and only then — if the control
 * carries a route of its own — is the route taken instead.
 *
 * The exception the operator confirmed is the load-bearing half. These sheets
 * say `ไม่เปิด URL ข้าม assertion` — do not open the URL to skip the
 * assertion — and a case whose script reaches a page through the menu is a
 * case ABOUT the menu. Substituting a `goto` there proves nothing and passes
 * anyway, which is the "a rung may only fail identically or succeed against
 * the right thing" rule broken in the most expensive direction.
 */
export const ROUTE_WORDS_IN_SCRIPT =
  /(เมนู|เมนูซ้าย|แถบเมนู|คลิก|กดเมนู|menu|sidebar|breadcrumb|crumb|navigate via|click through)/i;

/**
 * Whether the case's own script makes the navigation the claim.
 *
 * Structural, not a phrase list for one app: it reads the SHEET's words for
 * travelling by menu. When they are present, the click is the thing under
 * test and no route may stand in for it.
 */
export function navigationIsTheClaim(caseText: string | undefined): boolean {
  return caseText !== undefined && ROUTE_WORDS_IN_SCRIPT.test(caseText);
}

export type ClickRecovery =
  | { kind: 'retry-after-reload' }
  | { kind: 'route'; url: string }
  | { kind: 'fail'; why: string };

/**
 * What to do for a click that did not take, given what is known about it.
 *
 * `routeUrl` is the element's OWN href as the accessibility tree already
 * reports it (`AxNode.url`) — never a guess at what a script-driven handler
 * might do. A button whose handler calls a router carries no url here, and the
 * step fails rather than having a path invented for it.
 */
export function clickRecovery(options: {
  reloadAlreadyTried: boolean;
  reloadSafe: boolean;
  routeUrl: string | undefined;
  caseText: string | undefined;
}): ClickRecovery {
  if (!options.reloadAlreadyTried && options.reloadSafe) return { kind: 'retry-after-reload' };
  if (options.routeUrl === undefined || options.routeUrl.trim() === '') {
    return {
      kind: 'fail',
      why: 'the control could not be clicked and carries no route of its own to take instead',
    };
  }
  if (navigationIsTheClaim(options.caseText)) {
    return {
      kind: 'fail',
      why:
        'the control could not be clicked, and the case reaches this page through the menu — ' +
        'navigating by URL would skip the very thing this case tests',
    };
  }
  return { kind: 'route', url: options.routeUrl };
}

/**
 * The model half, on the AGENT ROLE'S OWN CONFIG.
 *
 * Asked for explicitly (2026-09-11): no new role, no new environment
 * variables, no second thing to keep in step — whatever the agent is pointed
 * at, this is pointed at too. `LLM_ROLES` is unchanged, and
 * `WOWLIDATOR_AGENT_PROVIDER` / `WOWLIDATOR_AGENT_MODEL` move both at once
 * because there is only one setting.
 *
 * What it does NOT share is the circuit breaker. `StructuredRequest.task` is
 * the name a caller gives its ask beyond the role, and the breaker is keyed
 * `task@model` — so this is `verdict-agent@<model>`, a circuit of its own.
 * That is the rule `src/providers/CLAUDE.md` already states for
 * `generator@…` vs `agent@…`: a role that keeps answering must never be
 * switched off by a sibling's failures on the same model. A payload this
 * cannot map must not cost the workflow agent its next leg.
 */
export const VERDICT_TASK = 'verdict-agent';

/** Exported so a test can prove there is no field a model could answer a VERDICT in. */
export const LocationSchema = z.object({
  path: z
    .string()
    .describe('Dotted path into the response that holds the answer, e.g. data.picking_lists.event_reason. Empty string if you cannot find it.'),
  read: z.enum(['count', 'value']).describe('count = how many entries are at that path; value = the value itself.'),
  reasoning: z.string().describe('One sentence naming the key you matched on.'),
});

const VERDICT_SYSTEM = `You locate, inside a JSON response, the part that answers a test's claim.

${DETERMINISM_RULES}

You are NOT deciding whether the test passes. You name WHERE the answer is; the
harness reads that path and compares it itself. A path you are unsure of is
worse than none: answer with an empty path when nothing in the response holds
the claim's subject, and the harness will record that the backend could not
settle it.

${procedure('Locating the answer', [
  'Read the claim and what it expected.',
  'Find the key in the response whose contents are the claim\'s subject — match on the subject\'s own words, never on position.',
  'If the claim is about HOW MANY, answer read="count" and give the path of the LIST. If it is about a value, answer read="value" and give the path of that value.',
  'If several keys could be meant, answer with an empty path rather than guessing: a wrong path is a wrong verdict.',
])}

${selfCheck([
  'Does the path I named exist in the response exactly as written?',
  'Is the thing at that path the claim\'s subject, or merely near it?',
  'If I am not sure, have I answered with an empty path?',
])}`;

export interface LlmCorroborationModelOptions {
  factory?: LlmFactory | undefined;
  model?: LanguageModel | undefined;
  id?: string | undefined;
  maxOutputTokens?: number | undefined;
  maxRetries?: number | undefined;
}

/** How much of a response the mapping call is shown. A lookup can be megabytes. */
export const CORROBORATION_BODY_MAX_CHARS = 12_000;

export class LlmCorroborationModel implements CorroborationModel {
  readonly #source: ModelSource;
  readonly #maxOutputTokens: number;
  readonly #maxRetries: number;
  readonly #givenId: string | undefined;

  constructor(options: LlmCorroborationModelOptions = {}) {
    if (options.model) {
      this.#source = { model: options.model };
      this.#givenId = options.id ?? `custom:${VERDICT_TASK}`;
      this.#maxRetries = options.maxRetries ?? 2;
    } else {
      const factory = options.factory ?? new LlmFactory();
      // The agent's role, deliberately. There is one setting for both.
      this.#source = { factory, role: 'agent' };
      this.#givenId = options.id;
      this.#maxRetries = options.maxRetries ?? factory.maxRetries;
    }
    this.#maxOutputTokens = options.maxOutputTokens ?? 512;
  }

  /** Resolved lazily, the `LlmAgentModel` rule: a run that never corroborates never demands a key. */
  get id(): string {
    if (this.#givenId !== undefined) return this.#givenId;
    return 'factory' in this.#source ? this.#source.factory.labelFor('agent') : `custom:${VERDICT_TASK}`;
  }

  async locate(request: CorroborationRequest): Promise<CorroborationLocation> {
    const body =
      request.body.length > CORROBORATION_BODY_MAX_CHARS
        ? `${request.body.slice(0, CORROBORATION_BODY_MAX_CHARS)}\n…[response clipped]`
        : request.body;
    const { object } = await generateStructuredForModel(this.#source, {
      modelLabel: this.id,
      // Its own circuit: a payload this cannot map must not refuse the
      // workflow agent's next leg on the same model.
      task: VERDICT_TASK,
      schema: LocationSchema,
      system: VERDICT_SYSTEM,
      prompt: [
        fence('catalog', sanitizeInline(request.intent)),
        `The step ran ${request.action} and expected: ${sanitizeInline(request.expected)}`,
        fence('network', sanitizeInline(request.url)),
        fence('network', body),
      ].join('\n\n'),
      maxOutputTokens: this.#maxOutputTokens,
      maxRetries: this.#maxRetries,
    });
    return { path: object.path.trim(), read: object.read, reasoning: object.reasoning };
  }

  async chooseDb(request: CorroborationDbRequest): Promise<DbLookupChoice | null> {
    const { object } = await generateStructuredForModel(this.#source, {
      modelLabel: this.id,
      task: VERDICT_TASK,
      schema: DbChoiceSchema,
      system: DB_VERDICT_SYSTEM,
      prompt: [
        fence('catalog', sanitizeInline(request.intent)),
        `The step ran ${request.action} and expected: ${sanitizeInline(request.expected)}`,
        fence('repository', request.schema),
      ].join('\n\n'),
      maxOutputTokens: this.#maxOutputTokens,
      maxRetries: this.#maxRetries,
    });
    const table = object.table.trim();
    if (table === '') return null;
    const where: Record<string, string> = {};
    for (const pair of object.where ?? []) {
      const column = pair.column.trim();
      if (column !== '') where[column] = pair.value;
    }
    return { table, column: object.column.trim(), where, read: object.read };
  }
}

const DbChoiceSchema = z.object({
  table: z.string().describe('The table that holds the answer. Empty string if the schema has none.'),
  column: z.string().describe('The column to read, or the column the rows are counted over.'),
  where: z
    .array(z.object({ column: z.string(), value: z.string() }))
    .describe('Filter as column/value pairs. Empty array for none. Flat, because a weak model handles a map badly.'),
  read: z.enum(['count', 'value']).describe('count = how many rows match; value = the column of the matching row.'),
  reasoning: z.string().describe('One sentence naming the table and column you matched on.'),
});

const DB_VERDICT_SYSTEM = `You name the table, column and filter that answer a test's claim.

${DETERMINISM_RULES}

You do NOT write SQL and you do NOT decide whether the test passes. You name
parts; the harness checks every name against the introspected schema, builds a
read-only SELECT with your filter as parameters, and compares the result itself.

A table or column the schema does not declare is refused and the corroboration
is lost, so answer with an empty table rather than a plausible guess.

${procedure('Naming the parts', [
  "Read the claim and what it expected.",
  'Find the table whose rows ARE the claim\'s subject.',
  'If the claim is about HOW MANY, answer read="count" and name the column the rows are counted over.',
  'Add only filters the claim itself states. A filter you invent narrows the answer to something the test never asked about.',
  'If no table in the schema holds the subject, answer with an empty table.',
])}

${selfCheck([
  'Is every table and column I named in the schema exactly as written?',
  'Does the filter come from the claim, or did I invent it?',
  'If I am not sure, have I answered with an empty table?',
])}`;

/* ------------------------------------------------------------ the database */

/**
 * The database as a corroboration source, beside the HTTP one.
 *
 * Asked for 2026-09-11: when a claim could be checked by reading the database,
 * read it — compare against the expected value AND what the UI showed, and put
 * the QUERY and the ROWS on the proof page. HIR-EC-029 is the shape: the page
 * count was wrong for a reason that had nothing to do with the data, and no
 * surface said what the data actually held.
 *
 * The rails are `value-resolution.ts`'s `fromDatabase`, reused rather than
 * reinvented, because they are what make a model-chosen query safe:
 *
 * - **A model names a table, a column and a filter — never SQL.** It cannot
 *   write a statement, so it cannot write one that mutates.
 * - **Every identifier is checked against the INTROSPECTED schema before it
 *   reaches the database.** A table, column or filter key the schema does not
 *   declare is a refusal, not a query.
 * - **Values travel as parameters**, never interpolated into the text.
 * - **Read-only by construction**: this builds `SELECT`, and nothing else.
 * - **A sensitive column is never read back into evidence** — the same rule
 *   the reports already apply, because a proof page is an artifact people mail
 *   to each other.
 */
export interface DbLookupChoice {
  table: string;
  column: string;
  where: Record<string, string>;
  /** `count` compares how many rows match; `value` compares the column's value. */
  read: 'count' | 'value';
}

/** The schema as the corroborator is allowed to see it — names only. */
export interface DbSchemaView {
  tables: readonly { name: string; columns: readonly string[] }[];
}

export interface DbCorroborationPlan {
  sql: string;
  params: readonly unknown[];
  table: string;
  column: string;
}

/**
 * Turn a model's choice into a statement, or refuse it.
 *
 * Returns a typed refusal string rather than throwing: a corroboration that
 * cannot be built is a corroboration that did not happen, and the step keeps
 * the verdict it already had.
 */
export function planDbLookup(
  choice: DbLookupChoice,
  schema: DbSchemaView,
  quoteIdent: (name: string) => string,
): DbCorroborationPlan | { refused: string } {
  const table = schema.tables.find((t) => t.name.toLowerCase() === choice.table.trim().toLowerCase());
  if (table === undefined) return { refused: `the schema declares no table "${choice.table}"` };
  const columns = new Set(table.columns.map((c) => c.toLowerCase()));
  const column = table.columns.find((c) => c.toLowerCase() === choice.column.trim().toLowerCase());
  if (column === undefined) return { refused: `${table.name} has no column "${choice.column}"` };
  for (const key of Object.keys(choice.where)) {
    if (!columns.has(key.trim().toLowerCase())) return { refused: `${table.name} has no column "${key}" to filter on` };
  }
  const keys = Object.keys(choice.where);
  const where = keys.length === 0 ? '' : ` WHERE ${keys.map((k, i) => `${quoteIdent(k)} = $${i + 1}`).join(' AND ')}`;
  const select = choice.read === 'count' ? 'count(*) AS v' : `${quoteIdent(column)} AS v`;
  const tail = choice.read === 'count' ? '' : ' ORDER BY 1 DESC LIMIT 1';
  return {
    sql: `SELECT ${select} FROM ${quoteIdent(table.name)}${where}${tail}`,
    params: keys.map((k) => choice.where[k]),
    table: table.name,
    column,
  };
}

/**
 * What the proof page is given about a database corroboration.
 *
 * The query is recorded whatever the outcome — the operator's complaint about
 * HIR-EC-029 was that no surface could say what had been counted, and a query
 * nobody can read is the same failure one layer down.
 */
export interface DbEvidence {
  sql: string;
  /** Parameters, redacted for display — never the raw values of a sensitive column. */
  params: readonly string[];
  table: string;
  column: string;
  found: string | null;
  expected: string;
  outcome: 'confirmed' | 'contradicted' | 'unavailable';
  why?: string | undefined;
}

/** Compare a database reading to what the UI step expected. */
export function compareDbReading(
  found: unknown,
  expected: string,
  plan: DbCorroborationPlan,
  params: readonly string[],
): DbEvidence {
  const base = { sql: plan.sql, params, table: plan.table, column: plan.column, expected };
  if (found === null || found === undefined) {
    return { ...base, found: null, outcome: 'unavailable', why: 'the query returned no row' };
  }
  const shown = String(found);
  return {
    ...base,
    found: shown,
    outcome: shown.trim().toLowerCase() === expected.trim().toLowerCase() ? 'confirmed' : 'contradicted',
  };
}

/** A `DbEvidence` as a `CorroborationOutcome`, so one verdict table serves both sources. */
export function dbOutcomeOf(evidence: DbEvidence): CorroborationOutcome {
  if (evidence.outcome === 'unavailable') {
    return { kind: 'unavailable', reason: evidence.why ?? 'the database could not answer' };
  }
  return {
    kind: evidence.outcome,
    query: evidence.sql,
    path: `${evidence.table}.${evidence.column}`,
    found: evidence.found ?? '',
    expected: evidence.expected,
  };
}
