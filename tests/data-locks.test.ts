/**
 * Step-level data locks — the rules of `src/cli/data-locks.ts`.
 *
 * Entirely unit-tier: window computation is a pure walk over a flow, and the
 * lock is an in-memory queue. Neither needs a browser or a model, so these
 * always run — the same reasoning as `tests/sections.test.ts`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SectionLocks, dataGateFor, dataLocksEnabled, dataWindows } from '../src/cli/data-locks.js';
import type { Flow, FlowStep } from '../src/engine/runner.js';

const flowOf = (steps: FlowStep[], setup: FlowStep[] = [], teardown?: FlowStep[]): Flow =>
  ({ name: 'f', steps, setup, ...(teardown ? { teardown } : {}) }) as Flow;

const SIGN_IN: FlowStep[] = [
  { action: 'goto', url: 'http://x/en/login' } as FlowStep,
  { action: 'fill', selector: 'role=textbox[name="Work email" i]', value: 'a@b.c' } as FlowStep,
  { action: 'fill', selector: 'input[type="password"]', value: 'pw' } as FlowStep,
  { action: 'click', selector: 'role=button[name="Sign in" i]' } as FlowStep,
];

test('a sign-in is not a data change — a flow that only signs in and reads locks nothing', () => {
  const flow = flowOf(
    [{ action: 'expectVisible', selector: 'text="Benefit Plan ID"' } as FlowStep],
    [...SIGN_IN, { action: 'goto', url: 'http://x/en/admin/benefits/plans' } as FlowStep],
  );
  assert.deepEqual(dataWindows(flow), []);
  assert.equal(dataGateFor(flow, new SectionLocks()), null);
});

test('the window starts at the change and ends at the last check of it — setup stays free', () => {
  const fill = { action: 'fill', selector: 'role=textbox[name="Benefit Name" i]', value: 'X' } as FlowStep;
  const save = { action: 'click', selector: 'role=button[name="Save" i]' } as FlowStep;
  const check = { action: 'expectText', selector: 'role=cell', value: 'X' } as FlowStep;
  const after = { action: 'click', selector: 'role=button[name="Close" i]' } as FlowStep;
  const flow = flowOf(
    [fill, save, check, after],
    [...SIGN_IN, { action: 'goto', url: 'http://x/en/admin/benefits/plans' } as FlowStep],
  );
  const windows = dataWindows(flow);
  assert.equal(windows.length, 1);
  assert.equal(windows[0]!.from, fill, 'the lock is taken at the first change, not at sign-in');
  assert.equal(windows[0]!.to, check, 'and given back at the last step that needs the change to hold');
  assert.deepEqual(windows[0]!.sections, ['route:admin/benefits']);
});

test('two changes on the same page are one span, not two acquisitions', () => {
  const a = { action: 'fill', selector: 'role=textbox[name="One" i]', value: '1' } as FlowStep;
  const check1 = { action: 'expectText', selector: 'role=cell', value: '1' } as FlowStep;
  const b = { action: 'fill', selector: 'role=textbox[name="Two" i]', value: '2' } as FlowStep;
  const check2 = { action: 'expectText', selector: 'role=cell', value: '2' } as FlowStep;
  const flow = flowOf([a, check1, b, check2], [{ action: 'goto', url: 'http://x/en/admin/benefits/plans' } as FlowStep]);
  const windows = dataWindows(flow);
  assert.equal(windows.length, 1, 'one span per flow — a lane never asks for a lock while holding one');
  assert.equal(windows[0]!.from, a);
  assert.equal(windows[0]!.to, check2);
});

test('a change whose location is unknown, and a delete, take the global section', () => {
  const prose = { action: 'workflow', goal: 'Create a new benefit plan' } as FlowStep;
  const unknown = dataWindows(flowOf([prose, { action: 'expectVisible', selector: 'text="Saved"' } as FlowStep]));
  assert.deepEqual(unknown[0]!.sections, ['*']);

  const del = { action: 'workflow', goal: 'Delete the plan TH_MED_005' } as FlowStep;
  const deleting = dataWindows(
    flowOf([del, { action: 'expectHidden', selector: 'text="TH_MED_005"' } as FlowStep], [
      { action: 'goto', url: 'http://x/en/admin/benefits/plans' } as FlowStep,
    ]),
  );
  assert.ok(deleting[0]!.sections.includes('*'), 'a delete is exclusive for its window, whatever section it names');
  assert.ok(deleting[0]!.sections.includes('route:admin/benefits'));
});

test('a teardown that puts the row back is inside the window', () => {
  const fill = { action: 'fill', selector: 'role=textbox', value: 'X' } as FlowStep;
  const restore = { action: 'fill', selector: 'role=textbox', value: 'original' } as FlowStep;
  const flow = flowOf(
    [fill],
    [{ action: 'goto', url: 'http://x/en/admin/benefits/plans' } as FlowStep],
    [restore],
  );
  const windows = dataWindows(flow);
  assert.equal(windows.length, 1);
  assert.equal(windows[0]!.to, restore);
});

test('a db step names its own section, whatever page the run is on', () => {
  const write = { action: 'request', method: 'POST', url: 'http://x/api/plans' } as FlowStep;
  const check = { action: 'expectDbRow', table: 'benefit_plan', where: {} } as unknown as FlowStep;
  const windows = dataWindows(flowOf([write, check]));
  assert.ok(windows[0]!.sections.includes('table:benefit_plan'));
});

test('FK-connected tables are one section', () => {
  const write = { action: 'request', method: 'POST', url: 'http://x/api/e' } as FlowStep;
  const check = { action: 'expectDbRow', table: 'benefit_enrollment', where: {} } as unknown as FlowStep;
  const windows = dataWindows(flowOf([write, check]), [['benefit_enrollment', 'benefit_plan']]);
  // The component is named by its lexicographically-first member, so a case
  // touching either table derives the same key.
  assert.ok(windows[0]!.sections.includes('table:benefit_enrollment'));
  assert.ok(!windows[0]!.sections.includes('table:benefit_plan'));
});

test('the lock serialises the same section and lets a different one straight through', async () => {
  const locks = new SectionLocks();
  await locks.acquire(['route:a']);
  let bIn = false;
  let aIn = false;
  void locks.acquire(['route:b']).then(() => (bIn = true));
  void locks.acquire(['route:a']).then(() => (aIn = true));
  await new Promise((r) => setImmediate(r));
  assert.equal(bIn, true, 'a disjoint section never waits');
  assert.equal(aIn, false, 'the same section does');
  locks.release(['route:a']);
  await new Promise((r) => setImmediate(r));
  assert.equal(aIn, true);
});

test('the global section intersects every other, in both directions', async () => {
  const locks = new SectionLocks();
  await locks.acquire(['*']);
  let got = false;
  void locks.acquire(['route:anything']).then(() => (got = true));
  await new Promise((r) => setImmediate(r));
  assert.equal(got, false);
  locks.release(['*']);
  await new Promise((r) => setImmediate(r));
  assert.equal(got, true);
});

test('a waiter reserves its sections, so a long queue cannot starve it', async () => {
  const locks = new SectionLocks();
  await locks.acquire(['route:a']);
  const order: string[] = [];
  void locks.acquire(['route:a']).then(() => order.push('first'));
  void locks.acquire(['route:a', 'route:b']).then(() => order.push('second'));
  void locks.acquire(['route:b']).then(() => order.push('third'));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, [], 'nothing runs while route:a is held');
  locks.release(['route:a']);
  await new Promise((r) => setImmediate(r));
  // "first" is granted; "second" reserves route:b, which is why "third" waits
  // behind it instead of jumping the queue forever.
  assert.deepEqual(order, ['first']);
});

test('the gate takes and releases around the steps it names, and releaseAll frees a dead run', async () => {
  const locks = new SectionLocks();
  const fill = { action: 'fill', selector: 'role=textbox', value: 'X' } as FlowStep;
  const check = { action: 'expectText', selector: 'role=cell', value: 'X' } as FlowStep;
  const flow = flowOf([fill, check], [{ action: 'goto', url: 'http://x/en/admin/benefits/plans' } as FlowStep]);
  const gate = dataGateFor(flow, locks);
  assert.ok(gate !== null);
  await gate.before(flow.setup![0]!);
  assert.deepEqual(locks.heldSections, [], 'the goto holds nothing');
  await gate.before(fill);
  assert.deepEqual(locks.heldSections, ['route:admin/benefits']);
  gate.after(fill);
  assert.deepEqual(locks.heldSections, ['route:admin/benefits'], 'still held: the check still needs it');
  gate.after(check);
  assert.deepEqual(locks.heldSections, []);

  // A run that dies mid-window must not take the section down with it.
  await gate.before(fill);
  assert.deepEqual(locks.heldSections, ['route:admin/benefits']);
  gate.releaseAll();
  assert.deepEqual(locks.heldSections, []);
});

test('WOWLIDATOR_DATA_LOCKS=off restores case-level flagging', () => {
  assert.equal(dataLocksEnabled({}), true);
  assert.equal(dataLocksEnabled({ WOWLIDATOR_DATA_LOCKS: 'off' }), false);
  assert.equal(dataLocksEnabled({ WOWLIDATOR_DATA_LOCKS: 'on' }), true);
});
