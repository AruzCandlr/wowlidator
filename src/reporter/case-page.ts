/**
 * One case's own report page (2026-09-10): a standalone HTML file beside the
 * catalog report, in the narrative style of the hand-written verifier reports
 * (a mast, a pre-read summary, a coverage bar, tickets, the test data, the
 * database evidence before and after, the queries that gathered it, the
 * outcomes step by step, the film, the stills), linked from the case's row in
 * the catalog index.
 *
 * Two kinds of sentence share the page, and the page keeps them apart:
 *
 * - **Evidence** — every table, chip, pill, query and still is a pure
 *   function of the bundle, the same rule as every other renderer here. A
 *   section with no evidence is omitted, never padded.
 * - **Narrative** — the lede, the pre-read summary, the ticket wording, the
 *   verifier's note and the open questions come from `bundle.narrative`,
 *   written by a model after the run (`generator/case-narrative.ts`). Every
 *   such sentence wears the `ai` class and the page says once, under the
 *   mast, whose words those are. A bundle with no narrative renders the
 *   evidence alone.
 *
 * The four sidecar files the "queries" section links to are built here too
 * (`caseSidecars`), from the same projection (`dbEvidence`, `dbChanges`), so
 * the page and its files cannot describe one check two ways. Everything in
 * them was redacted before it reached the bundle; no DSN, no credential.
 *
 * Labels come in the run's report language (`ReportLang`); application text,
 * ids, SQL and selectors are shown exactly as recorded, never translated.
 */

import {
  BACKEND_TIER_ACTIONS,
  describeTarget,
  describeValueSource,
  expectedActual,
  type ProofBundle,
  type ProofStep,
  type ReportLang,
  type StepDbChange,
} from '../engine/proof-bundle.js';
import { casePageName, catalogCaseExportName, verdictChipOf, type CatalogReportCase } from './catalog-report.js';
import {
  dbEvidence,
  displayCaseId,
  isAssertionStepAction,
  observedEvidence,
  provenanceExtras,
  runNotesSummary,
  sheetLabel,
  signInPersona,
  stepNarration,
  stepTarget,
  type DbEvidence,
} from './step-facts.js';

/* ------------------------------------------------------------------ labels */

interface Labels {
  eyebrow: string;
  sub: string;
  idCase: string;
  idScenario: string;
  idSheet: string;
  idVerdict: string;
  aiNote: (model: string) => string;
  preRead: string;
  thTopic: string;
  thDetail: string;
  testCase: string;
  testData: string;
  expected: string;
  noneRecorded: string;
  coverage: (n: number) => string;
  covPass: string;
  covObs: string;
  covFail: string;
  covNa: string;
  tickets: string;
  thKind: string;
  thTicket: string;
  thOwner: string;
  tagApp: string;
  tagTest: string;
  dataUsed: string;
  dataLede: string;
  thItem: string;
  thValue: string;
  thSource: string;
  savedByRun: string;
  signedInAs: string;
  dbBeforeAfter: string;
  dbLede: string;
  thTable: string;
  thBefore: string;
  thAfter: string;
  thChange: string;
  unchanged: string;
  rowsWord: string;
  sampleWord: string;
  queries: string;
  queriesLede: string;
  chipQuery: string;
  chipBefore: string;
  chipAfter: string;
  chipEvidence: string;
  stepWord: string;
  asOfStep: string;
  probeFailed: string;
  paramsWord: string;
  rowsReturned: string;
  polled: string;
  backendCalls: string;
  backendLede: string;
  requestWord: string;
  responseWord: string;
  noResponse: string;
  questions: string;
  outcomes: (n: number) => string;
  thNo: string;
  thStep: string;
  thResult: string;
  thEvidence: string;
  film: string;
  filmLede: string;
  stills: string;
  stillsLede: string;
  footer: string;
  backToIndex: string;
  /** The blocked-case page: a case that never ran still says why, on a page of its own. */
  blockedSub: string;
  blockedWhy: string;
  blockedEvidence: string;
  blockedNoRun: string;
  blockedNoReason: string;
  verdict: Record<string, string>;
  pill: Record<string, string>;
}

const EN: Labels = {
  eyebrow: 'wowlidator',
  sub: 'Recorded from the run itself: the values used, the database before and after, and the browser evidence, in one file.',
  idCase: 'Case',
  idScenario: 'Scenario',
  idSheet: 'Sheet',
  idVerdict: 'Verdict',
  aiNote: (model) => `Sentences with a violet bar were written by ${model} from this record after the run. They explain; they decide nothing.`,
  preRead: 'Before reading the results',
  thTopic: 'Topic',
  thDetail: 'What this run used',
  testCase: 'Test case',
  testData: 'Test data',
  expected: 'Expected result',
  noneRecorded: 'none recorded',
  coverage: (n) => `Coverage — ${n} step(s)`,
  covPass: 'asserted and passed',
  covObs: 'performed',
  covFail: 'asserted and failed',
  covNa: 'not reached',
  tickets: 'Suggested tickets',
  thKind: 'Kind',
  thTicket: 'Suggested ticket',
  thOwner: 'Owner',
  tagApp: 'app',
  tagTest: 'test',
  dataUsed: 'Test data actually used',
  dataLede: 'Values the run saved or signed in with, masked by name where sensitive.',
  thItem: 'Item',
  thValue: 'Value',
  thSource: 'Where it came from',
  savedByRun: 'saved by the run',
  signedInAs: 'signed in as',
  dbBeforeAfter: 'Database evidence, before and after',
  dbLede: 'Every baseline table, as the last backend probe found it against the snapshot taken before the run: row counts and a capped, redacted sample of changed rows (deleted rows on the before side, inserted and updated on the after side).',
  thTable: 'Table',
  thBefore: 'Before',
  thAfter: 'After',
  thChange: 'What changed',
  unchanged: 'unchanged',
  rowsWord: 'rows',
  sampleWord: 'sample',
  queries: 'Queries used for the DB evidence',
  queriesLede: 'Parameterised, built from schema-validated identifiers and run on the read-only session; bound values redacted at the source. The files hold no DSN and no credential.',
  chipQuery: 'full SQL',
  chipBefore: 'before',
  chipAfter: 'after',
  chipEvidence: 'per-field evidence',
  stepWord: 'step',
  asOfStep: 'as of step',
  probeFailed: 'a later backend step could not probe the baseline — the state shown may be older than the run\'s end',
  paramsWord: 'parameters',
  rowsReturned: 'rows returned',
  polled: 'polled',
  backendCalls: 'Backend calls the test made',
  backendLede: 'HTTP the test sent deliberately, with what came back.',
  requestWord: 'request',
  responseWord: 'response',
  noResponse: 'no response',
  questions: 'Questions the sheet left open',
  outcomes: (n) => `Outcome per step — ${n}`,
  thNo: '#',
  thStep: 'What the step did',
  thResult: 'Result',
  thEvidence: 'Evidence',
  film: 'The run on film',
  filmLede: 'Recorded as it happened.',
  stills: 'Evidence from the screen',
  stillsLede: 'One still per step that kept one; the red rectangle marks what the step acted on.',
  footer: 'Files',
  backToIndex: 'Back to the catalog report',
  blockedSub: 'This case was not run, so nothing here is a verdict about the application.',
  blockedWhy: 'Why this case did not run',
  blockedEvidence: 'Evidence',
  blockedNoRun: 'No run took place, so there are no steps, no screenshots, no recording and no defects. Nothing on this page is a finding about the application under test.',
  blockedNoReason: 'The ledger recorded no reason for this case.',
  verdict: { passed: 'passed', 'pass**': 'passed with issues', 'test failed': 'test failed', 'test failed (dead-end)': 'test failed (dead-end)', 'system error': 'system error', 'needs review': 'needs review', 'recorded only': 'recorded only', blocked: 'blocked', 'never ran': 'never ran' },
  pill: { passed: 'passed', failed: 'failed', 'dead-end': 'dead end', error: 'error', skipped: 'skipped' },
};

