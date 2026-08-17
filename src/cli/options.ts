/**
 * The CLI's option surface: the `CliOptions` shape and the flag-parsing
 * helpers. Split out of cli.ts verbatim.
 */

import type { WowlidatorConfig } from '../config.js';
import type { ScreenshotMode, VideoMode } from '../engine/runner.js';
import type { MutationPolicy } from '../generator/test-generator.js';
import type { LlmFactory } from '../providers/llm-factory.js';

export const SCREENSHOT_MODES = ['auto', 'off', 'on-failure', 'on-event', 'all'] as const;

export interface CliOptions {
  config: WowlidatorConfig;
  factory: LlmFactory;
  cdp: string | undefined;
  cache: string | undefined;
  out: string;
  report: string | undefined;
  reportDir: string;
  reportEnabled: boolean;
  /**
   * What the user asked for. **Undefined means unset**, and is passed through
   * as unset so the runner can pick a mode from whether the run is filmed —
   * see `SmartRunnerOptions.screenshots`. Call sites that are never filmed
   * (the crawler) read it as `?? 'all'`, which is what it always was.
   */
  screenshots: ScreenshotMode | undefined;
  video: VideoMode;
  agentAssist: boolean;
  /**
   * Let the agent steady the page before a generation/authoring capture —
   * wait out spinners, dismiss overlays, prime lazy content. On by default
   * (`--no-agent-capture` disables): the pilot can only look, wait, scroll
   * and dismiss, and an inaccurate capture poisons every test written from
   * it. Degrades silently to an unpiloted capture when the agent role has
   * no key.
   */
  agentCapture: boolean;
  /**
   * In-run step reconstruction: a failed step is rebuilt by the repair model
   * against the live page and retried, up to 3 total tries, before final
   * classification. On by default (`--no-reconstruct` disables); degrades
   * silently when the generator role has no key.
   */
  reconstruct: boolean;
  captureDelayMs: number;
  /**
   * Pause before each step, ms. Undefined lets the runner decide: 1.5s while
   * filming for a viewer (`--video always`), zero otherwise. Set explicitly
   * (`--step-delay 1500` or `WOWLIDATOR_STEP_DELAY=1500`) to pace every run.
   */
  stepDelayMs: number | undefined;
  heal: boolean;
  agent: boolean;
  json: boolean;
  all: boolean;
  focus: string | undefined;
  maxCases: number;
  /** Explicit suite destination. Undefined means "put it with the reports". */
  suite: string | undefined;
  /** Explicit flow destination. Undefined means "put it with the reports". */
  flow: string | undefined;
  /** Page to ground `wowlidator author` against. */
  url: string | undefined;
  run: boolean;
  policy: MutationPolicy;
  updateBaselines: boolean;
  history: boolean;
  /** Where the append-only run index lives. Absolute; see `config.historyPath`. */
  historyPath: string;
  /** Include the repository context graph in `generate` prompts. Default off. */
  context: boolean;
  /**
   * Open the page's menus and disclosures before generating or authoring, so
   * controls that only exist after a click are visible to the model.
   */
  probe: boolean;
  /** How many links `wowlidator crawl` may follow. */
  maxPages: number | undefined;
  /** Healer calls allowed per link during a crawl. */
  maxHeal: number | undefined;
  /** Follow navigational buttons as well as links. Opt-in — see the crawler. */
  followButtons: boolean;
  /** Start or recycle a driveable Chrome before running. Default on. */
  ensureChrome: boolean;
  /** Profile for a browser wowlidator starts itself. */
  chromeProfile: string;
  /**
   * Run without a window. `undefined` means no preference was expressed, which
   * is not the same as `false`: a browser already running is left in whatever
   * mode it is in, rather than being restarted to acquire a window nobody asked
   * for. See `resolveHeadless`.
   */
  headless: boolean | undefined;
  /** Stop the browser afterwards, but only if this process started it. */
  stopChrome: boolean;
  /** Wait for this URL to answer before starting. */
  waitFor: string | undefined;
  /** Open the HTML report when the run finishes. */
  open: boolean;
  /** Per-navigation budget for a crawl, in ms. */
  timeoutMs: number | undefined;
  /** `wowlidator watch` interval, e.g. "15m". */
  every: string | undefined;
  /** Command run on a result change, fed the verdict as JSON on stdin. */
  notify: string | undefined;
  /** Stop watching at the first failure. */
  untilFail: boolean;
  /** Report a known-flaky failure without counting it as one. */
  quarantineFlaky: boolean;
  /** Where to write JUnit XML for CI, if anywhere. */
  junit: string | undefined;
  /** Where to write CTRF JSON for CI, if anywhere. */
  ctrf: string | undefined;
  /** Stop after listing a catalog's claims, before anything is authored or run. */
  claimsOnly: boolean;
  /** Read approved claims from this file instead of extracting them again. */
  claims: string | undefined;
  /** Where `--claims-only` writes the claims it found. */
  claimsOut: string | undefined;
  /** Where `draft` writes the catalog it constructs. */
  catalogOut: string | undefined;
  /** Cap on cases drafted in one go. */
  maxDraftCases: number;
  /** Supporting documents — background for the model, never a source of claims. */
  contextDocs: string[];
  /** Cap on claims read out of one catalog. */
  maxClaims: number;
  /** Project root to index for `context build`/`show` and `generate --context`. */
  root: string | undefined;
  /** Where the context graph is cached. */
  contextOut: string | undefined;
  /** Rebuild the context graph even if its signature is unchanged. */
  force: boolean;
  /** `run`: on failure, ask AI to rewrite the flow and retry. Default off. */
  repair: boolean;
  /** Total attempts for `--repair`, including the first unmodified run. */
  repairAttempts: number;
  /** `--repair`: agent reinvestigates each failure live before a fix is asked for. */
  repairInvestigate: boolean;
  /** `--repair`: a fix may regenerate the failing section from the failed step onward. */
  repairRegenerate: boolean;
  /** OpenAPI/Swagger spec to index — a path or an http(s) URL. */
  openapi: string | undefined;
  /** `generate`: write API tests from the indexed spec instead of reading a page. */
  api: boolean;
  /** Watch the page's HTTP traffic over CDP. Default on. */
  network: boolean;
}

