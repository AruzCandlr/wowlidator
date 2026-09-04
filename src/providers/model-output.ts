/**
 * Making a model-output schema survive a provider that omits keys.
 *
 * Two provider behaviours pull in opposite directions, and a model-output
 * schema in this codebase has to satisfy both:
 *
 * - **Strict providers reject a partial `required`.** Groq's `openai/gpt-oss-*`
 *   and OpenAI's own refuse an object schema whose `required` omits any key of
 *   `properties`, *before the model is asked* — so `.optional()` and
 *   `.default()` are unusable here however reasonable they look. Every key
 *   stays required. See "Structured output on free tiers" in CLAUDE.md.
 * - **Lenient providers omit keys anyway.** z.ai's GLM drops exactly the
 *   fields whose value would have been empty: a `waitFor` step arrives with no
 *   `value` and no `url`, and zod then rejects the whole generation with
 *   "expected string, received undefined". Measured on glm-4.7-flash: this is
 *   two thirds of the generator's structured-output failures.
 *
 * `lenientObject` is the reconciliation. The **emitted** JSON Schema is
 * byte-for-byte the strict one, so the first constraint holds; a missing key is
 * filled in on the way *in*, so the second cannot fail the call.
 *
 * This generalises a fix that already existed once, hand-written for the `case`
 * field of `AuthoredStepSchema` in `flow-author.ts`. One copy, applied to every
 * schema with the same convention, rather than a fix per field discovered one
 * failure at a time.
 */

import { z } from 'zod';

/**
 * The JSON object inside a model's answer, when the answer was asked for as
 * JSON — fences stripped, surrounding prose dropped, nothing else changed.
 *
 * Exists for the claude-cli / claude-tty generator path (2026-08-27, live on
 * PL_02_02): fable answered a `--json-schema` authoring call with the object
 * wrapped in a markdown fence and a sentence of preamble, the AI SDK's parse
 * saw non-JSON at index 0, and the whole call failed "did not match schema" —
 * about an answer that was in there, whole and valid. The same shape is the
 * documented habit of every schema-in-prompt provider (`claude-tty`,
 * `claude-cloud`), where nothing upstream validates at all.
 *
 * Deliberately narrow, in this order:
 *  1. Text that already parses as JSON is returned VERBATIM — the common
 *     case costs one JSON.parse and changes nothing.
 *  2. A fenced block (```json … ``` or bare ```) whose body parses is the
 *     answer.
 *  3. Otherwise the first balanced top-level `{…}` or `[…]` that parses is
 *     taken — string-aware, so a brace inside a quoted selector never
 *     unbalances it.
 * Anything else comes back unchanged: this repairs PACKAGING only, never
 * content — zod still has the last word, and a genuinely malformed answer
 * still fails exactly as it did.
 */
export function extractStructuredJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed === '') return text;
  if (parses(trimmed)) return trimmed;
  for (const match of trimmed.matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/gi)) {
    const body = (match[1] ?? '').trim();
    if (parses(body)) return body;
  }
  const balanced = firstBalancedJson(trimmed);
  if (balanced !== null && parses(balanced)) return balanced;
  return text;
}

function parses(candidate: string): boolean {
  if (candidate === '' || !/^[[{]/.test(candidate)) return false;
  try {
    JSON.parse(candidate);
    return true;
  } catch {
    return false;
  }
}

/** The first balanced `{…}`/`[…]` span, tracking strings so quoted braces do not count. */
function firstBalancedJson(text: string): string | null {
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  const open = text[start] as '{' | '[';
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let at = start; at < text.length; at += 1) {
    const ch = text[at];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = inString;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, at + 1);
    }
  }
  return null;
}

/**
 * What a missing key is filled with, or `null` for "leave it missing".
 *
 * **Only fields whose schema already has an empty value in its vocabulary are
 * filled**, and that restraint is the whole safety argument. An absent
 * `selector` becomes `''`, which every consumer already treats as "not
 * supplied" — `toFlowStep` returns `null` for a step whose selector it needs
 * and does not have, so the step is *dropped*, not executed against nothing.
 * An absent `action` or an absent count has no such reading: there is no empty
 * enum member and no empty number, and inventing one would turn a model that
 * failed to answer into a step that does the wrong thing quietly. Those stay
 * missing and still fail the call, which is the correct outcome.
 */
function fillerFor(schema: z.ZodType): (() => unknown) | null {
  // Order matters: a nullable wrapper is checked before its inner type, since
  // `null` is what that schema itself says "declined" looks like.
  if (schema instanceof z.ZodNullable) return () => null;
  if (schema instanceof z.ZodString) return () => '';
  if (schema instanceof z.ZodArray) return () => [];
  return null;
}

/**
 * A `z.object` that tolerates a provider dropping keys it considered empty.
 *
 * Use this for every **model-output** object whose convention is "unused
 * fields are empty strings". It is not for input schemas — the MCP tool
 * schemas in `src/mcp/server.ts` describe what a caller may send, where a
 * missing key is a caller error worth reporting rather than a provider quirk
 * worth absorbing.
 */
export function lenientObject<T extends z.ZodRawShape>(shape: T): z.ZodType<z.infer<z.ZodObject<T>>> {
  const object = z.object(shape);
  const fillers = Object.entries(shape)
    .map(([key, schema]) => [key, fillerFor(schema as z.ZodType)] as const)
    .filter((entry): entry is readonly [string, () => unknown] => entry[1] !== null);

  // Nothing fillable: hand back the plain object rather than wrapping it in a
  // preprocess step that would only ever be the identity.
  if (fillers.length === 0) return object as z.ZodType<z.infer<z.ZodObject<T>>>;

  return z.preprocess((raw) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    const record = raw as Record<string, unknown>;
    let patched: Record<string, unknown> | undefined;
    for (const [key, filler] of fillers) {
      // `in`, not `=== undefined`: a key the model explicitly sent as null is
      // an answer, and overwriting it here would hide a real disagreement
      // between the model and the schema.
      if (key in record) continue;
      patched ??= { ...record };
      patched[key] = filler();
    }
    return patched ?? raw;
  }, object) as z.ZodType<z.infer<z.ZodObject<T>>>;
}
