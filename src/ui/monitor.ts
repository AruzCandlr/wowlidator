/**
 * The panel's half of the live monitor.
 *
 * The `/wowlidate` skill opens `monitor/index.html` from the filesystem and a
 * watcher writes `run-state.js` beside it. The panel serves **that same page**
 * and **that same state** — the page file is read from disk, and the state
 * comes from `src/monitor/run-state.ts`, the one projector both surfaces use.
 * Nothing is re-rendered or re-computed here: two monitors that disagree
 * about one run would be worse than one monitor.
 *
 * It runs the readings, it does not reimplement them — and, like the skill's
 * page, it is view-only. There is no route here that can touch a run.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { openSync, readSync, closeSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRunState, runStateScript, type RunState } from '../monitor/run-state.js';
import { fetchClaudeQuota } from '../providers/claude-quota.js';
import {
  claudeCliUsagePath,
  readClaudeCliUsage,
  summarizeClaudeCliUsage,
} from '../providers/claude-cli-usage-log.js';
import { quotaHoldPercent } from '../cli/quota-hold.js';
import { LLM_ROLES } from '../config.js';
import { listCatalogRuns } from './catalog-runs.js';

/**
 * The page the skill plants in a run folder, read from the repository.
 *
 * One file, two surfaces: editing it changes the terminal's monitor and the
 * panel's together, which is the only way "identical" survives a change.
 */
const MONITOR_PAGE_CANDIDATES = [
  // Running from source (`npm run ui`): two up from src/ui is the repo root.
  resolve(dirname(fileURLToPath(import.meta.url)), '../../.claude/skills/wowlidate/monitor/index.html'),
  // Running from dist/, and the last resort for an install started elsewhere.
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../.claude/skills/wowlidate/monitor/index.html'),
  resolve(process.cwd(), '.claude/skills/wowlidate/monitor/index.html'),
];

export class MonitorPageMissingError extends Error {}

/** The first candidate that exists. A missing page is said plainly, not rendered around. */
export async function monitorPageFile(): Promise<string> {
  for (const candidate of MONITOR_PAGE_CANDIDATES) {
    if ((await stat(candidate).catch(() => null))?.isFile()) return candidate;
  }
  throw new MonitorPageMissingError(
    `the monitor page was not found — looked in ${MONITOR_PAGE_CANDIDATES.join(', ')}`,
  );
}

/** The page, with its state script pointed at the panel's route instead of a sibling file. */
export async function monitorPage(ledgerPath?: string): Promise<string> {
  const html = await readFile(await monitorPageFile(), 'utf8');
  const pick = ledgerPath === undefined ? '' : `ledger=${encodeURIComponent(ledgerPath)}&`;
  // The skill's page re-injects `run-state.js` from beside itself every few
  // seconds, cache-busting with its own `?t=`. Served over HTTP that sibling
  // does not exist, so the one tag is pointed at the route that builds it —
  // the page's timer, its byte-offset bookkeeping and every other behaviour
  // are untouched, which is what makes the two monitors the same monitor.
  return html.replace("'run-state.js?t=' + Date.now()", `'/monitor/run-state.js?${pick}t=' + Date.now()`);
}

/** The first bytes of a log, for its header. */
function head(path: string, bytes = 8192): string {
  try {
    const buf = Buffer.alloc(bytes);
    const fd = openSync(path, 'r');
    let read = 0;
    try {
      read = readSync(fd, buf, 0, bytes, 0);
    } finally {
      closeSync(fd);
    }
    return buf.subarray(0, read).toString('utf8');
  } catch {
    return '';
  }
}

/**
 * Which log belongs to THIS ledger.
 *
 * Newest-by-mtime picked independently for each is how a fresh run's log ends
 * up beside a previous run's counts. A catalog log's header names its own
 * claims file, so the pairing is read off the log rather than guessed — the
 * same rule the skill's watcher uses, in the other direction.
 */
export async function logForLedger(ledgerPath: string): Promise<string | null> {
  const dir = dirname(ledgerPath);
  const claims = `${basename(ledgerPath).replace(/\.progress\.json$/, '')}`;
  const names = await readdir(dir).catch(() => [] as string[]);
  const logs: { path: string; mtime: number }[] = [];
  for (const name of names) {
    if (!name.endsWith('.log')) continue;
    const path = join(dir, name);
    const info = await stat(path).catch(() => null);
    if (info?.isFile()) logs.push({ path, mtime: info.mtimeMs });
  }
  logs.sort((a, b) => b.mtime - a.mtime);
  const owned = logs.find((log) => head(log.path).includes(claims));
  // No header match: the newest log in the ledger's own folder is still that
  // run's folder, which is a far weaker guess than the header but not a
  // different run's directory. Nothing at all is the honest answer elsewhere.
  return owned?.path ?? logs[0]?.path ?? null;
}

