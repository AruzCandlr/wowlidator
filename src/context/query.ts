/**
 * Turns a `ProjectGraph` into the compact text a prompt can afford.
 *
 * Same reasoning as the AX-tree cap in `jit-healer.ts`: the graph can hold
 * thousands of nodes, but a generation prompt should only ever see the slice
 * relevant to the page being tested. `toPromptContext` walks outward from the
 * matched route and stops at a node budget rather than dumping the graph.
 */

import { matchesRoutePattern, pathnameOf } from './context-engine.js';
import type { ProjectEdgeKind, ProjectGraph, ProjectNode } from './types.js';

export const DEFAULT_CONTEXT_MAX_NODES = 40;

export interface PromptContextOptions {
  /** The page being tested. Used to find the route this graph knows about it. */
  url?: string | undefined;
  maxNodes?: number | undefined;
}

/** The route node whose URL pattern matches `url`, if the graph indexed one. */
export function findRouteForUrl(graph: ProjectGraph, url: string): ProjectNode | undefined {
  const path = pathnameOf(url) ?? url;
  return graph.nodes.find((node) => node.kind === 'route' && matchesRoutePattern(path, node.name));
}

function describeEdge(from: ProjectNode, kind: ProjectEdgeKind, to: ProjectNode): string {
  switch (kind) {
    case 'renders':
      return `  renders ${to.name} (${to.file})`;
    case 'uses':
      return `  ${from.name} uses ${to.name} (${to.file})`;
    case 'covers':
      return `  covered by "${from.name}" (${from.file})`;
    default:
      return `  ${from.name} -> ${to.name}`;
  }
}

/**
 * Route-centered prompt context: the matched route, what it renders, what
 * that component (transitively) uses, and what already covers it — breadth-
 * first outward from the route, capped at `maxNodes`. Empty string if `url`
 * is omitted or nothing in the graph matches it, so callers can splice this
 * into a prompt unconditionally without an `if` at every call site.
 */
export function toPromptContext(graph: ProjectGraph, options: PromptContextOptions = {}): string {
  if (options.url === undefined) return '';

  const maxNodes = options.maxNodes ?? DEFAULT_CONTEXT_MAX_NODES;
  const route = findRouteForUrl(graph, options.url);
  if (!route) return `Project context: no indexed route matches ${options.url}.`;

  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const outEdges = new Map<string, typeof graph.edges>();
  const inCoversEdges = new Map<string, typeof graph.edges>();
  for (const edge of graph.edges) {
    if (!outEdges.has(edge.from)) outEdges.set(edge.from, []);
    outEdges.get(edge.from)?.push(edge);
    if (edge.kind === 'covers') {
      if (!inCoversEdges.has(edge.to)) inCoversEdges.set(edge.to, []);
      inCoversEdges.get(edge.to)?.push(edge);
    }
  }

  const lines = [`Project context for ${route.name} (${route.file}):`];
  const included = new Set<string>([route.id]);
  const queue: string[] = [route.id];
  let truncated = false;
  let cursor = 0;

  while (cursor < queue.length) {
    const id = queue[cursor];
    cursor += 1;
    if (id === undefined) continue;
    const node = nodesById.get(id);
    if (!node) continue;

    for (const edge of outEdges.get(id) ?? []) {
      if (included.has(edge.to)) continue;
      if (included.size >= maxNodes) {
        truncated = true;
        break;
      }
      const target = nodesById.get(edge.to);
      if (!target) continue;
      included.add(edge.to);
      queue.push(edge.to);
      lines.push(describeEdge(node, edge.kind, target));
    }

    for (const edge of inCoversEdges.get(id) ?? []) {
      if (included.has(edge.from)) continue;
      if (included.size >= maxNodes) {
        truncated = true;
        break;
      }
      const source = nodesById.get(edge.from);
      if (!source) continue;
      included.add(edge.from);
      lines.push(describeEdge(source, edge.kind, node));
    }
  }

  if (truncated) lines.push(`  (context truncated at ${maxNodes} nodes)`);
  return lines.join('\n');
}

/** Human-readable overview for `wowlidator context show` — counts, not the full graph. */
export function summarize(graph: ProjectGraph): string {
  const counts: Record<string, number> = {};
  for (const node of graph.nodes) counts[node.kind] = (counts[node.kind] ?? 0) + 1;

  const warnings = graph.sources.flatMap((source) => source.warnings.map((w) => `  [${source.id}] ${w}`));

  const lines = [
    `rootDir     ${graph.rootDir}`,
    `generatedAt ${graph.generatedAt}`,
    `nodes       ${graph.nodes.length} (${Object.entries(counts)
      .map(([kind, count]) => `${count} ${kind}`)
      .join(', ')})`,
    `edges       ${graph.edges.length}`,
  ];
  if (warnings.length > 0) lines.push('warnings:', ...warnings);
  return lines.join('\n');
}