const TH: Labels = {
  eyebrow: 'wowlidator',
  sub: 'บันทึกจากการรันจริง: ค่าที่ใช้ ค่า DB ก่อน/หลัง และหลักฐานจากเบราว์เซอร์ ไว้ในไฟล์เดียว',
  idCase: 'Case',
  idScenario: 'Scenario',
  idSheet: 'Sheet',
  idVerdict: 'ผลรวม',
  aiNote: (model) => `ข้อความที่มีแถบสีม่วงเขียนโดย ${model} จากบันทึกนี้หลังการรัน เป็นคำอธิบาย ไม่ใช่คำตัดสิน`,
  preRead: 'สรุปก่อนอ่านผล',
  thTopic: 'หัวข้อ',
  thDetail: 'รายละเอียดที่ใช้ทดสอบ',
  testCase: 'Test case',
  testData: 'Test data',
  expected: 'Expected result',
  noneRecorded: 'ไม่มีบันทึก',
  coverage: (n) => `ความครอบคลุม ${n} steps`,
  covPass: 'assert แล้วผ่าน',
  covObs: 'ทำสำเร็จ',
  covFail: 'assert แล้วตก',
  covNa: 'ไปไม่ถึง',
  tickets: 'แนะนำเปิด ticket',
  thKind: 'ประเภท',
  thTicket: 'Ticket ที่แนะนำ',
  thOwner: 'เจ้าของ',
  tagApp: 'แอป',
  tagTest: 'ตัวตรวจ',
  dataUsed: 'Test data ที่ใช้จริง',
  dataLede: 'ค่าที่การรันบันทึกไว้หรือใช้ล็อกอิน ปิดบังตามชื่อฟิลด์เมื่อเป็นข้อมูลอ่อนไหว',
  thItem: 'รายการ',
  thValue: 'ค่าที่ใช้',
  thSource: 'ที่มา',
  savedByRun: 'บันทึกระหว่างรัน',
  signedInAs: 'ล็อกอินเป็น',
  dbBeforeAfter: 'หลักฐานจาก DB ก่อนและหลัง',
  dbLede: 'ทุกตาราง baseline ตามที่ backend probe ครั้งสุดท้ายพบ เทียบกับ snapshot ก่อนเริ่มรัน: จำนวนแถว และตัวอย่างแถวที่เปลี่ยน (ปิดบังแล้ว จำกัดจำนวน) แถวที่ถูกลบอยู่ฝั่งก่อนรัน แถวที่เพิ่มหรือแก้อยู่ฝั่งหลังรัน',
  thTable: 'ตาราง',
  thBefore: 'ก่อนรัน',
  thAfter: 'หลังรัน',
  thChange: 'สิ่งที่เปลี่ยน',
  unchanged: 'ไม่เปลี่ยน',
  rowsWord: 'แถว',
  sampleWord: 'ตัวอย่าง',
  queries: 'Query ที่ใช้เก็บหลักฐาน DB',
  queriesLede: 'Query แบบ parameterised บน session แบบ read-only สร้างจาก identifier ที่ตรวจกับ schema แล้ว ค่าที่ผูกถูกปิดบังตั้งแต่ต้นทาง ไฟล์ไม่เก็บ DSN หรือ credential',
  chipQuery: 'SQL เต็ม',
  chipBefore: 'ก่อนรัน',
  chipAfter: 'หลังรัน',
  chipEvidence: 'หลักฐานราย field',
  stepWord: 'step',
  asOfStep: 'ณ step',
  probeFailed: 'backend step ถัดมา probe baseline ไม่สำเร็จ สถานะที่แสดงอาจเก่ากว่าตอนจบการรัน',
  paramsWord: 'พารามิเตอร์',
  rowsReturned: 'แถวที่ได้',
  polled: 'รอผล',
  backendCalls: 'การเรียก backend ที่ test ทำ',
  backendLede: 'HTTP ที่ test ส่งเอง พร้อมผลตอบกลับ',
  requestWord: 'request',
  responseWord: 'response',
  noResponse: 'ไม่มีการตอบกลับ',
  questions: 'คำถามที่ workbook ค้างไว้',
  outcomes: (n) => `ผลราย ${n} steps`,
  thNo: 'ข้อ',
  thStep: 'สิ่งที่ step ทำ',
  thResult: 'ผล',
  thEvidence: 'หลักฐาน / เหตุผล',
  film: 'วิดีโอทั้งรอบ',
  filmLede: 'บันทึกตามที่เกิดขึ้นจริง',
  stills: 'หลักฐานจากหน้าจอ',
  stillsLede: 'หนึ่งภาพต่อ step ที่เก็บภาพไว้ กรอบสีแดงคือสิ่งที่ step กระทำ',
  footer: 'ไฟล์',
  backToIndex: 'กลับไปหน้ารายงาน catalog',
  blockedSub: 'เคสนี้ไม่ได้ถูกรัน ข้อมูลในหน้านี้จึงไม่ใช่ผลตัดสินเกี่ยวกับแอปพลิเคชัน',
  blockedWhy: 'เหตุผลที่เคสนี้ไม่ได้รัน',
  blockedEvidence: 'หลักฐาน',
  blockedNoRun: 'ไม่มีการรันเกิดขึ้น จึงไม่มีขั้นตอน ภาพหน้าจอ วิดีโอ หรือข้อบกพร่องใด ๆ ไม่มีสิ่งใดในหน้านี้เป็นข้อค้นพบเกี่ยวกับแอปพลิเคชันที่ทดสอบ',
  blockedNoReason: 'ledger ไม่ได้บันทึกเหตุผลของเคสนี้',
  verdict: { passed: 'ผ่าน', 'pass**': 'ผ่านแบบมีข้อสังเกต', 'test failed': 'ตก', 'test failed (dead-end)': 'ตก (ไปไม่ถึง)', 'system error': 'ระบบผิดพลาด', 'needs review': 'รอตรวจ', 'recorded only': 'บันทึกอย่างเดียว', blocked: 'ถูกกั้น', 'never ran': 'ไม่ได้รัน' },
  pill: { passed: 'ผ่าน', failed: 'ตก', 'dead-end': 'ไปไม่ถึง', error: 'ผิดพลาด', skipped: 'ข้าม' },
};

export function caseLabels(lang: ReportLang): Labels {
  return lang === 'th' ? TH : EN;
}

/* ----------------------------------------------------------------- files */

export type CaseSidecarKind = 'query' | 'before' | 'after' | 'evidence';

/** `<case slug>-db-query.sql`, `-db-before.csv`, `-db-after.csv`, `-db-evidence.csv` — flat, beside the page. */
export function caseSidecarName(caseId: string, kind: CaseSidecarKind): string {
  const base = catalogCaseExportName(caseId);
  return kind === 'query' ? `${base}-db-query.sql` : `${base}-db-${kind}.csv`;
}

