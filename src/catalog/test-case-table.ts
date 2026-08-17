/**
 * The test-case table: this project's catalog format, read and written.
 *
 * A QA team's catalog is not prose and it is not a list of sentences — it is a
 * spreadsheet with a fixed set of columns, one row per test case, scenario IDs
 * grouping the rows. `src/catalog/catalog.ts` can read *any* document by asking
 * a model what it asserts; this module is the other thing, for the one shape we
 * actually own:
 *
 *   read   a table in this format → claims, with no model call at all
 *   write  cases from a description or a page → a table in this format
 *
 * **Reading it structurally rather than asking a model is the whole point.** The
 * columns already say what the general extractor has to infer: which rows are
 * cases, what each one is called, how important it is, whether it is a negative
 * test, what the steps are and what the expected output is. Handing that to a
 * model to re-derive costs a call, loses the Test Case ID, and can hallucinate a
 * claim the sheet never made. A column read is exact and free.
 *
 * The format is fixed by the file, not by us — column names, their order and
 * their spelling (` Test Data` really does carry a leading space) are matched
 * leniently on read and reproduced exactly on write, so a sheet can go out of
 * here and back into whatever the team already uses.
 */

import { parseDelimited, sniffDelimiter } from './extract.js';
import type { CatalogClaim } from './catalog.js';

/**
 * The header, exactly as the format has it — including the leading space in
 * ` Test Data` and the trailing empty column, both of which are what a
 * spreadsheet exporter produced and both of which round-trip.
 */
export const TEST_CATALOG_HEADER = [
  'No.',
  'Scenario ID',
  'Test Scenario',
  'Test Case ID',
  'Positive/Negative',
  'Priority',
  'Test Case',
  ' Test Data',
  'Menu',
  'Test Script / Steps',
  'Expected Output',
  'Actual Result',
  'Test Date',
  'Test by',
  'Bug ticket',
  'Note',
  '',
] as const;

/** One row. Every field is a string, because every cell is. */
export interface TestCaseRow {
  /** Row number in the sheet. Written as 1..n; ignored on read. */
  no: string;
  /** e.g. `HP_01`. Blank on a continuation row — see `carryForward`. */
  scenarioId: string;
  /** Title of the scenario the case belongs to. Blank on a continuation row. */
  scenario: string;
  /** e.g. `HP_01_02`. This is the case's identity. */
  caseId: string;
  /** `Positive` or `Negative`. */
  polarity: string;
  /** `High` / `Medium` / `Low`. */
  priority: string;
  /** One line: what this case checks. */
  testCase: string;
  /** Inputs, personas, boundary values. */
  testData: string;
  /** Where in the application, as numbered menu levels. */
  menu: string;
  /** Numbered steps, one per line. */
  steps: string;
  /** Numbered expectations, keyed to the step that produces them (`3.2`). */
  expected: string;
  /** `Pass` / `Fail` / blank. A record of the last manual run, never an input. */
  actual: string;
  testDate: string;
  testBy: string;
  bugTicket: string;
  note: string;
}

const EMPTY_ROW: TestCaseRow = {
  no: '',
  scenarioId: '',
  scenario: '',
  caseId: '',
  polarity: '',
  priority: '',
  testCase: '',
  testData: '',
  menu: '',
  steps: '',
  expected: '',
  actual: '',
  testDate: '',
  testBy: '',
  bugTicket: '',
  note: '',
};

/** Header cell → field, matched on a squashed form so spacing cannot break it. */
const FIELD_BY_HEADER = new Map<string, keyof TestCaseRow>([
  ['no.', 'no'],
  ['no', 'no'],
  ['scenarioid', 'scenarioId'],
  ['testscenario', 'scenario'],
  ['testcaseid', 'caseId'],
  ['positive/negative', 'polarity'],
  ['priority', 'priority'],
  ['testcase', 'testCase'],
  ['testdata', 'testData'],
  ['menu', 'menu'],
  ['testscript/steps', 'steps'],
  ['teststeps', 'steps'],
  ['expectedoutput', 'expected'],
  ['expectedresult', 'expected'],
  ['actualresult', 'actual'],
  ['testdate', 'testDate'],
  ['testby', 'testBy'],
  ['bugticket', 'bugTicket'],
  ['note', 'note'],
  ['notes', 'note'],
]);

