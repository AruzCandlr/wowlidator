/**
 * The database execution plane's seam.
 *
 * Structured exactly like `ApiTransport`: a small injectable interface, one
 * real implementation, so everything above it is stubbable offline and no
 * call site knows which driver answered. This is what lets the whole DB test
 * suite run with a scripted stub, and what makes a second dialect (mysql2,
 * better-sqlite3) an additive change.
 *
 * **The driver is a lazy optional import, not a dependency.** A run that
 * never executes a DB step must never demand `pg` be installed — the same
 * rule that lets a run that never heals run without an API key. A missing
 * driver throws `DbUnavailableError`, whose message the exit contract maps to
 * `EXIT.environment` and `runCases` scores as *blocked*: a check the harness
 * could not make says nothing about the application.
 *
 * **Read-only is enforced in layers, not requested nicely.** Layer 1 is
 * `db-actions.ts`, which never accepts SQL from a flow and only ever builds
 * parameterized SELECTs against schema-validated identifiers. Layer 2 is
 * here: the session is opened with `default_transaction_read_only = on`, so
 * even a bug in layer 1 cannot write. Layer 3 is documentation: point
 * wowlidator at a read-only grant. Any one of the three suffices.
 */

export interface DbColumn {
  name: string;
  type: string;
  nullable: boolean;
  pk: boolean;
}

export interface DbTable {
  name: string;
  columns: DbColumn[];
  /** Primary-key column names, in order. Empty when the table declares none. */
  pk: string[];
  /** `"user_id -> users.id"` lines, when foreign keys are declared/readable. */
  references: string[];
}

export interface DbSchema {
  tables: DbTable[];
  source: 'introspection' | 'ddl' | 'prisma';
  capturedAt?: string | undefined;
}

export interface DbResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  durationMs: number;
}

/** The seam. Same shape as `ApiTransport`: an id and a couple of methods. */
export interface DbClient {
  readonly id: string;
  /** Execute one parameterized statement. Callers only ever build SELECTs. */
  query(sql: string, params: readonly unknown[]): Promise<DbResult>;
  /** Read the live schema — the source of truth wherever a connection exists. */
  introspect(): Promise<DbSchema>;
  close(): Promise<void>;
}

export interface DbConfig {
  /** Connection string. Travels by env (`WOWLIDATOR_DB_URL`), never argv — a DSN on a command line is in `ps` for everyone. */
  url?: string | undefined;
  /** A DSN resolving to a non-loopback host is refused without this. */
  remoteOk?: boolean | undefined;
}

/**
 * The database could not be reached, the driver is not installed, or the
 * configuration refuses the connection. Always an environment fact, never an
 * application finding — the message prefix is load-bearing: `exit.ts` matches
 * "database unavailable" into `EXIT.environment`, and `neverRan` then scores
 * the case blocked rather than failed.
 */
export class DbUnavailableError extends Error {
  override readonly name = 'DbUnavailableError';
  constructor(detail: string) {
    super(`database unavailable: ${detail}`);
  }
}

/**
 * A flow referenced a table or column the schema does not declare. A flow
 * problem (or a stale schema), not an application finding — classified as an
 * `error`, and never healed or filed as a defect.
 */
export class DbGroundingError extends Error {
  override readonly name = 'DbGroundingError';
}

/** `postgres://user:secret@host/db` → `postgres://user:***@host/db`. */
export function maskDsn(dsn: string): string {
  try {
    const url = new URL(dsn);
    if (url.password !== '') url.password = '***';
    return url.toString();
  } catch {
    // Unparseable is unmaskable; show nothing rather than risk the secret.
    return '(unparseable connection string)';
  }
}

/** Loopback and socket hosts are the ones a default may touch. */
export function isLoopbackDsn(dsn: string): boolean {
  try {
    const host = new URL(dsn).hostname;
    return (
      host === '' ||
      host === 'localhost' ||
      host === '::1' ||
      host === '[::1]' ||
      host.startsWith('127.')
    );
  } catch {
    return false;
  }
}

/**
 * The RESTORE connection, from `WOWLIDATOR_DB_RESTORE_URL` — a second, separate
 * DSN on purpose: the read-only session is read-only by construction, and the
 * one thing in this directory that writes (`baseline.ts`'s restore) must be
 * opted into with a credential the operator chose for it. Null when unset.
 */
export function restoreDbConfig(): DbConfig | null {
  const url = process.env['WOWLIDATOR_DB_RESTORE_URL'];
  if (!url) return null;
  return { url, remoteOk: process.env['WOWLIDATOR_DB_REMOTE_OK'] === '1' };
}

/** Read the default DB config from env. `undefined` when none is configured. */
export function defaultDbConfig(): DbConfig | null {
  const url = process.env['WOWLIDATOR_DB_URL'];
  if (!url) return null;
  return {
    url,
    remoteOk: process.env['WOWLIDATOR_DB_REMOTE_OK'] === '1',
  };
}

/**
 * Every readable, non-system schema — not just `current_schema()`. Real
 * applications keep their tables in named schemas (`benefit_management.*`,
 * `employee_center.*` — the first multi-schema target found this), and a
 * grounding gate that only saw `public` would refuse every table the app
 * actually writes. Tables in the current schema keep their bare name so
 * existing flows read the same; every other table is addressed
 * `schema.table`, and `information_schema` already hides what the role may
 * not read.
 */
