/**
 * The record's catalog-run list — ledgers on disk read back as resumable
 * entries, so the offer to continue a run survives a panel restart. Pure
 * file-walk-and-parse, unit tier, same reasoning as `context-engine.test.ts`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { listCatalogRuns, missingPersonaPasswords } from '../src/ui/catalog-runs.js';
import { newLedger, recordOutcome, writeLedger } from '../src/cli/suite-progress.js';

describe('the catalog-run record', () => {
  it('lists a ledger under its run key with the counts a resume banner needs', async () => {
    const reportDir = await mkdtemp(join(tmpdir(), 'wow-catalog-runs-'));
    await mkdir(join(reportDir, 'catalogs'), { recursive: true });

    const ledger = newLedger('wowlidator catalog — be100.csv', ['A_1', 'A_2', 'A_3', 'A_4']);
    ledger.runKey = 'be100@2026-08-24T10:00:00.000Z';
    ledger.launch = { catalog: '/x/be100.csv', claims: join(reportDir, 'catalogs', 'be100.claims.json') };
    recordOutcome(ledger, { name: 'A_1 one', verdict: 'passed', bundle: null });
    recordOutcome(ledger, { name: 'A_2 two', verdict: 'failed', bundle: { status: 'error' } as never, reason: 'db down' });
    ledger.ended = { at: 'now', cause: 'paused with 2 case(s) still to run', complete: false };
    const path = join(reportDir, 'catalogs', 'be100.claims.progress.json');
    await writeLedger(path, ledger);
    // A JSON file that is not a ledger is skipped, never fatal.
    await writeFile(join(reportDir, 'catalogs', 'not-a-ledger.progress.json'), '{"version":99}', 'utf8');

    const runs = await listCatalogRuns(reportDir);
    const entry = runs.find((r) => r.ledgerPath === resolve(path));
    assert.ok(entry, 'the ledger is listed');
    assert.equal(entry.runKey, 'be100@2026-08-24T10:00:00.000Z');
    assert.equal(entry.title, 'wowlidator catalog — be100.csv');
    assert.equal(entry.left, 2);
    assert.equal(entry.resumable, true);
    assert.equal(entry.errors, 1);
    assert.equal(entry.failed, 0);
    assert.equal(entry.summary.planned, 4);
    assert.equal(entry.ended?.cause, 'paused with 2 case(s) still to run');
    assert.equal(entry.launch?.catalog, '/x/be100.csv');
    assert.equal(
      runs.find((r) => r.ledgerPath.endsWith('not-a-ledger.progress.json')),
      undefined,
    );
  });

  it('records the Chromes a case ran on, first use first, each once', () => {
    const ledger = newLedger('browsers', ['A_1', 'A_3']);
    recordOutcome(ledger, { name: 'A_1 one', verdict: 'passed', bundle: null });
    // Off the steps' stamps — the manager's browser after the employee's.
    recordOutcome(ledger, {
      name: 'A_3 three',
      verdict: 'passed',
      bundle: {
        status: 'passed',
        steps: [
          { browser: 'http://localhost:9222' },
          { browser: 'http://localhost:9223', persona: 'MANAGER_ACCOUNT' },
          { browser: 'http://localhost:9222' },
          {},
        ],
      } as never,
    });
    assert.deepEqual(ledger.outcomes['A_3']?.browsers, ['http://localhost:9222', 'http://localhost:9223']);
    assert.equal(ledger.outcomes['A_1']?.browsers, undefined);
  });

  it('a completed run is listed but not resumable', async () => {
    const reportDir = await mkdtemp(join(tmpdir(), 'wow-catalog-runs-'));
    await mkdir(join(reportDir, 'catalogs'), { recursive: true });
    const ledger = newLedger('done', ['A_1']);
    recordOutcome(ledger, { name: 'A_1 one', verdict: 'passed', bundle: null });
    ledger.ended = { at: 'now', cause: null, complete: true };
    const path = join(reportDir, 'catalogs', 'done.claims.progress.json');
    await writeLedger(path, ledger);
    const entry = (await listCatalogRuns(reportDir)).find((r) => r.ledgerPath === resolve(path));
    assert.equal(entry?.resumable, false);
    assert.equal(entry?.left, 0);
  });

  it('carries every account the run signs in as — labels and emails, never a password', async () => {
    // `launch.personas` has been written to the ledger since it learned the
    // field and has been on this wire ever since, read by nothing. A person
    // looking at a resumable two-login run could not see that it needed two,
    // which is the same blindness the launcher had before it could ask.
    const reportDir = await mkdtemp(join(tmpdir(), 'wow-catalog-personas-'));
    await mkdir(join(reportDir, 'catalogs'), { recursive: true });

    const ledger = newLedger('wowlidator catalog — probation.csv', ['PR_01_01']);
    ledger.runKey = 'probation@2026-09-04T09:00:00.000Z';
    ledger.launch = {
      catalog: '/x/probation.csv',
      claims: join(reportDir, 'catalogs', 'probation.claims.json'),
      persona: 'mgr@x.test',
      personas: { MANAGER_ACCOUNT: 'mgr@x.test', HRBP_ACCOUNT: 'hrbp@x.test' },
    };
    await writeLedger(join(reportDir, 'catalogs', 'probation.claims.progress.json'), ledger);

    const runs = await listCatalogRuns(reportDir);
    const run = runs.find((r) => r.runKey === ledger.runKey);
    assert.ok(run);
    assert.deepEqual(run.launch?.personas, { MANAGER_ACCOUNT: 'mgr@x.test', HRBP_ACCOUNT: 'hrbp@x.test' });

    // The ledger is a file on disk that outlives the panel. No key in it may
    // hold a secret, whatever else it grows.
    for (const key of Object.keys(run.launch ?? {})) assert.doesNotMatch(key, /password|passwd|pwd|secret|token/i);
    assert.doesNotMatch(JSON.stringify(run.launch), /password|passwd|secret/i);
  });

  it('names every account a resume still needs, and pairs each password with the LEDGER\'s email', () => {
    const launch = {
      catalog: '/x/probation.csv',
      claims: '/x/probation.claims.json',
      personas: { MANAGER_ACCOUNT: 'mgr@x.test', HRBP_ACCOUNT: 'hrbp@x.test' },
    } as never;

    // Nothing known: both are asked for, by label and by the email recorded.
    const cold = missingPersonaPasswords(launch, undefined, {});
    assert.deepEqual(cold.missing, [
      { label: 'MANAGER_ACCOUNT', email: 'mgr@x.test' },
      { label: 'HRBP_ACCOUNT', email: 'hrbp@x.test' },
    ]);
    assert.deepEqual(cold.personas, {});

    // One supplied is not enough — the other is still named. This is the whole
    // bug: the old gate looked at one account and let the run start blind for
    // every other, which died at the second signIn with PersonaUnknownError.
    const half = missingPersonaPasswords(launch, undefined, {}, { MANAGER_ACCOUNT: 'pw1' });
    assert.deepEqual(half.missing, [{ label: 'HRBP_ACCOUNT', email: 'hrbp@x.test' }]);

    // Both supplied: the run may start, and each password is paired with the
    // email the LEDGER recorded — the client sends the secret half only and
    // cannot redirect the run at a different account.
    const full = missingPersonaPasswords(launch, undefined, {}, { MANAGER_ACCOUNT: 'pw1', HRBP_ACCOUNT: 'pw2' });
    assert.deepEqual(full.missing, []);
    assert.deepEqual(full.personas, {
      MANAGER_ACCOUNT: { email: 'mgr@x.test', password: 'pw1' },
      HRBP_ACCOUNT: { email: 'hrbp@x.test', password: 'pw2' },
    });

    // An email the client tries to substitute is ignored: only the password is
    // taken from what it sent.
    const spoof = missingPersonaPasswords(launch, undefined, {}, { MANAGER_ACCOUNT: 'pw1', HRBP_ACCOUNT: 'pw2' });
    assert.equal(spoof.personas['HRBP_ACCOUNT']?.email, 'hrbp@x.test');
  });

  it('asks for nothing already carried by the panel session or the machine', () => {
    const launch = { catalog: '/x/c.csv', claims: '/x/c.json', personas: { A_ACCOUNT: 'a@x.test' } } as never;
    const carried = JSON.stringify({ A_ACCOUNT: { email: 'a@x.test', password: 'from-the-prior-job' } });

    // A resume in the SAME panel session inherits the prior job's environment.
    const inherited = missingPersonaPasswords(launch, { WOWLIDATOR_PERSONAS: carried }, {});
    assert.deepEqual(inherited.missing, []);
    assert.equal(inherited.personas['A_ACCOUNT']?.password, 'from-the-prior-job');

    // …and a machine whose own environment carries them needs no asking either.
    const fromEnv = missingPersonaPasswords(launch, undefined, { WOWLIDATOR_PERSONAS: carried });
    assert.deepEqual(fromEnv.missing, []);

    // A malformed map is "nothing known", never a crash: the worst outcome is
    // asking for a password the caller already had.
    const broken = missingPersonaPasswords(launch, { WOWLIDATOR_PERSONAS: 'not json' }, {});
    assert.deepEqual(broken.missing, [{ label: 'A_ACCOUNT', email: 'a@x.test' }]);

    // A run that names no personas is untouched — every single-account resume
    // behaves exactly as it did.
    assert.deepEqual(missingPersonaPasswords({ catalog: 'c', claims: 'j' } as never, undefined, {}), { missing: [], personas: {} });
    assert.deepEqual(missingPersonaPasswords(null, undefined, {}), { missing: [], personas: {} });
  });
});
