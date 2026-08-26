/**
 * Claude Code's own CLI as an AI SDK provider.
 *
 * Every control-plane role in this system already sits behind a small
 * injectable interface, and every provider behind one entry in `FACTORIES` —
 * so "which model writes the tests" has always been configuration rather than
 * code. This is that seam used for the machine the harness is running on:
 * `claude -p`, driven as a completion model.
 *
 * It exists because a run can outlive a provider. Measured 2026-08-26: the
 * OpenRouter account behind all four roles hit its credit ceiling at case 22
 * of 108 ($100.008 of $100), every authoring call came back "Key limit
 * exceeded", and the suite could not continue at all. A provider that bills
 * to the operator's own Claude session is the one that is available exactly
 * when the others are not.
 *
 * Three decisions worth keeping:
 *
 *   * **The Claude Code system prompt is REPLACED, not appended to.** `-p`
 *     otherwise loads the whole agentic instruction set — tool protocols,
 *     file conventions — which this use has no need of, pays input tokens
 *     for on every call, and which would lean on a judge or an author that
 *     should see only the prompt it was given.
 *   * **It runs from a neutral directory.** A `claude` started inside this
 *     repository reads this repository's CLAUDE.md, and a model authoring
 *     tests for a *different* application must not be told how THIS codebase
 *     thinks. `--strict-mcp-config` keeps connected servers out for the same
 *     reason, and saves their startup on every call.
 *   * **No API key.** The CLI carries the operator's own session, so
 *     `PROVIDER_META` records no env var for it and the role gate treats it
 *     as always available.
 *
 * Structured output is NATIVE: the CLI takes `--json-schema` and validates
 * against it, so the schema is not restated in the prompt and a reply that
 * does not parse never costs a re-ask — which on this provider would mean
 * another process startup.
 *
 * It was briefly disabled on the belief that the CLI had rejected the AI
 * SDK's schema. That was wrong, and worth recording: the failure was the
 * usage limit arriving in the same minute, and `Command failed` reads
 * identically for both. Bisected afterwards against the exact schema that
 * "failed" — `$schema`, `additionalProperties: false`, nested arrays, all
 * accepted. The lesson is the ordinary one: a provider error and a quota
 * error look the same from outside, so neither should be diagnosed from one
 * observation.
 *
 * **What makes it slow is process startup, not the model.** Measured
 * 2026-08-26 across model and effort combinations: wall-clock minus the API's
 * own reported duration is a flat 3.4–4.3 s on every call, whatever the model
 * or the prompt size — Node boot, config load, session setup. At roughly
 * twenty calls to author and run one case, that is over a minute of pure
 * startup per case. `--effort` and the model choice move the API half;
 * nothing but reusing a process moves the other half.
 */

import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
} from '@ai-sdk/provider';

const run = promisify(execFile);

/** How long one completion may take. An authoring prompt is large and slow. */
export const CLAUDE_CLI_TIMEOUT_MS = 10 * 60 * 1000;
/** The reasoning effort every role gets unless its own env var says otherwise. */
export const DEFAULT_CLAUDE_CLI_EFFORT = 'high';

/**
 * Whether to hand the CLI the JSON Schema directly (`--json-schema`) rather
 * than stating it in the prompt. On by default — verified against the AI
 * SDK's own generated schemas. `WOWLIDATOR_CLAUDE_CLI_NATIVE_SCHEMA=0` falls
 * back to the prompt-shaped path if a future CLI ever regresses it.
 */
export const CLAUDE_CLI_NATIVE_SCHEMA =
  process.env['WOWLIDATOR_CLAUDE_CLI_NATIVE_SCHEMA'] !== '0';

/**
 * What this process has spent on the CLI.
 *
 * Module-level on purpose, and that is also what makes it honest: the meter
 * counts calls made by THIS process, which for a run is exactly the test
 * flow's own spend. A supervising session, a judge pass, or anything else
 * driving the CLI runs in its own process with its own counter, so nobody
 * else's tokens can land in a run's report.
 *
 * The CLI reports `total_cost_usd` per call, which is the real number rather
 * than an estimate from a price table that would drift the moment pricing
 * changed. `cachedInputTokens` is tracked apart because it is the bulk of
 * the input and bills at a fraction — a total that hid it would read as ten
 * times the spend it is.
 */
export interface ClaudeCliUsage {
  calls: number;
  costUsd: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** Wall time inside the CLI, including the process startup each call pays. */
  wallMs: number;
}

const usage: ClaudeCliUsage = {
  calls: 0,
  costUsd: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  wallMs: 0,
};

/** What this process has spent so far. A copy — the caller cannot edit the meter. */
export function claudeCliUsage(): ClaudeCliUsage {
  return { ...usage };
}

/** `after` minus `before`, for measuring one run's share of the meter. */
export function claudeCliUsageSince(before: ClaudeCliUsage): ClaudeCliUsage {
  const now = usage;
  return {
    calls: now.calls - before.calls,
    costUsd: now.costUsd - before.costUsd,
    inputTokens: now.inputTokens - before.inputTokens,
    cachedInputTokens: now.cachedInputTokens - before.cachedInputTokens,
    outputTokens: now.outputTokens - before.outputTokens,
    wallMs: now.wallMs - before.wallMs,
  };
}

/** `$schema` says nothing the CLI needs, and is the leading suspect for its rejection. */
export function withoutSchemaKeyword(schema: unknown): unknown {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  const { $schema: _dropped, ...rest } = schema as Record<string, unknown>;
  return rest;
}

/**
 * A directory with no CLAUDE.md, made once per process.
 *
 * Not `tmpdir()` itself: a stray CLAUDE.md left in /tmp by anything else
 * would silently start steering every call.
 */
