/**
 * The session usage cap — the rule (`providers/usage-cap.ts`, pure) and the
 * panel's guard (`ui/usage-cap.ts`, against a stubbed job runner and a
 * stubbed quota). No credential, no network, no browser.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  UsageCapExceededError,
  assertUnderUsageCap,
  evaluateUsageCap,
  parseCapPercent,
  usageCapSettings,
} from '../src/providers/usage-cap.js';
import { UsageCapGuard } from '../src/ui/usage-cap.js';
import type { ClaudeQuotaSnapshot } from '../src/providers/claude-quota.js';

const snapshot = (session: number, week: number): ClaudeQuotaSnapshot => ({
  limits: [
    { kind: 'session', percent: session, severity: 'normal', resetsAt: '2026-08-27T11:40:00Z', model: null, label: 'session' },
    { kind: 'weekly_all', percent: week, severity: 'normal', resetsAt: null, model: null, label: 'week' },
  ],
  note: '',
  fetchedAt: '2026-08-27T09:00:00Z',
});

describe('usage cap settings', () => {
  it('is off by default, and reads on/percent from the env', () => {
    assert.deepEqual(usageCapSettings({}), { enabled: false, capPercent: 90 });
    assert.deepEqual(
      usageCapSettings({ WOWLIDATOR_USAGE_CAP: 'on', WOWLIDATOR_USAGE_CAP_PERCENT: '75' }),
      { enabled: true, capPercent: 75 },
    );
    // A nonsense percent falls back rather than arming a cap at 0 or 1000.
    assert.equal(usageCapSettings({ WOWLIDATOR_USAGE_CAP_PERCENT: '0' }).capPercent, 90);
  });

  it('refuses a cap outside 1–100 by name', () => {
    assert.equal(parseCapPercent('80'), 80);
    assert.throws(() => parseCapPercent('101'), /1 to 100/);
    assert.throws(() => parseCapPercent('abc'), /1 to 100/);
  });
});

describe('evaluateUsageCap', () => {
  it('regards the SESSION window only — a weekly window past the cap never trips it', () => {
    // Asked for 2026-08-28, after "week (Fable) 50% ≥ cap 50%" held every
    // run for a window no amount of waiting inside the day would reset: the
    // weekly and per-model windows are the person's own budget, and only the
    // 5-hour session window — the one this panel's spending moves — caps.
    const v = evaluateUsageCap(snapshot(24, 92), { enabled: true, capPercent: 90 });
    assert.equal(v.tripped, false);
    assert.equal(v.worst?.label, 'session');
    assert.equal(v.maxPercent, 24);
    const scoped = evaluateUsageCap(
      {
        limits: [
          { kind: 'session', percent: 10, severity: 'normal', resetsAt: null, model: null, label: 'session' },
          { kind: 'weekly_scoped', percent: 99, severity: 'warning', resetsAt: null, model: 'Fable', label: 'week (Fable)' },
        ],
        note: '',
        fetchedAt: '2026-08-28T09:00:00Z',
      },
      { enabled: true, capPercent: 50 },
    );
    assert.equal(scoped.tripped, false, 'the Fable weekly window must never trip the cap');
  });

  it('trips on the session window, and names it', () => {
    const v = evaluateUsageCap(snapshot(92, 24), { enabled: true, capPercent: 90 });
    assert.equal(v.tripped, true);
    assert.equal(v.worst?.label, 'session');
    assert.equal(v.maxPercent, 92);
  });

  it('warns when approaching, and never trips while off', () => {
    const near = evaluateUsageCap(snapshot(85, 5), { enabled: true, capPercent: 90 });
    assert.equal(near.tripped, false);
    assert.equal(near.nearing, true);
    const off = evaluateUsageCap(snapshot(99, 99), { enabled: false, capPercent: 90 });
    assert.equal(off.tripped, false);
    assert.equal(off.nearing, false);
  });

  it('a cap that cannot see never trips', () => {
    const blind = evaluateUsageCap({ limits: [], note: 'no token', fetchedAt: '' }, { enabled: true, capPercent: 1 });
    assert.equal(blind.tripped, false);
    assert.equal(blind.note, 'no token');
  });

  it('assertUnderUsageCap is a no-op while the cap is off', async () => {
    await assertUnderUsageCap({ WOWLIDATOR_USAGE_CAP: 'off' });
  });

  it('the refusal reads as a provider fact with the way out', () => {
    const v = evaluateUsageCap(snapshot(95, 5), { enabled: true, capPercent: 90 });
    const error = new UsageCapExceededError(v);
    assert.match(error.message, /the provider refused the call/);
    assert.match(error.message, /session 95% ≥ cap 90%/);
    assert.match(error.message, /WOWLIDATOR_USAGE_CAP_PERCENT/);
  });
});

describe('UsageCapGuard', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wowlidator-usage-cap-'));

  function stubJobs() {
    const stopped: string[] = [];
    const jobs = [
      { id: 'a', title: 'catalog PL_03', status: 'running' },
      { id: 'b', title: 'old run', status: 'passed' },
      { id: 'c', title: 'go login', status: 'running' },
    ];
    return {
      stopped,
      runner: {
        list: () => jobs,
        stop: (id: string) => {
          const job = jobs.find((j) => j.id === id);
          if (!job || job.status !== 'running') return false;
          job.status = 'stopped';
          stopped.push(job.title);
          return true;
        },
      },
    };
  }

  it('stops every running job once, holds, persists, and lifts on reset', async () => {
    const { runner, stopped } = stubJobs();
    let quota = snapshot(93, 5);
    const statePath = join(dir, 'trip.json');
    const guard = new UsageCapGuard(runner, {
      statePath,
      env: { WOWLIDATOR_USAGE_CAP: 'on', WOWLIDATOR_USAGE_CAP_PERCENT: '90' },
      quota: async () => quota,
    });

    const view = await guard.tick();
    assert.equal(view.tripped?.reason, 'session 93% ≥ cap 90%');
    assert.deepEqual(stopped, ['catalog PL_03', 'go login']);
    assert.equal(guard.held, true);
    assert.match(guard.holdMessage(), /usage cap reached/);
    // The hold is on disk, so a restarted panel keeps holding.
    const persisted = JSON.parse(await readFile(statePath, 'utf8')) as { reason: string };
    assert.equal(persisted.reason, 'session 93% ≥ cap 90%');

    // A second tick over the cap re-stops nothing: the hold already stands.
    await guard.tick();
    assert.equal(stopped.length, 2);

    // Reset while still over: trips straight back — the way out is the cap.
    const still = await guard.reset();
    assert.equal(still.tripped !== null, true);

    // Reset once the window has come down: the hold lifts.
    quota = snapshot(40, 5);
    const lifted = await guard.reset();
    assert.equal(lifted.tripped, null);
    assert.equal(guard.held, false);
  });

  it('a fresh guard reloads a hold left by an earlier process', async () => {
    const { runner } = stubJobs();
    const statePath = join(dir, 'reload.json');
    const first = new UsageCapGuard(runner, {
      statePath,
      env: { WOWLIDATOR_USAGE_CAP: 'on', WOWLIDATOR_USAGE_CAP_PERCENT: '50' },
      quota: async () => snapshot(60, 1),
    });
    await first.tick();
    const second = new UsageCapGuard(stubJobs().runner, { statePath, env: {}, quota: async () => snapshot(0, 0) });
    await second.load();
    assert.equal(second.held, true);
  });

  it('never stops anything while the cap is off', async () => {
    const { runner, stopped } = stubJobs();
    const guard = new UsageCapGuard(runner, {
      statePath: join(dir, 'off.json'),
      env: { WOWLIDATOR_USAGE_CAP: 'off' },
      quota: async () => snapshot(100, 100),
    });
    const view = await guard.tick();
    assert.equal(view.tripped, null);
    assert.deepEqual(stopped, []);
  });
});
