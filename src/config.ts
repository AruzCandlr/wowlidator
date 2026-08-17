/**
 * Centralised environment configuration.
 *
 * Every knob wowlidator has lives here, validated once at startup rather than
 * scattered through `process.env` lookups. The important part is the *role*
 * table: wowlidator has three distinct model jobs, and each is routed to whichever
 * free-tier provider suits it, independently of the others.
 *
 *   healer    → fast + cheap. One small repair, latency-sensitive.  → Groq (gpt-oss-120b)
 *   generator → big context. A whole AX tree in, a suite out.       → Gemini
 *   agent     → general reasoning, one decision per turn.           → Groq (gpt-oss-120b)
 *   data      → small, rare escalation for mock data.               → Groq (gpt-oss-120b)
 *
 * Nothing here is hard-wired: any role can point at any provider and model id
 * through environment variables, which is the whole point of the abstraction.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

import { z } from 'zod';

import { DEFAULT_REPORT_DIR as REPORTER_DEFAULT_DIR } from './reporter/html-reporter.js';
import { DEFAULT_CAPTURE_DELAY_MS } from './engine/evidence.js';
import type { ScreenshotMode, VideoMode } from './engine/runner.js';

export const LLM_ROLES = ['healer', 'generator', 'agent', 'data'] as const;
export type LlmRole = (typeof LLM_ROLES)[number];

export const PROVIDERS = ['google', 'groq', 'openrouter', 'emmiedev', 'zai'] as const;
export type ProviderName = (typeof PROVIDERS)[number];

/** Which env var carries each provider's key, and where to get one. */
export const PROVIDER_META: Record<
  ProviderName,
  { envKey: string; label: string; consoleUrl: string; freeTier: string }
> = {
  google: {
    envKey: 'GOOGLE_GENERATIVE_AI_API_KEY',
    label: 'Google AI Studio (Gemini)',
    consoleUrl: 'https://aistudio.google.com/apikey',
    freeTier: 'generous free tier; largest context of the three',
  },
  groq: {
    envKey: 'GROQ_API_KEY',
    label: 'Groq',
    consoleUrl: 'https://console.groq.com/keys',
    freeTier: 'free tier with tight rate limits; fastest tokens/sec',
  },
  openrouter: {
    envKey: 'OPENROUTER_API_KEY',
    label: 'OpenRouter',
    consoleUrl: 'https://openrouter.ai/keys',
    freeTier: 'free `:free` model variants; broad model selection',
  },
  // OpenAI-compatible endpoint at chat.emmiedev.com — keys start `ek-`.
  // The server ignores the model field; `default` is its stable alias for
  // whatever model it currently runs, so always use that as the model id.
  emmiedev: {
    envKey: 'EMMIEDEV_API_KEY',
    label: 'EmmieDev',
    consoleUrl: 'https://chat.emmiedev.com',
    freeTier: 'self-provided key; OpenAI-compatible /v1 API',
  },
  // Z.AI (Zhipu) — OpenAI-compatible endpoint serving the GLM family
  // (glm-4.6, glm-4.5-air, …).
  zai: {
    envKey: 'ZAI_API_KEY',
    label: 'Z.AI (GLM)',
    consoleUrl: 'https://z.ai/manage-apikey/apikey-list',
    freeTier: 'paid API with free trial credit; GLM models',
  },
};

/**
 * Defaults chosen to match each role's shape.
 *
 * ⚠️ Model *ids* move faster than this file does. They are the most likely
 * thing here to be stale — run `wowlidator doctor` to confirm each one resolves
 * against the live provider before trusting a run.
 *
 * The Google and Groq ids below were confirmed against each provider's live
 * `models.list` endpoint (Groq's `openai/gpt-oss-120b` on 2026-08-11).
 */
export const DEFAULT_ROLE_MODELS: Record<LlmRole, { provider: ProviderName; modelId: string }> = {
  healer: { provider: 'groq', modelId: 'openai/gpt-oss-120b' },
  generator: { provider: 'google', modelId: 'gemini-3.6-flash' },
  agent: { provider: 'groq', modelId: 'openai/gpt-oss-120b' },
  // Same job shape as healer — small, latency-sensitive, rarely called (most
  // data generation is deterministic and never reaches a model at all).
  data: { provider: 'groq', modelId: 'openai/gpt-oss-120b' },
};

