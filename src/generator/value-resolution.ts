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
 * 0. **relative-date** — the sheet writes dates the way a tester thinks about
 *    them: `Hire Date = Today`, `Effective Start Date = Next day`, `Date of
 *    Birth = Age < 60`, `Period End Date = Hire Date + 119 Day`, `วันที่ 25
 *    ของเดือนปัจจุบัน`, `31 Dec 9999` (278 rows of the HR workbook, 2026-09-03).
 *    `fromRelativeDate` computes the ISO date from an injected `now`, $0 and
 *    deterministic, and a later field may lean on an earlier one by label.
 *    Then, before anything else, **unique-per-run**: a key value that IS the
 *    case id (`Benefit Plan ID = PL_06_21`) or a `QA-`/`SIT_` name gets the
 *    run's suffix, because on any rerun the app says "already exists" and the
 *    create case fails for a reason it never asked about (49 rows).
 * 1. **test-data** — the case's own text names a concrete value for the same
 *    field (`Replaced Employee ID = 20001234`). $0. Packed lines
 *    (`Position = 40106337 Job Code = MKB12.12`) and phase headers
 *    (`--Insert R1--`) are read pair by pair.
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
import { uniquePerRun } from '../data/mock-data.js';
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

/** The wording that says a key value must ALREADY be in the system — a duplicate case, never a create. */
const ALREADY_EXISTS = /มีอยู่แล้ว|มีในระบบ|ที่มีอยู่|ซ้ำกับ|already exists?|duplicate|existing/i;
/** A field whose value is a key the app keeps unique: an id, a code, a name. Thai has no `\b`. */
const KEY_FIELD = /\b(?:ID|Code|Name|Key|No\.?)\b|รหัส|ชื่อ/i;
/** The sheet's own QA-owned key prefixes. */
const QA_KEY = /^(?:QA-|SIT_)/i;

export type ValueSourceKind = 'relative-date' | 'unique-per-run' | 'test-data' | 'repo' | 'db' | 'generated';

/** One `Field = value` pair of the case's Test data, with the phase header it sat under (`--Insert R1--`). */
export interface TestDataPair {
  phase: string | null;
  key: string;
  value: string;
}

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
  /**
   * The value as written is a DATE PHRASE (`Today`, `Hire Date + 119 Day`,
   * `Age < 60`), left in place for the resolver. Only `fromRelativeDate` may
   * answer such a need; when it cannot, the step is left as authored.
   */
  phrase?: string | undefined;
  /**
   * The value as written is a key that IS the case id or a `QA-`/`SIT_` name.
   * Only `fromUniquePerRun` may rewrite it; when the case says the value must
   * already exist, the step is left as authored.
   */
  uniqueKey?: string | undefined;
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
  /**
   * What "today" is, for the relative-date source. Injected so a run is
   * reproducible from its record; the stage takes the wall clock only when
   * nothing is passed.
   */
  now?: Date | undefined;
  /** The catalog run's key; its last six alphanumerics make a key value unique to this run. */
  runKey?: string | undefined;
  /** The row's own case id (`PL_06_21`) — a value equal to it is a key the sheet reused. */
  caseId?: string | undefined;
  /** The Test data already split into pairs (`testDataPairs` in `catalog/test-case-table.ts`); the case text is split here when absent. */
  testDataPairs?: readonly TestDataPair[] | undefined;
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
    const body = intent.replace(/^(?:Step|Case step)\s*\d+:\s*/i, '');
    const m = /\b([A-Z][A-Za-z]+(?:(?:\s+(?:of|the|and|&|\/)\s*|\s+)[A-Z][A-Za-z]*)*)\b/.exec(body);
    if (m) return m[1]!.trim();
    // A Thai label after the sheet's own verb — `กรอก ชื่อแผน = X`, `เลือก
    // ประเภทสวัสดิการ เป็น Y`. Title-Case has nothing to find here, and a
    // Test data key spelled in Thai (BE Rule rows) never matched (CG-02).
    // `\p{M}` because Thai vowels and tone marks are combining marks, not letters.
    const th = /(?:กรอก|ระบุ|เลือก|ใส่|คีย์|กำหนด|พิมพ์)\s*(?:ช่อง|ฟิลด์|field|ค่า)?\s*([\p{L}\p{N}][\p{L}\p{M}\p{N} /().'*-]{1,40}?)\s*(?:=|:|เป็น|ด้วย|$)/u.exec(body);
    if (th) return th[1]!.trim();
  }
  return typeof selector === 'string' ? selector : 'value';
}

