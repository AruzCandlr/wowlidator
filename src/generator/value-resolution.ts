/**
 * Value resolution at authoring time (asked for 2026-09-02).
 *
 * A sheet leaves some inputs as TOKENS — `<NON_EXISTING_EMPLOYEE_ID>`,
 * `<VALID_EMPLOYEE_ID>`, `<HR_ADMIN_ACCOUNT>` — or as a description — "Replaced
 * Employee ID ของพนักงานที่มีอยู่จริง". Live (ec10_2 HIR-EC-012) the author
 * typed the token itself into the field; the page URL-encoded it, the API
 * rejected malformed input, and the step "proved" a rejection the case never
 * asked about. Refusing the row instead (`typesPlaceholderToken`) is honest and
 * useless: the tester still has no run.
 *
 * So a token is RESOLVED, from the cheapest source that can answer, and the
 * step says which one did:
 *
 * 1. **test-data** — the case's own text names a concrete value for the same
 *    field (`Replaced Employee ID = 20001234`). $0.
 * 2. **repo** — the context documents and the repository's prompt slice are
 *    retrieved against the field and token words, and the agent role is asked
 *    ONE structured question over those passages. Accepted only when the value
 *    appears verbatim in a passage — the model's word is never the evidence.
 * 3. **db** — read-only, only when a connection is configured: the agent role
 *    names `{table, column, where}` in `dbCount`'s own shape, every identifier
 *    is checked against the introspected schema, one `SELECT … LIMIT 1` runs,
 *    the value passes through redaction. A NON_EXISTING token is proved
 *    non-existent instead: a well-formed candidate from the case's stated
 *    format, `count(*) = 0`, up to five tries.
 * 4. **generated** — the generator role invents a well-formed value from the
 *    case's stated format (or a deterministic one when no model answers), and
 *    the step is FLAGGED: `valueSource.kind = 'generated'`, the intent says so,
 *    every report shows it. A generated value is a stand-in the reader must
 *    know about, never evidence.
 *
 * Never fatal: a source that throws is a source that did not answer, and the
 * stage as a whole leaves a step untouched when nothing answered — the lint
 * then refuses it, as before.
 */

import { z } from 'zod';

import type { ExtractedDocument } from '../catalog/extract.js';
import { selectRelevantContext } from '../catalog/retrieve.js';
import type { DbClient, DbSchema } from '../db/client.js';
import { quoteIdent } from '../db/db-actions.js';
import { redactValue } from '../db/redact-row.js';
import type { FlowStep } from '../engine/runner.js';
import { lenientObject } from '../providers/model-output.js';
import { generateStructuredForModel, type ModelSource } from '../providers/llm-factory.js';

/** The sheet's angle-bracket placeholder: `<NON_EXISTING_EMPLOYEE_ID>`. */
export const PLACEHOLDER_TOKEN = /<[A-Z][A-Z0-9_\- ]{2,}>/;
/** A token (or an intent) that asks for something that must NOT exist. */
const NON_EXISTING = /NON[_\- ]?EXIST|NOT[_\- ]?EXIST|INVALID|UNKNOWN|NOT[_\- ]?FOUND|ไม่มีอยู่จริง|ไม่ถูกต้อง/i;
/** A description standing where a value should be: "an existing …", "ของ…ที่มีอยู่จริง". */
const DESCRIBED_VALUE = /ที่มีอยู่จริง|มีอยู่แล้ว|existing|any valid|a valid|ของพนักงาน/i;
/** Columns whose values are never handed out as test input, whatever the redaction rule says. */
const SENSITIVE_COLUMN = /pass(word|wd)?|secret|token|hash|salt|\bssn\b|national_?id|citizen|passport|card_?(no|number)|cvv|pin\b/i;
/** The open-question marker — asserted never, typed never; not this module's business. */
const OPEN_QUESTION = /\b(?:OQ|CF)-[A-Za-z]+-\d+\b/;

export type ValueSourceKind = 'test-data' | 'repo' | 'db' | 'generated';

/** Where a step's value came from, carried on the step into every report. */
export interface ValueSource {
  kind: ValueSourceKind;
  /** One line a reader can check: the sheet line, the passage, the query, or the format generated from. */
  detail: string;
}

export type ValueSection = 'setup' | 'steps';

