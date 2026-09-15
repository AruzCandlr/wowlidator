/**
 * The case told as a report a person reads first — written by a model AFTER
 * the run and stored on the bundle (`ProofBundle.narrative`), so the per-case
 * page (`reporter/case-page.ts`) can show a lede, a pre-read summary, the
 * ticket each defect deserves, a verifier's note and the questions the case
 * leaves open without ever calling a model itself. The verifier's note is the
 * run's own `notes` summarised in at most `NARRATIVE_NOTE_MAX_WORDS` words —
 * the page shows the summary INSTEAD of the notes, not beside them.
 *
 * The sibling of `step-narration.ts`, under the same three rules:
 *
 * 1. **It narrates the record, and is given nothing else.** The input is the
 *    case's own step lines (`formatStepLine`, verbatim — the text the run log
 *    prints and every report renders), its defects as recorded, the DB
 *    evidence lines the workbook prints, the masked variables, the run notes,
 *    and the one sheet-owned source every runtime role already sees: the
 *    case card (`caseContext` — the sheet's claim, expected output and test
 *    data). No page text and no credential the step lines withhold reaches
 *    the prompt.
 * 2. **It is descriptive, never authoritative.** It sets no status, files no
 *    defect, and is read by no finding. A run's verdict is identical with a
 *    narrative on and off; an `app` ticket must restate a recorded defect by
 *    id and is DROPPED when that id does not exist — a model does not file a
 *    defect here — and at most one `test`-side ticket is kept.
 * 3. **It is attributed.** `CaseNarrative.by` carries the model id and the
 *    page labels every narrative sentence as the model's words.
 *
 * Cost: ONE `generator`-role call per case — the whole case is one prompt
 * (a 120-step case with its DB lines is tens of thousands of tokens, which
 * the healer's default tier cannot take; `WOWLIDATOR_GENERATOR_*` re-points
 * it). ON by default for a run (`--no-case-narrative` /
 * `WOWLIDATOR_CASE_NARRATIVE=off` disables), unlike step narration, because
 * the page is built around it; a role with no key degrades silently to the
 * evidence-only page. A `wowlidator report` rebuild back-fills it only when
 * asked (`--case-narrative`): a rebuild is "no re-run", and spending a call
 * per case across every ledger on disk must be a choice.
 */

import type { LanguageModel } from 'ai';
import { z } from 'zod';

import {
  formatStepLine,
  REPORT_LANGS,
  type CaseNarrative,
  type Defect,
  type NarrativeQuestion,
  type NarrativeTicket,
  type ProofBundle,
  type ReportLang,
} from '../engine/proof-bundle.js';
import { LlmFactory, generateStructuredForModel, type ModelSource } from '../providers/llm-factory.js';
import { DETERMINISM_RULES, procedure, selfCheck } from '../providers/prompt-discipline.js';
import { dbProofLines } from '../reporter/step-facts.js';

export const CASE_NARRATIVE_ENV = 'WOWLIDATOR_CASE_NARRATIVE';
/** A narrative field longer than this is not a summary. Clipped, never dropped. */
export const NARRATIVE_MAX_CHARS = 600;
/**
 * `summary` and `testData` are read inside one table cell on the case page, so
 * they carry a tighter bound than the fields a reader reads as prose. Clipped
 * at the last sentence or list boundary before the bound, never dropped:
 * `expected` keeps the sheet's own enumeration and is NOT bound here.
 */
export const NARRATIVE_MAX_CELL_CHARS = 320;
/**
 * The three surfaces a reader meets BEFORE the evidence — the coverage note,
 * a suggested ticket's detail, and a step's own verdict — are held to 200
 * characters, with 50 more allowed when the text needs them.
 *
 * Soft, not hard, and the distinction is the whole design: an over-long field
 * is sent back to be written shorter, ONCE, rather than cut where the budget
 * happens to land. The model is the only thing that can drop the least
 * load-bearing clause and keep the rest true; a cut can only remove whatever
 * was last. The hard cap is what remains after that ask, and it is a
 * sentence-boundary cut, never a mid-word one.
 */
export const NARRATIVE_SOFT_CHARS = 200;
export const NARRATIVE_OVER_ALLOWANCE = 50;
export const NARRATIVE_HARD_CHARS = NARRATIVE_SOFT_CHARS + NARRATIVE_OVER_ALLOWANCE;

