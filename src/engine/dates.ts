/**
 * The dates a sheet writes, as the harness needs them.
 *
 * A QA workbook says "Hire Date = Today", "Effective End = 31/12/9999",
 * "Next day+1", "วันที่ 25 ของเดือนปัจจุบัน", "15 ก.ย. 2569", "+119 Day";
 * a date input takes `2027-09-01`; a calendar heading reads "กันยายน 2570";
 * a trigger button reads back "15 ก.ย. 2569". Measured across the HR
 * workbook (2026-09-03): ~330 cases carry a date in one of those shapes, and
 * `runner.ts`'s `isoDateOf` accepted ISO and English month names only, so
 * every other one fell to a model call per date field.
 *
 * Three jobs, all pure and $0:
 *
 * - `isoDateOf(text, locale?)` — a superset of the runner's function of the
 *   same name (same answers on its inputs: ISO, `D Mon YYYY`, `Mon D, YYYY`;
 *   `01/09/2027` without a locale is still `null`), adding Thai month names,
 *   Buddhist-era years, `dd/mm/yyyy` under a locale or when the day part is
 *   unambiguous, and the `31/12/9999` sentinel.
 * - `resolveDateExpression("today+30d")` — the relative tokens, so an author
 *   emits `{{date:today+30d}}` instead of arithmetic (see `api/variables.ts`).
 * - `formatDate(iso, "d MMM yyyy", "th")` — the rendering a page shows, for a
 *   display comparison or a calendar read-back.
 *
 * **A Buddhist year is never converted silently.** `2567` is converted only
 * when the caller said `locale: 'th'` or the date carries a Thai month name —
 * HIR-EC-024 types "2567" into an English form precisely to see it rejected.
 */

/** How a numeric `a/b/yyyy` is read, and which era a bare year is in. */
export type DateLocale = 'en' | 'en-US' | 'en-GB' | 'th';

export const EN_MONTHS_FULL = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;
export const EN_MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;
/** As humi's `lib/date.ts` spells them — the strings its headings and triggers render. */
export const THAI_MONTHS_FULL = [
  'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม',
] as const;
export const THAI_MONTHS_SHORT = [
  'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
  'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.',
] as const;

/** The Buddhist era runs 543 years ahead; a four-digit year past this can only be BE. */
const BUDDHIST_FLOOR = 2400;
const BUDDHIST_OFFSET = 543;

/** Month number (1–12) for a month token in either language, or null. */
export function monthNumberOf(token: string): number | null {
  const t = token.trim().replace(/[.,]+$/u, '');
  if (t === '') return null;
  const lower = t.toLowerCase();
  const en = EN_MONTHS_FULL.findIndex((m, i) => {
    const full = m.toLowerCase();
    const short = EN_MONTHS_SHORT[i]!.toLowerCase();
    return lower === full || lower === short || (lower === 'sept' && short === 'sep');
  });
  if (en >= 0) return en + 1;
  const dotless = t.replace(/\./gu, '');
  const th = THAI_MONTHS_FULL.findIndex((m, i) => t === m || dotless === THAI_MONTHS_SHORT[i]!.replace(/\./gu, ''));
  return th >= 0 ? th + 1 : null;
}

/** True when the token is one of the Thai month spellings — a date written in Thai is in the Thai era. */
function isThaiMonth(token: string): boolean {
  return /[ก-๙]/u.test(token) && monthNumberOf(token) !== null;
}

