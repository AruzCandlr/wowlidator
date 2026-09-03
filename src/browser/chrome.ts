/**
 * Getting a driveable Chrome, from inside the CLI.
 *
 * ## Why this is not a shell script any more
 *
 * It was one: `wowlidator.sh` found Chrome, started it, waited for the port, opened
 * a tab and only then ran wowlidator. That worked, and it split the project in two
 * — the interesting half in TypeScript with 293 tests, the half that decides
 * whether anything can run at all in bash, reachable only by executing it.
 * Every rule here (what "ready" means, whose browser may be restarted) was
 * learned the same way and belongs with the code that depends on it.
 *
 * ## Answering is not the same as being driveable
 *
 * The rule this module exists for: **a Chrome that responds on its debugging
 * port is not necessarily one Playwright can take over.** A browser left
 * running for a day or two keeps serving `/json/version` perfectly while
 * refusing to hand over browser-level context management, and the failure
 * surfaces much later as `Browser.setDownloadBehavior: Browser context
 * management is not supported` on every single step — an error that reads like
 * a missing `--remote-debugging-port` and is not one. So readiness is proved
 * by actually connecting and disconnecting, never by a status check.
 *
 * ## Whose browser is it
 *
 * A stale browser on **wowlidator's own profile** is recycled: that is
 * housekeeping. A stale browser on any other profile is reported, never
 * touched — those are somebody's tabs. The distinction is made on the process
 * command line, and `pgrep -f` is used rather than `ps | grep` because the
 * pattern appears in the grep's own arguments and a piped grep matches itself,
 * reporting every profile as ours.
 */

import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

import { poolMember } from './pool.js';

const run = promisify(execFile);

export const DEFAULT_CHROME_PROFILE = '/tmp/wowlidator-chrome-profile';
export const DEFAULT_BOOT_TIMEOUT_MS = 30_000;

/** Where Chrome usually lives, most specific first. */
export const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
] as const;

export type EnsureStatus =
  /** Already there and driveable — nothing was touched. */
  | 'ready'
  /** Nothing was listening, so one was started. */
  | 'started'
  /** Something was listening but could not be driven, and it was ours to recycle. */
  | 'restarted'
  /** Something was listening, could not be driven, and was not ours. */
  | 'blocked'
  /** No Chrome binary could be found. */
  | 'missing-chrome'
  /** A browser was started but still could not be driven. */
  | 'failed';

export interface EnsureResult {
  status: EnsureStatus;
  cdpUrl: string;
  /** True when this process started the browser — the only one it may stop. */
  startedByUs: boolean;
  /** What happened, in the words a user should see. */
  message: string;
}

export interface EnsureOptions {
  cdpUrl: string;
  profile?: string | undefined;
  /** Run without a window — the right default on a CI runner, wrong on a desk. */
  headless?: boolean | undefined;
  bootTimeoutMs?: number | undefined;
  /** Path to a Chrome binary, when the usual places are wrong. */
  binary?: string | undefined;
  onLog?: ((line: string) => void) | undefined;
}

/** Port from a CDP URL, for process matching and messages. */
export function portOf(cdpUrl: string): string {
  try {
    return new URL(cdpUrl).port || '9222';
  } catch {
    return '9222';
  }
}

