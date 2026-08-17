/**
 * Persistent store for selectors repaired by the JIT healer.
 *
 * The cache is the bridge between the two planes: the control plane writes a
 * repair once (paying tokens), and every subsequent run resolves it from disk
 * at $0 cost. Keys are scoped by page URL so the same selector string can heal
 * differently on different screens.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export const CACHE_FILE_VERSION = 1;
export const DEFAULT_CACHE_FILENAME = 'healed-selectors.json';

/** A single repaired selector, as persisted to `healed-selectors.json`. */
export interface HealedSelectorEntry {
  /** Cache key — `${scopedUrl} :: ${original}`. */
  key: string;
  /** The selector the test author wrote, which stopped resolving. */
  original: string;
  /** The replacement selector the healer produced and verified. */
  healed: string;
  /** Which locator family the healer chose (role, text, css, …). */
  strategy: string;
  /** Page URL, normalised to `origin + pathname`. */
  url: string;
  /** Healer self-reported confidence, clamped to 0–1. */
  confidence: number;
  /** One-line justification, kept for human review of the cache file. */
  reasoning: string;
  /** Model id that produced the repair, e.g. `claude-haiku-4-5`. */
  model: string;
  healedAt: string;
  lastUsedAt: string;
  /** Number of runs that resolved this entry from cache. */
  hits: number;
}

export interface HealedSelectorCacheFile {
  version: number;
  updatedAt: string;
  entries: Record<string, HealedSelectorEntry>;
}

export interface CacheManagerOptions {
  /** Path to the JSON cache file. Defaults to `./healed-selectors.json`. */
  filePath?: string;
  /** Emit a warning to stderr when the cache file is unreadable. Default true. */
  warn?: boolean;
}

/** Reduce a URL to `origin + pathname` so query strings don't fragment the cache. */
export function scopeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.length > 1 ? parsed.pathname.replace(/\/+$/, '') : parsed.pathname;
    return `${parsed.origin}${path}`;
  } catch {
    return url;
  }
}

export class CacheManager {
  readonly filePath: string;

  readonly #warn: boolean;
  #entries = new Map<string, HealedSelectorEntry>();
  #dirty = false;
  #loaded = false;

  constructor(options: CacheManagerOptions = {}) {
    this.filePath = resolve(options.filePath ?? DEFAULT_CACHE_FILENAME);
    this.#warn = options.warn ?? true;
  }

  /** Build the cache key for a selector observed on a given page. */
  static key(url: string, selector: string): string {
    return `${scopeUrl(url)} :: ${selector}`;
  }

  /**
   * Read the cache file into memory. Missing files start empty; malformed
   * files are reported and ignored rather than aborting a test run.
   */
  async load(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;

    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }

    try {
      const parsed = JSON.parse(raw) as Partial<HealedSelectorCacheFile>;
      for (const [key, entry] of Object.entries(parsed.entries ?? {})) {
        if (entry && typeof entry.healed === 'string') {
          this.#entries.set(key, entry);
        }
      }
    } catch (error) {
      if (this.#warn) {
        const detail = error instanceof Error ? error.message : String(error);
        process.stderr.write(
          `[wowlidator] ignoring unreadable selector cache at ${this.filePath}: ${detail}\n`,
        );
      }
    }
  }

  get(key: string): HealedSelectorEntry | undefined {
    return this.#entries.get(key);
  }

  has(key: string): boolean {
    return this.#entries.has(key);
  }

  /** Insert or replace an entry. Resets the hit counter for a new repair. */
  set(entry: Omit<HealedSelectorEntry, 'healedAt' | 'lastUsedAt' | 'hits'>): HealedSelectorEntry {
    const now = new Date().toISOString();
    const stored: HealedSelectorEntry = { ...entry, healedAt: now, lastUsedAt: now, hits: 0 };
    this.#entries.set(entry.key, stored);
    this.#dirty = true;
    return stored;
  }

  /** Mark a cached repair as used by the current run. */
  recordUse(key: string): void {
    const entry = this.#entries.get(key);
    if (!entry) return;
    entry.hits += 1;
    entry.lastUsedAt = new Date().toISOString();
    this.#dirty = true;
  }

  delete(key: string): boolean {
    const deleted = this.#entries.delete(key);
    if (deleted) this.#dirty = true;
    return deleted;
  }

  clear(): void {
    if (this.#entries.size === 0) return;
    this.#entries.clear();
    this.#dirty = true;
  }

  entries(): HealedSelectorEntry[] {
    return [...this.#entries.values()];
  }

  get size(): number {
    return this.#entries.size;
  }

  /** Persist to disk if anything changed. Writes via temp file + rename. */
  async flush(): Promise<void> {
    if (!this.#dirty) return;

    const payload: HealedSelectorCacheFile = {
      version: CACHE_FILE_VERSION,
      updatedAt: new Date().toISOString(),
      entries: Object.fromEntries(
        [...this.#entries.entries()].sort(([a], [b]) => a.localeCompare(b)),
      ),
    };

    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await rename(tmp, this.filePath);
    this.#dirty = false;
  }
}