let neutralDir: string | null = null;
function neutralCwd(): string {
  neutralDir ??= mkdtempSync(join(tmpdir(), 'wowlidator-claude-'));
  return neutralDir;
}

/**
 * The AI SDK's message array, flattened to the single prompt a CLI takes.
 *
 * System messages are returned apart so they can REPLACE the CLI's own system
 * prompt rather than being buried in the user turn — a model told "you are
 * driving a browser" in the user message and "you are Claude Code" in the
 * system one has been given two jobs.
 */
export function flattenPrompt(prompt: LanguageModelV4CallOptions['prompt']): {
  system: string;
  text: string;
} {
  const system: string[] = [];
  const turns: string[] = [];
  for (const message of prompt) {
    if (message.role === 'system') {
      system.push(message.content);
      continue;
    }
    const parts = Array.isArray(message.content)
      ? message.content
          .map((part) =>
            part.type === 'text'
              ? part.text
              : // A non-text part cannot be sent through a text CLI, and
                // dropping it silently would produce a confident answer about
                // evidence the model never saw.
                `[unsupported ${part.type} part omitted]`,
          )
          .join('\n')
      : String(message.content);
    turns.push(message.role === 'assistant' ? `Assistant: ${parts}` : parts);
  }
  return { system: system.join('\n\n'), text: turns.join('\n\n') };
}

/** What the CLI prints under `--output-format json`. */
interface CliEnvelope {
  result?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

export interface ClaudeCliOptions {
  /** `fable`, `opus`, `sonnet`, `haiku`, or a full id. */
  modelId: string;
  /**
   * Reasoning effort. Higher costs more and thinks longer — measured at 15k
   * tokens of prompt, fable/high answered in 6.1 s of API time against
   * sonnet/low's 3.0 s, at four times the price. The roles called most often
   * (healer, agent, data) make one small decision at a time and want `low`;
   * authoring is the one that earns `high`.
   */
  effort?: string | undefined;
  /** Overridable for tests — the binary to run. */
  binary?: string | undefined;
  timeoutMs?: number | undefined;
}

export function createClaudeCli(options: ClaudeCliOptions): LanguageModelV4 {
  const binary = options.binary ?? 'claude';
  const effort = options.effort ?? DEFAULT_CLAUDE_CLI_EFFORT;
  const timeout = options.timeoutMs ?? CLAUDE_CLI_TIMEOUT_MS;

  return {
    specificationVersion: 'v4',
    provider: 'claude-cli',
    modelId: options.modelId,
    supportedUrls: {},

    async doGenerate(call: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
      const startedMs = Date.now();
      const { system, text } = flattenPrompt(call.prompt);
      // The CLI validates against the schema itself, so it is not restated
      // in the prompt. `$schema` is dropped as a courtesy — it tells the CLI
      // nothing it needs — not because it was ever the problem.
      const schema =
        CLAUDE_CLI_NATIVE_SCHEMA &&
        call.responseFormat?.type === 'json' &&
        call.responseFormat.schema !== undefined
          ? JSON.stringify(withoutSchemaKeyword(call.responseFormat.schema))
          : null;
      const args = [
        '-p',
        '--model',
        options.modelId,
        '--effort',
        effort,
        '--output-format',
        'json',
        // Replaced, never appended — see the note at the top of this file.
        '--system-prompt',
        system === ''
          ? 'You answer exactly what is asked, with no preamble and no commentary.'
          : system,
        '--strict-mcp-config',
        ...(schema === null ? [] : ['--json-schema', schema]),
        text,
      ];

      let envelope: CliEnvelope;
      try {
        const { stdout } = await run(binary, args, {
          cwd: neutralCwd(),
          timeout,
          maxBuffer: 32 * 1024 * 1024,
        });
        envelope = JSON.parse(stdout) as CliEnvelope;
      } catch (error) {
        // Worded as a provider fact. `generateStructured` and the healer both
        // key off "the provider refused the call" to keep a model outage from
        // being filed as an application defect.
        throw new Error(
          `claude CLI could not be asked — the provider refused the call: ${
            error instanceof Error ? error.message.split('\n')[0] : String(error)
          }`,
        );
      }
      if (envelope.is_error === true) {
        throw new Error(`claude CLI could not be asked — the provider refused the call: ${envelope.result ?? 'unknown error'}`);
      }

      const answer = String(envelope.result ?? '');
      usage.calls += 1;
      usage.costUsd += envelope.total_cost_usd ?? 0;
      usage.wallMs += Date.now() - startedMs;
      const input = envelope.usage?.input_tokens ?? 0;
      const cacheRead = envelope.usage?.cache_read_input_tokens ?? 0;
      const cacheWrite = envelope.usage?.cache_creation_input_tokens ?? 0;
      const output = envelope.usage?.output_tokens ?? 0;

      usage.inputTokens += input;
      usage.cachedInputTokens += cacheRead;
      usage.outputTokens += output;

      return {
        content: answer === '' ? [] : [{ type: 'text', text: answer }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          // `total` includes what was served from cache: it is what the call
          // actually weighed, which is the number a token budget is about.
          inputTokens: {
            total: input + cacheRead + cacheWrite,
            noCache: input,
            cacheRead,
            cacheWrite,
          },
          outputTokens: { total: output, text: output, reasoning: 0 },
        },
        warnings: [],
      };
    },

    doStream(): never {
      // Nothing in this system streams — every call site is `generateObject`
      // or `generateText`. Saying so is better than a shim that pretends.
      throw new Error('claude-cli does not stream; this system never asks it to');
    },
  };
}