/** Does anything answer on the debugging port? */
export async function cdpAnswers(cdpUrl: string, timeoutMs = 2_000): Promise<boolean> {
  try {
    const response = await fetch(`${cdpUrl}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Can Playwright actually take this browser over?
 *
 * The whole point of the module. Imported lazily so that a command which never
 * touches a browser does not pay for loading Playwright.
 */
export async function cdpDrivable(cdpUrl: string): Promise<boolean> {
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.connectOverCDP(cdpUrl);
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

/** The command line a browser started by wowlidator carries. */
export function chromeMatchPattern(port: string, profile: string): string {
  return `remote-debugging-port=${port} --user-data-dir=${profile}`;
}

/**
 * Is the browser on this port running without a window?
 *
 * Read off the process command line, not `/json/version`. That was the obvious
 * place and it does not work: `--headless=new` reports `Chrome/151.0.7922.76`,
 * exactly as a headful browser does — the `HeadlessChrome/…` product string
 * belonged to the old headless implementation. So this asks the same question
 * `chromeIsOurs` asks, in the same way, of the same process.
 *
 * `null` when there is no matching process to inspect — nothing is claimed
 * about a browser this did not start.
 */
export async function chromeIsHeadless(port: string, profile: string): Promise<boolean | null> {
  try {
    // `-fl`, not `-af`. BSD pgrep has no `-a`, and rather than refusing it it
    // prints bare pids and exits 0 — so the command lines come back empty, every
    // browser reads as windowed, and each run restarts a perfectly good one.
    const { stdout } = await run('pgrep', ['-fl', chromeMatchPattern(port, profile)]);
    // The pattern matches Chrome's helper processes too, and a renderer does not
    // carry `--headless` whatever the browser is doing. The browser process is
    // the one with no `--type=`.
    const browser = stdout
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.includes('--type='));
    if (browser.length === 0) return null;
    return browser.some((line) => line.includes('--headless'));
  } catch {
    return null;
  }
}

/**
 * Is the browser on this port one of ours?
 *
 * `pgrep -f`, not `ps | grep`: the pattern appears in the grep's own argument
 * list, so a piped grep matches itself and calls every profile ours.
 */
export async function chromeIsOurs(port: string, profile: string): Promise<boolean> {
  try {
    await run('pgrep', ['-f', chromeMatchPattern(port, profile)]);
    return true;
  } catch {
    return false;
  }
}

/** Stop only a browser matching our own profile. */
export async function stopChrome(port: string, profile: string): Promise<void> {
  try {
    await run('pkill', ['-f', chromeMatchPattern(port, profile)]);
  } catch {
    // pkill exits non-zero when nothing matched, which is a fine outcome.
  }
}

/** First Chrome binary that exists, or null. */
export async function findChrome(explicit?: string): Promise<string | null> {
  const candidates = explicit ? [explicit, ...CHROME_CANDIDATES] : [...CHROME_CANDIDATES];
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep looking.
    }
  }
  return null;
}

/**
 * Launch Chrome, detached, and wait for the port to answer.
 *
 * Detached and `unref`'d on purpose: the browser must outlive the command that
 * started it, or the next `wowlidator run` finds nothing there. Stopping it is
 * `--stop-chrome`'s job, and only for a browser this process started.
 */
export async function startChrome(options: EnsureOptions & { binary: string }): Promise<boolean> {
  const port = portOf(options.cdpUrl);
  const profile = options.profile ?? DEFAULT_CHROME_PROFILE;
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
  if (options.headless) {
    args.push('--headless=new');
    // Containers only, and opt-in. `--no-sandbox` used to ride along with
    // headless, on the assumption that headless means CI — but headless is also
    // how someone keeps the browser out of their way on a desktop all day, and
    // turning off the renderer sandbox for a browser that is about to load the
    // application under test is not a windowing decision. Chrome's headless
    // mode sandboxes perfectly well outside Docker.
    if (process.env['WOWLIDATOR_CHROME_NO_SANDBOX'] === '1') {
      args.push('--no-sandbox', '--disable-dev-shm-usage');
    }
  }
  // Open one blank tab, explicitly.
  //
  // Given no URL, Chrome opens its startup page — which is `chrome://newtab`,
  // and which renders Google's search box and one-google-bar iframe. Every run
  // that had to start a browser therefore popped what looks like "a random
  // Google tab", on a profile nobody browses with. `ensureTab` already knows a
  // blank tab is the right thing for a browser wowlidator drives; this is the
  // same decision made at launch, before the wrong tab exists.
  args.push('about:blank');

  spawn(options.binary, args, { detached: true, stdio: 'ignore' }).unref();

  const deadline = Date.now() + (options.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS);
  while (Date.now() < deadline) {
    if (await cdpAnswers(options.cdpUrl)) return true;
    await sleep(300);
  }
  return false;
}

/**
 * A Chrome with zero tabs accepts connections and cannot hand out a page, and
 * the resulting error blames the debugging port. One blank tab avoids the
 * whole confusion; it happens every time someone closes their last tab.
 */
export async function ensureTab(cdpUrl: string): Promise<void> {
  try {
    const response = await fetch(`${cdpUrl}/json/list`, { signal: AbortSignal.timeout(3_000) });
    const tabs = (await response.json()) as unknown[];
    if (Array.isArray(tabs) && tabs.length > 0) return;
  } catch {
    return; // Not answering is a different problem, already handled.
  }
  await fetch(`${cdpUrl}/json/new?about:blank`, {
    method: 'PUT',
    signal: AbortSignal.timeout(3_000),
  }).catch(() =>
    fetch(`${cdpUrl}/json/new?about:blank`, { signal: AbortSignal.timeout(3_000) }).catch(
      () => undefined,
    ),
  );
}

/**
 * Make sure there is a browser wowlidator can drive, starting or recycling one if
 * that is safe to do.
 */
export async function ensureChrome(options: EnsureOptions): Promise<EnsureResult> {
  const { cdpUrl } = options;
  const profile = options.profile ?? DEFAULT_CHROME_PROFILE;
  const port = portOf(cdpUrl);
  const log = options.onLog;

  if (await cdpAnswers(cdpUrl)) {
    if (await cdpDrivable(cdpUrl)) {
      // Asking for no window only ever applied to a browser this *started*, so
      // the second run of the day silently kept the window from the first — you
      // pass --headless, windows keep appearing, and nothing says why. The mode
      // is part of what "a browser wowlidator can drive" means, so a mismatch is
      // a reason to recycle, exactly like an undriveable one. Only ever on our
      // own profile, and only when a mode was actually asked for: with no
      // preference stated, whatever is running is right.
      const wrongMode =
        options.headless !== undefined &&
        (await chromeIsHeadless(port, profile)) === !options.headless;

      if (!wrongMode) {
        await ensureTab(cdpUrl);
        return {
          status: 'ready',
          cdpUrl,
          startedByUs: false,
          message: `using the browser already running on port ${port}`,
        };
      }

      const wanted = options.headless ? 'without a window' : 'with a window';
      if (!(await chromeIsOurs(port, profile))) {
        return {
          status: 'ready',
          cdpUrl,
          startedByUs: false,
          message:
            `using the browser already running on port ${port} — it is not the profile\n` +
            `wowlidator manages, so it has been left alone and is NOT running ${wanted}.`,
        };
      }
      log?.(`the Chrome on port ${port} is not running ${wanted} — restarting it`);
      return await restart(options, { port, profile });
    }

    if (!(await chromeIsOurs(port, profile))) {
      return {
        status: 'blocked',
        cdpUrl,
        startedByUs: false,
        message:
          `something is listening on port ${port} but will not hand over a browser context.\n` +
          'This is what a long-running Chrome looks like once it goes stale: the port still\n' +
          'answers, so nothing looks wrong until every step fails.\n\n' +
          `It is not the profile wowlidator manages (${profile}), so your browser has been left\n` +
          'alone. Restart that Chrome yourself, or use another port:\n\n' +
          `  wowlidator run … --cdp http://localhost:9333`,
      };
    }

    log?.(`the Chrome on port ${port} answers but cannot be driven — restarting it`);
    return await restart(options, { port, profile });
  }

  const binary = await findChrome(options.binary);
  if (!binary) return missingChrome(cdpUrl, port, profile);

  log?.('starting Chrome…');
  if (!(await startChrome({ ...options, binary }))) {
    return {
      status: 'failed',
      cdpUrl,
      startedByUs: true,
      message: `Chrome did not open port ${port} within the boot timeout`,
    };
  }
  if (!(await cdpDrivable(cdpUrl))) {
    return {
      status: 'failed',
      cdpUrl,
      startedByUs: true,
      message: `Chrome opened port ${port} but cannot be driven — try removing ${profile}`,
    };
  }
  await ensureTab(cdpUrl);
  return { status: 'started', cdpUrl, startedByUs: true, message: `started Chrome on port ${port}` };
}

/** One browser of a pool, with where it lives so it can be stopped later. */
export interface PoolMember extends EnsureResult {
  profile: string;
}

/**
 * A pool of browsers for a parallel run — the primary on `options.cdpUrl`
 * plus `count - 1` more on the ports after it, each on its own profile
 * (`poolMember`). Every member goes through `ensureChrome`, so a stale one is
 * recycled and one that belongs to somebody else is reported and left alone,
 * exactly as the primary is.
 *
 * The extras run headless unless a window was explicitly asked for
 * (`--no-headless`): with no preference stated the primary is left as it is,
 * but four more windows nobody asked for is not "as it is". Members are
 * started in parallel — Chrome boots in seconds and a pool of five booted one
 * after another would cost the run what it exists to save.
 */
export async function ensureChromePool(options: EnsureOptions, count: number): Promise<PoolMember[]> {
  const profile = options.profile ?? DEFAULT_CHROME_PROFILE;
  const wanted = Math.max(1, Math.floor(count));
  const members = Array.from({ length: wanted }, (_, i) => poolMember(options.cdpUrl, profile, i));
  return Promise.all(
    members.map(async (member, i) => {
      const result = await ensureChrome({
        ...options,
        cdpUrl: member.cdpUrl,
        profile: member.profile,
        headless: i === 0 ? options.headless : options.headless ?? true,
        onLog: options.onLog ? (line): void => options.onLog?.(i === 0 ? line : `[browser ${i + 1}] ${line}`) : undefined,
      });
      return { ...result, profile: member.profile };
    }),
  );
}

/**
 * Stop the browser on this port and start a fresh one in its place.
 *
 * Shared by the two reasons to do it — a stale browser that will not hand over
 * a context, and one running in the wrong window mode. Both have already
 * established the browser is wowlidator's own to recycle; this must never be
 * called before that check.
 */
async function restart(
  options: EnsureOptions,
  where: { port: string; profile: string },
): Promise<EnsureResult> {
  const { cdpUrl } = options;
  const { port, profile } = where;

  await stopChrome(port, profile);
  const gone = Date.now() + 15_000;
  while (Date.now() < gone && (await cdpAnswers(cdpUrl))) await sleep(300);

  const binary = await findChrome(options.binary);
  if (!binary) return missingChrome(cdpUrl, port, profile);
  if (!(await startChrome({ ...options, binary }))) {
    return { status: 'failed', cdpUrl, startedByUs: true, message: `Chrome did not open port ${port}` };
  }
  if (!(await cdpDrivable(cdpUrl))) {
    return {
      status: 'failed',
      cdpUrl,
      startedByUs: true,
      message: `restarted Chrome on port ${port} but it still cannot be driven — try removing ${profile}`,
    };
  }
  await ensureTab(cdpUrl);
  return {
    status: 'restarted',
    cdpUrl,
    startedByUs: true,
    message:
      `restarted Chrome on port ${port}` + (options.headless ? ' — running without a window' : ''),
  };
}

function missingChrome(cdpUrl: string, port: string, profile: string): EnsureResult {
  return {
    status: 'missing-chrome',
    cdpUrl,
    startedByUs: false,
    message:
      'could not find Chrome.\n\nInstall it, or start your own with a debugging port:\n\n' +
      `  <your-chrome> --remote-debugging-port=${port} --user-data-dir=${profile}`,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait until a URL responds — for an application still booting.
 *
 * Any response counts, including a 4xx or a redirect: the question is whether
 * something is serving, and judging the answer is the test's job, not this
 * function's.
 */
export async function waitForApp(
  url: string,
  timeoutMs = 90_000,
  onLog?: (line: string) => void,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let announced = false;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(3_000), redirect: 'follow' });
      return true;
    } catch {
      if (!announced) {
        onLog?.(`waiting for ${url} …`);
        announced = true;
      }
      await sleep(1_000);
    }
  }
  return false;
}
