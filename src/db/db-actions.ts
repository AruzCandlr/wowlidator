/**
 * The DB verification actions — `ApiActions`' sibling, same constitution.
 *
 * They live here rather than on the runner because they are a group of
 * actions that needs no browser: `SmartRunner` delegates for mixed UI+DB
 * flows, `runApiFlow` uses this directly for flows that never open Chrome.
 * Nothing here touches `Page`. That constraint is the whole point — keep it.
 *
 * Two rules outrank everything else in this file:
 *
 * - **State, never wording that claims interaction.** A row that changed
 *   while the flow ran is evidence the backend's *effect* happened; only
 *   `expectDbCalled` (statement statistics) speaks about calls, and it says
 *   "correlational" out loud. The strong form of attribution is a `where`
 *   keyed on a `{{variable}}` the run itself saved — an id the API handed
 *   this run is causally tied to it.
 * - **No SQL from the flow, ever.** Every assertion compiles to a
 *   parameterized SELECT built here, from identifiers validated against the
 *   introspected schema. A table the schema does not declare is refused —
 *   grounding and injection defense in one move, enforced structurally.
 */

import type { ProofBundleBuilder, DefectCategory, DefectSeverity } from '../engine/proof-bundle.js';
import type { VariableStore } from '../api/variables.js';
import {
  DbGroundingError,
  DbUnavailableError,
  connectDb,
  type DbClient,
  type DbConfig,
  type DbSchema,
  type DbTable,
} from './client.js';
import { redactRows, redactWhereSummary } from './redact-row.js';

/** A value a flow may compare a column against. */
export type FlowDbValue = string | number | boolean | null;

export interface FlowDbSnapshotSpec {
  tables: string[];
  /** Name later deltas refer to. Defaults to `before`. */
  as?: string | undefined;
  intent?: string | undefined;
}

export interface FlowDbRowSpec {
  table: string;
  /** Column → value. Prefer a `{{variable}}` the run saved — that is causal. */
  where: Record<string, FlowDbValue>;
  /** Additional column values the matched row(s) must hold. */
  values?: Record<string, FlowDbValue> | undefined;
  /** Exact number of matching rows; omitted means "at least one". */
  count?: number | undefined;
  /** Eventual-consistency allowance — the check polls until this expires. */
  timeoutMs?: number | undefined;
  intent?: string | undefined;
}

export interface FlowDbDeltaSpec {
  table: string;
  /** Expected change in row count since the named snapshot. */
  delta: number;
  since?: string | undefined;
  timeoutMs?: number | undefined;
  intent?: string | undefined;
}

export interface FlowDbUnchangedSpec {
  tables: string[];
  since?: string | undefined;
  intent?: string | undefined;
}

export interface FlowDbCalledSpec {
  /** Case-insensitive substring of the normalized statement, e.g. `INSERT INTO orders`. */
  match: string;
  since?: string | undefined;
  /** Exact number of executions since the snapshot. */
  delta?: number | undefined;
  /** Minimum executions since the snapshot. Ignored when `delta` is set. */
  atLeast?: number | undefined;
  timeoutMs?: number | undefined;
  intent?: string | undefined;
}

/**
 * The stored form of one DB check. Lives here because this module owns what
 * a check *is*; the bundle only carries it — the `RequestRecord` rule.
 * Everything in it is already redacted.
 */
export interface DbCheckRecord {
  kind: 'snapshot' | 'row' | 'delta' | 'unchanged' | 'called';
  table?: string | undefined;
  tables?: string[] | undefined;
  /** Redacted `col = value AND …` summary of the where clause. */
  where?: string | undefined;
  expected?: string | undefined;
  observed?: string | undefined;
  /** Redacted sample of matched/nearby rows, capped at `DB_EVIDENCE_MAX_ROWS`. */
  rows?: Record<string, string>[] | undefined;
  durationMs: number;
  /** Set when the check only passed after polling — eventual consistency, on the record. */
  polledMs?: number | undefined;
  /** Disclosed limitation or context for this check. */
  note?: string | undefined;
}

export interface DbActionsOptions {
  /** Connection config; `null` means none configured (steps become environment errors). */
  db: DbConfig | null;
  /** Pre-built client — the test/embedder seam. Wins over `db` when set. */
  client?: DbClient | null | undefined;
  bundle: ProofBundleBuilder;
  /** The run's shared store — `{{orderId}}` saved by a request keys rows here. */
  variables: VariableStore;
  currentUrl?: (() => string | null) | undefined;
  recordDefect?:
    | ((category: DefectCategory, severity: DefectSeverity, title: string, detail: string) => void)
    | undefined;
}

