/**
 * One deterministic sign-in, shared by everything that has to establish a
 * session on the person's behalf.
 *
 * Three callers with one procedure between them: the journey capture and the
 * navigation-map learner (both in `cli/commands/authoring.ts`), and the
 * runner's **session bootstrap** — the recovery for a flow that assumes a
 * signed-in user against a browser that has no session. The live case that
 * forced the third caller (BE_Test2.csv, run of 2026-08-19 16:53): a
 * test-case-table catalog whose rows are pure UI scripts ("กด Menu…"), no
 * persona column, captured against a browser that HAD a session — so the
 * authored setup honestly assumes one, and on a fresh headless Chrome every
 * case died on the login screen with the session guard's fatal.
 *
 * The procedure is the one `signInOnCaptureTab` learned from this
 * application, generalised: a settle for hydration; a TWO-STEP form advanced
 * once (identity + Next, no password field yet); the password filled and
 * submitted with a wait on the URL actually leaving the sign-in page — or,
 * for an application that lands a successful sign-in back on its sign-in
 * page, on the server accepting the credential POST (`watchAcceptedSubmit`;
 * a sign-in URL alone is never evidence of no session); one
 * hydration replay (a click that lands before the app hydrates is reset and
 * dropped — the engine replays the same shape for flows). Consent is handled
 * by `consent-gate.ts` after authentication. Everything is
 * deterministic, nothing invents a value: the credentials are the person's
 * own `--as`.
 */

import { errors, type Locator, type Page, type Response } from 'playwright';

/** Whether a path reads as an authentication page. Presentation only. */
export const SIGN_IN_URL_PATTERN = /(^|\/)(login|signin|sign-in|auth|sso)(\/|$)/i;
const IDENTITY_FIELD =
  'input[type="text"], input[type="email"], input[type="tel"], input:not([type])';
const SUBMIT_CONTROL = 'button[type="submit"], input[type="submit"]';
const SIGN_IN_RENDER_TIMEOUT_MS = 6_000;
/** The control that advances a two-step sign-in past its identity screen. */
const ADVANCE_CONTROL = 'role=button[name=/^(next|continue|proceed|ถัดไป|ดำเนินการต่อ)$/i]';
/**
 * A sign-out control's accessible NAME — name-gated for the same reason as
 * `CONSENT_ACCEPT_NAME`: only a control that says it signs out is ever
 * clicked, so a promo's anonymous link can never be mistaken for one.
 */
export const SIGN_OUT_NAME = /^(sign ?out|log ?out|logout|ออกจากระบบ)$/i;
/** The roles a sign-out control is offered as — a menu item most of all. */
const SIGN_OUT_ROLES = ['menuitem', 'button', 'link'] as const;
/**
 * A disclosure that plausibly holds the identity/account menu. ARIA-marked
 * only — the `page-probe.ts` safety model: "Submit", "Delete" and "Approve"
 * carry none of these attributes, so they are never candidates.
 */
const IDENTITY_DISCLOSURE = 'button[aria-haspopup="menu"], button[aria-haspopup="true"]';

export interface SignInCredentials {
  email: string;
  password: string;
}

export type SignInResult =
  | {
      ok: true;
      landedUrl: string;
      /**
       * The credential POST the server accepted, when the page then stayed
       * on a sign-in URL — the application's landing, not a lost session.
       */
      acceptedSubmit?: string | undefined;
      /**
       * The first URL off the sign-in page the application went to after the
       * submit, when it then bounced back to a sign-in URL — the signed-in
       * surface the application itself chose (HUMI: `/th` → `/th/me/home` →
       * `/th/login`). Evidence, not a guess: a later leg that starts on the
       * sign-in page may go there instead of acting on login furniture.
       */
      signedInSurface?: string | undefined;
      /** Credential submissions made, the first included. */
      attempts: number;
    }
  | { ok: false; reason: string; attempts: number };

/**
 * How many times a sign-in is submitted before it is called not taken —
 * the first submission included, so `1` means no retry. A retry is a reload
 * of the sign-in page, the credentials entered again and the control
 * clicked again (a reload empties the fields; a bare re-click submits
 * nothing). `WOWLIDATOR_SIGN_IN_ATTEMPTS` overrides; `0` and `1` both mean
 * no retry.
 */
export const SIGN_IN_ATTEMPTS = 10;
/** A reload that has not committed in this long is treated as one more attempt that did not take. */
export const SIGN_IN_RELOAD_TIMEOUT_MS = 10_000;

export function signInAttemptCeiling(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env['WOWLIDATOR_SIGN_IN_ATTEMPTS'] ?? '').trim();
  if (raw === '') return SIGN_IN_ATTEMPTS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return SIGN_IN_ATTEMPTS;
  return Math.max(1, n);
}

