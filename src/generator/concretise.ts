/**
 * Sharpening a thin claim from evidence the model never saw (asked for
 * 2026-09-09).
 *
 * A `weak` refusal describes a flow that proves less than it should. The
 * author hands those over with a note and nothing else, because the one remedy
 * available — re-asking — bought nothing measurable: the model came back with
 * the same flow, having learned no new fact (`flow-author.ts`, "A flow refused
 * ONLY for thinness is accepted at once"). That reasoning is about a re-ask,
 * and it still holds. What it does not cover is the case where a NEW FACT
 * exists and nobody looked it up.
 *
 * Two such facts are already in hand at the moment a lint fires, and neither
 * costs a call:
 *
 * - the indexed **repository**'s route patterns (`FlowAuthor`'s
 *   `declaredRoutes`), which say which paths the application really declares;
 * - the **database**'s answer about the row a step is scoped to, which
 *   `step-evidence.ts` has already resolved into
 *   `StepEvidenceOutcome.existingFixtures` before any lint runs.
 *
 * So this module adds no lookup of its own. It reads what the run already
 * knows and turns a vague complaint into a concrete flow.
 *
 * **The rule that keeps it honest: a concretiser may make an existing claim
 * concrete; it may never add one.** Naming a route, inserting the navigation
 * that reaches it, or scoping a step to the row the case is about are all
 * things the sheet already asked for. Adding an assertion the sheet never
 * wrote would be authoring an expected result nobody specified — the failure
 * the claim-fidelity family exists to prevent. Navigation and scoping only;
 * never a new `expect*`.
 *
 * It is the same asymmetry `step-evidence.ts` states and for the same reason:
 * **evidence may excuse a claim, never accuse one.** Nothing here can raise a
 * refusal, and a concretiser that finds nothing leaves the note exactly as the
 * lint wrote it.
 */

import { pathnameOf, routeIsDeclared } from '../context/route-match.js';
import { LOGIN_URL_PATTERN } from './value-rules.js';
import type { FlowStep } from '../engine/runner.js';

/**
 * What a weak complaint may consult to sharpen itself. Assembled from values
 * already in scope where the lints run — no query, no model, no I/O.
 */
export interface ConcreteEvidence {
  /** Route patterns the indexed repository declares (the graph's `route` nodes). */
  readonly routes: readonly string[];
  /**
   * Fixtures the database shows the application already holds, as
   * `step-evidence.ts` resolved them before the lints ran. A literal absent
   * from this list was either never looked up or not found — never a licence
   * to assert it exists.
   */
  readonly existingFixtures: readonly string[];
  /** The deployment the run is pointed at, for turning a declared path into a URL. */
  readonly startUrl: string;
}

/** A path in the sheet's own words: `/humi/en/admin/benefits/plans`, never a bare word. */
const BARE_PATH = /(?<![\w:/])\/[a-z0-9][a-z0-9\-_/]*(?:\/[a-z0-9\-_]+)+/gi;

/**
 * A sign-in page is where a run STARTS, never what a case is about.
 *
 * This is the shape that made the rule necessary. A sheet may open every row's
 * Steps column with the same preamble — "begin at <login url> and use /en/ for
 * every route" — and `destinationOf` (`catalog/test-case-table.ts`) takes the
 * FIRST url it finds there, so every row in the workbook is recorded as having
 * the login page for its destination. `ignoresMenuPath` then reports that the
 * flow never navigates to it, which is true and means nothing: signing in is
 * what setup does, and navigating back to the login page after signing in is
 * not a thing any correct flow can do.
 */
/** Whether a path is an entry page rather than a destination. */
export function isEntryPath(path: string): boolean {
  // `LOGIN_URL_PATTERN` is the one spelling of this question in the repo, and
  // its own comment says why: two would drift. It already reads a bare path
  // and is careful about `auth`/`sso` (a payroll app's `/admin/config/sso` is
  // not a sign-in surface), which a looser rule here got wrong once already.
  return LOGIN_URL_PATTERN.test(path) || /(?:^|\/)logout(?:\/|$)/i.test(path);
}

