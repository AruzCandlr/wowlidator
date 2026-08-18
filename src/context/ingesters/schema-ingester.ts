/**
 * Indexes the database schema into `table` nodes — the state-side counterpart
 * of the OpenAPI ingester, and it follows that file's manners deliberately:
 * conventional discovery, silent no-op when nothing is found (most projects
 * have no schema file, and warning about it on every build trains people to
 * ignore the warnings that matter), warnings instead of throws for anything
 * unreadable, and **no model call anywhere** — parsing is not reasoning.
 *
 * Three sources, in priority order:
 *
 * 1. An explicit `--db-schema <file>` (`.sql` DDL or `.prisma`).
 * 2. A conventionally-named file among the walked files (`schema.prisma`,
 *    `schema.sql` — shallowest path wins).
 * 3. **Live introspection**, when `WOWLIDATOR_DB_URL` is configured and no file
 *    was found. The database is the source of truth wherever a connection
 *    exists — "never assert a table we did not observe" beats any parser.
 *
 * Disclosed gaps, not silent ones: DDL parsing covers `CREATE TABLE` with
 * ordinary column lists — a statement it cannot parse becomes a warning
 * naming it, never a guess. Prisma parsing covers `model` blocks, `@@map`,
 * `@map`, `@id` and relation fields; generators/datasources are skipped.
 * `meta` values are delimiter-joined strings (the `Record<string, string>`
 * contract), read back only by our own linking pass.
 */

import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';

import type { DbSchema, DbTable } from '../../db/client.js';
import type { IngestContext, IngestResult, Ingester, ProjectEdge, ProjectNode } from '../types.js';

const SCHEMA_FILE_RE = /(^|\/)schema\.(sql|prisma)$/i;

/** Prisma scalar types — a field of any other capitalized type is a relation. */
const PRISMA_SCALARS = new Set([
  'String',
  'Int',
  'BigInt',
  'Float',
  'Decimal',
  'Boolean',
  'DateTime',
  'Json',
  'Bytes',
  'Unsupported',
]);

export interface SchemaIngesterOptions {
  /** Explicit schema file (absolute or project-relative). Wins over discovery. */
  source?: string | undefined;
  /**
   * Connection string for live introspection when no file is found. Passed in
   * by the caller (usually from `WOWLIDATOR_DB_URL`) rather than read here, so
   * the ingester stays a pure function of its inputs.
   */
  dbUrl?: string | undefined;
  /** Forwarded to the connection guard — see `connectDb`. */
  dbRemoteOk?: boolean | undefined;
}

interface ParsedTable {
  name: string;
  /** `name:type` (plus ` pk`) — display strings, not a type system. */
  columns: string[];
  pk: string[];
  /** `col -> table.col` */
  references: string[];
}

function stripQuotes(name: string): string {
  return name.replace(/^["'`[]|["'`\]]$/g, '');
}

/**
 * `public.orders` → `orders`; `benefit_management.benefit_plan` stays
 * qualified; quoting stripped. Mirrors `qualifiedName()` in `db/client.ts` —
 * bare for the default schema, `schema.table` for everything else — because
 * the run-time grounding gate compares names against the live introspection's:
 * a file-sourced inventory that stripped a named schema authored flows the
 * gate then refused, for tables that exist.
 */
function qualifiedTableName(raw: string): string {
  const unquoted = stripQuotes(raw.trim());
  const dot = unquoted.lastIndexOf('.');
  if (dot < 0) return unquoted;
  const schema = stripQuotes(unquoted.slice(0, dot));
  const table = stripQuotes(unquoted.slice(dot + 1));
  return /^public$/i.test(schema) ? table : `${schema}.${table}`;
}

/** Remove `--` and `/* *​/` comments so the paren scan cannot be fooled by them. */
function stripSqlComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, '');
}

