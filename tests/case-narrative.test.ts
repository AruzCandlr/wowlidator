/**
 * The case narrative (`src/generator/case-narrative.ts`). Pure everywhere
 * except one test that drives the real structured path through a mock model:
 * what matters is the trust boundary in `applyNarrative` and the projection
 * that decides what the model ever sees.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { LanguageModel } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';

import { effectiveStatus, type ProofBundle, type ProofStep } from '../src/engine/proof-bundle.js';
import {
  NARRATIVE_MAX_CELL_CHARS,
  NARRATIVE_HARD_CHARS,
  NARRATIVE_NOTE_MAX_WORDS,
  NARRATIVE_SOFT_CHARS,
  clipNote,
  noteWords,
  keepShorter,
  overSoftCap,
  shortenAsk,
  NARRATIVE_MAX_CHARS,
  NARRATIVE_MAX_TICKETS,
  applyNarrative,
  clipCell,
  buildNarrativePrompt,
  caseNarrativeEnabled,
  composeNarrative,
  narrativeRequest,
  needsNarrative,
  LlmCaseNarrativeModel,
  type CaseNarrativeModel,
  type NarrativeAnswer,
} from '../src/generator/case-narrative.js';
import { jsonModel } from './helpers.js';

function step(over: Partial<ProofStep> & Pick<ProofStep, 'index' | 'action'>): ProofStep {
  return {
    selector: null,
    resolvedSelector: null,
    resolution: null,
    status: 'passed',
    startedAt: '2026-09-10T00:00:00.000Z',
    durationMs: 12,
    url: 'https://app.example.com/probation',
    ...over,
  } as ProofStep;
}

type Narratable = Pick<ProofBundle, 'steps' | 'name' | 'status' | 'defects'> & Partial<Pick<ProofBundle, 'variables' | 'notes' | 'narrative'>>;

function bundle(over: Partial<Narratable> = {}): Narratable {
  return {
    name: 'PRB-EC-026',
    status: 'failed',
    defects: [{ id: 'd1', severity: 'high', category: 'functional', title: 'Due date not synced', detail: 'extend_date 2026-11-07 but page says Due in 29 days', source: 'runtime' }],
    steps: [
      step({ index: 1, action: 'goto' }),
      step({ index: 2, action: 'fill', selector: 'role=textbox[name="Password" i]', detail: { value: 'hunter2-secret' } }),
      step({
        index: 3,
        action: 'expectDbRow',
        db: {
          kind: 'row', table: 'probation_transactions', where: 'id = 69', expected: 'probation_status = PASSED', observed: 'probation_status = PENDING',
          durationMs: 40,
          statements: [{ sql: 'SELECT * FROM "probation_transactions" WHERE "id" = $1 LIMIT 25', params: ['69'], tables: ['probation_transactions'] }],
          rows: [{ id: '69', probation_status: 'PENDING' }],
          rowsMatched: 1,
        },
        status: 'failed',
        error: 'expected PASSED, observed PENDING',
      }),
    ],
    variables: { transactionId: '69', password: '[masked]' },
    notes: ['started from an empty session'],
    ...over,
  };
}

const ANSWER: NarrativeAnswer = {
  lede: 'Tested the second extension on transaction 69.',
  summary: 'Opens the probation page, signs in, and reads transaction 69 back from the database.',
  testData: 'Transaction 69.',
  expected: 'The transaction is PASSED after approval.',
  tickets: [
    { kind: 'app', title: 'PRB-EC-026 · sync the due date', detail: 'extend_date 2026-11-07 but page says Due in 29 days', owner: 'Dev', defectId: 'd1' },
    { kind: 'test', title: 'PRB-EC-026 · cover notifications', detail: 'the inbox was never opened', owner: 'Verifier', defectId: 'ghost' },
    { kind: 'app', title: 'PRB-EC-026 · invented defect', detail: 'no line shows this', owner: 'Dev', defectId: 'ghost' },
    { kind: 'app', title: 'PRB-EC-026 · another invented defect', detail: 'nor this', owner: 'Dev' },
    { kind: 'test', title: 'PRB-EC-026 · a second test-side ticket', detail: 'one is the cap', owner: 'Verifier' },
  ],
  verifierNote: 'The session started empty.',
  questions: [{ question: 'PASS or PASSED?', answer: 'PENDING was observed.', evidence: 'step 3' }],
};

describe('the switch', () => {
  it('is ON unless switched off — the page is built around it', () => {
    assert.equal(caseNarrativeEnabled({}), true);
    assert.equal(caseNarrativeEnabled({ WOWLIDATOR_CASE_NARRATIVE: 'on' }), true);
    for (const off of ['off', '0', 'false', 'no', ' OFF ']) assert.equal(caseNarrativeEnabled({ WOWLIDATOR_CASE_NARRATIVE: off }), false, off);
  });
});

describe('what the model sees', () => {
  it('is the step lines, the DB proof lines, the defects, the masked variables and the notes — and the language', () => {
    const request = narrativeRequest(bundle(), 'ต่อทดลองงาน 2 รอบ', 'th');
    const prompt = buildNarrativePrompt(request);
    assert.match(prompt, /^LANGUAGE: write every field in Thai/);
    assert.match(prompt, /CASE: PRB-EC-026/);
    assert.match(prompt, /STATUS: failed/);
    assert.match(prompt, /ต่อทดลองงาน 2 รอบ/);
    assert.match(prompt, /\[3\]\s+expectDbRow/);
    assert.match(prompt, /query: SELECT \* FROM "probation_transactions" WHERE "id" = \$1 LIMIT 25/);
    assert.match(prompt, /parameters: \$1 = 69/);
    assert.match(prompt, /- d1 \[functional, high\] Due date not synced/);
    assert.match(prompt, /- transactionId = 69/);
    assert.match(prompt, /- password = \[masked\]/);
    assert.match(prompt, /- started from an empty session/);
  });

  it('never carries a typed credential: the fill value is not on the step line the model is given', () => {
    const prompt = buildNarrativePrompt(narrativeRequest(bundle(), 'x', 'en'));
    assert.doesNotMatch(prompt, /hunter2-secret/);
  });

  it('shows the first 120 step lines and says how many there were', () => {
    const steps = Array.from({ length: 121 }, (_, i) => step({ index: i + 1, action: 'click' }));
    const prompt = buildNarrativePrompt(narrativeRequest(bundle({ steps }), 'x', 'en'));
    assert.match(prompt, /STEPS \(121, first 120 shown\):/);
    assert.doesNotMatch(prompt, /\[121\]/);
  });

  it('leaves out superseded attempts', () => {
    const b = bundle({ steps: [step({ index: 1, action: 'click', superseded: true }), step({ index: 1, action: 'click' })] });
    assert.equal(narrativeRequest(b, 'x', 'en').stepLines.length, 1);
  });
});

describe('applyNarrative — the trust boundary', () => {
  it('writes an attributed narrative; an app ticket must restate a recorded defect, a test ticket may not, and one test ticket is the cap', () => {
    const b = bundle();
    assert.equal(applyNarrative(b, ANSWER, 'mock:narrator', 'en', '2026-09-10T01:00:00.000Z'), true);
    assert.equal(b.narrative?.by, 'mock:narrator');
    assert.equal(b.narrative?.lang, 'en');
    assert.equal(b.narrative?.at, '2026-09-10T01:00:00.000Z');
    assert.deepEqual(
      b.narrative?.tickets.map((t) => [t.kind, t.title, t.defectId]),
      [
        ['app', 'PRB-EC-026 · sync the due date', 'd1'],
        ['test', 'PRB-EC-026 · cover notifications', undefined],
      ],
    );
    assert.equal(b.narrative?.questions[0]?.evidence, 'step 3');
  });

  it('a narrative moves no verdict: the effective status is the same with and without it', () => {
    const b = bundle();
    const before = effectiveStatus(b as ProofBundle);
    applyNarrative(b, ANSWER, 'm', 'en');
    assert.equal(effectiveStatus(b as ProofBundle), before);
  });

  it('clips every field and caps the lists', () => {
    const b = bundle();
    const long = 'x'.repeat(NARRATIVE_MAX_CHARS * 2);
    b.defects = Array.from({ length: NARRATIVE_MAX_TICKETS + 3 }, (_, i) => ({ ...b.defects[0]!, id: `d${i}` }));
    const tickets = Array.from({ length: NARRATIVE_MAX_TICKETS + 3 }, (_, i) => ({ kind: 'app' as const, title: `t${i}`, detail: long, owner: 'Dev', defectId: `d${i}` }));
    applyNarrative(b, { ...ANSWER, lede: long, tickets }, 'm', 'en');
    assert.equal(b.narrative?.lede.length, NARRATIVE_MAX_CHARS);
    assert.equal(b.narrative?.tickets.length, NARRATIVE_MAX_TICKETS);
    // A ticket's detail is held to the page's own budget, not the lede's.
    assert.equal(b.narrative?.tickets[0]?.detail.length, NARRATIVE_HARD_CHARS);
  });

  /*
   * The pre-read table's three cells. Measured on the live
   * ec-spot3 PRB-EC-053 page: `summary` was one ~700-character Thai sentence
   * chaining the whole run and `testData` a comma-run of every recorded value,
   * both inside one table cell.
   */
  describe('the cell bound on summary and testData', () => {
    const LIVE_SUMMARY =
      'การรันเปิดแอป แล้วลงชื่อเข้าใช้ด้วย persona MANAGER_ACCOUNT จากนั้นขั้นตอน workflow ที่ต้องเปิดคิวทดลองงานและบันทึกผลกลับ ERROR เพราะเอเจนต์รายงานว่าหน้า sign-in ต้องใช้รหัสผ่านซึ่งไม่มีใน task context ' +
      'ต่อมาลงชื่อเข้าใช้ด้วย persona HRBP_ACCOUNT บนเบราว์เซอร์ใหม่ แต่ขั้นตอน workflow อนุมัติรายการ txn 53 ก็ ERROR เพราะเอเจนต์ออกจากหน้าเริ่มต้น /humi/en/me/home ไป 8 เทิร์นและจบที่ /humi/en/hr/approvals/probation/53 ' +
      'ในการตรวจสอบ พบข้อความ txn 53, "Pass probation (normal)" แต่ไม่พบ "2026-10-08", "PASS_NORMAL"';

    it('clips a run-chaining summary and a comma-run of values to the cell bound', () => {
      const b = bundle();
      const testData = Array.from({ length: 40 }, (_, i) => `field${i} = value${i}`).join(', ');
      applyNarrative(b, { ...ANSWER, summary: LIVE_SUMMARY, testData }, 'm', 'en');
      assert.ok((b.narrative?.summary.length ?? 0) <= NARRATIVE_MAX_CELL_CHARS);
      assert.ok((b.narrative?.testData.length ?? 0) <= NARRATIVE_MAX_CELL_CHARS);
      assert.ok(NARRATIVE_MAX_CELL_CHARS < NARRATIVE_MAX_CHARS);
    });

    it('a summary and a test-data cell within the bound are left exactly as written', () => {
      const b = bundle();
      applyNarrative(b, ANSWER, 'm', 'en');
      assert.equal(b.narrative?.summary, ANSWER.summary);
      assert.equal(b.narrative?.testData, ANSWER.testData);
    });

    it('expected is NOT cut to the cell bound, and keeps the sheet\'s enumeration', () => {
      const enumerated = '1. ' + 'a'.repeat(NARRATIVE_MAX_CELL_CHARS) + '\n2. ' + 'b'.repeat(40);
      const b = bundle();
      applyNarrative(b, { ...ANSWER, expected: enumerated }, 'm', 'en');
      assert.equal(b.narrative?.expected, enumerated);
      assert.ok(b.narrative!.expected.includes('\n2. '));
    });

    it('cuts at the last boundary the text itself carries, so a claim ends rather than halves', () => {
      const sentences = 'The run signed in as MANAGER_ACCOUNT. The approval step errored. A third sentence that runs past the bound and would otherwise be halved mid-claim by a plain character clip.';
      const cut = clipCell(sentences, 80);
      assert.equal(cut, 'The run signed in as MANAGER_ACCOUNT. The approval step errored.…');
      // A list separator when there is no sentence end, and a space when there is neither.
      assert.equal(clipCell('a = 1, b = 2, c = 3, dddddddddddddddddddd = 4', 30), 'a = 1, b = 2, c = 3,…');
      assert.equal(clipCell('aaaa bbbb cccc dddddddddddddddddddd', 20), 'aaaa bbbb cccc…');
      // Nothing to cut at: the plain character clip is the honest answer.
      assert.equal(clipCell('x'.repeat(40), 20).length, 20);
    });
  });

  it('an empty answer leaves the bundle exactly as it was', () => {
    const b = bundle();
    const empty: NarrativeAnswer = { lede: '', summary: '', testData: '', expected: '', tickets: [], verifierNote: '', questions: [] };
    assert.equal(applyNarrative(b, empty, 'm', 'en'), false);
    assert.equal(b.narrative, undefined);
  });

  it('a narrative is needed when there is none, or when the language changed', () => {
    const b = bundle();
    assert.equal(needsNarrative(b, 'en'), true);
    applyNarrative(b, ANSWER, 'm', 'en');
    assert.equal(needsNarrative(b, 'en'), false);
    assert.equal(needsNarrative(b, 'th'), true);
  });
});

