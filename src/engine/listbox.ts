/**
 * Choosing from a hand-rolled listbox the way a person does.
 *
 * humi's selects are `button[aria-haspopup=listbox][aria-expanded]` triggers
 * over a `ul[role=listbox] > li[role=option][aria-disabled]` list — sometimes
 * portaled to `<body>`, sometimes with a search `<input>` above the list
 * ("Type to search..." / "Search..." / "ค้นหา...") that filters up to 813
 * options, sometimes a checkbox row per option for a multi-select, and for
 * a dependent pair (Province → District → Sub-district) the child list
 * fills only after a fetch. `#selectCustom` in `runner.ts` clicked the
 * trigger and one option page-wide with nothing else — no typing, no wait
 * for the fetch, no multi, and on a miss an error that was not a content
 * miss, so the ladder paid a healer that cannot open a list and an agent
 * look before failing (EH-01, ~450 rows: every EC hire's ~20 coded lookups,
 * PY-Config Company→Branch, BE Company multi-select, TM leave type,
 * probation result).
 *
 * The procedure, deterministic and $0:
 *
 * 1. open the list unless `aria-expanded="true"` (a second click closes it);
 * 2. wait for the list to HOLD something — ≥ 1 option, ≥ 1 checkbox row, or
 *    an empty row ("No options" / "ไม่พบข้อมูล") — up to `timeout`, because
 *    a dependent list still fetching is the common case;
 * 3. when a search box sits inside or beside the open list, type the stable
 *    head of the value (its CODE half — "A" of "A - Permanent", "40106337"
 *    of "40106337 (Job Title)" — else the whole value); if that leaves the
 *    list empty, clear and type the LABEL half; if still empty, clear so
 *    the whole list is back;
 * 4. match an option by WHOLE name, then whole word, for the whole value,
 *    then its code half, then its label half — never plain substring ("Male"
 *    is inside "Female"); a disabled match is a state verdict;
 * 5. multi-select: split on `,` / `;` / ` + `, tick each row's checkbox,
 *    Escape;
 * 6. read the trigger back and require it to show what was picked — a click
 *    that landed nowhere is a failure with evidence, not a green step.
 *
 * Two different misses, two different errors, because they mean opposite
 * things (2026-09-11):
 *
 * - `ListboxOptionMissingError` — the list was READ and the option is not in
 *   it. Keeps the `no option named … appeared` wording the runner's
 *   state-contradiction rung is keyed on: the read IS a verdict about the
 *   application.
 * - `ListboxNotReadableError` — no list, menu or panel of rows was found at
 *   all, so NOTHING is known about what the control offers. It is not a
 *   state contradiction and must never be worded as one; the healer is still
 *   skipped, since the target is inside a popup it cannot open.
 *
 * Both close the list. Runner wiring is the runner's half.
 */
import type { Locator, Page } from 'playwright';

import { codeAndLabelOf, foldedMatch, type FoldedMatch } from './normalise.js';
import { optionNamePatterns } from './selector.js';

export interface SelectFromListboxOptions {
  /** Budget for opening, for the list to fill, and for the pick. Default 2 000 ms. */
  timeout?: number | undefined;
  /** How long the list is given to react to a keystroke. Default 250 ms. */
  settleMs?: number | undefined;
  /** Type into a search box when one is offered. Default true. */
  typeToFilter?: boolean | undefined;
  /**
   * `require` (default): the trigger must show the picked value afterwards
   * or the pick throws. `record`: read it, report it, never throw on it —
   * for a trigger whose text is its label, not its value.
   */
  readBack?: 'require' | 'record' | undefined;
}

export interface ListboxSelection {
  /** The option names actually clicked / ticked, in order. */
  picked: string[];
  via: 'option' | 'checkbox';
  /** What was typed into the search box, when one was used. */
  typed?: string | undefined;
  /**
   * Which candidate found the option: the whole value, its code half, its
   * label half — or `prefix`, the one option in the list that starts with
   * the value when nothing matched whole ("Thai" → "Thailand - Thailand").
   */
  matchedBy: 'whole' | 'code' | 'label' | 'prefix';
  /** What the trigger showed afterwards, and whether that holds the pick. */
  readBack: string | null;
  confirmed: boolean;
  /** How long the list took to hold anything after opening. */
  waitedMs: number;
}

