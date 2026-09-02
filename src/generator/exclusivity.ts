/**
 * An exclusivity claim — "shows ONLY these", "แสดงเฉพาะ", "3 ค่าเท่านั้น" —
 * and whether a flow actually proves the ONLY half of it.
 *
 * Measured on ec10_3x HIR-EC-029 (2026-09-02): the Expected output read
 * "dropdown แสดง 3 ค่า : Event Reason แสดงเฉพาะ New Hire / Replacement /
 * Migration". The authored flow asserted the three names visible and three
 * named background codes hidden — every assertion real, and the case went
 * green — but the list could have held thirty entries and passed, because
 * nothing counted it. "Only" was read as "contains".
 *
 * The rule this module states, once, for the author's prompt, the author's
 * lint and the suite runner: **an exclusivity word in the Expected output is
 * a claim about the whole set, and the whole set is proved by counting it.**
 * Presence checks prove the listed items are offered; hidden checks prove the
 * named absentees are absent; neither says anything about the unnamed rest.
 * Only an `expectCount` of the items the list exposes, equal to the number
 * the sheet enumerates, can fail when a fourth entry appears.
 *
 * Conservative on purpose, because a false positive costs a row: the marker
 * must sit in the Expected block (a title alone does not count), and the line
 * carrying it must enumerate something — a stated count ("3 ค่า", "3 values")
 * or a list of two or more items ("A / B / C", "A, B and C"). "กลุ่มเป้าหมาย
 * เฉพาะบางกลุ่ม" (a targeting condition, nothing enumerated) is left alone.
 *
 * Leaf on purpose — no import of the runner or the author — the same reason
 * `vacuous.ts` is a leaf: three places share it without a cycle.
 */

import type { FlowStep } from '../engine/runner.js';

/**
 * Words that make a listing exhaustive. English needs word boundaries; Thai
 * has no word boundaries, so its markers are matched as substrings, and
 * "เฉพาะ" covers "แสดงเฉพาะ", "มีเฉพาะ", "เฉพาะ … เท่านั้น" alike.
 */
const ENGLISH_MARKER = /\b(only|just|exactly|solely|nothing else|no other|none other|and nothing more)\b/i;
const THAI_MARKER = /(เท่านั้น|แค่|เฉพาะ|เพียง)/;

/** "3 ค่า", "3 values", "three options" — a stated size of the set. */
const STATED_COUNT =
  /(\d+)\s*(?:ค่า|รายการ|ตัวเลือก|แถว|ฉบับ|items?|values?|options?|entries|rows?|records?|choices?|columns?|tabs?|buttons?)/i;
const WORD_COUNTS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  หนึ่ง: 1, สอง: 2, สาม: 3, สี่: 4, ห้า: 5, หก: 6, เจ็ด: 7, แปด: 8, เก้า: 9, สิบ: 10,
};
const WORD_COUNT =
  /\b(one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:items?|values?|options?|entries|rows?|records?|choices?)\b|(หนึ่ง|สอง|สาม|สี่|ห้า|หก|เจ็ด|แปด|เก้า|สิบ)\s*(?:ค่า|รายการ|ตัวเลือก|แถว)/i;

/** "A / B / C", "A, B, C", "A หรือ B", "A or B", "A and B". */
const LIST_SEPARATOR = /\s\/\s|\s*,\s*|\sหรือ\s|\sor\s|\sand\s|\sและ\s/;

export interface ExclusivityClaim {
  /** The word that made the listing exhaustive, verbatim. */
  marker: string;
  /** The Expected line carrying it, trimmed. */
  line: string;
  /** How many items the line enumerates, when it states or lists them. */
  count: number | null;
}

/**
 * The Expected block of a case's text, or the whole text when it has none.
 *
 * Same split `expectedItemsIn` (flow-author.ts) uses, so both lints read the
 * same block. `Flow.caseContext` writes the block as "Expected:", the sheet
 * prompt as "Expected output:", the claims file inline as "— expected:".
 */
function expectedBlockOf(text: string): string | null {
  const at = text.search(/(?:^|—)\s*Expected(?: output)?\s*:/im);
  if (at === -1) return null;
  const block = text
    .slice(at)
    .split(/^\s*(?:Note|Test data|Steps|Menu path|Login \/ persona|Preconditions|Actual)\b/im)[0];
  return block ?? null;
}