describe('what the model is asked for', () => {
  /* The bound is stated to the model, not only enforced after it: a clipped field is a cut sentence. */
  async function ask(): Promise<{ system: string; schema: string }> {
    let seen: { system: string; schema: string } | null = null;
    const model = new MockLanguageModelV4({
      provider: 'mock',
      modelId: 'capture',
      doGenerate: async (options: Record<string, unknown>) => {
        const messages = options['prompt'] as { role: string; content: unknown }[];
        seen = {
          system: messages.filter((m) => m.role === 'system').map((m) => JSON.stringify(m.content)).join('\n'),
          schema: JSON.stringify(options['responseFormat'] ?? {}),
        };
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(ANSWER) }],
          finishReason: { unified: 'stop' as const, raw: 'stop' },
          usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 5, text: 5, reasoning: 0 },
          },
          warnings: [],
        };
      },
    });
    await new LlmCaseNarrativeModel({ model: model as unknown as LanguageModel, id: 'mock:capture' }).compose(
      narrativeRequest(bundle(), 'Extend twice, then pass', 'th'),
    );
    assert.ok(seen !== null);
    return seen!;
  }

  it('states the cell bound for summary and testData, in the prompt and in the schema', async () => {
    const { system, schema } = await ask();
    assert.ok(system.includes(String(NARRATIVE_MAX_CELL_CHARS)));
    assert.match(system, /one or two short sentences/i);
    assert.ok(schema.includes(String(NARRATIVE_MAX_CELL_CHARS)));
    assert.match(schema, /not every value recorded/i);
  });

  it('asks for the Expected enumeration to be kept, and exempts it from the no-list rule', async () => {
    const { system, schema } = await ask();
    assert.match(schema, /KEEP the enumeration/);
    assert.match(system, /`expected`, which keeps/);
    assert.match(system, /the sheet's own numbering/);
  });

  it("states that the note summarises NOTES, in order, within its word bound", async () => {
    const { system, schema } = await ask();
    assert.ok(system.includes(`${NARRATIVE_NOTE_MAX_WORDS} words`));
    assert.match(system, /the NOTES block below, summarised/);
    assert.match(system, /system error and the fix it suggests, then interference/);
    assert.ok(schema.includes(`${NARRATIVE_NOTE_MAX_WORDS} words`));
    assert.match(schema, /SUMMARY OF THE NOTES block/);
  });

  it('says a shorter field may not become a vaguer one', async () => {
    const { system } = await ask();
    assert.match(system, /Shorter is not vaguer/);
  });
});

