/**
 * The catalog report (`src/reporter/catalog-report.ts`).
 *
 * Mostly unit-tier: the render is a pure function over ledger-shaped cases,
 * and every claim the page makes (grouping, embedding, the two panes, export)
 * is a string here.
 *
 * One tier above it, gated on CDP: **that the embedded recording actually
 * plays.** No string check can prove that. Chrome refuses a `data:` video
 * silently — the element sits at `readyState 0` with no error, which reads
 * exactly like a corrupt file — and the whole Blob indirection exists because
 * of it. A test that asserted only the markup would pass on a report whose
 * every player spins forever, which is the bug this feature was written to
 * fix. It runs against the real `tests/fixtures/recording.webm`, on the same
 * "a reader tested only against its own writer proves nothing" rule as the
 * `.xlsx` and `.pdf` there.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ProofBundle, ProofStep } from '../src/engine/proof-bundle.js';
import {
  RECORDING_BUDGET_BYTES,
  REPORT_HTML_CEILING_BYTES,
  SCREENSHOT_BUDGET_BYTES,
  catalogReportPath,
  renderCatalogReport,
  verdictChipOf,
  type CatalogReportCase,
} from '../src/reporter/catalog-report.js';

function step(over: Partial<ProofStep>): ProofStep {
  return {
    index: 0, action: 'goto', intent: undefined, selector: null, resolvedSelector: null,
    resolution: null, status: 'passed', startedAt: '2026-08-31T04:00:00.000Z', durationMs: 350,
    url: 'http://localhost:3000/en/login',
    ...over,
  } as ProofStep;
}

function bundle(steps: ProofStep[], over: Partial<ProofBundle> = {}): ProofBundle {
  return {
    runId: 'r1', name: 'PL_02_01 first', status: 'passed',
    startedAt: '2026-08-31T04:00:00.000Z', finishedAt: '2026-08-31T04:01:00.000Z',
    durationMs: 60_000, caseDurationMs: 61_000, cdpUrl: null, cachePath: null, healerModel: null,
    summary: { totalSteps: steps.length, passed: steps.length, failed: 0 } as ProofBundle['summary'],
    defects: [], steps,
    ...over,
  } as ProofBundle;
}

function kase(over: Partial<CatalogReportCase>): CatalogReportCase {
  return {
    id: 'PL_02_01', name: 'PL_02_01 first', scenario: 'PL_02', verdict: 'passed',
    status: 'passed', reason: null, bundle: bundle([step({})]), history: [],
    ...over,
  };
}

describe('grouping and coverage', () => {
  it('groups by scenario with a passed-count; a never-ran case is counted and folded, a blocked one with no bundle is a row', () => {
    const html = renderCatalogReport({
      title: 'be100', runKey: 'be100-csv@2026', generatedAt: null,
      cases: [
        kase({}),
        kase({ id: 'PL_02_02', name: 'PL_02_02 second', verdict: 'never-ran', status: null, bundle: null }),
        kase({ id: 'PL_02_03', name: 'PL_02_03 third', verdict: 'blocked', status: null, bundle: null, reason: 'the run was paused' }),
        kase({ id: 'PL_06_01', name: 'PL_06_01 other', scenario: 'PL_06' }),
      ],
    });
    assert.match(html, /<section class="scenario"><div class="shead">PL_02/);
    assert.match(html, /PL_06/);
    assert.match(html, /1 of 3 passed/);
    assert.match(html, />never ran</);
    // The never-ran row lives in the fold (its id still in the DOM), the blocked row is a section of its own.
    assert.match(html, /<details class="never-ran"[^>]*>[\s\S]*PL_02_02/);
    assert.match(html, /No steps were recorded — the run was paused/);
  });

  it('the chip follows the two-family taxonomy', () => {
    assert.equal(verdictChipOf(kase({ verdict: 'failed', status: 'dead-end' })).label, 'test failed (dead-end)');
    assert.equal(verdictChipOf(kase({ verdict: 'failed', status: 'error' })).label, 'system error');
    assert.equal(verdictChipOf(kase({ verdict: 'passed', status: 'passed-with-issues' })).label, 'pass**');
    assert.equal(verdictChipOf(kase({ verdict: 'review', status: 'needs-review' })).label, 'needs review');
  });
});

describe('the two panes', () => {
  it('left holds expandable steps with detail; right holds the time record with the slow budget named', () => {
    const html = renderCatalogReport({
      title: 't', runKey: null, generatedAt: null,
      cases: [kase({
        history: ['newly broken — passed until yesterday'],
        bundle: bundle([
          step({ index: 0, intent: 'open the page' }),
          step({ index: 1, action: 'click', selector: 'role=button[name="Save" i]', status: 'failed', durationMs: 2500, error: 'no element matches' }),
        ], { status: 'failed', notes: ['pre-run dead-end risk 20%'] }),
        verdict: 'failed', status: 'failed',
      })],
    });
    assert.match(html, /class="steps-pane"/);
    assert.match(html, /class="time-pane"/);
    assert.match(html, /<details class="step no"/);
    assert.match(html, /no element matches/);
    assert.match(html, /Time record — /);
    assert.match(html, /tbar slow broke/);
    assert.match(html, /2s fast-path budget/);
    assert.match(html, /From the run history/);
    assert.match(html, /newly broken — passed until yesterday/);
    assert.match(html, /Run notes/);
  });
});

describe('embedded evidence and the budget', () => {
  it('embeds screenshots as data URIs; a failure still is embedded past the budget, a routine one is omitted with a note', () => {
    const big = 'A'.repeat(SCREENSHOT_BUDGET_BYTES + 10);
    const html = renderCatalogReport({
      title: 't', runKey: null, generatedAt: null,
      cases: [
        kase({ bundle: bundle([step({ screenshot: big })]) }), // routine, over budget alone
        kase({
          id: 'PL_02_03', name: 'PL_02_03 f', verdict: 'failed', status: 'failed',
          bundle: bundle([step({ status: 'failed', screenshot: 'FAILSHOT' })], { status: 'failed' }),
        }),
      ],
    });
    assert.match(html, /data:image\/jpeg;base64,FAILSHOT/, 'failure stills always embed');
    assert.ok(!html.includes(big), 'the over-budget routine still is not embedded');
    assert.match(html, /omitted for size — it stays in the proof bundle/);
    assert.match(html, /routine screenshot\(s\) omitted/);
  });

  it('keeps a small report byte-identical when the optional spill sink is unused', () => {
    const input = {
      title: 't', runKey: null, generatedAt: null,
      cases: [kase({ bundle: bundle([step({ screenshot: 'SMALLSHOT' })]) })],
    };
    const withoutSink = renderCatalogReport(input);
    const withUnusedSink = renderCatalogReport({
      ...input,
      spillScreenshot: () => {
        throw new Error('a small report must not call the spill sink');
      },
    });

    assert.equal(withUnusedSink, withoutSink);
    assert.equal((withUnusedSink.match(/data:image/g) ?? []).length, 1);
    assert.ok(!withUnusedSink.includes('shots/'));
  });

  it('spills a routine screenshot after the inline budget and links the returned relative href', () => {
    const routine = 'QUJD'.repeat(250_000);
    const spilled = 'SPILL'.repeat(200_000);
    const calls: Array<{ caseId: string; stepIndex: number; base64: string }> = [];
    const cases = Array.from({ length: 16 }, (_, index) => {
      const id = `PL_02_${String(index + 1).padStart(2, '0')}`;
      return kase({
        id,
        name: `${id} case`,
        bundle: bundle([step({ index: index === 15 ? 7 : 0, screenshot: index === 15 ? spilled : routine })]),
      });
    });

    const html = renderCatalogReport({
      title: 't', runKey: null, generatedAt: null, cases,
      spillScreenshot: (caseId, stepIndex, base64) => {
        calls.push({ caseId, stepIndex, base64 });
        return 't-media/shots/pl-02-16-7.jpg';
      },
    });

    assert.deepEqual(calls, [{ caseId: 'PL_02_16', stepIndex: 7, base64: spilled }]);
    assert.match(html, /src="t-media\/shots\/pl-02-16-7\.jpg"/);
    assert.ok(!html.includes(`data:image/jpeg;base64,${spilled}`));
  });

  it('keeps a failure inline after routine budget is spent, but spills one that would cross the hard ceiling', () => {
    const routine = 'A'.repeat(SCREENSHOT_BUDGET_BYTES + 1);
    const sinkCalls: string[] = [];
    const prioritized = renderCatalogReport({
      title: 't', runKey: null, generatedAt: null,
      cases: [
        kase({ bundle: bundle([step({ screenshot: routine })]) }),
        kase({
          id: 'PL_02_02', name: 'PL_02_02 failed', verdict: 'failed', status: 'failed',
          bundle: bundle([step({ status: 'failed', screenshot: 'FAILSHOT' })], { status: 'failed' }),
        }),
      ],
      spillScreenshot: (caseId) => {
        sinkCalls.push(caseId);
        return `t-media/shots/${caseId}.jpg`;
      },
    });
    assert.deepEqual(sinkCalls, ['PL_02_01']);
    assert.match(prioritized, /data:image\/jpeg;base64,FAILSHOT/);

    const overCeiling = 'A'.repeat(REPORT_HTML_CEILING_BYTES + 1);
    const ceilingCalls: string[] = [];
    const capped = renderCatalogReport({
      title: 't', runKey: null, generatedAt: null,
      cases: [kase({
        id: 'PL_02_03', name: 'PL_02_03 failed', verdict: 'failed', status: 'failed',
        bundle: bundle([step({ status: 'failed', screenshot: overCeiling })], { status: 'failed' }),
      })],
      spillScreenshot: (caseId) => {
        ceilingCalls.push(caseId);
        return 't-media/shots/ceiling.jpg';
      },
    });
    assert.deepEqual(ceilingCalls, ['PL_02_03']);
    assert.match(capped, /src="t-media\/shots\/ceiling\.jpg"/);
    assert.doesNotMatch(capped, /data:image\/jpeg;base64,/);
  });

  it('falls back to the proof-bundle omission when the spill sink cannot take a screenshot', () => {
    const html = renderCatalogReport({
      title: 't', runKey: null, generatedAt: null,
      cases: [kase({ bundle: bundle([step({ screenshot: 'A'.repeat(SCREENSHOT_BUDGET_BYTES + 1) })]) })],
      spillScreenshot: () => null,
    });

    assert.match(html, /omitted for size — it stays in the proof bundle/);
    assert.match(html, /routine screenshot\(s\) omitted/);
  });

  it('adds the beside-this-file spill count only when a screenshot spilled', () => {
    const input = {
      title: 't', runKey: null, generatedAt: null,
      cases: [kase({ bundle: bundle([step({ screenshot: 'A'.repeat(SCREENSHOT_BUDGET_BYTES + 1) })]) })],
    };
    const withoutSpill = renderCatalogReport(input);
    const withSpill = renderCatalogReport({
      ...input,
      spillScreenshot: () => 't-media/shots/pl-02-01-0.jpg',
    });

    assert.ok(!withoutSpill.includes('screenshot(s) written beside this file'));
    assert.match(withSpill, /1 screenshot\(s\) written beside this file in t-media\/shots\//);
  });
});

describe('export', () => {
  it('a proved case exports to its own workbook, relative to this file, beside the recording', () => {
    const html = renderCatalogReport({ title: 't', runKey: 'pl-02@2026-08-31T04:00:00.000Z', generatedAt: null, cases: [kase({})] });
    assert.match(html, /<a class="btn export-case" download href="pl-02-2026-08-31t04-00-00-000z-media\/pl-02-01\.xlsx"/);
    assert.match(html, /Export \(Excel\)/);
    // The link must not toggle the case open as a side effect of downloading.
    assert.match(html, /export-case" download href="[^"]+" onclick="event\.stopPropagation\(\)"/);
  });

  it('a case that did not pass has the button DISABLED — there is no proof to hand over', () => {
    for (const verdict of ['failed', 'blocked', 'review'] as const) {
      const html = renderCatalogReport({
        title: 't', runKey: null, generatedAt: null,
        cases: [kase({ verdict, status: 'failed', bundle: bundle([step({ status: 'failed' })]) })],
      });
      assert.match(html, /<button class="btn export-case" type="button" disabled/, verdict);
      assert.ok(!html.includes('pl-02-01.xlsx'), `${verdict} must not link a workbook`);
    }
    // A never-ran case has no section at all, so no button either — and no workbook link.
    const folded = renderCatalogReport({ title: 't', runKey: null, generatedAt: null, cases: [kase({ verdict: 'never-ran', status: null, bundle: null })] });
    assert.ok(!folded.includes('export-case'));
    assert.ok(!folded.includes('pl-02-01.xlsx'));
  });

  it('the header links the run workbook and still exports the whole catalog client-side', () => {
    const html = renderCatalogReport({ title: 't', runKey: 'pl-02@2026-08-31T04:00:00.000Z', generatedAt: null, cases: [kase({})] });
    assert.match(html, /function exportCatalog\(/);
    assert.match(html, /Export catalog/);
    assert.match(html, /href="pl-02-2026-08-31t04-00-00-000z-passed\.xlsx"/);
  });

  it('a live report says it is in progress and reloads itself; a finished one does neither', () => {
    const cases = [kase({}), kase({ id: 'PL_02_02', name: 'PL_02_02 later', verdict: 'never-ran', status: null, bundle: null })];
    const live = renderCatalogReport({ title: 't', runKey: null, generatedAt: null, cases, live: true });
    assert.match(live, /in progress — 1 of 2 case\(s\) finished/);
    assert.match(live, /<meta http-equiv="refresh" content="60"\/>/);
    const done = renderCatalogReport({ title: 't', runKey: null, generatedAt: null, cases });
    assert.ok(!done.includes('http-equiv="refresh"'));
    assert.ok(!done.includes('in progress'));
  });
});

describe('the case page link', () => {
  it('links the case name to the media folder by default, to the href the writer gives when it does, and carries the ledger path for the panel', () => {
    const base = { title: 't', runKey: 'pl-02@2026-08-31T04:00:00.000Z', generatedAt: null };
    const plain = renderCatalogReport({ ...base, cases: [kase({})] });
    assert.match(plain, /<a class="open-case" href="pl-02-2026-08-31t04-00-00-000z-media\/pl-02-01\.html" onclick/);
    const own = renderCatalogReport({
      ...base,
      cases: [kase({ reportPath: '/runs/x/humi-en-login-pl-02/01-catalog-pl-02-01.html' })],
      casePageHref: () => '../runs/x/humi-en-login-pl-02/01-catalog-pl-02-01.html',
    });
    assert.match(own, /<a class="open-case" href="\.\.\/runs\/x\/humi-en-login-pl-02\/01-catalog-pl-02-01\.html" data-report="\/runs\/x\/humi-en-login-pl-02\/01-catalog-pl-02-01\.html" onclick/);
    assert.match(own, /a\.href = '\/view\?path=' \+ encodeURIComponent/);
    // A case with no bundle has no page and no link.
    const none = renderCatalogReport({ ...base, cases: [kase({ verdict: 'blocked', status: null, bundle: null })] });
    assert.doesNotMatch(none, /<a class="open-case"/);
  });
});

describe('safety and paths', () => {
  it('escapes case names — application text cannot become markup', () => {
    const html = renderCatalogReport({
      title: '<script>x</script>', runKey: null, generatedAt: null,
      cases: [kase({ name: 'PL_02_01 <img src=x onerror=alert(1)>' })],
    });
    assert.ok(!html.includes('<img src=x'));
    assert.ok(!html.includes('<script>x</script>'));
  });

  it('the path is reports/<runKey slug>.html, stable per run key', () => {
    const p = catalogReportPath('be100-csv@2026-08-31T03:33:23.997Z', 'be100', '/tmp/x');
    assert.match(p, /^\/tmp\/x\/reports\/be100-csv-2026-08-31t03-33-23-997z\.html$/);
    assert.equal(catalogReportPath(null, 'My Catalog', '/tmp/x'), '/tmp/x/reports/my-catalog.html');
  });
});

/* ------------------------------------------------------------- narration */

