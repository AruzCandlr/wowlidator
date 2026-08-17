/**
 * File-convention route discovery for Next.js (App Router and Pages Router).
 *
 * Other frameworks' routers (Vue Router, Angular's `RouterModule`, SvelteKit)
 * are not file-convention-based in the same mechanical way SvelteKit and
 * Next.js are — they need real config/decorator parsing, not a file walk —
 * so they are deliberately left for a future ingester rather than faked here.
 */

import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';

import type { IngestContext, IngestResult, Ingester, ProjectEdge, ProjectNode } from '../types.js';
import { componentId, pascalFromFilename } from '../naming.js';

const APP_BASENAMES = new Set(['page', 'layout', 'route']);
const APP_EXTENSIONS = ['tsx', 'ts', 'jsx', 'js'];
const NEXT_EXTENSION_RE = /\.(tsx|ts|jsx|js)$/;
const IGNORED_PAGES_BASENAME_RE = /^(_app|_document|_error|_middleware)$/;
const TEST_FILE_RE = /\.(test|spec)\.[tj]sx?$/;

type RouteType = 'page' | 'layout' | 'api';

/** `[id]` -> `:id`, `[...slug]` -> `*slug`, `[[...slug]]` -> `*slug`, `(group)` -> dropped. */
function convertSegment(segment: string): string | null {
  if (segment.startsWith('(') && segment.endsWith(')')) return null;
  const optionalCatchAll = /^\[\[\.\.\.(.+)\]\]$/.exec(segment);
  if (optionalCatchAll) return `*${optionalCatchAll[1]}`;
  const catchAll = /^\[\.\.\.(.+)\]$/.exec(segment);
  if (catchAll) return `*${catchAll[1]}`;
  const dynamic = /^\[(.+)\]$/.exec(segment);
  if (dynamic) return `:${dynamic[1]}`;
  return segment;
}

function toRoutePath(segments: string[]): string {
  const converted = segments.map(convertSegment).filter((s): s is string => s !== null);
  return converted.length === 0 ? '/' : `/${converted.join('/')}`;
}

function stripBase(file: string, base: string): string | null {
  const prefix = `${base}/`;
  return file.startsWith(prefix) ? file.slice(prefix.length) : null;
}

/** Best-effort guess at the default-exported component name, for a `renders` edge. Dangling guesses are pruned by the engine. */
async function guessDefaultComponentName(rootDir: string, file: string): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(posix.join(rootDir, file), 'utf8');
  } catch {
    return undefined;
  }
  const named = /export\s+default\s+function\s+([A-Z]\w*)/.exec(text);
  if (named?.[1]) return named[1];
  const reference = /export\s+default\s+([A-Z]\w*)\s*;/.exec(text);
  if (reference?.[1]) return reference[1];
  if (/export\s+default\s+/.test(text)) return pascalFromFilename(file);
  return undefined;
}

interface AppRouteMatch {
  segments: string[];
  type: RouteType;
}

function matchAppRoute(rest: string): AppRouteMatch | null {
  const parts = rest.split('/');
  const filename = parts[parts.length - 1];
  if (filename === undefined) return null;
  const match = new RegExp(`^(page|layout|route)\\.(${APP_EXTENSIONS.join('|')})$`).exec(filename);
  if (!match || !APP_BASENAMES.has(match[1] ?? '')) return null;

  const kind = match[1];
  const segments = parts.slice(0, -1);
  const type: RouteType = kind === 'route' ? 'api' : kind === 'layout' ? 'layout' : 'page';
  return { segments, type };
}

function matchPagesRoute(rest: string): { segments: string[]; type: RouteType } | null {
  if (!NEXT_EXTENSION_RE.test(rest) || TEST_FILE_RE.test(rest)) return null;
  const withoutExt = rest.replace(NEXT_EXTENSION_RE, '');
  const parts = withoutExt.split('/');
  const basename = parts[parts.length - 1];
  if (basename === undefined || IGNORED_PAGES_BASENAME_RE.test(basename)) return null;

  const segments = basename === 'index' ? parts.slice(0, -1) : parts;
  const type: RouteType = parts[0] === 'api' ? 'api' : 'page';
  return { segments, type };
}

export class RouteIngester implements Ingester {
  readonly id = 'route';

  async ingest(ctx: IngestContext): Promise<IngestResult> {
    const nodes: ProjectNode[] = [];
    const edges: ProjectEdge[] = [];
    const warnings: string[] = [];

    for (const file of ctx.files) {
      const appRest = stripBase(file, 'src/app') ?? stripBase(file, 'app');
      const appMatch = appRest ? matchAppRoute(appRest) : null;

      const pagesRest = stripBase(file, 'src/pages') ?? stripBase(file, 'pages');
      const pagesMatch = !appMatch && pagesRest ? matchPagesRoute(pagesRest) : null;

      const match = appMatch
        ? { segments: appMatch.segments, type: appMatch.type, router: 'next-app' as const }
        : pagesMatch
          ? { segments: pagesMatch.segments, type: pagesMatch.type, router: 'next-pages' as const }
          : null;
      if (!match) continue;

      const routePath = toRoutePath(match.segments);
      const nodeId = `route:${file}`;
      nodes.push({
        id: nodeId,
        kind: 'route',
        name: routePath,
        file,
        meta: { router: match.router, type: match.type },
      });

      if (match.type !== 'api') {
        const componentName = await guessDefaultComponentName(ctx.rootDir, file);
        if (componentName) {
          edges.push({ from: nodeId, to: componentId(file, componentName), kind: 'renders' });
        }
      }
    }

    return { nodes, edges, warnings };
  }
}
