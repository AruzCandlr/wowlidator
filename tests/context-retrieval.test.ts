/**
 * Context-document retrieval: chunking, BM25, and the rails that keep a
 * partial document from reading like a whole one.
 *
 * Entirely unit-tier — chunk-and-score is arithmetic over strings, with no
 * model, no browser and no file system, the `context-engine.test.ts`
 * reasoning. The two boundary tests are here rather than in `catalog.test.ts`
 * because what they pin is a property of *this* feature: the catalog document
 * and `draft`'s source material are never selected over, and both failures
 * would be silent.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CONTEXT_BUDGET_CHARS,
  CONTEXT_RETRIEVAL_MIN_CHARS,
  MAX_SPINE_LINES,
  chunkDocument,
  rankChunks,
  referencedSources,
  selectRelevantContext,
  tokenize,
} from '../src/catalog/retrieve.js';
import { buildAuthoringPrompt, buildClaimsPrompt } from '../src/catalog/catalog.js';
import { buildDraftPrompt } from '../src/catalog/draft.js';
import type { ExtractedDocument } from '../src/catalog/extract.js';
import { HEAL_BACKGROUND_BUDGET_CHARS, healHintsFrom } from '../src/context/heal-hints.js';
import { buildUserPrompt as healerPrompt } from '../src/healer/jit-healer.js';

function doc(name: string, text: string): ExtractedDocument {
  return { name, format: 'markdown', text, note: '', originalChars: text.length };
}

/** A document long enough to be worth selecting from. */
function padded(name: string, sections: readonly [string, string][]): ExtractedDocument {
  const filler = 'The system records the outcome of the operation for later review. ';
  const text = sections
    .map(([heading, body]) => `## ${heading}\n${body}\n${filler.repeat(30)}`)
    .join('\n\n');
  return doc(name, text);
}

describe('chunking', () => {
  it('attaches the heading path and never straddles a heading', () => {
    const chunks = chunkDocument(
      doc(
        'spec.md',
        '# Sessions\n\nIntro line.\n\n## Timeout\n\nSessions expire after 30 minutes.\n\n## Refresh\n\nA refresh extends the session.',
      ),
    );

    assert.deepEqual(
      chunks.map((chunk) => chunk.headingPath),
      ['Sessions', 'Sessions > Timeout', 'Sessions > Refresh'],
    );
    for (const chunk of chunks) {
      assert.equal(chunk.text.includes('##'), false, 'a chunk must not carry the next heading');
    }
    assert.match(chunks[1]?.text ?? '', /expire after 30 minutes/);
  });

  it('splits an oversize body at a line boundary, never mid-line', () => {
    const line = 'Every requirement in this section is numbered and testable.';
    const chunks = chunkDocument(doc('long.md', `## Rules\n\n${`${line}\n`.repeat(200)}`));

    assert.ok(chunks.length > 1, 'a 12,000-character section must be split');
    for (const chunk of chunks) {
      for (const own of chunk.text.split('\n')) {
        assert.ok(own === '' || own === line, `a line was cut: ${JSON.stringify(own)}`);
      }
    }
  });

  it('repeats a table header in every chunk that continues the table', () => {
    const header = 'Case ID | Scenario | Expected';
    const rows = Array.from(
      { length: 120 },
      (_, i) => `PB-${String(i).padStart(2, '0')} | the probation inbox loads | the list is shown`,
    );
    const chunks = chunkDocument(doc('cases.csv', `${header}\n${rows.join('\n')}`));

    assert.ok(chunks.length > 1, 'the fixture must be long enough to split');
    for (const chunk of chunks) {
      assert.ok(
        chunk.text.startsWith(header),
        'a retrieved row without its column names means nothing',
      );
    }
  });

  it('loses no line of the document, whatever shape it is', () => {
    // The regression this exists for: numbered lines were read as headings,
    // a heading's line is carried as a path and never as body, and a six-step
    // checklist chunked to NOTHING — the model was handed an outline of the
    // steps with no steps under it. Any content loss here is invisible
    // downstream, which is the whole reason `extract.ts` has the same rule.
    const shapes = [
      '## Steps\n1. Open the probation hub\n2. Select the employee row\n3. Submit',
      'A) first\nB) second\nC) third',
      '1.1 Session timeout\n1.2 Session refresh',
      'Case ID | Scenario\nPB-01 | the inbox loads\nPB-02 | the filter applies',
      'no headings at all, just one paragraph of prose about probation reviews',
    ];
    for (const text of shapes) {
      const chunks = chunkDocument(doc('shape.md', text));
      const kept = chunks.map((chunk) => chunk.text).join('\n');
      for (const line of text.split('\n')) {
        if (line.startsWith('#') || line.trim() === '') continue;
        assert.ok(kept.includes(line.trim()), `lost: ${JSON.stringify(line)}`);
      }
    }
  });

  it('does not treat a numbered procedure step as a section heading', () => {
    const chunks = chunkDocument(
      doc('steps.md', '## Procedure\n\n1. Open the page and wait for the list to finish loading.\n2. Click Approve.'),
    );
    assert.deepEqual(new Set(chunks.map((chunk) => chunk.headingPath)), new Set(['Procedure']));
  });
});

