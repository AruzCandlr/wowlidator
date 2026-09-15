/**
 * Step-level evidence lookup at authoring time (asked for 2026-09-08).
 *
 * `value-resolution.ts` answers "the sheet left this VALUE as a token — what is
 * the value?" from the cheapest source that can answer, and records which one
 * did. This module answers the other half of the same question: **"the sheet
 * names a control the captured tree does not show — does anything else state
 * that the application renders it?"**
 *
 * The measured failure (be-cycle1-sit, 2026-09-07/08, 440 rows): a row's later
 * steps act on a page no capture ever reached — behind a `workflow` leg, an
 * upload wizard, a route the journey capture ranked past — so the author writes
 * the control the sheet names, the $0 grounding audit flags it ("the accessible
 * name in role=button[name="ส่งออก CSV" i] appears in no captured tree"), and the
 * paid review answers `unsure` 507 times. Twice in the same run the review
 * answered `keep` instead, quoting `messages/th.json` — the repository DID
 * declare the string, and a model call was spent discovering what a string
 * comparison could have said for nothing.
 *
 * Two sources answer here, and the choice of which is the whole design:
 *
 * 1. **the repository** — the strings the indexed project declares the
 *    application renders (a message catalog's values, a component's own JSX
 *    words). This is the grounding order the authoring prompt already states —
 *    tree, then repository, then a workflow leg — and the source
 *    `ungroundedTextExpectation` has accepted since 2026-08-28. What is new is
 *    that the lookup is keyed on the STEP's own name, over the whole index,
 *    instead of over the route-ranked slice chosen before the flow existed.
 * 2. **the database** — read-only, for a fixture the flow asserts as already
 *    present. `ungroundedFixtureAssertion` refuses such an assertion because
 *    thirteen be100 cases asserted records the database never held; a
 *    `count(*) > 0` against the indexed schema is the evidence that settles
 *    that doubt in the application's favour, and a `count(*) = 0` leaves the
 *    refusal exactly where it was.
 *
 * **The documents are deliberately NOT a source for a control.** A requirement
 * document's wording is the thing the tree's rendering is checked against, not
 * a substitute for it — the live refusal *"that is the requirement document's
 * wording, and the step will dead-end on every run"* (RU_09_03) is the rule
 * this module must not undo. The documents stay where they already ground
 * things: values (`fromRepo` in `value-resolution.ts`) and paths (`applyReview`).
 *
 * Rails, all the ladder's:
 * - **Never fatal.** A source that throws is a source that did not answer.
 * - **Silence is not evidence.** No tree, or a truncated one, and the stage
 *   declines outright — the same rule every grounding lint follows.
 * - **It may only make a claim MORE grounded, never more refused.** The lines
 *   it finds are handed to the lints that read declared strings as GROUNDING;
 *   they are never handed to `workflowOverDeclaredControls`, which reads them
 *   as a prohibition.
 * - **Provenance travels on the step.** Each answered step's intent ends
 *   `[evidence: repository — <file> declares "<string>"]`, the flow's notes
 *   carry the summary, and the run log prints one line per lookup.
 */

import type { DbClient } from '../db/client.js';
import { quoteIdent } from '../db/db-actions.js';
import type { FlowStep } from '../engine/runner.js';
import { selectorGrounded, selectorName } from '../orchestrator/agent-guards.js';
import {
  qualifiedIdent,
  resolveTableIn,
  schemaSummary,
  tableLookupFailure,
  type ValueResolverModel,
} from './value-resolution.js';

/** The marker a narrowed tree carries; past it, absence is not evidence of absence. */
const TRUNCATED = 'TREE TRUNCATED';

/**
 * How many fixtures one row may ask the database about. Each is one small
 * model call (which table holds such a value) plus one `SELECT count(*)`; a
 * row asserting more pre-existing records than this is a row whose test data
 * is the reader's problem, not a lookup's.
 */
export const MAX_DB_LOOKUPS = 2;

/** The sources a step's evidence may come from here. The captured tree is not one: a step it grounds was never a need. */
export type StepEvidenceKind = 'repository' | 'database';

export interface StepEvidence {
  kind: StepEvidenceKind;
  /** One line a reader can check: the file that declares the string, or the table, column and count. */
  detail: string;
  /** True when the source states the name EXACTLY, not merely inside a longer string. */
  exact: boolean;
}

/** One string the indexed repository declares the application renders, and where it says so. */
export interface DeclaredString {
  text: string;
  /** The node's own name and file — `admin_benefits_rules (messages/th.json)`. */
  where: string;
}

/** One step resting on a name no captured tree renders. */
export interface EvidenceNeed {
  section: 'setup' | 'steps';
  index: number;
  /** The accessible name or asserted text the step rests on. */
  name: string;
}

