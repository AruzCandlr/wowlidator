/**
 * The paragraph a report should open with.
 *
 * ## Why this is its own module
 *
 * A proof bundle answers "what did the machinery do". A reader arriving at a
 * red run needs three different answers, in this order: **what broke**, **which
 * side is at fault**, and **is this new**. All three are already in the bundle
 * — spread across the step list, the summary's frontend/backend split, the
 * defect categories, the network capture and the trend block — and reassembling
 * them is work every reader currently does by hand, badly.
 *
 * Everything here is a pure function of the bundle, so the wording can be
 * tested like any other output, and every sentence traces to recorded evidence.
 * Nothing is inferred beyond what the run actually observed: where the evidence
 * is correlational (network attribution), the copy says so, in the same words
 * `src/api/` uses — "while this step was waiting", never "because of".
 */

import type { ProofBundle, ProofStep } from '../engine/proof-bundle.js';

/** Which team a failure most likely belongs to. */
export type Owner = 'frontend' | 'backend' | 'mixed';

export interface Verdict {
  status: 'passed' | 'failed' | 'error' | 'dead-end';
  /** One line: outcome, flow name. */
  headline: string;
  /** What broke, in the author's own words where they gave any. */
  what: string;
  /** Which side, and the evidence for saying so. Null when nothing failed. */
  side: string | null;
  /** Whether this is new, from run history. Null when there is no history. */
  history: string | null;
  owner: Owner | null;
  firstFailingStep: number | null;
}

/**
 * Wording lives in one map so it is greppable, reviewable and swappable —
 * including by teams who want it in another language. Functions rather than
 * templates because several need a count or a name.
 */
export const VERDICT_COPY = {
  passedHeadline: (name: string) => `PASSED — ${name}`,
  failedHeadline: (name: string) => `FAILED — ${name}`,
  errorHeadline: (name: string) => `ERROR — ${name} (the run hit errors; this is not an assertion failure)`,
  deadEndHeadline: (name: string) => `DEAD END — ${name} (a control could not be found by any means; nothing left to try)`,
  passedAll: (steps: number) =>
    `All ${steps} step${steps === 1 ? '' : 's'} did what the test said they should.`,
  runError: 'The run could not complete. Nothing below was verified.',
  noSteps: 'No steps ran, so nothing was checked.',

  // What broke — chosen by the shape of the failure, not by guesswork.
  couldNotFind: (what: string) => `${what} — the control it needed was never found.`,
  assertionFailed: (what: string) => `${what} — the check did not hold.`,
  backendAnswered: (what: string) => `${what} — the endpoint did not answer as expected.`,
  stepFailed: (what: string) => `${what} — this step failed.`,

  // Which side.
  frontendSide: (calls: number) =>
    calls > 0
      ? `This looks like a FRONTEND problem (the page or its selectors): all ${calls} network call${calls === 1 ? '' : 's'} during the run succeeded.`
      : 'This looks like a FRONTEND problem (the page or its selectors); no backend traffic was involved.',
  backendSide: (failures: number) =>
    // The closing clause belongs in both branches: whichever way the backend
    // failure surfaced, the actionable point is that the test is not at fault.
    failures > 0
      ? `This is a BACKEND problem: ${failures} request${failures === 1 ? '' : 's'} failed while the test was waiting. No amount of selector work will fix it.`
      : 'This is a BACKEND problem: an HTTP step the test made did not answer as expected. No amount of selector work will fix it.',
  mixedSide: 'Both sides failed in this run — treat the backend failures first, they may explain the rest.',

  // History.
  firstRun: 'First recorded run of this test — there is nothing to compare it against yet.',
  newlyBroken: 'This test was passing until this run.',
  stillBroken: (runs: number) => `This test has now failed ${runs} run${runs === 1 ? '' : 's'} in a row.`,
  newlyFixed: 'This test was failing and now passes.',
  stable: 'Consistent with recent runs.',
  flaky: 'This test alternates between passing and failing — treat the result as untrustworthy either way.',
} as const;

/** Actions whose failure is an assertion not holding, rather than a lost control. */
const ASSERTION_PREFIX = /^expect/;

/** Describe a step the way its author would: their intent, else what it did. */
export function describeStep(step: ProofStep): string {
  if (step.intent) return `"${step.intent.replace(/\s+$/, '')}"`;
  const target = step.selector ?? step.resolvedSelector;
  return target ? `Step ${step.index} (${step.action} ${target})` : `Step ${step.index} (${step.action})`;
}

function whatBroke(step: ProofStep): string {
  const described = describeStep(step);
  const error = step.error ?? '';
  const base = /could not resolve|did not resolve|Timeout .* exceeded/i.test(error)
    ? VERDICT_COPY.couldNotFind(described)
    : /expected status|expected .* to (contain|be)|did not match/i.test(error)
      ? VERDICT_COPY.backendAnswered(described)
      : ASSERTION_PREFIX.test(step.action)
        ? VERDICT_COPY.assertionFailed(described)
        : VERDICT_COPY.stepFailed(described);
  // What the page was showing outranks how the machinery failed to find
  // things on it — "the page said Access Denied" is the diagnosis, "could not
  // resolve" is a symptom. Quoted verbatim: evidence, never paraphrase.
  const showing = step.pageContext?.[0];
  return showing ? `The page was showing "${showing}" at the moment of failure. ${base}` : base;
}

