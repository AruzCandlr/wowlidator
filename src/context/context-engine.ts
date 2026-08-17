/**
 * Orchestrates the ingesters into one `ProjectGraph` and caches it to disk.
 *
 * Deliberately not incremental per-file: a full rebuild is plain filesystem
 * walking plus syntactic parsing, no model call, so it costs milliseconds on
 * a project this shape targets. What IS worth avoiding is redoing that work
 * when nothing changed — `signature` is a cheap composite of every walked
 * file's size and mtime, and a matching signature short-circuits straight to
 * the cached graph without touching an ingester.
 */

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, posix, resolve } from 'node:path';
import type { Dirent } from 'node:fs';

import { ManifestIngester } from './ingesters/manifest-ingester.js';
import { ComponentIngester } from './ingesters/component-ingester.js';
import { RouteIngester } from './ingesters/route-ingester.js';
import { TestIngester } from './ingesters/test-ingester.js';
import { OpenApiIngester } from './ingesters/openapi-ingester.js';
import {
  PROJECT_GRAPH_VERSION,
  type IngestContext,
  type IngestResult,
  type Ingester,
  type ProjectEdge,
  type ProjectGraph,
  type ProjectGraphSource,
  type ProjectNode,
} from './types.js';

export const DEFAULT_CONTEXT_CACHE_FILE = '.wowlidator/context-graph.json';

const IGNORED_DIR_NAMES = new Set(['node_modules', 'dist', 'build', 'out', 'coverage']);
/** A time/resource budget for the walk itself, same spirit as the AX-tree node cap. */
const MAX_WALK_FILES = 20_000;

