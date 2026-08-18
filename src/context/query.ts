/**
 * Turns a `ProjectGraph` into the compact text a prompt can afford.
 *
 * Same reasoning as the AX-tree cap in `jit-healer.ts`: the graph can hold
 * thousands of nodes, but a generation prompt should only ever see the slice
 * relevant to the page being tested. `toPromptContext` walks outward from the
 * matched route and stops at a node budget rather than dumping the graph.
 */

import { matchesRoutePattern, pathnameOf } from './context-engine.js';
import { bm25, queryTerms } from './relevance.js';
import type { ProjectEdgeKind, ProjectGraph, ProjectNode } from './types.js';

export const DEFAULT_CONTEXT_MAX_NODES = 40;

/**
 * Routes the description names, beyond the one the run starts on.
 *
 * A journey is not one page. "log in, open time and attendance, create an
 * overtime request, check its status" starts at `/login` and is *about*
 * `/overtime` — and a walk seeded only from the starting URL handed the
 * authoring model two lines about the login page while 71 nodes describing
 * overtime sat unread in the same graph. Measured on the saved
 * `cnext-hrms-fortest` index against that exact prompt.
 */
export const DEFAULT_DESCRIBED_ROUTE_ROOTS = 6;

/**
 * A route must score this much of the best route's score to be included.
 *
 * The cap alone is the wrong instrument in both directions: a description that
 * names one page should not drag in five, and one that crosses four pages
 * should not lose the fourth to a fixed number. Measured on the overtime
 * prompt, `/:locale/time` scores 54% of the best route and belongs; the
 * routes below this floor shared one generic word ("request", "form") with the
 * description and nothing else. Same rule, same value, as
 * `RELATIVE_SCORE_FLOOR` in `catalog/retrieve.ts` — and it is here for the
 * same reason: filling a budget with whatever ranked next is how a prompt ends
 * up carrying pages the test was never about.
 */
export const ROUTE_SCORE_FLOOR = 0.35;

export interface PromptContextOptions {
  /** The page being tested. Used to find the route this graph knows about it. */
  url?: string | undefined;
  /**
   * What the test is meant to do, in the author's words. Routes the graph
   * declares are ranked against it, so the section describes the journey and
   * not only its first page. Omit it and the walk is url-only, byte-for-byte
   * what this produced before.
   */
  query?: string | undefined;
  maxNodes?: number | undefined;
  /** How many description-matched routes may seed the walk. */
  maxDescribedRoots?: number | undefined;
}

/**
 * What a route is *about*, as text to rank: its pattern, its file, and the
 * names of what it renders. A route pattern alone is too thin a document —
 * `/:locale/time/timesheet` shares no word with "attendance", while the
 * `TimeAttendancePage` it renders does.
 */
function routeDocument(graph: ProjectGraph, route: ProjectNode): string {
  const rendered = graph.edges
    .filter((edge) => edge.from === route.id)
    .map((edge) => graph.nodes.find((node) => node.id === edge.to))
    .filter((node): node is ProjectNode => node !== undefined)
    .map((node) => `${node.name} ${node.file ?? ''}`);
  return [route.name, route.file ?? '', ...rendered].join(' ');
}

/**
 * The routes this description is about, best first, never a zero-scoring one.
 *
 * Exported for the test that pins the ranking against a real saved graph: a
 * silently empty result here is indistinguishable from a repository that
 * declares nothing, which is the failure mode this whole section must not have.
 */
export function routesForDescription(
  graph: ProjectGraph,
  query: string,
  limit = DEFAULT_DESCRIBED_ROUTE_ROOTS,
): ProjectNode[] {
  if (queryTerms(query).length === 0) return [];
  const routes = graph.nodes.filter((node) => node.kind === 'route');
  if (routes.length === 0) return [];
  const scores = bm25(routes.map((route) => routeDocument(graph, route)), query);
  const best = Math.max(0, ...scores);
  if (best <= 0) return [];
  return routes
    .map((route, i) => ({ route, score: scores[i] ?? 0 }))
    .filter((entry) => entry.score >= best * ROUTE_SCORE_FLOOR)
    .sort((a, b) => b.score - a.score || a.route.name.localeCompare(b.route.name))
    .slice(0, limit)
    .map((entry) => entry.route);
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
    case 'references':
      return `  ${from.name} references ${to.name}`;
    default:
      return `  ${from.name} -> ${to.name}`;
  }
}

/**
 * Route-centered prompt context: each root route, what it renders, what that
 * component (transitively) uses, and what already covers it — breadth-first
 * outward, capped at `maxNodes` across every root together.
 *
 * **Roots are the page the run starts on *and* the routes the description
 * names.** A journey is not one page: seeded only from the starting URL, the
 * describe path handed the authoring model two lines about a login screen
 * while everything the test was actually about sat unread in the same graph.
 * The two kinds of root are labelled apart, because "this is the page you are
 * on" and "this is elsewhere in the application, and the description mentions
 * it" are different claims — the probe-report separation rule, applied again.
 *
 * Empty string when there is nothing to look up, so callers can splice this
 * into a prompt unconditionally.
 */
export function toPromptContext(graph: ProjectGraph, options: PromptContextOptions = {}): string {
  const maxNodes = options.maxNodes ?? DEFAULT_CONTEXT_MAX_NODES;
  const startRoute = options.url === undefined ? undefined : findRouteForUrl(graph, options.url);
  const described = options.query
    ? routesForDescription(
        graph,
        options.query,
        options.maxDescribedRoots ?? DEFAULT_DESCRIBED_ROUTE_ROOTS,
      ).filter((route) => route.id !== startRoute?.id)
    : [];

  if (startRoute === undefined && described.length === 0) {
    if (options.url === undefined) return '';
    // Unchanged wording: callers detect this sentence to tell "nothing was
    // looked up" from "the repository declares nothing".
    return `Project context: no indexed route matches ${options.url}.`;
  }

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

  const included = new Set<string>();
  let truncated = false;

  /** One root's block: breadth-first outward, sharing the global node budget. */
  const walk = (root: ProjectNode, heading: string): string[] => {
    const lines = [heading];
    included.add(root.id);
    const queue: string[] = [root.id];
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
    return lines;
  };

  const blocks: string[] = [];
  if (startRoute) {
    blocks.push(walk(startRoute, `Project context for ${startRoute.name} (${startRoute.file}):`).join('\n'));
  }
  if (described.length > 0) {
    blocks.push(
      'Also declared in this repository, matching what the test describes ' +
        '(these are pages elsewhere in the application, not the page you are on):',
    );
    for (const route of described) {
      blocks.push(walk(route, `  ${route.name} (${route.file}):`).join('\n'));
    }
  }
  if (truncated) blocks.push(`  (context truncated at ${maxNodes} nodes)`);
  return blocks.join('\n');
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
