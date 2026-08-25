/**
 * Proof bundles: the structured, machine-readable record of a run.
 *
 * Every step records not just pass/fail but *how* its selector resolved —
 * `fast` (execution plane, free), `cache` (a prior repair, free), or `jit`
 * (a control-plane call that cost tokens). That breakdown is what makes the
 * bundle useful to an MCP client deciding whether a suite is drifting.
 */

import { randomUUID } from 'node:crypto';
import type { PolaritySource, TestPolarity } from './polarity.js';

import type { RequestRecord } from '../api/api-client.js';
import type { NetworkCall } from '../api/network-observer.js';
import type { DbCheckRecord } from '../db/db-actions.js';
import type { CoverageReport } from '../coverage/ax-coverage.js';
import type { RunTrend } from '../history/run-history.js';
import type { SnapshotResult } from '../visual/baseline.js';
import type { VideoRecording } from './video.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/**
 * `failed` — an assertion the test made did not hold.
 * `error`  — the step blew up for a reason that is not an assertion (a thrown
 *            exception, a navigation that never landed, bad interpolation).
 * `dead-end` — every rung of the escalation ladder was spent and the selector
 *            still could not be resolved; there is nothing left to try.
 */
export type StepStatus = 'passed' | 'failed' | 'error' | 'dead-end';
export type RunStatus =
  | 'passed'
  | 'passed-with-issues'
  /**
   * proved-? — the claim's SHAPE held and only its wording did not, closely
   * enough that a machine must not rule. Every broken step is a failed
   * assertion whose recorded `actual` is a near-miss of its `expected`
   * ("Create Plan" vs a dialog titled "Create Benefit Plan"), and whether
   * that is a spec violation or an authoring paraphrase is a human call. The
   * run awaits confirmation (`ProofBundle.review`); until it arrives it is
   * NOT a pass anywhere — `isPassing` says no — and not a product failure
   * either.
   */
  | 'needs-review'
  | 'failed'
  | 'error'
  | 'dead-end';

/**
 * Did the run's claims hold?
 *
 * `passed` and `passed-with-issues` both answer yes. The second is the run
 * whose **assertions all held** while one or more of its *actions* did not —
 * a click that dead-ended on a consent gate and was then made redundant by a
 * later step, an agent leg that gave up after the page had already arrived.
 * Measured (BE_Test2.csv, 2026-08-19 18:16): PL_02_03 dead-ended at step 3
 * clicking "Create Plan", then clicked the same control at step 6, passed,
 * and passed both of its assertions — and was reported `dead-end`, with its
 * film cut at step 1. The claim the row makes was proved; the flow's path to
 * it was not clean. Those are two different facts and the verdict now says
 * both.
 *
 * Every consumer that asks "did it pass" — exit code, trend, quarantine,
 * suite index, the panel's filters — asks through this predicate, so the
 * qualified pass is a pass everywhere and an issue everywhere, never one or
 * the other by accident.
 */
/**
 * The actions whose outcome IS a claim — the same set `classifyStepFailure`
 * files as `failed` rather than `error`, restated here because this module
 * cannot import the runner (the runner imports it).
 */
function isAssertionAction(action: string): boolean {
  return (
    action.startsWith('expect') ||
    action === 'snapshot' ||
    action === 'fillEach' ||
    action === 'fillRetry'
  );
}

export function isPassing(status: RunStatus | string): boolean {
  return status === 'passed' || status === 'passed-with-issues';
}

/**
 * The status a consumer should act on: a human ruling on a `needs-review`
 * run outranks the machine's deferral. Everything that displays or scores a
 * bundle should ask this, not `bundle.status`, once reviews exist.
 */
export function effectiveStatus(bundle: {
  status: RunStatus | string;
  review?: { verdict: 'proved' | 'failed'; at?: string | undefined } | undefined;
}): RunStatus | string {
  if (bundle.status === 'needs-review' && bundle.review !== undefined) {
    return bundle.review.verdict === 'proved' ? 'passed' : 'failed';
  }
  return bundle.status;
}

/**
 * Should a failed comparison be JUDGED rather than scored failed on the spot?
 *
 * The history of the threshold is the point of the function. It began as a
 * ≥50%-word-overlap near-miss detector — only comparisons that close reached
 * the review layer, and everything below flat-failed. Broadened 2026-08-24 at
 * the person's request: after the deterministic comparison has read the
 * actual, any mismatch that is not accurate (≥90% / containment territory
 * passes or proves trivially anyway) goes to the agent judge to rule on —
 * the wording call belongs to a reader of both strings, not to a token
 * ratio, and the false failures this suite produced were precisely the
 * mismatches the ratio flat-failed ("Reimbursement by HR" against a page
 * that renders "การเบิกจ่ายโดย HR" scores 0% and was never shown to anything
 * that could read Thai).
 *
 * What still refuses to soften are facts, not wording:
 * - **Purely numeric expectations are never judged**: 119 days against a
 *   promised 120 is the catalog's own documented defect (PB_01_01), and
 *   softening a number is how an instrument teaches people to ignore it.
 * - **A numeric token inside the expectation must appear in the actual** —
 *   "120 days" against "119 days remaining" is a defect about the number,
 *   however well the words overlap.
 * - **Identical strings do not fail** — that is a bug elsewhere, not a
 *   wording call — and an empty side says nothing worth judging.
 */
export function nearMiss(expected: unknown, actual: unknown): boolean {
  const e = typeof expected === 'string' ? expected : JSON.stringify(expected) ?? '';
  const a = typeof actual === 'string' ? actual : JSON.stringify(actual) ?? '';
  if (e === '' || a === '') return false;
  const el = e.toLowerCase().trim();
  const al = a.toLowerCase().trim();
  if (el === al) return false; // identical strings do not fail — this is not a near-miss, it is a bug elsewhere
  const tokens = el.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 0);
  if (tokens.length === 0) return false;
  if (tokens.every((t) => /^\p{N}+$/u.test(t))) return false;
  // A numeric token is exact or nothing: "120 days" against "119 days
  // remaining" is a defect about the number, however well the words overlap.
  const hayAll = ` ${al} `;
  if (tokens.some((t) => /^\p{N}+$/u.test(t) && !hayAll.includes(` ${t} `) && !hayAll.includes(t))) {
    return false;
  }
  // Every other wording mismatch is the judge's to rule on.
  return true;
}

/**
 * Actions that speak HTTP directly instead of driving the page.
 *
 * One definition, two users: `isBrowserFree()` in the runner decides whether a
 * flow needs a browser at all, and the summary uses it to split a run's result
 * into a frontend and a backend half. Two lists would drift, and the drift
 * would be silent — a step counted as UI in one place and API in the other.
 */
export const API_STEP_ACTIONS: ReadonlySet<string> = new Set([
  'request',
  'expectStatus',
  'expectJson',
  'expectHeader',
]);

/** Actions that speak SQL (read-only) instead of driving the page. */
export const DB_STEP_ACTIONS: ReadonlySet<string> = new Set([
  'dbSnapshot',
  'expectDbRow',
  'expectDbDelta',
  'expectDbUnchanged',
  'expectDbCalled',
]);

/**
 * The one flat `API_STEP_ACTIONS` used to do nine jobs at once; these two sets
 * split them along the line that actually divides the new actions.
 *
 * `BROWSER_FREE_ACTIONS` — steps that never touch the page: they need no
 * browser (`isBrowserFree`), interpolate their own fields (`interpolateStep`
 * skips them), and get no screenshot, no video offset and no caption, because
 * nothing about them happened on screen.
 *
 * `BACKEND_TIER_ACTIONS` — steps whose *findings* belong to the backend half
 * of the report: everything browser-free, plus `expectCalls`, which needs the
 * live network observer (so it is emphatically not browser-free — a flow of
 * API steps plus one `expectCalls` dispatched without a browser would have no
 * traffic to assert on) but whose subject is HTTP the page made.
 */
