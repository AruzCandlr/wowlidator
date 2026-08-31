/**
 * Post-run system-error diagnosis (`src/generator/error-diagnosis.ts`) —
 * entirely unit-tier. The signals are pure over a proof bundle; the model is a
 * `MockLanguageModelV4` through the same `generateStructured` path every role
 * uses. The fixture mirrors the live case that forced the feature: PL_07's
 * agent stalling over a plan id the application never had.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ProofBundle, ProofStep } from '../src/engine/proof-bundle.js';
import {
  LlmDiagnosisModel,
  buildDiagnosisPrompt,
  describeDiagnosis,
  diagnoseError,
  diagnosisEnabled,
  diagnosisSignals,
  erroredSteps,
  type DiagnosisRequest,
} from '../src/generator/error-diagnosis.js';
import { jsonModel } from './helpers.js';

function step(overrides: Partial<ProofStep>): ProofStep {
  return {
    index: 1, action: 'click', intent: undefined, selector: null, resolvedSelector: null,
    resolution: null, status: 'passed', startedAt: '2026-08-28T04:00:00.000Z', durationMs: 100, url: 'http://localhost:3000/en/admin/benefits/plans',
    ...overrides,
  } as ProofStep;
}

/** PL_07's shape: a workflow stall hunting a seeded plan that does not exist. */
function bundle(overrides: Partial<ProofBundle> = {}): ProofBundle {
  return {
    runId: 'r1', name: 'PL_07_01 ตรวจสอบการกดปุ่ม Make Correction', status: 'error',
    startedAt: '2026-08-28T04:00:00.000Z', finishedAt: '2026-08-28T04:10:00.000Z', durationMs: 600_000,
    cdpUrl: null, cachePath: null, healerModel: null,
    summary: { totalSteps: 3, passed: 1, failed: 2 } as ProofBundle['summary'],
    defects: [],
    error: 'run completed with 1 error: workflow — agent stalled: nothing advanced in 5 consecutive turns',
    steps: [
      step({ index: 1, action: 'goto', status: 'passed' }),
      step({
        index: 2, action: 'workflow', status: 'error',
        error: 'agent stalled: nothing advanced in 5 consecutive turns (last failure: no element matches "role=cell[name="PL_07_01_02_03_04_05_06" i]" (waited 1500 ms))',
        agent: {
          goal: "locate the row for Benefit Plan ID 'PL_07_01_02_03_04_05_06' and click Make Correction",
          model: 'mock', success: false, summary: 'agent stalled: nothing advanced in 5 consecutive turns',
          turns: 5, maxSteps: null, latencyMs: 90_000,
          actions: [
            { index: 1, action: 'scroll', selector: 'text=PL_07_01_02_03_04_05_06', value: null, url: 'x', reasoning: 'find the row', ok: false, error: 'no element matches "text=PL_07_01_02_03_04_05_06" (waited 1500 ms)', durationMs: 1600 },
            { index: 2, action: 'click', selector: null, value: null, url: 'x', reasoning: 'open rows per page', ok: false, error: 'no element matches "role=combobox[name="Rows per page" i]" (waited 1500 ms)', durationMs: 1600 },
          ],
        },
      } as Partial<ProofStep>),
      step({ index: 3, action: 'expectModal', status: 'failed', error: 'no dialog or modal is currently visible' }),
    ],
    ...overrides,
  } as ProofBundle;
}

function request(overrides: Partial<DiagnosisRequest> = {}): DiagnosisRequest {
  return {
    caseName: 'PL_07_01 Make Correction',
    caseText: 'Steps: hover the Make Correction pencil icon in the plans table; Expected: tooltip "Make Correction"',
    bundle: bundle(),
    declaredRoutes: ['/:locale/admin/benefits/plans'],
    ...overrides,
  };
}

describe('the switch and the gate', () => {
  it('is on unless WOWLIDATOR_DIAGNOSE=off', () => {
    assert.equal(diagnosisEnabled({}), true);
    assert.equal(diagnosisEnabled({ WOWLIDATOR_DIAGNOSE: 'off' }), false);
  });

  it('only a system error is diagnosed — a test-failure is a verdict, not a mystery', async () => {
    const model = new LlmDiagnosisModel({ model: jsonModel('m', { origin: 'agent', confidence: 90, reasoning: 'x', fix: '', actionable: false }, { inputTokens: 1, outputTokens: 1 }) });
    for (const status of ['failed', 'dead-end', 'passed', 'needs-review'] as const) {
      assert.equal(await diagnoseError(request({ bundle: bundle({ status }) }), { model }), null, status);
    }
  });
});

