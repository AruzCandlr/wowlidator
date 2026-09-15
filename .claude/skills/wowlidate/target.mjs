#!/usr/bin/env node
/**
 * Resolve a named environment from targets.json, and prove it is reachable
 * before a run is spent on it.
 *
 * A target answers WHERE — the URL, the repo index, the database, the
 * credentials — and deliberately not how hard to run: lanes, policy and repair
 * are decided per catalog, because they belong to the catalog, not the
 * environment.
 *
 * The checks are the point. Each one has cost a run on this machine: a URL
 * behind a VPN that was not up, a --repo whose graph was never built, a
 * persona list that was never exported. All are seconds here and an hour
 * afterwards.
 *
 * Usage:
 *   node target.mjs list
 *   node target.mjs <name> [--json]
 *
 * Exit 0 ready · 1 not ready · 2 no such target.
 */
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { REPO, SKILL_DIR, loadDotEnv } from './paths.mjs';

loadDotEnv();

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const name = argv.find((a) => !a.startsWith('--'));

const file = join(SKILL_DIR, 'targets.json');
const doc = JSON.parse(readFileSync(file, 'utf8'));
const targets = doc.targets ?? {};

if (name === undefined || name === 'list') {
  for (const [key, t] of Object.entries(targets)) {
    console.log(`${key.padEnd(14)} ${t.url ?? ''}`);
    if (t.description) console.log(`${' '.repeat(15)}${t.description}`);
  }
  if (!Object.keys(targets).length) console.log('no targets defined in targets.json');
  process.exit(0);
}

const t = targets[name];
if (!t) {
  console.error(`no target "${name}". Known: ${Object.keys(targets).join(', ') || '(none)'}`);
  process.exit(2);
}

const problems = [];
const warnings = [];

// Credentials and database, by key only — a value is never read out, printed
// or put on a command line, because ps shows argv to every process here.
for (const [key, why] of Object.entries(t.requires ?? {})) {
  const value = process.env[key];
  if (value === undefined || value.trim() === '') problems.push(`${key} is not set in .env — ${why}`);
}
for (const [key, why] of Object.entries(t.optional ?? {})) {
  const value = process.env[key];
  if (value === undefined || value.trim() === '') warnings.push(`${key} is not set — ${why}`);
}

// The repo index. `--repo <id>` reads a graph built earlier; naming one that
// was never built is not an error the run reports loudly, it is a run whose
// database claims quietly degrade.
if (t.repo) {
  const graph = join(REPO, '.wowlidator', 'context', `${t.repo}.graph.json`);
  if (!existsSync(graph)) {
    problems.push(`--repo ${t.repo}: no graph at .wowlidator/context/${t.repo}.graph.json — build it with \`context build\``);
  } else {
    try {
      const g = JSON.parse(readFileSync(graph, 'utf8'));
      const kinds = {};
      for (const n of g.nodes ?? []) kinds[n.kind] = (kinds[n.kind] ?? 0) + 1;
      t._graph = { generatedAt: g.generatedAt ?? null, rootDir: g.rootDir ?? null, kinds };
      if (!kinds.table) warnings.push(`--repo ${t.repo}: the graph has no table nodes, so claims asserting database state degrade to what the UI shows`);
    } catch {
      problems.push(`--repo ${t.repo}: the graph file will not parse`);
    }
  }
}