export const BROWSER_FREE_ACTIONS: ReadonlySet<string> = new Set([
  ...API_STEP_ACTIONS,
  ...DB_STEP_ACTIONS,
]);

export const BACKEND_TIER_ACTIONS: ReadonlySet<string> = new Set([
  ...BROWSER_FREE_ACTIONS,
  'expectCalls',
]);

/**
 * How an authored step announces that a backend check would prove it better.
 *
 * A prefix on `intent` rather than a field of its own on every step shape:
 * the authoring schema is one flat object shared by twenty-odd actions, and a
 * marker the model writes into prose it is already writing costs nothing to
 * add and nothing to narrow. It is lifted off the intent when the step is
 * recorded, so the stored intent reads as the author's plain sentence and the
 * hint stands on its own field.
 */
export const BACKEND_HINT_PREFIX = /^\s*backend could prove this:\s*/i;

/** Split an intent into its plain sentence and the backend hint it carries, or null. */
export function backendHintOf(
  intent: string | undefined,
): { intent: string; hint: string } | null {
  if (intent === undefined) return null;
  const match = BACKEND_HINT_PREFIX.exec(intent);
  if (match === null) return null;
  const hint = intent.slice(match[0].length).trim();
  if (hint === '') return null;
  return { intent: hint, hint };
}

/** How a selector was resolved for a step. */
export type ResolutionSource =
  | 'fast'
  | 'case'
  | 'narrow'
  /**
   * The author's selector resolved and only its TEXT missed, and the claim
   * held against its container instead — a label whose value sits beside it.
   * Free and deterministic; see `ancestorSelectors` in `engine/runner.ts`.
   */
  | 'kin'
  /**
   * The agent was asked the assertion's own question — read-only, so it could
   * not act — named the element holding the answer, and the harness re-ran
   * the author's comparison against it. The agent's answer is checked, never
   * believed. See `#agentReread` in `engine/runner.ts`.
   */
  | 'agent-read'
  /**
   * The author's own selector, given one more window at the healed timeout —
   * free, and the last deterministic rung before a model is paid. Exists for
   * content that renders after the fast-path budget (a hydrating detail
   * page): the step passes honestly, and a timing defect still says the page
   * is slower than the budget.
   */
  | 'late'
  | 'cache'
  | 'jit'
  | 'dialog'
  /**
   * The step only resolved after the workflow agent was let loose on the page
   * to make the control reachable — a menu opened, something scrolled into
   * view, a load waited out. The most expensive rung there is, and the only
   * one that *acts* on the application before the step runs.
   */
  | 'agent';

export interface HealRecord {
  /** Selector the healer replaced. */
  from: string;
  /** Selector the healer produced. */
  to: string;
  strategy: string;
  confidence: number;
  reasoning: string;
  model: string;
  /** Wall-clock cost of the control-plane round trip, in ms. */
  latencyMs: number;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
}

/**
 * Record of an unexpected dialog dismissed automatically before a step could
 * proceed. Named `DialogRecord`, not `InterstitialRecord` — "interstitial"
 * already means something else in this codebase (an unknown *page* the
 * workflow agent navigates through, see `orchestrator/workflow-agent.ts`);
 * this is a blocking dialog on the *current* page.
 */
export interface DialogRecord {
  /** Best-effort label for the dialog that was blocking the step. */
  name: string;
  /** Accessible text of the button clicked to dismiss it. */
  button: string;
}

/** Outcome of one attempt inside a data-driven `fillRetry` step. */
export interface DataRetryAttempt {
  attempt: number;
  kind: string;
  value: string;
  /** True once the failure indicator was no longer present after this attempt. */
  succeeded: boolean;
}

/** Record of a `fillRetry` step's regenerate-and-retry loop. */
export interface DataRetryRecord {
  kind: string;
  attempts: DataRetryAttempt[];
  succeeded: boolean;
  /** Set only when the `custom` kind escalated to a model. */
  model?: string | undefined;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
}

/** One action taken by the workflow agent while it held the browser. */
export interface AgentAction {
  index: number;
  action: string;
  selector: string | null;
  value: string | null;
  url: string;
  reasoning: string;
  ok: boolean;
  error?: string | undefined;
  durationMs: number;
}

/**
 * What the agent judged, chose, and did when a step met something the flow
 * does not describe.
 *
 * The rung above this one (`modal.ts`) is deliberately ARIA-only, and the
 * overlay rung needs Playwright to name a pointer-interception. Neither can
 * see the shape that actually stopped a run: PB_01_01 against localhost:3000
 * met a full-page PDPA consent screen — "Accept and continue" — that is
 * neither a `role="dialog"` nor an interceptor. In that run the click only
 * existed because a person had written it into the flow; with nobody
 * anticipating it the run dies on "could not resolve" and files defects about
 * a feature it never reached.
 *
 * So the agent is asked to look and choose, and what it chose is kept here.
 * The separation is the point: `observed`/`decided`/`because` are the agent's
 * own words — claims — while `actions` are what it actually did and
 * `resolved` is whether the author's own selector then worked. Only the last
 * of those is evidence, and the report must never present the first three as
 * anything else.
 */
export interface StepDecision {
  /** What the agent judged was in the way, in its own words. Empty when it saw nothing. */
  observed: string;
  /** What it chose to do — including choosing to do nothing. */
  decided: string;
  /** Its stated reason. */
  because: string;
  /** What it actually did. Claims are not evidence; these are the acts. */
  actions: AgentAction[];
  /** Whether the author's own selector resolved afterwards. THE evidence. */
  resolved: boolean;
  model: string;
}

/** Record of a multi-page navigation the agent completed on the runner's behalf. */
export interface AgentRecord {
  goal: string;
  model: string;
  success: boolean;
  summary: string;
  actions: AgentAction[];
  /** Model turns consumed out of the step budget. */
  turns: number;
  /** The configured turn ceiling, or null when the run was unbounded and the
   *  loop's own logic (arrival, stall, no-progress) was the only judge. */
  maxSteps: number | null;
  latencyMs: number;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
}

export type DefectSeverity = 'high' | 'medium' | 'low';
/**
 * `backend` is deliberately its own category rather than a flavour of
 * `functional`: it routes to a different team and calls for a different fix.
 * A functional defect says the test and the app disagree; a backend defect
 * says a request the page made did not succeed, which no amount of selector
 * work will repair.
 */
export type DefectCategory =
  | 'functional'
  | 'usability'
  | 'accessibility'
  | 'backend'
  /**
   * The page answered with an authorization failure — an Access Denied
   * surface, a 401/403 document. Its own category for the same reason
   * `backend` is: it routes to a different conversation (who is signed in,
   * what may they see) and no amount of selector work will fix it.
   */
  | 'authorization';

/** A usability or functional problem, from static analysis or from a failing step. */
export interface Defect {
  id: string;
  severity: DefectSeverity;
  category: DefectCategory;
  title: string;
  detail: string;
  /** Where the model or runner says the problem lives. */
  selector?: string | undefined;
  /** Index of the step that surfaced it, when it came from a run. */
  stepIndex?: number | undefined;
  source: 'generator' | 'runtime';
  /**
   * How many identical findings this one stands for. Repeated identical
   * failures (same title, selector, category, source) cluster into one defect
   * at recording time — eleven copies of "Step failed: fill role=textbox"
   * read as eleven problems when they are one problem hit eleven times.
   * Absent means 1.
   */
  occurrences?: number | undefined;
  /** Every step that surfaced this defect, when it clustered. First one is `stepIndex`. */
  stepIndexes?: number[] | undefined;
}