/** How long a row/delta check keeps polling by default. Author-overridable. */
export const DEFAULT_DB_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 250;
/** How many where-matches a values/evidence read will fetch. */
const ROW_FETCH_LIMIT = 25;

const COUNT_NOTE =
  'count-based: an UPDATE that changes values without changing row count is invisible to this check';
const CORRELATION_NOTE =
  'read directly from the database while this flow ran — on a shared database, other writers count too';

/**
 * Quote an identifier that has already passed the schema-membership gate.
 * Doubled quotes are the SQL escape; membership is what makes this safe, the
 * quoting only makes it correct.
 */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * `"id = {{orderId}} AND status = pending"` → `{ id: '{{orderId}}', status:
 * 'pending' }` — the flat authored form of a where/values map, narrowed here.
 * The model writes one string because a generated schema stays flat; hand-
 * written flows and MCP input use the structured record directly. Values stay
 * strings (`looseEquals` compares stringily anyway); a literal `NULL` means
 * SQL null. Returns null when any clause fails to parse — an unusable step,
 * never a guessed one.
 */
export function parseDbConditions(text: string): Record<string, FlowDbValue> | null {
  const trimmed = text.trim();
  if (trimmed === '') return {};
  const out: Record<string, FlowDbValue> = {};
  for (const clause of splitConditions(trimmed)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/.exec(clause.trim());
    if (!match?.[1] || match[2] === undefined) return null;
    const rawValue = match[2].trim();
    const unquoted =
      (rawValue.startsWith("'") && rawValue.endsWith("'")) ||
      (rawValue.startsWith('"') && rawValue.endsWith('"'))
        ? rawValue.slice(1, -1)
        : rawValue;
    out[match[1]] = unquoted.toUpperCase() === 'NULL' ? null : unquoted;
  }
  return out;
}

/** Split on ` AND ` — outside quotes, so a quoted value may contain the word. */
function splitConditions(text: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | null = null;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (quote !== null) {
      current += ch;
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      i += 1;
      continue;
    }
    const rest = /^\s+AND\s+/i.exec(text.slice(i));
    if (rest) {
      parts.push(current);
      current = '';
      i += rest[0].length;
      continue;
    }
    current += ch;
    i += 1;
  }
  parts.push(current);
  return parts;
}

/** The one comparison rule for expected-vs-actual cell values. */
export function looseEquals(expected: FlowDbValue, actual: unknown): boolean {
  if (expected === null) return actual === null || actual === undefined;
  if (actual === null || actual === undefined) return false;
  const rendered = actual instanceof Date ? actual.toISOString() : String(actual);
  return rendered === String(expected);
}

interface SnapshotData {
  at: string;
  counts: Map<string, number>;
  /** `queryid → {query, calls}` from pg_stat_statements, or null when unreadable. */
  statements: Map<string, { query: string; calls: number }> | null;
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message.split('\n')[0] ?? error.message;
  return String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class DbActions {
  readonly #config: DbConfig | null;
  readonly #injected: DbClient | null;
  readonly #bundle: ProofBundleBuilder;
  readonly #variables: VariableStore;
  readonly #currentUrl: () => string | null;
  readonly #recordDefect: (
    category: DefectCategory,
    severity: DefectSeverity,
    title: string,
    detail: string,
  ) => void;

  #client: DbClient | null = null;
  /** Cached, including as a rejection — a dead DB fails each step fast, once. */
  #connecting: Promise<DbClient> | null = null;
  #schema: DbSchema | null = null;
  readonly #snapshots = new Map<string, SnapshotData>();

  constructor(options: DbActionsOptions) {
    this.#config = options.db;
    this.#injected = options.client ?? null;
    this.#bundle = options.bundle;
    this.#variables = options.variables;
    this.#currentUrl = options.currentUrl ?? (() => null);
    this.#recordDefect = options.recordDefect ?? (() => undefined);
  }

