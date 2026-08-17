/**
 * `wowlidator watch` change detection, flake quarantine, and captured-text marking
 * (specs A4, A5, R5).
 *
 * Unit-tier throughout: the interesting logic is "when is this worth telling
 * someone about" and "when may a failure stop counting", both pure decisions
 * over a bundle and its history. The loop around them is a `setTimeout`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ProofBundleBuilder, type ProofBundle } from '../src/engine/proof-bundle.js';
import { CONSECUTIVE_PASSES_TO_CLEAR, decideQuarantine } from '../src/history/quarantine.js';
import { renderReport } from '../src/reporter/html-reporter.js';
import type { HistoryEntry } from '../src/history/run-history.js';
import {
  classifyChange,
  formatWatchLine,
  notifyPayload,
  parseInterval,
  type WatchState,
} from '../src/watch.js';

const base = { startedAt: '2026-08-03T10:00:00.000Z', durationMs: 40, url: 'http://app/x' };

function bundleOf(
  status: 'passed' | 'failed',
  trend?: Partial<ProofBundle['trend']> & { verdict: string },
): ProofBundle {
  const builder = new ProofBundleBuilder({ name: 'nightly', cdpUrl: null, cachePath: null });
  builder.addStep({
    action: 'click',
    intent: 'Do the thing',
    selector: '#a',
    resolvedSelector: status === 'passed' ? '#a' : null,
    resolution: status === 'passed' ? 'fast' : null,
    status,
    ...base,
    ...(status === 'failed' ? { error: 'could not resolve "#a"' } : {}),
  });
  const bundle = builder.finish();
  if (trend) {
    (bundle as { trend?: unknown }).trend = {
      consecutiveFailures: 0,
      flips: 2,
      sampleSize: 10,
      newFailures: [],
      message: 'test fixture',
      ...trend,
    };
  }
  return bundle;
}

const entry = (status: 'passed' | 'failed', runId: string): HistoryEntry =>
  ({ runId, name: 'nightly', status, finishedAt: base.startedAt }) as HistoryEntry;

describe('watch — when to speak up', () => {
  it('reports the first result, then stays quiet while nothing changes', () => {
    const state: WatchState = {};
    assert.equal(classifyChange(bundleOf('passed'), state), 'first-result');

    state.previousStatus = 'passed';
    assert.equal(classifyChange(bundleOf('passed'), state), 'unchanged');
  });

  it('speaks up on both transitions', () => {
    assert.equal(classifyChange(bundleOf('failed'), { previousStatus: 'passed' }), 'broke');
    assert.equal(classifyChange(bundleOf('passed'), { previousStatus: 'failed' }), 'fixed');
  });

  it('treats "started alternating" as news even when the result did not change', () => {
    // Same reason `flaky` outranks pass/fail in analyseTrend: a test that has
    // begun flipping is untrustworthy whichever way it landed this time.
    const change = classifyChange(bundleOf('passed', { verdict: 'flaky' }), {
      previousStatus: 'passed',
      previousTrend: 'stable',
    });
    assert.equal(change, 'now-flaky');
  });

  it('does not re-announce a flaky test on every run', () => {
    const change = classifyChange(bundleOf('passed', { verdict: 'flaky' }), {
      previousStatus: 'passed',
      previousTrend: 'flaky',
    });
    assert.equal(change, 'unchanged');
  });

  it('hands the notifier a payload that stands alone', () => {
    const payload = notifyPayload(bundleOf('failed'), 'broke', '/reports/nightly.html');
    assert.equal(payload.change, 'broke');
    assert.equal(payload.status, 'failed');
    assert.match(payload.headline, /^FAILED — nightly/);
    assert.match(payload.what, /Do the thing/);
    assert.equal(payload.reportPath, '/reports/nightly.html');
    // Whoever receives this should not need the terminal it came from.
    assert.ok(JSON.parse(JSON.stringify(payload)));
  });

  it('formats one readable line per iteration', () => {
    const line = formatWatchLine(notifyPayload(bundleOf('failed'), 'broke', null), 3);
    assert.match(line, /#3 ✗ nightly {2}← BROKE/);
  });
});

describe('watch — interval parsing', () => {
  it('reads the units a person would type', () => {
    assert.equal(parseInterval('30s'), 30_000);
    assert.equal(parseInterval('15m'), 900_000);
    assert.equal(parseInterval('2h'), 7_200_000);
    assert.equal(parseInterval('90'), 5_400_000, 'a bare number is minutes');
  });

  it('refuses an interval that would hammer the app', () => {
    assert.throws(() => parseInterval('1s'), /too short/);
    assert.throws(() => parseInterval('soon'), /cannot read/);
  });

  it('defaults rather than throwing when unset', () => {
    assert.equal(parseInterval(undefined), 15 * 60 * 1000);
  });
});

describe('flake quarantine', () => {
  it('does nothing unless it was asked for', () => {
    // Automatic entry would be a silent way to hide a real failure — the
    // opt-in is the whole safety mechanism.
    const decision = decideQuarantine(bundleOf('failed', { verdict: 'flaky' }), [], {
      enabled: false,
    });
    assert.equal(decision.quarantined, false);
  });

  it('quarantines a failing run whose history says flaky', () => {
    const decision = decideQuarantine(bundleOf('failed', { verdict: 'flaky' }), [], {
      enabled: true,
    });
    assert.equal(decision.quarantined, true);
    assert.match(decision.reason, /known flaky/);
    assert.match(decision.reason, /reported but not counted/);
  });

  it('refuses to quarantine a consistently failing test', () => {
    const decision = decideQuarantine(bundleOf('failed', { verdict: 'still-broken' }), [], {
      enabled: true,
    });
    assert.equal(decision.quarantined, false);
    assert.match(decision.reason, /a consistently failing test is a broken test/);
  });

  it('lets a case out after a streak of passes, not after one', () => {
    const flaky = bundleOf('failed', { verdict: 'flaky' });
    const almost = Array.from({ length: CONSECUTIVE_PASSES_TO_CLEAR - 1 }, (_, i) =>
      entry('passed', `p${i}`),
    );
    assert.equal(decideQuarantine(flaky, almost, { enabled: true }).quarantined, true);

    const enough = Array.from({ length: CONSECUTIVE_PASSES_TO_CLEAR }, (_, i) =>
      entry('passed', `p${i}`),
    );
    const cleared = decideQuarantine(flaky, enough, { enabled: true });
    assert.equal(cleared.quarantined, false);
    assert.match(cleared.reason, /left quarantine/);
  });

  it('counts only trailing passes — an old streak does not clear anything', () => {
    const flaky = bundleOf('failed', { verdict: 'flaky' });
    const brokenStreak = [
      ...Array.from({ length: CONSECUTIVE_PASSES_TO_CLEAR }, (_, i) => entry('passed', `old${i}`)),
      entry('failed', 'recent'),
    ];
    assert.equal(decideQuarantine(flaky, brokenStreak, { enabled: true }).quarantined, true);
  });
});

describe('captured application text', () => {
  it('quotes non-Latin text verbatim and marks it for screen readers', () => {
    const builder = new ProofBundleBuilder({ name: 'thai', cdpUrl: null, cachePath: null });
    builder.addStep({
      action: 'click',
      intent: 'คลิกประเมินทดลองงาน',
      selector: '#a',
      resolvedSelector: '#a',
      resolution: 'fast',
      status: 'passed',
      ...base,
    });
    const html = renderReport(builder.finish());

    // Verbatim: a report is evidence, and a translation is a claim about it.
    assert.match(html, /คลิกประเมินทดลองงาน/);
    // `lang=""` says "not the document language" without pretending to know
    // which language it is.
    assert.match(html, /<span lang="" class="captured">คลิกประเมินทดลองงาน<\/span>/);
  });

  it('leaves plain English unmarked', () => {
    const builder = new ProofBundleBuilder({ name: 'en', cdpUrl: null, cachePath: null });
    builder.addStep({
      action: 'click',
      intent: 'Press the button',
      selector: '#a',
      resolvedSelector: '#a',
      resolution: 'fast',
      status: 'passed',
      ...base,
    });
    const html = renderReport(builder.finish());
    assert.ok(!/<span lang="" class="captured">Press the button/.test(html));
  });
});
