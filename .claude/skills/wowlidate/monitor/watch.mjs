#!/usr/bin/env node
// Project a running catalog into monitor/run-state.js, for index.html to read.
//
// The page is opened from the filesystem, where fetch() of a sibling file is
// blocked. A <script src> is not, so the state is written as an assignment and
// the page re-injects the tag on a timer. That is the whole trick, and it is
// why this writes JS rather than JSON.
//
// Usage: node watch.mjs [--ledger <path>] [--log <path>] [--interval 3] [--once]

import { readFileSync, writeFileSync, renameSync, existsSync, statSync, readdirSync, openSync, readSync, closeSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../../..');
const OUT = join(HERE, 'run-state.js');

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const once = argv.includes('--once');
const intervalMs = Math.max(1, Number(flag('interval', 3))) * 1000;

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

const catalogsDir = join(reportDir(), 'catalogs');
const ledgerPath = flag('ledger', null) ?? newestIn(catalogsDir, '.claims.progress.json');
// The log is wherever the launch redirected stdout, which is often the in-repo
// .wowlidator/ path even when the ledger is not. Look in both.
const logPath =
  flag('log', null) ??
  [catalogsDir, join(REPO, '.wowlidator', 'reports', 'catalogs')]
    .map((d) => newestIn(d, '.log'))
    .filter(Boolean)
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ??
  null;

// Read only the tail; a catalog log reaches hundreds of MB and re-reading it
// whole every few seconds would cost more than the run.
function tail(path, bytes = 262144) {
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - bytes);
    const len = size - start;
    const buf = Buffer.alloc(len);
    const fd = openSync(path, 'r');
    try { readSync(fd, buf, 0, len, start); } finally { closeSync(fd); }
    return buf.toString('utf8');
  } catch { return ''; }
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

function chromeCount() {
  try {
    return execSync('pgrep -f "remote-debugging-port=93" 2>/dev/null | wc -l', { encoding: 'utf8' }).trim() | 0;
  } catch { return 0; }
}

function build() {
  const state = {
    updatedAt: new Date().toISOString(),
    ledgerFile: ledgerPath ?? null,
    logFile: logPath ?? null,
    counts: { planned: 0, passed: 0, failed: 0, review: 0, blocked: 0 },
    recentOutcomes: [],
    recentActivity: [],
    chromeAlive: chromeCount(),
    phase: 'waiting',
    ended: null,
    runKey: null,
    title: null,
    logMtime: null,
    authored: 0,
    requestsSeenThisWindow: 0,
    note: null,
  };

  if (!ledgerPath || !existsSync(ledgerPath)) {
    state.note = `no ledger found under ${catalogsDir} — the run has not written one yet`;
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
      state.recentOutcomes = entries
        .filter(([, o]) => o?.at)
        .sort((a, b) => Date.parse(b[1].at) - Date.parse(a[1].at))
        .slice(0, 40)
        .map(([id, o]) => ({
          id,
          name: o.name || id,
          verdict: ['passed', 'failed', 'blocked'].includes(String(o.verdict).toLowerCase())
            ? String(o.verdict).toLowerCase()
            : 'review',
          at: o.at,
          reason: String(o.reason ?? '').replace(/\s+/g, ' ').slice(0, 240),
        }));
      state.runKey = led.runKey ?? null;
      state.title = led.title ?? null;
      state.authored = Object.keys(led.authored ?? {}).length;
      state.ended = led.ended ?? null;
      state.launch = led.launch
        ? { url: led.launch.url ?? null, catalog: led.launch.catalog ? basename(led.launch.catalog) : null }
        : null;
    }
  }

  if (logPath && existsSync(logPath)) {
    state.logMtime = new Date(statSync(logPath).mtimeMs).toISOString();
    const text = tail(logPath);
    state.recentActivity = activityFrom(text);
    state.requestsSeenThisWindow = (text.match(/→ (generator|agent|healer|data|governor) /g) ?? []).length;
  }

  if (state.ended) state.phase = state.ended.complete ? 'finished' : 'stopped';
  else if (state.logMtime && Date.now() - Date.parse(state.logMtime) < 90000) state.phase = 'running';
  else if (state.counts.planned) state.phase = 'idle';

  return state;
}

function write(state) {
  const body = 'window.__WOW_STATE__ = ' + JSON.stringify(state, null, 1) + ';\n';
  const tmp = OUT + '.tmp';
  writeFileSync(tmp, body);
  renameSync(tmp, OUT); // atomic, so the page never loads a half-written file
}

function tick() {
  try { write(build()); } catch (err) { console.error('watch: ' + err.message); }
}

tick();
if (once) {
  console.log(`wrote ${OUT}`);
} else {
  console.log(`watching → ${OUT}`);
  console.log(`  ledger ${ledgerPath ?? '(none yet)'}`);
  console.log(`  log    ${logPath ?? '(none yet)'}`);
  const timer = setInterval(tick, intervalMs);
  const stop = () => { clearInterval(timer); tick(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