/** Split a column list on top-level commas — `numeric(10,2)` stays whole. */
function splitColumns(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  let inString = false;
  for (const ch of body) {
    if (inString) {
      current += ch;
      if (ch === "'") inString = false;
      continue;
    }
    if (ch === "'") {
      inString = true;
      current += ch;
    } else if (ch === '(') {
      depth += 1;
      current += ch;
    } else if (ch === ')') {
      depth -= 1;
      current += ch;
    } else if (ch === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim() !== '') out.push(current.trim());
  return out;
}

const TABLE_CONSTRAINT_RE = /^(CONSTRAINT|PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK|EXCLUDE|LIKE)\b/i;

export function parseSqlSchema(text: string): { tables: ParsedTable[]; warnings: string[] } {
  const tables: ParsedTable[] = [];
  const warnings: string[] = [];
  const clean = stripSqlComments(text);

  const re = /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+([^\s(]+)\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(clean)) !== null) {
    const name = qualifiedTableName(match[1] ?? '');
    // Scan for the matching close paren from just past the open one.
    let depth = 1;
    let inString = false;
    let end = -1;
    for (let i = re.lastIndex; i < clean.length; i += 1) {
      const ch = clean[i];
      if (inString) {
        if (ch === "'") inString = false;
        continue;
      }
      if (ch === "'") inString = true;
      else if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end < 0) {
      warnings.push(`could not parse CREATE TABLE ${name} — unbalanced parentheses; skipped`);
      continue;
    }

    const table: ParsedTable = { name, columns: [], pk: [], references: [] };
    for (const entry of splitColumns(clean.slice(re.lastIndex, end))) {
      const constraint = TABLE_CONSTRAINT_RE.exec(entry);
      if (constraint) {
        const pkCols = /PRIMARY\s+KEY\s*\(([^)]+)\)/i.exec(entry);
        if (pkCols?.[1]) {
          table.pk.push(...pkCols[1].split(',').map((c) => stripQuotes(c.trim())));
        }
        const fk = /FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+([^\s(]+)\s*\(([^)]+)\)/i.exec(entry);
        if (fk?.[1] && fk[2] && fk[3]) {
          table.references.push(
            `${stripQuotes(fk[1].trim())} -> ${qualifiedTableName(fk[2])}.${stripQuotes(fk[3].trim())}`,
          );
        }
        continue;
      }

      const column = /^("[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_$]*)\s+(\S+)/.exec(entry);
      if (!column?.[1] || !column[2]) {
        warnings.push(`could not parse a column of "${name}": ${entry.slice(0, 60)} — skipped`);
        continue;
      }
      const columnName = stripQuotes(column[1]);
      const isPk = /\bPRIMARY\s+KEY\b/i.test(entry);
      if (isPk) table.pk.push(columnName);
      const ref = /\bREFERENCES\s+([^\s(]+)\s*(?:\(([^)]+)\))?/i.exec(entry);
      if (ref?.[1]) {
        const target = qualifiedTableName(ref[1]);
        const targetCol = ref[2] ? stripQuotes(ref[2].trim()) : 'id';
        table.references.push(`${columnName} -> ${target}.${targetCol}`);
      }
      table.columns.push(`${columnName}:${column[2].toLowerCase()}${isPk ? ' pk' : ''}`);
    }
    tables.push(table);
  }
  return { tables, warnings };
}

export function parsePrismaSchema(text: string): { tables: ParsedTable[]; warnings: string[] } {
  const tables: ParsedTable[] = [];
  const warnings: string[] = [];
  const modelNames = new Set<string>();
  const tableNameOf = new Map<string, string>();

  const modelRe = /(^|\n)\s*model\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{([\s\S]*?)\n\s*\}/g;
  const bodies: Array<{ model: string; body: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = modelRe.exec(text)) !== null) {
    const model = match[2] ?? '';
    const body = match[3] ?? '';
    bodies.push({ model, body });
    modelNames.add(model);
    const mapped = /@@map\(\s*"([^"]+)"\s*\)/.exec(body);
    const base = mapped?.[1] ?? model;
    // multiSchema: `@@schema("x")` qualifies the table the same way live
    // introspection does — bare for public, `schema.table` otherwise — so a
    // file-sourced name and the database's own agree at the grounding gate.
    const schemaAttr = /@@schema\(\s*"([^"]+)"\s*\)/.exec(body)?.[1];
    tableNameOf.set(
      model,
      schemaAttr !== undefined && !/^public$/i.test(schemaAttr) ? `${schemaAttr}.${base}` : base,
    );
  }

  for (const { model, body } of bodies) {
    const table: ParsedTable = {
      name: tableNameOf.get(model) ?? model,
      columns: [],
      pk: [],
      references: [],
    };
    for (const rawLine of body.split('\n')) {
      const line = rawLine.replace(/\/\/.*$/, '').trim();
      if (line === '' || line.startsWith('@@')) continue;
      const field = /^([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)(\[\])?(\?)?/.exec(line);
      if (!field?.[1] || !field[2]) continue;
      const fieldName = field[1];
      const type = field[2];

      if (modelNames.has(type) && !PRISMA_SCALARS.has(type)) {
        // A relation field is not a column; the FK column (if scalar) appears
        // on its own line. Record the relationship at table granularity.
        table.references.push(`${fieldName} -> ${tableNameOf.get(type) ?? type}`);
        continue;
      }

      const mapped = /@map\(\s*"([^"]+)"\s*\)/.exec(line);
      const columnName = mapped?.[1] ?? fieldName;
      const isPk = /@id\b/.test(line);
      if (isPk) table.pk.push(columnName);
      table.columns.push(`${columnName}:${type.toLowerCase()}${isPk ? ' pk' : ''}`);
    }
    tables.push(table);
  }

  return { tables, warnings };
}

