/**
 * Publishing a report as an artifact.
 *
 * Everything here is the pure half — the strip, the budget, the title and the
 * argv — which is the half that decides whether a publish is correct. Starting
 * a real Claude session is not tested: it uploads to Anthropic's servers, and
 * a test suite that publishes is a test suite nobody can run twice.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ARTIFACT_BUDGET_BYTES,
  artifactPathFor,
  publishArgv,
  stripToFit,
  titleOf,
} from '../src/reporter/publish-artifact.js';

/** A report of `bytes`, carrying an embedded film of the given base64 length. */
function report(filmChars: number, padding = 0): string {
  return (
    `<title>wowlidator report — PL_01_01</title>` +
    `<figure class="video"><video id="run-video" data-webm="${'A'.repeat(filmChars)}">` +
    `</video><div class="video-subtitle" id="video-subtitle" hidden></div></figure>` +
    `<p>${'x'.repeat(padding)}</p>`
  );
}

describe('stripToFit — the film goes only when the page does not otherwise fit', () => {
  it('leaves a report that already fits exactly as it was', () => {
    const small = report(2000);
    const out = stripToFit(small);
    assert.equal(out.html, small, 'not one byte changes');
    assert.equal(out.strippedFilm, false);
    assert.equal(out.bytes, Buffer.byteLength(small, 'utf8'));
  });

  it('drops the film when the page is over budget, and says so in its place', () => {
    const huge = report(ARTIFACT_BUDGET_BYTES + 1000);
    const out = stripToFit(huge);
    assert.equal(out.strippedFilm, true);
    assert.ok(out.bytes < ARTIFACT_BUDGET_BYTES, 'it now fits');
    assert.match(out.html, /data-webm=""/, 'the payload is gone');
    // A silently empty player reads as a broken report, which is a lie about
    // the run rather than a fact about the size limit.
    assert.match(out.html, /The recording is not embedded in this artifact/);
    assert.match(out.html, /kept with the run/);
    assert.ok(!out.html.includes('A'.repeat(1000)), 'no base64 survives');
  });

  it('keeps everything that is not the film', () => {
    const out = stripToFit(report(ARTIFACT_BUDGET_BYTES + 1000, 500));
    assert.match(out.html, /wowlidator report — PL_01_01/, 'the title survives');
    assert.match(out.html, /<p>x{500}<\/p>/, 'the body survives');
  });

  it('leaves an oversized page with no film alone rather than pretending to shrink it', () => {
    // There is nothing to drop. Reporting `strippedFilm` here would say a
    // recording was sacrificed when none existed.
    const wordy = `<title>t</title><p>${'y'.repeat(ARTIFACT_BUDGET_BYTES + 10)}</p>`;
    const out = stripToFit(wordy);
    assert.equal(out.strippedFilm, false);
    assert.equal(out.html, wordy);
  });

  it('measures bytes, not characters', () => {
    // A Thai case title is three bytes per character, and a budget checked in
    // characters would publish a page a third over the limit.
    const thai = `<title>${'ทดสอบ'.repeat(10)}</title>`;
    assert.equal(stripToFit(thai).bytes, Buffer.byteLength(thai, 'utf8'));
    assert.ok(stripToFit(thai).bytes > thai.length);
  });
});

describe('titleOf — the artifact is named by the page', () => {
  it('reads the title, trimmed', () => {
    assert.equal(titleOf('<title>  PL_01_01 report </title>', 'fallback'), 'PL_01_01 report');
  });
  it('keeps a Thai title verbatim', () => {
    const name = 'ตรวจสอบการจ้างพนักงานใหม่';
    assert.equal(titleOf(`<title>${name}</title>`, 'fallback'), name);
  });
  it('falls back when there is no title, or an empty one', () => {
    assert.equal(titleOf('<p>no title here</p>', 'report.html'), 'report.html');
    assert.equal(titleOf('<title>   </title>', 'report.html'), 'report.html');
  });
  it('only scans the head, as the platform does', () => {
    const late = `${'<p>x</p>'.repeat(2000)}<title>too late</title>`;
    assert.ok(late.length > 8192);
    assert.equal(titleOf(late, 'fallback'), 'fallback');
  });
});

describe('artifactPathFor — the stripped copy sits beside the report', () => {
  it('never overwrites the run its own evidence', () => {
    assert.equal(
      artifactPathFor('/runs/x/humi/03-catalog-pl-01-01.html'),
      '/runs/x/humi/03-catalog-pl-01-01.artifact.html',
    );
  });
  it('gives an extensionless path an html one', () => {
    assert.equal(artifactPathFor('/runs/x/report'), '/runs/x/report.artifact.html');
  });
});

describe('publishArgv — the command that publishes', () => {
  const argv = publishArgv('/runs/x/r.html', 'PL_01_01', 'haiku');

  it('backgrounds a session, because print mode has no Artifact tool', () => {
    // Measured 2026-09-08: `claude -p` does not carry Artifact — not in its
    // tool list, not via ToolSearch, and not when named in --allowedTools,
    // which grants a tool that exists rather than registering one that does
    // not. `claude --bg` does. A change of this flag silently breaks publish.
    assert.ok(argv.includes('--bg'), 'must background a full session');
    assert.ok(!argv.includes('-p') && !argv.includes('--print'), 'never print mode');
  });

  it('names the model it was asked for', () => {
    assert.deepEqual(argv.slice(argv.indexOf('--model'), argv.indexOf('--model') + 2), ['--model', 'haiku']);
    assert.ok(publishArgv('/f.html', 't', 'sonnet').includes('sonnet'));
  });

  it('never lets the session bypass permissions — the publish must still ask', () => {
    // Publishing uploads to Anthropic's servers. The prompt is the design.
    assert.ok(!argv.some((a) => a.includes('dangerously')), 'no permission bypass');
    assert.ok(!argv.includes('bypassPermissions'));
    assert.deepEqual(
      argv.slice(argv.indexOf('--permission-mode'), argv.indexOf('--permission-mode') + 2),
      ['--permission-mode', 'acceptEdits'],
    );
  });

  it('carries the path and title as argv elements, never interpolated into a shell', () => {
    const nasty = publishArgv('/runs/a b/r.html', 'PL "01" & co', 'haiku');
    const prompt = nasty[nasty.length - 1] ?? '';
    assert.ok(prompt.includes('/runs/a b/r.html'), 'the path is passed whole');
    assert.ok(prompt.includes(JSON.stringify('PL "01" & co')), 'the title is quoted, not escaped by hand');
  });

  it('tells the session to publish what it was given, unchanged', () => {
    const prompt = argv[argv.length - 1] ?? '';
    assert.match(prompt, /Artifact tool/);
    assert.match(prompt, /change nothing in it/);
  });
});
