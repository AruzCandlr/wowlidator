/**
 * Browser lifecycle from inside the CLI (`src/browser/chrome.ts`).
 *
 * This logic used to live in `wowlidator.sh`, where the only way to test it was to
 * run it. Moving it into the CLI means the rules that decide whether anything
 * can run at all are covered by the same suite as everything else.
 *
 * Split by cost: the decisions (which port, whose profile, where Chrome lives)
 * are pure and run always; the parts that start and kill real browsers stay
 * gated behind `WOWLIDATOR_CHROME_TESTS=1`, because doing that unasked on someone's
 * laptop is rude in a way "skipped because no browser" is not.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  CHROME_CANDIDATES,
  cdpAnswers,
  cdpDrivable,
  chromeIsHeadless,
  chromeIsOurs,
  chromeMatchPattern,
  ensureChrome,
  ensureChromePool,
  findChrome,
  portOf,
  stopChrome,
  waitForApp,
} from '../src/browser/chrome.js';
import { poolMember } from '../src/browser/pool.js';

describe('chrome — decisions', () => {
  it('reads the port out of a CDP url, and falls back sensibly', () => {
    assert.equal(portOf('http://localhost:9333'), '9333');
    assert.equal(portOf('http://127.0.0.1:9222'), '9222');
    // Chrome's own default, for a URL that names no port.
    assert.equal(portOf('http://localhost'), '9222');
    assert.equal(portOf('nonsense'), '9222');
  });

  it('matches a browser by port AND profile, never by port alone', () => {
    // Matching on the port alone would make `--stop-chrome` capable of killing
    // a browser that merely shares a number with ours.
    const pattern = chromeMatchPattern('9222', '/tmp/wowlidator-chrome-profile');
    assert.match(pattern, /remote-debugging-port=9222/);
    assert.match(pattern, /--user-data-dir=\/tmp\/wowlidator-chrome-profile/);
  });

  it('does not claim a browser on somebody else profile', async () => {
    const ours = await chromeIsOurs('9222', '/tmp/definitely-not-a-real-wowlidator-profile-xyz');
    assert.equal(ours, false);
  });

  it('looks for Chrome in the usual places, most specific first', async () => {
    assert.ok(CHROME_CANDIDATES.length > 3);
    assert.ok(CHROME_CANDIDATES[0]?.includes('Google Chrome'));
    // An explicit path that does not exist must not be returned just because
    // it was asked for.
    const found = await findChrome('/no/such/chrome');
    assert.notEqual(found, '/no/such/chrome');
  });

  it('reports a dead port as neither answering nor driveable', async () => {
    assert.equal(await cdpAnswers('http://127.0.0.1:9', 300), false);
    assert.equal(await cdpDrivable('http://127.0.0.1:9'), false);
  });

  it('gives up on an app that never answers, rather than hanging', async () => {
    const started = Date.now();
    const ready = await waitForApp('http://127.0.0.1:9/nothing', 1_200);
    assert.equal(ready, false);
    assert.ok(Date.now() - started < 6_000, 'the timeout must be a budget, not a suggestion');
  });

  it('counts the wait down on the console, one line per second, and stops at the deadline', async () => {
    const lines: string[] = [];
    const ready = await waitForApp('http://127.0.0.1:9/nothing', 2_500, (l) => lines.push(l));
    assert.equal(ready, false);
    assert.deepEqual(lines, [
      'waiting for http://127.0.0.1:9/nothing … 3s left',
      'waiting for http://127.0.0.1:9/nothing … 2s left',
      'waiting for http://127.0.0.1:9/nothing … 1s left',
    ]);
  });
});

/**
 * An endpoint that answers `/json/version` and can do nothing else — what a
 * stale Chrome looks like from the outside. Its argv decides whether wowlidator
 * should recognise it as its own.
 */
