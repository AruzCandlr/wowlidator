/**
 * Redaction for database rows on their way into a proof bundle.
 *
 * Same argument as `redact.ts`, with worse odds: the report is deliberately
 * self-contained and emailable, and a result set is *more* likely than an
 * HTTP body to carry PII — that is what databases are for. So the same rules
 * apply at the same kind of choke point: column names run through the one
 * sensitive-key heuristic, evidence is capped, and a value we could not
 * render legibly is replaced with a description of its size and type —
 * never emit a payload we could not inspect.
 */

import { REDACTED, isSensitiveKey } from '../api/redact.js';

/** Rows of evidence a single check may carry into a bundle. */
export const DB_EVIDENCE_MAX_ROWS = 3;

const MAX_VALUE_CHARS = 120;

/** Render one cell the way the report may show it. */
export function redactValue(column: string, value: unknown): string {
  if (isSensitiveKey(column)) return REDACTED;
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'string') return truncate(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return `[bytes: ${value.byteLength}]`;
  // Anything else (json columns, arrays, driver-specific types) — render only
  // what JSON can carry, and describe what it cannot.
  try {
    const rendered = JSON.stringify(value);
    return rendered === undefined ? `[unrenderable: ${typeof value}]` : truncate(rendered);
  } catch {
    return `[unrenderable: ${typeof value}]`;
  }
}

/** One row, every cell through `redactValue`. */
export function redactRow(row: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [column, value] of Object.entries(row)) {
    out[column] = redactValue(column, value);
  }
  return out;
}

/** Up to `DB_EVIDENCE_MAX_ROWS` rows, redacted — the sample a report shows. */
export function redactRows(rows: readonly Record<string, unknown>[]): Record<string, string>[] {
  return rows.slice(0, DB_EVIDENCE_MAX_ROWS).map(redactRow);
}

/**
 * `{ id: '4f2…', password: 'hunter2' }` → `id = 4f2… AND password = [redacted]`.
 * The where clause is evidence too, and it is exactly where a flow puts a
 * session token when it keys a row on one.
 */
export function redactWhereSummary(where: Record<string, unknown>): string {
  return Object.entries(where)
    .map(([column, value]) => `${column} = ${redactValue(column, value)}`)
    .join(' AND ');
}

function truncate(text: string): string {
  if (text.length <= MAX_VALUE_CHARS) return text;
  return `${text.slice(0, MAX_VALUE_CHARS)}… [${text.length} chars]`;
}