/**
 * The verifier's note is the ONE place the run's own notes reach the reader:
 * the page shows this summary and not `bundle.notes` themselves, which join
 * into a ~300-word paragraph (a real one, case PL_06_10: the session's origin,
 * the sign-in evidence, the pre-run risk line, a cross-case interference
 * stamp, and a whole system-error diagnosis with its suggested fix). Seventy
 * words is a paragraph a person reads BEFORE the evidence; the blob was one
 * nobody read at all.
 *
 * Bound in WORDS, not characters, because that is the unit the instruction to
 * the model states and the unit a reader feels — under the same soft/hard
 * discipline as `NARRATIVE_SOFT_CHARS` above: over-long goes back ONCE to be
 * written shorter (only the model can drop the least load-bearing clause and
 * keep the rest true), and what remains after that ask is cut where the text
 * itself breaks.
 */
export const NARRATIVE_NOTE_MAX_WORDS = 70;
/**
 * Thai — the other half of `REPORT_LANGS` — writes no space between words, so
 * a `split(/\s+/)` count of a Thai note is ONE and a word bound alone would
 * let it run to any length, while a character bound alone would truncate an
 * English note absurdly. A run of such characters is therefore counted as
 * characters and converted here.
 *
 * 4.5 code points per orthographic word, measured on running Thai: function
 * words run 2-3 (ว่า, ที่, ไม่), content words 4-9 (ข้อความ, แจ้งเตือน), with
 * combining vowels and tone marks counted as the code points they are. So 70
 * words is ~315 Thai characters against ~420 English ones — the same paragraph
 * in both scripts. Lao, Khmer and Burmese are written the same way and are
 * measured the same; a report language in a CJK script would need its own
 * ratio (its words are one or two characters) and `REPORT_LANGS` holds none.
 */
const CONTINUOUS_CHARS_PER_WORD = 4.5;
const CONTINUOUS_SCRIPT = /[\u0E00-\u0EFF\u1000-\u109F\u1780-\u17FF]/;
const WORD_CHAR = /[\p{L}\p{N}]/u;

export const NARRATIVE_MAX_TICKETS = 6;
export const NARRATIVE_MAX_QUESTIONS = 8;
/** Step lines beyond this are summarised as a count: the prompt must stay one call. */
export const NARRATIVE_MAX_STEP_LINES = 120;

/** On unless switched off — the inverse of `narrationEnabled`, on purpose: the page is built around it. */
export function caseNarrativeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[CASE_NARRATIVE_ENV] ?? '').trim().toLowerCase();
  return !(raw === 'off' || raw === '0' || raw === 'false' || raw === 'no');
}

/* ------------------------------------------------------------- projection */

export interface NarrativeRequest {
  caseName: string;
  /** The sheet's own claim — what the case set out to prove. */
  caseText: string;
  lang: ReportLang;
  /** The bundle's sealed status, as the ledger would say it. */
  status: string;
  /** `formatStepLine` per surviving step, verbatim. */
  stepLines: readonly string[];
  /** `dbProofLines` per DB step, verbatim. */
  dbLines: readonly string[];
  defects: readonly Pick<Defect, 'id' | 'category' | 'severity' | 'title' | 'detail'>[];
  /** Masked by name before they reached the bundle. */
  variables: Readonly<Record<string, string>>;
  notes: readonly string[];
  /** Set only on the ONE re-ask a narrative over the soft cap earns — see `shortenAsk`. */
  shorten?: string | undefined;
}

export interface NarrativeAnswer {
  lede: string;
  summary: string;
  testData: string;
  expected: string;
  tickets: readonly { kind: 'app' | 'test'; title: string; detail: string; owner: string; defectId?: string | undefined }[];
  verifierNote: string;
  questions: readonly { question: string; answer: string; evidence: string }[];
}

export interface CaseNarrativeModel {
  readonly id: string;
  compose(request: NarrativeRequest): Promise<NarrativeAnswer>;
}

type NarratableBundle = Pick<ProofBundle, 'steps' | 'name' | 'status' | 'defects'> &
  Partial<Pick<ProofBundle, 'variables' | 'notes' | 'narrative'>>;