describe('composeNarrative', () => {
  it('drives the structured path through a mock model, in one call, and lands the narrative', async () => {
    const model = new LlmCaseNarrativeModel({ model: jsonModel('mock', ANSWER, { inputTokens: 900, outputTokens: 300 }), id: 'mock:narrator' });
    const b = bundle();
    assert.equal(await composeNarrative(b, 'Extend twice, then pass', { model, lang: 'en' }), true);
    assert.equal(b.narrative?.summary, ANSWER.summary);
    assert.equal(b.narrative?.by, 'mock:narrator');
  });

  it('is a no-op on a bundle already narrated in that language — a rebuild costs nothing twice', async () => {
    const model: CaseNarrativeModel = { id: 'never', compose: async () => assert.fail('should not have been called') };
    const b = bundle();
    applyNarrative(b, ANSWER, 'm', 'en');
    assert.equal(await composeNarrative(b, 'x', { model, lang: 'en' }), false);
  });

  it('leaves the bundle as it was when the model fails, and says so', async () => {
    const logged: string[] = [];
    const model: CaseNarrativeModel = { id: 'broken', compose: async () => { throw new Error('429 rate limited\nretry later'); } };
    const b = bundle();
    assert.equal(await composeNarrative(b, 'x', { model, lang: 'en', log: (l) => logged.push(l) }), false);
    assert.equal(b.narrative, undefined);
    assert.match(logged.join('\n'), /narrative skipped for PRB-EC-026: 429 rate limited/);
  });
});

