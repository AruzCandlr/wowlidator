/**
 * The truth table — a suite's verdicts graded against the sheet's record.
 *
 * Entirely unit-tier: classification and the tally are arithmetic, and the
 * page is a pure string. The semantics under test are the ones the be100
 * campaign settled: a blocked case agrees with nothing, an unscored row is
 * never invented into a verdict, and the human's record is the ground truth.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyTruth,
  hasGroundTruth,
  renderTruthTable,
  truthRows,
  truthTally,
  type TruthOutcome,
} from '../src/reporter/truth-table.js';
import type { ProofBundle } from '../src/engine/proof-bundle.js';

const bundle = (
  status: string,
  known?: 'passed' | 'failed',
  name = 'PL_01_01 ตรวจสอบเมนู',
): ProofBundle =>
  ({
    runId: 'r1',
    name,
    status,
    polarity: 'positive',
    durationMs: 1200,
    generatedBy: {
      model: 'm',
      generatedAt: '2026-08-25T00:00:00Z',
      sourceUrl: 'http://x.test',
      kind: 'catalog',
      rationale: '',
      source: 'be100.csv',
      ...(known === undefined ? {} : { knownResult: known }),
    },
  }) as unknown as ProofBundle;

const outcome = (
  verdict: TruthOutcome['verdict'],
  b: ProofBundle | null,
  name = b?.name ?? 'case',
): TruthOutcome => ({ name, verdict, bundle: b });

describe('classifyTruth', () => {
  it('grades the four agreement quadrants', () => {
    assert.equal(classifyTruth('failed', 'failed'), 'TP');
    assert.equal(classifyTruth('passed', 'passed'), 'TN');
    assert.equal(classifyTruth('failed', 'passed'), 'FP');
    assert.equal(classifyTruth('passed', 'failed'), 'FN');
  });

  it('a blocked case agrees with nothing, and an unscored row outranks everything', () => {
    assert.equal(classifyTruth('blocked', 'passed'), 'no-verdict');
    assert.equal(classifyTruth('review', 'failed'), 'review');
    // The sheet never scored the row — no verdict can be graded against it,
    // not even a blocked one.
    assert.equal(classifyTruth('passed', null), 'unscored');
    assert.equal(classifyTruth('blocked', null), 'unscored');
  });
});

describe('truthRows', () => {
  it('reads ground truth from the bundle, and falls back to the flow stamp for a bundleless case', () => {
    const rows = truthRows(
      [
        outcome('passed', bundle('passed', 'passed')),
        // Blocked before a bundle existed — the flow's own stamp still scores it.
        outcome('blocked', null, 'PL_02_02 blocked-before-start'),
      ],
      new Map([['PL_02_02 blocked-before-start', 'failed']]),
    );
    assert.equal(rows[0]!.cls, 'TN');
    assert.equal(rows[1]!.known, 'failed');
    assert.equal(rows[1]!.cls, 'no-verdict');
  });
});

describe('truthTally', () => {
  it('accuracy, precision and recall cover verdict-delivering cases only', () => {
    const rows = truthRows([
      outcome('failed', bundle('failed', 'failed', 'tp')),
      outcome('passed', bundle('passed', 'passed', 'tn1')),
      outcome('passed', bundle('passed', 'passed', 'tn2')),
      outcome('failed', bundle('failed', 'passed', 'fp')),
      outcome('passed', bundle('passed', 'failed', 'fn')),
      outcome('blocked', bundle('error', 'passed', 'nv')),
      outcome('passed', bundle('passed', undefined, 'un')),
    ]);
    const t = truthTally(rows);
    assert.deepEqual(
      { tp: t.tp, tn: t.tn, fp: t.fp, fn: t.fn, nv: t.noVerdict, un: t.unscored },
      { tp: 1, tn: 2, fp: 1, fn: 1, nv: 1, un: 1 },
    );
    assert.equal(t.accuracy, 3 / 5);
    assert.equal(t.precision, 1 / 2);
    assert.equal(t.recall, 1 / 2);
  });

  it('with nothing scored the ratios are null, never zero — no data is not a bad score', () => {
    const t = truthTally(truthRows([outcome('blocked', null)]));
    assert.equal(t.accuracy, null);
    assert.equal(t.precision, null);
    assert.equal(t.recall, null);
  });
});

describe('renderTruthTable', () => {
  const rows = truthRows([
    outcome('failed', bundle('dead-end', 'failed', 'PL_03_08 ตรวจสอบ <จำนวน> & "totals"')),
    outcome('passed', bundle('passed', 'passed', 'PL_03_09 ok')),
  ]);
  const html = renderTruthTable({ source: 'be100.csv', ranAt: '2026-08-25T04:00:00Z' }, rows);

  it('is one self-contained page listing every case, with the raw status beside the grade', () => {
    assert.match(html, /<!doctype html>/);
    assert.match(html, /PL_03_09 ok/);
    // The dead-end that graded as failed stays visible next to its grade.
    assert.match(html, /failed <span class="mut">\(dead-end\)<\/span>/);
    assert.match(html, /TP/);
    assert.doesNotMatch(html, /<script/i);
  });

  it('escapes application text — a case name cannot become markup', () => {
    assert.match(html, /&lt;จำนวน&gt; &amp; &quot;totals&quot;/);
  });

  it('hasGroundTruth gates the page: a catalog with no recorded results writes nothing', () => {
    assert.equal(hasGroundTruth(truthRows([outcome('passed', bundle('passed'))])), false);
    assert.equal(hasGroundTruth(rows), true);
  });
});
