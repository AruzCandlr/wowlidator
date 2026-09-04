/**
 * Driving a calendar-dialog date field — humi's `DateField`: a
 * `button[aria-haspopup=dialog][aria-expanded]` trigger showing "15 ก.ย. 2569"
 * or "Select date"/"เลือกวันที่", opening a portaled `div[role=dialog]`
 * (aria-label "Calendar"/"ปฏิทิน") with a month heading, `Previous month`/
 * `Next month` (`เดือนก่อนหน้า`/`เดือนถัดไป`) buttons, a grid of day buttons
 * named by the bare day number (`aria-pressed` for the selected one,
 * `disabled` outside min/max), a month view behind the heading (a `select`
 * for the month, a number input for the year), and Today/Clear.
 *
 * The engine had no path into it (EH-11, ~150 rows: BE Effective Start/End,
 * PY-Config effective dates, probation extend/confirm, TM leave ranges):
 * `fill` on a `<button>` fails, the read-only-shell rung wants an input,
 * so every such date went to an agent call guessing at day buttons.
 *
 * The procedure, deterministic and $0:
 *
 * 1. open the trigger unless `aria-expanded="true"`; wait for the dialog;
 * 2. read the month heading (any month name + 4-digit year in the dialog's
 *    text; a Buddhist year is converted) and step month by month with the
 *    nav buttons until it is the target month — at most `MAX_MONTH_STEPS`;
 *    when the jump is long and the heading is a button that opens a month
 *    view with a month `select` and a year field, use those instead;
 * 3. click the day button named by the bare day number (the LAST such match
 *    for a day ≥ 15 — the leading days of the previous month sit above the
 *    grid — and the first for a day < 15, where trailing days follow); a
 *    disabled one is `DateOutOfRangeError`, a state verdict;
 * 4. wait for the dialog to close (an OK/Apply/ตกลง button is pressed when
 *    one is offered), read the trigger back, and require it to render the
 *    date picked — a picker whose trigger still says "Select date" did not
 *    take the click.
 *
 * Runner wiring (rung 1.03 for `fill`/`type` onto `button[aria-haspopup=
 * dialog]`, `isoDateOf` for the value, `detail.enteredAs`) is the runner's.
 */
import type { Locator, Page } from 'playwright';

import { dateRenderings, daysInMonth, formatDate, isoDateOf, monthYearOf, partsOf } from './dates.js';
import { waitForDialog } from './modal.js';

export interface PickDateOptions {
  /** Budget for opening, for each nav click, and for the pick. Default 2 000 ms. */
  timeout?: number | undefined;
  /** How long the dialog is given to close after the pick. Default 1 500 ms. */
  settleMs?: number | undefined;
}

export interface PickDateResult {
  iso: string;
  /** What the trigger shows afterwards. */
  shown: string | null;
  /** Whether `shown` renders the date picked. */
  confirmed: boolean;
  /** Month-navigation clicks made. */
  navigated: number;
  /** How the target month was reached. */
  via: 'same-month' | 'month-nav' | 'month-view';
  /** The heading's text when the day was clicked. */
  heading: string;
}

/** The day exists in the picker and is disabled — the page's rule, not the selector's. */
export class DateOutOfRangeError extends Error {
  override readonly name = 'DateOutOfRangeError';
  constructor(iso: string, heading: string) {
    super(`date ${iso} is outside the picker's allowed range — its day button under "${heading}" is disabled (element is not enabled)`);
  }
}

/** The calendar could not be driven to the date: no dialog, no heading, no day button, or no close. */
export class CalendarDriveError extends Error {
  override readonly name = 'CalendarDriveError';
  constructor(message: string) {
    super(message);
  }
}

/** 20 years either way, one click per month. */
export const MAX_MONTH_STEPS = 240;
/** Past this many months the month view (when there is one) is cheaper than clicking. */
const MONTH_VIEW_THRESHOLD = 13;

