/**
 * The GRIM theme. Unit tier — pure strings, no browser, no cost.
 *
 * These tests guard the two properties that make a shared theme worth having
 * at all: that it really does carry both modes, and that adopting it cannot
 * turn a self-contained artefact into one that phones home.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  GRIM_BASE,
  GRIM_COMPONENTS,
  GRIM_PALETTE,
  GRIM_TOKENS,
  grimTheme,
  toneOf,
} from '../src/reporter/theme.js';
import { renderApp } from '../src/ui/app-html.js';

describe('the theme carries both grim-agent palettes', () => {
  it('has the QA Command Center light palette', () => {
    assert.match(GRIM_TOKENS, /--bg: #F7F7F4/, 'paper');
    assert.match(GRIM_TOKENS, /--ink: #1C2126/);
    assert.match(GRIM_TOKENS, /--accent: #0E8A9E/, 'teal');
    assert.match(GRIM_TOKENS, /--ok: #1B7F4B/);
  });

  it('has the Orchestrator 3 Stream dark palette', () => {
    assert.match(GRIM_TOKENS, /--bg: #0a0a0a/);
    assert.match(GRIM_TOKENS, /--accent: #06b6d4/, 'cyan');
    assert.match(GRIM_TOKENS, /--ok: #10b981/);
  });

  it('lets an explicit theme choice beat the OS in both directions', () => {
    // Without the `:not([data-theme="light"])`, a reader on a dark OS who asks
    // for light gets dark anyway — the toggle silently does nothing.
    assert.match(GRIM_TOKENS, /@media \(prefers-color-scheme: dark\)/);
    assert.match(GRIM_TOKENS, /:root:not\(\[data-theme="light"\]\)/);
    assert.match(GRIM_TOKENS, /:root\[data-theme="dark"\]/);
  });

  it('declares color-scheme so form controls follow too', () => {
    assert.match(GRIM_TOKENS, /color-scheme: light dark/);
  });
});

describe('the theme cannot make an artefact phone home', () => {
  const all = grimTheme();

  it('names IBM Plex but never fetches it', () => {
    assert.match(all, /IBM Plex Sans Thai/, 'GRIM is a Thai-language product; the Thai face matters');
    assert.match(all, /IBM Plex Mono/);
    assert.doesNotMatch(all, /fonts\.googleapis|fonts\.gstatic|@font-face|@import/);
  });

  it('contains no url() of any kind', () => {
    // A background-image would be a remote fetch from inside a report that is
    // supposed to open off a USB stick.
    assert.doesNotMatch(all, /url\(/);
  });

  it('contains no absolute http reference', () => {
    assert.doesNotMatch(all, /https?:\/\//);
  });
});

describe('GRIM_PALETTE agrees with the CSS', () => {
  // The comment on GRIM_PALETTE promises this test exists. Values duplicated
  // into JS drift from the stylesheet the moment nobody is checking.
  it('matches every light value', () => {
    for (const [token, value] of Object.entries(GRIM_PALETTE.light)) {
      const name = token === 'bg' ? 'bg' : token;
      assert.match(
        GRIM_TOKENS,
        new RegExp(`--${name}: ${value}`, 'i'),
        `light --${name} should be ${value}`,
      );
    }
  });

  it('matches every dark value', () => {
    for (const [token, value] of Object.entries(GRIM_PALETTE.dark)) {
      assert.match(
        GRIM_TOKENS,
        new RegExp(`--${token}: ${value}`, 'i'),
        `dark --${token} should be ${value}`,
      );
    }
  });
});

describe('toneOf is the one place a word becomes a colour', () => {
  it('reads GRIM verdicts', () => {
    assert.equal(toneOf('PASS'), 'pass');
    assert.equal(toneOf('FAIL'), 'fail');
    assert.equal(toneOf('ORACLE_UNAVAILABLE'), 'warn');
    assert.equal(toneOf('REFUSED'), 'warn');
    assert.equal(toneOf('BLOCKED'), 'warn');
  });

  it('reads GRIM statuses', () => {
    assert.equal(toneOf('verified'), 'pass');
    assert.equal(toneOf('failed'), 'fail');
    assert.equal(toneOf('unsure'), 'warn');
  });

  it('reads wowlidator run words', () => {
    assert.equal(toneOf('passed'), 'pass');
    assert.equal(toneOf('flaky'), 'warn');
    assert.equal(toneOf('quarantined'), 'warn');
  });

  it('never guesses — an unknown word is idle, not a colour', () => {
    assert.equal(toneOf('probably fine'), 'idle');
    assert.equal(toneOf(''), 'idle');
  });
});

describe('every surface actually adopts the theme', () => {
  it('the control panel renders both palettes and no external request', () => {
    const html = renderApp();
    assert.match(html, /#F7F7F4/, 'light');
    assert.match(html, /#06b6d4/, 'dark');
    assert.doesNotMatch(html, /<script src=|rel="stylesheet"|fonts\.googleapis/);
  });

  it('exposes the shared components the other surfaces build on', () => {
    for (const cls of ['.g-panel', '.g-chip', '.g-cap', '.g-table', '.g-cmd', '.g-verdict']) {
      assert.ok(GRIM_COMPONENTS.includes(cls), `${cls} missing from the shared components`);
    }
  });

  it('honours prefers-reduced-motion', () => {
    assert.match(GRIM_COMPONENTS, /prefers-reduced-motion/);
  });

  it('keeps focus visible', () => {
    assert.match(GRIM_BASE, /:focus-visible/);
  });
});

describe('accent pairings clear WCAG AA', () => {
  // Added after measuring the real thing in a browser: a solid `--accent` fill
  // under white text is 4.08:1 in light mode and 2.43:1 in dark, both under the
  // 4.5 AA needs for body-sized text. That is why the accent is three tokens.
  const luminance = (hex: string): number => {
    const channels = [1, 3, 5].map((i) => {
      const v = parseInt(hex.slice(i, i + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const ratio = (a: string, b: string): number => {
    const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
    return (x + 0.05) / (y + 0.05);
  };
  const AA = 4.5;

  const token = (mode: 'light' | 'dark', name: string): string => {
    // The dark block is the second occurrence of every name.
    const all = [...GRIM_TOKENS.matchAll(new RegExp(`--${name}: (#[0-9a-fA-F]{6})`, 'g'))].map(
      (m) => m[1] as string,
    );
    return (mode === 'light' ? all[0] : all[1]) as string;
  };

  for (const mode of ['light', 'dark'] as const) {
    it(`${mode}: text on a solid accent fill is readable`, () => {
      const r = ratio(token(mode, 'accent-strong'), token(mode, 'on-accent'));
      assert.ok(r >= AA, `--on-accent on --accent-strong is ${r.toFixed(2)}:1, needs ${AA}`);
    });

    it(`${mode}: accent text on the soft accent tint is readable`, () => {
      const r = ratio(token(mode, 'accent-soft'), token(mode, 'accent-ink'));
      assert.ok(r >= AA, `--accent-ink on --accent-soft is ${r.toFixed(2)}:1, needs ${AA}`);
    });

    it(`${mode}: body text on the canvas is readable`, () => {
      const r = ratio(token(mode, 'bg'), token(mode, 'ink'));
      assert.ok(r >= AA, `--ink on --bg is ${r.toFixed(2)}:1`);
    });

    it(`${mode}: muted text on the canvas is still readable`, () => {
      const r = ratio(token(mode, 'bg'), token(mode, 'muted'));
      assert.ok(r >= AA, `--muted on --bg is ${r.toFixed(2)}:1`);
    });
  }
});
