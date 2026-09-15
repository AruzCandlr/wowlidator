/**
 * A persistent tracker for calls to an HTTP API provider — the ledger
 * `claude-cli-usage-log.ts` is for `claude -p`, for everything else.
 *
 * Why it exists (2026-09-10, a BE catalog on `emmiedev:default`): the run was
 * stopped after four minutes and NOTHING on this machine could say what the
 * model layer had done. The monitor's model panel reads
 * `claude-cli-usage.jsonl`, which only `claude-cli` writes, so an API run
 * showed an empty panel — indistinguishable from a run that had made no call
 * at all. A provider chosen per run cannot mean a blind run.
 *
 * One JSONL line per completed call, appended to `.wowlidator/api-usage.jsonl`
 * in the working directory (`WOWLIDATOR_API_USAGE_PATH` overrides,
 * `WOWLIDATOR_API_USAGE=off` disables). **`claude-*` providers never write
 * here** — they have their own ledger and their own cost accounting, and a
 * row invented for them would be counted twice.
 *
 * Cost is not recorded. An OpenAI-compatible endpoint states tokens and never
 * a price, and a price this file guessed from a table would drift the way
 * model ids drift; tokens are what the provider actually said. Appends are
 * fire-and-forget and never throw: a ledger must not become a new way for a
 * call that already succeeded to fail.
 *
 * Day boundaries in the summary are UTC, the same as the pacer's.
 */

import { appendFile, readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** One completed API call, as recorded. */
export interface ApiCallRecord {
  /** ISO time the call finished. */
  ts: string;
  /** The provider as configured — `emmiedev`, `groq`, `openrouter`, … */
  provider: string;
  /** The model as asked for. */
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  /** Wall time of the whole call. */
  wallMs: number;
  /** The process that made the call — lets one run's rows be told apart. */
  pid: number;
  /** The role that asked (`generator`, `healer`, …). */
  role?: string | undefined;
  /**
   * Why the call ended when it did not end with an answer: `refused` is the
   * provider turning it away (rate limit, quota, concurrency, credential),
   * `error` anything else. Absent on a call that answered. A refused call
   * costs no tokens and is recorded anyway — it is the row that explains a
   * run that went quiet.
   */
  finish?: 'refused' | 'error' | undefined;
  /** The first line of the failure, for a refused or errored row. */
  detail?: string | undefined;
}

/**
 * A test process spends no provider's quota, so it writes no row.
 *
 * Measured the day this ledger landed: `npm test` drives `generateStructured`
 * against `MockLanguageModelV4` hundreds of times, and every one of those
 * mock answers was appended to the machine's real ledger — 351 rows with no
 * role, a provider of `groq` and a model of `some-free-model`, mixed in with
 * what actual runs had spent. A ledger a test suite can write to is a ledger
 * nobody can read an answer out of. `NODE_TEST_CONTEXT` is set by the Node
 * test runner in every test process and by nothing else.
 */
function inTestProcess(env: NodeJS.ProcessEnv): boolean {
  return (env['NODE_TEST_CONTEXT'] ?? '') !== '';
}

export function apiUsageEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (inTestProcess(env)) return false;
  const raw = env['WOWLIDATOR_API_USAGE']?.trim().toLowerCase();
  return !(raw === 'off' || raw === '0' || raw === 'false');
}

export function apiUsagePath(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env['WOWLIDATOR_API_USAGE_PATH']?.trim();
  return raw !== undefined && raw !== ''
    ? raw
    : join(process.cwd(), '.wowlidator', 'api-usage.jsonl');
}

let complained = false;

/**
 * Append one call. Fire-and-forget: the returned promise is for tests;
 * production call sites drop it, and no failure here surfaces into the call
 * that produced the record.
 */
export async function recordApiCall(
  record: ApiCallRecord,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!apiUsageEnabled(env)) return;
  const path = apiUsagePath(env);
  try {
    mkdirSync(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8');
  } catch (error) {
    if (!complained) {
      complained = true;
      process.stderr.write(
        `[wowlidator] could not write the API usage ledger at ${path}: ${
          error instanceof Error ? (error.message.split('\n')[0] ?? error.message) : String(error)
        } — calls still work; tracking is off for this process\n`,
      );
    }
  }
}

