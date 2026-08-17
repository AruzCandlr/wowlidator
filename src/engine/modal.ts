/**
 * Modal / dialog / popup detection and interaction — deterministic, no model
 * call. This is execution-plane code, not control-plane: it costs nothing
 * and runs on every step, so it has to be cheap and it has to be honest
 * about what it can and can't see.
 *
 * Detection is ARIA-based only: `role="dialog"`, `role="alertdialog"`, or a
 * native `<dialog open>`. A fixed-position `<div>` with no dialog role is
 * not detected — the same "understate, never overstate" choice
 * `ax-coverage.ts` makes for CSS selectors, applied here to a much richer
 * signal. Every mainstream component library (Radix, MUI, Headless UI,
 * Bootstrap 5) exposes this correctly; a hand-rolled non-ARIA popup is a
 * known, disclosed gap rather than something silently guessed at.
 */

import type { Locator, Page } from 'playwright';

const DIALOG_SELECTOR = '[role="dialog"], [role="alertdialog"], dialog[open]';

/** Common dismiss/accept affordances, matched against a button's full accessible text. */
const DISMISS_NAME_PATTERN =
  /^(close|dismiss|cancel|ok|okay|got it|accept|accept all|accept cookies|i agree|agree|no,? thanks|maybe later|not now|continue)$/i;
const DISMISS_SYMBOL_PATTERN = /^[×✕✖⨯]$/;

export interface DismissButton {
  locator: Locator;
  /** Accessible text of the button, for reports and error messages. */
  text: string;
}

/** Every currently-visible dialog, most-recently-attached first — usually the topmost/newest one. */
async function visibleDialogs(page: Page): Promise<Locator[]> {
  const candidates = page.locator(DIALOG_SELECTOR);
  const count = await candidates.count().catch(() => 0);
  const visible: Locator[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const candidate = candidates.nth(i);
    if (await candidate.isVisible().catch(() => false)) visible.push(candidate);
  }
  return visible;
}

/**
 * The dialog open right now, with no wait. For the automatic recovery path,
 * called only after a step has already failed — waiting here would just add
 * a second timeout on top of the one that already elapsed.
 */
export async function openDialogNow(page: Page): Promise<Locator | null> {
  const dialogs = await visibleDialogs(page);
  return dialogs[0] ?? null;
}

/**
 * Wait up to `timeoutMs` for a dialog to appear. For `expectModal`/
 * `closeModal`, where the author is asserting one should show up — possibly
 * a moment after the step that triggers it.
 *
 * Polls rather than `locator.first().waitFor()`: a page can have more than
 * one dialog-role container in the DOM at once (several possible modals,
 * only one shown at a time), and `.first()` waits on whichever matches
 * first in *DOM order* — which is not necessarily the one that actually
 * becomes visible.
 */
export async function waitForDialog(page: Page, timeoutMs: number): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const dialog = await openDialogNow(page);
    if (dialog) return dialog;
    if (Date.now() >= deadline) return null;
    await page.waitForTimeout(50);
  }
}

/**
 * A human-ish label for a dialog, for reports and error messages.
 * Approximate on purpose — full ARIA accessible-name computation
 * (aria-labelledby resolution, etc.) is more involved than a test-reporting
 * label needs to be.
 */
export async function describeDialog(dialog: Locator): Promise<string> {
  const label = await dialog.getAttribute('aria-label').catch(() => null);
  if (label) return label;
  const text = (await dialog.textContent().catch(() => '')) ?? '';
  const trimmed = text.replace(/\s+/g, ' ').trim();
  return trimmed === '' ? 'unnamed dialog' : trimmed.slice(0, 80);
}

/**
 * Find a button inside `dialog` whose accessible name looks like a
 * dismiss/accept affordance. Checked in order: an explicit
 * `aria-label="Close"` control (the single most reliable signal, common on
 * icon-only close buttons with no visible text), then any button whose
 * accessible name matches a common dismiss word.
 *
 * Uses `getByRole('button', { name })`, not raw text content — the
 * accessible-name computation it does correctly follows `aria-label` even
 * when a button's visible content is just an icon, which is exactly the
 * icon-only-close-button case this needs to handle. Symbol glyphs (×, ✕)
 * rarely carry an accessible name at all, so those still need one manual
 * text-content check.
 *
 * When a dialog offers more than one plausible match (e.g. both "Accept" and
 * "Reject" on a cookie banner), this returns the first one found in document
 * order — not necessarily the one a human would choose. That ambiguity is
 * exactly why `closeModal` accepts an explicit `button` override rather than
 * relying on this alone.
 */
export async function findDismissButton(dialog: Locator): Promise<DismissButton | null> {
  const explicitClose = dialog.getByRole('button', { name: /^close$/i }).first();
  if (await explicitClose.isVisible().catch(() => false)) {
    const text =
      (await explicitClose.getAttribute('aria-label').catch(() => null)) ??
      (await explicitClose.textContent().catch(() => null)) ??
      'Close';
    return { locator: explicitClose, text: text.trim() || 'Close' };
  }

  const common = dialog.getByRole('button', { name: DISMISS_NAME_PATTERN }).first();
  if (await common.isVisible().catch(() => false)) {
    const text =
      ((await common.textContent().catch(() => '')) ||
        (await common.getAttribute('aria-label').catch(() => '')) ||
        ''
      ).trim();
    return { locator: common, text };
  }

  // Symbol-only glyphs rarely have a computed accessible name, so they need a
  // manual scan rather than a role-name query.
  const buttons = dialog.getByRole('button');
  const count = await buttons.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const candidate = buttons.nth(i);
    const text = ((await candidate.textContent().catch(() => '')) ?? '').trim();
    if (DISMISS_SYMBOL_PATTERN.test(text) && (await candidate.isVisible().catch(() => false))) {
      return { locator: candidate, text };
    }
  }
  return null;
}
