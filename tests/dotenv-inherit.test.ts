/**
 * `.env` values must not masquerade as the real environment in child runs.
 *
 * The shape of the bug (hit live, EmmieDev): the panel loads `.env` at
 * startup, the user corrects a bad API key in the file, and every run the
 * panel spawns still fails auth — the child inherited the panel's stale
 * snapshot, and the child's own `loadDotEnv` correctly lets "the real
 * environment" win over the file, not knowing that this particular value was
 * never the real environment at all. `DOTENV_SOURCED` is how the panel knows
 * which vars to keep out of the inheritance; these tests pin the tracking and
 * the precedence rules around it.
 *
 * Spawned as subprocesses because `loadDotEnv`'s ORIGINAL_ENV snapshot is
 * taken at module import — the rules under test are import-order rules, and
 * only a fresh process exercises them honestly.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

const PROJECT = process.cwd();

/** Run a snippet in a fresh tsx process and return its stdout. */
let snippetId = 0;
function inFreshProcess(code: string, env: Record<string, string>, cwd: string): string {
  const file = join(cwd, `snippet-${snippetId++}.mts`);
  writeFileSync(file, code);
  return execFileSync(
    process.execPath,
    [join(PROJECT, 'node_modules', '.bin', 'tsx'), file],
    { cwd, env: { ...env, PATH: process.env['PATH'] ?? '' }, encoding: 'utf8' },
  ).trim();
}

describe('loadDotEnv provenance (DOTENV_SOURCED)', () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wowlidator-dotenv-'));
    await writeFile(join(dir, '.env'), 'EMMIEDEV_API_KEY=ek-from-file\n');
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('marks a file-supplied value as dotenv-sourced', async () => {
    const out = inFreshProcess(
      `import { loadDotEnv, DOTENV_SOURCED } from '${PROJECT}/src/config.js';
       loadDotEnv();
       console.log(process.env['EMMIEDEV_API_KEY'], DOTENV_SOURCED.has('EMMIEDEV_API_KEY'));`,
      {},
      dir,
    );
    assert.equal(out, 'ek-from-file true');
  });

  it('a real-environment value wins over the file and is NOT marked', async () => {
    const out = inFreshProcess(
      `import { loadDotEnv, DOTENV_SOURCED } from '${PROJECT}/src/config.js';
       loadDotEnv();
       console.log(process.env['EMMIEDEV_API_KEY'], DOTENV_SOURCED.has('EMMIEDEV_API_KEY'));`,
      { EMMIEDEV_API_KEY: 'ek-from-shell' },
      dir,
    );
    assert.equal(out, 'ek-from-shell false');
  });

  it('an inherited stale value is replaced once the parent stops exporting it', async () => {
    // The child of a fixed panel: no EMMIEDEV var in its environment, the
    // corrected file on disk. It must read the file.
    const out = inFreshProcess(
      `import { loadDotEnv } from '${PROJECT}/src/config.js';
       loadDotEnv();
       console.log(process.env['EMMIEDEV_API_KEY']);`,
      {},
      dir,
    );
    assert.equal(out, 'ek-from-file');
  });

  it('a reload in the same process picks up a replaced value', async () => {
    const out = inFreshProcess(
      `import { writeFileSync } from 'node:fs';
       import { loadDotEnv, DOTENV_SOURCED } from '${PROJECT}/src/config.js';
       loadDotEnv();
       const first = process.env['EMMIEDEV_API_KEY'];
       writeFileSync('.env', 'EMMIEDEV_API_KEY=ek-corrected\\n');
       loadDotEnv();
       console.log(first, process.env['EMMIEDEV_API_KEY'], DOTENV_SOURCED.has('EMMIEDEV_API_KEY'));
       writeFileSync('.env', 'EMMIEDEV_API_KEY=ek-from-file\\n');`,
      {},
      dir,
    );
    assert.equal(out, 'ek-from-file ek-corrected true');
  });
});
