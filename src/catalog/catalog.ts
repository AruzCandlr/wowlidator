/**
 * A catalog: a document of claims, turned into a test.
 *
 * The thing a team already has is not a flow. It is a requirements page, a QA
 * checklist, a spreadsheet of cases — prose that says what must be true. This
 * module is the path from that to a runnable flow, and it is deliberately two
 * steps rather than one:
 *
 *   document ──► claims ──► (a person prunes) ──► cases ──► a run each
 *
 * The last arrow is plural on purpose. A catalog asserts several independent
 * things, so it authors several independent cases, and each is run on its own:
 * a case that fails is recorded and the remaining ones are still checked. One
 * long flow would stop at its first failure and leave every claim after it
 * unanswered — the document asked those questions and someone approved them.
 *
 * **The gate between claims and steps is the point.** Handing a whole document
 * to a model and running whatever comes back spends tokens and a browser on
 * work nobody has looked at, against claims the model may have invented from a
 * heading. Extracting claims first is cheap, and a list of sentences is
 * something a person can scan in seconds and strike through. It is the same
 * gate GRIM puts in front of a catalog, for the same reason.
 *
 * **Claims extraction is not authoring.** This asks only "what does this
 * document assert?", never "how would you test it" — no selectors, no steps, no
 * page. That keeps this call cheap, keeps it useful without a browser, and
 * leaves the grounding problem where it is already solved: `FlowAuthor` writes
 * the steps against a live accessibility tree, so the selectors come from the
 * page rather than from the document.
 *
 * Routing reuses the `generator` role rather than adding a fifth: a large
 * prompt in, a small flat shape out — the same job in the same shape as
 * generation and repair, so it wants the same large-context model and
 * `wowlidator doctor` keeps covering it for free.
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

/** Claims asked for in one call. Beyond this a catalog wants splitting up. */
export const DEFAULT_MAX_CLAIMS = 40;
export const END_SUPPORTING_CONTEXT = '--- END SUPPORTING CONTEXT ---';

export interface CatalogClaim {
  /** One thing the document says must be true, in the document's own terms. */
  claim: string;
  /** `high` / `medium` / `low`, as stated or inferred. Never invented detail. */
  priority: string;
  /**
   * Where in the document it came from — a heading, a row, a section number.
   * Kept so a person reviewing the list can find the source of anything
   * surprising instead of taking the model's word for it.
   */
  source: string;
  /**
   * False for a line that sets context rather than asserting anything ("the
   * user is logged in as an admin"). Kept, because dropping it would lose what
   * the surrounding claims depend on, but never turned into a check of its own.
   */
  testable: boolean;
}

export interface CatalogClaims {
  /** What the document appears to be about, in one line. */
  summary: string;
  claims: CatalogClaim[];
  model: string;
  latencyMs: number;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  /** Extraction notes carried through from the document itself. */
  documentNote: string;
}

/**
 * Flat, every field required, no unions — the shape free-tier models actually
 * produce reliably. Narrowed in code afterwards, same as `GeneratedStepSchema`.
 */
const ClaimSchema = lenientObject({
  claim: z.string(),
  priority: z.string(),
  source: z.string(),
  testable: z.boolean(),
});

const ClaimsSchema = lenientObject({
  summary: z.string(),
  claims: z.array(ClaimSchema),
});

export interface ClaimsRequest {
  document: ExtractedDocument;
  /** Supporting documents, kept separate from the catalog — see `buildPrompt`. */
  context?: readonly ExtractedDocument[] | undefined;
  maxClaims?: number | undefined;
}

/** The seam. One method, so the whole feature is testable without a provider. */
export interface CatalogModel {
  readonly id: string;
  extractClaims(request: ClaimsRequest): Promise<Omit<CatalogClaims, 'documentNote'>>;
}

