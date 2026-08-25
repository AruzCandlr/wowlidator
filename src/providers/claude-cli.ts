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
 * Structured output is prompt-shaped, not native: `claude-cli` joins
 * `SCHEMA_IN_PROMPT_PROVIDERS`, the schema is stated in the prompt, and the
 * JSON is parsed out of the reply. The CLI has no `response_format`, and
 * pretending otherwise would fail on the first `generateObject`.
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
  /** Reasoning effort. Higher costs more and thinks longer. */
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
      const { system, text } = flattenPrompt(call.prompt);
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
      const input = envelope.usage?.input_tokens ?? 0;
      const cacheRead = envelope.usage?.cache_read_input_tokens ?? 0;
      const cacheWrite = envelope.usage?.cache_creation_input_tokens ?? 0;
      const output = envelope.usage?.output_tokens ?? 0;

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
