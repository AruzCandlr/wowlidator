import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createClaudeCli,
  formatToolArg,
  flattenPrompt,
  withoutSchemaKeyword,
  DEFAULT_CLAUDE_CLI_EFFORT,
} from '../src/providers/claude-cli.js';
import { sessionKeyOf, type SessionKey } from '../src/providers/claude-cli-session.js';

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
