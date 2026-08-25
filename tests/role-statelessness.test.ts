/**
 * Every model role's context window is cleared after every call — pinned.
 *
 * Architecturally this is already how wowlidator works: each call to a role is a
 * stateless single-shot `generateStructured` (system + prompt in, one object
 * out), and no conversation transcript accumulates anywhere. What carries
 * between calls is deliberate, bounded, and NOT a context window:
 *
 * - the healer's `rejected` list — inside ONE `heal()` re-ask cycle only;
 * - the agent's action history — inside ONE `run()` only, capped at 12 lines;
 * - the author's refusal `feedback` — inside ONE `author()` cycle only;
 * - the persistent caches (healed selectors, replay memory) — data, not text.
 *
 * Each of those seams exists because removing it measurably wastes calls (the
 * healer echoing the failed selector, PB_03_01's repeated password fills), so
 * "clear everything" would be a regression — but "nothing ELSE may carry" is a
 * guarantee worth pinning, because it is what keeps every role's token bill
 * exactly the size of its own request. These tests call each role model twice
 * on one instance and assert the second prompt contains nothing unique from
 * the first.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LlmHealerModel } from '../src/healer/jit-healer.js';
import { LlmAgentModel } from '../src/orchestrator/workflow-agent.js';
import { LlmDataModel } from '../src/data/data-model.js';
import { jsonModel } from './helpers.js';

/** Every prompt the mock saw, flattened to searchable text. */
function promptTexts(model: ReturnType<typeof jsonModel>): string[] {
  return model.doGenerateCalls.map((call) => JSON.stringify(call.prompt));
}

describe('role calls are stateless', () => {
  it('a second heal carries nothing from the first — not even its rejections', async () => {
    const model = jsonModel(
      'mock-healer',
      { selector: 'role=button[name="Go" i]', strategy: 'role', confidence: 0.9, reasoning: 'r' },
      { inputTokens: 10, outputTokens: 5 },
    );
    const healer = new LlmHealerModel({ model, id: 'mock:healer' });

    await healer.suggest({
      failedSelector: 'role=button[name="FIRST-UNIQUE-MARKER" i]',
      action: 'click',
      url: 'https://one.test/',
      axTree: 'button "TREE-TOKEN-ONE"',
      rejected: ['role=button[name="REJECTED-GHOST" i] — did not resolve'],
    });
    await healer.suggest({
      failedSelector: 'role=button[name="Second" i]',
      action: 'click',
      url: 'https://two.test/',
      axTree: 'button "Second"',
    });

    const [first, second] = promptTexts(model);
    assert.ok(first!.includes('FIRST-UNIQUE-MARKER'));
    for (const residue of ['FIRST-UNIQUE-MARKER', 'TREE-TOKEN-ONE', 'REJECTED-GHOST', 'one.test']) {
      assert.ok(!second!.includes(residue), `second heal prompt leaked "${residue}"`);
    }
  });

  it('a second agent decision starts from exactly its own observation', async () => {
    const model = jsonModel(
      'mock-agent',
      { action: 'click', selector: 'role=button[name="Go" i]', value: '', url: '', reasoning: 'r', next: [] },
      { inputTokens: 10, outputTokens: 5 },
    );
    const agent = new LlmAgentModel({ model, id: 'mock:agent' });

    await agent.decide({
      goal: 'GOAL-ALPHA reach the alpha page',
      url: 'https://one.test/',
      axTree: 'button "ALPHA-CONTROL"',
      caseContext: 'Case: ALPHA_01 the alpha claim',
      history: ['click role=button[name="ALPHA-HISTORY" i] — ok'],
      stepsRemaining: 5,
    });
    await agent.decide({
      goal: 'reach the beta page',
      url: 'https://two.test/',
      axTree: 'button "Beta"',
      history: [],
      stepsRemaining: 5,
    });

    const second = promptTexts(model)[1]!;
    for (const residue of ['GOAL-ALPHA', 'ALPHA-CONTROL', 'ALPHA-HISTORY', 'ALPHA_01', 'one.test']) {
      assert.ok(!second.includes(residue), `second agent prompt leaked "${residue}"`);
    }
  });

  it('a second data value is generated with no memory of the first field', async () => {
    const model = jsonModel(
      'mock-data',
      { value: 'EMP-0099', reasoning: 'r' },
      { inputTokens: 10, outputTokens: 5 },
    );
    const data = new LlmDataModel({ model, id: 'mock:data' });

    await data.generate({
      description: 'FIRST-FIELD-MARKER employee id',
      attempt: 2,
      previousValue: 'PREV-VALUE-GHOST',
      observedError: 'CONFLICT-GHOST already exists',
    });
    await data.generate({ description: 'a SKU', attempt: 1 });

    const second = promptTexts(model)[1]!;
    for (const residue of ['FIRST-FIELD-MARKER', 'PREV-VALUE-GHOST', 'CONFLICT-GHOST']) {
      assert.ok(!second.includes(residue), `second data prompt leaked "${residue}"`);
    }
  });
});
