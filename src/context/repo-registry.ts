/**
 * Saved repositories — the memory behind "select a repo on a run".
 *
 * `context add <path>` scans a repository through the ordinary `ContextEngine`
 * and remembers it here: one registry file, one graph cache per repo, so a
 * second repository no longer overwrites the first (the single
 * `.wowlidator/context-graph.json` used to be last-writer-wins). Selection is
 * explicit — `--repo <slug|path>` on a run, or the dropdown in wowUI — and an
 * unknown selection is a loud error, never a guess: the user named a specific
 * repository, and silently authoring without it would ground nothing while
 * looking grounded.
 *
 * The registry is deliberately dumb: slug, path, when, how many nodes, plus
 * the openapi/db-schema inputs the scan was made with (a rebuild that silently
 * dropped the OpenAPI spec would lose every `operation` node and read as "the
 * app declares no endpoints"). Everything derived — routes, tables, coverage —
 * lives in the graph file, which `ContextEngine`'s own signature keeps fresh.
 *
 * Same file-handling constitution as the cache: temp-file + rename on write,
 * and a corrupt registry is reported to stderr and read as empty rather than
 * taking the command down.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

/** Where saved repositories live, relative to the working directory. */
export const REPO_REGISTRY_DIR = '.wowlidator/context';
export const REPO_REGISTRY_FILE = 'repos.json';

export interface RepoEntry {
  /** Human-readable, collision-proof id: basename plus a short path hash. */
  slug: string;
  /** Resolved absolute path to the repository. */
  path: string;
  /** ISO timestamp of the last scan. */
  indexedAt: string;
  /** Node count of the last scan — what the panel shows next to the slug. */
  nodes: number;
  /** The scan's OpenAPI spec input, carried so a re-scan keeps its endpoints. */
  openapi?: string | undefined;
  /** The scan's DB schema input, carried for the same reason. */
  dbSchema?: string | undefined;
}

/** basename + 4 hex chars of the resolved path: readable, and stable per path. */
export function slugFor(path: string): string {
  const abs = resolve(path);
  const hash = createHash('sha256').update(abs).digest('hex').slice(0, 4);
  return `${basename(abs)}-${hash}`;
}

/** Where a saved repo's graph is cached. */
export function graphFileFor(slug: string, dir: string = REPO_REGISTRY_DIR): string {
  return join(dir, `${slug}.graph.json`);
}

function registryPath(dir: string): string {
  return join(dir, REPO_REGISTRY_FILE);
}

/** Every saved repository. A missing or corrupt registry reads as empty. */
export async function listRepos(dir: string = REPO_REGISTRY_DIR): Promise<RepoEntry[]> {
  let raw: string;
  try {
    raw = await readFile(registryPath(dir), 'utf8');
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as { repos?: unknown };
    if (!Array.isArray(parsed.repos)) return [];
    return parsed.repos.filter(
      (entry): entry is RepoEntry =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as RepoEntry).slug === 'string' &&
        typeof (entry as RepoEntry).path === 'string',
    );
  } catch (error) {
    process.stderr.write(
      `wowlidator: repository registry unreadable (${(error as Error).message}) — treating as empty\n`,
    );
    return [];
  }
}

/** Add or replace one entry, keyed by slug. */
export async function upsertRepo(entry: RepoEntry, dir: string = REPO_REGISTRY_DIR): Promise<void> {
  const repos = (await listRepos(dir)).filter((existing) => existing.slug !== entry.slug);
  repos.push(entry);
  repos.sort((a, b) => a.slug.localeCompare(b.slug));
  const file = registryPath(dir);
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ version: 1, repos }, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

/**
 * The scan inputs a (re-)add should build with. A re-add usually arrives bare
 * — wowUI's Repositories "Re-scan" posts only the path — and rebuilding
 * without the remembered openapi/db-schema would drop every operation/table
 * node while reading as a refresh: exactly the loss the fields on `RepoEntry`
 * exist to prevent. A flag passed on THIS invocation still wins — re-adding
 * with a new `--openapi` means it. One derivation, fed to both the
 * `ContextEngine` build and the registry entry, so the graph and what the
 * entry claims it was scanned with cannot disagree.
 */
export function mergedScanInputs(
  existing: RepoEntry | null,
  current: { openapi?: string | undefined; dbSchema?: string | undefined },
): { openapi: string | undefined; dbSchema: string | undefined } {
  return {
    openapi: current.openapi ?? existing?.openapi,
    dbSchema: current.dbSchema ?? existing?.dbSchema,
  };
}

/**
 * Find a saved repo by slug or by path. `null` means unknown — and for an
 * explicit selection the caller must fail loudly, not fall back to nothing.
 */
export async function resolveRepo(
  value: string,
  dir: string = REPO_REGISTRY_DIR,
): Promise<RepoEntry | null> {
  const repos = await listRepos(dir);
  const bySlug = repos.find((entry) => entry.slug === value);
  if (bySlug) return bySlug;
  const abs = resolve(value);
  return repos.find((entry) => entry.path === abs) ?? null;
}