/** One input step whose value is not yet a value. */
export interface ValueNeed {
  section: ValueSection;
  index: number;
  /** The field's label as the selector or intent names it (`Replaced Employee ID`). */
  field: string;
  /** The token as written, or null when the value was a description / empty. */
  token: string | null;
  /** The case wants something that does NOT exist (an invalid id to be rejected). */
  nonExisting: boolean;
  /** The format the case states for this field, when it does. */
  format: ValueFormat | null;
}

/** What the case says a well-formed value looks like. */
export interface ValueFormat {
  digits?: number | undefined;
  leading?: string | undefined;
  /** A literal pattern the case quotes, e.g. `N-NNNN-NNNNN-NN-N`. */
  mask?: string | undefined;
}

export interface ResolvedValue {
  need: ValueNeed;
  value: string;
  source: ValueSource;
}

/** The three questions the resolver may ask a model — one small structured call each. */
export interface ValueResolverModel {
  readonly id: string;
  /** Which concrete value in these passages satisfies the need? `value: null` when none does. */
  fromPassages(q: { field: string; token: string | null; caseText: string; passages: readonly string[] }): Promise<{ value: string | null; evidence: string }>;
  /** Which table/column holds such a value, and how to narrow it? `null` when the schema offers nothing. */
  chooseDbLookup(q: { field: string; token: string | null; caseText: string; schema: string }): Promise<{ table: string; column: string; where: Record<string, string> } | null>;
  /** Invent a well-formed value. */
  generate(q: { field: string; token: string | null; caseText: string; format: ValueFormat | null }): Promise<{ value: string }>;
}

export interface ValueResolutionContext {
  /** The case's own words (`describeCase`); the test-data source and the format reader work on this. */
  caseText: string;
  /** The context documents the author saw, for retrieval. Optional; the prompt text stands in. */
  documents?: readonly ExtractedDocument[] | undefined;
  /** The repository's prompt slice — routes, components, tables, declared strings. */
  projectContext?: string | undefined;
  /** The whole authoring prompt, when the documents are not available as objects. */
  promptText?: string | undefined;
  /** Read-only client, resolved lazily so a run that needs no value never connects. */
  db?: (() => Promise<DbClient | null>) | undefined;
  model: ValueResolverModel | null;
  /** Per-call budget for the retrieval passages handed to the model. */
  passageBudgetChars?: number | undefined;
  onLog?: ((line: string) => void) | undefined;
}

// --- finding what needs a value ---------------------------------------------

const INPUT_ACTIONS = new Set(['fill', 'fillRetry', 'type', 'selectOption']);

/** The field's label: the role selector's name, else the intent's first Title-Case run, else the selector. */
export function fieldLabelOf(step: FlowStep): string {
  const selector = (step as { selector?: unknown }).selector;
  if (typeof selector === 'string') {
    const m = /\[name=(?:"([^"]+)"|'([^']+)')/.exec(selector);
    if (m) return (m[1] ?? m[2] ?? '').trim();
  }
  const intent = (step as { intent?: unknown }).intent;
  if (typeof intent === 'string') {
    const m = /\b([A-Z][A-Za-z]+(?:(?:\s+(?:of|the|and|&|\/)\s*|\s+)[A-Z][A-Za-z]*)*)\b/.exec(intent.replace(/^(?:Step|Case step)\s*\d+:\s*/i, ''));
    if (m) return m[1]!.trim();
  }
  return typeof selector === 'string' ? selector : 'value';
}

/**
 * The format the case states for a field: `8 หลัก` / `8 digits`, `หลักแรกเป็น 2` /
 * `starts with 2`, or a quoted mask like `N-NNNN-NNNNN-NN-N`. Looked for near
 * the field's words first, then anywhere in the case.
 */
export function formatStatedFor(field: string, caseText: string): ValueFormat | null {
  const read = (text: string): ValueFormat | null => {
    const digits = /(\d{1,3})\s*(?:หลัก|-?\s*digits?\b)/i.exec(text);
    const leading = /(?:หลักแรก(?:เป็น|คือ)?|starts? with|first digit(?: is)?|leading digit(?: is)?)\s*(\d)/i.exec(text);
    const mask = /\b([NX](?:[NX\-]){4,})\b/.exec(text);
    if (!digits && !leading && !mask) return null;
    return {
      ...(digits ? { digits: Number(digits[1]) } : {}),
      ...(leading ? { leading: leading[1] } : {}),
      ...(mask ? { mask: mask[1] } : {}),
    };
  };
  const words = field.split(/\s+/).filter((w) => w.length > 2).map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''));
  for (const line of caseText.split('\n')) {
    if (words.some((w) => w !== '' && line.toLowerCase().includes(w.toLowerCase()))) {
      const near = read(line);
      if (near !== null) return near;
    }
  }
  return read(caseText);
}

