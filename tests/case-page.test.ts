/**
 * The per-case report page (`src/reporter/case-page.ts`) and its sidecars.
 * A pure render over a ledger-shaped case, so every claim the page makes is
 * a string here: what appears, what is omitted, whose words are marked, and
 * that nothing reaches the page that was not already in the bundle.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ProofBundle, ProofStep } from '../src/engine/proof-bundle.js';
import { casePageName, type CatalogReportCase } from '../src/reporter/catalog-report.js';
import { caseSidecarName, caseSidecars, renderCasePage, type CasePageInput } from '../src/reporter/case-page.js';

function step(over: Partial<ProofStep>): ProofStep {
  return {
    index: 1, action: 'goto', selector: null, resolvedSelector: null, resolution: null, status: 'passed',
    startedAt: '2026-09-10T04:00:00.000Z', durationMs: 350, url: 'https://app.example.com/probation',
    ...over,
  } as ProofStep;
}

const DB_STEP = step({
  index: 3,
  action: 'expectDbRow',
  status: 'failed',
  error: 'expected PASSED, observed PENDING\nmore',
  db: {
    kind: 'row', table: 'probation_transactions', where: 'id = 69', expected: 'probation_status = PASSED', observed: 'probation_status = PENDING',
    durationMs: 40, polledMs: 5000,
    statements: [{ sql: 'SELECT * FROM "probation_transactions" WHERE "id" = $1 LIMIT 25', params: ['69'], tables: ['probation_transactions'] }],
    rows: [{ id: '69', probation_status: 'PENDING', password: '[redacted]' }],
    rowsMatched: 1,
  },
  dbChanges: [
    { table: 'probation_transactions', baselineRows: 10, rows: 10, changed: true, updated: 1, sample: [{ kind: 'updated', key: 'id=69', row: { id: '69', extend_date: '2026-11-07' } }] },
    { table: 'employment_jobs', baselineRows: 4, rows: 4, changed: false },
  ],
});

function bundle(steps: ProofStep[], over: Partial<ProofBundle> = {}): ProofBundle {
  return {
    runId: 'r1', name: 'PRB-EC-026 ต่อทดลองงาน 2 รอบ', status: 'failed',
    startedAt: '2026-09-10T04:00:00.000Z', finishedAt: '2026-09-10T04:01:00.000Z',
    durationMs: 60_000, cdpUrl: null, cachePath: null, healerModel: null,
    summary: { totalSteps: steps.length, passed: 0, failed: 0 } as ProofBundle['summary'],
    defects: [], steps,
    ...over,
  } as ProofBundle;
}

function kase(over: Partial<CatalogReportCase> = {}): CatalogReportCase {
  return {
    id: 'PRB-EC-026', name: 'PRB-EC-026 ต่อทดลองงาน 2 รอบ', scenario: 'PRB-EC', verdict: 'failed', status: 'failed', reason: null,
    bundle: bundle([step({ index: 1, intent: 'Open the probation page' }), step({ index: 2, action: 'click', selector: 'role=button[name="Extend" i]', status: 'skipped' }), DB_STEP]),
    history: [],
    ...over,
  };
}

function page(over: Partial<CasePageInput> = {}, c: CatalogReportCase = kase()): string {
  return renderCasePage({
    case: c, title: 'EC cases', runKey: 'ec@2026-09-10', lang: 'en', indexHref: '../ec-2026-09-10.html',
    sidecars: caseSidecars(c),
    ...over,
  });
}

describe('names', () => {
  it('the page and its four sidecars sit flat beside the workbook, under the case slug', () => {
    assert.equal(casePageName('PRB-EC-026'), 'prb-ec-026.html');
    assert.equal(caseSidecarName('PRB-EC-026', 'query'), 'prb-ec-026-db-query.sql');
    assert.equal(caseSidecarName('PRB-EC-026', 'before'), 'prb-ec-026-db-before.csv');
    assert.equal(caseSidecarName('PRB-EC-026', 'after'), 'prb-ec-026-db-after.csv');
    assert.equal(caseSidecarName('PRB-EC-026', 'evidence'), 'prb-ec-026-db-evidence.csv');
  });
});

describe('the query section', () => {
  it('shows every DB step: kind, scope, expected against observed, the SQL with its bound values, the rows', () => {
    const html = page();
    assert.match(html, /<h2 class="sec">Queries used for the DB evidence<\/h2>/);
    assert.match(html, /<span class="fno">step 3<\/span> <strong>db row<\/strong> <code>probation_transactions · where id = 69<\/code>/);
    assert.match(html, /expected <code>probation_status = PASSED<\/code> · observed <code>probation_status = PENDING<\/code>/);
    assert.match(html, /<pre class="sql"><code>-- \$1 = 69\nSELECT \* FROM &quot;probation_transactions&quot; WHERE &quot;id&quot; = \$1 LIMIT 25;<\/code><\/pre>/);
    assert.match(html, /<caption>rows returned[^<]*<\/caption><thead><tr><th>id<\/th><th>probation_status<\/th><th>password<\/th>/);
    assert.match(html, /<td class="lab">\[redacted\]<\/td>/);
    assert.match(html, /polled 5\.0s/);
  });

  it('links the four chips only to files that exist; a missing one is a plain chip, never a dead link', () => {
    const html = page();
    assert.match(html, /<a class="chip" href="prb-ec-026-db-query\.sql" download><code>db-query\.sql<\/code> · full SQL<\/a>/);
    assert.match(html, /<a class="chip" href="prb-ec-026-db-evidence\.csv" download>/);
    assert.match(html, /<a class="chip" href="prb-ec-026-db-after\.csv" download>/);
    const noChanges = kase({ bundle: bundle([{ ...DB_STEP, dbChanges: undefined }]) });
    const html2 = page({ sidecars: caseSidecars(noChanges) }, noChanges);
    assert.match(html2, /<span class="chip muted"><code>db-before\.csv<\/code> · before<\/span>/);
  });

  it('is omitted on a case with no DB step; a check refused before any SQL ran shows its summary and no code block', () => {
    assert.doesNotMatch(page({}, kase({ bundle: bundle([step({})]) })), /Queries used for the DB evidence/);
    const refused = kase({ bundle: bundle([{ ...DB_STEP, db: { ...DB_STEP.db!, statements: undefined, rows: undefined } }]) });
    const html = page({ sidecars: caseSidecars(refused) }, refused);
    assert.match(html, /<strong>db row<\/strong>/);
    assert.doesNotMatch(html, /<pre class="sql">/);
  });

  it('a request step gets its own backend-call block', () => {
    const c = kase({ bundle: bundle([step({ index: 4, action: 'request', request: { method: 'POST', url: 'https://api.example.com/probation/69/extend', status: 200, durationMs: 120, requestBody: '{"days":30}', responseBody: '{"ok":true}' } })]) });
    const html = page({ sidecars: caseSidecars(c) }, c);
    assert.match(html, /Backend calls the test made/);
    assert.match(html, /<strong>HTTP POST<\/strong> <code>https:\/\/api\.example\.com\/probation\/69\/extend<\/code>/);
    assert.match(html, /<div class="fno">request<\/div><pre class="sql"><code>\{&quot;days&quot;:30\}<\/code><\/pre>/);
  });
});

describe('the sidecars', () => {
  it('db-query.sql wraps every statement in a read-only transaction with its bound values as comments', () => {
    const s = caseSidecars(kase());
    assert.match(s.query!, /^-- PRB-EC-026\n/);
    assert.match(s.query!, /BEGIN TRANSACTION READ ONLY;\n\n-- step 3: row on probation_transactions where id = 69\n-- \$1 = 69\nSELECT \* FROM "probation_transactions" WHERE "id" = \$1 LIMIT 25;\n\nROLLBACK;\n$/);
    assert.doesNotMatch(s.query!, /postgres:\/\//);
  });

  it('before/after carry the baseline counts and the redacted sample rows, one field per line; evidence carries each returned row per field', () => {
    const s = caseSidecars(kase());
    assert.equal(s.before, 'step,table,kind,key,field,value\n3,probation_transactions,count,,rows,10\n3,employment_jobs,count,,rows,4\n');
    assert.match(s.after!, /\n3,probation_transactions,updated,id=69,extend_date,2026-11-07\n/);
    assert.match(s.evidence!, /^step,check,table,where,expected,observed,row,field,value\n3,row,probation_transactions,id = 69,probation_status = PASSED,probation_status = PENDING,,,\n3,row,probation_transactions,id = 69,probation_status = PASSED,probation_status = PENDING,1,id,69\n/);
  });

  it('a case with no DB evidence has no sidecars at all', () => {
    assert.deepEqual(caseSidecars(kase({ bundle: bundle([step({})]) })), { query: null, before: null, after: null, evidence: null });
  });

  it('quotes a CSV cell that holds a comma, a quote or a newline', () => {
    const c = kase({ bundle: bundle([{ ...DB_STEP, db: { ...DB_STEP.db!, rows: [{ note: 'a, "b"\nc' }] } }]) });
    assert.match(caseSidecars(c).evidence!, /,1,note,"a, ""b""\nc"\n/);
  });
});

describe('evidence sections', () => {
  it('the mast names the case, the verdict, the sheet and the way back; the summary table reads the bundle', () => {
    const html = page({}, kase({ sheet: 'EC', category: 'Probation' }));
    assert.match(html, /<title>PRB-EC-026 — EC cases<\/title>/);
    assert.match(html, /<h1>PRB-EC-026 — ต่อทดลองงาน 2 รอบ<\/h1>/);
    assert.match(html, /Verdict <b style="color:var\(--app\)">test failed<\/b>/);
    assert.match(html, /Sheet <b>EC · Probation<\/b>/);
    assert.match(html, /<a href="\.\.\/ec-2026-09-10\.html">Back to the catalog report<\/a>/);
    assert.match(html, /<td class="fld">Test data<\/td><td><strong><code>none recorded<\/code><\/strong><\/td>/);
  });

  it('the coverage bar counts passed, observed, failed and not reached from the steps', () => {
    const html = page();
    assert.match(html, /<h2>Coverage — 3 step\(s\)<\/h2>/);
    // A passed goto performed something; it asserted nothing.
    assert.match(html, /asserted and passed <b>0<\/b>/);
    assert.match(html, /performed <b>1<\/b>/);
    assert.match(html, /asserted and failed <b>1<\/b>/);
    assert.match(html, /not reached <b>1<\/b>/);
  });

  it('the before/after table lists every baseline table, unchanged ones muted', () => {
    const html = page();
    assert.match(html, /<td class="fld">probation_transactions<\/td><td class="lab">10 rows<\/td><td class="lab">10 rows<\/td><td class="note">~1 · as of step 3 · sample: <code>updated id=69<\/code>/);
    assert.match(html, /<tr class="na"><td class="fld">employment_jobs<\/td>/);
  });

  it('the outcomes table pills each step and puts its error on the row; a skipped step is muted', () => {
    const html = page();
    assert.match(html, /<td class="num">1<\/td><td>Open the probation page<span class="det"><code>goto<\/code> · 350ms<\/span><\/td><td><span class="pill pass">passed<\/span><\/td>/);
    assert.match(html, /<tr class="na"><td class="num">2<\/td>/);
    assert.match(html, /<span class="pill fail">failed<\/span><\/td><td class="note">db: probation_status = PENDING · <code>expected PASSED, observed PENDING<\/code>/);
  });

  it('tickets come from the recorded defects; with no defect and no narrative there is no ticket section', () => {
    const withDefect = kase({ bundle: bundle([DB_STEP], { defects: [{ id: 'd1', severity: 'high', category: 'backend', title: 'Due date not synced', detail: 'extend_date 2026-11-07 but page says Due in 29 days', source: 'runtime', stepIndex: 3 }] }) });
    const html = page({ sidecars: caseSidecars(withDefect) }, withDefect);
    assert.match(html, /<h2 class="sec">Suggested tickets<\/h2>/);
    assert.match(html, /<strong>Due date not synced<\/strong><span class="det">extend_date 2026-11-07 but page says Due in 29 days<\/span><span class="det"><code>d1<\/code> · backend · high · step 3<\/span><\/td><td class="own">backend<\/td>/);
    assert.doesNotMatch(page(), /Suggested tickets/);
    // The owner is the seal's own side: a functional defect on a DB step is backend; on a click it is frontend.
    const onDbStep = kase({ bundle: bundle([DB_STEP], { defects: [{ id: 'd2', severity: 'low', category: 'functional', title: 'x', detail: 'y', source: 'runtime', stepIndex: 3 }] }) });
    assert.match(page({ sidecars: caseSidecars(onDbStep) }, onDbStep), /<td class="own">backend<\/td>/);
    const onClick = kase({ bundle: bundle([step({ index: 2, action: 'click' })], { defects: [{ id: 'd3', severity: 'low', category: 'functional', title: 'x', detail: 'y', source: 'runtime', stepIndex: 2 }] }) });
    assert.match(page({ sidecars: caseSidecars(onClick) }, onClick), /<td class="own">frontend<\/td>/);
  });

  it('a narrated step keeps the author\'s intent as the row and shows the sentence after it, marked', () => {
    const c = kase({ bundle: bundle([step({ index: 1, intent: 'Open the probation page', narration: { text: 'Opened the page.', by: 'm', at: 'z' } })]) });
    const html = page({ sidecars: caseSidecars(c) }, c);
    assert.match(html, /<td>Open the probation page<span class="det ai">Opened the page\.<\/span><span class="det"><code>goto<\/code>/);
  });

  it('a still per step that kept one, the film through the Blob player, and the footer lists every file', () => {
    const c = kase({
      verdict: 'passed', status: 'passed',
      bundle: bundle([step({ index: 1, screenshot: 'AAAA', intent: 'Open the page' })], { video: { data: 'QUJD', width: 1280, height: 720, bytes: 3 } }),
    });
    const html = page({ sidecars: caseSidecars(c) }, c);
    assert.match(html, /<img src="data:image\/jpeg;base64,AAAA" alt="Open the page" loading="lazy">/);
    assert.match(html, /<video controls preload="none" playsinline data-webm="QUJD"><\/video>/);
    assert.match(html, /function wowHydrate/);
    assert.match(html, /<footer><p><strong>Files:<\/strong> <code>prb-ec-026\.html<\/code> · <a href="prb-ec-026\.xlsx" download>/);
    const spilled = page({ sidecars: caseSidecars(c), videoHref: 'prb-ec-026.webm' }, c);
    assert.match(spilled, /<video controls preload="metadata" playsinline src="prb-ec-026\.webm"><\/video>/);
  });

  it('a case with no steps says why and renders nothing it cannot show', () => {
    const html = page({}, kase({ verdict: 'blocked', status: null, reason: 'the run was paused', bundle: bundle([]) }));
    assert.match(html, /Outcome per step — 0<\/h2><p class="lede">the run was paused<\/p>/);
    assert.doesNotMatch(html, /class="cov"/);
    assert.doesNotMatch(html, /Evidence from the screen/);
  });
});

describe('the narrative', () => {
  const NARRATED = kase({
    bundle: bundle([DB_STEP], {
      defects: [{ id: 'd1', severity: 'high', category: 'functional', title: 'Due date not synced', detail: 'raw detail', source: 'runtime' }],
      narrative: {
        lang: 'en', by: 'claude-cli:opus', at: '2026-09-10T05:00:00.000Z',
        lede: 'Tested the second extension on transaction 69.',
        summary: 'Opens the page and reads transaction 69 back.',
        testData: 'Transaction 69.',
        expected: 'The transaction is PASSED.',
        tickets: [
          { kind: 'app', title: 'PRB-EC-026 · sync the due date', detail: 'worded detail', owner: 'Dev', defectId: 'd1' },
          { kind: 'test', title: 'PRB-EC-026 · cover notifications', detail: 'the inbox was never opened', owner: 'Verifier' },
        ],
        verifierNote: 'The first attempt compared an ISO date with the screen format.',
        questions: [{ question: 'PASS or PASSED?', answer: 'PENDING was observed.', evidence: 'step 3' }],
      },
    }),
  });

  it('every model sentence wears the ai class and the mast says whose words they are', () => {
    const html = page({ sidecars: caseSidecars(NARRATED) }, NARRATED);
    assert.match(html, /<p class="sub ai">Tested the second extension on transaction 69\.<\/p>/);
    assert.match(html, /Sentences with a violet bar were written by claude-cli:opus/);
    assert.match(html, /<span class="det ai">Opens the page and reads transaction 69 back\.<\/span>/);
    assert.match(html, /<strong class="ai">The transaction is PASSED\.<\/strong>/);
    assert.match(html, /<p class="ai caveat">The first attempt compared an ISO date with the screen format\.<\/p>/);
    assert.match(html, /<p class="q ai">PASS or PASSED\?<\/p><p class="a ai">PENDING was observed\.<\/p><p class="how ai">step 3<\/p>/);
  });

  it('a ticket that restates a defect wears the model wording but keeps the defect id; a test-side ticket is its own row', () => {
    const html = page({ sidecars: caseSidecars(NARRATED) }, NARRATED);
    assert.match(html, /<strong class="ai">PRB-EC-026 · sync the due date<\/strong><span class="det ai">worded detail<\/span><span class="det"><code>d1<\/code> Due date not synced — raw detail<\/span><span class="det"><code>d1<\/code> · functional · high<\/span>/);
    assert.match(html, /<span class="tag test">test<\/span><\/td><td><strong class="ai">PRB-EC-026 · cover notifications<\/strong>/);
  });

  it('without a narrative the page has no ai class and no attribution line', () => {
    const html = page();
    assert.doesNotMatch(html, /class="[^"]*\bai\b/);
    assert.doesNotMatch(html, /violet bar/);
  });
});

describe('language and safety', () => {
  it('Thai labels when the run chose Thai; recorded values stay as recorded', () => {
    const html = page({ lang: 'th' });
    assert.match(html, /<html lang="th">/);
    assert.match(html, /<h2 class="sec">Query ที่ใช้เก็บหลักฐาน DB<\/h2><p class="lede">Query แบบ parameterised บน session แบบ read-only [^<]*ไฟล์ไม่เก็บ DSN หรือ credential<\/p>/);
    assert.match(html, /<code>db-query\.sql<\/code> · SQL เต็ม/);
    assert.match(html, /<span class="pill fail">ตก<\/span>/);
    assert.match(html, /probation_status = PENDING/);
  });

  it('escapes application text everywhere — a case name, an SQL string, a cell, an intent', () => {
    const c = kase({
      name: 'PRB <script>alert(1)</script>',
      bundle: bundle([{ ...DB_STEP, intent: '<b>bold</b>', db: { ...DB_STEP.db!, rows: [{ note: '<img src=x>' }] } }]),
    });
    const html = page({ sidecars: caseSidecars(c) }, c);
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(html, /&lt;b&gt;bold&lt;\/b&gt;/);
    assert.match(html, /&lt;img src=x&gt;/);
  });

  it('escapes every other channel too: a defect, the narrative, the reason, a note, an alt, a request url', () => {
    const probe = '<script>alert(1)</script>';
    const c = kase({
      reason: probe,
      bundle: bundle([step({ index: 1, screenshot: 'AAAA', intent: probe }), step({ index: 4, action: 'request', request: { method: 'GET', url: `https://x/${probe}`, status: 200, durationMs: 1 } })], {
        notes: [probe],
        defects: [{ id: 'd1', severity: 'high', category: 'functional', title: probe, detail: probe, source: 'runtime' }],
        narrative: { lang: 'en', by: probe, at: 'z', lede: probe, summary: probe, testData: probe, expected: probe, verifierNote: probe, tickets: [{ kind: 'app', title: probe, detail: probe, owner: probe, defectId: 'd1' }], questions: [{ question: probe, answer: probe, evidence: probe }] },
      }),
    });
    const html = page({ sidecars: caseSidecars(c) }, c);
    assert.doesNotMatch(html, /<script>alert/);
    assert.equal((html.match(/&lt;script&gt;alert\(1\)&lt;\/script&gt;/g) ?? []).length >= 14, true);
  });

  it('is self-contained: no external stylesheet, script, font or image', () => {
    const html = page();
    assert.doesNotMatch(html, /<link|<script src|@import|url\(|https:\/\/fonts/);
  });

  it('a newline inside a recorded value cannot end an SQL comment early in db-query.sql', () => {
    const c = kase({ bundle: bundle([{ ...DB_STEP, db: { ...DB_STEP.db!, where: 'id = 69\nCOMMIT;', statements: [{ sql: 'SELECT 1', params: ['a\nDROP TABLE x;'], tables: [] }] } }]) });
    const sql = caseSidecars(c).query!;
    assert.doesNotMatch(sql, /^COMMIT;/m);
    assert.doesNotMatch(sql, /^DROP TABLE/m);
    assert.match(sql, /-- \$1 = a DROP TABLE x;/);
  });

  it('a typed value on a step never reaches the page — only what the bundle chose to record does', () => {
    const c = kase({ bundle: bundle([step({ index: 1, action: 'fill', selector: 'role=textbox[name="Password" i]', detail: { value: 'hunter2-secret', password: 'hunter2-secret' } })]) });
    const html = page({ sidecars: caseSidecars(c) }, c);
    assert.doesNotMatch(html, /hunter2-secret/);
  });

  it('renders byte-identically for the same input', () => {
    assert.equal(page(), page());
  });
});