/** Test seam: the once-per-process complaint is module state. */
export function resetApiUsageComplaint(): void {
  complained = false;
}

/**
 * Read the ledger back. A corrupt line — a crash mid-append, a hand edit — is
 * skipped rather than sinking the whole history; a missing file is an empty
 * ledger, not an error. Same rule as the run-history reader.
 */
export async function readApiUsage(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ApiCallRecord[]> {
  let raw: string;
  try {
    raw = await readFile(apiUsagePath(env), 'utf8');
  } catch {
    return [];
  }
  const records: ApiCallRecord[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line) as ApiCallRecord;
      if (typeof parsed?.ts === 'string' && typeof parsed.provider === 'string') {
        records.push(parsed);
      }
    } catch {
      // A broken line loses one call, never the ledger.
    }
  }
  return records;
}

/** Totals for one slice of the ledger. */
export interface ApiUsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  wallMs: number;
  /** Calls the provider turned away — the number that explains a stalled run. */
  refusals: number;
  /** Calls that failed for any other reason. */
  errors: number;
}

export interface ApiUsageSummary {
  total: ApiUsageTotals;
  /** The current UTC day only. */
  today: ApiUsageTotals;
  /** Per provider, all-time, busiest first. */
  byProvider: (ApiUsageTotals & { provider: string })[];
  /** Per role, all-time, busiest first. Rows without a role bucket as `unattributed`. */
  byRole: (ApiUsageTotals & { role: string })[];
  /** Per model asked for, all-time, busiest first. */
  byModel: (ApiUsageTotals & { modelId: string })[];
  lastCallAt: string | null;
}

function emptyTotals(): ApiUsageTotals {
  return { calls: 0, inputTokens: 0, outputTokens: 0, wallMs: 0, refusals: 0, errors: 0 };
}

function add(into: ApiUsageTotals, record: ApiCallRecord): void {
  into.calls += 1;
  into.inputTokens += record.inputTokens || 0;
  into.outputTokens += record.outputTokens || 0;
  into.wallMs += record.wallMs || 0;
  if (record.finish === 'refused') into.refusals += 1;
  else if (record.finish === 'error') into.errors += 1;
}

function bucket(
  map: Map<string, ApiUsageTotals>,
  key: string,
  record: ApiCallRecord,
): void {
  let totals = map.get(key);
  if (totals === undefined) {
    totals = emptyTotals();
    map.set(key, totals);
  }
  add(totals, record);
}

/** Aggregate the ledger. Pure, so a caller may filter a slice out first. */
export function summarizeApiUsage(
  records: readonly ApiCallRecord[],
  now: Date = new Date(),
): ApiUsageSummary {
  const total = emptyTotals();
  const today = emptyTotals();
  const providers = new Map<string, ApiUsageTotals>();
  const roles = new Map<string, ApiUsageTotals>();
  const models = new Map<string, ApiUsageTotals>();
  const utcDay = now.toISOString().slice(0, 10);
  let lastCallAt: string | null = null;
  for (const record of records) {
    add(total, record);
    if (record.ts.slice(0, 10) === utcDay) add(today, record);
    bucket(providers, record.provider, record);
    bucket(roles, record.role ?? 'unattributed', record);
    bucket(models, record.modelId, record);
    if (lastCallAt === null || record.ts > lastCallAt) lastCallAt = record.ts;
  }
  const busiest = (a: ApiUsageTotals, b: ApiUsageTotals): number => b.calls - a.calls;
  return {
    total,
    today,
    byProvider: [...providers.entries()]
      .map(([provider, totals]) => ({ provider, ...totals }))
      .sort(busiest),
    byRole: [...roles.entries()].map(([role, totals]) => ({ role, ...totals })).sort(busiest),
    byModel: [...models.entries()].map(([modelId, totals]) => ({ modelId, ...totals })).sort(busiest),
    lastCallAt,
  };
}