describe('tokenizing', () => {
  it('keeps an identifier whole and in parts', () => {
    const terms = tokenize('Case PB-05-01 failed');
    assert.ok(terms.includes('pb-05-01'), 'the id someone pasted must match');
    assert.ok(terms.includes('pb'), 'and so must the scenario prefix they typed');
    assert.ok(terms.includes('05'));
  });

  it('indexes a script with no word boundaries as n-grams', () => {
    // Thai runs together, so a whitespace tokeniser sees one token and the
    // query never meets the corpus. PB-05-01's app rendered exactly this.
    const corpus = 'ระบบบันทึกผลการประเมินทดลองงาน';
    const query = 'การประเมิน';
    assert.equal(
      corpus.split(/\s+/).includes(query),
      false,
      'the whitespace tokeniser this replaces fails the same fixture',
    );
    const terms = new Set(tokenize(corpus));
    assert.ok(
      tokenize(query).some((term) => terms.has(term)),
      'n-grams are what make the two meet',
    );
  });
});

describe('BM25 ranking', () => {
  const chunks = [
    { doc: 'a.md', headingPath: 'Sessions', index: 0, text: 'a session expires after thirty minutes of inactivity' },
    { doc: 'a.md', headingPath: 'Payments', index: 1, text: 'a refund is issued to the original payment method' },
    { doc: 'a.md', headingPath: 'Login', index: 2, text: 'a session begins when the user signs in' },
  ];

  it('ranks the chunk the query is about first', () => {
    const ranked = rankChunks(chunks, 'how long before a session expires');
    assert.equal(ranked[0]?.chunk.index, 0);
  });

  it('never scores a term negatively, however common it is', () => {
    // "a" is in every chunk. The textbook IDF goes negative there, and a chunk
    // then scores worse for containing a query term — a result that reads like
    // a bug and behaves like one.
    for (const entry of rankChunks(chunks, 'a')) {
      assert.ok(entry.score >= 0, `negative score: ${entry.score}`);
    }
  });

  it('scores nothing for a query with no shared vocabulary', () => {
    for (const entry of rankChunks(chunks, 'quarterly warehouse logistics')) {
      assert.equal(entry.score, 0);
    }
  });
});

