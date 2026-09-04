/**
 * The retrieval seam (`src/context/retriever.ts`) and what the model-role
 * prompts do with it: the healer's ranked tree, the agent's cache-aligned
 * turn prompt, the case card the runtime roles read. Entirely unit-tier —
 * ranking is arithmetic and prompt assembly is string building.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  Bm25Retriever,
  buildRetriever,
  focusTreeText,
} from '../src/context/retriever.js';
import {
  HEAL_TREE_MAX_LINES,
  buildUserPrompt as healPrompt,
} from '../src/healer/jit-healer.js';
import { buildUserPrompt as agentPrompt } from '../src/orchestrator/workflow-agent.js';
import { caseCard, expectedLacksAnchors, sheetGate } from '../src/cli/commands/authoring.js';

describe('Bm25Retriever', () => {
  const items = [
    { id: 'a', text: 'button "Create Plan"' },
    { id: 'b', text: 'link "Home"' },
    { id: 'c', text: 'button "Create Benefit Plan" dialog' },
  ];

  it('ranks by relevance and respects the limit', async () => {
    const out = await new Bm25Retriever().rank('create benefit plan', items, 2);
    assert.equal(out.length, 2);
    assert.equal(out[0]!.id, 'c');
  });

  it('is deterministic for identical inputs', async () => {
    const retriever = new Bm25Retriever();
    const first = await retriever.rank('plan', items, 3);
    const second = await retriever.rank('plan', items, 3);
    assert.deepEqual(first, second);
  });

  it('is the default, and an unknown retriever fails at the boundary', () => {
    assert.equal(buildRetriever(undefined).id, 'bm25');
    assert.equal(buildRetriever('bm25').id, 'bm25');
    assert.throws(() => buildRetriever('vectors-i-invented'), /WOWLIDATOR_RETRIEVER/);
  });
});

describe('focusTreeText', () => {
  const line = (n: number): string => `button "Control number ${n}"`;
  const bigTree = [
    ...Array.from({ length: 40 }, (_, i) => line(i)),
    'button "Create Benefit Plan"',
    ...Array.from({ length: 40 }, (_, i) => line(40 + i)),
  ].join('\n');

  it('does nothing under the budget — narrowing evidence that fits only loses', () => {
    const small = 'button "A"\nbutton "B"';
    assert.equal(focusTreeText(small, 'anything', 10).text, small);
  });

  it('keeps the queried line, restores document order, and discloses the cut', () => {
    const { text, kept, total } = focusTreeText(bigTree, 'Create Benefit Plan', 20);
    assert.ok(text.includes('button "Create Benefit Plan"'));
    assert.equal(kept, 20);
    assert.equal(total, 81);
    assert.match(text, /TREE NARROWED: showing 20 of 81/);
    // Absence must prove nothing — the wording is part of the contract.
    assert.match(text, /never conclude an element is absent/);
    // Document order: the kept numbered lines still ascend.
    const numbers = [...text.matchAll(/Control number (\d+)/g)].map((m) => Number(m[1]));
    assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b));
  });

  it('always keeps the head lines — a journey tree label is evidence', () => {
    const labelled = `ANOTHER PAGE IN THIS JOURNEY — /en/x:\n${bigTree}`;
    const { text } = focusTreeText(labelled, 'zzz nothing matches', 5, 1);
    assert.ok(text.startsWith('ANOTHER PAGE IN THIS JOURNEY — /en/x:'));
  });
});

describe('the healer prompt', () => {
  const treeOf = (lines: number, needle: string): string =>
    [...Array.from({ length: lines }, (_, i) => `button "Filler ${i}"`), needle].join('\n');

  it('ranks the tree against the failed selector and intent, disclosed', () => {
    const prompt = healPrompt({
      failedSelector: 'role=button[name="Create Leave Request" i]',
      intent: 'Open the leave request form',
      action: 'click',
      url: 'http://x/',
      axTree: treeOf(200, 'link "Leave request Apply for leave"'),
    });
    assert.ok(prompt.includes('link "Leave request Apply for leave"'), 'the answer survives the cut');
    assert.match(prompt, /TREE NARROWED: showing \d+ of 201/);
  });

  it('leaves a tree under the cap whole', () => {
    const tree = treeOf(HEAL_TREE_MAX_LINES - 2, 'button "Target"');
    const prompt = healPrompt({
      failedSelector: 'role=button[name="Target" i]',
      action: 'click',
      url: 'http://x/',
      axTree: tree,
    });
    assert.ok(prompt.includes(tree));
    assert.ok(!prompt.includes('TREE NARROWED'));
  });

  it('carries the test case as context, not as the thing to repair', () => {
    const prompt = healPrompt({
      failedSelector: 'role=button[name="X" i]',
      action: 'click',
      url: 'http://x/',
      axTree: 'button "X"',
      caseContext: 'Case: PL_06_10 duplicate Plan ID\nExpected: Plan ID already exists',
    });
    assert.match(prompt, /test case this step serves \(context, not the thing to repair\)/);
    assert.ok(prompt.includes('PL_06_10'));
  });
});

describe('the agent turn prompt', () => {
  const observation = {
    goal: 'Open the Create Plan modal',
    url: 'http://x/plans',
    axTree: 'button "Create Plan"',
    history: ['click role=button[name="Menu" i] — ok, still at http://x/plans'],
    stepsRemaining: 5,
  };

  it('orders stable-first: goal, card, tree — then the per-turn parts', () => {
    const prompt = agentPrompt({ ...observation, caseContext: 'Case: PL_06_01 create a plan' });
    const at = (needle: string): number => {
      const index = prompt.indexOf(needle);
      assert.ok(index >= 0, `${needle} missing`);
      return index;
    };
    // The tree is the dominant repeated bytes; everything that changes every
    // turn (URL, history) must come AFTER it, or a provider's implicit prompt
    // cache never covers it.
    assert.ok(at('GOAL:') < at('THE TEST CASE THIS STEP SERVES'));
    assert.ok(at('THE TEST CASE') < at('Accessibility tree:'));
    assert.ok(at('Accessibility tree:') < at('Current URL:'));
    assert.ok(at('Current URL:') < at('What you have tried:'));
  });

  it('keeps feedback last, after every byte the re-ask shares', () => {
    const prompt = agentPrompt({ ...observation, feedback: 'that selector is not in the tree' });
    assert.ok(prompt.trimEnd().endsWith('that selector is not in the tree'));
  });

  it('never shows the turn budget', () => {
    const prompt = agentPrompt(observation);
    assert.ok(!/remaining/i.test(prompt));
  });
});

describe('caseCard', () => {
  it('folds the sheet row into a bounded card, note included', () => {
    const card = caseCard({
      no: '1', scenarioId: 'PL_04', scenario: 'Filters', caseId: 'PL_04_11',
      polarity: 'Positive', priority: 'Low',
      testCase: 'ตรวจสอบ Filter Effective date: Month',
      persona: 'admin', preconditions: '', testData: 'N/A'.repeat(1),
      menu: 'HR > Benefits', steps: '1. เข้าสู่เมนู',
      expected: 'x'.repeat(1000),
      actual: 'Cancelled', testDate: '', testBy: '', bugTicket: '',
      note: 'HRIS confirmed removed',
    });
    assert.ok(card !== undefined);
    assert.ok(card.includes('PL_04_11'));
    assert.ok(card.includes('Note: HRIS confirmed removed'));
    // Bounded: the 1000-char expected output is cut, the card stays compact.
    assert.ok(card.length < 900, `card is ${card.length} chars`);
  });

  it('returns nothing for an empty row — no card beats an empty card', () => {
    const empty = {
      no: '', scenarioId: '', scenario: '', caseId: '', polarity: '', priority: '',
      testCase: '', persona: '', preconditions: '', testData: '', menu: '',
      steps: '', expected: '', actual: '', testDate: '', testBy: '', bugTicket: '', note: '',
    };
    assert.equal(caseCard(empty), undefined);
  });
});

describe('expectedLacksAnchors — is the sheet contextual enough to assert?', () => {
  it('an expected with a number, an = pair, or a quoted span is contextual', () => {
    assert.equal(expectedLacksAnchors('6.1 +1 in Total Plans', '', ''), false);
    assert.equal(expectedLacksAnchors('shows the default', 'Status = Active', ''), false);
    assert.equal(expectedLacksAnchors('shows "Pending" badge', '', ''), false);
  });

  it('vague across all three columns trips it — the author would have to invent', () => {
    assert.equal(expectedLacksAnchors('displays correctly', 'confirmed', 'N/A'), true);
  });

  it('an empty expected is another lint\'s problem, never vague here', () => {
    assert.equal(expectedLacksAnchors('', 'no values anywhere', ''), false);
  });
});

describe('sheetGate (S7 — the Note/Actual columns are a gate)', () => {
  const row = (actual: string, note: string) => ({ actual, note, caseId: 'X', testCase: '', expected: '', testData: '', persona: '', steps: '', menu: '', preconditions: '', no: '', scenarioId: '', scenario: '', polarity: '', priority: '', testDate: '', testBy: '', bugTicket: '' }) as never;
  it('refuses a Cancelled row before any model is asked', () => {
    assert.match(sheetGate(row('Cancelled', '')) ?? '', /Cancelled/);
    assert.match(sheetGate(row('', "P'Eng 6 Jul// Start Date filter cancelled")) ?? '', /cancelled/);
  });
  it('authors Passed / TBC / Failed rows (the feature exists), and a re-tested row despite an old cancel note', () => {
    assert.equal(sheetGate(row('Passed', 'TBC wording Plan ID')), null);
    assert.equal(sheetGate(row('Failed', '14-Aug Failed Company error')), null);
    assert.equal(sheetGate(row('Re-Test Passed', 'was cancelled, then reinstated')), null);
  });
  it('the card carries a requirement-change note as its own line, ahead of the persona', () => {
    const card = caseCard({ ...(row('Passed', '4-Aug New req. update pop-up to page') as object), caseId: 'PL_06_01', testCase: 'Create plan', expected: '2.1 dialog opens' } as never) ?? '';
    assert.match(card, /Requirement note .*pop-up to page/);
  });

  it('gates a row whose Note says the case cannot be run yet (CNS-EC-028)', () => {
    const note =
      'ผลตรวจหน้าจอจริงบนระบบทดสอบ SIT วันที่ 31 ส.ค. 2026\n' +
      '- ระบบทดสอบยังไม่มีหน้าจอทะเบียนหนังสือให้ความยินยอมฝั่งผู้ดูแล\n' +
      '- เคสกลุ่มนี้จึงยังรันไม่ได้จนกว่าทีมพัฒนาจะส่งมอบหน้าจอทะเบียน ให้บันทึกผลเป็นยังทดสอบไม่ได้';
    const why = sheetGate(row('', note));
    assert.match(why ?? '', /cannot be run yet/);
    assert.match(why ?? '', /ยังรันไม่ได้/);
    // An ordinary note is not a gate.
    assert.equal(sheetGate(row('', 'ตัดจากเคส E2E-01 ไฟล์ HR_SIT_E2E_V.0.1 (28).xlsx')), null);
  });
});