const SYSTEM_PROMPT = `You read a document and list what it asserts must be true about an application.

You are NOT writing tests. Do not mention selectors, clicks, steps or code.

Rules:
- One claim per thing the document asserts. Split a sentence that asserts two things.
- Use the document's own words and its own terms for features. Do not generalise.
- NEVER invent a claim the document does not make. A short document yields few claims; that is a correct answer.
- Mark a line that only sets up context (who is logged in, what data exists) as testable=false.
- "source" is where you found it: a heading, a row identifier, a section number. If there is no marker, quote three or four words of the line.
- "priority" is high, medium or low — as the document states it, or your reading of how central it is.

${DETERMINISM_RULES}

${procedure('HOW TO LIST THE CLAIMS', [
  'Walk the catalog top to bottom, in its own order. Claims come out in DOCUMENT ORDER — never regrouped, never sorted by importance.',
  'For each row, section or paragraph: one claim per assertion it makes. A sentence with "and" between two checkable things is two claims; a numbered "Expected output" list is one claim per number.',
  'Keep the document\'s identifiers: "source" is the case id / row id / heading exactly as written (TC_01_01, "3.2 Session timeout"), or the first four words of the line when there is none.',
  'Priority: the document\'s own word when it has one (High/Medium/Low → high/medium/low); otherwise medium. Never infer high from tone.',
  'testable=false for a line that only states who is signed in, what data exists, or what environment is running; everything that says what the application must show or do is testable=true.',
])}

${selfCheck([
  'Every claim quotes or closely paraphrases a line of the CATALOG section, none of the SUPPORTING CONTEXT.',
  'Claims are in document order and no two claims restate one line.',
  'Every claim with a document identifier carries it verbatim in "source".',
  'No claim mentions a selector, a click, a step, or code.',
])}`;

/** Exported for the test that asserts the two kinds of document stay apart. */
export function buildClaimsPrompt(request: ClaimsRequest): string {
  const parts: string[] = [];

  // The two kinds of document are labelled and separated on purpose. Context is
  // background the claims may refer to; it asserts nothing itself, and a model
  // that conflates the two produces claims about the API documentation instead
  // of about the application. Same reasoning as keeping a probe report apart
  // from the AX tree in `flow-author.ts`.
  for (const document of request.context ?? []) {
    parts.push(
      `--- SUPPORTING CONTEXT: ${document.name} ---\n` +
        'Background only. It makes no claims of its own; use it to understand terms.\n' +
        document.text,
    );
  }

  parts.push(
    `--- CATALOG: ${request.document.name} ---\n` +
      'Every claim you list must come from this document.\n' +
      request.document.text,
  );

  parts.push(
    `List at most ${request.maxClaims ?? DEFAULT_MAX_CLAIMS} claims from the catalog above.`,
  );

  return parts.join('\n\n');
}

export class LlmCatalogModel implements CatalogModel {
  readonly #source: ModelSource;
  readonly #maxOutputTokens: number;
  readonly #maxRetries: number;
  #label: string | undefined;

  constructor(options: {
    factory?: LlmFactory | undefined;
    model?: ModelSource | undefined;
    maxOutputTokens?: number | undefined;
  } = {}) {
    this.#source = options.model ?? { factory: options.factory ?? new LlmFactory(), role: 'generator' };
    this.#maxOutputTokens = options.maxOutputTokens ?? 4096;
    this.#maxRetries =
      'factory' in this.#source ? this.#source.factory.maxRetries : 2;
  }

  /** Lazy: constructing this class must never itself demand an API key. */
  get id(): string {
    if (this.#label === undefined) {
      this.#label =
        'factory' in this.#source ? this.#source.factory.forRole('generator').id : 'model';
    }
    return this.#label;
  }

  async extractClaims(request: ClaimsRequest): Promise<Omit<CatalogClaims, 'documentNote'>> {
    const started = Date.now();
    const { object, inputTokens, outputTokens } = await generateStructuredForModel(this.#source, {
      modelLabel: this.id,
      schema: ClaimsSchema,
      system: SYSTEM_PROMPT,
      prompt: buildClaimsPrompt(request),
      maxOutputTokens: this.#maxOutputTokens,
      maxRetries: this.#maxRetries,
    });

    return {
      summary: object.summary.trim(),
      claims: object.claims
        .map((claim) => ({
          claim: claim.claim.trim(),
          priority: normalisePriority(claim.priority),
          source: claim.source.trim(),
          testable: claim.testable,
        }))
        .filter((claim) => claim.claim !== ''),
      model: this.id,
      latencyMs: Date.now() - started,
      inputTokens,
      outputTokens,
    };
  }
}

/**
 * Models return `P1`, `HIGH`, `must have`, `nice to have`, `1`. Only three of
 * those are a priority, and the word is matched inside the phrase rather than
 * against it: a whole-string match files "nice to have" as medium, which is a
 * quiet lie about what the document said.
 */
function normalisePriority(value: string): string {
  const word = value.trim().toLowerCase();
  if (/\b(high|p1|critical|must)\b/.test(word) || word === '1') return 'high';
  if (/\b(low|p3|nice|could|optional)\b/.test(word) || word === '3') return 'low';
  return 'medium';
}