export interface ProofStep {
  index: number;
  action: string;
  /** The author's plain-language description of this step, verbatim from `FlowStep.intent`. */
  intent?: string | undefined;
  /**
   * What a backend check would have proved about this step, when the run's
   * backend toggle was off and the claim deserved one.
   *
   * The author writes it as an `intent` beginning `backend could prove this:`
   * (see `BACKEND_HINT_PREFIX`), and it is lifted here — at the one recording
   * choke point, so every action carries it the same way. Never a defect and
   * never a verdict: the visual check really did pass, and this says a
   * stronger proof exists that this run chose not to take.
   */
  backendHint?: string | undefined;
  /**
   * Set when this step is the reason a run is `needs-review`: the assertion
   * failed on a near-miss of wording, and this is the proof of the unsure
   * part — expected vs actual, in one line, for the human who must rule.
   */
  unsure?: string | undefined;
  selector: string | null;
  /** The selector that actually resolved — differs from `selector` when healed. */
  resolvedSelector: string | null;
  resolution: ResolutionSource | null;
  status: StepStatus;
  startedAt: string;
  durationMs: number;
  url: string | null;
  detail?: Record<string, unknown> | undefined;
  heal?: HealRecord | undefined;
  /** Populated when an unexpected dialog was dismissed before this step could retry. */
  dialog?: DialogRecord | undefined;
  agent?: AgentRecord | undefined;
  /**
   * What the agent decided when this step met an interaction the flow does not
   * describe — recorded whether it acted, acted in vain, or declined. A
   * decision not to act is exactly the fact a later reader needs; dropping it
   * makes "the agent was consulted and saw nothing" indistinguishable from
   * "the agent was never tried".
   */
  decision?: StepDecision | undefined;
  /** Visual-regression result, when this step was a `snapshot`. */
  snapshot?: SnapshotResult | undefined;
  /** Per-value outcomes, when this step was a data-driven `fillEach`. */
  dataCases?: DataCaseResult[] | undefined;
  /** Populated when this step was a data-driven `fillRetry`. */
  dataRetry?: DataRetryRecord | undefined;
  /**
   * HTTP calls the page made while this step was running.
   *
   * Only attached when they are actually evidence — the step failed, or one of
   * the calls failed — because a busy SPA issues dozens per interaction and
   * recording them all would bury the report in noise it cannot act on.
   */
  network?: NetworkCall[] | undefined;
  /**
   * The call this step made, when it was a `request` step.
   *
   * Distinct from `network` on purpose: that is traffic the *page* generated
   * and wowlidator merely watched, this is a call the *test* made deliberately.
   */
  request?: RequestRecord | undefined;
  /**
   * The database check this step made, when it was a DB step. Singular, like
   * `request`: the check the *test* performed, redacted before it got here.
   */
  db?: DbCheckRecord | undefined;
  /**
   * Base64 JPEG, embedded directly into the HTML report.
   *
   * With video recording on this is a *failure* still only: the run is already
   * on film, so a frame per step would be the same evidence twice at several
   * times the size. What a still adds over a frame is resolution — a failure
   * is the one thing someone zooms into to read an error message or check a
   * border — so that is the one place it is still captured.
   */
  screenshot?: string | undefined;
  /**
   * Where this step begins in the run's recording, in ms from the first frame.
   *
   * This is what makes one video per-step evidence rather than a single long
   * clip nobody scrubs: the report seeks to it. Absent when nothing was
   * recorded, and absent for a step that never touched the page.
   */
  videoOffsetMs?: number | undefined;
  error?: string | undefined;
  /**
   * What the page was showing when this step failed — up to a few
   * heading/landmark lines from the AX tree that was already captured for the
   * heal attempt. This is how "the page said Access Denied" becomes
   * first-class evidence instead of a substring of a rejected repair. Failed
   * steps only; never a fresh capture.
   */
  pageContext?: string[] | undefined;
  /**
   * Repair candidates the healer proposed and the run refused, with why.
   * A rejected proposal is what the model *saw on the page* — frequently the
   * diagnosis itself — so it is kept as data, not just as a trace substring.
   */
  rejectedHeals?: RejectedHeal[] | undefined;
  /**
   * Set when this step failed after an earlier step in the run had already
   * failed: its failure may be a consequence, not an independent finding.
   */
  downstream?: boolean | undefined;
  /**
   * This failure was followed by a successful in-run reconstruction of the
   * same step, so it is an *attempt*, not the step's outcome. Superseded
   * steps stay listed — the report shows what was tried — but count toward
   * nothing: not the pass/fail tallies, not the run status, not the trend's
   * failure signatures.
   */
  superseded?: boolean | undefined;
  /** Set on a step that ran as an in-run reconstruction of a failed one. */
  reconstruction?: ReconstructionRecord | undefined;
}

/** What an in-run reconstruction did to a failed step, kept as evidence. */
export interface ReconstructionRecord {
  /** Which try finally held (1 = the original, so this is ≥ 2). */
  attempt: number;
  /** The step as the flow wrote it, JSON-encoded. */
  from: string;
  /** The step as reconstructed, JSON-encoded. Equal to `from` for an assertion. */
  to: string;
  /** Steps inserted before the retry (dismissals, waits, missed preconditions). */
  inserted: number;
  reasoning: string;
  model: string;
}

/** A repair candidate the run refused, kept because it is evidence. */
export interface RejectedHeal {
  proposed: string;
  confidence: number;
  reasoning: string;
  rejectedBecause: string;
}

/** Outcome of one value in a data-driven step. */
export interface DataCaseResult {
  label: string;
  value: string;
  ok: boolean;
  error?: string | undefined;
}

/**
 * One side of a run's result — the UI half or the HTTP half.
 *
 * Separated because a mixed flow's headline pass/fail cannot answer the
 * question anyone actually asks when it goes red: *which side is broken?* A
 * failed `expectVisible` and a failed `expectStatus` route to different people,
 * and rolling them into one number hides that. `frontend.defects +
 * backend.defects` always equals `defects`.
 */
export interface TierSummary {
  /** Steps belonging to this side. */
  steps: number;
  passed: number;
  failed: number;
  /** Defects attributed to this side — `backend` category, or everything else. */
  defects: number;
}