describe('the three written surfaces are held to a budget', () => {
  const answer = (over: Partial<NarrativeAnswer>) => ({ ...ANSWER, ...over }) as NarrativeAnswer;

  it('says nothing about an answer already inside its budget — the common case must cost nothing', () => {
    const note = Array.from({ length: NARRATIVE_NOTE_MAX_WORDS }, (_, i) => `word${i}`).join(' ');
    assert.deepEqual(overSoftCap(answer({ verifierNote: note })), []);
  });

  it('names the coverage note and each over-long ticket, with its length', () => {
    const over = overSoftCap(
      answer({
        verifierNote: Array.from({ length: NARRATIVE_NOTE_MAX_WORDS + 30 }, (_, i) => `word${i}`).join(' '),
        tickets: [
          { kind: 'app', title: 't0', detail: 'short', owner: 'Dev' },
          { kind: 'app', title: 't1', detail: 'y'.repeat(400), owner: 'Dev' },
        ],
      }),
    );
    assert.equal(over.length, 2);
    assert.match(over[0]!, /^verifierNote \(100 words\)$/);
    assert.match(over[1]!, /^tickets\[1\]\.detail \(400 characters\)$/);
  });

  it('the re-ask names the fields and every number, and protects the rest', () => {
    const ask = shortenAsk(['verifierNote (140 words)', 'tickets[0].detail (400 characters)']);
    assert.match(ask, /verifierNote \(140 words\)/);
    assert.match(ask, new RegExp(`${NARRATIVE_NOTE_MAX_WORDS} words`));
    assert.match(ask, new RegExp(String(NARRATIVE_SOFT_CHARS)));
    assert.match(ask, new RegExp(String(NARRATIVE_HARD_CHARS)));
    assert.match(ask, /Every other field stays exactly as you wrote it/);
  });

  it('keeps the shorter of the two answers, field by field', () => {
    const first = answer({ verifierNote: 'x'.repeat(300), tickets: [{ kind: 'app', title: 't', detail: 'y'.repeat(300), owner: 'Dev' }] });
    const second = answer({ verifierNote: 'x'.repeat(120), tickets: [{ kind: 'app', title: 't', detail: 'y'.repeat(90), owner: 'Dev' }] });
    const kept = keepShorter(first, second);
    assert.equal(kept.verifierNote.length, 120);
    assert.equal(kept.tickets?.[0]?.detail.length, 90);
  });

  it('a re-ask that came back LONGER changes nothing — asking again may never make the page worse', () => {
    const first = answer({ verifierNote: 'x'.repeat(220) });
    const kept = keepShorter(first, answer({ verifierNote: 'x'.repeat(900) }));
    assert.equal(kept.verifierNote.length, 220);
  });

  it('an empty re-ask keeps the first answer rather than blanking the field', () => {
    const first = answer({ verifierNote: 'x'.repeat(220) });
    assert.equal(keepShorter(first, answer({ verifierNote: '   ' })).verifierNote.length, 220);
  });

  it('leaves every field the cap does not govern to the FIRST answer', () => {
    const first = answer({ verifierNote: 'x'.repeat(300), lede: 'the first lede' });
    const kept = keepShorter(first, answer({ verifierNote: 'x'.repeat(10), lede: 'a rewritten lede' }));
    assert.equal(kept.lede, 'the first lede');
  });

  it("what survives the re-ask is still cut at the note's own bound", () => {
    const b = bundle();
    applyNarrative(b, { ...ANSWER, verifierNote: 'word. '.repeat(200) }, 'm', 'en');
    assert.ok(noteWords(b.narrative?.verifierNote) <= NARRATIVE_NOTE_MAX_WORDS);
    // A sentence-boundary cut, not a mid-word one.
    assert.match(String(b.narrative?.verifierNote), /(\.|…)$/);
  });
});

