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
