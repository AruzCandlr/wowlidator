/**
 * Selector-syntax helpers shared by everything that *writes* a selector from
 * an accessibility name.
 *
 * ## Why this module exists
 *
 * wowlidator reads accessible names through Chrome (`Accessibility.getFullAXTree`,
 * see `captureAxNodes`) but resolves selectors through Playwright's `role=`
 * engine — two independent accessible-name implementations, and they do not
 * agree on case. Chrome applies CSS `text-transform` when it computes a name;
 * Playwright computes from DOM text and does not. So a control styled
 * `text-transform: uppercase` is captured as `"DUE SOON 1 15–29 days"` and
 * matched against `"Due soon 1 15–29 days"` — zero matches, at any timeout.
 *
 * That is not drift and not flake: every generated selector for a
 * text-transformed control is unresolvable *by construction*, and the healer
 * cannot repair it because it reads the same tree and proposes the same name.
 *
 * The fix is to stop asserting a case we never actually observed. `[name="X"]`
 * becomes `[name="X" i]` on the way out of the generator, the healer and the
 * agent, and the runner retries the flagged form once, for free, before paying
 * for a repair.
 *
 * **Case-insensitivity is a loosening, and the guards that make it safe are
 * elsewhere:** the healer still verifies a candidate resolves to exactly one
 * element, and a step that matches two controls differing only in case fails
 * on Playwright's strict-mode violation rather than picking one silently.
 */

/**
 * Matches a `[name="…"]` / `[name='…']` attribute, capturing the quoted value
 * and any existing ` i` flag. Deliberately anchored on the attribute rather
 * than the whole selector, so chained forms (`role=button[name="Edit"] >>
 * nth=0`) and extra role attributes keep everything around the name intact.
 */
