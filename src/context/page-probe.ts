/**
 * Interaction probing: what the page shows *after* you touch it.
 *
 * ## The gap this closes
 *
 * Everything that reads a page in wowlidator reads one accessibility tree, captured
 * once, of the page as it loaded. That is the right default and it has a hard
 * limit: an application's most important controls are frequently one click
 * away from existing at all. A generator pointed at a page with a role switcher
 * behind an identity menu cannot write a test that switches roles, because at
 * the moment it looked, the menu items were not in the document. It does not
 * write a bad test — it writes a small one, and the reason is invisible.
 *
 * A probe opens the disclosures, records what each one revealed, and closes
 * them again, so the tree handed to a model reads:
 *
 * ```
 * button "Active role — open identity menu"
 *   ↳ revealed by clicking:
 *       menuitem "Take Action on Behalf of…"
 *       menuitem "Sign out"
 * ```
 *
 * ## Only disclosures, and that restriction is the safety model
 *
 * A probe *clicks things on a live application*. The whole design rests on
 * clicking only controls that ARIA marks as revealing more UI —
 * `aria-haspopup`, `aria-expanded="false"`, `role="combobox"` — never a bare
 * button. "Submit", "Delete", "Approve" carry none of those attributes, so
 * they are never candidates. This is the same understate-never-overstate rule
 * `ax-coverage.ts` applies to attribution, pointed at a riskier operation: an
 * unmarked disclosure is a missed opportunity, an unmarked *action* clicked by
 * mistake is a write to someone's database.
 *
 * Every probe is put back before the next one opens, and "put back" is
 * verified against the tree captured before the click, never assumed. Escape
 * is the first gesture, not the only one: a popover that closes on "click
 * outside" need not listen for Escape at all (live, 2026-09-10: a top-bar
 * popover with a full-viewport click-catcher ignored it, the probe left it
 * open, and its catcher then swallowed every later click of the case). So the
 * gestures a person would try come next, cheapest and safest first — a
 * neutral dismiss control inside what opened, the click-catcher itself (an
 * element with no action of its own), and finally the trigger again, which a
 * disclosure marks as a toggle. Only when all four fail is the disclosure
 * reported left open, and probing stops there so one control's contents are
 * never attributed to the next.
 *
 * Probing is diagnostic. Anything that goes wrong inside it is swallowed and
 * reported as a warning — it must never fail the generation it was helping.
 */

import type { Locator, Page } from 'playwright';

import { findClickCatcher } from '../engine/click-catcher.js';
import { findDismissButton, openDialogNow } from '../engine/modal.js';
import { captureAxNodes, type AxNode } from '../healer/jit-healer.js';

/**
 * Minimal shape of the browser globals this module touches inside
 * `page.evaluate`.
 *
 * The same shim pattern `runner.ts` uses for `document.body`: `tsconfig` pins
 * `types: ["node"]` and no DOM lib, deliberately, so browser-side callbacks
 * declare exactly what they use rather than pulling every DOM global into the
 * build.
 */
interface ProbeElement {
  hasAttribute(name: string): boolean;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  getBoundingClientRect(): { width: number; height: number };
  innerText?: string;
}

interface ProbeDocument {
  document: {
    querySelectorAll(selector: string): { forEach(fn: (el: ProbeElement, i: number) => void): void };
  };
}

/** Controls ARIA marks as revealing more UI when activated. */
const DISCLOSURE_SELECTOR = [
  '[aria-haspopup="true"]',
  '[aria-haspopup="menu"]',
  '[aria-haspopup="dialog"]',
  '[aria-haspopup="listbox"]',
  '[aria-expanded="false"]',
  '[role="combobox"]',
].join(', ');

export const DEFAULT_MAX_PROBES = 6;
export const DEFAULT_PROBE_SETTLE_MS = 600;

/** The gestures a probe tries, in order, to put a disclosure back. */
export type CloseGesture = 'escape' | 'dismiss-button' | 'click-catcher' | 'trigger';