describe('selection', () => {
  const spec = padded('spec.md', [
    ['Overview', 'The application manages probation reviews.'],
    ['Session timeout', 'A session expires after thirty minutes and the user is signed out.'],
    ['Payments', 'A refund is issued to the original payment method within five days.'],
    ['Notifications', 'An email is sent whenever a review is submitted for approval.'],
  ]);

  it('keeps only what the query is about, in document order, under the budget', () => {
    const result = selectRelevantContext([spec], 'a session expires and signs the user out', {
      budgetChars: 4_000,
    });

    assert.equal(result.retrieved, true);
    assert.ok(result.chars <= 4_000 + 2_000, 'budget plus the spine and the notice');
    const text = result.documents[0]?.text ?? '';
    assert.match(text, /expires after thirty minutes/);
    assert.doesNotMatch(text, /refund is issued/);

    const positions = ['Session timeout'].map((heading) => text.indexOf(heading));
    assert.ok(positions.every((position) => position >= 0));
  });

  it('sends a small document through byte-for-byte', () => {
    const small = doc('glossary.md', '# Glossary\n\nHRBP: HR business partner.');
    assert.ok(small.text.length < CONTEXT_RETRIEVAL_MIN_CHARS);

    const result = selectRelevantContext([small], 'what is an HRBP');
    assert.equal(result.retrieved, false);
    assert.equal(result.documents[0]?.text, small.text, 'selection must not touch what already fits');
    assert.equal(result.note, '');
  });

  it('gives every document its best section before any document gets a second', () => {
    const other = padded('api.md', [
      ['Endpoints', 'POST /api/sessions creates a session.'],
      ['Errors', 'A 401 is returned when the session has expired.'],
      ['Rate limits', 'A client may make sixty requests a minute.'],
      ['Versioning', 'The version is carried in the Accept header.'],
    ]);
    assert.ok(other.text.length >= CONTEXT_RETRIEVAL_MIN_CHARS, 'both fixtures must be selected over');
    const result = selectRelevantContext([spec, other], 'session expiry', { budgetChars: 3_000 });

    for (const document of result.documents) {
      assert.match(
        document.note,
        /relevance-selected: [1-9]/,
        `${document.name} was crowded out — two documents someone passed are two things they thought mattered`,
      );
    }
  });

  it('a lexically weaker document still quotes its best section — never outline-only', () => {
    // The query's vocabulary saturates spec.md, so every api.md chunk scores
    // under RELATIVE_SCORE_FLOOR of the global best. The old floor drew from
    // the filtered list and left api.md quoting NOTHING — "the AI only used
    // one document". Any document that scored at all must quote something.
    const other = padded('api.md', [
      ['Endpoints', 'POST /api/reviews creates a review record.'],
      ['Errors', 'A 401 is returned when authentication fails.'],
      ['Rate limits', 'A client may make sixty requests a minute.'],
      ['Versioning', 'The version is carried in the Accept header.'],
    ]);
    const result = selectRelevantContext(
      [spec, other],
      'session expires after thirty minutes signed out session expires review',
      { budgetChars: 3_000 },
    );
    const api = result.documents.find((d) => d.name === 'api.md');
    assert.match(
      api?.note ?? '',
      /relevance-selected: [1-9]/,
      'the weaker document was reduced to an outline with nothing quoted',
    );
  });

  it('sends the document whole rather than quoting sections that matched nothing', () => {
    const result = selectRelevantContext([spec], 'quarterly warehouse logistics', {
      budgetChars: 4_000,
    });
    assert.equal(result.selected, 0, 'nothing irrelevant may be quoted as if it were selected');
    assert.equal(result.documents[0]?.text, spec.text, 'and the background is not lost either');
    assert.match(result.note, /does not distinguish/);
  });

  it('refuses to select when the query tells no section from another', () => {
    // Every section shares its vocabulary, so every score is the same and the
    // tie breaks on document order: "selected" would mean sections 1..n —
    // positional truncation wearing a relevance badge, which is worse than
    // positional truncation because a reader believes it.
    const flat = padded(
      'flat.md',
      Array.from({ length: 12 }, (_, i) => [`Module ${i}`, 'A record is created and reviewed.'] as [string, string]),
    );
    const result = selectRelevantContext([flat], 'a record is created and reviewed', {
      budgetChars: 4_000,
    });
    assert.equal(result.retrieved, false);
    assert.equal(result.documents[0]?.text, flat.text);
  });

  it('sends the outline whatever the budget, and says what was left out', () => {
    const result = selectRelevantContext([spec], 'session expiry', { budgetChars: 1_500 });
    const text = result.documents[0]?.text ?? '';

    for (const heading of ['Overview', 'Session timeout', 'Payments', 'Notifications']) {
      assert.ok(text.includes(heading), `${heading} must appear in the outline even when elided`);
    }
    assert.match(text, /sections are included below/);
    assert.match(text, /do NOT conclude the document is silent on anything/);
  });

  it('truncates a very long outline and discloses that too', () => {
    const many = padded(
      'huge.md',
      Array.from({ length: MAX_SPINE_LINES + 20 }, (_, i) => [`Section ${i}`, `Body ${i}.`] as [string, string]),
    );
    const text = selectRelevantContext([many], 'section 3', { budgetChars: 2_000 }).documents[0]?.text ?? '';
    assert.match(text, /\(\+20 more section\(s\), not listed\)/);
  });

  it('returns a document that fits entirely, unchanged', () => {
    // Between CONTEXT_RETRIEVAL_MIN_CHARS and the budget, selection has
    // nothing to select away — and the outline plus the notice would make the
    // prompt LARGER than sending the document did, in exactly the range where
    // this feature saves nothing.
    // Every section of the fixture carries this sentence, so every one scores
    // and every one fits — nothing is left out, so nothing needs disclosing.
    const result = selectRelevantContext([spec], 'the system records the outcome for later review', {
      budgetChars: 500_000,
    });
    assert.equal(result.selected, result.total, 'the premise: the whole document was selected');
    assert.equal(result.retrieved, false, 'reporting work it did not do is its own kind of dishonest');
    assert.equal(result.note, '');
    assert.equal(result.documents[0]?.text, spec.text);
    assert.equal(result.documents[0]?.note, '');
  });

  it('is on by default, and 0 sends every document whole', () => {
    // The default budget is what a run gets with no flag: a document larger
    // than it is cut to the sections that bear on the query. `0` is the off
    // switch, and it must still mean "everything, untouched".
    assert.equal(CONTEXT_BUDGET_CHARS, 24_000);
    const big = doc('big.md', Array.from({ length: 60 }, (_, i) => `# Section ${i}\n\n${'filler words about topic '.repeat(40)}${i === 7 ? 'session expiry logs the user out' : ''}`).join('\n\n'));
    const byDefault = selectRelevantContext([big], 'session expiry', {});
    assert.equal(byDefault.retrieved, true);
    assert.ok((byDefault.documents[0]?.text.length ?? 0) < big.text.length);
    for (const options of [{ budgetChars: 0 }]) {
      const result = selectRelevantContext([big], 'session expiry', options);
      assert.equal(result.retrieved, false);
      assert.equal(result.documents[0]?.text, big.text);
    }
  });

  it('builds an identical prompt from identical inputs', () => {
    const once = selectRelevantContext([spec], 'session expiry', { budgetChars: 4_000 });
    const twice = selectRelevantContext([spec], 'session expiry', { budgetChars: 4_000 });
    assert.equal(once.documents[0]?.text, twice.documents[0]?.text);
  });

  it('returns the documents whole when anything inside it throws', () => {
    const exploding = { ...doc('boom.md', 'x'.repeat(20_000)) };
    Object.defineProperty(exploding, 'text', {
      get() {
        throw new Error('unreadable');
      },
    });

    const warnings: string[] = [];
    const result = selectRelevantContext([exploding as ExtractedDocument], 'anything', {
      budgetChars: 4_000,
      onWarn: (line) => warnings.push(line),
    });

    assert.equal(result.retrieved, false);
    assert.equal(result.documents[0], exploding, 'the caller keeps exactly what it passed in');
    assert.match(warnings[0] ?? '', /sending the documents whole/);
  });
});

