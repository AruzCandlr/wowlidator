/**
 * Reachability crawling: does every link on this page actually go somewhere?
 *
 * ## What this answers that a flow cannot
 *
 * A flow proves one journey works. It says nothing about the nine other cards
 * on the same hub page, and writing ten near-identical flows to cover them is
 * how suites become unmaintainable. A crawl asks a different, cheaper question
 * of the whole page at once: **click each link, does a real page come back, can
 * we get home again.** That is the coverage a hub, a dashboard or a nav menu
 * actually needs, and it is worth almost nothing to write by hand.
 *
 * ## Only links, and only same-origin
 *
 * The safety model is the probe's, applied to navigation. A crawl follows
 * things that ARIA calls a `link` and that carry a URL — never a button, never
 * a form submit. Links are GETs; buttons are where "Delete", "Approve" and
 * "Submit" live. Combined with a same-origin restriction (inherited from the
 * workflow agent's `allowedOrigins` reasoning) a crawl cannot mutate the
 * application and cannot wander onto the public internet.
 *
 * `mailto:`, `tel:`, `#fragment` and duplicates are skipped — and *counted*, so
 * a crawl that visited three of eleven links never reads as a clean sweep.
 *
 * ## Returning is part of the test
 *
 * After each visit the crawler goes back, and checks it landed where it
 * started. A page you can enter but not leave is a real defect — a router that
 * loses history, a modal route that traps you — and it is invisible to any test
 * that navigates by URL instead of by clicking.
 */

import type { Page } from 'playwright';

import { captureAxNodes, type JitHealer } from '../healer/jit-healer.js';
import type { HealRecord, ProofBundleBuilder } from '../engine/proof-bundle.js';
import { relaxRoleName } from '../engine/selector.js';
import {
  DEFAULT_CAPTURE_DELAY_MS,
  captureEvidence,
  type ScreenshotMode,
} from '../engine/evidence.js';

export const DEFAULT_MAX_PAGES = 20;
/**
 * How long any single navigation, settle or click may take.
 *
 * Generous on purpose: a crawl walks pages nobody has profiled, and a route
 * that takes eight seconds to render is slow, not broken. The fast-path
 * argument ("a thing that works, works immediately") applies to a selector on
 * a page already loaded — it does not apply to loading the page.
 */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** Healer calls allowed per link before a crawl gives up on the control. */
export const DEFAULT_MAX_HEAL_ATTEMPTS = 5;
/** Schemes that are links but not pages. */
const NON_PAGE_SCHEMES = /^(mailto:|tel:|javascript:|blob:|data:)/i;

export interface DiscoveredLink {
  name: string;
  /** Empty for a button: where it goes is only knowable by clicking it. */
  url: string;
  /** Links are safe by construction; buttons are opt-in — see `followButtons`. */
  kind: 'link' | 'button';
}

/**
 * Labels that read like an action rather than a destination.
 *
 * Only applied to *short* names. A row button's accessible name is the whole
 * row — "Expense claim … Assign to me — ฿1,200" — and rejecting it because the
 * row happens to contain the word "assign" would refuse to crawl the very
 * pages this feature exists for. A control whose entire label is "Approve" is
 * a different animal, and that is what this catches.
 */
const ACTION_LABEL =
  /\b(delete|remove|approve|reject|submit|confirm|pay|purchase|checkout|send|assign|save|cancel|discard|archive|publish|revoke|sign out|log out)\b/i;
const SHORT_LABEL_CHARS = 28;

/** True when a control looks like it *does* something rather than goes somewhere. */
export function looksLikeAction(name: string): boolean {
  return name.trim().length <= SHORT_LABEL_CHARS && ACTION_LABEL.test(name);
}

export interface SkippedLink {
  name: string;
  url: string;
  reason: string;
}

