/**
 * newUI — the one-page surface at `/new` (docs/one-page-ui-spec.md).
 *
 * Page-string assertions, the same way `wow-ui.test.ts` pins wowUI: the page
 * is one self-contained document built through `el()`, it composes wowUI's
 * script rather than forking it, and every feature the spec's retention
 * ledger names has a hook in the source. Plus the manual parser, which is the
 * one piece of new server-side logic: it turns our own static HTML into data
 * so the page needs no `innerHTML` at all.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { COMMANDS } from '../src/ui/commands.js';
import { MANUAL } from '../src/ui/manual.js';
import { parseManualHtml, renderNewUi } from '../src/ui/new-ui-html.js';

describe('the newUI page', () => {
  const html = renderNewUi();

  it('cannot phone home — it is one self-contained document', () => {
    assert.doesNotMatch(html, /<script src=|rel="stylesheet"|fonts\.googleapis|@import/);
    // The manual's own prose carries a literal `http://…` placeholder; nothing else may.
    assert.doesNotMatch(html, /https?:\/\/(?!localhost|www\.w3\.org|…)/);
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

  it('composes wowUI rather than forking it: the base functions are renamed, the rest replaced', () => {
    for (const name of ['wowOpenLauncher', 'wowLauncherBox', 'wowPost', 'wowDataSignature']) {
      assert.equal((html.match(new RegExp(`function ${name}\\(`, 'g')) ?? []).length, 1, name);
    }
    // wowUI's evidence machinery ships unchanged: the checks table, the drawer, the launcher gate.
    for (const name of ['checksTable', 'evidencePanel', 'claimsGate', 'recomputeLanes', 'agentActionLog', 'streamJob', 'outputSection', 'jobForRun', 'progressBar', 'tqdmReadout']) {
      assert.match(html, new RegExp(`function ${name}\\(`), name);
    }
  });

  it('is one page: six anchored sections, no router, old addresses mapped', () => {
    for (const id of ['now', 'start', 'runs', 'library', 'machinery', 'help']) {
      assert.match(html, new RegExp(`id="sec-${id}"`), id);
    }
    assert.match(html, /var LEGACY_HASH = \{/);
    for (const old of ['history', 'healed', 'attention', 'reports', 'keys', 'repos', 'flows', 'cache', 'manual']) {
      assert.match(html, new RegExp(`\\b${old}: '`), `old hash #${old} lands somewhere`);
    }
    assert.doesNotMatch(html, /location\.href = '\/'/, 'no link out to another surface');
  });

  it('keeps the launcher inline, with a fourth segment that offers every other command', () => {
    assert.match(html, /id: 'launcher'/);
    assert.match(html, /'More commands'/);
    assert.match(html, /var MORE_EXCLUDED = \['go', 'catalog-claims', 'catalog-run', 'run'\]/);
    assert.match(html, /S\.meta\.commands/);
    assert.doesNotMatch(html, /openStartModal/);
    // The rule survives: nobody is asked to type a flow. Running one is an action on its row.
    assert.doesNotMatch(html, /The flow to run|Start from a flow on disk|Paste a flow/);
    assert.doesNotMatch(html, /commandId: 'run'/);
    assert.match(html, /function openRunForm\(flowPaths\)/);
    assert.match(html, /\{ flow: true \}/, 'the flow field is locked when opened from a row');
  });

  it('renders the command form from the spec, the right way round', () => {
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
    for (const group of ['Recording', 'Behaviour', 'Chrome', 'Output']) assert.match(html, new RegExp(`\\['${group}', \\[`));
    // Every advanced browser flag is placed in a group, so none lands in "Other options" by accident.
    const grouped = new Set([...html.matchAll(/\['(?:Recording|Behaviour|Chrome|Output)', \[([^\]]*)\]/g)].flatMap((m) => m[1]!.match(/'[^']+'/g)!.map((s) => s.slice(1, -1))));
    const browserFlags = COMMANDS.find((c) => c.id === 'crawl')!.fields.filter((f) => f.advanced).map((f) => f.name);
    for (const name of browserFlags) assert.ok(grouped.has(name), `${name} is grouped`);
  });

  it('says what the words mean, and what every number is a number of', () => {
    assert.match(html, /var VOCAB = \[/);
    for (const term of ['pass\\*\\*', 'proved-\\?', 'dead-end', 'quarantined', 'rung', 'ledger', 'bundle', 'vacuous', 'polarity']) {
      assert.match(html, new RegExp(`term: '${term}'`), term);
    }
    assert.match(html, /'of the last ' \+ recent\.length/, 'the proved tile carries its denominator');
    assert.match(html, /more stopped catalog run\(s\) — show all/, 'no silent cap on the banners');
    assert.match(html, /S\.proofs\.forEach\(function \(card\) \{\n    if \(card\.status === 'needs-review'/, 'attention scans every proof');
    assert.match(html, /function legendModal\(/);
  });

  it('uses one destructive idiom, and never window.prompt', () => {
    assert.match(html, /var DESTRUCTIVE = \{/);
    assert.match(html, /'cache-forget': function/);
    assert.match(html, /'history-clear': function/);
    assert.match(html, /function confirmModal\(/);
    assert.match(html, /function promptModal\(/);
    assert.match(html, /function trapFocus\(/);
    const newPart = html.slice(html.indexOf('newUI =='));
    assert.doesNotMatch(newPart, /window\.prompt/);
  });

  it('shows the header status on every poll and never a key', () => {
    assert.match(html, /function renderStatus\(/);
    assert.match(html, /'browser in use — one run at a time'/);
    assert.match(html, /' roles keyed'/);
    assert.doesNotMatch(html, /apiKey|api_key|process\.env/);
  });

  it('folds History into Runs and keeps Failed runs distinct', () => {
    assert.match(html, /\['flow', 'By flow'\], \['every', 'Every run'\]/);
    assert.match(html, /\['latest', 'Latest'\], \['name', 'Name'\]/);
    assert.match(html, /localeCompare\(b\.name, undefined, \{ numeric: true \}\)/);
    assert.match(html, /Failed runs — no proof was produced/);
    assert.match(html, /\/api\/failed-runs/);
  });

  it('carries the whole manual as data, every section by title', () => {
    for (const section of MANUAL) assert.ok(html.includes(JSON.stringify(section.title).slice(1, -1)), section.title);
    assert.match(html, /"id":"start","title":"Start here"/);
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
