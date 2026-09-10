#!/usr/bin/env npx tsx
// Project a running catalog into monitor/run-state.js, for index.html to read.
//
// The page is opened from the filesystem, where fetch() of a sibling file is
// blocked. A <script src> is not, so the state is written as an assignment and
// the page re-injects the tag on a timer. That is the whole trick, and it is
// why this writes JS rather than JSON.
//
// The Claude half — the account's quota windows and the claude-cli call ledger
// — comes from the project's own readers, imported dynamically. A monitor that
// computed those itself could disagree with the run it is watching, which is
// the one thing a monitor may never do. tsx is what makes importing them
// possible; under plain node the import fails and the page simply shows the run
// without the Claude panel, with a note saying why.
//
// Usage: npx tsx watch.mjs [--run <run folder or its name>] [--ledger <path>] [--log <path>] [--out <run-state.js>] [--once]
//                          [--interval 3] [--once]

import { readFileSync, writeFileSync, renameSync, existsSync, statSync, readdirSync, openSync, readSync, closeSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

import { catalogDirs, runDirs } from '../paths.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../../..');

// `.env` carries WOWLIDATOR_CLAUDE_QUOTA, the hold percent and the role models.
// The CLI loads it before anything reads them; so does this, or the monitor
// reports a quota setting the run is not using.
try {
  for (const line of readFileSync(join(REPO, '.env'), 'utf8').split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq <= 0 || line.trimStart().startsWith('#')) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length > 1 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
} catch { /* no .env is normal */ }
// The ledger every claude-cli process appends to is resolved from the working
// directory, so pin it to the repo — the watcher is not always started there.
if (process.env['WOWLIDATOR_CLAUDE_CLI_USAGE_PATH'] === undefined) {
  process.env['WOWLIDATOR_CLAUDE_CLI_USAGE_PATH'] = join(REPO, '.wowlidator', 'claude-cli-usage.jsonl');
}

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const once = argv.includes('--once');
const intervalMs = Math.max(1, Number(flag('interval', 3))) * 1000;
// How many raw log lines each reading carries. The page appends by byte
// offset, so this is a per-tick ceiling, not the size of what it can show.
const tailLines = Math.max(50, Number(flag('tail-lines', 400)) || 400);

// Where the page reads its state from. A run keeps its own folder now, with
// its own copy of index.html in it, so the state has to be written beside THAT
// copy rather than beside the one in the skill — two runs sharing one
// run-state.js is two runs sharing one monitor, and the second one wins.
// Defaults to the skill's own page, which is still right for a one-off look.
const OUT = resolve(flag('out', join(HERE, 'run-state.js')));

