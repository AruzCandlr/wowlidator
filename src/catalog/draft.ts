/**
 * Writing a catalog, rather than reading one.
 *
 * `catalog <file>` starts from a document a team already has. The other two ways
 * in — **Describe** ("what should I test?") and **Add Context** (here are the
 * specs, work it out) — had no catalog at all: they went straight to a flow, so
 * the thing that got run was never written down in a form anyone could review,
 * amend, or hand to a tester. This closes that: they now produce a catalog in
 * the project's own format first, and everything after it is the ordinary
 * catalog path.
 *
 * That ordering matters more than it looks. The gate in `catalog.ts` exists
 * because nobody should spend a browser on work nobody has looked at; a Describe
 * that skipped straight to authoring skipped the gate as well. Now all three
 * entrances meet at the same reviewable file.
 *
 * Routing reuses the `generator` role, same as claims extraction and repair: a
 * large prompt in, a flat shape out.
 */

import { z } from 'zod';

import { lenientObject } from '../providers/model-output.js';
import { DETERMINISM_RULES, procedure, selfCheck } from '../providers/prompt-discipline.js';

import {
  LlmFactory,
  generateStructuredForModel,
  type ModelSource,
} from '../providers/llm-factory.js';
import type { ExtractedDocument } from './extract.js';
import { numberCases, prefixFor, type TestCaseRow } from './test-case-table.js';

/** Cases asked for in one call. Beyond this, narrow the description. */
export const DEFAULT_MAX_DRAFT_CASES = 20;

/**
 * Flat, every field required — the shape free-tier models produce reliably.
 * The bookkeeping columns are absent on purpose: `No.`, `Scenario ID` and
 * `Test Case ID` are a function of position, so `numberCases` computes them and
 * the model is never given the chance to repeat one.
 */
const DraftCaseSchema = lenientObject({
  scenario: z.string().describe('The scenario this case belongs to. Cases sharing one are grouped.'),
  testCase: z.string().describe('One line: what this case checks.'),
  polarity: z.string().describe('Positive or Negative.'),
  priority: z.string().describe('High, Medium or Low.'),
  testData: z.string().describe('Inputs, personas, boundary values. "N/A" when none.'),
  menu: z.string().describe('Where in the app, as numbered levels, one per line. Empty if unknown.'),
  steps: z.string().describe('Numbered steps a tester would take, one per line.'),
  expected: z
    .string()
    .describe(
      'Numbered expected outputs, one per line, each keyed to the step that produces it (3.1, 3.2).',
    ),
  note: z.string().describe('Where this came from — a spec line, a file, a rule. Empty if none.'),
});

const DraftSchema = lenientObject({
  subject: z.string().describe('What this catalog covers, in a few words.'),
  cases: z.array(DraftCaseSchema),
});

export interface DraftRequest {
  /** What the person asked for. Empty when working from context alone. */
  description: string;
  /** Specs, requirement pages, API docs — background, and the source material. */
  context?: readonly ExtractedDocument[] | undefined;
  /** Accessibility tree of the page, when there is one to look at. */
  axTree?: string | undefined;
  url?: string | undefined;
  maxCases?: number | undefined;
}

export interface DraftResult {
  subject: string;
  rows: TestCaseRow[];
  model: string;
  latencyMs: number;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
}

/** The seam, so drafting is testable without a provider. */
export interface DraftModel {
  readonly id: string;
  draft(request: DraftRequest): Promise<Omit<DraftResult, 'rows'> & { cases: DraftCase[] }>;
}

export type DraftCase = z.infer<typeof DraftCaseSchema>;