  /** Take named row counts (and statement stats, opportunistically). */
  async dbSnapshot(spec: FlowDbSnapshotSpec): Promise<void> {
    const name = spec.as ?? 'before';
    await this.#check('dbSnapshot', spec.intent, async () => {
      const client = await this.#ensureClient();
      const counts = new Map<string, number>();
      for (const table of spec.tables) {
        const declared = await this.#requireTable(table);
        counts.set(declared.name, await this.#countRows(client, declared.name, {}));
      }
      const statements = await this.#readStatements(client).catch(() => null);
      this.#snapshots.set(name, { at: new Date().toISOString(), counts, statements });

      return {
        record: {
          kind: 'snapshot',
          tables: [...counts.keys()],
          observed: [...counts.entries()].map(([t, n]) => `${t}=${n}`).join(', '),
          note:
            statements === null
              ? 'statement statistics were not readable (pg_stat_statements absent or not permitted) — expectDbCalled against this snapshot will be blocked'
              : undefined,
        },
        detail: { snapshot: name },
      };
    });
  }

  /** Assert row(s) matching `where` (and `values`) exist — polling through the budget. */
  async expectDbRow(spec: FlowDbRowSpec): Promise<void> {
    await this.#check('expectDbRow', spec.intent, async () => {
      const client = await this.#ensureClient();
      const table = await this.#requireTable(spec.table);
      const where = this.#variables.interpolateDeep({ ...spec.where });
      const values = spec.values ? this.#variables.interpolateDeep({ ...spec.values }) : undefined;
      this.#requireColumns(table, Object.keys(where));
      if (values) this.#requireColumns(table, Object.keys(values));

      const deadline = Date.now() + (spec.timeoutMs ?? DEFAULT_DB_TIMEOUT_MS);
      const started = Date.now();
      let polledMs: number | undefined;

      for (;;) {
        const whereCount = await this.#countRows(client, table.name, where);
        let matches = whereCount;
        let rows: Record<string, unknown>[] = [];

        if (values !== undefined || whereCount > 0) {
          rows = await this.#fetchRows(client, table.name, where);
        }
        if (values !== undefined) {
          if (whereCount > ROW_FETCH_LIMIT) {
            throw new DbGroundingError(
              `"${table.name}" has ${whereCount} rows matching the where clause — too many to ` +
                `verify values against (limit ${ROW_FETCH_LIMIT}). Narrow the where, ideally with a ` +
                '{{variable}} the run saved.',
            );
          }
          matches = rows.filter((row) =>
            Object.entries(values).every(([column, expected]) => looseEquals(expected, row[column])),
          ).length;
        }

        const wanted = spec.count;
        const passed = wanted === undefined ? matches >= 1 : matches === wanted;
        if (passed) {
          const waited = Date.now() - started;
          if (waited > POLL_INTERVAL_MS) polledMs = waited;
          return {
            record: {
              kind: 'row',
              table: table.name,
              where: redactWhereSummary(where),
              expected: wanted === undefined ? 'at least 1 row' : `exactly ${wanted} row(s)`,
              observed: `${matches} row(s)`,
              rows: redactRows(rows),
              polledMs,
              note: CORRELATION_NOTE,
            },
            detail: { table: table.name },
          };
        }

        if (Date.now() >= deadline) {
          throw new DbCheckFailure(
            `expected ${wanted === undefined ? 'at least 1 row' : `exactly ${wanted} row(s)`} in ` +
              `"${table.name}" where ${redactWhereSummary(where)}; found ${matches} ` +
              `(polled ${Date.now() - started}ms)`,
            {
              kind: 'row',
              table: table.name,
              where: redactWhereSummary(where),
              expected: wanted === undefined ? 'at least 1 row' : `exactly ${wanted} row(s)`,
              observed: `${matches} row(s)`,
              rows: redactRows(rows),
              note: CORRELATION_NOTE,
            },
          );
        }
        await sleep(POLL_INTERVAL_MS);
      }
    });
  }

  /** Assert a table's row count moved by exactly `delta` since a snapshot. */
  async expectDbDelta(spec: FlowDbDeltaSpec): Promise<void> {
    await this.#check('expectDbDelta', spec.intent, async () => {
      const client = await this.#ensureClient();
      const table = await this.#requireTable(spec.table);
      const before = this.#requireSnapshot(spec.since);
      const prior = before.counts.get(table.name);
      if (prior === undefined) {
        throw new DbGroundingError(
          `snapshot "${spec.since ?? 'before'}" did not include "${table.name}" — add it to the ` +
            "dbSnapshot step's tables",
        );
      }

      const deadline = Date.now() + (spec.timeoutMs ?? DEFAULT_DB_TIMEOUT_MS);
      const started = Date.now();
      for (;;) {
        const now = await this.#countRows(client, table.name, {});
        const observed = now - prior;
        if (observed === spec.delta) {
          const waited = Date.now() - started;
          return {
            record: {
              kind: 'delta',
              table: table.name,
              expected: `${spec.delta >= 0 ? '+' : ''}${spec.delta} row(s)`,
              observed: `${observed >= 0 ? '+' : ''}${observed} (${prior} → ${now})`,
              polledMs: waited > POLL_INTERVAL_MS ? waited : undefined,
              note: CORRELATION_NOTE,
            },
            detail: { table: table.name },
          };
        }
        // Keep polling only while undershooting an increase (or overshooting a
        // decrease): a count already past the target will not come back.
        const undershooting = spec.delta >= 0 ? observed < spec.delta : observed > spec.delta;
        if (!undershooting || Date.now() >= deadline) {
          throw new DbCheckFailure(
            `expected "${table.name}" to change by ${spec.delta} row(s) since snapshot ` +
              `"${spec.since ?? 'before'}"; it changed by ${observed} (${prior} → ${now})`,
            {
              kind: 'delta',
              table: table.name,
              expected: `${spec.delta >= 0 ? '+' : ''}${spec.delta} row(s)`,
              observed: `${observed >= 0 ? '+' : ''}${observed} (${prior} → ${now})`,
              note: CORRELATION_NOTE,
            },
          );
        }
        await sleep(POLL_INTERVAL_MS);
      }
    });
  }

  /** Assert row counts did not move since a snapshot — the accidental-write catch. */
  async expectDbUnchanged(spec: FlowDbUnchangedSpec): Promise<void> {
    await this.#check('expectDbUnchanged', spec.intent, async () => {
      const client = await this.#ensureClient();
      const before = this.#requireSnapshot(spec.since);
      const changed: string[] = [];
      const observed: string[] = [];
      for (const name of spec.tables) {
        const table = await this.#requireTable(name);
        const prior = before.counts.get(table.name);
        if (prior === undefined) {
          throw new DbGroundingError(
            `snapshot "${spec.since ?? 'before'}" did not include "${table.name}" — add it to the ` +
              "dbSnapshot step's tables",
          );
        }
        const now = await this.#countRows(client, table.name, {});
        observed.push(`${table.name}=${now}`);
        if (now !== prior) changed.push(`${table.name} (${prior} → ${now})`);
      }

      if (changed.length > 0) {
        throw new DbCheckFailure(
          `expected no row-count change in ${spec.tables.join(', ')}; changed: ${changed.join('; ')}`,
          {
            kind: 'unchanged',
            tables: [...spec.tables],
            expected: 'no row-count change',
            observed: changed.join('; '),
            note: `${COUNT_NOTE}; ${CORRELATION_NOTE}`,
          },
        );
      }
      return {
        record: {
          kind: 'unchanged',
          tables: [...spec.tables],
          expected: 'no row-count change',
          observed: observed.join(', '),
          note: `${COUNT_NOTE}; ${CORRELATION_NOTE}`,
        },
        detail: {},
      };
    });
  }

  /**
   * Assert statements matching `match` executed since a snapshot — via
   * `pg_stat_statements`, the light "called as planned" tier. Statement-level
   * and correlational, and the record says both.
   */
  async expectDbCalled(spec: FlowDbCalledSpec): Promise<void> {
    await this.#check('expectDbCalled', spec.intent, async () => {
      const client = await this.#ensureClient();
      const before = this.#requireSnapshot(spec.since);
      if (before.statements === null) {
        throw new DbUnavailableError(
          `statement statistics were not readable when snapshot "${spec.since ?? 'before'}" was ` +
            'taken — enable the pg_stat_statements extension (and grant read on it) to use expectDbCalled',
        );
      }
      const prior = before.statements;
      const needle = spec.match.toLowerCase();
      const deadline = Date.now() + (spec.timeoutMs ?? DEFAULT_DB_TIMEOUT_MS);
      const started = Date.now();

      for (;;) {
        const now = await this.#readStatements(client);
        let observed = 0;
        let resets = false;
        const matched: string[] = [];
        for (const [queryid, entry] of now) {
          if (!entry.query.toLowerCase().includes(needle)) continue;
          const priorCalls = prior.get(queryid)?.calls ?? 0;
          const delta = entry.calls - priorCalls;
          if (delta < 0) {
            resets = true;
            continue;
          }
          if (delta > 0 && matched.length < 3) matched.push(entry.query.slice(0, 120));
          observed += delta;
        }

        const note =
          `statement-level and correlational: normalized statements, counted while this flow ran — ` +
          `on a shared database other clients count too` +
          (resets ? '; statistics were reset mid-window, so this count is a floor' : '');
        const target = spec.delta ?? spec.atLeast ?? 1;
        const passed = spec.delta !== undefined ? observed === spec.delta : observed >= target;

        if (passed) {
          const waited = Date.now() - started;
          return {
            record: {
              kind: 'called',
              expected:
                spec.delta !== undefined
                  ? `exactly ${spec.delta} execution(s) of "${spec.match}"`
                  : `at least ${target} execution(s) of "${spec.match}"`,
              observed: `${observed} execution(s)`,
              rows: matched.length > 0 ? matched.map((query) => ({ statement: query })) : undefined,
              polledMs: waited > POLL_INTERVAL_MS ? waited : undefined,
              note,
            },
            detail: { match: spec.match },
          };
        }

        const undershooting = observed < target;
        if (!undershooting || Date.now() >= deadline) {
          throw new DbCheckFailure(
            `expected ${
              spec.delta !== undefined
                ? `exactly ${spec.delta}`
                : `at least ${target}`
            } execution(s) of a statement matching "${spec.match}" since snapshot ` +
              `"${spec.since ?? 'before'}"; observed ${observed}`,
            {
              kind: 'called',
              expected:
                spec.delta !== undefined
                  ? `exactly ${spec.delta} execution(s) of "${spec.match}"`
                  : `at least ${target} execution(s) of "${spec.match}"`,
              observed: `${observed} execution(s)`,
              note,
            },
          );
        }
        await sleep(POLL_INTERVAL_MS);
      }
    });
  }

  async close(): Promise<void> {
    const client = this.#client;
    this.#client = null;
    this.#connecting = null;
    if (client && client !== this.#injected) await client.close().catch(() => undefined);
  }

  // --- plumbing ------------------------------------------------------------

  async #ensureClient(): Promise<DbClient> {
    if (this.#client) return this.#client;
    if (!this.#connecting) {
      this.#connecting = this.#injected
        ? Promise.resolve(this.#injected)
        : this.#config
          ? connectDb(this.#config)
          : Promise.reject(
              new DbUnavailableError(
                'no connection is configured — set WOWLIDATOR_DB_URL to a postgres:// connection string',
              ),
            );
      // A rejected promise stays cached: a dead database fails each later
      // step immediately instead of re-paying a connection timeout per step.
      this.#connecting.catch(() => undefined);
    }
    this.#client = await this.#connecting;
    return this.#client;
  }

  async #ensureSchema(client: DbClient): Promise<DbSchema> {
    if (this.#schema) return this.#schema;
    try {
      this.#schema = await client.introspect();
    } catch (error) {
      throw new DbUnavailableError(`could not read the schema: ${describe(error)}`);
    }
    return this.#schema;
  }

  /** The grounding gate: a table the schema does not declare is refused. */
  async #requireTable(name: string): Promise<DbTable> {
    const client = await this.#ensureClient();
    const schema = await this.#ensureSchema(client);
    const table = schema.tables.find((t) => t.name === name);
    if (!table) {
      const known = schema.tables.map((t) => t.name).slice(0, 20).join(', ');
      throw new DbGroundingError(
        `"${name}" is not in the schema. Declared tables: ${known || '(none found)'}`,
      );
    }
    return table;
  }

  #requireColumns(table: DbTable, columns: readonly string[]): void {
    const declared = new Set(table.columns.map((c) => c.name));
    for (const column of columns) {
      if (!declared.has(column)) {
        throw new DbGroundingError(
          `"${table.name}" has no column "${column}". Declared: ${table.columns
            .map((c) => c.name)
            .join(', ')}`,
        );
      }
    }
  }

  #requireSnapshot(name: string | undefined): SnapshotData {
    const key = name ?? 'before';
    const snapshot = this.#snapshots.get(key);
    if (!snapshot) {
      throw new DbGroundingError(
        `no snapshot named "${key}" — add a dbSnapshot step (as: "${key}") to setup before ` +
          'diffing against it. Explicit beats an implicit baseline nobody can audit.',
      );
    }
    return snapshot;
  }

  #buildWhere(where: Record<string, FlowDbValue>): { clause: string; params: unknown[] } {
    const parts: string[] = [];
    const params: unknown[] = [];
    for (const [column, value] of Object.entries(where)) {
      if (value === null) {
        parts.push(`${quoteIdent(column)} IS NULL`);
      } else {
        params.push(value);
        parts.push(`${quoteIdent(column)} = $${params.length}`);
      }
    }
    return { clause: parts.length > 0 ? ` WHERE ${parts.join(' AND ')}` : '', params };
  }

  async #countRows(
    client: DbClient,
    table: string,
    where: Record<string, FlowDbValue>,
  ): Promise<number> {
    const built = this.#buildWhere(where);
    const result = await client.query(
      `SELECT count(*)::text AS n FROM ${quoteIdent(table)}${built.clause}`,
      built.params,
    );
    return Number(result.rows[0]?.['n'] ?? 0);
  }

  async #fetchRows(
    client: DbClient,
    table: string,
    where: Record<string, FlowDbValue>,
  ): Promise<Record<string, unknown>[]> {
    const built = this.#buildWhere(where);
    const result = await client.query(
      `SELECT * FROM ${quoteIdent(table)}${built.clause} LIMIT ${ROW_FETCH_LIMIT}`,
      built.params,
    );
    return result.rows;
  }

  async #readStatements(
    client: DbClient,
  ): Promise<Map<string, { query: string; calls: number }>> {
    const result = await client.query(
      'SELECT queryid::text AS queryid, query, calls::text AS calls FROM pg_stat_statements',
      [],
    );
    const out = new Map<string, { query: string; calls: number }>();
    for (const row of result.rows) {
      out.set(String(row['queryid']), {
        query: String(row['query'] ?? ''),
        calls: Number(row['calls'] ?? 0),
      });
    }
    return out;
  }

  /**
   * Run one check and record it — the `#assert` shape from `ApiActions`.
   * No selector, no resolution: nothing the healer could repair, and nothing
   * that should ever walk the escalation ladder.
   */
  async #check(
    action: string,
    intent: string | undefined,
    run: () => Promise<{ record: DbCheckRecord | Omit<DbCheckRecord, 'durationMs'>; detail: Record<string, unknown> }>,
  ): Promise<void> {
    const startedAt = new Date().toISOString();
    const started = Date.now();
    try {
      const outcome = await run();
      this.#record(action, intent, startedAt, Date.now() - started, {
        status: 'passed',
        detail: { ...outcome.detail, intent },
        db: { ...outcome.record, durationMs: Date.now() - started },
      });
    } catch (error) {
      const message = describe(error);
      this.#record(action, intent, startedAt, Date.now() - started, {
        status: 'failed',
        detail: { intent },
        db:
          error instanceof DbCheckFailure
            ? { ...error.record, durationMs: Date.now() - started }
            : undefined,
        error: message,
      });
      // Environment and grounding problems are the harness's/flow's, never
      // the application's — no defect is filed for them, and the executor
      // reclassifies the step to `error` by the error's name.
      if (!(error instanceof DbUnavailableError) && !(error instanceof DbGroundingError)) {
        this.#recordDefect(
          'backend',
          'high',
          `DB check failed: ${action}`,
          `${message}\nState was ${CORRELATION_NOTE}.`,
        );
      }
      throw error;
    }
  }

  #record(
    action: string,
    intent: string | undefined,
    startedAt: string,
    durationMs: number,
    fields: {
      status: 'passed' | 'failed';
      detail?: Record<string, unknown> | undefined;
      db?: DbCheckRecord | undefined;
      error?: string | undefined;
    },
  ): void {
    this.#bundle.addStep({
      action,
      intent,
      selector: null,
      resolvedSelector: null,
      // Null, not 'fast' — same rule as `ApiActions`: `fastPath` counts
      // selector resolutions on a page, and a SQL read resolved nothing there.
      resolution: null,
      status: fields.status,
      startedAt,
      durationMs,
      url: this.#currentUrl(),
      detail: fields.detail,
      db: fields.db,
      error: fields.error,
    });
  }
}

/** An assertion miss that carries its evidence record with it. */
class DbCheckFailure extends Error {
  readonly record: Omit<DbCheckRecord, 'durationMs'>;
  constructor(message: string, record: Omit<DbCheckRecord, 'durationMs'>) {
    super(message);
    this.record = record;
  }
}
