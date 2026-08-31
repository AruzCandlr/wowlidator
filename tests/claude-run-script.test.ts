import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  claudeArgsTemplate,
  claudeBinary,
  claudeExtraArgs,
  describeClaudeRunScript,
  formatCommandLine,
  renderArgsTemplate,
  splitArgs,
  validateArgsTemplate,
} from '../src/providers/claude-run-script.js';
import { loadConfig, PROVIDERS, SERIAL_PROVIDERS, DEFAULT_PROVIDER_MODELS } from '../src/config.js';

describe('splitArgs', () => {
  it('splits on whitespace', () => {
    assert.deepEqual(splitArgs('--permission-mode plan  --verbose'), [
      '--permission-mode',
      'plan',
      '--verbose',
    ]);
  });

  it('keeps a quoted value with spaces as one argument', () => {
    assert.deepEqual(splitArgs('--add-dir "/tmp/my dir"'), ['--add-dir', '/tmp/my dir']);
    assert.deepEqual(splitArgs("--name 'a b'"), ['--name', 'a b']);
  });

  it('handles a quote inside a word and an escaped space', () => {
    assert.deepEqual(splitArgs('--flag=va"l ue"'), ['--flag=val ue']);
    assert.deepEqual(splitArgs('a\\ b c'), ['a b', 'c']);
  });

  it('does no expansion — $HOME stays $HOME, because no shell is involved', () => {
    assert.deepEqual(splitArgs('--dir $HOME'), ['--dir', '$HOME']);
  });

  it('yields an empty vector for an empty or blank string', () => {
    assert.deepEqual(splitArgs(''), []);
    assert.deepEqual(splitArgs('   '), []);
  });

  it('keeps an explicitly empty argument', () => {
    assert.deepEqual(splitArgs('--tools ""'), ['--tools', '']);
  });

  it('refuses an unclosed quote loudly, at config time', () => {
    assert.throws(() => splitArgs('--flag "a b'), /unclosed " quote/);
  });
});

describe('the adjustable run script', () => {
  it('defaults to `claude` from PATH with no extra args', () => {
    const env = {} as NodeJS.ProcessEnv;
    assert.equal(claudeBinary('claude-cli', env), 'claude');
    assert.deepEqual(claudeExtraArgs('claude-tty', env), []);
  });

  it('takes the shared binary, and lets the per-provider one win', () => {
    const env = {
      WOWLIDATOR_CLAUDE_BIN: '/opt/claude/shared',
      WOWLIDATOR_CLAUDE_TTY_BIN: '/opt/claude/tty-only',
    } as NodeJS.ProcessEnv;
    assert.equal(claudeBinary('claude-cli', env), '/opt/claude/shared');
    assert.equal(claudeBinary('claude-tty', env), '/opt/claude/tty-only');
    assert.equal(claudeBinary('claude-cloud', env), '/opt/claude/shared');
  });

  it('appends shared extra args first, then the provider’s own', () => {
    const env = {
      WOWLIDATOR_CLAUDE_EXTRA_ARGS: '--verbose',
      WOWLIDATOR_CLAUDE_CLI_EXTRA_ARGS: '--permission-mode plan',
    } as NodeJS.ProcessEnv;
    assert.deepEqual(claudeExtraArgs('claude-cli', env), [
      '--verbose',
      '--permission-mode',
      'plan',
    ]);
    assert.deepEqual(claudeExtraArgs('claude-tty', env), ['--verbose']);
  });

  it('describes the full command, quoting only what needs it', () => {
    const env = {
      WOWLIDATOR_CLAUDE_CLI_EXTRA_ARGS: '--add-dir "/tmp/a b"',
    } as NodeJS.ProcessEnv;
    const view = describeClaudeRunScript('claude-cli', ['-p', '--model', '<model>'], env);
    assert.equal(view.binary, 'claude');
    assert.equal(view.error, null);
    assert.equal(view.commandLine, "claude -p --model '<model>' --add-dir '/tmp/a b'");
  });

  it('reports an unparseable extra-args string instead of throwing', () => {
    const env = { WOWLIDATOR_CLAUDE_TTY_EXTRA_ARGS: '--x "open' } as NodeJS.ProcessEnv;
    const view = describeClaudeRunScript('claude-tty', [], env);
    assert.match(view.error ?? '', /unclosed/);
    assert.deepEqual(view.extraArgs, []);
  });

  it('formats an empty argument visibly', () => {
    assert.equal(formatCommandLine('claude', ['--tools', '']), "claude --tools ''");
  });
});

describe('the editable args template', () => {
  it('defaults reproduce each provider’s historical vector', () => {
    const env = {} as NodeJS.ProcessEnv;
    const { template, custom } = claudeArgsTemplate('claude-tty', env);
    assert.equal(custom, false);
    const rendered = renderArgsTemplate(template, {
      'model-args': ['--model', 'sonnet'],
      'effort-args': ['--effort', 'low'],
      'extra-args': [],
    });
    assert.deepEqual(rendered, ['--model', 'sonnet', '--effort', 'low', '--strict-mcp-config']);
  });

  it('a custom line really EDITS — a deleted flag is gone, order is honoured', () => {
    const env = {
      WOWLIDATOR_CLAUDE_TTY_ARGS: '{extra-args} {model-args}',
    } as NodeJS.ProcessEnv;
    const { template, custom } = claudeArgsTemplate('claude-tty', env);
    assert.equal(custom, true);
    const rendered = renderArgsTemplate(template, {
      'model-args': ['--model', 'sonnet'],
      'effort-args': ['--effort', 'low'],
      'extra-args': ['--verbose'],
    });
    // --strict-mcp-config deleted, extra args moved first, effort unused.
    assert.deepEqual(rendered, ['--verbose', '--model', 'sonnet']);
  });

  it('a null expansion disappears; a placeholder mid-word stays literal', () => {
    assert.deepEqual(
      renderArgsTemplate(['a', '{gone}', '--x={model-args}'], { gone: null, 'model-args': ['m'] }),
      ['a', '--x={model-args}'],
    );
  });

  it('refuses an unknown placeholder with the known list in hand', () => {
    assert.throws(
      () => renderArgsTemplate(['{promt}'], { prompt: ['p'] }),
      /unknown placeholder \{promt\}.*\{prompt\}/,
    );
    assert.throws(
      () => validateArgsTemplate('claude-tty', splitArgs('{model-args} {promt}')),
      /unknown placeholder \{promt\}/,
    );
  });

  it('refuses a model named by hand — the role selector is the one place', () => {
    // In a template…
    assert.throws(
      () => validateArgsTemplate('claude-tty', splitArgs('--model sonnet {model-args}')),
      /--model is not allowed/,
    );
    assert.throws(
      () => validateArgsTemplate('claude-tty', splitArgs('--model=sonnet {model-args}')),
      /--model is not allowed/,
    );
    // …a template that drops {model-args} entirely…
    assert.throws(
      () => validateArgsTemplate('claude-tty', splitArgs('--strict-mcp-config')),
      /must include \{model-args\}/,
    );
    // …and in the extra args, at resolution time.
    assert.throws(
      () =>
        claudeExtraArgs('claude-tty', {
          WOWLIDATOR_CLAUDE_TTY_EXTRA_ARGS: '--model opus',
        } as NodeJS.ProcessEnv),
      /--model is not allowed/,
    );
  });

  it('refuses to save a line that loses a required placeholder', () => {
    assert.throws(
      () => validateArgsTemplate('claude-cli', splitArgs('-p {model-args}')),
      /must include \{prompt\}/,
    );
    assert.throws(
      () => validateArgsTemplate('claude-cloud', splitArgs('{model-args}')),
      /must include \{attach-args\}/,
    );
    assert.doesNotThrow(() => validateArgsTemplate('claude-tty', splitArgs('{model-args}')));
  });
});

describe('the claude-cloud provider registration', () => {
  it('is a provider, serial, keyless, with a default model', () => {
    assert.ok((PROVIDERS as readonly string[]).includes('claude-cloud'));
    assert.ok(SERIAL_PROVIDERS.has('claude-cloud'));
    assert.equal(DEFAULT_PROVIDER_MODELS['claude-cloud'], 'sonnet');
    const config = loadConfig({});
    assert.ok((config.apiKeys['claude-cloud']?.length ?? 0) > 0);
  });

  it('resolves the agent role onto claude-cloud with its own default model', () => {
    const config = loadConfig({ WOWLIDATOR_AGENT_PROVIDER: 'claude-cloud' });
    assert.equal(config.roles.agent.provider, 'claude-cloud');
    // The provider named without a model takes ITS default, never another
    // provider's model id — the DEFAULT_PROVIDER_MODELS rule.
    assert.equal(config.roles.agent.modelId, 'sonnet');
  });
});
