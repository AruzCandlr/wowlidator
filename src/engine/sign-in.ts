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
 * submitted with a wait on the URL actually leaving the sign-in page; one
 * hydration replay (a click that lands before the app hydrates is reset and
 * dropped — the engine replays the same shape for flows); and a consent gate
 * accepted only when the URL names one and a name-gated accept control is
 * present. Everything is deterministic, nothing invents a value: the
 * credentials are the person's own `--as`.
 */

import type { Locator, Page } from 'playwright';

/** Whether a path reads as an authentication page. Presentation only. */
export const SIGN_IN_URL_PATTERN = /(^|\/)(login|signin|sign-in|auth|sso)(\/|$)/i;
/** A page standing between signing in and the application. */
export const CONSENT_GATE_URL_PATTERN = /(^|\/)(consent|pdpa|terms|agreement)(\/|$|\?)/i;

const IDENTITY_FIELD =
  'input[type="text"], input[type="email"], input[type="tel"], input:not([type])';
const SUBMIT_CONTROL = 'button[type="submit"], input[type="submit"]';
/** The control that advances a two-step sign-in past its identity screen. */
const ADVANCE_CONTROL = 'role=button[name=/^(next|continue|proceed|ถัดไป|ดำเนินการต่อ)$/i]';
/**
 * The accept control's accessible NAME — exported so the agent loop and the
 * authoring repair can recognise an accept-shaped control without a second
 * list that drifts from this one.
 */
export const CONSENT_ACCEPT_NAME =
  /^(accept and continue|accept|agree|i agree|ยอมรับและดำเนินการต่อ|ยอมรับ)$/i;
/** A consent interstitial's accept control — name-gated, never a bare primary action. */
const CONSENT_ACCEPT_CONTROL =
  'role=button[name=/^(accept and continue|accept|agree|i agree|ยอมรับและดำเนินการต่อ|ยอมรับ)$/i]';
/**
 * A consent-shaped page heading. Detection by CONTENT, because the gate this
 * was measured on (cnext-hrms-fortest, BE_Test2 2026-08-20 11:52 run) is
 * client-side and renders IN PLACE on whatever URL a goto asked for — the URL
 * never says "consent", the heading does. See
 * docs/consent-gate-recovery-spec.md.
 */
export const CONSENT_HEADING_PATTERN = /consent|pdpa|personal data|ความยินยอม/i;

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
  | { ok: true; landedUrl: string }
  | { ok: false; reason: string };

/** The first of these a user could actually see and act on. */
async function firstVisible(scope: Page | Locator, selector: string): Promise<Locator | null> {
  const all = await scope.locator(selector).all();
  for (const one of all) {
    if (await one.isVisible().catch(() => false)) return one;
  }
  return null;
}

/**
 * If the tab is on a consent page, accept it and wait. True when it did.
 * Gated on the URL naming a consent page AND a name-gated accept control, so
 * this can accept a consent a sign-in steered it into, and nothing else.
 */
export async function acceptConsentGate(tab: Page): Promise<boolean> {
  if (!CONSENT_GATE_URL_PATTERN.test(tab.url())) return false;
  const accept = await firstVisible(tab, CONSENT_ACCEPT_CONTROL);
  if (accept === null) return false;
  await accept.click();
  await tab.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
  await tab.waitForTimeout(300).catch(() => undefined);
  return true;
}

/**
 * The gate detected by what the page SHOWS, not by its URL: the name-gated
 * accept control AND either a consent-naming URL or a consent-shaped heading
 * — both halves required, so a page that merely carries an "Accept" button (a
 * cookie banner has its own ladder rung) is never treated as this gate.
 * Returns the accept control when the gate is showing, `null` otherwise.
 */
export async function consentGateShowing(tab: Page): Promise<Locator | null> {
  const accept = await firstVisible(tab, CONSENT_ACCEPT_CONTROL);
  if (accept === null) return null;
  if (CONSENT_GATE_URL_PATTERN.test(tab.url())) return accept;
  const headings = await tab
    .locator('h1, h2, h3, [role="heading"]')
    .allInnerTexts()
    .catch(() => [] as string[]);
  return headings.some((heading) => CONSENT_HEADING_PATTERN.test(heading)) ? accept : null;
}

/**
 * Accept the gate WHEREVER it renders — the content-detected sibling of
 * `acceptConsentGate`, for the gate that renders on the URL the flow asked
 * for. True when a gate was showing and was accepted.
 */
export async function acceptConsentGateAnywhere(tab: Page): Promise<boolean> {
  const accept = await consentGateShowing(tab);
  if (accept === null) return false;
  await accept.click();
  await tab.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
  await tab.waitForTimeout(300).catch(() => undefined);
  return true;
}

/**
 * Sign in on the page the tab is currently showing. The tab must already be
 * on the sign-in form; the caller decides how it got there.
 */
export async function performSignIn(
  tab: Page,
  credentials: SignInCredentials,
): Promise<SignInResult> {
  // Let the form hydrate before typing into it; the replay below covers the
  // case this settle misses.
  await tab.waitForTimeout(400).catch(() => undefined);
  let password = await firstVisible(tab, 'input[type="password"]');

  // A sign-in may take two screens: identity + Next first, password after.
  if (password === null) {
    const identity = await firstVisible(tab, IDENTITY_FIELD);
    const advance = identity === null ? null : await firstVisible(tab, ADVANCE_CONTROL);
    if (identity === null || advance === null) {
      return { ok: false, reason: 'no visible password field, and no identity screen to advance' };
    }
    await identity.fill(credentials.email);
    await advance.click();
    await tab.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
    password = await firstVisible(tab, 'input[type="password"]');
    if (password === null) {
      return {
        ok: false,
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

  const submitOnce = async (): Promise<void> => {
    const submit = await firstVisible(scope, SUBMIT_CONTROL);
    if (submit !== null) await submit.click();
    else await password!.press('Enter');
    // Wait for the sign-in to TAKE — the URL leaving the sign-in page — not
    // merely for the network to go quiet.
    await tab
      .waitForURL((url) => !SIGN_IN_URL_PATTERN.test(url.pathname), { timeout: 8_000 })
      .catch(() => undefined);
    await tab.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
  };
  await submitOnce();

  // The hydration replay: a click that landed before the app attached its
  // handlers was dropped, the page stayed put, and the credentials are fine.
  if (SIGN_IN_URL_PATTERN.test(tab.url())) {
    await tab.waitForTimeout(500).catch(() => undefined);
    const again = await firstVisible(tab, 'input[type="password"]');
    if (again !== null) {
      password = again;
      if (identity !== null && (await identity.isVisible().catch(() => false))) {
        await identity.fill(credentials.email);
      }
      await password.fill(credentials.password);
      await submitOnce();
    }
  }

  if (SIGN_IN_URL_PATTERN.test(tab.url())) {
    return { ok: false, reason: `the page never left the sign-in screen (${tab.url()})` };
  }

  // A consent gate after the first sign-in of a fresh context is part of
  // signing in: nothing behind it is reachable until it is accepted.
  await acceptConsentGate(tab);
  return { ok: true, landedUrl: tab.url() };
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
