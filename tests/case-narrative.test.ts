/**
 * The case narrative (`src/generator/case-narrative.ts`). Pure everywhere
 * except one test that drives the real structured path through a mock model:
 * what matters is the trust boundary in `applyNarrative` and the projection
 * that decides what the model ever sees.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { effectiveStatus, type ProofBundle, type ProofStep } from '../src/engine/proof-bundle.js';
import {
  NARRATIVE_MAX_CHARS,
  NARRATIVE_MAX_TICKETS,
  applyNarrative,
  buildNarrativePrompt,
  caseNarrativeEnabled,
  composeNarrative,
  narrativeRequest,
  needsNarrative,
  LlmCaseNarrativeModel,
  type CaseNarrativeModel,
  type NarrativeAnswer,
} from '../src/generator/case-narrative.js';
import { jsonModel } from './helpers.js';

function step(over: Partial<ProofStep> & Pick<ProofStep, 'index' | 'action'>): ProofStep {
  return {
    selector: null,
    resolvedSelector: null,
    resolution: null,
    status: 'passed',
    startedAt: '2026-09-10T00:00:00.000Z',
    durationMs: 12,
    url: 'https://app.example.com/probation',
    ...over,
  } as ProofStep;
}

type Narratable = Pick<ProofBundle, 'steps' | 'name' | 'status' | 'defects'> & Partial<Pick<ProofBundle, 'variables' | 'notes' | 'narrative'>>;

function bundle(over: Partial<Narratable> = {}): Narratable {
  return {
    name: 'PRB-EC-026',
    status: 'failed',
    defects: [{ id: 'd1', severity: 'high', category: 'functional', title: 'Due date not synced', detail: 'extend_date 2026-11-07 but page says Due in 29 days', source: 'runtime' }],
    steps: [
      step({ index: 1, action: 'goto' }),
      step({ index: 2, action: 'fill', selector: 'role=textbox[name="Password" i]', detail: { value: 'hunter2-secret' } }),
      step({
        index: 3,
        action: 'expectDbRow',
        db: {
          kind: 'row', table: 'probation_transactions', where: 'id = 69', expected: 'probation_status = PASSED', observed: 'probation_status = PENDING',
          durationMs: 40,
          statements: [{ sql: 'SELECT * FROM "probation_transactions" WHERE "id" = $1 LIMIT 25', params: ['69'], tables: ['probation_transactions'] }],
          rows: [{ id: '69', probation_status: 'PENDING' }],
          rowsMatched: 1,
        },
        status: 'failed',
        error: 'expected PASSED, observed PENDING',
      }),
    ],
    variables: { transactionId: '69', password: '[masked]' },
    notes: ['started from an empty session'],
    ...over,
  };
}

const ANSWER: NarrativeAnswer = {
  lede: 'Tested the second extension on transaction 69.',
  summary: 'Opens the probation page, signs in, and reads transaction 69 back from the database.',
  testData: 'Transaction 69.',
  expected: 'The transaction is PASSED after approval.',
  tickets: [
    { kind: 'app', title: 'PRB-EC-026 · sync the due date', detail: 'extend_date 2026-11-07 but page says Due in 29 days', owner: 'Dev', defectId: 'd1' },
    { kind: 'test', title: 'PRB-EC-026 · cover notifications', detail: 'the inbox was never opened', owner: 'Verifier', defectId: 'ghost' },
    { kind: 'app', title: 'PRB-EC-026 · invented defect', detail: 'no line shows this', owner: 'Dev', defectId: 'ghost' },
    { kind: 'app', title: 'PRB-EC-026 · another invented defect', detail: 'nor this', owner: 'Dev' },
    { kind: 'test', title: 'PRB-EC-026 · a second test-side ticket', detail: 'one is the cap', owner: 'Verifier' },
  ],
  verifierNote: 'The session started empty.',
  questions: [{ question: 'PASS or PASSED?', answer: 'PENDING was observed.', evidence: 'step 3' }],
};

describe('the switch', () => {
  it('is ON unless switched off — the page is built around it', () => {
    assert.equal(caseNarrativeEnabled({}), true);
    assert.equal(caseNarrativeEnabled({ WOWLIDATOR_CASE_NARRATIVE: 'on' }), true);
    for (const off of ['off', '0', 'false', 'no', ' OFF ']) assert.equal(caseNarrativeEnabled({ WOWLIDATOR_CASE_NARRATIVE: off }), false, off);
  });
});

describe('what the model sees', () => {
  it('is the step lines, the DB proof lines, the defects, the masked variables and the notes — and the language', () => {
    const request = narrativeRequest(bundle(), 'ต่อทดลองงาน 2 รอบ', 'th');
    const prompt = buildNarrativePrompt(request);
    assert.match(prompt, /^LANGUAGE: write every field in Thai/);
    assert.match(prompt, /CASE: PRB-EC-026/);
    assert.match(prompt, /STATUS: failed/);
    assert.match(prompt, /ต่อทดลองงาน 2 รอบ/);
    assert.match(prompt, /\[3\]\s+expectDbRow/);
    assert.match(prompt, /query: SELECT \* FROM "probation_transactions" WHERE "id" = \$1 LIMIT 25/);
    assert.match(prompt, /parameters: \$1 = 69/);
    assert.match(prompt, /- d1 \[functional, high\] Due date not synced/);
    assert.match(prompt, /- transactionId = 69/);
    assert.match(prompt, /- password = \[masked\]/);
    assert.match(prompt, /- started from an empty session/);
  });

  it('never carries a typed credential: the fill value is not on the step line the model is given', () => {
    const prompt = buildNarrativePrompt(narrativeRequest(bundle(), 'x', 'en'));
    assert.doesNotMatch(prompt, /hunter2-secret/);
  });

  it('shows the first 120 step lines and says how many there were', () => {
    const steps = Array.from({ length: 121 }, (_, i) => step({ index: i + 1, action: 'click' }));
    const prompt = buildNarrativePrompt(narrativeRequest(bundle({ steps }), 'x', 'en'));
    assert.match(prompt, /STEPS \(121, first 120 shown\):/);
    assert.doesNotMatch(prompt, /\[121\]/);
  });

  it('leaves out superseded attempts', () => {
    const b = bundle({ steps: [step({ index: 1, action: 'click', superseded: true }), step({ index: 1, action: 'click' })] });
    assert.equal(narrativeRequest(b, 'x', 'en').stepLines.length, 1);
  });
});

describe('applyNarrative — the trust boundary', () => {
  it('writes an attributed narrative; an app ticket must restate a recorded defect, a test ticket may not, and one test ticket is the cap', () => {
    const b = bundle();
    assert.equal(applyNarrative(b, ANSWER, 'mock:narrator', 'en', '2026-09-10T01:00:00.000Z'), true);
    assert.equal(b.narrative?.by, 'mock:narrator');
    assert.equal(b.narrative?.lang, 'en');
    assert.equal(b.narrative?.at, '2026-09-10T01:00:00.000Z');
    assert.deepEqual(
      b.narrative?.tickets.map((t) => [t.kind, t.title, t.defectId]),
      [
        ['app', 'PRB-EC-026 · sync the due date', 'd1'],
        ['test', 'PRB-EC-026 · cover notifications', undefined],
      ],
    );
    assert.equal(b.narrative?.questions[0]?.evidence, 'step 3');
  });

  it('a narrative moves no verdict: the effective status is the same with and without it', () => {
    const b = bundle();
    const before = effectiveStatus(b as ProofBundle);
    applyNarrative(b, ANSWER, 'm', 'en');
    assert.equal(effectiveStatus(b as ProofBundle), before);
  });

  it('clips every field and caps the lists', () => {
    const b = bundle();
    const long = 'x'.repeat(NARRATIVE_MAX_CHARS * 2);
    b.defects = Array.from({ length: NARRATIVE_MAX_TICKETS + 3 }, (_, i) => ({ ...b.defects[0]!, id: `d${i}` }));
    const tickets = Array.from({ length: NARRATIVE_MAX_TICKETS + 3 }, (_, i) => ({ kind: 'app' as const, title: `t${i}`, detail: long, owner: 'Dev', defectId: `d${i}` }));
    applyNarrative(b, { ...ANSWER, lede: long, tickets }, 'm', 'en');
    assert.equal(b.narrative?.lede.length, NARRATIVE_MAX_CHARS);
    assert.equal(b.narrative?.tickets.length, NARRATIVE_MAX_TICKETS);
    assert.equal(b.narrative?.tickets[0]?.detail.length, NARRATIVE_MAX_CHARS);
  });

  it('an empty answer leaves the bundle exactly as it was', () => {
    const b = bundle();
    const empty: NarrativeAnswer = { lede: '', summary: '', testData: '', expected: '', tickets: [], verifierNote: '', questions: [] };
    assert.equal(applyNarrative(b, empty, 'm', 'en'), false);
    assert.equal(b.narrative, undefined);
  });

  it('a narrative is needed when there is none, or when the language changed', () => {
    const b = bundle();
    assert.equal(needsNarrative(b, 'en'), true);
    applyNarrative(b, ANSWER, 'm', 'en');
    assert.equal(needsNarrative(b, 'en'), false);
    assert.equal(needsNarrative(b, 'th'), true);
  });
});

describe('composeNarrative', () => {
  it('drives the structured path through a mock model, in one call, and lands the narrative', async () => {
    const model = new LlmCaseNarrativeModel({ model: jsonModel('mock', ANSWER, { inputTokens: 900, outputTokens: 300 }), id: 'mock:narrator' });
    const b = bundle();
    assert.equal(await composeNarrative(b, 'Extend twice, then pass', { model, lang: 'en' }), true);
    assert.equal(b.narrative?.summary, ANSWER.summary);
    assert.equal(b.narrative?.by, 'mock:narrator');
  });

  it('is a no-op on a bundle already narrated in that language — a rebuild costs nothing twice', async () => {
    const model: CaseNarrativeModel = { id: 'never', compose: async () => assert.fail('should not have been called') };
    const b = bundle();
    applyNarrative(b, ANSWER, 'm', 'en');
    assert.equal(await composeNarrative(b, 'x', { model, lang: 'en' }), false);
  });

  it('leaves the bundle as it was when the model fails, and says so', async () => {
    const logged: string[] = [];
    const model: CaseNarrativeModel = { id: 'broken', compose: async () => { throw new Error('429 rate limited\nretry later'); } };
    const b = bundle();
    assert.equal(await composeNarrative(b, 'x', { model, lang: 'en', log: (l) => logged.push(l) }), false);
    assert.equal(b.narrative, undefined);
    assert.match(logged.join('\n'), /narrative skipped for PRB-EC-026: 429 rate limited/);
  });
});
