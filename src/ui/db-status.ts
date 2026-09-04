/**
 * "Is the database ready?" — the fourth sibling of `keys.ts` / `models.ts` /
 * `checks.ts`, asking about the one backend a run verifies against instead of
 * a model role.
 *
 * Three facts on one card, kept separate because they are different kinds of
 * knowledge:
 *
 * - **Configured** — what `WOWLIDATOR_DB_URL` resolves to, shown masked
 *   (`maskDsn`; the password characters never reach the page, same rule as
 *   API keys). This is wowlidator's own configuration.
 * - **Probed** — whether that configuration answers, on a click and never on
 *   a poll (`checks.ts`'s rule: the page polls every few seconds, and a
 *   connection opened per poll is a connection held against someone's
 *   database for asking whether it is there). The probe is `doctor`'s db
 *   line run in-process: connect read-only, introspect, count tables, close.
 * - **Hinted** — what the registered repositories' own files say their
 *   database is (`context/db-hint.ts`), shown so "no database configured"
 *   comes with "…but the repo you scanned declares postgres on
 *   localhost:5432/HRCenter — set WOWLIDATOR_DB_URL". A hint is never
 *   connected to; the password is never read from the repo. Configuring the
 *   DSN stays the person's own act, in `.env`, with their eyes on it.
 */

import { connectDb, defaultDbConfig, maskDsn, restoreDbConfig } from '../db/client.js';
import type { DbHint } from '../context/db-hint.js';
import { listRepos } from '../context/repo-registry.js';

/** One repo's hint, labelled with whose word it is. */
export interface RepoDbHint extends DbHint {
  repo: string;
}

export interface DbProbeResult {
  ok: boolean;
  /** "read-only session up in 431ms — 386 table(s) visible", or the refusal. */
  detail: string;
  tables: number | null;
  at: string;
}

export interface DbStatusView {
  configured: boolean;
  /** Masked DSN — the password is `***` before it leaves this process. */
  maskedUrl: string | null;
  host: string | null;
  port: number | null;
  database: string | null;
  user: string | null;
  /** Whether the configured DSN carries a password (never the characters). */
  passwordSet: boolean;
  /** Last probe, until the config it was about changes. */
  probe: DbProbeResult | null;
  checking: boolean;
  /** What scanned repositories say their database is. */
  hints: RepoDbHint[];
  /** Whether a WRITE credential for the baseline restore is configured, masked. */
  restore: { configured: boolean; maskedUrl: string | null };
}

export class DbStatus {
  #last: DbProbeResult | null = null;
  /** The DSN the last probe was about — a changed config drops the verdict. */
  #lastUrl: string | null = null;
  #inFlight: Promise<DbProbeResult> | null = null;

  async describe(): Promise<DbStatusView> {
    const config = defaultDbConfig();
    const url = config?.url ?? null;
    if (url !== this.#lastUrl) this.#last = null; // never show a verdict about a different database
    let parsed: URL | null = null;
    if (url !== null) {
      try {
        parsed = new URL(url);
      } catch {
        parsed = null;
      }
    }
    const hints: RepoDbHint[] = [];
    for (const repo of await listRepos().catch(() => [])) {
      if (repo.dbHint !== undefined) hints.push({ ...repo.dbHint, repo: repo.slug });
    }
    return {
      configured: url !== null,
      maskedUrl: url === null ? null : maskDsn(url),
      host: parsed === null || parsed.hostname === '' ? null : parsed.hostname,
      port: parsed === null || parsed.port === '' ? (parsed !== null ? 5432 : null) : Number(parsed.port),
      database: parsed === null ? null : parsed.pathname.replace(/^\//, '') || null,
      user: parsed === null || parsed.username === '' ? null : decodeURIComponent(parsed.username),
      passwordSet: parsed !== null && parsed.password !== '',
      probe: this.#last,
      checking: this.#inFlight !== null,
      hints,
      restore: (() => {
        const rc = restoreDbConfig();
        return { configured: rc !== null, maskedUrl: rc?.url ? maskDsn(rc.url) : null };
      })(),
    };
  }

  /** One real connection, on a click. A second click joins the first. */
  async check(): Promise<DbProbeResult> {
    if (this.#inFlight !== null) return this.#inFlight;
    const started = this.#run().finally(() => {
      this.#inFlight = null;
    });
    this.#inFlight = started;
    return started;
  }

  async #run(): Promise<DbProbeResult> {
    const config = defaultDbConfig();
    const at = new Date().toISOString();
    if (config === null) {
      const result: DbProbeResult = {
        ok: false,
        detail: 'WOWLIDATOR_DB_URL is not set — database checks in flows will be blocked, not failed',
        tables: null,
        at,
      };
      this.#last = result;
      this.#lastUrl = null;
      return result;
    }
    const startedAt = Date.now();
    try {
      const client = await connectDb(config);
      try {
        const schema = await client.introspect();
        const result: DbProbeResult = {
          ok: true,
          detail: `read-only session up in ${Date.now() - startedAt}ms — ${schema.tables.length} table(s) visible`,
          tables: schema.tables.length,
          at,
        };
        this.#last = result;
        this.#lastUrl = config.url ?? null;
        return result;
      } finally {
        await client.close().catch(() => undefined);
      }
    } catch (error) {
      const result: DbProbeResult = {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
        tables: null,
        at,
      };
      this.#last = result;
      this.#lastUrl = config.url ?? null;
      return result;
    }
  }
}