const SYSTEM_PROMPT = `You write a QA test catalog: a table of test cases, one row each.

You are NOT writing automation. No selectors, no code, no framework. Write what a
tester would do and what they should see — the same words you would put in a
spreadsheet for someone to run by hand.

Each case has:
- scenario   the feature or rule being exercised. Cases that belong to the same
             rule share one scenario, and are then grouped under it.
- testCase   one line, the specific thing this row checks.
- polarity   Positive for the intended path, Negative for a rule being enforced
             (invalid input, a missing precondition, a permission being denied).
- priority   High for a rule whose breach loses or corrupts data, or blocks the
             main path. Medium for ordinary behaviour. Low for cosmetic or
             sample-data coverage.
- testData   the inputs that make the case specific: personas, values, boundary
             numbers. "N/A" when the case needs none.
- menu       how a user gets there, as numbered levels, one per line.
- steps      numbered, one per line, each an action a person can take.
- expected   numbered, one per line, and **keyed to the step that produces it**:
             "3.1" is the first thing that must be true after step 3. This is
             what makes a row checkable, so it is the part to get right.
- note       where the case came from — a requirement id, a rule, a file.

Rules:
- Cover the negative cases. A catalog of happy paths passes on an application
  that enforces nothing.
- Every expectation must be observable by the person running the steps. "The
  data is saved correctly" is not; "the record appears in the list with status
  Pending" is.
- Never invent a feature the material does not mention. Fewer, real cases beat a
  full-looking sheet about an application that does not exist.
- Boundaries get their own case with the values in testData (14, 15, 29, 30).

${DETERMINISM_RULES}

${procedure('HOW TO DRAFT THE CATALOG', [
  'List the rules and features the SOURCE material states, in the order the material states them. That list, in that order, is the list of scenarios.',
  'For each scenario in turn: the positive case first, then each negative case the rule implies, then each boundary with its values. Stop at the case limit — earlier scenarios win.',
  'Steps are what a person does, numbered from 1, one action per line, using the control names THE PAGE section shows when there is one. Expected lines are keyed to the step that produces them ("3.1").',
  'Priority: High for data loss/corruption or a blocked main path, Medium for ordinary behaviour, Low for cosmetic and sample-data coverage — decided by the rule\'s consequence, never by how much text the source spends on it.',
])}

${selfCheck([
  'Scenarios follow the order of the source material; cases within a scenario go positive → negative → boundary.',
  'Every expected line is observable by a person and keyed to a step number.',
  'No case mentions a feature the source material does not, and no case is a duplicate of another under different words.',
  'Menu paths and control names match THE PAGE section wherever one was given.',
])}`;

export function buildDraftPrompt(request: DraftRequest): string {
  const parts: string[] = [];

  for (const document of request.context ?? []) {
    parts.push(`--- SOURCE: ${document.name} ---\n${document.text}`);
  }

  if (request.axTree !== undefined) {
    parts.push(
      `--- THE PAGE${request.url === undefined ? '' : `: ${request.url}`} ---\n` +
        'What is actually on screen. Menu paths and control names should match it.\n' +
        request.axTree,
    );
  }

  parts.push(
    request.description.trim() === ''
      ? 'Write the catalog the sources above call for.'
      : `What to cover: ${request.description.trim()}`,
  );
  parts.push(`At most ${request.maxCases ?? DEFAULT_MAX_DRAFT_CASES} cases.`);

  return parts.join('\n\n');
}

export class LlmDraftModel implements DraftModel {
  readonly #source: ModelSource;
  readonly #maxOutputTokens: number;
  readonly #maxRetries: number;
  #label: string | undefined;

  constructor(
    options: { factory?: LlmFactory | undefined; model?: ModelSource | undefined } = {},
  ) {
    this.#source =
      options.model ?? { factory: options.factory ?? new LlmFactory(), role: 'generator' };
    this.#maxOutputTokens = 8192;
    this.#maxRetries = 'factory' in this.#source ? this.#source.factory.maxRetries : 2;
  }

  /** Lazy: constructing this must never itself demand an API key. */
  get id(): string {
    if (this.#label === undefined) {
      this.#label =
        'factory' in this.#source ? this.#source.factory.forRole('generator').id : 'model';
    }
    return this.#label;
  }

  async draft(
    request: DraftRequest,
  ): Promise<Omit<DraftResult, 'rows'> & { cases: DraftCase[] }> {
    const started = Date.now();
    const { object, inputTokens, outputTokens } = await generateStructuredForModel(this.#source, {
      modelLabel: this.id,
      schema: DraftSchema,
      system: SYSTEM_PROMPT,
      prompt: buildDraftPrompt(request),
      maxOutputTokens: this.#maxOutputTokens,
      maxRetries: this.#maxRetries,
    });

    return {
      subject: object.subject.trim(),
      cases: object.cases.filter((one) => one.testCase.trim() !== ''),
      model: this.id,
      latencyMs: Date.now() - started,
      inputTokens,
      outputTokens,
    };
  }
}

/** Draft a catalog, numbered and ready to write. */
export async function draftCatalog(
  model: DraftModel,
  request: DraftRequest,
): Promise<DraftResult> {
  const result = await model.draft(request);
  const rows = numberCases(
    result.cases.map((one) => ({
      scenario: one.scenario.trim(),
      testCase: one.testCase.trim(),
      polarity: one.polarity,
      priority: one.priority,
      // The draft schema has no sign-in/environment columns (its cases are
      // drafted from specs, not run); the fields exist so a drafted sheet
      // round-trips through the same row shape the parser reads.
      persona: '',
      preconditions: '',
      testData: one.testData.trim(),
      menu: one.menu.trim(),
      steps: one.steps.trim(),
      expected: one.expected.trim(),
      note: one.note.trim(),
      actual: '',
      testDate: '',
      testBy: '',
      bugTicket: '',
    })),
    prefixFor(result.subject || request.description),
  );

  return {
    subject: result.subject,
    rows,
    model: result.model,
    latencyMs: result.latencyMs,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  };
}