export async function extractClaims(
  model: CatalogModel,
  request: ClaimsRequest,
): Promise<CatalogClaims> {
  const result = await model.extractClaims(request);
  return { ...result, documentNote: request.document.note };
}

export class CatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogError';
  }
}

/**
 * The claims file — the gate, as a file on disk.
 *
 * Both phases and both surfaces meet here: `--claims-only` writes it, a person
 * (or wowUI's tick boxes) edits `approved`, and the authoring phase reads it
 * back. It is plain JSON with one boolean per claim precisely so the review can
 * happen in an editor, in a diff, or in a browser without any of those being
 * the only way — and so what ran is a file you still have afterwards.
 */
export interface ApprovedClaim extends CatalogClaim {
  /** Ticked. An unapproved claim is kept in the file, and never tested. */
  approved: boolean;
}

/**
 * The gate's participant table, present only for a sequence-diagram catalog.
 * The diagram never says which host is "the API" — plane assignments start as
 * deterministic defaults (`guessed` marks the ones the notation did not
 * state), and this block is where the person confirms or corrects them.
 */
export interface SequenceGateInfo {
  notation: string;
  participants: Array<{ name: string; label: string; plane: string; guessed: boolean }>;
  /**
   * Which claim came from which message — `claim` indexes the claims array.
   * What lets a gate that edits a plane recompute testability instead of
   * asking the person to re-derive it by hand. Absent in files written before
   * it existed; everything degrades to the read-only lane display.
   */
  messages?: Array<{ claim: number; from: string; to: string; reply: boolean }> | undefined;
}

export interface ClaimsFile {
  /** Name of the document the claims were read out of. */
  catalog: string;
  summary: string;
  documentNote: string;
  model: string;
  extractedAt: string;
  claims: ApprovedClaim[];
  sequence?: SequenceGateInfo | undefined;
}

export function toClaimsFile(
  catalog: string,
  claims: CatalogClaims,
  extractedAt: string,
  sequence?: SequenceGateInfo,
): ClaimsFile {
  return {
    catalog,
    summary: claims.summary,
    documentNote: claims.documentNote,
    model: claims.model,
    extractedAt,
    // Everything starts ticked: the review is for striking things out, and a
    // gate that begins empty is a gate everyone clicks "select all" through.
    claims: claims.claims.map((claim) => ({ ...claim, approved: true })),
    ...(sequence !== undefined ? { sequence } : {}),
  };
}

export function parseClaimsFile(raw: string): ClaimsFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CatalogError(`claims file is not valid JSON — ${error instanceof Error ? error.message : String(error)}`);
  }
  const file = parsed as Partial<ClaimsFile>;
  if (!Array.isArray(file.claims)) {
    throw new CatalogError('claims file has no "claims" array — is this the file --claims-only wrote?');
  }
  const sequence =
    typeof file.sequence === 'object' &&
    file.sequence !== null &&
    Array.isArray(file.sequence.participants)
      ? file.sequence
      : undefined;
  return {
    catalog: typeof file.catalog === 'string' ? file.catalog : 'catalog',
    summary: typeof file.summary === 'string' ? file.summary : '',
    documentNote: typeof file.documentNote === 'string' ? file.documentNote : '',
    model: typeof file.model === 'string' ? file.model : 'unknown',
    extractedAt: typeof file.extractedAt === 'string' ? file.extractedAt : '',
    ...(sequence !== undefined ? { sequence } : {}),
    claims: file.claims.map((claim: Partial<ApprovedClaim>) => ({
      claim: String(claim.claim ?? '').trim(),
      priority: normalisePriority(String(claim.priority ?? '')),
      source: String(claim.source ?? ''),
      testable: claim.testable !== false,
      // Absent means approved: a hand-written claims file should not have to
      // say yes to every line to be usable.
      approved: claim.approved !== false,
    })).filter((claim) => claim.claim !== ''),
  };
}

/**
 * The claims that will actually be tested.
 *
 * A claim marked `testable: false` is context, and is kept for the prompt but
 * never counted here — so "0 approved" means what it says, rather than
 * silently including three lines that assert nothing.
 */
export function approvedClaims(file: ClaimsFile): ApprovedClaim[] {
  return file.claims.filter((claim) => claim.approved);
}

/**
 * The prompt `FlowAuthor` is given for an approved set of claims.
 *
 * Every claim is numbered and every one must be covered, because the person who
 * ticked them chose exactly this set: silently testing four of six would report
 * a pass for two claims nothing checked. Context documents come first and are
 * labelled as background, the same separation the claims prompt makes.
 */
