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
 *    the whole list is back; a list that does not yet hold the value is
 *    given a debounce window to start a request and that request the time
 *    to land before it is believed (a server-searched list answers late);
 * 4. match an option by WHOLE name, then whole word, for the whole value,
 *    then its code half, then its label half — never plain substring ("Male"
 *    is inside "Female"); a disabled match is a state verdict;
 * 4½. an option found OUTSIDE the viewport that its own scroll cannot bring
 *    in (a `position: fixed` panel opened below the fold by a trigger on the
 *    last visible line) is a geometry fact, not a missing option: the trigger
 *    is centred, the list reopened if the scroll closed it, and the SAME
 *    option — by its own name — found again; otherwise nothing changes;
 * 5. multi-select: split on `,` / `;` / ` + `, tick each row's checkbox,
 *    Escape;
 * 6. read the trigger back and require it to show what was picked — a click
 *    that landed nowhere is a failure with evidence, not a green step.
 *
 * On a miss the list is closed and the error keeps the `no option named …
 * appeared` wording the runner's state-contradiction rung is keyed on; an
 * option that was found and could not be clicked says exactly that
 * (`ListboxOptionUnclickableError`), keyed on by the same rung.
 * Runner wiring is the runner's half.
 */
import type { Locator, Page, Request } from 'playwright';

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

