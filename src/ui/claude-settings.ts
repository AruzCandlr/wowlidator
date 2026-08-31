/**
 * The panel's window onto the claude-* providers: the run script each one
 * would launch, editable, and the signed-in account's live quota.
 *
 * The sibling of `models.ts` and `keys.ts`, with one deliberate difference:
 * a run-script edit IS persisted to `.env` immediately (the same reasoning
 * that moved model picks there — a binary path that evaporates on restart is
 * not a setting, it is a trap), and applied to this process's environment so
 * the panel's own next spawn already carries it.
 *
 * Quota comes from `providers/claude-quota.ts`, which caches; `GET /api/claude`
 * is therefore pollable the way `/api/models` is. The panel never sees the
 * OAuth token — only percentages and reset times.
 */

import { readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { DOTENV_SOURCED, type LlmRole, type WowlidatorConfig, LLM_ROLES } from '../config.js';
import {
  CLAUDE_PROVIDERS,
  DEFAULT_ARGS_TEMPLATE,
  TEMPLATE_PLACEHOLDERS,
  argsTemplateEnvVar,
  assertNoModelArg,
  binaryEnvVar,
  claudeArgsTemplate,
  claudeBinary,
  claudeExtraArgs,
  extraArgsEnvVar,
  formatCommandLine,
  isClaudeProvider,
  renderArgsTemplate,
  splitArgs,
  validateArgsTemplate,
  type ArgExpansions,
  type ClaudeProviderName,
} from '../providers/claude-run-script.js';
import {
  fetchClaudeQuota,
  type ClaudeQuotaSnapshot,
} from '../providers/claude-quota.js';
import {
  claudeCliUsageEnabled,
  claudeCliUsagePath,
  readClaudeCliUsage,
  summarizeClaudeCliUsage,
  type ClaudeCliUsageSummary,
} from '../providers/claude-cli-usage-log.js';

export class ClaudeSettingsError extends Error {}

export interface ClaudeProviderSettingsView {
  provider: ClaudeProviderName;
  /**
   * True for claude-cli, whose command is hardcoded in
   * `src/providers/claude-cli.ts` (rolled back from the template on request,
   * 2026-08-27) — the row shows the command and where to edit it, and the
   * server refuses to persist env edits that would silently do nothing.
   */
  hardcoded: boolean;
  /** The resolved binary, and the env var that would override it. */
  binary: string;
  binaryEnvVar: string;
  binaryOverridden: boolean;
  /** The full launch command as this configuration would run it, for display. */
  commandLine: string;
  /** Set when the args cannot be parsed or rendered; the provider refuses too. */
  error: string | null;
  /**
   * The whole argument line, editable: the effective template (custom or
   * default), the default to fall back to, whether a custom one is set, the
   * env var it lives in, and the placeholders it may use.
   */
  argsTemplate: string;
  argsTemplateDefault: string;
  argsTemplateCustom: boolean;
  argsTemplateEnvVar: string;
  placeholders: string[];
  /** The raw per-provider extra-args string, for the edit box. */
  extraArgsRaw: string;
  extraArgsEnvVar: string;
  /** The shared extra-args string every claude provider inherits first. */
  sharedExtraArgsRaw: string;
  /** Roles currently pointed at this provider — why the card matters now. */
  roles: LlmRole[];
}

export interface ClaudeSettingsBody {
  runScripts: ClaudeProviderSettingsView[];
  quota: ClaudeQuotaSnapshot;
  /**
   * The `claude -p` ledger — every claude-cli call any process made from
   * this working directory, aggregated. Interactive providers (claude-tty,
   * claude-cloud) report no usage and so are honestly absent here.
   */
  cliUsage: ClaudeCliUsageSummary & { path: string; enabled: boolean };
}

/**
 * How each placeholder is shown in the preview — display stand-ins for the
 * values that vary per role and per call, so the preview is the real command
 * shape without pretending to know the next call's prompt.
 */
function displayExpansions(
  provider: ClaudeProviderName,
  env: NodeJS.ProcessEnv,
): ArgExpansions {
  const shared: ArgExpansions = {
    'model-args': ['--model', '<model>'],
    'effort-args': ['--effort', '<effort>'],
    'extra-args': claudeExtraArgs(provider, env),
  };
  if (provider === 'claude-cli') {
    return {
      ...shared,
      'output-args': ['--output-format', 'json'],
      'system-args': ['--system-prompt', '<system>'],
      'tool-args': null,
      'schema-args': ['--json-schema', '<schema>'],
      prompt: ['<prompt>'],
    };
  }
  if (provider === 'claude-cloud') {
    return { ...shared, 'attach-args': ['--cloud', '<session-id>'] };
  }
  return shared;
}

/** Where the hardcoded claude-cli command lives, for the row's note. */
export const CLAUDE_CLI_SCRIPT_FILE = 'src/providers/claude-cli.ts';
/** The hardcoded vector, restated for display only — the file is the truth. */
const CLAUDE_CLI_DISPLAY_ARGS = [
  '-p', '--model', '<model>', '--effort', '<effort>', '--output-format', 'json',
  '--system-prompt', '<system>', '--strict-mcp-config', '--setting-sources', '',
  '--disable-slash-commands', '--no-session-persistence', '--tools=',
  '--json-schema', '<schema>', '<prompt>',
];

/** One provider's row of the card, never throwing — a broken value is the row's `error`. */
function runScriptView(
  provider: ClaudeProviderName,
  config: WowlidatorConfig,
  env: NodeJS.ProcessEnv,
): ClaudeProviderSettingsView {
  const roles = LLM_ROLES.filter((role) => config.roles[role].provider === provider);
  if (provider === 'claude-cli') {
    return {
      provider,
      hardcoded: true,
      binary: 'claude',
      binaryEnvVar: '',
      binaryOverridden: false,
      commandLine: formatCommandLine('claude', CLAUDE_CLI_DISPLAY_ARGS),
      error: null,
      argsTemplate: '',
      argsTemplateDefault: '',
      argsTemplateCustom: false,
      argsTemplateEnvVar: '',
      placeholders: [],
      extraArgsRaw: '',
      extraArgsEnvVar: '',
      sharedExtraArgsRaw: '',
      roles,
    };
  }
  const binary = claudeBinary(provider, env);
  let commandLine = '';
  let template = DEFAULT_ARGS_TEMPLATE[provider];
  let custom = false;
  let error: string | null = null;
  try {
    const resolved = claudeArgsTemplate(provider, env);
    custom = resolved.custom;
    template = env[argsTemplateEnvVar(provider)]?.trim() || DEFAULT_ARGS_TEMPLATE[provider];
    if (custom) validateArgsTemplate(provider, resolved.template);
    commandLine = formatCommandLine(
      binary,
      renderArgsTemplate(resolved.template, displayExpansions(provider, env)),
    );
  } catch (bad) {
    error = bad instanceof Error ? bad.message : String(bad);
  }
  return {
    provider,
    hardcoded: false,
    binary,
    binaryEnvVar: binaryEnvVar(provider),
    binaryOverridden:
      (env[binaryEnvVar(provider)]?.trim() || env['WOWLIDATOR_CLAUDE_BIN']?.trim() || '') !== '',
    commandLine,
    error,
    argsTemplate: template,
    argsTemplateDefault: DEFAULT_ARGS_TEMPLATE[provider],
    argsTemplateCustom: custom,
    argsTemplateEnvVar: argsTemplateEnvVar(provider),
    placeholders: [...TEMPLATE_PLACEHOLDERS[provider]],
    extraArgsRaw: env[extraArgsEnvVar(provider)] ?? '',
    extraArgsEnvVar: extraArgsEnvVar(provider),
    sharedExtraArgsRaw: env['WOWLIDATOR_CLAUDE_EXTRA_ARGS'] ?? '',
    roles: LLM_ROLES.filter((role) => config.roles[role].provider === provider),
  };
}

export async function describeClaudeSettings(
  config: WowlidatorConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ClaudeSettingsBody> {
  return {
    runScripts: CLAUDE_PROVIDERS.map((provider) => runScriptView(provider, config, env)),
    quota: await fetchClaudeQuota(env),
    cliUsage: {
      ...summarizeClaudeCliUsage(await readClaudeCliUsage(env)),
      path: claudeCliUsagePath(env),
      enabled: claudeCliUsageEnabled(env),
    },
  };
}

/** A value that has to survive as one `.env` line and one argv element. */
function assertOneLine(what: string, value: string): void {
  if (/[\r\n]/.test(value)) {
    throw new ClaudeSettingsError(`${what} cannot contain a newline`);
  }
}

/**
 * Save one provider's run script: its binary and its extra args, as typed.
 *
 * Empty means "back to the default" and the `.env` line is commented out
 * rather than deleted — recoverable by eye, the same rule as
 * `persistRoleModel`. The extra-args string is parsed before anything is
 * written, so an unclosed quote is refused here with its own message instead
 * of failing inside the next run.
 */
export async function persistClaudeRunScript(
  provider: string,
  edit: { binary?: string | undefined; args?: string | undefined; extraArgs?: string | undefined },
  envPath = '.env',
): Promise<void> {
  if (!isClaudeProvider(provider)) {
    throw new ClaudeSettingsError(
      `"${provider}" is not a claude provider — it has ${CLAUDE_PROVIDERS.join(', ')}`,
    );
  }
  if (provider === 'claude-cli') {
    // Rolled back to a hardcoded command on request — accepting an env edit
    // here would save a setting that silently does nothing.
    throw new ClaudeSettingsError(
      `the claude-cli command is hardcoded — edit the args array in ${CLAUDE_CLI_SCRIPT_FILE} ` +
        '(and the warm session args in src/providers/claude-cli-session.ts) directly',
    );
  }
  const assignments: [string, string | null][] = [];
  if (edit.binary !== undefined) {
    const binary = edit.binary.trim();
    assertOneLine('the binary', binary);
    assignments.push([binaryEnvVar(provider), binary === '' ? null : binary]);
  }
  if (edit.args !== undefined) {
    // The whole argument line. Empty (or exactly the default) means back to
    // the default — writing the default out verbatim would freeze today's
    // vector into `.env` and silently pin it across upgrades.
    const raw = edit.args.trim();
    assertOneLine('the arguments', raw);
    const backToDefault = raw === '' || raw === DEFAULT_ARGS_TEMPLATE[provider];
    if (!backToDefault) {
      try {
        validateArgsTemplate(provider, splitArgs(raw));
      } catch (error) {
        throw new ClaudeSettingsError(error instanceof Error ? error.message : String(error));
      }
    }
    assignments.push([argsTemplateEnvVar(provider), backToDefault ? null : raw]);
  }
  if (edit.extraArgs !== undefined) {
    const raw = edit.extraArgs.trim();
    assertOneLine('the extra arguments', raw);
    try {
      // The model belongs to the role selector alone — refused here so the
      // save fails with the reason, not the next run with a mislabelled model.
      assertNoModelArg(splitArgs(raw), 'the extra arguments');
    } catch (error) {
      throw new ClaudeSettingsError(error instanceof Error ? error.message : String(error));
    }
    assignments.push([extraArgsEnvVar(provider), raw === '' ? null : raw]);
  }
  if (assignments.length === 0) return;

  await upsertEnv(assignments, envPath);

  // Applied to this process too, so the next run the panel spawns already
  // carries the edit — and marked dotenv-sourced, so a later ".env reload"
  // may replace it and a spawned child is not handed it as though it were
  // the real launch environment.
  for (const [key, value] of assignments) {
    if (value === null) delete process.env[key];
    else process.env[key] = value;
    DOTENV_SOURCED.add(key);
  }
}

/**
 * Upsert `.env` lines in place — comments and order kept, temp file plus
 * rename. The same shape as `persistRoleModel`'s writer; a null value
 * comments the line out.
 */
export async function upsertEnv(assignments: [string, string | null][], envPath: string): Promise<void> {
  const target = resolve(envPath);
  let text = '';
  try {
    text = await readFile(target, 'utf8');
  } catch {
    text = '';
  }
  const lines = text.split('\n');
  const appended: string[] = [];
  for (const [key, value] of assignments) {
    const at = lines.findIndex((line) => new RegExp(`^\\s*${key}\\s*=`).test(line));
    if (value === null) {
      if (at !== -1) lines[at] = `# ${lines[at]}`;
      continue;
    }
    if (at === -1) appended.push(`${key}=${value}`);
    else lines[at] = `${key}=${value}`;
  }
  if (appended.length > 0) {
    const heading = '# --- Chosen in the panel ---';
    if (!lines.includes(heading)) {
      if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
      lines.push(heading);
    }
    lines.push(...appended);
  }
  const next = lines.join('\n');
  const temp = `${target}.tmp`;
  await writeFile(temp, next.endsWith('\n') ? next : `${next}\n`, 'utf8');
  await rename(temp, target);
}
