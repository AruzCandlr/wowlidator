/**
 * A running catalog, projected into the shape the monitor page reads.
 *
 * **One projector, two front ends.** The `/wowlidate` skill writes this to
 * `run-state.js` beside a `file://` page (a `<script src>` is the only way a
 * page opened from the filesystem can read a sibling file — that is why the
 * state is JS rather than JSON); the panel serves the same object at
 * `/monitor/run-state.js` for the same page. Neither computes anything of its
 * own: a monitor that disagrees with the run it watches, or with the other
 * monitor, is worse than no monitor.
 *
 * Everything here is a READING. Nothing in this module can touch a run — no
 * write, no signal, no control — which is what makes the page safe to leave
 * open on a second screen for five hours.
 *
 * Path resolution deliberately lives in the caller. The skill resolves a run
 * folder the way `paths.mjs` does and the panel resolves it from the ledgers
 * it already lists; both hand a ledger and a log to `buildRunState`.
 */

import { existsSync, statSync, openSync, readSync, closeSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { execSync } from 'node:child_process';

import {
  readApiUsage,
  apiUsagePath,
  summarizeApiUsage,
  type ApiCallRecord,
  type ApiUsageTotals,
} from '../providers/api-usage-log.js';
import { apiPressureHolds } from '../providers/api-pressure.js';

export interface RunStateCounts {
  planned: number;
  passed: number;
  failed: number;
  review: number;
  blocked: number;
}

export interface RunStateOutcome {
  id: string;
  name: string;
  verdict: 'passed' | 'failed' | 'blocked' | 'review';
  at: string;
  status: string | null;
  scenario: string | null;
  reportPath: string | null;
  reason: string;
}

export interface RunStateLogLine {
  /** Absolute byte offset of the line's end — the page appends by offset, never re-printing one. */
  o: number;
  t: string;
}

export interface RunStateRunner {
  alive: boolean;
  pid: number | null;
  count: number;
  uptime: string | null;
  uptimeSec: number;
}

/** The API half of the model panel: what a non-`claude-*` provider has done. */
export interface ApiSection {
  /** Providers held right now because they refused a call. */
  holds: { provider: string; seconds: number; reason: string; refusals: number; stated: boolean }[];
  today: ApiUsageTotals | null;
  total: ApiUsageTotals | null;
  byProvider: (ApiUsageTotals & { provider: string })[];
  byRole: (ApiUsageTotals & { role: string })[];
  byModel: (ApiUsageTotals & { modelId: string })[];
  lastCallAt: string | null;
  recentCalls: {
    ts: string;
    role: string;
    provider: string;
    modelId: string;
    wallMs: number;
    outputTokens: number;
    finish: string | null;
    detail: string | null;
  }[];
  note: string | null;
}

export interface RunState {
  updatedAt: string;
  ledgerFile: string | null;
  logFile: string | null;
  counts: RunStateCounts;
  outcomes: RunStateOutcome[];
  recentActivity: { caseId: string; text: string }[];
  chromeAlive: number;
  runner: RunStateRunner;
  logLines: RunStateLogLine[];
  logBytes: number | null;
  phase: 'waiting' | 'running' | 'quiet' | 'idle' | 'gone' | 'finished' | 'stopped';
  ended: { at?: string; cause?: string; complete?: boolean } | null;
  runKey: string | null;
  startedAt: string | null;
  title: string | null;
  logMtime: string | null;
  authored: number;
  requestsSeenThisWindow: number;
  note: string | null;
  launch?: { url: string | null; catalog: string | null } | null;
  claude?: unknown;
  api?: ApiSection;
}

export interface BuildRunStateOptions {
  /** The run's ledger (`<claims>.progress.json`). May not exist yet. */
  ledgerPath: string | null;
  /** The log this launch wrote. May not exist yet. */
  logPath: string | null;
  /** Where the caller looked, for the "no ledger" note. */
  catalogsDir?: string | undefined;
  /** Raw log lines per reading. A per-tick ceiling, not what the page can hold. */
  tailLines?: number | undefined;
  /**
   * The Claude half of the model panel, when the caller can read it. Injected
   * rather than imported so this module stays free of the account readers —
   * the skill's watcher loads them dynamically and says so when it cannot.
   */
  claude?: ((logText: string) => Promise<unknown>) | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** Only ever offer a link the page can actually open — a missing report is no link. */
const reportSeen = new Set<string>();
function reportIfPresent(path: unknown): string | null {
  if (typeof path !== 'string' || path === '') return null;
  if (reportSeen.has(path)) return path;
  if (existsSync(path)) {
    reportSeen.add(path);
    return path;
  }
  return null;
}

/** Read only the tail; a catalog log reaches hundreds of MB. */
function tailAt(path: string, bytes = 262_144): { text: string; start: number; size: number } {
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - bytes);
    const len = size - start;
    const buf = Buffer.alloc(len);
    const fd = openSync(path, 'r');
    try {
      readSync(fd, buf, 0, len, start);
    } finally {
      closeSync(fd);
    }
    return { text: buf.toString('utf8'), start, size };
  } catch {
    return { text: '', start: 0, size: 0 };
  }
}

