/**
 * The vacuous-flow rule: a flow whose only assertions are the sign-in proof
 * and a URL proves nothing about its claim. Pure — the predicate, the drop
 * reasons the author now reports, and the ledger's re-run marking.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { FlowStep } from '../src/engine/runner.js';
import { dropReasonFor } from '../src/generator/flow-author.js';
import { isLoginProof, substantiveAssertions, vacuousClaim, vacuousFlow } from '../src/generator/vacuous.js';
import { markVacuous, newLedger, recordOutcome, remaining } from '../src/cli/suite-progress.js';

const LOGIN: FlowStep[] = [
  { action: 'goto', url: '/en/login' },
  { action: 'fill', selector: 'role=textbox[name="Work email" i]', value: 'a@b.c' },
  { action: 'click', selector: 'role=button[name="Next" i]' },
  { action: 'fill', selector: 'input[type="password"]', value: 'x' },
  { action: 'click', selector: 'role=button[name="Sign in" i]' },
  { action: 'expectHidden', selector: 'role=button[name="Sign in" i]' },
];

describe('vacuousClaim', () => {
  it("names be100's shape: sign-in proof + expectUrl is no claim at all", () => {
    const steps: FlowStep[] = [...LOGIN, { action: 'goto', url: '/en/admin/benefits/plans' }, { action: 'expectUrl', value: '/en/admin/benefits/plans' }];
    assert.equal(isLoginProof(LOGIN[5]!), true);
    assert.deepEqual(substantiveAssertions(steps), []);
    assert.match(vacuousClaim(steps) ?? '', /only assertions are the sign-in proof and expectUrl/);
    // With a workflow leg in between it is still vacuous — the leg's own report is not an assertion.
    assert.ok(vacuousClaim([...steps, { action: 'workflow', goal: 'open the filter' }, { action: 'expectUrl', value: '/x' }]) !== null);
  });

  it('is satisfied by one assertion about the page, including inside a when branch', () => {
    const real: FlowStep[] = [...LOGIN, { action: 'expectText', selector: 'role=dialog', value: 'Create Benefit Plan' }];
    assert.equal(vacuousClaim(real), null);
    const branched: FlowStep[] = [...LOGIN, { action: 'when', visible: 'text=x', then: [{ action: 'expectVisible', selector: 'role=option[name="Active" i]' }] }];
    assert.equal(vacuousClaim(branched), null);
    // An expectHidden that is NOT the login control is a claim (a leaked token must not show).
    assert.equal(vacuousClaim([...LOGIN, { action: 'expectHidden', selector: 'text="pending"' }]), null);
  });

  it('reports a flow with no assertion at all, and reads setup + steps together', () => {
    assert.match(vacuousClaim(LOGIN.slice(0, 5)) ?? '', /no assertion/);
    assert.equal(vacuousFlow({ setup: LOGIN, steps: [{ action: 'expectVisible', selector: 'role=heading[name="Rules" i]' }] }), null);
    assert.ok(vacuousFlow({ setup: LOGIN, steps: [{ action: 'expectUrl', value: '/x' }] }) !== null);
  });
});

describe('dropReasonFor', () => {
  const raw = (over: Record<string, unknown>) => ({
    action: 'click', selector: '', value: '', url: '', key: '', name: '', intent: '', case: null, ...over,
  }) as never;
  it('says what was missing, in words the re-ask can act on', () => {
    assert.match(dropReasonFor(raw({ action: 'click' }), true), /names no selector/);
    assert.match(dropReasonFor(raw({ action: 'click', selector: '/* not found */' }), true), /comment, not a selector/);
    assert.match(dropReasonFor(raw({ action: 'expectText', selector: 'role=cell' }), true), /needs a value/);
    assert.match(dropReasonFor(raw({ action: 'expectDbRow', name: 't', key: 'a = 1' }), false), /indexed schema/);
    assert.match(dropReasonFor(raw({ action: 'hover', selector: 'role=link[name="x"]' }), true), /not an action this harness has/);
    assert.match(dropReasonFor(raw({ action: 'goto' }), true), /needs a url/);
  });
});

describe('the ledger re-runs vacuous passes', () => {
  it('marks recorded passes whose flow proves nothing, and remaining() includes them', async () => {
    const ledger = newLedger('t', ['A_1', 'A_2', 'A_3']);
    recordOutcome(ledger, { name: 'A_1 x', verdict: 'passed', bundle: null }, { flowPath: '/flows/a1.json' });
    recordOutcome(ledger, { name: 'A_2 y', verdict: 'passed', bundle: null }, { flowPath: '/flows/a2.json' });
    recordOutcome(ledger, { name: 'A_3 z', verdict: 'failed', bundle: null }, { flowPath: '/flows/a3.json' });
    assert.deepEqual(remaining(ledger), []);
    const marked = await markVacuous(ledger, async (path) => (path.endsWith('a2.json') ? 'only the sign-in proof' : null));
    assert.deepEqual(marked, ['A_2']);
    assert.equal(ledger.outcomes['A_2']?.verdict, 'blocked');
    assert.match(ledger.outcomes['A_2']?.reason ?? '', /^vacuous:/);
    assert.deepEqual(remaining(ledger), ['A_2']);
  });
});