export interface StepEvidenceContext {
  /** Every captured tree and the probe report, joined — the definition of "already grounded". */
  trees?: string | undefined;
  /** The row's repository slice, as it reached the prompt. Its quoted strings are declared strings too. */
  projectContext?: string | undefined;
  /** Everything the indexed repository declares, beyond the row's ranked slice. */
  declared?: readonly DeclaredString[] | undefined;
  /** The identifier-shaped values of the case's own test data (`fixtureFacts`). */
  fixtures?: readonly string[] | undefined;
  /** Read-only client, resolved lazily so a row that needs no lookup never connects. */
  db?: (() => Promise<DbClient | null>) | undefined;
  /** Only the database tier asks a model, and only to choose a table and column. */
  model?: ValueResolverModel | null | undefined;
  /** The case's own words — what the database tier tells the model it is looking for. */
  caseText?: string | undefined;
  onLog?: ((line: string) => void) | undefined;
}

export interface StepEvidenceOutcome {
  /**
   * Names a declared source states EXACTLY. The grounding audit may treat a
   * selector on one of these as grounded: the repository declaring the
   * rendered string is the second source the authoring prompt names, and on a
   * page no capture reached it is the only one left before a workflow leg.
   */
  groundedControls: string[];
  /**
   * The evidence lines, in the repository section's own shape, to append to
   * the declared-strings text the grounding lints and the reviewer read.
   * Repository only — never a document, never the case's own words.
   */
  declaredLines: string[];
  /** Fixtures the database shows the application already holds. */
  existingFixtures: string[];
  /**
   * Fixtures whose lookup COULD NOT RUN, with the reason — a connection that
   * refused, a driver that is not installed, a table the model named that did
   * not resolve. **Unavailable is not absent** (2026-09-11, run
   * `be-sit-high-opus-th-20260911-174323`, case PL_09_01): the lookup threw on
   * a table-name spelling, the fixture stayed out of `existingFixtures`, and
   * `ungroundedFixtureAssertion` refused as though the database had answered
   * "no such row" — twice, identically, so the row sealed `blocked` where a
   * plain `--resume` can never pick it up again. The two facts are recorded
   * apart so the caller can refuse one and merely note the other; this module
   * still judges nothing, in keeping with "evidence may excuse a claim, never
   * accuse one".
   *
   * Only a lookup that was ATTEMPTED and failed is listed. A row with no
   * database configured, or one past `MAX_DB_LOOKUPS`, asks nothing and is
   * exactly as unproven as it was before this module existed — silence there
   * is the documented baseline, not a new fault.
   */
  unavailableFixtures: { fact: string; reason: string }[];
  /** One line per lookup that answered — for the flow's notes. */
  notes: string[];
  /** The names nothing answered, so the refusal that follows is still the honest one. */
  unanswered: string[];
}

const EMPTY: StepEvidenceOutcome = {
  groundedControls: [],
  declaredLines: [],
  existingFixtures: [],
  unavailableFixtures: [],
  notes: [],
  unanswered: [],
};

/**
 * Every selector a step carries — the one `selector`, or an either/or step's
 * `selectors` (CG-08). The grounding lints read this so an alternative is
 * judged exactly as a single selector would be. Lives here, beside the
 * evidence lookup that reads the same selectors, and is re-exported by
 * `flow-author.ts` so there is one definition.
 */
export function selectorsOf(step: FlowStep): string[] {
  const one = (step as { selector?: unknown }).selector;
  const many = (step as { selectors?: unknown }).selectors;
  const out: string[] = [];
  if (typeof one === 'string') out.push(one);
  if (Array.isArray(many)) for (const s of many) if (typeof s === 'string') out.push(s);
  return out;
}

/**
 * Every string a repository-context section declares the application renders:
 * the quoted spans of `renders the … strings [locale, file]: key: "value" · …`
 * lines and of a component's `says: "word" · "word"` detail. One extractor for
 * every consumer, so "declared by the code" cannot mean two different things
 * in two lints. Re-exported by `flow-author.ts`, which had it first.
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

/** The shape of an indexed node this module needs — structural, so no graph type is imported. */
export interface DeclaringNode {
  kind: string;
  name: string;
  file?: string | undefined;
  detail?: string | undefined;
}

/**
 * The whole index's declared strings: every quoted span of a `message` or
 * `component` node's own detail, with the node that declares it. Those two
 * kinds are the ones that carry the application's WORDS — a message
 * namespace's values and a component's JSX text and label attributes (see
 * `src/context/CLAUDE.md`, "a component's own words"). Built once per run and
 * searched per step; it never reaches a prompt, so its size is a memory
 * question, not a token one.
 */
