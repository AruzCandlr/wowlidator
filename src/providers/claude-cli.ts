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

import { askWarm, closeClaudeSessions, sessionTurnBudget } from './claude-cli-session.js';
import { recordClaudeCliCall } from './claude-cli-usage-log.js';
import {
  claudeRetrievalCorpusSize,
  ensureClaudeRetrievalServer,
  RETRIEVAL_SERVER_NAME,
  RETRIEVAL_TOOL_FULL,
} from './claude-retrieval.js';
import { assertUnderUsageCap } from './usage-cap.js';
import { extractStructuredJson } from './model-output.js';
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
} from '@ai-sdk/provider';

const run = promisify(execFile);

/**
 * Whether to reuse a warm process instead of spawning one per call.
 *
 * On by default: measured, it takes a call from ~6 s to ~1.2 s by paying the
 * CLI's 3.4-4.3 s startup once per forty calls rather than once per call.
 * `WOWLIDATOR_CLAUDE_CLI_WARM=0` forces the one-shot path, which is also
 * where every warm failure falls back to.
 */
export const CLAUDE_CLI_WARM = process.env['WOWLIDATOR_CLAUDE_CLI_WARM'] !== '0';

export { closeClaudeSessions };

/** How long one completion may take. An authoring prompt is large and slow. */
export const CLAUDE_CLI_TIMEOUT_MS = 10 * 60 * 1000;
/** The reasoning effort every role gets unless its own env var says otherwise. */
export const DEFAULT_CLAUDE_CLI_EFFORT =
  process.env['WOWLIDATOR_CLAUDE_CLI_EFFORT'] ||
  process.env['CLAUDE_CLI_EFFORT'] ||
  'high';

/** Format tool parameter (string or array) into a CLI argument string. */
export function formatToolArg(val: string | readonly string[] | undefined | null): string | null {
  if (val === undefined || val === null) return null;
  if (Array.isArray(val)) {
    return val.length === 0 ? '' : val.join(',');
  }
  return String(val);
}

/**
 * Whether to hand the CLI the JSON Schema directly (`--json-schema`) rather
 * than stating it in the prompt. On by default — verified against the AI
 * SDK's own generated schemas. `WOWLIDATOR_CLAUDE_CLI_NATIVE_SCHEMA=0` falls
 * back to the prompt-shaped path if a future CLI ever regresses it.
 */
export const CLAUDE_CLI_NATIVE_SCHEMA =
  process.env['WOWLIDATOR_CLAUDE_CLI_NATIVE_SCHEMA'] !== '0';

/**
 * Whether a role that opted in (`ClaudeCliOptions.retrieval` — the generator
 * and the healer, see `llm-factory.ts`) gets the BM25 `search_context` tool
 * over the run's registered corpus. On by default; the tool only actually
 * attaches when a command has registered something to search
 * (`setClaudeRetrievalCorpus`), so a bare run is unchanged.
 * `WOWLIDATOR_CLAUDE_CLI_RETRIEVAL=0` turns it off everywhere.
 */
export const CLAUDE_CLI_RETRIEVAL = process.env['WOWLIDATOR_CLAUDE_CLI_RETRIEVAL'] !== '0';

/**
 * The `--mcp-config` + merged `--allowed-tools` for a retrieval-enabled call,
 * or null when there is nothing to search or the loopback server refused to
 * start — in which case the call runs exactly as it would have without the
 * feature. `=` forms throughout: both flags are variadic (see the args note).
 */