/**
 * Whether this run wants a window, and whether it cares.
 *
 * Three answers, not two. `undefined` — nobody said — is the default, and it is
 * why a browser you already have open is never restarted just to change how it
 * looks. Precedence is the usual one: flag, then environment, then no opinion.
 *
 * `WOWLIDATOR_HEADLESS=1` in the engine's `.env` is how you stop windows
 * appearing for good, rather than remembering a flag on every command. Same
 * place the provider keys and report paths live; the `grimval` wrapper needs no
 * variable of its own, because the engine owns its config.
 */
export function resolveHeadless(flag: boolean, negated: boolean): boolean | undefined {
  if (flag) return true;
  if (negated) return false;
  const set = process.env['WOWLIDATOR_HEADLESS'];
  if (set === undefined || set === '') return undefined;
  return set !== '0' && set.toLowerCase() !== 'false';
}

/**
 * `--screenshots` if given, otherwise whatever the environment configured,
 * otherwise the default.
 *
 * The fallback used to be the literal default, which meant `WOWLIDATOR_SCREENSHOTS`
 * was accepted by `loadConfig`, documented in `.env.example`, and then silently
 * ignored by every CLI command.
 */
export function parseScreenshotMode(
  raw: string | undefined,
  configured: ScreenshotMode | undefined,
): ScreenshotMode | null | undefined {
  if (raw === undefined) return configured;
  // `auto` is how "unset" is said out loud. Without it there is no way to ask
  // for the video-aware default from a command line — and no way at all once
  // WOWLIDATOR_SCREENSHOTS is set in the environment, which is exactly where
  // someone would need to override back to the default for one run.
  if (raw === 'auto') return undefined;
  return (SCREENSHOT_MODES as readonly string[]).includes(raw) ? (raw as ScreenshotMode) : null;
}

/**
 * `--capture-delay` in milliseconds, on the same fallback ladder.
 *
 * Rejects rather than clamps: a delay is paid once per captured step, so
 * `--capture-delay 3000` on a hundred-step run is five minutes of waiting the
 * author probably did not mean to buy, and silently accepting a nonsense value
 * hides it until the run is already slow.
 */
export function parseCaptureDelay(raw: string | undefined, configured: number): number | null {
  if (raw === undefined) return configured;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0 || parsed > 30_000) {
    return null;
  }
  return parsed;
}

/** Commands whose invocation is worth saving as a recallable preset. */
export const LAUNCH_COMMANDS = new Set(['run', 'generate', 'author', 'go', 'crawl', 'watch', 'catalog']);