/** A Buddhist year as a common-era year; anything else as written. */
export function ceYearOf(year: number): number {
  return year >= BUDDHIST_FLOOR && year < 9999 ? year - BUDDHIST_OFFSET : year;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function iso(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
}

/**
 * The ISO `YYYY-MM-DD` a date input accepts, or `null` when the text is not
 * a date or is ambiguous under the given locale.
 *
 * Accepted: ISO; `1 Sep 2027` / `01 September 2027` / `1-Sep-2027`;
 * `Sep 1, 2027`; `15 ก.ย. 2569` / `15 กันยายน 2569` (Thai month → BE year
 * converted); `2027/09/01`; `dd/mm/yyyy` with `/`, `-` or `.` when the locale
 * is `th` or `en-GB`, `mm/dd/yyyy` when it is `en-US`, and either way when one
 * part exceeds 12 — which is what makes `31/12/9999` unambiguous everywhere.
 * `01/09/2027` with no locale, or under plain `en`, stays `null`: January or
 * September depends on who wrote it, and that is never guessed.
 *
 * A four-digit year ≥ 2400 is converted from the Buddhist era under
 * `locale: 'th'` or beside a Thai month; otherwise it is left as written.
 */
export function isoDateOf(text: string, locale?: DateLocale | undefined): string | null {
  const t = text.trim();
  if (t === '') return null;
  const thai = locale === 'th';

  const isoMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:T.*)?$/.exec(t);
  if (isoMatch) {
    const y = Number(isoMatch[1]);
    return iso(thai ? ceYearOf(y) : y, Number(isoMatch[2]), Number(isoMatch[3]));
  }
  const ymd = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/.exec(t);
  if (ymd) {
    const y = Number(ymd[1]);
    return iso(thai ? ceYearOf(y) : y, Number(ymd[2]), Number(ymd[3]));
  }

  // "1 Sep 2027", "1 September 2027", "1-Sep-2027", "15 ก.ย. 2569", "15 กันยายน 2569".
  const dmy = /^(\d{1,2})[\s-]+(\S+?)\.?,?[\s-]+(\d{4})$/u.exec(t);
  // "Sep 1, 2027", "September 1 2027".
  const mdy = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(t);
  const named = dmy
    ? { d: dmy[1]!, mon: dmy[2]!, y: dmy[3]! }
    : mdy
      ? { d: mdy[2]!, mon: mdy[1]!, y: mdy[3]! }
      : null;
  const namedMonth = named === null ? null : monthNumberOf(named.mon);
  if (named !== null && namedMonth !== null) {
    const year = Number(named.y);
    return iso(thai || isThaiMonth(named.mon) ? ceYearOf(year) : year, namedMonth, Number(named.d));
  }

  const numeric = /^(\d{1,2})([/.-])(\d{1,2})\2(\d{4})$/.exec(t);
  if (numeric) {
    const a = Number(numeric[1]);
    const b = Number(numeric[3]);
    const year = Number(numeric[4]);
    let day: number;
    let month: number;
    if (a > 12 && b <= 12) [day, month] = [a, b];
    else if (b > 12 && a <= 12) [day, month] = [b, a];
    else if (locale === 'th' || locale === 'en-GB') [day, month] = [a, b];
    else if (locale === 'en-US') [day, month] = [b, a];
    else return null;
    return iso(thai ? ceYearOf(year) : year, month, day);
  }
  return null;
}

/**
 * The month a calendar heading names — "September 2027", "Sep 2027",
 * "กันยายน 2570" (Buddhist year converted) — as `{ year, month }` with the
 * month 1-based, or `null`. Reads the first such pair anywhere in the text,
 * so a dialog's whole innerText can be handed over.
 */