export function declaredStringsOf(nodes: readonly DeclaringNode[]): DeclaredString[] {
  const out: DeclaredString[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    if (node.kind !== 'message' && node.kind !== 'component') continue;
    const where = node.file ? `${node.name} (${node.file})` : node.name;
    for (const text of declaredControlStrings(node.detail)) {
      const key = `${text} ${where}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ text, where });
    }
  }
  return out;
}

const fold = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * The steps resting on a name no captured tree renders — the audit's own
 * question (`selectorGrounded`, one predicate for both), asked here so the
 * lookup and the audit cannot disagree about what "ungrounded" means.
 *
 * Declines wholly when there is no usable tree: past the node budget, and with
 * nothing captured at all, absence of evidence is not evidence of absence.
 * `expectHidden` and a zero `expectCount` are exempt for the reason the lints
 * exempt them — asserting that something is NOT rendered needs no rendering.
 */
export function unaccountedControls(
  setup: readonly FlowStep[],
  steps: readonly FlowStep[],
  trees: string | undefined,
): EvidenceNeed[] {
  if (trees === undefined || trees.trim() === '' || trees.includes(TRUNCATED)) return [];
  const needs: EvidenceNeed[] = [];
  const walk = (section: 'setup' | 'steps', list: readonly FlowStep[]): void => {
    list.forEach((step, index) => {
      if (step.action === 'workflow') return;
      if (step.action === 'expectHidden') return;
      if (step.action === 'expectCount' && (step as { count?: number }).count === 0) return;
      for (const selector of selectorsOf(step)) {
        if (selectorGrounded(selector, trees) !== false) continue;
        const name = selectorName(selector);
        if (name === null || name.trim() === '') continue;
        needs.push({ section, index, name: name.trim() });
      }
    });
  };
  walk('setup', setup);
  walk('steps', steps);
  return needs;
}

/**
 * What the repository declares about a name: the exact declaration first, a
 * declaration that CONTAINS it second (the containment
 * `ungroundedTextExpectation` has always used, kept so the two agree), and
 * null when the index says nothing. The row's own slice is searched beside the
 * whole index, so a run with no index but a slice still answers.
 */
export function fromRepository(
  name: string,
  ctx: Pick<StepEvidenceContext, 'declared' | 'projectContext'>,
): StepEvidence | null {
  const needle = fold(name);
  if (needle.length < 2) return null;
  const pool: DeclaredString[] = [
    ...(ctx.declared ?? []),
    ...declaredControlStrings(ctx.projectContext).map((text) => ({
      text,
      where: 'the repository section handed to the author',
    })),
  ];
  const exact = pool.find((entry) => fold(entry.text) === needle);
  if (exact !== undefined) {
    return {
      kind: 'repository',
      exact: true,
      detail: `${exact.where} declares ${JSON.stringify(exact.text)}`,
    };
  }
  const inside = pool.find((entry) => needle.length >= 3 && fold(entry.text).includes(needle));
  if (inside !== undefined) {
    return {
      kind: 'repository',
      exact: false,
      detail: `${inside.where} declares ${JSON.stringify(inside.text)}, which contains it`,
    };
  }
  return null;
}

/**
 * The fixtures a flow ASSERTS rather than types — the same reading
 * `ungroundedFixtureAssertion` makes: the step's claim without its intent,
 * because an intent is written for a reader and asserts nothing.
 */
export function assertedFixtures(steps: readonly FlowStep[], facts: readonly string[]): string[] {
  const out = new Set<string>();
  for (const step of steps) {
    if (step.action === 'fill' || step.action === 'type' || step.action === 'selectOption') continue;
    const { intent: _intent, ...claim } = step as FlowStep & { intent?: unknown };
    const text = JSON.stringify(claim);
    for (const fact of facts) if (text.includes(fact)) out.add(fact);
  }
  return [...out];
}

/**
 * Does the application's own data already hold this value? Read-only, one
 * `SELECT count(*)`, every identifier checked against the introspected schema
 * before it reaches SQL — `value-resolution.ts`'s database rails, applied to
 * an existence question instead of a value question.
 *
 * Only `count > 0` answers. A count of zero is NOT a finding this module
 * reports: it is the refusal `ungroundedFixtureAssertion` was already going to
 * make, and saying it twice would only make the message longer.
 */
export async function fromDatabase(
  value: string,
  ctx: StepEvidenceContext,
): Promise<StepEvidence | null> {
  if (ctx.db === undefined || ctx.model === null || ctx.model === undefined) return null;
  const client = await ctx.db();
  if (client === null) return null;
  const schema = await client.introspect();
  const choice = await ctx.model.chooseDbLookup({
    field: value,
    token: null,
    caseText: (ctx.caseText ?? '').slice(0, 3000),
    schema: schemaSummary(schema),
  });
  if (choice === null) return null;
  const resolved = resolveTableIn(schema, choice.table);
  if (resolved.kind !== 'found') throw new Error(tableLookupFailure(choice.table, resolved));
  const table = resolved.table;
  const column = table.columns.find((c) => c.name.toLowerCase() === choice.column.trim().toLowerCase());
  if (column === undefined) {
    throw new Error(`the model named column "${choice.column}" on ${table.name}, which the schema does not declare`);
  }
  const result = await client.query(
    `SELECT count(*) AS n FROM ${qualifiedIdent(table.name)} WHERE ${quoteIdent(column.name)} = $1`,
    [value],
  );
  const n = Number((result.rows[0] as { n?: unknown } | undefined)?.n ?? 0);
  if (n <= 0) return null;
  return {
    kind: 'database',
    exact: true,
    detail: `${table.name}.${column.name} holds ${n} row(s) with this value, so the application already has it`,
  };
}

/** The provenance suffix a step carries once a source answered for it. */
export function evidenceNote(evidence: StepEvidence): string {
  return ` [evidence: ${evidence.kind} — ${evidence.detail.slice(0, 160)}]`;
}

/** Append the suffix to a step's intent, in place and once — the step objects are shared with the case lists. */
function annotate(step: FlowStep, evidence: StepEvidence): void {
  const holder = step as FlowStep & { intent?: string | undefined };
  const suffix = evidenceNote(evidence);
  const current = holder.intent ?? '';
  if (current.includes(suffix)) return;
  holder.intent = `${current}${suffix}`.trim();
}

/**
 * Look up every step the captured trees do not account for, cheapest source
 * first, and record what answered on the step and in the outcome.
 *
 * Never throws: a source that fails is a source that did not answer, and the
 * lints then refuse exactly what they refused before this existed.
 */
export async function resolveStepEvidence(
  setup: readonly FlowStep[],
  steps: readonly FlowStep[],
  ctx: StepEvidenceContext,
): Promise<StepEvidenceOutcome> {
  const needs = unaccountedControls(setup, steps, ctx.trees);
  const fixtures = assertedFixtures(steps, ctx.fixtures ?? []);
  if (needs.length === 0 && fixtures.length === 0) return EMPTY;

  const groundedControls: string[] = [];
  const declaredLines: string[] = [];
  const existingFixtures: string[] = [];
  const unavailableFixtures: { fact: string; reason: string }[] = [];
  const notes: string[] = [];
  const unanswered: string[] = [];
  const answered = new Map<string, StepEvidence>();

  for (const need of needs) {
    const key = fold(need.name);
    let found = answered.get(key) ?? null;
    if (found === null && !unanswered.includes(need.name)) {
      found = fromRepository(need.name, ctx);
      if (found === null) {
        unanswered.push(need.name);
        continue;
      }
      answered.set(key, found);
      if (found.exact) groundedControls.push(need.name);
      declaredLines.push(`  ${found.detail}`);
      notes.push(`${JSON.stringify(need.name)}: ${found.detail}`);
      ctx.onLog?.(`  evidence for ${JSON.stringify(need.name)} — ${found.detail}`);
    }
    if (found === null) continue;
    const list = need.section === 'setup' ? setup : steps;
    const step = list[need.index];
    if (step !== undefined) annotate(step, found);
  }

  let lookups = 0;
  for (const fixture of fixtures) {
    if (lookups >= MAX_DB_LOOKUPS) break;
    if (ctx.db === undefined || ctx.model === null || ctx.model === undefined) break;
    lookups += 1;
    try {
      const found = await fromDatabase(fixture, ctx);
      if (found === null) continue;
      existingFixtures.push(fixture);
      notes.push(`${fixture}: ${found.detail}`);
      ctx.onLog?.(`  evidence for ${fixture} — ${found.detail}`);
    } catch (error) {
      const reason = error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error);
      unavailableFixtures.push({ fact: fixture, reason });
      ctx.onLog?.(`  evidence for ${fixture}: the database did not answer — ${reason}`);
    }
  }

  return { groundedControls, declaredLines, existingFixtures, unavailableFixtures, notes, unanswered };
}

/** The flow's note for what the lookup found — the reader's one line about evidence that came from outside the trees. */
export function describeStepEvidence(outcome: StepEvidenceOutcome): string | null {
  if (outcome.notes.length === 0) return null;
  return `${outcome.notes.length} step claim(s) grounded outside the captured trees: ${outcome.notes.join('; ')}`;
}