/**
 * The one option name that begins with `value` (case-folded, whitespace
 * collapsed, a code-half `X - ` prefix on the option tolerated), or null when
 * none or several do. Pure; the pick rung's last resort before a miss.
 */
export function uniquePrefixMatch(options: readonly string[], value: string): string | null {
  const fold = (text: string): string => text.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
  const wanted = fold(value);
  if (wanted.length < 2) return null;
  const hits = options.filter((option) => {
    const name = fold(option);
    if (name === wanted) return false; // a whole match belongs to the rung above
    if (name.startsWith(wanted)) return true;
    // "TH - Thailand": the label half after a code dash may carry the prefix.
    const dash = name.indexOf(' - ');
    return dash > 0 && name.slice(dash + 3).startsWith(wanted);
  });
  return hits.length === 1 ? hits[0]! : null;
}

/** The list opened but never held the option — closed again; wording is a parsed contract. */
export class ListboxOptionMissingError extends Error {
  override readonly name = 'ListboxOptionMissingError';
  readonly shown: string[];
  /**
   * Was `shown` a list narrowed by a typed search head, or the whole list?
   * The agent loop's enumerated-listbox judge (`listboxCannotOffer`) reads
   * only a whole enumeration as evidence that the control cannot offer a
   * value — a filtered list says nothing about what the filter hid.
   */
  readonly filtered: boolean;
  /**
   * The search head the list's own empty row answered ("No options found")
   * — the application's own statement that nothing matches that text — or
   * null when no search was typed or every head returned options.
   */
  readonly searchedEmpty: string | null;
  /** The trigger's own label when the list opened — the page's name for the control, in its language. */
  readonly trigger: string;
  constructor(
    trigger: string,
    value: string,
    shown: string[],
    detail: string,
    evidence: { filtered?: boolean | undefined; searchedEmpty?: string | null | undefined } = {},
  ) {
    super(
      `opened ${JSON.stringify(trigger)} but no option named ${JSON.stringify(value)} appeared ` +
        `(looked for role=option, menuitem, menuitemradio; ${
          shown.length === 0 ? 'the list held no options' : `${shown.length} shown: ${shown.slice(0, 8).map((s) => JSON.stringify(s)).join(', ')}${shown.length > 8 ? ', …' : ''}`
        })${detail === '' ? '' : `: ${detail}`}`,
    );
    this.shown = shown;
    this.filtered = evidence.filtered ?? false;
    this.searchedEmpty = evidence.searchedEmpty ?? null;
    this.trigger = trigger;
  }
}

/**
 * The list was never read — so this says NOTHING about what the control can
 * offer, and must not be worded as if it did.
 *
 * Split out of `ListboxOptionMissingError` on 2026-09-11. The old error was
 * thrown with `shown: []` when no panel was found at all, and its sentence
 * read "opened X but no option named Y appeared" — a claim about the
 * application made from zero evidence. Live on humi SIT the option was
 * right there (`CDS (C001)`, a checkbox row), and a case was failed and a
 * whole agent leg spent trying to work around a control that was working.
 *
 * A harness that could not see is a harness fault, not an application one:
 * the wording says so, and the runner classifies it as such.
 */
export class ListboxNotReadableError extends Error {
  override readonly name = 'ListboxNotReadableError';
  readonly trigger: string;
  readonly value: string;

  constructor(trigger: string, value: string, timeout: number) {
    super(
      `opened ${JSON.stringify(trigger)} but could not read its list within ${timeout} ms — ` +
        `no list, menu or panel of rows became visible, so nothing is known about whether ` +
        `${JSON.stringify(value)} is offered. This is the harness failing to see the control, ` +
        'not the control failing to offer the value.',
    );
    this.trigger = trigger;
    this.value = value;
  }
}

