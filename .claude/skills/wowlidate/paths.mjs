// Where this repo's runs actually write, resolved the way the CLI resolves it.
//
// Getting this wrong is not cosmetic: a ledger looked for in the wrong place
// turns a `--resume` into a full re-run, which is exactly what happened on
// 2026-09-07. `.env` here redirects reports out of the repo, so the in-repo
// default is the fallback, never the assumption.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILL_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(SKILL_DIR, '../../..');

/** `.env` into process.env, without overwriting what is already set. */
export function loadDotEnv(root = REPO) {
  try {
    for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) {
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
}

export function reportDir(root = REPO) {
  const raw = process.env['WOWLIDATOR_REPORT_DIR'];
  if (raw) return resolve(raw.replace(/^~/, process.env['HOME'] ?? '~'));
  try {
    const m = readFileSync(join(root, '.env'), 'utf8').match(/^WOWLIDATOR_REPORT_DIR=(.*)$/m);
    if (m) {
      return resolve(m[1].trim().replace(/^['"]|['"]$/g, '').replace(/^~/, process.env['HOME'] ?? '~'));
    }
  } catch { /* fall through to the in-repo default */ }
  return join(root, '.wowlidator', 'reports');
}

/**
 * Every run folder `newrun.mjs` has created under the report directory —
 * `<report-dir>/runs/<slug>-<stamp>/` — newest first. A run launched that way
 * writes its ledger INSIDE its own folder, and only the shell that ran the
 * launch's `eval` still has WOWLIDATOR_REPORT_DIR pointed there. Every other
 * session (a triage the next morning, a watcher started by hand, a resume
 * listing) resolved `<report-dir>/catalogs/` and found nothing — "no ledger"
 * about a run with a perfectly good one (2026-09-10).
 */
export function runDirs(root = REPO) {
  const runs = join(reportDir(root), 'runs');
  if (!existsSync(runs)) return [];
  return readdirSync(runs)
    .map((f) => join(runs, f))
    .filter((d) => existsSync(join(d, 'catalogs')))
    .map((d) => ({ d, m: newestMtime(join(d, 'catalogs'), '.claims.progress.json') ?? statSync(d).mtimeMs }))
    .sort((a, b) => b.m - a.m)
    .map((x) => x.d);
}

function newestMtime(dir, suffix) {
  let best = null;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(suffix)) continue;
    const m = statSync(join(dir, f)).mtimeMs;
    if (best === null || m > best) best = m;
  }
  return best;
}

/**
 * Every catalog directory a run on this machine may have written to, in the
 * order a "current run" question should search them: the run folder this
 * shell launched (`WOW_RUN_DIR`, from the `newrun.mjs` eval), then every run
 * folder under the report directory newest first, then the report directory's
 * own `catalogs/`, then the in-repo default — because a ledger carried between
 * checkouts lands in the other one and is then invisible.
 */
export function catalogDirs(root = REPO) {
  const own = process.env['WOW_RUN_DIR'];
  const dirs = [
    ...(own ? [join(resolve(own), 'catalogs')] : []),
    ...runDirs(root).map((d) => join(d, 'catalogs')),
    join(reportDir(root), 'catalogs'),
    join(root, '.wowlidator', 'reports', 'catalogs'),
  ];
  return [...new Set(dirs)].filter((d) => existsSync(d));
}

/** Every ledger across `dirs`, newest first: `{ path, dir, run, mtimeMs }`; `run` is the run folder name or null. */
export function ledgersAcross(dirs) {
  const hits = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.claims.progress.json')) continue;
      const path = join(dir, f);
      const parent = dirname(dir);
      const run = dirname(parent).endsWith(`${sep}runs`) || basename(dirname(parent)) === 'runs' ? basename(parent) : null;
      hits.push({ path, dir, run, slug: basename(f, '.claims.progress.json'), mtimeMs: statSync(path).mtimeMs });
    }
  }
  return hits.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * The ledger a person means by `ref`:
 * - nothing or `latest` — the newest ledger anywhere `catalogDirs` looks;
 * - a path to a ledger — that file;
 * - a path to a run folder (or its `catalogs/`) — the newest ledger inside it;
 * - a run folder name, or a prefix of one (`be-sit-high-fixed`), or a ledger
 *   slug prefix — the newest ledger whose run or slug starts with it.
 * Null when nothing matches; `describeLedgerSearch` says where it looked.
 */
export function findLedger(ref, root = REPO) {
  const all = ledgersAcross(catalogDirs(root));
  if (ref === undefined || ref === '' || ref === 'latest') return all[0]?.path ?? null;
  const asPath = resolve(ref.replace(/^~/, process.env['HOME'] ?? '~'));
  if (existsSync(asPath)) {
    const st = statSync(asPath);
    if (st.isFile()) return asPath;
    const inside = ledgersAcross([asPath, join(asPath, 'catalogs')]);
    if (inside.length) return inside[0].path;
  }
  const needle = basename(ref).toLowerCase();
  const hit = all.find((l) => (l.run ?? '').toLowerCase().startsWith(needle) || l.slug.toLowerCase().startsWith(needle));
  return hit?.path ?? null;
}

/** For an error message: the directories searched and the newest ledgers found. */
export function describeLedgerSearch(root = REPO, limit = 6) {
  const dirs = catalogDirs(root);
  const lines = ['searched:', ...dirs.map((d) => `  ${d}`)];
  const found = ledgersAcross(dirs).slice(0, limit);
  if (found.length) {
    lines.push('newest ledgers found:');
    for (const l of found) lines.push(`  ${new Date(l.mtimeMs).toISOString()}  ${l.run ?? '(no run folder)'}  ${l.path}`);
  }
  return lines.join('\n');
}

/** Newest file with `suffix` across `dirs`, or null. */
export function newestAcross(dirs, suffix) {
  const hits = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (f.endsWith(suffix)) hits.push({ p: join(dir, f), m: statSync(join(dir, f)).mtimeMs });
    }
  }
  hits.sort((a, b) => b.m - a.m);
  return hits.length ? hits[0].p : null;
}
