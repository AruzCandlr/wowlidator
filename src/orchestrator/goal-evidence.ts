/**
 * What the page shows about a workflow goal, as opposed to what the agent says
 * about it.
 *
 * The rule this module exists to enforce is already stated twice in this
 * codebase and was implemented in neither place that needed it here: **what
 * the agent claims is never the evidence.** The ladder's `#agentRescue` obeys
 * it structurally — the agent prepares the page and then the *author's own
 * selector* is retried, so the agent's account of itself decides nothing. The
 * `workflow` action did not: `SmartRunner.workflow()` read `record.success`
 * and stopped there.
 *
 * Measured on a real catalog run (PB_03_01, 2026-08-19): the agent filled a
 * password field four times, clicked Sign in, and kept going — it had already
 * signed in successfully at turn 5 and spent the remaining three turns
 * re-filling a field it could not see the effect of. It then reported "agent
 * gave up after 8 turns without reaching the goal", the step was recorded
 * failed, a `high` functional defect was filed against the application, and
 * the very next step — `expectVisible role=heading[name="Probation Reviews"]`
 * — passed on the fast path in 14ms, from the destination the goal named. The
 * run was reported `error` about an application that had done exactly what was
 * asked of it, and it cost 37 seconds plus a reconstruction model call to
 * arrive there.
 *
 * Every predicate below is deterministic, costs nothing, and is written to
 * **understate**: each one requires an observed *transition*, so none of them
 * can be satisfied by an agent that did nothing at all. That asymmetry is the
 * whole safety argument — the dangerous direction here is calling a genuinely
 * unreached goal reached, so no rule may hold on the starting state alone.
 */

/**
 * Whether a path reads as an authentication page. Presentation only.
 *
 * Lives here rather than in `runner.ts` because both the runner's session
 * guard and the agent's own loop need it, and `runner` imports
 * `workflow-agent` — so the shared predicate cannot sit in either of them
 * without a cycle.
 */