async function retrievalArgs(
  enabled: boolean,
  allowedTools: string | null,
): Promise<{ mcpConfig: string | null; allowedTools: string | null }> {
  if (!enabled || !CLAUDE_CLI_RETRIEVAL || claudeRetrievalCorpusSize() === 0) {
    return { mcpConfig: null, allowedTools };
  }
  const url = await ensureClaudeRetrievalServer();
  if (url === null) return { mcpConfig: null, allowedTools };
  return {
    mcpConfig: JSON.stringify({ mcpServers: { [RETRIEVAL_SERVER_NAME]: { type: 'http', url } } }),
    allowedTools:
      allowedTools === null || allowedTools === ''
        ? RETRIEVAL_TOOL_FULL
        : `${allowedTools},${RETRIEVAL_TOOL_FULL}`,
  };
}

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
/** One role's share of the meter — who spent it, not only how much. */
export interface ClaudeCliRoleSpend {
  calls: number;
  costUsd: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface ClaudeCliUsage {
  calls: number;
  costUsd: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** Wall time inside the CLI, including the process startup each call pays. */
  wallMs: number;
  /**
   * The same spend split by the ROLE that asked (`generator`, `healer`,
   * `agent`, `data` — whatever `createModelForRole` stamped on the model).
   * "This flow cost $2, of which authoring was $1.60 and heals $0.30" was
   * unanswerable before this: the meter knew the total and nothing else.
   */
  byRole: Record<string, ClaudeCliRoleSpend>;
}

const usage: ClaudeCliUsage = {
  calls: 0,
  costUsd: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  wallMs: 0,
  byRole: {},
};

function roleBucket(role: string): ClaudeCliRoleSpend {
  return (usage.byRole[role] ??= {
    calls: 0,
    costUsd: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  });
}

/** What this process has spent so far. A copy — the caller cannot edit the meter. */
export function claudeCliUsage(): ClaudeCliUsage {
  return {
    ...usage,
    byRole: Object.fromEntries(Object.entries(usage.byRole).map(([role, spend]) => [role, { ...spend }])),
  };
}

/** `after` minus `before`, for measuring one run's share of the meter. */
export function claudeCliUsageSince(before: ClaudeCliUsage): ClaudeCliUsage {
  const now = usage;
  const byRole: Record<string, ClaudeCliRoleSpend> = {};
  for (const [role, spend] of Object.entries(now.byRole)) {
    const prior = before.byRole[role];
    const delta: ClaudeCliRoleSpend = {
      calls: spend.calls - (prior?.calls ?? 0),
      costUsd: spend.costUsd - (prior?.costUsd ?? 0),
      inputTokens: spend.inputTokens - (prior?.inputTokens ?? 0),
      cachedInputTokens: spend.cachedInputTokens - (prior?.cachedInputTokens ?? 0),
      outputTokens: spend.outputTokens - (prior?.outputTokens ?? 0),
    };
    // A role that asked nothing in this slice says nothing about it.
    if (delta.calls > 0) byRole[role] = delta;
  }
  return {
    calls: now.calls - before.calls,
    costUsd: now.costUsd - before.costUsd,
    inputTokens: now.inputTokens - before.inputTokens,
    cachedInputTokens: now.cachedInputTokens - before.cachedInputTokens,
    outputTokens: now.outputTokens - before.outputTokens,
    wallMs: now.wallMs - before.wallMs,
    byRole,
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
  num_turns?: number;
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
   * Choices: 'low', 'medium', 'high', 'xhigh', 'max'.
   */
  effort?: string | undefined;
  /**
   * Tools to make available to the Claude session via `--tools`.
   * Accepts a string (e.g. `""` to disable all tools, `"default"` for all built-ins,
   * or a comma/space-separated list like `"Bash,Edit,Read"`) or an array of tool names.
   * If unset, falls back to `WOWLIDATOR_CLAUDE_CLI_TOOLS` or `CLAUDE_CLI_TOOLS`.
   */
  tools?: string | readonly string[] | undefined;
  /**
   * Allowed tools via `--allowed-tools`.
   * Comma or space-separated list or array of tool names/patterns (e.g. `"Bash(git *) Edit"`).
   * If unset, falls back to `WOWLIDATOR_CLAUDE_CLI_ALLOWED_TOOLS` or `CLAUDE_CLI_ALLOWED_TOOLS`.
   */
  allowedTools?: string | readonly string[] | undefined;
  /**
   * Disallowed tools via `--disallowed-tools`.
   * Comma or space-separated list or array of tool names/patterns.
   * If unset, falls back to `WOWLIDATOR_CLAUDE_CLI_DISALLOWED_TOOLS` or `CLAUDE_CLI_DISALLOWED_TOOLS`.
   */
  disallowedTools?: string | readonly string[] | undefined;
  /**
   * Whether this role may search the run's registered corpus (repo context
   * graph + context documents) via the loopback BM25 MCP tool. Set for the
   * generator, healer and agent roles; see `claude-retrieval.ts`.
   */
  retrieval?: boolean | undefined;
  /**
   * Which role this model serves — stamps the meter's `byRole` bucket and
   * the ledger row, so "what did authoring cost this flow" is answerable.
   */
  role?: string | undefined;
  /** Overridable for tests — the binary to run. */
  binary?: string | undefined;
  timeoutMs?: number | undefined;
}

export function createClaudeCli(options: ClaudeCliOptions): LanguageModelV4 {
  // The command this provider runs is HARDCODED below, on request
  // (2026-08-27): it briefly went through the editable args template that
  // `claude-tty`/`claude-cloud` still use, and was rolled back so the vector
  // can be edited directly in this file. To change what `claude -p` runs,
  // edit the `args` array in `doGenerate` below — and the warm session's
  // launch args in `claude-cli-session.ts`, which must stay in step (or set
  // WOWLIDATOR_CLAUDE_CLI_WARM=0 so only this file's vector runs).
  const binary = options.binary ?? 'claude';
  const effort =
    options.effort ??
    process.env['WOWLIDATOR_CLAUDE_CLI_EFFORT'] ??
    process.env['CLAUDE_CLI_EFFORT'] ??
    DEFAULT_CLAUDE_CLI_EFFORT;
  const timeout = options.timeoutMs ?? CLAUDE_CLI_TIMEOUT_MS;

  // Tools default to NONE, not to the CLI's default set. Every role here is
  // ask→answer: the built-in tool schemas would be paid for on every cold
  // start (as cache-write on warm ones), and a model that can reach for Bash
  // or Read answers from what it fetched, not from the evidence it was given.
  // `WOWLIDATOR_CLAUDE_CLI_TOOLS=default` restores the full set.
  const resolvedTools = formatToolArg(
    options.tools ??
      process.env['WOWLIDATOR_CLAUDE_CLI_TOOLS'] ??
      process.env['CLAUDE_CLI_TOOLS'] ??
      '',
  );
  const resolvedAllowedTools = formatToolArg(
    options.allowedTools ??
      process.env['WOWLIDATOR_CLAUDE_CLI_ALLOWED_TOOLS'] ??
      process.env['CLAUDE_CLI_ALLOWED_TOOLS'] ??
      null,
  );
  const resolvedDisallowedTools = formatToolArg(
    options.disallowedTools ??
      process.env['WOWLIDATOR_CLAUDE_CLI_DISALLOWED_TOOLS'] ??
      process.env['CLAUDE_CLI_DISALLOWED_TOOLS'] ??
      null,
  );

  return {
    specificationVersion: 'v4',
    provider: 'claude-cli',
    modelId: options.modelId,
    supportedUrls: {},

    async doGenerate(call: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
      // The session usage cap, enforced in EVERY process — a run the panel
      // never saw refuses its next call here. TTL-cached; throws only on a
      // confirmed trip, worded as a provider refusal (an environment fact).
      await assertUnderUsageCap();
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
      // The BM25 search tool, when this role has it and there is a corpus.
      const retrieval = await retrievalArgs(options.retrieval ?? false, resolvedAllowedTools);
      // THE `claude -p` COMMAND. Edit this array to change what runs.
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
        // No settings, hooks, plugins or skills: nothing outside the prompt
        // may steer an answer, and none of it is paid for at startup.
        '--setting-sources',
        '',
        '--disable-slash-commands',
        // A per-call transcript on disk serves nobody — the proof bundle is
        // the record — and skipping it removes a write per turn.
        '--no-session-persistence',
        // `=` form on purpose: these flags are variadic, and the space form
        // with an empty value swallows the positional prompt (measured —
        // "Input must be provided either through stdin or as a prompt").
        ...(resolvedTools !== null ? [`--tools=${resolvedTools}`] : []),
        ...(retrieval.allowedTools !== null ? [`--allowed-tools=${retrieval.allowedTools}`] : []),
        ...(resolvedDisallowedTools !== null ? [`--disallowed-tools=${resolvedDisallowedTools}`] : []),
        ...(retrieval.mcpConfig === null ? [] : [`--mcp-config=${retrieval.mcpConfig}`]),
        ...(schema === null ? [] : ['--json-schema', schema]),
        text,
      ];

      // **The warm path.** A process already running answers in about a fifth
      // of the time, because the startup was paid by an earlier call. Any
      // failure here falls through to the one-shot path below rather than
      // failing the call: a reused process is an optimisation, never a new
      // way for a run to break.
      if (CLAUDE_CLI_WARM) {
        try {
          const warm = await askWarm(
            {
              binary,
              cwd: neutralCwd(),
              modelId: options.modelId,
              effort,
              system,
              schema,
              tools: resolvedTools,
              allowedTools: retrieval.allowedTools,
              disallowedTools: resolvedDisallowedTools,
              mcpConfig: retrieval.mcpConfig,
            },
            text,
            // Per-role: authoring asks are independent of each other and pay
            // for every earlier row they carry — see `sessionTurnBudget`.
            sessionTurnBudget(options.role),
          );
          usage.calls += 1;
          usage.costUsd += warm.costUsd;
          usage.wallMs += Date.now() - startedMs;
          usage.inputTokens += warm.inputTokens;
          usage.cachedInputTokens += warm.cachedInputTokens;
          usage.outputTokens += warm.outputTokens;
          const warmRole = roleBucket(options.role ?? 'unattributed');
          warmRole.calls += 1;
          warmRole.costUsd += warm.costUsd;
          warmRole.inputTokens += warm.inputTokens;
          warmRole.cachedInputTokens += warm.cachedInputTokens;
          warmRole.outputTokens += warm.outputTokens;
          // The cross-process ledger — fire-and-forget; see its module header.
          void recordClaudeCliCall({
            ts: new Date().toISOString(),
            modelId: options.modelId,
            path: 'warm',
            costUsd: warm.costUsd,
            inputTokens: warm.inputTokens,
            cachedInputTokens: warm.cachedInputTokens,
            cacheWriteTokens: warm.cacheWriteTokens,
            outputTokens: warm.outputTokens,
            wallMs: Date.now() - startedMs,
            pid: process.pid,
            turns: warm.turns,
            ...(options.role === undefined ? {} : { role: options.role }),
          });
          // A JSON answer is unwrapped from fences/prose before the SDK
          // parses it — packaging repair only; see `extractStructuredJson`.
          const warmText =
            call.responseFormat?.type === 'json' ? extractStructuredJson(warm.text) : warm.text;
          return {
            content: warmText === '' ? [] : [{ type: 'text', text: warmText }],
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: {
                total: warm.inputTokens + warm.cachedInputTokens + warm.cacheWriteTokens,
                noCache: warm.inputTokens,
                cacheRead: warm.cachedInputTokens,
                cacheWrite: warm.cacheWriteTokens,
              },
              outputTokens: { total: warm.outputTokens, text: warm.outputTokens, reasoning: 0 },
            },
            warnings: [],
          };
        } catch {
          // Fall through and ask the cold way.
        }
      }

      let envelope: CliEnvelope;
      try {
        const { stdout } = await run(binary, args, {
          cwd: neutralCwd(),
          timeout,
          maxBuffer: 32 * 1024 * 1024,
          // The version check and telemetry are network calls inside the
          // 3.4-4.3s startup this provider pays; a model call needs neither.
          env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
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

      // Same packaging repair as the warm path — the two vectors stay in step.
      const answer =
        call.responseFormat?.type === 'json'
          ? extractStructuredJson(String(envelope.result ?? ''))
          : String(envelope.result ?? '');
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
      const coldRole = roleBucket(options.role ?? 'unattributed');
      coldRole.calls += 1;
      coldRole.costUsd += envelope.total_cost_usd ?? 0;
      coldRole.inputTokens += input;
      coldRole.cachedInputTokens += cacheRead;
      coldRole.outputTokens += output;

      // Same ledger as the warm path — one row per `claude -p` call.
      void recordClaudeCliCall({
        ts: new Date().toISOString(),
        modelId: options.modelId,
        path: 'cold',
        costUsd: envelope.total_cost_usd ?? 0,
        inputTokens: input,
        cachedInputTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        outputTokens: output,
        wallMs: Date.now() - startedMs,
        pid: process.pid,
        turns: envelope.num_turns ?? 1,
        ...(options.role === undefined ? {} : { role: options.role }),
      });

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