const HISTORY_COPY: Record<string, (bundle: ProofBundle) => string> = {
  'first-run': () => VERDICT_COPY.firstRun,
  'newly-broken': () => VERDICT_COPY.newlyBroken,
  'still-broken': (bundle) => VERDICT_COPY.stillBroken(bundle.trend?.sampleSize ?? 0),
  'newly-fixed': () => VERDICT_COPY.newlyFixed,
  stable: () => VERDICT_COPY.stable,
  flaky: () => VERDICT_COPY.flaky,
};

/**
 * Decide which side owns a failure.
 *
 * The precedence mirrors `ProofSummary`'s defect attribution, because the two
 * must never disagree: a report cannot say "frontend problem" above a defect
 * table filing it under backend.
 */
export function ownerOf(bundle: ProofBundle): Owner | null {
  const { frontend, backend } = bundle.summary;
  const backendBroke = backend.failed > 0 || backend.defects > 0;
  const frontendBroke = frontend.failed > 0 || frontend.defects > 0;
  if (backendBroke && frontendBroke) return 'mixed';
  if (backendBroke) return 'backend';
  if (frontendBroke) return 'frontend';
  return null;
}

/** Build the opening paragraph. Pure — every sentence comes from the bundle. */
export function buildVerdict(bundle: ProofBundle): Verdict {
  const failing = bundle.steps.find((step) => step.status !== 'passed');
  const owner = ownerOf(bundle);
  const summary = bundle.summary;

  const history = bundle.trend ? (HISTORY_COPY[bundle.trend.verdict]?.(bundle) ?? null) : null;

  if (bundle.status === 'passed') {
    return {
      status: 'passed',
      headline: VERDICT_COPY.passedHeadline(bundle.name),
      what: VERDICT_COPY.passedAll(summary.totalSteps),
      side: null,
      history,
      owner: null,
      firstFailingStep: null,
    };
  }

  const what = failing
    ? whatBroke(failing)
    : bundle.error
      ? VERDICT_COPY.runError
      : VERDICT_COPY.noSteps;

  let side: string | null = null;
  if (owner === 'backend') side = VERDICT_COPY.backendSide(summary.networkFailures);
  else if (owner === 'frontend') side = VERDICT_COPY.frontendSide(summary.networkCalls);
  else if (owner === 'mixed') side = VERDICT_COPY.mixedSide;

  const headline =
    bundle.status === 'error'
      ? VERDICT_COPY.errorHeadline(bundle.name)
      : bundle.status === 'dead-end'
        ? VERDICT_COPY.deadEndHeadline(bundle.name)
        : VERDICT_COPY.failedHeadline(bundle.name);

  return {
    status: bundle.status,
    headline,
    what,
    side,
    history,
    owner,
    firstFailingStep: failing?.index ?? null,
  };
}

/** One rung of an escalation trace, rewritten for a reader. */
export interface TraceRung {
  rung: string;
  /** Plain-language account of what was attempted. */
  prose: string;
  /** The raw message, kept verbatim — evidence, not decoration. */
  detail: string;
}

const RUNG_PROSE: Record<string, string> = {
  fast: 'Tried the selector exactly as the test wrote it',
  case: 'Retried it ignoring letter-case',
  narrow: 'Retried the ambiguous text selector as exact text',
  cache: 'Tried a selector repaired on an earlier run',
  late: 'Gave the content one longer window to render',
  backend: 'Stopped without attempting a repair — a request had already failed',
  authorization: 'Stopped without attempting a repair — the page is an authorization failure',
  known: 'Stopped — this exact selector already dead-ended on this page earlier in the run',
  jit: 'Asked the model for a replacement selector',
};

/**
 * Turn a `StepResolutionError` message into ordered, readable rungs.
 *
 * The raw message is a stack of `- rung "selector": message` lines, which reads
 * as machinery. The reader wants the story: what was tried, in what order, and
 * where it gave up. Unrecognised rungs pass through with their own name rather
 * than being dropped — a new rung must never silently vanish from the account.
 */
export function escalationTrace(error: string | undefined): TraceRung[] {
  if (!error || !error.includes('\n')) return [];
  const rungs: TraceRung[] = [];
  for (const line of error.split('\n')) {
    const match = /^\s*-\s+([a-z]+)\b[^:]*:\s*(.*)$/i.exec(line);
    if (!match) continue;
    const rung = (match[1] ?? '').toLowerCase();
    const detail = (match[2] ?? '').trim();
    const prose = RUNG_PROSE[rung] ?? `Tried the "${rung}" step`;
    // A dialog rung reports itself as `fast (after dismissing "X")`.
    const dismissed = /after dismissing "([^"]*)"/.exec(line);
    rungs.push({
      rung: dismissed ? 'dialog' : rung,
      prose: dismissed ? `Dismissed the "${dismissed[1]}" dialog and retried` : prose,
      detail,
    });
  }
  return rungs;
}