/** What one retried submission ended as, judged by its caller. */
export type SignInAttemptOutcome = 'signed-in' | 'not-yet' | 'failed';

/**
 * The retry loop, pure so the ceiling can be tested without a browser.
 * `attempt(n)` performs submission number `n` — reload, re-enter, re-click —
 * and reports what the caller's own evidence says (an accepted POST or the
 * URL leaving the sign-in page → `signed-in`; a step of the attempt that
 * itself failed → `failed`, which ends the loop rather than spending the
 * ceiling on a control that no longer resolves). Anything `attempt` throws
 * propagates: a lost session or a dead browser is not an attempt.
 * `attemptsSoFar` counts the submissions already made before the loop.
 */
export async function retrySignIn(
  attempt: (n: number) => Promise<SignInAttemptOutcome>,
  attemptsSoFar: number,
  ceiling: number,
): Promise<{ attempts: number; didNotTake: boolean }> {
  let attempts = attemptsSoFar;
  while (attempts < ceiling) {
    attempts += 1;
    const outcome = await attempt(attempts);
    if (outcome === 'signed-in') return { attempts, didNotTake: false };
    if (outcome === 'failed') return { attempts, didNotTake: true };
  }
  return { attempts, didNotTake: true };
}

/** The kinds of request a credential form submits as; a beacon or an image is never one. */
const SUBMIT_RESOURCE_TYPES = new Set(['xhr', 'fetch', 'document']);

/**
 * Listen for the submit's own POST being accepted — see
 * `acceptedCredentialSubmit` in `runner.ts`, the same rule read from the
 * observer: method POST, a response, status under 400. Playwright's own
 * `response` event, so every caller of this procedure gets it without a CDP
 * observer. `detach` must run in a `finally`.
 */
function watchAcceptedSubmit(tab: Page): { first: () => string | null; seen: Promise<void>; detach: () => void } {
  let accepted: string | null = null;
  let resolveSeen: () => void = () => undefined;
  const seen = new Promise<void>((resolve) => {
    resolveSeen = resolve;
  });
  const onResponse = (response: Response): void => {
    if (accepted !== null) return;
    const request = response.request();
    if (request.method().toUpperCase() !== 'POST') return;
    if (!SUBMIT_RESOURCE_TYPES.has(request.resourceType())) return;
    if (response.status() >= 400) return;
    accepted = `POST ${request.url()} ${response.status()}`;
    resolveSeen();
  };
  tab.on('response', onResponse);
  return { first: () => accepted, seen, detach: () => tab.off('response', onResponse) };
}

/** The first of these a user could actually see and act on. */
async function firstVisible(scope: Page | Locator, selector: string): Promise<Locator | null> {
  const all = await scope.locator(selector).all();
  for (const one of all) {
    if (await one.isVisible().catch(() => false)) return one;
  }
  return null;
}

/** One pass of the procedure: the form found, filled, submitted (and, on the first pass, replayed once for hydration). */
type SignInPass =
  | { kind: 'no-form'; reason: string }
  | { kind: 'submitted'; acceptedSubmit: string | null; signedInSurface: string | null; submissions: number };

function onSignInPage(tab: Page): boolean {
  return SIGN_IN_URL_PATTERN.test(tab.url());
}

/**
 * Sign in on the page the tab is currently showing. The tab must already be
 * on the sign-in form; the caller decides how it got there.
 *
 * A submission that did not take — still on the sign-in URL, no accepted
 * POST — is retried up to `ceiling` submissions in total: the page reloaded
 * (a reload empties the fields, so a bare re-click would submit nothing),
 * the procedure run again from the form, the network let settle between
 * attempts so a slow login is not hammered. Only the evidence ends the loop
 * early — the URL leaving the sign-in page or the server accepting the
 * POST — so a retry can turn "no session" into "session" only by actually
 * signing in.
 */
