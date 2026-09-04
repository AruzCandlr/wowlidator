/**
 * `personasIn` — how many Chromes a case needs (one per person it signs in
 * as). Pure: it reads the flow and nothing else, so it runs always.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { foldPersonaKey, personasIn, type Flow } from '../src/engine/runner.js';

const flow = (steps: Flow['steps'], extra: Partial<Flow> = {}): Flow => ({ name: 't', steps, ...extra });

describe('personasIn', () => {
  it('is empty for a flow that never signs in by persona', () => {
    assert.deepEqual(
      personasIn(flow([{ action: 'goto', url: 'http://x/login' }, { action: 'fill', selector: 'role=textbox', value: 'a' }])),
      [],
    );
  });

  it('lists distinct people in order of first appearance, the label as first written', () => {
    const got = personasIn(
      flow([
        { action: 'signIn', as: 'EMPLOYEE_ACCOUNT' },
        { action: 'goto', url: 'http://x/leave' },
        { action: 'signIn', as: '<MANAGER_ACCOUNT>' },
        { action: 'signIn', as: 'employee' },
        { action: 'signIn', as: 'Manager' },
      ]),
    );
    assert.deepEqual(got, ['EMPLOYEE_ACCOUNT', '<MANAGER_ACCOUNT>']);
  });

  it('walks setup, when-branches and teardown', () => {
    const got = personasIn(
      flow([{ action: 'when', visible: 'role=button', then: [{ action: 'signIn', as: 'HRBP_ACCOUNT' }], else: [{ action: 'signIn', as: 'HR_ADMIN_ACCOUNT' }] }], {
        setup: [{ action: 'signIn', as: 'SPD_ADMIN' }],
        teardown: [{ action: 'signIn', as: 'spd admin' }],
      }),
    );
    assert.deepEqual(got, ['SPD_ADMIN', 'HRBP_ACCOUNT', 'HR_ADMIN_ACCOUNT']);
  });

  it('folds labels the way resolvePersona matches them', () => {
    assert.equal(foldPersonaKey('<HR_ADMIN_ACCOUNT>'), 'hradmin');
    assert.equal(foldPersonaKey('HR admin'), 'hradmin');
    assert.equal(foldPersonaKey('hr-admin'), 'hradmin');
    assert.equal(foldPersonaKey('  '), '');
  });
});