/** The last line naming a fatal condition, when the runner is gone; null while it lives. */
export function lastFatalLine(path: string | null): string | null {
  if (path === null || !existsSync(path) || Date.now() - statSync(path).mtimeMs < 30_000) return null;
  const { text } = tailAt(path, 16_384);
  const lines = text.split('\n').map((l) => l.replace(ANSI, '').trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^wowlidator: |did not open port|ERR_CONNECTION_REFUSED|ECONNREFUSED|EADDRINUSE|out of memory|No space left/i.test(lines[i]!)) {
      return lines[i]!.slice(0, 240);
    }
  }
  return null;
}

/**
 * The log as the run wrote it, one entry per complete line, tagged with the
 * absolute offset of its end. The window rarely starts on a line boundary, so
 * the first line is dropped, and so is the trailing one still being written —
 * a half-written line shown once and completed later would print twice.
 */
export function logLinesFrom(text: string, start: number, max: number): RunStateLogLine[] {
  const parts = text.split('\n');
  const out: RunStateLogLine[] = [];
  let off = start;
  for (let i = 0; i < parts.length; i++) {
    const raw = parts[i]!;
    const end = off + Buffer.byteLength(raw, 'utf8') + 1;
    if (i < parts.length - 1 && !(i === 0 && start > 0)) {
      const t = raw.replace(ANSI, '').replace(/\r/g, '').replace(/\s+$/, '');
      out.push({ o: end, t: t.length > 600 ? `${t.slice(0, 600)}…` : t });
    }
    off = end;
  }
  return out.slice(-max);
}

const NOISE = /^\s*(ask|response|prompt):/i;

/** The filtered feed: what a person can read, out of what the run wrote. */
export function activityFrom(text: string): { caseId: string; text: string }[] {
  const out: { caseId: string; text: string }[] = [];
  for (const raw of text.split('\n')) {
    const m = raw.match(/^\[([^\]\s]+)\]\s+(.*)$/);
    if (!m) continue;
    const who = m[1]!;
    const rest = m[2]!.trim();
    if (rest === '' || NOISE.test(rest)) continue;
    if (/^\[llm /.test(rest) || /^→|^←/.test(rest)) continue;
    if (who === 'wowlidator' && /warm session|re-asking/.test(rest)) {
      out.push({ caseId: 'system', text: rest.slice(0, 200) });
      continue;
    }
    if (/^──|^─/.test(rest)) continue;
    out.push({ caseId: who.slice(0, 16), text: rest.replace(/\s+/g, ' ').slice(0, 220) });
  }
  return out.slice(-40).reverse();
}