/** Every input step whose value is a token, or a description in place of a value. */
export function findUnresolvedValues(setup: readonly FlowStep[], steps: readonly FlowStep[], caseText: string): ValueNeed[] {
  const needs: ValueNeed[] = [];
  const scan = (section: ValueSection, list: readonly FlowStep[]): void => {
    for (const [index, step] of list.entries()) {
      if (!INPUT_ACTIONS.has(step.action)) continue;
      const value = (step as { value?: unknown }).value;
      const intent = (step as { intent?: unknown }).intent;
      const text = typeof value === 'string' ? value : '';
      if (OPEN_QUESTION.test(text)) continue;
      const token = PLACEHOLDER_TOKEN.exec(text)?.[0] ?? null;
      const described = token === null && (text === '' || DESCRIBED_VALUE.test(text));
      if (token === null && !described) continue;
      // An empty value is only a need when something SAYS a value belongs here.
      if (token === null && text === '' && !(typeof intent === 'string' && DESCRIBED_VALUE.test(intent))) continue;
      const field = fieldLabelOf(step);
      const around = `${token ?? ''} ${text} ${typeof intent === 'string' ? intent : ''}`;
      needs.push({
        section,
        index,
        field,
        token,
        nonExisting: NON_EXISTING.test(around),
        format: formatStatedFor(field, caseText),
      });
    }
  };
  scan('setup', setup);
  scan('steps', steps);
  return needs;
}

/** The case's lines that mention the field. */
function linesAbout(field: string, caseText: string): string {
  const words = field.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  return caseText
    .split('\n')
    .filter((line) => words.some((w) => line.toLowerCase().includes(w)))
    .join('\n');
}

// --- the sources ----------------------------------------------------------------