describe('the signals', () => {
  it('recognises the PL_07 signature: a stalled agent hunting values no evidence mentions', () => {
    const signals = diagnosisSignals(request());
    assert.ok(signals.some((s) => s.includes('1 workflow step(s) stalled')), signals.join('\n'));
    assert.ok(
      signals.some((s) => s.includes('"PL_07_01_02_03_04_05_06"') && s.includes('NO evidence') && s.includes('may name data the application does not have')),
      signals.join('\n'),
    );
  });

  it('reads the opposite when the hunted controls ARE in the evidence — an agent failure', () => {
    const signals = diagnosisSignals(request({
      caseText: 'The plans table has a Rows per page control and the row PL_07_01_02_03_04_05_06 seeded by the fixture.',
    }));
    assert.ok(signals.some((s) => s.includes('a navigation failure, not missing data')), signals.join('\n'));
  });

  it('points at the environment when the run error names the provider', () => {
    const signals = diagnosisSignals(request({ bundle: bundle({ error: 'the provider refused the call: rate limit' }) }));
    assert.ok(signals.some((s) => s.includes('points at environment')));
  });

  it('marks a cascaded assertion error as a cascade, not its own fault', () => {
    const b = bundle();
    (b.steps[2] as { status: string }).status = 'error';
    const signals = diagnosisSignals(request({ bundle: b }));
    assert.ok(signals.some((s) => s.includes('step 3') && s.includes('cascade')), signals.join('\n'));
  });

  it('erroredSteps skips superseded steps and non-errors', () => {
    const b = bundle();
    assert.deepEqual(erroredSteps(b).map((s) => s.index), [2]);
  });
});

describe('the prompt and the record', () => {
  it('carries the errored step, the agent trail, the downstream failures and the routes', () => {
    const req = request();
    const prompt = buildDiagnosisPrompt(req, diagnosisSignals(req));
    assert.match(prompt, /CASE: PL_07_01 Make Correction/);
    assert.match(prompt, /- step 2 workflow/);
    assert.match(prompt, /agent goal: locate the row for Benefit Plan ID/);
    assert.match(prompt, /last actions: ✗ scroll text=PL_07_01_02_03_04_05_06/);
    assert.match(prompt, /ALSO \(test-failures downstream — likely cascades\):\n- step 3 expectModal/);
    assert.match(prompt, /DECLARED PAGE ROUTES \(1\)/);
  });

  it('turns the model answer into the record, and the note names origin, confidence and fix', async () => {
    const model = new LlmDiagnosisModel({
      model: jsonModel('m', {
        origin: 'test-catalog', confidence: 85,
        reasoning: 'The plan id the agent hunted appears in no evidence; every later step cascades from never finding the row.',
        fix: "Seed benefit plan PL_07_01_02_03_04_05_06 ('QA-Make correction') before the PL_07 scenario, or point the sheet's Test Data at a plan that exists.",
        actionable: true,
      }, { inputTokens: 700, outputTokens: 60 }),
      id: 'mock:diagnosis',
    });
    const diagnosis = await diagnoseError(request(), { model });
    assert.ok(diagnosis);
    assert.equal(diagnosis.origin, 'test-catalog');
    assert.equal(diagnosis.confidence, 0.85);
    assert.equal(diagnosis.actionable, true);
    assert.ok(diagnosis.signals.length >= 2, 'the computed signals ride on the record');
    assert.equal(diagnosis.model, 'mock:diagnosis');
    const line = describeDiagnosis(diagnosis);
    assert.match(line, /^system error diagnosed: the test catalog \(the case or its data\) \(85%\) — /);
    assert.match(line, /fix: Seed benefit plan PL_07_01_02_03_04_05_06/);
  });

  it('keeps the honest empty: no fix is null, and the note says so', async () => {
    const model = new LlmDiagnosisModel({ model: jsonModel('m', { origin: 'environment', confidence: 60, reasoning: 'x', fix: '', actionable: true }, { inputTokens: 1, outputTokens: 1 }) });
    const diagnosis = await diagnoseError(request(), { model });
    assert.equal(diagnosis?.fix, null);
    assert.equal(diagnosis?.actionable, false, 'a fix that is empty cannot be actionable');
    assert.match(describeDiagnosis(diagnosis!), /\(no fix available\)$/);
  });

  it('never throws — a judge that fails leaves the run reporting its error plainly, logged once', async () => {
    const lines: string[] = [];
    const diagnosis = await diagnoseError(request(), {
      model: { id: 'broken', diagnose: async () => { throw new Error('breaker open\nmore'); } },
      log: (line) => lines.push(line),
    });
    assert.equal(diagnosis, null);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /error diagnosis skipped for PL_07_01 .*breaker open — the run reports its error plainly/);
  });
});
