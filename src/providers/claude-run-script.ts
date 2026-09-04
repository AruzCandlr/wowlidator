/**
 * The run script behind the claude-* providers, made adjustable.
 *
 * `claude-cli`, `claude-tty` and `claude-cloud` all launch the same binary,
 * and until this file the command was hard-wired: the binary was the literal
 * string `claude` and the argument vector was whatever each provider baked
 * in. That is right until it isn't — a pinned install (`~/.claude/local/claude`),
 * a wrapper script that sets an environment first, a new CLI flag worth
 * passing before this repo knows about it. Each of those is a decision about
 * the machine, so the knobs live in the environment (and therefore in `.env`,
 * where the panel can edit them):
 *
 *   WOWLIDATOR_CLAUDE_BIN               binary for every claude-* provider
 *   WOWLIDATOR_CLAUDE_CLI_BIN           binary for claude-cli only (wins)
 *   WOWLIDATOR_CLAUDE_TTY_BIN           binary for claude-tty only (wins)
 *   WOWLIDATOR_CLAUDE_CLOUD_BIN         binary for claude-cloud only (wins)
 *   WOWLIDATOR_CLAUDE_EXTRA_ARGS        extra args for every claude-* provider
 *   WOWLIDATOR_CLAUDE_CLI_EXTRA_ARGS    extra args for claude-cli (appended after shared)
 *   WOWLIDATOR_CLAUDE_TTY_EXTRA_ARGS    extra args for claude-tty (appended after shared)
 *   WOWLIDATOR_CLAUDE_CLOUD_EXTRA_ARGS  extra args for claude-cloud (appended after shared)
 *
 * Extra args are written the way a shell line is (`--permission-mode plan
 * --add-dir "/tmp/my dir"`) and split here with quote support — but they are
 * NEVER given to a shell. Every provider spawns argv directly, so a value can
 * contain spaces (quoted) and nothing can be smuggled through `;` or `$()`.
 *
 * Extra args come LAST in each provider's vector, after the flags the
 * provider itself needs — last wins in the CLI's parser, so an extra
 * `--effort max` genuinely overrides the provider's own choice, which is the
 * point of an escape hatch.
 */

import { PROVIDERS, type ProviderName } from '../config.js';

/** The claude-backed providers — the ones this file's knobs apply to. */
export const CLAUDE_PROVIDERS = ['claude-cli', 'claude-tty', 'claude-cloud'] as const;
export type ClaudeProviderName = (typeof CLAUDE_PROVIDERS)[number];

export function isClaudeProvider(name: string): name is ClaudeProviderName {
  return (CLAUDE_PROVIDERS as readonly string[]).includes(name);
}

/** `claude-cli` → `CLI`, the middle of its env var names. */
function envInfix(provider: ClaudeProviderName): string {
  return provider.slice('claude-'.length).toUpperCase();
}

/** The env var that overrides one provider's binary. */
export function binaryEnvVar(provider: ClaudeProviderName): string {
  return `WOWLIDATOR_CLAUDE_${envInfix(provider)}_BIN`;
}

/** The env var that appends one provider's extra arguments. */
export function extraArgsEnvVar(provider: ClaudeProviderName): string {
  return `WOWLIDATOR_CLAUDE_${envInfix(provider)}_EXTRA_ARGS`;
}

/** The env var that REPLACES one provider's whole argument line. */
export function argsTemplateEnvVar(provider: ClaudeProviderName): string {
  return `WOWLIDATOR_CLAUDE_${envInfix(provider)}_ARGS`;
}

/**
 * The full argument line each provider runs by default, as an editable
 * template. `{name}` placeholders are whole arguments (never spliced into a
 * larger word) and expand per call — `{model-args}` to `--model <id>`,
 * `{prompt}` to the prompt text, and so on; an expansion the call has no
 * value for disappears. Everything else is a literal argument, which is what
 * makes the line EDITABLE rather than merely appendable: delete
 * `--strict-mcp-config` and it is gone, reorder the flags and they reorder.
 *
 * `WOWLIDATOR_CLAUDE_<CLI|TTY|CLOUD>_ARGS` replaces the whole line; unset
 * keeps the default below, which reproduces the historical behaviour
 * exactly. `{extra-args}` is where the append-style extra args land, so the
 * two mechanisms compose instead of fighting.
 */