const NEXT_MONTH = /^(next month|เดือนถัดไป|เดือนหน้า|next|›|>)$/i;
const PREVIOUS_MONTH = /^(previous month|prev month|เดือนก่อนหน้า|เดือนก่อน|previous|prev|‹|<)$/i;
const NEXT_YEAR = /^(next year|ปีถัดไป|ปีหน้า)$/i;
const PREVIOUS_YEAR = /^(previous year|prev year|ปีก่อนหน้า|ปีก่อน)$/i;
const SELECT_MONTH = /^(select month|month|เลือกเดือน|เดือน)$/i;
const SELECT_YEAR = /^(select year|year|เลือกปี|ปี)$/i;
const CONFIRM = /^(ok|okay|apply|done|confirm|ตกลง|ยืนยัน|เสร็จสิ้น)$/i;

async function attr(locator: Locator, name: string, timeout: number): Promise<string | null> {
  return locator
    .first()
    .evaluate((el, n: string) => (el as unknown as { getAttribute(a: string): string | null }).getAttribute(n), name, { timeout })
    .catch(() => null);
}

async function textOf(locator: Locator, timeout: number): Promise<string> {
  return ((await locator.first().innerText({ timeout }).catch(() => '')) ?? '').replace(/[ \t]+/g, ' ').trim();
}

/** The dialog's heading month, from whatever line of its text names one. */
async function headingOf(dialog: Locator, timeout: number): Promise<{ text: string; year: number; month: number } | null> {
  const text = await textOf(dialog, timeout);
  const parsed = monthYearOf(text);
  if (parsed === null) return null;
  // Keep the heading line itself for the record and for finding its button —
  // minus the nav chevrons innerText glues to it ("‹September 2026›").
  const line = text.split(/\n/).find((l) => monthYearOf(l) !== null) ?? text.slice(0, 60);
  return { text: line.replace(/[^\p{L}\p{M}\p{N}.\s]/gu, ' ').replace(/\s+/g, ' ').trim(), ...parsed };
}

function monthsBetween(from: { year: number; month: number }, to: { year: number; month: number }): number {
  return (to.year - from.year) * 12 + (to.month - from.month);
}

/**
 * Jump through the month view when the dialog offers one: a `select` named
 * for the month and a year field. Returns true when the heading now reads the
 * target month.
 */
async function jumpViaMonthView(
  dialog: Locator,
  target: { year: number; month: number },
  timeout: number,
): Promise<boolean> {
  let monthSelect = dialog.getByRole('combobox', { name: SELECT_MONTH }).first();
  let yearField = dialog.getByRole('spinbutton', { name: SELECT_YEAR }).or(dialog.getByRole('textbox', { name: SELECT_YEAR })).first();
  if (!(await monthSelect.isVisible().catch(() => false))) {
    // humi: the month heading is a button that opens the month view.
    const heading = await headingOf(dialog, timeout);
    if (heading === null) return false;
    const headingButton = dialog.getByRole('button', { name: new RegExp(`^\\s*${heading.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'iu') }).first();
    if (!(await headingButton.isVisible().catch(() => false))) return false;
    await headingButton.click({ timeout }).catch(() => undefined);
    monthSelect = dialog.getByRole('combobox', { name: SELECT_MONTH }).first();
    yearField = dialog.getByRole('spinbutton', { name: SELECT_YEAR }).or(dialog.getByRole('textbox', { name: SELECT_YEAR })).first();
    if (!(await monthSelect.isVisible().catch(() => false))) return false;
  }
  // The year field shows the era the heading shows: a value ≥ 2400 is Buddhist.
  const shownYear = Number(await yearField.inputValue({ timeout }).catch(() => ''));
  const buddhist = Number.isFinite(shownYear) && shownYear >= 2400;
  const wantYear = buddhist ? target.year + 543 : target.year;
  if (await yearField.isVisible().catch(() => false)) {
    await yearField.fill(String(wantYear), { timeout }).catch(() => undefined);
    await yearField.press('Enter', { timeout }).catch(() => undefined);
  }
  await monthSelect.selectOption({ index: target.month - 1 }, { timeout }).catch(() => undefined);
  // A month grid (humi) needs the month button clicked to return to the day view.
  const monthButtons = dialog.getByRole('button', { pressed: true });
  if ((await monthButtons.count().catch(() => 0)) > 0 && (await monthSelect.isVisible().catch(() => false))) {
    const options = await monthSelect.locator('option').allInnerTexts().catch(() => [] as string[]);
    const label = options[target.month - 1];
    if (label !== undefined) {
      const button = dialog.getByRole('button', { name: new RegExp(`^\\s*${label.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'iu') }).first();
      await button.click({ timeout }).catch(() => undefined);
    }
  }
  const after = await headingOf(dialog, timeout);
  return after !== null && after.year === target.year && after.month === target.month;
}

