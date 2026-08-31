/**
 * A persistent tracker for `claude -p` calls specifically.
 *
 * The in-memory meter in `claude-cli.ts` answers "what did THIS process
 * spend" — which is right for a run's proof bundle and deliberately dies
 * with the process. It cannot answer the question that comes after a day of
 * catalog runs: how many `claude -p` calls happened on this machine, on
 * which models, and what did they cost — across every CLI process the panel
 * spawned. The rate pacer already persists day counts for the same
 * many-processes reason (`.wowlidator/llm-usage.json`); this is that move
 * for the Claude CLI.
 *
 * One JSONL line per completed `claude -p` call, appended to
 * `.wowlidator/claude-cli-usage.jsonl` in the working directory
 * (`WOWLIDATOR_CLAUDE_CLI_USAGE_PATH` overrides;
 * `WOWLIDATOR_CLAUDE_CLI_USAGE=off` disables). Only `claude-cli` writes
 * here: `claude-tty` and `claude-cloud` are interactive terminals whose text
 * carries no usage, and inventing rows for them would make the ledger lie.
 * Appends are fire-and-forget and never throw — a ledger must not become a
 * new way for a call that already succeeded to fail. An unwritable path is
 * complained about once per process, on stderr, not per call.
 *
 * Day boundaries in the summary are UTC, same as the pacer, and disclosed
 * rather than hidden.
 */

import { appendFile, readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** One completed `claude -p` call, as recorded. */
export interface ClaudeCliCallRecord {
  /** ISO time the call finished. */
  ts: string;
  /** The model as asked for — `fable`, `sonnet`, or a full id. */
  modelId: string;
  /** `warm` reused a stream-json session; `cold` paid a full process start. */
  path: 'warm' | 'cold';
  costUsd: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  /** Wall time of the whole call, process startup included. */
  wallMs: number;
  /** The process that made the call — lets one run's rows be told apart. */
  pid: number;
  /**
   * Model turns the call took. Above 1 means tool use — for the retrieval
   * roles, the only record that `search_context` was consulted. Absent on
   * rows written before 2026-08-27.
   */
  turns?: number | undefined;
  /** The role that asked (`generator`, `healer`, …). Absent on older rows. */
  role?: string | undefined;
}

export function claudeCliUsageEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env['WOWLIDATOR_CLAUDE_CLI_USAGE']?.trim().toLowerCase();
  return !(raw === 'off' || raw === '0' || raw === 'false');
}

export function claudeCliUsagePath(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env['WOWLIDATOR_CLAUDE_CLI_USAGE_PATH']?.trim();
  return raw !== undefined && raw !== ''
    ? raw
    : join(process.cwd(), '.wowlidator', 'claude-cli-usage.jsonl');
}

let complained = false;

/**
 * Append one call to the ledger. Fire-and-forget: the returned promise is
 * for tests; production call sites drop it, and no failure here can surface
 * into the call that produced the record.
 */
export async function recordClaudeCliCall(
  record: ClaudeCliCallRecord,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!claudeCliUsageEnabled(env)) return;
  const path = claudeCliUsagePath(env);
  try {
    // Sync and idempotent; appendFile alone would fail on the first run in a
    // fresh working directory before anything else created `.wowlidator/`.
    mkdirSync(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8');
  } catch (error) {
    if (!complained) {
      complained = true;
      process.stderr.write(
        `[wowlidator] could not write the claude -p usage ledger at ${path}: ${
          error instanceof Error ? (error.message.split('\n')[0] ?? error.message) : String(error)
        } — calls still work; tracking is off for this process\n`,
      );
    }
  }
}

/** Test seam: the once-per-process complaint is module state. */
export function resetClaudeCliUsageComplaint(): void {
  complained = false;
}

/**
 * Read the ledger back. A corrupt line — a crash mid-append, a hand edit —
 * is skipped rather than sinking the whole history, the same rule as the
 * run-history reader. Missing file = empty ledger, not an error.
 */