export interface RoleConfig {
  role: LlmRole;
  provider: ProviderName;
  modelId: string;
}

export interface WowlidatorConfig {
  roles: Record<LlmRole, RoleConfig>;
  /**
   * Ordered by preference — index 0 is the one used by default. A provider
   * with more than one key gets automatic failover: see
   * `LlmFactory.callWithFailover` in `providers/llm-factory.ts`.
   */
  apiKeys: Partial<Record<ProviderName, string[]>>;
  /** Free tiers rate-limit aggressively; the SDK backs off between attempts. */
  maxRetries: number;
  cdpUrl: string;
  cachePath: string;
  proofDir: string;
  /** Append-only run index. Absolute, or relative to the process's cwd. */
  historyPath: string;
  reportDir: string;
  /** Explicit report destination (file, directory, or a `{placeholder}` path). */
  reportPath: string | undefined;
  /** False disables HTML report writing entirely. */
  reportEnabled: boolean;
  /**
   * Stills.
   *
   * **`undefined` means unset, and unset is not `all`.** Left alone, the
   * runner picks a mode from whether the run is being filmed — `on-failure`
   * when it is, `all` when it is not. Defaulting it here would resolve that
   * choice before the runner could make it, and every run would carry both a
   * recording and a full set of stills.
   */
  screenshots: ScreenshotMode | undefined;
  /** Film the run, with a drawn-in pointer. See `engine/video.ts`. */
  video: VideoMode;
  /** Pause before each screenshot, so the page has painted. See `evidence.ts`. */
  captureDelayMs: number;
  healing: boolean;
  agentEnabled: boolean;
  /** Let the agent rescue an unreachable control mid-run. Off by default. */
  agentAssist: boolean;
}

export const DEFAULT_CDP_URL = 'http://localhost:9222';
export const DEFAULT_CACHE_PATH = 'healed-selectors.json';
export const DEFAULT_PROOF_DIR = '.wowlidator/proofs';
export const DEFAULT_REPORT_DIR = REPORTER_DEFAULT_DIR;
export const DEFAULT_MAX_RETRIES = 2;

const providerSchema = z.enum(PROVIDERS);
const screenshotSchema = z.enum(['off', 'on-failure', 'on-event', 'all']);
/**
 * `WOWLIDATOR_SCREENSHOTS=auto` is the same "unset" the CLI's `--screenshots
 * auto` means: let the recording decide. Accepted here so the environment can
 * state the default rather than only override it.
 */
const screenshotEnvSchema = z.union([screenshotSchema, z.literal('auto')]);
const videoSchema = z.enum(['on', 'off']);

const envSchema = z.object({
  WOWLIDATOR_HEALER_PROVIDER: providerSchema.optional(),
  WOWLIDATOR_HEALER_MODEL: z.string().min(1).optional(),
  WOWLIDATOR_GENERATOR_PROVIDER: providerSchema.optional(),
  WOWLIDATOR_GENERATOR_MODEL: z.string().min(1).optional(),
  WOWLIDATOR_AGENT_PROVIDER: providerSchema.optional(),
  WOWLIDATOR_AGENT_MODEL: z.string().min(1).optional(),
  WOWLIDATOR_DATA_PROVIDER: providerSchema.optional(),
  WOWLIDATOR_DATA_MODEL: z.string().min(1).optional(),

  GOOGLE_GENERATIVE_AI_API_KEY: z.string().min(1).optional(),
  GROQ_API_KEY: z.string().min(1).optional(),
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  EMMIEDEV_API_KEY: z.string().min(1).optional(),
  ZAI_API_KEY: z.string().min(1).optional(),

  WOWLIDATOR_LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(10).optional(),
  WOWLIDATOR_CDP_URL: z.string().min(1).optional(),
  WOWLIDATOR_CACHE_PATH: z.string().min(1).optional(),
  WOWLIDATOR_PROOF_DIR: z.string().min(1).optional(),
  WOWLIDATOR_HISTORY_PATH: z.string().min(1).optional(),
  WOWLIDATOR_REPORT_DIR: z.string().min(1).optional(),
  WOWLIDATOR_REPORT_PATH: z.string().min(1).optional(),
  WOWLIDATOR_DISABLE_REPORT: z.string().optional(),
  WOWLIDATOR_SCREENSHOTS: screenshotEnvSchema.optional(),
  WOWLIDATOR_VIDEO: videoSchema.optional(),
  WOWLIDATOR_CAPTURE_DELAY_MS: z.coerce.number().int().min(0).max(30_000).optional(),
  WOWLIDATOR_DISABLE_HEALING: z.string().optional(),
  WOWLIDATOR_DISABLE_AGENT: z.string().optional(),
  WOWLIDATOR_AGENT_ASSIST: z.string().optional(),
});

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Load a local `.env` into `process.env`, if one exists.
 *
 * Called from the CLI and MCP entrypoints only — never from `loadConfig`,
 * which stays pure so tests can pass an explicit env object. Values already
 * present in the real environment win, so `GROQ_API_KEY=... wowlidator run` still
 * overrides the file.
 */