export interface CaseSidecars {
  query: string | null;
  before: string | null;
  after: string | null;
  evidence: string | null;
}

interface DbStep {
  step: ProofStep;
  evidence: DbEvidence;
}

function dbSteps(bundle: ProofBundle | null): DbStep[] {
  if (bundle === null) return [];
  const out: DbStep[] = [];
  for (const step of bundle.steps) {
    if (step.superseded) continue;
    const evidence = dbEvidence(step);
    if (evidence !== null) out.push({ step, evidence });
  }
  return out;
}

interface ChangeRow {
  stepIndex: number;
  change: StepDbChange;
}

/** Every baseline table as the LAST backend step left it — cumulative, like `dbChanges` itself. */
function latestChanges(bundle: ProofBundle | null): ChangeRow[] {
  if (bundle === null) return [];
  const byTable = new Map<string, ChangeRow>();
  for (const step of bundle.steps) {
    if (step.superseded || step.dbChanges === undefined) continue;
    for (const change of step.dbChanges) byTable.set(change.table, { stepIndex: step.index, change });
  }
  return [...byTable.values()];
}

/** One SQL comment line; a newline inside a recorded value must not end the comment early. */
function sqlComment(text: string): string {
  return `-- ${text.replace(/\r?\n/g, ' ')}`;
}

