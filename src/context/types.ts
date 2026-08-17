/**
 * Core data model for the repository context engine.
 *
 * The engine is deterministic, static-analysis only — no model call is ever
 * made to build the graph. It exists so the control-plane modules (generator,
 * healer, orchestrator) can reach for project-level knowledge a single page's
 * AX tree cannot show: which component a route renders, what already covers
 * it, what the project even is. Indexing is $0; only `toPromptContext`'s
 * chosen slice ever reaches a prompt, and only when a caller opts in.
 */

/**
 * `operation` is the backend counterpart of `route`: one method+path pair from
 * an OpenAPI document. Kept as its own kind rather than folded into `route`
 * because the two answer different questions — a route renders a page, an
 * operation accepts a request — and because two operations can share one path.
 */
/**
 * `table` follows the same precedent one layer further down: one table from a
 * database schema (DDL, Prisma, or live introspection). Its own kind because
 * a table is a different promise again — an operation accepts a request, a
 * table holds the state the request was supposed to change.
 */
export type ProjectNodeKind = 'package' | 'component' | 'route' | 'test' | 'operation' | 'table';

export interface ProjectNode {
  /** Stable id, e.g. `component:src/components/Button.tsx#Button`. */
  id: string;
  kind: ProjectNodeKind;
  name: string;
  /** Repo-relative path. */
  file: string;
  detail?: string | undefined;
  meta?: Record<string, string> | undefined;
}

/** `references` — a foreign key from one `table` node to another. */
export type ProjectEdgeKind = 'uses' | 'renders' | 'covers' | 'references';

export interface ProjectEdge {
  from: string;
  to: string;
  kind: ProjectEdgeKind;
}

/** One ingester's contribution before the engine merges and prunes it. */
export interface IngestResult {
  nodes: ProjectNode[];
  edges: ProjectEdge[];
  /** Surfaced on the graph rather than thrown — one bad ingester must not block the rest. */
  warnings: string[];
}

export interface IngestContext {
  /** Absolute path to the project being indexed. */
  rootDir: string;
  /**
   * Every non-ignored file under `rootDir`, as repo-relative paths, walked
   * once and shared across ingesters so N ingesters cost one directory walk.
   */
  files: string[];
}

/** A pluggable source the context engine reads from. */
export interface Ingester {
  readonly id: string;
  ingest(ctx: IngestContext): Promise<IngestResult>;
}

export const PROJECT_GRAPH_VERSION = 1;

export interface ProjectGraphSource {
  id: string;
  nodes: number;
  edges: number;
  warnings: string[];
}

export interface ProjectGraph {
  version: number;
  rootDir: string;
  generatedAt: string;
  /**
   * Cheap composite signature (path + size + mtime of every walked file) used
   * to decide whether a rebuild is needed. Not a content hash — content
   * hashing every file on each `wowlidator generate` would cost more than the
   * static analysis it is meant to short-circuit.
   */
  signature: string;
  nodes: ProjectNode[];
  edges: ProjectEdge[];
  sources: ProjectGraphSource[];
}