/**
 * `ProofStep.narration` in the catalog report's step detail (2026-09-07).
 * The same sentence, the same label and the same attribution as the per-run
 * report — both surfaces read it through `stepNarration` so they cannot
 * disagree on the wording — placed after every recorded fact of the step and
 * before none of them.
 */
describe('a step narrated in plain language', () => {
  const narration = { text: 'Looked for "Create Plan" and found "สร้างแผนสวัสดิการ" instead.', by: 'groq:llama-3.3-70b', at: '2026-09-07T00:00:00.000Z' };
  const narratedCase = (over: Partial<ProofStep> = {}): CatalogReportCase =>
    kase({
      bundle: bundle([
        step({
          index: 0, action: 'expectModal', intent: 'the Create Plan dialog is shown',
          selector: 'role=dialog[name="Create Plan" i]', status: 'failed', error: 'could not resolve',
          narration, ...over,
        } as Partial<ProofStep>),
      ]),
    });

  it('renders the sentence in the step detail, labelled, explained and signed', () => {
    const html = renderCatalogReport({ title: 'be100', runKey: null, generatedAt: null, cases: [narratedCase()] });
    const line = html.match(/<div class="narration">[\s\S]*?<\/div>/)?.[0] ?? '';
    assert.notEqual(line, '', 'the narration renders in the step body');
    // The catalog report's `esc` escapes `&<>"` — enough inside a double-quoted
    // attribute, and the same escaping every other title on this page uses.
    assert.match(line, /<span class="narr-k" title="A model's plain-language reading of this step's own recorded line[^"]*Descriptive only: it sets no status[^"]*">in plain language<\/span>/);
    assert.match(line, /Looked for &quot;Create Plan&quot; and found &quot;สร้างแผนสวัสดิการ&quot; instead\./, 'application text is quoted, never translated');
    assert.match(line, /— written by groq:llama-3\.3-70b<\/em>/, 'attributed where it is read');
  });

  it('comes after the step\'s recorded facts and displaces none of them', () => {
    const html = renderCatalogReport({ title: 'be100', runKey: null, generatedAt: null, cases: [narratedCase()] });
    const body = html.slice(html.indexOf('<div class="sbody">'));
    for (const before of ['<span>intent</span>', '<span>selector</span>', '<div class="kv err"><span>error</span>']) {
      assert.ok(body.indexOf(before) >= 0, `${before} still renders`);
      assert.ok(body.indexOf(before) < body.indexOf('<div class="narration">'), `${before} is read before the narration, not after it`);
    }
  });

  it('escapes the model\'s prose and the model\'s name', () => {
    const html = renderCatalogReport({
      title: 'be100', runKey: null, generatedAt: null,
      cases: [narratedCase({ narration: { text: '<script>alert(1)</script>', by: '<img src=x onerror=1>', at: 'now' } } as Partial<ProofStep>)],
    });
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.ok(!html.includes('<img src=x'));
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  });

  it('a case with no narration renders exactly the bytes it did before narration existed', () => {
    const c = narratedCase();
    const withNarration = renderCatalogReport({ title: 'be100', runKey: null, generatedAt: null, cases: [c] });
    delete (c.bundle!.steps[0] as { narration?: unknown }).narration;
    const plain = renderCatalogReport({ title: 'be100', runKey: null, generatedAt: null, cases: [c] });
    assert.doesNotMatch(plain, /class="narration"|in plain language<\/span>/);
    assert.equal(withNarration.replace(/<div class="narration">[\s\S]*?<\/div>/g, ''), plain);
  });
});