function csvCell(value: unknown): string {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csv(header: readonly string[], rows: readonly (readonly unknown[])[]): string | null {
  if (rows.length === 0) return null;
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}

/**
 * The sidecar contents, from the bundle alone. Null for a file that would be
 * empty — a chip for a file with no rows would be a claim about evidence.
 */
export function caseSidecars(c: CatalogReportCase, lang: ReportLang = 'en'): CaseSidecars {
  const L = caseLabels(lang);
  const checks = dbSteps(c.bundle);
  const changes = latestChanges(c.bundle);

  const sql: string[] = [];
  for (const { step, evidence } of checks) {
    if (evidence.statements.length === 0) continue;
    const scope = [evidence.target === null ? '' : evidence.target, evidence.where === null ? '' : `where ${evidence.where}`].filter((s) => s !== '').join(' ');
    sql.push(sqlComment(`${L.stepWord} ${step.index}: ${evidence.kind}${scope === '' ? '' : ` on ${scope}`}`));
    for (const statement of evidence.statements) {
      for (const [i, p] of statement.params.entries()) sql.push(sqlComment(`$${i + 1} = ${p}`));
      sql.push(statement.sql.trimEnd().endsWith(';') ? statement.sql.trimEnd() : `${statement.sql.trimEnd()};`);
    }
    sql.push('');
  }
  const query =
    sql.length === 0
      ? null
      : `${sqlComment(c.id)}\n-- the statements this case's checks sent, parameterised, built from schema-validated identifiers,\n-- run on the run's read-only session; bound values as redacted at the source. No DSN, no credential.\n-- wrapped here so the file can be replayed without writing anything.\nBEGIN TRANSACTION READ ONLY;\n\n${sql.join('\n')}\nROLLBACK;\n`;

  const beforeRows: unknown[][] = [];
  const afterRows: unknown[][] = [];
  for (const { stepIndex, change } of changes) {
    beforeRows.push([stepIndex, change.table, 'count', '', 'rows', change.baselineRows]);
    afterRows.push([stepIndex, change.table, 'count', '', 'rows', change.rows]);
    for (const s of change.sample ?? []) {
      const target = s.kind === 'deleted' ? beforeRows : afterRows;
      for (const [field, value] of Object.entries(s.row)) target.push([stepIndex, change.table, s.kind, s.key, field, value]);
    }
  }
  const dbHeader = ['step', 'table', 'kind', 'key', 'field', 'value'];

  const evidenceRows: unknown[][] = [];
  for (const { step, evidence } of checks) {
    const base = [step.index, evidence.kind, evidence.target ?? '', evidence.where ?? '', evidence.expected ?? '', evidence.observed ?? ''];
    evidenceRows.push([...base, '', '', '']);
    evidence.rows.forEach((row, r) => {
      evidence.columns.forEach((column, i) => {
        evidenceRows.push([...base, r + 1, column, row[i] ?? '']);
      });
    });
  }
  return {
    query,
    before: csv(dbHeader, beforeRows),
    after: csv(dbHeader, afterRows),
    evidence: csv(['step', 'check', 'table', 'where', 'expected', 'observed', 'row', 'field', 'value'], evidenceRows),
  };
}

/* ------------------------------------------------------------------ page */

export interface CasePageInput {
  case: CatalogReportCase;
  /** The catalog's title and key — the eyebrow. */
  title: string;
  runKey: string | null;
  lang: ReportLang;
  /** `../<runKey slug>.html` — where the mast's link back goes. */
  indexHref: string;
  /** Which sidecars exist beside the page (from `caseSidecars`), so a chip is never a dead link. */
  sidecars: CaseSidecars;
  /**
   * The recording as a file beside the page (the catalog's spilled `.webm`),
   * when one was written; otherwise the bundle's own data is embedded.
   */
  videoHref?: string | null | undefined;
}

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 120) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s`;
}

function ai(text: string | undefined, tag: 'p' | 'span' = 'span', cls = ''): string {
  if (text === undefined || text === '') return '';
  return `<${tag} class="ai${cls === '' ? '' : ` ${cls}`}">${esc(text)}</${tag}>`;
}

function pct(n: number, total: number): string {
  return total === 0 ? '0' : ((n / total) * 100).toFixed(2);
}

/**
 * How the case is titled — the sheet's own id when the run qualified it, and
 * the name with a leading repeat of either id removed. One derivation, so the
 * mast and the pre-read table cannot print the id once and twice.
 */
function caseTitle(c: CatalogReportCase, stamped: { sheetCaseId: string | null }): { shown: string; qualified: string | null; name: string } {
  const id = displayCaseId(c.id, c.sheetCaseId ?? stamped.sheetCaseId);
  let name = c.name;
  for (const lead of [c.id, id.shown]) {
    if (lead !== '' && name.startsWith(lead)) name = name.slice(lead.length).replace(/^[\s—–:-]+/, '');
  }
  return { ...id, name };
}

/**
 * The items of a narrative field the model itself enumerated ("1. … 2. …"),
 * or null for text that is not a list. The run is taken only from a leading
 * `1.`/`1)` and only while the numbers ascend by one, so a date, a decimal or
 * a stray "2)" mid-sentence cannot split a paragraph; text before the first
 * marker, an empty item, or fewer than two items all mean "not a list", and
 * such text renders exactly as it did before this existed. Nothing is
 * dropped: every character after the first marker belongs to some item.
 */
function enumeratedItems(text: string): string[] | null {
  const marker = /(^|\s)(\d{1,2})[.)]\s+/g;
  const marks: { start: number; body: number; n: number }[] = [];
  for (let m = marker.exec(text); m !== null; m = marker.exec(text)) {
    marks.push({ start: m.index + m[1]!.length, body: m.index + m[0].length, n: Number(m[2]) });
  }
  if (marks.length < 2 || marks[0]!.n !== 1 || text.slice(0, marks[0]!.start).trim() !== '') return null;
  const run = [marks[0]!];
  for (const mark of marks.slice(1)) if (mark.n === run.length + 1) run.push(mark);
  if (run.length < 2) return null;
  const items = run.map((mark, i) => text.slice(mark.body, i + 1 < run.length ? run[i + 1]!.start : undefined).trim());
  return items.some((item) => item === '') ? null : items;
}

/**
 * A model-written field: an ordered list when its own text is enumerated, the
 * single element otherwise. Marked `ai` either way — restructuring what was
 * recorded is layout, and the words stay the model's.
 */
function narrative(text: string | undefined, tag: 'strong' | 'span' = 'span', cls = ''): string {
  if (text === undefined || text === '') return '';
  const klass = cls === '' ? 'ai' : `${cls} ai`;
  const items = enumeratedItems(text);
  if (items === null) return `<${tag} class="${klass}">${esc(text)}</${tag}>`;
  return `<ol class="${klass} enum">${items.map((item) => `<li>${esc(item)}</li>`).join('')}</ol>`;
}

function pillOf(step: ProofStep, L: Labels): string {
  const cls = step.status === 'passed' ? 'pass' : step.status === 'skipped' ? 'na' : 'fail';
  return `<span class="pill ${cls}">${esc(L.pill[step.status] ?? step.status)}</span>`;
}

function stepTitle(step: ProofStep): string {
  const target = stepTarget(step);
  const own = `${esc(step.intent ?? step.action)}${step.intent ? '' : target ? ` <code>${esc(target)}</code>` : ''}`;
  // The author's intent is the row; a narration is a reading of it and comes after, marked.
  const narrated = stepNarration(step);
  return narrated === null ? own : `${own}<span class="det ai">${esc(narrated.text)}</span>`;
}

function stepEvidence(step: ProofStep, L: Labels): string {
  const parts: string[] = [];
  const comparison = expectedActual(step);
  if (comparison !== null) parts.push(esc(comparison));
  for (const seen of observedEvidence(step)) parts.push(`<code>${esc(seen.text)}</code>`);
  const db = dbEvidence(step);
  if (db !== null && db.observed !== null) parts.push(`db: ${esc(db.observed)}`);
  const described = describeTarget(step.target);
  if (described !== null && parts.length === 0) parts.push(esc(described));
  const value = describeValueSource(step);
  if (value !== null) parts.push(esc(value));
  if (step.status !== 'passed' && step.status !== 'skipped' && step.error) parts.push(`<code>${esc(step.error.split('\n')[0])}</code>`);
  if (step.status === 'skipped' && parts.length === 0) parts.push(esc(L.covNa));
  return parts.join(' · ');
}

function mast(input: CasePageInput, L: Labels, bundle: ProofBundle | null): string {
  const c = input.case;
  const chip = verdictChipOf(c);
  const stamped = provenanceExtras(bundle);
  const label = sheetLabel({ sheet: c.sheet ?? stamped.sheet, category: c.category ?? stamped.category });
  const { shown, name } = caseTitle(c, stamped);
  const when = bundle?.finishedAt ?? bundle?.startedAt ?? null;
  const narrative = bundle?.narrative;
  const verdictColour = chip.cls === 'pass' ? 'var(--pass)' : chip.cls === 'fail' || chip.cls === 'error' ? 'var(--app)' : 'var(--case)';
  return (
    `<header class="mast">` +
    `<p class="eyebrow">${esc(L.eyebrow)} · ${esc(input.title)}${when === null ? '' : ` · ${esc(when)}`}</p>` +
    `<h1>${esc(shown)}${name === '' ? '' : ` — ${esc(name)}`}</h1>` +
    (narrative?.lede ? `<p class="sub ai">${esc(narrative.lede)}</p>` : `<p class="sub">${esc(L.sub)}</p>`) +
    `<p class="idline">` +
    `<span>${esc(L.idCase)} <b>${esc(c.id)}</b></span>` +
    (c.scenario === '' ? '' : `<span>${esc(L.idScenario)} <b>${esc(c.scenario)}</b></span>`) +
    (label === null ? '' : `<span>${esc(L.idSheet)} <b>${esc(label)}</b></span>`) +
    `<span>${esc(L.idVerdict)} <b style="color:${verdictColour}">${esc(L.verdict[chip.label] ?? chip.label)}</b></span>` +
    `<span><a href="${esc(input.indexHref)}">${esc(L.backToIndex)}</a></span>` +
    `</p>` +
    (narrative === undefined ? '' : `<p class="ainote">${esc(L.aiNote(narrative.by))}</p>`) +
    `</header>`
  );
}

function preRead(input: CasePageInput, L: Labels, bundle: ProofBundle | null): string {
  const c = input.case;
  const n = bundle?.narrative;
  const { shown, name } = caseTitle(c, provenanceExtras(bundle));
  const variables = Object.entries(bundle?.variables ?? {});
  // A recorded value is evidence and stays in `code`; "none recorded" is the
  // absence of one, so it reads as the note it is rather than as a value.
  const data =
    variables.length === 0
      ? `<span class="det">${esc(L.noneRecorded)}</span>`
      : `<strong><code>${esc(variables.map(([k, v]) => `${k} = ${v}`).join(' · '))}</code></strong>`;
  const expected = narrative(n?.expected, 'strong');
  return (
    `<h2 class="sec">${esc(L.preRead)}</h2><div class="tw"><table class="pre"><thead><tr><th>${esc(L.thTopic)}</th><th>${esc(L.thDetail)}</th></tr></thead><tbody>` +
    `<tr><td class="fld">${esc(L.testCase)}</td><td><strong><code>${esc(shown)}</code>${name === '' ? '' : ` · ${esc(name)}`}</strong>${narrative(n?.summary, 'span', 'det')}</td></tr>` +
    `<tr><td class="fld">${esc(L.testData)}</td><td>${data}${narrative(n?.testData, 'span', 'det')}</td></tr>` +
    `<tr><td class="fld">${esc(L.expected)}</td><td>${expected === '' ? `<span class="det">${esc(L.noneRecorded)}</span>` : expected}</td></tr>` +
    `</tbody></table></div>`
  );
}

function coverage(L: Labels, bundle: ProofBundle | null): string {
  if (bundle === null) return '';
  const steps = bundle.steps.filter((s) => !s.superseded);
  if (steps.length === 0) return '';
  // A passed assertion proved a claim; a passed action only got the run there.
  const pass = steps.filter((s) => s.status === 'passed' && isAssertionStepAction(s.action)).length;
  const obs = steps.filter((s) => s.status === 'passed' && !isAssertionStepAction(s.action)).length;
  const fail = steps.filter((s) => s.status === 'failed' || s.status === 'dead-end' || s.status === 'error').length;
  const na = steps.filter((s) => s.status === 'skipped').length;
  // One paragraph, not the verbatim notes: the model's bounded summary of them
  // where there is one, and the notes themselves only when the run has no
  // narrative to summarise them (`--no-case-narrative`, or a role with no key).
  const summary = runNotesSummary(bundle);
  const caveat =
    summary === null
      ? ''
      : summary.by === null
        ? `<p class="caveat">${esc(summary.text)}</p>`
        : ai(summary.text, 'p', 'caveat');
  return (
    `<section class="cov"><h2>${esc(L.coverage(steps.length))}</h2>` +
    `<div class="bar" role="img" aria-label="${esc(`${L.covPass} ${pass} ${L.covObs} ${obs} ${L.covFail} ${fail} ${L.covNa} ${na}`)}">` +
    `<span class="b-pass" style="width:${pct(pass, steps.length)}%"></span><span class="b-obs" style="width:${pct(obs, steps.length)}%"></span>` +
    `<span class="b-fail" style="width:${pct(fail, steps.length)}%"></span><span class="b-na" style="width:${pct(na, steps.length)}%"></span></div>` +
    `<div class="key"><span><i style="background:var(--pass)"></i>${esc(L.covPass)} <b>${pass}</b></span>` +
    `<span><i style="background:var(--accent)"></i>${esc(L.covObs)} <b>${obs}</b></span>` +
    `<span><i style="background:var(--app)"></i>${esc(L.covFail)} <b>${fail}</b></span>` +
    `<span><i style="background:var(--line)"></i>${esc(L.covNa)} <b>${na}</b></span></div>` +
    caveat +
    `</section>`
  );
}

/** The side the seal files a defect under — the same rule as `ProofSummary`'s attribution: category `backend` wins, then the step's own tier. */
function defectSide(bundle: ProofBundle, d: ProofBundle['defects'][number]): 'backend' | 'frontend' {
  if (d.category === 'backend') return 'backend';
  const step = d.stepIndex === undefined ? undefined : bundle.steps.find((s) => s.index === d.stepIndex && !s.superseded);
  return step !== undefined && (BACKEND_TIER_ACTIONS as ReadonlySet<string>).has(step.action) ? 'backend' : 'frontend';
}

function tickets(L: Labels, bundle: ProofBundle | null): string {
  if (bundle === null) return '';
  const narrated = bundle.narrative?.tickets ?? [];
  const rows: string[] = [];
  const worded = new Set<string>();
  for (const d of bundle.defects) {
    const t = narrated.find((x) => x.defectId === d.id);
    if (t !== undefined) worded.add(d.id);
    const title = t?.title ?? d.title;
    const detail = t?.detail ?? d.detail;
    const owner = t?.owner ?? defectSide(bundle, d);
    rows.push(
      `<tr><td><span class="tag app">${esc(L.tagApp)}</span></td>` +
      `<td><strong${t ? ' class="ai"' : ''}>${esc(title)}</strong><span class="det${t ? ' ai' : ''}">${esc(detail)}</span>` +
      // The recorded defect stays on the row under the model's wording: the
      // seal's title is the finding, the wording is a reading of it.
      (t ? `<span class="det"><code>${esc(d.id)}</code> ${esc(d.title)} — ${esc(d.detail)}</span>` : '') +
      `<span class="det"><code>${esc(d.id)}</code> · ${esc(d.category)} · ${esc(d.severity)}${d.stepIndex === undefined ? '' : ` · ${esc(L.stepWord)} ${d.stepIndex}`}</span></td>` +
      `<td class="own">${esc(owner)}</td></tr>`,
    );
  }
  for (const t of narrated) {
    if (t.defectId !== undefined && worded.has(t.defectId)) continue;
    rows.push(
      `<tr><td><span class="tag ${t.kind === 'test' ? 'test' : 'app'}">${esc(t.kind === 'test' ? L.tagTest : L.tagApp)}</span></td>` +
      `<td><strong class="ai">${esc(t.title)}</strong><span class="det ai">${esc(t.detail)}</span></td><td class="own">${esc(t.owner)}</td></tr>`,
    );
  }
  if (rows.length === 0) return '';
  return `<h2 class="sec">${esc(L.tickets)}</h2><div class="tw"><table><thead><tr><th>${esc(L.thKind)}</th><th>${esc(L.thTicket)}</th><th>${esc(L.thOwner)}</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

