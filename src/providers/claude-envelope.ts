/**
 * Reading the `result` event Claude Code prints — the same shape on both
 * claude-cli vectors (`--output-format json` one-shot, stream-json warm).
 *
 * Pure helpers, no I/O, so the two vectors cannot drift in how they read an
 * answer. Everything here was measured on CLI 2.1.260 (2026-09-04) with a
 * one-token haiku probe rather than assumed:
 *
 *   * A `--json-schema` answer arrives as a TOOL CALL: `stop_reason:
 *     "tool_use"`, `num_turns: 2`, the validated object in
 *     `structured_output`, and `result` holding a string rendering of it. So
 *     `turns: 2` in the ledger is the ordinary shape of every schema call —
 *     not a re-ask — and retrieval use is `turns >= 3`.
 *   * When the CLI's OWN output cap is hit the event is `is_error: true`,
 *     `terminal_reason: "api_error"`, `stop_reason` absent, and the whole
 *     answer is `"API Error: Claude's response exceeded the 40 output token
 *     maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS
 *     environment variable."` — nothing of the object arrives. The cap is the
 *     CLI's (`CLAUDE_CODE_MAX_OUTPUT_TOKENS`, 32,000 by default), and the
 *     model's real ceiling rides in `modelUsage.<id>.maxOutputTokens`
 *     (64,000 for opus, 32,000 for haiku, measured).
 *
 * Before this module the warm session rejected that error as if the pipe had
 * died, `claude-cli.ts` fell back to a cold one-shot of the SAME prompt (the
 * same cap, so the same cut — and the whole prompt paid twice), and the cold
 * copy surfaced as a plain "provider refused" error that `generateStructured`
 * could not tell from a model that cannot do JSON.
 */

/** The fields of a `result` event this codebase reads. Everything else is ignored. */
export interface ClaudeResultEvent {
  result?: unknown;
  is_error?: unknown;
  /** The object the CLI validated against `--json-schema`, when it did. */
  structured_output?: unknown;
  stop_reason?: unknown;
  total_cost_usd?: unknown;
  num_turns?: unknown;
  usage?: unknown;
  modelUsage?: unknown;
}

/**
 * The output-token cap named by an `is_error` result, or null when the event
 * is anything else. The cap is the only fact in that text; the number is
 * what a re-ask needs, so it is parsed from the CLI's own sentence — the same
 * way a Google 429 body is the only place its limit is stated.
 */
export function outputCapOf(event: ClaudeResultEvent): number | null {
  if (event.is_error !== true || typeof event.result !== 'string') return null;
  const match = /exceeded the (\d+) output token maximum/i.exec(event.result);
  if (match === null) return null;
  const cap = Number(match[1]);
  return Number.isFinite(cap) && cap > 0 ? cap : null;
}

/**
 * The most output tokens the answering model can emit at all, from the
 * event's `modelUsage`, or null when the CLI did not say. Above this a cap
 * cannot be raised: the cut is the model's, not the CLI's.
 */
export function modelOutputCeilingOf(event: ClaudeResultEvent): number | null {
  const usage = event.modelUsage;
  if (usage === null || typeof usage !== 'object') return null;
  let ceiling: number | null = null;
  for (const entry of Object.values(usage as Record<string, unknown>)) {
    const max = (entry as { maxOutputTokens?: unknown } | null)?.maxOutputTokens;
    if (typeof max === 'number' && Number.isFinite(max) && max > 0) {
      ceiling = ceiling === null ? max : Math.max(ceiling, max);
    }
  }
  return ceiling;
}

/**
 * The answer text to hand the SDK. For a JSON call the CLI-validated
 * `structured_output` is the answer and `result` is a rendering of it —
 * prefer the object the CLI already checked, so a model that also wrote a
 * sentence alongside its tool call cannot fail the call on packaging. For
 * anything else, `result` verbatim. Packaging only: the object is emitted as
 * it came, nothing added or dropped.
 */
export function answerTextOf(event: ClaudeResultEvent, wantsJson: boolean): string {
  if (wantsJson && event.structured_output !== undefined && event.structured_output !== null) {
    return JSON.stringify(event.structured_output);
  }
  return typeof event.result === 'string' ? event.result : String(event.result ?? '');
}

