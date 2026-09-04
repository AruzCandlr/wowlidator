import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { chmodSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  claudeCliUsage,
  claudeCliUsageSince,
  createClaudeCli,
  formatToolArg,
  flattenPrompt,
  withoutSchemaKeyword,
} from '../src/providers/claude-cli.js';
import {
  askWarm,
  closeClaudeSessions,
  sessionKeyOf,
  sessionTurnBudget,
  AUTHORING_TURNS_PER_SESSION,
  MAX_TURNS_PER_SESSION,
  type SessionKey,
} from '../src/providers/claude-cli-session.js';
import {
  answerErrorOf,
  answerTextOf,
  modelOutputCeilingOf,
  outputCapOf,
  raisedOutputCap,
  usageOf,
  type ClaudeResultEvent,
} from '../src/providers/claude-envelope.js';
import { extractStructuredJson } from '../src/providers/model-output.js';

describe('claude-cli helper functions', () => {
  it('formatToolArg formats strings, arrays, and empties', () => {
    assert.equal(formatToolArg(undefined), null);
    assert.equal(formatToolArg(null), null);
    assert.equal(formatToolArg(''), '');
    assert.equal(formatToolArg('Bash,Edit'), 'Bash,Edit');
    assert.equal(formatToolArg([]), '');
    assert.equal(formatToolArg(['Bash', 'Edit', 'Read']), 'Bash,Edit,Read');
  });

  it('flattenPrompt separates system and user turns', () => {
    const { system, text } = flattenPrompt([
      { role: 'system', content: 'You are a tester' },
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] },
      { role: 'user', content: [{ type: 'text', text: 'Do step' }] },
    ]);
    assert.equal(system, 'You are a tester');
    assert.match(text, /Hello/);
    assert.match(text, /Assistant: Hi/);
    assert.match(text, /Do step/);
  });

  it('withoutSchemaKeyword removes $schema from objects', () => {
    assert.deepEqual(withoutSchemaKeyword({ $schema: 'http://json-schema.org/draft-07/schema#', type: 'object' }), {
      type: 'object',
    });
    assert.equal(withoutSchemaKeyword(null), null);
    assert.deepEqual(withoutSchemaKeyword([1, 2]), [1, 2]);
  });
});

describe('claude-cli session key hashing', () => {
  const baseKey: SessionKey = {
    binary: 'claude',
    cwd: '/tmp',
    modelId: 'sonnet',
    effort: 'low',
    system: 'system',
    schema: null,
  };

  it('produces different hash when effort differs', () => {
    const keyLow = sessionKeyOf({ ...baseKey, effort: 'low' });
    const keyHigh = sessionKeyOf({ ...baseKey, effort: 'high' });
    assert.notEqual(keyLow, keyHigh);
  });

  it('produces different hash when tools or allowedTools differ', () => {
    const keyNoTools = sessionKeyOf({ ...baseKey });
    const keyWithTools = sessionKeyOf({ ...baseKey, tools: 'Bash,Read' });
    const keyWithAllowed = sessionKeyOf({ ...baseKey, allowedTools: 'Bash(git *)' });
    const keyWithDisallowed = sessionKeyOf({ ...baseKey, disallowedTools: 'Edit' });

    assert.notEqual(keyNoTools, keyWithTools);
    assert.notEqual(keyNoTools, keyWithAllowed);
    assert.notEqual(keyNoTools, keyWithDisallowed);
    assert.notEqual(keyWithTools, keyWithAllowed);
  });
});

describe('createClaudeCli construction', () => {
  it('creates a model with expected provider and modelId', () => {
    const model = createClaudeCli({
      modelId: 'sonnet',
      effort: 'medium',
      tools: ['Bash', 'Read'],
      allowedTools: 'Bash(git *)',
      disallowedTools: 'Edit',
    });

    assert.equal(model.provider, 'claude-cli');
    assert.equal(model.modelId, 'sonnet');
    assert.equal(model.specificationVersion, 'v4');
  });
});

