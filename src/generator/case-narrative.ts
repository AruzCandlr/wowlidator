/**
 * The case told as a report a person reads first — written by a model AFTER
 * the run and stored on the bundle (`ProofBundle.narrative`), so the per-case
 * page (`reporter/case-page.ts`) can show a lede, a pre-read summary, the
 * ticket each defect deserves, a verifier's note and the questions the case
 * leaves open without ever calling a model itself.
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
      detail: clip(t.detail, NARRATIVE_MAX_CHARS),
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
    summary: clip(answer.summary, NARRATIVE_MAX_CHARS),
    testData: clip(answer.testData, NARRATIVE_MAX_CHARS),
    expected: clip(answer.expected, NARRATIVE_MAX_CHARS),
    tickets,
    verifierNote: clip(answer.verifierNote, NARRATIVE_MAX_CHARS),
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
  summary: z.string().describe('Two or three sentences a reader reads before the results: what the case does, step by step in plain words.'),
  testData: z.string().describe('The data the run used — ids, names, dates — exactly as the step lines and variables show them. "none recorded" when there is none.'),
  expected: z.string().describe('What the sheet expected, restated in plain words from CASE TEXT.'),
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
  verifierNote: z.string().describe('What a reader should know about how this run went — a step that needed healing, a check the harness could not make, data that was shared. Empty string when there is nothing to say.'),
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
- No markdown, no bullets, no headings inside a field. Plain sentences.

${DETERMINISM_RULES}

${procedure('HOW TO WRITE', [
  'Read CASE TEXT so you know what the test as a whole set out to prove, and STATUS for how it ended.',
  'Read every STEP line: what each did, and whether it passed, failed, dead-ended, errored or was skipped.',
  'Read the DB lines: which tables were checked, what was expected against what was observed, the rows returned.',
  'Read the DEFECTS: each is one ticket, worded for the person who will fix it, with its id copied.',
  'Write the lede and the summary from steps 1–3; the test data from the step lines and VARIABLES; the note from what the harness disclosed.',
  'Answer only the questions CASE TEXT asks that the record can answer, naming the line you read the answer off.',
])}

${selfCheck([
  'Every app ticket copies the id of a DEFECT listed above; there is no app ticket for anything not listed.',
  'No field holds an email address, a password, a token or a connection string.',
  'Every value, id, date and status you wrote appears in a STEP, DB, DEFECT or VARIABLES line, or in CASE TEXT.',
  'The lede and summary agree with STATUS and with each step outcome; a DEAD END or ERROR step is not described as done.',
])}`;

export function buildNarrativePrompt(request: NarrativeRequest): string {
  const lines: string[] = [];
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
export async function composeNarrative(bundle: NarratableBundle, caseText: string, options: ComposeOptions): Promise<boolean> {
  if (!needsNarrative(bundle, options.lang)) return false;
  try {
    const answer = await options.model.compose(narrativeRequest(bundle, caseText, options.lang));
    return applyNarrative(bundle, answer, options.model.id, options.lang);
  } catch (error) {
    const message = error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error);
    options.log?.(`  ! narrative skipped for ${bundle.name}: ${message} — the case page shows its evidence alone`);
    return false;
  }
}
