/**
 * The suite ledger: what a catalog run proved so far, written after every
 * case so a run that stops short can be continued. Pure, plus the job
 * runner's account of how a job ended.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  carriedOutcomes,
  caseIdOf,
  ledgerPathFor,
  newLedger,
  readLedger,
  recordOutcome,
  remaining,
  sortByPlan,
  summariseLedger,
  writeLedger,
} from '../src/cli/suite-progress.js';

describe('suite progress ledger', () => {
  it('lives beside the claims file and is keyed by case id', () => {
    assert.equal(ledgerPathFor('/x/be100.claims.json'), '/x/be100.claims.progress.json');
    assert.equal(caseIdOf('PL_06_05 ตรวจสอบ Required Field'), 'PL_06_05');
  });

  it('keeps verdicts and retries non-verdicts on a resume', async () => {
    const ledger = newLedger('be100', ['A_1', 'A_2', 'A_3', 'A_4', 'A_5']);
    recordOutcome(ledger, { name: 'A_1 one', verdict: 'passed', bundle: null });
    recordOutcome(ledger, { name: 'A_2 two', verdict: 'failed', bundle: null, reason: 'step 3 broke' });
    recordOutcome(ledger, { name: 'A_3 three', verdict: 'blocked', bundle: null, reason: 'quota' });
    // A_4 and A_5 were never reached.
    assert.deepEqual(remaining(ledger), ['A_3', 'A_4', 'A_5']);
    assert.deepEqual(summariseLedger(ledger), { planned: 5, passed: 1, failed: 1, review: 0, blocked: 1, notReached: 2 });

    const dir = await mkdtemp(join(tmpdir(), 'wow-ledger-'));
    const path = join(dir, 'x.claims.progress.json');
    ledger.ended = { at: 'now', cause: 'stopped by SIGINT with 3 case(s) still to run', complete: false };
    await writeLedger(path, ledger);
    const back = await readLedger(path);
    assert.equal(back?.ended?.cause, 'stopped by SIGINT with 3 case(s) still to run');
    assert.deepEqual(remaining(back!), ['A_3', 'A_4', 'A_5']);
    assert.match(await readFile(path, 'utf8'), /"A_2"/);
    // A planned list that shrank (claims struck out since) is honoured.
    assert.deepEqual(remaining(back!, ['A_1', 'A_4']), ['A_4']);
  });

  it('reads nothing from a missing or foreign file', async () => {
    assert.equal(await readLedger('/nonexistent/x.progress.json'), null);
  });

  it('keeps the run key, the launch record and each case\'s name and proof path across a write', async () => {
    const ledger = newLedger('be100', ['A_1']);
    assert.equal(ledger.runKey, null);
    ledger.runKey = 'be100@2026-08-24T10:00:00.000Z';
    ledger.launch = { catalog: '/x/be100.csv', claims: '/x/be100.claims.json', url: 'http://localhost:3000' };
    recordOutcome(
      ledger,
      { name: 'A_1 login works', verdict: 'passed', bundle: null, reportPath: '/r/a1.html' },
      { proofPath: '/p/run-1.json' },
    );
    const dir = await mkdtemp(join(tmpdir(), 'wow-ledger-'));
    const path = join(dir, 'x.claims.progress.json');
    await writeLedger(path, ledger);
    const back = await readLedger(path);
    assert.equal(back?.runKey, 'be100@2026-08-24T10:00:00.000Z');
    assert.equal(back?.launch?.url, 'http://localhost:3000');
    assert.equal(back?.outcomes['A_1']?.name, 'A_1 login works');
    assert.equal(back?.outcomes['A_1']?.proofPath, '/p/run-1.json');
  });
});

describe('carrying finished cases into a resume', () => {
  it('carries only planned verdicts the resume did not re-earn', () => {
    const ledger = newLedger('t', ['A_1', 'A_2', 'A_3', 'A_4', 'A_5']);
    recordOutcome(ledger, { name: 'A_1 one', verdict: 'passed', bundle: null });
    recordOutcome(ledger, { name: 'A_2 two', verdict: 'failed', bundle: null, reason: 'step 3 broke' });
    recordOutcome(ledger, { name: 'A_3 three', verdict: 'blocked', bundle: null, reason: 'quota' });
    recordOutcome(ledger, { name: 'A_4 four', verdict: 'passed', bundle: null });
    ledger.outcomes['A_4']!.vacuous = true; // a vacuous pass was never a verdict
    // The resume ran A_3 (it was blocked) and A_5 (never reached) itself.
    const carried = carriedOutcomes(ledger.outcomes, ledger.planned, new Set(['A_3', 'A_5']));
    assert.deepEqual(
      carried.map((c) => c.id),
      ['A_1', 'A_2'],
    );
    assert.equal(carried[0]?.outcome.name, 'A_1 one');
    // A verdict the resume re-earned is never doubled, even though the prior
    // ledger still holds an entry for it.
    assert.deepEqual(
      carriedOutcomes(ledger.outcomes, ledger.planned, new Set(['A_1', 'A_2', 'A_3', 'A_5'])).map((c) => c.id),
      [],
    );
  });

  it('orders a merged roll-up as the plan reads, not as the stopwatch ran', () => {
    const merged = sortByPlan(
      [
        { name: 'A_3 fresh', verdict: 'passed', bundle: null },
        { name: 'A_1 carried', verdict: 'passed', bundle: null, carried: true },
        { name: 'Z_9 unplanned', verdict: 'failed', bundle: null },
      ],
      ['A_1', 'A_2', 'A_3'],
    );
    assert.deepEqual(
      merged.map((o) => o.name),
      ['A_1 carried', 'A_3 fresh', 'Z_9 unplanned'],
    );
    // No plan at all: the list is returned as it came.
    assert.deepEqual(
      sortByPlan([{ name: 'b', verdict: 'passed', bundle: null }, { name: 'a', verdict: 'passed', bundle: null }], []).map((o) => o.name),
      ['b', 'a'],
    );
  });
});

describe('rerun marking', () => {
  it('marks errors and failures separately, and leaves verdicts it was not asked about', async () => {
    const { markForRerun, isErrorOutcome, isFailedOutcome } = await import('../src/cli/suite-progress.js');
    const ledger = newLedger('t', ['A_1', 'A_2', 'A_3', 'A_4']);
    recordOutcome(ledger, { name: 'A_1 x', verdict: 'passed', bundle: null });
    recordOutcome(ledger, { name: 'A_2 y', verdict: 'failed', bundle: { status: 'error' } as never, reason: 'db unreachable' });
    recordOutcome(ledger, { name: 'A_3 z', verdict: 'failed', bundle: { status: 'dead-end' } as never, reason: 'step 4' });
    recordOutcome(ledger, { name: 'A_4 w', verdict: 'failed', bundle: null, reason: 'threw' });
    assert.deepEqual(markForRerun(ledger, isErrorOutcome, 'rerun after error'), ['A_2', 'A_4']);
    assert.match(ledger.outcomes['A_2']?.reason ?? '', /^rerun after error: db unreachable/);
    assert.deepEqual(markForRerun(ledger, isFailedOutcome, 'heal'), ['A_3']);
    assert.deepEqual(remaining(ledger), ['A_2', 'A_3', 'A_4']);
    assert.equal(ledger.outcomes['A_1']?.verdict, 'passed');
  });
});

describe('authoring refusals', () => {
  it('records a refusal as blocked with its count; a refused row is still "left" once, then is not', async () => {
    const { AUTHORING_REFUSAL_CAP } = await import('../src/cli/suite-progress.js');
    const ledger = newLedger('t', ['A_1', 'A_2']);
    recordOutcome(ledger, { name: 'A_1 x', verdict: 'passed', bundle: null });
    // First pass: strict authoring refused the row. It is on the ledger — the
    // report says why — and a resume lists it, to author it leniently.
    recordOutcome(
      ledger,
      { name: 'A_2', verdict: 'blocked', bundle: null, reason: 'authoring refused (attempt 1): asserts text no tree renders' },
      { authoringRefused: 1 },
    );
    assert.equal(ledger.outcomes['A_2']?.authoringRefused, 1);
    assert.deepEqual(remaining(ledger), ['A_2']);
    // Second pass refused too: that is the cap. A third resume would spend
    // the model twice for the same answer, so the row stops being "left".
    recordOutcome(
      ledger,
      { name: 'A_2', verdict: 'blocked', bundle: null, reason: 'authoring refused (attempt 2): still ungrounded' },
      { authoringRefused: AUTHORING_REFUSAL_CAP },
    );
    assert.deepEqual(remaining(ledger), []);
    assert.equal(ledger.outcomes['A_2']?.verdict, 'blocked');
    // The count survives a write, like every other field.
    const dir = await mkdtemp(join(tmpdir(), 'wow-ledger-'));
    const path = join(dir, 'x.progress.json');
    await writeLedger(path, ledger);
    assert.equal((await readLedger(path))?.outcomes['A_2']?.authoringRefused, AUTHORING_REFUSAL_CAP);
  });

  it('an explicit rerun of errors lifts the cap so the row is authored again', async () => {
    const { AUTHORING_REFUSAL_CAP, markForRerun, isErrorOutcome } = await import('../src/cli/suite-progress.js');
    const ledger = newLedger('t', ['A_1']);
    recordOutcome(ledger, { name: 'A_1', verdict: 'blocked', bundle: null, reason: 'authoring refused (attempt 2): x' }, { authoringRefused: AUTHORING_REFUSAL_CAP });
    assert.deepEqual(remaining(ledger), []);
    assert.deepEqual(markForRerun(ledger, isErrorOutcome, 'rerun after error'), ['A_1']);
    assert.equal(ledger.outcomes['A_1']?.authoringRefused, undefined);
    assert.deepEqual(remaining(ledger), ['A_1']);
  });
});