export interface ProofSummary {
  totalSteps: number;
  passed: number;
  failed: number;
  /** Steps that drove the page. */
  frontend: TierSummary;
  /**
   * Steps that called the API directly (`request`/`expectStatus`/…).
   *
   * Deliberately *not* the same thing as the `network*` counters: those are
   * traffic the page made on its own, observed passively. This is HTTP the
   * test itself performed and asserted on.
   */
  backend: TierSummary;
  fastPath: number;
  /**
   * Steps that only resolved once the accessible name was matched
   * case-insensitively — free and deterministic, but it means the flow's
   * selector and the page disagree about case. See `src/engine/selector.ts`.
   */
  caseRetries: number;
  cacheHits: number;
  jitHeals: number;
  /** Steps that only succeeded after an unexpected dialog was dismissed. */
  dialogsDismissed: number;
  /** Steps handed to the multi-page workflow agent. */
  agentTakeovers: number;
  /** Visual snapshots compared, and how many drifted. */
  visualChecks: number;
  visualFailures: number;
  /** `fillRetry` steps that needed more than one attempt. */
  dataRetries: number;
  /** `request` steps the test itself made. */
  apiRequests: number;
  /** Of those, ones that never got a response (transport failure). */
  apiFailures: number;
  /** Database checks the test itself made (snapshots included). */
  dbChecks: number;
  /** Of those, ones that did not pass. */
  dbFailures: number;
  /** HTTP calls the page made, as observed over CDP. */
  networkCalls: number;
  /** Of those, ones that failed hard enough to explain a broken step. */
  networkFailures: number;
  /** Steps that suppressed a JIT heal because a request had already failed. */
  backendBlocked: number;
  /**
   * Heal attempts that never got an answer because the *provider* failed —
   * rate limit, transport, unparseable response. Counted apart from
   * `jitHeals` because a rung the machinery could not climb says nothing
   * about the page, and conflating the two blames the app for an outage.
   */
  healUnavailable: number;
  /**
   * Calls that fell out of the observer's ring buffer. Reported rather than
   * swallowed — a truncated capture reads exactly like a quiet page otherwise.
   */
  networkDropped: number;
  /** Total ms spent inside control-plane calls (healer + agent). */
  healLatencyMs: number;
  agentLatencyMs: number;
  inputTokens: number;
  outputTokens: number;
  defects: number;
}

/** Where a flow came from, when it wasn't hand-written. */
export interface GenerationProvenance {
  model: string;
  /**
   * When the authoring pass that produced this case ran.
   *
   * Identical across every case of one pass and different for the next one,
   * which is what makes it the identity of a *batch*: running the same catalog
   * twice produces two values, so the two runs of a case never collapse into
   * one group. wowUI groups the run list on exactly this.
   */
  generatedAt: string;
  sourceUrl: string;
  kind: string;
  rationale: string;
  /**
   * The sheet's own recorded outcome for this case (`Actual Result`,
   * normalised): what a person found when they last ran it by hand. This is
   * the ground truth wowUI's accuracy compares a run's verdict against —
   * Positive/Negative says what the case means to prove, only this says how
   * the application actually behaved. Absent when the sheet recorded nothing
   * (blank, Cancelled, Pending) or the source was not a test-case table.
   */
  knownResult?: 'passed' | 'failed' | undefined;
  /**
   * The document this was authored from — a catalog's file name.
   *
   * `sourceUrl` is the *page* the flow was grounded against, which for a
   * catalog run is the same login screen for every case of every catalog, so
   * it cannot name what a reader is actually looking at. Absent for anything
   * not authored from a document.
   */
  source?: string | undefined;
  /**
   * The sheet's scenario this case belongs to (`<scenarioId> <title>`), and
   * the row's own test-case title. Per case, not per pass — wowUI groups a
   * catalog's cases by scenario and shows the title beside the case id.
   * Absent for anything not authored from a test-case table.
   */
  scenario?: string | undefined;
  caseTitle?: string | undefined;
  /**
   * The catalog run's unique key: `<catalog name, slugged>@<generatedAt>`,
   * minted when the run is initialised and reused verbatim by every resume of
   * it (the ledger stores it; `cmdCatalog` reads it back). It is the pass
   * identity made legible — the stamp above stays the grouping key, since
   * bundles written before this field existed carry only the stamp, and the
   * key embeds it, so the two group identically. Absent for anything not run
   * as a catalog.
   */
  runKey?: string | undefined;
}

export interface ProofBundle {
  /**
   * Marked known-flaky by `--quarantine-flaky`: the result is reported in full
   * but must not be counted as a failure by anything downstream. Absent means
   * "not quarantined" — silence about flakiness is the failure mode
   * `src/history/` exists to prevent, so this is never set automatically.
   */
  quarantined?: boolean | undefined;
  runId: string;
  name: string;
  /**
   * The name the run was recorded under, when a person renamed it in wowUI.
   * Kept so anything keyed on the original — the flow file lookup, history
   * lines written before the rename — can still be matched; set once, on the
   * first rename, and never overwritten by later renames.
   */
  renamedFrom?: string | undefined;
  status: RunStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  cdpUrl: string | null;
  cachePath: string | null;
  healerModel: string | null;
  summary: ProofSummary;
  steps: ProofStep[];
  defects: Defect[];
  /**
   * The run on film, when recording was on.
   *
   * One recording per run rather than one per step, because that is what the
   * browser produces and because the interesting thing about a video is
   * precisely the part between two steps. `ProofStep.videoOffsetMs` is how a
   * step addresses its own moment in it.
   */
  video?: VideoRecording | undefined;
  /** UI coverage measured against the AX tree at the end of the run. */
  coverage?: CoverageReport | undefined;
  /** How this run compares to previous runs of the same flow. */
  trend?: RunTrend | undefined;
  /**
   * Variables the run saved, masked by name before they got here — see
   * `VariableStore.snapshotForReport`. A DB check keyed on `{{orderId}}` is
   * only auditable if the report can say what `orderId` was.
   */
  variables?: Record<string, string> | undefined;
  /**
   * Decisions the harness took about THIS run that a reader should know and
   * that are not findings — "started from an empty session because the flow
   * signs in itself". One line each, plain words.
   */
  notes?: string[] | undefined;
  generatedBy?: GenerationProvenance | undefined;
  /**
   * Whether this test MEANS to prove acceptance or refusal. A negative test's
   * green run says "the application refused it, as required" — read without
   * this label, the same green says the opposite. `polaritySource` says
   * whether the catalog stated it or the harness inferred it, because a
   * stated column is the author's word and an inference is only a reading.
   */
  polarity?: TestPolarity | undefined;
  polaritySource?: PolaritySource | undefined;
  /**
   * A human's ruling on a `needs-review` run, written back into the bundle
   * file by the panel (or by hand). `proved` means the near-miss wording is
   * acceptable and the claims count as held; `failed` means it is a real
   * mismatch. The original status is never rewritten — the ruling sits
   * beside it, so what the machine said and what the person decided are both
   * on the record.
   */
  review?:
    | {
        verdict: 'proved' | 'failed';
        at: string;
        /**
         * Who ruled. Absent = a human (wowUI's Confirm buttons). A model
         * ruling (`src/engine/review-judge.ts`) carries its model label here
         * plus its confidence and reasoning — and a human may REPLACE a model
         * ruling in the panel; never the reverse.
         */
        by?: string | undefined;
        confidence?: number | undefined;
        reasoning?: string | undefined;
      }
    | undefined;
  error?: string | undefined;
}

export interface ProofBundleBuilderOptions {
  name: string;
  cdpUrl?: string | null | undefined;
  cachePath?: string | null | undefined;
  healerModel?: string | null | undefined;
  runId?: string | undefined;
  generatedBy?: GenerationProvenance | undefined;
  /** Called synchronously right after each step is recorded — for live progress output. */
  onStep?: ((step: ProofStep) => void) | undefined;
  /** See `ProofBundle.polarity`. Stamped by `runFlow` from the flow or by inference. */
  polarity?: TestPolarity | undefined;
  polaritySource?: PolaritySource | undefined;
}

/** Accumulates steps during a run and seals them into a `ProofBundle`. */
export class ProofBundleBuilder {
  readonly runId: string;
  readonly name: string;
  readonly startedAt: string;

