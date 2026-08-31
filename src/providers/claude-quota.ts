/**
 * Real-time quota for the claude-* providers — what the signed-in Claude
 * session has left, while it is being spent.
 *
 * The `claude-cli` meter counts what THIS process spent; it cannot say how
 * close the account is to its limits, and that is the number that decides
 * whether a 108-case catalog run survives the afternoon. Claude Code itself
 * answers `/usage` from an OAuth endpoint, and the same endpoint is readable
 * here with the credential the CLI already holds:
 *
 *   GET https://api.anthropic.com/api/oauth/usage
 *   Authorization: Bearer <the CLI's own access token>
 *   anthropic-beta: oauth-2025-04-20
 *
 * The token comes from where Claude Code keeps it — the macOS keychain entry
 * `Claude Code-credentials` (read with `security`, argv only, no shell), or
 * `~/.claude/.credentials.json` elsewhere. Verified live 2026-08-27: the
 * answer's `limits` array carries one row per limit window — session (5 h),
 * weekly, and weekly rows SCOPED to a model (`scope.model.display_name`,
 * e.g. "Fable") — each with a used percent, a severity and a reset time.
 * That scoped row is what "usage per model type" means at the account level;
 * per-call token counts per model id stay on the `claude-cli` meter.
 *
 * Three promises this module keeps:
 *
 *   * **Never throws, never blocks a run.** Everything degrades to a snapshot
 *     with a `note` saying why there is nothing to show. `if available` is the
 *     contract — an API-key install has no OAuth token and that is fine.
 *   * **Cached.** One fetch per `WOWLIDATOR_CLAUDE_QUOTA_TTL_MS` (default
 *     30 s) however often it is asked, with in-flight dedupe — the panel
 *     polls and a catalog run asks after every call.
 *   * **The token never leaves.** It is not in the snapshot, not in a note,
 *     not in a log line. Notes name the provider and the status, nothing else.
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { logLlmLine } from './llm-log.js';

const run = promisify(execFile);

export const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
/** How long one fetched snapshot is reused. */
export const DEFAULT_QUOTA_TTL_MS = 30_000;
/** A quota lookup must never be the slow part of anything. */
const FETCH_TIMEOUT_MS = 5_000;
/** The credential is stable; re-reading the keychain per fetch would be noise. */
const TOKEN_TTL_MS = 5 * 60_000;

export function claudeQuotaEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env['WOWLIDATOR_CLAUDE_QUOTA']?.trim().toLowerCase();
  return !(raw === 'off' || raw === '0' || raw === 'false');
}

export function quotaTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env['WOWLIDATOR_CLAUDE_QUOTA_TTL_MS']);
  return Number.isFinite(n) && n >= 1_000 ? Math.floor(n) : DEFAULT_QUOTA_TTL_MS;
}

export interface ClaudeQuotaLimit {
  /** The endpoint's own name for the window — `session`, `weekly_all`, `weekly_scoped`. */
  kind: string;
  /** Percent of the window already used, 0–100. */
  percent: number;
  /** `normal` until the endpoint says otherwise (`warning`, `exceeded`, …). */
  severity: string;
  /** ISO time the window resets, when stated. */
  resetsAt: string | null;
  /** The model this row is scoped to (e.g. `Fable`), null for account-wide rows. */
  model: string | null;
  /** A short label for people: `session`, `week`, `week (Fable)`. */
  label: string;
}

export interface ClaudeQuotaSnapshot {
  /** Empty when unavailable — see `note`. */
  limits: ClaudeQuotaLimit[];
  /** Why `limits` is empty, or '' when it is not. */
  note: string;
  /** ISO time this snapshot was fetched. */
  fetchedAt: string;
}

function unavailable(note: string): ClaudeQuotaSnapshot {
  return { limits: [], note, fetchedAt: new Date().toISOString() };
}

/**
 * The `limits` rows of the usage payload, normalised. Exported pure so the
 * parse is testable against a recorded payload without any credential.
 */