function fromDbSchema(schema: DbSchema): ParsedTable[] {
  return schema.tables.map((table: DbTable) => ({
    name: table.name,
    columns: table.columns.map((c) => `${c.name}:${c.type}${c.pk ? ' pk' : ''}`),
    pk: [...table.pk],
    references: [...table.references],
  }));
}

function toNodes(
  tables: readonly ParsedTable[],
  file: string,
  source: 'ddl' | 'prisma' | 'introspection',
): { nodes: ProjectNode[]; edges: ProjectEdge[] } {
  const nodes: ProjectNode[] = [];
  const edges: ProjectEdge[] = [];
  for (const table of tables) {
    const meta: Record<string, string> = {
      // ` · `-joined like the OpenAPI ingester's summaries — read back only by
      // our own passes, never treated as authoritative structure.
      columns: table.columns.join(' · '),
      source,
    };
    if (table.pk.length > 0) meta['pk'] = table.pk.join(',');
    if (table.references.length > 0) meta['references'] = table.references.join(' · ');
    nodes.push({
      id: `table:${table.name}`,
      kind: 'table',
      name: table.name,
      file,
      detail: `${table.columns.length} column(s)`,
      meta,
    });
    for (const reference of table.references) {
      const rawTarget = /->\s*(\S+)/.exec(reference)?.[1];
      if (!rawTarget) continue;
      // DDL and introspection references end `.column`, so the table is
      // everything before the LAST dot — a first-dot read turned a qualified
      // `schema.table.column` into an edge to `schema`. Prisma references
      // carry no column at all: the whole target is the table.
      const lastDot = rawTarget.lastIndexOf('.');
      const target = source === 'prisma' || lastDot < 0 ? rawTarget : rawTarget.slice(0, lastDot);
      // A dangling target (a table the schema never declares) is pruned by
      // the merge step, not guessed at — the standing rule.
      edges.push({ from: `table:${table.name}`, to: `table:${target}`, kind: 'references' });
    }
  }
  return { nodes, edges };
}

export class SchemaIngester implements Ingester {
  readonly id = 'schema';
  readonly #options: SchemaIngesterOptions;

  constructor(options: SchemaIngesterOptions = {}) {
    this.#options = options;
  }

  async ingest(ctx: IngestContext): Promise<IngestResult> {
    const warnings: string[] = [];

    const located = this.#locate(ctx);
    if (located !== undefined) {
      let text: string;
      try {
        text = await readFile(
          located.startsWith('/') ? located : posix.join(ctx.rootDir, located),
          'utf8',
        );
      } catch (error) {
        return {
          nodes: [],
          edges: [],
          warnings: [
            `could not read ${located}: ${error instanceof Error ? error.message : String(error)}`,
          ],
        };
      }
      const isPrisma = /\.prisma$/i.test(located);
      const parsed = isPrisma ? parsePrismaSchema(text) : parseSqlSchema(text);
      warnings.push(...parsed.warnings);
      if (parsed.tables.length === 0) {
        warnings.push(`${located} declared no tables this parser could read`);
      }
      const { nodes, edges } = toNodes(parsed.tables, located, isPrisma ? 'prisma' : 'ddl');
      return { nodes, edges, warnings };
    }

    // No file: introspect, when a connection is configured. The lazy import
    // inside `connectDb` keeps `pg` optional for everyone who never gets here.
    if (this.#options.dbUrl !== undefined) {
      try {
        const { connectDb } = await import('../../db/client.js');
        const client = await connectDb({
          url: this.#options.dbUrl,
          remoteOk: this.#options.dbRemoteOk,
        });
        try {
          const schema = await client.introspect();
          const { nodes, edges } = toNodes(fromDbSchema(schema), '(live database)', 'introspection');
          return { nodes, edges, warnings };
        } finally {
          await client.close().catch(() => undefined);
        }
      } catch (error) {
        return {
          nodes: [],
          edges: [],
          warnings: [
            `could not introspect the configured database: ${
              error instanceof Error ? error.message.split('\n')[0] : String(error)
            }`,
          ],
        };
      }
    }

    // No schema anywhere. Not a warning — the OpenAPI ingester's reasoning,
    // verbatim: most projects have none, and saying so on every build trains
    // people to ignore the warnings that matter.
    return { nodes: [], edges: [], warnings: [] };
  }

  /** Explicit source wins; else the shallowest conventionally-named file. */
  #locate(ctx: IngestContext): string | undefined {
    if (this.#options.source !== undefined) return this.#options.source;
    const candidates = ctx.files.filter((file) => SCHEMA_FILE_RE.test(file));
    if (candidates.length === 0) return undefined;
    candidates.sort((a, b) => {
      const depth = a.split('/').length - b.split('/').length;
      return depth !== 0 ? depth : a.localeCompare(b);
    });
    return candidates[0];
  }
}