function dataUsed(L: Labels, bundle: ProofBundle | null): string {
  if (bundle === null) return '';
  const rows: string[] = [];
  for (const [name, value] of Object.entries(bundle.variables ?? {})) {
    rows.push(`<tr><td class="fld">${esc(name)}</td><td class="lab">${esc(value)}</td><td class="note">${esc(L.savedByRun)}</td></tr>`);
  }
  for (const step of bundle.steps) {
    if (step.superseded || step.action !== 'signIn') continue;
    const persona = signInPersona(step);
    if (persona === null) continue;
    rows.push(`<tr><td class="fld">${esc(L.signedInAs)}</td><td class="lab">${esc(persona)}</td><td class="note">${esc(L.stepWord)} ${step.index}</td></tr>`);
  }
  if (rows.length === 0) return '';
  return (
    `<h2 class="sec">${esc(L.dataUsed)}</h2><p class="lede">${esc(L.dataLede)}</p>` +
    `<div class="tw"><table><thead><tr><th>${esc(L.thItem)}</th><th>${esc(L.thValue)}</th><th>${esc(L.thSource)}</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`
  );
}

function dbBeforeAfter(L: Labels, bundle: ProofBundle | null): string {
  const changes = latestChanges(bundle);
  if (changes.length === 0) return '';
  const rows = changes.map(({ stepIndex, change }) => {
    const parts: string[] = [];
    if (change.inserted) parts.push(`+${change.inserted}`);
    if (change.deleted) parts.push(`−${change.deleted}`);
    if (change.updated) parts.push(`~${change.updated}`);
    const what = !change.changed ? L.unchanged : parts.length > 0 ? parts.join(' ') : `${change.baselineRows} → ${change.rows}`;
    const sample = (change.sample ?? [])
      .slice(0, 3)
      .map((s) => `<code>${esc(s.kind)} ${esc(s.key)}</code>`)
      .join(' ');
    return (
      `<tr${change.changed ? '' : ' class="na"'}><td class="fld">${esc(change.table)}</td><td class="lab">${change.baselineRows} ${esc(L.rowsWord)}</td>` +
      `<td class="lab">${change.rows} ${esc(L.rowsWord)}</td><td class="note">${esc(what)} · ${esc(L.asOfStep)} ${stepIndex}${sample === '' ? '' : ` · ${esc(L.sampleWord)}: ${sample}`}</td></tr>`
    );
  });
  const lastProbe = Math.max(...changes.map((c) => c.stepIndex));
  const probeFailed = (bundle?.steps ?? []).some((s) => !s.superseded && s.index > lastProbe && s.dbProbeError !== undefined);
  return (
    `<h2 class="sec">${esc(L.dbBeforeAfter)}</h2><p class="lede">${esc(L.dbLede)}</p>` +
    `<div class="tw"><table><thead><tr><th>${esc(L.thTable)}</th><th>${esc(L.thBefore)}</th><th>${esc(L.thAfter)}</th><th>${esc(L.thChange)}</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>` +
    (probeFailed ? `<p class="lede muted">${esc(L.probeFailed)}</p>` : '')
  );
}

function chip(href: string | null, file: string, label: string): string {
  const text = `<code>${esc(file)}</code> · ${esc(label)}`;
  return href === null ? `<span class="chip muted">${text}</span>` : `<a class="chip" href="${esc(href)}" download>${text}</a>`;
}