/**
 * Pick `isoDate` in the calendar dialog behind `trigger`. See the module
 * comment for the procedure. Throws `DateOutOfRangeError` for a disabled day
 * and `CalendarDriveError` for a picker that could not be driven.
 */
export async function pickDateInDialog(
  page: Page,
  trigger: Locator,
  isoDate: string,
  options: PickDateOptions = {},
): Promise<PickDateResult> {
  const timeout = options.timeout ?? 2_000;
  const settleMs = options.settleMs ?? 1_500;
  const target = partsOf(isoDate);
  if (target === null) throw new CalendarDriveError(`${JSON.stringify(isoDate)} is not an ISO date (YYYY-MM-DD)`);

  const expanded = await attr(trigger, 'aria-expanded', 250);
  if (expanded !== 'true') await trigger.first().click({ timeout });
  const dialog = await waitForDialog(page, timeout);
  if (dialog === null) throw new CalendarDriveError(`no dialog opened within ${timeout} ms of clicking the date field`);

  // 2. Reach the month.
  let heading = await headingOf(dialog, timeout);
  if (heading === null) {
    await page.keyboard.press('Escape').catch(() => undefined);
    throw new CalendarDriveError(`the dialog shows no month heading to navigate by (text: ${JSON.stringify((await textOf(dialog, timeout)).slice(0, 120))})`);
  }
  let navigated = 0;
  let via: PickDateResult['via'] = 'same-month';
  let delta = monthsBetween(heading, target);
  if (Math.abs(delta) > MONTH_VIEW_THRESHOLD && (await jumpViaMonthView(dialog, target, timeout))) {
    via = 'month-view';
    heading = (await headingOf(dialog, timeout)) ?? heading;
    delta = monthsBetween(heading, target);
  }
  // Year nav buttons cover the long way faster when there is no month view.
  while (Math.abs(delta) >= 12) {
    const yearButton = dialog.getByRole('button', { name: delta > 0 ? NEXT_YEAR : PREVIOUS_YEAR }).first();
    if (!(await yearButton.isVisible().catch(() => false))) break;
    await yearButton.click({ timeout });
    navigated += 1;
    heading = (await headingOf(dialog, timeout)) ?? heading;
    delta = monthsBetween(heading, target);
    via = 'month-nav';
  }
  while (delta !== 0 && navigated < MAX_MONTH_STEPS) {
    const nav = dialog.getByRole('button', { name: delta > 0 ? NEXT_MONTH : PREVIOUS_MONTH }).first();
    if (!(await nav.isVisible().catch(() => false))) {
      await page.keyboard.press('Escape').catch(() => undefined);
      throw new CalendarDriveError(`the dialog under "${heading.text}" offers no ${delta > 0 ? 'next' : 'previous'}-month control to reach ${isoDate}`);
    }
    await nav.click({ timeout });
    navigated += 1;
    via = 'month-nav';
    const next = await headingOf(dialog, timeout);
    if (next === null) break;
    const moved = monthsBetween(heading, next);
    heading = next;
    delta = monthsBetween(heading, target);
    if (moved === 0) {
      // The picker refused to move — its max/min month. The date is out of range.
      await page.keyboard.press('Escape').catch(() => undefined);
      throw new DateOutOfRangeError(isoDate, heading.text);
    }
  }
  if (delta !== 0) {
    await page.keyboard.press('Escape').catch(() => undefined);
    throw new CalendarDriveError(`could not reach ${isoDate}: after ${navigated} month steps the heading reads "${heading.text}"`);
  }

  // 3. The day.
  const day = target.day;
  const dayButtons = dialog.getByRole('button', { name: new RegExp(`^\\s*0?${day}\\s*$`) });
  const count = await dayButtons.count().catch(() => 0);
  if (count === 0) {
    await page.keyboard.press('Escape').catch(() => undefined);
    throw new CalendarDriveError(`no day button named "${day}" under "${heading.text}" (${daysInMonth(target.year, target.month)} days in that month)`);
  }
  const chosen = day >= 15 ? dayButtons.nth(count - 1) : dayButtons.first();
  const disabled = (await attr(chosen, 'aria-disabled', 250)) === 'true' || !(await chosen.isEnabled().catch(() => true));
  if (disabled) {
    await page.keyboard.press('Escape').catch(() => undefined);
    throw new DateOutOfRangeError(isoDate, heading.text);
  }
  const headingText = heading.text;
  await chosen.click({ timeout });

  // 4. Close and read back.
  const closed = await waitForClose(dialog, settleMs);
  if (!closed) {
    const confirm = dialog.getByRole('button', { name: CONFIRM }).first();
    if (await confirm.isVisible().catch(() => false)) {
      await confirm.click({ timeout }).catch(() => undefined);
      await waitForClose(dialog, settleMs);
    }
  }
  const shown = await readTrigger(trigger, timeout);
  const confirmed = shown !== null && showsDate(shown, isoDate);
  return { iso: isoDate, shown, confirmed, navigated, via, heading: headingText };
}