/** What the model is given: the record, projected the way every report already prints it. */
export function narrativeRequest(bundle: NarratableBundle, caseText: string, lang: ReportLang): NarrativeRequest {
  const steps = bundle.steps.filter((step) => step.superseded !== true);
  return {
    caseName: bundle.name,
    caseText,
    lang,
    status: bundle.status,
    stepLines: steps.map((step) => formatStepLine(step)),
    dbLines: steps.flatMap((step) => dbProofLines(step)),
    defects: bundle.defects.map((d) => ({ id: d.id, category: d.category, severity: d.severity, title: d.title, detail: d.detail })),
    variables: bundle.variables ?? {},
    notes: bundle.notes ?? [],
  };
}

/** Whether a bundle still needs a narrative in this language — a rebuild in another language writes a new one. */
export function needsNarrative(bundle: Pick<ProofBundle, 'narrative'>, lang: ReportLang): boolean {
  return bundle.narrative === undefined || bundle.narrative.lang !== lang;
}

function clip(text: unknown, max: number): string {
  const folded = String(text ?? '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return folded.length <= max ? folded : folded.slice(0, max - 1) + '…';
}

/**
 * The cell bound, cut where the text itself breaks. A sentence end, then a
 * list separator, then a space — the last one that leaves at least half the
 * budget standing; below that the plain character clip is the honest cut. A
 * boundary cut ends a claim rather than halving one, which is what keeps a
 * shorter cell from becoming a vaguer one.
 */
export function clipCell(text: unknown, max: number = NARRATIVE_MAX_CELL_CHARS): string {
  const folded = clip(text, Number.MAX_SAFE_INTEGER);
  if (folded.length <= max) return folded;
  const head = folded.slice(0, max - 1);
  const floor = Math.floor(max / 2);
  for (const marks of ['.!?\n。', ';；,、·', ' ']) {
    let cut = -1;
    for (let i = head.length - 1; i >= floor; i--) if (marks.includes(head[i] as string)) { cut = i; break; }
    if (cut >= floor) return head.slice(0, marks === ' ' ? cut : cut + 1).trim() + '…';
  }
  return head + '…';
}

/**
 * Word-equivalents in a note, and the character index at which a budget of
 * them is reached — ONE scan, so the count that judges a note over-long and
 * the cut that shortens it can never disagree about where 70 words end. The
 * measure reads the TEXT, not the narrative's `lang`: a Thai note quotes the
 * application's English wording verbatim, and both halves must be counted the
 * way their own script is written.
 */
function measureNote(folded: string, budget: number = Number.POSITIVE_INFINITY): { words: number; index: number } {
  let words = 0;
  let index = folded.length;
  let inToken = false;
  for (let i = 0; i < folded.length; i++) {
    const ch = folded[i] as string;
    if (CONTINUOUS_SCRIPT.test(ch)) {
      inToken = false;
      words += 1 / CONTINUOUS_CHARS_PER_WORD;
    } else if (/\s/.test(ch)) {
      inToken = false;
    } else if (!inToken && WORD_CHAR.test(ch)) {
      words += 1;
      inToken = true;
    }
    if (words > budget && index === folded.length) index = i;
  }
  return { words, index };
}

/** What a note is worth in words — spaced tokens, plus the converted runs of a script that writes none. */
export function noteWords(text: unknown): number {
  return Math.round(measureNote(clip(text, Number.MAX_SAFE_INTEGER)).words);
}

/**
 * The note bound, cut where the text itself breaks. The word budget becomes
 * the character index it lands on, and `clipCell` makes the cut at the last
 * sentence end, list separator or space before it — so what a reader is left
 * with is a claim that ended, never half a word. Thai offers fewer of those
 * marks, and a stretch with none falls to the plain character cut: a script
 * that writes no boundary cannot be cut on one, and inventing a segmenter to
 * find one would be a claim about the language the harness cannot check.
 */
export function clipNote(text: unknown, maxWords: number = NARRATIVE_NOTE_MAX_WORDS): string {
  const folded = clip(text, Number.MAX_SAFE_INTEGER);
  const { words, index } = measureNote(folded, maxWords);
  if (words <= maxWords) return folded;
  return clipCell(folded, index + 1);
}

/**
 * Write the narrative onto the bundle, in place. The whole of the trust
 * boundary: a ticket naming a defect the run never filed loses that
 * reference, lists are capped, every field is clipped, and an answer with
 * nothing in it leaves the bundle exactly as it was. Returns whether it
 * landed.
 */
export function applyNarrative(
  bundle: NarratableBundle,
  answer: NarrativeAnswer,
  by: string,
  lang: ReportLang,
  at: string = new Date().toISOString(),
): boolean {
  const known = new Set(bundle.defects.map((d) => d.id));
  const tickets: NarrativeTicket[] = [];
  let testSide = 0;
  for (const t of answer.tickets ?? []) {
    if (tickets.length >= NARRATIVE_MAX_TICKETS) break;
    const title = clip(t.title, 200);
    if (title === '') continue;
    const defectId = typeof t.defectId === 'string' && known.has(t.defectId) ? t.defectId : undefined;
    const kind = t.kind === 'test' ? 'test' : 'app';
    // An application ticket is a defect; only the run files those.
    if (kind === 'app' && defectId === undefined) continue;
    if (kind === 'test' && testSide++ >= 1) continue;
    tickets.push({
      kind,
      title,
      detail: clipCell(t.detail, NARRATIVE_HARD_CHARS),
      owner: clip(t.owner, 60),
      ...(defectId === undefined ? {} : { defectId }),
    });
  }
  const questions: NarrativeQuestion[] = [];
  for (const q of answer.questions ?? []) {
    if (questions.length >= NARRATIVE_MAX_QUESTIONS) break;
    const question = clip(q.question, 300);
    const reply = clip(q.answer, NARRATIVE_MAX_CHARS);
    if (question === '' || reply === '') continue;
    questions.push({ question, answer: reply, evidence: clip(q.evidence, 300) });
  }
  const narrative: CaseNarrative = {
    lang,
    lede: clip(answer.lede, NARRATIVE_MAX_CHARS),
    summary: clipCell(answer.summary),
    testData: clipCell(answer.testData),
    expected: clip(answer.expected, NARRATIVE_MAX_CHARS),
    tickets,
    verifierNote: clipNote(answer.verifierNote),
    questions,
    by,
    at,
  };
  if (narrative.lede === '' && narrative.summary === '' && tickets.length === 0 && questions.length === 0) return false;
  bundle.narrative = narrative;
  return true;
}

/* ----------------------------------------------------------------- prompt */

const NarrativeSchema = z.object({
  lede: z.string().describe('One sentence under the title: what was tested, with what data, and what the record holds. No verdict word the record does not carry.'),
  summary: z.string().describe(
    `ONE or TWO short sentences, at most ${NARRATIVE_MAX_CELL_CHARS} characters in total: this is read inside a table cell, not as a paragraph. ` +
    'What the case set out to do and how the run ended — never a step-by-step retelling of the whole run. Drop detail; never blur what happened.',
  ),
  testData: z.string().describe(
    `Only the values that DECIDE this case — the record under test and the inputs its expectation turns on — at most ${NARRATIVE_MAX_CELL_CHARS} characters, not every value recorded. ` +
    'Each exactly as a step line or a VARIABLES line shows it. "none recorded" when there is none.',
  ),
  expected: z.string().describe(
    'What the sheet expected, restated in plain words from CASE TEXT. When the Expected column enumerates its items, KEEP the enumeration: one item per line, numbered as the sheet numbers them ("1. … 2. …"). Never flatten it into one sentence.',
  ),
  tickets: z
    .array(
      z.object({
        kind: z.enum(['app', 'test']).describe('app: the application misbehaved. test: the test, its data or the harness did.'),
        title: z.string().describe('A ticket title: the case id, then what to fix.'),
        detail: z.string().describe('The recorded facts that justify it — values, statuses, step numbers. Nothing inferred.'),
        owner: z.string().describe('Who should act: "Dev" for app, "Verifier" for test.'),
        defectId: z.string().optional().describe('The DEFECT id this ticket restates, copied exactly. Omit when it restates none.'),
      }),
    )
    .describe('One per recorded defect at most, plus at most one test-side ticket when the record shows the test itself fell short. Empty when nothing needs a ticket.'),
  verifierNote: z.string().describe(
    `A SUMMARY OF THE NOTES block, at most ${NARRATIVE_NOTE_MAX_WORDS} words — it is the only place the run's own notes reach the reader, and they are not shown beside it. ` +
    'Most decision-relevant first: a diagnosed system error and its suggested fix, then interference from another case, then a risk judged before the run, then how the session was obtained. ' +
    'Empty string when NOTES is empty and there is genuinely nothing to say.',
  ),
  questions: z
    .array(
      z.object({
        question: z.string().describe('A question CASE TEXT asks or leaves open.'),
        answer: z.string().describe('The answer as the record holds it, quoting values exactly.'),
        evidence: z.string().describe('The step number, DB line or defect the answer was read off.'),
      }),
    )
    .describe('Only questions the record actually answers. Empty when the sheet asks none.'),
});

const LANGUAGE_NAMES: Record<ReportLang, string> = { en: 'English', th: 'Thai' };

const SYSTEM_PROMPT = `You write the front page of a finished UI test's report, for a reader who did not build the test
harness — a tester, a developer, a manager. You are a translator of the record, not an investigator of it.

WHAT YOU ARE GIVEN, AND ALL YOU ARE GIVEN: the case's own claim from the test sheet, its sealed status,
each step's own report line, the database evidence lines exactly as the workbook prints them, the
defects the run filed, the variables it saved (masked where sensitive), and the run's notes.
Everything you write must be readable off those lines.

WHAT YOU WRITE: a lede, a pre-read summary, the test data used, the expectation restated, a ticket
per recorded defect (and at most one for the test side when the record shows the test fell short),
a verifier's note, and the questions the sheet leaves open that the record answers.

HARD RULES:
- Invent nothing. A value, a status, a date or an id you write must appear in the record. If the
  record does not say, say that it does not — "no pre-run value was captured" is a correct answer.
- Never contradict the status or a step's outcome. A DEAD END step did not succeed.
- A ticket restates a recorded DEFECT and copies its id; do not file a ticket for what no line shows.
- Quote application text and recorded values exactly as they appear, in their own language and
  script. Never translate them — a translation is a claim about evidence.
- Never write a credential, a password, an email address or a connection string, even if one
  somehow appears.
- No markdown, no bullets, no headings inside a field. Plain sentences. The one exception is \`expected\`, which keeps
  the sheet's own numbering ("1. …" on its own line, "2. …" on the next) when the Expected column enumerates items.

FIELD LENGTHS — \`summary\` and \`testData\` are read inside one cell of a table:
- \`summary\`: one or two short sentences, ${NARRATIVE_MAX_CELL_CHARS} characters at most. Say what the case set out to
  prove and how the run ended. Do not chain the run step by step; the step list below the table already does that.
- \`testData\`: the values the case turns on — the record under test and the inputs its expectation depends on —
  ${NARRATIVE_MAX_CELL_CHARS} characters at most. Not every value the run recorded.
- \`verifierNote\`: the NOTES block below, summarised in at most ${NARRATIVE_NOTE_MAX_WORDS} words. It is the ONLY place those notes
  reach the reader — the page does not show them beside it — so say the most decision-relevant facts first: a diagnosed
  system error and the fix it suggests, then interference from another case, then a risk judged before the run, then how
  the session was obtained. Empty only when NOTES is empty.
- Shorter is not vaguer: drop a detail rather than generalise it. A value you keep is quoted exactly; a value you drop
  is simply not mentioned.

${DETERMINISM_RULES}

${procedure('HOW TO WRITE', [
  'Read CASE TEXT so you know what the test as a whole set out to prove, and STATUS for how it ended.',
  'Read every STEP line: what each did, and whether it passed, failed, dead-ended, errored or was skipped.',
  'Read the DB lines: which tables were checked, what was expected against what was observed, the rows returned.',
  'Read the DEFECTS: each is one ticket, worded for the person who will fix it, with its id copied.',
  'Write the lede, then the summary in one or two short sentences — what was tried and how it ended, not each step in turn.',
  'Pick for the test data only the values the case turns on; leave the rest to the step lines. Keep the Expected enumeration numbered as the sheet numbers it.',
  `Write the verifier's note as a summary of the NOTES block — the error diagnosis and its fix first, then interference, then risk, then session mechanics — in at most ${NARRATIVE_NOTE_MAX_WORDS} words.`,
  'Answer only the questions CASE TEXT asks that the record can answer, naming the line you read the answer off.',
])}