/* -------------------------------------------- the leg that decided nothing */

/**
 * The same fold as the per-run report, in the step detail pane (2026-09-08).
 * Both surfaces ask `inconsequentialAgentLeg`, so they cannot disagree about
 * which legs are noise or about the words they fold them behind — and neither
 * of them removes anything from the document.
 */
describe('an agent leg that did not decide its step', () => {
  const leg = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    goal: 'open the Company Code picker',
    model: 'stub',
    success: false,
    summary: 'agent found nothing the goal names to act on',
    turns: 2,
    maxSteps: null,
    latencyMs: 5,
    actions: [{ index: 0, action: 'scroll', selector: '', value: null, url: 'u', reasoning: 'look further down', ok: true, durationMs: 1 }],
    ...over,
  });

  const legCase = (over: Partial<ProofStep> = {}, agent: Record<string, unknown> = leg()): CatalogReportCase =>
    kase({
      bundle: bundle([
        step({ index: 0, action: 'selectOption', intent: 'set the rule type', selector: 'role=combobox[name="Company Code" i]', agent, ...over } as Partial<ProofStep>),
      ]),
    });

  const render = (c: CatalogReportCase): string => renderCatalogReport({ title: 'be100', runKey: null, generatedAt: null, cases: [c] });

  it('folds a leg that did not decide the outcome, and keeps every turn inside the disclosure', () => {
    const html = render(legCase());
    // The catalog report's `esc` escapes `&<>"` and leaves the apostrophe —
    // valid as element content, and the same escaping every other line here uses.
    assert.match(html, /<details class="aside-leg"><summary>agent leg — did not affect this step's outcome: the step passed on the flow's own selector regardless<\/summary><div class="agent">/);
    // Nothing left the pane: the summary line and the turn are still there.
    assert.match(html, /agent found nothing the goal names to act on \(2 turn\(s\)\)/);
    assert.match(html, /<ol class="turns"><li class="ok">scroll/);
    assert.doesNotMatch(html, /<details class="aside-leg" open>/);
  });

  it('says "it never engaged a control the goal names" for a look-only leg — the same words the per-run report uses', () => {
    const html = render(legCase({}, leg({ lookedOnly: true, endedBy: 'no-progress' })));
    assert.match(html, /<summary>agent leg — did not affect this step's outcome: it never engaged a control the goal names<\/summary>/);
  });

  it('never folds a failing step, a hold, or the model\'s own "fail" claim', () => {
    const held = { reason: 'irreversible', rule: 'manifest', message: 'no approval' };
    for (const c of [
      legCase({ status: 'failed', error: 'could not resolve' }),
      legCase({ blocked: held } as Partial<ProofStep>),
      legCase({}, leg({ blocked: held })),
      legCase({}, leg({ endedBy: 'fail' })),
      legCase({}, leg({ success: true })),
    ]) {
      const html = render(c);
      assert.doesNotMatch(html, /<details class="aside-leg"/);
      assert.match(html, /<div class="agent">/, 'the leg still renders, just not folded');
    }
  });

  it('a case with no qualifying step renders exactly the bytes it did before folding existed', () => {
    const c = legCase();
    const folded = render(c);
    // The one field the predicate reads and this page renders nowhere.
    (c.bundle!.steps[0]!.agent as unknown as { endedBy?: string }).endedBy = 'fail';
    const plain = render(c);
    // The stylesheet always carries the rule; the MARKUP is what must be gone.
    assert.doesNotMatch(plain, /<details class="aside-leg"/);
    assert.equal(
      folded.replace(/<details class="aside-leg"><summary>[^<]*<\/summary>([\s\S]*?)<\/details>/, '$1'),
      plain,
      'the fold is a wrapper; every other byte of the report is the same',
    );
  });

  it('escapes the leg it folds and composes the summary from constants alone', () => {
    const html = render(legCase({}, leg({ goal: '<script>alert(1)</script>', summary: '<img src=x onerror=1>' })));
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.ok(!html.includes('<img src=x'));
    const summaries = [...html.matchAll(/<details class="aside-leg"><summary>([^<]*)<\/summary>/g)].map((m) => m[1]);
    assert.deepEqual(summaries, ["agent leg — did not affect this step's outcome: the step passed on the flow's own selector regardless"]);
  });
});