export function loadDotEnv(path = '.env'): boolean {
  let parsed: Record<string, string | undefined>;
  try {
    parsed = parseEnv(readFileSync(path, 'utf8')) as Record<string, string | undefined>;
  } catch {
    return false; // No .env is the normal case, not an error.
  }
  // The file is applied by hand rather than through `process.loadEnvFile`,
  // because that API refuses to overwrite an existing variable — which made
  // "reload `.env`" a lie for exactly the case it exists for, a key
  // *replaced* in the file while the process runs.
  for (const [key, value] of Object.entries(parsed)) {
    if (value === undefined) continue;
    // Anything this process was started with, or set itself, wins over the
    // file — `GROQ_API_KEY=... wowlidator run` still overrides `.env`. Only a
    // variable that is unset, or that an earlier load of the file supplied,
    // takes the file's value.
    if (process.env[key] !== undefined && !DOTENV_SOURCED.has(key)) continue;
    process.env[key] = value;
    // Recorded so a parent process can avoid exporting file-supplied values
    // to children as though they were the real environment (see the spawn in
    // `ui/jobs.ts` for why that distinction is load-bearing).
    DOTENV_SOURCED.add(key);
  }
  return true;
}

/**
 * Env vars whose current value came from a `.env` file rather than from the
 * environment this process was actually started with.
 *
 * The distinction exists for one reason: a long-lived process (the control
 * panel) that spawns CLI runs. `loadDotEnv`'s "real environment wins" rule is
 * right within one process — `GROQ_API_KEY=... wowlidator run` must beat the
 * file — but a panel that passes its own dotenv-loaded snapshot to a child
 * makes that snapshot *become* the child's real environment, permanently
 * shadowing every later edit to `.env`. Found the expensive way: a corrected
 * EMMIEDEV_API_KEY in the file, and every panel-launched run still failing
 * auth on the stale value the panel had exported from before the fix.
 */
export const DOTENV_SOURCED = new Set<string>();

/** Drop empty strings so `FOO=` behaves the same as an unset `FOO`. */
function compact(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' && value.trim() !== '') out[key] = value;
  }
  return out;
}

/**
 * One env var, one or more keys: `GOOGLE_GENERATIVE_AI_API_KEY=key1,key2`.
 * Order is preserved — the first key listed is the one tried first — and
 * duplicates are dropped so a pasted-twice key doesn't count as a second,
 * independent quota to fail over into.
 */