export const CLOSE_GESTURES: readonly CloseGesture[] = ['escape', 'dismiss-button', 'click-catcher', 'trigger'];

/** How long a disclosure is given to settle after a closing gesture. */
export const CLOSE_SETTLE_MS = 200;

export interface ProbeResult {
  /** The control that was clicked, as a reader would name it. */
  trigger: string;
  /** Nodes that exist only while the disclosure is open. */
  revealed: AxNode[];
  /** True when the disclosure would not close again — see `probeInteractions`. */
  leftOpen?: boolean;
  /** The gesture that put the disclosure back. Absent when it was left open. */
  closedVia?: CloseGesture;
}

export interface ProbeReport {
  probes: ProbeResult[];
  /** Candidates found but not opened, because the budget ran out. */
  skipped: number;
  /** Anything that went wrong. Never thrown — a probe cannot fail a run. */
  warnings: string[];
}

export interface ProbeOptions {
  maxProbes?: number | undefined;
  /** How long to wait for revealed content to render. */
  settleMs?: number | undefined;
}

/**
 * Open each disclosure on the page in turn and record what it reveals.
 *
 * The page is left as it was found, as far as Escape can manage it.
 */
export async function probeInteractions(
  page: Page,
  options: ProbeOptions = {},
): Promise<ProbeReport> {
  const maxProbes = options.maxProbes ?? DEFAULT_MAX_PROBES;
  const settleMs = options.settleMs ?? DEFAULT_PROBE_SETTLE_MS;
  const report: ProbeReport = { probes: [], skipped: 0, warnings: [] };

  let baseline: AxNode[];
  try {
    baseline = await captureAxNodes(page);
  } catch (error) {
    report.warnings.push(`could not capture the page before probing: ${describe(error)}`);
    return report;
  }
  const baselineKeys = new Set(baseline.map(keyOf));

  let candidates: { selector: string; label: string }[];
  try {
    candidates = await page.evaluate((selector) => {
      const out: { selector: string; label: string }[] = [];
      const seen = new Set<string>();
      const doc = (globalThis as unknown as ProbeDocument).document;
      doc.querySelectorAll(selector).forEach((el, index) => {
        if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') return;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        const label = (el.getAttribute('aria-label') || el.innerText || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 60);
        if (!label || seen.has(label)) return;
        seen.add(label);
        // A stable handle for the click, independent of the label's case — the
        // same accessible-name mismatch `src/engine/selector.ts` documents.
        el.setAttribute('data-wowlidator-probe', String(index));
        out.push({ selector: `[data-wowlidator-probe="${index}"]`, label });
      });
      return out;
    }, DISCLOSURE_SELECTOR);
  } catch (error) {
    report.warnings.push(`could not enumerate disclosures: ${describe(error)}`);
    return report;
  }

  if (candidates.length > maxProbes) {
    // Said out loud rather than silently truncated: a capped probe otherwise
    // reads exactly like a page with nothing more to show.
    report.skipped = candidates.length - maxProbes;
  }

  const urlBefore = page.url();
  for (const candidate of candidates.slice(0, maxProbes)) {
    try {
      const trigger = page.locator(candidate.selector).first();
      await trigger.click({ timeout: 2_000 });
      await page.waitForTimeout(settleMs);

      if (page.url() !== urlBefore) {
        // A "disclosure" that navigated is mislabelled, and a probe that leaves
        // the page on another URL has changed the run it was helping. Go back
        // (best effort) and stop: nothing after this can be attributed.
        report.warnings.push(
          `"${candidate.label}" navigated to ${page.url()} instead of revealing content — ` +
            'went back and stopped probing',
        );
        await page.goBack({ waitUntil: 'commit', timeout: 5_000 }).catch(() => undefined);
        break;
      }

      const after = await captureAxNodes(page);
      const revealed = after.filter((node) => !baselineKeys.has(keyOf(node)));

      const closed = await closeDisclosure(page, trigger, baselineKeys);

      if (revealed.length > 0) {
        report.probes.push(
          closed === null
            ? { trigger: candidate.label, revealed, leftOpen: true }
            : { trigger: candidate.label, revealed, closedVia: closed },
        );
      }

      if (closed === null) {
        // Whatever opened is still there and would contaminate every later
        // probe. Stop rather than attribute one control's contents to another.
        report.warnings.push(
          `"${candidate.label}" would not close (tried ${CLOSE_GESTURES.join(', ')}) — stopped ` +
            'probing to avoid attributing its contents to another control',
        );
        break;
      }
    } catch (error) {
      report.warnings.push(`probing "${candidate.label}" failed: ${describe(error)}`);
    }
  }

  await page
    .evaluate(() =>
      (globalThis as unknown as ProbeDocument).document
        .querySelectorAll('[data-wowlidator-probe]')
        .forEach((el) => el.removeAttribute('data-wowlidator-probe')),
    )
    .catch(() => undefined);

  return report;
}