${selfCheck([
  'Every app ticket copies the id of a DEFECT listed above; there is no app ticket for anything not listed.',
  'No field holds an email address, a password, a token or a connection string.',
  'Every value, id, date and status you wrote appears in a STEP, DB, DEFECT or VARIABLES line, or in CASE TEXT.',
  'The lede and summary agree with STATUS and with each step outcome; a DEAD END or ERROR step is not described as done.',
  `The summary is one or two sentences and the test data only the deciding values — each under ${NARRATIVE_MAX_CELL_CHARS} characters.`,
  `The verifier's note covers every NOTES line that changes what a reader would do, and is at most ${NARRATIVE_NOTE_MAX_WORDS} words.`,
])}`;

export function buildNarrativePrompt(request: NarrativeRequest): string {
  const lines: string[] = [];
  // At the top, not the bottom: this is the whole reason for the second call,
  // and a long record between the ask and the answer is where it gets lost.
  if (typeof request.shorten === 'string' && request.shorten !== '') {
    lines.push(`REWRITE — SHORTER: ${request.shorten}`);
    lines.push('');
  }
  lines.push(`LANGUAGE: write every field in ${LANGUAGE_NAMES[request.lang]}. Quoted application text and recorded values stay exactly as recorded.`);
  lines.push('');
  lines.push(`CASE: ${request.caseName}`);
  lines.push(`STATUS: ${request.status}`);
  lines.push('CASE TEXT:');
  lines.push(clip(request.caseText, 2_000));
  lines.push('');
  const shown = request.stepLines.slice(0, NARRATIVE_MAX_STEP_LINES);
  lines.push(`STEPS (${request.stepLines.length}${shown.length < request.stepLines.length ? `, first ${shown.length} shown` : ''}):`);
  for (const line of shown) lines.push(clip(line, 900));
  lines.push('');
  lines.push(`DB EVIDENCE (${request.dbLines.length} line(s)):`);
  for (const line of request.dbLines.slice(0, 200)) lines.push(clip(line, 600));
  lines.push('');
  lines.push(`DEFECTS (${request.defects.length}):`);
  for (const d of request.defects) lines.push(`- ${d.id} [${d.category}, ${d.severity}] ${clip(d.title, 200)} — ${clip(d.detail, 600)}`);
  lines.push('');
  const variables = Object.entries(request.variables);
  lines.push(`VARIABLES (${variables.length}):`);
  for (const [name, value] of variables) lines.push(`- ${name} = ${clip(value, 200)}`);
  lines.push('');
  lines.push(`NOTES (${request.notes.length}):`);
  for (const note of request.notes) lines.push(`- ${clip(note, 400)}`);
  return lines.join('\n');
}

/* ------------------------------------------------------------- the model */

export interface LlmCaseNarrativeModelOptions {
  model?: LanguageModel | undefined;
  id?: string | undefined;
  factory?: LlmFactory | undefined;
  maxOutputTokens?: number | undefined;
  maxRetries?: number | undefined;
}

/** A `generator`-role call: the whole case is one prompt, and that role has the room for it. */
export class LlmCaseNarrativeModel implements CaseNarrativeModel {
  readonly #source: ModelSource;
  readonly #explicitId: string | undefined;
  readonly #maxOutputTokens: number;
  readonly #maxRetries: number;

  constructor(options: LlmCaseNarrativeModelOptions = {}) {
    if (options.model) {
      this.#source = { model: options.model };
      this.#explicitId = options.id ?? 'custom:narrative';
      this.#maxRetries = options.maxRetries ?? 2;
    } else {
      const factory = options.factory ?? new LlmFactory();
      this.#source = { factory, role: 'generator' };
      this.#explicitId = options.id;
      this.#maxRetries = options.maxRetries ?? factory.maxRetries;
    }
    // The schema's own caps sum to ~18k characters, two to three times that in Thai.
    this.#maxOutputTokens = options.maxOutputTokens ?? 8_000;
  }

  get id(): string {
    if (this.#explicitId !== undefined) return this.#explicitId;
    return 'factory' in this.#source ? this.#source.factory.forRole('generator').id : 'custom:narrative';
  }

  async compose(request: NarrativeRequest): Promise<NarrativeAnswer> {
    if (!REPORT_LANGS.includes(request.lang)) throw new Error(`unknown report language ${JSON.stringify(request.lang)}`);
    const { object } = await generateStructuredForModel(this.#source, {
      modelLabel: this.id,
      schema: NarrativeSchema,
      system: SYSTEM_PROMPT,
      prompt: buildNarrativePrompt(request),
      maxOutputTokens: this.#maxOutputTokens,
      maxRetries: this.#maxRetries,
      task: 'case-narrative',
    });
    return object;
  }
}

/* ---------------------------------------------------------------- driving */

export interface ComposeOptions {
  model: CaseNarrativeModel;
  lang: ReportLang;
  log?: ((line: string) => void) | undefined;
}

/**
 * Write the case's narrative onto its bundle when it has none in this
 * language. Never throws: a failed call leaves the bundle as it was and the
 * page renders its evidence alone. Returns whether a narrative landed.
 */
/**
 * Which capped fields came back over the soft cap, named the way the re-ask
 * addresses them. Empty when the answer is already inside its budget — which
 * is the common case, and the one that must cost nothing.
 */
export function overSoftCap(
  answer: NarrativeAnswer,
  soft: number = NARRATIVE_SOFT_CHARS,
  maxWords: number = NARRATIVE_NOTE_MAX_WORDS,
): string[] {
  const over: string[] = [];
  const len = (v: unknown): number => (typeof v === 'string' ? clip(v, Number.MAX_SAFE_INTEGER).length : 0);
  // The note is judged in words, in the unit its own budget is written in; a
  // character count would bound the two report languages at different lengths.
  const words = noteWords(answer.verifierNote);
  if (words > maxWords) over.push(`verifierNote (${words} words)`);
  (answer.tickets ?? []).forEach((t, i) => {
    if (len(t.detail) > soft) over.push(`tickets[${i}].detail (${len(t.detail)} characters)`);
  });
  return over;
}

/** The instruction the over-long fields go back with. Names them; never rewrites them here. */
export function shortenAsk(
  over: readonly string[],
  soft: number = NARRATIVE_SOFT_CHARS,
  hard: number = NARRATIVE_HARD_CHARS,
  maxWords: number = NARRATIVE_NOTE_MAX_WORDS,
): string {
  return (
    `These fields are longer than the budget the page gives them: ${over.join('; ')}. ` +
    `Write the SAME answer again with those fields shorter — the verifier's note at most ${maxWords} words, ` +
    `every other field named above ${soft} characters and never more than ${hard}. ` +
    'Drop the least load-bearing clause; do not generalise what you keep, and do not drop a value, a status or a step number. ' +
    'Every other field stays exactly as you wrote it.'
  );
}