// The report directory is WOWLIDATOR_REPORT_DIR when .env sets it, and
// .wowlidator/reports otherwise. Getting this wrong is how a --resume silently
// becomes a full re-run, so the monitor resolves it the same way the CLI does.
function reportDir() {
  if (process.env.WOWLIDATOR_REPORT_DIR) return resolve(process.env.WOWLIDATOR_REPORT_DIR);
  const envFile = join(REPO, '.env');
  if (existsSync(envFile)) {
    const m = readFileSync(envFile, 'utf8').match(/^WOWLIDATOR_REPORT_DIR=(.*)$/m);
    if (m) return resolve(m[1].trim().replace(/^['"]|['"]$/g, '').replace(/^~/, process.env.HOME ?? '~'));
  }
  return join(REPO, '.wowlidator', 'reports');
}

// Only ever offer a link the page can actually open. A file:// navigation to a
// report that was never written lands on a blank page with no error, which
// reads as the monitor being broken rather than the report being absent — so a
// missing report is no link at all. Once a path exists it keeps existing, so
// the stat is remembered rather than repeated every three seconds.
const reportSeen = new Set();
function reportIfPresent(p) {
  if (typeof p !== 'string' || !p) return null;
  if (reportSeen.has(p)) return p;
  if (existsSync(p)) { reportSeen.add(p); return p; }
  return null;
}

const newestIn = (dir, suffix) => {
  if (!existsSync(dir)) return null;
  const hits = readdirSync(dir)
    .filter((f) => f.endsWith(suffix))
    .map((f) => ({ p: join(dir, f), m: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  return hits.length ? hits[0].p : null;
};

// Every place a run may have written — the run folder this shell launched
// (`WOW_RUN_DIR`), every `runs/<slug>-<stamp>/catalogs/` newest first, the
// report directory's own `catalogs/`, the in-repo default — or only the one
// run `--run <folder|name>` names. A watcher started from a fresh shell used
// to look in `<report-dir>/catalogs/` alone and report "no ledger" about a
// run that keeps its ledger in its own folder (2026-09-10).
const runRef = flag('run', null);
function catalogsDirs() {
  if (runRef !== null) {
    const asPath = resolve(runRef.replace(/^~/, process.env.HOME ?? '~'));
    if (existsSync(join(asPath, 'catalogs'))) return [join(asPath, 'catalogs')];
    if (existsSync(asPath)) return [asPath];
    const hit = runDirs().find((d) => basename(d).toLowerCase().startsWith(runRef.toLowerCase()));
    if (hit) return [join(hit, 'catalogs')];
    console.error(`no run folder matches ${runRef}`);
    process.exit(2);
  }
  return catalogDirs();
}
const catalogsDir = catalogsDirs()[0] ?? join(reportDir(), 'catalogs');

// The first bytes of a log, for its header. `tail` reads the other end.
function head(path, bytes = 8192) {
  try {
    const size = statSync(path).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    const fd = openSync(path, 'r');
    try { readSync(fd, buf, 0, len, 0); } finally { closeSync(fd); }
    return buf.toString('utf8');
  } catch { return ''; }
}

// Which ledger belongs to THIS log. Newest-by-mtime is picked independently
// for each, so a fresh run's log can be paired with a previous run's ledger —
// counts from one run beside the activity of another, which is a worse lie
// than showing nothing. The log's own header names its claims file, so ask it
// rather than guessing: same rule as the role models, the run's output wins.
function ledgerFromLog(logFile) {
  if (!logFile) return null;
  const m = head(logFile).match(/^\s*claims\s+(\S+\.claims\.json)\s*$/m);
  if (!m) return null;
  // Returned whether or not it exists yet. A run that has not sealed its first
  // case has no ledger, and "the run has not written one yet" is the truth —
  // falling back to the newest file on disk would answer with a DIFFERENT
  // run's counts, which is the exact failure this function exists to stop.
  return m[1].replace(/\.claims\.json$/, '.claims.progress.json');
}
// The log is wherever the launch redirected stdout, which is often the in-repo
// .wowlidator/ path even when the ledger is not. Look in both.
function newestLog() {
  return (
    [...catalogsDirs(), join(REPO, '.wowlidator', 'reports', 'catalogs')]
      .map((d) => newestIn(d, '.log'))
      .filter(Boolean)
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null
  );
}

// **Both paths are re-resolved while they are still unknown** (2026-09-09).
// They used to be computed once at module load, and the watcher is normally
// started in the same breath as the run it watches — so at that instant the
// log holds nothing, its `claims` header is unwritten, and the run's own
// folder is empty. `ledgerFromLog` answered null, the newest-file fallback
// answered null, and null LATCHED: the page said "the run has not sealed its
// first case yet" for the whole run, while a perfectly good ledger sat beside
// it seconds later. Nothing about that is visible to a person watching — the
// counts simply never move.
//
// So resolution is a function of the moment, not of startup. An explicit
// --ledger / --log still wins and is resolved once; everything else is asked
// again each tick until it answers, and then stays put. Re-resolving a path
// we already have would let a LATER run's files steal a running watcher, which
// is the pairing lie `ledgerFromLog` exists to prevent.
const fixedLedger = flag('ledger', null);
const fixedLog = flag('log', null);
// The newest-ledger fallback looks in the LOG's own folder when a log is
// known: with run folders in the search, "newest anywhere" would be another
// run's ledger beside this run's log — the pairing lie `ledgerFromLog` exists
// to prevent.
function fallbackLedger() {
  return newestIn(logPath ? dirname(logPath) : catalogsDir, '.claims.progress.json');
}
let logPath = fixedLog ?? newestLog();
let ledgerPath = fixedLedger ?? ledgerFromLog(logPath) ?? fallbackLedger();

function resolvePaths() {
  if (!logPath) logPath = fixedLog ?? newestLog();
  if (ledgerPath) return;
  ledgerPath = fixedLedger ?? ledgerFromLog(logPath) ?? fallbackLedger();
}

// Read only the tail; a catalog log reaches hundreds of MB and re-reading it
// whole every few seconds would cost more than the run. The byte offset the
// window starts at comes back with it, because the terminal on the page
// appends by absolute offset — that is what lets the page accumulate far past
// this window while never re-printing a line it already holds.
function tailAt(path, bytes = 262144) {
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - bytes);
    const len = size - start;
    const buf = Buffer.alloc(len);
    const fd = openSync(path, 'r');
    try { readSync(fd, buf, 0, len, start); } finally { closeSync(fd); }
    return { text: buf.toString('utf8'), start, size };
  } catch { return { text: '', start: 0, size: 0 }; }
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** The last line of the log that names a fatal condition, when the runner is gone; null while it lives. */
function lastFatalLine(path) {
  // A log still being written is a run still going, whatever its tail says.
  if (!path || !existsSync(path) || Date.now() - statSync(path).mtimeMs < 30_000) return null;
  const { text } = tailAt(path, 16384);
  const lines = text.split('\n').map((l) => l.replace(ANSI, '').trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^wowlidator: |did not open port|ERR_CONNECTION_REFUSED|ECONNREFUSED|EADDRINUSE|out of memory|No space left/i.test(lines[i])) return lines[i].slice(0, 240);
  }
  return null;
}

// The log as the run wrote it, one entry per complete line, tagged with the
// absolute offset of its end. The window rarely starts on a line boundary, so
// the first line is dropped, and so is the trailing one still being written —
// a half-written line shown once and completed later would print twice.
function logLinesFrom(text, start, max) {
  const parts = text.split('\n');
  const out = [];
  let off = start;
  for (let i = 0; i < parts.length; i++) {
    const raw = parts[i];
    const end = off + Buffer.byteLength(raw, 'utf8') + 1;
    if (i < parts.length - 1 && !(i === 0 && start > 0)) {
      const t = raw.replace(ANSI, '').replace(/\r/g, '').replace(/\s+$/, '');
      out.push({ o: end, t: t.length > 600 ? t.slice(0, 600) + '…' : t });
    }
    off = end;
  }
  return out.slice(-max);
}

const NOISE = /^\s*(ask|response|prompt):/i;
function activityFrom(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    const m = raw.match(/^\[([^\]\s]+)\]\s+(.*)$/);
    if (!m) continue;
    const [, who, restRaw] = m;
    const rest = restRaw.trim();
    if (!rest || NOISE.test(rest)) continue;
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

// Is the run still a process? The log answers "did it write recently", which a
// run sitting on a four-minute model call fails while perfectly healthy. Only
// the process table answers "is it there at all" — and a run that was killed
// seals no `ended`, so without this reading the page calls a corpse idle.
//
// `ps` rather than `pgrep`, so the scan cannot match its own command line, and
// so the elapsed time arrives in the same reading.
function runnerProcs() {
  try {
    const out = execSync('ps -Ao pid=,etime=,command=', {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    const procs = [];
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/);
      if (!m) continue;
      const cmd = m[3];
      if (!/\bcatalog\b/.test(cmd)) continue;
      if (!/(cli\.ts|cli\.js|bin\/wow|wowlidator)/.test(cmd)) continue;
      if (/\bps\s+-Ao\b/.test(cmd)) continue;
      procs.push({ pid: Number(m[1]), seconds: etimeSeconds(m[2]) });
    }
    return procs.sort((a, b) => b.seconds - a.seconds);
  } catch { return []; }
}

// ps prints elapsed time as [[dd-]hh:]mm:ss.
function etimeSeconds(s) {
  const dash = s.indexOf('-');
  const days = dash > 0 ? Number(s.slice(0, dash)) : 0;
  const parts = (dash > 0 ? s.slice(dash + 1) : s).split(':').map(Number);
  let sec = 0;
  if (parts.length === 3) sec = parts[0] * 3600 + parts[1] * 60 + parts[2];
  else if (parts.length === 2) sec = parts[0] * 60 + parts[1];
  else sec = parts[0] || 0;
  return (Number.isFinite(days) ? days : 0) * 86400 + (Number.isFinite(sec) ? sec : 0);
}

function humanUptime(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '0s';
  if (sec < 60) return Math.round(sec) + 's';
  const m = Math.floor(sec / 60);
  if (m < 60) return m + 'm';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}

function chromeCount() {
  try {
    return execSync('pgrep -f "remote-debugging-port=93" 2>/dev/null | wc -l', { encoding: 'utf8' }).trim() | 0;
  } catch { return 0; }
}

// ── The Claude half ────────────────────────────────────────────────────────
// Two questions the run's own ledger cannot answer: how much of the account's
// window is left (the thing that decides whether a catalog survives the
// afternoon), and what the model layer has actually been doing lately. Both
// have a reader in the project already — `fetchClaudeQuota` is the same OAuth
// read the suite's quota hold consults, cached at its own TTL, and
// `readClaudeCliUsage` is the JSONL ledger every `claude -p` call appends to.

let readersPromise = null;
function claudeReaders() {
  if (readersPromise === null) {
    readersPromise = (async () => {
      try {
        const [quota, usage, hold] = await Promise.all([
          import(join(REPO, 'src/providers/claude-quota.ts')),
          import(join(REPO, 'src/providers/claude-cli-usage-log.ts')),
          import(join(REPO, 'src/cli/quota-hold.ts')),
        ]);
        return { quota, usage, hold, note: null };
      } catch (err) {
        // Almost always "run me under tsx". Say so rather than showing an
        // empty panel that looks like a quota of zero.
        return {
          note:
            'claude readers could not load (' +
            String(err && err.message ? err.message.split('\n')[0] : err) +
            ') — start the watcher with `npx tsx`, not `node`',
        };
      }
    })();
  }
  return readersPromise;
}

// The ledger grows by a line per call and is read whole; re-parse it only when
// it has actually changed.
let usageCache = { mtime: 0, summary: null, recent: [] };

async function claudeSection(logText) {
  const r = await claudeReaders();
  const out = {
    note: r.note ?? null,
    quota: null,
    holdPercent: null,
    usage: null,
    recentCalls: [],
    warmFailures: 0,
    reAsks: 0,
    roles: null,
  };

  // What the model layer is doing to THIS run, from the run's own log tail.
  out.warmFailures = (logText.match(/warm session could not answer/g) ?? []).length;
  out.reAsks = (logText.match(/re-asking|asking again with the refusal/g) ?? []).length;

  // Which model each role is on. The environment is only the fallback: a run
  // launched with `WOWLIDATOR_AGENT_MODEL=sonnet` on its own command line has
  // an environment this watcher never sees, and the panel would then name the
  // `.env` default with total confidence while the run used something else.
  // The run's log says what it actually dispatched to, every call — so the log
  // wins wherever it has spoken. A monitor may be silent; it may not disagree.
  const roles = {};
  for (const role of ['generator', 'agent', 'healer', 'data', 'governor']) {
    const provider = process.env['WOWLIDATOR_' + role.toUpperCase() + '_PROVIDER'];
    const model = process.env['WOWLIDATOR_' + role.toUpperCase() + '_MODEL'];
    if (provider || model) roles[role] = [provider, model].filter(Boolean).join(':');
  }
  for (const m of logText.matchAll(
    /\b(generator|agent|healer|data|governor) · ([a-z0-9-]+:[^ ·\n]+)/g,
  )) {
    roles[m[1]] = m[2];
  }
  if (Object.keys(roles).length) out.roles = roles;

  if (r.note) return out;

  try {
    out.holdPercent = r.hold.quotaHoldPercent(process.env);
  } catch { /* a hold percent is a nicety, never a reason to lose the panel */ }

  try {
    const snap = await r.quota.fetchClaudeQuota(process.env);
    out.quota = { limits: snap.limits ?? [], note: snap.note ?? '', fetchedAt: snap.fetchedAt ?? null };
  } catch (err) {
    out.quota = { limits: [], note: String(err && err.message ? err.message : err), fetchedAt: null };
  }

  try {
    const path = r.usage.claudeCliUsagePath(process.env);
    const mtime = existsSync(path) ? statSync(path).mtimeMs : 0;
    if (mtime !== usageCache.mtime) {
      const records = await r.usage.readClaudeCliUsage(process.env);
      usageCache = {
        mtime,
        summary: r.usage.summarizeClaudeCliUsage(records),
        recent: records.slice(-14).reverse().map((c) => ({
          ts: c.ts,
          role: c.role ?? 'unattributed',
          modelId: c.modelId,
          path: c.path,
          wallMs: c.wallMs,
          outputTokens: c.outputTokens,
          finish: c.finish ?? null,
        })),
      };
    }
    const sum = usageCache.summary;
    if (sum) {
      const slim = (t) => ({
        calls: t.calls, costUsd: t.costUsd, inputTokens: t.inputTokens,
        cachedInputTokens: t.cachedInputTokens, outputTokens: t.outputTokens,
        wallMs: t.wallMs, warmCalls: t.warmCalls,
      });
      out.usage = {
        today: slim(sum.today),
        total: slim(sum.total),
        lastCallAt: sum.lastCallAt,
        byRole: sum.byRole.slice(0, 6).map((x) => ({ role: x.role, ...slim(x) })),
        byModel: sum.byModel.slice(0, 4).map((x) => ({ modelId: x.modelId, ...slim(x) })),
      };
    }
    out.recentCalls = usageCache.recent;
  } catch (err) {
    out.note = 'claude-cli ledger unreadable: ' + String(err && err.message ? err.message : err);
  }

  return out;
}

async function build() {
  const state = {
    updatedAt: new Date().toISOString(),
    ledgerFile: ledgerPath ?? null,
    logFile: logPath ?? null,
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
  if (procs.length) {
    state.runner = {
      alive: true,
      pid: procs[0].pid,
      count: procs.length,
      uptime: humanUptime(procs[0].seconds),
      uptimeSec: procs[0].seconds,
    };
  }

  if (!ledgerPath || !existsSync(ledgerPath)) {
    // A folder with a log and no ledger is one of two things, and the log's
    // own last fatal line tells them apart: a run still authoring its first
    // case, or one that died before sealing any — a stale Chrome on the pool's
    // ports is the usual way (2026-09-10: "browser 1 of 4: Chrome did not open
    // port 9333 within the boot timeout", read as "no ledger" for an hour).
    const fatal = lastFatalLine(logPath);
    state.note = fatal
      ? `no ledger — the run ended before sealing a case: ${fatal}`
      : `no ledger at ${ledgerPath ?? catalogsDir} — the run has not sealed its first case yet`;
  } else {
    let led;
    try {
      led = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    } catch {
      // A ledger caught mid-write is normal, not an error. Keep the last good
      // reading rather than blanking the page on a torn read.
      state.note = 'ledger was mid-write at this reading; showing what parsed';
      led = null;
    }
    if (led) {
      const planned = Array.isArray(led.planned) ? led.planned : [];
      const outcomes = led.outcomes && typeof led.outcomes === 'object' ? led.outcomes : {};
      const entries = Object.entries(outcomes);
      state.counts.planned = planned.length;
      for (const [, o] of entries) {
        const v = String(o?.verdict ?? '').toLowerCase();
        if (v === 'passed') state.counts.passed++;
        else if (v === 'failed') state.counts.failed++;
        else if (v === 'blocked') state.counts.blocked++;
        else state.counts.review++;
      }
      // Every sealed verdict, not the newest forty. A search box over forty
      // rows answers "is it recent", which is not the question anyone types
      // into one. At ~380 bytes a row a full catalog costs well under 200KB,
      // and the page repaints only when the set actually changes.
      const authored = led.authored && typeof led.authored === 'object' ? led.authored : {};
      state.outcomes = entries
        .filter(([, o]) => o?.at)
        .sort((a, b) => Date.parse(b[1].at) - Date.parse(a[1].at))
        .slice(0, 2000)
        .map(([id, o]) => ({
          id,
          name: o.name || id,
          verdict: ['passed', 'failed', 'blocked'].includes(String(o.verdict).toLowerCase())
            ? String(o.verdict).toLowerCase()
            : 'review',
          at: o.at,
          status: o.status ? String(o.status).slice(0, 48) : null,
          scenario: authored[id]?.scenarioId ?? null,
          reportPath: reportIfPresent(o.reportPath),
          reason: String(o.reason ?? '').replace(/\s+/g, ' ').slice(0, 240),
        }));
      state.runKey = led.runKey ?? null;
      state.startedAt = led.startedAt ?? null;
      state.title = led.title ?? null;
      state.authored = Object.keys(led.authored ?? {}).length;
      state.ended = led.ended ?? null;
      state.launch = led.launch
        ? { url: led.launch.url ?? null, catalog: led.launch.catalog ? basename(led.launch.catalog) : null }
        : null;
    }
  }

  // The newest log is not always THIS run's log. A run launched in a terminal
  // redirects nowhere, so the newest file on disk can belong to a run that
  // ended hours ago — and pairing it with a live ledger is the exact lie the
  // two clocks exist to prevent: a healthy run reading as wedged. A log that
  // predates the run's own start is not evidence about it.
  let logText = '';
  const startedMs = state.startedAt ? Date.parse(state.startedAt) : NaN;
  const logMs = logPath && existsSync(logPath) ? statSync(logPath).mtimeMs : NaN;
  const logIsOurs =
    Number.isFinite(logMs) && (!Number.isFinite(startedMs) || logMs >= startedMs - 60_000);
  if (logPath && !logIsOurs) {
    state.logFile = null;
    state.note =
      'this run writes no log file — the newest one on disk (' +
      basename(logPath) +
      ') predates it, so the activity feed is empty and the ledger is the only reading';
  }
  if (logPath && logIsOurs) {
    state.logMtime = new Date(statSync(logPath).mtimeMs).toISOString();
    const win = tailAt(logPath);
    logText = win.text;
    state.logLines = logLinesFrom(win.text, win.start, tailLines);
    state.logBytes = win.size;
    state.recentActivity = activityFrom(logText);
    state.requestsSeenThisWindow = (logText.match(/→ (generator|agent|healer|data|governor) /g) ?? []).length;
  }

  state.claude = await claudeSection(logText);

  // A fresh log outranks the process scan: something is plainly writing, so a
  // pattern that failed to match is the scan's problem, not the run's. Only
  // when the log has also gone silent is the absence of a process evidence,
  // and then it is the strongest evidence there is — a killed run seals no
  // `ended`, and that is exactly the state this reading exists to name.
  const logAgeMs = state.logMtime ? Date.now() - Date.parse(state.logMtime) : Infinity;
  if (state.ended) state.phase = state.ended.complete ? 'finished' : 'stopped';
  else if (logAgeMs < 90000) state.phase = 'running';
  else if (state.runner.alive) state.phase = 'quiet';
  else if (state.counts.planned && logAgeMs > 120000) state.phase = 'gone';
  else if (state.counts.planned) state.phase = 'idle';

  return state;
}

function write(state) {
  const body = 'window.__WOW_STATE__ = ' + JSON.stringify(state, null, 1) + ';\n';
  const tmp = OUT + '.tmp';
  writeFileSync(tmp, body);
  renameSync(tmp, OUT); // atomic, so the page never loads a half-written file
}

async function tick() {
  resolvePaths();
  try { write(await build()); } catch (err) { console.error('watch: ' + err.message); }
}

await tick();
if (once) {
  console.log(`wrote ${OUT}`);
} else {
  console.log(`watching → ${OUT}`);
  console.log(`  ledger ${ledgerPath ?? '(none yet — will keep looking each tick)'}`);
  console.log(`  log    ${logPath ?? '(none yet — will keep looking each tick)'}`);
  const timer = setInterval(() => { void tick(); }, intervalMs);
  const stop = () => { clearInterval(timer); void tick().finally(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
