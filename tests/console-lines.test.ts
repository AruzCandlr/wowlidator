/**
 * The console classifier — the reading the panel gives each line of a job's
 * output. Unit tier: the same string the page ships is evaluated here and
 * driven with sample lines, so what a row looks like on screen is decided by
 * a function this file can call.
 *
 * Two properties matter more than any one shape: a line the classifier does
 * not recognise comes back untouched as 'plain' (a new CLI format degrades to
 * text, never to a dropped line), and no classification keys on a case's
 * wording — the ids and messages below are invented, and every pattern is a
 * structural one (a channel tag, an arrow, a glyph, a bullet).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CONSOLE_LINES_SCRIPT } from '../src/ui/console-lines.js';

interface Classified {
  kind: string;
  caseNo: number | null;
  caseId: string | null;
  body: string;
  time: string | null;
  glyph: string;
  index: number | null;
  action: string | null;
  rest: string | null;
  took: string | null;
  label: string | null;
  edge: string | null;
  problem: boolean;
  /** Indented four or more under nobody's headline — the view attaches it to the row above. */
  hang: boolean;
}

interface ConsoleApi {
  classifyLine(text: unknown): Classified;
  conGroupLabel(c: Classified): string | null;
  conMatchesMode(c: Classified, mode: string): boolean;
  conMatchesQuery(haystack: string, query: string): boolean;
  conRawText(lines: { stream: string; text: string }[]): string;
  CON_FILTERS: [string, string, string][];
}

const api = new Function(
  `${CONSOLE_LINES_SCRIPT}\nreturn { classifyLine: classifyLine, conGroupLabel: conGroupLabel, conMatchesMode: conMatchesMode, conMatchesQuery: conMatchesQuery, conRawText: conRawText, CON_FILTERS: CON_FILTERS };`,
)() as ConsoleApi;