/**
 * The page a case is really about, from the paths it names and the routes the
 * repository declares.
 *
 * The sheet states its route in prose — `0. Route อ้างอิง
 * /humi/en/admin/benefits/plans (locale=en)` — as a bare path, which carries no
 * scheme and so never becomes the row's `Destination`. The repository knows
 * that path is a real route; nothing else in the system does.
 *
 * **The deployment's base path is not the repository's** — measured on
 * be-high-sonnet (2026-09-09), where this returned null on all ten rows it was
 * built for. The graph declares `/:locale/admin/benefits/plans`; the sheet, and
 * the browser, say `/humi/en/admin/benefits/plans`, because the app is served
 * under a `/humi` prefix the route table knows nothing about. `routeIsDeclared`
 * takes the deployment URL for exactly this and `ungroundedGoto` has always
 * passed it; omitting it made every comparison fail on a prefix.
 *
 * Returns the first path the case names that is not an entry page and that the
 * repository declares, or null when the case names none, none is declared, or
 * no repository is indexed. Silence declines — the rule every grounding lint
 * here follows.
 */
export function declaredRouteInCaseText(
  caseText: string,
  routes: readonly string[],
  deploymentUrl?: string | undefined,
): string | null {
  if (routes.length === 0) return null;
  const seen = new Set<string>();
  for (const match of caseText.matchAll(BARE_PATH)) {
    const path = match[0].replace(/\/+$/, '');
    if (path === '' || seen.has(path)) continue;
    seen.add(path);
    if (isEntryPath(path)) continue;
    if (routeIsDeclared(path, routes, deploymentUrl) === true) return path;
  }
  return null;
}

/**
 * Whether the flow already reaches its page, by any route a sheet allows.
 *
 * A `goto` is the obvious one, but a menu-navigation case is explicitly told
 * NOT to jump by URL — the live sheet writes "ไม่เปิด URL ข้าม assertion", do not
 * open a URL to skip the assertion — and reaches its page by clicking crumbs
 * instead. A journey handed to the agent travels too. Counting only gotos would
 * call every correctly authored menu case unnavigated, and inserting a goto
 * into one would destroy the very thing it tests.
 */
export function flowTravels(steps: readonly FlowStep[]): boolean {
  return steps.some(
    (step) => step.action === 'goto' || step.action === 'workflow' || step.action === 'click',
  );
}

/** Whether any step already navigates to this path. */
export function flowReaches(steps: readonly FlowStep[], path: string): boolean {
  return steps.some(
    (step) =>
      (step.action === 'goto' && (pathnameOf(step.url) ?? step.url).replace(/\/+$/, '') === path) ||
      (step.action === 'workflow' && step.goal.toLowerCase().includes(path.toLowerCase())),
  );
}

/** A declared path as a URL on the run's own deployment. */
export function urlForRoute(path: string, startUrl: string): string {
  try {
    return new URL(path, startUrl).href;
  } catch {
    return path;
  }
}

/** What a route complaint became once the repository was consulted. */
export type RouteConcretion =
  | { kind: 'honoured'; path: string }
  | { kind: 'navigate'; path: string; url: string }
  | null;

/**
 * The route half, as a pure decision — the caller performs it.
 *
 * Three outcomes, and the middle one is the whole point:
 *
 * - **null** — the repository declares no page the case names, so nothing is
 *   known that the lint did not know. Its note stands, unchanged.
 * - **honoured** — the case's real page is declared and the flow already
 *   reaches it. The complaint was about the sheet's *stated* destination,
 *   which was a sign-in preamble; the flow is right and the note is noise.
 * - **navigate** — the case's real page is declared and the flow reaches no
 *   page at all. A `goto` is inserted. This is navigation, not an assertion,
 *   so it makes the case testable without deciding what it should prove.
 */
export function concretiseRoute(
  caseText: string,
  steps: readonly FlowStep[],
  evidence: ConcreteEvidence,
): RouteConcretion {
  const path = declaredRouteInCaseText(
    caseText,
    evidence.routes,
    evidence.startUrl === '' ? undefined : evidence.startUrl,
  );
  if (path === null) return null;
  if (flowReaches(steps, path) || flowTravels(steps)) return { kind: 'honoured', path };
  return { kind: 'navigate', path, url: urlForRoute(path, evidence.startUrl) };
}