  readonly #startedMs: number;
  readonly #cdpUrl: string | null;
  readonly #cachePath: string | null;
  readonly #healerModel: string | null;
  readonly #generatedBy: GenerationProvenance | undefined;
  readonly #polarity: TestPolarity | undefined;
  readonly #polaritySource: PolaritySource | undefined;
  readonly #steps: ProofStep[] = [];
  readonly #defects: Defect[] = [];
  readonly #onStep: ((step: ProofStep) => void) | undefined;
  #coverage: CoverageReport | undefined;
  #trend: RunTrend | undefined;
  #variables: Record<string, string> | undefined;
  #notes: string[] = [];
  #errorIsTally = false;
  #video: VideoRecording | undefined;
  #videoStartedMs: number | undefined;
  #error: string | undefined;
  #sessionLost = false;
  #network = { calls: 0, failures: 0, dropped: 0 };
  #backendBlocked = 0;
  #healUnavailable = 0;
  #extraInputTokens = 0;
  #extraOutputTokens = 0;
  #hasNonPass = false;

  constructor(options: ProofBundleBuilderOptions) {
    this.runId = options.runId ?? randomUUID();
    this.name = options.name;
    this.startedAt = new Date().toISOString();
    this.#startedMs = Date.now();
    this.#cdpUrl = options.cdpUrl ?? null;
    this.#cachePath = options.cachePath ?? null;
    this.#healerModel = options.healerModel ?? null;
    this.#generatedBy = options.generatedBy;
    this.#polarity = options.polarity;
    this.#polaritySource = options.polarity === undefined ? undefined : options.polaritySource;
    this.#onStep = options.onStep;
  }