describe('warm session accounting and pooling', () => {
  // A fake `claude` speaking just enough stream-json for the session class:
  // each user line gets a `result` event with CUMULATIVE total_cost_usd and
  // num_turns (the real CLI's measured behaviour, 2026-08-27) and per-call
  // usage. FAKE_CLAUDE_DELAY_MS holds an answer open so two askWarm calls
  // can be made to overlap.
  const dir = mkdtempSync(join(tmpdir(), 'wowlidator-fake-claude-'));
  const binary = join(dir, 'fake-claude.cjs');
  writeFileSync(
    binary,
    `#!/usr/bin/env node
let turn = 0;
const delay = Number(process.env.FAKE_CLAUDE_DELAY_MS || 0);
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim() === '') return;
  turn += 1;
  const mine = turn;
  setTimeout(() => {
    process.stdout.write(JSON.stringify({
      type: 'result', result: 'answer ' + mine,
      total_cost_usd: mine * 0.001, num_turns: mine,
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }) + '\\n');
  }, delay);
});
`,
    'utf8',
  );
  chmodSync(binary, 0o755);

  const key: SessionKey = {
    binary,
    cwd: dir,
    modelId: 'sonnet',
    effort: 'low',
    system: 'test',
    schema: null,
  };

  after(() => closeClaudeSessions());

  it('reports each call\'s OWN cost and turns, not the session\'s running total', async () => {
    const first = await askWarm(key, 'q1');
    const second = await askWarm(key, 'q2');
    // The fake reports cumulative 0.001 then 0.002 — the answers must carry
    // the deltas, or a 10-turn session's ledger over-reports ~5x.
    assert.ok(Math.abs(first.costUsd - 0.001) < 1e-9, `first cost ${first.costUsd}`);
    assert.ok(Math.abs(second.costUsd - 0.001) < 1e-9, `second cost ${second.costUsd}`);
    assert.equal(first.turns, 1);
    assert.equal(second.turns, 1);
    assert.equal(second.text, 'answer 2', 'same warm process answered both');
  });

  it('two concurrent asks on one key both complete — a busy session is never killed', async () => {
    closeClaudeSessions();
    process.env['FAKE_CLAUDE_DELAY_MS'] = '250';
    try {
      const [a, b] = await Promise.all([askWarm(key, 'q1'), askWarm(key, 'q2')]);
      // Before the pool, the second ask CLOSED the busy session — the first
      // caller got "the claude session exited" and fell back to a cold
      // one-shot re-paying the whole prompt (measured live: 217 s).
      assert.equal(a.text, 'answer 1');
      assert.equal(b.text, 'answer 1', 'answered by its own pooled process, first turn');
    } finally {
      delete process.env['FAKE_CLAUDE_DELAY_MS'];
    }
  });
});

describe('per-role spend attribution', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wowlidator-fake-claude-role-'));
  const binary = join(dir, 'fake-claude.cjs');
  writeFileSync(
    binary,
    `#!/usr/bin/env node
require('node:readline').createInterface({ input: process.stdin }).on('line', () => {
  process.stdout.write(JSON.stringify({
    type: 'result', result: 'ok', total_cost_usd: 0.002, num_turns: 1,
    usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  }) + '\\n');
});
`,
    'utf8',
  );
  chmodSync(binary, 0o755);
  after(() => closeClaudeSessions());

  it('books a call under the role that asked, and the delta view drops silent roles', async () => {
    process.env['WOWLIDATOR_CLAUDE_CLI_USAGE'] = 'off'; // keep the real ledger clean
    try {
      const before = claudeCliUsage();
      const model = createClaudeCli({ modelId: 'sonnet', effort: 'low', binary, role: 'healer' });
      await model.doGenerate({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }],
      } as Parameters<typeof model.doGenerate>[0]);
      const spent = claudeCliUsageSince(before);
      assert.equal(spent.byRole['healer']?.calls, 1);
      assert.ok((spent.byRole['healer']?.costUsd ?? 0) > 0);
      // A role that asked nothing in the slice says nothing about it.
      assert.equal('generator' in spent.byRole, false);
    } finally {
      delete process.env['WOWLIDATOR_CLAUDE_CLI_USAGE'];
    }
  });
});

