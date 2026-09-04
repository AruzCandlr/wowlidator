/**
 * What the scanned repository says about its own database — engine, host,
 * port, database, user, and WHERE a password is defined. Never the password.
 *
 * The question this answers (asked live, 2026-08-25): "does scanning the repo
 * make the system know the database is postgres at 5432?" It did not — the
 * scan learned the *schema* (tables, via `--db-schema` or live introspection
 * through wowlidator's own `WOWLIDATOR_DB_URL`) and nothing about the
 * *connection*. The connection was configuration someone had to already have.
 * This module closes that gap as a HINT: the repo's own docker-compose,
 * `.env(.example)` and Prisma datasource are read for the connection's shape,
 * and the panel shows it next to "no database configured" so the person knows
 * exactly what to set.
 *
 * Two rules, both load-bearing:
 *
 * - **A secret never leaves the file it lives in.** A password found in a
 *   compose file or a DSN is reported as a LOCATION (`.env: DATABASE_URL`),
 *   never a value — `suggestedUrl` is built without it. Harvesting a
 *   credential out of a scanned repo and quietly connecting with it is the
 *   same class of unasked-for act as touching a real database in a test
 *   run, and the same policy applies: the person configures
 *   `WOWLIDATOR_DB_URL` themselves, with their own eyes on it.
 * - **A hint is never a connection.** Nothing here opens a socket. Detection
 *   is file-walk-and-parse, unit-tier by construction, same as the rest of
 *   the context engine.
 *
 * Parsing is deliberately pragmatic — an indent-scan of compose, a line-scan
 * of dotenv, a block-scan of Prisma — because the output is a suggestion a
 * person reads, not configuration a run trusts. A file too odd to parse
 * yields no hint rather than a wrong one.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface DbHint {
  /** 'postgres', 'mysql', … — as the repo's own files name it. */
  engine: string;
  host?: string | undefined;
  port?: number | undefined;
  database?: string | undefined;
  user?: string | undefined;
  /** Where a password is defined — file and key, NEVER the value. */
  passwordAt?: string | undefined;
  /** The file the hint was read from, relative to the repo root. */
  source: string;
  /** A ready-to-edit `WOWLIDATOR_DB_URL` suggestion, password omitted. */
  suggestedUrl?: string | undefined;
}

/** Env keys whose value is expected to be a whole connection string. */
const URL_KEY = /^(?:DATABASE|DB|POSTGRES|PG)_?(?:URL|URI|CONNECTION(?:_STRING)?)$/i;
const URL_SCHEME = /^(postgres(?:ql)?|mysql|mariadb|mssql|sqlserver):\/\//i;

function engineOf(scheme: string): string {
  const s = scheme.toLowerCase();
  if (s.startsWith('postgres')) return 'postgres';
  if (s === 'mariadb') return 'mysql';
  return s;
}

