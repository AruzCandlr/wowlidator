/**
 * Reading proof bundles off disk, for wowUI.
 *
 * The control panel's other browse tabs read one file each — the history
 * JSONL, the cache JSON. wowUI is built around the bundles themselves, because
 * they are the only artefact that carries *evidence*: a step's screenshot, the
 * calls the page made while it was waiting, the repair the healer proposed.
 * The rendered HTML report has all of that too, but as a document to look at
 * rather than data to group, so a "which of these eleven runs of this flow was
 * the one that broke" view cannot be built out of it.
 *
 * Two things here exist because a bundle is big:
 *
 * - **The list never carries steps.** A run with screenshots on every step is
 *   comfortably a few megabytes, and the list view shows none of it. `toCard`
 *   is the projection, and `/api/proofs` returns nothing else.
 * - **Parsed bundles are cached on `path + mtime + size`.** The page polls, and
 *   re-reading a directory of multi-megabyte JSON every few seconds to
 *   redisplay the same numbers would make the panel the slowest thing on the
 *   machine. A changed file has a changed signature, so a stale card is not a
 *   failure mode this can have.
 *
 * A run is addressed by its `runId`, never by a path from the client. The
 * lookup goes through the index this module builds, so there is no join of
 * user input onto a directory to get wrong — the same reasoning that keeps
 * `isAllowed` in `server.ts`, applied by making the question not arise.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { ProofBundle, TierSummary } from '../engine/proof-bundle.js';

/** Bundles read for one listing. Beyond this, the oldest are not shown. */
const DEFAULT_LIMIT = 150;

/** A bundle larger than this is listed but not parsed — something is wrong with it. */
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;

/**
 * What the list view needs, and nothing that would make it heavy.
 *
 * Every field is either shown on a row or decides how the row looks. The steps,
 * the screenshots, the network calls and the heal records stay on disk until
 * someone opens a run.
 */
export interface ProofCard {
  runId: string;
  name: string;
  status: 'passed' | 'failed' | 'error' | 'dead-end';
  quarantined: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  totalSteps: number;
  passed: number;
  failed: number;
  defects: number;
  /** Repairs that cost tokens. A row whose count is climbing is drifting. */
  jitHeals: number;
  caseRetries: number;
  cacheHits: number;
  dialogsDismissed: number;
  networkFailures: number;
  /** Steps that declined to heal because a request had already failed. */
  backendBlocked: number;
  frontend: TierSummary;
  backend: TierSummary;
  /** 0–1, or null when the page had no controls to measure against. */
  coverage: number | null;
  trend: string | null;
  trendMessage: string | null;
  /** Set when a model wrote this flow rather than a person. */
  generatedBy: { model: string; sourceUrl: string; kind: string } | null;
  /** Whether opening this run will show any pictures. */
  hasEvidence: boolean;
  error: string | null;
  path: string;
}

export interface ProofIndex {
  cards: ProofCard[];
  /** `runId` → the file it was read from. The only path→run mapping wowUI has. */
  paths: Map<string, string>;
  dir: string;
  /** Files that are JSON but not a bundle, or unreadable. Reported, not hidden. */
  skipped: number;
}

export function toCard(bundle: ProofBundle, path: string): ProofCard {
  return {
    runId: bundle.runId,
    name: bundle.name,
    status: bundle.status,
    quarantined: bundle.quarantined === true,
    startedAt: bundle.startedAt,
    finishedAt: bundle.finishedAt,
    durationMs: bundle.durationMs,
    totalSteps: bundle.summary.totalSteps,
    passed: bundle.summary.passed,
    failed: bundle.summary.failed,
    defects: bundle.summary.defects,
    jitHeals: bundle.summary.jitHeals,
    caseRetries: bundle.summary.caseRetries,
    cacheHits: bundle.summary.cacheHits,
    dialogsDismissed: bundle.summary.dialogsDismissed,
    networkFailures: bundle.summary.networkFailures,
    backendBlocked: bundle.summary.backendBlocked,
    frontend: bundle.summary.frontend,
    backend: bundle.summary.backend,
    coverage: bundle.coverage?.ratio ?? null,
    trend: bundle.trend?.verdict ?? null,
    trendMessage: bundle.trend?.message ?? null,
    generatedBy:
      bundle.generatedBy === undefined
        ? null
        : {
            model: bundle.generatedBy.model,
            sourceUrl: bundle.generatedBy.sourceUrl,
            kind: bundle.generatedBy.kind,
          },
    // A filmed run has evidence for every step even when only its failures
    // carry a still, so asking about screenshots alone would report the
    // richest runs as having none.
    hasEvidence:
      bundle.video?.data !== undefined || bundle.steps.some((s) => s.screenshot !== undefined),
    error: bundle.error ?? null,
    path,
  };
}