/* -------------------------------------------------------------- findings */

/**
 * The block under the tally (2026-09-05, `findings.ts`): root causes first,
 * every member linked to its section, statuses exactly as sealed, and the
 * never-ran remainder as ONE list rather than a section each.
 */
describe('findings lead the report', () => {
  const apiFailure = (id: string, status: string, path: string): CatalogReportCase =>
    kase({
      id, name: `${id} api`, scenario: 'BE_01', verdict: 'failed', status,
      bundle: bundle(
        [
          step({ index: 0, action: 'request', url: null, request: { method: 'POST', url: `http://api.test${path}`, status: 500, durationMs: 80 } } as Partial<ProofStep>),
          step({ index: 1, action: 'expectStatus', url: null, status: status === 'error' ? 'error' : 'failed', detail: { expected: [201], actual: '500 Internal Server Error' } }),
        ],
        { status: status as ProofBundle['status'] },
      ),
    });
  const urlFailure = (id: string): CatalogReportCase =>
    kase({
      id, name: `${id} url`, scenario: 'UI_01', verdict: 'failed', status: 'failed',
      bundle: bundle([step({ index: 0, action: 'expectUrl', status: 'failed', url: 'http://app.test/en/login', detail: { expected: '/plans', actual: 'http://app.test/en/login' } })], { status: 'failed' }),
    });
  const anchorOf = (id: string): string => id.toLowerCase().replace(/_/g, '-');

  it('states the exact count line, links every member to its section, and shows statuses as the ledger sealed them', () => {
    const html = renderCatalogReport({
      title: 't', runKey: null, generatedAt: null,
      cases: [
        apiFailure('BE_01_01', 'failed', '/v1/plans'),
        apiFailure('BE_01_02', 'error', '/v1/plans'),
        urlFailure('UI_01_01'),
        kase({ id: 'UI_01_02', name: 'UI_01_02 lone', scenario: 'UI_01', verdict: 'failed', status: 'failed', bundle: bundle([step({ status: 'failed' })], { status: 'failed' }) }),
        kase({}),
      ],
    });
    const block = html.match(/<section class="findings" id="findings">[\s\S]*?<\/section>/)?.[0] ?? '';
    assert.ok(block !== '', 'the block exists');
    assert.ok(block.includes('2 findings account for 3 of 4 non-passing cases · 1 unclustered'), block.slice(0, 400));
    for (const id of ['BE_01_01', 'BE_01_02', 'UI_01_01', 'UI_01_02']) {
      assert.ok(block.includes(`<a href="#case-${anchorOf(id)}">${id}</a>`), `${id} links to its section`);
      assert.ok(html.includes(`<details class="case" id="case-${anchorOf(id)}"`), `${id} has a section`);
    }
    assert.ok(block.includes('POST /v1/plans answered 500'));
    // The sealed status, not a relabel: the error case reads `error` and is counted as one.
    assert.match(block, /BE_01_02<\/a> <code class="sealed">error<\/code>/);
    assert.ok(block.includes('2 cases · failed: 1 · error: 1'));
    assert.ok(block.includes('<span class="fkind">api</span>'));
    assert.ok(block.includes('<details class="finding unclustered">'));
    assert.ok(!block.includes('PL_02_01'), 'a passed case is in no finding');
  });

  it('a run with nothing failed has no findings block', () => {
    const html = renderCatalogReport({ title: 't', runKey: null, generatedAt: null, cases: [kase({})] });
    assert.ok(!html.includes('<section class="findings"'));
  });

  it('a dependent is listed under its prerequisite\'s finding, marked', () => {
    const html = renderCatalogReport({
      title: 't', runKey: null, generatedAt: null,
      cases: [
        apiFailure('BE_01_01', 'failed', '/v1/plans'),
        kase({ id: 'BE_01_02', name: 'BE_01_02 dep', scenario: 'BE_01', verdict: 'blocked', status: null, bundle: null, reason: 'depends on BE_01_01 which failed' }),
      ],
    });
    const block = html.match(/<section class="findings" id="findings">[\s\S]*?<\/section>/)?.[0] ?? '';
    assert.ok(block.includes('1 finding account for 2 of 2 non-passing cases · 0 unclustered'));
    assert.match(block, /BE_01_02<\/a> <code class="sealed">blocked<\/code> <em[^>]*>↳ depends on BE_01_01<\/em>/);
  });

  it('252 never-ran cases render as ONE details block listing every id, and no section each', () => {
    const neverRan = Array.from({ length: 252 }, (_, i) =>
      kase({
        id: `NR_${String(Math.floor(i / 20) + 1).padStart(2, '0')}_${String((i % 20) + 1).padStart(2, '0')}`,
        name: `never ${i}`, scenario: `NR_${Math.floor(i / 20) + 1}`, verdict: 'never-ran', status: null, bundle: null,
      }),
    );
    const html = renderCatalogReport({ title: 't', runKey: null, generatedAt: null, cases: [kase({}), ...neverRan] });
    assert.equal((html.match(/<details class="never-ran"/g) ?? []).length, 1);
    const fold = html.match(/<details class="never-ran"[\s\S]*?<\/details>/)?.[0] ?? '';
    assert.ok(fold.includes('252 cases never ran'));
    assert.ok(fold.includes('>NR_07_13<'), 'a sampled id is in the list');
    assert.equal((fold.match(/class="nid"/g) ?? []).length, 252, 'every id is in the DOM');
    assert.equal((html.match(/<details class="case"/g) ?? []).length, 1, 'only the case that ran has a section');
    assert.ok(!html.includes('<details class="case" id="case-nr-07-13"'), 'no per-case section for a never-ran row');
    assert.match(html, /never ran: <b>252<\/b>/, 'the tally still counts them');
  });
});

