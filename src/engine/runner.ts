/**
 * Execution plane: a thin, fast Playwright wrapper.
 *
 * Every action takes the fast path first, with a deliberately short timeout —
 * a selector that is going to work works immediately, and waiting longer only
 * slows down the failure we actually care about. Only once the fast path has
 * failed do we escalate: a cheap check for a blocking dialog, then cached
 * repair, then (and only then) the JIT healer.
 *
 * The escalation ladder is the whole design. Steps 1, 1.5, and 2 cost nothing.
 */

import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import { rm } from 'node:fs/promises';

import { ApiActions, type FlowRequestSpec } from '../api/api-actions.js';
import { BrowserTransport, FetchTransport, type ApiTransport } from '../api/api-client.js';
import {
  NetworkObserver,
  describeCall,
  isBlockingFailure,
  type NetworkCall,
} from '../api/network-observer.js';
import {
  ObservationTruncatedError,
  ObservationUnavailableError,
  matchExpectedCalls,
  matchTable,
  neverViolations,
  describeExpected,
  type ExpectedCall,
  type FlowExpectCallsSpec,
} from '../api/expect-calls.js';
import { isSecretStepValue, maskSecret } from '../api/redact.js';
import type { RedactionPolicy } from '../api/redact.js';
import { VariableStore } from '../api/variables.js';
import { DbActions } from '../db/db-actions.js';
import type {
  FlowDbCalledSpec,
  FlowDbDeltaSpec,
  FlowDbRowSpec,
  FlowDbSnapshotSpec,
  FlowDbUnchangedSpec,
} from '../db/db-actions.js';
import { defaultDbConfig, type DbClient, type DbConfig } from '../db/client.js';
import {
  DEFAULT_CAPTURE_DELAY_MS,
  captureEvidence,
  type EvidenceKind,
  type ScreenshotMode,
} from './evidence.js';
import {
  captionVideo,
  installCursorOverlay,
  keepCaption,
  sealVideo,
  videoSize,
  videoTempDir,
  type VideoCut,
  type VideoMode,
} from './video.js';
import { CacheManager } from '../cache/cache-manager.js';
import { measureCoverage } from '../coverage/ax-coverage.js';
import {
  DEFAULT_BASELINE_DIR,
  baselinePath,
  compareSnapshot,
  isVisualFailure,
} from '../visual/baseline.js';
import { RunHistory, analyseTrend } from '../history/run-history.js';
import { HealFailedError, HealUnavailableError, JitHealer, captureAxTree } from '../healer/jit-healer.js';
import type { FlowRepairModel } from '../repair/flow-repair-model.js';
import { WorkflowAgent, cacheAgentMemory, type AgentDbProbe, type PlanStep } from '../orchestrator/workflow-agent.js';
import { SessionVault, type StoredSession } from './session-vault.js';

/**
 * One recorded action of a `workflow` step's deterministic script — the
 * agent's own `PlanStep` shape, re-exported under the flow file's name for
 * it so flow JSON stays readable without the orchestrator's vocabulary.
 */
export type WorkflowScriptStep = PlanStep;
import { selectorName } from '../orchestrator/agent-guards.js';
import {
  AUTO_PROVE_CONFIDENCE,
  autoReviewRuling,
  reviewPairs,
  type ReviewJudge,
} from './review-judge.js';
import {
  agentModelUnavailable,
  goalEvidence,
  looksLikeSignIn,
} from '../orchestrator/goal-evidence.js';
import { performSignIn, performSignOut, acceptConsentGate, acceptConsentGateAnywhere, CONSENT_GATE_URL_PATTERN } from './sign-in.js';
import { generateValue, type DataKind } from '../data/mock-data.js';
import type { DataModel } from '../data/data-model.js';
import { describeDialog, findDismissButton, openDialogNow, waitForDialog } from './modal.js';
import {
  exactTextSelector,
  isTextSelector,
  qualifyBareRole,
  relaxRoleName,
  relaxTextSelector,
  sanitizeSelector,
} from './selector.js';
import { expandFlow, hasIncludes } from './compose.js';
import {
  BACKEND_TIER_ACTIONS,
  BROWSER_FREE_ACTIONS,
  ProofBundleBuilder,
  type AgentRecord,
  type StepDecision,
  type DataCaseResult,
  type DataRetryAttempt,
  type DataRetryRecord,
  type Defect,
  type DialogRecord,
  type GenerationProvenance,
  type HealRecord,
  type ProofBundle,
  type ProofStep,
  type RejectedHeal,
  type ResolutionSource,
} from './proof-bundle.js';
import { inferPolarity, type TestPolarity } from './polarity.js';

export const DEFAULT_CDP_URL = 'http://localhost:9222';
/** Fast-path timeout. Short by design — see the module comment. */
export const DEFAULT_FAST_TIMEOUT_MS = 2_000;

/**
 * Budget for the one-attribute read that decides whether a field is a
 * password. Deliberately tiny: the element has just been resolved and acted
 * on, so it is there now or the answer does not matter — and a masking
 * decision must never be able to slow a step down, let alone fail one.
 */
const ATTRIBUTE_READ_TIMEOUT_MS = 250;
/** Timeout for a cached or freshly healed selector, which we expect to work. */
export const DEFAULT_HEALED_TIMEOUT_MS = 10_000;

// Re-exported for callers that configure a run through the runner's surface
// (`src/config.ts`); the rules themselves live in `evidence.ts`/`video.ts`.
export type { ScreenshotMode } from './evidence.js';
export type { VideoMode } from './video.js';

export interface SmartRunnerOptions {
  /** CDP endpoint of an already-running Chrome. Connect-only; never launches. */
  cdpUrl?: string | undefined;
  cache: CacheManager;
  bundle: ProofBundleBuilder;
  /** Omit or pass `null` to run with healing disabled (pure execution plane). */
  healer?: JitHealer | null | undefined;
  /** Omit or pass `null` to disable multi-page agentic navigation. */
  agent?: WorkflowAgent | null | undefined;
  /**
   * Consulted only by a `fillRetry` step whose `kind` is `custom`. Every
   * other kind generates deterministically and never needs this at all.
   */
  dataModel?: DataModel | null | undefined;
  /**
   * `Flow.caseContext`, threaded to the runtime model roles: every heal and
   * every agent turn carries the test case the step serves. Context only —
   * it changes what those models know, never what any step claims.
   */
  caseContext?: string | undefined;
  fastTimeoutMs?: number | undefined;
  healedTimeoutMs?: number | undefined;
  /**
   * Film the run, with a drawn-in pointer so clicks are visible. Default `on`.
   *
   * Recording requires a context wowlidator creates, so turning it on means a
   * fresh cookie jar rather than the one the attached browser already had —
   * see `video.ts`. That is the reason this is a switch and not an assumption.
   */
  video?: VideoMode | undefined;
  /**
   * Give this run its own browser context even when it is not being filmed.
   *
   * Two runs sharing `browser.contexts()[0]` share its pages, and a suite that
   * runs its cases concurrently would have them clicking in each other's tabs
   * — the exact interleaving the panel's one-browser-at-a-time rule exists to
   * prevent, moved inside a single command. A recorded run already gets its
   * own context for an unrelated reason (recording is a property of a context),
   * which is why this only has to cover `--video off`.
   *
   * The session is carried across exactly as the recording path carries it, so
   * isolation does not silently sign the run out.
   */
  isolate?: boolean | undefined;
  /**
   * Whether a context this run creates starts with the attached browser's
   * session (cookies + storage). Default true — the reason a filmed run can
   * still test a page someone signed into by hand. `false` starts EMPTY, and
   * is what a flow that signs in ITSELF wants: an inherited session is a
   * different account signed in before its first step, and on this
   * application a stale admin session left in the browser by an earlier run
   * put every persona's case on the admin's landing page instead of the login
   * form. `runFlow` sets it from the flow's own shape — see `signsInItself`.
   */
  inheritSession?: boolean | undefined;

  /**
   * A session banked by an earlier case of the same suite, injected into
   * this run's own context (`SessionVault` as data — contexts stay
   * isolated). Used only when `inheritSession` allows inheriting at all;
   * outranks the attached browser's state when present.
   */
  sessionState?: StoredSession | undefined;

  /**
   * Stills.
   *
   * Left unset, this follows the recording: with video on it drops to
   * `on-failure`, because the film already carries every other step and a
   * per-step still would be the same evidence twice at many times the size.
   * With video off it stays at `all`, which is what it always was. Setting it
   * explicitly overrides that in either direction — a run can have both.
   */
  screenshots?: ScreenshotMode | undefined;
  /**
   * Pause before each screenshot, so the page has painted. A navigation waits
   * for `domcontentloaded`, which is earlier than "there is something to look
   * at"; see `evidence.ts`. Zero captures as soon as the load states allow.
   */
  captureDelayMs?: number | undefined;
  /**
   * Let the agent try to make a control reachable when the healer cannot find
   * it. Default false — see `#agentRescue` for why this is opt-in.
   */
  agentAssist?: boolean | undefined;
  /**
   * In-run step reconstruction: on a step's failure, ask this model for a
   * rebuilt step against the live page and retry, up to
   * `STEP_RECONSTRUCT_TRIES` total tries, before final classification.
   * Attempts a rescue supersedes count toward nothing; every rescue files a
   * `medium` drift defect; an assertion keeps its claim verbatim (only
   * preparation may be inserted before it). Null/absent disables.
   */
  stepRepair?: FlowRepairModel | null | undefined;
  /**
   * Pause before each step, in ms. Zero (the default) keeps the hot path
   * hot. Under `video: 'always'` the default becomes
   * `DEMONSTRATION_STEP_DELAY_MS`: that mode records a film for a human to
   * watch, and a run that blurs through five states in two seconds
   * demonstrates nothing — the pause is what lets each state be seen, with
   * the caption naming the step about to happen.
   */
  stepDelayMs?: number | undefined;
  /** Measure AX-tree coverage at the end of the run. Default true. */
  coverage?: boolean | undefined;
  /** Where visual baselines live. */
  baselineDir?: string | undefined;
  /** Rewrite baselines instead of comparing against them. */
  updateBaselines?: boolean | undefined;
  /**
   * Watch the page's HTTP traffic over CDP so a step that failed because a
   * request failed can say so — and can decline to pay for a heal that would
   * only repair onto the resulting error state. Default true; it costs one
   * extra CDP session and no model call.
   */
  network?: boolean | undefined;
  /** How much of an observed request may be recorded. Defaults to redacting. */
  networkRedaction?: RedactionPolicy | undefined;
  /**
   * The credentials this run was told to sign in with (`--as`).
   *
   * Held for ONE purpose: masking. A value the person named as a credential is
   * masked wherever it lands in a record, whatever the field looks like and
   * whatever the DOM says — their statement outranks any inference this code
   * could make. The email is deliberately NOT masked: it is not a secret, and
   * it is frequently the evidence that says which persona a run signed in as.
   */
  credentials?: { email: string; password: string } | undefined;
  /**
   * Whether the flow contains its own sign-in (`signsInItself`). Decides the
   * session bootstrap below: a flow that types credentials must be the one
   * doing the signing in, and the harness must never race it.
   */
  flowSignsInItself?: boolean | undefined;
  /**
   * Ring-buffer cap for the observer. The default (300) suits per-step
   * evidence; a long journey ending in an `expectCalls` over the whole run
   * may need more — a `never` claim over a window that dropped calls is
   * blocked, not passed, and this is the dial that prevents that.
   */
  networkMaxCalls?: number | undefined;
  /**
   * Transport for `request` steps. Defaults to the browser context's own,
   * which inherits the session the UI steps established — that inheritance is
   * the whole reason API steps live in the same flow as UI steps.
   */
  transport?: ApiTransport | null | undefined;
  /**
   * Database connection for DB verification steps. Defaults to
   * `WOWLIDATOR_DB_URL` (see `defaultDbConfig`); `null` disables. Connection
   * is lazy — a run with no DB steps never opens one and never demands the
   * driver be installed.
   */
  db?: DbConfig | null | undefined;
  /** Pre-built DB client — the embedder/test seam. Wins over `db`. */
  dbClient?: DbClient | null | undefined;
}

/**
 * How many observed calls to attach to a failed step.
 *
 * Enough to see the pattern, few enough that a chatty SPA doesn't turn one red
 * step into a hundred rows nobody reads.
 */
const MAX_STEP_EVIDENCE = 8;

/**
 * How far back before a step began to look for the request that explains it.
 *
 * Almost never zero, and that's the whole point: the request that starves a
 * step is usually fired by the interaction *before* it. A `click` returns as
 * soon as the click lands, the XHR it triggered is still in flight, and it is
 * the following `expectVisible` that fails. A window starting at the failing
 * step's own start would miss exactly the call that matters.
 *
 * The cost of the window being too wide is a correlation reported for an
 * unrelated failure — which is why every message this produces says
 * "while this step was waiting", not "because of". The cost of it being too
 * narrow is paying for a heal that repairs onto an error banner, which is the
 * failure mode this whole rung exists to prevent.
 */
const NETWORK_LOOKBACK_MS = 3_000;

/** How often `expectCalls` re-reads the window while its budget lasts. */
const SEQUENCE_POLL_MS = 150;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One value in a data-driven step, with what should hold after filling it. */
export interface DataCase {
  value: string;
  /** Human label, e.g. "empty", "max length", "unicode". */
  label?: string | undefined;
  expectText?: { selector: string; value: string } | undefined;
  expectVisible?: string | undefined;
  expectHidden?: string | undefined;
}

interface ResolveResult<T> {
  value: T;
  resolution: ResolutionSource;
  resolvedSelector: string;
  heal?: HealRecord | undefined;
  dialog?: DialogRecord | undefined;
  /** What the agent did to make the control reachable, when it was called in. */
  agent?: AgentRecord | undefined;
  /** What the agent judged and chose, when it was asked to decide for itself. */
  decision?: StepDecision | undefined;
}

/**
 * Minimal shape of the browser globals used inside `page.evaluate`.
 *
 * Declared locally rather than pulling in the DOM lib, which would make every
 * browser global visible to Node-side code and hide real mistakes.
 */
interface BrowserStorage {
  setItem(key: string, value: string): void;
  clear(): void;
}

interface BrowserGlobals {
  localStorage: BrowserStorage;
  sessionStorage: BrowserStorage;
}

/** What one scrollability reading tells us. */
interface ScrollMeasurement {
  /** How to name the thing in an error message. */
  what: string;
  /** Content is taller than the box. */
  overflows: boolean;
  /** And the scroll position actually moves — overflow a user can reach. */
  moved: boolean;
  scrollSize: number;
  clientSize: number;
}

interface ScrollTarget {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
}

interface ScrollStyled {
  readonly __styled: unique symbol;
}

interface BrowserScroll {
  document: {
    querySelector(selector: string): unknown;
    scrollingElement: unknown;
  };
  getComputedStyle(element: ScrollStyled): { overflowY?: string; overflow?: string };
}

interface BrowserDocument {
  document: {
    body: {
      hasAttribute(name: string): boolean;
      setAttribute(name: string, value: string): void;
      removeAttribute(name: string): void;
      focus(): void;
    };
  };
}

/** Thrown when every rung of the escalation ladder has failed. */
/**
 * The run is stranded on a sign-in page it never asked to be on.
 *
 * Fatal on purpose, and the only error in the engine that stops a flow dead.
 * Everything after a lost session is being asserted against the login screen,
 * so continuing produces two kinds of garbage and no information: steps that
 * fail because the feature is not on this page, and — far worse — steps the
 * healer *rescues* by repairing them onto whatever the login page happens to
 * offer. That is exactly how PB_01_01 came to report
 * `waitFor role=heading[name="Sign in"] … passed (jit)`: a green step, on a
 * page the test was never meant to reach.
 *
 * Same reasoning as rung 6 of the ladder declining to heal after a failed
 * request: when the precondition is gone, a repair can only fail identically
 * or succeed against the wrong thing, and the second outcome is worse than
 * stopping.
 */
export class SessionLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionLostError';
  }
}

/**
 * The browser (or its page/context) died mid-run.
 *
 * Fatal, like `SessionLostError`, and for the same shape of reason turned up
 * to eleven: every later step can only fail, and each failure files a defect
 * against an application that was never reached. Seen live in PB-02-01's
 * predecessor run, where two `goto`s failed with "Target page, context or
 * browser has been closed" and fourteen "defects" followed. Unlike a lost
 * session, teardown is *skipped* — there is no browser to tear down in — and
 * the run classifies as an environment problem, not a test result.
 */
export class BrowserGoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserGoneError';
  }
}

/** Does this error mean the browser itself went away? */
export function isBrowserGone(message: string): boolean {
  return /Target (page|context|browser).* (has been closed|closed)|browser has been closed|Browser closed|Target closed/i.test(
    message,
  );
}

export class StepResolutionError extends Error {
  readonly selector: string;
  readonly attempts: string[];
  /** What the page was showing — stamped by the denial guard, carried to the step. */
  pageContext?: string[] | undefined;
  /** Repair candidates the healer proposed and the ladder refused. */
  rejectedHeals?: RejectedHeal[] | undefined;
  /**
   * What the agent decided here, when it was consulted and the step still
   * failed. Carried on the error because that is the only channel a failing
   * step has — and "the agent looked and chose to do nothing" is precisely
   * what a reader of a dead-ended step needs to see.
   */
  decision?: StepDecision | undefined;

  constructor(selector: string, attempts: string[]) {
    // "Could not resolve" must not headline a failure where every rung DID
    // resolve the selector and the content behind it was wrong — that header
    // reads as "the control is missing" and files the wrong defect. Seen
    // live: `expectText role=main` resolved instantly on every rung, failed
    // on text, and the report said the control was never found.
    const contentOnly =
      attempts.length > 0 && attempts.every((line) => /expected text to contain/i.test(line));
    super(
      contentOnly
        ? `"${selector}" resolved, but its content did not hold after ${attempts.length} attempt(s):\n  - ${attempts.join('\n  - ')}`
        : `could not resolve "${selector}" after ${attempts.length} attempt(s):\n  - ${attempts.join('\n  - ')}`,
    );
    this.name = 'StepResolutionError';
    this.selector = selector;
    this.attempts = attempts;
  }
}

/**
 * The viewport every wowlidator page runs at.
 *
 * Connecting over CDP inherits whatever size the Chrome window happens to be
 * — often a small window on a laptop — so captures came out narrow and, worse,
 * responsive layouts hid their desktop-only controls (this app's tier chips
 * are `hidden xl:inline-flex`, gone below 1280px). Pinning a full-width
 * desktop viewport makes runs, generation, and evidence all see the same
 * layout regardless of the window. `WOWLIDATOR_VIEWPORT=1440x900` overrides;
 * `WOWLIDATOR_VIEWPORT=off` keeps the window's own size.
 */
const DEFAULT_VIEWPORT = { width: 1920, height: 1080 } as const;

function configuredViewport(
  raw: string | undefined = process.env['WOWLIDATOR_VIEWPORT'],
): { width: number; height: number } | null {
  const value = raw?.trim() ?? '';
  if (value === '') return DEFAULT_VIEWPORT;
  if (/^(off|none|0)$/i.test(value)) return null;
  const match = /^(\d{3,5})\s*[xX]\s*(\d{3,5})$/.exec(value);
  if (!match) return DEFAULT_VIEWPORT;
  return { width: Number(match[1]), height: Number(match[2]) };
}

/** What a recording context managed to bring over from the browser it films. */
interface SessionInheritance {
  state: Awaited<ReturnType<BrowserContext['storageState']>> | undefined;
  /** Cookies the attached browser had, whether or not they came across. */
  available: number;
  /** Why nothing was inherited, when that is the answer. */
  error?: string | undefined;
  /** Nothing was inherited ON PURPOSE — the flow signs in itself. Not a finding. */
  declined?: boolean | undefined;
  /** The state came from the suite's own vault, not the attached browser. */
  fromSuite?: boolean | undefined;
}

/**
 * Copy the attached browser's session so a filmed run is the same run.
 *
 * Never throws: a browser that will not hand over its state is a reason to
 * report a run that started signed out, not to refuse to run at all. The
 * counts come back either way so the caller can say what happened — silence
 * here is what turned a lost session into six invented frontend defects.
 */
async function inheritSession(browser: Browser): Promise<SessionInheritance> {
  const source = browser.contexts()[0];
  if (!source) return { state: undefined, available: 0 };
  try {
    const state = await source.storageState();
    return { state, available: state.cookies.length };
  } catch (error) {
    return { state: undefined, available: 0, error: describe(error) };
  }
}

/** Apply the configured viewport. Best-effort — a page that refuses stays as it is. */
async function applyViewport(page: Page): Promise<void> {
  const size = configuredViewport();
  if (size === null) return;
  await page.setViewportSize(size).catch(() => undefined);
}

/**
 * Turn what the agent actually returned into the decision recorded on a step.
 *
 * Deliberately derivative: every word here comes from the agent's own output —
 * `AgentRecord.summary` and the per-action `reasoning` it already produces —
 * rather than a second model call asked to narrate the first. A field that
 * cannot be filled honestly is left empty; synthesising words the agent never
 * said would put a claim in the report wearing the agent's voice.
 *
 * The split matters more than the wording. `observed`/`decided`/`because` are
 * claims; `actions` are the acts; `resolved` is whether the author's own
 * selector then worked, and is the only one of the four that is evidence.
 */
export function decisionFrom(
  record: AgentRecord,
  resolved: boolean,
): StepDecision {
  // The first acting turn is the decision — `finish` is the agent stopping,
  // not choosing. An agent that only ever called `finish` decided to do
  // nothing, and that is recorded as exactly that rather than as an absence.
  const acted = record.actions.filter((a) => a.action !== 'finish');
  const first = acted[0];
  return {
    // What it saw is only ever stated in the reasoning of the turn it acted
    // on; with no acting turn there is nothing it claimed to see, and an
    // empty string says so without inventing a sighting.
    observed: first?.reasoning ?? '',
    decided: first
      ? `${first.action}${first.selector ? ` ${first.selector}` : ''}${
          first.value ? ` = ${first.value}` : ''
        }`
      : 'nothing — the agent judged that no interaction was in the way',
    because: record.summary,
    actions: [...record.actions],
    resolved,
    model: record.model,
  };
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message.split('\n')[0] ?? error.message;
  return String(error);
}

/**
 * Assertions that claim *presence* — "this is shown" — and nothing else.
 * These are the only actions the ladder's narrow rung may satisfy with "one
 * of several matches": any element a text selector matched contains the
 * asserted text, so any of them proves the claim. An action that *does*
 * something (click, fill) is excluded on purpose — acting on an arbitrary
 * match changes what the test exercises.
 */
const PRESENCE_ACTIONS: ReadonlySet<string> = new Set(['expectText', 'expectVisible']);

/**
 * How long an ordinary click waits for a popup it did not declare.
 *
 * A `window.open` fired inside a click handler spawns its page while the
 * click is still being awaited, so the event is almost always already there;
 * this is the small margin for the stragglers (400ms — 250 proved tight on a
 * Chrome carrying a full test suite), paid on every click that
 * opens nothing — which is why it is small. A link that *declares*
 * `target="_blank"` gets the healed timeout instead.
 */
const POPUP_GRACE_MS = 400;

/**
 * Per-keystroke pacing for the `type` action — fast enough not to drag a run,
 * slow enough that per-keystroke listeners (debounced autocompletes) see
 * distinct events rather than one burst.
 */
const TYPE_KEY_DELAY_MS = 40;

/** Step pacing while filming for a human viewer (`video: 'always'`). */
export const DEMONSTRATION_STEP_DELAY_MS = 1_500;

/** Animation/state classes that churn on overlays and make a selector stale. */
const OVERLAY_STATE_CLASSES =
  /^(animating|transition|fade|in|out|visible|active|show|showing|open|opening|hidden)$/i;

/**
 * The element Playwright says intercepted a pointer, parsed out of its own
 * actionability log. This is what makes the overlay rung evidence-driven
 * rather than heuristic: the engine names the exact blocker
 * ("<div class=\"ui dimmer modals page …\"> intercepts pointer events"),
 * so acting on it overstates nothing — precisely the ARIA-only modal
 * detector's documented blind spot (a Semantic-UI dimmer carries no
 * `role=dialog`; found live on homepro.co.th's promo modal).
 */
export function parseInterception(
  message: string,
): { css: string | null; label: string } | null {
  // Line-anchored: the actionability log also prints the element the click
  // *resolved to* a few lines earlier, and a lazy match across the whole
  // message names that instead of the blocker.
  const line = message
    .split('\n')
    .find((entry) => entry.includes('intercepts pointer events'));
  if (line === undefined) return null;
  // The line can name two elements — "<p>…</p> from <div class=…>…</div>
  // subtree intercepts pointer events" — and the *last* one is the overlay
  // container; the first is just whichever leaf sat under the pointer.
  const matches = [...line.matchAll(/<(\w+)([^>]*)>/g)];
  const match = matches[matches.length - 1];
  if (!match) return null;
  const tag = match[1]!.toLowerCase();
  const attrs = match[2] ?? '';
  const classMatch = /class="([^"]*)"/.exec(attrs);
  const classes = (classMatch?.[1] ?? '')
    .split(/\s+/)
    .filter((c) => c !== '' && !OVERLAY_STATE_CLASSES.test(c))
    .slice(0, 3);
  const css = classes.length > 0 ? `${tag}.${classes.join('.')}` : null;
  const label = css ?? `<${tag}> overlay`;
  return { css, label };
}

/**
 * Headings that mean "you are not allowed to see this page".
 *
 * Deliberately narrow: only phrases that name an authorization failure
 * outright, in the scripts this codebase already meets. A missed denial page
 * costs one wasted heal; a false positive would suppress healing on a page
 * that merely mentions permissions — understate, never overstate, the same
 * rule `ax-coverage.ts` applies to attribution.
 */
/**
 * How much of a live-region message is kept, and how many. A toast is a
 * sentence; a page mid-error can hold several, and `pageContext` is read by a
 * human at the top of a failure, not scrolled through.
 */
const PAGE_MESSAGE_MAX = 2;
const PAGE_MESSAGE_MAX_CHARS = 160;

const DENIAL_HEADING_PATTERN =
  /access denied|forbidden|not authori[sz]ed|unauthori[sz]ed|permission denied|no permission|ไม่มีสิทธิ์|\b403\b/i;

const LATIN_LETTER = /[A-Za-zÀ-ɏ]/;
const NON_LATIN_LETTER = /[Ͱ-ϿЀ-ӿ֐-׿؀-ۿ฀-๿぀-ヿ一-鿿가-힯]/;

/**
 * A one-line diagnosis for a text assertion that failed across a script
 * boundary: the expected text is in one writing system and the page renders
 * its content in another. Deterministic and purely advisory — it never
 * changes the verdict, it explains it. Without it PB-05-01's report read as
 * "the detail page is broken" when the page had rendered the same employee's
 * name in Thai.
 */
/**
 * A short window of the page's actual text around the part that satisfied the
 * claim — enough to show the value in its context ("119 days remaining", not
 * just "days") without inlining a whole page of innerText into the bundle.
 */
