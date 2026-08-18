/**
 * Which of a set of texts a question is about — lexically, deterministically,
 * and with no model anywhere near it.
 *
 * Two callers, and they are why this is its own module rather than a private
 * helper of either: `catalog/retrieve.ts` ranks the chunks of a background
 * document against the case being authored, and `context/query.ts` ranks a
 * repository's routes against the journey a person described. Same question —
 * *of these, which bear on that* — so it should be one implementation, and the
 * one that fixes an idf or a tokenising trap should fix it for both.
 *
 * It lives under `src/context/` because that is this codebase's layer for
 * knowing things about a project without asking a model, and because a
 * dependency the other way — the project index reaching into the document
 * catalog — would be backwards.
 */

/**
 * Characters indexed as n-grams instead of as words.
 *
 * Thai has no spaces: a whitespace tokeniser turns a Thai section into one
 * token, and retrieval returns nothing for it however well it matches. This
 * codebase already has Thai in its failure history (PB-05-01,
 * `scriptMismatchNote`), so it is a live case. Same for Han, Kana, Khmer, Lao
 * and Burmese. The n-grams go into both the corpus and the query, so the two
 * meet whether or not either was ever split into words.
 */
const SCRIPTLESS = /[\p{Script=Thai}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Khmer}\p{Script=Lao}\p{Script=Myanmar}]/u;
const NGRAM_SIZE = 3;

/** Word runs, keeping `PB-05-01` and `order_id` whole for the first pass. */
const WORD = /[\p{L}\p{N}]+(?:[-_/.][\p{L}\p{N}]+)*/gu;

/** A query longer than this is a document, and its tail adds nothing. */
export const MAX_QUERY_TERMS = 200;

/** Okapi BM25's usual constants. */
const K1 = 1.5;
const B = 0.75;

/**
 * Text to terms.
 *
 * An identifier is emitted **whole and in parts** — `PB-05-01` is the highest
 * signal token a requirements document contains, and it has to be findable both
 * by itself and by the scenario prefix someone typed. The same split is what
 * lets a described journey ("create overtime request") meet a route named
 * `/:locale/overtime` and a file called `OvertimeScreen.tsx`.
 */
export function tokenize(text: string): string[] {
  const terms: string[] = [];
  for (const match of text.toLowerCase().matchAll(WORD)) {
    const whole = match[0];
    terms.push(whole);
    if (/[-_/.]/.test(whole)) {
      for (const part of whole.split(/[-_/.]/)) if (part !== '') terms.push(part);
    }
  }
  const out: string[] = [];
  for (const term of terms) {
    out.push(term);
    if (SCRIPTLESS.test(term) && term.length >= NGRAM_SIZE) {
      for (let i = 0; i + NGRAM_SIZE <= term.length; i += 1) {
        out.push(term.slice(i, i + NGRAM_SIZE));
      }
    }
  }
  return out;
}

/** The query's terms, deduplicated in order and capped. */
export function queryTerms(query: string): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const term of tokenize(query)) {
    if (seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
    if (terms.length >= MAX_QUERY_TERMS) break;
  }
  return terms;
}

/**
 * Okapi BM25 score per document, in the order they were given.
 *
 * The IDF is the **smoothed** form, `ln(1 + (N - n + 0.5)/(n + 0.5))`. The
 * textbook one goes negative for a term appearing in more than half the
 * documents, which on a small corpus means a document scores *worse* for
 * containing a query term — a result that reads like a bug and behaves like
 * one. There is no stopword list for the same reason there is no stemmer: IDF
 * already discounts a term that is everywhere, and both lists would be
 * maintained in English against a corpus that is frequently not.
 */
export function bm25(documents: readonly string[], query: string): number[] {
  const terms = queryTerms(query);
  const frequencies = documents.map((text) => {
    const counts = new Map<string, number>();
    for (const term of tokenize(text)) counts.set(term, (counts.get(term) ?? 0) + 1);
    return counts;
  });
  const lengths = frequencies.map((counts) => {
    let total = 0;
    for (const count of counts.values()) total += count;
    return total;
  });
  const total = documents.length;
  const averageLength = total === 0 ? 0 : lengths.reduce((sum, length) => sum + length, 0) / total;

  const documentFrequency = new Map<string, number>();
  for (const term of terms) {
    let n = 0;
    for (const counts of frequencies) if (counts.has(term)) n += 1;
    documentFrequency.set(term, n);
  }

  return documents.map((_, i) => {
    let score = 0;
    const counts = frequencies[i] ?? new Map<string, number>();
    const length = lengths[i] ?? 0;
    for (const term of terms) {
      const frequency = counts.get(term);
      if (frequency === undefined) continue;
      const n = documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (total - n + 0.5) / (n + 0.5));
      const denominator =
        frequency + K1 * (1 - B + (B * length) / (averageLength === 0 ? 1 : averageLength));
      score += idf * ((frequency * (K1 + 1)) / denominator);
    }
    return score;
  });
}
