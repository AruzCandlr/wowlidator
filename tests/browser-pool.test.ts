/**
 * The browser pool (`--browsers <n>`) — the pure half. Where each member
 * listens and which profile it owns, and the least-loaded lease, need no
 * browser to prove; that n Chromes actually start is the gated tier in
 * `chrome.test.ts`, for the same reason the rest of that file is gated.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BrowserLease, poolMember } from '../src/browser/pool.js';
import { chromeMatchPattern, portOf } from '../src/browser/chrome.js';
import { resolveBrowsers } from '../src/cli/options.js';

describe('poolMember', () => {
  it('leaves the primary exactly where it was', () => {
    assert.deepEqual(poolMember('http://localhost:9222', '/tmp/p', 0), {
      cdpUrl: 'http://localhost:9222',
      profile: '/tmp/p',
    });
  });

  it('puts the i-th browser on the i-th port after the primary, on its own profile', () => {
    assert.deepEqual(poolMember('http://localhost:9222', '/tmp/p', 1), {
      cdpUrl: 'http://localhost:9223',
      profile: '/tmp/p-2',
    });
    assert.deepEqual(poolMember('http://127.0.0.1:9300', '/tmp/p', 3), {
      cdpUrl: 'http://127.0.0.1:9303',
      profile: '/tmp/p-4',
    });
  });

  it('gives members command lines the process matcher cannot confuse', () => {
    // `chromeIsOurs` and `stopChrome` match on port AND profile. Two members
    // must never match each other's pattern, or stopping one stops both.
    const a = poolMember('http://localhost:9222', '/tmp/p', 0);
    const b = poolMember('http://localhost:9222', '/tmp/p', 1);
    const lineA = `chrome --remote-debugging-port=${portOf(a.cdpUrl)} --user-data-dir=${a.profile} --headless=new`;
    const lineB = `chrome --remote-debugging-port=${portOf(b.cdpUrl)} --user-data-dir=${b.profile} --headless=new`;
    assert.ok(lineA.includes(chromeMatchPattern(portOf(a.cdpUrl), a.profile)));
    assert.ok(!lineB.includes(chromeMatchPattern(portOf(a.cdpUrl), a.profile)));
    assert.ok(!lineA.includes(chromeMatchPattern(portOf(b.cdpUrl), b.profile)));
  });

  it('falls back sensibly on a URL that is not one', () => {
    assert.equal(poolMember('nonsense', '/tmp/p', 1).cdpUrl, 'http://localhost:9223');
  });
});

describe('BrowserLease', () => {
  it('a serial run always lands on the primary — nothing changes for one case at a time', () => {
    const lease = new BrowserLease(['a', 'b', 'c']);
    for (let i = 0; i < 5; i += 1) {
      const got = lease.acquire();
      assert.equal(got, 'a');
      lease.release(got);
    }
  });

  it('spreads concurrent cases over the least-loaded browser', () => {
    const lease = new BrowserLease(['a', 'b', 'c']);
    assert.deepEqual([lease.acquire(), lease.acquire(), lease.acquire()], ['a', 'b', 'c']);
    assert.equal(lease.acquire(), 'a');
    assert.deepEqual(lease.load(), [2, 1, 1]);
    lease.release('b');
    lease.release('b');
    // b is now empty and gets the next two before anything else does.
    assert.equal(lease.acquire(), 'b');
    assert.deepEqual(lease.load(), [2, 1, 1]);
  });

  it('does not pile onto one browser after the pool drains for an exclusive case', () => {
    // The reason this is least-loaded and not "lane i → browser i": after an
    // exclusive case ran alone, the queue's next lanes are numbered from
    // wherever it left off, and a modulo would put them on the same browser.
    const lease = new BrowserLease(['a', 'b']);
    const alone = lease.acquire();
    lease.release(alone);
    const next = [lease.acquire(), lease.acquire()];
    assert.deepEqual(next.sort(), ['a', 'b']);
  });

  it('ignores a release of a browser it never leased, and never goes negative', () => {
    const lease = new BrowserLease(['a']);
    lease.release('zzz');
    lease.release('a');
    assert.deepEqual(lease.load(), [0]);
  });

  it('refuses an empty pool', () => {
    assert.throws(() => new BrowserLease([]));
  });
});

describe('BrowserLease.acquireMany — one Chrome per persona', () => {
  it('hands a two-persona case two distinct browsers, least-loaded first', () => {
    const lease = new BrowserLease(['a', 'b', 'c']);
    const got = lease.acquireMany(2);
    assert.deepEqual(got, { cdpUrls: ['a', 'b'], distinct: true });
    assert.deepEqual(lease.load(), [1, 1, 0]);
    // A single-persona case arriving now goes to the idle one.
    assert.equal(lease.acquire(), 'c');
    lease.releaseMany(got.cdpUrls);
    assert.deepEqual(lease.load(), [0, 0, 1]);
  });

  it('never picks the same browser twice while another is free', () => {
    const lease = new BrowserLease(['a', 'b']);
    lease.acquire(); // a: 1
    lease.acquire(); // b: 1
    lease.acquire(); // a: 2
    // b is least loaded; the second pick must not be b again but a.
    assert.deepEqual(lease.acquireMany(2), { cdpUrls: ['b', 'a'], distinct: true });
  });

  it('doubles up and says so when the pool is smaller than the case', () => {
    const lease = new BrowserLease(['a']);
    const got = lease.acquireMany(3);
    assert.deepEqual(got, { cdpUrls: ['a', 'a', 'a'], distinct: false });
    assert.deepEqual(lease.load(), [3]);
    lease.releaseMany(got.cdpUrls);
    assert.deepEqual(lease.load(), [0]);
  });

  it('acquireMany(1) is acquire()', () => {
    const lease = new BrowserLease(['a', 'b']);
    assert.deepEqual(lease.acquireMany(1), { cdpUrls: ['a'], distinct: true });
    assert.deepEqual(lease.acquireMany(0), { cdpUrls: ['b'], distinct: true });
  });

  it('accepts a browser that joined after the pool was built, once', () => {
    const lease = new BrowserLease(['a']);
    lease.add('b');
    lease.add('b');
    assert.equal(lease.size, 2);
    assert.deepEqual(lease.acquireMany(2), { cdpUrls: ['a', 'b'], distinct: true });
  });
});

describe('resolveBrowsers', () => {
  const env = process.env['WOWLIDATOR_BROWSERS'];
  const restore = (): void => {
    if (env === undefined) delete process.env['WOWLIDATOR_BROWSERS'];
    else process.env['WOWLIDATOR_BROWSERS'] = env;
  };

  it('flag first, then the environment, then nothing', () => {
    try {
      delete process.env['WOWLIDATOR_BROWSERS'];
      assert.equal(resolveBrowsers(undefined), undefined);
      assert.equal(resolveBrowsers('4'), 4);
      process.env['WOWLIDATOR_BROWSERS'] = '3';
      assert.equal(resolveBrowsers(undefined), 3);
      assert.equal(resolveBrowsers('2'), 2);
    } finally {
      restore();
    }
  });

  it('treats nonsense and zero as no preference rather than a pool of nothing', () => {
    try {
      delete process.env['WOWLIDATOR_BROWSERS'];
      assert.equal(resolveBrowsers('0'), undefined);
      assert.equal(resolveBrowsers('lots'), undefined);
      assert.equal(resolveBrowsers('2.9'), 2);
    } finally {
      restore();
    }
  });
});