export function parseClaudeQuotaPayload(payload: unknown): ClaudeQuotaLimit[] {
  const body = payload as { limits?: unknown } | null;
  const rows = Array.isArray(body?.limits) ? body.limits : [];
  const limits: ClaudeQuotaLimit[] = [];
  for (const row of rows) {
    const r = row as {
      kind?: unknown;
      percent?: unknown;
      severity?: unknown;
      resets_at?: unknown;
      scope?: { model?: { display_name?: unknown } | null } | null;
    };
    if (typeof r?.kind !== 'string' || typeof r.percent !== 'number') continue;
    const model =
      typeof r.scope?.model?.display_name === 'string' ? r.scope.model.display_name : null;
    limits.push({
      kind: r.kind,
      percent: r.percent,
      severity: typeof r.severity === 'string' ? r.severity : 'normal',
      resetsAt: typeof r.resets_at === 'string' ? r.resets_at : null,
      model,
      label:
        r.kind === 'session'
          ? 'session'
          : model !== null
            ? `week (${model})`
            : r.kind.startsWith('weekly')
              ? 'week'
              : r.kind,
    });
  }
  return limits;
}

/** One line for a log or a status bar: `session 6% · week 2% · week (Fable) 1%`. */
export function formatClaudeQuota(snapshot: ClaudeQuotaSnapshot): string {
  if (snapshot.limits.length === 0) return snapshot.note;
  return snapshot.limits
    .map((limit) => {
      const warn = limit.severity !== 'normal' ? ` (${limit.severity})` : '';
      return `${limit.label} ${Math.round(limit.percent)}%${warn}`;
    })
    .join(' · ');
}

// --- The credential ---------------------------------------------------------

let cachedToken: { value: string | null; note: string; at: number } | null = null;

function tokenFrom(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { claudeAiOauth?: { accessToken?: unknown } };
    const token = parsed.claudeAiOauth?.accessToken;
    return typeof token === 'string' && token !== '' ? token : null;
  } catch {
    return null;
  }
}

/**
 * The CLI's own OAuth access token, or null with a reason. Reads the macOS
 * keychain first (that is where Claude Code keeps it on darwin), then the
 * credentials file other platforms use. Cached — see `TOKEN_TTL_MS`.
 */
async function accessToken(): Promise<{ value: string | null; note: string }> {
  if (cachedToken !== null && Date.now() - cachedToken.at < TOKEN_TTL_MS) return cachedToken;
  let value: string | null = null;
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await run(
        'security',
        ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        { timeout: FETCH_TIMEOUT_MS },
      );
      value = tokenFrom(stdout.trim());
    } catch {
      // Fall through to the file.
    }
  }
  if (value === null) {
    try {
      value = tokenFrom(await readFile(join(homedir(), '.claude', '.credentials.json'), 'utf8'));
    } catch {
      // No file either.
    }
  }
  cachedToken = {
    value,
    note:
      value === null
        ? 'no Claude Code OAuth credential on this machine — quota is only visible for a signed-in claude session'
        : '',
    at: Date.now(),
  };
  return cachedToken;
}

// --- The fetch --------------------------------------------------------------

type QuotaFetcher = (token: string) => Promise<ClaudeQuotaSnapshot>;

async function fetchFromEndpoint(token: string): Promise<ClaudeQuotaSnapshot> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(CLAUDE_USAGE_URL, {
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: controller.signal,
    });
    // Reported by status only — the request carries the credential, so no
    // part of it may be echoed into a note.
    if (!response.ok) return unavailable(`the usage endpoint answered ${response.status}`);
    const limits = parseClaudeQuotaPayload(await response.json());
    return limits.length === 0
      ? unavailable('the usage endpoint listed no limits')
      : { limits, note: '', fetchedAt: new Date().toISOString() };
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    return unavailable(
      aborted
        ? `the usage endpoint did not answer within ${FETCH_TIMEOUT_MS / 1000}s`
        : 'could not reach the usage endpoint',
    );
  } finally {
    clearTimeout(timer);
  }
}

let fetcher: QuotaFetcher = fetchFromEndpoint;
let cachedSnapshot: { snapshot: ClaudeQuotaSnapshot; at: number } | null = null;
let inFlight: Promise<ClaudeQuotaSnapshot> | null = null;

/** Test seam: answer quota questions without a credential or a network. */
export function setClaudeQuotaFetcher(next: QuotaFetcher | null): void {
  fetcher = next ?? fetchFromEndpoint;
  cachedSnapshot = null;
  inFlight = null;
}

/** Test seam: cached state is module-wide. */
export function resetClaudeQuotaCache(): void {
  cachedSnapshot = null;
  cachedToken = null;
  inFlight = null;
  lastLogged = null;
}