describe('extractStructuredJson (packaging repair for schema answers)', () => {
  // The selector value carries a brace and quotes INSIDE a JSON string — the
  // shape a naive depth counter or regex would cut short.
  const object = JSON.stringify({
    steps: [{ action: 'click', selector: 'role=button[name="A {b}" i]' }],
  });

  it('returns already-valid JSON verbatim', () => {
    assert.equal(extractStructuredJson(object), object);
    assert.equal(extractStructuredJson('  ' + object + '  '), object);
  });

  it('unwraps a markdown fence (the PL_02_02 fable shape)', () => {
    const fenced = 'Here is the flow:\n```json\n' + object + '\n```\nDone.';
    assert.equal(extractStructuredJson(fenced), object);
    const bare = '```\n' + object + '\n```';
    assert.equal(extractStructuredJson(bare), object);
  });

  it('takes the first balanced object out of surrounding prose, string-aware', () => {
    // The selector contains a brace inside a quoted string — a naive
    // depth counter would cut the object short there.
    const prose = 'Sure! ' + object + ' — let me know if you need changes.';
    assert.equal(extractStructuredJson(prose), object);
  });

  it('leaves non-JSON and malformed answers unchanged — content is never repaired', () => {
    assert.equal(extractStructuredJson('no json here at all'), 'no json here at all');
    const broken = 'prefix {"a": [1, 2';
    assert.equal(extractStructuredJson(broken), broken);
    assert.equal(extractStructuredJson(''), '');
  });
});

/**
 * The per-role session turn budget (P1, 2026-08-31). Pure policy over the
 * environment, so it is unit-tier — whether a real process actually recycles
 * is the shell/lifecycle tier's business.
 */
describe('sessionTurnBudget', () => {
  it('gives the generator one turn and everyone else the old bound', () => {
    // Authoring rows are independent questions: carrying nine earlier rows'
    // prompts is pure cost. A healer conversation about one page is not.
    assert.equal(sessionTurnBudget('generator', {}), AUTHORING_TURNS_PER_SESSION);
    assert.equal(sessionTurnBudget('generator', {}), 1);
    assert.equal(sessionTurnBudget('healer', {}), MAX_TURNS_PER_SESSION);
    assert.equal(sessionTurnBudget('agent', {}), MAX_TURNS_PER_SESSION);
    assert.equal(sessionTurnBudget(undefined, {}), MAX_TURNS_PER_SESSION);
  });

  it('a per-role dial beats the global one, which beats the default', () => {
    assert.equal(sessionTurnBudget('generator', { WOWLIDATOR_SESSION_TURNS: '4' }), 4);
    assert.equal(
      sessionTurnBudget('generator', {
        WOWLIDATOR_SESSION_TURNS: '4',
        WOWLIDATOR_GENERATOR_SESSION_TURNS: '2',
      }),
      2,
    );
    assert.equal(sessionTurnBudget('healer', { WOWLIDATOR_SESSION_TURNS: '4' }), 4);
  });

  it('refuses a value that would re-create the bloat it exists to bound', () => {
    for (const bad of ['0', '-1', '41', 'lots', '', '2.5']) {
      assert.equal(
        sessionTurnBudget('generator', { WOWLIDATOR_GENERATOR_SESSION_TURNS: bad }),
        AUTHORING_TURNS_PER_SESSION,
        `"${bad}" should fall back to the default`,
      );
    }
  });
});

/**
 * The CLI's own output cap (2026-09-04, measured on CLI 2.1.260 with
 * CLAUDE_CODE_MAX_OUTPUT_TOKENS=40): the result event is `is_error: true`,
 * `terminal_reason: "api_error"`, no `stop_reason`, and the whole answer is
 * the sentence naming the cap. The model's ceiling rides in `modelUsage`.
 */