export async function performSignIn(
  tab: Page,
  credentials: SignInCredentials,
  ceiling: number = signInAttemptCeiling(),
): Promise<SignInResult> {
  const first = await signInOnce(tab, credentials, true);
  if (first.kind === 'no-form') return { ok: false, reason: first.reason, attempts: 0 };
  // Written from inside the retry closure; an object so the narrowing
  // outside it reads the assignments.
  const state = {
    acceptedSubmit: first.acceptedSubmit,
    signedInSurface: first.signedInSurface,
    attempts: first.submissions,
    noForm: null as string | null,
  };

  if (onSignInPage(tab) && state.acceptedSubmit === null) {
    const retried = await retrySignIn(
      async () => {
        await tab
          .reload({ waitUntil: 'domcontentloaded', timeout: SIGN_IN_RELOAD_TIMEOUT_MS })
          .catch(() => undefined);
        await tab.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
        const pass = await signInOnce(tab, credentials, false);
        if (pass.kind === 'no-form') {
          state.noForm = pass.reason;
          return 'failed';
        }
        state.acceptedSubmit = pass.acceptedSubmit;
        state.signedInSurface = pass.signedInSurface;
        return onSignInPage(tab) && state.acceptedSubmit === null ? 'not-yet' : 'signed-in';
      },
      state.attempts,
      ceiling,
    );
    state.attempts = retried.attempts;
  }

  const { acceptedSubmit, signedInSurface, attempts, noForm } = state;
  if (noForm !== null) {
    return { ok: false, reason: `${noForm} (on sign-in attempt ${attempts} of ${ceiling})`, attempts };
  }
  if (onSignInPage(tab)) {
    if (acceptedSubmit === null) {
      return {
        ok: false,
        reason: `the page never left the sign-in screen (${tab.url()}) after ${attempts} attempt(s)`,
        attempts,
      };
    }
    return {
      ok: true,
      landedUrl: tab.url(),
      acceptedSubmit,
      ...(signedInSurface === null ? {} : { signedInSurface }),
      attempts,
    };
  }
  return { ok: true, landedUrl: tab.url(), attempts };
}

/**
 * The procedure itself, once. `hydrationReplay` is the first pass's one
 * re-submit for a click that landed before the app attached its handlers;
 * a retry pass has just reloaded and settled, and is one submission exactly,
 * so the ceiling counts what it says.
 */
async function signInOnce(
  tab: Page,
  credentials: SignInCredentials,
  hydrationReplay: boolean,
): Promise<SignInPass> {
  // Let the form hydrate before typing into it; the replay below covers the
  // case this settle misses.
  await tab.waitForTimeout(400).catch(() => undefined);
  let password = await firstVisible(tab, 'input[type="password"]');

  if (password === null && (await firstVisible(tab, IDENTITY_FIELD)) === null) {
    try {
      await tab.locator('input[type="password"]').first().waitFor({
        state: 'visible',
        timeout: SIGN_IN_RENDER_TIMEOUT_MS,
      });
    } catch (error) {
      if (!(error instanceof errors.TimeoutError)) throw error;
    }
    password = await firstVisible(tab, 'input[type="password"]');
  }

  // A sign-in may take two screens: identity + Next first, password after.
  if (password === null) {
    const identity = await firstVisible(tab, IDENTITY_FIELD);
    const advance = identity === null ? null : await firstVisible(tab, ADVANCE_CONTROL);
    if (identity === null || advance === null) {
      return { kind: 'no-form', reason: 'no visible password field, and no identity screen to advance' };
    }
    await identity.fill(credentials.email);
    await advance.click();
    await tab.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
    password = await firstVisible(tab, 'input[type="password"]');
    if (password === null) {
      return {
        kind: 'no-form',
        reason: 'no visible password field, even after advancing past the identity screen',
      };
    }
  }

  // Scope the identity to the password's own form; a page can carry a search
  // box beside the login. On a two-step screen there may be no identity field
  // left, and that is fine — it was given on the first screen.
  const form = tab.locator('form:has(input[type="password"])').first();
  const scope: Page | Locator = (await form.count().catch(() => 0)) > 0 ? form : tab;
  const identity = await firstVisible(scope, IDENTITY_FIELD);
  if (identity !== null) await identity.fill(credentials.email);
  await password.fill(credentials.password);
  // One re-assert: a fill that landed before hydration is reset silently.
  if ((await password.inputValue().catch(() => '')) !== credentials.password) {
    if (identity !== null) await identity.fill(credentials.email);
    await password.fill(credentials.password);
  }

  // The first main-frame URL off the sign-in path after the submit: for an
  // application that lands a successful sign-in back on its sign-in page,
  // this is where it went in between — its own signed-in surface.
  let signedInSurface: string | null = null;
  const onNavigated = (frame: { url(): string; parentFrame(): unknown }): void => {
    if (signedInSurface !== null || frame.parentFrame() !== null) return;
    const url = frame.url();
    if (!/^https?:/.test(url)) return;
    let pathname: string;
    try {
      pathname = new URL(url).pathname;
    } catch {
      return;
    }
    if (!SIGN_IN_URL_PATTERN.test(pathname)) signedInSurface = url;
  };
  const submitOnce = async (): Promise<string | null> => {
    const watch = watchAcceptedSubmit(tab);
    tab.on('framenavigated', onNavigated);
    try {
      const submit = await firstVisible(scope, SUBMIT_CONTROL);
      if (submit !== null) await submit.click();
      else await password!.press('Enter');
      // Wait for the sign-in to TAKE — the URL leaving the sign-in page — not
      // merely for the network to go quiet. An application that lands a
      // successful sign-in back on its sign-in page never leaves it
      // (be-sit-high-20260909-170213, 2026-09-10): once the server has
      // accepted the credential POST, the URL gets a short window to move
      // and the accepted POST is the evidence instead of the full wait.
      const urlLeft = (timeout: number): Promise<void> =>
        tab
          .waitForURL((url) => !SIGN_IN_URL_PATTERN.test(url.pathname), { timeout })
          .catch(() => undefined);
      await Promise.race([urlLeft(8_000), watch.seen.then(() => urlLeft(2_000))]);
      await tab.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
      return watch.first();
    } finally {
      tab.off('framenavigated', onNavigated);
      watch.detach();
    }
  };
  let acceptedSubmit = await submitOnce();
  let submissions = 1;

  // The hydration replay: a click that landed before the app attached its
  // handlers was dropped, the page stayed put, and the credentials are fine.
  // A page still on the sign-in URL after an ACCEPTED submit is the
  // application's landing, not a dropped click — replaying would sign in
  // twice and prove nothing.
  if (hydrationReplay && onSignInPage(tab) && acceptedSubmit === null) {
    await tab.waitForTimeout(500).catch(() => undefined);
    const again = await firstVisible(tab, 'input[type="password"]');
    if (again !== null) {
      password = again;
      if (identity !== null && (await identity.isVisible().catch(() => false))) {
        await identity.fill(credentials.email);
      }
      await password.fill(credentials.password);
      acceptedSubmit = await submitOnce();
      submissions += 1;
    }
  }

  return { kind: 'submitted', acceptedSubmit, signedInSurface, submissions };
}

