/**
 * A flow that proves nothing about its claim — the green that lies.
 *
 * Measured on be100.csv (2026-08-21): 20 of 22 `pass**` cases and 5 of 13
 * plain passes had exactly two assertions — the sign-in proof (`expectHidden`
 * of the submit control) and an `expectUrl` — and nothing about the row's
 * Expected Output (dropdown values, error messages, counts). The mechanism
 * was not the model declining to write the test: it wrote the middle, its
 * steps were dropped on narrowing, the lints refused "no assertion" and the
 * thin workflow claim, and after the budget the weak claim was accepted. A
 * run of that flow passes whether or not the feature exists.
 *
 * This module names the shape so three places can refuse it the same way:
 * the author (a fatal lint — a case that cannot assert its claim is blocked,
 * never handed over green), the suite runner (a flow already on disk is not
 * run, it is recorded as blocked and re-authored on the next resume), and
 * the ledger (`--rerun-vacuous` marks past passes of this shape for re-run).
 *
 * Leaf on purpose — no import of the runner or the author — so all three can
 * share it without a cycle.
 */

import type { FlowStep } from '../engine/runner.js';

/** Every action that makes a claim. Mirrors `ASSERTION_ACTIONS` in the runner, as a string set. */
const ASSERTIONS = new Set([
  'expectStatus',
  'expectJson',
  'expectHeader',
  'expectCalls',
  'expectText',
  'expectVisible',
  'expectHidden',
  'expectEnabled',
  'expectDisabled',
  'expectCount',
  'expectUrl',
  'expectValue',
  'expectAttribute',
  'expectFocused',
  'expectTabOrder',
  'expectScrollable',
  'expectModal',
  'expectDbRow',
  'expectDbDelta',
  'expectDbUnchanged',
  'expectDbCalled',
  'snapshot',
  'fillEach',
  'fillRetry',
]);

/**
 * The sign-in proof's own shape: `expectHidden` of the control the login
 * clicked — Sign in / Log in / Next / Continue / Submit. It says the form
 * went away, which is preparation, not the claim.
 */
const LOGIN_CONTROL = /sign[ -]?in|log[ -]?in|\blogin\b|\bnext\b|\bcontinue\b|\bsubmit\b|เข้าสู่ระบบ/i;

export function isLoginProof(step: FlowStep): boolean {
  return step.action === 'expectHidden' && LOGIN_CONTROL.test(step.selector);
}

function isAssertionStep(step: FlowStep): boolean {
  return ASSERTIONS.has(step.action);
}

/**
 * The assertions that say something about the claim itself: everything that
 * asserts, minus the sign-in proof and `expectUrl` (which says which page is
 * open, not that anything on it is right).
 */
export function substantiveAssertions(steps: readonly FlowStep[]): FlowStep[] {
  const out: FlowStep[] = [];
  for (const step of steps) {
    if (step.action === 'when') {
      out.push(...substantiveAssertions(step.then), ...substantiveAssertions(step.else ?? []));
      continue;
    }
    if (!isAssertionStep(step) || step.action === 'expectUrl' || isLoginProof(step)) continue;
    out.push(step);
  }
  return out;
}

/**
 * Why this step list proves nothing about its claim, or null when it does.
 * A list with no assertion at all is reported too, so one predicate answers
 * both halves for callers that only want the verdict.
 */
export function vacuousClaim(steps: readonly FlowStep[]): string | null {
  const asserting = steps.filter((s) => isAssertionStep(s) || s.action === 'when');
  if (asserting.length === 0) return 'the flow contains no assertion';
  if (substantiveAssertions(steps).length > 0) return null;
  const kinds = [...new Set(steps.filter(isAssertionStep).map((s) => (isLoginProof(s) ? 'the sign-in proof' : s.action)))];
  return `the flow's only assertions are ${kinds.join(' and ')} — neither checks the claim; a run passes whether or not the feature works`;
}

/** Setup + steps, the way a run sees a flow. */
export function vacuousFlow(flow: { setup?: readonly FlowStep[] | undefined; steps: readonly FlowStep[] }): string | null {
  return vacuousClaim([...(flow.setup ?? []), ...flow.steps]);
}
