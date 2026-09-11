/**
 * The per-step narrator. Pure everywhere except one test that drives the real
 * `generateObject` path through a mock model — the whole point of the module is
 * that a model's prose can be put beside evidence without being able to change
 * it, so most of what is worth asserting is the trust boundary in
 * `applyNarration` and the projection that decides what the model ever sees.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ProofBundle, ProofStep } from '../src/engine/proof-bundle.js';
import {
  NARRATION_SOFT_CHARS,
  keepShorterNarrations,
  narrationsOverSoftCap,
  shortenStepAsk,
  NARRATION_MAX_CHARS,
  applyNarration,
  buildNarrationPrompt,
  chunk,
  narratableSteps,
  narrateBundle,
  narrationEnabled,
  unnarrated,
  LlmNarrationModel,
  type NarrationModel,
} from '../src/generator/step-narration.js';
import { jsonModel } from './helpers.js';

function step(over: Partial<ProofStep> & Pick<ProofStep, 'index' | 'action'>): ProofStep {
  return {
    selector: null,
    resolvedSelector: null,
    resolution: null,
    status: 'passed',
    startedAt: '2026-09-07T00:00:00.000Z',
    durationMs: 12,
    url: 'https://app.example.com/plans',
    ...over,
  } as ProofStep;
}

function bundle(steps: ProofStep[]): Pick<ProofBundle, 'steps' | 'name'> {
  return { name: 'PL_06_07', steps };
}

const THREE = [
  step({ index: 1, action: 'goto', url: 'https://app.example.com/plans' }),
  step({ index: 2, action: 'click', selector: 'role=button[name="Save" i]', resolvedSelector: 'role=button[name="Save" i]', resolution: 'fast' }),
  step({ index: 3, action: 'selectOption', selector: 'role=combobox[name="Condition" i]', status: 'dead-end', error: 'could not be found\nafter 3 rungs' }),
];

describe('the switch', () => {
  it('is OFF unless asked for — the inverse of every other post-run judge', () => {
    assert.equal(narrationEnabled({}), false);
    assert.equal(narrationEnabled({ WOWLIDATOR_NARRATE: '' }), false);
    assert.equal(narrationEnabled({ WOWLIDATOR_NARRATE: 'off' }), false);
    // A typo must not silently enable a per-case model call.
    assert.equal(narrationEnabled({ WOWLIDATOR_NARRATE: 'yes please' }), false);
    for (const on of ['on', 'ON', '1', 'true', 'yes']) {
      assert.equal(narrationEnabled({ WOWLIDATOR_NARRATE: on }), true, on);
    }
  });
});

describe('what the model is shown', () => {
  it('narrates every step, and only ever the step\'s own report line', () => {
    const projected = narratableSteps(bundle(THREE));
    assert.deepEqual(projected.map((s) => s.index), [1, 2, 3]);
    assert.deepEqual(projected.map((s) => s.status), ['passed', 'passed', 'dead-end']);
    // The line is `formatStepLine`'s, verbatim: the same text the run log
    // prints. That is what makes a narration unable to contradict the report.
    assert.match(projected[2]!.line, /\[3\]/);
    assert.match(projected[2]!.line, /selectOption/);
    assert.match(projected[2]!.line, /DEAD END/);
  });

  it('excludes a superseded attempt — what was tried is not what happened', () => {
    const steps = [step({ index: 1, action: 'click', status: 'failed', superseded: true }), step({ index: 2, action: 'click' })];
    assert.deepEqual(narratableSteps(bundle(steps)).map((s) => s.index), [2]);
  });

  it('never puts an account in the prompt', () => {
    const signIn = step({ index: 1, action: 'signIn', detail: { as: 'MANAGER=manager@example.com:hunter2', password: 'hunter2' } });
    const prompt = buildNarrationPrompt({ caseName: 'PL_06_07', caseText: 'sign in as a manager', steps: narratableSteps(bundle([signIn])) });
    assert.doesNotMatch(prompt, /hunter2/);
    assert.doesNotMatch(prompt, /manager@example\.com/);
    assert.match(prompt, /withheld from the report/);
  });

  it('asks for every step by index, and carries the case the run was proving', () => {
    const prompt = buildNarrationPrompt({ caseName: 'PL_06_07', caseText: 'Create a benefit plan with a condition', steps: narratableSteps(bundle(THREE)) });
    assert.match(prompt, /CASE: PL_06_07/);
    assert.match(prompt, /Create a benefit plan with a condition/);
    for (const i of [1, 2, 3]) assert.match(prompt, new RegExp(`--- step ${i} `));
  });
});

describe('applyNarration — the trust boundary', () => {
  it('lands a sentence, attributed to the model that wrote it', () => {
    const steps = THREE.map((s) => ({ ...s }));
    const landed = applyNarration(bundle(steps), [{ index: 2, text: '  Clicked the Save button, and it worked.  ' }], 'groq:llama', '2026-09-07T10:00:00.000Z');
    assert.equal(landed, 1);
    assert.deepEqual(steps[1]!.narration, { text: 'Clicked the Save button, and it worked.', by: 'groq:llama', at: '2026-09-07T10:00:00.000Z' });
    // Untouched steps stay exactly as they were.
    assert.equal(steps[0]!.narration, undefined);
  });

  it('drops an index the run never had, rather than inventing a step', () => {
    const steps = THREE.map((s) => ({ ...s }));
    assert.equal(applyNarration(bundle(steps), [{ index: 99, text: 'A step that does not exist.' }], 'm'), 0);
    assert.equal(steps.some((s) => s.narration !== undefined), false);
  });

  it('will not narrate a superseded attempt even when the model answers for it', () => {
    const steps = [step({ index: 1, action: 'click', status: 'failed', superseded: true }), step({ index: 2, action: 'click' })];
    assert.equal(applyNarration(bundle(steps), [{ index: 1, text: 'x' }, { index: 2, text: 'y' }], 'm'), 1);
    assert.equal(steps[0]!.narration, undefined);
    assert.equal(steps[1]!.narration?.text, 'y');
  });

  it('leaves a step alone on an empty answer, and never overwrites one already written', () => {
    const steps = [step({ index: 1, action: 'click' }), step({ index: 2, action: 'click', narration: { text: 'first', by: 'a', at: 'z' } })];
    assert.equal(applyNarration(bundle(steps), [{ index: 1, text: '   ' }, { index: 2, text: 'second' }], 'm'), 0);
    assert.equal(steps[0]!.narration, undefined);
    assert.equal(steps[1]!.narration?.text, 'first');
  });

  it('clips an essay — a narration longer than a summary is not one', () => {
    const steps = [step({ index: 1, action: 'click' })];
    applyNarration(bundle(steps), [{ index: 1, text: 'x'.repeat(NARRATION_MAX_CHARS * 2) }], 'm');
    assert.equal(steps[0]!.narration!.text.length, NARRATION_MAX_CHARS);
    assert.ok(steps[0]!.narration!.text.endsWith('…'));
  });
});

describe('unnarrated and chunking', () => {
  it('is what a rebuild pass has left to do', () => {
    const steps = THREE.map((s) => ({ ...s }));
    steps[1]!.narration = { text: 'done', by: 'm', at: 'z' };
    assert.deepEqual(unnarrated(bundle(steps)).map((s) => s.index), [1, 3]);
  });

  it('splits a long case into calls rather than one unanswerable prompt', () => {
    assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    assert.deepEqual(chunk([], 2), []);
  });
});

describe('narrateBundle', () => {
  it('narrates a whole case through the real generateObject path', async () => {
    const model = new LlmNarrationModel({
      model: jsonModel('mock:narrator', {
        steps: [
          { index: 1, text: 'Opened the benefit plans page.' },
          { index: 2, text: 'Clicked Save; the button responded.' },
          { index: 3, text: 'Looked for the Condition dropdown and never found it, so the step could not run.' },
        ],
      }, { inputTokens: 400, outputTokens: 80 }),
      id: 'mock:narrator',
    });
    const steps = THREE.map((s) => ({ ...s }));
    assert.equal(await narrateBundle(bundle(steps), 'Create a benefit plan', { model }), 3);
    assert.equal(steps[0]!.narration!.text, 'Opened the benefit plans page.');
    assert.equal(steps[2]!.narration!.by, 'mock:narrator');
  });

  it('is a no-op on a bundle already narrated — a rebuild costs nothing twice', async () => {
    const model: NarrationModel = { id: 'never', narrate: async () => assert.fail('should not have been called') };
    const steps = THREE.map((s) => ({ ...s, narration: { text: 'done', by: 'm', at: 'z' } }));
    assert.equal(await narrateBundle(bundle(steps), 'x', { model }), 0);
  });

  it('leaves the steps reading as they always did when the model fails', async () => {
    const logged: string[] = [];
    const model: NarrationModel = { id: 'broken', narrate: async () => { throw new Error('429 rate limited\nretry later'); } };
    const steps = THREE.map((s) => ({ ...s }));
    // Never throws: a narration that cannot be written is a report exactly as
    // good as the one before this feature existed.
    assert.equal(await narrateBundle(bundle(steps), 'x', { model, log: (l) => logged.push(l) }), 0);
    assert.equal(steps.some((s) => s.narration !== undefined), false);
    assert.match(logged.join('\n'), /narration skipped for 3 step\(s\) of PL_06_07: 429 rate limited/);
  });

  it('keeps the batches it did get when a later one fails', async () => {
    let call = 0;
    const model: NarrationModel = {
      id: 'flaky',
      narrate: async (request) => {
        call += 1;
        if (call === 2) throw new Error('provider refused');
        return request.steps.map((s) => ({ index: s.index, text: `step ${s.index} ran.` }));
      },
    };
    const steps = THREE.map((s) => ({ ...s }));
    assert.equal(await narrateBundle(bundle(steps), 'x', { model, batch: 2 }), 2);
    assert.equal(steps[0]!.narration?.text, 'step 1 ran.');
    assert.equal(steps[2]!.narration, undefined);
  });
});

describe('a step verdict is held to the same budget', () => {
  const n = (index: number, text: string) => ({ index, text });

  it('finds only the steps over the soft cap', () => {
    const over = narrationsOverSoftCap([n(1, 'x'.repeat(NARRATION_SOFT_CHARS)), n(2, 'y'.repeat(NARRATION_SOFT_CHARS + 1))]);
    assert.deepEqual(over, [2]);
  });

  it('the re-ask names the step indexes and both numbers', () => {
    const ask = shortenStepAsk([3, 7]);
    assert.match(ask, /Steps 3, 7/);
    assert.match(ask, new RegExp(String(NARRATION_SOFT_CHARS)));
    assert.match(ask, new RegExp(String(NARRATION_MAX_CHARS)));
  });

  it('keeps the shorter reading per step and leaves unanswered steps alone', () => {
    const first = [n(1, 'x'.repeat(300)), n(2, 'kept as written')];
    const kept = keepShorterNarrations(first, [n(1, 'much shorter')]);
    assert.equal(kept[0]?.text, 'much shorter');
    assert.equal(kept[1]?.text, 'kept as written');
  });

  it('a longer or empty re-ask changes nothing', () => {
    const first = [n(1, 'x'.repeat(220))];
    assert.equal(keepShorterNarrations(first, [n(1, 'y'.repeat(900))])[0]?.text.length, 220);
    assert.equal(keepShorterNarrations(first, [n(1, '  ')])[0]?.text.length, 220);
  });
});