async function startFakeCdp(dir: string, port: number, argvTag: string): Promise<void> {
  const script = join(dir, `fake-cdp-${port}.mjs`);
  await writeFile(
    script,
    `import { createServer } from 'node:http';
createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ Browser: 'Chrome/150.0.0.0' }));
}).listen(${port}, '127.0.0.1');
`,
    'utf8',
  );
  spawn(process.execPath, [script, argvTag], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 20; i++) {
    if (await cdpAnswers(`http://127.0.0.1:${port}`, 500)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
}

const gated = process.env['WOWLIDATOR_CHROME_TESTS'] === '1';
const skip = gated
  ? false
  : 'set WOWLIDATOR_CHROME_TESTS=1 to run these — they start and kill real Chrome processes';

describe('chrome — starting and recycling (real browsers)', { skip }, () => {
  const PORT = 9347;
  const CDP = `http://127.0.0.1:${PORT}`;
  const PROFILE = join(tmpdir(), 'wowlidator-chrome-test-profile');
  let dir: string;

  const cleanup = async (): Promise<void> => {
    await stopChrome(String(PORT), PROFILE);
    await new Promise<void>((resolve) => {
      spawn('pkill', ['-f', `fake-cdp-${PORT}`]).on('close', () => resolve());
    });
    for (let i = 0; i < 20 && (await cdpAnswers(CDP, 300)); i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
  };

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wowlidator-chrome-'));
    await cleanup();
  });

  after(async () => {
    await cleanup();
    await rm(dir, { recursive: true, force: true });
    await rm(PROFILE, { recursive: true, force: true });
  });

  it('starts a browser when nothing is listening', async () => {
    const result = await ensureChrome({ cdpUrl: CDP, profile: PROFILE, headless: true });
    assert.equal(result.status, 'started', result.message);
    assert.equal(result.startedByUs, true);
    assert.equal(await cdpDrivable(CDP), true, 'and it must actually be driveable');
    await cleanup();
  });

  it('uses a healthy browser as it finds it', async () => {
    await ensureChrome({ cdpUrl: CDP, profile: PROFILE, headless: true });
    const second = await ensureChrome({ cdpUrl: CDP, profile: PROFILE, headless: true });
    assert.equal(second.status, 'ready', second.message);
    // Only the run that started it may stop it.
    assert.equal(second.startedByUs, false);
    await cleanup();
  });

  it('restarts a stale browser that is on our own profile', async () => {
    await startFakeCdp(dir, PORT, `--remote-debugging-port=${PORT} --user-data-dir=${PROFILE}`);
    const result = await ensureChrome({ cdpUrl: CDP, profile: PROFILE, headless: true });
    assert.equal(result.status, 'restarted', result.message);
    assert.equal(await cdpDrivable(CDP), true);
    await cleanup();
  });

  it('refuses to touch a browser that is not ours, and says what to do', async () => {
    await startFakeCdp(dir, PORT, 'somebody-elses-browser');
    const result = await ensureChrome({ cdpUrl: CDP, profile: PROFILE, headless: true });

    assert.equal(result.status, 'blocked', result.message);
    assert.match(result.message, /will not hand over a browser context/);
    assert.match(result.message, /has been left\s+alone/);
    // The impostor must still be running: those are somebody's tabs.
    assert.equal(await cdpAnswers(CDP, 500), true);
    await cleanup();
  });
});

/**
 * Window mode.
 *
 * `--headless` used to apply only to a browser wowlidator *started*, so the
 * second run of the day silently kept the window from the first: you pass the
 * flag, windows keep appearing, and nothing says why.
 */
describe('chrome — a pool of browsers (real browsers)', { skip }, () => {
  const PORT = 9350;
  const CDP = `http://127.0.0.1:${PORT}`;
  const PROFILE = join(tmpdir(), 'wowlidator-chrome-pool-profile');
  const members = [0, 1, 2].map((i) => poolMember(CDP, PROFILE, i));

  const cleanup = async (): Promise<void> => {
    for (const m of members) {
      await stopChrome(portOf(m.cdpUrl), m.profile);
      for (let i = 0; i < 20 && (await cdpAnswers(m.cdpUrl, 300)); i++) {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  };

  before(cleanup);
  after(async () => {
    await cleanup();
    for (const m of members) await rm(m.profile, { recursive: true, force: true });
  });

  it('starts n browsers on consecutive ports, each driveable, the extras headless', async () => {
    const results = await ensureChromePool({ cdpUrl: CDP, profile: PROFILE }, 3);
    assert.deepEqual(
      results.map((r) => r.status),
      ['started', 'started', 'started'],
    );
    assert.deepEqual(
      results.map((r) => r.cdpUrl),
      members.map((m) => m.cdpUrl),
    );
    for (const m of members) assert.equal(await cdpDrivable(m.cdpUrl), true);
    // No preference for the primary; the extras run without a window.
    assert.equal(await chromeIsHeadless(portOf(members[1]!.cdpUrl), members[1]!.profile), true);
    assert.equal(await chromeIsHeadless(portOf(members[2]!.cdpUrl), members[2]!.profile), true);
  });

  it('stops one member without touching its neighbours', async () => {
    await stopChrome(portOf(members[1]!.cdpUrl), members[1]!.profile);
    for (let i = 0; i < 20 && (await cdpAnswers(members[1]!.cdpUrl, 300)); i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(await cdpAnswers(members[1]!.cdpUrl), false);
    assert.equal(await cdpAnswers(members[0]!.cdpUrl), true);
    assert.equal(await cdpAnswers(members[2]!.cdpUrl), true);
  });
});

describe('chrome — running without a window (real browsers)', { skip }, () => {
  const PORT = 9348;
  const CDP = `http://127.0.0.1:${PORT}`;
  const PROFILE = join(tmpdir(), 'wowlidator-chrome-headless-profile');

  const cleanup = async (): Promise<void> => {
    await stopChrome(String(PORT), PROFILE);
    for (let i = 0; i < 20 && (await cdpAnswers(CDP, 300)); i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
  };

  before(cleanup);
  after(async () => {
    await cleanup();
    await rm(PROFILE, { recursive: true, force: true });
  });

  it('reads the mode off the process, because /json/version cannot tell', async () => {
    // `--headless=new` reports `Chrome/<version>`, exactly as a headful browser
    // does. Anything keying off the product string would read every headless
    // browser as windowed and restart it on every run.
    await ensureChrome({ cdpUrl: CDP, profile: PROFILE, headless: true });
    assert.equal(await chromeIsHeadless(String(PORT), PROFILE), true);

    const version = (await (await fetch(`${CDP}/json/version`)).json()) as { Browser: string };
    assert.doesNotMatch(version.Browser, /Headless/, 'the trap this avoids');
    await cleanup();
  });

  it('opens one blank tab, not the Google new-tab page', async () => {
    // Given no URL, Chrome opens chrome://newtab — a Google search box and its
    // one-google-bar iframe — on a profile nobody browses with.
    await ensureChrome({ cdpUrl: CDP, profile: PROFILE, headless: true });
    const tabs = (await (await fetch(`${CDP}/json/list`)).json()) as { type: string; url: string }[];
    const pages = tabs.filter((t) => t.type === 'page');

    assert.equal(pages.length, 1);
    assert.equal(pages[0]?.url, 'about:blank');
    assert.equal(pages.some((t) => t.url.includes('newtab')), false);
    await cleanup();
  });

  it('restarts a windowed browser of ours when asked for no window', async () => {
    await ensureChrome({ cdpUrl: CDP, profile: PROFILE, headless: false });
    assert.equal(await chromeIsHeadless(String(PORT), PROFILE), false);

    const second = await ensureChrome({ cdpUrl: CDP, profile: PROFILE, headless: true });

    assert.equal(second.status, 'restarted', second.message);
    assert.match(second.message, /without a window/);
    assert.equal(await chromeIsHeadless(String(PORT), PROFILE), true);
    assert.equal(await cdpDrivable(CDP), true);
    await cleanup();
  });

  it('leaves a running browser alone when no mode was asked for', async () => {
    // Undefined is not false. Restarting someone's browser to give it a window
    // they never asked about would be the same overreach in the other direction.
    await ensureChrome({ cdpUrl: CDP, profile: PROFILE, headless: true });
    const second = await ensureChrome({ cdpUrl: CDP, profile: PROFILE });

    assert.equal(second.status, 'ready', second.message);
    assert.equal(await chromeIsHeadless(String(PORT), PROFILE), true, 'still headless');
    await cleanup();
  });
});