export interface CrawlOptions {
  /** How many links to follow. The rest are reported as not visited. */
  maxPages?: number | undefined;
  /** Origins a crawl may enter. Defaults to the starting page's own. */
  allowedOrigins?: readonly string[] | undefined;
  /** Time budget for each navigation, settle and click. */
  timeoutMs?: number | undefined;
  /**
   * Repairs a link selector the crawl could not resolve.
   *
   * A crawl builds its own selectors from accessible names, so when one fails
   * to resolve the test author has nothing to fix — which makes this the one
   * place healing is not a convenience but the difference between a crawl that
   * covers a page and one that gives up on it.
   */
  healer?: JitHealer | null | undefined;
  /** Healer calls per link. Each one costs tokens, so it is bounded. */
  maxHealAttempts?: number | undefined;
  /**
   * Whether to photograph each destination. Default `all`.
   *
   * A crawl's whole claim is "a real page came back", and the cheapest way to
   * check that claim is to look at the page. Without this a crawl report is a
   * list of names and control counts — it can tell you a destination rendered
   * 42 accessible nodes and not that every one of them was a skeleton loader.
   */
  screenshots?: ScreenshotMode | undefined;
  /**
   * Pause before each of those photographs, so the destination has painted.
   *
   * This matters more here than anywhere else: a crawl navigates on every
   * step, and a navigation is exactly when the shutter is most likely to open
   * on an empty shell. See `evidence.ts`.
   */
  captureDelayMs?: number | undefined;
  /**
   * Also follow buttons that navigate.
   *
   * Off by default, and the default is the safety model: a link is a GET, a
   * button is anything. But plenty of applications route from table rows and
   * cards rendered as buttons — on such a page a link-only crawl is perfectly
   * honest and completely useless, reporting "0 links" about a page full of
   * destinations.
   *
   * When on, two guards remain: a control whose short label reads like an
   * action (`looksLikeAction`) is never clicked, and neither is a disclosure
   * (`aria-haspopup`), which belongs to `page-probe.ts`. The residual risk is
   * real and cannot be designed away — a button whose label says nothing about
   * what it does may do something — which is exactly why this is opt-in.
   */
  followButtons?: boolean | undefined;
  onLog?: ((line: string) => void) | undefined;
}

export interface VisitResult {
  link: DiscoveredLink;
  /** Where the browser actually ended up — redirects make this differ. */
  landedOn: string;
  ok: boolean;
  /** Interactive controls found on the destination. Zero means a dead page. */
  controls: number;
  /** True when going back returned us to the page we started from. */
  returned: boolean;
  /** How the link was finally followed — what the reader needs to trust it. */
  via: 'click' | 'healed-click' | 'url' | 'failed';
  /** Every repair attempted for this link, successful or not. */
  heals: HealAttempt[];
  /** True when history back failed and the crawl navigated home instead. */
  recovered?: boolean | undefined;
  error?: string | undefined;
}

/** One healer call, kept whether or not it worked. */
export interface HealAttempt {
  attempt: number;
  from: string;
  to?: string | undefined;
  ok: boolean;
  reasoning?: string | undefined;
  error?: string | undefined;
  latencyMs: number;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
}

export interface CrawlReport {
  origin: string;
  startUrl: string;
  visited: VisitResult[];
  skipped: SkippedLink[];
  /** Discovered but beyond `maxPages` — surfaced, never silently dropped. */
  notVisited: DiscoveredLink[];
}

/**
 * Give a page a moment to render before reading it.
 *
 * `domcontentloaded` fires long before a client-rendered application has put
 * anything on screen, and a crawl that reads the tree at that instant finds
 * zero links and reports a page with nothing on it — the same hydration race
 * that makes a `hidden` condition answer "yes" for a control that has simply
 * not been created yet. A flow author can insert a `waitFor`; a crawl is
 * autonomous, so it has to wait for itself.
 *
 * Best-effort by design: `networkidle` never settles on a page that polls, so
 * the timeout is a budget, not a requirement, and a page that stays busy is
 * still read rather than skipped.
 */
export async function settle(page: Page, timeoutMs = 3_000): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: timeoutMs }).catch(() => undefined);
  // A short floor for frameworks that paint after idle rather than before it.
  await page.waitForTimeout(150);
}

/**
 * Enumerate the links on the current page.
 *
 * Reads the accessibility tree rather than the DOM, so a crawl sees what a
 * screen-reader user sees: a `<div onclick>` that navigates is not a link, is
 * not announced as one, and is a finding in its own right rather than
 * something to quietly follow.
 */
