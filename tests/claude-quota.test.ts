import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  claudeQuotaEnabled,
  formatClaudeQuota,
  parseClaudeQuotaPayload,
  resetClaudeQuotaCache,
  setClaudeQuotaFetcher,
} from '../src/providers/claude-quota.js';

/**
 * The shape the OAuth usage endpoint actually answered on this machine,
 * 2026-08-27, cut to the fields the parser reads. A reader tested only
 * against its own writer proves nothing — this is the recorded wire shape.
 */
const RECORDED_PAYLOAD = {
  five_hour: { utilization: 6.0, resets_at: '2026-08-27T11:00:00.374020+00:00' },
  seven_day: { utilization: 2.0, resets_at: '2026-09-03T06:00:00.374039+00:00' },
  limits: [
    {
      kind: 'session',
      group: 'session',
      percent: 6,
      severity: 'normal',
      resets_at: '2026-08-27T11:00:00.374020+00:00',
      scope: null,
      is_active: true,
    },
    {
      kind: 'weekly_all',
      group: 'weekly',
      percent: 2,
      severity: 'normal',
      resets_at: '2026-09-03T06:00:00.374039+00:00',
      scope: null,
      is_active: false,
    },
    {
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 1,
      severity: 'normal',
      resets_at: '2026-09-03T06:00:00.374223+00:00',
      scope: { model: { id: null, display_name: 'Fable' }, surface: null },
      is_active: false,
    },
  ],
};

afterEach(() => {
  setClaudeQuotaFetcher(null);
  resetClaudeQuotaCache();
});

describe('parseClaudeQuotaPayload', () => {
  it('reads the limits rows, including the one scoped to a model type', () => {
    const limits = parseClaudeQuotaPayload(RECORDED_PAYLOAD);
    assert.equal(limits.length, 3);
    assert.deepEqual(
      limits.map((l) => l.label),
      ['session', 'week', 'week (Fable)'],
    );
    assert.equal(limits[0]?.percent, 6);
    assert.equal(limits[2]?.model, 'Fable');
    assert.equal(limits[2]?.resetsAt, '2026-09-03T06:00:00.374223+00:00');
  });

  it('skips malformed rows rather than inventing numbers', () => {
    const limits = parseClaudeQuotaPayload({
      limits: [{ kind: 'session' }, { percent: 4 }, null, 'x', RECORDED_PAYLOAD.limits[1]],
    });
    assert.equal(limits.length, 1);
    assert.equal(limits[0]?.kind, 'weekly_all');
  });

  it('answers empty for a payload with no limits at all', () => {
    assert.deepEqual(parseClaudeQuotaPayload({}), []);
    assert.deepEqual(parseClaudeQuotaPayload(null), []);
  });
});

describe('formatClaudeQuota', () => {
  it('is one line, per window, with the severity named only when abnormal', () => {
    const line = formatClaudeQuota({
      limits: parseClaudeQuotaPayload(RECORDED_PAYLOAD),
      note: '',
      fetchedAt: '2026-08-27T00:00:00Z',
    });
    assert.equal(line, 'session 6% · week 2% · week (Fable) 1%');
  });

  it('names an elevated severity', () => {
    const limits = parseClaudeQuotaPayload({
      limits: [{ kind: 'session', percent: 97, severity: 'warning', resets_at: null, scope: null }],
    });
    assert.equal(
      formatClaudeQuota({ limits, note: '', fetchedAt: '' }),
      'session 97% (warning)',
    );
  });

  it('falls back to the note when nothing is available', () => {
    assert.equal(
      formatClaudeQuota({ limits: [], note: 'no credential', fetchedAt: '' }),
      'no credential',
    );
  });
});

describe('claudeQuotaEnabled', () => {
  it('is on by default and off only when said so', () => {
    assert.equal(claudeQuotaEnabled({} as NodeJS.ProcessEnv), true);
    assert.equal(claudeQuotaEnabled({ WOWLIDATOR_CLAUDE_QUOTA: 'off' } as NodeJS.ProcessEnv), false);
    assert.equal(claudeQuotaEnabled({ WOWLIDATOR_CLAUDE_QUOTA: '0' } as NodeJS.ProcessEnv), false);
    assert.equal(claudeQuotaEnabled({ WOWLIDATOR_CLAUDE_QUOTA: 'on' } as NodeJS.ProcessEnv), true);
  });
});