/** `Field = value` on a line of the case, when the value is concrete. */
export function fromTestData(need: ValueNeed, caseText: string): ResolvedValue | null {
  const label = need.field.toLowerCase();
  for (const raw of caseText.split('\n')) {
    const line = raw.trim().replace(/^[-•*]\s*/, '');
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const rhs = line.slice(eq + 1).trim();
    // The key must be the field (or the field qualified: "Invalid Replaced Employee ID").
    if (key !== label && !key.endsWith(` ${label}`) && !label.endsWith(` ${key}`)) continue;
    // A non-existing need must not take the VALID id's line and vice versa.
    const keyWantsMissing = NON_EXISTING.test(key);
    if (keyWantsMissing !== need.nonExisting) continue;
    if (rhs === '' || PLACEHOLDER_TOKEN.test(rhs) || OPEN_QUESTION.test(rhs) || /^\?/.test(rhs) || DESCRIBED_VALUE.test(rhs)) continue;
    const value = rhs.split(/\s{2,}|\s+\(/)[0]!.trim();
    if (value === '') continue;
    return { need, value, source: { kind: 'test-data', detail: `the case states "${line.slice(0, 100)}"` } };
  }
  return null;
}

/** Passages worth asking about: documents ranked by retrieval, else the prompt's own paragraphs ranked by overlap. */
function passagesFor(need: ValueNeed, ctx: ValueResolutionContext): string[] {
  const query = [need.field, need.token ?? '', linesAbout(need.field, ctx.caseText).slice(0, 400)].join('\n');
  const budget = ctx.passageBudgetChars ?? 12_000;
  if (ctx.documents !== undefined && ctx.documents.length > 0) {
    const selected = selectRelevantContext(ctx.documents, query, { budgetChars: budget });
    return selected.documents.map((d) => d.text).filter((t) => t.trim() !== '');
  }
  const pool = `${ctx.projectContext ?? ''}\n\n${ctx.promptText ?? ''}`;
  const terms = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 2);
  const scored = pool
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .map((p) => ({ p, score: terms.reduce((n, t) => n + (p.toLowerCase().includes(t) ? 1 : 0), 0) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  const out: string[] = [];
  let used = 0;
  for (const { p } of scored) {
    if (used + p.length > budget) break;
    out.push(p);
    used += p.length;
  }
  return out;
}

/** A value the documents or the repository state, grounded: the answer must appear verbatim in a passage. */
export async function fromRepo(need: ValueNeed, ctx: ValueResolutionContext): Promise<ResolvedValue | null> {
  if (ctx.model === null || need.nonExisting) return null;
  const passages = passagesFor(need, ctx);
  if (passages.length === 0) return null;
  const answer = await ctx.model.fromPassages({ field: need.field, token: need.token, caseText: ctx.caseText.slice(0, 3000), passages });
  if (answer.value === null || answer.value.trim() === '') return null;
  const value = answer.value.trim();
  const grounded = passages.some((p) => p.includes(value));
  if (!grounded) {
    ctx.onLog?.(`  value for ${need.field}: the model offered ${JSON.stringify(value)} but no passage contains it — not accepted`);
    return null;
  }
  return { need, value, source: { kind: 'repo', detail: `from the documents/repository: ${answer.evidence.slice(0, 120) || value}` } };
}

/** `schema.table` or `table` → the introspected table, case-insensitively. */
function tableIn(schema: DbSchema, name: string): DbSchema['tables'][number] | null {
  const want = name.trim().toLowerCase();
  return (
    schema.tables.find((t) => t.name.toLowerCase() === want) ??
    schema.tables.find((t) => t.name.toLowerCase().endsWith(`.${want}`)) ??
    null
  );
}

function qualifiedIdent(table: string): string {
  return table.split('.').map(quoteIdent).join('.');
}

function schemaSummary(schema: DbSchema): string {
  return schema.tables
    .slice(0, 80)
    .map((t) => `${t.name}(${t.columns.map((c) => c.name).slice(0, 30).join(', ')})`)
    .join('\n');
}

/** A well-formed candidate from the stated format — deterministic, so a retry can step it. */
export function candidateFor(format: ValueFormat | null, attempt = 0): string {
  const digits = format?.digits ?? 8;
  const leading = format?.leading ?? '9';
  if (format?.mask) {
    let n = 0;
    return format.mask.replace(/[NX]/g, () => String((9 - ((n++ + attempt) % 10) + 10) % 10));
  }
  const body = String(9_999_999_999_999).slice(0, Math.max(1, digits - leading.length));
  const stepped = (BigInt(body) - BigInt(attempt)).toString().padStart(Math.max(1, digits - leading.length), '0');
  return `${leading}${stepped}`.slice(0, digits);
}

/** A real value from the database, or the proof that a candidate does not exist there. */
export async function fromDb(need: ValueNeed, ctx: ValueResolutionContext): Promise<ResolvedValue | null> {
  if (ctx.model === null || ctx.db === undefined) return null;
  const client = await ctx.db();
  if (client === null) return null;
  const schema = await client.introspect();
  const choice = await ctx.model.chooseDbLookup({ field: need.field, token: need.token, caseText: ctx.caseText.slice(0, 3000), schema: schemaSummary(schema) });
  if (choice === null) return null;
  const table = tableIn(schema, choice.table);
  if (table === null) throw new Error(`the model named table "${choice.table}", which the schema does not declare`);
  const columns = new Set(table.columns.map((c) => c.name.toLowerCase()));
  const column = table.columns.find((c) => c.name.toLowerCase() === choice.column.trim().toLowerCase());
  if (column === undefined) throw new Error(`the model named column "${choice.column}" on ${table.name}, which the schema does not declare`);
  for (const key of Object.keys(choice.where)) {
    if (!columns.has(key.trim().toLowerCase())) throw new Error(`the model filtered on "${key}", which ${table.name} does not have`);
  }
  const whereKeys = Object.keys(choice.where);
  const params = whereKeys.map((k) => choice.where[k]);
  const where = whereKeys.length === 0 ? '' : ` WHERE ${whereKeys.map((k, i) => `${quoteIdent(k)} = $${i + 1}`).join(' AND ')}`;
  const from = qualifiedIdent(table.name);

  if (need.nonExisting) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = candidateFor(need.format, attempt);
      const result = await client.query(`SELECT count(*) AS n FROM ${from} WHERE ${quoteIdent(column.name)} = $1`, [candidate]);
      const n = Number((result.rows[0] as { n?: unknown } | undefined)?.n ?? 0);
      if (n === 0) {
        return {
          need,
          value: candidate,
          source: { kind: 'db', detail: `${table.name}.${column.name} holds no row with this value (count = 0), so it does not exist` },
        };
      }
    }
    return null;
  }

  const result = await client.query(`SELECT ${quoteIdent(column.name)} AS v FROM ${from}${where} ORDER BY 1 DESC LIMIT 1`, params);
  const row = result.rows[0] as { v?: unknown } | undefined;
  if (row === undefined || row.v === null || row.v === undefined) return null;
  // A sensitive column never becomes a typed value, whatever the model asked
  // for: the redaction rule the reports use, plus the names that rule is too
  // narrow for (`password_hash`, `salt`, `token`, an id document number).
  const shown = redactValue(column.name, row.v);
  if (/redact/i.test(shown) || SENSITIVE_COLUMN.test(column.name)) {
    ctx.onLog?.(`  value for ${need.field}: ${table.name}.${column.name} is a sensitive column — not used`);
    return null;
  }
  return {
    need,
    value: String(row.v),
    source: {
      kind: 'db',
      detail: `${table.name}.${column.name}${whereKeys.length ? ` where ${whereKeys.map((k) => `${k}=${choice.where[k]}`).join(', ')}` : ''}`,
    },
  };
}

/** The last resort: a well-formed stand-in, flagged. */
export async function generated(need: ValueNeed, ctx: ValueResolutionContext): Promise<ResolvedValue> {
  const formatNote = need.format
    ? `the case's stated format (${[need.format.digits ? `${need.format.digits} digits` : '', need.format.leading ? `leading ${need.format.leading}` : '', need.format.mask ?? ''].filter(Boolean).join(', ')})`
    : 'no stated format';
  let value = '';
  if (ctx.model !== null) {
    try {
      value = (await ctx.model.generate({ field: need.field, token: need.token, caseText: ctx.caseText.slice(0, 3000), format: need.format })).value.trim();
    } catch {
      value = '';
    }
  }
  if (value === '' || PLACEHOLDER_TOKEN.test(value) || (need.format?.digits !== undefined && !new RegExp(`^\\d{${need.format.digits}}$`).test(value))) {
    value = candidateFor(need.format);
  }
  return {
    need,
    value,
    source: {
      kind: 'generated',
      detail: `GENERATED by the author from ${formatNote} — no test data, document, repository or database source named one`,
    },
  };
}

// --- the stage ------------------------------------------------------------------

export interface ValueResolutionOutcome {
  setup: FlowStep[];
  steps: FlowStep[];
  resolved: ResolvedValue[];
}

/**
 * Resolve every need, cheapest source first, and write the answer onto the
 * step: its `value`, a suffix on its `intent`, and `valueSource`.
 */
export async function resolveValues(
  setup: readonly FlowStep[],
  steps: readonly FlowStep[],
  ctx: ValueResolutionContext,
): Promise<ValueResolutionOutcome> {
  const nextSetup = setup.map((s) => ({ ...s })) as FlowStep[];
  const nextSteps = steps.map((s) => ({ ...s })) as FlowStep[];
  const resolved: ResolvedValue[] = [];
  for (const need of findUnresolvedValues(nextSetup, nextSteps, ctx.caseText)) {
    let answer: ResolvedValue | null = null;
    const tried: string[] = [];
    for (const [name, source] of [
      ['test-data', async (): Promise<ResolvedValue | null> => fromTestData(need, ctx.caseText)],
      ['repo', async (): Promise<ResolvedValue | null> => fromRepo(need, ctx)],
      ['db', async (): Promise<ResolvedValue | null> => fromDb(need, ctx)],
    ] as const) {
      try {
        answer = await source();
      } catch (error) {
        tried.push(`${name}: ${error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error)}`);
        answer = null;
      }
      if (answer !== null) break;
    }
    if (answer === null) answer = await generated(need, ctx);
    for (const line of tried) ctx.onLog?.(`  value for ${need.field}: ${line}`);
    const list = need.section === 'setup' ? nextSetup : nextSteps;
    const step = list[need.index] as FlowStep & { value?: string; intent?: string | undefined; valueSource?: ValueSource | undefined };
    step.value = answer.value;
    step.valueSource = answer.source;
    const suffix =
      answer.source.kind === 'generated'
        ? ` — value GENERATED by the author: ${answer.source.detail}`
        : ` — value from ${answer.source.kind}: ${answer.source.detail}`;
    step.intent = `${step.intent ?? `${step.action} ${need.field}`}${suffix}`;
    ctx.onLog?.(
      `  ${need.field} ← ${answer.source.kind}${answer.source.kind === 'generated' ? '' : ` (${answer.value})`}` +
        (answer.source.kind === 'generated' ? ` ${answer.value} — flagged` : ''),
    );
    resolved.push(answer);
  }
  return { setup: nextSetup, steps: nextSteps, resolved };
}

// --- the model ------------------------------------------------------------------

const RULES = `Answer from the evidence given and nothing else. A value you cannot point at in the passages is null. Never invent an id, a name or a code when asked what the evidence says; inventing is a separate question you will be asked explicitly.`;

/** The three questions, each one small structured call on the agent role. */
export class LlmValueResolverModel implements ValueResolverModel {
  readonly id: string;
  readonly #source: ModelSource;

  constructor(options: { factory: import('../providers/llm-factory.js').LlmFactory; role?: 'agent' | 'generator' | undefined } | { model: import('ai').LanguageModel; id?: string | undefined }) {
    if ('factory' in options) {
      this.#source = { factory: options.factory, role: options.role ?? 'agent' };
      this.id = `value-resolver:${options.role ?? 'agent'}`;
    } else {
      this.#source = { model: options.model };
      this.id = options.id ?? 'value-resolver:model';
    }
  }

  async fromPassages(q: { field: string; token: string | null; caseText: string; passages: readonly string[] }): Promise<{ value: string | null; evidence: string }> {
    const { object } = await generateStructuredForModel(this.#source, {
      modelLabel: this.id,
      schema: lenientObject({ value: z.string().nullable(), evidence: z.string() }),
      system: `You find concrete values in evidence.\n${RULES}`,
      prompt:
        `FIELD: ${q.field}\nTOKEN: ${q.token ?? '(a described value)'}\nCASE:\n${q.caseText}\n\nPASSAGES:\n` +
        q.passages.map((p, i) => `--- passage ${i + 1} ---\n${p}`).join('\n') +
        `\n\nWhich concrete value in the passages satisfies the field? Reply {"value": "<verbatim from a passage>", "evidence": "<the passage line>"} or {"value": null, "evidence": ""}.`,
      maxOutputTokens: 300,
    });
    return { value: object.value, evidence: object.evidence ?? '' };
  }

  async chooseDbLookup(q: { field: string; token: string | null; caseText: string; schema: string }): Promise<{ table: string; column: string; where: Record<string, string> } | null> {
    const { object } = await generateStructuredForModel(this.#source, {
      modelLabel: this.id,
      schema: lenientObject({
        table: z.string().nullable(),
        column: z.string().nullable(),
        where: z.string().describe('column=value pairs joined by commas, or empty'),
      }),
      system: `You choose a read-only database lookup.\n${RULES} Name only a table and columns that appear in the schema list.`,
      prompt:
        `FIELD: ${q.field}\nTOKEN: ${q.token ?? '(a described value)'}\nCASE:\n${q.caseText}\n\nSCHEMA (table(columns)):\n${q.schema}\n\n` +
        `Which table and column hold a real value for this field, and which column=value filter narrows to a usable row (e.g. status=active)? Reply {"table":..., "column":..., "where": "col=value, col2=value"} or {"table": null, "column": null, "where": ""}.`,
      maxOutputTokens: 200,
    });
    if (!object.table || !object.column) return null;
    const where: Record<string, string> = {};
    for (const pair of (object.where ?? '').split(',')) {
      const t = pair.trim();
      if (t === '') continue;
      const eq = t.indexOf('=');
      if (eq <= 0) continue;
      where[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
    }
    return { table: object.table, column: object.column, where };
  }

  async generate(q: { field: string; token: string | null; caseText: string; format: ValueFormat | null }): Promise<{ value: string }> {
    const { object } = await generateStructuredForModel(this.#source, {
      modelLabel: this.id,
      schema: lenientObject({ value: z.string() }),
      system: 'You invent ONE well-formed test value for a form field. Match the stated format exactly; make it obviously synthetic; output only the value.',
      prompt:
        `FIELD: ${q.field}\nTOKEN: ${q.token ?? '(a described value)'}\nFORMAT: ${q.format ? JSON.stringify(q.format) : 'not stated — infer from the case'}\nCASE:\n${q.caseText}\n\nReply {"value": "<the value>"}.`,
      maxOutputTokens: 60,
    });
    return { value: object.value };
  }
}