/**
 * Render a probe report for a prompt.
 *
 * Provenance is explicit — "revealed by clicking X" is not the same claim as
 * "on the page", and a model that cannot tell them apart will write a flow
 * that clicks a menu item without opening the menu.
 */
export function formatProbeReport(report: ProbeReport): string {
  if (report.probes.length === 0) return '';
  const lines: string[] = [
    'Controls that exist only after an interaction. To use one, click its',
    'trigger first — it is not on the page as loaded:',
    '',
  ];
  for (const probe of report.probes) {
    lines.push(`click ${JSON.stringify(probe.trigger)} reveals:`);
    for (const node of probe.revealed.slice(0, 20)) {
      lines.push(`  ${node.role}${node.name ? ` ${JSON.stringify(node.name)}` : ''}`);
    }
    if (probe.revealed.length > 20) lines.push(`  … ${probe.revealed.length - 20} more`);
    lines.push('');
  }
  if (report.skipped > 0) {
    lines.push(`(${report.skipped} more disclosure(s) not opened — probe budget reached.)`);
  }
  return lines.join('\n');
}

/**
 * Put an opened disclosure back, one gesture at a time, and say which one
 * did it — `null` when none did. Every gesture is verified the same way:
 * the tree holds nothing the baseline did not.
 *
 * Order is by how little each gesture can do beyond closing: Escape touches
 * nothing; a neutral dismiss control is named for exactly this; a
 * click-catcher has no action of its own by construction
 * (`src/engine/click-catcher.ts`); the trigger is a toggle by ARIA contract,
 * but it is still a control, so it goes last. A gesture that throws — the
 * trigger under a catcher Playwright refuses to click through — is simply
 * the next gesture's turn.
 */
async function closeDisclosure(
  page: Page,
  trigger: Locator,
  baselineKeys: ReadonlySet<string>,
): Promise<CloseGesture | null> {
  const stillOpen = async (): Promise<boolean> => {
    await page.waitForTimeout(CLOSE_SETTLE_MS);
    const settled = await captureAxNodes(page);
    return settled.some((node) => !baselineKeys.has(keyOf(node)));
  };

  await page.keyboard.press('Escape').catch(() => undefined);
  if (!(await stillOpen())) return 'escape';

  const dialog = await openDialogNow(page).catch(() => null);
  if (dialog) {
    const dismiss = await findDismissButton(dialog, { policy: 'automatic' }).catch(() => null);
    if (dismiss) {
      await dismiss.locator.click({ timeout: 2_000 }).catch(() => undefined);
      if (!(await stillOpen())) return 'dismiss-button';
    }
  }

  const catcher = await findClickCatcher(page);
  if (catcher) {
    await page.mouse.click(catcher.point.x, catcher.point.y).catch(() => undefined);
    if (!(await stillOpen())) return 'click-catcher';
  }

  await trigger.click({ timeout: 2_000 }).catch(() => undefined);
  if (!(await stillOpen())) return 'trigger';

  return null;
}

function keyOf(node: AxNode): string {
  return `${node.role} ${node.name} ${node.value}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message.split('\n')[0] ?? error.message : String(error);
}