/**
 * Field by field, the shorter of two answers — and only for the fields the
 * cap governs. Everything else is the first answer's, because the re-ask was
 * told to leave them alone and a model that changed one anyway must not get
 * to restate the record on a second pass.
 */
export function keepShorter(first: NarrativeAnswer, second: NarrativeAnswer): NarrativeAnswer {
  const pick = (a: unknown, b: unknown): string => {
    const one = typeof a === 'string' ? a : '';
    const two = typeof b === 'string' ? b : '';
    if (two.trim() === '') return one;
    return two.length < one.length ? two : one;
  };
  const tickets = (first.tickets ?? []).map((t, i) => {
    const other = (second.tickets ?? [])[i];
    return other === undefined ? t : { ...t, detail: pick(t.detail, other.detail) };
  });
  return { ...first, verifierNote: pick(first.verifierNote, second.verifierNote), tickets };
}

export async function composeNarrative(bundle: NarratableBundle, caseText: string, options: ComposeOptions): Promise<boolean> {
  if (!needsNarrative(bundle, options.lang)) return false;
  try {
    const request = narrativeRequest(bundle, caseText, options.lang);
    let answer = await options.model.compose(request);
    // One re-ask, never two: a second would cost a call per case to save
    // characters a sentence-boundary cut already removes safely.
    const over = overSoftCap(answer);
    if (over.length > 0) {
      options.log?.(`  narrative over its budget (${over.join('; ')}) — asking once for a shorter one`);
      try {
        const shorter = await options.model.compose({ ...request, shorten: shortenAsk(over) });
        // The re-ask is kept only where it actually helped. A field that came
        // back LONGER keeps the first answer, so a re-ask can never make the
        // page worse than not asking.
        answer = keepShorter(answer, shorter);
      } catch (error) {
        const why = error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error);
        options.log?.(`  ! shorter narrative not written for ${bundle.name}: ${why} — the first answer stands, cut at its bound`);
      }
    }
    return applyNarrative(bundle, answer, options.model.id, options.lang);
  } catch (error) {
    const message = error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error);
    options.log?.(`  ! narrative skipped for ${bundle.name}: ${message} — the case page shows its evidence alone`);
    return false;
  }
}
