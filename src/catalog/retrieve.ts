/**
 * Choosing the part of a background document that bears on the case being
 * written.
 *
 * `--context-doc` is background the model may read to understand a term
 * (`catalog.ts`, `buildClaimsPrompt`). Until this module it was sent whole,
 * every time it was sent — and the catalog path sends it **once per table
 * row**, because `authorEachRow` authors each row on its own against one open
 * page. A twelve-row sheet with one 120,000-character spec spent roughly 360k
 * input tokens on background, eleven-twelfths of it about rows that call was
 * not writing.
 *
 * ## Why BM25 and not embeddings
 *
 * The query here is the row's own steps and expectations, and the claims
 * prompt already instructs "use the document's own words" — so query and
 * corpus share vocabulary by construction and lexical matching is doing the
 * job a semantic model would be paid for. An embedding index would also make
 * an *indexing* step call a model, which is the line `src/context/` is built
 * on: indexing is not reasoning. So this is arithmetic over strings, no
 * dependency, no key, no network — execution-plane, like `extract.ts` beside
 * it.
 *
 * ## The rule that outranks the ranking
 *
 * **A partial document must never be mistaken for a whole one.** Retrieval's
 * characteristic failure is silent partial recall: a section that was not
 * selected reads exactly like a section that does not exist, and a model that
 * concludes the second writes a confident claim about nothing. Three things
 * hold that line, and none of them is optional:
 *
 * - the **spine** — the document's complete heading outline — is sent whatever
 *   the budget, so what was elided is visible rather than inferable;
 * - an elision notice says so in words, worded after `captureAxTree`'s
 *   ("do NOT conclude anything is missing"), because that is already the rule;
 * - a document small enough to fit is passed through **byte-for-byte**, and a
 *   document nothing matched keeps its spine rather than vanishing.
 *
 * And containment degrades the *other* way from history and coverage: anything
 * that throws in here returns the documents whole. Those two are diagnostic, so
 * failing to nothing is right; this one is an optimisation, so the safe
 * direction is more context, not less.
 *
 * What this must never be pointed at: the catalog document itself, `draft`'s
 * source documents, or the AX tree. The first two are enumeration problems —
 * you cannot retrieve a claim you do not yet know exists — and a miss there
 * drops a requirement while the run still reports green.
 */

import { bm25, queryTerms, tokenize } from '../context/relevance.js';
import type { ExtractedDocument } from './extract.js';

// Re-exported because this module was the tokeniser's first home and is still
// where a reader looks for it; the implementation moved when the graph
// projection needed the same ranking. One idf, one tokeniser, two callers.
export { tokenize };

/** Below this a document is sent whole: selection can only lose, never gain. */
export const CONTEXT_RETRIEVAL_MIN_CHARS = 8_000;

/**
 * Characters of background per prompt. `--context-budget 0` sends every
 * context document whole.
 *
 * On by default since 2026-08-21. It shipped off (this decides what every
 * authoring prompt sees, the `--probe` / `--agent-assist` argument), and the
 * measured cost of off was the thing people actually hit: a ten-row sheet
 * with two spreadsheets remembered on the repository (1,014,914 + 78,752
 * characters) spent ~50,000 input tokens of background on EVERY authoring
 * call — the whole "30k tokens per request" — about rows that call was not
 * writing. With the five rails below in place, the same rows retrieve to
 * 15–25k characters (~4–6k tokens), each quoting its own sections. The
 * documents are still sent whole when they fit, when the query cannot tell
 * the sections apart, or when anything inside here throws.
 */
export const CONTEXT_BUDGET_CHARS = 24_000;

/**
 * A chunk must score at least this much of the best chunk's score to be
 * quoted. Filling the budget with whatever ranked next is how a prompt ends up
 * carrying nine sections about other rows and calling it relevance.
 */
export const RELATIVE_SCORE_FLOOR = 0.35;

