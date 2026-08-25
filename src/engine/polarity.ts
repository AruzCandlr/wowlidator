/**
 * Whether a test MEANS to prove acceptance or refusal.
 *
 * A negative test passes by showing the application refuses something — an
 * invalid submission rejected, a forbidden page denied, an error surfaced.
 * Read without that label, its green run looks like "the feature works" and
 * its red run looks like a defect, when both readings are exactly backwards.
 * The label therefore travels with the result: stamped on the flow when the
 * catalog states it (a test-case sheet's own Positive/Negative column is the
 * author's word and always wins), inferred deterministically otherwise — from
 * the words the test uses and the shape of what it asserts, never a model
 * call, so the same flow classifies the same way on every run.
 *
 * Inference understates, never overstates: only wording and step shapes that
 * unambiguously describe refusal count as negative. `expectHidden` alone does
 * not — it is also the canonical login proof — and a 4xx `expectStatus` does,
 * because the only reason to pin one is to demand the request be refused.
 */

export type TestPolarity = 'positive' | 'negative';

/** How the label got there — a stated column is evidence, a heuristic is not. */
export type PolaritySource = 'stated' | 'inferred';

/**
 * A catalog's own Positive/Negative column, normalised. Anything that does not
 * plainly say one or the other is `undefined` — a blank cell must fall through
 * to inference, never default to positive by string accident.
 */
export function statedPolarity(raw: string | undefined): TestPolarity | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (/^neg/i.test(trimmed)) return 'negative';
  if (/^pos/i.test(trimmed)) return 'positive';
  return undefined;
}

/**
 * Wording that describes a rule being enforced rather than a path succeeding.
 * English and Thai, because those are the two languages the validation
 * catalogs this was measured on actually use. Word-boundary anchored where
 * the language has boundaries; Thai matched as substrings, as everywhere
 * else in this codebase.
 */
const NEGATIVE_WORDING = new RegExp(
  [
    String.raw`\binvalid\b`,
    String.raw`\bmalformed\b`,
    String.raw`\bincorrect\b`,
    String.raw`\bwrong\b`,
    String.raw`\bunauthori[sz]ed\b`,
    String.raw`\bforbidden\b`,
    String.raw`\bdenied\b`,
    String.raw`\breject(?:s|ed|ion)?\b`,
    String.raw`\brefus(?:e|es|ed|al)\b`,
    String.raw`\bshould not\b`,
    String.raw`\bmust not\b`,
    String.raw`\bcannot\b`,
    String.raw`\bcan(?:'|’)t\b`,
    String.raw`\bnot allowed\b`,
    String.raw`\bnot permitted\b`,
    String.raw`\bblocked\b`,
    String.raw`\bprevent(?:s|ed)?\b`,
    String.raw`\berror message\b`,
    String.raw`\bvalidation (?:error|message|fails?)\b`,
    String.raw`\bmissing required\b`,
    String.raw`\bempty required\b`,
    String.raw`\bduplicate\b`,
    // Thai: incorrect / not allowed-no permission / refuse / forbidden.
    'ไม่ถูกต้อง',
    'ไม่มีสิทธิ์',
    'ปฏิเสธ',
    'ห้าม',
  ].join('|'),
  'i',
);

/** The step fields inference reads. Structural, to stay import-cycle-free. */
export interface PolarityStepLike {
  action: string;
  status?: number | number[] | undefined;
  never?: unknown[] | undefined;
}

/** A step shape that can only mean "the application must refuse this". */
function refusalStep(step: PolarityStepLike): boolean {
  if (step.action === 'expectStatus') {
    const statuses = typeof step.status === 'number' ? [step.status] : (step.status ?? []);
    // Every accepted status is an error status — a list mixing 200 and 422
    // is a tolerance, not a refusal claim.
    return statuses.length > 0 && statuses.every((s) => s >= 400);
  }
  if (step.action === 'expectCalls') {
    return Array.isArray(step.never) && step.never.length > 0;
  }
  return false;
}

/**
 * Classify a test from its own words and assertions. `text` is whatever names
 * the test — the flow name (which on the catalog path carries the row's
 * claim verbatim) plus any step intents worth reading.
 */
export function inferPolarity(
  text: string,
  steps: readonly PolarityStepLike[] = [],
): TestPolarity {
  if (NEGATIVE_WORDING.test(text)) return 'negative';
  if (steps.some(refusalStep)) return 'negative';
  return 'positive';
}