  /** Append a completed step. `index` is assigned automatically. */
  addStep(step: Omit<ProofStep, 'index'>): ProofStep {
    const hint = backendHintOf(step.intent);
    const recorded: ProofStep = {
      index: this.#steps.length,
      ...step,
      // Lifted from the intent at the one choke point every action passes
      // through: the alternative is eighteen call sites each remembering to
      // do it, which is the same reasoning as the video offset below.
      ...(hint === null ? {} : { backendHint: hint.hint, intent: hint.intent }),
      // Stamped here rather than at each `addStep` call site: every action in
      // the runner already reports `startedAt`, and there are a dozen and a
      // half of them. One derivation cannot disagree with itself.
      ...this.#videoOffsetFor(step),
    };
    if (recorded.status !== 'passed') {
      // Marked here, at the one choke point, rather than by any caller: a
      // failure after an earlier failure may be a consequence of it, and the
      // report should be able to say so instead of presenting eleven
      // independent findings for one broken precondition.
      if (this.#hasNonPass) recorded.downstream = true;
      this.#hasNonPass = true;
    }
    this.#steps.push(recorded);
    this.#onStep?.(recorded);
    return recorded;
  }

  /**
   * Where a step sits in the recording.
   *
   * Nothing is stamped when recording is off, and nothing is stamped for a
   * step with no page to have been filmed — an HTTP step never appeared on
   * screen, so pointing at a moment in the video would invite someone to look
   * for something that was never there. Same rule that already denies those
   * steps a screenshot.
   */
  #videoOffsetFor(step: Omit<ProofStep, 'index'>): { videoOffsetMs?: number } {
    if (this.#videoStartedMs === undefined) return {};
    if (BROWSER_FREE_ACTIONS.has(step.action)) return {};
    const began = Date.parse(step.startedAt);
    if (Number.isNaN(began)) return {};
    return { videoOffsetMs: Math.max(0, began - this.#videoStartedMs) };
  }

  /**
   * Mark the moment the recording's first frame corresponds to, so steps can
   * be addressed against it. Set once, when the recorded page is created.
   */
  setVideoStart(startedMs: number): void {
    this.#videoStartedMs = startedMs;
  }

  /** Attach the sealed recording. Called after the recording context closes. */
  setVideo(video: VideoRecording): void {
    this.#video = video;
    // The recording may end before the run did — it is deliberately cut at
    // the first failure — so any step whose offset lies at or past the end
    // loses it here. A "play from here" that seeks past the last frame is a
    // dead control pretending to be evidence. Reconciled only for a CUT
    // recording (`endsAtStep` set): an uncut film covers the whole run by
    // construction, and its *measured* duration can undershoot the last
    // step's start — a variable-frame-rate recorder writes no frames while a
    // paced page sits still — so stripping there would delete offsets the
    // film actually answers (a seek past the measured end clamps to the
    // final frame, which is exactly the state that step saw).
    const endMs = video.durationMs;
    if (endMs !== undefined && video.endsAtStep !== undefined) {
      for (const step of this.#steps) {
        if (step.videoOffsetMs !== undefined && step.videoOffsetMs >= endMs) {
          delete step.videoOffsetMs;
        }
      }
    }
  }

  /**
   * Attach a usability or functional finding to the run.
   *
   * Identical *runtime* findings cluster: same title, selector, category and
   * severity fold into one defect with an `occurrences` count and the full
   * list of step indexes. The alternative — eleven separate high-severity
   * defects for one broken login block — reads as eleven problems and buries
   * the two real ones. Generator findings never cluster; each is already a
   * distinct static observation.
   */
  addDefect(defect: Defect): void {
    if (defect.source === 'runtime') {
      const existing = this.#defects.find(
        (d) =>
          d.source === 'runtime' &&
          d.title === defect.title &&
          d.selector === defect.selector &&
          d.category === defect.category &&
          d.severity === defect.severity,
      );
      if (existing) {
        existing.occurrences = (existing.occurrences ?? 1) + 1;
        existing.stepIndexes = [
          ...(existing.stepIndexes ?? (existing.stepIndex !== undefined ? [existing.stepIndex] : [])),
          ...(defect.stepIndex !== undefined ? [defect.stepIndex] : []),
        ];
        return;
      }
    }
    this.#defects.push(defect);
  }

  addDefects(defects: readonly Defect[]): void {
    for (const defect of defects) this.addDefect(defect);
  }

  /**
   * Totals from the network observer, set once at the end of a run.
   *
   * Kept separate from `ProofStep.network` on purpose: the per-step arrays hold
   * only the calls that are evidence for a particular step, so summing them
   * would badly understate what the page actually did.
   */
  setNetworkTotals(totals: { calls: number; failures: number; dropped: number }): void {
    this.#network = { ...totals };
  }

  /** Record that a step declined to heal because a request had already failed. */
  noteBackendBlocked(): void {
    this.#backendBlocked += 1;
  }

  /** Record a heal attempt that died on the provider, not on the page. */
  noteHealUnavailable(): void {
    this.#healUnavailable += 1;
  }

  /**
   * Tokens spent by a model call that leaves no per-step record — an in-run
   * reconstruction ask, including one whose answer was `canFix: false` or was
   * refused. `summary.inputTokens`/`outputTokens` are the run's WHOLE runtime
   * model bill, and before this the reconstruction calls (the generator role,
   * measured as the second-largest sink on be100) simply vanished from it.
   * Heal, agent and data spend still arrives via their own records; this
   * counter is only for calls with nowhere else to land, so nothing is ever
   * counted twice.
   */
  noteModelSpend(inputTokens: number, outputTokens: number): void {
    this.#extraInputTokens += inputTokens;
    this.#extraOutputTokens += outputTokens;
  }

  /**
   * A later reconstruction of these failed attempts passed: mark them
   * superseded and withdraw the defects they filed. The attempts stay in the
   * step list — what was tried is evidence — but a rescued step must not
   * leave the run red, or "retry until it works" would be indistinguishable
   * from "failed" and nobody would let it run.
   */
  supersedeSteps(indexes: readonly number[]): void {
    const set = new Set(indexes);
    for (const step of this.#steps) {
      if (set.has(step.index) && step.status !== 'passed') step.superseded = true;
    }
    for (let i = this.#defects.length - 1; i >= 0; i -= 1) {
      const defect = this.#defects[i]!;
      if (defect.source !== 'runtime') continue;
      const refs = defect.stepIndexes ?? (defect.stepIndex !== undefined ? [defect.stepIndex] : []);
      const kept = refs.filter((r) => !set.has(r));
      if (kept.length === refs.length) continue;
      if (kept.length === 0) {
        this.#defects.splice(i, 1);
      } else {
        defect.stepIndexes = kept;
        defect.stepIndex = kept[0]!;
        defect.occurrences = kept.length > 1 ? kept.length : undefined;
      }
    }
  }

  /** Stamp the last recorded step as the reconstruction that finally held. */
  noteReconstruction(record: ReconstructionRecord): void {
    const last = this.#steps[this.#steps.length - 1];
    if (!last) return;
    last.reconstruction = record;
  }

  /**
   * A selector that dead-ended during the run resolved when re-checked at the
   * end: it was never absent, it was slower than the fast-path budget. The
   * defect it filed is downgraded and says so — the mirror of the timing
   * check that already runs after a successful heal.
   */
  reclassifyTimingDefect(selector: string): boolean {
    const defect = this.#defects.find(
      (d) => d.source === 'runtime' && d.selector === selector && d.severity === 'high',
    );
    if (!defect) return false;
    defect.severity = 'medium';
    defect.detail =
      `TIMING, not absence: this selector resolved when re-checked at the end of the run, ` +
      `so the control renders — slower than the fast-path budget. The step still failed ` +
      `honestly at the time it ran. Original finding: ${defect.detail}`;
    return true;
  }

  /**
   * Record which way the `when` step just added went.
   *
   * Written onto the step rather than counted in the summary: a branch is not
   * a cost or a risk, it is context for the steps that follow it, and a report
   * that says "the role was already HRBP, so the switch was skipped" explains
   * an otherwise puzzling gap in the step list.
   */
  noteBranch(matched: boolean): void {
    const last = this.#steps[this.#steps.length - 1];
    if (!last || last.action !== 'when') return;
    last.detail = { ...(last.detail ?? {}), matched, branch: matched ? 'then' : 'else' };
  }

  setCoverage(coverage: CoverageReport): void {
    this.#coverage = coverage;
  }

  /**
   * Attach the run's saved variables, already masked by name. Set once at
   * seal time; an empty snapshot is left off the bundle entirely so a run
   * that saved nothing does not grow an empty object that reads like data.
   */
  /** One plain sentence about a decision this run took. Never a verdict. */
  note(text: string): void {
    this.#notes.push(text);
  }

  setVariables(snapshot: Record<string, string>): void {
    if (Object.keys(snapshot).length > 0) this.#variables = snapshot;
  }

  setTrend(trend: RunTrend): void {
    this.#trend = trend;
  }

  /** Selectors that actually resolved — the input to coverage measurement. */
  resolvedSelectors(): string[] {
    const touched: string[] = [];
    for (const step of this.#steps) {
      if (step.status !== 'passed') continue;
      if (step.resolvedSelector !== null) touched.push(step.resolvedSelector);
      // `fillEach` clicks its submit control once per case; that control was
      // genuinely exercised even though it is not the step's main selector.
      const submit = step.detail?.['submit'];
      if (typeof submit === 'string' && submit !== '') touched.push(submit);
    }
    return touched;
  }

  /** Record a run-level failure that isn't attributable to a single step. */
  recordRunError(error: unknown): void {
    this.#error = error instanceof Error ? error.message : String(error);
  }

  /**
   * Record the run's "completed with N issue(s)" tally. It lands on the
   * bundle's `error` field like a run error — every reader of that field
   * already expects the tally there — but it is NOT a fatal, and the verdict
   * may still be a qualified pass over it. See `StepIssuesError`.
   */
  recordIssueTally(message: string): void {
    this.#error = message;
    this.#errorIsTally = true;
  }

  /**
   * The session guard fired: this run proved nothing about the application.
   *
   * A flag rather than a defect-title match, because the verdict must not
   * depend on wording. It exists because DB_04_02 finalised **passed, 7/7**
   * while carrying the high defect "the session is not established, so
   * nothing after this point can say anything about the feature under test" —
   * the guard fired on a step whose `SessionLostError` was swallowed on a
   * path that is right to swallow it (teardown's, where the body's outcome is
   * the story), so no step failed and no run error was recorded. Whichever
   * path swallows the throw, the verdict cannot be `passed` afterwards.
   */
  noteSessionLost(): void {
    this.#sessionLost = true;
  }

  /**
   * Refine the last recorded step's non-passed status — the runner records
   * `failed` at the point of failure, and the step executor (which knows
   * *why* it failed) reclassifies it as `error` or `dead-end` right after.
   */
  reclassifyLastStep(status: StepStatus, action?: string): void {
    const last = this.#steps[this.#steps.length - 1];
    if (!last || last.status === 'passed') return;
    // When the caller says which action it just ran, only touch a matching
    // step — a failure thrown before anything was recorded (bad interpolation,
    // say) must not relabel some earlier step's failure.
    if (action !== undefined && last.action !== action) return;
    last.status = status;
  }

  get steps(): readonly ProofStep[] {
    return this.#steps;
  }

  /** Seal the run and compute the summary. */
  finish(): ProofBundle {
    const summary: ProofSummary = {
      totalSteps: this.#steps.length,
      passed: 0,
      failed: 0,
      frontend: { steps: 0, passed: 0, failed: 0, defects: 0 },
      backend: { steps: 0, passed: 0, failed: 0, defects: 0 },
      fastPath: 0,
      caseRetries: 0,
      cacheHits: 0,
      jitHeals: 0,
      dialogsDismissed: 0,
      agentTakeovers: 0,
      visualChecks: 0,
      visualFailures: 0,
      dataRetries: 0,
      apiRequests: 0,
      apiFailures: 0,
      dbChecks: 0,
      dbFailures: 0,
      networkCalls: this.#network.calls,
      networkFailures: this.#network.failures,
      backendBlocked: this.#backendBlocked,
      healUnavailable: this.#healUnavailable,
      networkDropped: this.#network.dropped,
      healLatencyMs: 0,
      agentLatencyMs: 0,
      // Seeded with the recordless spend (reconstruction asks); the step loop
      // below adds every heal/agent/data record's own usage on top.
      inputTokens: this.#extraInputTokens,
      outputTokens: this.#extraOutputTokens,
      defects: this.#defects.length,
    };

    // Attribution, in order of how much the signal is worth:
    //
    // 1. Category `backend` wins outright. It means "no amount of selector
    //    work fixes this", and it is raised for traffic the *page* made — so
    //    it can sit on a `click` step and still belong to the API side.
    // 2. Otherwise the step's own side decides, so a malformed `request` step
    //    counts against the half of the test it lives in rather than leaking
    //    onto the UI's tally.
    // 3. A defect with no step at all (static findings from the generator) is
    //    the UI's, which is the only thing the generator looks at.
    for (const defect of this.#defects) {
      const step = defect.stepIndex === undefined ? undefined : this.#steps[defect.stepIndex];
      const isBackend =
        defect.category === 'backend' ||
        (step !== undefined && BACKEND_TIER_ACTIONS.has(step.action));
      if (isBackend) summary.backend.defects += 1;
      else summary.frontend.defects += 1;
    }

    for (const step of this.#steps) {
      // A superseded attempt is history, not an outcome: its reconstruction
      // passed in its place, so it counts toward nothing. It stays in the
      // step list, which is the transparency half of the bargain.
      if (step.superseded) continue;
      if (step.status === 'passed') summary.passed += 1;
      else summary.failed += 1;

      const tier = BACKEND_TIER_ACTIONS.has(step.action) ? summary.backend : summary.frontend;
      tier.steps += 1;
      if (step.status === 'passed') tier.passed += 1;
      else tier.failed += 1;

      switch (step.resolution) {
        case 'fast':
          summary.fastPath += 1;
          break;
        case 'case':
          summary.caseRetries += 1;
          break;
        case 'cache':
          summary.cacheHits += 1;
          break;
        case 'jit':
          summary.jitHeals += 1;
          break;
        case 'dialog':
          summary.dialogsDismissed += 1;
          break;
        default:
          break;
      }

      if (step.heal) {
        summary.healLatencyMs += step.heal.latencyMs;
        summary.inputTokens += step.heal.inputTokens ?? 0;
        summary.outputTokens += step.heal.outputTokens ?? 0;
      }

      if (step.snapshot) {
        summary.visualChecks += 1;
        if (step.snapshot.outcome === 'changed' || step.snapshot.outcome === 'size-mismatch') {
          summary.visualFailures += 1;
        }
      }

      if (step.dataRetry) {
        if (step.dataRetry.attempts.length > 1) summary.dataRetries += 1;
        summary.inputTokens += step.dataRetry.inputTokens ?? 0;
        summary.outputTokens += step.dataRetry.outputTokens ?? 0;
      }

      if (step.request) {
        summary.apiRequests += 1;
        // A non-2xx is a *result* here, not a failure — `expectStatus` is what
        // turns a status into pass/fail. Only a call that never got a response
        // at all counts as the request itself having failed.
        if (step.request.status === null) summary.apiFailures += 1;
      }

      if (step.db) {
        summary.dbChecks += 1;
        if (step.status !== 'passed') summary.dbFailures += 1;
      }

      if (step.agent) {
        summary.agentTakeovers += 1;
        summary.agentLatencyMs += step.agent.latencyMs;
        summary.inputTokens += step.agent.inputTokens ?? 0;
        summary.outputTokens += step.agent.outputTokens ?? 0;
      }
    }

    // Worst-first: an error outranks a dead end outranks an assertion failure,
    // so the headline says what actually happened, not just "failed".
    let status: RunStatus = 'passed';
    const counted = this.#steps.filter((s) => !s.superseded);
    if (counted.some((s) => s.status === 'error')) status = 'error';
    else if (counted.some((s) => s.status === 'dead-end')) status = 'dead-end';
    else if (summary.failed > 0 || this.#error !== undefined) status = 'failed';
    // **The claims held, the path did not.** When every assertion the run made
    // passed — and it made at least one — and only ACTION steps broke, the
    // row's claim was proved and the verdict says so, qualified. The broken
    // actions stay on the record as issues (their defects are untouched), and
    // the film is kept whole so a reader can see the claim being reached
    // past them. Never applied over a run-level error (a session guard, a
    // dead browser): those say the claims were asserted against the wrong
    // page, which no passing assertion can outrank.
    // An `error` step is excluded outright: it says the HARNESS could not
    // proceed (a variable that never saved, a database it could not reach, a
    // model that would not answer) — a passing assertion after one proves the
    // claim, not that the run did what it said. Only `failed`/`dead-end`
    // actions — a click that missed, a selector that never resolved — are the
    // kind of issue a held claim may be read over.
    if (
      status !== 'passed' &&
      status !== 'error' &&
      (this.#error === undefined || this.#errorIsTally)
    ) {
      const assertions = counted.filter((s) => isAssertionAction(s.action));
      const claimsHeld =
        assertions.length > 0 && assertions.every((s) => s.status === 'passed');
      if (claimsHeld) status = 'passed-with-issues';
    }
    // **proved-? — every broken step is a failed assertion whose actual is a
    // near-miss of its expected.** The page produced the right SHAPE of thing
    // under wording the machine cannot rule on: whether "Create Benefit
    // Plan" satisfies a claim written "Create Plan" is a spec question, and
    // both answers are defensible. The run defers to a human instead of
    // picking one: status `needs-review`, the proof of each unsure part
    // written onto the step (`unsure`), and `ProofBundle.review` is where
    // the ruling lands. Never over an error, a dead end (the control was
    // ABSENT — nothing near about that), or a run-level fatal; a far miss
    // ("Home landing" for "Create Plan") stays failed.
    //
    // ONE dead-end shape qualifies: a step the runner stamped
    // `foundInPageText` — the exact-match instrument (`text="X"`, a role
    // name) resolved nothing, but the runner then read the live page and the
    // asserted text IS in it, inside larger text. "Absent" is disproved by
    // the page's own words, so whether an embedded rendering satisfies an
    // exact claim is the same human wording call as any other near-miss
    // (be100 PL_06_10: `text="Plan ID already exists"` dead-ended while the
    // toast held that exact sentence in a longer message).
    // `expectUrl` never defers: a URL is a mechanical destination, grounded
    // from the link's own href — "expected /orders, got /login" is a routing
    // fact, and inviting a judge to bless a wrong route is exactly the
    // softening the numeric guard refuses for numbers.
    const nearEligible = (s: ProofStep): boolean =>
      s.action !== 'expectUrl' &&
      (s.status === 'failed' ||
        (s.status === 'dead-end' && s.detail?.['foundInPageText'] === true));
    if (
      (status === 'failed' || status === 'dead-end') &&
      (this.#error === undefined || this.#errorIsTally)
    ) {
      const broken = counted.filter((s) => s.status !== 'passed');
      const allNearMisses =
        broken.length > 0 &&
        broken.every(
          (s) =>
            nearEligible(s) &&
            isAssertionAction(s.action) &&
            s.detail?.['expected'] !== undefined &&
            s.detail?.['actual'] !== undefined &&
            nearMiss(s.detail['expected'], s.detail['actual']),
        );
      if (allNearMisses) {
        for (const s of broken) {
          const render = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));
          s.unsure =
            `expected ${JSON.stringify(render(s.detail!['expected']))} but the page holds ` +
            `${JSON.stringify(render(s.detail!['actual']))} — the exact comparison cannot rule ` +
            'whether this satisfies the claim; the judge (or a human in the panel) decides, ' +
            'confirm proved or failed';
        }
        status = 'needs-review';
      }
    }
    // A run whose session guard fired proved nothing, whatever its steps say.
    // `error` and not `failed`: the application was never reached, so this is
    // the harness's own environment fact, not a verdict about the feature.
    if (isPassing(status) && this.#sessionLost) status = 'error';

    return {
      runId: this.runId,
      name: this.name,
      status,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - this.#startedMs,
      cdpUrl: this.#cdpUrl,
      cachePath: this.#cachePath,
      healerModel: this.#healerModel,
      summary,
      steps: this.#steps,
      defects: this.#defects,
      video: this.#video,
      coverage: this.#coverage,
      trend: this.#trend,
      variables: this.#variables,
      ...(this.#notes.length > 0 ? { notes: [...this.#notes] } : {}),
      generatedBy: this.#generatedBy,
      polarity: this.#polarity,
      polaritySource: this.#polaritySource,
      error: this.#error,
    };
  }
}

/**
 * Whether this run's coverage number means anything.
 *
 * The inventory is captured once, at close, of the page the run *ended* on —
 * so for a multi-page journey the denominator is one page's controls while
 * the numerator drew selectors from every page the flow crossed. "1/72 (1%)"
 * on a login → navigate → detail journey is not a low score, it is a
 * category error, and printing it teaches people to ignore the instrument on
 * the runs where it is real: single-page suites, which are what `generate`
 * writes and what drift detection was built for. Measurement still happens
 * and the bundle still carries it (history's coverage trend included); only
 * the display is gated.
 */
export function meaningfulCoverage(bundle: {
  coverage?: { total: number } | undefined;
  steps: readonly { resolvedSelector: string | null; url: string | null }[];
}): boolean {
  if (!bundle.coverage || bundle.coverage.total === 0) return false;
  const pages = new Set<string>();
  for (const step of bundle.steps) {
    if (step.resolvedSelector === null || step.url === null) continue;
    try {
      const url = new URL(step.url);
      pages.add(url.origin + url.pathname);
    } catch {
      pages.add(step.url);
    }
  }
  return pages.size <= 1;
}

/** Write a bundle to `<dir>/<runId>.json` and return the absolute path. */
export async function writeProofBundle(bundle: ProofBundle, dir: string): Promise<string> {
  const target = resolve(dir);
  await mkdir(target, { recursive: true });
  const file = join(target, `${bundle.runId}.json`);
  await writeFile(file, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
  return file;
}

/**
 * One line per step, for live progress output as a run executes — as opposed
 * to `formatProofSummary`, which only exists once the whole bundle is sealed.
 * `intent` (verbatim from `FlowStep.intent`, never regenerated) is the second
 * line when present, same "explain what this step checks" reasoning as the
 * HTML report's `.step-intent`.
 */
export function formatStepLine(step: ProofStep): string {
  const mark = step.status === 'passed' ? '✓' : '✗';
  const target = step.resolvedSelector ?? step.selector;
  const tag = step.resolution && step.resolution !== 'fast' ? `${step.resolution}, ` : '';
  const kind = step.status === 'error' ? ' ERROR' : step.status === 'dead-end' ? ' DEAD END' : '';
  const lines = [
    `${mark} [${step.index}] ${step.action}${target ? ` ${target}` : ''}${kind} (${tag}${step.durationMs}ms)`,
  ];
  if (step.intent) lines.push(`      ${step.intent}`);
  const comparison = expectedActual(step);
  if (comparison) lines.push(`      ${comparison}`);
  if (step.status !== 'passed' && step.error) lines.push(`      ${step.error.split('\n')[0]}`);
  return lines.join('\n');
}

/**
 * The "expected X, actual Y" line, when the step recorded both. Assertions
 * write these into `detail` on every outcome — a pass shows what the page
 * really held, not just that a check went green.
 */
export function expectedActual(step: ProofStep): string | null {
  const detail = step.detail;
  if (!detail || detail['expected'] === undefined) return null;
  const render = (v: unknown): string =>
    typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v) ?? String(v);
  const expected = render(detail['expected']);
  const actual = 'actual' in detail ? render(detail['actual']) : null;
  return actual === null ? `expected ${expected}` : `expected ${expected} · actual ${actual}`;
}

/** One line per completed agent turn, for live progress during a `workflow` step. */
export function formatAgentAction(action: AgentAction): string {
  const mark = action.ok ? '✓' : '✗';
  const target = action.selector ?? action.url ?? action.value ?? '';
  const lines = [
    `  ${mark} agent: ${action.action}${target ? ` ${target}` : ''} (${action.durationMs}ms)`,
  ];
  if (action.reasoning) lines.push(`        ${action.reasoning}`);
  return lines.join('\n');
}

/**
 * The frontend/backend split, but only when there is a split to report.
 *
 * A flow that never touches HTTP directly is already fully described by the
 * `steps` line above — printing `backend 0/0` on every UI run would be noise
 * pretending to be information.
 */
function tierLines(summary: ProofSummary): string[] {
  const { frontend, backend } = summary;
  if (backend.steps === 0 && backend.defects === 0) return [];
  const describe = (tier: TierSummary): string => {
    const defects = tier.defects > 0 ? `, ${tier.defects} defect(s)` : '';
    return `${tier.passed}/${tier.steps} passed${defects}`;
  };
  return [
    `  frontend   ${describe(frontend)}`,
    `  backend    ${describe(backend)}`,
  ];
}

/** Short human-readable digest, used by the CLI. */
/**
 * How a status is printed. `passed-with-issues` prints as `PASS**`: it IS a
 * pass — every claim held and nothing about validation changes — and the
 * asterisks point at the step(s) that only acted and broke on the way, which
 * `issueSteps` names. One spelling for the CLI, the report and the panel.
 */
function statusLabel(status: ProofBundle['status']): string {
  return status === 'passed-with-issues' ? 'PASS**' : status.toUpperCase();
}

/** The broken action steps behind a `PASS**`, one line each. */
export function issueSteps(bundle: ProofBundle): string[] {
  return bundle.steps
    .filter((s) => !s.superseded && s.status !== 'passed')
    .map(
      (s) =>
        `step ${s.index} ${s.action}${s.selector ? ` ${s.selector}` : ''}` +
        (s.error ? ` — ${s.error.split('\n')[0]}` : ''),
    );
}

export function formatProofSummary(bundle: ProofBundle): string {
  const { summary } = bundle;
  const lines = [
    `${statusLabel(bundle.status)} ${bundle.name} (${bundle.durationMs}ms)`,
    ...(bundle.status === 'passed-with-issues'
      ? issueSteps(bundle).map((line) => `  ** issue   ${line} (does not affect the verdict)`)
      : []),
    `  steps      ${summary.passed}/${summary.totalSteps} passed`,
    ...tierLines(summary),
    `  resolution fast=${summary.fastPath} case=${summary.caseRetries} cache=${summary.cacheHits} jit=${summary.jitHeals} dialog=${summary.dialogsDismissed} agent=${summary.agentTakeovers}`,
    `  control    heal ${summary.healLatencyMs}ms + agent ${summary.agentLatencyMs}ms, ${summary.inputTokens} in / ${summary.outputTokens} out tokens`,
  ];
  if (summary.visualChecks > 0) {
    lines.push(
      `  visual     ${summary.visualChecks} snapshot(s), ${summary.visualFailures} drifted`,
    );
  }
  if (summary.dataRetries > 0) {
    lines.push(`  data       ${summary.dataRetries} fillRetry step(s) needed regeneration`);
  }
  if (summary.apiRequests > 0) {
    lines.push(
      `  api        ${summary.apiRequests} request(s), ${summary.apiFailures} with no response`,
    );
  }
  if (summary.dbChecks > 0) {
    lines.push(`  db         ${summary.dbChecks} check(s), ${summary.dbFailures} failed`);
  }
  if (bundle.variables && Object.keys(bundle.variables).length > 0) {
    // Names only on the one-line digest; the masked values are in the bundle.
    lines.push(`  variables  ${Object.keys(bundle.variables).join(', ')}`);
  }
  if (summary.networkCalls > 0) {
    const dropped = summary.networkDropped > 0 ? `, ${summary.networkDropped} not captured` : '';
    const blocked =
      summary.backendBlocked > 0 ? `, ${summary.backendBlocked} step(s) not healed` : '';
    lines.push(
      `  network    ${summary.networkCalls} call(s), ${summary.networkFailures} failed${blocked}${dropped}`,
    );
  }
  if (summary.defects > 0) {
    const high = bundle.defects.filter((d) => d.severity === 'high').length;
    lines.push(`  defects    ${summary.defects} (${high} high)`);
  }
  lines.push(`  runId      ${bundle.runId}`);
  return lines.join('\n');
}