function excerptAround(actual: string, matched: string): string {
  const text = actual.trim();
  if (text.length <= 200) return text;
  const at = text.indexOf(matched);
  if (at === -1) return text.slice(0, 200);
  const start = Math.max(0, at - 60);
  const end = Math.min(text.length, at + matched.length + 60);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

export function scriptMismatchNote(expected: string, actual: string): string {
  const expectedLatin = LATIN_LETTER.test(expected) && !NON_LATIN_LETTER.test(expected);
  const expectedOther = NON_LATIN_LETTER.test(expected) && !LATIN_LETTER.test(expected);
  const actualHasOther = NON_LATIN_LETTER.test(actual);
  const actualHasLatin = LATIN_LETTER.test(actual);
  const crossed = (expectedLatin && actualHasOther) || (expectedOther && actualHasLatin);
  if (!crossed) return '';
  // One line on purpose: the ladder's attempts trace keeps an error's first
  // line only, and a diagnosis that starts on line two never reaches a reader.
  return (
    ' — note: the page renders content in a different script than the expected text; ' +
    'this may be a language rendering, not a missing feature. If the claim is not about ' +
    'language, assert a language-neutral anchor (an ID, code or number) or list the ' +
    "accepted renderings in the step's \"anyOf\"."
  );
}

/**
 * Actions that may legitimately change the page.
 *
 * Used to tell "the test navigated" from "the application navigated" — see
 * `#flagUnrequestedNavigation`. A click can follow a link, a `goto` obviously
 * moves, and the agent drives the browser wholesale; everything else that
 * changes the URL did so without being asked.
 */
const NAVIGATING_ACTIONS: ReadonlySet<string> = new Set([
  'goto',
  'click',
  'press',
  'back',
  'forward',
  'workflow',
  'closeModal',
]);

/** Whether two recorded URLs are different pages, ignoring the query and hash. */
function differentPage(before: string, after: string): boolean {
  try {
    const a = new URL(before);
    const b = new URL(after);
    return a.origin !== b.origin || a.pathname !== b.pathname;
  } catch {
    return false;
  }
}

/**
 * Whether this URL can hold web storage at all.
 *
 * Only http and https get a storage origin. `about:blank` — where every page
 * starts, and where a flow sits until its first `goto` — is opaque, and so are
 * `file:`, `data:` and `chrome:`; touching `localStorage` on any of them throws
 * a `SecurityError` rather than returning empty. Decided by inspecting the URL,
 * the same way `isBrowserFree` decides whether a flow needs a browser: it cannot
 * be wrong, and it cannot be confused with storage that a real origin has
 * genuinely refused.
 */
export function hasStorableOrigin(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

export class SmartRunner {
  /**
   * Mutable on purpose: a click on a `target="_blank"` link navigates a page
   * this runner would otherwise never watch, and adopting the popup (see
   * `#adoptPage`) is what keeps the flow on the journey the user is on.
   */
  page: Page;
  readonly bundle: ProofBundleBuilder;

  readonly #browser: Browser;
  readonly #context: BrowserContext;
  readonly #cache: CacheManager;
  readonly #healer: JitHealer | null;
  readonly #agent: WorkflowAgent | null;
  readonly #caseContext: string | undefined;
  readonly #dataModel: DataModel | null;
  readonly #fastTimeoutMs: number;
  readonly #healedTimeoutMs: number;
  readonly #screenshots: ScreenshotMode;
  readonly #captureDelayMs: number;
  /**
   * Set only when this runner created a recording context, which is also the
   * only case in which it may close one. An embedder that came in through
   * `attach()` owns its own context and its own video, if any.
   */
  #video: { dir: string; size: { width: number; height: number } } | null = null;
  /** How this run is filmed — `'always'` keeps the whole recording on a pass. */
  #videoMode: VideoMode = 'on';
  /** Pause before each step. See `SmartRunnerOptions.stepDelayMs`. */
  #stepDelayMs = 0;
  /** The caption now showing, re-applied whenever a navigation wipes it. */
  #caption = '';
  readonly #agentAssist: boolean;
  /**
   * Selectors that already exhausted the ladder in this run, keyed by
   * `url :: selector`, valued with the step index that established it. Never
   * persisted — a negative result belongs to this run's page state only.
   */
  readonly #deadResolutions = new Map<string, number>();
  /** Pages this runner drove and then navigated away from, via popup adoption. */
  readonly #pagesLeftBehind: Page[] = [];
  /**
   * Repair model for in-run step reconstruction, or null. Public and
   * readonly: `executeSteps` (a module function, not a method) drives the
   * retry loop and needs to consult it.
   */
  readonly stepRepair: FlowRepairModel | null;
  /** Where the previous step's network mark sat — see `#takeNetMark`. */
  #previousNetMark: number | undefined;
  /** Lower bound of the current step's evidence window. */
  #evidenceFloorMs: number | undefined;
  readonly #coverage: boolean;
  readonly #baselineDir: string;
  readonly #updateBaselines: boolean;
  readonly #networkEnabled: boolean;
  readonly #networkRedaction: RedactionPolicy;
  /**
   * Values the person named as secret via `--as`. Masked wherever they land in
   * a record — see `#maskValue`. A set, so the check stays exact-match: no
   * substring cleverness, which would mask an unrelated field that happened to
   * contain the password as a fragment.
   */
  readonly #secretValues: ReadonlySet<string>;
  readonly #networkMaxCalls: number | undefined;
  #network: NetworkObserver | null = null;
  readonly #api: ApiActions;
  readonly #db: DbActions;
  /**
   * Where the last `expectCalls` window ended — consecutive `expectCalls`
   * steps verify consecutive stretches of the journey. Deliberately not the
   * `#evidenceFloorMs` machinery: that floor reaches back into the previous
   * step by design, which is right for failure evidence and wrong for a
   * window that must not double-count.
   */
  #sequenceMark = 0;
  #defectSeq = 0;
  #ownsPage = true;
  /** Path of the most recent `goto`, and whether that goto asked for a sign-in page. */
  #lastGotoPath: string | null = null;
  #lastGotoAskedSignIn = false;
  #lastAction: string | null = null;
  #strandedReported = false;
  /**
   * A credential submit fired, the hydration race ate it, and the replay did
   * not rescue it — so this run holds no session. Positive evidence only: set
   * from the same signatures `nativeFormResubmitDetected` and
   * `fillsLostToHydration` produce, never from a page merely looking like a
   * login screen. See `#strandedMessage`.
   */
  #signInDidNotTake = false;
  /** `--as`, for the session bootstrap; masking holds them separately. */
  #credentials: { email: string; password: string } | undefined;
  #flowSignsInItself = false;
  /** The bootstrap runs once per run — a second bounce is a real finding. */
  #sessionBootstrapTried = false;
  /** Only a context this runner created may be closed by it — see `close()`. */
  #ownsContext = false;

  private constructor(
    browser: Browser,
    context: BrowserContext,
    page: Page,
    options: SmartRunnerOptions,
  ) {
    this.#browser = browser;
    this.#context = context;
    this.page = page;
    this.bundle = options.bundle;
    this.#cache = options.cache;
    this.#healer = options.healer ?? null;
    this.#agent = options.agent ?? null;
    this.#dataModel = options.dataModel ?? null;
    this.#caseContext = options.caseContext;
    this.#fastTimeoutMs = options.fastTimeoutMs ?? DEFAULT_FAST_TIMEOUT_MS;
    this.#healedTimeoutMs = options.healedTimeoutMs ?? DEFAULT_HEALED_TIMEOUT_MS;
    this.#screenshots =
      options.screenshots ?? ((options.video ?? 'on') !== 'off' ? 'on-failure' : 'all');
    this.#captureDelayMs = options.captureDelayMs ?? DEFAULT_CAPTURE_DELAY_MS;
    this.#agentAssist = options.agentAssist ?? false;
    this.stepRepair = options.stepRepair ?? null;
    this.#stepDelayMs =
      options.stepDelayMs ?? ((options.video ?? 'on') === 'always' ? DEMONSTRATION_STEP_DELAY_MS : 0);
    this.#coverage = options.coverage ?? true;
    this.#baselineDir = options.baselineDir ?? DEFAULT_BASELINE_DIR;
    this.#updateBaselines = options.updateBaselines ?? false;
    this.#networkEnabled = options.network ?? true;
    this.#networkRedaction = options.networkRedaction ?? {};
    // Only the password. The email is not a secret and is the evidence that
    // says which persona signed in.
    this.#secretValues = new Set(
      options.credentials?.password ? [options.credentials.password] : [],
    );
    this.#credentials = options.credentials;
    this.#flowSignsInItself = options.flowSignsInItself ?? false;
    this.#networkMaxCalls = options.networkMaxCalls;
    this.#sequenceMark = Date.now();
    // One store, both action families: a `request` step saves `{{orderId}}`
    // and an `expectDbRow` keys on it — two stores would make one name mean
    // two different things in one flow.
    const variables = new VariableStore();
    const recordDefect = (
      category: Defect['category'],
      severity: Defect['severity'],
      title: string,
      detail: string,
    ): void => this.#recordRuntimeDefect(category, severity, title, detail, undefined);
    this.#api = new ApiActions({
      transport: options.transport ?? new BrowserTransport(context),
      bundle: this.bundle,
      variables,
      redaction: this.#networkRedaction,
      currentUrl: () => this.#currentUrl(),
      recordDefect,
    });
    this.#db = new DbActions({
      db: options.db === undefined ? defaultDbConfig() : options.db,
      client: options.dbClient,
      bundle: this.bundle,
      variables,
      currentUrl: () => this.#currentUrl(),
      // Read only after a DB check has already failed, and only to separate
      // "the write was refused" from "no write was ever sent". GET and HEAD
      // cannot change state, so they are not evidence that anything tried.
      // The browser-free construction below passes none of this: an API flow
      // has no page to watch, and no witness means no attribution, which is
      // exactly the behaviour this had before.
      writeWitness: () => {
        const observer = this.#network;
        if (!observer) return { observing: false, total: 0, mutating: 0 };
        const calls = observer.all();
        return {
          observing: true,
          total: calls.length,
          mutating: calls.filter((call) => !/^(GET|HEAD)$/i.test(call.method)).length,
        };
      },
      recordDefect,
    });
  }

  /** Values saved by `request` steps, for `{{name}}` interpolation later. */
  get variables(): VariableStore {
    return this.#api.variables;
  }

  /**
   * Attach to a running browser over CDP. This never launches Chrome — start
   * one with `--remote-debugging-port=9222` first (`npm run chrome`).
   */
  static async connect(options: SmartRunnerOptions): Promise<SmartRunner> {
    const cdpUrl = options.cdpUrl ?? DEFAULT_CDP_URL;

    let browser: Browser;
    try {
      browser = await chromium.connectOverCDP(cdpUrl);
    } catch (error) {
      throw new Error(
        `could not attach to a browser at ${cdpUrl}: ${describe(error)}\n` +
          'Start Chrome with --remote-debugging-port first (npm run chrome).',
      );
    }

    // Recording is a property of a context, set when the context is created,
    // and there is no way to switch it on for one that already exists. So a
    // recorded run gets its own context — and with it its own cookie jar,
    // which is the cost of filming and the reason `--video off` exists.
    const recording = (options.video ?? 'on') !== 'off';
    const viewport = configuredViewport();
    const size = videoSize(viewport);
    let dir: string | null = null;
    let context: BrowserContext;
    let inheritance: SessionInheritance | null = null;
    if (recording) {
      dir = await videoTempDir();
      // **A recording context must carry the attached browser's session, or
      // filming silently changes what the test is.** Recording is a property
      // of a context and can only be set when one is created, so a filmed run
      // cannot reuse the browser's own context — and a bare `newContext()`
      // starts with an empty cookie jar. Against an application that requires
      // a login, every protected URL then redirects to the sign-in page and
      // the whole run tests the login screen: twenty steps "pass" on a page
      // the flow never meant to be on, the assertions fail, and the report
      // blames the selectors. Seen exactly that way in PB_02_01, whose 26
      // steps all ran on `/en/login`.
      //
      // `storageState()` is the whole session as data — cookies, and
      // localStorage for every origin the browser visited — so handing it to
      // the new context makes filming invisible to the application.
      // The suite's own vault outranks the attached browser: a session a
      // sibling case established seconds ago is the fresher truth.
      inheritance =
        options.inheritSession === false
          ? { state: undefined, available: 0, declined: true }
          : options.sessionState !== undefined
            ? { state: options.sessionState, available: options.sessionState.cookies.length, fromSuite: true }
            : await inheritSession(browser);
      context = await browser.newContext({
        recordVideo: { dir, size },
        ...(viewport ? { viewport } : {}),
        ...(inheritance.state ? { storageState: inheritance.state } : {}),
      });
      await installCursorOverlay(context);
    } else if (options.isolate === true) {
      // Same move the recording branch makes, for a different reason: a
      // context of our own, carrying the browser's session so the application
      // cannot tell the difference.
      inheritance =
        options.inheritSession === false
          ? { state: undefined, available: 0, declined: true }
          : options.sessionState !== undefined
            ? { state: options.sessionState, available: options.sessionState.cookies.length, fromSuite: true }
            : await inheritSession(browser);
      context = await browser.newContext({
        ...(viewport ? { viewport } : {}),
        ...(inheritance.state ? { storageState: inheritance.state } : {}),
      });
    } else {
      context = browser.contexts()[0] ?? (await browser.newContext());
    }

    // Everything from here to a constructed runner is on the hook for undoing
    // the context if it fails: nothing else will close it, and an abandoned
    // recording context is not garbage — it is a live browser context sitting
    // in a Chrome that outlives this process, one per failed run.
    let page: Page;
    try {
      page = await context.newPage();
      await applyViewport(page);
      await options.cache.load();
    } catch (error) {
      if (dir) {
        await context.close().catch(() => undefined);
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
      throw error;
    }

    const runner = new SmartRunner(browser, context, page, options);
    if (inheritance) runner.#noteSessionInheritance(inheritance);
    // Whoever created the context closes it. Without this an isolated,
    // unfilmed run leaves a live context behind in a Chrome that outlives the
    // process — one per case, every suite.
    if (options.isolate === true) runner.#ownsContext = true;
    if (dir) {
      runner.#video = { dir, size };
      runner.#videoMode = options.video ?? 'on';
      // The first frame is written when the page opens, so this is the origin
      // every step's offset is measured from.
      runner.#ownsContext = true;
      keepCaption(page, () => runner.#caption);
      options.bundle.setVideoStart(Date.now());
    }
    await runner.observeNetwork();
    return runner;
  }

  /**
   * Start watching the page's HTTP traffic. Idempotent and best-effort:
   * `connect()` calls it for you, and embedders that came in through
   * `attach()` can call it themselves.
   *
   * Failure here is swallowed by design. Observation is diagnostic — the same
   * rule history and coverage follow — and a browser that won't hand out a
   * second CDP session is a reason to run without evidence, not to fail a run
   * that would otherwise have been perfectly good.
   */
  async observeNetwork(): Promise<void> {
    if (!this.#networkEnabled || this.#network) return;
    try {
      this.#network = await NetworkObserver.attach(this.page, {
        redaction: this.#networkRedaction,
        maxCalls: this.#networkMaxCalls,
      });
      this.#sequenceMark = this.#network.mark();
    } catch {
      this.#network = null;
    }
  }

  /** Feed statically-generated findings into this run's report. */
  addDefects(defects: readonly Defect[]): void {
    this.bundle.addDefects(defects);
  }

  /** Wrap an existing page — used by tests and by embedders that own the browser. */
  static attach(
    browser: Browser,
    context: BrowserContext,
    page: Page,
    options: SmartRunnerOptions,
  ): SmartRunner {
    const runner = new SmartRunner(browser, context, page, options);
    runner.#ownsPage = false;
    return runner;
  }

  // --- Actions -------------------------------------------------------------

  async goto(url: string): Promise<void> {
    const startedAt = new Date().toISOString();
    const started = Date.now();
    // What the flow asked for, which is what makes "we were sent somewhere
    // else" a fact rather than a guess.
    try {
      const asked = new URL(url, this.page.url() || undefined);
      this.#lastGotoPath = asked.pathname;
      // Per-goto, not sticky-for-the-run: a flow that signs in FIRST always
      // has a login goto in its past, and a run-wide flag then exempted the
      // exact case the guard exists for — a post-login goto to a protected
      // page bounced straight back to /login, followed by every body step
      // dead-ending against login furniture as "frontend" defects. Only the
      // most recent goto says what the flow means to be looking at now.
      this.#lastGotoAskedSignIn = looksLikeSignIn(asked.href);
    } catch {
      this.#lastGotoPath = null;
      this.#lastGotoAskedSignIn = false;
    }
    const urlBeforeNav = this.page.url();
    try {
      await this.page.goto(url, { waitUntil: 'domcontentloaded' });
      // **The session bootstrap.** A goto that asked for an ordinary page and
      // landed on the sign-in screen, in a run that HAS credentials and whose
      // flow contains no sign-in of its own, is a flow that assumes a session
      // against a browser that has none — a fresh headless Chrome, an
      // isolated context. Seen live (BE_Test2.csv, 2026-08-19 16:53): a
      // test-case-table catalog authored against a signed-in browser, every
      // case of which then died on the login screen under the session guard.
      // The rows' own precondition is "a signed-in user", the person supplied
      // the account (`--as`), and establishing a documented precondition
      // deterministically is preparation, not the claim — the same contract
      // as the agent rung. Once per run; a flow that signs in itself is never
      // raced; no credentials means the honest fatal below stands.
      const bootstrapped = await this.#bootstrapSession(url);
      // **Consent-gate recovery** (docs/consent-gate-recovery-spec.md, F1).
      // A client-side consent gate can render ON the URL this goto asked for
      // — URL unchanged, consent heading showing — and accepting it bounces
      // to the app's home landing, abandoning the deep link. Both facts
      // measured on the BE_Test2 11:52 run, where recovery left to the model
      // was a coin flip: the one flow whose agent returned to the asked-for
      // page passed, the three that wandered off by menu label went red.
      // Deterministic here: detect by content, accept, re-issue this goto
      // once. Never when the goto asked for the gate itself.
      const consentSettled = await this.#settleConsentGate(url, urlBeforeNav);
      this.bundle.addStep({
        action: 'goto',
        selector: null,
        resolvedSelector: null,
        resolution: null,
        status: 'passed',
        startedAt,
        durationMs: Date.now() - started,
        url: this.page.url(),
        detail: {
          url,
          ...(bootstrapped === null ? {} : { sessionEstablished: bootstrapped }),
          ...(consentSettled ? { consentAccepted: true } : {}),
        },
        // The landing state. A navigation is where the page changes most, so
        // this is the frame everything after it is read against.
        screenshot: await this.#shoot(bootstrapped === null && !consentSettled ? 'routine' : 'notable'),
      });
    } catch (error) {
      this.bundle.addStep({
        action: 'goto',
        selector: null,
        resolvedSelector: null,
        resolution: null,
        status: 'failed',
        startedAt,
        durationMs: Date.now() - started,
        url: this.page.url(),
        detail: { url },
        error: describe(error),
        // A failed navigation still lands somewhere — an error page, a login
        // redirect, a blank screen — and which of those it is decides what to
        // do next.
        screenshot: await this.#shoot('failure'),
      });
      throw error;
    }
  }

  /**
   * Click — and follow the click where it actually went.
   *
   * A link with `target="_blank"` (homepro.co.th's "ติดต่อเรา", live) opens
   * its destination in a NEW page: the click lands, nothing on the watched
   * page changes, and every later step asserts against the page the user
   * left. So a click that spawns a popup adopts it: the runner switches to
   * the new page and the flow continues on the journey the click started.
   * Recorded on the step (`detail.openedNewTab`) — an adopted page is a fact
   * about the run, not a silent switch.
   *
   * The wait is paid where it is owed: a declared `target="_blank"` waits
   * properly for its popup; everything else gets a short grace, enough for a
   * `window.open` fired in the click handler, cheap enough for the thousands
   * of clicks that never spawn anything.
   */
  async click(selector: string, intent?: string): Promise<void> {
    const detail: Record<string, unknown> = {};
    await this.#step(
      'click',
      selector,
      intent,
      async (locator, timeout) => {
        // The listener is armed before the click, so a popup spawned during
        // the click's own await — a `target="_blank"` default action, a
        // `window.open` in the handler — is already resolved by the time the
        // grace window is consulted. No attribute pre-read: that would spend
        // a second rung-timeout before the click got its first, silently
        // doubling the fast path for every click on the page.
        const popupPromise = this.page
          .waitForEvent('popup', { timeout: POPUP_GRACE_MS })
          .catch(() => null);
        try {
          await locator.click({ timeout });
        } catch (error) {
          // A grace window consumed on a failed click would tax every rung
          // of the ladder; the failure is the story, rethrow it now.
          popupPromise.catch(() => null);
          throw error;
        }
        const popup = await popupPromise;
        if (popup !== null) {
          await this.#adoptPage(popup);
          detail['openedNewTab'] = this.page.url();
        }
      },
      detail,
    );
  }

  /**
   * Continue the run on a page the application just opened.
   *
   * The original page is left as it is — closing it mid-run could take a
   * recording with it, and it is the page the user's journey came from. On a
   * filmed run the popup was born inside the recording context, so it is on
   * film too; captions resume with the next step's narration.
   */
  async #adoptPage(popup: Page): Promise<void> {
    await popup.waitForLoadState('domcontentloaded', { timeout: this.#healedTimeoutMs }).catch(() => undefined);
    await applyViewport(popup);
    // Remembered so `close()` can shut it: leaving it to leak accumulated a
    // tab per adopted popup, and a Chrome carrying dozens of leftover tabs
    // degrades every run after it. It cannot be closed *now* — a filmed
    // run's recording may live on it, and it is the page the journey came
    // from if anything still needs to look back.
    this.#pagesLeftBehind.push(this.page);
    this.page = popup;
  }

  async fill(selector: string, value: string, intent?: string): Promise<void> {
    await this.#step(
      'fill',
      selector,
      intent,
      (locator, timeout) => locator.fill(value, { timeout }),
      { value },
    );
  }

  /**
   * Choose a dropdown option by its visible label — one step for both a
   * native `<select>` and a custom combobox. `fill` throws on a select and
   * `click` can only open one; this is the action that completes it.
   */
  async selectOption(selector: string, value: string, intent?: string): Promise<void> {
    const detail: Record<string, unknown> = { value };
    await this.#step(
      'selectOption',
      selector,
      intent,
      async (locator, timeout) => {
        // Explicit timeout: locator.evaluate would otherwise wait Playwright's
        // 30s default for a missing element, stretching every ladder rung. Its
        // failure is left to throw — "the dropdown is not there" must read as
        // an ordinary resolution failure, not as a missing option.
        const tag = await locator.first().evaluate((el) => el.tagName, undefined, { timeout });
        detail['via'] = tag === 'SELECT' ? 'native' : 'custom';
        if (tag === 'SELECT') await this.#selectNative(locator, value, timeout);
        else await this.#selectCustom(locator, selector, value, timeout);
      },
      detail,
    );
  }

  /** Native `<select>`: match the visible label first, the value attribute second. */
  async #selectNative(locator: Locator, value: string, timeout: number): Promise<void> {
    try {
      await locator.selectOption({ label: value }, { timeout });
    } catch {
      // The author may have quoted the value attribute instead of the label.
      await locator.selectOption(value, { timeout });
    }
  }

  /**
   * Custom dropdown: click to open, then click the option the way a user
   * would. The option is searched page-wide because custom dropdowns render
   * their options in a portal at the end of the document, not inside the
   * control.
   */
  async #selectCustom(
    locator: Locator,
    selector: string,
    value: string,
    timeout: number,
  ): Promise<void> {
    await locator.click({ timeout });
    const option = this.page
      .getByRole('option', { name: value })
      .or(this.page.getByRole('menuitem', { name: value }))
      .or(this.page.getByRole('menuitemradio', { name: value }))
      .first();
    try {
      await option.click({ timeout });
    } catch (error) {
      // Close the dropdown so a ladder retry starts from a closed state and
      // later steps are not covered by an abandoned open list.
      await this.page.keyboard.press('Escape').catch(() => undefined);
      throw new Error(
        `opened ${JSON.stringify(selector)} but no option named ${JSON.stringify(value)} ` +
          `appeared (looked for role=option, menuitem, menuitemradio): ${describe(error)}`,
      );
    }
  }

  /** Tick a checkbox, radio, or ARIA toggle — see `#setChecked`. */
  async check(selector: string, intent?: string): Promise<void> {
    await this.#setChecked('check', selector, true, intent);
  }

  /** Untick one. */
  async uncheck(selector: string, intent?: string): Promise<void> {
    await this.#setChecked('uncheck', selector, false, intent);
  }

  /**
   * Set a checkable control's state and verify it actually changed — what
   * makes this preferable to a bare `click` when the resulting state is the
   * point. Native inputs go through Playwright's `setChecked`; a styled
   * toggle falls back to reading `aria-checked`/`aria-pressed`, clicking only
   * when the state differs, and re-reading to confirm. A control exposing no
   * state at all is refused rather than clicked blind.
   */
  async #setChecked(
    action: 'check' | 'uncheck',
    selector: string,
    target: boolean,
    intent?: string,
  ): Promise<void> {
    const detail: Record<string, unknown> = {};
    await this.#step(action, selector, intent, async (locator, timeout) => {
      // Explicit timeout for the same reason as selectOption's tag probe:
      // evaluate waits 30s by default for an element that may not be there.
      const readState = (): Promise<boolean | null> =>
        locator
          .first()
          .evaluate(
            (el) => {
              const aria = el.getAttribute('aria-checked') ?? el.getAttribute('aria-pressed');
              return aria === null ? null : aria === 'true';
            },
            undefined,
            { timeout },
          )
          .catch(() => null);

      try {
        // Native checkbox or radio — Playwright verifies the state itself.
        await locator.setChecked(target, { timeout });
        detail['via'] = 'native';
      } catch (error) {
        // Not natively checkable. Without ARIA state there is nothing to
        // verify against, so the original error stands.
        const before = await readState();
        if (before === null) throw error;
        detail['via'] = 'aria';
        if (before === target) return; // already in the wanted state — a no-op, not a toggle
        await locator.click({ timeout });
        const after = await readState();
        if (after !== target) {
          throw new Error(
            `clicked ${JSON.stringify(selector)}, but it still reports ` +
              `${action === 'check' ? 'unchecked' : 'checked'} (aria state ${String(after)})`,
          );
        }
      }
    }, detail);
  }

  /**
   * Type into a field key by key, firing the events a real keyboard fires —
   * for autocomplete/typeahead/masked fields that react per keystroke, which
   * `fill`'s single programmatic assignment cannot wake.
   */
  async type(selector: string, value: string, intent?: string): Promise<void> {
    await this.#step(
      'type',
      selector,
      intent,
      async (locator, timeout) => {
        // Focus the way a user does, then clear so the typed value is the
        // whole value. A non-input target (a div listening for keydown) has
        // nothing to clear; that is fine.
        await locator.click({ timeout });
        await locator.fill('', { timeout }).catch(() => undefined);
        // The typing budget scales with length: resolving the field is the
        // race the ladder times, typing N characters at a human pace is not,
        // and a fixed 2s window would fail long values on timing alone.
        await locator.pressSequentially(value, {
          delay: TYPE_KEY_DELAY_MS,
          timeout: Math.max(this.#healedTimeoutMs, value.length * TYPE_KEY_DELAY_MS + 1000),
        });
      },
      { value },
    );
  }

  async waitFor(selector: string, intent?: string): Promise<void> {
    await this.#step('waitFor', selector, intent, (locator, timeout) =>
      locator.waitFor({ state: 'visible', timeout }),
    );
  }

  /**
   * Seed a localStorage key. The page must already be on the target origin —
   * localStorage is origin-scoped, so `goto` has to come first.
   */
  async setLocalStorage(key: string, value: string): Promise<void> {
    await this.#bareStep('setLocalStorage', { key }, async () => {
      await this.page.evaluate(
        ([k, v]: [string, string]) =>
          (globalThis as unknown as BrowserGlobals).localStorage.setItem(k, v),
        [key, value] as [string, string],
      );
    });
  }

  /**
   * Pin the page's clock to a fixed moment, via Playwright's clock API.
   *
   * This is the capability that makes time-dependent claims checkable at all:
   * "14 days remaining shows the Urgent chip" is a claim about a boundary,
   * and a run on the wall clock exercises whatever day it happens to be —
   * usually none of the boundaries, while the report reads as though it
   * checked them (seen live: a 13/13 "pass" of an urgency-tier case whose
   * four probe dates were all in the past by run day). No selector, nothing
   * to heal — `#bareStep`, like the other state seeding. An unparseable time
   * fails loudly: a clock silently NOT installed turns every later assertion
   * back into that vacuous pass.
   */
  async setClock(time: string, intent?: string): Promise<void> {
    await this.#bareStep('setClock', { time, ...(intent !== undefined ? { intent } : {}) }, async () => {
      const parsed = new Date(time);
      if (Number.isNaN(parsed.getTime())) {
        throw new Error(
          `setClock: "${time}" is not a date the clock can be pinned to — use ISO, e.g. 2026-08-01 or 2026-08-01T00:00:00Z`,
        );
      }
      await this.page.clock.install({ time: parsed });
    });
  }

  /**
   * Clear localStorage and sessionStorage for the current origin.
   *
   * **A page that has not navigated yet has no storage to clear, and that is
   * done, not an error.** Storage is origin-scoped; before the first `goto` the
   * page sits on `about:blank`, whose origin is opaque, and reading
   * `localStorage` there throws `SecurityError: Access is denied for this
   * document`. As the first step of `setup` — where a model reliably puts it,
   * and where it reads as ordinary hygiene — that aborts the flow before it has
   * looked at the application even once, and reports a frontend defect about a
   * page nobody visited.
   *
   * So the origin is checked first and the clear is skipped when there is
   * nothing to clear, with the reason recorded on the step rather than left to
   * be inferred from a suspiciously fast pass. On a real origin the call is made
   * for real and a `SecurityError` there still fails the step: storage blocked
   * on a page that *has* storage is a genuine finding about the environment, and
   * swallowing it would be the overstatement this is trying to avoid.
   *
   * `setLocalStorage` deliberately does **not** do this. Its intent is to put a
   * value somewhere, which an opaque origin cannot honour, so a flow that seeds
   * auth before navigating must fail loudly instead of running on unauthenticated
   * and failing later somewhere confusing. Clearing has the opposite property:
   * "leave no storage behind" is already true of a page that has none.
   */
  async clearStorage(): Promise<void> {
    const url = this.page.url();
    const storable = hasStorableOrigin(url);
    await this.#bareStep(
      'clearStorage',
      storable ? {} : { cleared: 'nothing — the page has not navigated to an origin yet', url },
      async () => {
        if (!storable) return;
        await this.page.evaluate(() => {
          const g = globalThis as unknown as BrowserGlobals;
          g.localStorage.clear();
          g.sessionStorage.clear();
        });
      },
    );
  }

  /**
   * Sign out through the application's own control (`performSignOut`), so a
   * persona switch exercises the same path a user takes. When the app offers
   * no name-gated sign-out control anywhere the step falls back to clearing
   * cookies and storage — the session still ends, and the step's `detail`
   * says the real path was not exercised rather than letting a wiped session
   * read as a working sign-out. A `#bareStep`: there is no author-supplied
   * selector to heal, the `setLocalStorage` category.
   */
  async signOut(intent?: string): Promise<void> {
    const detail: Record<string, unknown> = { intent, urlBefore: this.page.url() };
    await this.#bareStep('signOut', detail, async () => {
      const result = await performSignOut(this.page);
      if (result.ok) {
        detail['via'] = result.via;
        detail['urlAfter'] = result.landedUrl;
        return;
      }
      // Fallback: end the session without the app's help. Cookies AND
      // storage — a cookie-backed session survives a storage wipe entirely.
      await this.page.context().clearCookies();
      if (hasStorableOrigin(this.page.url())) {
        await this.page.evaluate(() => {
          const g = globalThis as unknown as BrowserGlobals;
          g.localStorage.clear();
          g.sessionStorage.clear();
        });
      }
      detail['via'] =
        `fallback — ${result.reason}; cleared cookies and storage instead, so the ` +
        'application\'s own sign-out path was NOT exercised';
      detail['urlAfter'] = this.page.url();
    });
  }

  // --- History navigation --------------------------------------------------
  //
  // A journey through an application is rarely a straight line: open a card,
  // check it, come back, open the next one. Without these a flow has to
  // `goto` the origin page again, which throws away exactly the state the
  // journey was testing — scroll position, an open filter, a loaded list.

  /**
   * Let any navigation already in flight finish before touching history.
   *
   * `click` returns when the click lands, not when the router responds, so a
   * `back` immediately after a click steps back past the entry the click was
   * about to create — landing on whatever preceded the *test*, usually
   * `about:blank`. Found against a real queue page: the row navigated, `back`
   * ran 37ms later, and the flow failed with "there is no previous page" while
   * the application had done nothing wrong.
   *
   * Stability, not a fixed wait: the URL is sampled until it stops changing,
   * so a fast navigation costs one sample and a slow one is still caught.
   */
  async #settleNavigation(): Promise<void> {
    const deadline = Date.now() + this.#fastTimeoutMs;
    let previous = this.page.url();
    let stable = 0;
    while (Date.now() < deadline && stable < 2) {
      await this.page.waitForTimeout(80);
      const current = this.page.url();
      stable = current === previous ? stable + 1 : 0;
      previous = current;
    }
  }

  /** Go back one entry in history, and wait for the page that follows. */
  async back(intent?: string): Promise<void> {
    await this.#bareStep('back', { intent }, async () => {
      await this.#settleNavigation();
      // `commit`, not the default `load`: a back navigation restored from the
      // back/forward cache fires no load event at all, so waiting for one
      // times out on exactly the pages where going back worked perfectly.
      const response = await this.page.goBack({
        timeout: this.#healedTimeoutMs,
        waitUntil: 'commit',
      });
      await this.page
        .waitForLoadState('domcontentloaded', { timeout: this.#healedTimeoutMs })
        .catch(() => undefined);
      // `goBack` resolves with null when there was nowhere to go. Silently
      // continuing would leave every later step asserting against the wrong
      // page and blaming the wrong thing.
      if (response === null && this.page.url() === 'about:blank') {
        throw new Error('there is no previous page to go back to');
      }
    });
  }

  /** Go forward one entry in history. */
  async forward(intent?: string): Promise<void> {
    await this.#bareStep('forward', { intent }, async () => {
      await this.#settleNavigation();
      const response = await this.page.goForward({
        timeout: this.#healedTimeoutMs,
        waitUntil: 'commit',
      });
      await this.page
        .waitForLoadState('domcontentloaded', { timeout: this.#healedTimeoutMs })
        .catch(() => undefined);
      if (response === null && this.page.url() === 'about:blank') {
        throw new Error('there is no next page to go forward to');
      }
    });
  }

  // --- Scrolling -----------------------------------------------------------

  /**
   * Scroll something into view.
   *
   * Goes through the ladder, unlike the other bare steps here: the target is
   * an author-supplied selector that can drift like any other, and healing it
   * is meaningful.
   */
  async scrollTo(selector: string, intent?: string): Promise<void> {
    await this.#step('scrollTo', selector, intent, async (locator, timeout) => {
      await locator.scrollIntoViewIfNeeded({ timeout });
    });
  }

  /**
   * Assert that something can actually be scrolled.
   *
   * "Is there more content below?" and "can a user reach it?" are different
   * questions, and only the second one matters. A container with
   * `overflow: hidden`, a fixed-height panel whose inner list overflows
   * invisibly, a modal body that traps the wheel — all of them have content
   * past the fold that nobody can get to, and every functional assertion
   * written against them passes, because the DOM is perfectly fine.
   *
   * So this checks both halves: there is overflow, *and* moving the scroll
   * position actually moves it. The position is restored afterwards, because
   * an assertion that leaves the page somewhere else changes what the next
   * step is testing.
   */
  async expectScrollable(selector?: string, intent?: string): Promise<void> {
    await this.#bareStep('expectScrollable', { selector, intent }, async () => {
      // Poll, don't measure once. Found against a real hub page: at 73ms the
      // document was still a shell exactly one viewport tall, so a single
      // reading reported "696px of content in 696px" and called a page that
      // scrolls to 2806px unscrollable. Same hydration race `expectUrl` lost.
      const result = await this.#pollScroll(selector, (r) => r.overflows && r.moved);
      if (!result.overflows) {
        throw new Error(
          `expected ${result.what} to be scrollable, but its content fits ` +
            `(${result.scrollSize}px of content in ${result.clientSize}px)`,
        );
      }
      if (!result.moved) {
        throw new Error(
          `expected ${result.what} to be scrollable: its content overflows ` +
            `(${result.scrollSize}px in ${result.clientSize}px) but the scroll position ` +
            'would not move — the overflow is unreachable',
        );
      }
    });
  }

  /** The mirror of `expectScrollable`, for a pane that must stay put. */
  async expectNotScrollable(selector?: string, intent?: string): Promise<void> {
    await this.#bareStep('expectNotScrollable', { selector, intent }, async () => {
      // A negative assertion must not wait for the thing to become true — that
      // would be waiting for its own failure. It does have to let the page
      // finish arriving first, or it passes against a shell that has not
      // rendered the content yet, which is the same false pass in reverse.
      await this.page
        .waitForLoadState('networkidle', { timeout: this.#fastTimeoutMs })
        .catch(() => undefined);
      const result = await this.#measureScroll(selector);
      if (result.overflows && result.moved) {
        throw new Error(
          `expected ${result.what} not to scroll, but it does ` +
            `(${result.scrollSize}px of content in ${result.clientSize}px)`,
        );
      }
    });
  }

  /**
   * Measure until the page agrees, or the fast-path budget runs out.
   *
   * Returns the last measurement either way, so the failure message reports
   * the real numbers rather than "timed out" — the sizes are the whole
   * diagnostic value of a scroll assertion.
   */
  async #pollScroll(
    selector: string | undefined,
    satisfied: (result: ScrollMeasurement) => boolean,
  ): Promise<ScrollMeasurement> {
    const deadline = Date.now() + this.#fastTimeoutMs;
    let last = await this.#measureScroll(selector);
    while (!satisfied(last) && Date.now() < deadline) {
      await this.page.waitForTimeout(100);
      last = await this.#measureScroll(selector);
    }
    return last;
  }

  /**
   * Measure scrollability, restoring the position before returning.
   *
   * Runs in one `evaluate` so the probe-and-restore cannot be interleaved with
   * anything the page does — a half-scrolled page left behind by a failed
   * assertion is a state no later step asked for.
   */
  async #measureScroll(selector?: string): Promise<ScrollMeasurement> {
    if (selector) {
      // A missing container is a different failure from an unscrollable one,
      // and saying so beats reporting "0px of content in 0px".
      const count = await this.page.locator(selector).count();
      if (count === 0) throw new Error(`no element matches ${JSON.stringify(selector)} to scroll`);
    }

    const measured = await this.page.evaluate((target: string | null) => {
      const g = globalThis as unknown as BrowserScroll;
      const element = target
        ? (g.document.querySelector(target) as ScrollTarget | null)
        : (g.document.scrollingElement as ScrollTarget | null);
      if (!element) return null;

      const scrollSize = element.scrollHeight;
      const clientSize = element.clientHeight;
      const overflows = scrollSize > clientSize + 1;

      // `element.scrollTop = n` works even on `overflow: hidden`, so moving the
      // position proves nothing on its own — script can scroll what a user
      // cannot. The computed style is what says whether a wheel, a drag or a
      // keypress would do anything, and that is the question being asked.
      const style = g.getComputedStyle(element as unknown as ScrollStyled);
      const axis = String(style.overflowY || style.overflow || '');
      const userScrollable =
        element === g.document.scrollingElement || /(auto|scroll|overlay)/.test(axis);

      const before = element.scrollTop;
      element.scrollTop = before + Math.max(40, Math.floor(clientSize / 2));
      const moved = userScrollable && element.scrollTop !== before;
      element.scrollTop = before;

      return { scrollSize, clientSize, overflows, moved };
    }, selector ?? null);

    if (!measured) throw new Error(`nothing to measure for ${selector ?? 'the page'}`);
    return { what: selector ? JSON.stringify(selector) : 'the page', ...measured };
  }

  // --- Keyboard ------------------------------------------------------------

  /** Press a key, optionally focusing `selector` first. */
  async press(key: string, selector?: string, intent?: string): Promise<void> {
    if (selector === undefined) {
      await this.#bareStep('press', { key }, () => this.page.keyboard.press(key));
      return;
    }
    await this.#step(
      'press',
      selector,
      intent,
      (locator, timeout) => locator.press(key, { timeout }),
      { key },
    );
  }

  /** Assert the element currently holds keyboard focus. */
  async expectFocused(selector: string, intent?: string): Promise<void> {
    await this.#step('expectFocused', selector, intent, async (locator, timeout) => {
      await locator.waitFor({ state: 'attached', timeout });
      if (!(await locator.first().evaluate((el) => el === el.ownerDocument.activeElement))) {
        throw new Error('expected element to have focus, but it does not');
      }
    });
  }

  /**
   * Tab through the page and assert focus lands on `selectors` in order.
   *
   * Focus order is the one accessibility property that cannot be read from a
   * static tree — it only exists while tabbing — so it needs a real
   * interaction to verify.
   */
  async expectTabOrder(selectors: readonly string[], intent?: string): Promise<void> {
    await this.#bareStep('expectTabOrder', { selectors, intent }, async () => {
      // Reset focus so the sequence is reproducible regardless of what ran
      // before.
      //
      // Two non-obvious traps here, both found the hard way:
      //   - `body.focus()` alone is a no-op, because body is not focusable
      //     without a tabindex.
      //   - `activeElement.blur()` clears activeElement but leaves Chrome's
      //     *sequential focus navigation starting point* on the old element,
      //     so the next Tab resumes from there instead of the top.
      // Temporarily making body focusable and focusing it resets both.
      await this.page.evaluate(() => {
        const body = (globalThis as unknown as BrowserDocument).document.body;
        const hadTabIndex = body.hasAttribute('tabindex');
        if (!hadTabIndex) body.setAttribute('tabindex', '-1');
        body.focus();
        if (!hadTabIndex) body.removeAttribute('tabindex');
      });

      const reached: string[] = [];
      for (const selector of selectors) {
        await this.page.keyboard.press('Tab');
        const matched = await this.page
          .locator(selector)
          .first()
          .evaluate((el) => el === el.ownerDocument.activeElement)
          .catch(() => false);
        reached.push(matched ? selector : '(not focused)');
        if (!matched) {
          throw new Error(
            `tab order diverged at position ${reached.length}: expected focus on ` +
              `${JSON.stringify(selector)}. Reached: ${reached.join(' → ')}`,
          );
        }
      }
    });
  }

  // --- Data-driven ---------------------------------------------------------

  /**
   * Fill one field with several values, asserting after each.
   *
   * This is boundary-value analysis made expressible. Every case runs even
   * after one fails — a partial boundary table is far less useful than the
   * whole one when you are trying to find where behaviour changes.
   */
  /**
   * Boundary values are the step's own evidence, so they are NOT masked by the
   * credential heuristics that guard `fill`/`type` — a table showing which
   * inputs a form accepted is worthless with its inputs hidden, and these
   * values come from the author's table or from `mock-data.ts`, never from a
   * real account. A value the person supplied through `--as` is still masked:
   * that statement outranks this reasoning wherever the two meet.
   */
  async fillEach(
    selector: string,
    cases: readonly DataCase[],
    intent?: string,
    submit?: string,
  ): Promise<void> {
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const results: DataCaseResult[] = [];

    for (const [index, testCase] of cases.entries()) {
      const label = testCase.label ?? `case ${index + 1}`;
      try {
        await this.page
          .locator(selector)
          .first()
          .fill(testCase.value, { timeout: this.#healedTimeoutMs });
        // Validation usually fires on submit, not on input — without this,
        // every boundary case would assert against a form that never ran.
        if (submit !== undefined) {
          await this.page.locator(submit).first().click({ timeout: this.#healedTimeoutMs });
        }
        await this.#checkDataExpectation(testCase);
        results.push({ label, value: this.#maskSuppliedSecret(testCase.value), ok: true });
      } catch (error) {
        results.push({
          label,
          value: this.#maskSuppliedSecret(testCase.value),
          ok: false,
          error: describe(error),
        });
      }
    }

    const failed = results.filter((r) => !r.ok);
    const status = failed.length === 0 ? 'passed' : 'failed';

    this.bundle.addStep({
      action: 'fillEach',
      intent,
      selector,
      resolvedSelector: selector,
      resolution: 'fast',
      status,
      startedAt,
      durationMs: Date.now() - started,
      url: this.page.url(),
      detail: { intent, cases: cases.length, submit },
      dataCases: results,
      screenshot: await this.#shoot(status === 'failed' ? 'failure' : 'routine'),
      error:
        failed.length === 0
          ? undefined
          : `${failed.length}/${results.length} value(s) failed: ${failed
              .map((r) => `${r.label} (${JSON.stringify(r.value)})`)
              .join(', ')}`,
    });

    if (failed.length > 0) {
      this.#recordRuntimeDefect(
        'functional',
        'high',
        `Boundary failures on ${selector}`,
        failed.map((r) => `${r.label}: ${r.error ?? 'failed'}`).join('; '),
        selector,
      );
      throw new Error(`fillEach: ${failed.length} of ${results.length} value(s) failed`);
    }
  }

  async #checkDataExpectation(testCase: DataCase): Promise<void> {
    const timeout = this.#fastTimeoutMs;
    if (testCase.expectText) {
      const actual =
        (await this.page.locator(testCase.expectText.selector).first().textContent({ timeout })) ??
        '';
      if (!actual.includes(testCase.expectText.value)) {
        throw new Error(
          `expected ${JSON.stringify(testCase.expectText.value)} in ` +
            `${testCase.expectText.selector}, got ${JSON.stringify(actual.trim().slice(0, 80))}`,
        );
      }
    }
    if (testCase.expectVisible) {
      await this.page
        .locator(testCase.expectVisible)
        .first()
        .waitFor({ state: 'visible', timeout });
    }
    if (testCase.expectHidden) {
      await this.page
        .locator(testCase.expectHidden)
        .first()
        .waitFor({ state: 'hidden', timeout });
    }
  }

  /**
   * Fill a field, submit, and check whether `failureSelector` (a validation
   * or conflict message — "email already exists", "SKU not found") is still
   * visible. If it is, regenerate the value and try again, up to
   * `maxAttempts`. Every kind except `custom` generates deterministically —
   * see `mock-data.ts` — so most calls never spend a token.
   *
   * Like `fillEach`, this does not go through the escalation ladder: the
   * *field* selector is assumed stable, only the *value* is in question.
   */
  async fillRetry(
    selector: string,
    kind: DataKind,
    failureSelector: string,
    options: {
      submit?: string | undefined;
      maxAttempts?: number | undefined;
      description?: string | undefined;
      intent?: string | undefined;
    } = {},
  ): Promise<void> {
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    const description = options.description ?? options.intent ?? selector;

    const attempts: DataRetryAttempt[] = [];
    let modelId: string | undefined;
    let inputTokens = 0;
    let outputTokens = 0;
    let previousValue: string | undefined;
    let observedError: string | undefined;
    let succeeded = false;
    let fatalError: string | undefined;

    for (let attempt = 1; attempt <= maxAttempts && !succeeded && fatalError === undefined; attempt++) {
      let value: string;
      try {
        if (kind === 'custom') {
          if (!this.#dataModel) {
            throw new Error('fillRetry kind "custom" needs a DataModel, but none is configured');
          }
          const generated = await this.#dataModel.generate({ description, observedError, previousValue, attempt });
          value = generated.value;
          modelId = this.#dataModel.id;
          inputTokens += generated.inputTokens ?? 0;
          outputTokens += generated.outputTokens ?? 0;
        } else {
          value = generateValue(kind, attempt);
        }
      } catch (error) {
        fatalError = describe(error);
        break;
      }
      previousValue = value;

      try {
        await this.page.locator(selector).first().fill(value, { timeout: this.#healedTimeoutMs });
        if (options.submit !== undefined) {
          await this.page.locator(options.submit).first().click({ timeout: this.#healedTimeoutMs });
        }
      } catch (error) {
        attempts.push({ attempt, kind, value: this.#maskSuppliedSecret(value), succeeded: false });
        fatalError = describe(error);
        break;
      }

      // Wait up to the fast-path budget for the conflict indicator — the
      // same short-by-design timeout as everywhere else, and for the same
      // reason: if it's going to reappear, it reappears immediately.
      const stillConflicting = await this.page
        .locator(failureSelector)
        .first()
        .waitFor({ state: 'visible', timeout: this.#fastTimeoutMs })
        .then(() => true)
        .catch(() => false);

      succeeded = !stillConflicting;
      attempts.push({ attempt, kind, value: this.#maskSuppliedSecret(value), succeeded });
      observedError = succeeded ? undefined : `"${failureSelector}" still visible after attempt ${attempt}`;
    }

    const dataRetry: DataRetryRecord = {
      kind,
      attempts,
      succeeded,
      model: modelId,
      inputTokens: modelId ? inputTokens : undefined,
      outputTokens: modelId ? outputTokens : undefined,
    };
    const failureMessage = succeeded
      ? undefined
      : (fatalError ?? `still conflicting after ${attempts.length} attempt(s)`);

    this.bundle.addStep({
      action: 'fillRetry',
      intent: options.intent,
      selector,
      resolvedSelector: selector,
      resolution: 'fast',
      status: succeeded ? 'passed' : 'failed',
      startedAt,
      durationMs: Date.now() - started,
      url: this.page.url(),
      detail: { kind, failureSelector, submit: options.submit, maxAttempts, intent: options.intent },
      dataRetry,
      screenshot: await this.#shoot(
        !succeeded ? 'failure' : attempts.length > 1 ? 'notable' : 'routine',
      ),
      error: failureMessage,
    });

    if (succeeded && attempts.length > 1) {
      // A passing step that still tells you something: the first value
      // conflicted, same reasoning as a JIT heal being reported even though
      // the step passed.
      this.#recordRuntimeDefect(
        'functional',
        'low',
        `Data regenerated on conflict: ${selector}`,
        `Needed ${attempts.length} attempt(s) before "${failureSelector}" cleared. If this is a ` +
          'shared test environment, consider whether seed data needs resetting.',
        selector,
      );
    }

    if (!succeeded) {
      this.#recordRuntimeDefect('functional', 'high', `Step failed: fillRetry ${selector}`, failureMessage ?? 'unknown', selector);
      throw new Error(`fillRetry: "${selector}" ${failureMessage}`);
    }
  }

  // --- Visual regression ---------------------------------------------------

  /** Compare the page (or one element) against a stored baseline. */
  async snapshot(name: string, selector?: string): Promise<void> {
    const startedAt = new Date().toISOString();
    const started = Date.now();

    const path = baselinePath(this.#baselineDir, this.bundle.name, name);

    try {
      // PNG, not JPEG: lossy artefacts would register as pixel drift.
      const shot =
        selector === undefined
          ? await this.page.screenshot({ type: 'png', fullPage: false })
          : await this.page
              .locator(selector)
              .first()
              .screenshot({ type: 'png', timeout: this.#healedTimeoutMs });

      const result = await compareSnapshot(shot, path, name, {
        updateBaseline: this.#updateBaselines,
      });
      const failed = isVisualFailure(result);

      this.bundle.addStep({
        action: 'snapshot',
        selector: selector ?? null,
        resolvedSelector: selector ?? null,
        resolution: 'fast',
        status: failed ? 'failed' : 'passed',
        startedAt,
        durationMs: Date.now() - started,
        url: this.page.url(),
        detail: { name, baseline: path },
        snapshot: result,
        error: failed ? result.message : undefined,
        // A snapshot that matched carries no image of its own — the baseline
        // and the render were identical, so there was nothing to show. Without
        // this it would be the one step in the run with no evidence at all.
        screenshot: await this.#shoot(failed ? 'failure' : 'routine'),
      });

      if (failed) {
        this.#recordRuntimeDefect(
          'usability',
          'high',
          `Visual regression: ${name}`,
          result.message,
          selector,
        );
        throw new Error(`snapshot "${name}": ${result.message}`);
      }
    } catch (error) {
      // Only wrap genuine capture failures; a drift failure is already recorded.
      if (error instanceof Error && error.message.startsWith(`snapshot "${name}"`)) throw error;
      this.bundle.addStep({
        action: 'snapshot',
        selector: selector ?? null,
        resolvedSelector: null,
        resolution: null,
        status: 'failed',
        startedAt,
        durationMs: Date.now() - started,
        url: this.page.url(),
        detail: { name },
        error: describe(error),
        screenshot: await this.#shoot('failure'),
      });
      throw error;
    }
  }

  // --- Modals ----------------------------------------------------------------

  /**
   * Assert a dialog/modal is currently open, optionally checking it mentions
   * `name`. Detection is ARIA-based (`role="dialog"`/`"alertdialog"`, or a
   * native `<dialog open>`) — see `modal.ts` for what that does and doesn't
   * catch. Like other presence/absence checks, this does not go through the
   * escalation ladder: there's no selector here to heal.
   */
  async expectModal(name?: string, intent?: string): Promise<void> {
    const detail: Record<string, unknown> = {
      name,
      intent,
      ...(name === undefined ? {} : { expected: name }),
    };
    await this.#bareStep('expectModal', detail, async () => {
      const dialog = await waitForDialog(this.page, this.#healedTimeoutMs);
      if (!dialog) {
        if (name !== undefined) detail['actual'] = '(no dialog or modal visible)';
        throw new Error('no dialog or modal is currently visible');
      }
      if (name) {
        const label = await describeDialog(dialog);
        detail['actual'] = label;
        if (!label.toLowerCase().includes(name.toLowerCase())) {
          throw new Error(`open dialog ("${label}") does not mention "${name}"`);
        }
      }
    });
  }

  /**
   * Close whatever dialog/modal is currently open. Pass `button` to target a
   * specific control inside it (a selector, scoped to the dialog); omit it to
   * fall back to `findDismissButton`'s best-effort match on common
   * dismiss/accept text — the same heuristic the automatic blocking-dialog
   * recovery in `#resolve` uses.
   */
  async closeModal(button?: string, intent?: string): Promise<void> {
    await this.#bareStep('closeModal', { button, intent }, async () => {
      const dialog = await waitForDialog(this.page, this.#healedTimeoutMs);
      if (!dialog) throw new Error('no dialog or modal is currently open to close');

      if (button) {
        await dialog.locator(button).first().click({ timeout: this.#healedTimeoutMs });
        return;
      }
      const dismiss = await findDismissButton(dialog);
      if (!dismiss) {
        throw new Error(
          'no dismiss button found in the open dialog — pass an explicit `button` selector',
        );
      }
      await dismiss.locator.click({ timeout: this.#healedTimeoutMs });
    });
  }

  // --- Assertions ----------------------------------------------------------

  /** Assert that the element's text contains `expected`. */
  /**
   * Assert the element's *visible* text contains `expected` — or any entry of
   * `anyOf`, the accepted equivalent renderings of the same content.
   *
   * `anyOf` exists for bilingual applications: a requirement written as
   * "Somchai Sukjai" against a page that renders "สมชาย สุขใจ" is the same
   * claim about the same employee, and failing it is a false fail about
   * language, not the feature (PB-05-01, live). The alternatives are
   * explicit and author-supplied — the engine never invents an equivalence —
   * so a case that *means* to check a specific language simply lists only
   * that language. Which variant matched is recorded on the step, because
   * "passed via the Thai rendering" is evidence, not trivia.
   *
   * Visible text (`innerText`), not `textContent`: against `body` the latter
   * happily reads `<script>` payloads — PB-05-01's "got …" text was mostly
   * Next.js flight data no user has ever seen. An assertion about what the
   * page says must read what the page shows.
   */
  async expectText(
    selector: string,
    expected: string,
    intent?: string,
    anyOf?: readonly string[],
  ): Promise<void> {
    const accepted = [expected, ...(anyOf ?? [])];
    // Mutated by the callback below, read when the step is recorded — this is
    // how "which rendering satisfied the claim" reaches the bundle.
    const detail: Record<string, unknown> = {
      expected,
      ...(anyOf?.length ? { anyOf: [...anyOf] } : {}),
    };
    await this.#step(
      'expectText',
      selector,
      intent,
      async (locator, timeout) => {
        // Poll until the text appears or the window closes — the same rule
        // `expectUrl` and `expectScrollable` already follow, for the same
        // reason: a selector like `body` resolves instantly on a page that
        // has not hydrated, so a single read is a race the assertion loses
        // by construction. PB-05-01's detail page renders the name ~3s after
        // the route commits; one read at 2s saw only the app shell.
        const deadline = Date.now() + timeout;
        let actual = '';
        for (;;) {
          try {
            actual = await locator.innerText({ timeout });
          } catch {
            // Non-HTML elements (SVG text, say) have no innerText; fall back
            // rather than failing an assertion the page can satisfy.
            actual = (await locator.textContent({ timeout })) ?? '';
          }
          const matched = accepted.find((candidate) => actual.includes(candidate));
          if (matched !== undefined) {
            if (matched !== expected) detail['matchedRendering'] = matched;
            detail['actual'] = excerptAround(actual, matched);
            return;
          }
          if (Date.now() >= deadline) break;
          await this.page.waitForTimeout(Math.min(150, Math.max(1, deadline - Date.now())));
        }
        detail['actual'] = actual.trim().slice(0, 400);
        throw new Error(
          `expected text to contain ${JSON.stringify(expected)}` +
            (anyOf?.length ? ` (or an accepted rendering: ${anyOf.map((a) => JSON.stringify(a)).join(', ')})` : '') +
            `, got ${JSON.stringify(actual.trim())}` +
            scriptMismatchNote(expected, actual),
        );
      },
      detail,
    );
  }

  async expectVisible(selector: string, intent?: string): Promise<void> {
    const detail: Record<string, unknown> = { expected: 'visible' };
    await this.#step(
      'expectVisible',
      selector,
      intent,
      async (locator, timeout) => {
        try {
          await locator.waitFor({ state: 'visible', timeout });
          detail['actual'] = 'visible';
        } catch (error) {
          detail['actual'] = 'not visible (hidden or absent)';
          throw error;
        }
      },
      detail,
    );
  }

  /**
   * Assert the element is absent or not visible.
   *
   * Runs *outside* the escalation ladder. Healing a selector whose whole point
   * is that it should not resolve would let the healer "repair" it onto some
   * unrelated element and turn a correct pass into a meaningless one.
   */
  async expectHidden(selector: string, intent?: string): Promise<void> {
    const detail: Record<string, unknown> = { selector, intent, expected: 'hidden or absent' };
    await this.#bareStep('expectHidden', detail, async () => {
      try {
        await this.page
          .locator(selector)
          .first()
          .waitFor({ state: 'hidden', timeout: this.#fastTimeoutMs });
        detail['actual'] = 'hidden or absent';
      } catch (error) {
        detail['actual'] = 'still visible';
        throw error;
      }
    });
  }

  async expectEnabled(selector: string, intent?: string): Promise<void> {
    const detail: Record<string, unknown> = { expected: 'enabled' };
    await this.#step(
      'expectEnabled',
      selector,
      intent,
      async (locator, timeout) => {
        await locator.waitFor({ state: 'attached', timeout });
        const enabled = await locator.isEnabled({ timeout });
        detail['actual'] = enabled ? 'enabled' : 'disabled';
        if (!enabled) {
          throw new Error('expected element to be enabled, but it is disabled');
        }
      },
      detail,
    );
  }

  async expectDisabled(selector: string, intent?: string): Promise<void> {
    const detail: Record<string, unknown> = { expected: 'disabled' };
    await this.#step(
      'expectDisabled',
      selector,
      intent,
      async (locator, timeout) => {
        await locator.waitFor({ state: 'attached', timeout });
        const enabled = await locator.isEnabled({ timeout });
        detail['actual'] = enabled ? 'enabled' : 'disabled';
        if (enabled) {
          throw new Error('expected element to be disabled, but it is enabled');
        }
      },
      detail,
    );
  }

  /** Assert how many elements the selector matches. Zero bypasses the ladder. */
  async expectCount(selector: string, expected: number, intent?: string): Promise<void> {
    if (expected === 0) {
      // Same reasoning as expectHidden: absence must not be "repaired".
      const zeroDetail: Record<string, unknown> = { selector, expected, intent };
      await this.#bareStep('expectCount', zeroDetail, async () => {
        const actual = await this.page.locator(selector).count();
        zeroDetail['actual'] = actual;
        if (actual !== 0) {
          throw new Error(`expected 0 matches, found ${actual}`);
        }
      });
      return;
    }

    const detail: Record<string, unknown> = { expected };
    await this.#step(
      'expectCount',
      selector,
      intent,
      async (locator, timeout) => {
        await locator.first().waitFor({ state: 'attached', timeout });
        const actual = await locator.count();
        detail['actual'] = actual;
        if (actual !== expected) {
          throw new Error(`expected ${expected} matches, found ${actual}`);
        }
      },
      detail,
    );
  }

  /** Assert the current URL contains `expected`. No selector, so no healing. */
  async expectUrl(expected: string, intent?: string): Promise<void> {
    const detail: Record<string, unknown> = { expected, intent };
    await this.#bareStep('expectUrl', detail, async () => {
      // Wait, don't peek. A client-side navigation is in flight when this step
      // begins — `click` returns as soon as the click lands, not when the
      // router has finished — so reading `page.url()` synchronously races it
      // and loses every time. That made `click` → `expectUrl`, the most
      // ordinary pair in any suite, fail against every SPA ever written, in
      // under a millisecond, with an error naming the *old* URL.
      //
      // The *healed* budget, not the fast one, and the distinction is the
      // point: the fast-path argument — "a selector that is going to work
      // works immediately" — is about finding an element on a page that has
      // already loaded. This is waiting for a page to arrive. A route that
      // takes four seconds on a cold browser is slow, not broken, and failing
      // it teaches nobody anything. Found on a freshly-started Chrome, where
      // the same navigation that took 18ms warm took over two seconds cold.
      try {
        await this.page.waitForURL((url) => url.toString().includes(expected), {
          timeout: this.#healedTimeoutMs,
        });
        detail['actual'] = this.page.url();
      } catch {
        // Report what the URL actually is now, not what the timeout said —
        // "expected X, got Y" is the whole diagnostic value of this step.
        detail['actual'] = this.page.url();
        throw new Error(
          `expected url to contain ${JSON.stringify(expected)}, got ${JSON.stringify(this.page.url())} — ` +
            'note: if the page shown IS the correct destination, the expectation was derived ' +
            "from a label rather than from where the control points; take expected URLs from " +
            "the tree's url= attributes, never from a control's name",
        );
      }
    });
  }

  /**
   * Evaluate a `when` condition and record the choice as a step.
   *
   * A *probe*, not an assertion, and the difference is the whole point:
   *
   * - **It never heals.** Healing asks "which element did the author really
   *   mean?", which is a question about a selector that ought to resolve. Here
   *   not resolving is a legitimate answer — often the answer the flow is
   *   asking for ("is the role switcher already showing HRBP?"). A repair
   *   would turn "no" into "yes, some other element", silently taking the
   *   wrong branch. Same reasoning that keeps `expectHidden` off the ladder.
   * - **It never fails the flow.** An unresolvable selector means the
   *   condition is false, and the `else` branch (or nothing) runs.
   *
   * The step is recorded either way, with the branch it took, so a report
   * shows *why* the following steps are the ones that ran.
   */
  async evaluateWhen(
    condition: { visible?: string; hidden?: string; enabled?: string; disabled?: string },
    intent?: string,
  ): Promise<boolean> {
    const entries = (['visible', 'hidden', 'enabled', 'disabled'] as const)
      .map((key) => [key, condition[key]] as const)
      .filter((pair): pair is readonly [typeof pair[0], string] => typeof pair[1] === 'string');

    if (entries.length !== 1) {
      throw new Error(
        `a "when" step needs exactly one of visible/hidden/enabled/disabled, got ${entries.length}`,
      );
    }
    const [kind, selector] = entries[0]!;

    let matched = false;
    await this.#bareStep('when', { selector, condition: kind, intent }, async () => {
      const locator = this.page.locator(selector).first();
      try {
        switch (kind) {
          case 'visible':
            await locator.waitFor({ state: 'visible', timeout: this.#fastTimeoutMs });
            matched = true;
            break;
          case 'hidden':
            await locator.waitFor({ state: 'hidden', timeout: this.#fastTimeoutMs });
            matched = true;
            break;
          case 'enabled':
            await locator.waitFor({ state: 'attached', timeout: this.#fastTimeoutMs });
            matched = await locator.isEnabled();
            break;
          case 'disabled':
            await locator.waitFor({ state: 'attached', timeout: this.#fastTimeoutMs });
            matched = !(await locator.isEnabled());
            break;
        }
      } catch {
        // Absent, or never settled inside the fast-path budget. Either way the
        // honest reading is "the condition does not hold right now".
        matched = false;
      }
    });

    this.bundle.noteBranch(matched);
    return matched;
  }

  /** Assert an input's current value. */
  async expectValue(selector: string, expected: string, intent?: string): Promise<void> {
    const detail: Record<string, unknown> = { expected };
    await this.#step(
      'expectValue',
      selector,
      intent,
      async (locator, timeout) => {
        const actual = await locator.inputValue({ timeout });
        detail['actual'] = actual;
        if (actual !== expected) {
          throw new Error(
            `expected value ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
          );
        }
      },
      detail,
    );
  }

  /** Assert an attribute equals `expected`. */
  async expectAttribute(
    selector: string,
    name: string,
    expected: string,
    intent?: string,
  ): Promise<void> {
    const detail: Record<string, unknown> = { attribute: name, expected };
    await this.#step(
      'expectAttribute',
      selector,
      intent,
      async (locator, timeout) => {
        await locator.waitFor({ state: 'attached', timeout });
        const actual = await locator.getAttribute(name);
        detail['actual'] = actual ?? '(attribute absent)';
        if (actual !== expected) {
          throw new Error(
            `expected @${name} to be ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
          );
        }
      },
      detail,
    );
  }

  // --- API actions ---------------------------------------------------------
  //
  // Delegated to `ApiActions`, which owns them so that a browser-free flow can
  // run exactly the same code without a page. See `src/api/api-actions.ts`.

  /** Make an HTTP call as part of the flow. A non-2xx does not fail the step. */
  async request(spec: FlowRequestSpec): Promise<void> {
    await this.#api.request(spec);
  }

  /** Assert the last response's status. Accepts one status or a set of them. */
  async expectStatus(expected: number | readonly number[], intent?: string): Promise<void> {
    await this.#api.expectStatus(expected, intent);
  }

  /** Assert something about the last response's JSON body. */
  async expectJson(
    path: string,
    options: { value?: string | undefined; intent?: string | undefined } = {},
  ): Promise<void> {
    await this.#api.expectJson(path, options);
  }

  /** Assert a response header. Names are compared case-insensitively. */
  async expectHeader(name: string, value: string, intent?: string): Promise<void> {
    await this.#api.expectHeader(name, value, intent);
  }

  // --- Database verification (delegated; see `src/db/db-actions.ts`) -------

  async dbSnapshot(spec: FlowDbSnapshotSpec): Promise<void> {
    await this.#db.dbSnapshot(spec);
  }

  async expectDbRow(spec: FlowDbRowSpec): Promise<void> {
    await this.#db.expectDbRow(spec);
  }

  /**
   * The agent's read-only database access, offered only when a database is
   * actually configured — an absent probe makes `dbCount` fail with advice
   * instead of a connection error, and never dangles a capability the run
   * cannot honour. Spread into `RunOptions` at the `agent.run` call sites.
   */
  #agentDbProbe(): { dbProbe: AgentDbProbe } | null {
    if (!this.#db.configured) return null;
    return { dbProbe: (table, where) => this.#db.probeCount(table, where) };
  }

  async expectDbDelta(spec: FlowDbDeltaSpec): Promise<void> {
    await this.#db.expectDbDelta(spec);
  }

  async expectDbUnchanged(spec: FlowDbUnchangedSpec): Promise<void> {
    await this.#db.expectDbUnchanged(spec);
  }

  async expectDbCalled(spec: FlowDbCalledSpec): Promise<void> {
    await this.#db.expectDbCalled(spec);
  }

  /**
   * Assert the traffic the page made — the sequence lane of a journey.
   *
   * Ordered-subsequence over the observer's window (see `expect-calls.ts` for
   * the matching semantics), polling through the healed budget because the
   * XHR a click fired is usually still in flight when the assertion starts —
   * the same reasoning that makes `expectUrl` wait rather than peek.
   *
   * Never on the escalation ladder: there is no selector, and "healing" a
   * traffic claim could only repair it onto different traffic. And two of its
   * outcomes are harness facts, not page facts: no observer, and a window the
   * ring buffer truncated — both classify as `error`/environment, file no app
   * defect, and say what dial to turn.
   */
  async expectCalls(spec: FlowExpectCallsSpec): Promise<void> {
    const expected: ExpectedCall[] = this.variables.interpolateDeep([...(spec.calls ?? [])]);
    const never: ExpectedCall[] = this.variables.interpolateDeep([...(spec.never ?? [])]);
    const detail: Record<string, unknown> = {
      ...(spec.intent !== undefined ? { intent: spec.intent } : {}),
      window: spec.since ?? 'mark',
    };

    await this.#bareStep('expectCalls', detail, async () => {
      if (expected.length === 0 && never.length === 0) {
        throw new Error(
          'expectCalls needs at least one entry in `calls` or `never` — an empty check would ' +
            'pass while proving nothing',
        );
      }
      const observer = this.#network;
      if (!observer) {
        throw new ObservationUnavailableError(
          'the page traffic observer is not attached (network observation off, or the browser ' +
            'refused a second CDP session) — this says nothing about the application',
        );
      }

      const windowStart = spec.since === 'run' ? 0 : this.#sequenceMark;
      // The window is truncated when eviction has eaten into it: drops
      // happened AND the oldest retained record starts after the window does.
      const truncated = (): boolean => {
        if (observer.dropped === 0) return false;
        const oldest = observer.all()[0];
        return oldest === undefined || oldest.startedAt > windowStart;
      };
      const truncatedError = (claim: string): ObservationTruncatedError =>
        new ObservationTruncatedError(
          `the observer dropped ${observer.dropped} call(s) and the assertion window reaches ` +
            `past the oldest retained record, so ${claim} cannot be proven — a truncated ` +
            'capture reads exactly like a quiet page. Raise networkMaxCalls, or assert earlier ' +
            'in the journey.',
        );

      const deadline = Date.now() + (spec.timeoutMs ?? this.#healedTimeoutMs);
      for (;;) {
        const observed = observer.since(windowStart);
        detail['observedCalls'] = observed.length;
        detail['dropped'] = observer.dropped;

        // An observed violation is real whatever the buffer dropped.
        const violations = neverViolations(observed, never);
        if (violations.length > 0) {
          const first = violations[0]!;
          detail['violations'] = violations.map(
            ({ expected: entry, call }) =>
              `${describeExpected(entry)} — observed: ${call ? describeCall(call) : ''}`,
          );
          throw new Error(
            `observed a call the flow forbids: ${describeExpected(first.expected)}` +
              (first.call ? ` — ${describeCall(first.call)}` : ''),
          );
        }

        const result = matchExpectedCalls(observed, expected);
        detail['calls'] = matchTable(result);

        if (result.complete) {
          // Presence is proven; absence still needs an intact window.
          if (never.length > 0 && truncated()) throw truncatedError('a "never" claim');
          this.#sequenceMark = observer.mark();
          return;
        }

        if (Date.now() >= deadline) {
          // A missing call over a truncated window may simply have been
          // evicted — failing the step would blame the app for the capture.
          if (truncated()) throw truncatedError('a missing call');
          const missing = result.matches.find((match) => match.call === null)!;
          // The plane hazard, named at the moment it bites: expectCalls can
          // only see traffic the page fires. An endpoint only the test (or a
          // backend service) would call is never observed here however
          // healthy it is — seen live as a high "backend" defect against a
          // seed endpoint nothing on the page calls. The wording must leave
          // the reader with that possibility in hand.
          throw new Error(
            `expected ${describeExpected(missing.expected)} — not observed ` +
              `(${observed.length} call(s) in the window, in order; see the match table). ` +
              `expectCalls watches traffic the page itself makes: if nothing on the page ` +
              `fires this call — because only the test should make it, or a server makes ` +
              `it server-side — author it as a \`request\` step (or drop the claim) rather ` +
              `than reading this as the endpoint being broken.`,
          );
        }
        await sleep(SEQUENCE_POLL_MS);
      }
    });
  }

  /**
   * Record a step that does not participate in the escalation ladder.
   *
   * Used by absence assertions, URL assertions, and state seeding — none of
   * which have a selector the healer could meaningfully repair.
   */
  async #bareStep(
    action: string,
    detail: Record<string, unknown>,
    run: () => Promise<void>,
  ): Promise<void> {
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const selector = typeof detail['selector'] === 'string' ? detail['selector'] : null;
    const intent = typeof detail['intent'] === 'string' ? detail['intent'] : undefined;
    const netMark = this.#takeNetMark();

    // An HTTP or DB step never touched the page, so a picture of the page is
    // not evidence about it — the request/response pair (or check record)
    // already recorded is, and a screenshot here would only assert that
    // something changed when nothing did. Evidence proportionate to what the
    // step actually exercised.
    const touchesPage = !BROWSER_FREE_ACTIONS.has(action);

    try {
      await run();
      this.bundle.addStep({
        action,
        intent,
        selector,
        resolvedSelector: selector,
        // 'fast' means "free path", which is exactly what this was — except
        // for an HTTP step, which never touched the page at all. Counting
        // those as fast-path resolutions inflates a frontend number with
        // backend work and blurs the split the summary is there to make.
        resolution: touchesPage ? 'fast' : null,
        status: 'passed',
        startedAt,
        durationMs: Date.now() - started,
        url: this.page.url(),
        detail,
        screenshot: touchesPage ? await this.#shoot('routine') : undefined,
      });
    } catch (error) {
      const evidence = this.#networkEvidence(netMark);
      this.bundle.addStep({
        action,
        intent,
        selector,
        resolvedSelector: null,
        resolution: null,
        status: 'failed',
        startedAt,
        durationMs: Date.now() - started,
        url: this.page.url(),
        detail,
        error: describe(error),
        network: evidence.calls.length > 0 ? evidence.calls : undefined,
        screenshot: touchesPage ? await this.#shoot('failure') : undefined,
      });
      this.#recordStepFailureDefect(
        action,
        selector ?? undefined,
        describe(error),
        evidence.failures,
        'Assertion',
      );
      throw error;
    }
  }

  /**
   * Hand the browser to the workflow agent until `goal` is reached, then
   * return to the deterministic fast path. Use for multi-page navigations
   * whose interstitials aren't known ahead of time.
   */
  async workflow(goal: string, script?: readonly WorkflowScriptStep[] | undefined): Promise<AgentRecord> {
    const startedAt = new Date().toISOString();
    const started = Date.now();

    if (!this.#agent) {
      const error = new Error(
        `workflow step "${goal}" needs the multi-page agent, but none is configured`,
      );
      this.bundle.addStep({
        action: 'workflow',
        selector: null,
        resolvedSelector: null,
        resolution: null,
        status: 'failed',
        startedAt,
        durationMs: Date.now() - started,
        url: this.page.url(),
        detail: { goal },
        error: error.message,
        screenshot: await this.#shoot('failure'),
      });
      throw error;
    }

    // **What the agent did is recorded as evidence, not only as its own
    // account.** The step carries what the page showed before and after —
    // URL, headings, and every request the page itself made while the agent
    // held it — so a leg nothing asserts on afterwards is still auditable
    // from the report: which page it ended on, what appeared, what the app
    // was asked to do. This is the honest form of "let the agent try and
    // record the screen and API changes as its proof": the agent's claim is
    // still never the verdict (see below), but the changes it caused are on
    // the record for a person to judge, and the film shows the rest.
    const netMark = this.#takeNetMark();
    const urlBefore = this.page.url();
    const headingsBefore = await this.#headingsNow();
    const record = await this.#agent.run(this.page, goal, {
      memory: cacheAgentMemory(this.#cache),
      caseContext: this.#caseContext,
      ...(script === undefined ? {} : { script }),
      ...(this.#agentDbProbe() ?? {}),
    });
    const urlAfter = this.page.url();
    const headingsAfter = await this.#headingsNow();
    const traffic = this.#networkEvidence(netMark);

    // **What the agent claims is never the evidence.** The ladder's agent rung
    // has always obeyed this structurally — it prepares the page and then the
    // author's own selector is retried — and this action did not: a single
    // `!record.success` read decided the step, so an agent that met its goal
    // and then talked itself out of saying so filed a `high` defect against a
    // working application. See `goal-evidence.ts` for the run this came from.
    //
    // The page is asked first. Only when it has nothing to say does the
    // agent's own account stand.
    const evidence = record.success ? null : goalEvidence(goal, urlBefore, urlAfter);
    // A model that could not answer is not an application that could not
    // comply. Same rule the healer follows for `HealUnavailableError`: a
    // provider fact, not a page fact, and it must never be worded as "the goal
    // is unreachable" or counted against the app.
    const providerFailed = !record.success && evidence === null && agentModelUnavailable(record.summary);
    const failed = !record.success && evidence === null;
    // F4 of docs/consent-gate-recovery-spec.md: a failure reported from a
    // page the flow never asked for names the displacement outright. The
    // measured shape: an interstitial dumped the agent elsewhere, it wandered
    // to the wrong page and honestly reported "the button does not exist" —
    // true of the page it was on, false of the page the step began on. The
    // note is what routes a reader to the gate finding instead of filing
    // "the control is missing" against a page that has it.
    const displaced =
      failed && !providerFailed && urlAfter !== urlBefore
        ? ` — note: the agent ended on ${urlAfter}, not the page this step began on (${urlBefore}); ` +
          'the control it reported on may exist on the original page'
        : '';

    this.bundle.addStep({
      action: 'workflow',
      selector: null,
      resolvedSelector: null,
      resolution: null,
      status: failed ? 'failed' : 'passed',
      startedAt,
      durationMs: Date.now() - started,
      url: urlAfter,
      detail: {
        goal,
        turns: record.turns,
        ...(evidence === null ? {} : { settledBy: evidence.rule, evidence: evidence.reason }),
        // The before/after the agent produced, as data. Headings are what a
        // person reads to know which screen they are on; the diff of them is
        // "what appeared". Capped, like every other evidence list.
        urlBefore,
        urlAfter,
        headingsBefore: headingsBefore.slice(0, 8),
        headingsAfter: headingsAfter.slice(0, 8),
        appeared: headingsAfter.filter((h) => !headingsBefore.includes(h)).slice(0, 8),
        callsMade: traffic.calls.length,
      },
      agent: record,
      network: traffic.calls.length > 0 ? traffic.calls : undefined,
      screenshot: await this.#shoot(failed ? 'failure' : 'notable'),
      error: failed ? `${record.summary}${displaced}` : undefined,
    });

    if (evidence !== null) {
      // Green, and still a finding: the goal was met, but the agent spent its
      // whole budget failing to notice, and every run will pay that again
      // until the goal is tightened or the leg is written as ordinary steps.
      this.#recordRuntimeDefect(
        'usability',
        'low',
        `Workflow agent under-reported its own success: ${goal}`,
        `The agent said "${record.summary}" after ${record.turns} turn(s), but ${evidence.reason}. ` +
          'The step is judged on that evidence rather than on the agent\'s account of itself. ' +
          'The turns were still paid for: narrow the goal, or replace this leg with ordinary steps.',
        undefined,
      );
    }

    if (failed) {
      if (providerFailed) {
        // No defect at all. Nothing here is a claim about the application —
        // the agent never reached it.
        throw new Error(
          `workflow agent unavailable: ${record.summary} ` +
            '(this is a SYSTEM failure — the model, not the application; no defect was filed against the app)',
        );
      }
      const exhausted = record.maxSteps !== null && record.turns >= record.maxSteps;
      this.#recordRuntimeDefect(
        'functional',
        // Running out of turns is a fact about the budget, not about the
        // feature: the agent may have been one click away. `high` is reserved
        // for a goal the agent actively determined it could not reach.
        exhausted ? 'medium' : 'high',
        `Workflow goal not reached: ${goal}`,
        exhausted
          ? `${record.summary}${displaced}. The ${record.maxSteps}-turn budget ran out, which is a harness limit rather than ` +
            'an application fact — nothing here says the feature is broken. Narrow the goal, or settle the ' +
            'claim with an assertion after this step.'
          : `${record.summary}${displaced}`,
        undefined,
      );
      throw new Error(`workflow agent failed: ${record.summary}`);
    }

    return record;
  }

  // --- Escalation ladder ---------------------------------------------------

  // --- Secret masking ------------------------------------------------------

  /**
   * The step's detail with a credential-shaped `value` masked.
   *
   * Applied at the recording boundary — the point a live value becomes a
   * stored artefact — which is the same rule and the same moment
   * `src/api/redact.ts` applies to an HTTP payload. The run keeps using the
   * real value throughout; only the record is masked.
   *
   * Measured flaw this closes: a real bundle on disk held
   * `{"action":"fill","selector":"input[type=\"password\"]","detail":{"value":"admin2026"}}`,
   * and the HTML report inlines it — a report deliberately built to be
   * emailable. `--as` made it worse by design, since it exists so a person
   * supplies a REAL credential rather than the model inventing one.
   *
   * Evidence first, wording second:
   *   1. a value the person named via `--as` — unconditional, any field;
   *   2. the field's own `type="password"` — a fact about the document;
   *   3. `looksLikeCredentialField` — the fallback for when the DOM cannot
   *      answer, which is most often a step that failed to resolve at all and
   *      whose value was therefore never typed anywhere, yet is still recorded.
   *
   * Never throws and never waits meaningfully: a masking decision must not be
   * able to fail a step, so an unreadable field simply falls through to (3).
   */
  async #maskValue(
    action: string,
    selector: string,
    intent: string | undefined,
    detail: Record<string, unknown> | undefined,
    resolvedSelector: string | null,
  ): Promise<Record<string, unknown> | undefined> {
    if (detail === undefined) return detail;
    const value = detail['value'];
    if (typeof value !== 'string' || value === '') return detail;

    // The DOM read is skipped when the answer cannot change the outcome — a
    // supplied secret is masked regardless, and a non-typing action is never
    // masked by inference.
    const needsDom =
      !this.#secretValues.has(value) && (action === 'fill' || action === 'type');
    const secret = isSecretStepValue({
      action,
      selector,
      intent,
      value,
      fieldIsPassword: needsDom ? await this.#fieldIsPassword(resolvedSelector) : null,
      secretValues: this.#secretValues,
    });
    return secret ? { ...detail, value: maskSecret(value) } : detail;
  }

  /**
   * Is the resolved field an `<input type="password">`?
   *
   * `null` means "could not tell" — gone, detached, not an input, or the read
   * threw — which is deliberately distinct from `false` so the caller can fall
   * back to the wording heuristic rather than treating silence as a denial.
   */
  async #fieldIsPassword(resolvedSelector: string | null): Promise<boolean | null> {
    if (resolvedSelector === null) return null;
    try {
      const type = await this.page
        .locator(resolvedSelector)
        .first()
        .getAttribute('type', { timeout: ATTRIBUTE_READ_TIMEOUT_MS });
      return type === null ? null : type.toLowerCase() === 'password';
    } catch {
      return null;
    }
  }

  /** Mask any `--as` value inside a composite record's own values. */
  #maskSuppliedSecret(value: string): string {
    return this.#secretValues.has(value) ? maskSecret(value) : value;
  }

  /**
   * A whole step with any credential-shaped `value` masked, for the records
   * that store a step verbatim rather than as `detail` — `ReconstructionRecord`
   * serialises `from`/`to` in full, so masking the recorded step's own detail
   * leaves that copy untouched.
   *
   * No DOM read here: this runs after the fact, on a step that may never have
   * resolved, so it is the wording heuristic and the `--as` set — exactly the
   * evidence available at this point.
   */
  maskStepSecrets<T>(step: T): T {
    const candidate = step as { value?: unknown; selector?: unknown; intent?: unknown };
    const value = candidate.value;
    if (typeof value !== 'string' || value === '') return step;
    const secret = isSecretStepValue({
      action: String((step as { action?: unknown }).action ?? ''),
      selector: typeof candidate.selector === 'string' ? candidate.selector : '',
      intent: typeof candidate.intent === 'string' ? candidate.intent : undefined,
      value,
      fieldIsPassword: null,
      secretValues: this.#secretValues,
    });
    return secret ? ({ ...step, value: maskSecret(value) } as T) : step;
  }

  async #step(
    action: string,
    selector: string,
    intent: string | undefined,
    run: (locator: Locator, timeoutMs: number) => Promise<unknown>,
    detail?: Record<string, unknown>,
  ): Promise<void> {
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const netMark = this.#takeNetMark();

    try {
      const result = await this.#resolve(action, selector, intent, run, netMark);
      this.bundle.addStep({
        action,
        intent,
        selector,
        resolvedSelector: result.resolvedSelector,
        resolution: result.resolution,
        status: 'passed',
        startedAt,
        durationMs: Date.now() - started,
        url: this.page.url(),
        detail: await this.#maskValue(action, selector, intent, detail, result.resolvedSelector),
        heal: result.heal,
        dialog: result.dialog,
        agent: result.agent,
        decision: result.decision,
        screenshot: await this.#shoot(
          // A heal, a dismissed dialog or an agent intervention is a passing
          // step that still changed what the test exercised; the rest are
          // ordinary filmstrip frames.
          result.resolution === 'jit' ||
            result.resolution === 'dialog' ||
            result.resolution === 'agent'
            ? 'notable'
            : 'routine',
        ),
      });

      if (result.heal) {
        // A heal is a passing step that still tells you something drifted.
        this.#recordRuntimeDefect(
          'functional',
          'low',
          `Selector drifted: ${selector}`,
          `Repaired to "${result.heal.to}" (${result.heal.strategy}, confidence ${result.heal.confidence.toFixed(2)}). ` +
            `Update the test to stop paying for this repair.`,
          selector,
        );
      }

      if (result.dialog) {
        // A passing step that still tells you something: the page put up an
        // unexpected dialog in the way. Real users hit the same friction.
        this.#recordRuntimeDefect(
          'usability',
          'medium',
          `Unexpected dialog blocked a step: ${selector}`,
          `"${result.dialog.name}" appeared and was dismissed via its "${result.dialog.button}" ` +
            `control before the step could proceed. If this dialog is expected, assert on it explicitly ` +
            `with expectModal/closeModal instead of relying on automatic recovery.`,
          selector,
        );
      }
    } catch (error) {
      const evidence = this.#networkEvidence(netMark);
      const resolution = error instanceof StepResolutionError ? error : undefined;
      // What the page is saying, read once on the failure path. A denial
      // heading still leads when the ladder found one — it is the harder stop
      // — and a live-region message follows, or leads when there is no denial.
      const pageContext = [...(resolution?.pageContext ?? []), ...(await this.#pageMessages())];
      // **An exact-match miss over text the page HOLDS is a wording question,
      // not an absence.** `text="X"` and `role=…[name="X"]` demand a whole
      // element whose text/name IS X; a page rendering X inside a longer
      // sentence fails them at any timeout while a reader sees the text
      // plainly on screen (be100 PL_06_10: `text="Plan ID already exists"`
      // dead-ended against a toast holding exactly that sentence, 40s and a
      // healer call to disprove nothing). One $0 read settles which case this
      // is: when the asserted text is contained in the page's own innerText,
      // the step keeps its failure but carries the evidence
      // (`expected`/`actual`/`foundInPageText`), and `finish()` classifies
      // the run proved-? for a human to rule — never a silent pass, never a
      // bare "could not resolve" about text that is there.
      if (PRESENCE_ACTIONS.has(action)) {
        // Only `expectText`'s expected IS content. The state assertions record
        // a state label there — `expectVisible` writes the literal word
        // "visible" — and probing the page for THAT stamped `foundInPageText`
        // on any page that happens to render the English word "visible"
        // (tests/evidence.test.ts's fixture, live): a dead-ended CSS selector
        // then read as a wording question about text nobody asserted. For
        // everything else the only content worth probing is the selector's
        // own name (`text=`/`role=[name=…]`); a CSS selector has none and is
        // never stamped.
        const wanted =
          action === 'expectText' && typeof detail?.['expected'] === 'string'
            ? (detail['expected'] as string)
            : (selectorName(selector) ?? '');
        const contained = wanted === '' ? null : await this.#textContainedInPage(wanted);
        if (contained !== null) {
          detail = {
            ...(detail ?? {}),
            expected: wanted,
            actual: contained,
            foundInPageText: true,
          };
        }
      }
      this.bundle.addStep({
        action,
        intent,
        selector,
        resolvedSelector: null,
        resolution: null,
        status: 'failed',
        startedAt,
        durationMs: Date.now() - started,
        url: this.page.url(),
        // A failed step never resolved, so there is no field to read a type
        // from — the wording fallback carries this path alone, which is
        // exactly the case it exists for.
        detail: await this.#maskValue(action, selector, intent, detail, null),
        // A StepResolutionError's later lines are the escalation trace — the
        // rung-by-rung account `escalationTrace()` in the reporter parses.
        // `describe()` keeps only the first line, which is right for prose
        // and would silently erase the trace from every report and bundle.
        error: resolution ? resolution.message : describe(error),
        // Diagnostics the ladder gathered on the way down: what the page was
        // showing, and which repairs were proposed and refused. Both are
        // evidence a reader needs and neither survives as anything but a
        // trace substring otherwise.
        pageContext: pageContext.length > 0 ? pageContext : undefined,
        rejectedHeals: resolution?.rejectedHeals,
        decision: resolution?.decision,
        network: evidence.calls.length > 0 ? evidence.calls : undefined,
        screenshot: await this.#shoot('failure'),
      });
      if (resolution) {
        // Remember an exhausted ladder for this page+selector, so an identical
        // retry later in the run fails in one attempt instead of repaying the
        // whole ladder and another model call. Backend and stranded stops are
        // excluded: those describe a moment, not the page's answer.
        const transient = resolution.attempts.some(
          (line) => line.startsWith('backend:') || line.startsWith('declined to heal:'),
        );
        if (!transient) {
          this.#deadResolutions.set(
            CacheManager.key(this.page.url(), selector),
            this.bundle.steps.length - 1,
          );
        }
      }
      this.#recordStepFailureDefect(action, selector, describe(error), evidence.failures);
      throw error;
    }
  }

  /**
   * Attribute a failed step to the backend when the evidence supports it.
   *
   * The wording matters and is deliberately correlational: we know a request
   * failed while this step was waiting, not that it caused the step to fail.
   * Overclaiming here would be the same mistake `ax-coverage.ts` refuses to
   * make when it declines to credit a CSS selector it cannot attribute.
   */
  #recordStepFailureDefect(
    action: string,
    selector: string | undefined,
    message: string,
    failures: readonly NetworkCall[],
    /** "Step" for an interaction, "Assertion" for a check — kept from before. */
    label: 'Step' | 'Assertion' = 'Step',
  ): void {
    // A harness fact files no application defect: "the observer was not
    // attached" and "the buffer truncated the window" say nothing about the
    // app, and a defect would send someone hunting a bug nobody claimed
    // exists. Same prefix matching the exit contract uses.
    if (/^(?:database unavailable|network observation)/.test(message)) return;
    if (failures.length === 0) {
      // A backend-tier step that failed is a backend finding by construction —
      // there is no selector, no page, and nothing a test author can repair.
      // Filing it as `functional` would put a 500 on the UI team's pile.
      this.#recordRuntimeDefect(
        BACKEND_TIER_ACTIONS.has(action) ? 'backend' : 'functional',
        'high',
        `${label} failed: ${action}${selector ? ` ${selector}` : ''}`,
        message,
        selector,
      );
      return;
    }

    const listed = failures.slice(0, MAX_STEP_EVIDENCE).map(describeCall).join('\n  ');
    this.#recordRuntimeDefect(
      'backend',
      'high',
      `Backend call failed during: ${action}${selector ? ` ${selector}` : ''}`,
      `${failures.length} request(s) failed while this step was waiting:\n  ${listed}\n\n` +
        `The step itself reported: ${message}\n` +
        'This is a correlation, not a proof of cause — but a failing request is a far more ' +
        'likely explanation for a control that never appeared than a drifted selector, so no ' +
        'repair was attempted. Fix the request before touching the test.',
      selector,
    );
  }

  /**
   * Calls worth attaching to a failed step: the ones that failed, plus a
   * little surrounding traffic for context when nothing failed outright.
   */
  /**
   * Take this step's network mark, and remember where the previous step began.
   *
   * The evidence window reaches back to the *previous step's start*, not just
   * a fixed lookback from this one: the request that starves a step is almost
   * always fired by the step before it, and a fixed 3s window loses exactly
   * that call as soon as the prior step runs long. PB-02-01's login block
   * spent 20s+ per step walking the ladder, and three failed steps in a row
   * carried no network evidence at all while their neighbours did.
   */
  /** The page's headings right now — the cheapest honest "which screen is this". */
  async #headingsNow(): Promise<string[]> {
    try {
      const texts = await this.page.locator('role=heading').allInnerTexts();
      return texts.map((t) => t.replace(/\s+/g, ' ').trim()).filter((t) => t !== '');
    } catch {
      return [];
    }
  }

  #takeNetMark(): number | undefined {
    if (!this.#network) return undefined;
    const mark = this.#network.mark();
    this.#evidenceFloorMs = Math.min(mark - NETWORK_LOOKBACK_MS, this.#previousNetMark ?? mark);
    this.#previousNetMark = mark;
    return mark;
  }

  #networkEvidence(mark: number | undefined): {
    calls: NetworkCall[];
    failures: NetworkCall[];
  } {
    if (mark === undefined || !this.#network) return { calls: [], failures: [] };
    try {
      const since = this.#network.since(this.#evidenceFloorMs ?? mark - NETWORK_LOOKBACK_MS);
      const failures = since.filter(isBlockingFailure);
      const calls =
        failures.length > 0 ? failures.slice(0, MAX_STEP_EVIDENCE) : since.slice(-MAX_STEP_EVIDENCE);
      return { calls, failures };
    } catch {
      return { calls: [], failures: [] };
    }
  }

  /**
   * Detect a heal that was really a race condition.
   *
   * If the *original* selector resolves once the page has settled, it was
   * never broken — it was slow, and the 2s fast-path budget expired first.
   * Healing "fixes" that invisibly and permanently, so the flake never gets
   * diagnosed. One cheap re-check turns it into a reported defect.
   */
  async #flagTimingHeal(original: string, healed: string): Promise<void> {
    if (original === healed) return;
    try {
      const count = await this.page.locator(original).count();
      if (count === 0) return; // Genuine drift: the original really is gone.
    } catch {
      return;
    }

    this.#recordRuntimeDefect(
      'functional',
      'medium',
      `Heal masked a timing issue: ${original}`,
      `"${original}" resolves once the page settles, so it was not broken — it was slower ` +
        `than the ${this.#fastTimeoutMs}ms fast-path budget. The heal to "${healed}" hides a ` +
        'race condition rather than fixing it. Add an explicit wait for the state this step ' +
        'depends on instead of relying on the repair.',
      original,
    );
  }

  /**
   * Report a text selector that was written tighter than the page renders.
   *
   * The relax rung is a rescue, not an absolution: the flow quoted a rendering
   * the application does not use, and left alone it will pay this rung on
   * every run forever. `low` because nothing about the application is wrong —
   * DB_07_01's `text="75,000"` against a page rendering `฿75,000.00` was two
   * `high` defects filed at a working feature, and the honest replacement is
   * one small note telling the author what the page actually says.
   *
   * The matched text is read back so the finding names the real rendering
   * rather than describing the shape of the problem. Best-effort: a read that
   * fails must not turn a rescued step into a failed one.
   */
  async #flagOverExactText(original: string, relaxed: string): Promise<void> {
    let shown: string | null = null;
    try {
      const text = await this.page.locator(relaxed).first().innerText({ timeout: 1_000 });
      shown = text.trim().replace(/\s+/g, ' ').slice(0, 120) || null;
    } catch {
      shown = null;
    }

    this.#recordRuntimeDefect(
      'functional',
      'low',
      `Text selector was more exact than the page: ${original}`,
      `"${original}" matches an element's WHOLE text, and the page renders that value with ` +
        `more around it${shown ? ` — it shows "${shown}"` : ''}. Matched instead as ` +
        `"${relaxed}". The assertion holds; the selector was written tighter than the ` +
        'rendering. Quote what the page actually shows (or use the unquoted substring form) ' +
        'so the suite stops paying this rung every run.',
      original,
    );
  }

  #recordRuntimeDefect(
    category: Defect['category'],
    severity: Defect['severity'],
    title: string,
    detail: string,
    selector: string | undefined,
  ): void {
    this.#defectSeq += 1;
    this.bundle.addDefect({
      id: `run-${this.#defectSeq}`,
      source: 'runtime',
      category,
      severity,
      title,
      detail,
      selector,
      stepIndex: this.bundle.steps.length - 1,
    });
  }

  /**
   * The page's url, or null when there isn't one.
   *
   * A `request` step can run before anything has been navigated to — the page
   * is on `about:blank` — and reporting that as the step's location is worse
   * than reporting nothing, since it reads like a navigation bug.
   */
  #currentUrl(): string | null {
    const url = this.page.url();
    return url && url !== 'about:blank' ? url : null;
  }

  /**
   * Capture what the page looked like at this step.
   *
   * The kinds, the size decisions and the never-throws rule all live in
   * `evidence.ts`, because the crawler captures on the same terms and two
   * copies of that rule would drift.
   */
  async #shoot(kind: EvidenceKind): Promise<string | undefined> {
    return captureEvidence(this.page, this.#screenshots, kind, this.#captureDelayMs);
  }

  /**
   * Notice that the application moved the run somewhere it never asked to go.
   *
   * This is the shape of a lost session, and it is invisible in the verdict
   * without help. PB_02_01 asked for `/en/workflows/probation/PB-001`, was
   * bounced to `/en/login` while a `setLocalStorage` step ran, and spent its
   * remaining 24 steps on the sign-in page — reported as six unresolvable
   * selectors, which reads as "the front end is broken" and is not what
   * happened.
   *
   * **The test is factual, not a guess about authentication.** It only fires
   * when the URL changed between two adjacent steps *neither of which can
   * navigate* — no `goto`, no `click`, nothing that follows a link. When that
   * is true the application moved by itself, which is worth saying whatever
   * the reason. Only reported for a run that actually failed: a self-directed
   * redirect that broke nothing is an app's business, not a finding.
   */
  #flagUnrequestedNavigation(): void {
    // The stranded guard already said this, with more for a reader to act on.
    if (this.#strandedReported) return;
    const steps = this.bundle.steps;
    if (!steps.some((step) => step.status !== 'passed')) return;

    let previous: { url: string; action: string } | null = null;
    for (const step of steps) {
      const url = step.url;
      if (url === null) continue;
      if (
        previous !== null &&
        !NAVIGATING_ACTIONS.has(previous.action) &&
        !NAVIGATING_ACTIONS.has(step.action) &&
        differentPage(previous.url, url)
      ) {
        const signIn = looksLikeSignIn(url);
        this.#recordRuntimeDefect(
          'functional',
          'high',
          signIn
            ? 'The application redirected the run to a sign-in page'
            : 'The application navigated the run somewhere it did not ask to go',
          `Between "${previous.action}" and "${step.action}" — neither of which navigates — ` +
            `the page moved from ${previous.url} to ${url}. ` +
            (signIn
              ? 'Every step after this one ran against the sign-in page, so failures below ' +
                'describe that page and not the feature under test. This is what a missing ' +
                'or expired session looks like: check that the browser is signed in, and ' +
                'that any token the flow seeds is applied before the app decides.'
              : 'Steps after this one ran against a different page than the flow intended.'),
          undefined,
        );
        return; // once is the finding; repeating it per step is noise
      }
      previous = { url, action: step.action };
    }
  }

  /**
   * Record what the recording context did or did not bring with it.
   *
   * A filmed run that starts signed out does not fail in a way that says so.
   * It fails as a pile of unresolvable selectors, on a login page the flow
   * never asked for, and the report blames the front end — which is how
   * PB_02_01 came to file six defects about an application that was fine.
   * So the one moment the truth is knowable, it is written down.
   */
  #noteSessionInheritance(inheritance: SessionInheritance): void {
    // Declined is a decision, not a defect: the flow authenticates itself and
    // asked for a clean start. Recorded on the bundle's notes so the report
    // says why this run held no cookies at step 0.
    if (inheritance.declined) {
      this.bundle.note(
        'session: started from an empty context — the flow signs in itself, so the ' +
          "attached browser's session was deliberately not inherited",
      );
      return;
    }
    if (inheritance.fromSuite) {
      this.bundle.note(
        `session: reused the session a sibling case of this suite established ` +
          `(${inheritance.state?.cookies.length ?? 0} cookie(s)) — no sign-in was paid for`,
      );
      return;
    }
    const carried = inheritance.state?.cookies.length ?? 0;
    if (inheritance.error !== undefined) {
      this.#recordRuntimeDefect(
        'functional',
        'high',
        'The run could not inherit the browser’s session',
        `Filming needs its own browser context, and this one could not copy the attached ` +
          `browser's cookies (${inheritance.error}). If the application requires a login, ` +
          `every step after the first redirect is happening on the sign-in page. Re-run with ` +
          `--video off to use the browser's own context.`,
        undefined,
      );
      return;
    }
    if (inheritance.available > 0 && carried === 0) {
      this.#recordRuntimeDefect(
        'functional',
        'high',
        'The run started without the browser’s session',
        `The attached browser held ${inheritance.available} cookie(s) but the recording ` +
          `context received none. If the application requires a login, this run is testing ` +
          `the sign-in page. Re-run with --video off to use the browser's own context.`,
        undefined,
      );
    }
  }

  /**
   * Where the recording should stop, or `null` to keep none of it.
   *
   * The rule: **a recording is evidence of a failure.** It runs from the start
   * of the flow — the state leading up to a failure is most of what makes it
   * diagnosable — and ends at the step that broke. A run where nothing broke
   * produces no video at all, which is what keeps this affordable as a
   * default: the reports that carry a recording are exactly the ones somebody
   * is going to open.
   *
   * The *first* failure, not the last. Once a step has failed the run
   * continues, and everything after it is happening in a state the test no
   * longer understands — so the later failures are usually consequences, and
   * the first one is the one worth watching.
   *
   * A failed step with no offset (an HTTP step, or a failure before filming
   * began) cuts nothing: there is no moment on film to cut to, and guessing
   * one would produce a video that claims to end at a step it never saw.
   */
  #videoCut(): VideoCut {
    const steps = this.bundle.steps;
    let sawSuperseded = false;
    let firstBroken: ProofStep | undefined;
    for (const step of steps) {
      if (step.status === 'passed') continue;
      // A superseded failure is an attempt, not the outcome — its
      // reconstruction passed in its place, and the run went on. Cutting the
      // film at it produced a PASSED run whose recording showed two steps of
      // five (seen live: "Navigate to Contact Us Page", cut at a rescued
      // expectUrl while the rescue and everything after went unfilmed).
      if (step.superseded) {
        sawSuperseded = true;
        continue;
      }
      if (step.videoOffsetMs === undefined) continue;
      firstBroken = step;
      break;
    }
    if (firstBroken === undefined) {
      // A run rescued mid-flight keeps its WHOLE film: the break and the
      // rescue are exactly the footage the drift defect asks someone to look
      // at. A run that passed cleanly still keeps nothing.
      return sawSuperseded ? 'full' : null;
    }
    // **The run carried on past the failure, so the film does too.** The
    // "cut at the first broken step" rule was written when a failure ended
    // the run, and its premise — everything afterwards is a state the test
    // no longer understands — stopped being true when steps after a failure
    // started getting their turn. Measured (BE_Test2, 2026-08-19): a flow
    // dead-ended clicking "Create Plan" at step 3, clicked the same control
    // and passed at step 6, passed both assertions — and its recording was
    // 13 seconds ending at step 1, the one part of the run that proved
    // nothing. Is the footage after the break relevant? It is the only
    // evidence of what the run did about the break. The report's player
    // still opens pre-seeked to the first broken step (`data-failure-offset`),
    // so the moment the film was kept for is the first frame seen; the rest
    // is scrub-able rather than gone. A run whose failure was its LAST filmed
    // step is cut there as before — there is nothing after it to keep.
    const later = steps.some(
      (s) => s.index > firstBroken!.index && s.videoOffsetMs !== undefined && !s.superseded,
    );
    if (later) return 'full';
    return {
      stepIndex: firstBroken.index,
      atMs: firstBroken.videoOffsetMs! + firstBroken.durationMs,
    };
  }

  /**
   * Stop the run if it is stranded on a sign-in page it never asked for.
   *
   * **This is the guard that turns the single most common wasted run into one
   * sentence.** An application that requires a login redirects every protected
   * URL to its sign-in page, and a flow whose session did not take then spends
   * every remaining step there: assertions fail because the feature is not on
   * this page, the healer repairs some of them onto login-page controls and
   * reports them green, and the run ends with a pile of defects about an
   * application that is working perfectly.
   *
   * Called before each step, so nothing runs — and nothing heals — once the
   * run is somewhere it cannot answer the question it was asked.
   *
   * Three conditions, all required, so a flow that *means* to be on a sign-in
   * page is never stopped:
   *
   * - the page is on a sign-in URL now;
   * - the MOST RECENT `goto` did not ask for a sign-in page — per-goto, not
   *   "any goto in this run": a flow that logs in first always has a login
   *   goto in its past, and the run-wide version of this exemption is what
   *   let a bounced post-login navigation spend six steps dead-ending
   *   against login furniture (seen live: the whole DB_04 create-plan body
   *   filed high frontend defects from /en/login);
   * - the last `goto` asked for a different page, i.e. we were sent here.
   *
   * A `click` is exempt: following a "Sign out" control is a legitimate way to
   * arrive, and the flow that clicked it knows where it is going.
   */
  assertSessionHeld(): void {
    const message = this.#strandedMessage();
    if (message === null) return;
    if (!this.#strandedReported) {
      this.#strandedReported = true;
      // Before the defect and before the throw: the verdict must hold even
      // when a later path swallows the error. See `noteSessionLost`.
      this.bundle.noteSessionLost();
      this.#recordRuntimeDefect(
        'functional',
        'high',
        this.#signInDidNotTake
          ? 'The sign-in never took effect — the run held no session'
          : 'The run lost its session and was sent to the sign-in page',
        message,
        undefined,
      );
    }
    throw new SessionLostError(message);
  }

  /**
   * The stranded diagnosis, or `null` when the run is where it should be.
   *
   * Split out from `assertSessionHeld` so the escalation ladder can consult it
   * without stopping the run: a step whose page was redirected *while it ran*
   * must decline to heal, but it is still an ordinary failed step.
   */
  /**
   * Establish the session this flow assumes, when it can be done honestly.
   * Returns the account it signed in as, or null when nothing was done.
   */