const squash = (value: string): string => value.replace(/\s+/g, '').toLowerCase();

/**
 * The columns that make a sheet *this* sheet.
 *
 * Deliberately few, and all three are load-bearing rather than decorative: an
 * identity per case, what to do, and what should happen. A sheet missing any of
 * them is somebody else's spreadsheet and goes to the general extractor, which
 * is the honest outcome — guessing at a table we do not recognise is how a
 * column ends up read as a claim.
 */
const REQUIRED: readonly (keyof TestCaseRow)[] = ['caseId', 'steps', 'expected'];

/**
 * Read a delimited document as a test-case table.
 *
 * `null` when it is not one — the caller falls back to asking a model what the
 * document claims.
 */
export function parseTestCaseTable(raw: string): TestCaseRow[] | null {
  const rows = parseDelimited(raw, sniffDelimiter(raw));
  if (rows.length < 2) return null;

  // The header is not always line 1: an exported sheet often carries a title
  // row, or a blank one, above it. Look for it in the first few rows only —
  // further down and it is data that happens to look like a header.
  let headerAt = -1;
  let mapping: (keyof TestCaseRow | null)[] = [];
  for (let i = 0; i < Math.min(rows.length, 5); i += 1) {
    const candidate = (rows[i] ?? []).map((cell) => FIELD_BY_HEADER.get(squash(cell)) ?? null);
    if (REQUIRED.every((field) => candidate.includes(field))) {
      headerAt = i;
      mapping = candidate;
      break;
    }
  }
  if (headerAt === -1) return null;

  const parsed: TestCaseRow[] = [];
  // Scenario ID and Test Scenario are written once per group and left blank on
  // the rows under them. Read literally, case 2 of a scenario belongs to no
  // scenario at all — so the last non-empty value carries down, which is what
  // the blank cell means to the person who wrote it.
  let scenarioId = '';
  let scenario = '';

  for (const cells of rows.slice(headerAt + 1)) {
    const row: TestCaseRow = { ...EMPTY_ROW };
    mapping.forEach((field, column) => {
      if (field !== null) row[field] = (cells[column] ?? '').trim();
    });

    if (row.scenarioId !== '') scenarioId = row.scenarioId;
    else row.scenarioId = scenarioId;
    if (row.scenario !== '') scenario = row.scenario;
    else row.scenario = scenario;

    // A row with no case id and nothing to check is a spacer, not a case.
    if (row.caseId === '' && row.testCase === '') continue;
    parsed.push(row);
  }

  return parsed.length === 0 ? null : parsed;
}

/**
 * The claims a table asserts.
 *
 * One claim per row, and the claim text is the case title plus what the sheet
 * says should happen — because "Saving is blocked when no HRBP is assigned" on
 * its own is a topic, and the Expected Output column is the actual assertion.
 * The Test Case ID becomes `source`, so every claim in the gate points back at
 * the row a reviewer can find.
 *
 * **`Actual Result` is ignored on purpose.** It records what a person saw last
 * time they ran it by hand. Reading it would let a sheet marked Fail arrive
 * pre-judged, and the run about to happen is the thing that decides.
 */
export function tableToClaims(rows: readonly TestCaseRow[]): CatalogClaim[] {
  return rows.map((row) => ({
    claim: claimTextOf(row),
    priority: row.priority.trim().toLowerCase() || 'medium',
    source: row.caseId || row.scenarioId || row.testCase.slice(0, 40),
    // Every row of this sheet is a case someone wrote to be run. A row that only
    // sets the scene does not get a Test Case ID and a set of expectations.
    testable: true,
  }));
}

function claimTextOf(row: TestCaseRow): string {
  const expected = row.expected.trim();
  const title = row.testCase.trim() || row.scenario.trim() || row.caseId;
  return expected === '' ? title : `${title} — expected: ${oneLine(expected)}`;
}

const oneLine = (value: string): string => value.split('\n').map((l) => l.trim()).filter(Boolean).join('; ');

/**
 * Everything the flow author should know about one case.
 *
 * The general catalog prompt hands the model a sentence. This hands it the row:
 * the steps a tester would take, what each should produce, the menu path to get
 * there, and the data to use. That is the difference between a model guessing a
 * journey and being told it — and the numbered expectations (`3.2`) say which
 * step each assertion belongs after, which is exactly what a flow needs.
 */