export type SignOutResult =
  | { ok: true; via: string; landedUrl: string }
  | { ok: false; reason: string };

/** The first visible sign-out control on the page, searched by role. */
async function visibleSignOutControl(tab: Page): Promise<{ control: Locator; label: string } | null> {
  for (const role of SIGN_OUT_ROLES) {
    const candidates = await tab.getByRole(role, { name: SIGN_OUT_NAME }).all();
    for (const one of candidates) {
      if (await one.isVisible().catch(() => false)) {
        const label = (await one.textContent().catch(() => null))?.trim() || 'Sign out';
        return { control: one, label: `${role} "${label}"` };
      }
    }
  }
  return null;
}

/**
 * Sign out the way a user does — through the application's own control.
 *
 * The persona-switch procedure used to be `clearStorage` between two gotos,
 * which works only for a session the browser holds client-side and tests
 * nothing: the application's sign-out path went unexercised, and a
 * cookie-backed session survived the wipe entirely — the next login form
 * never appeared because the app still considered the user signed in. So the
 * real path first: a name-gated sign-out control (`SIGN_OUT_NAME` — never an
 * anonymous link), searched on the page and then behind ARIA-marked
 * identity disclosures (`aria-haspopup`, the probe's safety model — a bare
 * button is never opened). Only the caller decides what happens when no
 * control exists; this reports the fact rather than inventing a wipe.
 */
export async function performSignOut(tab: Page): Promise<SignOutResult> {
  // Already signed out: a page sitting on the sign-in surface has no session
  // to end, and clicking around it would be noise.
  if (SIGN_IN_URL_PATTERN.test(tab.url())) {
    return { ok: true, via: 'already on the sign-in page', landedUrl: tab.url() };
  }

  let found = await visibleSignOutControl(tab);
  let opened: string | null = null;

  if (found === null) {
    // The control usually lives behind the identity/account menu. Open only
    // ARIA-marked disclosures, verify each closed (Escape) before the next —
    // the page-probe contract, narrowed to one goal.
    const disclosures = await tab.locator(IDENTITY_DISCLOSURE).all();
    for (const disclosure of disclosures.slice(0, 4)) {
      if (!(await disclosure.isVisible().catch(() => false))) continue;
      await disclosure.click().catch(() => undefined);
      await tab.waitForTimeout(250).catch(() => undefined);
      found = await visibleSignOutControl(tab);
      if (found !== null) {
        opened =
          (await disclosure.getAttribute('aria-label').catch(() => null)) ??
          (await disclosure.textContent().catch(() => null))?.trim() ??
          'a disclosure';
        break;
      }
      await tab.keyboard.press('Escape').catch(() => undefined);
    }
  }

  if (found === null) {
    return {
      ok: false,
      reason: 'no sign-out control found — none visible on the page or behind its ARIA-marked menus',
    };
  }

  await found.control.click();
  // Signing out lands on the sign-in page on most applications; wait for
  // that, but do not require it — an app may land on a public home page.
  await tab
    .waitForURL((url) => SIGN_IN_URL_PATTERN.test(url.pathname), { timeout: 8_000 })
    .catch(() => undefined);
  await tab.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
  const via = opened === null ? found.label : `${found.label} behind "${opened}"`;
  return { ok: true, via, landedUrl: tab.url() };
}