/** Enough of a bundle to be worth showing. A JSON file that isn't one is skipped. */
function looksLikeBundle(value: unknown): value is ProofBundle {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ProofBundle>;
  return (
    typeof candidate.runId === 'string' &&
    typeof candidate.name === 'string' &&
    Array.isArray(candidate.steps) &&
    typeof candidate.summary === 'object'
  );
}

interface CacheEntry {
  signature: string;
  bundle: ProofBundle;
}

/**
 * Bundles already parsed, keyed by path.
 *
 * Module-level rather than per-request: the page polls, and the point of the
 * cache is that the second poll costs a `stat` per file instead of a parse.
 */
const cache = new Map<string, CacheEntry>();

async function readBundle(path: string, signature: string): Promise<ProofBundle | null> {
  const cached = cache.get(path);
  if (cached?.signature === signature) return cached.bundle;

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
  if (!looksLikeBundle(parsed)) return null;

  cache.set(path, { signature, bundle: parsed });
  return parsed;
}

/**
 * Every bundle under `dir`, newest first.
 *
 * The walk is shallow and bounded because the proof directory is ours: bundles
 * land in it directly, and a deep tree there means someone has pointed the
 * config at a directory that is not one.
 */
export async function readProofIndex(dir: string, limit = DEFAULT_LIMIT): Promise<ProofIndex> {
  const root = resolve(dir);
  const files: { path: string; signature: string; mtimeMs: number }[] = [];

  async function walk(current: string, depth: number): Promise<void> {
    if (depth > 3) return;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.name.endsWith('.json')) {
        const info = await stat(full).catch(() => null);
        if (!info || info.size > MAX_BUNDLE_BYTES) continue;
        files.push({ path: full, signature: `${info.mtimeMs}:${info.size}`, mtimeMs: info.mtimeMs });
      }
    }
  }
  await walk(root, 0);

  // Newest by mtime decides *which* runs are shown; `finishedAt` decides the
  // order they are shown in. A bundle copied onto the machine has a recent
  // mtime and an old finish time, and both of those are the truth about it.
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const considered = files.slice(0, limit);

  const cards: ProofCard[] = [];
  const paths = new Map<string, string>();
  let skipped = 0;

  for (const file of considered) {
    const bundle = await readBundle(file.path, file.signature);
    if (bundle === null) {
      skipped += 1;
      continue;
    }
    cards.push(toCard(bundle, file.path));
    paths.set(bundle.runId, file.path);
  }

  cards.sort((a, b) => (b.finishedAt || b.startedAt).localeCompare(a.finishedAt || a.startedAt));
  return { cards, paths, dir: root, skipped };
}

/** A run id that could not be anything but a file name. */
const SAFE_RUN_ID = /^[A-Za-z0-9._-]+$/;

async function loadIfBundle(path: string): Promise<ProofBundle | null> {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || info.size > MAX_BUNDLE_BYTES) return null;
  return readBundle(path, `${info.mtimeMs}:${info.size}`);
}

/**
 * One run, in full — steps, screenshots, heals and all.
 *
 * A bundle is written as `<proof dir>/<runId>.json`, so the fast path is to
 * look for exactly that, and it is only taken for a run id that cannot be a
 * path: no separator, no `..`, nothing to normalise. Anything else falls back
 * to the index, where the run id is matched against a bundle's *contents*
 * rather than against a file name — so a renamed or nested bundle still opens
 * and a crafted id still cannot reach outside the directory.
 */
export async function readProof(dir: string, runId: string): Promise<ProofBundle | null> {
  const root = resolve(dir);
  if (SAFE_RUN_ID.test(runId)) {
    const direct = await loadIfBundle(join(root, `${runId}.json`));
    if (direct?.runId === runId) return direct;
  }

  const index = await readProofIndex(root, Number.MAX_SAFE_INTEGER);
  const path = index.paths.get(runId);
  return path === undefined ? null : loadIfBundle(path);
}

/** Drop the parsed-bundle cache. Exists so a test does not inherit one. */
export function clearProofCache(): void {
  cache.clear();
}
