/**
 * Value normalisation shared by every comparator that asks "is this the value
 * the sheet wrote?" — `expectText`, `expectValue`, the entry rung's read-back,
 * the listbox pick's read-back and the agent's goal evidence.
 *
 * The sheets write a value the way a person types it; the page renders it the
 * way a component does. Measured on the ec10/be100 reruns (2026-09-03):
 * "A - Permanent" against "A — Permanent" (em dash, HIR-EC-037..150),
 * "Active" against "A (Active)" (status badges), "30,000.00" against
 * "฿30,000.00" (DB_07_01, and every amount column), "Status = Inactive"
 * against an "INACTIVE" suffix (PL_05_07, RU_09_56). None of those is a
 * defect, and every one of them was scored as one because each comparator
 * folded case and whitespace and nothing else — except `optionNamePatterns`,
 * which folded dashes, and `goal-evidence.ts`'s `foldValue`, which folded
 * dashes and case. This module is the one place the rule lives.
 *
 * Two lines that must never move:
 *
 * - **Script is never folded.** Thai and Latin renderings of one name are not
 *   an equivalence (tests/smoke.test.ts "still fails a single-rendering
 *   assertion, but names the script mismatch"); `foldValue` touches case,
 *   whitespace, dashes, quotes and number formatting and nothing that could
 *   make "สมชาย" equal "Somchai".
 * - **This is a superset of `orchestrator/goal-evidence.ts`'s `foldValue`.**
 *   Same name, same answers on its inputs (dash variants, case, spacing —
 *   `foldValue('A-Permanent') === 'a - permanent'`), so that import can be
 *   switched here without a test moving. What is added on top — currency
 *   glyphs, thousands separators, a trailing `.00`, surrounding quotes — only
 *   widens what compares equal.
 */

/** Every dash the page might draw for the sheet's hyphen. */
const DASHES = /[‐-―−﹘﹣－]/g;

/** A currency mark glued to a number: ฿30,000.00, $ 1,000, THB 500, 500 บาท. */
const CURRENCY_BEFORE = /(?:฿|\$|€|£|¥|thb|usd|eur|baht|บาท)\s*(?=\d)/gu;
const CURRENCY_AFTER = /(?<=\d)\s*(?:฿|thb|usd|eur|baht|บาท)(?![\p{L}\p{N}])/gu;