function queryBlock(check: DbStep, L: Labels): string {
  const { step, evidence } = check;
  const scope = [evidence.target ?? '', evidence.where === null ? '' : `where ${evidence.where}`].filter((s) => s !== '').join(' · ');
  const head =
    `<div class="qhead"><span class="fno">${esc(L.stepWord)} ${step.index}</span> <strong>db ${esc(evidence.kind)}</strong>${scope === '' ? '' : ` <code>${esc(scope)}</code>`}` +
    (evidence.expected === null ? '' : `<span class="det">expected <code>${esc(evidence.expected)}</code>${evidence.observed === null ? '' : ` · observed <code>${esc(evidence.observed)}</code>`}</span>`) +
    (evidence.polledMs === null ? '' : `<span class="det">${esc(L.polled)} ${esc(fmtMs(evidence.polledMs))}</span>`) +
    (evidence.note === null ? '' : `<span class="det">${esc(evidence.note)}</span>`) +
    `</div>`;
  const sqlText = evidence.statements
    .map((s) => {
      const params = s.params.map((p, i) => sqlComment(`$${i + 1} = ${p}`)).join('\n');
      return `${params === '' ? '' : `${params}\n`}${s.sql.trimEnd()}${s.sql.trimEnd().endsWith(';') ? '' : ';'}`;
    })
    .join('\n\n');
  const pre = sqlText === '' ? '' : `<pre class="sql"><code>${esc(sqlText)}</code></pre>`;
  const rows =
    evidence.rows.length === 0
      ? ''
      : `<div class="tw"><table><caption>${esc(evidence.sample === null ? L.rowsReturned : `${L.rowsReturned} — ${evidence.sample}`)}</caption>` +
        `<thead><tr>${evidence.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>` +
        `<tbody>${evidence.rows.map((r) => `<tr>${r.map((cell) => `<td class="lab">${esc(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  return `<section class="query">${head}${pre}${rows}</section>`;
}

function queries(input: CasePageInput, L: Labels): string {
  const checks = dbSteps(input.case.bundle);
  if (checks.length === 0) return '';
  const id = input.case.id;
  const s = input.sidecars;
  const chips =
    `<div class="chips">` +
    chip(s.query === null ? null : caseSidecarName(id, 'query'), 'db-query.sql', L.chipQuery) +
    chip(s.before === null ? null : caseSidecarName(id, 'before'), 'db-before.csv', L.chipBefore) +
    chip(s.after === null ? null : caseSidecarName(id, 'after'), 'db-after.csv', L.chipAfter) +
    chip(s.evidence === null ? null : caseSidecarName(id, 'evidence'), 'db-evidence.csv', L.chipEvidence) +
    `</div>`;
  return `<h2 class="sec">${esc(L.queries)}</h2><p class="lede">${esc(L.queriesLede)}</p>${chips}${checks.map((c) => queryBlock(c, L)).join('')}`;
}

function backendCalls(L: Labels, bundle: ProofBundle | null): string {
  if (bundle === null) return '';
  const blocks: string[] = [];
  for (const step of bundle.steps) {
    if (step.superseded || step.request === undefined) continue;
    const r = step.request;
    const status = r.status === null ? L.noResponse : `${r.status}${r.statusText ? ` ${r.statusText}` : ''}`;
    const part = (title: string, body: string | undefined): string =>
      body === undefined || body === '' ? '' : `<div class="fno">${esc(title)}</div><pre class="sql"><code>${esc(body)}</code></pre>`;
    blocks.push(
      `<section class="query"><div class="qhead"><span class="fno">${esc(L.stepWord)} ${step.index}</span> <strong>HTTP ${esc(r.method)}</strong> <code>${esc(r.url)}</code>` +
      `<span class="det">${esc(status)} · ${esc(fmtMs(r.durationMs))}${r.error ? ` · ${esc(r.error)}` : ''}${r.saved && r.saved.length > 0 ? ` · saved ${esc(r.saved.join(', '))}` : ''}</span></div>` +
      part(L.requestWord, r.requestBody) +
      part(L.responseWord, r.responseBody) +
      `</section>`,
    );
  }
  if (blocks.length === 0) return '';
  return `<h2 class="sec">${esc(L.backendCalls)}</h2><p class="lede">${esc(L.backendLede)}</p>${blocks.join('')}`;
}

function questions(L: Labels, bundle: ProofBundle | null): string {
  const qs = bundle?.narrative?.questions ?? [];
  if (qs.length === 0) return '';
  return (
    `<h2 class="sec">${esc(L.questions)}</h2><div class="ans">` +
    qs
      .map(
        (q, i) =>
          `<article><h3>${i + 1}</h3><p class="q ai">${esc(q.question)}</p><p class="a ai">${esc(q.answer)}</p>${q.evidence === '' ? '' : `<p class="how ai">${esc(q.evidence)}</p>`}</article>`,
      )
      .join('') +
    `</div>`
  );
}

function outcomes(L: Labels, bundle: ProofBundle | null, c: CatalogReportCase): string {
  const steps = (bundle?.steps ?? []).filter((s) => !s.superseded);
  if (steps.length === 0) {
    return `<h2 class="sec">${esc(L.outcomes(0))}</h2><p class="lede">${esc(c.reason ?? L.noneRecorded)}</p>`;
  }
  const rows = steps
    .map(
      (s) =>
        `<tr${s.status === 'skipped' ? ' class="na"' : ''}><td class="num">${s.index}</td><td>${stepTitle(s)}<span class="det"><code>${esc(s.action)}</code> · ${esc(fmtMs(s.durationMs))}</span></td>` +
        `<td>${pillOf(s, L)}</td><td class="note">${stepEvidence(s, L)}</td></tr>`,
    )
    .join('');
  return `<h2 class="sec">${esc(L.outcomes(steps.length))}</h2><div class="tw"><table><thead><tr><th>${esc(L.thNo)}</th><th>${esc(L.thStep)}</th><th>${esc(L.thResult)}</th><th>${esc(L.thEvidence)}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function film(input: CasePageInput, L: Labels, bundle: ProofBundle | null): string {
  if (bundle === null) return '';
  const clips: { caption: string; src: string | null; webm: string | null; omitted: string | null }[] = [];
  const personas = bundle.videos ?? [];
  if (personas.length > 0) {
    for (const v of personas) clips.push({ caption: v.persona, src: null, webm: v.video.data ?? null, omitted: v.video.omitted ?? null });
  } else if (bundle.video !== undefined) {
    const href = input.videoHref ?? null;
    clips.push({ caption: L.filmLede, src: href, webm: href === null ? (bundle.video.data ?? null) : null, omitted: bundle.video.omitted ?? null });
  }
  if (clips.length === 0) return '';
  const figures = clips.map((clip) => {
    const player =
      clip.src !== null
        ? `<video controls preload="metadata" playsinline src="${esc(clip.src)}"></video>`
        : clip.webm !== null
          ? `<video controls preload="none" playsinline data-webm="${esc(clip.webm)}"></video>`
          : `<div class="muted">${esc(clip.omitted ?? L.noneRecorded)}</div>`;
    return `<figure class="vid">${player}<figcaption><strong>${esc(clip.caption)}</strong></figcaption></figure>`;
  });
  return `<h2 class="sec">${esc(L.film)}</h2><p class="lede">${esc(L.filmLede)}</p><div class="vidgrid">${figures.join('')}</div>`;
}

function stills(L: Labels, bundle: ProofBundle | null): string {
  const shots = (bundle?.steps ?? []).filter((s) => !s.superseded && typeof s.screenshot === 'string' && s.screenshot !== '');
  if (shots.length === 0) return '';
  const frames = shots
    .map((s) => {
      const target = stepTarget(s);
      return (
        `<figure class="frame"><img src="data:image/jpeg;base64,${esc(s.screenshot)}" alt="${esc(s.intent ?? s.action)}" loading="lazy">` +
        `<figcaption><span class="fno">#${s.index}</span><strong>${esc(s.intent ?? s.action)}</strong>` +
        `<span class="fsub">${esc(L.pill[s.status] ?? s.status)}${target ? ` · <code>${esc(target)}</code>` : ''}</span></figcaption></figure>`
      );
    })
    .join('');
  return `<h2 class="sec">${esc(L.stills)}</h2><p class="lede">${esc(L.stillsLede)}</p><div class="strip">${frames}</div>`;
}

function footer(input: CasePageInput, L: Labels): string {
  const id = input.case.id;
  const files: string[] = [`<code>${esc(casePageName(id))}</code>`];
  if (input.case.verdict === 'passed') files.push(`<a href="${esc(`${catalogCaseExportName(id)}.xlsx`)}" download><code>${esc(`${catalogCaseExportName(id)}.xlsx`)}</code></a>`);
  for (const kind of ['query', 'before', 'after', 'evidence'] as const) {
    if (input.sidecars[kind] !== null) files.push(`<a href="${esc(caseSidecarName(id, kind))}" download><code>${esc(caseSidecarName(id, kind))}</code></a>`);
  }
  return `<footer><p><strong>${esc(L.footer)}:</strong> ${files.join(' · ')} · <a href="${esc(input.indexHref)}">${esc(L.backToIndex)}</a></p></footer>`;
}

/** The catalog player, restated: Chrome refuses a `data:` video silently, so the bytes go through a Blob. */
const PLAYER = `
function wowHydrate(v){if(v.dataset.wowReady||!v.dataset.webm)return;var b=atob(v.dataset.webm),a=new Uint8Array(b.length);for(var i=0;i<b.length;i++)a[i]=b.charCodeAt(i);v.src=URL.createObjectURL(new Blob([a],{type:'video/webm'}));v.dataset.wowReady='1';}
document.querySelectorAll('video[data-webm]').forEach(wowHydrate);
`;

const STYLE = `
:root{--ground:#eef1f5;--surface:#fff;--sunk:#e4e9ef;--line:#ccd5df;--line-soft:#dde3ea;--ink:#14202b;--ink-2:#465768;--ink-3:#6f8093;--accent:#0d6b8a;--app:#b52d18;--app-bg:#fbeae7;--case:#8a5a06;--case-bg:#fcf2e2;--test:#474596;--test-bg:#ecebf8;--pass:#1a6f45;--pass-bg:#e6f3ec;--sans:"IBM Plex Sans Thai","IBM Plex Sans",-apple-system,"Segoe UI",sans-serif;--mono:"IBM Plex Mono",ui-monospace,Menlo,monospace}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){--ground:#0d141b;--surface:#151f29;--sunk:#1c2733;--line:#2c3a48;--line-soft:#243040;--ink:#e3eaf1;--ink-2:#9dafc0;--ink-3:#7b8d9e;--accent:#54b3d3;--app:#f5806c;--app-bg:#331915;--case:#e0a950;--case-bg:#2e2412;--test:#a5a2f0;--test-bg:#1f1e3a;--pass:#5cc48d;--pass-bg:#12291d}}
*{box-sizing:border-box}body{margin:0;background:var(--ground);color:var(--ink);font-family:var(--sans);font-size:16px;line-height:1.68;-webkit-font-smoothing:antialiased}
main{max-width:1000px;margin:0 auto;padding:0 22px 90px}code,.mono{font-family:var(--mono);font-size:.86em;font-variant-numeric:tabular-nums}
.mast{border-bottom:2px solid var(--ink);padding:34px 0 18px;margin-bottom:26px}
.eyebrow{font-family:var(--mono);font-size:.72rem;letter-spacing:.13em;text-transform:uppercase;color:var(--ink-3);margin:0 0 10px}
.mast h1{font-size:2.15rem;line-height:1.12;margin:0;letter-spacing:-.02em;text-wrap:balance}.mast .sub{color:var(--ink-2);margin:8px 0 0;max-width:72ch}
.idline{display:flex;flex-wrap:wrap;gap:8px 26px;margin-top:18px;font-family:var(--mono);font-size:.78rem;color:var(--ink-2)}.idline b{color:var(--ink);font-weight:600}.idline a{color:var(--accent)}
.ainote{margin:14px 0 0;font-size:.82rem;color:var(--ink-3)}
.ai{border-left:3px solid var(--test);padding-left:9px}strong.ai,span.ai{display:inline-block}
.cov{background:var(--surface);border:1px solid var(--line);border-radius:3px;padding:20px 22px;margin:34px 0}
.cov h2{font-size:.78rem;font-family:var(--mono);letter-spacing:.11em;text-transform:uppercase;color:var(--ink-3);margin:0 0 14px;font-weight:600}
.bar{display:flex;height:16px;border-radius:2px;overflow:hidden;background:var(--sunk)}.bar span{display:block}.bar .b-pass{background:var(--pass)}.bar .b-obs{background:var(--accent)}.bar .b-fail{background:var(--app)}.bar .b-na{background:var(--line)}
.key{display:flex;flex-wrap:wrap;gap:6px 22px;margin-top:14px;font-size:.86rem;color:var(--ink-2)}.key i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:7px}.key b{color:var(--ink);font-family:var(--mono)}
.cov p.caveat{margin:16px 0 0;padding-top:14px;border-top:1px solid var(--line-soft);font-size:.9rem;color:var(--ink-2)}
h2.sec{font-size:1.32rem;margin:40px 0 12px;letter-spacing:-.01em}p.lede{color:var(--ink-2);margin:0 0 20px;max-width:76ch}
.tw{overflow-x:auto;border:1px solid var(--line);border-radius:3px;background:var(--surface)}
table{width:100%;border-collapse:collapse;font-size:.9rem;min-width:620px}caption{text-align:left;font-family:var(--mono);font-size:.68rem;letter-spacing:.09em;text-transform:uppercase;color:var(--ink-3);padding:10px 14px 4px}
th{text-align:left;font-family:var(--mono);font-size:.68rem;letter-spacing:.09em;text-transform:uppercase;color:var(--ink-3);font-weight:600;padding:11px 14px;border-bottom:1px solid var(--line);background:var(--sunk)}
td{padding:10px 14px;border-bottom:1px solid var(--line-soft);vertical-align:top}tr:last-child td{border-bottom:none}
td.num{font-family:var(--mono);font-weight:600;white-space:nowrap}td.fld{font-weight:500;white-space:nowrap}td.lab{font-family:var(--mono);font-size:.83rem}td.note{color:var(--ink-2);font-size:.86rem}
td .det,.qhead .det{display:block;color:var(--ink-2);font-size:.85rem;margin-top:3px}td.own{white-space:nowrap;font-family:var(--mono);font-size:.78rem;color:var(--ink-2)}
ol.enum{display:block;margin:0;padding:0 0 0 9px;font-weight:600;list-style-position:inside}ol.enum li{margin:0 0 5px;padding-left:2px;text-indent:-1.5em;margin-left:1.5em}ol.enum li:last-child{margin-bottom:0}ol.enum.det{font-weight:400}
table.pre td{padding:13px 14px;line-height:1.62}table.pre td:last-child{max-width:82ch}table.pre .det{margin-top:6px}
.tag,.pill{font-family:var(--mono);font-size:.68rem;letter-spacing:.05em;padding:2px 8px;border-radius:2px;font-weight:600;white-space:nowrap}
.tag.app,.pill.fail{background:var(--app-bg);color:var(--app)}.tag.test,.pill.obs{background:var(--test-bg);color:var(--test)}.pill.pass{background:var(--pass-bg);color:var(--pass)}.pill.na{background:var(--sunk);color:var(--ink-3)}
tr.na td:not(.num){color:var(--ink-3)}
.chips{display:flex;flex-wrap:wrap;gap:10px;margin:0 0 18px}.chip{font-family:var(--mono);font-size:.82rem;padding:8px 14px;border:1px solid var(--line);border-radius:3px;background:var(--surface);color:var(--accent);text-decoration:none}.chip.muted{color:var(--ink-3)}a.chip:hover{text-decoration:underline}
.query{margin:0 0 18px}.qhead{margin:0 0 8px}.qhead .fno{margin-right:6px}
pre.sql{margin:0 0 10px;padding:18px 22px;background:var(--surface);border:1px solid var(--line);border-radius:3px;overflow-x:auto;font-family:var(--mono);font-size:.84rem;line-height:1.7;white-space:pre}
.ans{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}.ans article{background:var(--surface);border:1px solid var(--line);border-top:3px solid var(--accent);border-radius:3px;padding:16px 18px}
.ans h3{font-family:var(--mono);font-size:.82rem;margin:0 0 4px;color:var(--accent)}.ans .q{font-size:.92rem;color:var(--ink-2);margin:0 0 12px}.ans .a{font-size:1.02rem;font-weight:600;margin:0 0 8px;line-height:1.45}.ans .how{font-size:.85rem;color:var(--ink-3);margin:0}
.vidgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}.vid{margin:0}.vid video{width:100%;display:block;border:1px solid var(--line);border-radius:3px;background:#000}.vid figcaption{color:var(--ink-2);font-size:.86rem;margin-top:9px}
.strip{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(310px,1fr));margin-top:6px}.frame{margin:0;background:var(--surface);border:1px solid var(--line);border-radius:3px;overflow:hidden;display:flex;flex-direction:column}
.frame img{width:100%;height:auto;display:block;border-bottom:1px solid var(--line-soft)}.frame figcaption{padding:11px 13px;font-size:.85rem;display:flex;flex-direction:column;gap:3px}
.fno{font-family:var(--mono);font-size:.68rem;color:var(--ink-3);letter-spacing:.06em}.frame strong{font-weight:600;line-height:1.4}.fsub{color:var(--ink-2);font-size:.82rem}
.muted{color:var(--ink-3)}footer{margin-top:52px;padding-top:20px;border-top:1px solid var(--line);font-size:.86rem;color:var(--ink-3)}footer code{color:var(--ink-2)}
@media(max-width:620px){.mast h1{font-size:1.65rem}body{font-size:15px}.vidgrid,.strip{grid-template-columns:minmax(0,1fr)}}
`;

/** The page. Pure: the same case and language render byte-identically. */
/**
 * The page a case gets when it never produced a bundle.
 *
 * Enforced 2026-09-11, asked for after a run whose 12 rows sealed 9 blocked:
 * **every case is routed to a page of its own**, and a case that never ran
 * says on that page WHY. Before this, `writeCasePages` deleted any stale page
 * for a bundle-less case and `casePageHref` returned null, so the only trace
 * of a blocked row was one line in the catalog index — a reader who clicked
 * the case name got nowhere, and the refusal text (often five separate lint
 * complaints, each naming a step) was truncated to whatever fitted the index
 * cell.
 *
 * Two honesty rules it inherits from every other surface here:
 *
 * - **It states an absence, never a verdict.** There was no run, so there is
 *   no evidence from the application: no steps, no film, no defects. The page
 *   says that in those words rather than leaving a reader to infer it from
 *   empty sections.
 * - **Every sentence is still a pure function of the record.** The reason is
 *   the ledger's own, escaped and split on the refusal's own `·` separator so
 *   five complaints read as five lines instead of one paragraph. Nothing is
 *   summarised and nothing is added.
 */
export function renderBlockedCasePage(input: CasePageInput): string {
  const L = caseLabels(input.lang);
  const c = input.case;
  const title = `${c.id} — ${input.title}`;
  const chip = verdictChipOf(c);
  const { shown, name } = caseTitle(c, { sheetCaseId: null });
  // The refusal's own separator: `composeRefusal` joins its complaints with
  // " · ", so splitting on it restores the list the model was given.
  const parts = (c.reason ?? '').split(' · ').map((one) => one.trim()).filter((one) => one !== '');
  const head = parts.shift() ?? L.blockedNoReason;
  return (
    `<!doctype html><html lang="${esc(input.lang)}"><head><meta charset="utf-8"/>` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"/>` +
    `<title>${esc(title)}</title><style>${STYLE}</style></head><body><main>` +
    `<header class="mast">` +
    `<p class="eyebrow">${esc(L.eyebrow)} · ${esc(input.title)}</p>` +
    `<h1>${esc(shown)}${name === '' ? '' : ` — ${esc(name)}`}</h1>` +
    `<p class="sub">${esc(L.blockedSub)}</p>` +
    `<p class="idline">` +
    `<span>${esc(L.idCase)} <b>${esc(c.id)}</b></span>` +
    (c.scenario === '' ? '' : `<span>${esc(L.idScenario)} <b>${esc(c.scenario)}</b></span>`) +
    `<span>${esc(L.idVerdict)} <b style="color:var(--case)">${esc(L.verdict[chip.label] ?? chip.label)}</b></span>` +
    `<span><a href="${esc(input.indexHref)}">${esc(L.backToIndex)}</a></span>` +
    `</p></header>` +
    `<section><h2>${esc(L.blockedWhy)}</h2>` +
    `<p>${esc(head)}</p>` +
    (parts.length === 0 ? '' : `<ul>${parts.map((one) => `<li>${esc(one)}</li>`).join('')}</ul>`) +
    `</section>` +
    `<section><h2>${esc(L.blockedEvidence)}</h2><p>${esc(L.blockedNoRun)}</p></section>` +
    `<footer><p><a href="${esc(input.indexHref)}">${esc(L.backToIndex)}</a></p></footer>` +
    `</main></body></html>`
  );
}

export function renderCasePage(input: CasePageInput): string {
  const L = caseLabels(input.lang);
  const c = input.case;
  const bundle = c.bundle;
  const title = `${c.id} — ${input.title}`;
  return (
    `<!doctype html><html lang="${esc(input.lang)}"><head><meta charset="utf-8"/>` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"/>` +
    `<title>${esc(title)}</title>` +
    // Self-contained like every report here: no external stylesheet, no
    // remote font. The stack names the template's typeface first and falls
    // through to the system's, so the page opens off a USB stick unchanged.
    `<style>${STYLE}</style></head><body><main>` +
    mast(input, L, bundle) +
    preRead(input, L, bundle) +
    coverage(L, bundle) +
    tickets(L, bundle) +
    dataUsed(L, bundle) +
    dbBeforeAfter(L, bundle) +
    queries(input, L) +
    backendCalls(L, bundle) +
    questions(L, bundle) +
    outcomes(L, bundle, c) +
    film(input, L, bundle) +
    stills(L, bundle) +
    footer(input, L) +
    `</main><script>${PLAYER}</script></body></html>`
  );
}
