import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildTask, extractAnswer, stripAnsi } from '../src/providers/claude-tty.js';

const ID = 'abc-123';
const open = `<WOWLIDATOR_RESULT id="${ID}">`;
const close = '</WOWLIDATOR_RESULT>';

describe('claude-tty answer boundary', () => {
  it('ignores the echoed prompt, whose envelope wraps only the placeholder', () => {
    // The TUI echoes what was typed — including the instruction's own
    // marker lines. That envelope is never an answer.
    const echo = buildTask('system', 'do the thing', ID);
    assert.equal(extractAnswer(echo, ID), null);
  });

  it('returns the answer that follows the echo', () => {
    const echo = buildTask('', 'ask', ID);
    const screen = `${echo}\n\n⏺ ${open}\n{"ok":true}\n${close}\n\n> `;
    const found = extractAnswer(screen, ID);
    assert.ok(found);
    assert.equal(found.answer, '{"ok":true}');
    assert.equal(screen.slice(found.end).trim(), '>');
  });

  it('waits while the latest copy of the envelope is still arriving', () => {
    const partial = `${open}\n{"ok":tr`;
    assert.equal(extractAnswer(partial, ID), null);
  });

  it('never matches an envelope carrying a different request id', () => {
    const stale = `<WOWLIDATOR_RESULT id="old-1">\n{"stale":true}\n${close}`;
    assert.equal(extractAnswer(stale, ID), null);
  });

  it('takes the last complete copy when ink redraws the same answer', () => {
    const one = `${open}\n{"n":1}\n${close}`;
    const screen = `${one}\n${one}`;
    const found = extractAnswer(screen, ID);
    assert.ok(found);
    assert.equal(found.answer, '{"n":1}');
    assert.equal(found.end, screen.length);
  });

  it('strips CSI, OSC and charset escapes', () => {
    const raw = '\x1b[32mgreen\x1b[0m \x1b]0;title\x07plain \x1b(B\x1b[2K\x1b[1Gend';
    assert.equal(stripAnsi(raw), 'green plain end');
  });
});
