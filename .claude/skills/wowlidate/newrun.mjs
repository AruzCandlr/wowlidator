#!/usr/bin/env node
// One catalog, one folder. Everything a run writes lands inside it.
//
// Before this, every run on this machine emptied into one flat `reports/`
// tree: per-case report folders, proof bundles, recordings, ledgers and logs
// from every catalog ever run, side by side. Two runs in flight at once is the
// case that makes it indefensible — on 2026-09-08 a second BE run was launched
// beside a live one and their logs, ledgers and media interleaved in the same
// directory, and telling them apart afterwards meant reading timestamps.
//
// Nothing in src/ needs to change for this. The engine already routes every
// artifact through WOWLIDATOR_REPORT_DIR and WOWLIDATOR_PROOF_DIR, so pointing
// those at a per-run folder is the whole mechanism. This script only creates
// the folder, plants the monitor page in it, and prints the exact environment
// the launch must carry — printed rather than exported, because a run that is
// re-pointed halfway is a run whose ledger is split across two places.
//
// **A folder is reused, not re-created.** `--resume` is on essentially every
// launch, and it finds a ledger by path — so stamping a fresh folder each time
// would turn every re-entry into a full re-run, the exact failure the report
// directory has already caused once (2026-09-07). So: the newest folder for
// this catalog name that already holds a ledger is reused and said so; a new
// one is stamped only when there is nothing to resume. `--fresh` forces one.
//
// Usage: node newrun.mjs <catalog> [--name <slug>] [--fresh]
//
// Prints shell-ready lines. The caller evals or copies them:
//   eval "$(node .claude/skills/wowlidate/newrun.mjs cases.csv --name be)"

import { mkdirSync, copyFileSync, existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { REPO, SKILL_DIR, loadDotEnv, reportDir } from './paths.mjs';

const argv = process.argv.slice(2);
const flag = (n) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};
const fresh = argv.includes('--fresh');
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--name') { i++; continue; }
  if (!argv[i].startsWith('--')) positional.push(argv[i]);
}
const catalog = positional[0];
if (!catalog) {
  console.error('usage: node newrun.mjs <catalog> [--name <slug>] [--fresh]');
  process.exit(2);
}

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);

// The folder is named for the catalog and stamped with the launch time, so a
// second run of the same sheet never lands on the first one's artifacts. The
// stamp is local time in a sortable shape: `ls` orders the runs by when they
// happened, which is the order anyone looking for one wants them in.
const name = slugify(flag('name') ?? basename(catalog).replace(/\.[^.]+$/, ''));

loadDotEnv(REPO);
// reportDir() is the BASE — the tree every run's folder is created under. It
// is read before this script exports anything, so a run folder is never
// created inside another run's folder.
const base = reportDir(REPO);
const runs = join(base, 'runs');

/**
 * The newest folder for this catalog that has something worth resuming. A
 * folder with no ledger is not a run to continue — it is a launch that died
 * before sealing a case — so it is passed over rather than reused, and the
 * caller gets a clean one instead of a `--resume` that finds nothing.
 */
function resumable() {
  if (!existsSync(runs)) return null;
  const mine = readdirSync(runs)
    .filter((f) => f === name || f.startsWith(name + '-'))
    .sort()
    .reverse();
  for (const f of mine) {
    const dir = join(runs, f);
    const cat = join(dir, 'catalogs');
    if (!existsSync(cat)) continue;
    if (readdirSync(cat).some((x) => x.endsWith('.claims.progress.json'))) return dir;
  }
  return null;
}

const reused = fresh ? null : resumable();
const d = new Date();
const p2 = (n) => String(n).padStart(2, '0');
const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
const runDir = reused ?? join(runs, `${name}-${stamp}`);

for (const d of [runDir, join(runDir, 'catalogs'), join(runDir, 'proofs'), join(runDir, 'monitor')]) {
  mkdirSync(d, { recursive: true });
}

// The monitor page is copied, not linked. The page and the state file it loads
// must be siblings — a file:// page cannot load a script from outside its own
// folder without the browser's leave — and a copy is also what makes the run
// readable a month later, when the skill's own page has moved on.
const page = join(runDir, 'monitor', 'index.html');
copyFileSync(join(SKILL_DIR, 'monitor', 'index.html'), page);

// A reused folder gets a NEW log per launch. The ledger is the run's memory
// and must be one file; the log is what a single launch said, and appending
// one launch onto another's output is how a resumed run's failures get read as
// the first attempt's.
const logPath = join(runDir, 'catalogs', `${name}-${stamp}.log`);

// Emitted as shell assignments so the launch carries them and nothing else on
// the machine does. Exporting these into a long-lived shell is how an
// unrelated later command writes into a finished run's folder.
const out = [
  `WOW_RUN_DIR=${runDir}`,
  `WOW_RUN_LOG=${logPath}`,
  `WOW_RUN_PAGE=${page}`,
  `WOW_RUN_STATE=${join(runDir, 'monitor', 'run-state.js')}`,
  `export WOWLIDATOR_REPORT_DIR=${runDir}`,
  `export WOWLIDATOR_PROOF_DIR=${join(runDir, 'proofs')}`,
];
console.log(out.join('\n'));
// To stdout would be to eval it. Which folder was chosen, and why, is the one
// thing the caller must actually read.
console.error(reused ? `reusing run folder ${runDir}` : `new run folder ${runDir}`);
if (!existsSync(page)) process.exit(1);