/* --------------------------------------------------------- the recording */

/**
 * The film, and why it has to be here (2026-08-31). The runner's screenshot
 * default is video-aware: while it is filming, stills are taken only at
 * failures, because the film covers the rest. Measured on be100-rip's bundles,
 * that is exactly what they hold — all 13 non-passing cases carry stills and
 * 18 of 19 passing ones carry none. A report that dropped the recording
 * therefore left a reader with no evidence at all for every case that worked.
 */
const withVideo = (over: Partial<CatalogReportCase>, data: string, over2: Partial<ProofBundle> = {}): CatalogReportCase =>
  kase({
    ...over,
    bundle: bundle([step({}), step({ index: 1, action: 'click', videoOffsetMs: 2110 })], {
      video: { data, width: 960, height: 540 },
      ...over2,
    } as Partial<ProofBundle>),
  });

describe('the recording in the page', () => {
  const render = (cases: CatalogReportCase[]): string =>
    renderCatalogReport({ title: 't', runKey: null, generatedAt: null, cases });

  it('carries the bytes on an attribute, never as a data: URI', () => {
    const html = render([withVideo({ id: 'A' }, 'QUJD')]);
    // Chrome will not load a `data:` video — the element sits at readyState 0
    // forever with no error, which reads exactly like a corrupt recording.
    assert.match(html, /<video[^>]*data-webm="QUJD"/);
    assert.doesNotMatch(html, /src="data:video/);
    assert.match(html, /wowHydrateVideo/, 'and the page carries what turns it into a Blob');
  });

  it('keeps a small report byte-identical when both optional spill sinks are unused', () => {
    const input = {
      title: 't', runKey: null, generatedAt: null,
      cases: [withVideo({ id: 'A' }, 'QUJD')],
    };
    const current = renderCatalogReport(input);
    const withUnusedSinks = renderCatalogReport({
      ...input,
      spillScreenshot: () => {
        throw new Error('a small report must not spill screenshots');
      },
      spillRecording: () => {
        throw new Error('a small report must not spill recordings');
      },
    });

    assert.equal(withUnusedSinks, current);
    assert.match(withUnusedSinks, /<video[^>]*data-webm="QUJD"/);
    assert.doesNotMatch(withUnusedSinks, /<video[^>]* src=/);
  });

  it('spills an over-budget recording to a file-backed video and preserves the failure offset', () => {
    const recording = 'V'.repeat(RECORDING_BUDGET_BYTES + 1);
    const calls: Array<{ caseId: string; base64: string }> = [];
    const html = renderCatalogReport({
      title: 't', runKey: null, generatedAt: null,
      cases: [kase({
        id: 'PL_02_03', verdict: 'failed', status: 'failed',
        bundle: bundle([step({ status: 'failed', videoOffsetMs: 4500 })], {
          status: 'failed',
          video: { data: recording, width: 960, height: 540 },
        } as Partial<ProofBundle>),
      })],
      spillRecording: (caseId, base64) => {
        calls.push({ caseId, base64 });
        return 't-media/pl-02-03.webm';
      },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.caseId, 'PL_02_03');
    assert.ok(calls[0]?.base64 === recording);
    assert.match(html, /<video[^>]* src="t-media\/pl-02-03\.webm"[^>]*data-failure-offset="4\.50"/);
    assert.doesNotMatch(html, /<video[^>]*data-webm=/);
  });

  it('spills both media kinds when their shared inline total reaches the hard ceiling', () => {
    const firstRecording = 'V'.repeat(RECORDING_BUDGET_BYTES);
    const crossingScreenshot = 'S'.repeat(REPORT_HTML_CEILING_BYTES - RECORDING_BUDGET_BYTES + 1);
    const screenshotCalls: string[] = [];
    const recordingCalls: string[] = [];
    const html = renderCatalogReport({
      title: 't', runKey: null, generatedAt: null,
      cases: [
        withVideo({ id: 'PL_02_01' }, firstRecording),
        kase({
          id: 'PL_02_02', verdict: 'failed', status: 'failed',
          bundle: bundle([step({ status: 'failed', screenshot: crossingScreenshot })], {
            status: 'failed',
            video: { data: 'NEXT', width: 960, height: 540 },
          } as Partial<ProofBundle>),
        }),
      ],
      spillScreenshot: (caseId) => {
        screenshotCalls.push(caseId);
        return 't-media/shots/pl-02-02-0.jpg';
      },
      spillRecording: (caseId) => {
        recordingCalls.push(caseId);
        return 't-media/pl-02-02.webm';
      },
    });

    assert.deepEqual(recordingCalls, ['PL_02_02']);
    assert.deepEqual(screenshotCalls, ['PL_02_02']);
    assert.match(html, /src="t-media\/pl-02-02\.webm"/);
    assert.match(html, /src="t-media\/shots\/pl-02-02-0\.jpg"/);
    assert.match(html, /1 screenshot\(s\) written beside this file[^<]* · 1 recording\(s\) written beside this file/);
  });

  it('uses the existing recording omission wording when its sink returns null', () => {
    const html = renderCatalogReport({
      title: 't', runKey: null, generatedAt: null,
      cases: [withVideo({ id: 'A' }, 'V'.repeat(RECORDING_BUDGET_BYTES + 1))],
      spillRecording: () => null,
    });

    assert.match(html, /the recording could not be embedded/);
    assert.doesNotMatch(html, /<video/);
  });

  it('does not decode until the case is opened', () => {
    const html = render([withVideo({ id: 'A' }, 'QUJD')]);
    assert.match(html, /preload="none"/);
    assert.match(html, /addEventListener\('toggle'/);
  });

  it('gives every filmed step a cue into the same file, on the summary where it can be seen', () => {
    const html = render([withVideo({ id: 'A' }, 'QUJD')]);
    assert.match(html, /data-seek="2\.11"/);
    // In the collapsed body a reader has to expand each step to discover that
    // seeking exists at all; a control nobody can see is not a control.
    const summary = /<summary>(?:(?!<\/summary>).)*data-seek/s;
    assert.match(html, summary);
  });

  it('opens a broken case ON the failure — the frame the recording was kept for', () => {
    const html = render([
      kase({
        id: 'A', verdict: 'failed',
        bundle: bundle([step({ index: 0, status: 'failed', videoOffsetMs: 4500 })], {
          video: { data: 'QUJD', width: 960, height: 540 },
        } as Partial<ProofBundle>),
      }),
    ]);
    assert.match(html, /data-failure-offset="4\.50"/);
  });

  it('keeps the old unlimited inline behaviour when no recording sink is supplied', () => {
    const html = renderCatalogReport({
      title: 't', runKey: null, generatedAt: null,
      cases: [withVideo({ id: 'A' }, 'x'.repeat(30_000_000))],
    });
    assert.match(html, /data-webm="x/);
    assert.doesNotMatch(html, /left out to keep this file portable/);
    assert.match(html, /data-seek=/);
  });

  it('says a recording FAILED differently from one that was never made', () => {
    const html = render([
      kase({
        id: 'A',
        bundle: bundle([step({})], {
          video: { data: '', width: 0, height: 0, omitted: 'the recording was 90MB' },
        } as Partial<ProofBundle>),
      }),
    ]);
    assert.match(html, /the recording was 90MB/);
  });

  it('an exported catalog takes the player and the bytes with it', () => {
    const html = render([withVideo({ id: 'A' }, 'QUJD')]);
    // The player rides the page as a value too, so a copy of the document
    // carries it; without it an export is a dead player in a file said to
    // hold the evidence.
    assert.match(html, /var WOW_PLAYER = /);
    // A Blob URL means nothing in another document, so it must be stripped…
    assert.match(html, /function wowStripBlobs/);
    // …while the base64 stays put, which is what makes the export playable.
    assert.match(html, /data-webm deliberately STAYS/);
  });
});

/* ------------------------------------------------- does it actually play */

const CDP_URL = process.env['WOWLIDATOR_CDP_URL'] ?? 'http://localhost:9222';

async function cdpAvailable(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/json/version`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

const browserReady = await cdpAvailable(CDP_URL);
const skipBrowser = browserReady
  ? false
  : `no CDP endpoint at ${CDP_URL} — start Chrome with --remote-debugging-port=9222 (npm run chrome)`;

describe('the recording plays (CDP)', { skip: skipBrowser }, () => {
  it('decodes on open, seeks from a step, and never toggles that step doing it', async () => {
    const { chromium } = await import('playwright');
    const webm = readFileSync(join(import.meta.dirname, 'fixtures', 'recording.webm')).toString('base64');
    const html = renderCatalogReport({
      title: 'plays', runKey: null, generatedAt: null,
      cases: [
        kase({
          id: 'A', verdict: 'failed',
          bundle: bundle(
            [step({ index: 0, videoOffsetMs: 0 }), step({ index: 1, action: 'click', videoOffsetMs: 500 })],
            { video: { data: webm, width: 960, height: 540 } } as Partial<ProofBundle>,
          ),
        }),
      ],
    });
    const file = join(mkdtempSync(join(tmpdir(), 'wow-catalog-')), 'report.html');
    writeFileSync(file, html, 'utf8');

    const browser = await chromium.connectOverCDP(CDP_URL);
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    try {
      await page.goto(`file://${file}`);
      // Nothing is decoded at load: a catalog holds dozens of these, and
      // building every Blob on first paint would stall the page to make
      // players nobody opened.
      assert.equal(await page.locator('video[data-wow-ready]').count(), 0);

      const kase1 = page.locator('details.case').first();
      await kase1.locator('> summary').click();
      // The test config has no DOM lib (tsconfig pins `types: ["node"]`), so
      // the page-side shapes are spelled structurally, as `src/` does.
      type VideoLike = { readyState: number; src: string; duration: number; currentTime: number; getAttribute(name: string): string | null };
      await page.waitForFunction(
        () => ((globalThis as { document?: { querySelector(sel: string): VideoLike | null } }).document?.querySelector('video')?.readyState ?? 0) >= 2,
        undefined,
        { timeout: 15_000 },
      );
      const video = kase1.locator('video').first();
      const state = await video.evaluate((el: VideoLike) => ({
        blob: el.src.startsWith('blob:'),
        duration: el.duration,
        kept: (el.getAttribute('data-webm') ?? '').length,
      }));
      assert.equal(state.blob, true, 'a Blob URL, because Chrome will not load a data: video');
      assert.ok(state.duration > 0, `the recording has a duration (${state.duration})`);
      assert.ok(state.kept > 0, 'and the base64 stays put, so an export of this case is playable');

      const seek = kase1.locator('button.seek').nth(1);
      assert.equal(await seek.isVisible(), true, 'the cue is on the summary, where a reader can see it');
      await seek.click();
      await page.waitForTimeout(500);
      assert.ok(
        (await video.evaluate((el: VideoLike) => el.currentTime)) > 0,
        'clicking a step cue moves the film',
      );
      assert.equal(
        await kase1.locator('details.step').nth(1).evaluate((el: { open: boolean }) => el.open),
        false,
        'and playing the film does not expand the step as a side effect',
      );
      assert.deepEqual(errors, []);
    } finally {
      await page.close().catch(() => undefined);
      await context.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    }
  });
});