describe('claude-envelope: reading the result event', () => {
  const cut: ClaudeResultEvent = {
    is_error: true,
    result:
      "API Error: Claude's response exceeded the 32000 output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.",
    total_cost_usd: 0.005,
    num_turns: 1,
    usage: { input_tokens: 4386, output_tokens: 160, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: { 'claude-opus-5': { maxOutputTokens: 64000 } },
  };

  it('reads the cap and the model ceiling off the event', () => {
    assert.equal(outputCapOf(cut), 32000);
    assert.equal(modelOutputCeilingOf(cut), 64000);
    assert.equal(outputCapOf({ is_error: false, result: '{"a":1}' }), null);
    assert.equal(outputCapOf({ is_error: true, result: 'API Error: 429 rate limited' }), null);
  });

  it('prefers the CLI-validated structured_output over a prose result for a JSON call', () => {
    const event: ClaudeResultEvent = {
      result: 'Here is the flow:\n```json\n{"ok":true}\n```',
      structured_output: { ok: true, steps: [] },
    };
    assert.equal(answerTextOf(event, true), '{"ok":true,"steps":[]}');
    assert.equal(answerTextOf(event, false), event.result);
    assert.equal(answerTextOf({ result: 'plain' }, true), 'plain');
  });

  it('types a cut as finish=length with the cap, the ceiling and what it cost', () => {
    const error = answerErrorOf(cut, usageOf(cut, 0.005, 1));
    assert.equal(error.name, 'ClaudeAnswerError');
    assert.equal(error.finishReason, 'length');
    assert.equal(error.outputCap, 32000);
    assert.equal(error.modelCeiling, 64000);
    assert.equal(error.usage?.outputTokens, 160);
    assert.match(error.message, /CUT OFF at the CLI's own output cap of 32000/);
    assert.match(error.message, /finish=length/);
    // Words that would misfile it as transport or as a key failure.
    assert.doesNotMatch(error.message, /timeout|timed out|terminated|quota|rate.?limit/i);
    assert.equal(raisedOutputCap(error), 64000, 'one doubling toward the ceiling');
  });

  it('raises nothing at the model ceiling, and keeps the refusal wording for other errors', () => {
    const atCeiling = answerErrorOf({ ...cut, modelUsage: { 'claude-haiku-4-5': { maxOutputTokens: 32000 } } });
    assert.equal(raisedOutputCap(atCeiling), null);
    assert.match(atCeiling.message, /model's ceiling/);
    const other = answerErrorOf({ is_error: true, result: 'API Error: 429 rate limited' });
    assert.equal(other.finishReason, 'error');
    assert.match(other.message, /could not be asked — the provider refused the call: API Error: 429/);
    assert.equal(raisedOutputCap(other), null);
  });

  it('makes the output cap part of the warm session identity', () => {
    const base: SessionKey = { binary: 'claude', cwd: '/tmp', modelId: 'opus', effort: 'high', system: 's', schema: null };
    assert.notEqual(sessionKeyOf(base), sessionKeyOf({ ...base, maxOutputTokens: 64000 }));
    assert.equal(sessionKeyOf(base), sessionKeyOf({ ...base, maxOutputTokens: null }));
  });
});

describe('claude-cli: an answer cut at the CLI cap is re-asked once at a raised cap, never re-sent cold', () => {
  // A fake `claude` that behaves like the real one under a cap: with no
  // CLAUDE_CODE_MAX_OUTPUT_TOKENS in its environment it answers the cap
  // error; with one it answers a prose `result` beside a validated
  // `structured_output`. A cold (`-p` without `--input-format`) invocation
  // leaves a marker file, so "was the prompt re-sent cold" is a fact on disk.
  const dir = mkdtempSync(join(tmpdir(), 'wowlidator-fake-claude-cap-'));
  const binary = join(dir, 'fake-claude.cjs');
  writeFileSync(
    binary,
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const warm = process.argv.includes('--input-format');
const cap = process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
const ceiling = Number(process.env.FAKE_CLAUDE_CEILING || 64000);
function event() {
  if (cap === undefined || cap === '') {
    return { type: 'result', is_error: true, terminal_reason: 'api_error',
      result: "API Error: Claude's response exceeded the 32000 output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.",
      total_cost_usd: 0.005, num_turns: 1,
      usage: { input_tokens: 4, output_tokens: 160, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      modelUsage: { 'claude-opus-5': { maxOutputTokens: ceiling } } };
  }
  return { type: 'result', is_error: false, stop_reason: 'tool_use',
    result: 'Here it is: {"ok":true}', structured_output: { ok: true, cap: Number(cap) },
    total_cost_usd: 0.01, num_turns: 2,
    usage: { input_tokens: 4, output_tokens: 900, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
}
if (warm) {
  require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
    if (line.trim() !== '') process.stdout.write(JSON.stringify(event()) + '\\n');
  });
} else {
  fs.writeFileSync(path.join(process.env.FAKE_CLAUDE_MARK_DIR, 'cold-' + process.pid), '');
  process.stdout.write(JSON.stringify(event()));
}
`,
    'utf8',
  );
  chmodSync(binary, 0o755);
  const coldCalls = (): number => readdirSync(dir).filter((name) => name.startsWith('cold-')).length;
  const call = {
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'author it' }] }],
    responseFormat: { type: 'json', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } },
  } as unknown as Parameters<ReturnType<typeof createClaudeCli>['doGenerate']>[0];

  after(() => closeClaudeSessions());

  it('raises the cap toward the model ceiling and returns the CLI-validated object', async () => {
    process.env['WOWLIDATOR_CLAUDE_CLI_USAGE'] = 'off';
    process.env['FAKE_CLAUDE_MARK_DIR'] = dir;
    delete process.env['CLAUDE_CODE_MAX_OUTPUT_TOKENS'];
    try {
      closeClaudeSessions();
      const before = claudeCliUsage();
      const model = createClaudeCli({ modelId: 'opus', effort: 'high', binary, role: 'generator' });
      const result = await model.doGenerate(call);
      const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
      // structured_output, not the prose `result` — and at the raised cap.
      assert.equal(text, '{"ok":true,"cap":64000}');
      assert.equal(coldCalls(), 0, 'the identical prompt must never be re-sent cold');
      // Both asks are booked: the cut (its thinking was billed) and the answer.
      const spent = claudeCliUsageSince(before);
      assert.equal(spent.byRole['generator']?.calls, 2);
      assert.ok(Math.abs((spent.byRole['generator']?.costUsd ?? 0) - 0.015) < 1e-9);
    } finally {
      delete process.env['WOWLIDATOR_CLAUDE_CLI_USAGE'];
      delete process.env['FAKE_CLAUDE_MARK_DIR'];
    }
  });

  it('at the model ceiling fails as finish=length, once, with nothing re-sent', async () => {
    process.env['WOWLIDATOR_CLAUDE_CLI_USAGE'] = 'off';
    process.env['FAKE_CLAUDE_MARK_DIR'] = dir;
    process.env['FAKE_CLAUDE_CEILING'] = '32000';
    delete process.env['CLAUDE_CODE_MAX_OUTPUT_TOKENS'];
    try {
      closeClaudeSessions();
      const before = claudeCliUsage();
      const model = createClaudeCli({ modelId: 'opus', effort: 'high', binary, role: 'generator' });
      await assert.rejects(async () => { await model.doGenerate(call); }, (error: Error) => {
        assert.equal(error.name, 'ClaudeAnswerError');
        assert.match(error.message, /CUT OFF/);
        assert.match(error.message, /finish=length/);
        return true;
      });
      assert.equal(coldCalls(), 0);
      assert.equal(claudeCliUsageSince(before).byRole['generator']?.calls, 1, 'the cut is booked, once');
    } finally {
      delete process.env['WOWLIDATOR_CLAUDE_CLI_USAGE'];
      delete process.env['FAKE_CLAUDE_MARK_DIR'];
      delete process.env['FAKE_CLAUDE_CEILING'];
    }
  });
});