export async function discoverLinks(
  page: Page,
  options: { followButtons?: boolean | undefined } = {},
): Promise<{
  links: DiscoveredLink[];
  skipped: SkippedLink[];
}> {
  await settle(page);
  const nodes = await captureAxNodes(page, 400);
  const links: DiscoveredLink[] = [];
  const skipped: SkippedLink[] = [];
  const seen = new Set<string>();
  const seenNames = new Set<string>();
  const here = new URL(page.url());

  for (const node of nodes) {
    if (node.role === 'button' && options.followButtons) {
      const name = node.name.trim();
      if (!name) continue;
      if (looksLikeAction(name)) {
        skipped.push({ name, url: '', reason: 'the label reads like an action, not a destination' });
        continue;
      }
      if (seenNames.has(name)) continue;
      seenNames.add(name);
      // No URL to record: where a button goes is only knowable by pressing it,
      // which is the whole reason this is opt-in.
      links.push({ name, url: '', kind: 'button' });
      continue;
    }
    if (node.role !== 'link') continue;
    const name = node.name || '(unnamed link)';
    if (!node.url) {
      skipped.push({ name, url: '', reason: 'the link carries no URL' });
      continue;
    }
    if (NON_PAGE_SCHEMES.test(node.url)) {
      skipped.push({ name, url: node.url, reason: 'not a page (mailto/tel/javascript)' });
      continue;
    }

    let resolved: URL;
    try {
      resolved = new URL(node.url, here);
    } catch {
      skipped.push({ name, url: node.url, reason: 'unparseable URL' });
      continue;
    }
    if (resolved.origin !== here.origin) {
      skipped.push({ name, url: resolved.href, reason: `different origin (${resolved.origin})` });
      continue;
    }
    // A pure fragment goes nowhere; a fragment on another path does.
    const target = `${resolved.origin}${resolved.pathname}${resolved.search}`;
    if (target === `${here.origin}${here.pathname}${here.search}`) {
      skipped.push({ name, url: resolved.href, reason: 'points at this same page' });
      continue;
    }
    if (seen.has(target)) continue;
    seen.add(target);
    links.push({ name, url: target, kind: 'link' });
  }

  return { links, skipped };
}

interface FollowOptions {
  timeoutMs: number;
  maxHealAttempts: number;
  healer?: JitHealer | undefined;
  onLog?: ((line: string) => void) | undefined;
}

interface FollowOutcome {
  via: VisitResult['via'];
  heals: HealAttempt[];
  /** The successful repair, in the shape the report already knows how to show. */
  heal?: HealRecord | undefined;
  error?: string | undefined;
}

/**
 * Follow one link, escalating only as far as it has to.
 *
 * The rungs are the runner's, adapted to a control the *crawl* wrote rather
 * than a test author: free retry first, then paid repair, then a degraded
 * fallback that is recorded as degraded. The last rung is the interesting one
 * — navigating to the href always "works", so calling that a success would let
 * a page full of broken cards report a clean sweep. It is recorded as
 * `via: 'url'` and the summary counts it separately.
 */
