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


import { catalogDirs, runDirs } from '../paths.mjs';

// The projector lives in the project, not here: the panel serves the SAME
// function at /monitor/run-state.js, and two monitors that disagree about one
// run is the failure this module exists to avoid. It is TypeScript, which is
// the other reason this script wants `npx tsx` — under plain node the import
// fails outright and says so, rather than showing a page computed differently.
let runState;
try {
  runState = await import(new URL('../../../../src/monitor/run-state.ts', import.meta.url).href);
} catch (err) {
  console.error(
    'watch.mjs could not load src/monitor/run-state.ts (' +
      String(err && err.message ? err.message.split('\n')[0] : err) +
      ') — start it with `npx tsx`, not `node`',
  );
  process.exit(1);
}

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
  for (const role of ['generator', 'agent', 'healer']) {
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

// The state itself is built by the project's own projector
// (`src/monitor/run-state.ts`) — the SAME function the panel serves at
// /monitor/run-state.js. This file resolves which run to watch and writes the
// file; it computes nothing the panel would then have to agree with.
async function build() {
  return runState.buildRunState({
    ledgerPath: ledgerPath ?? null,
    logPath: logPath ?? null,
    catalogsDir,
    tailLines,
    claude: claudeSection,
  });
}

function write(state) {
  const body = runState.runStateScript(state);
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
