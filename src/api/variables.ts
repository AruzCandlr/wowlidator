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
import { dateBuiltin } from '../engine/dates.js';

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
const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_-]*)\s*(?:([+-])\s*(\d+)\s*)?\}\}/g;

/**
 * A builtin: `{{date:today+30d}}`, `{{date:monthEnd|dd/MM/yyyy}}`. The name
 * before the colon picks the resolver, everything after it is the resolver's
 * to read. Substituted BEFORE saved variables, so a builtin can never be
 * shadowed by a saved name and a saved name can never contain a colon.
 *
 * Why a builtin at all (CG-07/EH-03, 2026-09-03): ~330 sheet rows write a
 * date relative to the day the case runs — "Hire Date = Today",
 * "Effective Start = Next day+1", "+119 Day" — and an author that had to
 * compute those wrote them as literals that were stale by the next run. One
 * token, resolved at step time, is the same fact every day.
 */
const BUILTIN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([^{}]*?)\s*\}\}/g;

/** A resolver for a builtin's argument; `null` means the argument was not understood. */
export type BuiltinResolver = (argument: string, context: { now: Date }) => string | null;

/** The builtins every store knows. `date` is the only one so far. */
export const DEFAULT_BUILTINS: Readonly<Record<string, BuiltinResolver>> = {
  date: (argument, { now }) => dateBuiltin(argument, now),
};

/**
 * The first integer in a saved value — "1,234 rows" → 1234, "Pending 1D" →
 * 1, "-3" → -3 — with where it sits and whether it used thousands separators,
 * so `{{name+1}}` can put the new number back in the same place, in the same
 * style. `null` when the value holds no integer.
 */
export function firstInteger(value: string): { start: number; end: number; n: number; grouped: boolean } | null {
  const m = /-?\d[\d,]*/.exec(value);
  if (m === null) return null;
  const raw = m[0].replace(/,+$/, '');
  return {
    start: m.index,
    end: m.index + raw.length,
    n: Number(raw.replace(/,/g, '')),
    grouped: raw.includes(','),
  };
}

function groupThousands(n: number): string {
  const sign = n < 0 ? '-' : '';
  const digits = String(Math.abs(n));
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

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

  /**
   * `reason`, when given, replaces the "nothing has saved it yet" wording —
   * for a variable that IS saved but cannot serve the token as written
   * (`{{count+1}}` on a value with no number in it, `{{date:yesterweek}}`).
   * Same class on purpose: it is the same harness-class fault, an author's
   * token the run cannot honour, and `classifyStepFailure` knows the name.
   */
  constructor(variable: string, known: readonly string[], reason?: string) {
    super(
      reason !== undefined
        ? `variable {{${variable}}} ${reason}`
        : `unknown variable {{${variable}}} — nothing has saved it yet. ` +
            (known.length > 0
              ? `Available: ${known.map((entry) => `{{${entry}}}`).join(', ')}.`
              : 'No variables have been saved in this run.'),
    );
    this.variable = variable;
  }
}

export interface VariableStoreOptions {
  /** Extra or replacement builtins, laid over `DEFAULT_BUILTINS`. */
  builtins?: Record<string, BuiltinResolver> | undefined;
  /** The clock `{{date:today}}` reads — injectable so a test can pin the day. */
  now?: (() => Date) | undefined;
}

export class VariableStore {
  readonly #values = new Map<string, string>();
  readonly #builtins: Record<string, BuiltinResolver>;
  readonly #now: () => Date;

  constructor(options: VariableStoreOptions = {}) {
    this.#builtins = { ...DEFAULT_BUILTINS, ...(options.builtins ?? {}) };
    this.#now = options.now ?? (() => new Date());
  }

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
    const withBuiltins = text.replace(BUILTIN, (match, name: string, argument: string) => {
      const resolver = this.#builtins[name];
      if (resolver === undefined) return match; // left for the stray check below
      const value = resolver(argument, { now: this.#now() });
      if (value === null) {
        throw new UnknownVariableError(`${name}:${argument}`, this.names(), `is not a ${name} this harness can compute`);
      }
      return value;
    });
    const out = withBuiltins.replace(PLACEHOLDER, (_match, name: string, op?: string, digits?: string) => {
      let value = this.#values.get(name);
      let operator = op;
      let amount = digits;
      // `{{rows-before-1}}`: hyphens belong to names, so the greedy name ate
      // the `-1`. When THAT name is unknown but the part before the trailing
      // `-N` is saved, the author meant arithmetic.
      if (value === undefined && operator === undefined) {
        const split = /^(.*[^-])-(\d+)$/.exec(name);
        if (split !== null && this.#values.has(split[1]!)) {
          value = this.#values.get(split[1]!);
          operator = '-';
          amount = split[2]!;
        }
      }
      if (value === undefined) throw new UnknownVariableError(name, this.names());
      if (operator === undefined || amount === undefined) return value;
      // `{{before_total+1}}` — a claim of "+1 / -1 / ไม่เปลี่ยนแปลง" against a
      // number the case observed first (CG-07: BE summary boxes, TM quota
      // lines, probation queue counts — 65 rows). The first integer in the
      // saved text moves; everything around it stays, in the same style.
      const found = firstInteger(value);
      if (found === null) {
        throw new UnknownVariableError(name, this.names(), `is not a number (it holds ${JSON.stringify(value)}), so {{${name}${operator}${amount}}} cannot be computed`);
      }
      const next = found.n + (operator === '-' ? -1 : 1) * Number(amount);
      const rendered = found.grouped ? groupThousands(next) : String(next);
      return value.slice(0, found.start) + rendered + value.slice(found.end);
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