export const DEFAULT_ARGS_TEMPLATE: Record<ClaudeProviderName, string> = {
  'claude-cli':
    '-p {model-args} {effort-args} {output-args} {system-args} --strict-mcp-config {tool-args} {schema-args} {extra-args} {prompt}',
  'claude-tty': '{model-args} {effort-args} --strict-mcp-config {extra-args}',
  'claude-cloud': '{attach-args} {model-args} {effort-args} --strict-mcp-config {extra-args}',
};

/**
 * The placeholders each provider's template may use. Also the authority the
 * panel validates an edit against, so a typo fails at save time with the
 * list in hand rather than inside the next run.
 */
export const TEMPLATE_PLACEHOLDERS: Record<ClaudeProviderName, readonly string[]> = {
  'claude-cli': ['model-args', 'effort-args', 'output-args', 'system-args', 'tool-args', 'schema-args', 'extra-args', 'prompt'],
  'claude-tty': ['model-args', 'effort-args', 'extra-args'],
  'claude-cloud': ['attach-args', 'model-args', 'effort-args', 'extra-args'],
};

/**
 * Placeholders whose loss would break the provider outright — and
 * `model-args`, which is required for a different reason: the model is
 * chosen by the role's model selector, ALWAYS. An args line without the
 * placeholder (or with a literal `--model`) would silently run a different
 * model from the one every report and ledger row records.
 */
export const REQUIRED_PLACEHOLDERS: Record<ClaudeProviderName, readonly string[]> = {
  'claude-cli': ['prompt', 'model-args'],
  'claude-tty': ['model-args'],
  'claude-cloud': ['attach-args', 'model-args'],
};

/**
 * Refuse an argument list that names a model by hand. The role selector is
 * the ONE place a model is chosen; a `--model` smuggled in through the args
 * editor or the extra args would override it silently while every record
 * still shows the selector's choice.
 */
export function assertNoModelArg(args: readonly string[], where: string): void {
  for (const arg of args) {
    if (arg === '--model' || arg.startsWith('--model=')) {
      throw new Error(
        `--model is not allowed in ${where} — the model always comes from the role's model ` +
          'selector ({model-args}); pick it there instead',
      );
    }
  }
}

/**
 * One provider's argument line: the env override when set, the default
 * otherwise. Split here so an unclosed quote fails loudly at config time.
 */
export function claudeArgsTemplate(
  provider: ClaudeProviderName,
  env: NodeJS.ProcessEnv = process.env,
): { template: string[]; custom: boolean } {
  const raw = env[argsTemplateEnvVar(provider)]?.trim();
  const custom = raw !== undefined && raw !== '';
  return { template: splitArgs(custom ? raw : DEFAULT_ARGS_TEMPLATE[provider]), custom };
}

/** What a `{name}` placeholder becomes: its arguments, or null for "drop it". */
export type ArgExpansions = Record<string, readonly string[] | null>;

const PLACEHOLDER = /^\{([a-z-]+)\}$/;

/**
 * Fill a template's placeholders. Unknown placeholders are refused with the
 * known list — a template that silently dropped `{promt}` would run a call
 * with no prompt and fail somewhere far less legible than here.
 */
export function renderArgsTemplate(
  template: readonly string[],
  expansions: ArgExpansions,
): string[] {
  const out: string[] = [];
  for (const arg of template) {
    const match = arg.match(PLACEHOLDER);
    if (match === null) {
      out.push(arg);
      continue;
    }
    const key = match[1] as string;
    if (!(key in expansions)) {
      throw new Error(
        `unknown placeholder {${key}} in the claude args template — known: ` +
          Object.keys(expansions)
            .map((name) => `{${name}}`)
            .join(' '),
      );
    }
    const expansion = expansions[key];
    if (expansion) out.push(...expansion);
  }
  return out;
}

/**
 * Refuse a template that cannot work before it is saved or used: an unknown
 * placeholder, or a required one missing. Takes the already-split template —
 * re-splitting a joined line would lose its quoting.
 */
export function validateArgsTemplate(
  provider: ClaudeProviderName,
  template: readonly string[],
): readonly string[] {
  const known = TEMPLATE_PLACEHOLDERS[provider];
  assertNoModelArg(template, `the ${provider} args`);
  for (const arg of template) {
    const match = arg.match(PLACEHOLDER);
    if (match !== null && !known.includes(match[1] as string)) {
      throw new Error(
        `unknown placeholder {${match[1]}} for ${provider} — known: ` +
          known.map((name) => `{${name}}`).join(' '),
      );
    }
  }
  for (const required of REQUIRED_PLACEHOLDERS[provider]) {
    if (!template.includes(`{${required}}`)) {
      throw new Error(`the ${provider} args must include {${required}} — without it every call breaks`);
    }
  }
  return template;
}