/** The option is there and cannot be chosen — a fact about the page, not the selector. */
export class ListboxOptionDisabledError extends Error {
  override readonly name = 'ListboxOptionDisabledError';
  constructor(value: string, name: string) {
    super(`option ${JSON.stringify(name)} for ${JSON.stringify(value)} is disabled — element is not enabled, so it cannot be chosen`);
  }
}

/** The pick landed but the control does not show it. */
export class ListboxReadBackError extends Error {
  override readonly name = 'ListboxReadBackError';
  constructor(value: string, picked: string, shown: string | null) {
    super(
      `picked ${JSON.stringify(picked)} for ${JSON.stringify(value)} but the control now shows ${
        shown === null ? 'nothing readable' : JSON.stringify(shown)
      } — the selection did not take`,
    );
  }
}

const EMPTY_ROW = /^(no (?:options?|results?|data|matches?)(?: found)?|nothing found|not found|ไม่พบ(?:ข้อมูล|รายการ|ผลลัพธ์)?|ไม่มี(?:ข้อมูล|รายการ|ตัวเลือก))$/iu;
const SEARCH_INPUT = 'input[type="text"], input[type="search"], input:not([type]), [role="searchbox"], [role="textbox"], [role="combobox"]';

/** A multi-value: `CDS (C001), B2S (C006)` / `A; B` / `A + B`. Never split on a dash. */
export function splitMultiValue(value: string): string[] {
  return value
    .split(/\s*(?:,|;|\s\+\s)\s*/u)
    .map((v) => v.trim())
    .filter((v) => v !== '');
}

/** The ordered candidates for an option name: whole, code half, label half. */
export function optionCandidates(value: string): { text: string; by: 'whole' | 'code' | 'label' }[] {
  const out: { text: string; by: 'whole' | 'code' | 'label' }[] = [{ text: value.trim(), by: 'whole' }];
  const halves = codeAndLabelOf(value);
  if (halves !== null) {
    if (halves.code !== value.trim()) out.push({ text: halves.code, by: 'code' });
    if (halves.label !== value.trim()) out.push({ text: halves.label, by: 'label' });
  }
  return out;
}

async function attr(locator: Locator, name: string, timeout: number): Promise<string | null> {
  return locator
    .first()
    .evaluate((el, n: string) => (el as unknown as { getAttribute(a: string): string | null }).getAttribute(n), name, { timeout })
    .catch(() => null);
}

/** The open list's container: `aria-controls` target, else the last visible listbox/menu on the page. */
async function openList(page: Page, trigger: Locator, timeout: number): Promise<{ list: Locator; container: Locator } | null> {
  const controls = await attr(trigger, 'aria-controls', 250);
  const deadline = Date.now() + timeout;
  for (;;) {
    if (controls) {
      const byId = page.locator(`[id="${controls.replace(/"/g, '\\"')}"]`);
      if (await byId.first().isVisible().catch(() => false)) {
        return { list: byId.first(), container: byId.first().locator('xpath=..') };
      }
    }
    const lists = page.locator('[role="listbox"], [role="menu"], [role="tree"]').filter({ visible: true });
    const count = await lists.count().catch(() => 0);
    if (count > 0) {
      const list = lists.nth(count - 1);
      return { list, container: list.locator('xpath=..') };
    }
    if (Date.now() >= deadline) return null;
    await page.waitForTimeout(50);
  }
}