/**
 * The account's current limits, cached. Never throws; never blocks longer
 * than the fetch timeout; a snapshot with an empty `limits` says why.
 * `force` skips the cache read (the answer still refills it) — for the one
 * reading where staleness would lie, the end-of-run delta.
 */
export async function fetchClaudeQuota(
  env: NodeJS.ProcessEnv = process.env,
  force = false,
): Promise<ClaudeQuotaSnapshot> {
  if (!claudeQuotaEnabled(env)) return unavailable('quota lookups are off (WOWLIDATOR_CLAUDE_QUOTA=off)');
  if (!force && cachedSnapshot !== null && Date.now() - cachedSnapshot.at < quotaTtlMs(env)) {
    return cachedSnapshot.snapshot;
  }
  if (inFlight !== null) return inFlight;
  inFlight = (async () => {
    try {
      const token = await accessToken();
      const fresh = token.value === null ? unavailable(token.note) : await fetcher(token.value);
      // **A failed read never erases a good one** (2026-08-28). The panel,
      // its usage-cap guard and every claude-cli child each poll this
      // endpoint on their own TTL, and it answered 429 — at which point the
      // Quota rows and the cap gauge simply vanished ("the guardrail is
      // gone"). A stale reading with its age stated is strictly better than
      // no reading: the cap keeps its last known percentages, the page keeps
      // its rows, and the note says why they are old. The retry is also
      // held back: a 429 doubles the wait before the next real request.
      const lastGood = cachedSnapshot?.snapshot.limits.length ? cachedSnapshot.snapshot : null;
      const snapshot =
        fresh.limits.length === 0 && lastGood !== null
          ? { ...lastGood, note: `stale — ${fresh.note}; showing the reading from ${lastGood.fetchedAt}` }
          : fresh;
      const rateLimited = /answered 429/.test(fresh.note);
      cachedSnapshot = { snapshot, at: Date.now() + (rateLimited ? quotaTtlMs(env) : 0) };
      return snapshot;
    } catch (error) {
      // The promises above make this unreachable in practice; keeping the
      // guarantee anyway is what "never throws" means.
      const snapshot = unavailable(
        error instanceof Error ? (error.message.split('\n')[0] ?? 'quota lookup failed') : 'quota lookup failed',
      );
      cachedSnapshot = { snapshot, at: Date.now() };
      return snapshot;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** The session (5-hour) window alone — the row a run's cost is judged against. */
export interface SessionQuotaPoint {
  /** Percent of the window used, 0–100, as the endpoint states it. */
  percent: number;
  resetsAt: string | null;
}

/**
 * The session window right now, or null when quota is unavailable. `force`
 * bypasses the cache — the end-of-run reading must not reuse the snapshot
 * the start of the run took, or every short run would report a 0% delta.
 */
export async function sessionQuotaPoint(
  env: NodeJS.ProcessEnv = process.env,
  force = false,
): Promise<SessionQuotaPoint | null> {
  const snapshot = await fetchClaudeQuota(env, force);
  const row = snapshot.limits.find((limit) => limit.kind === 'session');
  return row === undefined ? null : { percent: row.percent, resetsAt: row.resetsAt };
}

// --- The log line -----------------------------------------------------------

/** A quota line is worth a row of the log when it changed, or after this long. */
const LOG_EVERY_MS = 60_000;
let lastLogged: { text: string; at: number } | null = null;

/**
 * After a claude-* call: put the account's headroom next to the call that
 * spent from it, without a network round trip on the hot path — the fetch is
 * fire-and-forget and the cache absorbs the frequency. A line is only
 * emitted when the numbers moved or a minute passed, so a fast healer loop
 * does not fill the log with the same three percentages.
 */
export function maybeLogClaudeQuota(task: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!claudeQuotaEnabled(env)) return;
  void fetchClaudeQuota(env)
    .then((snapshot) => {
      if (snapshot.limits.length === 0) return; // unavailable is not worth a line per call
      const text = formatClaudeQuota(snapshot);
      if (lastLogged !== null && lastLogged.text === text && Date.now() - lastLogged.at < LOG_EVERY_MS) {
        return;
      }
      lastLogged = { text, at: Date.now() };
      logLlmLine(`⛽ ${task} · claude quota: ${text}`, env);
    })
    .catch(() => undefined);
}
