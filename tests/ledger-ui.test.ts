/**
 * Ledger — the home page at `/` (src/ui/ledger-html.ts).
 *
 * Page-string assertions, the same way `wow-ui.test.ts` pins wowUI: the page
 * is one self-contained document built through `el()`, it composes wowUI's
 * script rather than forking it, the two things only the retired command
 * panel offered (every command as a form, the manual) are here, and nothing
 * on the page reaches for `window.prompt` or `window.confirm`. Plus the manual
 * parser, the one piece of server-side logic: it turns our own static HTML
 * into data so the page needs no `innerHTML` at all.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { COMMANDS } from '../src/ui/commands.js';
import { MANUAL } from '../src/ui/manual.js';
import { parseManualHtml, renderLedger } from '../src/ui/ledger-html.js';

describe('the Ledger page', () => {
  const html = renderLedger();
  const ledgerPart = html.slice(html.indexOf('ledger =='));

  it('cannot phone home — it is one self-contained document', () => {
    assert.doesNotMatch(html, /<script src=|rel="stylesheet"|fonts\.googleapis|@import/);
  });

  it('renders whole and parses — a stray backtick truncates the page', () => {
    assert.ok(html.length > 300_000);
    assert.ok(html.trimEnd().endsWith('</html>'));
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    assert.equal(scripts.length, 2, 'the manual data, then the page script');
    for (const script of scripts) assert.doesNotThrow(() => new Function(script));
    assert.equal((html.match(/\nboot\(\);/g) ?? []).length, 1, 'exactly one boot — wowUI\'s own is removed');
  });

  it('builds every node through el(), never from an HTML string — including the manual', () => {
    assert.doesNotMatch(html, /innerHTML|trustedHtml|insertAdjacentHTML|document\.write/);
    assert.match(html, /var MANUAL_DATA = \[/);
    assert.match(html, /function manualNode\(/);
  });

  it('composes wowUI rather than forking it: two base functions renamed, the layout ones replaced', () => {
    for (const name of ['wowPost', 'wowDataSignature']) {
      assert.equal((html.match(new RegExp(`function ${name}\\(`, 'g')) ?? []).length, 1, name);
    }
    // The evidence machinery ships unchanged: the checks table, the drawer, the launcher gate, the live console.
    for (const name of ['checksTable', 'evidencePanel', 'claimsGate', 'recomputeLanes', 'agentActionLog', 'streamJob', 'outputSection', 'jobForRun', 'progressBar', 'tqdmReadout', 'renderGroup', 'taskRow', 'renderKeys', 'renderRepos', 'renderHistory', 'renderHealed', 'renderReports', 'workQueueBox', 'confirmDeleteGroup']) {
      assert.match(html, new RegExp(`function ${name}\\(`), name);
    }
    // And the layout is declared again, later, so the base calls land here.
    for (const name of ['render', 'show', 'renderSidebar', 'pageHead', 'renderRuns', 'statsStrip', 'attentionItems', 'renderAttention', 'boot']) {
      assert.equal((ledgerPart.match(new RegExp(`\\nfunction ${name}\\(`, 'g')) ?? []).length, 1, `${name} is redeclared once`);
    }
  });

  it('is six tabs on a top bar, and every address the older surfaces wrote still lands', () => {
    assert.match(html, /<nav class="tabs" id="tabs"/);
    assert.match(html, /<div class="topstatus" id="status"/);
    for (const id of ['runs', 'history', 'learned', 'machinery', 'commands', 'help']) {
      assert.match(html, new RegExp(`\\{ id: '${id}', label: '`), id);
    }
    assert.match(html, /var LEGACY_HASH = \{/);
    for (const old of ['healed', 'attention', 'reports', 'cache', 'keys', 'repos', 'manual', 'panel', 'flows']) {
      assert.match(html, new RegExp(`\\b${old}: \\['`), `old hash #${old} lands somewhere`);
    }
    assert.match(html, /if \(S\.meta && commandById\(view\)\) \{ sub = view; view = 'commands'; \}/, 'a command id opens its form');
    assert.match(html, /if \(S\.view === 'keys'\) S\.view = 'machinery';/, 'the base usage-cap dialog still finds Models and keys');
    assert.doesNotMatch(ledgerPart, /location\.href = '\/'/, 'no link out to another surface');
  });

  it('absorbs the command panel: every other command as a form rendered from the spec, the right way round', () => {
    assert.match(html, /function renderCommands\(/);
    assert.match(html, /var COMMANDS_EXCLUDED = \['go', 'catalog-claims', 'catalog-run', 'run'\]/);
    assert.match(html, /'secret' \? 'password'/);
    for (const flag of ['no-heal', 'no-agent', 'no-network', 'no-history', 'no-report', 'no-reconstruct', 'no-agent-early-stop', 'no-ensure-chrome']) {
      assert.match(html, new RegExp(`'${flag}': '`), `${flag} has a positive label`);
    }
    assert.match(html, /data-invert/);
    assert.match(html, /if \(!box\.checked\) values\[field\.name\] = true;/, 'an off switch sends the no-* flag; on sends nothing');
    assert.match(html, /else if \(field\.offFlag\) values\[field\.name\] = false;/, 'offFlag booleans still state both directions');
    assert.match(html, /function chipsInput\(/, 'repeatable fields are a chip list');
    assert.match(html, /if \(list\.length\) values\[field\.name\] = list\.slice\(\);/, 'and submit as an array');
    assert.match(html, /turn on “/, 'a gated field is visible and says what gates it');
    assert.match(html, /function commandLineFor\(/, 'the command line it builds is shown');
    assert.match(html, /carried as env, never argv/);
    for (const group of ['Recording', 'Behaviour', 'Chrome', 'Output']) assert.match(html, new RegExp(`\\['${group}', \\[`));
    // Every advanced browser flag is placed in a group, so none lands in "Other options" by accident.
    const grouped = new Set([...html.matchAll(/\['(?:Recording|Behaviour|Chrome|Output)', \[([^\]]*)\]/g)].flatMap((m) => m[1]!.match(/'[^']+'/g)!.map((s) => s.slice(1, -1))));
    const advanced = new Set(COMMANDS.flatMap((c) => c.fields.filter((f) => f.advanced).map((f) => f.name)));
    for (const name of advanced) assert.ok(grouped.has(name), `${name} is grouped`);
    // The rule survives: nobody is asked to pick a flow. Running one is an action on its row.
    assert.doesNotMatch(ledgerPart, /The flow to run|Start from a flow on disk|Paste a flow|editorBox|openEditor/);
  });

  it('uses one dialog idiom and never the browser\'s own prompt or confirm', () => {
    assert.match(html, /var DESTRUCTIVE = \{/);
    assert.match(html, /'cache-forget': function/);
    assert.match(html, /function confirmModal\(/);
    assert.match(html, /function promptModal\(/);
    assert.match(html, /function trapFocus\(/);
    assert.doesNotMatch(ledgerPart, /window\.prompt|window\.confirm/);
    // The three prompts wowUI still makes with window.prompt are redeclared here on the modal.
    for (const name of ['renameTask', 'renameGroup', 'resumeCatalog', 'reauthorCase', 'queueAdd', 'queueRemove', 'queueRun']) {
      assert.match(ledgerPart, new RegExp(`\\nfunction ${name}\\(`), name);
    }
    assert.match(ledgerPart, /type: 'password', button: 'Resume with it'/, 'the resume password is asked in a password box');
  });

  it('shows the header status on every poll and never a key', () => {
    assert.match(html, /function renderStatus\(/);
    assert.match(html, /'browser in use — one run at a time'/);
    assert.match(html, /' roles keyed'/);
    assert.doesNotMatch(html, /apiKey|api_key|process\.env/);
  });

  it('says what every number is a number of, and looks at every proof for what needs a human', () => {
    assert.match(ledgerPart, /passed \+ ' of the last ' \+ recent\.length \+ ' runs'/, 'the proved figure carries its denominator');
    assert.match(ledgerPart, /more stopped or finished catalog run\(s\) — show all/, 'no silent cap on the banners');
    assert.match(ledgerPart, /S\.proofs\.forEach\(function \(card\) \{\n    if \(card\.status === 'needs-review'/, 'attention scans every proof');
    assert.match(html, /var VOCAB = \[/);
    for (const term of ['pass\\*\\*', 'proved-\\?', 'dead-end', 'quarantined', 'spec\\?', 'rung', 'ledger', 'bundle', 'vacuous', 'polarity']) {
      assert.match(html, new RegExp(`term: '${term}'`), term);
    }
  });

  it('carries the whole manual as data, every section by title', () => {
    for (const section of MANUAL) assert.ok(html.includes(JSON.stringify(section.title).slice(1, -1)), section.title);
    assert.match(html, /"id":"start","title":"Start here"/);
  });

  it('keeps the page from scrolling sideways on a phone and honours reduced motion', () => {
    assert.match(html, /@media \(max-width: 720px\)/);
    assert.match(html, /\.tbl \{ display: block; overflow-x: auto; \}/);
    assert.match(html, /\.drawer \{ width: 100vw; \}/);
    assert.match(html, /prefers-reduced-motion: reduce/);
  });
});

describe('the manual parser', () => {
  it('turns tags into nodes, keeps only class, decodes entities, and never emits markup', () => {
    const nodes = parseManualHtml('<p class="lead">Run <code>wow &lt;flow&gt;</code> &amp; read the <b>report</b>.<br>Done</p><table class="ref"><tr><th>a</th><td>1 &rarr; 2</td></tr></table>');
    assert.deepEqual(nodes, [
      { t: 'p', c: 'lead', k: ['Run ', { t: 'code', k: ['wow <flow>'] }, ' & read the ', { t: 'b', k: ['report'] }, '.', { t: 'br', k: [] }, 'Done'] },
      { t: 'table', c: 'ref', k: [{ t: 'tr', k: [{ t: 'th', k: ['a'] }, { t: 'td', k: ['1 → 2'] }] }] },
    ]);
  });

  it('drops attributes other than class, so nothing from the manual can carry a handler', () => {
    const nodes = parseManualHtml('<span class="x" onclick="alert(1)" data-y="z">t</span>');
    assert.deepEqual(nodes, [{ t: 'span', c: 'x', k: ['t'] }]);
  });

  it('parses every real manual section without losing text', () => {
    for (const section of MANUAL) {
      const nodes = parseManualHtml(section.html);
      const text = (list: unknown[]): string => list.map((n) => (typeof n === 'string' ? n : text((n as { k: unknown[] }).k))).join('');
      const plain = section.html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&rarr;/g, '→').replace(/&mdash;/g, '—');
      assert.equal(text(nodes), plain, section.id);
    }
  });
});