function enumeratedCount(line: string): number | null {
  const stated = STATED_COUNT.exec(line);
  if (stated) return Number(stated[1]);
  const worded = WORD_COUNT.exec(line);
  if (worded) {
    const word = (worded[1] ?? worded[2] ?? '').toLowerCase();
    if (word in WORD_COUNTS) return WORD_COUNTS[word]!;
  }
  // A listing after a colon or after the marker: "แสดงเฉพาะ New Hire /
  // Replacement / Migration", "offers only Active, Inactive and Pending". A
  // trailing marker ("A / B / C เท่านั้น") lists before itself instead.
  let tail = line.split(/[:：]/).pop() ?? line;
  const marker = ENGLISH_MARKER.exec(tail) ?? THAI_MARKER.exec(tail);
  if (marker) {
    const after = tail.slice(marker.index + marker[0].length).trim();
    tail = after !== '' ? after : tail.slice(0, marker.index);
  }
  const parts = tail
    .split(LIST_SEPARATOR)
    .map((part) => part.trim())
    .filter((part) => part !== '');
  return parts.length >= 2 ? parts.length : null;
}

/**
 * The exclusivity claim a case's text makes, if it makes one.
 *
 * Reads only the Expected block; a title that says "เฉพาะ" with an Expected
 * output that does not is the sheet-writer's summary, not an assertion. The
 * line must also enumerate — a count or a list — or there is nothing whose
 * size a count could prove.
 */
export function exclusivityClaimIn(text: string): ExclusivityClaim | null {
  const block = expectedBlockOf(text);
  if (block === null) return null;
  // Claims-file form is one line ("… — expected: EC; - a; - b"): split on the
  // sheet's own "; -" bullets as well as newlines so each Expected item is
  // judged on its own.
  const lines = block.split(/\r?\n|;\s*-\s+/);
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') continue;
    const marker = ENGLISH_MARKER.exec(line)?.[1] ?? THAI_MARKER.exec(line)?.[1];
    if (marker === undefined) continue;
    const count = enumeratedCount(line);
    if (count === null) continue;
    return { marker, line, count };
  }
  return null;
}

function countOf(step: FlowStep): number | null {
  const raw = (step as { count?: number | string | undefined }).count;
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) return Number(raw.trim());
  return null;
}

export interface UnprovedExclusivity {
  claim: ExclusivityClaim;
  /** 'no-count': nothing counts the set. 'wrong-count': a count exists but disagrees with the sheet. */
  reason: 'no-count' | 'wrong-count';
  /** The disagreeing expectCount step, for 'wrong-count'. */
  index?: number | undefined;
  asserted?: number | undefined;
}

/**
 * Whether `steps` prove the ONLY half of the case's exclusivity claim.
 *
 * Proof is an `expectCount` in the body. When the sheet states how many, a
 * numeric count that disagrees is refused too — "3 ค่า" proved by
 * expectCount 5 is the count of something else. A `{{variable}}` count is
 * accepted as-is: it is a reconciliation the runner settles at run time.
 */
export function unprovedExclusivity(
  steps: readonly FlowStep[],
  caseText: string,
): UnprovedExclusivity | null {
  const claim = exclusivityClaimIn(caseText);
  if (claim === null) return null;
  const counts = steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => step.action === 'expectCount');
  if (counts.length === 0) return { claim, reason: 'no-count' };
  if (claim.count === null) return null;
  const agreeing = counts.some(({ step }) => {
    const n = countOf(step);
    return n === null || n === claim.count;
  });
  if (agreeing) return null;
  const first = counts[0]!;
  return { claim, reason: 'wrong-count', index: first.index, asserted: countOf(first.step) ?? undefined };
}

/** One sentence for a report, a log line or a blocked reason. */
export function describeUnprovedExclusivity(found: UnprovedExclusivity): string {
  const { claim } = found;
  const size = claim.count === null ? 'the enumerated items' : `${claim.count} item(s)`;
  return found.reason === 'no-count'
    ? `the Expected output says "${claim.marker}" (${claim.line}) — an exclusive set of ${size} — but no step counts the set; ` +
        'presence and hidden checks cannot fail when an unlisted item appears'
    : `the Expected output says "${claim.marker}" (${claim.line}) — ${size} — but step ${found.index} counts ` +
        `${found.asserted ?? '?'}`;
}
