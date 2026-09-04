/**
 * One line per model request and one per response, on stderr.
 *
 * stderr, never stdout: `--json` promises one parseable document on stdout
 * and the MCP server owns it outright, while stderr is exactly where the
 * panel's run drawer and an `npm run` console already show a run's narration.
 *
 * `WOWLIDATOR_LLM_LOG`: `on` (default — request, response summary, the
 * object cut at `WOWLIDATOR_LLM_LOG_CHARS`, default 1500), `full` (the whole
 * object), `off`. Nothing here may carry a key: the model label is
 * `provider:modelId`, the pacer id ends in the key's last four characters.
 */

import { currentLogTag } from '../log-format.js';

export type LlmLogMode = 'off' | 'on' | 'full';

function llmLogMode(env: NodeJS.ProcessEnv = process.env): LlmLogMode {
  const raw = env['WOWLIDATOR_LLM_LOG']?.trim().toLowerCase();
  if (raw === 'off' || raw === '0' || raw === 'false') return 'off';
  if (raw === 'full') return 'full';
  return 'on';
}

function llmLogChars(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env['WOWLIDATOR_LLM_LOG_CHARS']);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1500;
}

/** Running totals for this process, printed on every response line. */
const tally = { requests: 0, inputTokens: 0, outputTokens: 0 };

export function llmTally(): Readonly<typeof tally> {
  return { ...tally };
}

/** Test seam. */
export function resetLlmTally(): void {
  tally.requests = 0;
  tally.inputTokens = 0;
  tally.outputTokens = 0;
}

/**
 * The default sink prefixes the async context's log tag (`[c3]`,
 * `[HIR-EC-001]`) on every line of an entry, so a model call made on behalf
 * of a case lands under that case in the interleaved log rather than floating
 * between two cases' lines. Outside any tagged context — `doctor`, a single
 * `run` — nothing is added.
 */
function writeStderr(line: string): void {
  const tag = currentLogTag();
  const text = tag === undefined ? line : line.split('\n').map((l) => `${tag} ${l}`).join('\n');
  process.stderr.write(`${text}\n`);
}

let sink: (line: string) => void = writeStderr;

/** Test seam: capture lines instead of writing them. */
export function setLlmLogSink(next: ((line: string) => void) | null): void {
  sink = next ?? writeStderr;
}

/** A free-form line on the same channel (pacing notices), honouring `off`. */
export function logLlmLine(line: string, env: NodeJS.ProcessEnv = process.env): void {
  if (llmLogMode(env) === 'off') return;
  sink(`[llm ${stamp()}] ${line}`);
}

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export interface LlmRequestLog {
  /** The role asking, plus anything the caller added — "generator · PL_02_03". */
  task: string;
  modelLabel: string;
  system: string;
  prompt: string;
  estTokens: number;
  /** Attempt number within the re-ask/retry machinery, 1 for the first. */
  attempt: number;
  /** Pacer state, when the provider is paced. */
  pacing?: string | undefined;
}

export function logLlmRequest(entry: LlmRequestLog, env: NodeJS.ProcessEnv = process.env): void {
  if (llmLogMode(env) === 'off') return;
  tally.requests++;
  sink(
    `[llm ${stamp()}] → ${entry.task} · ${entry.modelLabel} · request #${tally.requests}` +
      (entry.attempt > 1 ? ` (attempt ${entry.attempt})` : '') +
      ` · ~${entry.estTokens} tokens in (${entry.system.length + entry.prompt.length} chars)` +
      (entry.pacing ? ` · ${entry.pacing}` : '') +
      `\n         ask: ${oneLine(entry.prompt, 160)}`,
  );
}

export interface LlmResponseLog {
  task: string;
  modelLabel: string;
  ms: number;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  object: unknown;
}

export function logLlmResponse(entry: LlmResponseLog, env: NodeJS.ProcessEnv = process.env): void {
  const mode = llmLogMode(env);
  if (mode === 'off') return;
  tally.inputTokens += entry.inputTokens ?? 0;
  tally.outputTokens += entry.outputTokens ?? 0;
  let body: string;
  try {
    body = JSON.stringify(entry.object);
  } catch {
    body = String(entry.object);
  }
  const max = llmLogChars(env);
  const shown = mode === 'full' || body.length <= max ? body : `${body.slice(0, max)}… (${body.length} chars)`;
  sink(
    `[llm ${stamp()}] ← ${entry.task} · ${entry.modelLabel} · ${(entry.ms / 1000).toFixed(1)}s · ` +
      `${entry.inputTokens ?? '?'} in / ${entry.outputTokens ?? '?'} out · ` +
      `session: ${tally.requests} req, ${tally.inputTokens} in / ${tally.outputTokens} out` +
      `\n         response: ${shown}`,
  );
}

export function logLlmFailure(
  entry: { task: string; modelLabel: string; ms: number; error: unknown; willRetryInMs?: number | undefined },
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (llmLogMode(env) === 'off') return;
  const message = entry.error instanceof Error ? entry.error.message : String(entry.error);
  sink(
    `[llm ${stamp()}] ✗ ${entry.task} · ${entry.modelLabel} · ${(entry.ms / 1000).toFixed(1)}s · ` +
      oneLine(message.replace(/https?:\/\/\S+/g, '<url>'), 300) +
      (entry.willRetryInMs !== undefined ? ` · retrying in ${Math.round(entry.willRetryInMs / 1000)}s` : ''),
  );
}
