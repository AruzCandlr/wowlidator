/**
 * The suite session vault (`engine/session-vault.ts`): a session one case
 * establishes is banked as storage state and injected into a later case's
 * own isolated context, so a flow that does not sign in itself starts
 * already authenticated.
 *
 * Two tiers, same gate as every browser suite: the vault's own rules are
 * pure; that an injected storage state actually reaches the application as
 * cookies is a fact about a real browser context.
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import { SessionVault } from '../src/engine/session-vault.js';
import { runFlow } from '../src/engine/runner.js';

describe('SessionVault', () => {
  const state = (cookies: number) => ({
    cookies: Array.from({ length: cookies }, (_, i) => ({
      name: `c${i}`,
      value: 'v',
      domain: 'a.test',
      path: '/',
      expires: -1,
      httpOnly: false,
      secure: false,
      sameSite: 'Lax' as const,
    })),
    origins: [],
  });

  it('is origin-scoped: state banked on one application never reaches another', () => {
    const vault = new SessionVault();
    assert.equal(vault.put('http://a.test', state(1)), true);
    assert.ok(vault.get('http://a.test'));
    assert.equal(vault.get('http://b.test'), null);
  });

  it('refuses an empty cookie jar — no session is not a session', () => {
    const vault = new SessionVault();
    assert.equal(vault.put('http://a.test', state(0)), false);
    assert.equal(vault.get('http://a.test'), null);
  });
});

const CDP_URL = process.env['WOWLIDATOR_CDP_URL'] ?? 'http://localhost:9222';

async function cdpAvailable(url: string): Promise<boolean> {
  try {
    const response = await fetch(new URL('/json/version', url), { signal: AbortSignal.timeout(1_000) });
    return response.ok;
  } catch {
    return false;
  }
}

const browserReady = await cdpAvailable(CDP_URL);
const skipBrowser = browserReady
  ? false
  : `no CDP endpoint at ${CDP_URL} — start Chrome with --remote-debugging-port=9222 (npm run chrome)`;

describe('session carried across isolated case contexts (CDP)', { skip: skipBrowser }, () => {
  let server: Server;
  let origin: string;

  before(async () => {
    server = createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0];
      if (path === '/acquire') {
        // The application grants a session — what a sign-in leaves behind.
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'set-cookie': 'session=alpha; Path=/',
        });
        res.end('<h1>Session granted</h1>');
        return;
      }
      // The page a later case opens: content depends on the cookie, exactly
      // like a protected page.
      const signedIn = /(?:^|;\s*)session=alpha/.test(req.headers.cookie ?? '');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(signedIn ? '<h1>Welcome back</h1>' : '<h1>Please sign in</h1>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it('banks the first case\'s session and the next case starts signed in', async () => {
    const vault = new SessionVault();
    const shared = { cdpUrl: CDP_URL, isolate: true, video: 'off' as const, coverage: false, network: false, sessionVault: vault };

    const first = await runFlow(
      {
        name: 'acquires a session',
        steps: [
          { action: 'goto', url: `${origin}/acquire` },
          { action: 'expectVisible', selector: 'role=heading[name="Session granted"]' },
        ],
      },
      shared,
    );
    assert.equal(first.status, 'passed');
    assert.ok(vault.get(origin), 'the run that ended signed in banked its state');

    const second = await runFlow(
      {
        name: 'starts on the banked session',
        steps: [
          { action: 'goto', url: `${origin}/protected` },
          // Only the carried cookie can render this heading.
          { action: 'expectVisible', selector: 'role=heading[name="Welcome back"]' },
        ],
      },
      shared,
    );
    assert.equal(second.status, 'passed');
    assert.ok(
      (second.notes ?? []).some((note) => /reused the session a sibling case/.test(note)),
      `the reuse is on the record: ${JSON.stringify(second.notes)}`,
    );
  });
});

// --- Per-account keying (EH-10, 2026-09-03) --------------------------------

describe('SessionVault keyed per account', () => {
  const state = (name: string) => ({
    cookies: [{ name, value: 'v', domain: 'a.test', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' as const }],
    origins: [],
  });

  it('hands a case the account it asked for, never whichever account the previous case ended as', () => {
    // ML_01_06's shape: the employee submits, the manager approves, the next
    // employee case must start as the employee again.
    const vault = new SessionVault();
    vault.put('http://a.test', state('employee'), 'employee@a.test');
    vault.put('http://a.test', state('manager'), 'manager@a.test');
    assert.equal(vault.get('http://a.test', 'employee@a.test')?.cookies[0]?.name, 'employee');
    assert.equal(vault.get('http://a.test', 'manager@a.test')?.cookies[0]?.name, 'manager');
    assert.equal(vault.get('http://a.test', 'hrbp@a.test'), null);
  });

  it('keeps the single-slot answer for a caller that names no account — the latest banked', () => {
    const vault = new SessionVault();
    vault.put('http://a.test', state('first'));
    vault.put('http://a.test', state('second'), 'x@a.test');
    assert.equal(vault.get('http://a.test')?.cookies[0]?.name, 'second');
    assert.equal(vault.get('http://b.test'), null, 'still origin-scoped');
  });
});