export function looksLikeSignIn(url: string): boolean {
  try {
    return /(^|\/)(login|signin|sign-in|auth|sso)(\/|$)/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** Trailing prose punctuation is not part of a URL someone wrote into a sentence. */
function trimTrailing(token: string): string {
  return token.replace(/[.,;:!?)\]}'"]+$/, '');
}

/**
 * The destination a goal names, as a path.
 *
 * A goal is prose, but the useful half of it is frequently a literal: "…and
 * navigate to probation queue at http://localhost:3000/en/workflows/probation".
 * That path is the one part of a goal a machine can check.
 *
 * The **last** url-shaped token wins, because goals read "do X, then end up at
 * Y" — the destination is where the sentence arrives, not where it departs. A
 * path is returned rather than a whole URL: a flow may be pointed at a
 * different host than the goal was written against, and the path is the part
 * that carries the meaning. A bare `/` is not a destination; it matches every
 * URL there is and would settle every goal for free.
 */
export function goalDestination(goal: string): string | null {
  const absolute: string[] = [];
  for (const match of goal.matchAll(/\bhttps?:\/\/\S+/gi)) {
    try {
      const url = new URL(trimTrailing(match[0]));
      const path = url.pathname;
      if (path.length > 1) absolute.push(path);
    } catch {
      // Not a URL after all — a sentence that merely contains "http".
    }
  }
  if (absolute.length > 0) return absolute[absolute.length - 1]!;

  const paths: string[] = [];
  for (const match of goal.matchAll(/(?:^|[\s"'(])(\/[A-Za-z0-9._~%-]+(?:\/[A-Za-z0-9._~%-]+)*)/g)) {
    const path = trimTrailing(match[1]!);
    if (path.length > 1) paths.push(path);
  }
  return paths.length > 0 ? paths[paths.length - 1]! : null;
}

/**
 * Is this URL at that destination?
 *
 * Containment, deliberately — the same comparison `expectUrl` makes ("expected
 * url to contain"), so a goal and an assertion written from the same words
 * agree about what arriving means. A locale prefix the goal omits (`/en`)
 * therefore does not defeat it.
 */
export function atGoalDestination(url: string, destination: string): boolean {
  try {
    return new URL(url).pathname.includes(destination);
  } catch {
    return url.includes(destination);
  }
}

/**
 * Whether a path reads as a page that stands BETWEEN signing in and the
 * application — a consent gate, a terms acceptance, a second factor. Leaving
 * the sign-in page for one of these is not the sign-in having taken: the
 * application is still not reachable, and a claim judged from here would be
 * judged against the gate. Measured on the application this was written
 * against, whose first sign-in per person lands on /en/consent.
 */
function looksLikeInterstitial(url: string): boolean {
  try {
    return /(^|\/)(consent|pdpa|terms|agreement|mfa|otp|verify|2fa)(\/|$)/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** Does this goal ask the agent to authenticate? */
export function goalMentionsSignIn(goal: string): boolean {
  return /\b(sign[- ]?in|log[- ]?in|password|credential|authenticate)\b/i.test(goal);
}

/** What settled a goal, when something did. */
export interface GoalEvidence {
  /** Which rule held — recorded on the step so a reader can audit the call. */
  rule: 'destination' | 'left-sign-in' | 'verification-deferred';
  /** One line, in the report's voice, saying what the page showed. */
  reason: string;
}

/**
 * Has the page arrived at the destination the goal names?
 *
 * Split out from `goalEvidence` because this is the only rule safe to consult
 * **mid-flight**. It is the end of the goal's own sentence, so reaching it
 * cannot cut the agent off early — whereas "the page left the sign-in screen"
 * is true the moment a consent interstitial appears, which is the middle of a
 * multi-part goal and not the end of one.
 */
export function destinationReached(goal: string, before: string, after: string): boolean {
  const destination = goalDestination(goal);
  return (
    destination !== null &&
    !atGoalDestination(before, destination) &&
    atGoalDestination(after, destination)
  );
}

/**
 * Did the page itself demonstrate that the goal was met?
 *
 * Two rules, both requiring a transition between `before` and `after`, and
 * they are **not** tried in sequence — the first one that *applies* is the
 * only one that decides:
 *
 * 1. **destination** — the goal names a path, the page is on it now, and was
 *    not on it when the step began. Arriving somewhere the goal asked for is
 *    the goal, in the only part of it that is checkable.
 * 2. **left-sign-in** — consulted *only when the goal names no destination*.
 *    The goal asks the agent to authenticate, the step began on a sign-in
 *    page, and it no longer is. An application does not leave its own login
 *    screen for a credential it rejected, so this is the outcome of the
 *    sign-in rather than a guess about it. This is the rule that covers the
 *    common shape, where the goal names where it ends by label ("open Team
 *    Management -> Probation Reviews") and no URL appears in the text at all:
 *    two of the three expensive false failures in the run that prompted this
 *    were exactly that.
 *
 * **A goal that names a destination is judged on that destination and nothing
 * else.** Falling through to the weaker rule when the strong one says *no* is
 * precisely the overstatement this module exists to refuse — live, the agent
 * that ended stranded on `/en/consent` while its goal named
 * `/en/admin/employees/EMP-0005/probation` had indeed left the sign-in page,
 * and calling that a success would have turned the one genuine non-completion
 * in the run into a green step.
 *
 * Returns `null` when nothing was demonstrated, which is not a demonstration
 * of failure: it means this module has nothing to say and the agent's own
 * report stands.
 */
export function goalEvidence(goal: string, before: string, after: string): GoalEvidence | null {
  const destination = goalDestination(goal);
  if (destination !== null) {
    return destinationReached(goal, before, after)
      ? {
          rule: 'destination',
          reason: `the page reached ${destination}, the destination the goal names, having started at ${before}`,
        }
      : null;
  }

  if (
    goalMentionsSignIn(goal) &&
    looksLikeSignIn(before) &&
    !looksLikeSignIn(after) &&
    !looksLikeInterstitial(after)
  ) {
    return {
      rule: 'left-sign-in',
      reason: `the sign-in the goal asked for took: the page left ${before} and ended at ${after}`,
    };
  }

  return null;
}

/**
 * Did the agent fail because the *model* did, rather than because the
 * application did?
 *
 * `WorkflowAgent.run()` never throws — a model that cannot answer is reported
 * in the record like any other outcome — so the only thing distinguishing "the
 * provider is down" from "the feature is broken" is the summary it wrote. Six
 * of eleven non-passing workflow steps in the run that prompted this were the
 * structured-output circuit breaker tripping on the agent role's model; each
 * one filed a `high` functional defect against an application the agent never
 * so much as clicked, and each turned its run's verdict to `error`.
 *
 * Same rule the healer already follows for `HealUnavailableError`: this is a
 * provider fact, not a page fact, and it must never read as "the goal is
 * unreachable".
 */
/**
 * Verbs that ask the agent to CHANGE something. A goal carrying any of them
 * wants work done, and an agent that could not do it failed at something real.
 */
const ACTION_VERB =
  /\b(click|press|open|fill|type|enter|select|choose|submit|save|create|insert|delete|remove|edit|update|change|correct|navigate|go to|search|filter|sort|upload|download|sign in|log in|sign out|accept|apply|toggle|expand|collapse|scroll to)\b/i;
/**
 * Verbs that are actions on a PAGE only when they take a page-shaped object.
 *
 * "add a plan" acts; "add them together" is arithmetic. "confirm the delete"
 * acts; "confirm that the sum equals" is a check. Live (be100 PL_03_01,
 * 2026-08-26): a goal reading "read the numbers … add them together, and
 * confirm that the sum equals the Total Plans number" was classed as an
 * action goal on the single word `add`, so the verification handoff never
 * fired, the agent was asked to be a calculator, and — having nothing on the
 * page it could legitimately click — it scrolled five times and was recorded
 * as a stall. A stronger model does not fix this; it was never the model.
 */
const CONTEXTUAL_ACTION_VERB = /\b(add|confirm)\s+(?:a|an|the|new|this|that\s+\w+)\b(?!\s+(?:sum|total|count|number|value|equals?|matches?|is\b))/i;
/**
 * Verbs that ask only to LOOK. The Thai verb sits outside the `\b` group on
 * purpose: JavaScript's word boundary is defined over `[A-Za-z0-9_]`, so
 * `\bตรวจสอบ\b` can never match — there is no word character next to a Thai
 * one for the boundary to sit on. (Caught by the test that asserts the
 * sheet's own language counts; be100's goals are written in it.)
 */
const VERIFY_VERB = /\b(verify|check|confirm that|ensure|assert|observe|read|see|compare|validate)\b|ตรวจสอบ/i;

/**
 * Is this goal asking the agent to VERIFY something and nothing else?
 *
 * The agent's contract in this codebase is **prepare, never perform**: it
 * drives the browser to where a claim can be checked, and the flow's own
 * assertion is what checks it (`#agentRescue` has always worked this way —
 * the agent prepares the page, then the author's own selector is retried).
 * A goal like "verify the Total Plans summary card shows count 75" asks the
 * agent to do the assertion's job instead, and an agent cannot produce
 * evidence — only an account of itself, which this module exists to distrust.
 *
 * Live (be100 PL_03_01, 2026-08-25): that goal, five turns of the agent
 * scrolling for a number the tree had (the count was being cut from its view
 * — see `focusTree`), "agent stalled: nothing advanced", the step recorded
 * failed with a `high` defect — and then `expectText "75"` PASSED against the
 * very page the agent had been standing on the whole time. The agent never
 * needed to succeed; it needed to hand off.
 *
 * Deliberately narrow: any action verb anywhere in the goal disqualifies it,
 * so a goal that acts and then checks ("open the dialog and verify the title")
 * is a real leg whose failure is real. Only a goal that asks for nothing but
 * looking defers.
 */
export function verificationOnlyGoal(goal: string): boolean {
  return VERIFY_VERB.test(goal) && !ACTION_VERB.test(goal) && !CONTEXTUAL_ACTION_VERB.test(goal);
}

export function agentModelUnavailable(summary: string): boolean {
  return /^agent model failed:/i.test(summary);
}