/** A label or a Test data key, normalised for matching: no `*`, no parenthetical, no trailing colon, one space. */
function normalLabel(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/\*/g, '')
    .replace(/:$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The key names the field, or the field qualified (`Invalid Replaced Employee ID`), or the field names the key. */
function keyMatchesLabel(key: string, label: string): boolean {
  if (key === '' || label === '') return false;
  return key === label || key.endsWith(` ${label}`) || label.endsWith(` ${key}`);
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

/** What `findUnresolvedValues` needs beyond the steps to see the two concrete-value needs. */
export interface NeedOptions {
  /** The row's case id: a typed value equal to it (any `-`/`_` spelling, or with the sheet's `_R1` tail) is a reused key. */
  caseId?: string | undefined;
}

/** `PL_06_21`, `PL-06-21`, `pl_06_21_R3` → `PL_06_21` — the sheet's own spellings of one case id. */
function keySpelling(value: string): string {
  return value.trim().toUpperCase().replace(/[-_\s]+/g, '_');
}

/**
 * A typed value that IS the case id (`Benefit Plan ID = PL_06_21`, the sheet's
 * `PL_06_21_R3` rerun spelling) or a QA-owned name (`QA-Insert`, `SIT_CNS_01`),
 * on a field the app keeps unique. Only such a value is made unique per run —
 * a value the tester chose for its meaning (`TH_MED_001`) is left alone.
 */
export function isReusedKeyValue(value: string, field: string, caseId: string | undefined): boolean {
  const text = value.trim();
  if (text === '' || text.length > 80 || PLACEHOLDER_TOKEN.test(text)) return false;
  if (!KEY_FIELD.test(field)) return false;
  if (QA_KEY.test(text)) return true;
  if (caseId === undefined || caseId.trim() === '') return false;
  const want = keySpelling(caseId);
  const have = keySpelling(text);
  return have === want || new RegExp(`^${want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_R\\d{1,2}$`).test(have);
}

/** Every input step whose value is a token, a description in place of a value, a date phrase, or a reused key. */
export function findUnresolvedValues(
  setup: readonly FlowStep[],
  steps: readonly FlowStep[],
  caseText: string,
  options: NeedOptions = {},
): ValueNeed[] {
  const needs: ValueNeed[] = [];
  const scan = (section: ValueSection, list: readonly FlowStep[]): void => {
    for (const [index, step] of list.entries()) {
      if (!INPUT_ACTIONS.has(step.action)) continue;
      const value = (step as { value?: unknown }).value;
      const intent = (step as { intent?: unknown }).intent;
      const text = typeof value === 'string' ? value : '';
      if (OPEN_QUESTION.test(text)) continue;
      const token = PLACEHOLDER_TOKEN.exec(text)?.[0] ?? null;
      // A date phrase left as written (`Today`, `Hire Date + 119 Day`) is a
      // need of its own kind: computed, never looked up. A selectOption's
      // value is an option label, which may legitimately read "Next day".
      const field = fieldLabelOf(step);
      const phrase = token === null && step.action !== 'selectOption' && isDatePhrase(text, field) ? text.trim() : null;
      const uniqueKey = token === null && phrase === null && isReusedKeyValue(text, field, options.caseId) ? text.trim() : null;
      const described = token === null && phrase === null && uniqueKey === null && (text === '' || DESCRIBED_VALUE.test(text));
      if (token === null && phrase === null && uniqueKey === null && !described) continue;
      // An empty value is only a need when something SAYS a value belongs here.
      if (token === null && phrase === null && uniqueKey === null && text === '' && !(typeof intent === 'string' && DESCRIBED_VALUE.test(intent))) continue;
      const around = `${token ?? ''} ${text} ${typeof intent === 'string' ? intent : ''}`;
      needs.push({
        section,
        index,
        field,
        token,
        nonExisting: NON_EXISTING.test(around),
        format: formatStatedFor(field, caseText),
        ...(phrase === null ? {} : { phrase }),
        ...(uniqueKey === null ? {} : { uniqueKey }),
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

/** `--Create--`, `-- Insert R1 --`: the BE sheet's phase headers inside one Test data cell. */
const PHASE_HEADER = /^-{2,}\s*(.+?)\s*-{2,}$/;
/**
 * Where a packed line breaks into its next pair: `Position = 40106337 Job Code
 * = MKB12.12` (278 rows pack several pairs on one line). A key is up to six
 * Title-Case words (or a bracketed `[OPERATOR]`) followed by `=`; a value's
 * own `+ 1 Day` never looks like one. Found LEFTMOST after each value starts
 * — a `split` on the same lookahead breaks `Job Code` at `Code` too.
 */
const PACKED_PAIR_BREAK = /\s+(?=(?:[A-Z[][A-Za-z0-9\]/().'*-]*)(?:\s+[A-Z(][A-Za-z0-9)/().'*-]*){0,5}\s*=\s)/;

/** `Position = 40106337 Job Code = MKB12.12` → two pieces, each with one `=`. */
function splitPacked(part: string): string[] {
  const out: string[] = [];
  let rest = part;
  for (let guard = 0; guard < 40; guard += 1) {
    const eq = rest.indexOf('=');
    if (eq <= 0) break;
    const after = rest.slice(eq + 1);
    const brk = PACKED_PAIR_BREAK.exec(after);
    if (brk === null || brk.index === 0) break;
    out.push(rest.slice(0, eq + 1 + brk.index));
    rest = after.slice(brk.index + brk[0].length);
  }
  out.push(rest);
  return out;
}
/** `ดราฟต์เดิมระบุ X ใช้ Y` — the sheet correcting its own earlier draft; Y is the value. */
const DRAFT_CORRECTION = /ดราฟต์เดิมระบุ\s*(.+?)\s*ใช้\s*(\S+)/gu;

/**
 * The case's `Field = value` pairs, one per entry, as the parser
 * (`testDataPairs` in `catalog/test-case-table.ts`) will hand them — and, until
 * it does, split out of the case text here: `describeCase` folds the Test data
 * block onto one line with `; `, a sheet line packs several pairs, a phase
 * header sits between blocks, and a draft correction renames a value.
 */
export function testDataPairsOf(caseText: string): TestDataPair[] {
  const corrections: [string, string][] = [];
  for (const m of caseText.matchAll(DRAFT_CORRECTION)) corrections.push([m[1]!.trim(), m[2]!.trim()]);
  const pairs: TestDataPair[] = [];
  let phase: string | null = null;
  // A bullet is one dash; two or more open a phase header and stay.
  const unbullet = (text: string): string => text.replace(/^(?:[•*]|-(?!-))\s*/, '');
  for (const raw of caseText.split('\n')) {
    const line = unbullet(raw.trim()).replace(/^Test data:\s*/i, '');
    if (line === '') continue;
    for (const segment of line.split(/;\s+/)) {
      const part = unbullet(segment.trim());
      const header = PHASE_HEADER.exec(part);
      if (header) {
        phase = header[1]!.trim();
        continue;
      }
      for (const piece of splitPacked(part)) {
        const eq = piece.indexOf('=');
        if (eq <= 0) continue;
        const key = piece.slice(0, eq).trim();
        let value = piece.slice(eq + 1).trim();
        if (key === '') continue;
        for (const [was, now] of corrections) if (value === was || value.startsWith(`${was} `)) value = now;
        pairs.push({ phase, key, value });
      }
    }
  }
  return pairs;
}

/** The pair naming this field — first in sheet order — when its value is concrete. */
function pairFor(need: ValueNeed, pairs: readonly TestDataPair[]): TestDataPair | null {
  const label = normalLabel(need.field);
  for (const pair of pairs) {
    if (!keyMatchesLabel(normalLabel(pair.key), label)) continue;
    // A non-existing need must not take the VALID id's line and vice versa.
    if (NON_EXISTING.test(pair.key) !== need.nonExisting) continue;
    const rhs = pair.value;
    if (rhs === '' || PLACEHOLDER_TOKEN.test(rhs) || OPEN_QUESTION.test(rhs) || /^\?/.test(rhs) || DESCRIBED_VALUE.test(rhs)) continue;
    return pair;
  }
  return null;
}

/** `Field = value` on a line of the case, when the value is concrete. */
export function fromTestData(need: ValueNeed, caseText: string, pairs?: readonly TestDataPair[]): ResolvedValue | null {
  const pair = pairFor(need, pairs ?? testDataPairsOf(caseText));
  if (pair === null) return null;
  const value = pair.value.split(/\s{2,}|\s+\(/)[0]!.trim();
  if (value === '') return null;
  const stated = `${pair.phase === null ? '' : `[${pair.phase}] `}${pair.key} = ${pair.value}`;
  return { need, value, source: { kind: 'test-data', detail: `the case states "${stated.slice(0, 100)}"` } };
}

// --- relative dates -----------------------------------------------------------------

/**
 * A year-month-day with no clock and no zone: the sheet's "today" is the
 * tester's calendar day, and the machine the run is on is that tester's.
 */
interface Ymd {
  y: number;
  m: number;
  d: number;
}

const ymdOf = (now: Date): Ymd => ({ y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() });
const daysInMonth = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();
function addDays(date: Ymd, n: number): Ymd {
  const t = new Date(Date.UTC(date.y, date.m - 1, date.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}
/** Month arithmetic keeps the day and clamps it to the month's end: 31 Jan + 1 month = 28/29 Feb. */
function addMonths(date: Ymd, n: number): Ymd {
  const total = date.y * 12 + (date.m - 1) + n;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  return { y, m, d: Math.min(date.d, daysInMonth(y, m)) };
}
const isoOf = (date: Ymd): string => `${String(date.y).padStart(4, '0')}-${String(date.m).padStart(2, '0')}-${String(date.d).padStart(2, '0')}`;
const ISO_DATE_VALUE = /^(\d{4})-(\d{2})-(\d{2})$/;

const EN_MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
/** Full and abbreviated Thai month names, as the sheet writes them (`25 ธ.ค. 2569`, `25 ธันวาคม 2569`). */
const TH_MONTHS: [RegExp, number][] = [
  [/^ม\.?ค\.?$|^มกราคม$/u, 1],
  [/^ก\.?พ\.?$|^กุมภาพันธ์$/u, 2],
  [/^มี\.?ค\.?$|^มีนาคม$/u, 3],
  [/^เม\.?ย\.?$|^เมษายน$/u, 4],
  [/^พ\.?ค\.?$|^พฤษภาคม$/u, 5],
  [/^มิ\.?ย\.?$|^มิถุนายน$/u, 6],
  [/^ก\.?ค\.?$|^กรกฎาคม$/u, 7],
  [/^ส\.?ค\.?$|^สิงหาคม$/u, 8],
  [/^ก\.?ย\.?$|^กันยายน$/u, 9],
  [/^ต\.?ค\.?$|^ตุลาคม$/u, 10],
  [/^พ\.?ย\.?$|^พฤศจิกายน$/u, 11],
  [/^ธ\.?ค\.?$|^ธันวาคม$/u, 12],
];

/** A Buddhist-era year (2569 = 2026) is any year the sheet could mean that way: 2400–2700, or two digits ≥ 40. */
function gregorianYear(raw: string, thai: boolean): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (raw.length === 2) return thai ? (n >= 40 ? 2500 + n - 543 : 2000 + n) : 2000 + n;
  if (n >= 2400 && n <= 2700) return n - 543;
  return n;
}

/**
 * A date written out — `31 Dec 9999`, `Dec 31, 9999`, `25 ธันวาคม 2569`,
 * `25 ธ.ค. 69`, `2026-09-03` — as Y-M-D, or null when it is not unambiguously
 * one. `01/09/2027` is left alone on purpose: whether that is January or
 * September depends on who wrote it (the engine's own rule, `isoDateOf`), with
 * the single exception of the sheet's `31/12/9999` sentinel, which reads the
 * same either way round.
 */
export function absoluteDateOf(text: string): Ymd | null {
  const t = text.trim();
  const iso = ISO_DATE_VALUE.exec(t);
  if (iso) return { y: Number(iso[1]), m: Number(iso[2]), d: Number(iso[3]) };
  if (/^(?:31\/12\/9999|12\/31\/9999|9999-12-31)$/.test(t)) return { y: 9999, m: 12, d: 31 };
  const dmy = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(t);
  const mdy = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(t);
  const en = dmy ? { d: dmy[1]!, mon: dmy[2]!, y: dmy[3]! } : mdy ? { d: mdy[2]!, mon: mdy[1]!, y: mdy[3]! } : null;
  if (en) {
    const m = EN_MONTHS[en.mon.slice(0, 4).toLowerCase()] ?? EN_MONTHS[en.mon.slice(0, 3).toLowerCase()];
    const y = gregorianYear(en.y, false);
    if (m === undefined || y === null) return null;
    const d = Number(en.d);
    return d >= 1 && d <= daysInMonth(y, m) ? { y, m, d } : null;
  }
  const th = /^(\d{1,2})\s*([\p{Script=Thai}.]{2,12})\s*(?:พ\.?ศ\.?\s*)?(\d{2}|\d{4})$/u.exec(t);
  if (th) {
    const m = TH_MONTHS.find(([re]) => re.test(th[2]!))?.[1];
    const y = gregorianYear(th[3]!, true);
    if (m === undefined || y === null) return null;
    const d = Number(th[1]);
    return d >= 1 && d <= daysInMonth(y, m) ? { y, m, d } : null;
  }
  return null;
}

/** The shapes a date phrase takes — the gate for treating a typed value as one. */
const DATE_PHRASE_SHAPES: RegExp[] = [
  /^(?:today|tomorrow|yesterday|next\s?day|now|current date|the current date)\b/i,
  /วันนี้|วันถัดไป|วันพรุ่งนี้|พรุ่งนี้|เมื่อวาน|วันที่ปัจจุบัน|ย้อนหลัง|วันก่อน|ล่วงหน้า|ของเดือน|สิ้นเดือน|ต้นเดือน|วันสุดท้าย|วันแรก|ของปี|อายุ/u,
  /^age\s*(?:[<>=≤≥]|under|over|below|above|at least|at most)/i,
  /\b9999\b/,
  /[+\-]\s*\d+\s*(?:(?:days?|d|weeks?|months?|years?)\b|วัน|สัปดาห์|เดือน|ปี)/iu,
  /\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+\d{4}\b/i,
  /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b/i,
  /^\d{1,2}\s*[\p{Script=Thai}.]{2,12}\s*(?:พ\.?ศ\.?\s*)?\d{2,4}$/u,
  /\b(?:day \d{1,2}|last day|first day|end|start|beginning) of (?:this|the|next|previous|last|current)\b/i,
  /\b\d{1,2}(?:st|nd|rd|th) of (?:this|the|next|previous|last|current) month\b/i,
];

/** A field that holds a birth date, where `35 ปี 6 เดือน` is an age and not a duration. */
const BIRTH_FIELD = /birth|\bdob\b|เกิด|\bage\b|อายุ/i;

/**
 * True when a typed value is a date phrase the resolver computes, not a value
 * to type as written. The bare `N ปี M เดือน` form is an age only on a
 * birth-date field — on a claim period it is the duration it says.
 */
export function isDatePhrase(text: string, field?: string): boolean {
  const t = text.trim();
  if (t === '' || t.length > 80 || ISO_DATE_VALUE.test(t)) return false;
  if (DATE_PHRASE_SHAPES.some((re) => re.test(t))) return true;
  return field !== undefined && BIRTH_FIELD.test(field) && /^\d{1,3}\s*(?:ปี|years?)(?:\s*\d{1,2}\s*(?:เดือน|months?))?$/iu.test(t);
}

/** What the resolver knows when it computes a phrase: today, and the fields already resolved by label. */
export interface DateEnvironment {
  now: Date;
  /** An earlier field's ISO date by its label (`hire date`), or null. */
  lookup: (label: string) => string | null;
}

export interface ResolvedDate {
  iso: string;
  /** One line a reader can check: `Hire Date + 119 Day = 2026-12-31 (Hire Date = 2026-09-03)`. */
  detail: string;
}

type MonthWord = 'this' | 'next' | 'previous';
function monthWordOf(text: string | undefined): MonthWord {
  if (text === undefined) return 'this';
  // `ก่อนหน้า` (previous) contains `หน้า` (next): the previous test goes first.
  if (/ก่อน|ที่แล้ว|previous|last/i.test(text)) return 'previous';
  if (/ถัดไป|หน้า|next/i.test(text)) return 'next';
  return 'this';
}
const monthOffset = (word: MonthWord): number => (word === 'next' ? 1 : word === 'previous' ? -1 : 0);

const OFFSET_UNIT = /(?:days?|d|weeks?|w|months?|years?|y)\b|วัน|สัปดาห์|เดือน|ปี/iu;
function applyOffset(date: Ymd, sign: number, n: number, unit: string): Ymd {
  if (/^(?:months?|เดือน)$/iu.test(unit)) return addMonths(date, sign * n);
  if (/^(?:years?|y|ปี)$/iu.test(unit)) return addMonths(date, sign * n * 12);
  if (/^(?:weeks?|w|สัปดาห์)$/iu.test(unit)) return addDays(date, sign * n * 7);
  return addDays(date, sign * n);
}

/**
 * `Age < 60`, `อายุน้อยกว่า 60 ปี`, `อายุ 60 ปีขึ้นไป`, `อายุพอดี 60 ปีเป๊ะ`,
 * `35 ปี 6 เดือน` — a DATE OF BIRTH such that the age holds at the anchor (the
 * Hire Date the case set, else today). Strict bounds land half a year inside
 * (`< 60` → 59 y 6 m): the sheet's `Age < 60` rows (82 of them) are about the
 * under-60 branch of the SSO rule, not its boundary, and the boundary rows say
 * `พอดี`/`เป๊ะ`/`=` and get the exact day.
 */
function ageDateOf(phrase: string, env: DateEnvironment): ResolvedDate | null {
  const m =
    /^(?:age|อายุ)?\s*(<=|>=|=|<|>|≤|≥|น้อยกว่า|ต่ำกว่า|ไม่ถึง|มากกว่า|เกิน|ตั้งแต่|พอดี|ครบ|under|below|over|above|at least|at most|exactly)?\s*(\d{1,3})\s*(?:ปี|years?|y)?\s*(?:(\d{1,2})\s*(?:เดือน|months?))?\s*(ขึ้นไป|เป๊ะ|พอดี|ลงมา|or (?:more|older|above|over)|or (?:less|younger|below|under)|and (?:above|over|older)|and (?:below|under|younger))?\s*$/iu.exec(
      phrase.trim(),
    );
  if (!m) return null;
  if (!/^(?:age|อายุ)/iu.test(phrase.trim()) && m[3] === undefined) return null;
  const years = Number(m[2]);
  const months = m[3] === undefined ? null : Number(m[3]);
  const op = `${m[1] ?? ''} ${m[4] ?? ''}`.trim();
  const anchorLabel = ['hire date', 'วันที่เข้างาน', 'วันเริ่มงาน', 'start date'].find((l) => env.lookup(l) !== null);
  const anchorIso = anchorLabel === undefined ? null : env.lookup(anchorLabel);
  const anchor = anchorIso === null ? ymdOf(env.now) : absoluteDateOf(anchorIso) ?? ymdOf(env.now);
  let relation: 'under' | 'exact' | 'over' = 'exact';
  if (months === null) {
    if (/^(?:<|น้อยกว่า|ต่ำกว่า|ไม่ถึง|under|below)$/iu.test(op)) relation = 'under';
    else if (/^(?:>|มากกว่า|เกิน|over|above)$/iu.test(op)) relation = 'over';
  }
  const back = years * 12 + (months ?? 0) + (relation === 'under' ? -6 : relation === 'over' ? 6 : 0);
  const dob = addMonths(anchor, -back);
  const shown = relation === 'under' ? `${years - 1} y 6 m` : relation === 'over' ? `${years} y 6 m` : months === null ? `${years} y` : `${years} y ${months} m`;
  const at = anchorIso === null ? `today ${isoOf(anchor)}` : `${anchorLabel} ${anchorIso}`;
  return { iso: isoOf(dob), detail: `${phrase.trim()} = ${isoOf(dob)} (age ${shown} at ${at})` };
}

/**
 * The phrase as a date. Grammar, all deterministic: a BASE — today / next day
 * / yesterday, `31 Dec 9999`, a written date (Thai months and Buddhist years
 * included), `วันที่ N ของเดือน(ปัจจุบัน|ถัดไป)`, `วันสุดท้ายของเดือนถัดไป`,
 * `01/01 ของปีก่อนหน้า`, or an earlier field by label (`Hire Date`) — then any
 * number of OFFSETS: `+ 119 Day`, `- 1 Day`, `+ 1 Year`, `ย้อนหลัง 3 วัน`,
 * `Next day + 1`. An age expression is its own shape. Null when a word is not
 * understood, so nothing half-computed is ever typed.
 */
export function resolveDatePhrase(phrase: string, env: DateEnvironment, depth = 0): ResolvedDate | null {
  let text = phrase.trim().replace(/\s*\([^)]*\)\s*$/, '').replace(/\s*(?:พอดี|เป๊ะ)\s*$/u, '').trim();
  if (text === '' || depth > 3) return null;
  const age = ageDateOf(text, env);
  if (age !== null) return age;

  const today = ymdOf(env.now);
  const notes: string[] = [];
  let base: Ymd | null = null;
  let fromToday = true;
  const take = (re: RegExp): RegExpExecArray | null => {
    const m = re.exec(text);
    if (m) text = text.slice(m[0].length).trim();
    return m;
  };

  // --- base
  let m: RegExpExecArray | null;
  if (take(/^(?:today|now|current date|the current date|วันนี้|วันที่ปัจจุบัน|ปัจจุบัน)/iu)) base = today;
  else if (take(/^(?:tomorrow|next\s?day|วันถัดไป|วันพรุ่งนี้|พรุ่งนี้)/iu)) base = addDays(today, 1);
  else if (take(/^(?:yesterday|เมื่อวาน(?:นี้)?|วันก่อนหน้า)/iu)) base = addDays(today, -1);
  else if ((m = take(/^(?:วันที่\s*(\d{1,2})\s*ของเดือน\s*(ปัจจุบัน|นี้|ถัดไป|หน้า|ก่อนหน้า|ก่อน|ที่แล้ว)?|day\s+(\d{1,2})\s+of\s+(?:the\s+)?(this|current|next|previous|last)\s+month|(\d{1,2})(?:st|nd|rd|th)\s+of\s+(?:the\s+)?(this|current|next|previous|last)\s+month)/iu))) {
    const day = Number(m[1] ?? m[3] ?? m[5]);
    const month = addMonths({ ...today, d: 1 }, monthOffset(monthWordOf(m[2] ?? m[4] ?? m[6])));
    if (day < 1 || day > daysInMonth(month.y, month.m)) return null;
    base = { ...month, d: day };
  } else if ((m = take(/^(?:วันสุดท้ายของเดือน\s*(ปัจจุบัน|นี้|ถัดไป|หน้า|ก่อนหน้า|ก่อน|ที่แล้ว)?|สิ้นเดือน\s*(ปัจจุบัน|นี้|ถัดไป|หน้า|ก่อนหน้า|ก่อน|ที่แล้ว)?|(?:last day|end)\s+of\s+(?:the\s+)?(this|current|next|previous|last)\s+month|month\s+end)/iu))) {
    const month = addMonths({ ...today, d: 1 }, monthOffset(monthWordOf(m[1] ?? m[2] ?? m[3])));
    base = { ...month, d: daysInMonth(month.y, month.m) };
  } else if ((m = take(/^(?:วันแรกของเดือน\s*(ปัจจุบัน|นี้|ถัดไป|หน้า|ก่อนหน้า|ก่อน|ที่แล้ว)?|ต้นเดือน\s*(ปัจจุบัน|นี้|ถัดไป|หน้า|ก่อนหน้า|ก่อน|ที่แล้ว)?|(?:first day|start|beginning)\s+of\s+(?:the\s+)?(this|current|next|previous|last)\s+month)/iu))) {
    base = addMonths({ ...today, d: 1 }, monthOffset(monthWordOf(m[1] ?? m[2] ?? m[3])));
  } else if ((m = take(/^(\d{1,2})\/(\d{1,2})\s*ของปี\s*(ก่อนหน้า|ที่แล้ว|นี้|ปัจจุบัน|ถัดไป|หน้า)/u))) {
    // `01/01 ของปีก่อนหน้า` — day/month, the Thai reading.
    const y = today.y + monthOffset(monthWordOf(m[3]));
    const mm = Number(m[2]);
    const dd = Number(m[1]);
    if (mm < 1 || mm > 12 || dd < 1 || dd > daysInMonth(y, mm)) return null;
    base = { y, m: mm, d: dd };
  } else if ((m = take(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+of\s+(?:the\s+)?(this|current|next|previous|last)\s+year/i))) {
    const y = today.y + monthOffset(monthWordOf(m[3]));
    const mm = EN_MONTHS[m[2]!.slice(0, 4).toLowerCase()] ?? EN_MONTHS[m[2]!.slice(0, 3).toLowerCase()];
    const dd = Number(m[1]);
    if (mm === undefined || dd < 1 || dd > daysInMonth(y, mm)) return null;
    base = { y, m: mm, d: dd };
  } else if ((m = take(/^(?:31\/12\/9999|12\/31\/9999|9999-12-31|\d{4}-\d{2}-\d{2}|\d{1,2}\s+[A-Za-z]{3,9}\.?,?\s+\d{4}|[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\s*[\p{Script=Thai}.]{2,12}\s*(?:พ\.?ศ\.?\s*)?\d{2,4})(?=$|\s)/u))) {
    base = absoluteDateOf(m[0]);
    if (base === null) return null;
    fromToday = false;
  } else if ((m = take(/^(?:ย้อนหลัง|ล่วงหน้า|อีก|in)\s*(\d+)\s*(?:วัน|days?)/iu))) {
    // `ย้อนหลัง 3 วัน` on its own: three days back from today.
    const back = /^(?:ย้อนหลัง)/u.test(m[0]);
    base = addDays(today, (back ? -1 : 1) * Number(m[1]));
  } else if ((m = take(/^(\d+)\s*(?:วันก่อน(?:หน้า)?|days?\s+ago|days?\s+back)/iu))) {
    base = addDays(today, -Number(m[1]));
  } else if ((m = take(/^([\p{L}][\p{L}\p{M}\p{N} /().'*-]{1,40}?)(?=\s*(?:[+\-]\s*\d|ย้อนหลัง|ล่วงหน้า|$))/u))) {
    // An earlier field by label: `Hire Date + 119 Day`.
    const label = m[1]!.trim();
    const iso = env.lookup(label);
    if (iso === null) return null;
    base = absoluteDateOf(iso);
    if (base === null) return null;
    notes.push(`${label} = ${iso}`);
    fromToday = false;
  }
  if (base === null) return null;

  // --- offsets, any number, in order
  let date = base;
  let guard = 0;
  while (text !== '' && guard++ < 8) {
    let o: RegExpExecArray | null;
    if ((o = take(new RegExp(`^([+\\-−])\\s*(\\d+)\\s*(${OFFSET_UNIT.source})?`, 'iu')))) {
      // `Next day + 1` with no unit is a day, the sheet's own shorthand.
      date = applyOffset(date, o[1] === '+' ? 1 : -1, Number(o[2]), (o[3] ?? 'day').toLowerCase());
    } else if ((o = take(/^(?:ย้อนหลัง)\s*(\d+)\s*(วัน|สัปดาห์|เดือน|ปี)/u))) {
      date = applyOffset(date, -1, Number(o[1]), o[2]!);
    } else if ((o = take(/^(?:ล่วงหน้า|อีก)\s*(\d+)\s*(วัน|สัปดาห์|เดือน|ปี)/u))) {
      date = applyOffset(date, 1, Number(o[1]), o[2]!);
    } else if (take(/^(?:และ|and)\b/iu)) {
      continue;
    } else {
      return null;
    }
  }
  const iso = isoOf(date);
  // `Next day + 1 = 2026-09-05 (today = 2026-09-03)` — the reader can check it;
  // `Today = 2026-09-03` needs no second telling.
  const bareToday = /^(?:today|now|วันนี้|วันที่ปัจจุบัน)$/iu.test(phrase.trim());
  const tail = [...notes, ...(fromToday && !bareToday ? [`today = ${isoOf(today)}`] : [])];
  return { iso, detail: `${phrase.trim()} = ${iso}${tail.length ? ` (${tail.join(', ')})` : ''}` };
}

/**
 * The FIRST source: a date phrase the step carries as written, or one the
 * case's Test data states for the field, computed from `now`. `earlier` holds
 * the fields this case already resolved, by label, so `Period End Date = Hire
 * Date + 119 Day` follows the Hire Date the same case set (probation rows,
 * 32 of them); a label not resolved yet is read from the Test data pairs
 * (`Hire Date = Today`) so sheet order does not matter.
 */
export function fromRelativeDate(
  need: ValueNeed,
  caseText: string,
  now: Date,
  pairs?: readonly TestDataPair[],
  earlier?: ReadonlyMap<string, string>,
): ResolvedValue | null {
  const all = pairs ?? testDataPairsOf(caseText);
  const known = earlier ?? new Map<string, string>();
  const env: DateEnvironment = {
    now,
    lookup: (label) => lookupDate(label, all, known, now, 0),
  };
  const phrase = need.phrase ?? (() => {
    const pair = pairFor(need, all);
    return pair !== null && isDatePhrase(pair.value, need.field) ? pair.value.trim() : null;
  })();
  if (phrase === null) return null;
  const date = resolveDatePhrase(phrase, env);
  if (date === null) return null;
  return { need, value: date.iso, source: { kind: 'relative-date', detail: date.detail } };
}

/** An earlier field's date by label: resolved this case, or stated in the Test data (recursively, bounded). */
function lookupDate(label: string, pairs: readonly TestDataPair[], known: ReadonlyMap<string, string>, now: Date, depth: number): string | null {
  const want = normalLabel(label);
  const hit = known.get(want);
  if (hit !== undefined) return hit;
  if (depth > 3) return null;
  for (const pair of pairs) {
    if (!keyMatchesLabel(normalLabel(pair.key), want)) continue;
    const value = pair.value.trim();
    if (ISO_DATE_VALUE.test(value)) return value;
    const absolute = absoluteDateOf(value);
    if (absolute !== null) return isoOf(absolute);
    if (!isDatePhrase(value) || normalLabel(value) === want) continue;
    const resolved = resolveDatePhrase(value, { now, lookup: (l) => lookupDate(l, pairs, known, now, depth + 1) }, depth + 1);
    if (resolved !== null) return resolved.iso;
  }
  return null;
}

// --- unique per run ------------------------------------------------------------------

/** The case says this value must ALREADY be in the system — the lines about the field, the value's own line, the step's intent. */
function saysAlreadyExists(need: ValueNeed, value: string, caseText: string, intent: string | undefined): boolean {
  if (intent !== undefined && ALREADY_EXISTS.test(intent)) return true;
  const lines = caseText.split('\n').filter((line) => line.includes(value));
  return `${linesAbout(need.field, caseText)}\n${lines.join('\n')}`.split('\n').some((line) => ALREADY_EXISTS.test(line));
}

/**
 * A key value the sheet reused across runs (`Benefit Plan ID = PL_06_21`,
 * `Benefit name = QA-Insert`, Consent `SIT_*`), made unique to this run —
 * unless the case says the value must already exist, in which case the
 * duplicate IS the test and the value stays.
 */
export function fromUniquePerRun(need: ValueNeed, caseText: string, runKey: string | undefined, intent?: string): ResolvedValue | null {
  if (need.uniqueKey === undefined || runKey === undefined || runKey.trim() === '') return null;
  if (saysAlreadyExists(need, need.uniqueKey, caseText, intent)) return null;
  const value = uniquePerRun(need.uniqueKey, runKey);
  if (value === need.uniqueKey) return null;
  return { need, value, source: { kind: 'unique-per-run', detail: `unique per run: ${need.uniqueKey} → ${value}` } };
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
 *
 * Needs are taken in step order, and every date resolved is remembered by its
 * field's label so a later phrase (`Hire Date + 119 Day`) can lean on it. A
 * date-phrase or reused-key need has exactly one source; when that source
 * declines, the step is left as authored and the log says so — a stand-in for
 * a date, or for a key the case says must already exist, would be a lie.
 */
export async function resolveValues(
  setup: readonly FlowStep[],
  steps: readonly FlowStep[],
  ctx: ValueResolutionContext,
): Promise<ValueResolutionOutcome> {
  const nextSetup = setup.map((s) => ({ ...s })) as FlowStep[];
  const nextSteps = steps.map((s) => ({ ...s })) as FlowStep[];
  const resolved: ResolvedValue[] = [];
  // The one place the wall clock is read: everything below takes `now`.
  const now = ctx.now ?? new Date();
  const pairs = ctx.testDataPairs ?? testDataPairsOf(ctx.caseText);
  const earlier = new Map<string, string>();
  for (const need of findUnresolvedValues(nextSetup, nextSteps, ctx.caseText, { caseId: ctx.caseId })) {
    const list = need.section === 'setup' ? nextSetup : nextSteps;
    const step = list[need.index] as FlowStep & { value?: string; intent?: string | undefined; valueSource?: ValueSource | undefined };
    let answer: ResolvedValue | null = null;
    const tried: string[] = [];
    if (need.phrase !== undefined || need.uniqueKey !== undefined) {
      answer =
        need.phrase !== undefined
          ? fromRelativeDate(need, ctx.caseText, now, pairs, earlier)
          : fromUniquePerRun(need, ctx.caseText, ctx.runKey, step.intent);
      if (answer === null) {
        ctx.onLog?.(
          need.phrase !== undefined
            ? `  ${need.field}: the date phrase ${JSON.stringify(need.phrase)} was not understood — left as written`
            : `  ${need.field}: ${JSON.stringify(need.uniqueKey)} kept as written${ctx.runKey === undefined ? ' (no run key)' : ' (the case says it already exists)'}`,
        );
        continue;
      }
    } else {
      for (const [name, source] of [
        ['relative-date', async (): Promise<ResolvedValue | null> => fromRelativeDate(need, ctx.caseText, now, pairs, earlier)],
        ['test-data', async (): Promise<ResolvedValue | null> => fromTestData(need, ctx.caseText, pairs)],
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
      // A value the Test data states that IS the case id gets the run's suffix
      // too — the sheet's `Benefit Plan ID = PL_06_21` reaches here through a
      // `<PLAN_ID>` token as often as typed outright.
      if (answer.source.kind === 'test-data' && isReusedKeyValue(answer.value, need.field, ctx.caseId)) {
        const unique = fromUniquePerRun({ ...need, uniqueKey: answer.value }, ctx.caseText, ctx.runKey, step.intent);
        if (unique !== null) answer = { need, value: unique.value, source: { kind: 'unique-per-run', detail: `${unique.source.detail}; ${answer.source.detail}` } };
      }
    }
    for (const line of tried) ctx.onLog?.(`  value for ${need.field}: ${line}`);
    step.value = answer.value;
    step.valueSource = answer.source;
    const suffix =
      answer.source.kind === 'generated'
        ? ` — value GENERATED by the author: ${answer.source.detail}`
        : answer.source.kind === 'unique-per-run'
          ? ` — value ${answer.source.detail}`
          : ` — value from ${answer.source.kind}: ${answer.source.detail}`;
    step.intent = `${step.intent ?? `${step.action} ${need.field}`}${suffix}`;
    if (ISO_DATE_VALUE.test(answer.value)) earlier.set(normalLabel(need.field), answer.value);
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