export function buildAuthoringPrompt(
  claims: readonly CatalogClaim[],
  options: {
    summary?: string | undefined;
    context?: readonly ExtractedDocument[] | undefined;
    /**
     * The full rows, when the catalog was the project's own table format. Steps
     * and step-keyed expectations instead of a distilled sentence — see
     * `describeCase` in `test-case-table.ts`. Given these, the numbered claim
     * list below is dropped: repeating each case in two different shapes invites
     * the model to cover it twice.
     */
    cases?: readonly string[] | undefined;
  } = {},
): string {
  const testable = claims.filter((claim) => claim.testable);
  const setup = claims.filter((claim) => !claim.testable);
  const parts: string[] = [];

  // The mission, first — before the background — so the model (and anyone
  // reading the request log) sees the task ahead of the documents that serve
  // it. Constant across every row of a catalog, so the shared prompt prefix
  // the caching comment below relies on is unchanged: this line + the docs
  // are byte-identical from row to row.
  parts.push(
    'Create a runnable JSON flow that navigates the website exactly as the test steps say, and takes ' +
      'the expected output in the test case VERBATIM as the expected output — without modification. ' +
      'If the case alone gives too little context, find what is missing in the SUPPORTING CONTEXT ' +
      'documents and the repository sections included below. Every test case has something to test.',
  );

  for (const document of options.context ?? []) {
    parts.push(
      `--- SUPPORTING CONTEXT: ${document.name} ---\n` +
        'Background only — it says nothing that needs checking.\n' +
        document.text,
    );
  }
  // A parseable boundary after the documents. Docs sit FIRST deliberately —
  // identical across every row of a catalog, they form a shared prompt prefix
  // a provider's implicit cache can bill at cache rates — and this sentinel is
  // what lets the reviewer elide them instead of paying for the whole document
  // set a second time per reviewed flow.
  if ((options.context ?? []).length > 0) parts.push(END_SUPPORTING_CONTEXT);

  if (options.summary !== undefined && options.summary !== '') {
    parts.push(`The catalog this comes from: ${options.summary}`);
  }
  if (setup.length > 0) {
    parts.push(
      'Assume this is already true; do not write checks for it:\n' +
        setup.map((claim) => `- ${claim.claim}`).join('\n'),
    );
  }

  if (options.cases !== undefined && options.cases.length > 0) {
    parts.push(
      'Write one flow that proves every one of these test cases. Each needs at least ' +
        'one assertion, and every case below must be covered — do not drop any.\n\n' +
        'Each case gives you the steps a tester would take and, numbered against ' +
        'them, what should be true afterwards. Follow the steps; turn each expected ' +
        'output into an assertion. An expectation numbered 3.2 belongs after the ' +
        'step numbered 3.\n\n' +
        // Expected values are the sheet's word, and a citation is a pointer,
        // never a licence to invent: the value lives in the cited source, and
        // retrieval has already placed that source's relevant passage in the
        // SUPPORTING CONTEXT above.
        'EXPECTED VALUES: the test case itself is the authority — quote its expected ' +
        'output wording and values exactly. When a case refers to another source for a ' +
        'value ("as per …", "according to …", "ตาม…", a named document, master list or ' +
        'section), that source\'s relevant passage is in the SUPPORTING CONTEXT above: ' +
        'take the exact value from there. Never invent a value neither the case nor ' +
        'the context states — if the cited value is genuinely absent from both, assert ' +
        'what the case itself states and nothing more.\n\n' +
        options.cases.join('\n\n'),
    );
  } else {
    parts.push(
      'Write one flow that proves every one of these claims. Each needs at least one assertion, ' +
        'and every claim below must be covered — do not drop any:\n' +
        testable.map((claim, index) => `${index + 1}. [${claim.priority}] ${claim.claim}`).join('\n'),
    );
  }

  // A catalog is a list of separate assertions, so its flow is a list of separate
  // cases — not one long sequence. Claim 2 failing must not decide whether claims
  // 3 to 6 are ever checked; those are questions the document asked and the
  // review approved, and "we stopped" is not an answer to any of them.
  parts.push(
    'Put each claim in its own case: name the case after the claim, and label every ' +
      'step that proves it with that name. Claims that can only be checked together ' +
      'share one case. Each case is run on its own and a failing one does not stop ' +
      'the rest, so no case may depend on an earlier case having run — put whatever ' +
      'they all need in setup, which runs again before each case. Setup starts on a ' +
      'blank page, so its first step is the goto; signing in and seeding storage come ' +
      'after it, and there is nothing to clear before it.',
  );

  return parts.join('\n\n');
}