/** ps prints elapsed time as [[dd-]hh:]mm:ss. */
export function etimeSeconds(s: string): number {
  const dash = s.indexOf('-');
  const days = dash > 0 ? Number(s.slice(0, dash)) : 0;
  const parts = (dash > 0 ? s.slice(dash + 1) : s).split(':').map(Number);
  let sec = 0;
  if (parts.length === 3) sec = parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  else if (parts.length === 2) sec = parts[0]! * 60 + parts[1]!;
  else sec = parts[0] ?? 0;
  return (Number.isFinite(days) ? days : 0) * 86_400 + (Number.isFinite(sec) ? sec : 0);
}

export function humanUptime(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '0s';
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * Is the run still a process? The log answers "did it write recently", which
 * a run sitting on a four-minute model call fails while perfectly healthy.
 * `ps` rather than `pgrep`, so the scan cannot match its own command line and
 * the elapsed time arrives in the same reading.
 */
function runnerProcs(): { pid: number; seconds: number }[] {
  try {
    const out = execSync('ps -Ao pid=,etime=,command=', { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    const procs: { pid: number; seconds: number }[] = [];
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/);
      if (!m) continue;
      const cmd = m[3]!;
      if (!/\bcatalog\b/.test(cmd)) continue;
      if (!/(cli\.ts|cli\.js|bin\/wow|wowlidator)/.test(cmd)) continue;
      if (/\bps\s+-Ao\b/.test(cmd)) continue;
      procs.push({ pid: Number(m[1]), seconds: etimeSeconds(m[2]!) });
    }
    return procs.sort((a, b) => b.seconds - a.seconds);
  } catch {
    return [];
  }
}

function chromeCount(): number {
  try {
    return Number(execSync('pgrep -f "remote-debugging-port=93" 2>/dev/null | wc -l', { encoding: 'utf8' }).trim()) || 0;
  } catch {
    return 0;
  }
}

// The ledger grows by a line per call and is read whole; re-parse it only
// when it has actually changed.
let apiCache: { mtime: number; records: ApiCallRecord[] } = { mtime: 0, records: [] };

/**
 * The API half of the model panel.
 *
 * The Claude half answers "can the account keep going". For a run on an HTTP
 * provider the account has no window to read — the only evidence is what the
 * calls themselves did, so that is what this shows: the ledger every call
 * appends to (`providers/api-usage-log.ts`) and the holds a refusal bought
 * (`providers/api-pressure.ts`). Before this, an `emmiedev` run's model panel
 * was empty and indistinguishable from a run making no calls at all.
 */
export async function apiSection(env: NodeJS.ProcessEnv = process.env): Promise<ApiSection> {
  const now = Date.now();
  const empty: ApiSection = {
    holds: apiPressureHolds(now).map((hold) => ({
      provider: hold.provider,
      seconds: Math.max(1, Math.round((hold.until - now) / 1000)),
      reason: hold.reason,
      refusals: hold.refusals,
      stated: hold.stated,
    })),
    today: null,
    total: null,
    byProvider: [],
    byRole: [],
    byModel: [],
    lastCallAt: null,
    recentCalls: [],
    note: null,
  };
  try {
    const path = apiUsagePath(env);
    const mtime = existsSync(path) ? statSync(path).mtimeMs : 0;
    if (mtime === 0) return empty;
    if (mtime !== apiCache.mtime) apiCache = { mtime, records: await readApiUsage(env) };
    const summary = summarizeApiUsage(apiCache.records);
    return {
      ...empty,
      today: summary.today,
      total: summary.total,
      byProvider: summary.byProvider.slice(0, 6),
      byRole: summary.byRole.slice(0, 6),
      byModel: summary.byModel.slice(0, 4),
      lastCallAt: summary.lastCallAt,
      recentCalls: apiCache.records.slice(-14).reverse().map((call) => ({
        ts: call.ts,
        role: call.role ?? 'unattributed',
        provider: call.provider,
        modelId: call.modelId,
        wallMs: call.wallMs,
        outputTokens: call.outputTokens,
        finish: call.finish ?? null,
        detail: call.detail ?? null,
      })),
    };
  } catch (error) {
    return { ...empty, note: `API usage ledger unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Test seam: the ledger cache is module state. */
export function resetApiSectionCache(): void {
  apiCache = { mtime: 0, records: [] };
}

/** One reading of a run. Never throws on a torn or missing file. */
export async function buildRunState(options: BuildRunStateOptions): Promise<RunState> {
  const env = options.env ?? process.env;
  const tailLines = Math.max(50, options.tailLines ?? 400);
  const { ledgerPath, logPath } = options;
  const state: RunState = {
    updatedAt: new Date().toISOString(),
    ledgerFile: ledgerPath,
    logFile: logPath,
    counts: { planned: 0, passed: 0, failed: 0, review: 0, blocked: 0 },
    outcomes: [],
    recentActivity: [],
    chromeAlive: chromeCount(),
    runner: { alive: false, pid: null, count: 0, uptime: null, uptimeSec: 0 },
    logLines: [],
    logBytes: null,
    phase: 'waiting',
    ended: null,
    runKey: null,
    startedAt: null,
    title: null,
    logMtime: null,
    authored: 0,
    requestsSeenThisWindow: 0,
    note: null,
  };

  const procs = runnerProcs();
  if (procs.length > 0) {
    state.runner = {
      alive: true,
      pid: procs[0]!.pid,
      count: procs.length,
      uptime: humanUptime(procs[0]!.seconds),
      uptimeSec: procs[0]!.seconds,
    };
  }

  if (ledgerPath === null || !existsSync(ledgerPath)) {
    // A folder with a log and no ledger is one of two things, and the log's
    // own last fatal line tells them apart: a run still authoring its first
    // case, or one that died before sealing any — a stale Chrome on the
    // pool's ports is the usual way.
    const fatal = lastFatalLine(logPath);
    state.note = fatal
      ? `no ledger — the run ended before sealing a case: ${fatal}`
      : `no ledger at ${ledgerPath ?? options.catalogsDir ?? 'any known catalogs folder'} — the run has not sealed its first case yet`;
  } else {
    let led: Record<string, unknown> | null = null;
    try {
      led = JSON.parse(readFileSync(ledgerPath, 'utf8')) as Record<string, unknown>;
    } catch {
      // A ledger caught mid-write is normal, not an error. Keep the last good
      // reading rather than blanking the page on a torn read.
      state.note = 'ledger was mid-write at this reading; showing what parsed';
    }
    if (led !== null) {
      const planned: unknown[] = Array.isArray(led['planned']) ? (led['planned'] as unknown[]) : [];
      const outcomes =
        led['outcomes'] !== null && typeof led['outcomes'] === 'object'
          ? (led['outcomes'] as Record<string, Record<string, unknown>>)
          : {};
      const entries = Object.entries(outcomes);
      state.counts.planned = planned.length;
      for (const [, o] of entries) {
        const v = String(o?.['verdict'] ?? '').toLowerCase();
        if (v === 'passed') state.counts.passed++;
        else if (v === 'failed') state.counts.failed++;
        else if (v === 'blocked') state.counts.blocked++;
        else state.counts.review++;
      }
      const authored =
        led['authored'] !== null && typeof led['authored'] === 'object'
          ? (led['authored'] as Record<string, Record<string, unknown>>)
          : {};
      // Every sealed verdict, not the newest forty: the search box above the
      // list exists to answer "where is PL_04_13", which a list of forty
      // cannot.
      state.outcomes = entries
        .filter(([, o]) => o['at'] !== undefined && o['at'] !== null)
        .sort((a, b) => Date.parse(String(b[1]['at'])) - Date.parse(String(a[1]['at'])))
        .slice(0, 2000)
        .map(([id, o]) => {
          const verdict = String(o['verdict'] ?? '').toLowerCase();
          return {
            id,
            name: typeof o['name'] === 'string' && o['name'] !== '' ? o['name'] : id,
            verdict: (['passed', 'failed', 'blocked'].includes(verdict)
              ? verdict
              : 'review') as RunStateOutcome['verdict'],
            at: String(o['at']),
            status: o['status'] ? String(o['status']).slice(0, 48) : null,
            scenario: (authored[id]?.['scenarioId'] as string | undefined) ?? null,
            reportPath: reportIfPresent(o['reportPath']),
            reason: String(o['reason'] ?? '').replace(/\s+/g, ' ').slice(0, 240),
          };
        });
      state.runKey = (led['runKey'] as string | null) ?? null;
      state.startedAt = (led['startedAt'] as string | null) ?? null;
      state.title = (led['title'] as string | null) ?? null;
      state.authored = Object.keys(authored).length;
      state.ended = (led['ended'] as RunState['ended']) ?? null;
      const launch = led['launch'] as { url?: string; catalog?: string } | undefined;
      state.launch = launch
        ? { url: launch.url ?? null, catalog: launch.catalog ? basename(launch.catalog) : null }
        : null;
    }
  }

  // The newest log is not always THIS run's log. A run launched in a terminal
  // redirects nowhere, so the newest file on disk can belong to a run that
  // ended hours ago — and pairing it with a live ledger is the exact lie the
  // two clocks exist to prevent: a healthy run reading as wedged.
  let logText = '';
  const startedMs = state.startedAt ? Date.parse(state.startedAt) : NaN;
  const logMs = logPath !== null && existsSync(logPath) ? statSync(logPath).mtimeMs : NaN;
  const logIsOurs = Number.isFinite(logMs) && (!Number.isFinite(startedMs) || logMs >= startedMs - 60_000);
  if (logPath !== null && !logIsOurs) {
    state.logFile = null;
    state.note =
      `this run writes no log file — the newest one on disk (${basename(logPath)}) predates it, ` +
      'so the activity feed is empty and the ledger is the only reading';
  }
  if (logPath !== null && logIsOurs) {
    state.logMtime = new Date(statSync(logPath).mtimeMs).toISOString();
    const win = tailAt(logPath);
    logText = win.text;
    state.logLines = logLinesFrom(win.text, win.start, tailLines);
    state.logBytes = win.size;
    state.recentActivity = activityFrom(logText);
    // `data` and `governor` are still in the pattern: it is a RUN'S OWN LOG
    // being read, and a run logged before they were retired (2026-09-11)
    // still names them.
    state.requestsSeenThisWindow = (logText.match(/→ (generator|agent|healer|data|governor) /g) ?? []).length;
  }

  if (options.claude !== undefined) state.claude = await options.claude(logText);
  state.api = await apiSection(env);

  // A fresh log outranks the process scan: something is plainly writing, so a
  // pattern that failed to match is the scan's problem, not the run's. Only
  // when the log has ALSO gone silent is the absence of a process evidence —
  // a killed run seals no `ended`, and that is the state this reading exists
  // to name.
  const logAgeMs = state.logMtime ? Date.now() - Date.parse(state.logMtime) : Infinity;
  if (state.ended) state.phase = state.ended.complete ? 'finished' : 'stopped';
  else if (logAgeMs < 90_000) state.phase = 'running';
  else if (state.runner.alive) state.phase = 'quiet';
  else if (state.counts.planned && logAgeMs > 120_000) state.phase = 'gone';
  else if (state.counts.planned) state.phase = 'idle';

  return state;
}

/** The state as the page loads it: an assignment, not JSON. */
export function runStateScript(state: RunState): string {
  return `window.__WOW_STATE__ = ${JSON.stringify(state, null, 1)};\n`;
}
