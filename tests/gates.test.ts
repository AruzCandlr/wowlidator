/**
 * The machinery gates (`src/ui/gates.ts`) — unit-tier: describe/persist are
 * file-and-env functions, run here against a temp `.env` and a fake env
 * object so nothing leaks into the real process.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  DIALS,
  GATES,
  SELECTS,
  describeDials,
  describeGates,
  describeSelects,
  persistDial,
  persistGate,
  persistSelect,
} from '../src/ui/gates.js';

let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wowlidator-gates-'));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('describeGates', () => {
  it('every gate defaults ON when its var is absent, and reads off/0/false/no as off', () => {
    const views = describeGates({});
    assert.equal(views.length, GATES.length);
    assert.ok(views.every((v) => v.on), 'absent = the default, and every gate here defaults on');
    for (const raw of ['off', '0', 'false', 'no']) {
      const v = describeGates({ WOWLIDATOR_SECTIONS: raw }).find((g) => g.env === 'WOWLIDATOR_SECTIONS');
      assert.equal(v?.on, false, raw);
    }
    const on = describeGates({ WOWLIDATOR_SECTIONS: 'on' }).find((g) => g.env === 'WOWLIDATOR_SECTIONS');
    assert.equal(on?.on, true);
  });

  it('the scenario gate is in the list — the reason the card exists', () => {
    assert.ok(GATES.some((g) => g.env === 'WOWLIDATOR_SCENARIO_GATE'));
  });
});

describe('persistGate', () => {
  it('writes .env AND the given env, so the next spawned job inherits it', async () => {
    const envPath = join(dir, '.env');
    const env: NodeJS.ProcessEnv = {};
    const view = await persistGate('WOWLIDATOR_SCENARIO_GATE', false, envPath, env);
    assert.equal(view.on, false);
    assert.equal(env['WOWLIDATOR_SCENARIO_GATE'], 'off');
    assert.match(await readFile(envPath, 'utf8'), /^WOWLIDATOR_SCENARIO_GATE=off$/m);
    // Flip back on: the same line is edited, not appended twice.
    await persistGate('WOWLIDATOR_SCENARIO_GATE', true, envPath, env);
    const text = await readFile(envPath, 'utf8');
    assert.equal((text.match(/WOWLIDATOR_SCENARIO_GATE=/g) ?? []).length, 1);
    assert.match(text, /^WOWLIDATOR_SCENARIO_GATE=on$/m);
    assert.equal(env['WOWLIDATOR_SCENARIO_GATE'], 'on');
  });

  it('refuses a var outside the allowlist by name — the endpoint cannot write arbitrary env', async () => {
    await assert.rejects(
      () => persistGate('PATH', false, join(dir, '.env'), {}),
      /"PATH" is not a machinery gate/,
    );
  });
});

describe('the dials — numeric machinery settings', () => {
  it('reads the env value within range, else the default', () => {
    const views = describeDials({});
    assert.equal(views.length, DIALS.length);
    assert.equal(views.find((d) => d.env === 'WOWLIDATOR_AUTHOR_CONCURRENCY')?.value, 3);
    assert.equal(
      describeDials({ WOWLIDATOR_AUTHOR_CONCURRENCY: '5' }).find((d) => d.env === 'WOWLIDATOR_AUTHOR_CONCURRENCY')?.value,
      5,
    );
    assert.equal(
      describeDials({ WOWLIDATOR_AUTHOR_CONCURRENCY: '99' }).find((d) => d.env === 'WOWLIDATOR_AUTHOR_CONCURRENCY')?.value,
      3,
      'out of range falls back',
    );
  });

  it('persists a valid value, refuses out-of-range and unknown vars by name', async () => {
    const envPath = join(dir, '.env-dial');
    const env: NodeJS.ProcessEnv = {};
    const view = await persistDial('WOWLIDATOR_AUTHOR_ATTEMPTS', 1, envPath, env);
    assert.equal(view.value, 1);
    assert.equal(env['WOWLIDATOR_AUTHOR_ATTEMPTS'], '1');
    assert.match(await readFile(envPath, 'utf8'), /^WOWLIDATOR_AUTHOR_ATTEMPTS=1$/m);
    await assert.rejects(() => persistDial('WOWLIDATOR_AUTHOR_ATTEMPTS', 9, envPath, env), /1 to 5/);
    await assert.rejects(() => persistDial('PATH', 3, envPath, env), /not a machinery dial/);
  });
});

describe('the selects — reasoning effort per role', () => {
  it('reads a known effort, else the role default (generator high, the rest low)', () => {
    const views = describeSelects({});
    assert.equal(views.length, SELECTS.length);
    assert.equal(views.find((s) => s.env === 'WOWLIDATOR_GENERATOR_EFFORT')?.value, 'high');
    assert.equal(views.find((s) => s.env === 'WOWLIDATOR_HEALER_EFFORT')?.value, 'low');
    assert.equal(
      describeSelects({ WOWLIDATOR_GENERATOR_EFFORT: 'medium' }).find((s) => s.env === 'WOWLIDATOR_GENERATOR_EFFORT')
        ?.value,
      'medium',
    );
    assert.equal(
      describeSelects({ WOWLIDATOR_GENERATOR_EFFORT: 'turbo' }).find((s) => s.env === 'WOWLIDATOR_GENERATOR_EFFORT')
        ?.value,
      'high',
      'an unknown value falls back to the default',
    );
  });

  it('every role that resolves an --effort has a select', () => {
    for (const env of [
      'WOWLIDATOR_GENERATOR_EFFORT',
      'WOWLIDATOR_HEALER_EFFORT',
      'WOWLIDATOR_AGENT_EFFORT',
      'WOWLIDATOR_DATA_EFFORT',
      'WOWLIDATOR_GOVERNOR_EFFORT',
    ]) {
      assert.ok(SELECTS.some((s) => s.env === env), env);
    }
  });

  it('persists a valid effort, refuses an unknown value and an unknown var by name', async () => {
    const envPath = join(dir, '.env-select');
    const env: NodeJS.ProcessEnv = {};
    const view = await persistSelect('WOWLIDATOR_GENERATOR_EFFORT', 'medium', envPath, env);
    assert.equal(view.value, 'medium');
    assert.equal(env['WOWLIDATOR_GENERATOR_EFFORT'], 'medium');
    assert.match(await readFile(envPath, 'utf8'), /^WOWLIDATOR_GENERATOR_EFFORT=medium$/m);
    // Same line edited, not appended twice.
    await persistSelect('WOWLIDATOR_GENERATOR_EFFORT', 'low', envPath, env);
    const text = await readFile(envPath, 'utf8');
    assert.equal((text.match(/WOWLIDATOR_GENERATOR_EFFORT=/g) ?? []).length, 1);
    assert.match(text, /^WOWLIDATOR_GENERATOR_EFFORT=low$/m);
    await assert.rejects(
      () => persistSelect('WOWLIDATOR_GENERATOR_EFFORT', 'turbo', envPath, env),
      /must be one of low, medium, high/,
    );
    await assert.rejects(() => persistSelect('PATH', 'low', envPath, env), /not a machinery select/);
  });
});