/**
 * How much the best chunk must beat the average before selection is trusted.
 *
 * Measured on a spec whose sections all share their vocabulary: every chunk
 * scored 0.06, the tie broke on document order, and the "selected" sections
 * were sections 1–7 — positional truncation wearing a relevance badge, which
 * is worse than positional truncation because a reader believes it. Below this
 * ratio the query does not distinguish the document's sections, and the honest
 * answer is to send the document as it is.
 */
export const DISCRIMINATION_MIN = 1.5;

/** What a chunk aims for, and the hard cap it is split at. */
export const CHUNK_TARGET_CHARS = 1_200;
export const CHUNK_MAX_CHARS = 2_400;

/**
 * Extraction cap for a context document when a budget will select from it.
 * `DEFAULT_MAX_CHARS` truncates *positionally* — "the first 120,000 of N" —
 * so a longer spec's last sections are unreachable by every consumer. Once
 * relevance decides what is sent, position no longer has to.
 */
export const CONTEXT_DOC_MAX_CHARS = 1_000_000;

/** Siblings pulled in after a hit, because a definition runs past a break. */
export const CONTEXT_NEIGHBOUR_BLEED = 1;

/** Outline lines before the outline itself is truncated (and says so). */
export const MAX_SPINE_LINES = 120;

// --- Chunking --------------------------------------------------------------

export interface ContextChunk {
  /** Which document it came from, for attribution. */
  doc: string;
  /** "Sessions > Timeout". A chunk that cannot say where it is from is not evidence. */
  headingPath: string;
  /** Position in the document, for restoring order and finding neighbours. */
  index: number;
  text: string;
}

interface Heading {
  level: number;
  title: string;
}

/**
 * Is this line a heading, and at what depth?
 *
 * **Markdown's `#` and nothing else**, including the `## row N` and
 * `## Sheet` blocks `extract.ts` emits itself. The first cut also read a
 * numbered line ("3.2 Session timeout") as a section, guarded on length and a
 * trailing full stop — and that guard was worthless: an ordinary procedure
 * ("1. Open the probation hub") satisfies it exactly. A heading's own line is
 * carried as `headingPath` and never as body, so every step of every numbered
 * list stopped existing: a six-step checklist chunked to **nothing at all**,
 * and what reached the model was an outline of its own steps with no content
 * under them. Found by running the chunker on the document shape a QA context
 * doc actually has.
 *
 * The rule this restores is the one the rest of the file already follows:
 * understate, never overstate. A numbered section heading left as body text
 * costs a little chunk coherence; a numbered step *read* as a heading costs
 * the document.
 */
function headingOf(line: string): Heading | null {
  const hash = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line);
  if (hash) return { level: hash[1]?.length ?? 1, title: (hash[2] ?? '').trim() };
  return null;
}

/** Lines that look like one table: three or more sharing a separator. */
function tableHeaders(lines: readonly string[]): (string | null)[] {
  const headers: (string | null)[] = new Array(lines.length).fill(null);
  for (const separator of ['|', '\t']) {
    let start = -1;
    const flush = (end: number): void => {
      if (start >= 0 && end - start >= 3) {
        for (let i = start + 1; i < end; i += 1) headers[i] = lines[start] ?? null;
      }
      start = -1;
    };
    for (let i = 0; i < lines.length; i += 1) {
      if ((lines[i] ?? '').includes(separator)) {
        if (start < 0) start = i;
      } else {
        flush(i);
      }
    }
    flush(lines.length);
  }
  return headers;
}

/**
 * A document as chunks that never straddle a heading.
 *
 * A chunk is flushed at a paragraph break once it reaches `CHUNK_TARGET_CHARS`,
 * and hard-flushed at `CHUNK_MAX_CHARS` — always on a **line** boundary, never
 * mid-line, the same rule that keeps a sparse spreadsheet row's column letters
 * in `extract.ts`. A chunk that continues a table repeats the table's header
 * row: a retrieved row without its column names means nothing.
 */