async function walkFiles(rootDir: string): Promise<{ files: string[]; truncated: boolean }> {
  const out: string[] = [];
  const stack: string[] = [''];
  let truncated = false;

  while (stack.length > 0) {
    if (out.length >= MAX_WALK_FILES) {
      truncated = true;
      break;
    }
    const dir = stack.pop();
    if (dir === undefined) break;

    let entries: Dirent[];
    try {
      entries = await readdir(posix.join(rootDir, dir), { withFileTypes: true });
    } catch {
      continue; // unreadable dir (permissions, race) — skip rather than abort the whole walk
    }

    for (const entry of entries) {
      const rel = dir === '' ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (IGNORED_DIR_NAMES.has(entry.name) || entry.name.startsWith('.')) continue;
        stack.push(rel);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  }

  return { files: out.sort(), truncated };
}

async function computeSignature(rootDir: string, files: readonly string[]): Promise<string> {
  const hash = createHash('sha1');
  for (const file of files) {
    try {
      const info = await stat(posix.join(rootDir, file));
      hash.update(`${file}:${info.size}:${info.mtimeMs}\n`);
    } catch {
      hash.update(`${file}:missing\n`);
    }
  }
  return hash.digest('hex');
}

export function pathnameOf(url: string): string | undefined {
  try {
    return new URL(url).pathname;
  } catch {
    // A relative url never parses, so strip the query and hash by hand —
    // `new URL()` would have done it for the absolute case, and a path that
    // kept `?page=2` would fail to match the route pattern it plainly hits.
    if (!url.startsWith('/')) return undefined;
    return url.split(/[?#]/)[0] ?? url;
  }
}

/** `:id` and `*catchAll` segments in `pattern` match anything at that position. */
export function matchesRoutePattern(path: string, pattern: string): boolean {
  const pathParts = path.split('/').filter(Boolean);
  const patternParts = pattern.split('/').filter(Boolean);

  const catchAllIndex = patternParts.findIndex((part) => part.startsWith('*'));
  if (catchAllIndex !== -1) {
    const fixed = patternParts.slice(0, catchAllIndex);
    // A catch-all consumes one or more segments — `/blog` alone does not
    // satisfy `/blog/*slug` (that's what an *optional* catch-all is for, a
    // distinction this matcher's single `*` encoding does not carry).
    if (pathParts.length <= fixed.length) return false;
    return fixed.every((part, i) => part.startsWith(':') || part === pathParts[i]);
  }

  if (pathParts.length !== patternParts.length) return false;
  return patternParts.every((part, i) => part.startsWith(':') || part === pathParts[i]);
}

/**
 * Cross-ingester linking pass: a `wowlidator-flow` test node records the URLs it
 * navigates to (the one thing we can read reliably out of our own flow
 * format); this matches those against route node names to produce `covers`
 * edges, so the graph can answer "does anything already test this route?"
 */
function linkCoverage(nodes: Map<string, ProjectNode>, edges: ProjectEdge[]): void {
  const routes = [...nodes.values()].filter((node) => node.kind === 'route');
  const operations = [...nodes.values()].filter((node) => node.kind === 'operation');
  if (routes.length === 0 && operations.length === 0) return;

  const seen = new Set(edges.map((edge) => `${edge.from}>${edge.kind}>${edge.to}`));
  const link = (from: string, to: string): void => {
    const key = `${from}>covers>${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from, to, kind: 'covers' });
  };

  for (const test of nodes.values()) {
    if (test.kind !== 'test') continue;

    const urls = (test.meta?.urls ?? '').split(',').filter((url) => url !== '');
    for (const url of urls) {
      const path = pathnameOf(url);
      if (path === undefined) continue;
      for (const route of routes) {
        if (matchesRoutePattern(path, route.name)) link(test.id, route.id);
      }
    }

    // The same idea one layer down: a `request` step records `METHOD url`, and
    // an operation node's name is `METHOD /path/:param`, so the same matcher
    // answers "does anything already test this endpoint?" The method must
    // match exactly — `GET /orders` and `DELETE /orders` are different
    // promises, and crediting one for the other would overstate coverage in
    // precisely the way `ax-coverage.ts` refuses to.
    const calls = (test.meta?.calls ?? '').split(',').filter((call) => call !== '');
    for (const call of calls) {
      const spaceAt = call.indexOf(' ');
      if (spaceAt < 0) continue;
      const method = call.slice(0, spaceAt);
      const path = pathnameOf(call.slice(spaceAt + 1));
      if (path === undefined) continue;
      for (const operation of operations) {
        const [opMethod, opPattern] = operation.name.split(' ');
        if (opMethod !== method || opPattern === undefined) continue;
        if (matchesRoutePattern(path, opPattern)) link(test.id, operation.id);
      }
    }
  }
}

function mergeGraph(
  rootDir: string,
  signature: string,
  results: ReadonlyArray<{ id: string; result: IngestResult }>,
): ProjectGraph {
  const nodes = new Map<string, ProjectNode>();
  const sources: ProjectGraphSource[] = [];
  const rawEdges: ProjectEdge[] = [];

  for (const { id, result } of results) {
    const warnings = [...result.warnings];
    let nodeCount = 0;
    for (const node of result.nodes) {
      if (nodes.has(node.id)) {
        warnings.push(`duplicate node id "${node.id}" from ingester "${id}" — kept the first`);
        continue;
      }
      nodes.set(node.id, node);
      nodeCount += 1;
    }
    rawEdges.push(...result.edges);
    sources.push({ id, nodes: nodeCount, edges: result.edges.length, warnings });
  }

  // An edge whose endpoint was never indexed is dropped, not guessed at — the
  // same "understate, never overstate" rule `ax-coverage.ts` follows.
  const seenEdges = new Set<string>();
  const edges: ProjectEdge[] = [];
  let dangling = 0;
  for (const edge of rawEdges) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) {
      dangling += 1;
      continue;
    }
    const key = `${edge.from}>${edge.kind}>${edge.to}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    edges.push(edge);
  }
  if (dangling > 0) {
    sources.push({
      id: 'merge',
      nodes: 0,
      edges: 0,
      warnings: [`dropped ${dangling} edge(s) whose endpoint(s) were never indexed`],
    });
  }

  linkCoverage(nodes, edges);

  return {
    version: PROJECT_GRAPH_VERSION,
    rootDir,
    generatedAt: new Date().toISOString(),
    signature,
    nodes: [...nodes.values()],
    edges,
    sources,
  };
}

export interface ContextEngineOptions {
  /** Project to index. Defaults to the current working directory. */
  rootDir?: string | undefined;
  /** Where the graph is cached. Defaults to `.wowlidator/context-graph.json`. */
  cacheFile?: string | undefined;
  /** Override the ingester set — mainly for tests. Defaults to all five built-ins. */
  ingesters?: Ingester[] | undefined;
  /**
   * OpenAPI/Swagger spec to index: a path (absolute or project-relative) or an
   * `http(s)` URL. Omit and the ingester looks for a conventionally-named spec
   * among the walked files.
   */
  openApiSpec?: string | undefined;
  /** Emit a warning to stderr when the cache file is unreadable. Default true. */
  warn?: boolean | undefined;
}

export class ContextEngine {
  readonly rootDir: string;
  readonly cacheFile: string;

  readonly #ingesters: Ingester[];
  readonly #warn: boolean;

  constructor(options: ContextEngineOptions = {}) {
    this.rootDir = resolve(options.rootDir ?? '.');
    this.cacheFile = resolve(options.cacheFile ?? DEFAULT_CONTEXT_CACHE_FILE);
    this.#ingesters = options.ingesters ?? [
      new ManifestIngester(),
      new ComponentIngester(),
      new RouteIngester(),
      new TestIngester(),
      new OpenApiIngester(options.openApiSpec === undefined ? {} : { source: options.openApiSpec }),
    ];
    this.#warn = options.warn ?? true;
  }

  /** Read the cached graph without rebuilding. `null` if none exists or it's unreadable. */
  async load(): Promise<ProjectGraph | null> {
    let raw: string;
    try {
      raw = await readFile(this.cacheFile, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    try {
      return JSON.parse(raw) as ProjectGraph;
    } catch (error) {
      if (this.#warn) {
        const detail = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[wowlidator] ignoring unreadable context graph at ${this.cacheFile}: ${detail}\n`);
      }
      return null;
    }
  }

  /**
   * Build (or reuse) the project graph. A matching `signature` against the
   * cached graph short-circuits to it; pass `force: true` to always rebuild.
   */
  async build(options: { force?: boolean } = {}): Promise<ProjectGraph> {
    const { files, truncated } = await walkFiles(this.rootDir);
    const signature = await computeSignature(this.rootDir, files);

    if (options.force !== true) {
      const cached = await this.load();
      if (cached && cached.signature === signature) return cached;
    }

    const ctx: IngestContext = { rootDir: this.rootDir, files };
    const results = await Promise.all(
      this.#ingesters.map(async (ingester) => {
        try {
          return { id: ingester.id, result: await ingester.ingest(ctx) };
        } catch (error) {
          const warnings = [`ingester crashed: ${error instanceof Error ? error.message : String(error)}`];
          const result: IngestResult = { nodes: [], edges: [], warnings };
          return { id: ingester.id, result };
        }
      }),
    );

    if (truncated) {
      results.push({
        id: 'walk',
        result: { nodes: [], edges: [], warnings: [`file walk hit the ${MAX_WALK_FILES}-file cap — some files were not indexed`] },
      });
    }

    const graph = mergeGraph(this.rootDir, signature, results);
    await this.#persist(graph);
    return graph;
  }

  async #persist(graph: ProjectGraph): Promise<void> {
    await mkdir(dirname(this.cacheFile), { recursive: true });
    const tmp = `${this.cacheFile}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(graph, null, 2)}\n`, 'utf8');
    await rename(tmp, this.cacheFile);
  }
}
