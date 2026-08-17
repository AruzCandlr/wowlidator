/**
 * Proof bundles: the structured, machine-readable record of a run.
 *
 * Every step records not just pass/fail but *how* its selector resolved —
 * `fast` (execution plane, free), `cache` (a prior repair, free), or `jit`
 * (a control-plane call that cost tokens). That breakdown is what makes the
 * bundle useful to an MCP client deciding whether a suite is drifting.
 */

import { randomUUID } from 'node:crypto';

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
export type RunStatus = 'passed' | 'failed' | 'error' | 'dead-end';

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

/** How a selector was resolved for a step. */
export type ResolutionSource =
  | 'fast'
  | 'case'
  | 'narrow'
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

/** Record of a multi-page navigation the agent completed on the runner's behalf. */
export interface AgentRecord {
  goal: string;
  model: string;
  success: boolean;
  summary: string;
  actions: AgentAction[];
  /** Model turns consumed out of the step budget. */
  turns: number;
  maxSteps: number;
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
  generatedAt: string;
  sourceUrl: string;
  kind: string;
  rationale: string;
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
  generatedBy?: GenerationProvenance | undefined;
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
  readonly #steps: ProofStep[] = [];
  readonly #defects: Defect[] = [];
  readonly #onStep: ((step: ProofStep) => void) | undefined;
  #coverage: CoverageReport | undefined;
  #trend: RunTrend | undefined;
  #variables: Record<string, string> | undefined;
  #video: VideoRecording | undefined;
  #videoStartedMs: number | undefined;
  #error: string | undefined;
  #network = { calls: 0, failures: 0, dropped: 0 };
  #backendBlocked = 0;
  #healUnavailable = 0;
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
    this.#onStep = options.onStep;
  }

  /** Append a completed step. `index` is assigned automatically. */
  addStep(step: Omit<ProofStep, 'index'>): ProofStep {
    const recorded: ProofStep = {
      index: this.#steps.length,
      ...step,
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
      inputTokens: 0,
      outputTokens: 0,
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
      generatedBy: this.#generatedBy,
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
  if (step.status !== 'passed' && step.error) lines.push(`      ${step.error.split('\n')[0]}`);
  return lines.join('\n');
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
export function formatProofSummary(bundle: ProofBundle): string {
  const { summary } = bundle;
  const lines = [
    `${bundle.status.toUpperCase()} ${bundle.name} (${bundle.durationMs}ms)`,
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
