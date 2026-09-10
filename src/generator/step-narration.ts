/**
 * Plain-language narration of every step, written after the run and stored on
 * the bundle so the report can show it without ever calling a model itself.
 *
 * What it is for: a report step reads `✗ [10] selectOption (jit, 8412ms)
 * role=combobox[name="Condition" i]  DEAD END` — precise, and unreadable to
 * anyone who did not build the harness. This turns each of those into a
 * sentence a tester or a developer can act on.
 *
 * Three rules make it safe to put a model's prose beside evidence:
 *
 * 1. **It narrates the step's own line, and is given nothing else.** The input
 *    is `formatStepLine(step)` verbatim — the same text the run log prints and
 *    the report renders. A narration can therefore only restate what the
 *    report already says; there is no second source for it to contradict, and
 *    no page text, detail dump or credential reaches the prompt that
 *    `formatStepLine` does not already print (`stepTarget`/`stepKindFacts`
 *    withhold an account; the generic detail dump is not included at all).
 * 2. **It is descriptive, never authoritative.** It sets no status, files no
 *    defect, and is excluded from the findings signature — which keys off
 *    typed fields precisely so one cause stays one finding whatever language
 *    it is worded in (`src/reporter/findings.ts`). A run's verdict is
 *    identical with narration on and off.
 * 3. **It is attributed.** `StepNarration.by` carries the model id and every
 *    surface labels the sentence as a model's words. The standing rule in
 *    `engine/runner.ts` (`decisionFrom`) is that synthesised words must never
 *    wear the harness's voice; this obeys it by wearing the model's.
 *
 * Cost: ONE call per case, not one per step — a 440-case catalog narrating
 * every step is 440 calls, not 4,000. Long cases chunk at `NARRATION_BATCH`.
 * Off by default (`WOWLIDATOR_NARRATE=on`, or `--narrate`): unlike the error
 * diagnosis this fires on every case, and a suite that spends its window on
 * prose is a suite that finishes its cases on refusals.
 */

import type { LanguageModel } from 'ai';
import { z } from 'zod';

import { formatStepLine, type ProofBundle, type ProofStep, type StepNarration } from '../engine/proof-bundle.js';
import { LlmFactory, generateStructuredForModel, type ModelSource } from '../providers/llm-factory.js';
import { DETERMINISM_RULES, procedure } from '../providers/prompt-discipline.js';

export const NARRATION_ENV = 'WOWLIDATOR_NARRATE';
/** Steps per model call. A case longer than this is narrated in several calls. */
export const NARRATION_BATCH = 40;
/** A narration longer than this is not a summary. Clipped, never dropped. */
export const NARRATION_MAX_CHARS = 320;

/**
 * Off unless asked for. The inverse of `WOWLIDATOR_DIAGNOSE`, and deliberately
 * so: the diagnosis fires only on a case that ended as a system error, this
 * fires on every case that runs.
 */
export function narrationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[NARRATION_ENV] ?? '').trim().toLowerCase();
  return raw === 'on' || raw === '1' || raw === 'true' || raw === 'yes';
}

/** One step as the model sees it: its index, its status, and its own report line. */
export interface NarratableStep {
  index: number;
  status: string;
  line: string;
}

export interface NarrationRequest {
  caseName: string;
  /** The sheet's own claim, so a narration can say what the step was for. */
  caseText: string;
  steps: readonly NarratableStep[];
}

export interface NarratedStep {
  index: number;
  text: string;
}

export interface NarrationModel {
  readonly id: string;
  narrate(request: NarrationRequest): Promise<NarratedStep[]>;
}

/* ------------------------------------------------------------- projection */

/**
 * Every step worth a sentence, as its own report line. Superseded attempts are
 * excluded for the same reason every other renderer excludes them: they are
 * what was tried, not what happened, and the report folds them under the step
 * that finally held.
 */