/**
 * The panel a role-less dropdown opened, found by its CONTENT rather than by
 * a role it does not carry.
 *
 * Measured live (humi SIT, 2026-09-11, BE PL_08_01): the Company picker is
 * `button[aria-haspopup="listbox"]` with **no `aria-controls`**, and the
 * panel it opens holds a "Search company..." input and one
 * `input[type=checkbox]` per company — and, with the panel open and
 * `aria-expanded="true"`, the page carries **zero** `role=listbox|menu|tree`
 * and zero `role=option`. `openList` therefore found nothing, and the miss
 * was reported as "no option named CDS (C001) appeared" about a control that
 * offers exactly that row. The harness had read no list at all.
 *
 * So: take the search box the click revealed and walk UP to the nearest
 * ancestor that also contains a row — a checkbox or an option. That ancestor
 * is the panel; everything downstream (`listState`, `searchBoxOf`,
 * `findOption`) already works against it, including the checkbox rows
 * `listState` has always counted.
 *
 * Deliberately narrow: the search box must be one the CLICK revealed (the
 * caller's `before` count), and an ancestor with no rows at all is not a
 * panel — that is the honest "nothing to read" case, which the miss now says
 * in those words. Walking up is capped so a page whose whole body qualifies
 * cannot hand back `<body>` as the list.
 */
const PANEL_ROW = 'input[type="checkbox"], [role="checkbox"], [role="option"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="treeitem"]';
const PANEL_WALK_LIMIT = 8;
/** How many visible search boxes are worth walking up from, newest first. */
const PANEL_CANDIDATES = 5;

async function revealedPanel(
  page: Page,
  searchBoxesBefore: number,
): Promise<{ list: Locator; container: Locator } | null> {
  const revealed = page.locator(SEARCH_INPUT).filter({ visible: true });
  const count = await revealed.count().catch(() => 0);
  if (count <= searchBoxesBefore) return null;
  // EVERY visible search box is a candidate, newest first — not just the
  // last one in DOM order. A page carrying its own search field renders it
  // after the popup as often as before, and taking `nth(count - 1)` blind
  // walked up from the wrong input (2026-09-11). The first candidate whose
  // ancestor is a real panel of visible rows wins; a page with none has no
  // panel, which is the honest answer.
  for (let i = count - 1; i >= 0 && i >= count - PANEL_CANDIDATES; i--) {
    const panel = await panelAround(revealed.nth(i));
    if (panel !== null) return panel;
  }
  return null;
}

/** The nearest ancestor of `box` that is a panel of visible rows, or null. */
async function panelAround(box: Locator): Promise<{ list: Locator; container: Locator } | null> {
  for (let up = 1; up <= PANEL_WALK_LIMIT; up++) {
    const panel = box.locator(`xpath=ancestor::*[${up}]`).first();
    if (!(await panel.isVisible().catch(() => false))) return null;
    // `body` is not a panel. Every page has one and it contains every other
    // control on the page — accepting it would turn a scoped pick into a
    // page-wide one, which is exactly the mistake the `body` fallback in
    // `findOption` is kept narrow to avoid. Caught by the unreadable-panel
    // test, which got `<body>` back and matched a DIFFERENT dropdown's
    // hidden rows (2026-09-11).
    const tag = await panel
      .evaluate((el) => (el as unknown as { tagName: string }).tagName, undefined, { timeout: 250 })
      .catch(() => '');
    if (tag === 'BODY' || tag === 'HTML') return null;
    // VISIBLE rows only: `count()` counts hidden ones too, and a page holding
    // a second, closed dropdown would otherwise look like a filled panel.
    const rows = await panel.locator(PANEL_ROW).filter({ visible: true }).count().catch(() => 0);
    if (rows > 0) return { list: panel, container: panel };
  }
  return null;
}

interface ListState {
  options: string[];
  checkboxes: number;
  emptyRow: string | null;
}