describe('the boundaries retrieval must not cross', () => {
  const catalog = doc('cases.md', '# Cases\n\nThe probation inbox lists every open review.');

  it('never selects over the catalog document itself', () => {
    const prompt = buildClaimsPrompt({ document: catalog, context: [] });
    assert.ok(
      prompt.includes(catalog.text),
      'a claim you did not retrieve is a requirement silently dropped',
    );
  });

  it('never selects over draft source material', () => {
    const prompt = buildDraftPrompt({ description: 'probation', context: [catalog] });
    assert.ok(
      prompt.includes(catalog.text),
      "draft enumerates cases FROM its context — it is source, not background",
    );
  });

  it('keeps the supporting-context section where it was', () => {
    const prompt = buildAuthoringPrompt(
      [{ claim: 'the inbox loads', priority: 'high', source: '1', testable: true }],
      { context: [doc('spec.md', 'background text')] },
    );
    assert.match(prompt, /--- SUPPORTING CONTEXT: spec\.md ---/);
    assert.match(prompt, /Background only/);
  });
});

// ---------------------------------------------------------------------------
// Heal hints (`src/context/heal-hints.ts`) — the healer's slice of retrieval.
// Unit-tier for the same reason as the rest of this file; the graph half is
// exercised where a real graph exists (`context-engine.test.ts`).
// ---------------------------------------------------------------------------

