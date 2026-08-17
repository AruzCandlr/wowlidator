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
