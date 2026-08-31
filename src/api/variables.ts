/**
 * Per-run variable store — the one genuinely new primitive backend testing
 * needs.
 *
 * Every flow action until now was independent: a selector, a value, an
 * assertion, none of them carrying anything to the next step. An API test
 * cannot work that way. You create a resource, the server assigns it an id,
 * and the next three steps are about *that* id. So a step needs to be able to
 * say "remember this" and a later one to say "use it".
 *
 * Two deliberate limits:
 *
 * - **A tiny JSONPath subset, written here, not a dependency.** `$.a.b[0]` and
 *   `a.b` are what extracting an id or a token actually needs. Filters,
 *   wildcards and recursive descent are the parts of JSONPath that turn a test
 *   into a program, and pulling in a full implementation to get them would add
 *   a dependency for a capability nobody asked for.
 * - **An unknown variable is an error, never an empty string.** Silently
 *   interpolating `''` produces a request to `/api/orders/` and a failure three
 *   steps later that reads like a backend bug. Failing at the point of use
 *   names the actual problem.
 */

import { REDACTED } from './redact.js';

/**
 * Matches `{{name}}`, allowing surrounding whitespace inside the braces.
 *
 * **Hyphens are part of a name.** The authoring prompt's own worked example is
 * `saveCount as "rows-before"` … `expectCount "{{rows-before}}"`, and a pattern
 * that stopped at `[A-Za-z0-9_]` could not match it: `replace` found nothing,
 * returned the string untouched, and the flow went on to assert the literal
 * text `{{rows-before}}` against the page. Worse, the unknown-name guard below
 * lives inside the replace callback, so a name that never matched was never
 * reported either — the one case that most needed an error produced silence.
 * Measured on PL_02: 11 of 18 authoring refusals were hyphenated placeholders,
 * and three rows died renaming the placeholder because nothing said that was
 * the problem.
 */
const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_-]*)\s*\}\}/g;

/**
 * Any `{{…}}` at all — what `interpolate` scans for AFTER substituting, so a
 * brace pair that `PLACEHOLDER` could not read is a loud failure rather than
 * literal text in an assertion. Deliberately laxer than `PLACEHOLDER`: its job
 * is to catch exactly what that one rejects.
 */
const ANY_PLACEHOLDER = /\{\{[^}]*\}\}/;

/**
 * Variable names whose value is treated as a credential in the report.
 *
 * Saved values are frequently tokens by construction — that's the main reason
 * to save one — so the report shows names and lets the run use the values,
 * without writing them into a file people email around.
 */
const SENSITIVE_NAME = /(token|secret|password|key|auth|session|cookie)/i;

export class UnknownVariableError extends Error {
  override readonly name = 'UnknownVariableError';
  readonly variable: string;

  constructor(variable: string, known: readonly string[]) {
    super(
      `unknown variable {{${variable}}} — nothing has saved it yet. ` +
        (known.length > 0
          ? `Available: ${known.map((entry) => `{{${entry}}}`).join(', ')}.`
          : 'No variables have been saved in this run.'),
    );
    this.variable = variable;
  }
}

export class VariableStore {
  readonly #values = new Map<string, string>();

  set(name: string, value: string): void {
    this.#values.set(name, value);
  }

  get(name: string): string | undefined {
    return this.#values.get(name);
  }

  has(name: string): boolean {
    return this.#values.has(name);
  }

  names(): string[] {
    return [...this.#values.keys()];
  }

  /**
   * Replace every `{{name}}` in `text`. Throws on an unknown name — and on a
   * brace pair `PLACEHOLDER` could not read at all, which is the same mistake
   * wearing a different hat and used to pass through as literal text.
   */
  interpolate(text: string): string {
    const out = text.replace(PLACEHOLDER, (_match, name: string) => {
      const value = this.#values.get(name);
      if (value === undefined) throw new UnknownVariableError(name, this.names());
      return value;
    });
    const stray = ANY_PLACEHOLDER.exec(out);
    if (stray !== null) {
      throw new UnknownVariableError(stray[0].slice(2, -2).trim(), this.names());
    }
    return out;
  }

  /**
   * Interpolate every string inside a structure, leaving other types alone.
   *
   * Used for request bodies and header maps, where the placeholder may be
   * nested anywhere in an object the author wrote as JSON.
   */
  interpolateDeep<T>(value: T): T {
    if (typeof value === 'string') return this.interpolate(value) as unknown as T;
    if (Array.isArray(value)) return value.map((item) => this.interpolateDeep(item)) as unknown as T;
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
        out[this.interpolate(key)] = this.interpolateDeep(inner);
      }
      return out as unknown as T;
    }
    return value;
  }

  /**
   * What the report is allowed to show: every name, and only the values that
   * are not credentials by name.
   */
  snapshotForReport(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, value] of this.#values) {
      out[name] = SENSITIVE_NAME.test(name) ? REDACTED : value;
    }
    return out;
  }
}

/**
 * Read a value out of a parsed JSON body.
 *
 * Accepts `$.a.b[0]`, `a.b`, and `$[0].id`. Returns `undefined` for a path
 * that does not resolve — callers report that as a failed extraction rather
 * than saving the string "undefined", which would poison every later step in a
 * way that is very hard to trace back here.
 */
export function extractPath(source: unknown, path: string): unknown {
  const segments = parsePath(path);
  if (segments === null) return undefined;

  let current: unknown = source;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (typeof segment === 'number') {
      if (!Array.isArray(current)) return undefined;
      current = current[segment];
    } else {
      if (typeof current !== 'object' || Array.isArray(current)) return undefined;
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return current;
}

/** `$.items[0].id` → `['items', 0, 'id']`. `null` when the path is malformed. */
function parsePath(path: string): (string | number)[] | null {
  const trimmed = path.trim().replace(/^\$/, '');
  if (trimmed === '') return [];

  const segments: (string | number)[] = [];
  const pattern = /\.([A-Za-z_][A-Za-z0-9_-]*)|\[(\d+)\]|^([A-Za-z_][A-Za-z0-9_-]*)/g;
  let consumed = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(trimmed)) !== null) {
    if (match.index !== consumed) return null; // a gap means we failed to parse something
    consumed = match.index + match[0].length;
    if (match[1] !== undefined) segments.push(match[1]);
    else if (match[2] !== undefined) segments.push(Number(match[2]));
    else if (match[3] !== undefined) segments.push(match[3]);
  }

  return consumed === trimmed.length ? segments : null;
}

/**
 * Render an extracted value as the string a later step will interpolate.
 *
 * Objects and arrays are JSON-encoded rather than becoming `[object Object]`,
 * which is the kind of thing that only reveals itself in a server log.
 */
export function stringifyExtracted(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value) ?? '';
}