/**
 * The CLI answered, and the answer was a failure: the model was asked, so a
 * repeat of the identical request cannot help and must not be paid for.
 *
 * `finishReason` is structural on purpose — `wasCutAtBudget` and
 * `describeGenerationFailure` in `llm-factory.ts` read `finishReason` off any
 * error in the cause chain, so a cut at the CLI's cap reaches line one as
 * `finish=length` through the seam that already exists, and nothing there
 * had to learn the claude-cli's name.
 */
/** What a failed answer still cost — a cut answer's thinking tokens are billed. */
export interface ClaudeAnswerUsage {
  costUsd: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  turns: number;
}

export class ClaudeAnswerError extends Error {
  readonly finishReason: 'length' | 'error';
  /** The CLI cap that cut the answer, when that is what happened. */
  readonly outputCap: number | null;
  /** The model's own ceiling, when the event named it. */
  readonly modelCeiling: number | null;
  /** The money and tokens the failed answer spent — a ledger row, not a loss. */
  readonly usage: ClaudeAnswerUsage | null;

  constructor(
    message: string,
    fields: {
      finishReason: 'length' | 'error';
      outputCap?: number | null;
      modelCeiling?: number | null;
      usage?: ClaudeAnswerUsage | null;
    },
  ) {
    super(message);
    this.name = 'ClaudeAnswerError';
    this.finishReason = fields.finishReason;
    this.outputCap = fields.outputCap ?? null;
    this.modelCeiling = fields.modelCeiling ?? null;
    this.usage = fields.usage ?? null;
  }
}

/** The per-call usage a `result` event carries, cost and turns already made deltas by the caller. */
export function usageOf(event: ClaudeResultEvent, costUsd: number, turns: number): ClaudeAnswerUsage {
  const usage = (event.usage ?? {}) as Record<string, unknown>;
  const num = (key: string): number => {
    const value = usage[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  };
  return {
    costUsd,
    inputTokens: num('input_tokens'),
    cachedInputTokens: num('cache_read_input_tokens'),
    cacheWriteTokens: num('cache_creation_input_tokens'),
    outputTokens: num('output_tokens'),
    turns,
  };
}

/**
 * The error for an `is_error` result. Worded exactly as the one-shot vector
 * always worded a refused call ("could not be asked — the provider refused
 * the call"), because `exit.ts`, `isKeyExhaustedError` and the healer all key
 * off that sentence to file an outage rather than an application defect. A
 * cut at the output cap says so instead, and names the dial — the words
 * "timeout"/"terminated"/"quota"/"rate limit" are deliberately absent, since
 * `isTransportError` and `isKeyExhaustedError` would misfile it on them.
 */
export function answerErrorOf(event: ClaudeResultEvent, usage: ClaudeAnswerUsage | null = null): ClaudeAnswerError {
  const cap = outputCapOf(event);
  const ceiling = modelOutputCeilingOf(event);
  if (cap !== null) {
    return new ClaudeAnswerError(
      `claude CLI answer was CUT OFF at the CLI's own output cap of ${cap} tokens (finish=length; ` +
        `nothing of the object arrived)${
          ceiling !== null && ceiling > cap
            ? ` — the model can emit ${ceiling}; set CLAUDE_CODE_MAX_OUTPUT_TOKENS above ${cap}`
            : " — this is the model's ceiling; the answer must be smaller"
        }`,
      { finishReason: 'length', outputCap: cap, modelCeiling: ceiling, usage },
    );
  }
  return new ClaudeAnswerError(
    `claude CLI could not be asked — the provider refused the call: ${
      typeof event.result === 'string' && event.result !== '' ? event.result : 'the claude session reported an error'
    }`,
    { finishReason: 'error', usage },
  );
}

/**
 * The cap a re-ask should run at after a cut, or null when raising cannot
 * help. One doubling toward the model's ceiling — the same rule as
 * `generateStructured`'s length re-ask — and never above what the model can
 * emit, because past that the identical cut is the only possible outcome.
 */
export function raisedOutputCap(error: ClaudeAnswerError): number | null {
  if (error.finishReason !== 'length' || error.outputCap === null) return null;
  if (error.modelCeiling === null || error.modelCeiling <= error.outputCap) return null;
  return Math.min(error.outputCap * 2, error.modelCeiling);
}
