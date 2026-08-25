/**
 * proved-? (`needs-review`) — the verdict that defers to a human.
 *
 * Born from PL_02_03 (BE_Test2, 2026-08-20): an `expectModal "Create Plan"`
 * against a dialog the application titles "Create Benefit Plan". The page
 * produced the right SHAPE of thing under wording the machine cannot rule on
 * — whether that is a spec violation or an authoring paraphrase is a
 * decision, not a measurement. The run marks itself proved-?, carries the
 * exact expected-vs-actual pair on each unsure step as proof, and awaits a
 * human ruling (`ProofBundle.review`) written back beside the machine's own
 * status — never over it.
 *
 * All unit-tier: classification, the exit contract and the report are pure.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ProofBundleBuilder,
  effectiveStatus,
  isPassing,
  nearMiss,
  type ProofBundle,
} from '../src/engine/proof-bundle.js';
import { EXIT, exitCodeFor, suiteExit } from '../src/cli/exit.js';
import { LlmReviewJudge, autoReviewRuling, reviewPairs } from '../src/engine/review-judge.js';
import { jsonModel } from './helpers.js';
import { buildVerdict } from '../src/reporter/verdict.js';
import { renderReport } from '../src/reporter/html-reporter.js';
import { clearProofCache, readProofWithPath } from '../src/ui/proofs.js';

describe('nearMiss', () => {
  it('every wording mismatch is the judge\'s to rule on — near and far alike', () => {
    assert.equal(nearMiss('Create Plan', 'Create Benefit Plan'), true, 'PL_02_03, verbatim');
    assert.equal(nearMiss('Benefit Plans', 'Benefits Admin › Benefit Plan Catalog'), true);
    // Broadened 2026-08-24: a far miss defers too — the judge, not a token
    // ratio, decides (it will confidently rule these failed; the point is
    // that something able to READ both strings makes the call, which is what
    // catches a translated rendering the ratio scores at 0%).
    assert.equal(nearMiss('Create Plan', 'Home landing'), true);
    assert.equal(nearMiss('Create Plan', '(no dialog or modal visible)'), true);
    assert.equal(nearMiss('Reimbursement by HR', 'การเบิกจ่ายโดย HR'), true);
  });

  it('a number is never a near-miss — 119 against a promised 120 is the documented defect', () => {
    assert.equal(nearMiss('120', '119'), false);
    assert.equal(nearMiss(4, 3), false);
  });

  it('identical strings are not a near-miss, and empty says nothing', () => {
    assert.equal(nearMiss('Create Plan', 'Create Plan'), false);
    assert.equal(nearMiss('', 'anything'), false);
    assert.equal(nearMiss('anything', ''), false);
  });

  it('a wordless script falls back to containment', () => {
    assert.equal(nearMiss('สวัสดิการ', 'แคตตาล็อกสวัสดิการ'), true);
  });

  it('containment either way round is a near-miss — the right text in the wrong shape', () => {
    // The exact-match instrument found the asserted sentence inside a longer
    // rendering: whether that satisfies the claim is a human wording call.
    assert.equal(nearMiss('Plan ID already exists', 'Error: Plan ID already exists in the system'), true);
    // And the reverse: the authored expectation is longer than what the page
    // renders — 4/9 words used to fail this outright.
    assert.equal(
      nearMiss('Plan ID already exists. Please choose a different identifier now', 'Plan ID already exists'),
      true,
    );
    // The numeric guard still outranks everything: a missing number is a
    // defect, never a wording call — the broadened gate does not soften it.
    assert.equal(nearMiss('120 days remaining today', 'days remaining today'), false);
  });
});

const base = { startedAt: '2026-08-20T10:00:00.000Z', durationMs: 100, url: 'http://app/x' };

describe('the auto-review judge', () => {
  it('rules both ways at the 70% bar, never below it', () => {
    const yes = { satisfied: true, confidence: 0.7, reasoning: 'same message, longer rendering' };
    const ruling = autoReviewRuling(yes, 'mock:agent');
    assert.equal(ruling?.verdict, 'proved');
    assert.equal(ruling?.by, 'mock:agent');
    assert.equal(ruling?.confidence, 0.7);
    assert.equal(autoReviewRuling({ ...yes, confidence: 0.69 }, 'mock:agent'), null);
    // Since the gate widened to every wording mismatch (2026-08-24), a
    // confident "no" stamps failed — labelled as the model's, replaceable by
    // a human in the panel — because an unruled far miss would sit at
    // proved-? forever. Below the bar it still goes to the human either way.
    const no = autoReviewRuling({ ...yes, satisfied: false, confidence: 0.99 }, 'mock:agent');
    assert.equal(no?.verdict, 'failed');
    assert.equal(no?.by, 'mock:agent');
    assert.equal(autoReviewRuling({ ...yes, satisfied: false, confidence: 0.5 }, 'mock:agent'), null);
  });

  it('a ruling makes the run pass everywhere effectiveStatus is asked', () => {
    const ruling = autoReviewRuling(
      { satisfied: true, confidence: 0.9, reasoning: 'r' },
      'mock:agent',
    );
    assert.ok(ruling);
    assert.equal(effectiveStatus({ status: 'needs-review', review: ruling }), 'passed');
    assert.equal(exitCodeFor({ status: 'needs-review', review: ruling, error: undefined } as never), EXIT.ok);
  });

  it('clamps the confidence a model returns — 0-100 scales and nonsense included', async () => {
    const model = jsonModel(
      'mock-judge',
      { satisfied: 'yes', confidence: 85, reasoning: 'same fact, app-name prefix' },
      { inputTokens: 50, outputTokens: 20 },
    );
    const judge = new LlmReviewJudge({ model, id: 'mock:judge' });
    const out = await judge.judge({
      flowName: 'PL_06_10',
      caseContext: 'Case: PL_06_10 duplicate Plan ID\nExpected: Plan ID already exists',
      pairs: [{ expected: 'Plan ID already exists', actual: 'Error: Plan ID already exists in the system' }],
    });
    assert.equal(out.satisfied, true);
    assert.equal(out.confidence, 0.85, '0-100 scale clamped into 0-1');
    // The retrieved case context and the pair both reached the model.
    const prompt = JSON.stringify(model.doGenerateCalls[0]?.prompt);
    assert.match(prompt, /PL_06_10 duplicate Plan ID/);
    assert.match(prompt, /already exists in the system/);
  });

  it('reviewPairs reads the unsure steps of a finished bundle', () => {
    const bundle = bundleOf((b) => {
      b.addStep({
        action: 'expectModal', selector: null, resolvedSelector: null, resolution: null,
        status: 'failed' as const,
        detail: { expected: 'Create Plan', actual: 'Create Benefit Plan' },
        intent: 'Assert the Create Plan dialog opens',
        ...base,
      });
    });
    assert.equal(bundle.status, 'needs-review');
    const pairs = reviewPairs(bundle);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0]?.expected, 'Create Plan');
    assert.equal(pairs[0]?.intent, 'Assert the Create Plan dialog opens');
  });
});

function bundleOf(build: (b: ProofBundleBuilder) => void): ProofBundle {
  const builder = new ProofBundleBuilder({ name: 'case', cdpUrl: null, cachePath: null });
  build(builder);
  return builder.finish();
}

const passedStep = {
  action: 'expectVisible',
  selector: 'h1',
  resolvedSelector: 'h1',
  resolution: 'fast' as const,
  status: 'passed' as const,
  ...base,
};

const nearMissStep = {
  action: 'expectModal',
  selector: null,
  resolvedSelector: null,
  resolution: null,
  status: 'failed' as const,
  detail: { expected: 'Create Plan', actual: 'Create Benefit Plan' },
  error: 'open dialog ("Create Benefit Plan") does not mention "Create Plan"',
  ...base,
};

describe('the needs-review verdict', () => {
  it('a run whose only broken steps are near-miss assertion failures defers to a human', () => {
    const bundle = bundleOf((b) => {
      b.addStep(passedStep);
      b.addStep(nearMissStep);
    });
    assert.equal(bundle.status, 'needs-review');
    assert.equal(isPassing(bundle.status), false, 'proved-? is never green by itself');
    const unsure = bundle.steps.find((s) => s.unsure !== undefined);
    assert.match(unsure?.unsure ?? '', /"Create Plan"/);
    assert.match(unsure?.unsure ?? '', /"Create Benefit Plan"/);
    assert.match(unsure?.unsure ?? '', /the judge \(or a human in the panel\) decides/);
  });

  it('a far miss defers too — the judge, not a token ratio, rules it failed', () => {
    // Broadened 2026-08-24: the machine's flat fail on "Home landing" was
    // right, but the same ratio flat-failed translated renderings it could
    // not read. Every wording mismatch now defers, and the judge's confident
    // "no" is what stamps this one failed (see the auto-review tests).
    const bundle = bundleOf((b) => {
      b.addStep({ ...nearMissStep, detail: { expected: 'Create Plan', actual: 'Home landing' } });
    });
    assert.equal(bundle.status, 'needs-review');
  });

  it('a numeric mismatch never defers — 119 against a promised 120 stays failed', () => {
    const bundle = bundleOf((b) => {
      b.addStep({ ...nearMissStep, detail: { expected: '120 days', actual: '119 days remaining' } });
    });
    assert.equal(bundle.status, 'failed');
  });

  it('a dead-ended exact match over text the page HOLDS defers to a human', () => {
    // be100 PL_06_10: `text="Plan ID already exists"` exhausted the ladder
    // while the toast held that exact sentence inside a longer message. The
    // runner stamps the containment evidence (`foundInPageText`); the run is
    // then a wording question, not an absence.
    const bundle = bundleOf((b) => {
      b.addStep({
        ...nearMissStep,
        action: 'expectText',
        selector: 'text="Plan ID already exists"',
        status: 'dead-end' as const,
        detail: {
          expected: 'Plan ID already exists',
          actual: '…Error: Plan ID already exists in the system. Choose another…',
          foundInPageText: true,
        },
        error: 'could not resolve "text="Plan ID already exists"" after 5 attempt(s)',
      });
    });
    assert.equal(bundle.status, 'needs-review');
    assert.match(bundle.steps[0]?.unsure ?? '', /the judge \(or a human in the panel\) decides/);
  });

  it('a plain dead end stays a dead end — absence has nothing near about it', () => {
    const bundle = bundleOf((b) => {
      b.addStep({
        ...nearMissStep,
        action: 'expectText',
        status: 'dead-end' as const,
        detail: { expected: 'Plan ID already exists', actual: 'Plan ID already exists, roughly' },
        error: 'could not resolve',
      });
    });
    // Same near words, but no `foundInPageText` stamp: the runner never
    // proved the text is on the page, so the machine must not soften it.
    assert.equal(bundle.status, 'dead-end');
  });

  it('a numeric mismatch stays failed — 119 vs 120 is the claim the catalog exists to catch', () => {
    const bundle = bundleOf((b) => {
      b.addStep({
        ...nearMissStep,
        action: 'expectText',
        detail: { expected: '120 days', actual: '119 days remaining' },
      });
    });
    // "120 days" vs "119 days remaining": "days" overlaps but "120" does not…
    // and a half-overlap of a two-token expectation whose miss IS the number
    // must not soften. The numeric token must match for the words to count.
    assert.equal(bundle.status, 'failed');
  });

  it('an error step, a dead end, or a run fatal outranks the deferral', () => {
    const withError = bundleOf((b) => {
      b.addStep(nearMissStep);
      b.addStep({ ...passedStep, action: 'workflow', status: 'error', error: 'agent gave up' });
    });
    assert.equal(withError.status, 'error');

    const withDeadEnd = bundleOf((b) => {
      b.addStep(nearMissStep);
      b.addStep({ ...passedStep, status: 'dead-end', error: 'could not resolve' });
    });
    assert.equal(withDeadEnd.status, 'dead-end');
  });

  it('a broken step with no comparison recorded stays failed', () => {
    const bundle = bundleOf((b) => {
      b.addStep({ ...nearMissStep, detail: {} });
    });
    assert.equal(bundle.status, 'failed');
  });
});

describe('the human ruling', () => {
  const deferred = (): ProofBundle =>
    bundleOf((b) => {
      b.addStep(nearMissStep);
    });

  it('effectiveStatus: the ruling outranks the deferral, and only then', () => {
    const bundle = deferred();
    assert.equal(effectiveStatus(bundle), 'needs-review');
    assert.equal(effectiveStatus({ ...bundle, review: { verdict: 'proved', at: 'now' } }), 'passed');
    assert.equal(effectiveStatus({ ...bundle, review: { verdict: 'failed', at: 'now' } }), 'failed');
    // A ruling on a settled run changes nothing — reviews only resolve deferrals.
    assert.equal(effectiveStatus({ status: 'failed', review: { verdict: 'proved' } }), 'failed');
  });

  it('the exit contract: deferred is neither ok nor a product failure; ruled is whichever was ruled', () => {
    const bundle = deferred();
    assert.equal(exitCodeFor(bundle), EXIT.environment);
    assert.equal(exitCodeFor({ ...bundle, review: { verdict: 'proved', at: 'now' } }), EXIT.ok);
    assert.equal(exitCodeFor({ ...bundle, review: { verdict: 'failed', at: 'now' } }), EXIT.failed);
  });

  it('a suite with a review case cannot exit 0, and a real failure still outranks it', () => {
    const outcome = (verdict: 'passed' | 'failed' | 'blocked' | 'review') =>
      ({ name: 'c', verdict, bundle: null }) as never;
    assert.equal(suiteExit([outcome('passed'), outcome('review')]), EXIT.environment);
    assert.equal(suiteExit([outcome('review'), outcome('failed')]), EXIT.failed);
    assert.equal(suiteExit([outcome('passed')]), EXIT.ok);
  });

  it('readProofWithPath hands back the file, and a written ruling round-trips', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wow-review-'));
    try {
      const bundle = deferred();
      const path = join(dir, `${bundle.runId}.json`);
      await writeFile(path, JSON.stringify(bundle, null, 2), 'utf8');
      clearProofCache();
      const found = await readProofWithPath(dir, bundle.runId);
      assert.equal(found?.path, path);
      assert.equal(found?.bundle.status, 'needs-review');

      const ruled = { ...found!.bundle, review: { verdict: 'proved' as const, at: 'now' } };
      await writeFile(path, JSON.stringify(ruled, null, 2), 'utf8');
      clearProofCache();
      const again = await readProofWithPath(dir, bundle.runId);
      assert.equal(effectiveStatus(again!.bundle), 'passed');
      assert.equal(again?.bundle.status, 'needs-review', 'the machine status is never rewritten');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('what a reader sees', () => {
  const bundle = bundleOf((b) => {
    b.addStep(nearMissStep);
  });

  it('the verdict leads with PROVED-? and says a human must rule', () => {
    const verdict = buildVerdict(bundle);
    assert.equal(verdict.status, 'needs-review');
    assert.match(verdict.headline, /PROVED-\?/);
    assert.match(verdict.what, /decision, not a measurement/);
  });

  it('the report carries the unsure proof as its own callout', () => {
    const html = renderReport(bundle);
    assert.match(html, /needs-review/);
    assert.match(html, /a human must rule on this step/);
    assert.match(html, /Create Benefit Plan/);
  });
});