export function chunkDocument(doc: ExtractedDocument): ContextChunk[] {
  const lines = doc.text.split('\n');
  const headers = tableHeaders(lines);
  const chunks: ContextChunk[] = [];
  const stack: Heading[] = [];

  let buffer: string[] = [];
  let bufferChars = 0;
  let startLine = 0;

  const pathNow = (): string => stack.map((heading) => heading.title).join(' > ');

  const flush = (): void => {
    const body = buffer.join('\n').trim();
    buffer = [];
    bufferChars = 0;
    if (body === '') return;
    const header = headers[startLine];
    const text = header !== null && header !== undefined && !body.startsWith(header)
      ? `${header}\n${body}`
      : body;
    chunks.push({ doc: doc.name, headingPath: pathNow(), index: chunks.length, text });
  };

  for (const [lineNumber, line] of lines.entries()) {
    const heading = headingOf(line);
    if (heading !== null) {
      flush();
      while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= heading.level) stack.pop();
      stack.push(heading);
      startLine = lineNumber + 1;
      continue;
    }

    if (buffer.length === 0) startLine = lineNumber;
    buffer.push(line);
    bufferChars += line.length + 1;

    const paragraphBreak = line.trim() === '';
    if ((bufferChars >= CHUNK_TARGET_CHARS && paragraphBreak) || bufferChars >= CHUNK_MAX_CHARS) {
      flush();
    }
  }
  flush();

  return chunks;
}

// --- Ranking ---------------------------------------------------------------

export interface ScoredChunk {
  chunk: ContextChunk;
  score: number;
}

/**
 * Okapi BM25 over the chunks of every context document as one corpus, so
 * scores are comparable across documents while `chunk.doc` keeps attribution.
 *
 * The IDF is the **smoothed** form, `ln(1 + (N - n + 0.5)/(n + 0.5))`. The
 * textbook one goes negative for a term appearing in more than half the
 * chunks, which on a single small document means a chunk scores *worse* for
 * containing a query term — a result that reads like a bug and behaves like
 * one. There is no stopword list for the same reason there is no stemmer: IDF
 * already discounts a term that is everywhere, and both lists would be
 * maintained in English against a corpus that is frequently not.
 */