/** What the list holds right now: option names, checkbox rows, an empty-state row. One read. */
async function listState(list: Locator, timeout: number): Promise<ListState> {
  const read = await list
    .first()
    .evaluate(
      (el) => {
        const root = el as unknown as {
          querySelectorAll(sel: string): ArrayLike<{
            textContent: string | null;
            getAttribute(a: string): string | null;
            innerText?: string;
          }>;
        };
        const names: string[] = [];
        const options = root.querySelectorAll('[role="option"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="treeitem"]');
        for (let i = 0; i < options.length; i++) {
          const o = options[i]!;
          const t = (o.getAttribute('aria-label') ?? o.innerText ?? o.textContent ?? '').replace(/\s+/g, ' ').trim();
          if (t !== '') names.push(t);
        }
        const checkboxes = root.querySelectorAll('input[type="checkbox"], [role="checkbox"]').length;
        let empty: string | null = null;
        if (names.length === 0) {
          const rows = root.querySelectorAll('li, [role="presentation"], p, div, span');
          for (let i = 0; i < rows.length; i++) {
            const t = (rows[i]!.innerText ?? rows[i]!.textContent ?? '').replace(/\s+/g, ' ').trim();
            if (t !== '' && t.length <= 60) { empty = t; break; }
          }
        }
        return { options: names, checkboxes, emptyRow: empty };
      },
      undefined,
      { timeout },
    )
    .catch(() => ({ options: [] as string[], checkboxes: 0, emptyRow: null as string | null }));
  return read;
}

/** Wait until the list holds options, checkbox rows, or an empty-state row. */
async function waitForListToFill(page: Page, list: Locator, timeout: number): Promise<{ state: ListState; waitedMs: number }> {
  const started = Date.now();
  const deadline = started + timeout;
  for (;;) {
    const state = await listState(list, Math.max(250, timeout));
    const filled = state.options.length > 0 || state.checkboxes > 0 || (state.emptyRow !== null && EMPTY_ROW.test(state.emptyRow));
    if (filled || Date.now() >= deadline) return { state, waitedMs: Date.now() - started };
    await page.waitForTimeout(50);
  }
}

/** The search box inside or beside the open list, visible now, or null. */
async function searchBoxOf(container: Locator, list: Locator): Promise<Locator | null> {
  for (const scope of [list, container, container.locator('xpath=..')]) {
    const box = scope.locator(SEARCH_INPUT).filter({ visible: true }).first();
    if (await box.isVisible().catch(() => false)) return box;
  }
  return null;
}

