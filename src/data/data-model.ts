/**
 * Control plane: AI escalation for `fillRetry`'s `custom` kind.
 *
 * Every other kind (`email`, `username`, `name`, `phone`, `text`) is
 * deterministic and never reaches this file — see `mock-data.ts`. `custom`
 * exists for the field a heuristic can't classify: "employee ID", "SKU",
 * "invoice reference". This is where "AI should only be used where
 * reasoning is required" earns its keep rather than being a slogan.
 */

import type { LanguageModel } from 'ai';
import { z } from 'zod';

import { LlmFactory, generateStructuredForModel, type ModelSource } from '../providers/llm-factory.js';
import { DETERMINISM_RULES, procedure } from '../providers/prompt-discipline.js';

const GenerateValueSchema = z.object({
  value: z.string().describe('The value to type into the field.'),
  reasoning: z.string().describe('One sentence explaining the choice.'),
});

export interface DataGenerateRequest {
  /** What the field is, e.g. "company name" or "employee ID". */
  description: string;
  /** The error/conflict message observed after the previous attempt, if any. */
  observedError?: string | undefined;
  /** The value tried previously, so the model doesn't repeat it. */
  previousValue?: string | undefined;
  attempt: number;
}

export interface DataGenerateResult {
  value: string;
  reasoning: string;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
}

/** Pluggable model backend, so tests can inject a deterministic stub. */
export interface DataModel {
  readonly id: string;
  generate(request: DataGenerateRequest): Promise<DataGenerateResult>;
}

const SYSTEM_PROMPT = `You generate one plausible, realistic value for a form field in a UI
test — a field a deterministic generator (email, username, name, phone, generic text) doesn't
know how to fill correctly. Read the field's description and, if given, the error the previous
attempt produced.

Return a short, realistic value — never a placeholder like "test value" or "TODO", and never
the exact previous value again. If an observed conflict is given (e.g. "already exists"), the
new value must plausibly avoid the same conflict.

${DETERMINISM_RULES}

${procedure('HOW TO CHOOSE THE VALUE', [
  'Read the field description and decide its FORMAT first: an identifier (letters+digits, keep the pattern the description or the previous value shows), a code from a fixed set (pick the first plausible one the description names), a free-text label, or a number with a range.',
  'Produce the plainest realistic value in that format. For an identifier, keep the previous value\'s prefix and change only the numeric tail. For free text, a short noun phrase about the field\'s subject.',
  'Attempt N > 1: derive the value from the previous one by the smallest change that avoids the observed conflict — increment the tail, append a distinguishing suffix — never a fresh unrelated invention.',
  'Say in "reasoning" which format you chose and, on a retry, what you changed and why.',
])}`;

function buildUserPrompt(request: DataGenerateRequest): string {
  const lines = [`Field: ${request.description}`, `Attempt: ${request.attempt}`];
  if (request.previousValue) lines.push(`Previous value tried: ${request.previousValue}`);
  if (request.observedError) lines.push(`Observed conflict: ${request.observedError}`);
  return lines.join('\n');
}

export interface LlmDataModelOptions {
  /** A concrete AI SDK model. Omit to resolve the `data` role from config. */
  model?: LanguageModel | undefined;
  id?: string | undefined;
  maxOutputTokens?: number | undefined;
  maxRetries?: number | undefined;
  factory?: LlmFactory | undefined;
}

/**
 * Default backend: one small structured-output call, through whichever provider the `data` role points at.
 *
 * `id` is resolved lazily, on first read, not in the constructor. This class
 * is constructed unconditionally for every run (unlike the healer, which is
 * gated behind a flag) precisely because most `fillRetry` steps never touch
 * it — resolving the role eagerly would demand a `data`-role key from every
 * run that never uses `kind: 'custom'`, which is the opposite of "AI
 * activates only on demand".
 */
export class LlmDataModel implements DataModel {
  readonly #source: ModelSource;
  readonly #maxOutputTokens: number;
  readonly #maxRetries: number;
  readonly #explicitId: string | undefined;

  constructor(options: LlmDataModelOptions = {}) {
    if (options.model) {
      this.#source = { model: options.model };
      this.#explicitId = options.id ?? 'custom:data';
      this.#maxRetries = options.maxRetries ?? 2;
    } else {
      const factory = options.factory ?? new LlmFactory();
      this.#source = { factory, role: 'data' };
      this.#explicitId = options.id;
      this.#maxRetries = options.maxRetries ?? factory.maxRetries;
    }
    this.#maxOutputTokens = options.maxOutputTokens ?? 256;
  }

  get id(): string {
    if (this.#explicitId !== undefined) return this.#explicitId;
    return 'factory' in this.#source ? this.#source.factory.forRole('data').id : 'custom:data';
  }

  async generate(request: DataGenerateRequest): Promise<DataGenerateResult> {
    const { object, inputTokens, outputTokens } = await generateStructuredForModel(this.#source, {
      modelLabel: this.id,
      schema: GenerateValueSchema,
      system: SYSTEM_PROMPT,
      prompt: buildUserPrompt(request),
      maxOutputTokens: this.#maxOutputTokens,
      maxRetries: this.#maxRetries,
    });

    return { value: object.value, reasoning: object.reasoning, inputTokens, outputTokens };
  }
}