/* --------------------------------------- the database check, and the step that decided nothing */

/**
 * The catalog report shows a database check the way the per-run report and
 * the workbook do (2026-09-08): the summary, the statement that answered the
 * claim with its bound parameters, and the rows as a real table. One
 * projection (`dbEvidence` in `step-facts.ts`), three surfaces — a fact added
 * to one page and not the other is the first thing a reader notices.
 */
describe('a database check shows the query it ran', () => {
  const dbCase = (db: Record<string, unknown>): CatalogReportCase =>
    kase({ bundle: bundle([step({ index: 0, action: 'expectDbRow', intent: 'the plan row is there', db: db as never } as Partial<ProofStep>)]) });

  const render = (c: CatalogReportCase): string =>
    renderCatalogReport({ title: 'be100', runKey: null, generatedAt: null, cases: [c] });

  const RECORD = {
    kind: 'row',
    table: 'benefit_plan',
    where: 'id = 42 AND session_token = [redacted]',
    expected: 'at least 1 row',
    observed: '1 row(s)',
    rows: [{ id: '42', name: 'Part time' }],
    rowsMatched: 42,
    durationMs: 12,
    statements: [{ sql: 'SELECT * FROM "benefit_plan" WHERE "id" = $1 LIMIT 25', params: ['42'], tables: ['benefit_plan'] }],
    note: 'read directly from the database while this flow ran',
  };

  it('renders the query, its parameters and the rows as a table with a header row', () => {
    const html = render(dbCase(RECORD));
    assert.match(html, /<span>db query<\/span><code>SELECT \* FROM &quot;benefit_plan&quot; WHERE &quot;id&quot; = \$1 LIMIT 25<\/code>/);
    assert.match(html, /<span>db parameters<\/span><code>\$1 = 42<\/code>/);
    assert.match(html, /<span>db rows returned<\/span><span>showing 1 of 42 row\(s\) — the sample is capped at 3<\/span>/);
    assert.match(html, /<thead><tr><th>id<\/th><th>name<\/th><\/tr><\/thead>/);
    assert.match(html, /<span>db where<\/span><span>id = 42 AND session_token = \[redacted\]<\/span>/);
    assert.match(html, /<span>db expected<\/span><span>at least 1 row<\/span>/);
  });

  it('escapes the statement and every cell, and carries no unredacted value', () => {
    const html = render(
      dbCase({ ...RECORD, rows: [{ password: '[redacted]', name: '<script>alert(1)</script>' }], statements: [{ sql: 'SELECT "p" FROM "u" -- <script>x</script>', params: ['[redacted]'] }] }),
    );
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.ok(!html.includes('-- <script>x</script>'));
    assert.match(html, /<th>password<\/th>/);
    assert.match(html, /<td>\[redacted\]<\/td>/);
  });

  it('a bundle sealed before the statement existed shows its summary and no query row', () => {
    const { statements: _dropped, rowsMatched: _also, ...older } = RECORD;
    const html = render(dbCase(older));
    assert.doesNotMatch(html, /<span>db query<\/span>/);
    assert.doesNotMatch(html, /<span>db parameters<\/span>/);
    assert.match(html, /<span>db where<\/span>/);
    assert.match(html, /<span>db rows returned<\/span><span>1 row\(s\)<\/span>/);
  });
});