async function followLink(
  page: Page,
  selector: string,
  link: DiscoveredLink,
  options: FollowOptions,
): Promise<FollowOutcome> {
  const { timeoutMs, maxHealAttempts } = options;
  const heals: HealAttempt[] = [];

  const tryClick = async (candidate: string): Promise<boolean> => {
    const locator = page.locator(candidate).first();
    if ((await locator.count()) === 0) return false;
    await locator.click({ timeout: timeoutMs });
    return true;
  };

  // 1. As built.
  try {
    if (await tryClick(selector)) return { via: 'click', heals };
  } catch {
    // Fall through — a click that timed out is a link worth repairing.
  }

  // 2. Case-relaxed, still free. Chrome applies CSS `text-transform` to the
  //    accessible name it reports; Playwright's matcher does not.
  const relaxed = relaxRoleName(selector);
  if (relaxed) {
    try {
      if (await tryClick(relaxed)) return { via: 'click', heals };
    } catch {
      /* keep going */
    }
  }

  // 3. The healer, bounded. Each attempt is a model call, and each one is
  //    recorded whether it worked or not — a repair that failed is evidence
  //    about the page, not noise to hide.
  if (options.healer) {
    for (let attempt = 1; attempt <= maxHealAttempts; attempt++) {
      const startedMs = Date.now();
      try {
        const outcome = await options.healer.heal({
          page,
          action: 'click',
          selector,
          intent: `Follow the link "${link.name}" to ${link.url}`,
          failureReason:
            attempt === 1
              ? 'the link was found in the accessibility tree but its selector did not resolve'
              : `attempt ${attempt}: the previous repair did not resolve either`,
        });
        const record: HealAttempt = {
          attempt,
          from: selector,
          to: outcome.selector,
          ok: false,
          reasoning: outcome.suggestion.reasoning,
          latencyMs: outcome.latencyMs,
          inputTokens: outcome.suggestion.inputTokens,
          outputTokens: outcome.suggestion.outputTokens,
        };
        try {
          if (await tryClick(outcome.selector)) {
            record.ok = true;
            heals.push(record);
            options.onLog?.(`  healed "${link.name.slice(0, 40)}" → ${outcome.selector}`);
            return {
              via: 'healed-click',
              heals,
              heal: {
                from: selector,
                to: outcome.selector,
                strategy: outcome.suggestion.strategy,
                confidence: outcome.suggestion.confidence,
                reasoning: outcome.suggestion.reasoning,
                model: options.healer.model.id,
                latencyMs: outcome.latencyMs,
                inputTokens: outcome.suggestion.inputTokens,
                outputTokens: outcome.suggestion.outputTokens,
              },
            };
          }
          record.error = 'the repaired selector still did not resolve';
        } catch (error) {
          record.error = error instanceof Error ? error.message.split('\n')[0] : String(error);
        }
        heals.push(record);
      } catch (error) {
        heals.push({
          attempt,
          from: selector,
          ok: false,
          error: error instanceof Error ? error.message.split('\n')[0] : String(error),
          latencyMs: Date.now() - startedMs,
        });
        // A healer that cannot answer will not answer better on the next try.
        break;
      }
    }
  }

  // 4. Degraded: the route is reachable, the control is not. Only possible for
  //    a link — a button's destination is not knowable without pressing it, so
  //    an unclickable button is simply a failure.
  if (!link.url) {
    return { via: 'failed', heals, error: 'the button could not be clicked' };
  }
  try {
    await page.goto(link.url, { timeout: timeoutMs, waitUntil: 'domcontentloaded' });
    return {
      via: 'url',
      heals,
      error: 'the link could not be clicked; navigated to its URL instead',
    };
  } catch (error) {
    return {
      via: 'failed',
      heals,
      error: error instanceof Error ? error.message.split('\n')[0] : String(error),
    };
  }
}

/**
 * Visit every link on `page`, checking each destination and the way back.
 *
 * Records one bundle step per visit when a builder is supplied, so a crawl
 * produces the same proof bundle, HTML report, JUnit and history as any other
 * run — a crawl is a test, not a side tool.
 */