export async function readClaudeCliUsage(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ClaudeCliCallRecord[]> {
  let raw: string;
  try {
    raw = await readFile(claudeCliUsagePath(env), 'utf8');
  } catch {
    return [];
  }
  const records: ClaudeCliCallRecord[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line) as ClaudeCliCallRecord;
      if (typeof parsed?.ts === 'string' && typeof parsed.modelId === 'string') {
        records.push(parsed);
      }
    } catch {
      // A broken line loses one call, never the ledger.
    }
  }
  return records;
}

/** Totals for one slice of the ledger. */
export interface ClaudeCliUsageTotals {
  calls: number;
  costUsd: number;
  inputTokens: number;
  cachedInputTokens: number;
  /**
   * Tokens written INTO the cache. Split out from the read side because the
   * two answer different questions and only together say whether a session's
   * context is being paid for once or over and over — the measurement that
   * `sessionTurnBudget` exists to move.
   */
  cacheWriteTokens: number;
  outputTokens: number;
  wallMs: number;
  /** How many of the calls rode a warm session instead of a process start. */
  warmCalls: number;
  /**
   * Session turns these calls took, summed. Divided by `calls` it is the
   * average conversation depth an ask carried — the number to watch after a
   * turn-budget change.
   */
  turns: number;
}

export interface ClaudeCliUsageSummary {
  /** Everything the ledger holds. */
  total: ClaudeCliUsageTotals;
  /** The current UTC day only — the boundary the pacer also uses. */
  today: ClaudeCliUsageTotals;
  /** Per model asked for, all-time, largest spender first. */
  byModel: (ClaudeCliUsageTotals & { modelId: string })[];
  /**
   * Per role, all-time, largest spender first. The slice that answers "what
   * is authoring actually costing" — and, with `cachedInputTokens / calls`,
   * whether a role's sessions are carrying context it never needed. Calls the
   * ledger recorded without a role are bucketed as `unattributed`.
   */
  byRole: (ClaudeCliUsageTotals & { role: string })[];
  /** ISO time of the most recent call, or null for an empty ledger. */
  lastCallAt: string | null;
}

function emptyTotals(): ClaudeCliUsageTotals {
  return {
    calls: 0,
    costUsd: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    wallMs: 0,
    warmCalls: 0,
    turns: 0,
  };
}

function add(into: ClaudeCliUsageTotals, record: ClaudeCliCallRecord): void {
  into.calls += 1;
  into.costUsd += record.costUsd || 0;
  into.inputTokens += record.inputTokens || 0;
  into.cachedInputTokens += record.cachedInputTokens || 0;
  into.cacheWriteTokens += record.cacheWriteTokens || 0;
  into.outputTokens += record.outputTokens || 0;
  into.wallMs += record.wallMs || 0;
  into.turns += record.turns || 0;
  if (record.path === 'warm') into.warmCalls += 1;
}

/**
 * Aggregate the ledger. Pure, so it is testable against a written shape and
 * usable on any slice a caller filters out first. `now` is injectable for
 * the same reason.
 */
export function summarizeClaudeCliUsage(
  records: readonly ClaudeCliCallRecord[],
  now: Date = new Date(),
): ClaudeCliUsageSummary {
  const total = emptyTotals();
  const today = emptyTotals();
  const models = new Map<string, ClaudeCliUsageTotals>();
  const roles = new Map<string, ClaudeCliUsageTotals>();
  const utcDay = now.toISOString().slice(0, 10);
  let lastCallAt: string | null = null;
  for (const record of records) {
    add(total, record);
    if (record.ts.slice(0, 10) === utcDay) add(today, record);
    let forModel = models.get(record.modelId);
    if (forModel === undefined) {
      forModel = emptyTotals();
      models.set(record.modelId, forModel);
    }
    add(forModel, record);
    const roleName = record.role ?? 'unattributed';
    let forRole = roles.get(roleName);
    if (forRole === undefined) {
      forRole = emptyTotals();
      roles.set(roleName, forRole);
    }
    add(forRole, record);
    if (lastCallAt === null || record.ts > lastCallAt) lastCallAt = record.ts;
  }
  return {
    total,
    today,
    byModel: [...models.entries()]
      .map(([modelId, totals]) => ({ modelId, ...totals }))
      .sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls),
    byRole: [...roles.entries()]
      .map(([role, totals]) => ({ role, ...totals }))
      .sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls),
    lastCallAt,
  };
}
