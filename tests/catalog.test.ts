/**
 * Catalogs: a document becomes claims, claims become a test.
 *
 * Unit tier — the model is stubbed, so this is free and offline. The parts
 * worth guarding are the two where a silent mistake survives all the way to a
 * green report: extraction handing back text that is not in the document, and
 * the gate testing something nobody approved.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import {
  EmptyDocumentError,
  UnsupportedDocumentError,
  extractDocument,
  extractDocumentFile,
  htmlToText,
} from '../src/catalog/extract.js';
import {
  DEFAULT_MAX_CLAIMS,
  LlmCatalogModel,
  approvedClaims,
  buildAuthoringPrompt,
  buildClaimsPrompt,
  extractClaims,
  parseClaimsFile,
  toClaimsFile,
  type CatalogClaim,
  groupClaimsByRow,
} from '../src/catalog/catalog.js';
import { jsonModel } from './helpers.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

const asDocument = (name: string, text: string) => extractDocument(name, Buffer.from(text, 'utf8'));

describe('reading a document', () => {
  it('reads the plain formats as they are', () => {
    assert.equal(asDocument('a.md', '# Title\n\n- one\n- two').text, '# Title\n\n- one\n- two');
    assert.equal(asDocument('a.csv', 'id,claim\n1,works').format, 'csv');
    assert.equal(asDocument('a.yaml', 'claims:\n  - works').format, 'yaml');
  });

  it('refuses a format it cannot read, rather than guessing', () => {
    // Sniffing bytes would mean a .docx quietly becoming "text" full of ZIP
    // noise, and a model writing tests from it.
    assert.throws(() => asDocument('spec.docx', 'PK...'), UnsupportedDocumentError);
    assert.throws(() => asDocument('notes', 'no extension at all'), UnsupportedDocumentError);
  });

  it('refuses an empty document instead of returning nothing', () => {
    assert.throws(() => asDocument('a.md', '   \n\n  '), EmptyDocumentError);
  });

  it('says when it truncated, and how much of it there was', () => {
    const document = extractDocument('big.md', Buffer.from('x'.repeat(500)), 100);
    assert.equal(document.text.length, 100);
    assert.equal(document.originalChars, 500);
    assert.match(document.note, /truncated to the first 100 of 500/);
  });
});

describe('reading a delimited table', () => {
  it('keeps a narrow table as lines, which is all it needs to be', () => {
    const document = asDocument('checklist.csv', 'id,claim\n1,the page loads\n2,the form saves');
    assert.equal(document.text, 'id | claim\n1 | the page loads\n2 | the form saves');
  });

  it('writes a wide table as labelled records, so a value keeps its column', () => {
    const document = asDocument(
      'cases.csv',
      'Case ID,Priority,Test Case,Expected Output\nRU_01,High,open the rules page,the list renders',
    );
    assert.match(document.text, /Case ID: RU_01/);
    assert.match(document.text, /Expected Output: the list renders/);
  });

  it('reads numbered steps written inside one cell', () => {
    // The case this was built for: a tester writes the steps as a list *in* the
    // cell, so the row spans four lines. Split on newlines and every line after
    // the first becomes its own bogus row.
    const document = asDocument(
      'script.csv',
      'Case ID,Steps,Expected\nRU_01,"1. open Menu\n2. click HR\n3. open rules",the rules page\nRU_02,single step,fine',
    );
    assert.match(document.text, /Steps:\n {2}1\. open Menu\n {2}2\. click HR\n {2}3\. open rules/);
    // …and the row after it is still a row of its own.
    assert.match(document.text, /Case ID: RU_02/);
  });

  it('omits an empty cell rather than emitting a blank field', () => {
    const document = asDocument(
      'cases.csv',
      'Case ID,Priority,Test Case,Note\nRU_01,,open the page,\nRU_02,Low,save the form,check twice',
    );
    assert.doesNotMatch(document.text, /Priority: *\n/);
    assert.match(document.text, /Priority: Low/);
  });

  it('does not fill a blank group cell down the column', () => {
    // A sheet states the scenario once and leaves it blank beneath. Carrying it
    // down would be this module writing text the document does not contain;
    // the rows stay adjacent and in order instead.
    const document = asDocument(
      'cases.csv',
      'Scenario,Case ID,Test Case,Expected\nRU_01,RU_01_01,open it,it opens\n,RU_01_02,close it,it closes',
    );
    const second = document.text.slice(document.text.indexOf('RU_01_02'));
    assert.doesNotMatch(second, /Scenario:/);
  });

  it('sniffs the delimiter instead of assuming a comma', () => {
    const semicolon = asDocument('a.csv', 'id;claim\n1;prices are formatted as 1,234.00');
    assert.equal(semicolon.text, 'id | claim\n1 | prices are formatted as 1,234.00');

    const tabbed = asDocument('a.tsv', 'id\tclaim\n1\tit works');
    assert.equal(tabbed.text, 'id | claim\n1 | it works');
  });

  it('drops a column that is empty in every row', () => {
    // An exporter that ends each line with a delimiter produces one of these.
    const document = asDocument('a.csv', 'id,claim,\n1,it works,\n2,it saves,');
    assert.equal(document.text, 'id | claim\n1 | it works\n2 | it saves');
    assert.match(document.note, /1 empty column\(s\) dropped/);
  });

  it('keeps a title above the header instead of reading it as data', () => {
    const document = asDocument(
      'a.csv',
      'BE Test script (Rule EN),,\nexported 2026-08-10,,\nid,claim,priority\n1,it works,High',
    );
    assert.match(document.text, /BE Test script \(Rule EN\)\nexported 2026-08-10/);
    // The header is found under the title, so it is a header and not a row.
    assert.match(document.text, /id \| claim \| priority\n1 \| it works \| High/);
    assert.match(document.note, /2 row\(s\) above the header kept as a preamble/);
  });

  it('strips a byte-order mark off the first column name', () => {
    const document = extractDocument('a.csv', Buffer.from('﻿step_no,claim\n1,it works', 'utf8'));
    assert.match(document.text, /^step_no \| claim/);
  });

  it('reads a sheet saved as UTF-16', () => {
    // "Save as CSV" writes this on more than one platform. Read as UTF-8 it is
    // a NUL between every character and one unreadable field.
    const utf16 = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('id,claim\n1,it works', 'utf16le'),
    ]);
    assert.equal(extractDocument('a.csv', utf16).text, 'id | claim\n1 | it works');
  });

  it('says so when the text was replaced at export instead of pretending it read it', () => {
    // A sheet exported to a non-Unicode encoding: valid CSV, content gone. This
    // is the one damage case nothing downstream can detect.
    const damaged = `id,claim\n${Array.from({ length: 20 }, (_, i) => `${i},${'?'.repeat(40)}`).join('\n')}`;
    assert.match(asDocument('a.csv', damaged).note, /literal "\?" characters/);
  });

  it('does not mistake ordinary question marks for damage', () => {
    const fine = `id,claim\n${Array.from({ length: 20 }, (_, i) => `${i},is the total correct? it should be`).join('\n')}`;
    assert.equal(asDocument('a.csv', fine).note, '');
  });
});

describe('reading HTML', () => {
  it('keeps the structure that says which claims belong together', () => {
    const text = htmlToText(
      '<h2>Balance</h2><ul><li>renders</li><li>filters</li></ul><p>Also true.</p>',
    );
    assert.match(text, /## Balance/);
    assert.match(text, /- renders/);
    assert.match(text, /- filters/);
    assert.match(text, /Also true\./);
  });

  it('keeps a table as columns, not as one sentence', () => {
    const text = htmlToText('<tr><td>LB-1</td><td>the table renders</td></tr>');
    assert.match(text, /LB-1\tthe table renders/);
  });

  it('drops script and style outright', () => {
    const text = htmlToText('<p>real</p><script>var secret = "leak";</script><style>p{color:red}</style>');
    assert.equal(text.includes('leak'), false);
    assert.equal(text.includes('color:red'), false);
    assert.match(text, /real/);
  });

  it('decodes the entities a saved page is full of', () => {
    assert.match(htmlToText('<p>a&nbsp;&amp;&nbsp;b &mdash; &#8220;c&#8221;</p>'), /a & b — “c”/);
  });
});

describe('reading a spreadsheet', () => {
  // A real workbook written by a real writer (openpyxl), not one this repo
  // built for itself — a ZIP reader tested only against its own writer proves
  // the two agree, not that either is right.
  it('reads every sheet, with its name and its rows', async () => {
    const document = await extractDocumentFile(join(FIXTURES, 'catalog.xlsx'));
    assert.equal(document.format, 'xlsx');
    assert.match(document.text, /## Leave cases/);
    assert.match(document.text, /Case\tWhat must be true\tPriority/);
    assert.match(document.text, /LB-1\tThe balance table renders with one row per leave type\thigh/);
    assert.match(document.text, /## Notes/);
  });

  it('keeps a sparse row’s columns, so a value cannot move under the wrong heading', async () => {
    const document = await extractDocumentFile(join(FIXTURES, 'catalog.xlsx'));
    assert.match(document.text, /D: far away value/);
  });

  it('says how many sheets were empty rather than silently dropping them', async () => {
    const document = await extractDocumentFile(join(FIXTURES, 'catalog.xlsx'));
    assert.match(document.note, /1 empty sheet\(s\) skipped/);
  });
});

describe('reading a PowerPoint deck', () => {
  // Written by Python's zipfile — an independent ZIP writer, same rule as the
  // openpyxl workbook: a reader tested only against its own writer proves the
  // two agree, not that either is right.
  it('reads every slide in order, joining runs a title was split into', async () => {
    const document = await extractDocumentFile(join(FIXTURES, 'sample.pptx'));
    assert.equal(document.format, 'pptx');
    assert.match(document.text, /## Slide 1/);
    // "Leave " + "Request Policy" are two <a:t> runs of one paragraph.
    assert.match(document.text, /Leave Request Policy/);
    assert.match(document.text, /Employees submit requests before the 20th/);
    assert.match(document.text, /## Slide 2/);
    assert.match(document.text, /การลาพักร้อน/);
    assert.match(document.text, /Approval & escalation/, 'entities decode');
  });

  it('carries speaker notes, labelled apart, with bare slide numbers dropped', async () => {
    const document = await extractDocumentFile(join(FIXTURES, 'sample.pptx'));
    assert.match(document.text, /\(speaker notes\)\nRemind the team about the payroll cutoff/);
    assert.doesNotMatch(document.text, /\(speaker notes\)\n1\b/);
  });

  it('says how many slides had no readable text rather than silently dropping them', async () => {
    const document = await extractDocumentFile(join(FIXTURES, 'sample.pptx'));
    assert.match(document.note, /1 slide\(s\) with no readable text skipped/);
  });

  it('the fixture is really a ZIP', async () => {
    const bytes = await readFile(join(FIXTURES, 'sample.pptx'));
    assert.equal(bytes.subarray(0, 2).toString('latin1'), 'PK');
  });
});

describe('reading a PDF', () => {
  it('reads the text layer of a real PDF', async () => {
    const document = await extractDocumentFile(join(FIXTURES, 'catalog.pdf'));
    assert.equal(document.format, 'pdf');
    assert.match(document.text, /The balance table renders with one row per leave type/);
    assert.match(document.text, /Filtering by month narrows the rows/);
  });

  it('does not return the rest of the file as if it were text', async () => {
    // Colour profiles and font programs inflate just as happily as page
    // content. Scanning whole streams turned a 3-line checklist into 15,000
    // characters of mojibake; only what sits between BT and ET is text.
    const document = await extractDocumentFile(join(FIXTURES, 'catalog.pdf'));
    assert.ok(document.text.length < 400, `expected a short checklist, got ${document.text.length} chars`);
  });

  it('refuses a PDF with no text layer instead of returning its noise', () => {
    // The shape of a scan: a page whose only stream is an image.
    const pdf = Buffer.concat([
      Buffer.from('%PDF-1.4\n1 0 obj<</Type/XObject/Subtype/Image/Filter/DCTDecode/Length 8>>stream\n'),
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]),
      Buffer.from('\nendstream endobj\n%%EOF'),
    ]);
    assert.throws(() => extractDocument('scan.pdf', pdf), (error: unknown) => {
      assert.ok(error instanceof EmptyDocumentError);
      assert.match((error as Error).message, /usually a scan/);
      return true;
    });
  });

  it('reads a compressed content stream', () => {
    const content = Buffer.from('BT /F1 12 Tf (the export button downloads a CSV) Tj ET');
    const body = deflateSync(content);
    const pdf = Buffer.concat([
      Buffer.from(`%PDF-1.4\n1 0 obj<</Length ${body.length}/Filter/FlateDecode>>stream\n`),
      body,
      Buffer.from('\nendstream endobj\n%%EOF'),
    ]);
    assert.match(extractDocument('flate.pdf', pdf).text, /the export button downloads a CSV/);
  });

  it('turns a large negative kern into the space the font never drew', () => {
    const pdf = Buffer.from(
      '%PDF-1.4\n1 0 obj<</Length 60>>stream\nBT [(two)-300(words)] TJ ET\nendstream endobj\n%%EOF',
    );
    assert.match(extractDocument('kern.pdf', pdf).text, /two words/);
  });
});

describe('the claims file — the gate as a file', () => {
  const claims: CatalogClaim[] = [
    { claim: 'the table renders', priority: 'high', source: 'LB-1', testable: true },
    { claim: 'the user is an admin', priority: 'medium', source: 'intro', testable: false },
    { claim: 'export downloads a CSV', priority: 'low', source: 'LB-3', testable: true },
  ];
  const file = toClaimsFile('cases.xlsx', {
    summary: 'leave balance',
    claims,
    model: 'stub',
    latencyMs: 1,
    documentNote: '',
  }, '2026-08-10T00:00:00.000Z');

  it('starts with everything ticked', () => {
    // A gate that begins empty is a gate everyone clicks "select all" through.
    assert.equal(approvedClaims(file).length, 3);
  });

  it('round-trips through JSON with the ticks intact', () => {
    const pruned = { ...file, claims: file.claims.map((c) => ({ ...c, approved: c.source !== 'LB-3' })) };
    const reread = parseClaimsFile(JSON.stringify(pruned));
    assert.deepEqual(approvedClaims(reread).map((c) => c.source), ['LB-1', 'intro']);
  });

  it('treats a claim with no "approved" key as approved', () => {
    // So a hand-written claims file does not have to say yes to every line.
    const reread = parseClaimsFile('{"claims":[{"claim":"it works"}]}');
    assert.equal(approvedClaims(reread).length, 1);
  });

  it('says so plainly when the file is not one', () => {
    assert.throws(() => parseClaimsFile('not json'), /not valid JSON/);
    assert.throws(() => parseClaimsFile('{"nope": 1}'), /no "claims" array/);
  });
});

describe('the prompt the author is given', () => {
  const claims: CatalogClaim[] = [
    { claim: 'the table renders', priority: 'high', source: 'LB-1', testable: true },
    { claim: 'the user is an admin', priority: 'medium', source: 'intro', testable: false },
  ];

  it('numbers every claim and insists all of them are covered', () => {
    const prompt = buildAuthoringPrompt(claims);
    assert.match(prompt, /1\. \[high\] the table renders/);
    assert.match(prompt, /every claim below must be covered/);
  });

  it('never asks for a check on something that only sets the scene', () => {
    const prompt = buildAuthoringPrompt(claims);
    assert.match(prompt, /Assume this is already true; do not write checks for it:\n- the user is an admin/);
    // ...and it is not also in the numbered list, or it becomes an assertion.
    assert.equal(/\d\. \[medium\] the user is an admin/.test(prompt), false);
  });

  it('asks for one case per claim, each standing on its own', () => {
    // The whole reason a catalog authors cases rather than one long flow: a
    // claim that fails must not decide whether the claims after it are checked.
    const prompt = buildAuthoringPrompt(claims);
    assert.match(prompt, /Put each claim in its own case/);
    assert.match(prompt, /a failing one does not stop the rest/);
    assert.match(prompt, /no case may depend on an earlier case having run/);
    assert.match(prompt, /put whatever they all need in setup, which runs again before each case/);
  });

  it('says setup starts blank, so nothing touches storage before the goto', () => {
    // `clearStorage` as setup's first step is origin-scoped and throws on
    // about:blank, which failed every case of a catalog at step 0.
    const prompt = buildAuthoringPrompt(claims);
    assert.match(prompt, /Setup starts on a blank page, so its first step is the goto/);
    assert.match(prompt, /there is nothing to clear before it/);
  });

  it('labels a context document as background, apart from the claims', () => {
    const prompt = buildAuthoringPrompt(claims, {
      context: [{ name: 'api.md', format: 'markdown', text: 'GET /leave', note: '', originalChars: 9 }],
    });
    assert.match(prompt, /SUPPORTING CONTEXT: api\.md/);
    assert.match(prompt, /says nothing that needs checking/);
  });
});

describe('asking a model what a document claims', () => {
  const document = { name: 'cases.md', format: 'markdown' as const, text: '- it renders', note: 'trimmed', originalChars: 12 };

  const stub = (payload: unknown) =>
    new LlmCatalogModel({ model: { model: jsonModel('stub', payload, { inputTokens: 5, outputTokens: 5 }) } });

  it('carries the document’s own extraction note through to the caller', async () => {
    const claims = await extractClaims(stub({ summary: 's', claims: [] }), { document });
    assert.equal(claims.documentNote, 'trimmed');
  });

  it('normalises whatever the model called a priority', async () => {
    const claims = await extractClaims(
      stub({
        summary: 's',
        claims: [
          { claim: 'a', priority: 'P1', source: '', testable: true },
          { claim: 'b', priority: 'nice to have', source: '', testable: true },
          { claim: 'c', priority: '', source: '', testable: true },
        ],
      }),
      { document },
    );
    assert.deepEqual(claims.claims.map((claim) => claim.priority), ['high', 'low', 'medium']);
  });

  it('drops an empty claim rather than putting a blank line in the gate', async () => {
    const claims = await extractClaims(
      stub({ summary: 's', claims: [{ claim: '   ', priority: 'high', source: '', testable: true }] }),
      { document },
    );
    assert.deepEqual(claims.claims, []);
  });

  it('keeps the catalog and its context apart in the prompt it sends', () => {
    // The whole reason the two are separate inputs: a model that conflates them
    // writes claims about the API documentation instead of the application.
    const prompt = buildClaimsPrompt({
      document,
      context: [{ name: 'api.md', format: 'markdown', text: 'GET /leave', note: '', originalChars: 9 }],
      maxClaims: 7,
    });
    assert.match(prompt, /SUPPORTING CONTEXT: api\.md/);
    assert.match(prompt, /Background only\. It makes no claims of its own/);
    assert.match(prompt, /CATALOG: cases\.md/);
    assert.match(prompt, /Every claim you list must come from this document/);
    assert.match(prompt, /at most 7 claims/);
    // The catalog is last, so the instruction that follows it is about it.
    assert.ok(prompt.indexOf('SUPPORTING CONTEXT') < prompt.indexOf('CATALOG:'));
  });

  it('defaults the cap rather than asking for unlimited claims', () => {
    assert.equal(DEFAULT_MAX_CLAIMS, 40);
  });
});

describe('what a stored document looks like on disk', () => {
  it('the fixtures this suite relies on are really those formats', async () => {
    // A fixture silently replaced by a text file would make the xlsx and pdf
    // tests above pass for the wrong reason.
    const xlsx = await readFile(join(FIXTURES, 'catalog.xlsx'));
    assert.equal(xlsx.subarray(0, 2).toString('latin1'), 'PK');
    const pdf = await readFile(join(FIXTURES, 'catalog.pdf'));
    assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
  });
});

// --- the project's own sheet format: the columns that decide honesty ---------

import {
  beyondHarnessReason,
  describeCase,
  parseTestCaseTable,
  realignRow,
  recordedResult,
  tablePersonas,
  tableToClaims,
} from '../src/catalog/test-case-table.js';

describe('the test-case table, read whole', () => {
  const HEADER =
    'No.,Scenario ID,Test Scenario,Test Case ID,Positive/Negative,Priority,Test Case,' +
    'Login / Persona,Preconditions,Test Data,Menu,Test Script / Steps,Expected Output,Note';

  it('reads the Login / Persona and Preconditions columns instead of dropping them', () => {
    // Those two columns are where the sheet's writer parked the credentials,
    // the working selectors and the deployment facts — losing them is how an
    // authored setup ends up guessing at a login the sheet had spelled out.
    const rows = parseTestCaseTable(
      `${HEADER}\n` +
        '1,DB_01,Health,DB_01_01,Positive,High,counts match,' +
        '"admin@cnext.test — real login","dev server on :3200; seed applied",n/a,,1. curl the endpoint,counts equal SQL,run first',
    );
    assert.ok(rows);
    assert.equal(rows[0]?.persona, 'admin@cnext.test — real login');
    assert.equal(rows[0]?.preconditions, 'dev server on :3200; seed applied');
  });

  it('carries the Note column into the claim text — the caveats decide the assertion', () => {
    const rows = parseTestCaseTable(
      `${HEADER}\n` +
        '1,PB_01,Due date,PB_01_01,Positive,High,due = hire + 120,,,,,1. read the card,card says 120 days,' +
        '"KNOWN FAIL: code uses 119 — encode as test.fail()"',
    );
    assert.ok(rows);
    const [claim] = tableToClaims(rows);
    assert.match(claim?.claim ?? '', /— note: KNOWN FAIL: code uses 119/);
  });

  it('names the accounts the whole document signs in as, with the cases that need each', () => {
    // The motivating shape: a probation review that changes hands. Two of its
    // five steps name an account, and neither of them is in the claim text —
    // `claimTextOf` reads the title, the expectation and the note, never the
    // Steps column. Without this roll-up nothing downstream could tell a
    // catalog needing two logins from one needing none until the authoring
    // loop refused a row, with a browser already open.
    const rows = parseTestCaseTable(
      `${HEADER}\n` +
        '1,PR_01,Probation,PR_01_01,Positive,High,manager submits and HRBP approves,,,,,' +
        '"1. Login ด้วย <MANAGER_ACCOUNT>\n2. กด Submit\n3. Login ด้วย <HRBP_ACCOUNT>\n4. กด Approve",' +
        'status is Probation Passed,\n' +
        '2,PR_01,Probation,PR_01_02,Positive,Medium,manager alone can submit,,,,,' +
        '"1. Login ด้วย <MANAGER_ACCOUNT>\n2. กด Submit",the case is queued,',
    );
    assert.ok(rows);
    const needs = tablePersonas(rows);
    assert.deepEqual(needs, [
      { label: 'MANAGER_ACCOUNT', cases: ['PR_01_01', 'PR_01_02'] },
      { label: 'HRBP_ACCOUNT', cases: ['PR_01_01'] },
    ]);

    // …and it reaches the claims file, which is what a surface actually reads.
    const file = toClaimsFile(
      'probation.csv',
      { summary: 's', documentNote: '', claims: tableToClaims(rows), model: 'read from the sheet', latencyMs: 0 },
      '2026-09-04T00:00:00.000Z',
      undefined,
      needs,
    );
    assert.deepEqual(file.personas?.map((p) => p.label), ['MANAGER_ACCOUNT', 'HRBP_ACCOUNT']);
    // Labels and case ids ONLY. This file is plain JSON a person opens, edits
    // and mails around; a credential has no business in it, and an email is a
    // credential's other half.
    // (`:` is JSON's own punctuation here — what must be absent is an
    // address or a secret, in any field.)
    assert.doesNotMatch(JSON.stringify(file.personas), /@|password|passwd|secret/i);
    for (const need of file.personas ?? []) assert.deepEqual(Object.keys(need).sort(), ['cases', 'label']);
  });

  it('says nothing at all when no row names an account, rather than saying none', () => {
    const rows = parseTestCaseTable(
      `${HEADER}\n1,X_01,Plain,X_01_01,Positive,Low,the page renders,,,,,1. open it,it renders,`,
    );
    assert.ok(rows);
    assert.deepEqual(tablePersonas(rows), []);
    const file = toClaimsFile(
      'plain.csv',
      { summary: 's', documentNote: '', claims: tableToClaims(rows), model: 'm', latencyMs: 0 },
      '2026-09-04T00:00:00.000Z',
      undefined,
      tablePersonas(rows),
    );
    // Absent, not `[]`: "nobody looked" and "nobody is needed" are different
    // facts, and a surface has to be able to tell them apart.
    assert.equal('personas' in file, false);
  });

  it('marks a row whose steps stop services as beyond the harness, boundary named', () => {
    const rows = parseTestCaseTable(
      `${HEADER}\n` +
        '1,DB_10,Outage,DB_10_01,Negative,High,graceful fallback when the DB is down,,,,,' +
        '"1. brew services stop postgresql@18\n2. open the catalog",falls back to the registry,run last',
    );
    assert.ok(rows);
    assert.equal(beyondHarnessReason(rows[0]!)?.includes('stopping or starting services'), true);
    const [claim] = tableToClaims(rows);
    assert.equal(claim?.testable, false);
    assert.match(claim?.source ?? '', /beyond the browser/);
  });

  it('marks a claim that pivots on a direct SQL write as held for a human', () => {
    const rows = parseTestCaseTable(
      `${HEADER}\n` +
        '1,DB_03,Propagation,DB_03_01,Positive,High,' +
        '"A direct SQL status change on a registry-matching row is reflected in the catalog",,,,,' +
        '1. psql update the row,the row renders Inactive,',
    );
    assert.ok(rows);
    assert.match(beyondHarnessReason(rows[0]!) ?? '', /read-only by design/);
    assert.equal(tableToClaims(rows)[0]?.testable, false);
  });

  it('ordinary rows stay testable — the detector is narrow on purpose', () => {
    const rows = parseTestCaseTable(
      `${HEADER}\n` +
        '1,DB_04,Create,DB_04_01,Positive,High,creating a plan inserts a row,,,,,' +
        '"1. click Create Plan\n2. psql -Atc ""select count(*) from plans"" to validate\n3. delete from plans where id=1 returning id",the row exists,cleanup via psql',
    );
    assert.ok(rows);
    // A psql SELECT for validation — and even a cleanup DELETE in the steps —
    // does not make the CLAIM untestable; only the service-stop commands and a
    // title that pivots on the write do.
    assert.equal(beyondHarnessReason(rows[0]!), null);
    assert.equal(tableToClaims(rows)[0]?.testable, true);
  });

  it('normalises the Actual Result column into accuracy\'s ground truth — and invents nothing', () => {
    // Every value the real be100 sheet holds. Passed/Failed (Re-Test included)
    // are verdicts; everything else — Cancelled, Pending confirm, Re-Testing,
    // blank — is the sheet saying it has none, and a percentage built on an
    // invented verdict would be a lie wearing a number.
    assert.equal(recordedResult('Passed'), 'passed');
    assert.equal(recordedResult('Re-Test Passed'), 'passed');
    assert.equal(recordedResult('pass'), 'passed');
    assert.equal(recordedResult('Failed'), 'failed');
    assert.equal(recordedResult('Re-Test Failed'), 'failed');
    assert.equal(recordedResult('fail'), 'failed');
    assert.equal(recordedResult('Cancelled'), undefined);
    assert.equal(recordedResult('Pending confirm'), undefined);
    assert.equal(recordedResult('Re-Testing'), undefined);
    assert.equal(recordedResult(''), undefined);
    assert.equal(recordedResult('  '), undefined);
  });

  it('describeCase hands the author the sheet whole: persona, preconditions, note', () => {
    const rows = parseTestCaseTable(
      `${HEADER}\n` +
        '1,DB_02,Union,DB_02_01,Positive,High,catalog renders the union,' +
        'admin@cnext.test / admin2026,dev server :3200,BE-MED-001,Benefits Admin,1. open the catalog,both rows render,' +
        'the union is the sync contract',
    );
    assert.ok(rows);
    const described = describeCase(rows[0]!);
    assert.match(described, /Login \/ persona:\n {2}admin@cnext.test \/ admin2026/);
    assert.match(described, /Preconditions:\n {2}dev server :3200/);
    assert.match(described, /Note \(from the sheet\):\n {2}the union is the sync contract/);
  });
});

// --- A workbook read as a grid (2026-09-03) ---------------------------------
//
// Built here with the reporter's own ZIP writer: the ZIP/XML reading is
// already proved against an openpyxl-written fixture (`catalog.xlsx`), and
// what this pins is the SHAPE — cell line breaks kept, sparse rows kept in
// their columns, several sheets, non-case sheets skipped.
import { buildZip } from '../src/reporter/excel-export.js';
import { extractDocument as extractDocumentText, extractWorkbookSheets } from '../src/catalog/extract.js';
import { parseTestCaseTable as parseTestCaseTableText, parseWorkbookCases, recordedResult as recorded } from '../src/catalog/test-case-table.js';

function cell(ref: string, text: string): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '&#10;');
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escaped}</t></is></c>`;
}
function sheetXml(rows: Record<string, string>[]): Buffer {
  const body = rows
    .map((cells, i) => `<row r="${i + 1}">${Object.entries(cells).map(([col, text]) => cell(`${col}${i + 1}`, text)).join('')}</row>`)
    .join('');
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`);
}
function trackerWorkbook(): Buffer {
  const workbook = Buffer.from(
    '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets>' +
      '<sheet name="Dashboard" sheetId="1" r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>' +
      '<sheet name="EC" sheetId="2" r:id="rId2" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>' +
      '<sheet name="TM" sheetId="3" r:id="rId3" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>' +
      '</sheets></workbook>',
  );
  const dashboard = sheetXml([{ A: 'Module', B: 'Passed' }, { A: 'EC', B: '8' }]);
  const ec = sheetXml([
    { A: 'No', B: 'Category', C: 'Scenario ID', D: 'Test Scenario', E: 'Test Case ID', F: 'Positive/Negative', G: 'Priority', H: 'Test Case', I: 'Test Data', J: 'Menu', K: 'Test Script / Steps', L: 'Expected Output', M: 'Test Status', N: 'Bug ticket' },
    { A: '1', B: 'Hiring', C: 'E2E-29', D: 'Hiring | Keyin', E: 'HIR-EC-029', F: 'Negative', G: 'High', H: 'Event Reason shows 3 values', I: '- Login = <HR_ADMIN_ACCOUNT>', J: 'EC > Hire & Onboard (New Hire)', K: '1. Login\n2. Open Event Reason', L: 'dropdown แสดง 3 ค่า\n- ไม่แสดง H_CORENTRY', M: 'Failed', N: 'BUG 71875' },
    // A remark row: the "id" column holds a paragraph, not a case.
    { E: 'ดูรายละเอียดเพิ่มเติมที่ชีท Hiring Test Data ก่อนคีย์ทุกครั้ง และแจ้งผู้ดูแลระบบให้ยกเลิกพนักงานหลังทดสอบ', H: 'note' },
    { A: '2', C: '', E: 'HIR-EC-030', F: 'Positive', G: 'Medium', H: 'Second case, scenario carried down', K: '1. x', L: 'y', M: 'Re-Test Passed' },
  ]);
  // A sheet whose header sits on a SPARSE row (extra columns further right)
  // and whose data rows leave columns empty — the shape that made the text
  // form's header unrecognisable.
  const tm = sheetXml([
    { A: 'No', B: 'Category', C: 'Scenario ID', D: 'Test Scenario', E: 'Test Case ID', F: 'Positive/Negative', G: 'Priority', H: 'Test Case', I: 'Test Data', J: 'Menu', K: 'Test Script / Steps', L: 'Expected Output', M: 'Test Status', Q: 'Blocker group', T: '4161', V: 'Tue' },
    { A: '163', B: 'Timesheet', C: 'TSH_02', D: 'ตรวจสอบ Work Schedule\n- เมนูย่อย Schedule', E: 'TSH_02_01', F: 'Positive', G: 'High', H: 'ตรวจสอบกรณี schedule_template_code = D05H0400_01', J: '1. ME\n2. Time & Attendance\n3. My Timesheet', K: '1. กด Menu\n2. กดเมนู ME', L: 'แสดงปฏิทินการทำงาน', M: 'Passed', Q: 'Test data' },
  ]);
  return buildZip([
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/worksheets/sheet1.xml', data: dashboard },
    { name: 'xl/worksheets/sheet2.xml', data: ec },
    { name: 'xl/worksheets/sheet3.xml', data: tm },
  ]);
}

describe('a tracking workbook is read as a grid, sheet by sheet', () => {
  it('keeps cell line breaks and sparse columns, and names each sheet', () => {
    const sheets = extractWorkbookSheets(trackerWorkbook());
    assert.deepEqual(sheets.map((s) => s.name), ['Dashboard', 'EC', 'TM']);
    const ec = sheets[1]!;
    assert.equal(ec.rows[1]![10], '1. Login\n2. Open Event Reason', 'the Steps cell is a multi-line cell, kept whole');
    const tm = sheets[2]!;
    assert.equal(tm.rows[0]![16], 'Blocker group', 'a sparse header keeps its column (Q = 16)');
    assert.equal(tm.rows[1]![8], '', 'an empty Test Data cell is an empty string in its column');
    assert.equal(tm.rows[1]![9], '1. ME\n2. Time & Attendance\n3. My Timesheet');
  });

  it('parses only the case sheets, tags rows with their sheet, and reads the tracker\'s columns', () => {
    const rows = parseWorkbookCases(extractWorkbookSheets(trackerWorkbook()));
    assert.ok(rows);
    assert.deepEqual(rows.map((r) => `${r.sheet}:${r.caseId}`), ['EC:HIR-EC-029', 'EC:HIR-EC-030', 'TM:TSH_02_01'], 'the dashboard is not a case sheet; a remark row is not a case');
    const first = rows[0]!;
    assert.equal(first.category, 'Hiring');
    assert.equal(first.menu, 'EC > Hire & Onboard (New Hire)');
    assert.equal(first.steps, '1. Login\n2. Open Event Reason');
    assert.equal(first.expected, 'dropdown แสดง 3 ค่า\n- ไม่แสดง H_CORENTRY');
    assert.equal(first.bugTicket, 'BUG 71875');
    assert.equal(recorded(first.actual), 'failed', 'Test Status is the sheet\'s recorded verdict');
    const second = rows[1]!;
    assert.equal(second.scenarioId, 'E2E-29', 'scenario carries down');
    assert.equal(second.category, 'Hiring', 'so does the category');
    assert.equal(recorded(second.actual), 'passed');
    const tm = rows[2]!;
    assert.equal(tm.sheet, 'TM');
    assert.equal(tm.testCase, 'ตรวจสอบกรณี schedule_template_code = D05H0400_01');
    assert.equal(tm.menu, '1. ME\n2. Time & Attendance\n3. My Timesheet');
    assert.equal(tm.testData, '');
  });

  it('is what the text form of the same workbook cannot give', () => {
    // The text path is for a model to read; re-parsing it as a delimited
    // table loses the multi-line cell and the sparse header. Pinned so the
    // catalog command is never quietly pointed back at it.
    const text = extractDocumentText('tracker.xlsx', trackerWorkbook(), Number.MAX_SAFE_INTEGER).text;
    const viaText = parseTestCaseTableText(text)?.find((r) => r.caseId === 'HIR-EC-029');
    const viaGrid = parseWorkbookCases(extractWorkbookSheets(trackerWorkbook()))?.find((r) => r.caseId === 'HIR-EC-029');
    assert.equal(viaGrid?.steps, '1. Login\n2. Open Event Reason');
    assert.notEqual(viaText?.steps, viaGrid?.steps, 'the text form has flattened the Steps cell');
  });
});

// --- The sheet grammar reaches the author (2026-09-03) ----------------------
//
// `tests/sheet-grammar.test.ts` pins each reader on the workbook's own lines;
// this pins what the catalog path does with them: the prompt's new sections
// sit between Test data and Steps so the older blocks keep their shape, the
// workbook's duplicate ids come out unique, and the claims gate can refuse a
// row that navigates off the run's origin.
import { describeCase as describeCaseRow, parseWorkbookCases as parseCases, sheetGateReason, tableToClaims as claimsOf } from '../src/catalog/test-case-table.js';

function collidingWorkbook(): Buffer {
  const workbook = Buffer.from(
    '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets>' +
      '<sheet name="BE" sheetId="1" r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>' +
      '<sheet name="TM" sheetId="2" r:id="rId2" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>' +
      '</sheets></workbook>',
  );
  const header = { A: 'No', B: 'Category', C: 'Scenario ID', D: 'Test Scenario', E: 'Test Case ID', F: 'Positive/Negative', G: 'Priority', H: 'Test Case', I: 'Test Data', J: 'Menu', K: 'Test Script / Steps', L: 'Expected Output', M: 'Test Status', N: 'Bug ticket', O: 'Note' };
  const be = sheetXml([
    header,
    { A: '1', B: 'Benefit Plan', C: 'PL_03', D: 'Create', E: 'PL_03_07', F: 'Positive', G: 'High', H: 'สร้าง Plan', I: 'Benefit Plan ID = PL_03_07\nBenefit name = QA-Create Plan\nCompany = C056 + C057', J: '1. HR\n2. Benefits Admin\n3. Benefit Plans', K: '1. เข้าสู่เมนูที่กำหนด\n2. กด Create', L: '6.1 จำนวนใน Total Plans +1\n6.2 จำนวนใน Reimbursement +1', M: 'Passed' },
    { A: '2', E: 'PL_03_08', F: 'Positive', G: 'High', H: 'Make Correction ไม่เปลี่ยนจำนวน', I: 'Benefit Plan ID = PL_03_07', J: '', K: '1. เข้าสู่เมนูที่กำหนด\n2. กด Make Correction', L: '4.1 จำนวนใน Total Plans ไม่เปลี่ยนแปลง', M: 'Blocked', N: '#71906' },
  ]);
  const tm = sheetXml([
    header,
    { A: '1', B: 'Leave Request', C: 'PL_03', D: 'ลา', E: 'PL_03_07', F: 'Positive', G: 'High', H: 'ลาป่วย', I: '', J: '1. ME\n2. Time & Attendance\n3. Leave request', K: '1. Login web humi\n2. กดเมนู ME', L: '- DB : time_management.leave_requests', M: 'Passed' },
    { A: '2', E: 'TSH_01_01', F: 'Positive', G: 'High', H: 'Timesheet A', K: '1. Navigate ไปที่ https://payroll-cnext-dev.central.co.th/admin/config/sso -> เลือกแท็บ "SSO Base Amount"', L: 'y', M: 'Not Start' },
    { A: '3', E: 'TSH_01_01', F: 'Positive', G: 'High', H: 'Timesheet B', K: '1. x', L: 'y', M: 'Not Start' },
  ]);
  return buildZip([
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/worksheets/sheet1.xml', data: be },
    { name: 'xl/worksheets/sheet2.xml', data: tm },
  ]);
}

describe('the sheet grammar reaches the author', () => {
  const rows = parseCases(extractWorkbookSheets(collidingWorkbook()))!;

  it('qualifies the workbook\'s colliding ids and keeps the sheet\'s spelling for the prompt', () => {
    assert.deepEqual(rows.map((r) => r.caseId), ['BE:PL_03_07', 'PL_03_08', 'TM:PL_03_07', 'TSH_01_01', 'TSH_01_01#2'], 'only the ids that collide are qualified');
    assert.equal(rows[0]!.sheetCaseId, 'PL_03_07');
    assert.equal(rows[3]!.sheetCaseId, undefined);
    assert.equal(rows[4]!.sheetCaseId, 'TSH_01_01');
    assert.deepEqual(rows[1]!.dependsOn, ['BE:PL_03_07'], 'a reference resolves to the same sheet\'s row, by its qualified id');
    assert.equal(rows[1]!.menu, rows[0]!.menu, 'a blank Menu inherits within the scenario');
  });

  it('describeCase adds its sections between Test data and Steps, and leaves the older blocks as they were', () => {
    const described = describeCaseRow(rows[0]!);
    const headings = described.split('\n').filter((line) => !/^ {2}/.test(line));
    assert.deepEqual(headings, [
      'PL_03_07: สร้าง Plan',
      'Scenario: Create',
      'Type: Positive',
      'Menu path: HR > Benefits Admin > Benefit Plans',
      'Test data:',
      'Steps:',
      'Expected output:',
    ]);
    assert.match(described, /\nTest data:\n {2}Benefit Plan ID = PL_03_07\n {2}Benefit name = QA-Create Plan\n {2}Company = C056 \+ C057\nSteps:\n/);
    assert.match(described, /\nExpected output:\n {2}6\.1 จำนวนใน Total Plans \+1\n {2}6\.2 จำนวนใน Reimbursement \+1$/);
    const tm = describeCaseRow(rows[2]!);
    assert.match(tm, /\nMenu path: ME > Time & Attendance > Leave request\nDatabase tables named: time_management\.leave_requests\nSteps:\n/);
    const py = describeCaseRow(rows[3]!);
    assert.match(py, /\nDestination: https:\/\/payroll-cnext-dev\.central\.co\.th\/admin\/config\/sso \(tab "SSO Base Amount"\)\nSteps:\n/);
  });

  it('the claims gate refuses a row that leaves the run\'s origin, and the sheet gate a Blocked one with its ticket', () => {
    const claims = claimsOf(rows, 'http://localhost:3005/humi/en/login');
    assert.equal(claims[3]!.testable, false);
    assert.match(claims[3]!.source, /^TSH_01_01 \(navigates to payroll-cnext-dev\.central\.co\.th/);
    assert.equal(claims[0]!.testable, true);
    assert.equal(claimsOf(rows)[3]!.testable, true, 'without a start URL the host is not judged');
    assert.equal(sheetGateReason(rows[1]!), 'the sheet records this case as Blocked — bug ticket #71906');
    assert.equal(sheetGateReason(rows[0]!), null);
  });
});

describe('a row that slipped against its header (ec09.csv, 2026-09-03)', () => {
  const HEADER =
    'No,Category,Scenario ID,Test Scenario,Test Case ID,Positive/Negative,Priority,Test Case,' +
    'Test Data,Menu,Test Script / Steps,Expected Output,Test Status,Test Date,Test by,Bug ticket,Note';

  it('realigns a row shifted one cell right by dropping the blank the writer skipped', () => {
    
    const cells = ['9', 'Hiring', '', 'E2E-09', 'Hiring | Keyin', 'HIR-EC-009', 'Positive', 'High', 'title', 'data', 'menu', '1. steps', 'expected', 'Failed', '', 'QA', '72079'];
    const { cells: fixed, shift } = realignRow(cells, 5);
    assert.equal(shift, 1);
    assert.equal(fixed[2], 'E2E-09');
    assert.equal(fixed[3], 'Hiring | Keyin');
    assert.equal(fixed[4], 'HIR-EC-009');
    assert.equal(fixed[5], 'Positive');
    assert.equal(fixed[15], '72079');
  });

  it('leaves an aligned row, and a row with no polarity nearby, exactly as they are', () => {
    
    const aligned = ['1', 'A', 'S1', 'scenario', 'ID-1', 'Negative', 'Low'];
    assert.deepEqual(realignRow(aligned, 5), { cells: aligned, shift: 0 });
    const none = ['1', 'A', 'S1', 'scenario', 'ID-1', '', 'Low'];
    assert.deepEqual(realignRow(none, 5), { cells: none, shift: 0 });
  });

  it('reads the shifted sheet as a table — one case, its columns where the header says', () => {
    const rows = parseTestCaseTable(
      `${HEADER}\n` +
        '9,Hiring,,E2E-09,"Hiring | Keyin - Success",HIR-EC-009,Positive,High,' +
        '"ตรวจสอบการจ้างพนักงานใหม่",- Entry Route = Keyin,EC > Hire,"1. Login\n2. Key in","EC\n- shows DVT fields",Failed,,QA-Thitiya,"72079\n72090"',
    );
    assert.ok(rows, 'the sheet is a test-case table, not a document for the model');
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row.caseId, 'HIR-EC-009');
    assert.equal(row.scenarioId, 'E2E-09');
    assert.equal(row.polarity, 'Positive');
    assert.match(row.steps, /^1\. Login/);
    assert.match(row.expected, /DVT fields/);
    assert.equal(row.actual, 'Failed');
    assert.equal(row.bugTicket, '72079\n72090');
  });
});

describe('one row is one case, even when a model split it', () => {
  
  const text =
    '## row 2\nTest Case ID: HIR-EC-009\nExpected Output:\n  - creates the employee\n  - shows 9 DVT fields\n\n' +
    '## row 3\nTest Case ID: HIR-EC-010\nExpected Output:\n  - rejects the duplicate';

  it('merges the testable claims of a row into one, keeping context lines and other rows apart', () => {
    const grouped = groupClaimsByRow(
      [
        { claim: 'The case runs as HR admin.', priority: 'low', source: 'HIR-EC-009', testable: false },
        { claim: 'The system creates the employee.', priority: 'medium', source: 'HIR-EC-009', testable: true },
        { claim: 'The system shows 9 DVT fields.', priority: 'high', source: 'HIR-EC-009', testable: true },
        { claim: 'The system rejects the duplicate.', priority: 'medium', source: 'HIR-EC-010', testable: true },
      ],
      text,
    );
    assert.equal(grouped.length, 3);
    assert.equal(grouped[0]!.testable, false);
    assert.deepEqual(grouped[1], {
      claim: 'The system creates the employee; The system shows 9 DVT fields',
      priority: 'high',
      source: 'HIR-EC-009',
      testable: true,
    });
    assert.equal(grouped[2]!.source, 'HIR-EC-010');
  });

  it('places a claim by the words it quoted when the source is not an id, and leaves an unplaceable one alone', () => {
    const grouped = groupClaimsByRow(
      [
        { claim: 'a', priority: 'medium', source: 'shows 9 DVT fields', testable: true },
        { claim: 'b', priority: 'medium', source: 'creates the employee', testable: true },
        { claim: 'c', priority: 'medium', source: 'nowhere in the sheet', testable: true },
      ],
      text,
    );
    assert.equal(grouped.length, 2);
    assert.equal(grouped[0]!.source, 'HIR-EC-009');
    assert.equal(grouped[0]!.claim, 'a; b');
    assert.equal(grouped[1]!.claim, 'c');
  });

  it('returns a prose document’s claims untouched', () => {
    const claims = [{ claim: 'x', priority: 'medium', source: '1.1', testable: true }];
    assert.deepEqual(groupClaimsByRow(claims, '# Spec\n1.1 x'), claims);
  });
});