async function waitForClose(dialog: Locator, settleMs: number): Promise<boolean> {
  const deadline = Date.now() + settleMs;
  for (;;) {
    if (!(await dialog.isVisible().catch(() => false))) return true;
    if (Date.now() >= deadline) return false;
    await dialog.page().waitForTimeout(50);
  }
}

async function readTrigger(trigger: Locator, timeout: number): Promise<string | null> {
  try {
    const held = await trigger.first().evaluate(
      (el) => {
        const node = el as unknown as { value?: unknown; getAttribute(n: string): string | null; innerText?: string; textContent?: string | null };
        if (typeof node.value === 'string' && node.value !== '') return node.value;
        return (node.getAttribute('aria-valuetext') ?? node.innerText ?? node.textContent ?? '').replace(/\s+/g, ' ').trim();
      },
      undefined,
      { timeout },
    );
    return typeof held === 'string' ? held : null;
  } catch {
    return null;
  }
}

/**
 * Does `shown` render `isoDate`? Parsed first (any locale the text implies),
 * then compared against every rendering the page might use.
 */
export function showsDate(shown: string, isoDate: string): boolean {
  const text = shown.replace(/\s+/g, ' ').trim();
  if (text === '') return false;
  for (const locale of [undefined, 'th', 'en-GB'] as const) {
    if (isoDateOf(text, locale) === isoDate) return true;
  }
  const lower = text.toLowerCase();
  if (dateRenderings(isoDate).some((r) => lower.includes(r.toLowerCase()))) return true;
  // A day-first rendering with a 2-digit year or extra words — the month and day at least.
  const parts = partsOf(isoDate);
  if (parts === null) return false;
  const short = formatDate(isoDate, 'd MMM', 'en')?.toLowerCase();
  const shortTh = formatDate(isoDate, 'd MMM', 'th');
  return (short !== undefined && lower.includes(short)) || (shortTh !== null && text.includes(shortTh));
}