/** `KEY=value` / `KEY: value` lines of a dotenv-shaped file, quotes stripped. */
function dotenvEntries(text: string): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    out.push({ key: m[1]!, value: m[2]!.trim().replace(/^["']|["']$/g, '') });
  }
  return out;
}

/** A hint from one connection-string value; null when it is not one. */
export function hintFromDsn(dsn: string, source: string, key: string): DbHint | null {
  const scheme = URL_SCHEME.exec(dsn);
  if (!scheme) return null;
  try {
    const url = new URL(dsn);
    const engine = engineOf(scheme[1]!);
    const database = url.pathname.replace(/^\//, '') || undefined;
    const port = url.port === '' ? (engine === 'postgres' ? 5432 : undefined) : Number(url.port);
    const user = url.username === '' ? undefined : decodeURIComponent(url.username);
    const host = url.hostname === '' ? undefined : url.hostname;
    return {
      engine,
      host,
      port,
      database,
      user,
      passwordAt: url.password === '' ? undefined : `${source}: ${key} (password present — not read)`,
      source,
      suggestedUrl: suggestedUrl(engine, host, port, database, user),
    };
  } catch {
    return null;
  }
}

function suggestedUrl(
  engine: string,
  host: string | undefined,
  port: number | undefined,
  database: string | undefined,
  user: string | undefined,
): string | undefined {
  if (database === undefined) return undefined;
  const scheme = engine === 'postgres' ? 'postgres' : engine;
  return `${scheme}://${user === undefined ? '' : `${encodeURIComponent(user)}@`}${host ?? 'localhost'}${
    port === undefined ? '' : `:${port}`
  }/${database}`;
}

/**
 * A compose file's database service: the first service whose `image:` names a
 * known engine. Host is `localhost` on purpose — the hint is for connecting
 * FROM the machine running wowlidator, and that is what a published port
 * means; the compose-internal service name would be wrong for everyone.
 */
export function hintFromCompose(text: string, source: string): DbHint | null {
  const image = /image:\s*["']?[^"'\s]*?(postgres|mysql|mariadb)[^"'\s]*/i.exec(text);
  if (!image) return null;
  const engine = engineOf(image[1]!);
  const internalPort = engine === 'postgres' ? 5432 : 3306;
  const ports = new RegExp(`["']?(\\d+):${internalPort}["']?`).exec(text);
  const env = (name: string): string | undefined => {
    const m = new RegExp(`${name}\\s*[:=]\\s*["']?([^"'\\s#]+)`).exec(text);
    return m?.[1];
  };
  const passwordKey = ['POSTGRES_PASSWORD', 'MYSQL_ROOT_PASSWORD', 'MYSQL_PASSWORD', 'MARIADB_ROOT_PASSWORD'].find(
    (k) => env(k) !== undefined,
  );
  const database = env('POSTGRES_DB') ?? env('MYSQL_DATABASE');
  const user = env('POSTGRES_USER') ?? env('MYSQL_USER');
  const port = ports?.[1] === undefined ? internalPort : Number(ports[1]);
  return {
    engine,
    host: 'localhost',
    port,
    database,
    user,
    passwordAt: passwordKey === undefined ? undefined : `${source}: ${passwordKey} (value not read)`,
    source,
    suggestedUrl: suggestedUrl(engine, 'localhost', port, database, user),
  };
}

/** A Prisma datasource: the provider, and the env var its url lives in. */
export function prismaDatasource(text: string): { provider: string; envVar: string } | null {
  const block = /datasource\s+\w+\s*\{([\s\S]*?)\}/.exec(text);
  if (!block) return null;
  const provider = /provider\s*=\s*"(\w+)"/.exec(block[1]!);
  const envVar = /url\s*=\s*env\("([^"]+)"\)/.exec(block[1]!);
  if (!provider || !envVar) return null;
  return { provider: engineOf(provider[1]!.replace('postgresql', 'postgres')), envVar: envVar[1]! };
}

const ENV_FILES = ['.env', '.env.local', '.env.development', '.env.example'];
const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
const PRISMA_FILES = ['prisma/schema.prisma', 'schema.prisma'];

async function tryRead(repoPath: string, rel: string): Promise<string | null> {
  try {
    return await readFile(join(repoPath, rel), 'utf8');
  } catch {
    return null;
  }
}

/**
 * The repository's own word on its database, best source first: a real
 * dotenv DSN (most concrete), then compose (adds the published port), then a
 * Prisma datasource resolved through the same dotenv files. Null when the
 * repo says nothing this understands — an honest "no hint", never a guess.
 */
export async function detectDbHint(repoPath: string): Promise<DbHint | null> {
  // Prisma names the env var a DSN lives under; collect it first so the
  // dotenv pass below can match a var named nothing like DATABASE_URL.
  let prismaVar: string | null = null;
  for (const rel of PRISMA_FILES) {
    const text = await tryRead(repoPath, rel);
    if (text === null) continue;
    const ds = prismaDatasource(text);
    if (ds !== null) {
      prismaVar = ds.envVar;
      break;
    }
  }

  for (const rel of ENV_FILES) {
    const text = await tryRead(repoPath, rel);
    if (text === null) continue;
    for (const { key, value } of dotenvEntries(text)) {
      if (!URL_KEY.test(key) && key !== prismaVar) continue;
      const hint = hintFromDsn(value, rel, key);
      if (hint !== null) return hint;
    }
  }

  for (const rel of COMPOSE_FILES) {
    const text = await tryRead(repoPath, rel);
    if (text === null) continue;
    const hint = hintFromCompose(text, rel);
    if (hint !== null) return hint;
  }

  return null;
}
