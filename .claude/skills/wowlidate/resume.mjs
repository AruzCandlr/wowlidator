#!/usr/bin/env node
/**
 * Which runs on this machine are unfinished, and what would re-entering one
 * cost or destroy?
 *
 * A catalog run outlives the command that started it, so "the run" is a ledger
 * on disk, not a process. This lists every ledger both catalog directories
 * hold — the configured report dir and the in-repo default, because a ledger
 * that lands in the other one is invisible and a `--resume` then silently
 * becomes a full re-run.
 *
 * It never re-enters anything. It reports; the caller decides.
 *
 * Usage: node resume.mjs [--json] [--all]
 *   --all  include finished runs, not only the ones with cases left
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { catalogDirs, loadDotEnv } from './paths.mjs';

loadDotEnv();

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const showAll = argv.includes('--all');

/** A run is "live" while its ledger is still being written. */
const LIVE_MS = 90_000;

const runs = [];
for (const dir of catalogDirs()) {
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.claims.progress.json')) continue;
    const path = join(dir, f);
    // The run folder `newrun.mjs` made, when this ledger lives in one.
    const runDir = basename(dirname(dirname(dir))) === 'runs' ? dirname(dir) : null;
    let led;
    try {
      led = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      runs.push({ path, runDir, slug: basename(f, '.claims.progress.json'), unreadable: true });
      continue;
    }
    const planned = Array.isArray(led.planned) ? led.planned : [];
    const outcomes = led.outcomes && typeof led.outcomes === 'object' ? led.outcomes : {};
    const counts = { passed: 0, failed: 0, review: 0, blocked: 0 };
    for (const o of Object.values(outcomes)) {
      const v = String(o?.verdict ?? '').toLowerCase();
      if (v in counts) counts[v]++;
      else counts.review++;
    }
    const reached = counts.passed + counts.failed + counts.review + counts.blocked;
    const mtime = statSync(path).mtimeMs;
    const live = !led.ended && Date.now() - mtime < LIVE_MS;
    runs.push({
      path,
      runDir,
      slug: basename(f, '.claims.progress.json'),
      runKey: led.runKey ?? null,
      title: led.title ?? null,
      startedAt: led.startedAt ?? null,
      updatedAt: new Date(mtime).toISOString(),
      ended: led.ended ?? null,
      planned: planned.length,
      counts,
      reached,
      left: Math.max(0, planned.length - reached),
      authored: Object.keys(led.authored ?? {}).length,
      launch: led.launch
        ? {
            catalog: led.launch.catalog ?? null,
            url: led.launch.url ?? null,
            repo: led.launch.repo ?? null,
            personas: led.launch.personas ? Object.keys(led.launch.personas).length : 0,
          }
        : null,
      dbBaseline: led.dbBaseline ? { tables: led.dbBaseline.tables ?? [], takenAt: led.dbBaseline.takenAt ?? null } : null,
      // The catalog file the run was launched from must still exist, or a
      // re-entry cannot even parse the sheet it is resuming.
      catalogMissing: led.launch?.catalog ? !existsSync(led.launch.catalog) : null,
      live,
      state: live ? 'running' : led.ended ? (led.ended.complete ? 'finished' : 'stopped') : 'abandoned',
    });
  }
}

runs.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
const shown = showAll ? runs : runs.filter((r) => r.unreadable || r.left > 0 || r.state === 'stopped');

if (asJson) {
  console.log(JSON.stringify(shown, null, 1));
  process.exit(0);
}

if (!shown.length) {
  console.log('no unfinished run found in:');
  for (const d of catalogDirs()) console.log('  ' + d);
  process.exit(0);
}

for (const r of shown) {
  if (r.unreadable) {
    console.log(`${r.slug}\n  ledger will not parse: ${r.path}\n`);
    continue;
  }
  const c = r.counts;
  console.log(`${r.slug}   [${r.state}]`);
  if (r.runDir) console.log(`  run dir   ${r.runDir}   (re-enter with: eval "$(node .claude/skills/wowlidate/newrun.mjs <catalog> --name ${basename(r.runDir).replace(/-\d{8}-\d{6}$/, '')})")`);
  console.log(`  run key   ${r.runKey}`);
  console.log(`  progress  ${r.reached}/${r.planned} reached · ${r.left} left · ${r.authored} authored`);
  console.log(`  verdicts  passed ${c.passed} · failed ${c.failed} · review ${c.review} · blocked ${c.blocked}`);
  console.log(`  last wrote ${r.updatedAt}`);
  if (r.ended && !r.ended.complete) console.log(`  stopped   ${r.ended.cause ?? 'cause not recorded'}`);
  if (r.launch) {
    console.log(`  launched  ${r.launch.catalog ?? '(catalog not recorded)'}`);
    console.log(`            --url ${r.launch.url ?? '?'}${r.launch.repo ? ` --repo ${r.launch.repo}` : ' (no --repo)'}`);
  }
  if (r.catalogMissing) console.log(`  BLOCKED   that catalog file no longer exists — a resume cannot read the sheet`);
  if (r.dbBaseline?.tables?.length) console.log(`  db        baseline of ${r.dbBaseline.tables.join(', ')} taken ${r.dbBaseline.takenAt}`);
  console.log(`  ledger    ${r.path}\n`);
}
console.log('A plain --resume keeps every sealed verdict and re-runs only what has none.');
console.log('The --rerun-* family RESETS the verdicts it names first — only pass one on a run that will finish.');
