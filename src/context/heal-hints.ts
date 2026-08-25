/**
 * BM25-retrieved context for the healer — spec R6 of
 * `docs/repo-context-memory-spec.md`, the last role that repaired blind.
 *
 * The author already reads both sources per row (`selectRelevantContext` in
 * `authorEachRow`, `toPromptContext` as `projectContext`); the healer read
 * neither, so a repair on a page the tree describes thinly (a control behind
 * a disclosure, a route the graph knows by name) had nothing but the tree.
 * Two sections, both **advisory framing only, never candidate material** —
 * the AX tree outranks everything here, every proposal still passes
 * `#verify`, and the boundaries of `context-doc-retrieval-spec.md` hold:
 * only *background* documents are retrieved over (never the catalog, never
 * the tree), and a throw degrades to no hint rather than no heal.
 *
 * Built once per suite (the graph and documents are already in memory on the
 * catalog path) and consulted per heal — both retrievals are in-memory BM25
 * scans, microseconds against a model call. Deterministic, so every re-ask
 * of one heal shares a byte-identical prefix (the healer's caching rule).
 */

import { selectRelevantContext } from '../catalog/retrieve.js';
import type { ExtractedDocument } from '../catalog/extract.js';
import { toPromptContext } from './query.js';
import type { ProjectGraph } from './types.js';

/** Advisory context for one repair. Either half may be absent. */
export interface HealHints {
  /** What the repository declares about the failing page — routes, components. */
  repoHints?: string | undefined;
  /** Background-document slices matching the failed step's own words. */
  background?: string | undefined;
}

/** What the healer knows at repair time — the retrieval query's raw material. */
export interface HealHintQuery {
  url: string;
  selector: string;
  intent?: string | undefined;
  caseContext?: string | undefined;
}

export type HealHintsProvider = (query: HealHintQuery) => HealHints;

/** A hint is framing, not a second tree: past this it starts competing with the evidence. */
export const HEAL_REPO_HINTS_MAX_LINES = 10;
/** The healer is latency-sensitive; background rides along only in this budget. */
export const HEAL_BACKGROUND_BUDGET_CHARS = 4_000;
/** Graph nodes walked for the hint — a slice, not the map the author gets. */
const HEAL_REPO_HINTS_MAX_NODES = 12;

/**
 * A provider over whatever sources the suite actually has. `null`/empty
 * sources cost nothing and yield nothing — a plain `run` with no graph and
 * no documents behaves exactly as before.
 */
export function healHintsFrom(
  graph: ProjectGraph | null | undefined,
  documents: readonly ExtractedDocument[] | undefined,
): HealHintsProvider {
  return (query) => {
    const hints: HealHints = {};
    const terms = [query.selector, query.intent ?? '', query.caseContext ?? ''].join(' ').trim();
    if (graph) {
      try {
        const rendered = toPromptContext(graph, {
          url: query.url,
          ...(terms === '' ? {} : { query: terms }),
          maxNodes: HEAL_REPO_HINTS_MAX_NODES,
        });
        // The sentinel ("no indexed route matches …") is a fact for the
        // author's audit trail, not a hint — a healer told "nothing matches"
        // learns nothing about the tree in front of it.
        if (rendered !== '' && !/no indexed route matches/.test(rendered)) {
          hints.repoHints = rendered.split('\n').slice(0, HEAL_REPO_HINTS_MAX_LINES).join('\n');
        }
      } catch {
        /* degrade to no hint — never to no heal */
      }
    }
    if (documents && documents.length > 0 && terms !== '') {
      try {
        const selected = selectRelevantContext(documents, terms, {
          budgetChars: HEAL_BACKGROUND_BUDGET_CHARS,
        });
        const text = selected.documents
          .map((doc) => `--- ${doc.name} ---\n${doc.text}`)
          .join('\n')
          .trim();
        // The selection degrades toward MORE context by design; the healer's
        // budget is the opposite contract, so an over-budget fallback (docs
        // returned whole after a selection fault) is cut here rather than
        // shipped. Disclosed by the ellipsis the same way the tree cap is.
        if (text !== '') {
          hints.background =
            text.length > HEAL_BACKGROUND_BUDGET_CHARS
              ? `${text.slice(0, HEAL_BACKGROUND_BUDGET_CHARS)}\n[…background cut at the healer's budget]`
              : text;
        }
      } catch {
        /* same rule */
      }
    }
    return hints;
  };
}
