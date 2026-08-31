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

/**
 * The HTTP methods a file-convention router exposes by EXPORTING a function
 * of that name. Next.js App Router: `export async function GET(...)`; the
 * Pages Router has one default handler and no per-method exports, which is
 * why only the App Router yields operations here.
 */
const HTTP_METHOD_EXPORTS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;

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
  // `async` is optional: an App Router page that awaits its data is
  // `export default async function BenefitPlansPage()`, and without this the
  // guess fell through to the filename ("Page"), the edge dangled and was
  // pruned, and the route walked to NOTHING — the generator's repository
  // slice for that page was empty (measured 2026-08-28: every async page
  // route in the indexed app had zero edges).
  const named = /export\s+default\s+(?:async\s+)?function\s+([A-Z]\w*)/.exec(text);
  if (named?.[1]) return named[1];
  const reference = /export\s+default\s+([A-Z]\w*)\s*;/.exec(text);
  if (reference?.[1]) return reference[1];
  if (/export\s+default\s+/.test(text)) return pascalFromFilename(file);
  return undefined;
}

/**
 * Which HTTP methods an App Router handler file exports.
 *
 * Read from the file because the file path cannot say it: `/api/benefit-plans`
 * as a PATH exists whether or not it answers GET. Live (be100 PL_03_03,
 * 2026-08-25): the index held `route "/api/benefit-plans"` and nothing else,
 * the author took the path from the repo exactly as its prompt demands,
 * guessed `GET`, and the app answered 405 Method Not Allowed — because that
 * file exports POST, PUT and DELETE only. Two `high` defects were filed
 * against an application that was behaving correctly. The method is half of
 * what an endpoint is, and until now the file-convention router indexed the
 * other half alone.
 *
 * A regex, not a parser, on the same "pragmatic beats wrong" rule as
 * `guessDefaultComponentName` above: the three shapes Next.js documents
 * (`export async function GET`, `export function GET`, `export const GET =`)
 * are matched, and a file too odd to read yields no operations rather than
 * wrong ones — the caller then keeps the methodless route node it always had.
 */
async function exportedHttpMethods(rootDir: string, file: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(posix.join(rootDir, file), 'utf8');
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const method of HTTP_METHOD_EXPORTS) {
    const re = new RegExp(`export\\s+(?:async\\s+)?(?:function\\s+${method}\\b|const\\s+${method}\\s*[:=])`);
    if (re.test(text)) found.push(method);
  }
  return found;
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
      // An api route's methods, read from the file. Recorded on the route
      // node too (one string, so `meta` stays a flat record) — a reader that
      // only has the route still learns what it answers.
      const methods =
        match.type === 'api' && match.router === 'next-app'
          ? await exportedHttpMethods(ctx.rootDir, file)
          : [];
      nodes.push({
        id: nodeId,
        kind: 'route',
        name: routePath,
        file,
        meta: {
          router: match.router,
          type: match.type,
          ...(methods.length > 0 ? { methods: methods.join(',') } : {}),
        },
      });

      // One `operation` per method+path — the same kind, id and `METHOD /path`
      // name shape the OpenAPI ingester emits, so every consumer (the prompt
      // slice, route matching, the authoring lint) reads one vocabulary
      // whether the endpoints came from a spec or from the file system. A
      // handler file that exports no method at all (a helper, an odd shape
      // the regex could not read) contributes none, and the route node above
      // still stands: silence, never a guess.
      for (const method of methods) {
        nodes.push({
          id: `operation:${method} ${routePath}`,
          kind: 'operation',
          name: `${method} ${routePath}`,
          file,
          meta: { source: 'route-file', router: match.router },
        });
      }

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
