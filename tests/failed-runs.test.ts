/**
 * Runs that ended without a proof are kept, not lost with the live row.
 * Pure: a JSONL log in a temp dir and the page source. No browser, no model.
 */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { FailedRunLog, leftNoProof, toFailedRun } from '../src/ui/failed-runs.js';
import type { Job } from '../src/ui/jobs.js';
import { renderWowUi } from '../src/ui/wow-ui-html.js';

function job(over: Partial<Job> = {}): Job {
  return {
    id: 'job-3',
    commandId: 'catalog-run',
    title: 'Prove a catalog',
    commandLine: 'wowlidator catalog be100.csv --run',
    argv: ['catalog', 'be100.csv', '--run'],
    browser: true,
    longRunning: false,
    status: 'error',
    exitCode: 3,
    ended: { cause: 'could not attach to a browser', resumable: false, runtimeError: true, errors: 0, failed: 0, unfinished: 0 },
    startedAt: '2026-08-21T04:19:55.390Z',
    finishedAt: '2026-08-21T04:19:58.300Z',
    lines: [
      { stream: 'out', text: 'starting Chrome…' },
      { stream: 'out', text: '' },
      { stream: 'err', text: 'wowlidator: cannot reach http://localhost:3000/en/login — is the app running?' },
    ],
    artifacts: [],
    progress: { done: 0, total: null, etaMs: null, percent: null, phase: null, rateMsPerStep: null, lastStepMs: 0, startedMs: null },
    cases: [],
    ...over,
  };
}

describe('failed runs without a proof', () => {
  it('qualifies a non-passing job that announced no proof', () => {
    assert.equal(leftNoProof(job()), true);
    assert.equal(leftNoProof(job({ status: 'stopped', exitCode: null })), true);
    assert.equal(leftNoProof(job({ status: 'passed', exitCode: 0 })), false);
    assert.equal(leftNoProof(job({ status: 'running', exitCode: null, finishedAt: null })), false);
  });

  it('defers to the bundle when one exists — a failure is never listed twice', () => {
    const withProof = job({ status: 'failed', exitCode: 1, artifacts: [{ kind: 'proof', path: '/p/x.json' }] });
    assert.equal(leftNoProof(withProof), false);
    assert.equal(toFailedRun(withProof), null);
  });

  it('keeps the last lines as the reason, blank lines dropped', () => {
    const entry = toFailedRun(job());
    assert.ok(entry);
    assert.deepEqual(entry.reason, [
      'starting Chrome…',
      'wowlidator: cannot reach http://localhost:3000/en/login — is the app running?',
    ]);
    assert.equal(entry.exitCode, 3);
  });

  it('round-trips through the log, newest first, and clears', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wow-failed-'));
    const log = new FailedRunLog(join(dir, 'nested', 'failed-runs.jsonl'));
    await log.record(job({ id: 'job-1', startedAt: '2026-08-21T04:00:00.000Z' }));
    await log.record(job({ status: 'passed', exitCode: 0 }));
    await log.record(job({ id: 'job-2', startedAt: '2026-08-21T05:00:00.000Z' }));
    const list = await log.list();
    assert.equal(list.length, 2);
    assert.equal(list[0]!.id, '2026-08-21T05:00:00.000Z#job-2');
    assert.match(list[0]!.reason.at(-1)!, /cannot reach/);
    await log.clear();
    assert.deepEqual(await log.list(), []);
  });

  it('the page renders the section from /api/failed-runs', () => {
    const html = renderWowUi();
    assert.match(html, /\/api\/failed-runs/);
    assert.match(html, /Failed runs — no proof was produced/);
  });
});
