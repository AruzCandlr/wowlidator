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

import { listCatalogRuns } from '../src/ui/catalog-runs.js';
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
});