// The database, checked against what .env actually points at. A connection
// string is easy to get almost right — the run on 2026-09-07 named the right
// database, user and password on the wrong host, and every claim asserting
// database state degraded silently rather than failing. Coordinates are
// compared; the password is never read, printed, or put on a command line.
if (t.db) {
  const raw = process.env['WOWLIDATOR_DB_URL'];
  if (raw) {
    let u = null;
    try { u = new URL(raw); } catch { problems.push('WOWLIDATOR_DB_URL will not parse as a URL'); }
    if (u) {
      const actual = {
        host: u.hostname,
        port: Number(u.port || 5432),
        database: decodeURIComponent(u.pathname.replace(/^\//, '')),
        username: decodeURIComponent(u.username),
        schema: decodeURIComponent(u.searchParams.get('options') ?? '').match(/search_path=([^,\s]+)/)?.[1] ?? null,
      };
      for (const key of ['host', 'port', 'database', 'username']) {
        if (t.db[key] !== undefined && actual[key] !== t.db[key]) {
          problems.push(`WOWLIDATOR_DB_URL ${key} is "${actual[key]}", but ${name} is "${t.db[key]}"${key === 'host' ? ` — ${t.db.note ?? ''}` : ''}`);
        }
      }
      if (t.db.schema && actual.schema !== t.db.schema) {
        warnings.push(`WOWLIDATOR_DB_URL has no search_path=${t.db.schema} — unqualified table names resolve against public instead`);
      }
      // Reachable at all? One TCP probe, because a VPN that dropped looks
      // exactly like a wrong host until something tries to connect.
      try {
        execFileSync('nc', ['-z', '-G', '5', String(t.db.host), String(t.db.port)], { timeout: 8000, stdio: 'ignore' });
      } catch {
        problems.push(`${t.db.host}:${t.db.port} refuses a TCP connection — VPN down, or the database moved`);
      }
      t._db = actual;
    }
  }
}

// Reachability. The VPN check is one DNS lookup and it has saved a relaunch.
if (t.reach?.host) {
  let ip = null;
  try {
    ip = execFileSync('dscacheutil', ['-q', 'host', '-a', 'name', t.reach.host], { encoding: 'utf8', timeout: 5000 })
      .match(/ip_address:\s*(\S+)/)?.[1] ?? null;
  } catch { /* fall through to the not-resolving branch */ }
  if (ip === null) {
    problems.push(`${t.reach.host} does not resolve${t.reach.note ? ` — ${t.reach.note}` : ''}`);
  } else if (t.reach.expectIp && ip !== t.reach.expectIp) {
    warnings.push(`${t.reach.host} resolves to ${ip}, not the expected ${t.reach.expectIp}`);
  }
  t._ip = ip;
}

// What to append to a `catalog` command. The environment, and nothing else.
const flags = [];
if (t.url) flags.push('--url', t.url);
if (t.repo) flags.push('--repo', t.repo);

if (asJson) {
  console.log(JSON.stringify({ name, flags, problems, warnings, graph: t._graph ?? null, ip: t._ip ?? null, db: t._db ?? null }, null, 1));
  process.exit(problems.length ? 1 : 0);
}

console.log(`target ${name}${t.description ? ` — ${t.description}` : ''}`);
console.log(`  flags   ${flags.join(' ')}`);
if (t._ip) console.log(`  reach   ${t.reach.host} → ${t._ip}`);
if (t._graph) {
  const k = t._graph.kinds;
  console.log(`  repo    ${t.repo} · ${Object.entries(k).map(([a, b]) => `${b} ${a}`).join(', ')}`);
  console.log(`          built ${t._graph.generatedAt} from ${t._graph.rootDir}`);
}
if (t._db) {
  console.log(`  db      ${t._db.username}@${t._db.host}:${t._db.port}/${t._db.database}${t._db.schema ? ` · search_path ${t._db.schema}` : ''}${t.db.access ? ` · ${t.db.access}` : ''}`);
}
const setKeys = Object.keys(t.requires ?? {}).filter((k) => (process.env[k] ?? '').trim() !== '');
if (setKeys.length) console.log(`  env     ${setKeys.join(', ')} set`);
for (const n of t.notes ?? []) console.log(`  note    ${n}`);
for (const w of warnings) console.log(`  !       ${w}`);
for (const p of problems) console.log(`  BLOCKED ${p}`);
console.log(problems.length ? '\nnot ready — fix the blocked lines above before launching' : '\nready');
process.exit(problems.length ? 1 : 0);