export async function crawlFrom(
  page: Page,
  options: CrawlOptions = {},
  bundle?: ProofBundleBuilder,
): Promise<CrawlReport> {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxHealAttempts = options.maxHealAttempts ?? DEFAULT_MAX_HEAL_ATTEMPTS;
  const screenshots = options.screenshots ?? 'all';
  const captureDelayMs = options.captureDelayMs ?? DEFAULT_CAPTURE_DELAY_MS;
  const startUrl = page.url();
  const origin = new URL(startUrl).origin;
  const allowed = new Set(options.allowedOrigins ?? [origin]);

  const { links: discovered, skipped } = await discoverLinks(page, {
    followButtons: options.followButtons,
  });
  // Links carry a destination and cannot act; buttons might be either. Spending
  // the page budget on certain navigation first means a truncated crawl still
  // covered the things it was sure about.
  const links = [...discovered].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'link' ? -1 : 1));
  options.onLog?.(`found ${links.length} link(s) to follow${skipped.length ? `, ${skipped.length} skipped` : ''}`);

  const visited: VisitResult[] = [];
  const notVisited: DiscoveredLink[] = [];
  // `maxPages` bounds *destinations reached*, not controls tried. A page whose
  // header is eight buttons would otherwise spend the whole budget discovering
  // that a theme toggle is not a destination, and never reach the rows the
  // crawl was pointed at. The separate attempt ceiling stops a page of a
  // hundred buttons from being exhaustively clicked in pursuit of the quota.
  const maxAttempts = maxPages * 3;
  let attempts = 0;

  // A queue, not a fixed list: visiting a control can change the page it came
  // from — a locale switch renames every control on it — so the candidate set
  // is re-read after each visit rather than trusted for the whole crawl.
  const queue: DiscoveredLink[] = [...links];
  const attempted = new Set<string>();
  const identity = (candidate: DiscoveredLink): string =>
    `${candidate.kind}|${candidate.name}|${candidate.url}`;

  while (queue.length > 0) {
    const link = queue.shift();
    if (!link) break;
    if (visited.length >= maxPages || attempts >= maxAttempts) {
      notVisited.push(link, ...queue.splice(0));
      break;
    }
    if (attempted.has(identity(link))) continue;
    attempted.add(identity(link));
    attempts += 1;
    if (link.url && !allowed.has(new URL(link.url).origin)) {
      skipped.push({ ...link, reason: 'origin not allowed' });
      continue;
    }

    // Is it still there?
    //
    // A crawl reads its candidates once and then spends minutes visiting them,
    // and a single control can invalidate the rest: clicking a language switch
    // re-renders every accessible name on the page. Found exactly that way —
    // one visit to "ไทย" and the next seventeen candidates were English names
    // that no longer existed, each one dutifully sent to the healer.
    //
    // So presence is checked first, and absence is *not* a healing problem. In
    // a flow, a selector that no longer resolves means the test drifted from
    // the app and a repair is the right answer. In a crawl the selector came
    // from the tree minutes ago, so absence means the page changed underneath
    // us — a repair would be paying a model to re-find something we should
    // simply look up again.
    const presenceSelector = `role=${link.kind}[name=${JSON.stringify(link.name)} i]`;
    if ((await page.locator(presenceSelector).count()) === 0) {
      skipped.push({
        ...link,
        reason: 'no longer on the page — something earlier in the crawl changed it',
      });
      options.onLog?.(`· ${link.name.slice(0, 60)} → gone since discovery`);
      continue;
    }

    const startedAt = new Date().toISOString();
    const started = Date.now();
    const result: VisitResult = {
      link,
      landedOn: '',
      ok: false,
      controls: 0,
      returned: false,
      via: 'failed',
      heals: [],
    };
    let heal: HealRecord | undefined;
    /** Evidence of the destination, captured while standing on it. */
    let shot: string | undefined;

    try {
      // Click the link rather than navigating to its href: the point is that
      // the *control works*, and a `goto` proves only that the route exists —
      // the weaker claim, and the one that misses a card whose click handler
      // is broken.
      //
      // Four rungs, cheapest first, mirroring the runner's ladder:
      //   1. the accessible-name selector, as built
      //   2. the same name matched case-insensitively (Chrome and Playwright
      //      disagree about case whenever CSS transforms text)
      //   3. the healer, up to `maxHealAttempts` times
      //   4. navigate to the href, recorded as a *degraded* success: the route
      //      exists, the control did not work, and the report must not blur
      //      those together
      const selector = `role=${link.kind}[name=${JSON.stringify(link.name)} i]`;
      const outcome = await followLink(page, selector, link, {
        timeoutMs,
        // A button might be a destination or might be furniture, and a repair
        // spent on furniture is a repair wasted. Links get the full budget
        // because a link that will not resolve is unambiguously a defect.
        maxHealAttempts: link.kind === 'link' ? maxHealAttempts : Math.min(maxHealAttempts, 1),
        ...(options.healer ? { healer: options.healer } : {}),
        ...(options.onLog ? { onLog: options.onLog } : {}),
      });
      result.via = outcome.via;
      result.heals = outcome.heals;
      heal = outcome.heal;
      if (outcome.via === 'failed') throw new Error(outcome.error ?? 'could not follow the link');

      // Wait for the navigation the click started, on the full budget. A
      // fixed settle is not enough: a heavy route can take seconds, and
      // measuring early reports the *origin* page as the destination and then
      // blames history for "not returning" to a page it never left. Same
      // mistake `expectUrl` used to make, one level up.
      await page
        .waitForURL((url) => url.toString() !== startUrl, { timeout: timeoutMs })
        .catch(() => undefined);
      await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => undefined);
      await settle(page, Math.min(timeoutMs, 5_000));
      result.landedOn = page.url();

      if (result.landedOn === startUrl) {
        // Clicked, nothing happened.
        //
        // For a *link* that is a defect: it promised a destination and did not
        // deliver one. For a *button* it is the ordinary case — a theme
        // toggle, a filter, a sort — and calling it a broken destination would
        // fill the report with failures about controls that were never
        // destinations, which is how a useful signal becomes noise nobody
        // reads. So a non-navigating button leaves the visited set entirely and
        // is reported as skipped, with the reason.
        if (link.kind === 'button') {
          skipped.push({ ...link, reason: 'the control did not navigate — not a destination' });
          options.onLog?.(`· ${link.name.slice(0, 60)} → not a destination`);
          // It may have toggled something on the way. Reload to put the page
          // back where the next candidate expects to find it.
          await page.goto(startUrl, { timeout: timeoutMs, waitUntil: 'domcontentloaded' });
          await settle(page, Math.min(timeoutMs, 3_000));
          continue;
        }

        result.error = 'the link was clicked but the page never navigated';
        result.controls = 0;
        result.ok = false;
        result.returned = true;
        visited.push(result);
        options.onLog?.(`✗ ${link.name.slice(0, 60)} → did not navigate`);
        // Still on the page we started from — which is exactly the finding, and
        // worth showing: a control that swallowed a click without navigating
        // often left some other visible trace.
        shot = await captureEvidence(page, screenshots, 'failure', captureDelayMs);
        bundle?.addStep({
          action: 'visitLink',
          intent: `Follow "${link.name}" and come back.`,
          selector: `role=${link.kind}[name=${JSON.stringify(link.name)} i]`,
          resolvedSelector: null,
          resolution: null,
          status: 'failed',
          startedAt,
          durationMs: Date.now() - started,
          url: startUrl,
          detail: { kind: link.kind, destination: link.url, via: result.via, healAttempts: result.heals.length },
          error: result.error,
          ...(heal ? { heal } : {}),
          ...(shot ? { screenshot: shot } : {}),
        });
        continue;
      }

      // "Did a real page come back" — an empty tree is a blank route, an error
      // boundary, or a redirect to nowhere, all of which look fine to a status
      // code.
      // Exclude the document node: every page has one, including a blank
      // route and a dead error boundary, so counting it would make "renders
      // nothing" impossible to detect — which is the check's whole purpose.
      const nodes = (await captureAxNodes(page, 200)).filter(
        (node) => node.role !== 'RootWebArea' && node.role !== 'WebArea',
      );
      result.controls = nodes.length;
      result.ok = nodes.length > 0;
      if (!result.ok) result.error = 'the destination rendered no accessible content';

      // While we are still standing on it. "A real page came back" is a claim
      // about what rendered, and a picture is the only part of the evidence a
      // reader can check for themselves — an accessible-node count cannot tell
      // you every one of them was a skeleton loader.
      shot = await captureEvidence(page, screenshots, result.ok ? 'routine' : 'failure', captureDelayMs);

      await page.goBack({ timeout: timeoutMs }).catch(() => undefined);
      await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => undefined);
      result.returned = page.url() === startUrl;
      if (!result.returned) {
        // Try once more: a router that pushes an extra entry needs two steps
        // back, and that is a nuisance rather than a defect.
        await page.goBack({ timeout: timeoutMs }).catch(() => undefined);
        await settle(page, Math.min(timeoutMs, 3_000));
        result.returned = page.url() === startUrl;
      }
      if (!result.returned) {
        // Recover so the next link starts from the right place, but keep the
        // finding: a page you cannot leave by going back is a real defect.
        result.recovered = true;
        await page.goto(startUrl, { timeout: timeoutMs, waitUntil: 'domcontentloaded' });
        await settle(page, Math.min(timeoutMs, 3_000));
      }
    } catch (error) {
      result.error = error instanceof Error ? error.message.split('\n')[0] : String(error);
      await page.goto(startUrl, { timeout: timeoutMs, waitUntil: 'domcontentloaded' }).catch(() => undefined);
    }

    visited.push(result);
    options.onLog?.(
      `${result.ok ? '✓' : '✗'} ${link.name.slice(0, 60)} → ${result.landedOn || link.url}` +
        (result.returned ? '' : ' (could not return)'),
    );

    // Re-read the page we came back to. Costs one accessibility capture and no
    // tokens, and it is the difference between a crawl that survives a control
    // with global effects and one that reports 17 phantom failures after it.
    try {
      const fresh = await discoverLinks(page, { followButtons: options.followButtons });
      for (const candidate of fresh.links) {
        if (attempted.has(identity(candidate))) continue;
        if (queue.some((queued) => identity(queued) === identity(candidate))) continue;
        queue.push(candidate);
      }
    } catch {
      // Diagnostic: a re-read that fails leaves the queue as it was rather
      // than ending the crawl.
    }

    bundle?.addStep({
      action: 'visitLink',
      intent: `Follow "${link.name}" and come back.`,
      selector: `role=link[name=${JSON.stringify(link.name)} i]`,
      resolvedSelector: null,
      resolution: null,
      status: result.ok && result.returned ? 'passed' : 'failed',
      startedAt,
      durationMs: Date.now() - started,
      url: result.landedOn || link.url,
      detail: {
        kind: link.kind,
        destination: link.url || result.landedOn,
        landedOn: result.landedOn,
        controls: result.controls,
        returned: result.returned,
        via: result.via,
        healAttempts: result.heals.length,
        ...(result.recovered ? { recoveredByNavigating: true } : {}),
      },
      // Surfacing the repair is the point: a crawl that only got there because
      // a model rewrote the selector passed, but the page still drifted, and
      // the report has to say so rather than showing a clean tick.
      ...(heal ? { heal } : {}),
      ...(shot ? { screenshot: shot } : {}),
      ...(result.error || !result.returned
        ? {
            error:
              result.error ??
              `followed the link but could not get back to ${startUrl} — history did not restore the previous page`,
          }
        : {}),
    });
  }

  return { origin, startUrl, visited, skipped, notVisited };
}