function parseApiKeys(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const candidate of raw.split(',')) {
    const key = candidate.trim();
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

/**
 * Validate the environment into a config object. Throws `ConfigError` with an
 * actionable message rather than letting a bad value surface later as a
 * confusing provider error.
 *
 * Missing API keys are **not** an error here — a run with `--no-heal` and no
 * `workflow` steps needs no keys at all. Keys are checked when a role is
 * actually instantiated (see `llm-factory.ts`).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): WowlidatorConfig {
  const parsed = envSchema.safeParse(compact(env));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new ConfigError(`invalid wowlidator environment:\n${issues}`);
  }
  const e = parsed.data;

  const role = (
    name: LlmRole,
    provider: ProviderName | undefined,
    modelId: string | undefined,
  ): RoleConfig => ({
    role: name,
    provider: provider ?? DEFAULT_ROLE_MODELS[name].provider,
    modelId: modelId ?? DEFAULT_ROLE_MODELS[name].modelId,
  });

  const apiKeys: Partial<Record<ProviderName, string[]>> = {};
  const googleKeys = parseApiKeys(e.GOOGLE_GENERATIVE_AI_API_KEY);
  const groqKeys = parseApiKeys(e.GROQ_API_KEY);
  const openrouterKeys = parseApiKeys(e.OPENROUTER_API_KEY);
  const emmiedevKeys = parseApiKeys(e.EMMIEDEV_API_KEY);
  const zaiKeys = parseApiKeys(e.ZAI_API_KEY);
  if (googleKeys.length > 0) apiKeys.google = googleKeys;
  if (groqKeys.length > 0) apiKeys.groq = groqKeys;
  if (openrouterKeys.length > 0) apiKeys.openrouter = openrouterKeys;
  if (emmiedevKeys.length > 0) apiKeys.emmiedev = emmiedevKeys;
  if (zaiKeys.length > 0) apiKeys.zai = zaiKeys;

  return {
    roles: {
      healer: role('healer', e.WOWLIDATOR_HEALER_PROVIDER, e.WOWLIDATOR_HEALER_MODEL),
      generator: role('generator', e.WOWLIDATOR_GENERATOR_PROVIDER, e.WOWLIDATOR_GENERATOR_MODEL),
      agent: role('agent', e.WOWLIDATOR_AGENT_PROVIDER, e.WOWLIDATOR_AGENT_MODEL),
      data: role('data', e.WOWLIDATOR_DATA_PROVIDER, e.WOWLIDATOR_DATA_MODEL),
    },
    apiKeys,
    maxRetries: e.WOWLIDATOR_LLM_MAX_RETRIES ?? DEFAULT_MAX_RETRIES,
    cdpUrl: e.WOWLIDATOR_CDP_URL ?? DEFAULT_CDP_URL,
    cachePath: e.WOWLIDATOR_CACHE_PATH ?? DEFAULT_CACHE_PATH,
    proofDir: e.WOWLIDATOR_PROOF_DIR ?? DEFAULT_PROOF_DIR,
    // Defaults *beside the proof bundles*, not to the working directory.
    // Everything else a run produces already had an absolute home configurable
    // through the environment; run history did not, so it resolved against
    // wherever the command happened to be typed — one file per directory anyone
    // ever ran from, and the UI reading a different one from all of them.
    historyPath:
      e.WOWLIDATOR_HISTORY_PATH ??
      join(e.WOWLIDATOR_PROOF_DIR ?? DEFAULT_PROOF_DIR, '..', 'history.jsonl'),
    reportDir: e.WOWLIDATOR_REPORT_DIR ?? DEFAULT_REPORT_DIR,
    reportPath: e.WOWLIDATOR_REPORT_PATH,
    reportEnabled: e.WOWLIDATOR_DISABLE_REPORT !== '1',
    screenshots: e.WOWLIDATOR_SCREENSHOTS === 'auto' ? undefined : e.WOWLIDATOR_SCREENSHOTS,
    video: e.WOWLIDATOR_VIDEO ?? 'on',
    captureDelayMs: e.WOWLIDATOR_CAPTURE_DELAY_MS ?? DEFAULT_CAPTURE_DELAY_MS,
    healing: e.WOWLIDATOR_DISABLE_HEALING !== '1',
    agentEnabled: e.WOWLIDATOR_DISABLE_AGENT !== '1',
    agentAssist: e.WOWLIDATOR_AGENT_ASSIST === '1',
  };
}

/** True when the provider backing `role` has at least one key available. */
export function hasKeyForRole(config: WowlidatorConfig, role: LlmRole): boolean {
  return (config.apiKeys[config.roles[role].provider]?.length ?? 0) > 0;
}

/** Human-readable routing table, used by `wowlidator doctor` and the CLI banner. */
export function describeRouting(config: WowlidatorConfig): string {
  return LLM_ROLES.map((role) => {
    const entry = config.roles[role];
    const meta = PROVIDER_META[entry.provider];
    const keys = config.apiKeys[entry.provider] ?? [];
    const key =
      keys.length === 0
        ? `MISSING ${meta.envKey}`
        : keys.length === 1
          ? 'key set'
          : `${keys.length} keys set (failover enabled)`;
    return `  ${role.padEnd(9)} ${entry.provider.padEnd(11)} ${entry.modelId.padEnd(34)} ${key}`;
  }).join('\n');
}