describe('healHintsFrom', () => {
  it('yields nothing from nothing — no graph, no documents, no sections', () => {
    const hints = healHintsFrom(null, [])({
      url: 'http://x.test/en/admin',
      selector: 'role=button[name="Save" i]',
    });
    assert.equal(hints.repoHints, undefined);
    assert.equal(hints.background, undefined);
  });

  it('yields no background when the query has no terms to rank by', () => {
    const hints = healHintsFrom(null, [doc('spec.md', '# Benefits\ncontent')])({
      url: 'http://x.test/en/admin',
      selector: '',
    });
    assert.equal(hints.background, undefined);
  });

  it('selects background by the failed step\'s own words and never exceeds its budget', () => {
    const filler = Array.from({ length: 200 }, (_, i) => `## Section ${i}\nfiller line about nothing relevant ${i}`).join('\n');
    const documents = [
      doc('spec.md', `# Manual\n${filler}\n## Benefit plan editing\nThe Edit Plan dialog opens from the row's pencil button and saves via the Update button.\n`),
    ];
    const hints = healHintsFrom(null, documents)({
      url: 'http://x.test/en/admin/benefits/plans',
      selector: 'role=button[name="Update" i]',
      intent: 'Save the edited benefit plan',
      caseContext: 'Case: PL_06_01 edit a benefit plan',
    });
    assert.ok(hints.background !== undefined, 'the matching section was selected');
    assert.match(hints.background!, /Edit Plan dialog/);
    assert.ok(
      hints.background!.length <= HEAL_BACKGROUND_BUDGET_CHARS + 100,
      `background exceeded the healer's budget: ${hints.background!.length}`,
    );
  });
});

// The healer's prompt renders both hint sections BEFORE the tree, so every
// re-ask of one heal still shares a byte-identical prefix — only `rejected`
// may grow between attempts (the healer's own caching rule).
describe('heal prompt with hints', () => {
  const request = {
    failedSelector: 'role=button[name="Update" i]',
    action: 'click',
    url: 'http://x.test/en/admin/benefits/plans',
    axTree: 'role=dialog\n  role=button[name="Update"]',
    rejected: ['role=button[name="Save" i] — not in the tree'],
  };

  it('renders repo and background sections between the header and the tree', () => {
    const prompt = healerPrompt(request, {
      repoHints: 'Project context for /en/admin/benefits/plans: renders PlanEditDialog',
      background: '--- spec.md ---\nThe Edit Plan dialog saves via Update.',
    });
    const repoAt = prompt.indexOf('What the repository declares');
    const backgroundAt = prompt.indexOf('Background documents');
    const treeAt = prompt.indexOf('Accessibility tree:');
    const rejectedAt = prompt.indexOf('Already tried and rejected');
    assert.ok(repoAt > -1 && backgroundAt > repoAt && treeAt > backgroundAt && rejectedAt > treeAt);
  });

  it('without hints the prompt is byte-identical to what it always was', () => {
    assert.equal(healerPrompt(request), healerPrompt(request, undefined));
    assert.doesNotMatch(healerPrompt(request), /repository declares|Background documents/);
  });
});

describe('referencedSources — the citations a test case defers to', () => {
  it('extracts the cited source from English and Thai markers', () => {
    assert.deepEqual(
      referencedSources('The displayed rates must match the values as per the Master Benefit List'),
      ['the Master Benefit List'],
    );
    assert.deepEqual(
      referencedSources('Verify totals according to section 4.2 of the spec'),
      ['section 4.2 of the spec'],
    );
    assert.deepEqual(referencedSources('ตรวจสอบค่า อ้างอิงจาก Requirement Spec v2'), ['Requirement Spec v2']);
    // Bare "ตาม" needs a document-ish noun — "per the condition" is not a citation.
    assert.deepEqual(referencedSources('ตรวจสอบตามเงื่อนไขที่กำหนด'), []);
    assert.equal(referencedSources('ตามเอกสาร Master Benefit List ข้อ 3').length, 1);
  });

  it('deduplicates, trims quotes, and never returns runaway phrases', () => {
    const twice = referencedSources('as per "the Master List". Also refer to the Master List.');
    assert.deepEqual(twice, ['the Master List']);
    assert.deepEqual(referencedSources('nothing cited here'), []);
    for (const phrase of referencedSources('see ' + 'x'.repeat(300))) {
      assert.ok(phrase.length <= 80);
    }
  });
});
