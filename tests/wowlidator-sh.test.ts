/**
 * `wowlidator.sh`, now a shim over the CLI.
 *
 * The browser lifecycle it used to own moved into `src/browser/chrome.ts` and
 * is covered by `tests/chrome.test.ts`. What is left to test here is the shim's
 * only remaining job: translating the old invocation into the new one without
 * losing anything. The heavy scenarios live with the code that runs them now.
 *
 * Original header follows, for the record:
 *
 * `wowlidator.sh`, the one-command wrapper (spec T3).
 *
 * **Opt in with `WOWLIDATOR_SH_TESTS=1`.** These tests start and kill real Chrome
 * processes. That is fine on a CI runner and rude on a developer's laptop, so
 * they are gated rather than merely skipped-if-unavailable like the browser
 * tier — the difference between "cannot run" and "should not run unasked".
 * They use a dedicated port and profile so they can never touch the browser
 * another test, or a human, is using.
 *
 * What is encoded here is the stale-Chrome incident: a browser left running for
 * days keeps answering `/json/version` while refusing to hand Playwright a
 * browser context, so the script's readiness check has to be a real takeover,
 * and its recovery has to distinguish *our* browser from *yours*.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');

/** A port and profile of our own — never the one a developer is driving. */
const PORT = 9345;
const PROFILE = join(tmpdir(), 'wowlidator-sh-test-profile');

const enabled = process.env['WOWLIDATOR_SH_TESTS'] === '1';
const skip = enabled
  ? false
  : 'set WOWLIDATOR_SH_TESTS=1 to run these — they start and kill real Chrome processes';

interface ShellResult {
  code: number;
  out: string;
}

function sh(command: string, timeoutMs = 120_000): Promise<ShellResult> {
  return new Promise((resolvePromise) => {
    const child = spawn('bash', ['-c', command], { cwd: ROOT, env: process.env });
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    child.stderr.on('data', (c: Buffer) => (out += c.toString()));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? -1, out });
    });
  });
}

/** Wait for the port to go quiet — Chrome takes a moment to actually exit. */
async function portQuiet(timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await portAnswers())) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function portAnswers(): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/json/version`, {
      signal: AbortSignal.timeout(1000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Kill anything this file started, whatever shape it is in. */
async function cleanupPort(): Promise<void> {
  await sh(`pkill -f "remote-debugging-port=${PORT}" || true`, 15_000);
  await sh(`pkill -f "fake-cdp-${PORT}" || true`, 15_000);
  for (let i = 0; i < 15 && (await portAnswers()); i++) {
    await new Promise((r) => setTimeout(r, 500));
  }
}

// The stale-Chrome recovery scenarios (a fake CDP endpoint that answers
// `/json/version` and nothing else) moved to `tests/chrome.test.ts` when the
// lifecycle logic moved from bash into `src/browser/chrome.ts`.

describe('wowlidator.sh shim', { skip }, () => {
  let dir: string;
  let flow: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wowlidator-sh-'));
    flow = join(dir, 'trivial.flow.json');
    await writeFile(
      flow,
      JSON.stringify({
        name: 'shell shim smoke',
        steps: [
          { action: 'goto', url: 'about:blank' },
          { action: 'expectUrl', value: 'about:blank', intent: 'The browser went where it was told.' },
        ],
      }),
      'utf8',
    );
    await cleanupPort();
  });

  after(async () => {
    await cleanupPort();
    await rm(dir, { recursive: true, force: true });
    await rm(PROFILE, { recursive: true, force: true });
  });

  it('still explains itself, and points at the CLI', async () => {
    const result = await sh('./wowlidator.sh --help', 30_000);
    assert.equal(result.code, 0);
    assert.match(result.out, /shim around the CLI/);
    assert.match(result.out, /wowlidator go/);
  });

  it('runs a flow end to end, letting the CLI handle the browser', async () => {
    const result = await sh(
      `WOWLIDATOR_CDP_PORT=${PORT} WOWLIDATOR_CHROME_PROFILE=${PROFILE} ` +
        `./wowlidator.sh ${flow} --no-open --cdp http://127.0.0.1:${PORT} ` +
        `--chrome-profile ${PROFILE} --headless --stop-chrome`,
      180_000,
    );
    assert.equal(result.code, 0, result.out.slice(-1500));
    assert.match(result.out, /PASSED/);
    // The CLI, not the script, started it — and stopped it again.
    assert.equal(await portQuiet(), true, 'the browser it started should be gone');
  });

  it('translates the flags people have in their fingers', async () => {
    // `-u` used to mean `--url`; a shim that silently dropped it would send a
    // description off to be authored with no page to check it against.
    const result = await sh(
      `./wowlidator.sh "some description" -u http://127.0.0.1:9/nothing --no-open --no-ensure-chrome`,
      60_000,
    );
    // It gets far enough to complain about the missing key or the unreachable
    // page — either proves --url arrived. What it must never say is that a URL
    // was required and absent.
    assert.ok(!/needs a page to check it against/.test(result.out), result.out.slice(-600));
  });
});