export function describeCase(row: TestCaseRow): string {
  const parts = [`${row.caseId || row.scenarioId}: ${row.testCase}`];
  if (row.scenario !== '') parts.push(`Scenario: ${row.scenario}`);
  if (row.polarity !== '') parts.push(`Type: ${row.polarity}`);
  if (row.menu !== '') parts.push(`Menu path:\n${indent(row.menu)}`);
  if (row.testData !== '' && row.testData.toUpperCase() !== 'N/A') {
    parts.push(`Test data: ${oneLine(row.testData)}`);
  }
  if (row.steps !== '') parts.push(`Steps:\n${indent(row.steps)}`);
  if (row.expected !== '') parts.push(`Expected output:\n${indent(row.expected)}`);
  return parts.join('\n');
}

const indent = (value: string): string =>
  value
    .split('\n')
    .map((line) => `  ${line.trim()}`)
    .join('\n');

// --- writing -----------------------------------------------------------------

/** Quote a cell the way a spreadsheet does: only when it has to be quoted. */
function cell(value: string): string {
  const text = value ?? '';
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Render rows as a catalog in this format.
 *
 * `No.` is renumbered from 1 and **`Scenario ID` / `Test Scenario` are blanked
 * on continuation rows**, because that is how the format expresses grouping and
 * a sheet that repeats them on every line looks, to a reader, like every row is
 * its own scenario. Result columns (`Actual Result` through `Bug ticket`) are
 * written empty: nothing here has been run by a person yet, and pre-filling
 * `Pass` would be a claim about work nobody did.
 */
export function renderTestCaseTable(rows: readonly TestCaseRow[]): string {
  const lines = [TEST_CATALOG_HEADER.map(cell).join(',')];
  let lastScenario = '';

  rows.forEach((row, index) => {
    const startsScenario = row.scenarioId !== lastScenario;
    lastScenario = row.scenarioId;
    lines.push(
      [
        String(index + 1),
        startsScenario ? row.scenarioId : '',
        startsScenario ? row.scenario : '',
        row.caseId,
        row.polarity,
        row.priority,
        row.testCase,
        row.testData,
        row.menu,
        row.steps,
        row.expected,
        row.actual,
        row.testDate,
        row.testBy,
        row.bugTicket,
        row.note,
        '',
      ]
        .map(cell)
        .join(','),
    );
  });

  return `${lines.join('\n')}\n`;
}

/**
 * Fill in what the format derives rather than states: ids, numbering, polarity.
 *
 * A model asked for test cases returns the interesting columns and is unreliable
 * at the bookkeeping ones — it repeats a Test Case ID, or numbers scenarios from
 * whatever it saw last. Those are a function of position, so they are computed
 * here and never asked for.
 */
export function numberCases(
  cases: readonly Omit<TestCaseRow, 'no' | 'scenarioId' | 'caseId'>[],
  prefix: string,
): TestCaseRow[] {
  const scenarioIds = new Map<string, string>();
  const perScenario = new Map<string, number>();
  const rows: TestCaseRow[] = [];

  for (const one of cases) {
    const key = one.scenario.trim() || 'General';
    let scenarioId = scenarioIds.get(key);
    if (scenarioId === undefined) {
      scenarioId = `${prefix}_${String(scenarioIds.size + 1).padStart(2, '0')}`;
      scenarioIds.set(key, scenarioId);
    }
    const n = (perScenario.get(scenarioId) ?? 0) + 1;
    perScenario.set(scenarioId, n);

    rows.push({
      ...one,
      scenario: key,
      no: String(rows.length + 1),
      scenarioId,
      caseId: `${scenarioId}_${String(n).padStart(2, '0')}`,
      polarity: /^neg/i.test(one.polarity) ? 'Negative' : 'Positive',
      priority: titleCase(one.priority) || 'Medium',
      // Never pre-filled: see `renderTestCaseTable`.
      actual: '',
      testDate: '',
      testBy: '',
      bugTicket: '',
    });
  }

  return rows;
}

function titleCase(value: string): string {
  const word = value.trim().toLowerCase();
  if (word === '') return '';
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** A short, stable id prefix from whatever the catalog is about. */
export function prefixFor(subject: string): string {
  const words = subject
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2);
  const initials = words.slice(0, 2).map((word) => word[0]?.toUpperCase() ?? '').join('');
  return initials.length >= 2 ? initials : 'TC';
}