export function monthYearOf(text: string): { year: number; month: number } | null {
  // Glyphs glued to the words ("‹September 2026›" is what a calendar's
  // innerText reads with its nav chevrons) are noise, not part of a token.
  const compact = text.replace(/[^\p{L}\p{M}\p{N}.\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  for (const m of compact.matchAll(/(\S+?)\.?\s+(\d{4})(?![\d])/gu)) {
    const month = monthNumberOf(m[1]!);
    if (month === null) continue;
    return { year: ceYearOf(Number(m[2])), month };
  }
  for (const m of compact.matchAll(/(\d{4})\s+(\S+)/gu)) {
    const month = monthNumberOf(m[2]!);
    if (month === null) continue;
    return { year: ceYearOf(Number(m[1])), month };
  }
  return null;
}

/** The year, month (1-based) and day of an ISO date, or null. */
export function partsOf(isoDate: string): { year: number; month: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate.trim());
  if (!m) return null;
  const parts = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  return iso(parts.year, parts.month, parts.day) === null ? null : parts;
}

function addMonthsClamped(year: number, month: number, day: number, delta: number): [number, number, number] {
  const total = year * 12 + (month - 1) + delta;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  return [y, m, Math.min(day, daysInMonth(y, m))];
}

function addDays(year: number, month: number, day: number, delta: number): [number, number, number] {
  const d = new Date(year, month - 1, day + delta);
  return [d.getFullYear(), d.getMonth() + 1, d.getDate()];
}

/** The offset grammar: `+30d`, `- 1y`, `+2 months`, `+119 Day`, a bare `+30` meaning days. */
const OFFSET = /\s*([+-])\s*(\d+)\s*(days?|weeks?|months?|years?|d|w|m|y)?\b/giu;

/**
 * A relative date expression as ISO, or `null` when it is not one.
 *
 * Bases: `today`/`now`, `tomorrow`/`next day`, `yesterday`, `monthStart`,
 * `monthEnd`, `nextMonthEnd`, `prevMonthEnd`, `yearStart`, `yearEnd`,
 * `day(25)` (the 25th of this month, clamped), or any literal `isoDateOf`
 * reads. Then any number of offsets: `today+30d`, `today-1y`, `today+119d`,
 * `next day+1`, `monthEnd+1d`, `2027-09-01+2m`. Case and spaces are free.
 * Month offsets clamp the day (31 Jan + 1m is 28/29 Feb), as a person does.
 */
export function resolveDateExpression(expression: string, now: Date = new Date()): string | null {
  const text = expression.trim();
  if (text === '') return null;
  // An ISO literal carries dashes of its own; split after it, not at them.
  const head = /^(\d{4}-\d{1,2}-\d{1,2})/.exec(text) ?? /^([^+-]*)/u.exec(text);
  const base = (head?.[1] ?? '').trim();
  const rest = text.slice(head?.[0].length ?? 0);

  let y = now.getFullYear();
  let m = now.getMonth() + 1;
  let d = now.getDate();
  const key = base.toLowerCase().replace(/[\s_-]+/g, '');
  const dayOf = /^day\((\d{1,2})\)$/.exec(key);
  if (key === 'today' || key === 'now' || key === '') {
    // as is
  } else if (key === 'tomorrow' || key === 'nextday') {
    [y, m, d] = addDays(y, m, d, 1);
  } else if (key === 'yesterday' || key === 'previousday' || key === 'prevday') {
    [y, m, d] = addDays(y, m, d, -1);
  } else if (key === 'monthstart' || key === 'startofmonth') {
    d = 1;
  } else if (key === 'monthend' || key === 'endofmonth') {
    d = daysInMonth(y, m);
  } else if (key === 'nextmonthend') {
    [y, m] = addMonthsClamped(y, m, 1, 1);
    d = daysInMonth(y, m);
  } else if (key === 'nextmonthstart') {
    [y, m, d] = addMonthsClamped(y, m, 1, 1);
  } else if (key === 'prevmonthend' || key === 'lastmonthend' || key === 'previousmonthend') {
    [y, m] = addMonthsClamped(y, m, 1, -1);
    d = daysInMonth(y, m);
  } else if (key === 'yearstart' || key === 'startofyear') {
    [m, d] = [1, 1];
  } else if (key === 'yearend' || key === 'endofyear') {
    [m, d] = [12, 31];
  } else if (dayOf !== null) {
    d = Math.min(Math.max(Number(dayOf[1]), 1), daysInMonth(y, m));
  } else {
    const literal = isoDateOf(base) ?? isoDateOf(base, 'th');
    const parts = literal === null ? null : partsOf(literal);
    if (parts === null) return null;
    ({ year: y, month: m, day: d } = parts);
  }

  let consumed = 0;
  for (const offset of rest.matchAll(OFFSET)) {
    if (offset.index !== consumed) return null;
    consumed = offset.index + offset[0].length;
    const sign = offset[1] === '-' ? -1 : 1;
    const n = Number(offset[2]) * sign;
    const unit = (offset[3] ?? 'd').toLowerCase()[0];
    if (unit === 'd') [y, m, d] = addDays(y, m, d, n);
    else if (unit === 'w') [y, m, d] = addDays(y, m, d, n * 7);
    else if (unit === 'm') [y, m, d] = addMonthsClamped(y, m, d, n);
    else [y, m, d] = addMonthsClamped(y, m, d, n * 12);
  }
  if (rest.slice(consumed).trim() !== '') return null;
  return iso(y, m, d);
}

/** Named formats an author may write instead of a token string. */
const FORMAT_ALIASES: Record<string, string> = {
  iso: 'yyyy-MM-dd',
  short: 'd MMM yyyy',
  long: 'd MMMM yyyy',
  slash: 'dd/MM/yyyy',
  us: 'MMM d, yyyy',
};

/**
 * An ISO date rendered as a page shows it. Tokens: `yyyy` (Buddhist under
 * `th`), `yy`, `MMMM` (full month), `MMM` (short — `ก.ย.` under `th`), `MM`,
 * `M`, `dd`, `d`; anything else is literal. Named formats: `iso` (default),
 * `short` (`d MMM yyyy` — humi's trigger text), `long`, `slash`
 * (`dd/MM/yyyy`), `us`. `null` when `isoDate` is not a date.
 */
export function formatDate(isoDate: string, format = 'iso', locale: DateLocale = 'en'): string | null {
  const parts = partsOf(isoDate);
  if (parts === null) return null;
  const pattern = FORMAT_ALIASES[format.trim().toLowerCase()] ?? format;
  const thai = locale === 'th';
  const year = thai && parts.year < 9999 ? parts.year + BUDDHIST_OFFSET : parts.year;
  const full = thai ? THAI_MONTHS_FULL : EN_MONTHS_FULL;
  const short = thai ? THAI_MONTHS_SHORT : EN_MONTHS_SHORT;
  return pattern.replace(/yyyy|yy|MMMM|MMM|MM|M|dd|d/g, (token) => {
    switch (token) {
      case 'yyyy': return String(year);
      case 'yy': return String(year).slice(-2);
      case 'MMMM': return full[parts.month - 1]!;
      case 'MMM': return short[parts.month - 1]!;
      case 'MM': return pad2(parts.month);
      case 'M': return String(parts.month);
      case 'dd': return pad2(parts.day);
      default: return String(parts.day);
    }
  });
}

/**
 * The `{{date:…}}` builtin: `expression[|format[|locale]]` — `today+30d`,
 * `today|dd/MM/yyyy`, `monthEnd|d MMM yyyy|th`, `2027-09-01|short`. ISO by
 * default. `null` when the expression is not a date, so the variable store
 * can fail loudly with the token that did not resolve.
 */
export function dateBuiltin(spec: string, now: Date = new Date()): string | null {
  const [expression = '', format = 'iso', locale = 'en'] = spec.split('|').map((s) => s.trim());
  const resolved = resolveDateExpression(expression, now);
  if (resolved === null) return null;
  const loc: DateLocale = locale === 'th' || locale === 'en-GB' || locale === 'en-US' ? locale : 'en';
  return formatDate(resolved, format === '' ? 'iso' : format, loc);
}

/**
 * Every rendering a page might give an ISO date, for a read-back that has to
 * recognise its own entry: ISO, `d MMM yyyy` and `d MMMM yyyy` in both
 * languages (Buddhist year under Thai), `dd/MM/yyyy`, `d/M/yyyy`, `MMM d, yyyy`.
 */
export function dateRenderings(isoDate: string): string[] {
  const out = new Set<string>();
  for (const [format, locale] of [
    ['iso', 'en'], ['short', 'en'], ['long', 'en'], ['short', 'th'], ['long', 'th'],
    ['slash', 'en'], ['d/M/yyyy', 'en'], ['slash', 'th'], ['us', 'en'], ['dd MMM yyyy', 'en'],
  ] as const) {
    const rendered = formatDate(isoDate, format, locale);
    if (rendered !== null) out.add(rendered);
  }
  return [...out];
}