export function narratableSteps(bundle: Pick<ProofBundle, 'steps'>): NarratableStep[] {
  return bundle.steps
    .filter((step) => step.superseded !== true)
    .map((step) => ({ index: step.index, status: step.status, line: formatStepLine(step) }));
}

/** Steps that have no narration yet — what a rebuild pass has left to do. */
export function unnarrated(bundle: Pick<ProofBundle, 'steps'>): NarratableStep[] {
  const done = new Set(bundle.steps.filter((s) => s.narration !== undefined).map((s) => s.index));
  return narratableSteps(bundle).filter((s) => !done.has(s.index));
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Write narrations onto the bundle, in place. Pure bookkeeping and the whole
 * of the trust boundary: an index the run never had is dropped, a superseded
 * step is never narrated, an empty answer leaves the step exactly as it was,
 * and an existing narration is not overwritten. Returns how many landed.
 */
export function applyNarration(
  bundle: Pick<ProofBundle, 'steps'>,
  narrated: readonly NarratedStep[],
  by: string,
  at: string = new Date().toISOString(),
): number {
  const byIndex = new Map<number, ProofStep>();
  for (const step of bundle.steps) if (step.superseded !== true) byIndex.set(step.index, step);
  let landed = 0;
  for (const item of narrated) {
    const step = byIndex.get(item.index);
    if (step === undefined || step.narration !== undefined) continue;
    const text = clip(item.text, NARRATION_MAX_CHARS);
    if (text === '') continue;
    const narration: StepNarration = { text, by, at };
    step.narration = narration;
    landed += 1;
  }
  return landed;
}

/* ----------------------------------------------------------------- prompt */

const NarrationSchema = z.object({
  steps: z
    .array(
      z.object({
        index: z.number().int().describe('The step number, copied from the STEP line it narrates.'),
        text: z.string().describe('One or two plain sentences about that step. No markdown, no bullet, no step number.'),
      }),
    )
    .describe('One entry per step given, in the same order.'),
});

const SYSTEM_PROMPT = `You rewrite the steps of a finished UI test into plain language, one short entry per step,
for a reader who did not build the test harness — a tester, a developer, a manager reading the
report. You are a translator of the record, not an investigator of it.

WHAT YOU ARE GIVEN, AND ALL YOU ARE GIVEN: each step's own report line — its number, its action,
how long it took, what it aimed at, what it expected against what it actually found, and its error
if it broke. Everything you write must be readable off that line.

WHAT EACH ENTRY SAYS:
- What the step tried to do, in the words a person would use. "Opened the benefit plans page",
  "typed the plan name into the Name box", "checked that the page showed the saved plan".
- Whether it worked. For a step that broke, say what went wrong in the same plain terms — what was
  looked for and what was there instead — and stop. Do NOT say why, do not blame a layer, do not
  propose a fix: another part of the report does that from more evidence than you have.
- Nothing else. No advice, no severity, no confidence, no restating the raw selector unless the
  selector IS the readable thing.

HARD RULES:
- Invent nothing. If the line does not say what a control was called, do not name it. A step whose
  line says little gets a short entry that says little; that is the correct answer, not a failure.
- Quote application text exactly as it appears, in its own language and script. Never translate it
  — a translation is a claim about evidence. Write your own sentences in English around it.
- Never contradict the line. If the line says DEAD END, the step did not succeed.
- Never write a credential, a password, or an email address, even if one somehow appears.
- One or two sentences. Under 300 characters.

${DETERMINISM_RULES}

${procedure('HOW TO NARRATE', [
  'Read the CASE so you know what the test as a whole was trying to prove.',
  'Take each STEP line in turn. Identify the act (what it did) and the outcome (✓ passed, ✗ failed, DEAD END, ERROR, SKIPPED).',
  'Write the act in plain words, then the outcome. For a break, add what was expected against what was found, from that line only.',
  'Return one entry per step given, with the index copied exactly from its line.',
])}`;

function clip(text: string, max: number): string {
  const folded = (text ?? '').replace(/\r/g, '').replace(/\s+/g, ' ').trim();
  return folded.length <= max ? folded : folded.slice(0, max - 1) + '…';
}

export function buildNarrationPrompt(request: NarrationRequest): string {
  const lines: string[] = [];
  lines.push(`CASE: ${request.caseName}`);
  lines.push(clip(request.caseText, 1_200));
  lines.push('');
  lines.push(`STEPS (${request.steps.length}) — narrate every one, by index:`);
  for (const step of request.steps) {
    lines.push('');
    lines.push(`--- step ${step.index} (${step.status})`);
    lines.push(clip(step.line, 900));
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------- the model */

export interface LlmNarrationModelOptions {
  model?: LanguageModel | undefined;
  id?: string | undefined;
  factory?: LlmFactory | undefined;
  maxOutputTokens?: number | undefined;
  maxRetries?: number | undefined;
}

/** A `healer`-role call: the small, fast, cheap model. Narration is not reasoning work. */
export class LlmNarrationModel implements NarrationModel {
  readonly #source: ModelSource;
  readonly #explicitId: string | undefined;
  readonly #maxOutputTokens: number;
  readonly #maxRetries: number;

  constructor(options: LlmNarrationModelOptions = {}) {
    if (options.model) {
      this.#source = { model: options.model };
      this.#explicitId = options.id ?? 'custom:narration';
      this.#maxRetries = options.maxRetries ?? 2;
    } else {
      const factory = options.factory ?? new LlmFactory();
      this.#source = { factory, role: 'healer' };
      this.#explicitId = options.id;
      this.#maxRetries = options.maxRetries ?? factory.maxRetries;
    }
    // ~60 output tokens a step, plus the envelope.
    this.#maxOutputTokens = options.maxOutputTokens ?? 2_500;
  }

  get id(): string {
    if (this.#explicitId !== undefined) return this.#explicitId;
    return 'factory' in this.#source ? this.#source.factory.forRole('healer').id : 'custom:narration';
  }

  async narrate(request: NarrationRequest): Promise<NarratedStep[]> {
    const { object } = await generateStructuredForModel(this.#source, {
      modelLabel: this.id,
      schema: NarrationSchema,
      system: SYSTEM_PROMPT,
      prompt: buildNarrationPrompt(request),
      maxOutputTokens: this.#maxOutputTokens,
      maxRetries: this.#maxRetries,
      task: 'narration',
    });
    return object.steps.map((s) => ({ index: s.index, text: s.text }));
  }
}

/* ---------------------------------------------------------------- driving */

export interface NarrateOptions {
  model: NarrationModel;
  log?: ((line: string) => void) | undefined;
  /** Steps per call. Lower it for a model with a small output budget. */
  batch?: number | undefined;
}

/**
 * Narrate every step of a bundle that has none yet, in place. Never throws and
 * never partially poisons a bundle: a failed batch leaves its steps unnarrated
 * and the report renders them exactly as it did before this existed. Returns
 * the number of steps narrated.
 */
export async function narrateBundle(
  bundle: Pick<ProofBundle, 'steps' | 'name'>,
  caseText: string,
  options: NarrateOptions,
): Promise<number> {
  const pending = unnarrated(bundle);
  if (pending.length === 0) return 0;
  const at = new Date().toISOString();
  let landed = 0;
  for (const batch of chunk(pending, options.batch ?? NARRATION_BATCH)) {
    try {
      const narrated = await options.model.narrate({ caseName: bundle.name, caseText, steps: batch });
      landed += applyNarration(bundle, narrated, options.model.id, at);
    } catch (error) {
      const message = error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error);
      options.log?.(`  ! narration skipped for ${batch.length} step(s) of ${bundle.name}: ${message} — the steps read as they always did`);
    }
  }
  return landed;
}
