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

import type { DbHint } from './db-hint.js';

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
  /**
   * The deployed application's navigation, learned from its own sidebar and
   * remembered here — see `NavMap`. Absent until a signed-in capture has had
   * a chance to read it.
   */
  nav?: NavMap | undefined;
  /**
   * Context documents remembered WITH the repository — background every run
   * grounded in this repo carries automatically, alongside anything passed
   * per run with `--context-doc`. Absolute file paths, read fresh at
   * authoring time, so editing the file on disk updates the context with no
   * re-registration: the registry remembers where the document lives, never
   * a copy of what it said.
   */
  contextDocs?: string[] | undefined;
  /**
   * What the repository's own files say about its database — engine, host,
   * port, database, user, and where a password is defined (never the value).
   * A hint the panel shows next to "no database configured", not a
   * connection anything opens. See `context/db-hint.ts`.
   */
  dbHint?: DbHint | undefined;
}

/**
 * One navigation destination the application itself offers: a link's
 * accessible name and where it points. `via` is the disclosure that had to be
 * opened for it to exist ("ขยายเมนู", "Team"), when there was one.
 */
export interface NavLink {
  label: string;
  path: string;
  via?: string | undefined;
}

/**
 * What the application's own menu says goes where.
 *
 * The static index knows a route as `/:locale/workflows/probation`; a test-case
 * sheet says "Team → Probation Reviews"; those two share no token, and no
 * ranking over the code can bridge them — measured, six of six rows of a real
 * catalog ranked to the wrong route. The bridge is the deployed page: its
 * sidebar link is *named* "Probation Reviews" and *points at*
 * /en/workflows/probation. Read once from a signed-in shell, kept with the
 * repository, and consulted before any ranking. `origin` records which
 * deployment it was read from, so a map learned against one host is not
 * mistaken for another's.
 */
export interface NavMap {
  learnedAt: string;
  origin: string;
  /** Who was signed in when it was read — a menu is role-dependent. */
  as?: string | undefined;
  links: NavLink[];
}

/**
 * The destination a request's words point at, by the application's own menu
 * labels. Among the labels present in the text the one that appears FIRST
 * wins — a sheet's Menu column names the primary path first and any second
 * surface after it, and a rail's group names ("Team", "HR") are buttons, not
 * links, so the first *link* label is the primary leaf. At the same position
 * the longer label wins ("Probation Reviews" over "Reviews"). `null` when no
 * label of three or more characters occurs, which is the honest answer: a
 * guess here becomes a page the capture reads and the author is grounded on.
 */
export function navDestination(text: string, nav: NavMap | undefined): NavLink | null {
  if (!nav || nav.links.length === 0) return null;
  const haystack = text.toLowerCase();
  let best: { link: NavLink; at: number; len: number } | null = null;
  for (const link of nav.links) {
    const label = link.label.trim();
    if (label.length < 3 || /^\d+$/.test(label)) continue;
    // A label with a live count on it ("Approval Requests 23 รายการใหม่") is
    // matched on its stable head: the part before the first digit run.
    const stable = label.replace(/\s+\d[\s\S]*$/, '').trim() || label;
    const at = haystack.indexOf(stable.toLowerCase());
    if (at === -1) continue;
    if (
      best === null ||
      at < best.at ||
      (at === best.at && stable.length > best.len)
    ) {
      best = { link, at, len: stable.length };
    }
  }
  return best?.link ?? null;
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
 * The context documents a (re-)add should remember. Same shape as
 * `mergedScanInputs`: a bare re-add keeps what the entry already remembered,
 * and a document added now with the SAME FILE NAME replaces the old path —
 * that is how an updated copy of a spec supersedes the version registered
 * before it, without the old entry lingering as a duplicate. Different names
 * accumulate.
 */
export function mergedContextDocs(
  existing: RepoEntry | null,
  added: readonly string[],
): string[] | undefined {
  const merged = [...(existing?.contextDocs ?? [])];
  for (const doc of added) {
    const name = basename(doc).toLowerCase();
    const at = merged.findIndex((prior) => basename(prior).toLowerCase() === name);
    if (at === -1) merged.push(doc);
    else merged[at] = doc;
  }
  return merged.length > 0 ? merged : undefined;
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