/*
 * The note is the ONLY place `bundle.notes` reaches the reader — the page does
 * not print the notes beside it — so the bound is what makes it readable and
 * the measure is what makes the bound mean the same thing in both report
 * languages.
 */
describe('the verifier\'s note is a 70-word summary of the run\'s notes', () => {
  const answer = (over: Partial<NarrativeAnswer>) => ({ ...ANSWER, ...over }) as NarrativeAnswer;
  const english = (words: number) => Array.from({ length: words }, (_, i) => `word${i}`).join(' ') + '.';
  // One Thai clause, no space inside it: the shape a `split(/\s+/)` count reads as one word.
  const thai = (times: number) => 'ระบบแสดงข้อความแจ้งเตือนว่าไม่พบข้อมูลพนักงานที่ระบุ'.repeat(times);

  it('an English note over 70 words earns the one re-ask, and one inside it does not', () => {
    assert.deepEqual(overSoftCap(answer({ verifierNote: english(NARRATIVE_NOTE_MAX_WORDS) })), []);
    assert.deepEqual(overSoftCap(answer({ verifierNote: english(NARRATIVE_NOTE_MAX_WORDS + 1) })), ['verifierNote (71 words)']);
  });

  it('a note still over-long after the re-ask is cut at a boundary, never mid-word', () => {
    const note = Array.from({ length: 40 }, (_, i) => `Sentence ${i} said something the reader needs.`).join(' ');
    const cut = clipNote(note);
    assert.ok(noteWords(cut) <= NARRATIVE_NOTE_MAX_WORDS);
    assert.match(cut, /needs\.…$/);
    assert.ok(note.startsWith(cut.replace(/…$/, '')));
  });

  it('Thai is measured in characters at the same paragraph length, not as one word', () => {
    // A naive whitespace count calls this ONE word; the measure must not.
    assert.ok(noteWords(thai(12)) > NARRATIVE_NOTE_MAX_WORDS);
    const cut = clipNote(thai(12));
    assert.ok(noteWords(cut) <= NARRATIVE_NOTE_MAX_WORDS);
    // ~4.5 code points per Thai word, so 70 words is ~315 characters — a paragraph, not a truncation.
    assert.ok(cut.length > 250 && cut.length <= 330, `Thai note cut to ${cut.length} characters`);
  });

  it('a Thai note inside the bound is stored exactly as written', () => {
    const note = thai(5);
    assert.ok(noteWords(note) < NARRATIVE_NOTE_MAX_WORDS);
    assert.equal(clipNote(note), note);
  });

  it('English quoted inside a Thai note is counted as the words it is', () => {
    assert.equal(noteWords('Sign-in POST /api/auth/local-login 200'), noteWords('Sign-in POST /api/auth/local-login 200 '));
    assert.ok(noteWords(`${thai(3)} "Benefit Plans" ${thai(3)}`) > noteWords(thai(6)));
  });

  it('an empty notes list still yields an empty note, and nothing is asked again', () => {
    const b = bundle();
    b.notes = [];
    assert.equal(narrativeRequest(b, 'x', 'en').notes.length, 0);
    assert.deepEqual(overSoftCap(answer({ verifierNote: '' })), []);
    applyNarrative(b, { ...ANSWER, verifierNote: '' }, 'm', 'en');
    assert.equal(b.narrative?.verifierNote, '');
  });
});