/** The Claude half of the model panel, from the panel's own readers. */
async function claudeSection(logText: string, env: NodeJS.ProcessEnv): Promise<unknown> {
  const out: Record<string, unknown> = {
    note: null,
    quota: null,
    holdPercent: null,
    usage: null,
    recentCalls: [] as unknown[],
    warmFailures: (logText.match(/warm session could not answer/g) ?? []).length,
    reAsks: (logText.match(/re-asking|asking again with the refusal/g) ?? []).length,
    roles: null,
  };

  // Which model each role is on. The run's own log wins wherever it has
  // spoken — a run launched with its own environment is not this process's.
  const roles: Record<string, string> = {};
  for (const role of LLM_ROLES) {
    const provider = env[`WOWLIDATOR_${role.toUpperCase()}_PROVIDER`];
    const model = env[`WOWLIDATOR_${role.toUpperCase()}_MODEL`];
    if (provider !== undefined || model !== undefined) {
      roles[role] = [provider, model].filter((x): x is string => x !== undefined && x !== '').join(':');
    }
  }
  // `data` and `governor` stay in the pattern for a log written before
  // those roles were retired (2026-09-11); the live list is `LLM_ROLES`.
  for (const m of logText.matchAll(/\b(generator|agent|healer|data|governor) · ([a-z0-9-]+:[^ ·\n]+)/g)) {
    roles[m[1]!] = m[2]!;
  }
  if (Object.keys(roles).length > 0) out['roles'] = roles;

  try {
    out['holdPercent'] = quotaHoldPercent(env);
  } catch {
    // A hold percent is a nicety, never a reason to lose the panel.
  }
  try {
    const snapshot = await fetchClaudeQuota(env);
    out['quota'] = { limits: snapshot.limits ?? [], note: snapshot.note ?? '', fetchedAt: snapshot.fetchedAt ?? null };
  } catch (error) {
    out['quota'] = { limits: [], note: error instanceof Error ? error.message : String(error), fetchedAt: null };
  }
  try {
    const records = await readClaudeCliUsage(env);
    if (records.length > 0) {
      const summary = summarizeClaudeCliUsage(records);
      out['usage'] = {
        today: summary.today,
        total: summary.total,
        lastCallAt: summary.lastCallAt,
        byRole: summary.byRole.slice(0, 6),
        byModel: summary.byModel.slice(0, 4),
      };
      out['recentCalls'] = records.slice(-14).reverse().map((call) => ({
        ts: call.ts,
        role: call.role ?? 'unattributed',
        modelId: call.modelId,
        path: call.path,
        wallMs: call.wallMs,
        outputTokens: call.outputTokens,
        finish: call.finish ?? null,
      }));
    }
  } catch (error) {
    out['note'] = `claude-cli ledger unreadable (${claudeCliUsagePath(env)}): ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
  return out;
}

/**
 * One reading for the panel.
 *
 * `ledgerPath` must be one the server itself discovered — the client picks
 * from `/api/catalog-runs`, it never names a path of its own, the same
 * known-roots rule as file serving. An unknown path is answered with the
 * newest run instead of being read.
 */
export async function panelRunState(
  reportDir: string,
  wanted: string | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RunState> {
  const runs = await listCatalogRuns(reportDir);
  const chosen =
    (wanted === null ? undefined : runs.find((run) => run.ledgerPath === resolve(wanted))) ?? runs[0];
  const ledgerPath = chosen?.ledgerPath ?? null;
  return buildRunState({
    ledgerPath,
    logPath: ledgerPath === null ? null : await logForLedger(ledgerPath),
    catalogsDir: join(resolve(reportDir), 'catalogs'),
    claude: (logText) => claudeSection(logText, env),
    env,
  });
}

/** The state as the page loads it: an assignment, not JSON. */
export async function panelRunStateScript(
  reportDir: string,
  wanted: string | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  return runStateScript(await panelRunState(reportDir, wanted, env));
}
