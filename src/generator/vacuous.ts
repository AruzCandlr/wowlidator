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

/**
 * The sign-in FORM's own controls appearing or becoming interactive — the
 * identity field, the password field, the literal "Sign in"/"Log in" submit
 * button — proof the login page rendered its own inputs, not that anything
 * the case asked about happened.
 *
 * Deliberately narrower than `LOGIN_CONTROL`: that regex's "next" / "continue"
 * / "submit" are legitimate wizard-step button names far past sign-in (a
 * multi-page hire form has its own "Next"), so they are excluded HERE on
 * purpose — only selectors this precise are checked, control-shaped and
 * naming the identity/password field or the sign-in button by exact role.
 * Never matched against `text=`/free-text selectors, so a genuine claim
 * about login VALIDATION — an error message that happens to contain the
 * word "password" — is never caught here; only the control rendering is.
 *
 * Closes the exact shape measured live (HIR-EC-006/HIR-EC-010, 2026-09-02):
 * a case about creating a new hire, re-authored down to `goto /en/login`,
 * fill the email, click Next, `expectVisible input[type="password"]`,
 * `expectVisible role=button[name="Sign in" i]` — three assertions, all of
 * them "the sign-in form is there," none of them about the hire it never
 * attempted. The narrower `isLoginProof` (expectHidden only) let all three
 * count as substantive, so the flow sailed past this module's own lint.
 */
const LOGIN_FORM_CONTROL = /work email|username|sign[ -]?in|log[ -]?in|เข้าสู่ระบบ|อีเมล/i;

function isLoginFormSurface(step: FlowStep): boolean {
  if (step.action !== 'expectVisible' && step.action !== 'expectEnabled' && step.action !== 'expectDisabled') {
    return false;
  }
  const selector = step.selector.trim();
  if (/^input\[type=["']password["']\]/i.test(selector)) return true;
  const role = /^role=(?:textbox|button)\[name=["']([^"']*)["']/i.exec(selector);
  return role !== null && LOGIN_FORM_CONTROL.test(role[1] ?? '');
}

function isAssertionStep(step: FlowStep): boolean {
  return ASSERTIONS.has(step.action);
}

/**
 * The assertions that say something about the claim itself: everything that
 * asserts, minus the sign-in proof, the sign-in form's own controls
 * rendering, and `expectUrl` (which says which page is open, not that
 * anything on it is right).
 */
export function substantiveAssertions(steps: readonly FlowStep[]): FlowStep[] {
  const out: FlowStep[] = [];
  for (const step of steps) {
    if (step.action === 'when') {
      out.push(...substantiveAssertions(step.then), ...substantiveAssertions(step.else ?? []));
      continue;
    }
    if (
      !isAssertionStep(step) ||
      step.action === 'expectUrl' ||
      isLoginProof(step) ||
      isLoginFormSurface(step)
    )
      continue;
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
  const kinds = [
    ...new Set(
      steps
        .filter(isAssertionStep)
        .map((s) => (isLoginProof(s) ? 'the sign-in proof' : isLoginFormSurface(s) ? 'the sign-in form rendering' : s.action)),
    ),
  ];
  return `the flow's only assertions are ${kinds.join(' and ')} — neither checks the claim; a run passes whether or not the feature works`;
}

/** Setup + steps, the way a run sees a flow. */
export function vacuousFlow(flow: { setup?: readonly FlowStep[] | undefined; steps: readonly FlowStep[] }): string | null {
  return vacuousClaim([...(flow.setup ?? []), ...flow.steps]);
}