const INTROSPECT_COLUMNS = `
  SELECT c.table_schema, c.table_name, c.column_name, c.data_type, c.is_nullable
  FROM information_schema.columns c
  JOIN information_schema.tables t
    ON t.table_schema = c.table_schema AND t.table_name = c.table_name
  WHERE t.table_type = 'BASE TABLE'
    AND c.table_schema NOT IN ('pg_catalog', 'information_schema')
    AND c.table_schema NOT LIKE 'pg_toast%'
  ORDER BY c.table_schema, c.table_name, c.ordinal_position`;

const INTROSPECT_KEYS = `
  SELECT tc.table_schema, tc.table_name, kcu.column_name, tc.constraint_type,
         ccu.table_schema AS foreign_schema, ccu.table_name AS foreign_table,
         ccu.column_name AS foreign_column
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
  LEFT JOIN information_schema.constraint_column_usage ccu
    ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
  WHERE tc.table_schema NOT IN ('pg_catalog', 'information_schema')
    AND tc.constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY')`;

/** `benefit_management.benefit_plan`, or the bare name for the current schema. */
function qualifiedName(schema: string, table: string, currentSchema: string): string {
  return schema === currentSchema ? table : `${schema}.${table}`;
}

class PgDbClient implements DbClient {
  readonly id: string;
  readonly #client: import('pg').Client;

  constructor(client: import('pg').Client, id = 'pg') {
    this.#client = client;
    this.id = id;
  }

  async query(sql: string, params: readonly unknown[]): Promise<DbResult> {
    const started = Date.now();
    const result = await this.#client.query(sql, params);
    return {
      rows: result.rows,
      rowCount: result.rowCount ?? result.rows.length,
      durationMs: Date.now() - started,
    };
  }

  async introspect(): Promise<DbSchema> {
    const current = String(
      (await this.query('SELECT current_schema() AS s', [])).rows[0]?.['s'] ?? 'public',
    );
    const columns = await this.query(INTROSPECT_COLUMNS, []);
    const keys = await this.query(INTROSPECT_KEYS, []);

    const tables = new Map<string, DbTable>();
    for (const row of columns.rows) {
      const tableName = qualifiedName(String(row['table_schema']), String(row['table_name']), current);
      let table = tables.get(tableName);
      if (!table) {
        table = { name: tableName, columns: [], pk: [], references: [] };
        tables.set(tableName, table);
      }
      table.columns.push({
        name: String(row['column_name']),
        type: String(row['data_type']),
        nullable: row['is_nullable'] === 'YES',
        pk: false,
      });
    }
    for (const row of keys.rows) {
      const table = tables.get(
        qualifiedName(String(row['table_schema']), String(row['table_name']), current),
      );
      if (!table) continue;
      const columnName = String(row['column_name']);
      if (row['constraint_type'] === 'PRIMARY KEY') {
        table.pk.push(columnName);
        const column = table.columns.find((c) => c.name === columnName);
        if (column) column.pk = true;
      } else if (row['foreign_table'] !== null && row['foreign_table'] !== undefined) {
        const target = qualifiedName(
          String(row['foreign_schema'] ?? current),
          String(row['foreign_table']),
          current,
        );
        table.references.push(`${columnName} -> ${target}.${String(row['foreign_column'])}`);
      }
    }

    return {
      tables: [...tables.values()],
      source: 'introspection',
      capturedAt: new Date().toISOString(),
    };
  }

  async close(): Promise<void> {
    await this.#client.end();
  }
}

/**
 * Connect. Postgres only for now — dialects differ exactly where this design
 * is strict (identifier quoting, introspection SQL), so each new one lands
 * behind its own client rather than behind an `if`.
 */
export async function connectDb(config: DbConfig): Promise<DbClient> {
  return connectPg(config, 'read');
}

/**
 * The write-capable connection, for the baseline restore and nothing else.
 * Same driver, same remote-host refusal, no read-only layer — which is why it
 * takes its own DSN (`WOWLIDATOR_DB_RESTORE_URL`) and is never the default.
 */
export async function connectDbWritable(config: DbConfig): Promise<DbClient> {
  return connectPg(config, 'write');
}

async function connectPg(config: DbConfig, mode: 'read' | 'write'): Promise<DbClient> {
  const dsn = config.url;
  if (!dsn) {
    throw new DbUnavailableError(
      mode === 'read'
        ? 'no connection is configured — set WOWLIDATOR_DB_URL to a postgres:// connection string'
        : 'no restore connection is configured — set WOWLIDATOR_DB_RESTORE_URL to a postgres:// connection string with write access',
    );
  }
  if (!isLoopbackDsn(dsn) && config.remoteOk !== true) {
    throw new DbUnavailableError(
      `${maskDsn(dsn)} is not a loopback host. Pointing a test tool at a remote database is a ` +
        'decision to state out loud: pass --db-remote-ok (or WOWLIDATOR_DB_REMOTE_OK=1) to confirm.',
    );
  }

  let ClientCtor: (typeof import('pg'))['Client'];
  try {
    ({ Client: ClientCtor } = await import('pg'));
  } catch {
    throw new DbUnavailableError(
      'the "pg" driver is not installed. It is optional by design — install it where DB ' +
        'verification is wanted: npm install pg',
    );
  }

  const raw = new ClientCtor({ connectionString: dsn });
  try {
    await raw.connect();
    // Layer 2 of read-only: even a bug in the statement builder cannot write
    // through a session that refuses writes. (Layer 3 is a read-only grant.)
    if (mode === 'read') await raw.query('SET default_transaction_read_only = on');
  } catch (error) {
    await raw.end().catch(() => undefined);
    const detail = error instanceof Error ? error.message.split('\n')[0] : String(error);
    throw new DbUnavailableError(`could not connect to ${maskDsn(dsn)}: ${detail}`);
  }

  return new PgDbClient(raw, mode === 'read' ? 'pg' : 'pg-rw');
}