/**
 * Split a shell-style line into argv, honouring single and double quotes.
 *
 * Deliberately small: quotes group, backslash escapes the next character
 * outside single quotes, and there is no expansion of any kind — `$HOME`
 * stays `$HOME`, because nothing here ever reaches a shell. An unclosed
 * quote is an error rather than a guess: the difference between
 * `--flag "a b` meaning one argument or two is exactly the kind of thing
 * that must fail loudly at config time, not misfire inside a run.
 */
export function splitArgs(raw: string): string[] {
  const args: string[] = [];
  let current = '';
  let started = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i] as string;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (ch === '\\' && i + 1 < raw.length) {
      current += raw[i + 1];
      started = true;
      i++;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) args.push(current);
      current = '';
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }
  if (quote !== null) {
    throw new Error(`unclosed ${quote} quote in claude extra args: ${raw}`);
  }
  if (started) args.push(current);
  return args;
}

/**
 * The binary one provider runs: its own env var, the shared one, `claude`.
 */
export function claudeBinary(
  provider: ClaudeProviderName,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    env[binaryEnvVar(provider)]?.trim() ||
    env['WOWLIDATOR_CLAUDE_BIN']?.trim() ||
    'claude'
  );
}

/**
 * The extra arguments one provider appends: the shared list first, then the
 * provider's own — so a per-provider flag can override a shared one.
 */
export function claudeExtraArgs(
  provider: ClaudeProviderName,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const args = [
    ...splitArgs(env['WOWLIDATOR_CLAUDE_EXTRA_ARGS'] ?? ''),
    ...splitArgs(env[extraArgsEnvVar(provider)] ?? ''),
  ];
  // The model comes from the role selector, never from here — see
  // `assertNoModelArg`. Checked at resolution so an env-set override fails
  // at construction with its own message, not by silently mislabelling runs.
  assertNoModelArg(args, `WOWLIDATOR_CLAUDE_EXTRA_ARGS / ${extraArgsEnvVar(provider)}`);
  return args;
}

/** One argument as a person would type it — quoted only when it needs to be. */
function shellWord(arg: string): string {
  if (arg === '') return "''";
  if (/^[A-Za-z0-9@%_+=:,.\/-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** A command line for humans — the panel's preview, a log line. Never executed. */
export function formatCommandLine(binary: string, args: readonly string[]): string {
  return [binary, ...args].map(shellWord).join(' ');
}

export interface ClaudeRunScriptView {
  provider: ClaudeProviderName;
  /** The resolved binary, and the env var that would override it. */
  binary: string;
  binaryEnvVar: string;
  binaryOverridden: boolean;
  /** The resolved extra args (shared + per-provider), and the per-provider var. */
  extraArgs: string[];
  extraArgsEnvVar: string;
  /** The full launch command as this configuration would run it, for display. */
  commandLine: string;
  /** Set when the extra args cannot be parsed; the provider will refuse too. */
  error: string | null;
}

/**
 * What each claude provider would actually run, for the panel and `doctor`.
 *
 * `baseArgs` names the flags the provider itself adds so the preview is the
 * real command, not a sketch — the caller owns those, this file only appends.
 */
export function describeClaudeRunScript(
  provider: ClaudeProviderName,
  baseArgs: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): ClaudeRunScriptView {
  const binary = claudeBinary(provider, env);
  let extraArgs: string[] = [];
  let error: string | null = null;
  try {
    extraArgs = claudeExtraArgs(provider, env);
  } catch (parseError) {
    error = parseError instanceof Error ? parseError.message : String(parseError);
  }
  return {
    provider,
    binary,
    binaryEnvVar: binaryEnvVar(provider),
    binaryOverridden:
      (env[binaryEnvVar(provider)]?.trim() || env['WOWLIDATOR_CLAUDE_BIN']?.trim() || '') !== '',
    extraArgs,
    extraArgsEnvVar: extraArgsEnvVar(provider),
    commandLine: formatCommandLine(binary, [...baseArgs, ...extraArgs]),
    error,
  };
}

// A compile-time cross-check: every name in CLAUDE_PROVIDERS must be a real
// provider. (`PROVIDERS` is the runtime registry; drift between the two would
// otherwise surface as an env var that silently configures nothing.)
type _AssertSubset = ClaudeProviderName extends ProviderName ? true : never;
const _assert: _AssertSubset = true;
void _assert;
void PROVIDERS;
