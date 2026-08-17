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
 * Every probe is closed with Escape and verified collapsed before the next one
 * opens, so one dialog cannot mask the next candidate.
 *
 * Probing is diagnostic. Anything that goes wrong inside it is swallowed and
 * reported as a warning — it must never fail the generation it was helping.
 */

import type { Page } from 'playwright';

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

export interface ProbeResult {
  /** The control that was clicked, as a reader would name it. */
  trigger: string;
  /** Nodes that exist only while the disclosure is open. */
  revealed: AxNode[];
  /** True when the disclosure would not close again — see `probeInteractions`. */
  leftOpen?: boolean;
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

  for (const candidate of candidates.slice(0, maxProbes)) {
    try {
      const trigger = page.locator(candidate.selector).first();
      await trigger.click({ timeout: 2_000 });
      await page.waitForTimeout(settleMs);

      const after = await captureAxNodes(page);
      const revealed = after.filter((node) => !baselineKeys.has(keyOf(node)));

      // Escape closes menus, dialogs and listboxes in every library that marks
      // them correctly — which is the same set this probe is restricted to.
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      const settled = await captureAxNodes(page);
      const stillOpen = settled.some((node) => !baselineKeys.has(keyOf(node)));

      if (revealed.length > 0) {
        report.probes.push(
          stillOpen
            ? { trigger: candidate.label, revealed, leftOpen: true }
            : { trigger: candidate.label, revealed },
        );
      }

      if (stillOpen) {
        // Whatever opened is still there and would contaminate every later
        // probe. Stop rather than attribute one control's contents to another.
        report.warnings.push(
          `"${candidate.label}" would not close with Escape — stopped probing to avoid ` +
            'attributing its contents to another control',
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

function keyOf(node: AxNode): string {
  return `${node.role} ${node.name} ${node.value}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message.split('\n')[0] ?? error.message : String(error);
}
