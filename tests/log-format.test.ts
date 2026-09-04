/**
 * The live log's plain-text shape (`src/log-format.ts`) and the two renderers
 * built on it that `.claude/skills/monitor/joblog.mjs` and the panel's
 * `jobs.ts` read back: the step/agent columns and the refusal list.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatAgentAction, formatStepLine, type ProofStep } from '../src/engine/proof-bundle.js';
import { AuthoringError, formatRefusalLines } from '../src/generator/flow-author.js';
import { currentLogTag, formatElapsed, phaseHeader, withLogTag, wrapText } from '../src/log-format.js';

describe('formatElapsed', () => {
  it('picks the unit a person reads at a glance', () => {
    assert.equal(formatElapsed(850), '850ms');
    assert.equal(formatElapsed(12_340), '12.3s');
    assert.equal(formatElapsed(264_000), '4m24s');
    assert.equal(formatElapsed(65 * 60_000 + 5000), '1h05m');
    assert.equal(formatElapsed(Number.NaN), '?');
  });
});

describe('phaseHeader', () => {
  it('is one rule of a fixed width with the label near the left', () => {
    const header = phaseHeader('authoring HIR-EC-001');
    assert.match(header, /^── authoring HIR-EC-001 ─+$/);
    assert.equal(header.length, 64);
    // A label longer than the rule still gets a short tail, never a cut label.
    assert.match(phaseHeader('x'.repeat(80)), /^── x{80} ────$/);
  });
});

describe('wrapText', () => {
  it('wraps on spaces with a hanging indent and leaves long runs whole', () => {
    const lines = wrapText('  (1) one two three four five six', 16, '      ');
    assert.deepEqual(lines, ['  (1) one two', '      three four', '      five six']);
    const url = 'https://example.test/a/very/long/path/that/does/not/break';
    assert.deepEqual(wrapText(`see ${url} now`, 20, '  '), ['see', `  ${url}`, '  now']);
    assert.deepEqual(wrapText('   ', 20, '  '), []);
  });
});

describe('withLogTag', () => {
  it('follows the async context and is absent outside one', async () => {
    assert.equal(currentLogTag(), undefined);
    const seen = await withLogTag('[c2]', async () => {
      await new Promise((r) => setTimeout(r, 1));
      return currentLogTag();
    });
    assert.equal(seen, '[c2]');
    assert.equal(currentLogTag(), undefined);
    assert.equal(withLogTag(undefined, () => currentLogTag()), undefined);
  });

  it('keeps two concurrent contexts apart', async () => {
    const [a, b] = await Promise.all([
      withLogTag('[A]', async () => {
        await new Promise((r) => setTimeout(r, 2));
        return currentLogTag();
      }),
      withLogTag('[B]', async () => {
        await new Promise((r) => setTimeout(r, 1));
        return currentLogTag();
      }),
    ]);
    assert.deepEqual([a, b], ['[A]', '[B]']);
  });
});

describe('the step and agent lines', () => {
  const base: ProofStep = {
    index: 12,
    action: 'expectVisible',
    selector: 'text="Benefit Plan Catalog"',
    resolvedSelector: 'text="Benefit Plan Catalog" >> nth=0',
    resolution: 'narrow',
    status: 'passed',
    durationMs: 18,
    startedAt: '2026-09-04T00:00:00.000Z',
    url: 'https://example.test',
  };

  it('puts mark, index, action and duration in columns and the target last', () => {
    const line = formatStepLine(base).split('\n')[0]!;
    assert.equal(line, '✓ [12]  expectVisible   (narrow, 18ms)  text="Benefit Plan Catalog" >> nth=0');
    // What the panel (`STEP_LINE`) and joblog.mjs read from the front.
    assert.match(line, /^[✓✗] \[(\d+)\]/);
    assert.match(line, /^([✓✗]) \[(\d+)\]\s+(\S+)\s+\((?:\w+, )?(\d+)ms\)(?:\s+(.*))?$/);
  });

  it('names a dead end after the target and trims a target-less line', () => {
    const dead = formatStepLine({ ...base, status: 'dead-end', resolvedSelector: null, resolution: null, error: 'gone' });
    assert.match(dead, /^✗ \[12\]  expectVisible {11}\(18ms\)  text="Benefit Plan Catalog"  DEAD END$/m);
    const bare = formatStepLine({ ...base, action: 'goto', selector: null, resolvedSelector: null, resolution: null });
    assert.equal(bare, '✓ [12]  goto                    (18ms)');
  });

  it('gives an agent turn the same columns, indented under its step', () => {
    const line = formatAgentAction({
      index: 0,
      action: 'click',
      selector: 'role=tab[name="HR" i]',
      value: '',
      url: '',
      ok: true,
      durationMs: 42,
      reasoning: 'Open the HR section',
    });
    assert.equal(line, '  ✓ agent click                   (42ms)  role=tab[name="HR" i]\n          Open the HR section');
  });
});

describe('formatRefusalLines', () => {
  const name = 'HIR-EC-001 New Hire Key-in ต้นเดือน';

  it('lists one numbered problem per line, wrapped, naming the flow once', () => {
    const error = new AuthoringError('3 problems with the authored flow — fix all of them, not just the first:\n  (1) …', {
      messages: [
        `the authored flow "${name}" performs the case's script only through step 7 of 8 — it never reaches the profile check. ` +
          'The claim lives in its LAST steps, and a flow that stops early proves the setup, not the claim.',
        `the authored flow "${name}" expectVisibles on "CF-SIT-19" as if it already existed in the application.`,
        '2 step(s) you wrote were dropped before they could run — expectValue: needs a value.',
      ],
    });
    const lines = formatRefusalLines(error, name);
    assert.equal(lines[0], 'refused: 3 problems with the authored flow — fix all of them, not just the first:');
    assert.equal(lines[1], `  flow: "${name}"`);
    assert.match(lines[2]!, /^  \(1\) the flow performs the case's script/);
    assert.ok(lines.every((l) => l.length <= 100), lines.join('\n'));
    assert.ok(lines.slice(3).some((l) => /^ {6}\S/.test(l)), 'a long problem continues under its label');
    assert.ok(!lines.slice(2).some((l) => l.includes(name)), 'the name is printed once, in the flow line');
    assert.equal(lines.filter((l) => /^  \(\d+\) /.test(l)).length, 3);
  });

  it('renders a single-lint refusal the same way, without the flow line when unnamed in it', () => {
    const lines = formatRefusalLines(new AuthoringError('no assertion — the flow proves nothing'), name);
    assert.deepEqual(lines, ['refused: 1 problem with the authored flow:', '  (1) no assertion — the flow proves nothing']);
  });
});
