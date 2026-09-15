/**
 * The pluggable retrieval seam — one place every "which part of this evidence
 * does the model actually need?" decision goes through.
 *
 * wowlidator already retrieves in three places, all lexical BM25 over
 * `src/context/relevance.ts` (context documents in `catalog/retrieve.ts`,
 * the table inventory and route ranking in authoring): measured, 94% less
 * background per row and 386 tables cut to 9. This module is the same
 * instrument behind an interface, so the two things that will change can
 * change independently:
 *
 * - **What is narrowed** — call sites (healer tree, author journey tree, the
 *   agent's context card) take the helpers here rather than scoring inline.
 * - **How it is ranked** — `Retriever` is the seam an embedding-based ranker
 *   plugs into later (the `HealerModel`/`AgentModel` pattern applied to
 *   retrieval: call sites hold the interface, never a scorer). `rank()` is
 *   async for exactly that reason — an embedding call is a request, BM25 just
 *   answers immediately.
 *
 * The rules the existing retrieval established carry over and are enforced
 * here, not re-decided per caller:
 *
 * - **Under the budget nothing happens.** Narrowing evidence that already
 *   fits only loses information and adds a notice (the `retrieve.ts` rule).
 * - **Document order is restored after ranking**, so a tree still reads as
 *   the page and a document still reads as itself.
 * - **A cut is disclosed, and worded so absence proves nothing** — retrieval's
 *   characteristic failure is silent partial recall, and a reader (model or
 *   human) must never conclude "not listed" means "not there".
 */

import { bm25 } from './relevance.js';

export interface RetrievalItem {
  id: string;
  text: string;
}

export interface RetrievedItem extends RetrievalItem {
  score: number;
}

/**
 * Ranks items against a query and returns the best `limit`, most relevant
 * first. Implementations must be deterministic for identical inputs — the
 * whole prompt-discipline layer (same evidence, same answer) sits on top of
 * what this returns.
 */
export interface Retriever {
  readonly id: string;
  rank(query: string, items: readonly RetrievalItem[], limit: number): Promise<RetrievedItem[]>;
}

/** The default: the same BM25 the catalog and table retrieval already use. */
export class Bm25Retriever implements Retriever {
  readonly id = 'bm25';

  rank(query: string, items: readonly RetrievalItem[], limit: number): Promise<RetrievedItem[]> {
    const scores = bm25(
      items.map((item) => item.text),
      query,
    );
    const order = items
      .map((item, index) => ({ ...item, score: scores[index] ?? 0, index }))
      // Ties break earlier-in-the-evidence, the determinism rule's own wording.
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, Math.max(0, limit))
      .map(({ index: _index, ...item }) => item);
    return Promise.resolve(order);
  }
}

const RETRIEVERS: Record<string, () => Retriever> = {
  bm25: () => new Bm25Retriever(),
};

/**
 * The retriever the environment asks for (`WOWLIDATOR_RETRIEVER`), BM25 by
 * default. An unknown name fails here, at the boundary, with the valid values
 * named — never thirty seconds into a run.
 */
export function buildRetriever(kind = process.env['WOWLIDATOR_RETRIEVER']): Retriever {
  const chosen = kind === undefined || kind.trim() === '' ? 'bm25' : kind.trim().toLowerCase();
  const factory = RETRIEVERS[chosen];
  if (factory === undefined) {
    throw new Error(
      `WOWLIDATOR_RETRIEVER=${chosen} is not a retriever. Valid: ${Object.keys(RETRIEVERS).join(', ')}.`,
    );
  }
  return factory();
}

/**
 * Narrow a rendered accessibility tree (one formatted node per line) to the
 * lines that bear on `query`, keeping document order, with the cut disclosed.
 *
 * This is `focusTree` (the agent's goal-ranked node cut) for the callers that
 * hold the tree as TEXT — the healer's `HealRequest.axTree`, the author's
 * journey capture — where re-plumbing nodes through would touch every capture
 * call site for no gain. Synchronous and BM25-only on purpose: it runs inside
 * prompt builders that must stay deterministic and instant; a future
 * embedding retriever narrows at the async call sites that hold a
 * `Retriever`, not here.
 *
 * `keepHead` lines are always kept verbatim at the top — a journey tree's own
 * label line is evidence about which page the tree describes, and ranking it
 * away would re-create exactly the mislabelling the label exists to prevent.
 */
/** Indent level of a rendered tree line — two spaces per level of containment. */
function indentOf(line: string): number {
  return Math.floor((/^ */.exec(line)?.[0].length ?? 0) / 2);
}

/**
 * The lines a tree line is indented under, outermost first.
 *
 * The text-space twin of `ancestorIndexes` in the healer: scanning back, the
 * first line shallower than this one is its container. Flat text has none.
 */
function ancestorLines(body: readonly string[], index: number): number[] {
  const chain: number[] = [];
  let want = indentOf(body[index] as string) - 1;
  for (let i = index - 1; i >= 0 && want >= 0; i -= 1) {
    const depth = indentOf(body[i] as string);
    if (depth <= want) {
      chain.push(i);
      want = depth - 1;
    }
  }
  return chain.reverse();
}

export function focusTreeText(
  tree: string,
  query: string,
  maxLines: number,
  keepHead = 0,
): { text: string; kept: number; total: number } {
  const all = tree.split('\n');
  const head = all.slice(0, keepHead);
  const body = all.slice(keepHead).filter((line) => line.trim() !== '');
  if (body.length <= maxLines) return { text: tree, kept: body.length, total: body.length };

  const scores = bm25(body, query);
  const ranked = body
    .map((_, index) => index)
    .sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0) || a - b);

  // A ranked line arrives with the lines it is INDENTED UNDER. A rendered AX
  // tree carries containment in its indentation (`formatAxTree`), and BM25
  // ranks one line at a time: keeping `button "Delete"` while ranking away the
  // row it belongs to would leave it indented under an unrelated line, which
  // is the one reading a scoped selector is written from. The closure is a
  // no-op on flat text — every line is at indent 0, so nothing has ancestors
  // and the selection is exactly the top-`maxLines` it always was.
  const kept = new Set<number>();
  for (const index of ranked) {
    if (kept.size >= maxLines) break;
    if (kept.has(index)) continue;
    const missing = ancestorLines(body, index).filter((i) => !kept.has(i));
    if (kept.size + missing.length + 1 > maxLines) continue;
    for (const i of missing) kept.add(i);
    kept.add(index);
  }
  // Document order restored — the tree still reads as the page.
  const keptIndexes = [...kept].sort((a, b) => a - b);

  const lines = [
    ...head,
    ...keptIndexes.map((index) => body[index] as string),
    `[TREE NARROWED: showing ${keptIndexes.length} of ${body.length} nodes, the ones closest to ` +
      `the intent kept. Controls may exist that are not listed — never conclude an element is ` +
      `absent from this list alone; if nothing shown serves the intent, say so rather than guessing.]`,
  ];
  return { text: lines.join('\n'), kept: keptIndexes.length, total: body.length };
}