/** What a row calls itself: its text, else its `aria-label`, else its label's text. */
async function rowName(option: Locator): Promise<string> {
  const text = ((await option.innerText({ timeout: 250 }).catch(() => '')) ?? '').replace(/\s+/g, ' ').trim();
  if (text !== '') return text;
  const aria = (await attr(option, 'aria-label', 250)) ?? '';
  if (aria.trim() !== '') return aria.replace(/\s+/g, ' ').trim();
  const labelled = await option
    .evaluate(
      (el) => {
        const node = el as unknown as { closest(sel: string): { textContent: string | null } | null };
        return node.closest('label')?.textContent ?? '';
      },
      undefined,
      { timeout: 250 },
    )
    .catch(() => '');
  return (labelled ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * The first enabled option matching `name` in scope, with its accessible
 * name; a disabled-only match is reported.
 *
 * `checkbox` is in the list, but only INSIDE the open panel (`rows: 'panel'`)
 * — never in the page-wide `body` fallback. A multi-select dropdown renders
 * each choice as a checkbox named for the choice (humi's Company picker:
 * `☐ CDS (C001)`), so refusing to look at checkboxes made those lists
 * unreadable; looking at them page-wide would let a form checkbox that
 * happens to share the value's name be ticked instead, which is the one
 * mistake that is worse than a miss.
 */
async function findOption(
  scope: Locator,
  name: RegExp,
  rows: 'panel' | 'page' = 'panel',
): Promise<{ option: Locator; name: string; disabled: boolean } | null> {
  const roles =
    rows === 'panel'
      ? (['option', 'menuitem', 'menuitemradio', 'menuitemcheckbox', 'treeitem', 'checkbox'] as const)
      : (['option', 'menuitem', 'menuitemradio', 'menuitemcheckbox', 'treeitem'] as const);
  let disabledOnly: { option: Locator; name: string } | null = null;
  for (const role of roles) {
    const matches = scope.getByRole(role, { name, includeHidden: false });
    const count = await matches.count().catch(() => 0);
    for (let i = 0; i < Math.min(count, 12); i++) {
      const option = matches.nth(i);
      if (!(await option.isVisible().catch(() => false))) continue;
      // An `<input type=checkbox>` row has NO innerText — its name lives on
      // `aria-label` or the `<label>` wrapping it. Read blind, the pick was
      // recorded as `picked: [""]` and the read-back then failed against a
      // tick that had actually landed (2026-09-11).
      const text = await rowName(option);
      const aria = await attr(option, 'aria-disabled', 250);
      const disabled = aria === 'true' || !(await option.isEnabled().catch(() => true));
      if (disabled) {
        disabledOnly ??= { option, name: text };
        continue;
      }
      return { option, name: text, disabled: false };
    }
  }
  return disabledOnly === null ? null : { ...disabledOnly, disabled: true };
}

/** What the trigger shows now — its text, value or aria-valuetext. */
async function readTrigger(trigger: Locator, timeout: number): Promise<string | null> {
  try {
    const held = await trigger.first().evaluate(
      (el) => {
        const node = el as unknown as {
          value?: unknown;
          getAttribute(name: string): string | null;
          innerText?: string;
          textContent?: string | null;
        };
        if (typeof node.value === 'string' && node.value !== '') return node.value;
        const aria = node.getAttribute('aria-valuetext');
        if (aria) return aria;
        return (node.innerText ?? node.textContent ?? '').replace(/[▾▼⌄˅]/g, ' ').replace(/\s+/g, ' ').trim();
      },
      undefined,
      { timeout },
    );
    return typeof held === 'string' ? held : null;
  } catch {
    return null;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error);
}

/**
 * Pick `value` from the listbox behind `trigger`. See the module comment for
 * the procedure. Throws `ListboxOptionMissingError` (list closed again),
 * `ListboxOptionDisabledError`, or `ListboxReadBackError`; any other error
 * is Playwright's own, from the open click.
 */
export async function selectFromListbox(
  page: Page,
  trigger: Locator,
  value: string,
  options: SelectFromListboxOptions = {},
): Promise<ListboxSelection> {
  const timeout = options.timeout ?? 2_000;
  const settleMs = options.settleMs ?? 250;
  const triggerName = (await readTrigger(trigger, 250)) ?? 'the trigger';

  // A search box on the page before the trigger was even touched is not
  // evidence of anything the click did; counted here so the fallback below
  // can tell "the click revealed one" from "one was already sitting there".
  const searchBoxesBefore = await page.locator(SEARCH_INPUT).filter({ visible: true }).count().catch(() => 0);

  const expanded = await attr(trigger, 'aria-expanded', 250);
  if (expanded !== 'true') await trigger.first().click({ timeout });

  let opened = await openList(page, trigger, timeout);
  if (opened === null && options.typeToFilter !== false) {
    // Some triggers (`aria-haspopup="listbox"` and nothing else — the
    // `HumiSearchableSelect` shape this module's header already names) open
    // onto a bare search box with no role=listbox/option anywhere yet: the
    // list is created only once the search is narrowed, so `openList` above
    // had nothing to find and timed out looking for it. A search-shaped
    // input that appeared as a RESULT of the click — never one already on
    // the page, which searching page-wide could grab by coincidence — is
    // worth one probe keystroke before giving up, the way a person facing an
    // apparently-empty dropdown starts typing rather than assuming it is
    // broken. The probe need not be the exact match: it only has to cause
    // the real list to render; the per-part loop below re-types the correct
    // head into it regardless, once a container exists to scope that search
    // to. A short retry budget — the list rendering in response to a
    // keystroke is a re-render, not the network fetch `waitForListToFill`
    // is patient for.
    const revealed = page.locator(SEARCH_INPUT).filter({ visible: true });
    const revealedCount = await revealed.count().catch(() => 0);
    if (revealedCount > searchBoxesBefore) {
      const firstPart = splitMultiValue(value)[0] ?? value;
      const probe = codeAndLabelOf(firstPart)?.code ?? firstPart;
      await revealed
        .nth(revealedCount - 1)
        .fill(probe, { timeout })
        .catch(() => undefined);
      await page.waitForTimeout(settleMs);
      opened = await openList(page, trigger, Math.min(timeout, 1_500));
    }
    // Still nothing with a list role: the panel may simply not carry one.
    // Find it by its content instead — see `revealedPanel`.
    opened ??= await revealedPanel(page, searchBoxesBefore);
  }
  if (opened === null) {
    await page.keyboard.press('Escape').catch(() => undefined);
    throw new ListboxNotReadableError(triggerName, value, timeout);
  }
  const { list, container } = opened;
  const filled = await waitForListToFill(page, list, timeout);
  let state = filled.state;
  const isMulti = state.checkboxes > 0 && splitMultiValue(value).length > 1;
  const parts = isMulti ? splitMultiValue(value) : [value];

  const picked: string[] = [];
  /** A checkbox panel stays open after a tick; a person presses Escape. */
  let tickedARow = false;
  /** Whether each ticked row read back as checked — the pick's own proof. */
  const ticksLanded: boolean[] = [];
  let typed: string | undefined;
  let matchedBy: 'whole' | 'code' | 'label' | 'prefix' = 'whole';
  for (const part of parts) {
    const candidates = optionCandidates(part);
    // 3. Type-to-filter, the stable head first.
    const box = options.typeToFilter === false ? null : await searchBoxOf(container, list);
    // What the miss below may say about the list: whether `state` is the
    // whole list or a typed narrowing of it, and which head the list's own
    // empty row answered. Read by the agent loop's enumerated-listbox judge.
    let filtered = false;
    let searchedEmpty: string | null = null;
    if (box !== null) {
      const heads = [candidates.find((c) => c.by === 'code')?.text ?? candidates[0]!.text];
      const label = candidates.find((c) => c.by === 'label')?.text;
      if (label !== undefined && label !== heads[0]) heads.push(label);
      let found = false;
      for (const head of heads) {
        await box.fill(head, { timeout }).catch(() => undefined);
        await page.waitForTimeout(settleMs);
        state = (await waitForListToFill(page, list, timeout)).state;
        typed = head;
        if (state.options.length > 0 || state.checkboxes > 0) {
          found = true;
          break;
        }
        if (searchedEmpty === null && state.emptyRow !== null && EMPTY_ROW.test(state.emptyRow)) searchedEmpty = head;
      }
      filtered = found;
      if (!found) {
        await box.fill('', { timeout }).catch(() => undefined);
        await page.waitForTimeout(settleMs);
        state = (await waitForListToFill(page, list, timeout)).state;
      }
    }
    // 4. Match: whole name, then whole word — for the whole value, then its halves.
    let hit: { option: Locator; name: string; disabled: boolean } | null = null;
    for (const candidate of candidates) {
      const [exact, contains] = optionNamePatterns(candidate.text);
      hit = (await findOption(container, exact)) ?? (await findOption(page.locator('body'), exact, 'page'));
      if (hit === null || hit.disabled) {
        const word = (await findOption(container, contains)) ?? (await findOption(page.locator('body'), contains, 'page'));
        if (word !== null && (!word.disabled || hit === null)) hit = word;
      }
      if (hit !== null && !hit.disabled) {
        matchedBy = candidate.by;
        break;
      }
    }
    // Last resort before a miss: the ONE option that starts with the value.
    // Never a substring ("Male" is not "Female") and never one of several
    // ("New Hire" is not every "New Hire — …"): exactly one option, or
    // nothing. The read-back below records what the control shows, so a
    // wrong guess is visible in the proof rather than silent. Measured live
    // (humi, 2026-09-05): "Thai" against a list whose only match was
    // "Thailand - Thailand" cost the agent a miss, a settle, and a turn.
    if (hit === null || hit.disabled) {
      const unique = uniquePrefixMatch(state.options, part);
      if (unique !== null) {
        const [exact] = optionNamePatterns(unique);
        const byPrefix = (await findOption(container, exact)) ?? (await findOption(page.locator('body'), exact, 'page'));
        if (byPrefix !== null && !byPrefix.disabled) {
          hit = byPrefix;
          matchedBy = 'prefix';
        }
      }
    }
    if (hit === null) {
      await page.keyboard.press('Escape').catch(() => undefined);
      throw new ListboxOptionMissingError(
        triggerName,
        part,
        state.options,
        state.emptyRow !== null && state.options.length === 0 ? `the list says ${JSON.stringify(state.emptyRow)}` : '',
        { filtered, searchedEmpty },
      );
    }
    if (hit.disabled) {
      await page.keyboard.press('Escape').catch(() => undefined);
      throw new ListboxOptionDisabledError(part, hit.name);
    }
    // 5. Tick or click. A row that IS a checkbox, or holds one, is ticked
    // whether or not the value is multi — a single value chosen from a
    // multi-select panel is still a tick, and clicking the row's padding
    // toggles nothing. `setChecked` is idempotent for a row already on.
    const ownCheckbox = hit.option.locator('input[type="checkbox"], [role="checkbox"]').first();
    const nestedCheckbox = (await ownCheckbox.count().catch(() => 0)) > 0;
    const isCheckboxRow =
      nestedCheckbox || (await hit.option.evaluate(
        (el) => {
          const node = el as unknown as { getAttribute(a: string): string | null; tagName: string };
          return node.getAttribute('role') === 'checkbox' ||
            (node.tagName === 'INPUT' && node.getAttribute('type') === 'checkbox');
        },
        undefined,
        { timeout: 250 },
      ).catch(() => false));
    if (isCheckboxRow) {
      tickedARow = true;
      const box = nestedCheckbox ? ownCheckbox : hit.option;
      await box.setChecked(true, { timeout }).catch(async () => {
        await hit!.option.click({ timeout });
      });
      // Read the state HERE, while the row is still on screen. The row
      // locator carries `includeHidden: false`, so once Escape closes the
      // panel it resolves to nothing and the read answers false about a tick
      // that landed perfectly well (2026-09-11).
      ticksLanded.push(await box.isChecked({ timeout: 250 }).catch(() => false));
    } else if (isMulti) {
      await hit.option.click({ timeout });
    } else {
      try {
        await hit.option.click({ timeout });
      } catch (error) {
        await page.keyboard.press('Escape').catch(() => undefined);
        throw new ListboxOptionMissingError(triggerName, part, state.options, `the option was found but could not be clicked: ${describe(error)}`);
      }
    }
    picked.push(hit.name);
  }
  if (isMulti || tickedARow) await page.keyboard.press('Escape').catch(() => undefined);

  // 6. Read back.
  await page.waitForTimeout(settleMs);
  const readBack = await readTrigger(trigger, timeout);
  let confirmed = false;
  if (readBack !== null) {
    const outcomes: (FoldedMatch | null)[] = [
      ...parts.map((p) => foldedMatch(p, readBack)),
      ...picked.map((p) => foldedMatch(p, readBack)),
    ];
    confirmed = outcomes.some((o) => o !== null);
  }
  // A checkbox panel's trigger often shows a summary ("1 selected") rather
  // than the value, so the ROW's own checked state is the pick's evidence —
  // read after Escape, so it proves the tick survived the panel closing. The
  // read-back requirement is not waived, only satisfied by better evidence.
  if (!confirmed && tickedARow) {
    confirmed = ticksLanded.length > 0 && ticksLanded.every(Boolean);
  }
  if (!confirmed && !isMulti && (options.readBack ?? 'require') === 'require') {
    throw new ListboxReadBackError(value, picked[0] ?? value, readBack);
  }
  return {
    picked,
    via: isMulti || tickedARow ? 'checkbox' : 'option',
    ...(typed === undefined ? {} : { typed }),
    matchedBy,
    readBack,
    confirmed,
    waitedMs: filled.waitedMs,
  };
}