/**
 * A broken step that decided nothing is folded here too (2026-09-08), through
 * the same `inconsequentialBrokenStep` predicate and in the same words. The
 * step is already a closed disclosure in this pane, so folding means the
 * ordinary colour and one honest line on its summary naming the sealed status
 * — nothing leaves the pane, and no status is rewritten.
 */
describe('a step that broke without deciding the outcome', () => {
  const steps = (broken: Partial<ProofStep> = {}): ProofStep[] => [
    step({ index: 0, action: 'goto' }),
    step({ index: 1, action: 'click', intent: 'dismiss the consent gate', selector: 'role=button[name="Accept" i]', status: 'failed', error: 'could not resolve', ...broken } as Partial<ProofStep>),
    step({ index: 2, action: 'expectText', intent: 'the plan is listed', selector: 'text="Part time"' }),
  ];
  const render = (over: Partial<ProofBundle> = {}, broken: Partial<ProofStep> = {}): string =>
    renderCatalogReport({
      title: 'be100', runKey: null, generatedAt: null,
      cases: [kase({ bundle: bundle(steps(broken), { status: 'passed-with-issues', ...over }) })],
    });

  it('folds it into an aside with the sealed status on the summary, and keeps the whole record', () => {
    const html = render();
    assert.match(html, /<details class="step aside">/);
    assert.match(html, /<span class="saside">failed — did not decide this run's outcome: it makes no claim, the run carried past it, and every claim the run did make held<\/span>/);
    // Nothing leaves the pane: the error and the intent are still in the body.
    assert.match(html, /<span>error<\/span><code>could not resolve<\/code>/);
    assert.match(html, /dismiss the consent gate/);
    // The status word is on the summary; the row is simply not coloured as a finding.
    assert.doesNotMatch(html, /<details class="step no"><summary><b class="dot"><\/b><span class="sname">1 click/);
  });

  it('never folds an assertion, an `error`, a hold, or anything on a run whose claims did not hold', () => {
    assert.doesNotMatch(render({}, { action: 'expectVisible' }), /<details class="step aside"/);
    assert.doesNotMatch(render({}, { status: 'error' }), /<details class="step aside"/);
    const held = { reason: 'irreversible', rule: 'manifest', message: 'no approval' };
    assert.doesNotMatch(render({}, { blocked: held } as Partial<ProofStep>), /<details class="step aside"/);
    for (const status of ['failed', 'dead-end', 'needs-review']) {
      assert.doesNotMatch(render({ status: status as ProofBundle['status'] }), /<details class="step aside"/, status);
    }
  });
});

/**
 * The same reading of the run's notes as the per-run report and the per-case
 * page make (`runNotesSummary`): the model's bounded summary where there is
 * one, the notes themselves when the run has no narrative.
 */
describe('the run notes a reader is shown', () => {
  const NARRATIVE: NonNullable<ProofBundle['narrative']> = {
    lang: 'en', by: 'claude-cli:opus', at: '2026-09-11T00:00:00.000Z',
    lede: '', summary: '', testData: '', expected: '', tickets: [], questions: [],
    verifierNote: 'The agent cleared a consent gate before the first assertion.',
  };

  function report(over: Partial<ProofBundle>): string {
    return renderCatalogReport({
      title: 't', runKey: null, generatedAt: null,
      cases: [kase({ bundle: bundle([step({})], over) })],
    });
  }

  it('shows the model summary, attributed, and not one word of the raw notes', () => {
    const html = report({ notes: ['pre-run dead-end risk 20%', 'shared data with PL_02_02'], narrative: NARRATIVE });
    assert.match(html, /Run notes/);
    assert.match(html, /The agent cleared a consent gate before the first assertion\./);
    assert.match(html, /written by claude-cli:opus/);
    assert.doesNotMatch(html, /pre-run dead-end risk/);
    assert.doesNotMatch(html, /shared data with/);
  });

  it('falls back to the notes, one per line and unattributed, when the run has no narrative', () => {
    const html = report({ notes: ['pre-run dead-end risk 20%', 'shared data with PL_02_02'] });
    assert.match(html, /<div class="hline">pre-run dead-end risk 20%<\/div><div class="hline">shared data with PL_02_02<\/div>/);
    assert.doesNotMatch(html, /written by/);
  });

  it('renders no notes block at all when the run recorded neither', () => {
    assert.doesNotMatch(report({}), /Run notes/);
  });

  it('escapes both paths', () => {
    const probe = '<b>a & b</b>';
    assert.match(report({ notes: [probe] }), /&lt;b&gt;a &amp; b&lt;\/b&gt;/);
    assert.doesNotMatch(report({ notes: [probe] }), /<b>a & b<\/b>/);
    const narrated = report({ notes: ['x'], narrative: { ...NARRATIVE, verifierNote: probe } });
    assert.match(narrated, /&lt;b&gt;a &amp; b&lt;\/b&gt;/);
    assert.doesNotMatch(narrated, /<b>a & b<\/b>/);
  });
});