/** The option was in the open list and the click on it failed — never worded as an option that did not appear. */
export class ListboxOptionUnclickableError extends Error {
  override readonly name = 'ListboxOptionUnclickableError';
  readonly shown: string[];
  readonly trigger: string;
  constructor(trigger: string, value: string, option: string, shown: string[], detail: string) {
    super(
      `opened ${JSON.stringify(trigger)} and found option ${JSON.stringify(option)} for ${JSON.stringify(value)}, ` +
        `but it could not be clicked (${shown.length} shown)${detail === '' ? '' : `: ${detail}`}`,
    );
    this.shown = shown;
    this.trigger = trigger;
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

/**
 * Do these option names hold `part` — by whole name or whole word for any
 * candidate, or as the one prefix match? Pure; the same rules the pick
 * applies, asked of names already read, so a list that holds the value is
 * never made to wait. It decides only whether to keep waiting, never what is
 * clicked.
 */
export function listHolds(options: readonly string[], part: string): boolean {
  for (const candidate of optionCandidates(part)) {
    const [exact, contains] = optionNamePatterns(candidate.text);
    if (options.some((option) => exact.test(option) || contains.test(option))) return true;
  }
  return uniquePrefixMatch(options, part) !== null;
}

/** How long a typed head is given to START a request: a search debounce is 300–500 ms. */
export const SEARCH_DEBOUNCE_MS = 750;

/**
 * Is a typed search head still being answered? Yes while a request it set
 * off is in flight, for one settle after the last one landed (the render),
 * and — with no request seen yet — until the debounce window closes. Never
 * past the budget. Pure.
 */
export function searchStillAnswering(at: {
  sinceTypedMs: number;
  requests: number;
  pending: number;
  sinceLastLandedMs: number | null;
  settleMs: number;
  budgetMs: number;
}): boolean {
  if (at.sinceTypedMs >= at.budgetMs) return false;
  if (at.pending > 0) return true;
  if (at.requests === 0) return at.sinceTypedMs < SEARCH_DEBOUNCE_MS;
  return at.sinceLastLandedMs !== null && at.sinceLastLandedMs < at.settleMs;
}

/** The page's own data requests (xhr/fetch) from now until `stop()`. */
function watchRequests(page: Page): { requests(): number; pending(): number; lastLandedAt(): number | null; stop(): void } {
  const inFlight = new Set<Request>();
  let requests = 0;
  let lastLandedAt: number | null = null;
  const started = (request: Request): void => {
    const type = request.resourceType();
    if (type !== 'xhr' && type !== 'fetch') return;
    inFlight.add(request);
    requests += 1;
  };
  const landed = (request: Request): void => {
    if (inFlight.delete(request)) lastLandedAt = Date.now();
  };
  page.on('request', started);
  page.on('requestfinished', landed);
  page.on('requestfailed', landed);
  return {
    requests: () => requests,
    pending: () => inFlight.size,
    lastLandedAt: () => lastLandedAt,
    stop: () => {
      page.off('request', started);
      page.off('requestfinished', landed);
      page.off('requestfailed', landed);
    },
  };
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

interface FoundOption {
  option: Locator;
  name: string;
  disabled: boolean;
}

/** The first enabled option matching `name` in scope, with its accessible name; a disabled-only match is reported. */
async function findOption(
  scope: Locator,
  name: RegExp,
): Promise<{ option: Locator; name: string; disabled: boolean } | null> {
  const roles = ['option', 'menuitem', 'menuitemradio', 'menuitemcheckbox', 'treeitem'] as const;
  let disabledOnly: { option: Locator; name: string } | null = null;
  for (const role of roles) {
    const matches = scope.getByRole(role, { name, includeHidden: false });
    const count = await matches.count().catch(() => 0);
    for (let i = 0; i < Math.min(count, 12); i++) {
      const option = matches.nth(i);
      if (!(await option.isVisible().catch(() => false))) continue;
      const text = ((await option.innerText({ timeout: 250 }).catch(() => '')) ?? '').replace(/\s+/g, ' ').trim();
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

/**
 * Where the element's box sits when it is not wholly inside the window's
 * viewport; null when it is, or when it cannot be read. One read.
 */
async function outsideViewport(locator: Locator): Promise<{ top: number; bottom: number; viewport: number } | null> {
  return locator
    .first()
    .evaluate(
      (el) => {
        const node = el as unknown as {
          getBoundingClientRect(): { top: number; bottom: number; left: number; right: number };
          ownerDocument: { defaultView: { innerWidth: number; innerHeight: number } | null };
        };
        const view = node.ownerDocument.defaultView;
        if (view === null) return null;
        const r = node.getBoundingClientRect();
        const inside = r.top >= 0 && r.left >= 0 && r.bottom <= view.innerHeight && r.right <= view.innerWidth;
        return inside ? null : { top: Math.round(r.top), bottom: Math.round(r.bottom), viewport: view.innerHeight };
      },
      undefined,
      { timeout: 250 },
    )
    .catch(() => null);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error);
}

/**
 * Pick `value` from the listbox behind `trigger`. See the module comment for
 * the procedure. Throws `ListboxOptionMissingError` (list closed again),
 * `ListboxOptionUnclickableError`, `ListboxOptionDisabledError`, or
 * `ListboxReadBackError`; any other error
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

  // The control handed in may BE the open list (HUMI SIT, 2026-09-18: the
  // indexed agent opened `button "จังหวัด"` and then chose SELECT on the
  // `listbox "จังหวัด"` it revealed — a click on an open listbox has nothing
  // to open and timed out five times). A list is picked from, never clicked.
  const role = await attr(trigger, 'role', 250);
  const isList = role === 'listbox' || role === 'menu' || role === 'tree';
  let opened: { list: Locator; container: Locator } | null = null;
  if (isList && (await trigger.first().isVisible().catch(() => false))) {
    opened = { list: trigger.first(), container: trigger.first().locator('xpath=..') };
  } else {
    const expanded = await attr(trigger, 'aria-expanded', 250);
    if (expanded !== 'true') await trigger.first().click({ timeout });
    opened = await openList(page, trigger, timeout);
  }
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
  }
  if (opened === null) {
    await page.keyboard.press('Escape').catch(() => undefined);
    throw new ListboxOptionMissingError(triggerName, value, [], `no listbox or menu became visible within ${timeout} ms of opening`);
  }
  let { list, container } = opened;
  const filled = await waitForListToFill(page, list, timeout);
  let state = filled.state;
  const isMulti = state.checkboxes > 0 && splitMultiValue(value).length > 1;
  const parts = isMulti ? splitMultiValue(value) : [value];

  const picked: string[] = [];
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
        const traffic = watchRequests(page);
        try {
          await box.fill(head, { timeout }).catch(() => undefined);
          const typedAt = Date.now();
          await page.waitForTimeout(settleMs);
          state = (await waitForListToFill(page, list, timeout)).state;
          // A server-searched list answers after a debounce and a fetch: until
          // then it shows its stale preload, or its own client-side filter of
          // that preload — "No options found" about a value the server holds
          // (HUMI SIT Position, 2026-09-21). A list that already holds the
          // value is not made to wait; one that does not is read again while
          // the typed head may still be being answered, and only then believed.
          while (!listHolds(state.options, part)) {
            const landedAt = traffic.lastLandedAt();
            const answering = searchStillAnswering({
              sinceTypedMs: Date.now() - typedAt,
              requests: traffic.requests(),
              pending: traffic.pending(),
              sinceLastLandedMs: landedAt === null ? null : Date.now() - landedAt,
              settleMs,
              budgetMs: timeout,
            });
            if (!answering) break;
            await page.waitForTimeout(50);
            state = await listState(list, 250);
          }
        } finally {
          traffic.stop();
        }
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
    // Last resort before a miss: the ONE option that starts with the value.
    // Never a substring ("Male" is not "Female") and never one of several
    // ("New Hire" is not every "New Hire — …"): exactly one option, or
    // nothing. The read-back below records what the control shows, so a
    // wrong guess is visible in the proof rather than silent. Measured live
    // (humi, 2026-09-05): "Thai" against a list whose only match was
    // "Thailand - Thailand" cost the agent a miss, a settle, and a turn.
    const locate = async (): Promise<{ hit: FoundOption | null; by: 'whole' | 'code' | 'label' | 'prefix' }> => {
      let found: FoundOption | null = null;
      for (const candidate of candidates) {
        const [exact, contains] = optionNamePatterns(candidate.text);
        found = (await findOption(container, exact)) ?? (await findOption(page.locator('body'), exact));
        if (found === null || found.disabled) {
          const word = (await findOption(container, contains)) ?? (await findOption(page.locator('body'), contains));
          if (word !== null && (!word.disabled || found === null)) found = word;
        }
        if (found !== null && !found.disabled) return { hit: found, by: candidate.by };
      }
      const unique = uniquePrefixMatch(state.options, part);
      if (unique !== null) {
        const [exact] = optionNamePatterns(unique);
        const byPrefix = (await findOption(container, exact)) ?? (await findOption(page.locator('body'), exact));
        if (byPrefix !== null && !byPrefix.disabled) return { hit: byPrefix, by: 'prefix' };
      }
      return { hit: found, by: 'whole' };
    };
    const located = await locate();
    let hit = located.hit;
    if (hit !== null && !hit.disabled) matchedBy = located.by;
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
    // 4½. The option is found; can a pointer reach it? A trigger on the last
    // visible line opens its `position: fixed` panel below the fold, where
    // no scroll of the option can bring it in and the click spends its whole
    // budget (HUMI SIT Employee Group, 2026-09-21: 10 s on `fast`, 10 s on
    // `late`, all four options read). One read for a pick that already
    // works; otherwise the option's own scroll first, and only then the
    // trigger is centred, the list reopened if that scroll closed it, the
    // typed head put back, and the SAME option — by its own name — found
    // again. Anything else leaves `hit` as it was, to fail as it would have.
    let reach = await outsideViewport(hit.option);
    if (reach !== null) {
      await hit.option.scrollIntoViewIfNeeded({ timeout: 500 }).catch(() => undefined);
      reach = await outsideViewport(hit.option);
    }
    let recentred = false;
    if (reach !== null && !isList) {
      await trigger
        .first()
        .evaluate(
          (el) => (el as unknown as { scrollIntoView(o: { block: string; inline: string }): void }).scrollIntoView({ block: 'center', inline: 'nearest' }),
          undefined,
          { timeout: 1_000 },
        )
        .catch(() => undefined);
      await page.waitForTimeout(settleMs);
      if (!(await list.first().isVisible().catch(() => false))) {
        if ((await attr(trigger, 'aria-expanded', 250)) !== 'true') await trigger.first().click({ timeout }).catch(() => undefined);
        const reopened = await openList(page, trigger, timeout);
        if (reopened !== null) ({ list, container } = reopened);
        if (typed !== undefined) {
          const again = await searchBoxOf(container, list);
          if (again !== null) await again.fill(typed, { timeout }).catch(() => undefined);
        }
      }
      const deadline = Date.now() + timeout;
      for (;;) {
        state = await listState(list, 250);
        const again = (await locate()).hit;
        if (again !== null && !again.disabled && again.name === hit.name) {
          hit = again;
          recentred = true;
          break;
        }
        if (Date.now() >= deadline) break;
        await page.waitForTimeout(100);
      }
    }
    const optionName = hit.name;
    const unclickable = (error: unknown): ListboxOptionUnclickableError =>
      new ListboxOptionUnclickableError(
        triggerName,
        part,
        optionName,
        state.options,
        `${describe(error)}${
          reach === null ? '' : ` — the option sat at y ${reach.top}–${reach.bottom} of a ${reach.viewport} px viewport`
        }${recentred ? ', and again after the trigger was centred and the list reopened' : ''}`,
      );
    // 5. Tick or click.
    if (isMulti) {
      // The row's own checkbox, not the row: a click on the row's padding
      // toggles nothing, and `setChecked` is idempotent for a row already on.
      const checkbox = hit.option.locator('input[type="checkbox"], [role="checkbox"]').first();
      if ((await checkbox.count()) > 0) {
        await checkbox.setChecked(true, { timeout });
      } else {
        await hit.option.click({ timeout });
      }
    } else {
      try {
        await hit.option.click({ timeout });
      } catch (error) {
        await page.keyboard.press('Escape').catch(() => undefined);
        throw unclickable(error);
      }
    }
    picked.push(hit.name);
  }
  if (isMulti) await page.keyboard.press('Escape').catch(() => undefined);

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
  if (!confirmed && !isMulti && (options.readBack ?? 'require') === 'require') {
    throw new ListboxReadBackError(value, picked[0] ?? value, readBack);
  }
  return {
    picked,
    via: isMulti ? 'checkbox' : 'option',
    ...(typed === undefined ? {} : { typed }),
    matchedBy,
    readBack,
    confirmed,
    waitedMs: filled.waitedMs,
  };
}