/** Surrounding quotes of any of the shapes a sheet or a model writes. */
const QUOTED = /^\s*["'“”‘’«»](.*)["'“”‘’«»]\s*$/su;

/**
 * A value as the page and the sheet might each spell it: NFC, case-folded,
 * every dash the same dash with one space either side, whitespace collapsed,
 * currency marks and thousands separators gone from numbers, a trailing `.00`
 * dropped, surrounding quotes removed.
 *
 * "A - Permanent" and "A — Permanent" are one value; so are "30,000.00",
 * "฿30,000.00" and "30000". Script is untouched on purpose (see the module
 * comment).
 */
export function foldValue(text: string): string {
  let out = text.normalize('NFC').toLowerCase();
  const quoted = QUOTED.exec(out);
  if (quoted !== null && quoted[1] !== undefined && quoted[1].trim() !== '') out = quoted[1];
  out = out
    .replace(DASHES, '-')
    .replace(CURRENCY_BEFORE, '')
    .replace(CURRENCY_AFTER, '')
    // 30,000 → 30000 — only a comma that sits between digit groups of three,
    // so "1, 2, 3" (a list) keeps its commas.
    .replace(/(\d),(?=\d{3}(?!\d))/g, '$1')
    .replace(/(\d)\.00(?!\d)/g, '$1');
  return out
    .replace(/\s*-\s*/g, ' - ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The two halves of a coded value, when it has them:
 *
 * - `CODE - Label` / `CODE — Label` (the sheet's "A - Permanent", humi's
 *   "H_NEWHIRE — New Hire") → code `A`, label `Permanent`;
 * - `Label (CODE)` / `CODE (Label)` ("Contract- Yearly (C2)", "A (Active)",
 *   "40106337 (Job Title)") → outside part and inside part, as code/label by
 *   shape: the shorter, code-looking one (digits, upper-case, underscores, no
 *   spaces) is the code.
 *
 * `null` when the value is a single token — nothing to split.
 */
export function codeAndLabelOf(value: string): { code: string; label: string } | null {
  const text = value.trim();
  // Spaces on both sides of the dash, or a bare code glued to it ("A- Permanent");
  // never a hyphenated word ("Contract- Yearly" is one label, not code+label).
  const dashed =
    /^(.+?)\s+[-‐-―−]\s+(.+)$/su.exec(text) ?? /^([A-Z0-9_./]{1,12})[-‐-―−]\s+(.+)$/su.exec(text);
  if (dashed !== null && dashed[1] !== undefined && dashed[2] !== undefined) {
    return { code: dashed[1].trim(), label: dashed[2].trim() };
  }
  const bracketed = /^(.+?)\s*\(([^()]+)\)\s*$/su.exec(text);
  if (bracketed !== null && bracketed[1] !== undefined && bracketed[2] !== undefined) {
    const outside = bracketed[1].trim();
    const inside = bracketed[2].trim();
    if (outside === '' || inside === '') return null;
    return looksLikeCode(inside) && !looksLikeCode(outside)
      ? { code: inside, label: outside }
      : { code: outside, label: inside };
  }
  return null;
}

/** Digits, upper-case letters, underscores and dots with no spaces — a code, not a label. */
function looksLikeCode(text: string): boolean {
  return /^[A-Z0-9_.\-/]{1,24}$/.test(text) && !/^[A-Z][a-z]/.test(text);
}

/**
 * The ordered candidates a sheet value may be found as on the page: the whole
 * value first, then its code half and its label half. Folded, de-duplicated,
 * empties dropped. A comparator that tries them in order and records WHICH
 * one matched can tell an exact rendering from a conceded one.
 */
export function valueEquivalents(expected: string): string[] {
  const out: string[] = [];
  const push = (candidate: string): void => {
    const folded = foldValue(candidate);
    if (folded !== '' && !out.includes(folded)) out.push(folded);
  };
  push(expected);
  const halves = codeAndLabelOf(expected);
  if (halves !== null) {
    push(halves.code);
    push(halves.label);
  }
  return out;
}

/** A regex-safe form of `text`. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `needle` as a whole word inside `hay`, both folded. Unicode boundaries, not
 * `\b`: "Male" must not be found inside "Female", and Thai has no ASCII word
 * characters to bound on.
 */
export function foldedIncludes(hay: string, needle: string): boolean {
  const n = foldValue(needle);
  const h = foldValue(hay);
  if (n === '') return h === '';
  if (h === n) return true;
  // A combining mark (a Thai vowel sign or tone mark) belongs to the word it
  // sits on: without \p{M} the boundary fell between a consonant and its
  // vowel, and a prefix of a Thai word passed as a whole word.
  const pattern = new RegExp(`(^|[^\\p{L}\\p{M}\\p{N}])${escapeRegExp(n).replace(/ /g, '\\s+')}([^\\p{L}\\p{M}\\p{N}]|$)`, 'u');
  return pattern.test(h);
}

/** How a folded comparison was satisfied — `null` when it was not. */
export type FoldedMatch =
  /** The folded actual IS the folded expected. */
  | 'exact'
  /** The folded expected appears in the actual as a whole word ("Active" in "A (Active)"). */
  | 'contains'
  /** Only a half of a coded expected appears ("Permanent" for "A - Permanent"). */
  | 'code'
  | 'label';

/**
 * Does `actual` show `expected`, by the sheet's own reading of it? Tries the
 * whole value, then its code half, then its label half — never plain
 * substring, so "Male" is not "Female" and "A" is not "Bangkok". The strict
 * comparison a caller already made stays first; this is the LAST look, and
 * the answer names what was conceded so the record can say so.
 */
export function foldedMatch(expected: string, actual: string): FoldedMatch | null {
  const want = foldValue(expected);
  const got = foldValue(actual);
  if (want === '') return got === '' ? 'exact' : null;
  if (want === got) return 'exact';
  if (foldedIncludes(got, want)) return 'contains';
  const halves = codeAndLabelOf(expected);
  if (halves === null) return null;
  if (foldedIncludes(got, halves.code) && looksLikeCode(halves.code)) return 'code';
  if (foldedIncludes(got, halves.label)) return 'label';
  return null;
}