/**
   * F1 of docs/consent-gate-recovery-spec.md: if the page a `goto` landed on
   * is SHOWING the consent gate — content-detected, because the gate renders
   * in place on the asked-for URL — accept it and re-issue the same goto
   * once. Runs whether the flow signed in itself or the bootstrap did; a goto
   * that asked for the gate's own page keeps its subject and is never
   * touched. Once per goto: a gate that re-renders after acceptance is an
   * application finding, and the next step fails honestly with the gate in
   * its pageContext.
   */
  async #settleConsentGate(askedUrl: string, urlBeforeNav: string): Promise<boolean> {
    try {
      const asked = new URL(askedUrl, this.page.url() || undefined);
      // A flow that means to test the consent page is never steered off it.
      if (CONSENT_GATE_URL_PATTERN.test(asked.pathname)) return false;
    } catch {
      return false;
    }
    let accepted = await acceptConsentGateAnywhere(this.page);
    if (!accepted) {
      // The gate has a THIRD shape on the measured application: the goto
      // lands on the target URL, and the client guard bounces to /en/consent
      // a beat AFTER domcontentloaded — so an immediate check sees nothing.
      // The tell is cheap and does not tax ordinary gotos: the page was ON a
      // consent URL before this goto (the sign-in just landed there), or is
      // on one now. Only then is a short bounce-window paid, and the re-check
      // also catches an in-place gate that finished rendering meanwhile.
      const expectGate =
        CONSENT_GATE_URL_PATTERN.test(this.page.url()) ||
        (() => {
          try {
            return CONSENT_GATE_URL_PATTERN.test(new URL(urlBeforeNav).pathname);
          } catch {
            return false;
          }
        })();
      if (expectGate) {
        await this.page
          .waitForURL((u) => CONSENT_GATE_URL_PATTERN.test(u.pathname), { timeout: 2_000 })
          .catch(() => undefined);
        await this.page.waitForTimeout(300).catch(() => undefined);
        accepted = await acceptConsentGateAnywhere(this.page);
      }
    }
    if (!accepted) return false;
    // Accepting abandons the deep link (the app lands on its home page), so
    // the recovery is only done once the goto is re-issued.
    await this.page.goto(askedUrl, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    await this.page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
    this.bundle.note(
      `consent gate: accepted the consent screen that stood in front of ${askedUrl} and returned to it`,
    );
    this.#recordRuntimeDefect(
      'usability',
      'low',
      'A consent gate stood in front of the page under test',
      `The navigation to ${askedUrl} landed on a consent screen; the run accepted it ` +
        `(name-gated control) and re-issued the navigation. Author the consent accept into ` +
        `setup (a clickIfVisible right after sign-in) to make the flow self-contained.`,
      undefined,
    );
    return true;
  }

  async #bootstrapSession(askedUrl: string): Promise<string | null> {
    if (this.#credentials === undefined) return null;
    if (this.#flowSignsInItself) return null;
    if (this.#sessionBootstrapTried) return null;
    if (this.#lastGotoAskedSignIn) return null;
    // A consent gate is the session HALF established — accept it and go on.
    if (await acceptConsentGate(this.page)) {
      if (!looksLikeSignIn(this.page.url())) return null;
    }
    if (!looksLikeSignIn(this.page.url())) return null;
    this.#sessionBootstrapTried = true;

    const outcome = await performSignIn(this.page, this.#credentials);
    if (!outcome.ok) {
      // Disclosed and left to the ordinary fatal: a sign-in the harness could
      // not complete says the credentials or the form are the problem, and
      // pretending otherwise would bury it.
      this.bundle.note(
        `session bootstrap: signing in as ${this.#credentials.email} did not take — ${outcome.reason}`,
      );
      return null;
    }
    await this.page.goto(askedUrl, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    await this.page
      .waitForLoadState('networkidle', { timeout: 10_000 })
      .catch(() => undefined);
    this.bundle.note(
      `session bootstrap: the flow assumes a signed-in user and the browser had no session, ` +
        `so the run signed in as ${this.#credentials.email} and returned to ${askedUrl}`,
    );
    // Green, and still a finding: the flow depends on a precondition it does
    // not establish, and every fresh browser will pay this again until the
    // sign-in is authored into setup (or --as keeps being supplied).
    this.#recordRuntimeDefect(
      'usability',
      'low',
      'The flow assumes a signed-in user',
      `Its first navigation landed on the sign-in page, so the run established the session ` +
        `itself with the supplied --as credentials (${this.#credentials.email}). Author the ` +
        `sign-in into setup to make the flow self-contained.`,
      undefined,
    );
    return this.#credentials.email;
  }

  #strandedMessage(): string | null {
    // The sign-in that never took, as opposed to the session that was lost.
    // `#strandedMessage`'s original question is "were we bounced AWAY from
    // what we asked for?", which needs `path !== #lastGotoPath` — and in a
    // flow that logs in first, the most recent goto IS the login page, so it
    // correctly declines and the run carries on unauthenticated. That is how
    // DB_04_01 filed six high frontend defects, DB_06_01 five, DB_07_01 five
    // and DB_08_01 three, every one of them about an application that was
    // fine: the login silently failed and everything after it ran on a page
    // the flow had no session for.
    //
    // This branch asks the other question — "did the sign-in work at all?" —
    // and it never guesses: `#signInDidNotTake` is set only from the hydration
    // signatures, after a replay that failed to rescue them. It deliberately
    // does NOT require the current page to look like a sign-in page: this app
    // renders a protected route for a beat before its client guard bounces
    // it, so "where are we now" is the wrong evidence. The trigger is the
    // flow asking for a page that needs a session — which is also what
    // exempts a negative sign-in test, since one that stays on the login page
    // to assert an error message never sets `#lastGotoAskedSignIn` false.
    const neverSignedIn = signInDidNotTakeMessage({
      signInDidNotTake: this.#signInDidNotTake,
      lastGotoAskedSignIn: this.#lastGotoAskedSignIn,
      lastGotoPath: this.#lastGotoPath,
    });
    if (neverSignedIn !== null) return neverSignedIn;
    // `click` is exempt (following a "Sign out" control is a legitimate way
    // to arrive) and so is `signOut`, which is that same arrival made
    // explicit — a persona switch MEANS to be on the sign-in page next.
    if (this.#lastGotoAskedSignIn || this.#lastAction === 'click' || this.#lastAction === 'signOut')
      return null;
    const current = this.page.url();
    if (!looksLikeSignIn(current)) return null;
    if (this.#lastGotoPath === null) return null;
    let path: string;
    try {
      path = new URL(current).pathname;
    } catch {
      return null;
    }
    if (path === this.#lastGotoPath) return null;

    return (
      `the run is on the sign-in page (${current}) after asking for ` +
      `${this.#lastGotoPath} — the session is not established, so nothing after this ` +
      `point can say anything about the feature under test.\n` +
      `  Every later step would be asserted against the login screen, and a heal could ` +
      `"fix" one onto a login control and report it green.\n` +
      (this.#credentials === undefined && !this.#flowSignsInItself
        ? `  The flow contains no sign-in of its own and the run was given no account: pass ` +
          `--as <email>:<password> and the run will establish the session itself before ` +
          `continuing.\n`
        : '') +
      `  Fix the flow's sign-in: log in through the UI before the steps that need it, ` +
      `and if it seeds a token with setLocalStorage, navigate again afterwards so the ` +
      `application reads it.`
    );
  }

  /**
   * The pause before a step, when pacing is on. After `narrate` on purpose:
   * the caption names the step about to happen, and the pause is when a
   * viewer reads it and sees the state it starts from.
   */
  async paceStep(): Promise<void> {
    if (this.#stepDelayMs <= 0) return;
    await this.page.waitForTimeout(this.#stepDelayMs).catch(() => undefined);
  }

  /**
   * Record how a credential submit ended.
   *
   * Called for every credential-shaped click: `true` when a hydration
   * signature fired AND the page is still on the sign-in URL afterwards —
   * the submit demonstrably did not take. `false` clears it, so a flow that
   * retries its login and succeeds is not haunted by the first attempt.
   */
  noteSignInOutcome(didNotTake: boolean): void {
    this.#signInDidNotTake = didNotTake;
  }

  /** Remember what just ran, for `assertSessionHeld`. */
  noteAction(action: string): void {
    this.#lastAction = action;
  }

  /**
   * A form submitted natively before the app hydrated — see
   * `nativeFormResubmitDetected`. Two findings in one: the harness raced the
   * page (and recovered by replaying), and the application let a credential
   * form degrade to a native GET, which puts what was typed — passwords
   * included — into URLs, browser history and server logs.
   */
  recordNativeResubmitFinding(step: FlowStep, param: string): void {
    this.#recordRuntimeDefect(
      'usability',
      'medium',
      'Form submitted natively before the app hydrated',
      `Clicking ${(step as { selector?: string }).selector ?? step.action} landed before the ` +
        `application attached its submit handler, so the browser performed the form's default ` +
        `GET submission — ${
          param === NATIVE_SUBMIT_UNNAMED
            ? "the URL gained a query string it did not have when the credentials were typed (the form's inputs carry no name attribute, so it submitted a bare \"?\")"
            : `form values (parameter "${param}") appeared in the page URL`
        } and no ` +
        `session was created. The run waited for hydration and replayed the fill block and the ` +
        `click once. This is also an application finding: a form that degrades to a native GET ` +
        `submission exposes what was typed in the URL.`,
      (step as { selector?: string }).selector,
    );
  }

  /**
   * The race's second signature — see `fillsLostToHydration`. Same class of
   * finding as `recordNativeResubmitFinding`: the harness typed faster than
   * the app could listen, and the recovery is disclosed, never silent.
   */
  recordLostFillFinding(step: FlowStep, lostSelector: string): void {
    this.#recordRuntimeDefect(
      'usability',
      'medium',
      'Filled fields were reset by hydration before the submit',
      `The fills landed before the application hydrated, and hydration reset its controlled ` +
        `inputs — ${lostSelector} no longer held what the flow typed when ` +
        `${(step as { selector?: string }).selector ?? step.action} was clicked, so the form ` +
        `submitted without it and no session was created. The run waited for hydration and ` +
        `replayed the fill block and the click once. This is also an application finding: a ` +
        `form a fast user can fill before hydration silently discards their input.`,
      (step as { selector?: string }).selector,
    );
  }

  /** A rescued step is also a finding: the flow is drifting from the app. */
  recordReconstructionDefect(step: FlowStep, failures: number): void {
    this.#recordRuntimeDefect(
      'functional',
      'medium',
      `Step reconstructed in-run: ${step.action}${'selector' in step ? ` ${(step as { selector?: string }).selector ?? ''}` : ''}`,
      `This step only passed after ${failures} failed attempt(s) and an in-run rebuild by the ` +
        'repair model. The run is green, but the flow as written no longer matches the ' +
        'application — update the step (see the reconstruction record on it) so the suite ' +
        'stops paying a model every run.',
      'selector' in step ? (step as { selector?: string }).selector : undefined,
    );
  }

  /**
   * The denial heading the page is showing right now, or null.
   *
   * Deterministic and free: one non-waiting locator read of the page's
   * headings, matched against `DENIAL_HEADING_PATTERN`. Anything that goes
   * wrong reads as "no denial" — this is a guard, and a guard that can fail a
   * step by itself would be worse than the miss it prevents.
   */
  async #denialSurface(): Promise<string | null> {
    try {
      const headings = await this.page.locator('role=heading').allInnerTexts();
      const denial = headings.find((text) => DENIAL_HEADING_PATTERN.test(text));
      return denial?.trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * What the page is telling the user right now — its live-region messages.
   *
   * A failure's diagnosis is frequently written on the screen in words, and
   * wowlidator was not reading it. Adjudicated live on DB_06_01: the flow
   * filled two of the rule form's required fields and clicked Save;
   * `RuleForm.tsx` refuses the save and raises a warning toast naming the
   * missing field, so the row never appeared and `expectVisible` was filed as
   * a `high` application defect. The application was working correctly *and
   * said so* — that sentence is the finding, and the report showed "could not
   * resolve" instead.
   *
   * ARIA only (`role="alert"` / `role="status"`), the same understate-never-
   * overstate rule `modal.ts` applies to dialog detection: a hand-rolled
   * toast `<div>` with no live-region role is a disclosed gap, not something
   * guessed at from class names. Non-waiting and hard-capped — this runs on a
   * path that has already failed, and anything that goes wrong reads as "the
   * page said nothing", because a diagnostic that can fail a step by itself
   * would be worse than the miss it prevents.
   */
  /**
   * Is `wanted` contained in the page's own rendered text? The excerpt around
   * the match when it is, null when it is not (or the page cannot be read).
   * `innerText`, not `textContent`, for the reason `expectText` reads it: a
   * user has never seen a `<script>` payload. Whitespace is folded on both
   * sides and matching is case-insensitive — an exact-match instrument
   * already failed; this read only decides whether the text is on screen at
   * all, and the excerpt it returns is the evidence a human rules on.
   */
  async #textContainedInPage(wanted: string): Promise<string | null> {
    try {
      const body = await this.page.evaluate(() => {
        const doc = (globalThis as unknown as { document?: { body?: { innerText?: string } } }).document;
        return doc?.body?.innerText ?? '';
      });
      const hay = body.replace(/\s+/g, ' ');
      const needle = wanted.replace(/\s+/g, ' ').trim();
      if (needle === '') return null;
      const at = hay.toLowerCase().indexOf(needle.toLowerCase());
      if (at < 0) return null;
      return excerptAround(hay, hay.slice(at, at + needle.length));
    } catch {
      return null;
    }
  }

  async #pageMessages(): Promise<string[]> {
    try {
      // Two reads, not one comma-separated selector: Playwright's `role=`
      // engine takes a single role, so `role=alert, role=status` is parsed as
      // the role literally named "alert, role=status" and matches nothing —
      // silently, which is exactly the failure mode this method exists to
      // prevent. Found by the test asserting the message reaches the step.
      const texts = [
        ...(await this.page.locator('role=alert').allInnerTexts()),
        ...(await this.page.locator('role=status').allInnerTexts()),
      ];
      const seen = new Set<string>();
      const messages: string[] = [];
      for (const raw of texts) {
        const text = raw.trim().replace(/\s+/g, ' ').slice(0, PAGE_MESSAGE_MAX_CHARS);
        if (text === '' || seen.has(text)) continue;
        seen.add(text);
        messages.push(text);
        if (messages.length >= PAGE_MESSAGE_MAX) break;
      }
      return messages;
    } catch {
      return [];
    }
  }

  /**
   * Caption the recording with the step about to run.
   *
   * The report can already seek a video to a step, so this is not navigation —
   * it is what lets the recording stand on its own once it has been pulled out
   * of the report and attached to a bug. A silent clip of a pointer clicking
   * things becomes an account of a test when each click says what it is for.
   *
   * No-op when not filming, and skipped for an HTTP step: nothing about a
   * `request` happens on screen, so captioning the page it did not touch would
   * label a frame with something that is not in it.
   */
  async narrate(index: number, action: string, intent?: string | undefined): Promise<void> {
    if (!this.#video || BROWSER_FREE_ACTIONS.has(action)) return;
    this.#caption = `${index}  ${intent ?? action}`;
    await captionVideo(this.page, this.#caption);
  }

  async #resolve(
    action: string,
    selector: string,
    intent: string | undefined,
    run: (locator: Locator, timeoutMs: number) => Promise<unknown>,
    /** Network-observer timestamp taken when this step began, if observing. */
    netMark?: number | undefined,
  ): Promise<ResolveResult<unknown>> {
    const attempts: string[] = [];

    // What (if anything) Playwright said intercepted the pointer — fuel for
    // the overlay rung below.
    let intercepted: { css: string | null; label: string } | null = null;
    const noteInterception = (error: unknown): void => {
      if (intercepted === null && error instanceof Error) {
        intercepted = parseInterception(error.message);
      }
    };

    // 1. Fast path — $0, short timeout.
    try {
      const value = await run(this.page.locator(selector), this.#fastTimeoutMs);
      return { value, resolution: 'fast', resolvedSelector: selector };
    } catch (error) {
      noteInterception(error);
      attempts.push(`fast "${selector}": ${describe(error)}`);
    }

    // 1.05. Known dead end — $0, and a stop.
    //
    // This exact selector already exhausted the whole ladder on this exact
    // page earlier in this run. One fresh fast attempt above is the honest
    // price (the page may have changed state); repaying the free rungs plus a
    // healer call for an identical answer is not. PB-02-01 walked the same
    // three-step login block through the full ladder three times over —
    // nine ladder walks and nine model calls for one fact. Never persisted:
    // the negative result belongs to this run's page, not to the next run's.
    const deadKey = CacheManager.key(this.page.url(), selector);
    const priorDeadEnd = this.#deadResolutions.get(deadKey);
    if (priorDeadEnd !== undefined) {
      attempts.push(
        `known dead end: identical failure at step ${priorDeadEnd} on this same page — ` +
          'not repaid; the page has not changed its answer, fix the flow',
      );
      throw new StepResolutionError(selector, attempts);
    }

    // 1.1. Non-standard syntax sanitizer (e.g. StaticText[name="X"] -> text="X")
    const sanitized = sanitizeSelector(selector);
    if (sanitized !== selector) {
      try {
        const value = await run(this.page.locator(sanitized), this.#fastTimeoutMs);
        return { value, resolution: 'case', resolvedSelector: sanitized };
      } catch (error) {
        attempts.push(`sanitized "${sanitized}": ${describe(error)}`);
      }
    }

    // 1.2. Case-relaxed retry — still $0, still the author's own selector.
    //
    // Chrome computes an accessible name with CSS `text-transform` applied;
    // Playwright's `role=` matcher does not. A control styled
    // `text-transform: uppercase` is therefore captured as "DUE SOON …" and
    // matched against "Due soon …", and matches nothing at any timeout. This
    // rung retries the same selector with the name compared case-insensitively.
    //
    // It sits above healing for the same reason dialog dismissal does, and it
    // is not that it is cheaper: the healer reads the *same* AX tree, so it
    // would propose the same name and reject its own correct answer at the
    // verify step, having spent a call. Only re-matching the author's selector
    // can fix a mismatch that lives in the matcher rather than in the page.
    //
    // Generated flows already carry the flag (see `src/engine/selector.ts`),
    // so in practice this rescues hand-authored and pre-existing flows.
    const relaxed = relaxRoleName(selector);
    if (relaxed) {
      try {
        const value = await run(this.page.locator(relaxed), this.#fastTimeoutMs);
        return { value, resolution: 'case', resolvedSelector: relaxed };
      } catch (error) {
        attempts.push(`case "${relaxed}": ${describe(error)}`);
      }
    }

    // 1.15. Bare role — the same selector, with the `role=` it forgot to say.
    //
    // `textbox >> nth=1` and `button[name="Save"]` are *valid* selectors:
    // Playwright reads the leading token as a CSS tag name. There is no
    // `<textbox>` element and no `<button name="Save">`, so they resolve
    // nothing on every page at any timeout, and the step reads as "the control
    // is missing" about an application that is fine.
    //
    // Free, deterministic, and above healing for the same reason as the case
    // rung: this is the author's own selector, and re-matching it is the only
    // move that cannot change what the test exercises. Generated flows now
    // carry the prefix (see `src/engine/selector.ts`), so this rescues the
    // hand-authored and already-written ones — which is how PB_02_01's login
    // came to spend twenty-six steps on the sign-in page.
    const qualified = qualifyBareRole(selector);
    if (qualified) {
      try {
        const value = await run(this.page.locator(qualified), this.#fastTimeoutMs);
        return { value, resolution: 'case', resolvedSelector: qualified };
      } catch (error) {
        attempts.push(`bare-role "${qualified}": ${describe(error)}`);
      }
      // A qualified selector can still carry a case mismatch, and paying one
      // more free attempt here beats paying the healer.
      const both = relaxRoleName(qualified);
      if (both) {
        try {
          const value = await run(this.page.locator(both), this.#fastTimeoutMs);
          return { value, resolution: 'case', resolvedSelector: both };
        } catch (error) {
          attempts.push(`bare-role+case "${both}": ${describe(error)}`);
        }
      }
    }

    // 1.3. Ambiguous-match narrowing — still $0, still the author's own text.
    //
    // Playwright's unquoted `text=…` is a *substring* match, so `text=4 days`
    // resolves "Overdue 54 days", "≤ 14 days · near due" and the row that
    // actually says "4 days" all at once, and strict mode correctly refuses to
    // pick one. Read as a verdict that is exactly backwards: the text being
    // asserted is on the page — more places than the author knew — and the
    // step reports "could not resolve". Healing cannot fix it for the same
    // reason as a case mismatch: the model would propose the same text and
    // then reject its own multi-match answer at the verify step.
    //
    // Two narrowings, both deterministic, both only after a strict-mode
    // violation (a plain not-found means the text is genuinely absent and
    // must stay a failure):
    //
    //   1. Exact form — `text="4 days"` matches whole normalised text, which
    //      is precisely what the author observed when the step was written.
    //   2. Presence assertions only, still ambiguous — take the first
    //      *visible* match. Safe here and nowhere else: every text-engine
    //      match contains the asserted text by construction, so "this text is
    //      shown" is satisfied by any of them. A click gets no such rung —
    //      acting on "whichever matched first" changes what the test does.
    const lastAttempt = attempts[attempts.length - 1] ?? '';
    if (isTextSelector(selector) && lastAttempt.includes('strict mode violation')) {
      const exact = exactTextSelector(selector);
      if (exact) {
        try {
          const value = await run(this.page.locator(exact), this.#fastTimeoutMs);
          return { value, resolution: 'narrow', resolvedSelector: exact };
        } catch (error) {
          attempts.push(`narrow "${exact}": ${describe(error)}`);
        }
      }
      if (PRESENCE_ACTIONS.has(action)) {
        const anyVisible = `${exact ?? selector} >> visible=true >> nth=0`;
        try {
          const value = await run(this.page.locator(anyVisible), this.#fastTimeoutMs);
          return { value, resolution: 'narrow', resolvedSelector: anyVisible };
        } catch (error) {
          attempts.push(`narrow "${anyVisible}": ${describe(error)}`);
        }
      }
    }

    // 1.35. Over-exact text — the same rung's mirror, and the same $0 move.
    //
    // Playwright's quoted `text="X"` matches an element's WHOLE normalised
    // text, so it resolves nothing the instant the page renders that value
    // with anything around it. Adjudicated live on DB_07_01: the flow asserted
    // `text="75,000"` and the app renders `฿{v.toLocaleString('th-TH', {
    // minimumFractionDigits: 2 })}` — `฿75,000.00`. The number was on screen
    // the whole time; the step reported "could not resolve" and two `high`
    // defects were filed against a working application. The healer cannot help
    // for the same reason it cannot help with a case mismatch: it reads the
    // same page and proposes the same text.
    //
    // Gated on a plain not-found (a strict-mode violation means the text is
    // already ambiguous, and rung 1.3 above is the correct answer there), and
    // on PRESENCE assertions only — the rule rung 1.3 already states for its
    // own any-of half: a text-engine match contains the asserted text by
    // construction, so "this text is shown" is satisfied by any of them, while
    // a click acting on a loosened match would change what the test exercises.
    if (
      isTextSelector(selector) &&
      PRESENCE_ACTIONS.has(action) &&
      !lastAttempt.includes('strict mode violation')
    ) {
      const loose = relaxTextSelector(selector);
      if (loose) {
        // Ambiguity is expected here — the whole point is that the page wraps
        // the value in more text — so the first visible match is taken in the
        // same breath rather than as a second rung.
        for (const candidate of [loose, `${loose} >> visible=true >> nth=0`]) {
          try {
            const value = await run(this.page.locator(candidate), this.#fastTimeoutMs);
            await this.#flagOverExactText(selector, candidate);
            return { value, resolution: 'narrow', resolvedSelector: candidate };
          } catch (error) {
            attempts.push(`relax "${candidate}": ${describe(error)}`);
          }
        }
      }
    }

    // 1.5. Blocking-dialog recovery — still $0. A surprising share of
    // "selector" failures are really "something is blocking the page"
    // failures: a cookie banner, a promo modal, a newsletter signup,
    // appearing after the page settles. If one showed up, dismiss it and
    // retry the ORIGINAL selector once before paying for a heal — a heal
    // here would either fail the same way, or worse, "successfully" repair
    // onto a control inside the dialog itself.
    //
    // EXCEPT when the previous step was a click or a keypress: a dialog that
    // opened off the flow's own action is almost always the intended context
    // — an edit modal the step is trying to fill — and dismissing it destroys
    // the very state the test built (seen live: the ladder closed a
    // deliberately-opened "Edit rule" dialog, and every later step failed
    // downstream of the wreckage). Left open, the failing step still fails
    // honestly, and the healer then reads a tree that CONTAINS the dialog —
    // which is exactly where the right candidate lives.
    if (this.#lastAction === 'click' || this.#lastAction === 'press') {
      const openNow = await openDialogNow(this.page);
      if (openNow) {
        attempts.push(
          `dialog: a "${await describeDialog(openNow).catch(() => 'dialog')}" opened by the ` +
            `previous ${this.#lastAction} is treated as the intended context, not a blocker — not dismissed`,
        );
      }
    } else {
      const dialog = await this.#dismissBlockingDialog();
      if (dialog) {
        try {
          const value = await run(this.page.locator(selector), this.#fastTimeoutMs);
          return { value, resolution: 'dialog', resolvedSelector: selector, dialog };
        } catch (error) {
          attempts.push(`fast (after dismissing "${dialog.name}") "${selector}": ${describe(error)}`);
        }
      }
    }

    // 1.6. Non-ARIA overlay — still $0, and still evidence, not guesswork.
    //
    // The ARIA rung above can only see `role=dialog`; a Semantic-UI dimmer, a
    // hand-rolled promo, a PDPA strip carry no such role and were the
    // detector's documented blind spot. But when one of them blocks a click,
    // Playwright *names it* in the failure ("<div class=…> intercepts pointer
    // events") — so this rung acts only on that named element: a dismiss
    // control inside it if one is recognisable, else Escape, then the
    // author's own selector retried once. Found live on homepro.co.th, whose
    // promo dimmer swallowed every click on the page behind it.
    if (intercepted !== null) {
      const overlay = await this.#clearInterceptingOverlay(intercepted);
      if (overlay) {
        try {
          const value = await run(this.page.locator(selector), this.#fastTimeoutMs);
          return { value, resolution: 'dialog', resolvedSelector: selector, dialog: overlay };
        } catch (error) {
          attempts.push(
            `fast (after clearing "${overlay.name}" via ${overlay.button}) "${selector}": ${describe(error)}`,
          );
        }
      }
    }

    const cacheKey = CacheManager.key(this.page.url(), selector);

    // 2. Previously healed selector — also $0.
    const cached = this.#cache.get(cacheKey);
    if (cached) {
      try {
        const value = await run(this.page.locator(cached.healed), this.#healedTimeoutMs);
        this.#cache.recordUse(cacheKey);
        return { value, resolution: 'cache', resolvedSelector: cached.healed };
      } catch (error) {
        // A stale repair is worse than none — drop it and let the healer retry.
        attempts.push(`cache "${cached.healed}": ${describe(error)}`);
        this.#cache.delete(cacheKey);
      }
    }

    // 2.5. Backend check — still $0, and it is a *stop*, not another attempt.
    //
    // If a request the page made has already failed hard (5xx, dropped
    // connection, expired session), the control this step wants probably never
    // rendered because the data behind it never arrived. Healing here can only
    // do one of two things: fail identically, having spent a token, or
    // "successfully" repair onto whatever the app rendered instead — usually
    // an error banner or an empty state. The second outcome is strictly worse
    // than failing, because the suite goes green while checking the wrong
    // thing. Same reasoning that puts dialog dismissal ahead of healing.
    const blocking = netMark === undefined ? [] : this.#networkEvidence(netMark).failures;
    if (blocking.length > 0) {
      this.bundle.noteBackendBlocked();
      attempts.push(
        `backend: ${blocking.length} request(s) failed while this step was waiting ` +
          `(${describeCall(blocking[0]!)}${blocking.length > 1 ? ', …' : ''}) — ` +
          'no repair attempted, the selector is not the problem',
      );
      throw new StepResolutionError(selector, attempts);
    }

    // 2.5. Stranded on a sign-in page — a stop, not another attempt.
    //
    // The step began somewhere legitimate and the application redirected
    // mid-step, so the guard that runs before each step could not have caught
    // it. Healing from here is the worst available move: the AX tree the
    // healer reads is the *login page*, so it proposes a login control,
    // verifies that it resolves to exactly one element, and reports the step
    // green. That is not a repaired test — it is a test that now checks the
    // sign-in screen. Seen exactly once and it produced
    // `waitFor role=heading[name="Sign in"] … passed (jit)`.
    //
    // Same shape as the backend rung above: when the precondition is gone, a
    // repair can only fail identically or succeed against the wrong thing.
    const stranded = this.#strandedMessage();
    if (stranded !== null) {
      attempts.push(`declined to heal: ${stranded.split('\n')[0] ?? stranded}`);
      throw new StepResolutionError(selector, attempts);
    }

    // 2.6. Denied surface — a stop, not another attempt.
    //
    // If the page is showing an authorization failure, the control this step
    // wants is not late and not renamed: the page has answered a different
    // question. Healing from here can only fail identically or repair onto
    // the denial page's own furniture — PB-02-01's healer dutifully proposed
    // `role=heading[name="ไม่มีสิทธิ์เข้าถึง · Access Denied"]` and the run threw
    // that diagnosis away as a low-confidence repair. The denial heading is
    // the finding; it goes on the step as page context and into the defect
    // table as `authorization`, and no token is spent repairing around it.
    //
    // A flow that *means* to test the denial page never reaches this rung:
    // its assertions name the denial content and resolve on the fast path.
    const denial = await this.#denialSurface();
    if (denial !== null) {
      attempts.push(
        `authorization: the page is showing "${denial}" — no repair attempted, ` +
          'the selector is not the problem; the run is not permitted to see this page',
      );
      this.#recordRuntimeDefect(
        'authorization',
        'high',
        `The page answered with "${denial}"`,
        `While resolving "${selector}" the page was showing an authorization failure. ` +
          'The signed-in identity cannot see this surface — fix the flow to sign in as ' +
          'the right persona (navigate to the sign-in page before switching identity), ' +
          'or grant the account access. No selector change can fix this.',
        selector,
      );
      const failure = new StepResolutionError(selector, attempts);
      failure.pageContext = [denial];
      throw failure;
    }

    // 2.7. Patience — the author's own selector, one more window, free.
    //
    // A presence assertion against a hydrating page loses by construction:
    // `body` resolves instantly on a shell that has not rendered the content
    // yet, so the fast window closes on the wrong page state and every later
    // rung reasons about that same wrong state. PB-05-01's detail page
    // renders its content ~3s after the route commits; the assertion died at
    // 2s and a working feature filed a defect. One more attempt at the healed
    // timeout is strictly cheaper than the model call the jit rung is about
    // to make, cannot change what the test exercises (it is the author's own
    // selector), and when it passes the run still records a timing defect —
    // "passed, slower than the budget" is a finding, not a free pass.
    //
    // Presence actions only: a click that needs ten seconds is a different
    // kind of slow, and acting late is not the same as observing late.
    // `expectCount` belongs here too — any expectCount that reaches the
    // ladder claims count > 0 (a zero-count expectation runs through
    // `#bareStep`, off the ladder entirely), which is a presence claim about
    // several things instead of one.
    if (PRESENCE_ACTIONS.has(action) || action === 'waitFor' || action === 'expectCount') {
      try {
        const value = await run(this.page.locator(selector), this.#healedTimeoutMs);
        this.#recordRuntimeDefect(
          'functional',
          'medium',
          `Slower than the fast-path budget: ${selector}`,
          `This step only passed when given ${this.#healedTimeoutMs}ms — the content renders, ` +
            `but not within the ${this.#fastTimeoutMs}ms fast path. The feature works; the page ` +
            'is slow (or hydrates late). Worth fixing before the budget hides a real regression.',
          selector,
        );
        return { value, resolution: 'late', resolvedSelector: selector };
      } catch (error) {
        attempts.push(`late "${selector}" (${this.#healedTimeoutMs}ms): ${describe(error)}`);
      }
    }

    // 3. Control plane — costs tokens.
    if (!this.#healer) {
      attempts.push('jit: healer disabled');
      return this.#agentRescue(action, selector, intent, run, attempts);
    }

    let outcome: Awaited<ReturnType<JitHealer['heal']>>;
    try {
      // The most recent attempt is the most direct evidence of what's wrong
      // right now — e.g. a strict-mode violation ("resolved to 126 elements")
      // needs a very different fix than a plain not-found timeout.
      const failureReason = attempts[attempts.length - 1];
      outcome = await this.#healer.heal({
        page: this.page,
        action,
        selector,
        intent,
        failureReason,
        caseContext: this.#caseContext,
      });
    } catch (error) {
      if (error instanceof HealUnavailableError) {
        // The provider failed, not the page. Counted apart and worded apart:
        // "unavailable" must never read as "the control is absent".
        this.bundle.noteHealUnavailable();
        attempts.push(`jit: unavailable — ${describe(error)} (a provider fact, not a page fact)`);
      } else {
        attempts.push(`jit: ${describe(error)}`);
      }
      // The healer's refused candidates are evidence — carry them onto
      // whatever failure this step ultimately records.
      const rejectedHeals = error instanceof HealFailedError ? error.rejectedHeals : undefined;
      try {
        return await this.#agentRescue(action, selector, intent, run, attempts);
      } catch (resolutionError) {
        if (resolutionError instanceof StepResolutionError && rejectedHeals?.length) {
          resolutionError.rejectedHeals = rejectedHeals;
        }
        throw resolutionError;
      }
    }

    const heal: HealRecord = {
      from: selector,
      to: outcome.selector,
      strategy: outcome.suggestion.strategy,
      confidence: outcome.suggestion.confidence,
      reasoning: outcome.suggestion.reasoning,
      model: this.#healer.model.id,
      latencyMs: outcome.latencyMs,
      inputTokens: outcome.suggestion.inputTokens,
      outputTokens: outcome.suggestion.outputTokens,
    };

    try {
      const value = await run(this.page.locator(outcome.selector), this.#healedTimeoutMs);
      await this.#flagTimingHeal(selector, outcome.selector);
      return { value, resolution: 'jit', resolvedSelector: outcome.selector, heal };
    } catch (error) {
      // The selector resolved during verification but the action still failed —
      // don't keep a repair that can't carry the step.
      this.#cache.delete(cacheKey);
      attempts.push(`jit "${outcome.selector}": ${describe(error)}`);
      return this.#agentRescue(action, selector, intent, run, attempts);
    }
  }

  /**
   * Last rung: let the agent make the control reachable, then run the
   * author's own selector against the page it opened up.
   *
   * **The division of labour with the healer is the point.** The healer fixes
   * a *wrong selector on the right page* — it reads one static tree and
   * proposes a different string. It is helpless against the opposite problem,
   * a *right selector on the wrong page state*: a control behind a closed
   * menu, below the fold, or on a view that has not finished hydrating is
   * simply not in the tree, so there is nothing for it to propose. Only
   * something that can *act* can fix that, and acting is what the agent does.
   *
   * **The author's selector still has to resolve.** The agent is not allowed
   * to perform the step — it prepares the page, and then the original selector
   * (and its free variants) is retried exactly as written. That is the same
   * guarantee the dialog rung gives, and it is what keeps this from becoming a
   * machine that makes tests pass: if the control the author named is still
   * not there afterwards, the step still fails.
   *
   * **An assertion is never offered this.** A claim that only holds because an
   * agent went and made it true is worse than a failed claim — the suite goes
   * green while the feature is broken. `ASSERTION_ACTIONS` decides, the same
   * list that stops the generator emitting a case with nothing to prove.
   *
   * **Opt-in** (`--agent-assist`), because unlike every rung above it this one
   * *changes the application* before the step runs: it clicks, it types, it
   * navigates. That is a decision about someone's system, not a default. Same
   * reasoning as `--follow-buttons` and `--probe`.
   */
  async #agentRescue<T>(
    action: string,
    selector: string,
    intent: string | undefined,
    run: (locator: Locator, timeoutMs: number) => Promise<unknown>,
    attempts: string[],
  ): Promise<ResolveResult<T>> {
    if (!this.#agentAssist || !this.#agent) {
      throw new StepResolutionError(selector, attempts);
    }
    if ((ASSERTION_ACTIONS as readonly string[]).includes(action)) {
      // Spelled out rather than silently skipped: "the agent could have been
      // tried here and deliberately was not" is the interesting fact.
      attempts.push('agent: not offered to an assertion — a claim it made true proves nothing');
      throw new StepResolutionError(selector, attempts);
    }

    // The old goal — "make this control reachable" — presumed the control was
    // merely hidden, and that presumption is what made PB_01_01's PDPA
    // consent screen unreachable: a full-page "Accept and continue"
    // interstitial is not a closed menu, not an ARIA dialog (so `modal.ts`
    // cannot see it) and not a pointer-interception (so the overlay rung
    // cannot either). Nothing in the ladder was equipped to even ask what was
    // on the page. So the agent is asked to look first and choose — including
    // choosing to do nothing, which is a legitimate answer and is recorded as
    // one.
    const goal =
      `The test expected this and it is not on the page: ` +
      `${intent ?? `the target of "${selector}"`} (selector: "${selector}").\n` +
      `FIRST look at what IS on the page and decide whether something ` +
      `unexpected is standing in the way — a consent or privacy screen, an ` +
      `interstitial, a notice, an onboarding step, or a modal the test does ` +
      `not mention.\n` +
      `If something is: decide what an ordinary user would do about it, do ` +
      `ONLY that, and stop.\n` +
      `If nothing is in the way, the control may simply be out of reach — ` +
      `open the menu, tab or disclosure it lives behind, scroll it into view, ` +
      `or wait for the view to finish loading.\n` +
      `If nothing is in the way and nothing would reveal it, do NOT act at ` +
      `all: call finish and say so. Declining is a correct answer here.\n` +
      `Either way, do NOT perform the test's own step — the test will click ` +
      `or type into "${selector}" itself. Call finish as soon as you are done.`;

    let record: AgentRecord;
    try {
      record = await this.#agent.run(this.page, goal, {
        memory: cacheAgentMemory(this.#cache),
        caseContext: this.#caseContext,
        ...(this.#agentDbProbe() ?? {}),
      });
    } catch (error) {
      // `run` is documented never to throw; belt and braces, because a throw
      // here would turn a failed step into a failed run.
      attempts.push(`agent: ${describe(error)}`);
      throw new StepResolutionError(selector, attempts);
    }

    // Whatever the agent *says*, the only evidence that counts is the author's
    // selector resolving. Free variants included, since the agent may have
    // revealed a control whose name differs only in case.
    for (const candidate of [selector, relaxRoleName(selector), qualifyBareRole(selector)]) {
      if (candidate === null) continue;
      try {
        const value = (await run(this.page.locator(candidate), this.#healedTimeoutMs)) as T;
        this.#recordRuntimeDefect(
          'usability',
          'medium',
          'A step only worked after the agent decided what was in the way',
          `"${selector}" was not reachable until the agent acted. It judged: ` +
            `${decisionFrom(record, true).observed || record.summary}. It chose: ` +
            `${decisionFrom(record, true).decided}. ` +
            `The flow does not describe this interaction — add the step that handles ` +
            `it (accept the notice, open the menu, switch the tab, scroll) so the run ` +
            `stops paying a model to rediscover it every time.`,
          selector,
        );
        return {
          value,
          resolution: 'agent',
          resolvedSelector: candidate,
          agent: record,
          decision: decisionFrom(record, true),
        };
      } catch {
        // Try the next variant; the aggregate failure is reported below.
      }
    }

    // The healer's blind spot is a tree that did not contain the answer, and
    // the agent has just changed the page — so this is the one moment a second
    // repair is worth paying for. It is a different question from the first
    // heal, asked of a different page: the menu is open now, the list has
    // loaded, the control is finally in the tree. One extra call, at the
    // bottom of the most expensive rung, and only when the author's own
    // selector has already been retried and failed.
    if (this.#healer) {
      try {
        const outcome = await this.#healer.heal({
          page: this.page,
          action,
          selector,
          intent,
          failureReason:
            `the control was not reachable until an agent acted (${record.summary}); ` +
            `this is the page as it now stands`,
          caseContext: this.#caseContext,
        });
        const value = (await run(
          this.page.locator(outcome.selector),
          this.#healedTimeoutMs,
        )) as T;
        this.#recordRuntimeDefect(
          'usability',
          'medium',
          'A step needed both the agent and a repair',
          `"${selector}" was neither reachable nor correct: the agent had to act ` +
            `(${record.summary}) and the selector then had to be repaired to ` +
            `"${outcome.selector}". Two model calls for one step — worth fixing the ` +
            `flow rather than paying this every run.`,
          selector,
        );
        return {
          value,
          resolution: 'agent',
          resolvedSelector: outcome.selector,
          agent: record,
          decision: decisionFrom(record, true),
          heal: {
            from: selector,
            to: outcome.selector,
            strategy: outcome.suggestion.strategy,
            confidence: outcome.suggestion.confidence,
            reasoning: outcome.suggestion.reasoning,
            model: this.#healer.model.id,
            latencyMs: outcome.latencyMs,
            inputTokens: outcome.suggestion.inputTokens,
            outputTokens: outcome.suggestion.outputTokens,
          },
        };
      } catch (error) {
        attempts.push(`agent+jit: ${describe(error)}`);
      }
    }

    attempts.push(
      `agent: ${record.success ? 'reported success' : 'gave up'} (${record.summary}) but ` +
        `"${selector}" still does not resolve`,
    );
    // The step is failing, and the decision goes with it. "The agent looked
    // and chose to do nothing" and "the agent was never consulted" are
    // different facts about a dead-ended step, and only one of them tells a
    // reader the ladder was exhausted honestly.
    const failure = new StepResolutionError(selector, attempts);
    failure.decision = decisionFrom(record, false);
    throw failure;
  }

  /**
   * Detect and dismiss a blocking dialog, with no wait — called only after
   * the fast path has already failed, so this must stay cheap rather than
   * adding a second timeout on top of the one that just elapsed.
   */
  /**
   * Clear an overlay Playwright reported as intercepting the pointer.
   *
   * Preference order matches the risk: a recognisable dismiss control inside
   * the named element first (`findDismissButton` — name-gated, so a promo's
   * anonymous link is never clicked and can never navigate us away), then
   * Escape, the one key every modal convention binds to "go away". The retry
   * afterwards is what decides whether it worked; this only reports what was
   * done.
   */
  async #clearInterceptingOverlay(intercepted: {
    css: string | null;
    label: string;
  }): Promise<DialogRecord | null> {
    try {
      if (intercepted.css !== null) {
        const container = this.page.locator(intercepted.css).first();
        if (await container.isVisible().catch(() => false)) {
          const dismiss = await findDismissButton(container);
          if (dismiss) {
            await dismiss.locator.click({ timeout: this.#fastTimeoutMs });
            await this.page.waitForTimeout(350);
            return { name: intercepted.label, button: dismiss.text };
          }
        }
      }
      await this.page.keyboard.press('Escape');
      await this.page.waitForTimeout(350);
      return { name: intercepted.label, button: 'Escape' };
    } catch {
      return null;
    }
  }

  async #dismissBlockingDialog(): Promise<DialogRecord | null> {
    const dialog = await openDialogNow(this.page);
    if (!dialog) return null;
    const dismiss = await findDismissButton(dialog);
    if (!dismiss) return null;

    const name = await describeDialog(dialog);
    try {
      await dismiss.locator.click({ timeout: this.#fastTimeoutMs });
    } catch {
      return null; // couldn't actually click it — don't claim a dismissal that never happened
    }
    return { name, button: dismiss.text };
  }

  // --- Teardown ------------------------------------------------------------

  /**
   * Flush the cache and detach. For a CDP connection Playwright disconnects
   * rather than killing the browser, so the user's Chrome survives the run.
   */
  /**
   * This run's session as data, for the suite's vault — cookies plus
   * localStorage, the same serialization the recording context inherits by.
   */
  async exportSession(): Promise<StoredSession> {
    return this.#context.storageState();
  }

  async close(): Promise<ProofBundle> {
    try {
      this.#flagUnrequestedNavigation();
    } catch {
      // Diagnostic, same rule as coverage below: it explains a failure, it
      // must never create one.
    }

    // Re-probe every selector that dead-ended: one that resolves *now* was
    // never absent — it was slower than the fast-path budget, and the defect
    // it filed should say "timing", not "missing". The mirror of
    // `#flagTimingHeal`, pointed at failures instead of successes.
    // Diagnostic: anything that goes wrong here changes nothing.
    try {
      // Only steps that failed on the page the run *ended* on can be
      // re-checked honestly: probing a login-page selector against whatever
      // page the run finished on would call a genuine absence "timing".
      const here = this.page.url();
      const deadEnded = new Set<string>();
      for (const step of this.bundle.steps) {
        if (
          step.status !== 'passed' &&
          step.selector !== null &&
          step.resolution === null &&
          step.url === here &&
          // Only genuine resolution failures may be downgraded to timing. A
          // content mismatch resolved fine and failed on what the element
          // SAYS ("expected text to contain…"), and an intercepted click
          // resolved fine and failed on what covered it — re-probing either
          // selector proves only what was never in doubt, and the "TIMING,
          // not absence" downgrade then papers over the real finding. Seen
          // live: a failed `expectText body` (content absent because the
          // journey never created it) downgraded to timing because `body`,
          // of course, resolves.
          !/expected text to contain|intercepts pointer events/i.test(step.error ?? '')
        ) {
          deadEnded.add(step.selector);
        }
      }
      for (const selector of deadEnded) {
        const count = await this.page
          .locator(selector)
          .count()
          .catch(() => 0);
        if (count > 0) this.bundle.reclassifyTimingDefect(selector);
      }
    } catch {
      // Same rule as coverage below: never let a diagnostic fail the run.
    }

    // Measured before teardown so the page is still in its final state.
    if (this.#coverage) {
      try {
        this.bundle.setCoverage(
          await measureCoverage(this.page, this.bundle.resolvedSelectors()),
        );
      } catch {
        // Coverage is diagnostic; never let it fail an otherwise good run.
      }
    }

    if (this.#network) {
      try {
        const calls = this.#network.all();
        this.bundle.setNetworkTotals({
          calls: calls.length + this.#network.dropped,
          failures: calls.filter(isBlockingFailure).length,
          dropped: this.#network.dropped,
        });
      } catch {
        // Diagnostic, same rule as coverage above.
      }
      await this.#network.detach().catch(() => undefined);
      this.#network = null;
    }

    // The DB connection is the runner's to close (it opened lazily on the
    // first DB step; a run with none has nothing to close). Never fatal.
    await this.#db.close().catch(() => undefined);

    // Saved variables are evidence once a later check keys on one — masked by
    // name before they leave the store, same rule as every other credential.
    try {
      this.bundle.setVariables(this.variables.snapshotForReport());
    } catch {
      // Diagnostic, same rule as coverage above.
    }

    await this.#cache.flush();

    // Sealing the recording has to happen between closing the context and
    // closing the browser, and in that order: Playwright finalises a video
    // when its *context* closes, so asking earlier reads a half-written file
    // that no player will open, and closing the browser first can take the
    // page — and with it `page.video()` — away before it can be asked.
    const video = this.#video;
    if (video) {
      const page = this.page;
      await this.#context.close().catch(() => undefined);
      const sealed = await sealVideo(
        page,
        video.dir,
        video.size,
        this.#videoMode === 'always' ? 'full' : this.#videoCut(),
      );
      if (sealed) this.bundle.setVideo(sealed);
      this.#video = null;
    }

    if (this.#ownsPage) {
      // Pages adoption left behind are this runner's to clean up, under the
      // same ownership rule as the current page.
      for (const page of this.#pagesLeftBehind) {
        if (!this.#ownsContext) await page.close().catch(() => undefined);
      }
      if (!this.#ownsContext) await this.page.close().catch(() => undefined);
      await this.#browser.close().catch(() => undefined);
    }
    return this.bundle.finish();
  }
}

/**
 * Borrow a page from the CDP-attached browser for a one-off task (generation,
 * inspection), then clean up. Same connect-only contract as `SmartRunner`.
 */
export async function withPage<T>(
  cdpUrl: string | undefined,
  fn: (page: Page) => Promise<T>,
): Promise<T> {
  const url = cdpUrl ?? DEFAULT_CDP_URL;
  let browser: Browser;
  try {
    browser = await chromium.connectOverCDP(url);
  } catch (error) {
    throw new Error(
      `could not attach to a browser at ${url}: ${describe(error)}\n` +
        'Start Chrome with --remote-debugging-port first (npm run chrome).',
    );
  }

  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = await context.newPage();
  await applyViewport(page);
  try {
    return await fn(page);
  } finally {
    await page.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

/**
 * `withPage`, for `count` tabs at once in the browser's shared context — one
 * per authoring worker. Every tab is closed when `fn` settles, however it
 * settles; the browser itself is only disconnected from, never killed.
 */
export async function withPages<T>(
  cdpUrl: string | undefined,
  count: number,
  fn: (pages: Page[]) => Promise<T>,
): Promise<T> {
  const url = cdpUrl ?? DEFAULT_CDP_URL;
  let browser: Browser;
  try {
    browser = await chromium.connectOverCDP(url);
  } catch (error) {
    throw new Error(
      `could not attach to a browser at ${url}: ${describe(error)}\n` +
        'Start Chrome with --remote-debugging-port first (npm run chrome).',
    );
  }

  const context = browser.contexts()[0] ?? (await browser.newContext());
  const pages: Page[] = [];
  try {
    for (let i = 0; i < Math.max(1, count); i += 1) {
      const page = await context.newPage();
      await applyViewport(page);
      pages.push(page);
    }
    return await fn(pages);
  } finally {
    for (const page of pages) await page.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

// --- Declarative flows -----------------------------------------------------

export type FlowStep =
  // --- navigation and interaction ---
  | { action: 'goto'; url: string }
  | { action: 'click'; selector: string; intent?: string | undefined }
  // --- composition and control flow ---
  /**
   * Splice in another flow's steps. Expanded before the run — see
   * `src/engine/compose.ts`.
   */
  | {
      action: 'use';
      /** Path to a `.flow.json`, relative to the flow doing the using. */
      flow: string;
      /** Values for `{{name}}` placeholders inside the fragment. */
      with?: Record<string, string> | undefined;
      intent?: string | undefined;
    }
  /**
   * Run `then` when the condition holds, `else` otherwise.
   *
   * The condition is a *probe*, not an assertion: it never heals and never
   * fails the flow, it only chooses a branch. Exactly one of the four
   * condition fields must be set.
   */
  | {
      action: 'when';
      visible?: string | undefined;
      hidden?: string | undefined;
      enabled?: string | undefined;
      disabled?: string | undefined;
      then: FlowStep[];
      else?: FlowStep[] | undefined;
      intent?: string | undefined;
    }
  | { action: 'fill'; selector: string; value: string; intent?: string | undefined }
  /** Choose a dropdown option by its visible label — native `<select>` or custom combobox. */
  | { action: 'selectOption'; selector: string; value: string; intent?: string | undefined }
  /** Tick / untick a checkbox, radio, or ARIA toggle, verifying the state changed. */
  | { action: 'check'; selector: string; intent?: string | undefined }
  | { action: 'uncheck'; selector: string; intent?: string | undefined }
  /** Type key by key — for autocomplete/typeahead/masked fields `fill` cannot wake. */
  | { action: 'type'; selector: string; value: string; intent?: string | undefined }
  | { action: 'waitFor'; selector: string; intent?: string | undefined }
  /**
   * Hand the browser to the agent until `goal` is satisfied. `script` is a
   * deterministic journey a previous successful run recorded on this very
   * step (see `withWorkflowScripts`): replayed before any model turn, and
   * the agent takes over only where the replay no longer grounds.
   */
  | { action: 'workflow'; goal: string; script?: WorkflowScriptStep[] | undefined }
  // --- keyboard ---
  | { action: 'press'; key: string; selector?: string | undefined; intent?: string | undefined }
  | { action: 'expectFocused'; selector: string; intent?: string | undefined }
  | { action: 'expectTabOrder'; selectors: string[]; intent?: string | undefined }
  // --- data-driven (boundary value analysis) ---
  | {
      action: 'fillEach';
      selector: string;
      cases: DataCase[];
      /** Clicked after each fill, before asserting — for on-submit validation. */
      submit?: string | undefined;
      intent?: string | undefined;
    }
  // --- mock data (regenerate-and-retry on a data conflict) ---
  | {
      action: 'fillRetry';
      selector: string;
      kind: DataKind;
      /** Visible while the current value still conflicts; retry stops once this clears. */
      failureSelector: string;
      /** Clicked after each fill, before checking `failureSelector`. */
      submit?: string | undefined;
      maxAttempts?: number | undefined;
      /** Field description for the `custom` kind, e.g. "employee ID". */
      description?: string | undefined;
      intent?: string | undefined;
    }
  // --- backend ---
  /**
   * An HTTP call made by the test itself. Sent through the browser context by
   * default, so it inherits whatever session the UI steps established.
   */
  | ({ action: 'request' } & FlowRequestSpec)
  | { action: 'expectStatus'; status: number | number[]; intent?: string | undefined }
  /** Omit `value` to assert only that the path resolves — for a server-assigned id. */
  | { action: 'expectJson'; path: string; value?: string | undefined; intent?: string | undefined }
  | { action: 'expectHeader'; name: string; value: string; intent?: string | undefined }
  /**
   * Assert the traffic the page made — ordered subsequence + absence claims
   * over the network observer's window. Browser-bound (it needs the live
   * observer) but backend-tier (its subject is HTTP). See `expect-calls.ts`.
   */
  | ({ action: 'expectCalls' } & FlowExpectCallsSpec)
  // --- database verification (read-only; see `src/db/`) ---
  | ({ action: 'dbSnapshot' } & FlowDbSnapshotSpec)
  | ({ action: 'expectDbRow' } & FlowDbRowSpec)
  | ({ action: 'expectDbDelta' } & FlowDbDeltaSpec)
  | ({ action: 'expectDbUnchanged' } & FlowDbUnchangedSpec)
  /** Statement-statistics tier — correlational "called as planned", via pg_stat_statements. */
  | ({ action: 'expectDbCalled' } & FlowDbCalledSpec)
  // --- modals ---
  | { action: 'expectModal'; name?: string | undefined; intent?: string | undefined }
  | { action: 'closeModal'; button?: string | undefined; intent?: string | undefined }
  // --- visual regression ---
  | { action: 'snapshot'; name: string; selector?: string | undefined }
  // --- state seeding (setup/teardown) ---
  | { action: 'setLocalStorage'; key: string; value: string }
  | { action: 'clearStorage' }
  /**
   * End the session the way a user does — the application's own sign-out
   * control (searched name-gated on the page, then behind ARIA-marked
   * identity menus). The persona-switch step: sign out, goto the sign-in
   * page, fill the next account's credentials.
   */
  | { action: 'signOut'; intent?: string | undefined }
  /**
   * Pin the page's clock to a fixed moment (ISO date or date-time), so a
   * claim that depends on "today" — an urgency tier, a due-date boundary, an
   * expiry — is checkable instead of drifting with the wall clock. Belongs in
   * setup, BEFORE the first `goto`: an application reads the clock as it
   * renders, and installing after the fact changes nothing already drawn.
   */
  | { action: 'setClock'; time: string; intent?: string | undefined }
  // --- history and scrolling ---
  /** Go back one history entry — for "open it, check it, come back". */
  | { action: 'back'; intent?: string | undefined }
  | { action: 'forward'; intent?: string | undefined }
  | { action: 'scrollTo'; selector: string; intent?: string | undefined }
  /** Assert the page, or a container, can really be scrolled by a user. */
  | { action: 'expectScrollable'; selector?: string | undefined; intent?: string | undefined }
  | { action: 'expectNotScrollable'; selector?: string | undefined; intent?: string | undefined }
  // --- assertions ---
  /**
   * `anyOf`: accepted equivalent renderings of the same content, for
   * bilingual applications — see `SmartRunner.expectText`. Omit it to
   * enforce one specific rendering.
   */
  | { action: 'expectText'; selector: string; value: string; anyOf?: string[] | undefined; intent?: string | undefined }
  | { action: 'expectVisible'; selector: string; intent?: string | undefined }
  | { action: 'expectHidden'; selector: string; intent?: string | undefined }
  | { action: 'expectEnabled'; selector: string; intent?: string | undefined }
  | { action: 'expectDisabled'; selector: string; intent?: string | undefined }
  | { action: 'expectCount'; selector: string; count: number; intent?: string | undefined }
  | { action: 'expectUrl'; value: string; intent?: string | undefined }
  | { action: 'expectValue'; selector: string; value: string; intent?: string | undefined }
  | {
      action: 'expectAttribute';
      selector: string;
      name: string;
      value: string;
      intent?: string | undefined;
    };

/**
 * Actions that assert something about the page.
 *
 * A flow containing none of these can pass while proving nothing — the
 * false-confidence failure mode. `hasAssertion()` is what lets the generator
 * refuse to emit such a case.
 */
export const ASSERTION_ACTIONS = [
  // `request` is deliberately NOT here: a call whose status nobody checks
  // passes whether or not the endpoint works, which is precisely the
  // false-confidence failure mode this list exists to prevent. `dbSnapshot`
  // is out for the same reason — it records, it claims nothing.
  'expectStatus',
  'expectJson',
  'expectHeader',
  'expectCalls',
  'expectDbRow',
  'expectDbDelta',
  'expectDbUnchanged',
  'expectDbCalled',
  'expectFocused',
  'expectTabOrder',
  'fillEach',
  'fillRetry',
  'expectModal',
  'snapshot',
  'expectText',
  'expectVisible',
  'expectHidden',
  'expectEnabled',
  'expectDisabled',
  'expectCount',
  'expectUrl',
  'expectValue',
  'expectScrollable',
  'expectNotScrollable',
  'expectAttribute',
] as const;

export type AssertionAction = (typeof ASSERTION_ACTIONS)[number];

const ASSERTION_SET: ReadonlySet<string> = new Set(ASSERTION_ACTIONS);

/** True when `steps` contains at least one real assertion. */
export function hasAssertion(steps: readonly FlowStep[]): boolean {
  return steps.some((step) => ASSERTION_SET.has(step.action));
}

/** How many steps a run intends to take, once composition has been resolved. */
export interface RunPlan {
  /** `setup + steps + teardown` — the denominator live progress counts against. */
  total: number;
  setup: number;
  steps: number;
  teardown: number;
}

export interface Flow {
  name: string;
  /**
   * The authoring pass that wrote this flow, when a model did.
   *
   * Written into the file, not merely into the run, because the file outlives
   * the run: re-running an authored case, or repairing it, produces a bundle
   * that would otherwise carry no provenance at all — and wowUI would file it
   * under "Authored flows" rather than beside the catalog it came from. The
   * flow is the artifact, so the artifact records where it came from.
   */
  authoredBy?: GenerationProvenance | undefined;
  /**
   * Whether this test means to prove acceptance or refusal. Stamped by the
   * catalog path when the sheet's own Positive/Negative column states it —
   * the author's word, which always wins. Absent, `runFlow` infers it
   * deterministically from the flow's own words and assertions
   * (`inferPolarity`), so every bundle carries the label either way.
   */
  polarity?: TestPolarity | undefined;
  /**
   * The test case this flow proves, as a compact card — the claim and its
   * expected output in the sheet's own words, stamped by the catalog path.
   * In the file for the same reason `authoredBy` is: the file outlives the
   * run, and the runtime roles (healer, agent) read it so a repair or a
   * workflow turn knows WHAT the step is trying to prove, not only which
   * selector failed. Context for those models, never an instruction — the
   * claim itself lives in the steps.
   */
  caseContext?: string | undefined;
  /**
   * How far this test reaches. Stamped `e2e` by the authoring path when the
   * flow switches personas (`switchesPersona` in `flow-author.ts`): a test
   * that signs in as two different people is a journey across the
   * application's own session machinery, not a unit check of one screen,
   * whatever scope the request asked for.
   */
  scope?: 'unit' | 'e2e' | undefined;
  /** Prefixed to relative `goto` urls. */
  baseUrl?: string | undefined;
  /**
   * Preconditions — authentication, seeded storage, navigation to a known
   * state. Failures here abort the flow before `steps` run, because a test
   * whose preconditions did not hold cannot produce a meaningful result.
   */
  setup?: FlowStep[] | undefined;
  steps: FlowStep[];
  /** Cleanup. Always runs, including after a failure. */
  teardown?: FlowStep[] | undefined;
}

function resolveUrl(url: string, baseUrl: string | undefined): string {
  if (!baseUrl) return url;
  try {
    return new URL(url, baseUrl).toString();
  } catch {
    return url;
  }
}

/**
 * Interpolate `{{name}}` in a step's string fields.
 *
 * Skipped entirely when the step carries no placeholder, which is the normal
 * case — a scan of a few short strings beats constructing a copy of every step
 * in every flow. API steps are left to `ApiActions`, which already interpolates
 * bodies and headers and knows which of its own fields must be resolved after
 * `baseUrl` rather than before (see the ordering trap in `src/api/`).
 */
function interpolateStep(step: FlowStep, variables: VariableStore): FlowStep {
  // Browser-free steps interpolate their own fields (`ApiActions` needs the
  // baseUrl ordering, `DbActions` has nested where/values this shallow walk
  // could not reach) — and `expectCalls` deep-interpolates its own entries
  // for the same nesting reason, so its top-level pass here is harmless.
  if (BROWSER_FREE_ACTIONS.has(step.action)) return step;
  const hasPlaceholder = Object.values(step).some(
    (value) => typeof value === 'string' && value.includes('{{'),
  );
  if (!hasPlaceholder) return step;

  const out: Record<string, unknown> = { ...step };
  for (const [key, value] of Object.entries(out)) {
    if (typeof value === 'string' && value.includes('{{')) out[key] = variables.interpolate(value);
  }
  return out as FlowStep;
}

/** One step that did not pass, in a run that kept going anyway. */
export interface StepIssue {
  action: string;
  selector: string | null;
  kind: 'failed' | 'error' | 'dead-end';
  message: string;
}

/**
 * What actually went wrong with a step, in the vocabulary the report uses:
 * an exhausted escalation ladder is a *dead end* (nothing left to try), a
 * broken assertion is a *fail*, and everything else — a thrown exception, a
 * navigation that never landed, bad interpolation — is an *error*, because
 * calling it a test failure would blame the app for the harness's problem.
 */
function classifyStepFailure(action: string, error: unknown): StepIssue['kind'] {
  if (error instanceof StepResolutionError) return 'dead-end';
  if (error instanceof Error && error.cause instanceof StepResolutionError) return 'dead-end';
  // Harness and grounding facts are errors even under an `expect` name: an
  // unreachable database, an unattached observer, a table the schema does not
  // declare, an unknown {{variable}} nothing saved, an assertion with no
  // request before it — calling any of them a test failure would blame the
  // app for the harness's (or the flow's) problem. Matched by error name so
  // this module does not import the whole db/api families for six classes.
  // (The variable and no-response names joined 2026-08-24: the identical
  // unknown-variable fault was already `error` on a `request` step and
  // `failed` + a backend defect on an `expectJson` — the asymmetry the api
  // CLAUDE.md's "an unknown variable is an error" rule always meant to rule
  // out.)
  if (
    error instanceof Error &&
    (error.name === 'DbUnavailableError' ||
      error.name === 'DbGroundingError' ||
      error.name === 'ObservationUnavailableError' ||
      error.name === 'ObservationTruncatedError' ||
      error.name === 'UnknownVariableError' ||
      error.name === 'NoResponseError' ||
      // A 405/501 is the endpoint refusing the VERB the test chose — the
      // flow's fault, never the application's (2026-08-25, be100 PL_03_03).
      error.name === 'MethodRefusedError')
  ) {
    return 'error';
  }
  if (action.startsWith('expect') || action === 'snapshot' || action === 'fillEach' || action === 'fillRetry') {
    return 'failed';
  }
  return 'error';
}

/**
 * Build the one run-level message for a run that finished with issues. The
 * run is complete — every step got its turn — so the message is a tally plus
 * one line per issue, worded the way each kind deserves.
 */
/**
 * The run completed and some steps did not pass — a TALLY, not a fatal.
 *
 * Its own type because the bundle has to tell the two apart: a fatal (the
 * session guard, a dead browser) says the claims were asserted against the
 * wrong page and no passing assertion may outrank it; a tally says exactly
 * what the step records already say. Recording the tally as the run error
 * used to make the qualified pass unreachable — every run with a broken step
 * carried a run-level error, which is the one thing `passed-with-issues` must
 * never override (PL_02_03, live: 7/9 steps, both assertions green, verdict
 * dead-end).
 */
class StepIssuesError extends Error {
  readonly issues: readonly StepIssue[];
  constructor(issues: readonly StepIssue[]) {
    super(summarizeIssues(issues));
    this.name = 'StepIssuesError';
    this.issues = issues;
  }
}

function summarizeIssues(issues: readonly StepIssue[]): string {
  const label = { failed: 'failed', error: 'error', 'dead-end': 'dead end' } as const;
  const counts = { failed: 0, error: 0, 'dead-end': 0 };
  for (const issue of issues) counts[issue.kind] += 1;
  const parts = (Object.keys(counts) as (keyof typeof counts)[])
    .filter((k) => counts[k] > 0)
    .map((k) => `${counts[k]} ${label[k]}`);
  const lines = issues.map(
    (i) =>
      `  ${label[i.kind].toUpperCase()}: ${i.action}${i.selector ? ` ${i.selector}` : ''} — ${i.message.split('\n')[0]}`,
  );
  return `run completed with ${parts.join(', ')}:\n${lines.join('\n')}`;
}

/** AX budget for a reconstruction ask — same as `--repair`'s. */
const DEFAULT_RECONSTRUCT_MAX_AX_NODES = 150;

/** Total tries per step, including the original, before final classification. */
export const STEP_RECONSTRUCT_TRIES = 3;

/**
 * Ladder stops whose whole argument is "a rewrite can only fail identically
 * or succeed against the wrong thing" — reconstruction honours them for the
 * same reason healing does.
 */
function reconstructionFutile(error: unknown): boolean {
  // Harness and grounding facts — the same names `classifyStepFailure` scores
  // as `error`, not `failed`: an unreachable database, an undeclared table, a
  // missing network observer. No rewrite of the step can connect a database
  // that is not configured, so asking for one spends a model call to fail
  // identically (be100, 2026-08-23: every `expectDbRow` failing on "database
  // unavailable" was sent for reconstruction anyway).
  if (
    error instanceof Error &&
    (error.name === 'DbUnavailableError' ||
      error.name === 'DbGroundingError' ||
      error.name === 'ObservationUnavailableError' ||
      error.name === 'ObservationTruncatedError' ||
      // No rewrite of the step can save a variable nothing set, or conjure
      // the request an assertion needed to have before it — same futility
      // rule, two more names (2026-08-24).
      error.name === 'UnknownVariableError' ||
      error.name === 'NoResponseError' ||
      // Nor can a rewrite give a handler a method it does not export.
      error.name === 'MethodRefusedError')
  ) {
    return true;
  }
  if (!(error instanceof StepResolutionError)) return false;
  return error.attempts.some(
    (line) =>
      line.startsWith('backend:') ||
      line.startsWith('declined to heal:') ||
      line.startsWith('authorization:') ||
      line.startsWith('known dead end:'),
  );
}

/**
 * Did that click's form submit natively, before the app hydrated?
 *
 * The live failure this catches: a login page's Sign in is clicked ~140ms
 * after load, before React attaches the submit handler, so the browser
 * performs the `<form>`'s default GET submission — the URL becomes
 * `/en/login?email=…&password=…`, no session is created, and every later
 * step runs against the login page filing "frontend" defects about an app
 * that works. Detection is evidence-based: a query parameter whose name
 * reads as a password, or whose value equals something a preceding fill
 * typed. Checked only when the preceding fill block looks credential-shaped,
 * so ordinary clicks never pay the recheck window.
 *
 * **A form whose inputs have no `name` submits nothing but a bare `?`**, and
 * that is the shape this missed for a whole catalog run. The app under test
 * writes `<input type="email">` / `<input type="password">` with no `name`
 * attribute, so its pre-hydration GET produced `/en/login?` — no parameters at
 * all, no evidence for either check above, no replay, and a silently failed
 * login. Measured across DB_01_01…DB_09_01: 21 of the 25 defects those runs
 * filed were downstream of exactly this. So a query string that **appeared
 * across the click** on a sign-in URL is the third signature. It is compared
 * against the URL as it stood when the fill block began — never "a login URL
 * happens to have a query string", which would trip on an ordinary
 * `/login?redirect=/somewhere`.
 *
 * Returns the offending parameter name, `NATIVE_SUBMIT_UNNAMED` for the bare
 * form, or null.
 */
export async function nativeFormResubmitDetected(
  urlOf: () => string,
  fills: readonly FlowStep[],
  recheckMs = 600,
  /** The URL when the credential fill block began. Absent disables the third signature. */
  urlBefore?: string | null,
): Promise<string | null> {
  if (fills.length === 0) return null;
  const credentialShaped = fills.some((step) =>
    /password|passwd|pwd/i.test(
      `${(step as { selector?: string }).selector ?? ''} ${(step as { intent?: string }).intent ?? ''}`,
    ),
  );
  if (!credentialShaped) return null;
  const typedValues = new Set(
    fills
      .map((step) => (step as { value?: string }).value)
      .filter((value): value is string => typeof value === 'string' && value !== ''),
  );
  // The native GET navigation commits within milliseconds on a healthy page,
  // but the click returns as soon as it lands — give the URL a short window
  // to show its hand before declaring the submit real.
  let before: URL | null = null;
  if (typeof urlBefore === 'string') {
    try {
      before = new URL(urlBefore);
    } catch {
      before = null;
    }
  }
  // A bare "?" is invisible to `URL.search`, which normalises an empty query
  // to '' — and the bare "?" IS the whole signature for a form whose inputs
  // have no name. `href` keeps it, so the query evidence is read from the
  // serialised form. (Found by writing the test: `new URL('http://x/a?')`
  // gives `search: ""`, `href: "http://x/a?"`.)
  const hasQuery = (u: URL): boolean => u.href.includes('?');
  const deadline = Date.now() + recheckMs;
  for (;;) {
    let url: URL;
    try {
      url = new URL(urlOf());
    } catch {
      return null;
    }
    for (const [name, value] of url.searchParams) {
      if (/password|passwd|pwd/i.test(name)) return name;
      if (typedValues.has(value)) return name;
    }
    // The unnamed-fields form: still on the sign-in page, and a query string
    // that was not there when the credentials were typed. Both halves are
    // required — the search must have APPEARED, and we must not have left.
    if (
      before !== null &&
      !hasQuery(before) &&
      hasQuery(url) &&
      url.pathname === before.pathname &&
      looksLikeSignIn(url.href)
    ) {
      return NATIVE_SUBMIT_UNNAMED;
    }
    if (Date.now() >= deadline) return null;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 150));
  }
}

/**
 * The "sign-in never took effect" diagnosis, or null.
 *
 * Pure and exported so the decision can be tested without a browser — the
 * message itself reads the page nowhere, which is the point: this app renders
 * a protected route for a beat before its client guard bounces it, so "what
 * does the URL look like now" is the wrong evidence and only the recorded
 * outcome of the submit will do.
 */
export function signInDidNotTakeMessage(state: {
  signInDidNotTake: boolean;
  lastGotoAskedSignIn: boolean;
  lastGotoPath: string | null;
}): string | null {
  // All three required. `lastGotoAskedSignIn` false plus a path is "the flow
  // has since asked for a page that needs a session" — which is exactly what
  // exempts a negative sign-in test that stays put to assert an error.
  if (!state.signInDidNotTake || state.lastGotoAskedSignIn || state.lastGotoPath === null) {
    return null;
  }
  return (
    `the sign-in did not take effect — the run is not signed in, and it has since asked ` +
    `for ${state.lastGotoPath}, which needs a session. Nothing after this point can say ` +
    `anything about the feature under test.\n` +
    `  This is not a redirect: the page never left the sign-in screen when the credentials ` +
    `were submitted. The click landed before the application hydrated, so the form ` +
    `submitted natively (or hydration reset the fields), and the replay did not recover it.\n` +
    `  Fix the flow's sign-in: assert something only a signed-in page shows immediately ` +
    `after the submit click, so the failure is caught here rather than as a pile of ` +
    `defects about the feature.`
  );
}

/**
 * Does this fill block type a credential? The shared shape behind both
 * hydration signatures and the sign-in verdict — one spelling, so the three
 * cannot drift apart.
 */
function credentialShapedBlock(fills: readonly FlowStep[]): boolean {
  return fills.some((step) =>
    /password|passwd|pwd/i.test(
      `${(step as { selector?: string }).selector ?? ''} ${(step as { intent?: string }).intent ?? ''}`,
    ),
  );
}

/**
 * The evidence marker for a native submit whose form named none of its fields
 * — see `nativeFormResubmitDetected`. Not a parameter name, because there
 * were none; the finding's wording branches on it.
 */
export const NATIVE_SUBMIT_UNNAMED = '(unnamed form fields)';

/** The replayed copy of a step, labelled so the bundle reads as what happened. */
function markReplayed(
  step: FlowStep,
  reason = 'the form submitted natively before hydration',
): FlowStep {
  return {
    ...step,
    intent: `${(step as { intent?: string }).intent ?? step.action} — replayed after ${reason}`,
  } as FlowStep;
}

/**
 * Did hydration EAT the fills? The second signature of the same race, seen
 * live on DB_04_01/DB_06_01/DB_07_01: the Sign-in click lands pre-hydration
 * but the form does NOT navigate (so `nativeFormResubmitDetected` has no URL
 * evidence) — instead React hydrates after the fills and resets its
 * controlled inputs, the click submits an empty password, and the page just
 * sits on the login screen. Even reconstruction's re-clicks then fail,
 * because nothing re-fills what hydration wiped.
 *
 * Evidence-based like its sibling: a credential-shaped field that reads back
 * a DIFFERENT value than the step typed (typically empty) is the signature.
 * Checked only when the block is credential-shaped, and each read is a
 * single immediate `inputValue` — the click already settled, so there is
 * nothing to wait for. A field that cannot be read (gone, not an input) is
 * skipped, never guessed at.
 *
 * Returns the lost field's selector (the evidence), or null.
 */
export async function fillsLostToHydration(
  valueOf: (selector: string) => Promise<string | null>,
  fills: readonly FlowStep[],
): Promise<string | null> {
  const credentialShaped = (step: FlowStep): boolean =>
    /password|passwd|pwd/i.test(
      `${(step as { selector?: string }).selector ?? ''} ${(step as { intent?: string }).intent ?? ''}`,
    );
  // No credential fill anywhere in the block → no reads at all: ordinary
  // form interactions must not pay a page round-trip per fill.
  if (!fills.some(credentialShaped)) return null;
  for (const step of fills) {
    if (!credentialShaped(step)) continue;
    const selector = (step as { selector?: string }).selector;
    const typed = (step as { value?: string }).value;
    if (!selector || typeof typed !== 'string' || typed === '') continue;
    const now = await valueOf(selector);
    if (now !== null && now !== typed) return selector;
  }
  return null;
}

async function executeSteps(
  runner: SmartRunner,
  steps: readonly FlowStep[],
  baseUrl: string | undefined,
  issues: StepIssue[],
): Promise<void> {
  // The contiguous fill/type block immediately behind the step now running —
  // what a hydration replay would have to repeat. See
  // `nativeFormResubmitDetected`; one replay per section, ever, so a page
  // that keeps racing cannot loop the run.
  const recentFills: FlowStep[] = [];
  // The URL as it stood when the block began — the baseline for the
  // unnamed-fields signature in `nativeFormResubmitDetected`. Captured at the
  // block's FIRST fill so "the URL gained a query string" is a real
  // observation rather than an assumption about what a login URL looks like.
  let urlBeforeFills: string | null = null;
  let hydrationReplayed = false;
  for (const raw of steps) {
    // A step that does not pass no longer aborts the run: it is recorded and
    // classified (fail / error / dead end), and the next step gets its turn.
    // The run reports everything it saw at the end instead of stopping at the
    // first thing that went wrong.
    //
    // Before that final classification comes **in-run reconstruction**: a
    // step's first failure asks the repair model for a rebuilt step against
    // the live page (the same job `--repair` does between runs, without the
    // re-run), and the step is retried until its failures reach
    // `STEP_RECONSTRUCT_TRIES`. Attempts a later reconstruction rescued are
    // marked superseded — recorded, but an outcome for nothing. Two honesty
    // rails: an **assertion keeps its claim verbatim** (a reconstruction may
    // only insert preparation before it — a claim rewritten until it passes
    // proves nothing, the same argument that keeps the agent rung off
    // assertions), and every rescue files a `medium` defect, because a flow
    // that needs rebuilding every run is drifting from the app.
    let original: FlowStep;
    try {
      original = interpolateStep(raw, runner.variables);
    } catch (error) {
      // Bad interpolation (an unknown {{var}}) fails this step and moves on,
      // exactly as it did before reconstruction existed — there is nothing a
      // rebuilt step could do about a variable the run never saved.
      const kind = classifyStepFailure(raw.action, error);
      runner.bundle.reclassifyLastStep(kind, raw.action);
      issues.push({
        action: raw.action,
        selector: (raw as { selector?: string }).selector ?? null,
        kind,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    let plan: FlowStep[] = [original];
    let failures = 0;
    const supersededIndexes: number[] = [];
    const history: Array<{ attempt: number; summary: string; outcome: string }> = [];
    let lastProposal: { replacement: FlowStep; inserted: number; reasoning: string } | null = null;

    for (;;) {
      let failedStep: FlowStep = original;
      try {
        for (const step of plan) {
          // Before anything else. A run bounced to the sign-in page cannot
          // answer the question it was asked — see `assertSessionHeld`.
          runner.assertSessionHeld();
          await runner.narrate(
            runner.bundle.steps.length,
            step.action,
            (step as { intent?: string | undefined }).intent,
          );
          await runner.paceStep();
          try {
            await executeStep(runner, step, baseUrl, issues);
            runner.noteAction(step.action);
          } catch (error) {
            runner.noteAction(step.action);
            failedStep = step;
            throw error;
          }
        }
      } catch (error) {
        // A lost session is fatal: it stops the flow rather than being
        // recorded as one more failed step among many.
        if (error instanceof SessionLostError) throw error;
        // A dead browser is fatal too, and it is an *environment* fact.
        if (error instanceof Error && isBrowserGone(error.message)) {
          throw new BrowserGoneError(
            `the browser went away mid-run (${error.message.split('\n')[0]}) — ` +
              'this is an environment failure, not an application result; every ' +
              'step after this point was skipped rather than blamed on the app',
          );
        }

        failures += 1;
        const recordedIndex = runner.bundle.steps.length - 1;

        const repair = runner.stepRepair;
        // `canExpress` guards the ask the schema refuses every answer to: a
        // step whose action the repair schema cannot spell (DB, HTTP,
        // workflow) makes the model echo the action, fail validation on
        // every identical temperature-0 retry, and open the structured-output
        // breaker for the rest of the run.
        if (
          repair &&
          failures < STEP_RECONSTRUCT_TRIES &&
          !reconstructionFutile(error) &&
          repair.canExpress?.(original.action) !== false
        ) {
          const proposal = await askReconstruction(
            runner,
            repair,
            original,
            failedStep,
            error,
            failures,
            history,
          );
          if (proposal !== null) {
            supersededIndexes.push(recordedIndex);
            const isAssertion = (ASSERTION_ACTIONS as readonly string[]).includes(original.action);
            // An assertion keeps its claim; everything else may be replaced.
            const replacement = isAssertion ? original : proposal.replacement;
            plan = [...proposal.insertBefore, replacement];
            lastProposal = {
              replacement,
              inserted: proposal.insertBefore.length,
              reasoning: proposal.reasoning,
            };
            history.push({
              attempt: failures,
              summary: proposal.reasoning,
              outcome: 'retrying in-run with this reconstruction',
            });
            continue;
          }
        }

        // Out of tries (or nothing to try): final classification, as ever.
        const kind = classifyStepFailure(failedStep.action, error);
        runner.bundle.reclassifyLastStep(kind, failedStep.action);
        issues.push({
          action: failedStep.action,
          selector: (failedStep as { selector?: string }).selector ?? null,
          kind,
          message: error instanceof Error ? error.message : String(error),
        });
        break;
      }

      // The plan ran clean. If earlier tries failed, they are attempts now,
      // not outcomes — and the rescue itself is a finding.
      if (supersededIndexes.length > 0 && lastProposal) {
        runner.bundle.supersedeSteps(supersededIndexes);
        runner.bundle.noteReconstruction({
          attempt: failures + 1,
          // A second recording boundary, and one the first fix missed: these
          // serialise the WHOLE step, so a masked `detail.value` on the step
          // itself does nothing for the copy stored here. Found by grepping a
          // real bundle after the fill masking landed and finding the password
          // still present under `reconstruction.from`.
          from: JSON.stringify(runner.maskStepSecrets(original)),
          to: JSON.stringify(runner.maskStepSecrets(lastProposal.replacement)),
          inserted: lastProposal.inserted,
          reasoning: lastProposal.reasoning,
          model: repairModelId(runner),
        });
        runner.recordReconstructionDefect(original, failures);
      }

      // Hydration-race recovery, after the plan ran clean: a click that
      // "passed" may still have submitted its form natively (pre-hydration),
      // which no per-step check can see — the click landed, the page just did
      // the wrong thing with it. Detect it from the URL's own evidence, file
      // the finding (it is an app fact too: credentials reached the URL), and
      // replay the fill block + click once against the hydrated page.
      if (original.action === 'fill' || original.action === 'type') {
        if (recentFills.length === 0) urlBeforeFills = runner.page.url();
        recentFills.push(original);
      } else if (original.action === 'click') {
        const param = hydrationReplayed
          ? null
          : await nativeFormResubmitDetected(
              () => runner.page.url(),
              recentFills,
              undefined,
              urlBeforeFills,
            );
        // Same race, second signature: no URL evidence because the form never
        // navigated — hydration reset the controlled inputs instead, and the
        // click submitted emptiness (DB_04_01/DB_06_01/DB_07_01 live). Only
        // consulted when the first signature is absent, and it reads the
        // fields once, immediately.
        const lostField =
          param !== null || hydrationReplayed
            ? null
            : await fillsLostToHydration(async (selector) => {
                try {
                  return await runner.page.locator(selector).inputValue({ timeout: 1_000 });
                } catch {
                  return null;
                }
              }, recentFills);
        if (param !== null || lostField !== null) {
          hydrationReplayed = true;
          const reason =
            param !== null
              ? 'the form submitted natively before hydration'
              : 'hydration reset the filled fields';
          if (param !== null) runner.recordNativeResubmitFinding(original, param);
          else runner.recordLostFillFinding(original, lostField as string);
          await runner.page
            .waitForLoadState('networkidle', { timeout: 10_000 })
            .catch(() => undefined);
          await runner.page.waitForTimeout(300).catch(() => undefined);
          try {
            for (const fill of recentFills) {
              await executeStep(runner, markReplayed(fill, reason), baseUrl, issues);
            }
            await executeStep(runner, markReplayed(original, reason), baseUrl, issues);
          } catch (error) {
            if (error instanceof SessionLostError) throw error;
            // A failed replay classifies like any failed step; the original
            // finding already says what went wrong the first time.
            const kind = classifyStepFailure(original.action, error);
            runner.bundle.reclassifyLastStep(kind, original.action);
            issues.push({
              action: original.action,
              selector: (original as { selector?: string }).selector ?? null,
              kind,
              message: error instanceof Error ? error.message : String(error),
            });
          }
          // Did the recovery work? Only a credential block can answer, and
          // only after the replay: still on the sign-in page means this run
          // holds no session, and every later step is about to be asserted
          // against a page it has no right to be on. See `#strandedMessage`.
          runner.noteSignInOutcome(looksLikeSignIn(runner.page.url()));
        } else if (credentialShapedBlock(recentFills)) {
          // A credential submit with no hydration evidence and no sign-in URL
          // left behind is a submit that worked — clear any earlier verdict,
          // so a flow that retries its login is judged on the retry.
          runner.noteSignInOutcome(false);
        }
        recentFills.length = 0;
        urlBeforeFills = null;
      } else {
        recentFills.length = 0;
        urlBeforeFills = null;
      }
      break;
    }
  }
}

function repairModelId(runner: SmartRunner): string {
  return runner.stepRepair?.id ?? 'unknown';
}

/**
 * One reconstruction ask against the live page. Best-effort everywhere: a
 * model that cannot be reached, declines, or answers garbage returns null,
 * and the step falls through to its ordinary classification.
 */
async function askReconstruction(
  runner: SmartRunner,
  repair: FlowRepairModel,
  original: FlowStep,
  failedStep: FlowStep,
  error: unknown,
  attempt: number,
  history: Array<{ attempt: number; summary: string; outcome: string }>,
): Promise<{ insertBefore: FlowStep[]; replacement: FlowStep; reasoning: string } | null> {
  let axTree = '(page unavailable for a fresh accessibility-tree read)';
  try {
    axTree = await captureAxTree(runner.page, DEFAULT_RECONSTRUCT_MAX_AX_NODES);
  } catch {
    // The live page is right here; if even that read fails, the proposal is
    // still worth asking for.
  }
  try {
    const proposal = await repair.repair({
      flow: { name: runner.bundle.name, steps: [original] },
      failedStep,
      section: 'steps',
      index: 0,
      error: describe(error),
      axTree,
      url: runner.page.url(),
      attempt,
      history,
    });
    // The call was made whatever the answer says — a `canFix: false` costs the
    // same tokens a fix does, and a bill that omits the refusals understates
    // exactly the runs that struggled most.
    runner.bundle.noteModelSpend(proposal.inputTokens ?? 0, proposal.outputTokens ?? 0);
    if (!proposal.canFix) return null;
    return {
      insertBefore: proposal.insertBefore,
      replacement: proposal.replacement,
      reasoning: proposal.reasoning,
    };
  } catch {
    // Provider trouble is not a page fact; the step classifies as it would
    // have without reconstruction.
    return null;
  }
}

async function executeStep(
  runner: SmartRunner,
  step: FlowStep,
  baseUrl: string | undefined,
  issues: StepIssue[],
): Promise<void> {
  {
    switch (step.action) {
      case 'use':
        // expandFlow() removes these before a run starts. Reaching one means a
        // caller executed a flow it never expanded — say so, rather than
        // silently skipping a fragment and running an incomplete test.
        throw new Error(
          `internal: unexpanded "use" step for "${step.flow}" — ` +
            'call expandFlow() before executing a composed flow',
        );
      case 'when': {
        const matched = await runner.evaluateWhen(
          {
            ...(step.visible !== undefined ? { visible: step.visible } : {}),
            ...(step.hidden !== undefined ? { hidden: step.hidden } : {}),
            ...(step.enabled !== undefined ? { enabled: step.enabled } : {}),
            ...(step.disabled !== undefined ? { disabled: step.disabled } : {}),
          },
          step.intent,
        );
        const branch = matched ? step.then : step.else;
        if (branch?.length) await executeSteps(runner, branch, baseUrl, issues);
        break;
      }
      case 'goto':
        await runner.goto(resolveUrl(step.url, baseUrl));
        break;
      case 'click':
        await runner.click(step.selector, step.intent);
        break;
      case 'fill':
        await runner.fill(step.selector, step.value, step.intent);
        break;
      case 'selectOption':
        await runner.selectOption(step.selector, step.value, step.intent);
        break;
      case 'check':
        await runner.check(step.selector, step.intent);
        break;
      case 'uncheck':
        await runner.uncheck(step.selector, step.intent);
        break;
      case 'type':
        await runner.type(step.selector, step.value, step.intent);
        break;
      case 'waitFor':
        await runner.waitFor(step.selector, step.intent);
        break;
      case 'workflow':
        await runner.workflow(step.goal, step.script);
        break;
      case 'setLocalStorage':
        await runner.setLocalStorage(step.key, step.value);
        break;
      case 'clearStorage':
        await runner.clearStorage();
        break;
      case 'signOut':
        await runner.signOut(step.intent);
        break;
      case 'setClock':
        await runner.setClock(step.time, step.intent);
        break;
      case 'back':
        await runner.back(step.intent);
        break;
      case 'forward':
        await runner.forward(step.intent);
        break;
      case 'scrollTo':
        await runner.scrollTo(step.selector, step.intent);
        break;
      case 'expectScrollable':
        await runner.expectScrollable(step.selector, step.intent);
        break;
      case 'expectNotScrollable':
        await runner.expectNotScrollable(step.selector, step.intent);
        break;
      case 'expectText':
        await runner.expectText(step.selector, step.value, step.intent, step.anyOf);
        break;
      case 'expectVisible':
        await runner.expectVisible(step.selector, step.intent);
        break;
      case 'expectHidden':
        await runner.expectHidden(step.selector, step.intent);
        break;
      case 'expectEnabled':
        await runner.expectEnabled(step.selector, step.intent);
        break;
      case 'expectDisabled':
        await runner.expectDisabled(step.selector, step.intent);
        break;
      case 'expectCount':
        await runner.expectCount(step.selector, step.count, step.intent);
        break;
      case 'expectUrl':
        await runner.expectUrl(step.value, step.intent);
        break;
      case 'expectValue':
        await runner.expectValue(step.selector, step.value, step.intent);
        break;
      case 'expectAttribute':
        await runner.expectAttribute(step.selector, step.name, step.value, step.intent);
        break;
      case 'press':
        await runner.press(step.key, step.selector, step.intent);
        break;
      case 'expectFocused':
        await runner.expectFocused(step.selector, step.intent);
        break;
      case 'expectTabOrder':
        await runner.expectTabOrder(step.selectors, step.intent);
        break;
      case 'fillEach':
        await runner.fillEach(step.selector, step.cases, step.intent, step.submit);
        break;
      case 'fillRetry':
        await runner.fillRetry(step.selector, step.kind, step.failureSelector, {
          submit: step.submit,
          maxAttempts: step.maxAttempts,
          description: step.description,
          intent: step.intent,
        });
        break;
      case 'request':
        // `baseUrl` is passed through rather than applied here — see the note
        // on `FlowRequestSpec.baseUrl` about placeholders and percent-encoding.
        await runner.request({ ...step, baseUrl });
        break;
      case 'expectStatus':
        await runner.expectStatus(step.status, step.intent);
        break;
      case 'expectJson':
        await runner.expectJson(step.path, { value: step.value, intent: step.intent });
        break;
      case 'expectHeader':
        await runner.expectHeader(step.name, step.value, step.intent);
        break;
      case 'expectCalls':
        await runner.expectCalls(step);
        break;
      case 'dbSnapshot':
        await runner.dbSnapshot(step);
        break;
      case 'expectDbRow':
        await runner.expectDbRow(step);
        break;
      case 'expectDbDelta':
        await runner.expectDbDelta(step);
        break;
      case 'expectDbUnchanged':
        await runner.expectDbUnchanged(step);
        break;
      case 'expectDbCalled':
        await runner.expectDbCalled(step);
        break;
      case 'expectModal':
        await runner.expectModal(step.name, step.intent);
        break;
      case 'closeModal':
        await runner.closeModal(step.button, step.intent);
        break;
      case 'snapshot':
        await runner.snapshot(step.name, step.selector);
        break;
    }
  }
}

/**
 * Execute a flow: setup → steps → teardown.
 *
 * Teardown runs even when the body fails, so a run cannot leave the browser
 * in a state that poisons the next test. A setup failure short-circuits the
 * body — preconditions that did not hold make the result meaningless.
 */
export async function executeFlow(runner: SmartRunner, flow: Flow): Promise<void> {
  const issues: StepIssue[] = [];

  // A lost session stops the body (see `assertSessionHeld`) but must not skip
  // cleanup: "teardown always runs" is the rule everywhere else, and a flow
  // that signed in and created something still has to put it back.
  let fatal: unknown;
  try {
    if (flow.setup?.length) await executeSteps(runner, flow.setup, flow.baseUrl, issues);
    await executeSteps(runner, flow.steps, flow.baseUrl, issues);
  } catch (error) {
    // A dead browser skips teardown outright — "teardown always runs" holds
    // for every failure that leaves a browser to run it in, and this one
    // does not. Attempting it would only stack more closed-target errors on
    // top of the one that matters.
    if (error instanceof BrowserGoneError) throw error;
    if (!(error instanceof SessionLostError)) throw error;
    fatal = error;
  }
  if (flow.teardown?.length) {
    try {
      await executeSteps(runner, flow.teardown, flow.baseUrl, issues);
    } catch (error) {
      // Teardown stranded too: the body's reason is the one worth reporting.
      if (error instanceof SessionLostError || error instanceof BrowserGoneError) {
        // swallow — the body's outcome is the story
      } else {
        throw error;
      }
    }
  }

  if (fatal) throw fatal;
  if (issues.length > 0) throw new StepIssuesError(issues);
}

export interface RunFlowOptions {
  cdpUrl?: string | undefined;
  cachePath?: string | undefined;
  healer?: JitHealer | null | undefined;
  agent?: WorkflowAgent | null | undefined;
  dataModel?: DataModel | null | undefined;
  fastTimeoutMs?: number | undefined;
  healedTimeoutMs?: number | undefined;
  /** Film the run with a drawn-in pointer. Default `on`; see `video.ts`. */
  video?: VideoMode | undefined;
  /**
   * Give this run its own browser context even when it is not being filmed.
   *
   * Two runs sharing `browser.contexts()[0]` share its pages, and a suite that
   * runs its cases concurrently would have them clicking in each other's tabs
   * — the exact interleaving the panel's one-browser-at-a-time rule exists to
   * prevent, moved inside a single command. A recorded run already gets its
   * own context for an unrelated reason (recording is a property of a context),
   * which is why this only has to cover `--video off`.
   *
   * The session is carried across exactly as the recording path carries it, so
   * isolation does not silently sign the run out.
   */
  isolate?: boolean | undefined;
  /**
   * Whether a context this run creates starts with the attached browser's
   * session (cookies + storage). Default true — the reason a filmed run can
   * still test a page someone signed into by hand. `false` starts EMPTY, and
   * is what a flow that signs in ITSELF wants: an inherited session is a
   * different account signed in before its first step, and on this
   * application a stale admin session left in the browser by an earlier run
   * put every persona's case on the admin's landing page instead of the login
   * form. `runFlow` sets it from the flow's own shape — see `signsInItself`.
   */
  inheritSession?: boolean | undefined;

  /**
   * The suite's session vault. Before the run, a banked session for this
   * flow's origin is injected (unless the flow signs in itself); after it,
   * a run that ends signed in on that origin banks its own state — so one
   * sign-in serves the whole suite. See `engine/session-vault.ts`.
   */
  sessionVault?: SessionVault | undefined;

  screenshots?: ScreenshotMode | undefined;
  captureDelayMs?: number | undefined;
  /** Let the agent make an unreachable control reachable. Default false. */
  agentAssist?: boolean | undefined;
  /**
   * In-run step reconstruction: on a step's failure, ask this model for a
   * rebuilt step against the live page and retry, up to
   * `STEP_RECONSTRUCT_TRIES` total tries, before final classification.
   * Attempts a rescue supersedes count toward nothing; every rescue files a
   * `medium` drift defect; an assertion keeps its claim verbatim (only
   * preparation may be inserted before it). Null/absent disables.
   */
  stepRepair?: FlowRepairModel | null | undefined;
  /**
   * The auto-review judge: one small `agent`-role call when a run lands on
   * proved-?, ruling it `proved` at `AUTO_PROVE_CONFIDENCE` or better — see
   * `src/engine/review-judge.ts`. Null/absent leaves every proved-? for a
   * human, exactly as before the judge existed.
   */
  reviewJudge?: ReviewJudge | null | undefined;
  /**
   * Pause before each step, in ms. Zero (the default) keeps the hot path
   * hot. Under `video: 'always'` the default becomes
   * `DEMONSTRATION_STEP_DELAY_MS`: that mode records a film for a human to
   * watch, and a run that blurs through five states in two seconds
   * demonstrates nothing — the pause is what lets each state be seen, with
   * the caption naming the step about to happen.
   */
  stepDelayMs?: number | undefined;
  coverage?: boolean | undefined;
  baselineDir?: string | undefined;
  updateBaselines?: boolean | undefined;
  /** Observe the page's HTTP traffic over CDP. Default true. */
  network?: boolean | undefined;
  /** How much of an observed request may be recorded. Defaults to redacting. */
  networkRedaction?: RedactionPolicy | undefined;
  /** Credentials for `--as`; carried only so their password can be masked. */
  credentials?: { email: string; password: string } | undefined;
  /** Ring-buffer cap for the observer — see `SmartRunnerOptions.networkMaxCalls`. */
  networkMaxCalls?: number | undefined;
  /**
   * Transport for `request` steps. Defaults to the browser context's (so API
   * calls inherit the UI's session), or to Node's `fetch` for a browser-free
   * flow.
   */
  transport?: ApiTransport | null | undefined;
  /**
   * Database connection for DB verification steps. Defaults to
   * `WOWLIDATOR_DB_URL`; `null` disables. Lazy — a flow with no DB steps
   * never connects and never demands the driver.
   */
  db?: DbConfig | null | undefined;
  /** Pre-built DB client — the embedder/test seam. Wins over `db`. */
  dbClient?: DbClient | null | undefined;
  /** Append to and compare against this run-history index. Null disables. */
  historyPath?: string | null | undefined;
  /** Build the healer once the cache exists. Ignored when `healer` is given. */
  makeHealer?: ((cache: CacheManager) => JitHealer) | undefined;
  /** Defects from a generator pass, merged into this run's report. */
  defects?: readonly Defect[] | undefined;
  /** Provenance when this flow was generated rather than hand-written. */
  generatedBy?: GenerationProvenance | undefined;
  /** Called right after each step is recorded — for live progress output. */
  onStep?: ((step: ProofStep) => void) | undefined;
  /**
   * Called once, before the first step, with how many steps this run intends
   * to take. Live progress needs a denominator, and this is the only place it
   * is knowable: composition has been resolved by then, so it counts the steps
   * a fragment spliced in, and it is still before anything has run.
   */
  onPlan?: ((plan: RunPlan) => void) | undefined;
  /**
   * Directory that `use` paths resolve against — normally the directory of the
   * `.flow.json` being run. Defaults to the process's cwd, which is right for
   * a flow built in memory and wrong for one loaded from disk, so callers that
   * read a file should pass it.
   */
  flowDir?: string | undefined;
}

/**
 * Actions that need no browser at all — shared with the proof bundle's set
 * definitions, so "does this step need a page" has exactly one answer. Note
 * this is `BROWSER_FREE_ACTIONS`, not `BACKEND_TIER_ACTIONS`: `expectCalls`
 * is backend-tier but needs the live observer, so its presence keeps a flow
 * on the browser path.
 */
const API_ONLY_ACTIONS = BROWSER_FREE_ACTIONS;

/**
 * True when nothing in this flow needs a page.
 *
 * Decided by inspection rather than by a flag, because it can't be wrong: a
 * flow of pure API steps has nothing to click, and asking the user to also
 * remember to pass `--no-browser` would only create a way to get it wrong.
 */
export function isBrowserFree(flow: Flow): boolean {
  const every = [...(flow.setup ?? []), ...flow.steps, ...(flow.teardown ?? [])];
  return every.length > 0 && every.every((step) => API_ONLY_ACTIONS.has(step.action));
}

async function executeApiSteps(
  api: ApiActions,
  db: DbActions,
  steps: readonly FlowStep[],
  baseUrl: string | undefined,
  issues: StepIssue[],
  bundle?: ProofBundleBuilder,
): Promise<void> {
  for (const step of steps) {
    // Same run-to-the-end rule as the browser path: a miss is classified and
    // collected, and the next step still runs.
    try {
      switch (step.action) {
        case 'request':
          await api.request({ ...step, baseUrl });
          break;
        case 'expectStatus':
          await api.expectStatus(step.status, step.intent);
          break;
        case 'expectJson':
          await api.expectJson(step.path, { value: step.value, intent: step.intent });
          break;
        case 'expectHeader':
          await api.expectHeader(step.name, step.value, step.intent);
          break;
        case 'dbSnapshot':
          await db.dbSnapshot(step);
          break;
        case 'expectDbRow':
          await db.expectDbRow(step);
          break;
        case 'expectDbDelta':
          await db.expectDbDelta(step);
          break;
        case 'expectDbUnchanged':
          await db.expectDbUnchanged(step);
          break;
        case 'expectDbCalled':
          await db.expectDbCalled(step);
          break;
        default:
          // Unreachable via `runFlow`, which checks `isBrowserFree` first — but
          // reachable by an embedder calling this directly, and a clear message
          // beats a `page is undefined` three frames down. (`expectCalls` lands
          // here on purpose: it needs the live observer, so it keeps a flow on
          // the browser path — see `API_ONLY_ACTIONS`.)
          throw new Error(
            `"${step.action}" needs a browser; this flow was run without one because every ` +
              'other step was an API or DB step',
          );
      }
    } catch (error) {
      const kind = classifyStepFailure(step.action, error);
      bundle?.reclassifyLastStep(kind, step.action);
      issues.push({
        action: step.action,
        selector: null,
        kind,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * Run a flow that never opens a browser.
 *
 * Everything downstream of the run — the proof bundle, the HTML report, run
 * history and flake analysis, `--repair` — works on the result unchanged,
 * because none of them ever depended on there having been a page. Coverage is
 * the one exception, and it correctly reports nothing measured rather than 0%,
 * which would read as "every control was missed".
 */
/**
 * The label the bundle carries: the flow's own statement when the catalog
 * stamped one, a deterministic inference otherwise. Inference reads the
 * flow's name (on the catalog path that is the row's claim verbatim), every
 * step's intent, and the step shapes that can only mean refusal.
 */
function flowPolarity(flow: Flow): { polarity: TestPolarity; source: 'stated' | 'inferred' } {
  if (flow.polarity !== undefined) return { polarity: flow.polarity, source: 'stated' };
  const steps = [...(flow.setup ?? []), ...flow.steps];
  const text = [flow.name, ...steps.map((step) => ('intent' in step ? (step.intent ?? '') : ''))]
    .filter((t) => t !== '')
    .join('\n');
  return { polarity: inferPolarity(text, steps as never), source: 'inferred' };
}

export async function runApiFlow(flow: Flow, options: RunFlowOptions = {}): Promise<ProofBundle> {
  const apiPolarity = flowPolarity(flow);
  const bundle = new ProofBundleBuilder({
    name: flow.name,
    cdpUrl: null,
    cachePath: null,
    healerModel: null,
    generatedBy: options.generatedBy,
    onStep: options.onStep,
    polarity: apiPolarity.polarity,
    polaritySource: apiPolarity.source,
  });
  if (options.defects?.length) bundle.addDefects(options.defects);

  let defectSeq = 0;
  const recordDefect = (
    category: Defect['category'],
    severity: Defect['severity'],
    title: string,
    detail: string,
  ): void => {
    defectSeq += 1;
    bundle.addDefect({
      id: `run-${defectSeq}`,
      source: 'runtime',
      category,
      severity,
      title,
      detail,
      stepIndex: bundle.steps.length - 1,
    });
  };
  // One store for both families — same reasoning as the runner's constructor.
  const variables = new VariableStore();
  const api = new ApiActions({
    transport: options.transport ?? new FetchTransport(),
    bundle,
    variables,
    redaction: options.networkRedaction,
    recordDefect,
  });
  const db = new DbActions({
    db: options.db === undefined ? defaultDbConfig() : options.db,
    client: options.dbClient,
    bundle,
    variables,
    recordDefect,
  });

  const issues: StepIssue[] = [];
  try {
    if (flow.setup?.length) {
      await executeApiSteps(api, db, flow.setup, flow.baseUrl, issues, bundle);
    }
    await executeApiSteps(api, db, flow.steps, flow.baseUrl, issues, bundle);
    // Teardown still always runs — its job is to clean up regardless of how
    // the body went, and that reasoning has nothing to do with browsers.
    if (flow.teardown?.length) {
      await executeApiSteps(api, db, flow.teardown, flow.baseUrl, issues, bundle);
    }
  } finally {
    await db.close().catch(() => undefined);
  }

  bundle.setVariables(variables.snapshotForReport());
  if (issues.length > 0) bundle.recordIssueTally(new StepIssuesError(issues).message);
  const sealed = bundle.finish();

  if (options.historyPath !== null) {
    try {
      const history = new RunHistory(options.historyPath ?? undefined);
      const priors = await history.forFlow(sealed.name);
      const trend = analyseTrend(sealed, priors);
      bundle.setTrend(trend);
      await history.append(sealed);
      return { ...sealed, trend };
    } catch {
      return sealed;
    }
  }

  return sealed;
}

/**
 * Connect, run a flow to completion (or first failure), and always return a
 * sealed proof bundle. A failing step is recorded, not thrown.
 *
 * A flow with no UI steps is dispatched to `runApiFlow` and never touches
 * Chrome — see `isBrowserFree`.
 */
/**
 * Does this flow authenticate on its own — a credential-shaped fill (a password
 * field by selector or intent, or the taught nameless-textbox idiom on a
 * sign-in page) anywhere in its setup or body?
 *
 * Decides whether a run should START with the attached browser's session. A
 * flow that signs in itself and also inherits a session begins as a different
 * account than it is about to become; measured on the application this was
 * written against, a stale admin session left in the browser by an earlier
 * run put an HRBP case on the admin landing page before its first step, and
 * the sign-in form the flow expected was not there.
 */
export function signsInItself(flow: Flow): boolean {
  const steps: FlowStep[] = [...(flow.setup ?? []), ...flow.steps];
  let onSignIn = false;
  for (const step of steps) {
    if (step.action === 'goto') {
      onSignIn = looksLikeSignIn(step.url);
      continue;
    }
    if (step.action !== 'fill' && step.action !== 'type') continue;
    const text = `${step.selector} ${step.intent ?? ''}`;
    if (/password|passwd|pwd/i.test(text)) return true;
    if (onSignIn && /role=textbox\s*>>\s*nth=/i.test(step.selector)) return true;
  }
  return false;
}

export async function runFlow(
  sourceFlow: Flow,
  options: RunFlowOptions = {},
): Promise<ProofBundle> {
  // Composition is resolved once, here, so every caller — CLI, MCP, the repair
  // loop — gets it without asking, and everything downstream sees an ordinary
  // flow. `flowDir` is what makes a fragment path relative to the flow that
  // used it rather than to whatever directory the process happens to be in.
  const flow = hasIncludes(sourceFlow)
    ? await expandFlow(sourceFlow, { dir: options.flowDir ?? process.cwd() })
    : sourceFlow;

  // Announced before the browser-free branch, so both paths report a plan and
  // a progress bar does not silently stay empty for an API-only flow.
  //
  // `total` is what the flow intends, not what it will necessarily record: a
  // failure stops `steps` early, and `when` runs one branch of two. It is an
  // upper bound, and the honest one — a denominator that shrank as a run went
  // wrong would make a failing run look like it was accelerating.
  const plan: RunPlan = {
    setup: flow.setup?.length ?? 0,
    steps: flow.steps.length,
    teardown: flow.teardown?.length ?? 0,
    total: 0,
  };
  plan.total = plan.setup + plan.steps + plan.teardown;
  options.onPlan?.(plan);

  if (isBrowserFree(flow)) return runApiFlow(flow, options);

  const cache = new CacheManager(
    options.cachePath === undefined ? {} : { filePath: options.cachePath },
  );
  await cache.load();

  const healer =
    options.healer !== undefined ? options.healer : (options.makeHealer?.(cache) ?? null);

  const polarity = flowPolarity(flow);
  const bundle = new ProofBundleBuilder({
    name: flow.name,
    cdpUrl: options.cdpUrl ?? DEFAULT_CDP_URL,
    cachePath: cache.filePath,
    healerModel: healer?.model.id ?? null,
    generatedBy: options.generatedBy,
    onStep: options.onStep,
    polarity: polarity.polarity,
    polaritySource: polarity.source,
  });

  // Generator findings belong in the report even if the run dies at connect.
  if (options.defects?.length) bundle.addDefects(options.defects);

  // The one origin this flow tests, for the suite's session vault: banked
  // state is only ever injected into — and saved from — a matching origin.
  const vaultOrigin = flowOriginOf(flow);
  const bankedSession =
    options.sessionVault !== undefined && vaultOrigin !== null
      ? (options.sessionVault.get(vaultOrigin) ?? undefined)
      : undefined;

  let runner: SmartRunner;
  try {
    runner = await SmartRunner.connect({
      cdpUrl: options.cdpUrl,
      cache,
      bundle,
      healer,
      agent: options.agent,
      dataModel: options.dataModel,
      // The flow's own card: the file is the artifact, so a re-run or a
      // repair still tells the runtime roles what the case proves.
      caseContext: flow.caseContext,
      fastTimeoutMs: options.fastTimeoutMs,
      healedTimeoutMs: options.healedTimeoutMs,
      video: options.video,
      isolate: options.isolate,
      // Explicit wins; else the flow's own shape decides. A flow that types a
      // password wants to be the account it types, not the one the browser
      // was left signed in as.
      inheritSession: options.inheritSession ?? !signsInItself(flow),
      flowSignsInItself: signsInItself(flow),
      screenshots: options.screenshots,
      captureDelayMs: options.captureDelayMs,
      agentAssist: options.agentAssist,
      stepRepair: options.stepRepair,
      stepDelayMs: options.stepDelayMs,
      coverage: options.coverage,
      baselineDir: options.baselineDir,
      updateBaselines: options.updateBaselines,
      network: options.network,
      networkRedaction: options.networkRedaction,
      credentials: options.credentials,
      networkMaxCalls: options.networkMaxCalls,
      transport: options.transport,
      db: options.db,
      dbClient: options.dbClient,
      ...(bankedSession === undefined ? {} : { sessionState: bankedSession }),
    });
  } catch (error) {
    // Died before a single test step could run. The bundle still goes to run
    // history — a launch that failed at attach is a result worth recalling,
    // not a run that never happened.
    bundle.recordRunError(error);
    return appendToHistory(bundle.finish(), bundle, options, flow.caseContext);
  }

  try {
    await executeFlow(runner, flow);
  } catch (error) {
    // The step itself is already recorded; keep the message at run level too.
    // A tally of step issues is kept apart from a fatal — see StepIssuesError.
    if (error instanceof StepIssuesError) bundle.recordIssueTally(error.message);
    else bundle.recordRunError(error);
  }

  // Bank the session for the suite's later cases — observation-gated: only a
  // run that ENDS on this origin, off the sign-in page, with cookies to its
  // name, has a session worth carrying. Never a verdict: any failure here is
  // a convenience lost, not a run changed.
  if (options.sessionVault !== undefined && vaultOrigin !== null) {
    try {
      const url = runner.page.url();
      if (url.startsWith(vaultOrigin) && !looksLikeSignIn(url)) {
        const state = await runner.exportSession();
        options.sessionVault.put(vaultOrigin, state);
      }
    } catch {
      // The context may already be gone (a run-level error) — nothing to bank.
    }
  }

  const sealed = await runner.close();
  return appendToHistory(sealed, bundle, options, flow.caseContext);
}

/** The origin a flow tests against — its baseUrl, else its first goto. */
function flowOriginOf(flow: Flow): string | null {
  const gotos = [...(flow.setup ?? []), ...flow.steps].filter(
    (step): step is Extract<FlowStep, { action: 'goto' }> => step.action === 'goto',
  );
  for (const candidate of [flow.baseUrl, ...gotos.map((g) => g.url)]) {
    if (candidate === undefined) continue;
    try {
      return new URL(candidate).origin;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * History is diagnostic: a failure to read or append it must never change
 * the verdict of the run it is describing.
 */
async function appendToHistory(
  sealed: ProofBundle,
  bundle: ProofBundleBuilder,
  options: RunFlowOptions,
  caseContext?: string,
): Promise<ProofBundle> {
  // The auto-review judge, before the history write so the ruling is part of
  // the record a recall reads. One small call, only on proved-? runs, only
  // when a judge was built (agent role resolvable, not switched off). A
  // ruling stamps `review` — `effectiveStatus` then reads the run as passed
  // or failed everywhere, both ways at the bar since the gate widened to
  // every wording mismatch — and anything short of the bar leaves the
  // human's queue exactly as it was, with the judge's opinion on `notes`.
  if (sealed.status === 'needs-review' && options.reviewJudge) {
    try {
      const pairs = reviewPairs(sealed);
      if (pairs.length > 0) {
        const judge = options.reviewJudge;
        const judgement = await judge.judge({
          flowName: sealed.name,
          caseContext,
          pairs,
        });
        const ruling = autoReviewRuling(judgement, judge.id);
        if (ruling !== null) {
          sealed.review = ruling;
          sealed.notes = [
            ...(sealed.notes ?? []),
            `auto-review: ruled ${ruling.verdict} by ${judge.id} at confidence ${judgement.confidence.toFixed(2)} — ${judgement.reasoning.split('\n')[0] ?? ''}`,
          ];
        } else {
          sealed.notes = [
            ...(sealed.notes ?? []),
            `auto-review: left for a human — ${judge.id} said ${judgement.satisfied ? 'satisfied' : 'not satisfied'} at confidence ${judgement.confidence.toFixed(2)} (bar ${AUTO_PROVE_CONFIDENCE})`,
          ];
        }
      }
    } catch (error) {
      // A judge fault never changes a verdict — the run stays proved-?.
      sealed.notes = [...(sealed.notes ?? []), `auto-review: could not run — ${describe(error)}`];
    }
  }
  if (options.historyPath === null) return sealed;
  try {
    const history = new RunHistory(options.historyPath ?? undefined);
    const priors = await history.forFlow(sealed.name);
    const trend = analyseTrend(sealed, priors);
    bundle.setTrend(trend);
    await history.append(sealed);
    return { ...sealed, trend };
  } catch {
    return sealed;
  }
}