const ROLE_NAME_ATTR = /\[name=("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')(\s+i)?\]/;

/** True for a Playwright role-engine selector (`role=button[name="Save"]`). */
export function isRoleSelector(selector: string): boolean {
  return /^\s*role=/.test(selector);
}

/**
 * The case-insensitive form of a role selector, or `null` when there is
 * nothing to relax — a CSS/text/testid selector, a role selector with no
 * name, or one that already carries the flag.
 *
 * Returning `null` rather than the input unchanged is what lets the runner
 * skip a redundant second attempt instead of paying the fast-path timeout
 * twice for the same selector.
 */
export function relaxRoleName(selector: string): string | null {
  if (!isRoleSelector(selector)) return null;
  const match = ROLE_NAME_ATTR.exec(selector);
  if (!match || match[2]) return null;
  // Function replacement, not a string: an accessible name containing `$&`
  // or `$1` would otherwise be mangled by replacement-pattern expansion.
  return selector.replace(ROLE_NAME_ATTR, () => `[name=${match[1]} i]`);
}

/**
 * `relaxRoleName` applied where a selector is being *written* — returns the
 * input untouched when there is nothing to relax, so call sites stay flat.
 */
export function withRelaxedRoleName(selector: string): string {
  return relaxRoleName(selector) ?? selector;
}

/**
 * True for a Playwright text-engine selector (`text=4 days`, `text="4 days"`).
 *
 * These matter to the escalation ladder because a text-engine match *contains
 * the asserted text by construction* — which is what makes narrowing an
 * ambiguous one safe in a way it could never be for a CSS selector, whose
 * matches promise nothing about their contents.
 */
export function isTextSelector(selector: string): boolean {
  return /^\s*text=/.test(selector);
}

/**
 * The exact-match form of an unquoted text selector, or `null` when there is
 * nothing to narrow.
 *
 * Playwright's unquoted `text=4 days` is a case-insensitive *substring* match,
 * so on a page with "Overdue 54 days" and "≤ 14 days" it resolves to all of
 * them and fails strict mode — a step asserting text that is genuinely,
 * uniquely on the page reports "could not resolve". Found by running a
 * generated suite against a real app (PB_04_01): the tier row said exactly
 * "4 days", and three unrelated strings containing "4 days" failed the step.
 *
 * The quoted form `text="4 days"` matches whole (normalised) text only, which
 * is precisely what the author observed when the selector was written. Same
 * contract as `relaxRoleName`: `null` rather than the input when the selector
 * is not a text selector or is already quoted, so the runner can skip a
 * redundant retry instead of paying the fast-path timeout twice.
 */
export function exactTextSelector(selector: string): string | null {
  const match = /^(\s*text=)(.*)$/s.exec(selector);
  if (!match) return null;
  const body = match[2]!;
  // Already exact (quoted) or a regex — nothing to narrow.
  if (/^\s*["'/]/.test(body)) return null;
  return `${match[1]}"${body.replace(/(["\\])/g, '\\$1')}"`;
}

/**
 * The substring form of a *quoted* text selector, or `null` when there is
 * nothing to relax.
 *
 * The exact mirror of `exactTextSelector`, and it exists for the opposite
 * failure. Playwright's quoted `text="X"` matches the whole normalised text of
 * an element, so it resolves **nothing** the moment the page renders that
 * value with anything around it. Found by adjudicating DB_07_01 against a live
 * app: the flow asserted `text="75,000"` and the page renders the amount as
 * `฿{v.toLocaleString('th-TH', { minimumFractionDigits: 2 })}` — that is
 * `฿75,000.00`, so the exact form matched zero elements while the number was
 * plainly on screen. Two `high` defects were filed against an application that
 * was working, and the healer cannot rescue it: it would read the same page
 * and propose the same text.
 *
 * Relaxing is a loosening, so the guards are in the caller (presence
 * assertions only — see the rung in `SmartRunner.#resolve`) and in the two
 * refusals here:
 *
 * - text containing `>>` is never relaxed: unquoted, it would be re-read as
 *   Playwright's selector-chaining operator and mean something else entirely;
 * - text that itself begins with a quote or `/` is never relaxed, for the
 *   same reason — the unquoted form would be re-parsed as a quoted string or
 *   a regex.
 *
 * Same `null`-rather-than-input contract as `relaxRoleName`, so the runner can
 * skip a redundant retry instead of paying the fast-path timeout twice.
 */
export function relaxTextSelector(selector: string): string | null {
  // A chained selector (`text="X" >> nth=0`, the shape a model writes for a
  // label that appears twice) is relaxed on its HEAD and the chain kept —
  // 2026-08-28: every `text="…" >> nth=0` used to skip this rung entirely,
  // because the `>>` refusal below read the chain operator as part of the
  // text. The refusal still guards text that itself contains `>>`.
  const chainAt = selector.indexOf('>>');
  if (chainAt >= 0) {
    const head = relaxTextSelector(selector.slice(0, chainAt));
    return head === null ? null : `${head} ${selector.slice(chainAt)}`;
  }
  const match = /^(\s*text=)(.*)$/s.exec(selector);
  if (!match) return null;
  const body = match[2]!.trim();
  const quoted = /^"((?:[^"\\]|\\.)*)"$/s.exec(body) ?? /^'((?:[^'\\]|\\.)*)'$/s.exec(body);
  if (!quoted) return null;
  const inner = quoted[1]!.replace(/\\(.)/g, '$1');
  if (inner.trim() === '') return null;
  if (inner.includes('>>')) return null;
  if (/^\s*["'/]/.test(inner)) return null;
  return `${match[1]}${inner}`;
}

/**
 * ARIA roles wowlidator may see in a captured tree.
 *
 * Used only to decide whether a bare leading token *was meant to be a role* —
 * see `qualifyBareRole`. Deliberately a list rather than a pattern: guessing
 * from shape would let a genuine CSS tag selector be rewritten into a role
 * selector that matches something else entirely.
 */
const ARIA_ROLES: ReadonlySet<string> = new Set([
  'alert', 'alertdialog', 'application', 'article', 'banner', 'blockquote', 'button',
  'caption', 'cell', 'checkbox', 'code', 'columnheader', 'combobox', 'complementary',
  'contentinfo', 'definition', 'deletion', 'dialog', 'directory', 'document', 'emphasis',
  'feed', 'figure', 'form', 'generic', 'grid', 'gridcell', 'group', 'heading', 'img',
  'insertion', 'link', 'list', 'listbox', 'listitem', 'log', 'main', 'marquee', 'math',
  'menu', 'menubar', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'meter', 'navigation',
  'none', 'note', 'option', 'paragraph', 'presentation', 'progressbar', 'radio',
  'radiogroup', 'region', 'row', 'rowgroup', 'rowheader', 'scrollbar', 'search',
  'searchbox', 'separator', 'slider', 'spinbutton', 'status', 'strong', 'subscript',
  'superscript', 'switch', 'tab', 'table', 'tablist', 'tabpanel', 'term', 'textbox',
  'time', 'timer', 'toolbar', 'tooltip', 'tree', 'treegrid', 'treeitem',
]);

/**
 * Attributes Playwright's role engine understands.
 *
 * A bare-role selector carrying anything else — `textbox[placeholder="Password"]`
 * is the one that turned up live — must NOT be qualified: `role=` would reject
 * the attribute outright (`Unknown attribute "placeholder"`), turning a step
 * that resolves nothing into a step that throws. Leaving it alone keeps it a
 * plain miss, which the healer can still repair.
 */
const ROLE_ENGINE_ATTRS: ReadonlySet<string> = new Set([
  'name', 'exact', 'checked', 'disabled', 'expanded', 'includeHidden', 'level',
  'pressed', 'selected',
]);

/** Selector engines Playwright recognises by prefix — never a bare role. */
const ENGINE_PREFIX = /^\s*(role|text|css|xpath|id|data-testid|internal:[a-z-]+)\s*=/i;

/**
 * Turn a selector that names a role but forgot to say `role=` into one that
 * says it.
 *
 * **This is the single most damaging thing a model gets wrong when writing
 * selectors, and it fails silently.** `textbox >> nth=1` is a *valid* selector
 * — Playwright reads the leading token as a CSS tag name — and there has never
 * been an HTML element called `<textbox>`, so it matches nothing, at any
 * timeout, on every page. Same for `heading[name="Employees"]` and
 * `button[name="Extend until"]`. The step reads as "the control is missing"
 * and the report files a front-end defect about an application that is fine.
 *
 * Found by investigating PB_02_01, whose login could never submit: the
 * password field has no accessible name (Chrome reports `role=textbox` with an
 * empty name), so the author fell back to a positional selector and dropped
 * the prefix. `textbox >> nth=1` resolved 0 elements; `role=textbox >> nth=1`
 * resolves 1. Every step after it ran on the sign-in page.
 *
 * Returns `null` when there is nothing to qualify — an engine-prefixed
 * selector, a real CSS selector, or a role carrying an attribute the role
 * engine does not accept — so a caller can tell "unchanged" from "rewritten"
 * without comparing strings.
 */
export function qualifyBareRole(selector: string): string | null {
  const trimmed = selector.trim();
  if (trimmed === '' || ENGINE_PREFIX.test(trimmed)) return null;
  // Anything a CSS selector uses structurally means this was never a bare role:
  // `.card button`, `#id`, `a > span`, `[data-x]`, `input:checked`.
  const head = trimmed.split('>>')[0] ?? '';
  if (/[.#>+~:*\s]/.test(head.replace(/\[[^\]]*\]/g, '').trim())) return null;

  const token = /^([A-Za-z]+)/.exec(head);
  if (!token || !ARIA_ROLES.has(token[1]!.toLowerCase())) return null;

  // Every attribute on the role token has to be one the role engine accepts,
  // or qualifying would swap a silent miss for a thrown error.
  for (const attr of head.matchAll(/\[\s*([A-Za-z]+)\s*[=\]]/g)) {
    if (!ROLE_ENGINE_ATTRS.has(attr[1]!)) return null;
  }
  return `role=${trimmed}`;
}

/**
 * Clean up non-standard selector engines or hallucinated prefixes (e.g. `StaticText[name="X"]`).
 */
export function sanitizeSelector(selector: string): string {
  let cleaned = selector.trim();
  // Rewrite `StaticText[name="X"]` or `StaticText[name='X']` -> `text="X"`
  cleaned = cleaned.replace(/^StaticText\[name=(["'])(.*?)\1\]/i, 'text=$1$2$1');
  return cleaned;
}

/** `qualifyBareRole` applied where the result is wanted whether or not it changed. */
export function withQualifiedRole(selector: string): string {
  const sanitized = sanitizeSelector(selector);
  return qualifyBareRole(sanitized) ?? sanitized;
}