export function rankChunks(chunks: readonly ContextChunk[], query: string): ScoredChunk[] {
  if (queryTerms(query).length === 0) return chunks.map((chunk) => ({ chunk, score: 0 }));
  const scores = bm25(chunks.map((chunk) => chunk.text), query);

  // Ties break by document order, never by iteration order: the same inputs
  // must build the same prompt twice, for the reason `temperature: 0` exists.
  return chunks
    .map((chunk, i) => ({ chunk, score: scores[i] ?? 0 }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.chunk.doc.localeCompare(b.chunk.doc) ||
        a.chunk.index - b.chunk.index,
    );
}

// --- Selection and rendering ----------------------------------------------

export interface ContextSelection {
  /** Same shape in, same shape out — the prompt builders do not change. */
  documents: ExtractedDocument[];
  /** One line for the caller to print. Empty when nothing was selected away. */
  note: string;
  /** Chunks kept, and chunks considered. */
  selected: number;
  total: number;
  /**
   * What the result costs, in characters. `-1` when selection did not run —
   * the documents are exactly as they arrived, and counting them would mean
   * reading text this is also the catch path for.
   */
  chars: number;
  /** False when nothing was left out: every document is as it arrived. */
  retrieved: boolean;
}

export interface SelectOptions {
  /** Characters of background allowed. `0` disables selection entirely. */
  budgetChars?: number | undefined;
  /** Reported failures, so a caller can put them in front of a person. */
  onWarn?: ((line: string) => void) | undefined;
}

function spineOf(chunks: readonly ContextChunk[]): string[] {
  const lines: string[] = [];
  let last = '';
  for (const chunk of chunks) {
    if (chunk.headingPath === '' || chunk.headingPath === last) continue;
    last = chunk.headingPath;
    const depth = chunk.headingPath.split(' > ').length - 1;
    const title = chunk.headingPath.split(' > ').at(-1) ?? '';
    lines.push(`${'  '.repeat(depth)}${title}`);
  }
  return lines;
}

/** The selected chunks of one document, in document order, with its outline. */
function render(doc: ExtractedDocument, all: readonly ContextChunk[], kept: readonly ContextChunk[]): string {
  const parts: string[] = [];
  const spine = spineOf(all);
  if (spine.length > 0) {
    const shown = spine.slice(0, MAX_SPINE_LINES);
    parts.push(
      `[Outline of ${doc.name} — every section, so nothing below is mistaken for the whole document:]\n` +
        shown.map((line) => `  ${line}`).join('\n') +
        (spine.length > shown.length
          ? `\n  (+${spine.length - shown.length} more section(s), not listed)`
          : ''),
    );
  }

  parts.push(
    kept.length === 0
      ? `[None of ${doc.name}'s ${all.length} sections matched this case, so none is quoted below. ` +
          'The document still says what its outline says — do NOT conclude it is silent on anything.]'
      : `[${kept.length} of ${all.length} sections are included below, selected by relevance to this case. ` +
          'The sections not shown still exist — do NOT conclude the document is silent on anything.]',
  );

  let lastPath: string | null = null;
  let lastIndex = -2;
  for (const chunk of kept) {
    if (chunk.index !== lastIndex + 1 && lastIndex >= 0) parts.push('[…]');
    if (chunk.headingPath !== lastPath && chunk.headingPath !== '') parts.push(`## ${chunk.headingPath}`);
    parts.push(chunk.text);
    lastPath = chunk.headingPath;
    lastIndex = chunk.index;
  }

  return parts.join('\n\n');
}

function joinNotes(...notes: string[]): string {
  return notes.filter((note) => note !== '').join('; ');
}

/**
 * The supporting documents, cut to the part that bears on `query`.
 *
 * Order of business, and each step is a rail rather than a tuning knob:
 *
 * 1. A document under `CONTEXT_RETRIEVAL_MIN_CHARS` passes through **whole**,
 *    and what it costs is taken off the budget so the total stays bounded.
 * 2. Every remaining document contributes its best matching chunk before any
 *    document contributes a second — two documents someone passed are two
 *    things they thought mattered, and a long one must not crowd out a
 *    glossary.
 * 3. The rest of the budget is filled greedily by score. A chunk scoring zero
 *    is never included even with room to spare: padding a prompt with
 *    irrelevant background is the cost this exists to remove.
 * 4. Selected chunks pull in `CONTEXT_NEIGHBOUR_BLEED` following siblings,
 *    budget permitting.
 * 5. Output is restored to **document order** before rendering. Order is
 *    meaning; a context section sorted by score reads as noise.
 *
 * Never throws. A failure returns the documents exactly as they arrived.
 */
/**
 * The external sources a test case CITES for its expected values — "as per
 * the Master Benefit List", "ตามเอกสาร Requirement", "refer to section 4.2".
 *
 * A row that points at another document for its value is the one row whose
 * own words are a WEAK retrieval query: the value lives in the cited source,
 * and the citation phrase is a few tokens drowned in step narration. The
 * authoring path extracts these phrases and boosts them in the BM25 query
 * (repetition raises term frequency — crude, deterministic, and enough to
 * pull the cited section to the top), so the expected value is quoted from
 * the source instead of invented. Pure text extraction, English and Thai
 * markers, deduplicated, capped so a runaway match cannot become the query.
 */
export function referencedSources(text: string): string[] {
  const found: string[] = [];
  const push = (phrase: string | undefined): void => {
    const cleaned = phrase?.trim().replace(/["'“”]+/g, '').replace(/\s+/g, ' ');
    if (cleaned !== undefined && cleaned.length >= 3 && cleaned.length <= 80) found.push(cleaned);
  };
  // A dot ends the phrase only when it ends a sentence — "section 4.2" and
  // "spec.pdf" keep theirs (`\.(?=\S)` accepts a dot glued to what follows).
  const PHRASE = String.raw`((?:[^.;:\n()]|\.(?=\S)){3,80})`;
  const english = new RegExp(
    String.raw`(?:refer(?:s|red)?\s+to|according\s+to|as\s+per|per\s+the|as\s+(?:defined|specified|stated|described)\s+in|(?:defined|specified|stated|described)\s+in|based\s+on|see)\s+` +
      PHRASE,
    'gi',
  );
  for (const match of text.matchAll(english)) push(match[1]);
  // Thai citation markers. `ตาม` alone is too common ("ตามเงื่อนไข" — "per the
  // condition") to be a citation by itself, so it only counts followed by a
  // document-ish noun; the explicit อ้างอิง (cite/reference) family always does.
  const thai = new RegExp(
    String.raw`(?:อ้างอิง(?:จาก|ตาม)?|อิงตาม|ดูจาก|ตาม\s*(?:เอกสาร|ไฟล์|สเปค|มาสเตอร์|รายการ|ตาราง|ข้อกำหนด|Requirement|Master|Spec|List)[^\s]*)\s*` +
      PHRASE,
    'gi',
  );
  for (const match of text.matchAll(thai)) push(match[1]);
  return [...new Set(found)].slice(0, 5);
}

export function selectRelevantContext(
  docs: readonly ExtractedDocument[],
  query: string,
  options: SelectOptions = {},
): ContextSelection {
  // Deliberately does not read `doc.text` — this is also the catch path, and
  // re-reading whatever just threw would rethrow it out of a function whose
  // whole contract is that it cannot fail.
  const unchanged = (note = ''): ContextSelection => ({
    documents: [...docs],
    note,
    selected: 0,
    total: 0,
    chars: -1,
    retrieved: false,
  });

  const budget = options.budgetChars ?? CONTEXT_BUDGET_CHARS;
  if (docs.length === 0 || budget <= 0 || query.trim() === '') return unchanged();

  try {
    // Only a document that would not fit anyway is a candidate. Under the
    // budget there is nothing to save and everything to lose — the outline and
    // the notice make the prompt bigger, and the model reads quoted fragments
    // where it used to read the author's own prose.
    const threshold = Math.max(budget, CONTEXT_RETRIEVAL_MIN_CHARS);
    const whole = docs.filter((doc) => doc.text.length <= threshold);
    const large = docs.filter((doc) => doc.text.length > threshold);
    if (large.length === 0) return unchanged();

    const wholeChars = whole.reduce((sum, doc) => sum + doc.text.length, 0);
    let remaining = Math.max(0, budget - wholeChars);

    const byDoc = new Map<string, ContextChunk[]>();
    const corpus: ContextChunk[] = [];
    for (const doc of large) {
      const chunks = chunkDocument(doc);
      byDoc.set(doc.name, chunks);
      corpus.push(...chunks);
    }

    const allScores = rankChunks(corpus, query);
    const best = allScores[0]?.score ?? 0;
    const mean =
      allScores.length === 0
        ? 0
        : allScores.reduce((sum, entry) => sum + entry.score, 0) / allScores.length;
    if (best <= 0 || mean <= 0 || best / mean < DISCRIMINATION_MIN) {
      // The query does not tell this document's sections apart, so any
      // selection would be document order with a relevance badge on it.
      return unchanged(
        `context: the query does not distinguish ${large.map((doc) => doc.name).join(', ')} — sending it whole`,
      );
    }
    const ranked = allScores.filter((entry) => entry.score >= best * RELATIVE_SCORE_FLOOR);
    const keptIds = new Set<string>();
    const idOf = (chunk: ContextChunk): string => `${chunk.doc}#${chunk.index}`;

    // `force` is what makes the floor a floor. A budget smaller than one
    // section would otherwise select nothing at all and hand the prompt an
    // outline with no content under it — a worse prompt than the whole
    // document this feature set out to improve on. The overrun is bounded by
    // one section per document and it is disclosed in the note, which is the
    // same trade the catch path makes: degrade toward more context, never less.
    const take = (chunk: ContextChunk, force = false): boolean => {
      const id = idOf(chunk);
      if (keptIds.has(id)) return false;
      if (!force && chunk.text.length > remaining) return false;
      keptIds.add(id);
      remaining -= chunk.text.length;
      return true;
    };

    // The floor: one chunk each, best first, before anyone gets a second.
    // Drawn from ALL scores, not the floor-filtered list — a document whose
    // best section scores under RELATIVE_SCORE_FLOOR of the GLOBAL best used
    // to quote nothing at all (seen live: two catalog documents, one lexically
    // dominant, the other reduced to a bare outline — "the AI only used one
    // document"). Every document that scored at all now quotes its own best
    // section; only a document nothing matched keeps its outline unquoted,
    // rather than being padded with noise.
    for (const doc of large) {
      const best = allScores.find((entry) => entry.chunk.doc === doc.name && entry.score > 0);
      if (best) take(best.chunk, true);
    }
    for (const entry of ranked) take(entry.chunk);

    for (const entry of [...keptIds]) {
      const [name, index] = [entry.slice(0, entry.lastIndexOf('#')), Number(entry.slice(entry.lastIndexOf('#') + 1))];
      const chunks = byDoc.get(name) ?? [];
      for (let step = 1; step <= CONTEXT_NEIGHBOUR_BLEED; step += 1) {
        const next = chunks[index + step];
        if (!next || next.headingPath !== chunks[index]?.headingPath) break;
        if (!take(next)) break;
      }
    }

    let selected = 0;
    let total = 0;
    let changed = false;
    const documents: ExtractedDocument[] = [];
    for (const doc of docs) {
      const chunks = byDoc.get(doc.name);
      if (chunks === undefined) {
        documents.push(doc);
        continue;
      }
      const kept = chunks.filter((chunk) => keptIds.has(idOf(chunk)));
      // Nothing was left out, so there is nothing to disclose — and the
      // outline and the notice would be pure overhead on a document that
      // already fitted. A document between `CONTEXT_RETRIEVAL_MIN_CHARS` and
      // the budget must come out no larger than it went in, or this feature
      // costs tokens in exactly the range where it saves none.
      if (kept.length === chunks.length) {
        documents.push(doc);
        selected += kept.length;
        total += chunks.length;
        continue;
      }
      selected += kept.length;
      total += chunks.length;
      changed = true;
      const text = render(doc, chunks, kept);
      documents.push({
        ...doc,
        text,
        note: joinNotes(
          doc.note,
          `relevance-selected: ${kept.length} of ${chunks.length} sections ` +
            `(${doc.text.length.toLocaleString('en-US')} → ${text.length.toLocaleString('en-US')} chars)`,
        ),
      });
    }

    const chars = documents.reduce((sum, doc) => sum + doc.text.length, 0);
    // "Nothing was left out" and "selection ran" are different facts, and only
    // the first one is worth a line in front of a person: a run that says it
    // selected 12 of 12 sections is a run that reports work it did not do.
    return {
      documents,
      note: changed
        ? `context: ${selected} of ${total} section(s) selected across ${large.length} document(s) (${chars.toLocaleString('en-US')} chars)`
        : '',
      selected,
      total,
      chars,
      retrieved: changed,
    };
  } catch (error) {
    // The other way round from history and coverage: those are diagnostic, so
    // failing to nothing is right. This is an optimisation, so it fails to
    // everything — losing the background entirely would be a worse prompt than
    // the one this feature set out to improve.
    const line = `context retrieval failed (${
      error instanceof Error ? error.message : String(error)
    }) — sending the documents whole`;
    options.onWarn?.(line);
    return unchanged(line);
  }
}