/** Human-readable digest for the CLI. */
export function formatCrawlReport(report: CrawlReport): string {
  const broken = report.visited.filter((v) => !v.ok);
  const trapped = report.visited.filter((v) => v.ok && !v.returned);
  const healed = report.visited.filter((v) => v.via === 'healed-click');
  const degraded = report.visited.filter((v) => v.via === 'url');
  const healCalls = report.visited.reduce((n, v) => n + v.heals.length, 0);
  const lines = [
    `  crawled    ${report.visited.length} link(s) from ${report.startUrl}`,
    `  reachable  ${report.visited.length - broken.length}/${report.visited.length}`,
  ];
  if (healCalls > 0) {
    // What the healer did, said out loud: a crawl that only got through
    // because a model rewrote selectors is a passing run *and* a drifting
    // page, and a reader needs both halves.
    lines.push(
      `  self-heal  ${healCalls} repair call(s), ${healed.length} link(s) recovered` +
        `${healed.length > 0 ? ' — the page has drifted from its accessible names' : ''}`,
    );
    for (const visit of report.visited.filter((v) => v.heals.length > 0)) {
      const last = visit.heals[visit.heals.length - 1];
      lines.push(
        `             "${visit.link.name.slice(0, 44)}" — ${visit.heals.length} attempt(s)` +
          `${last?.ok ? `, fixed with ${last.to}` : ', not repaired'}`,
      );
    }
  }
  if (degraded.length > 0) {
    lines.push(
      `  degraded   ${degraded.length} link(s) could not be clicked at all — reached by URL instead`,
    );
  }
  if (trapped.length > 0) {
    lines.push(`  no way back ${trapped.length} page(s) did not restore on history back`);
  }
  if (report.skipped.length > 0) {
    lines.push(`  skipped    ${report.skipped.length} (external, non-page, or self-referencing)`);
  }
  if (report.notVisited.length > 0) {
    // Never a silent cap: a truncated crawl otherwise reads as a clean sweep.
    lines.push(`  not visited ${report.notVisited.length} link(s) beyond the page budget`);
  }
  return lines.join('\n');
}