describe('the console classifier', () => {
  it('ships as plain script that parses on its own and inside the page', () => {
    assert.doesNotThrow(() => new Function(CONSOLE_LINES_SCRIPT));
    // A template interpolation inside the raw string would be evaluated at
    // module load, not shipped; the string must carry none.
    assert.doesNotMatch(CONSOLE_LINES_SCRIPT, /\$\{/);
  });

  it('reads a model request and its response as one-line summaries, with the stamp aside', () => {
    const req = api.classifyLine('[llm 06:41:47] → generator · claude-cli:opus · request #1 · ~12013 tokens in (48047 chars)');
    assert.equal(req.kind, 'llm-req');
    assert.equal(req.time, '06:41:47');
    assert.equal(req.glyph, '→');
    assert.equal(req.body, 'generator · claude-cli:opus · request #1 · ~12013 tokens in (48047 chars)');
    const res = api.classifyLine('[llm 06:46:11] ← generator · claude-cli:opus · 264.0s · 92865 in / 21714 out · session: 1 req, 92865 in / 21714 out');
    assert.equal(res.kind, 'llm-res');
    assert.equal(res.problem, false);
    const fail = api.classifyLine('[llm 06:46:11] ✗ healer · groq:llama · 1.2s · rate limited · retrying in 4s');
    assert.equal(fail.kind, 'llm-fail');
    assert.equal(fail.problem, true);
    const note = api.classifyLine('[llm 06:46:12] pacing: 2 in flight, waiting 800ms');
    assert.equal(note.kind, 'llm-note');
    // ASCII arrows and a stampless tag read the same way — the prefix may move.
    assert.equal(api.classifyLine('[llm] -> agent · x · request #2').kind, 'llm-req');
    assert.equal(api.classifyLine('[llm] <- agent · x · 0.4s').kind, 'llm-res');
  });

  it('marks the ask:/response: continuation lines so the view can fold them', () => {
    const ask = api.classifyLine('         ask: Test request: create a runnable JSON flow…');
    assert.equal(ask.kind, 'llm-cont');
    assert.equal(ask.label, 'ask');
    assert.equal(ask.body, 'Test request: create a runnable JSON flow…');
    const response = api.classifyLine('         response: {"name":"x"}');
    assert.equal(response.kind, 'llm-cont');
    assert.equal(response.label, 'response');
  });

  it('reads a step verdict — glyph, index, action, selector, duration — and tolerates missing parts', () => {
    const pass = api.classifyLine('✓ [7] click role=button[name="Sign in"] (fast, 812ms)');
    assert.equal(pass.kind, 'step-pass');
    assert.equal(pass.index, 7);
    assert.equal(pass.action, 'click');
    assert.equal(pass.rest, 'role=button[name="Sign in"]');
    assert.equal(pass.took, 'fast, 812ms');
    assert.equal(pass.problem, false);
    const fail = api.classifyLine('[c2] ✗ [3] fill #email (2011ms)');
    assert.equal(fail.kind, 'step-fail');
    assert.equal(fail.caseNo, 2);
    assert.equal(fail.index, 3);
    assert.equal(fail.took, '2011ms');
    assert.equal(fail.problem, true);
    const bare = api.classifyLine('  ✓ agent reached the destination');
    assert.equal(bare.kind, 'step-pass');
    assert.equal(bare.index, null);
    assert.equal(bare.action, 'agent reached', 'an agent verb rides with the word agent');
    assert.equal(bare.took, null);
  });

  it('peels the case tag and the case id and folds a doubled id, so a group label can replace the prefix', () => {
    const line = api.classifyLine('[c1] [ACME-042]   ACME-042: persona OPERATOR → someone@example.test');
    assert.equal(line.caseNo, 1);
    assert.equal(line.caseId, 'ACME-042');
    assert.equal(line.body, 'persona OPERATOR → someone@example.test');
    assert.equal(api.conGroupLabel(line), 'ACME-042');
    // The doubled id going away changes nothing.
    const single = api.classifyLine('[ACME-042] persona OPERATOR → someone@example.test');
    assert.equal(single.caseId, 'ACME-042');
    assert.equal(single.body, 'persona OPERATOR → someone@example.test');
    // A tag with no id groups by number; no prefix at all groups under nothing.
    assert.equal(api.conGroupLabel(api.classifyLine('[c3] case "x" started')), 'c3');
    assert.equal(api.conGroupLabel(api.classifyLine('reading the page…')), null);
    // A bracketed step index is not a case id, and neither is the llm tag.
    assert.equal(api.classifyLine('[3] something').caseId, null);
    assert.equal(api.classifyLine('[llm 10:00:00] → x').caseId, null);
    assert.equal(api.classifyLine('[llm] → x').caseId, null);
  });

  it('reads a refusal and the bullets under it', () => {
    const refusal = api.classifyLine('refused: 4 problems with the authored flow — fix all of them, not just the first:');
    assert.equal(refusal.kind, 'refusal');
    assert.equal(refusal.problem, true);
    const inline = api.classifyLine('workflow goal refused: the page never offered the control');
    assert.equal(inline.kind, 'refusal');
    const bullet = api.classifyLine('  · 2 step(s) you wrote were dropped before they could run');
    assert.equal(bullet.kind, 'bullet');
    assert.equal(bullet.body, '2 step(s) you wrote were dropped before they could run');
    assert.equal(api.classifyLine('  • another shape of bullet').kind, 'bullet');
  });

  it('reads attempt, case-boundary and phase markers', () => {
    const again = api.classifyLine('asking again with the refusal as feedback (attempt 2/3)…');
    assert.equal(again.kind, 'marker');
    assert.equal(again.label, 'retry');
    const started = api.classifyLine('case "ACME-042" started');
    assert.equal(started.kind, 'marker');
    assert.equal(started.edge, 'started');
    assert.equal(started.problem, false);
    const failed = api.classifyLine('[c2] case "ACME-043" failed');
    assert.equal(failed.edge, 'failed');
    assert.equal(failed.problem, true);
    for (const header of ['── authoring ──', '## running 3 cases', 'phase: proving', '▶ resume']) {
      assert.equal(api.classifyLine(header).kind, 'marker', header);
      assert.equal(api.classifyLine(header).label, 'phase', header);
    }
  });

  it('reads the final CLI shapes (2026-09-04): tag first, columns, numbered refusals, rules, summaries', () => {
    // src/log-format.ts: every line of a row carries its tag first — including stderr llm lines.
    const req = api.classifyLine('[ACME-042] [llm 06:41:47] → generator · claude-cli:opus · request #1 · ~12013 tokens in (48047 chars)');
    assert.equal(req.kind, 'llm-req');
    assert.equal(req.caseId, 'ACME-042');
    assert.equal(req.time, '06:41:47');
    assert.equal(req.body, 'generator · claude-cli:opus · request #1 · ~12013 tokens in (48047 chars)');
    const cont = api.classifyLine('[ACME-042]          ask: Test request: create a runnable JSON flow…');
    assert.equal(cont.kind, 'llm-cont');
    assert.equal(cont.caseId, 'ACME-042');
    assert.equal(api.classifyLine('[c2] [llm 06:41:47] ← agent · m · 0.4s · 10 in / 5 out').caseNo, 2);
    // No doubled id after the tag any more; the plain body stays plain and whole.
    const plain = api.classifyLine('[ACME-042] journey capture: reading http://localhost:3005/en/admin/hire…');
    assert.equal(plain.kind, 'plain');
    assert.equal(plain.body, 'journey capture: reading http://localhost:3005/en/admin/hire…');

    // phaseHeader(): a 64-column rule; the label survives, the rule does not.
    const rule = '── authoring ACME-042 ' + '─'.repeat(64 - '── authoring ACME-042 '.length);
    assert.equal(rule.length, 64);
    const phase = api.classifyLine(rule);
    assert.equal(phase.kind, 'marker');
    assert.equal(phase.label, 'phase');
    assert.equal(phase.body, 'authoring ACME-042');
    assert.equal(api.classifyLine('[ACME-042] ── run ACME-042 ' + '─'.repeat(40)).body, 'run ACME-042');
    // The attempt marker, and a summary that merely mentions an attempt.
    const attempt = api.classifyLine('— authoring attempt 2/3 —');
    assert.equal(attempt.kind, 'marker');
    assert.equal(attempt.label, 'retry');
    const authored = api.classifyLine('  authored   57 step(s) on attempt 2/3 in 4m31s');
    assert.equal(authored.kind, 'summary');
    assert.equal(authored.label, 'authored');
    assert.equal(authored.body, '57 step(s) on attempt 2/3 in 4m31s');
    assert.equal(api.classifyLine('  elapsed    41.2s from pickup to verdict').label, 'elapsed');
    assert.equal(api.classifyLine('  plan       57 step(s)').label, 'plan');
    assert.equal(api.classifyLine('  report     /tmp/x.html').kind, 'summary');

    // formatRefusalLines(): headline, the flow named once, numbered problems, six-space continuation.
    assert.equal(api.classifyLine('refused: 3 problems with the authored flow — fix all of them, not just the first:').kind, 'refusal');
    const flow = api.classifyLine('  flow: "ACME-042 New hire key-in"');
    assert.equal(flow.kind, 'bullet');
    assert.equal(flow.label, 'flow');
    assert.equal(flow.body, '"ACME-042 New hire key-in"');
    const item = api.classifyLine("  (1) the flow performs the case's script only through step 7 of 8 — it never");
    assert.equal(item.kind, 'bullet');
    assert.equal(item.glyph, '(1)');
    assert.equal(item.body, "the flow performs the case's script only through step 7 of 8 — it never");
    const wrapped = api.classifyLine('      reaches: 8. check the profile.');
    assert.equal(wrapped.kind, 'plain');
    assert.equal(wrapped.hang, true);
    assert.equal(wrapped.body, 'reaches: 8. check the profile.', 'the view indents a continuation itself');

    // formatStepLine(): mark, [index], action, duration, then the target; detail at eight spaces.
    const pass = api.classifyLine('✓ [1]   fill                     (7ms)  role=textbox[name="Email"]');
    assert.equal(pass.kind, 'step-pass');
    assert.equal(pass.index, 1);
    assert.equal(pass.action, 'fill');
    assert.equal(pass.took, '7ms');
    assert.equal(pass.rest, 'role=textbox[name="Email"]');
    const fail = api.classifyLine('[c1] ✗ [3]   fill                  (7684ms)  input[name="q"]  DEAD END');
    assert.equal(fail.kind, 'step-fail');
    assert.equal(fail.took, '7684ms');
    assert.equal(fail.rest, 'input[name="q"]  DEAD END');
    assert.equal(fail.problem, true);
    const narrow = api.classifyLine('✓ [9]   expectVisible   (narrow, 18ms)  text="Benefit catalog" >> nth=0');
    assert.equal(narrow.action, 'expectVisible');
    assert.equal(narrow.took, 'narrow, 18ms');
    assert.equal(narrow.rest, 'text="Benefit catalog" >> nth=0');
    const bare = api.classifyLine('✓ [12]  goto                    (18ms)');
    assert.equal(bare.took, '18ms');
    assert.equal(bare.rest, '');
    assert.equal(api.classifyLine('        expected "x", actual "y"').hang, true);
    // formatAgentAction(): "agent" where the index would be, note at ten spaces.
    const turn = api.classifyLine('  ✓ agent click                   (42ms)  role=tab[name="HR" i]');
    assert.equal(turn.kind, 'step-pass');
    assert.equal(turn.index, null);
    assert.equal(turn.action, 'agent click');
    assert.equal(turn.took, '42ms');
    assert.equal(turn.rest, 'role=tab[name="HR" i]');
    assert.equal(api.classifyLine('          Open the HR section').hang, true);
  });

  it('leaves everything else as plain text, untouched, and never throws', () => {
    for (const text of ['', ' ', 'got 55 step(s), 2 dropped', '  two-space prose is nobody\'s continuation', '<script>alert(1)</script>']) {
      const c = api.classifyLine(text);
      assert.equal(c.kind, 'plain', JSON.stringify(text));
      assert.equal(c.body, text);
    }
    // Four or more spaces is a continuation of the line above: still plain,
    // flagged, and shown trimmed (the raw line is what search and copy see).
    const hang = api.classifyLine('    dropped  expectValue "x" — expectValue needs a value');
    assert.equal(hang.kind, 'plain');
    assert.equal(hang.hang, true);
    assert.equal(hang.body, 'dropped  expectValue "x" — expectValue needs a value');
    assert.equal(api.classifyLine(undefined).kind, 'plain');
    assert.equal(api.classifyLine(null).body, '');
    // Prose that names a problem is kept by the problems filter but stays plain.
    assert.equal(api.classifyLine('BLOCKED ACME-042 — no session held').problem, true);
    assert.equal(api.classifyLine('  ! no verdict: the harness ended first').problem, true);
  });

  it('answers the four filters from the classification alone', () => {
    const modes = api.CON_FILTERS.map((f) => f[0]);
    assert.deepEqual(modes, ['all', 'steps', 'model', 'problems']);
    const lines = {
      pass: api.classifyLine('✓ [1] goto /'),
      fail: api.classifyLine('✗ [2] click x (10ms)'),
      req: api.classifyLine('[llm 10:00:00] → agent · m · request #1'),
      llmFail: api.classifyLine('[llm 10:00:01] ✗ agent · m · 1.0s · boom'),
      refusal: api.classifyLine('refused: no'),
      edge: api.classifyLine('case "x" started'),
      prose: api.classifyLine('reading the page…'),
    };
    const keep = (mode: string) => Object.entries(lines).filter(([, c]) => api.conMatchesMode(c, mode)).map(([k]) => k);
    assert.deepEqual(keep('all'), Object.keys(lines));
    assert.deepEqual(keep('steps'), ['pass', 'fail', 'edge']);
    assert.deepEqual(keep('model'), ['req', 'llmFail']);
    assert.deepEqual(keep('problems'), ['fail', 'llmFail', 'refusal']);
  });

  it('searches case-insensitively and copies the raw log verbatim', () => {
    assert.equal(api.conMatchesQuery('Refused: Something', 'refused'), true);
    assert.equal(api.conMatchesQuery('x', '  '), true);
    assert.equal(api.conMatchesQuery('x', 'y'), false);
    assert.equal(api.conRawText([{ stream: 'out', text: 'a' }, { stream: 'err', text: '[llm] → b' }]), 'a\n[llm] → b');
  });
});
