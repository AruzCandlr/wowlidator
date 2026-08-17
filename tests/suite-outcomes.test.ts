/**
 * How a list of cases is scored when some of them could not be run.
 *
 * Pure, and imported rather than driven as a subprocess — unlike the rest of
 * the CLI's surface, these two are decision functions with no I/O, and the
 * decision is the whole point. `tests/cli.test.ts` still owns exit codes and
 * stdout as observed from outside.
 *
 * The rule under test: **a run that failed without any step failing learned
 * nothing about the application.** Reporting it red sends someone to look for a
 * bug that was never claimed to exist.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { EXIT, exitCodeFor, neverRan, suiteExit, type CaseOutcome } from '../src/cli.js';
import { isBrowserGone } from '../src/engine/runner.js';
import type { ProofBundle, ProofStep } from '../src/engine/proof-bundle.js';

const step = (status: 'passed' | 'failed'): ProofStep =>
  ({
    action: 'expectVisible',
    selector: 'role=table',
    resolvedSelector: 'role=table',
    resolution: 'fast',
    status,
    startedAt: '2026-08-11T00:00:00.000Z',
    durationMs: 5,
    url: 'http://localhost:3000/',
  }) as ProofStep;

const bundleOf = (over: Partial<ProofBundle>): ProofBundle =>
  ({ name: 'case', status: 'passed', steps: [], ...over }) as ProofBundle;

describe('a browser that dies mid-run', () => {
  it('is recognised from the error Playwright actually throws', () => {
    assert.ok(isBrowserGone('page.goto: Target page, context or browser has been closed'));
    assert.ok(isBrowserGone('Target closed'));
    assert.equal(isBrowserGone('could not resolve "#login" after 2 attempt(s)'), false);
  });

  it('exits as an environment problem, never as an application result', () => {
    // The predecessor PB-02-01 run: two gotos failed on a dead browser and
    // fourteen "failures" were filed against an app the run never reached.
    const gone = bundleOf({
      status: 'error',
      error:
        'the browser went away mid-run (page.goto: Target page, context or browser has been closed) — ' +
        'this is an environment failure, not an application result',
    });
    assert.equal(exitCodeFor(gone), EXIT.environment);
    // An ordinary failure still exits 1 — the contract is unchanged for real results.
    assert.equal(exitCodeFor(bundleOf({ status: 'failed', error: 'boom' })), EXIT.failed);
  });
});

describe('a case that never produced a verdict', () => {
  it('is the shape a dead browser really takes: failed, zero steps, a run error', () => {
    // Not an exception. `runFlow` catches the attach failure and hands back a
    // bundle, which is why a try/catch around it caught nothing and seven cases
    // were reported as red with no explanation under them.
    const bundle = bundleOf({
      status: 'failed',
      steps: [],
      error: 'could not attach to a browser at http://localhost:9222: connect ECONNREFUSED',
    });

    assert.match(String(neverRan(bundle)), /could not attach to a browser/);
  });

  it('counts a run that broke off partway with no assertion contradicted', () => {
    // Two steps passed and then the browser went away. Nothing the application
    // did was ever shown to be wrong.
    const bundle = bundleOf({
      status: 'failed',
      steps: [step('passed'), step('passed')],
      error: 'Target page, context or browser has been closed',
    });

    assert.match(String(neverRan(bundle)), /has been closed/);
  });

  it('gives the reason as one line, because the roll-up gives each case one', () => {
    // The engine's attach error carries a two-line "start Chrome like this"
    // hint. Seven blocked cases printing it whole turned a ten-line summary into
    // a wall. The full text stays on the bundle and in the report.
    const bundle = bundleOf({
      status: 'failed',
      steps: [],
      error:
        'could not attach to a browser at http://localhost:9222: connect ECONNREFUSED\n' +
        'Start Chrome with --remote-debugging-port first (npm run chrome).',
    });

    const reason = String(neverRan(bundle));
    assert.equal(reason.includes('\n'), false);
    assert.match(reason, /ECONNREFUSED$/);
  });

  it('always gives a reason, even when the bundle carries no error text', () => {
    const bundle = bundleOf({ status: 'failed', steps: [step('passed')] });
    assert.match(String(neverRan(bundle)), /before any step could fail/);
  });

  it('is not what a real failure looks like', () => {
    // One step failed: the application was asked a question and gave the wrong
    // answer. That is a result, and it must stay red.
    const bundle = bundleOf({
      status: 'failed',
      steps: [step('passed'), step('failed')],
      error: 'expected 3 matches, found 5',
    });

    assert.equal(neverRan(bundle), null);
  });

  it('is not what a pass looks like', () => {
    assert.equal(neverRan(bundleOf({ status: 'passed', steps: [step('passed')] })), null);
  });
});

describe('the exit code for a list of cases', () => {
  const outcome = (verdict: CaseOutcome['verdict']): CaseOutcome => ({
    name: verdict,
    verdict,
    bundle: null,
  });

  it('is ok only when every listed case passed', () => {
    assert.equal(suiteExit([outcome('passed'), outcome('passed')]), EXIT.ok);
  });

  it('reports a real failure ahead of anything else', () => {
    // Both present: the application being wrong is the more actionable fact.
    assert.equal(suiteExit([outcome('blocked'), outcome('failed')]), EXIT.failed);
  });

  it('never calls a suite green when a case never ran', () => {
    // Nine passes and one case nobody could run is not a green suite — but it is
    // an environment problem, not a defect in the application.
    const outcomes = [...Array<CaseOutcome>(9).fill(outcome('passed')), outcome('blocked')];
    assert.equal(suiteExit(outcomes), EXIT.environment);
  });
});
