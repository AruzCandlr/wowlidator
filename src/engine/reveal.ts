/**
 * Reveal a control that is on the page but folded away.
 *
 * A form that folds its sections — an accordion card, a closed `<details>`,
 * an inactive tab — keeps the control in the DOM and out of the accessibility
 * tree. Every `role=` selector skips hidden elements, so the author's correct
 * selector matches nothing; the healer reads the same tree the control is
 * missing from, so it proposes a different control that is not there either;
 * and the agent, given the same tree, cannot name it. Live (ec10 HIR-EC-002,
 * 2026-09-02): Gender sits inside the hire form's collapsed "Personal
 * Information" card; the agent tried `button` and `combobox` by that name for
 * five turns and stalled, and the case never entered a value.
 *
 * The fix is the click a person makes: find the disclosure that owns the
 * hidden ancestor and open it. Deterministic, no model, and the author's own
 * selector is run again afterwards — the reveal never chooses a different
 * element.
 *
 * Why the search is done by hand rather than with `[include-hidden]`: the
 * accessible-name algorithm returns an EMPTY name for a hidden element whose
 * label is hidden with it (accname step 2A), so `role=button[name="Gender"
 * i][include-hidden]` matches nothing either. The name is recomputed here
 * from the label, the aria attributes and the text, ignoring hidden-ness.
 */
import type { Page } from 'playwright';

export interface RevealResult {
  /** The disclosures clicked, outermost first, named by their own label and the header beside them. */
  disclosures: string[];
  /** Whether the target became visible within the settle window. */
  revealed: boolean;
}

/** How long a section is given to unfold after its disclosure is clicked. */
export const REVEAL_SETTLE_MS = 1_500;

/**
 * Widen a selector so its `role=` segments match hidden elements too. Any
 * other engine (`css`, `text=`, `#id`) already matches regardless of
 * visibility, so it is returned unchanged. Only useful for a role selector
 * WITHOUT a name — see the module comment for why a named one cannot match.
 */
export function includeHidden(selector: string): string {
  return selector.replace(
    /(^|>>\s*)role=([a-z]+)((?:\[[^\]]*\])*)/g,
    (whole: string, pre: string, role: string, attrs: string) =>
      attrs.includes('include-hidden') ? whole : `${pre}role=${role}${attrs}[include-hidden]`,
  );
}

/** `role=button[name="Gender" i]` → its parts; anything else → null. */
export function parseRoleName(selector: string): { role: string; name: string; ci: boolean } | null {
  const match = /^role=([a-z]+)\[name=(?:"([^"]*)"|'([^']*)')(\s+i)?\](?:\[include-hidden\])?$/.exec(selector.trim());
  if (match === null) return null;
  return { role: match[1] ?? '', name: match[2] ?? match[3] ?? '', ci: match[4] !== undefined };
}

/** What a role means in plain HTML — enough of the implicit-role table for form controls. */
const IMPLICIT: Record<string, string> = {
  button: 'button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"]',
  textbox:
    'textarea, [role="textbox"], input:not([type]), input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input[type="password"], input[type="number"], input[type="search"]',
  searchbox: 'input[type="search"], [role="searchbox"]',
  combobox: '[role="combobox"], select:not([multiple]):not([size]), input[list]',
  listbox: '[role="listbox"], select[multiple], select[size]',
  option: 'option, [role="option"]',
  checkbox: 'input[type="checkbox"], [role="checkbox"]',
  radio: 'input[type="radio"], [role="radio"]',
  switch: '[role="switch"]',
  link: 'a[href], [role="link"]',
  tab: '[role="tab"]',
  heading: 'h1, h2, h3, h4, h5, h6, [role="heading"]',
  spinbutton: 'input[type="number"], [role="spinbutton"]',
  slider: 'input[type="range"], [role="slider"]',
  menuitem: '[role="menuitem"]',
  cell: 'td, [role="cell"], [role="gridcell"]',
  row: 'tr, [role="row"]',
};

/**
 * In-page source, as a STRING on purpose: tsx/esbuild's keepNames wraps every
 * named inner function in a `__name` helper that does not exist in the page,
 * and Playwright ships a function's source — see `engine/evidence.ts` and
 * `src/reporter/CLAUDE.md` for the same landmine. Plain JS, no types.
 *
 * `(args) => result` where args = { role, name, ci, css, marker } and result
 * is null (no hidden match), { visible: true } (the first match is already
 * visible), or { disclosures: string[] } after clicking what hides it.
 */
export const REVEAL_SOURCE = String.raw`(function (args) {
  var doc = document;
  function textOf(n) {
    var out = '';
    (function walk(x) {
      for (var i = 0; i < x.childNodes.length; i++) {
        var c = x.childNodes[i];
        if (c.nodeType === 3) out += c.textContent || '';
        else if (c.nodeType === 1 && c.getAttribute('aria-hidden') !== 'true') walk(c);
      }
    })(n);
    return out.replace(/\s+/g, ' ').trim();
  }
  function nameOf(el) {
    var ariaLabel = (el.getAttribute('aria-label') || '').trim();
    if (ariaLabel) return ariaLabel;
    var labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      var text = labelledBy.split(/\s+/).map(function (id) { return doc.getElementById(id); })
        .filter(Boolean).map(textOf).join(' ').trim();
      if (text) return text;
    }
    if (el.labels && el.labels.length) {
      var lt = Array.prototype.map.call(el.labels, textOf).join(' ').trim();
      if (lt) return lt;
    }
    if (el.id) {
      var label = doc.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (label) { var t = textOf(label); if (t) return t; }
    }
    var own = textOf(el);
    if (own) return own;
    return (el.getAttribute('placeholder') || el.getAttribute('title') || '').trim();
  }
  function fold(s) { return args.ci ? s.toLowerCase() : s; }
  var target = null;
  if (args.marker) {
    target = doc.querySelector(args.marker);
    if (target) target.removeAttribute(args.marker.slice(1, -1));
  } else {
    var wanted = fold(args.name.replace(/\s+/g, ' ').trim());
    var nodes = doc.querySelectorAll(args.css);
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var explicit = el.getAttribute('role');
      if (explicit !== null && explicit !== args.role) continue;
      var got = fold(nameOf(el));
      if (got !== wanted && got.replace(/\s*\*$/, '') !== wanted) continue;
      target = el;
      break;
    }
  }
  if (!target) return null;
  var inClosedDetails = !!target.closest('details:not([open])') && !target.closest('details:not([open]) > summary');
  var shown = typeof target.checkVisibility === 'function'
    ? target.checkVisibility({ visibilityProperty: true })
    : target.getClientRects().length > 0;
  if (shown && !inClosedDetails) return { visible: true };
  function isHidden(n) {
    // A closed <details> hides its children without display:none.
    if (n.tagName === 'DETAILS' && !n.open) return true;
    return n.hidden === true || getComputedStyle(n).display === 'none' || n.getAttribute('aria-hidden') === 'true';
  }
  function labelOf(n) {
    return (n.getAttribute('aria-label') || n.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  }
  var hiddenAncestors = [];
  for (var n = target; n && n !== doc.body; n = n.parentElement) if (isHidden(n)) hiddenAncestors.push(n);
  hiddenAncestors.reverse();
  var clicked = [];
  for (var k = 0; k < hiddenAncestors.length; k++) {
    var hidden = hiddenAncestors[k];
    var disclosure = null;
    if (hidden.id) {
      var id = CSS.escape(hidden.id);
      disclosure = doc.querySelector('[aria-controls="' + id + '"][aria-expanded="false"], [role="tab"][aria-controls="' + id + '"]');
    }
    if (!disclosure) {
      var prev = hidden.previousElementSibling;
      if (prev) disclosure = prev.matches('[aria-expanded="false"]') ? prev : prev.querySelector('[aria-expanded="false"]');
    }
    if (!disclosure) {
      var details = hidden.closest('details');
      if (details && !details.open) disclosure = details.querySelector(':scope > summary');
    }
    if (!disclosure && hidden.parentElement) {
      disclosure = hidden.parentElement.querySelector(':scope > [aria-expanded="false"], :scope > * > [aria-expanded="false"]');
    }
    if (!disclosure) continue;
    var label = labelOf(disclosure) || 'disclosure';
    var header = disclosure.parentElement;
    var headerText = header ? labelOf(header) : '';
    disclosure.click();
    clicked.push(headerText && headerText !== label ? label + ' (' + headerText + ')' : label);
  }
  return { disclosures: clicked };
})`;

const MARKER_ATTR = 'data-wowlidator-reveal';

/**
 * If `selector` matches only once hidden elements are included, open the
 * disclosures that hide it and report what was clicked. `null` when the
 * selector matches nothing at all, already matches something visible, or no
 * disclosure could be found — in every one of those cases the caller's ladder
 * carries on exactly as it would have.
 */
export async function revealHidden(
  page: Page,
  selector: string,
  settleMs = REVEAL_SETTLE_MS,
): Promise<RevealResult | null> {
  const parsed = parseRoleName(selector);
  let marker: string | null = null;
  if (parsed === null) {
    // Any other engine matches hidden elements already; mark the first one so
    // the in-page code can start from it without re-deriving the selector.
    let count: number;
    try {
      count = await page.locator(includeHidden(selector)).count();
    } catch {
      return null;
    }
    if (count === 0) return null;
    const first = page.locator(includeHidden(selector)).first();
    if (await first.isVisible().catch(() => false)) return null;
    const marked = await first
      .evaluate((el, attr: string) => { el.setAttribute(attr, '1'); return true; }, MARKER_ATTR, { timeout: settleMs })
      .catch(() => false);
    if (!marked) return null;
    marker = `[${MARKER_ATTR}]`;
  }
  const args = {
    role: parsed?.role ?? '',
    name: parsed?.name ?? '',
    ci: parsed?.ci ?? false,
    css: parsed === null ? '' : (IMPLICIT[parsed.role] ?? `[role="${parsed.role}"]`),
    marker,
  };
  const disclosures: string[] = [];
  let revealed = false;
  // Two passes, not one: a disclosure whose first click does nothing exists
  // in the wild — humi's hire wizard toggles `!state[id]` on a section whose
  // state is still undefined, so the first "Expand" sets collapsed=true on an
  // already-collapsed card and only the second opens it. A person clicks
  // again; so does this, once, and says so.
  for (let pass = 1; pass <= 2 && !revealed; pass += 1) {
    const outcome = (await page
      .evaluate(`${REVEAL_SOURCE}(${JSON.stringify({ ...args, marker: pass === 1 ? marker : null })})`)
      .catch(() => null)) as { visible?: boolean; disclosures?: string[] } | null;
    if (outcome === null || outcome.visible === true) break;
    const clicked = outcome.disclosures ?? [];
    if (clicked.length === 0) break;
    disclosures.push(...(pass === 1 ? clicked : clicked.map((d) => `${d} — clicked again, the first click left it collapsed`)));
    try {
      // The author's OWN selector, now that the section is open — never the
      // hand-found element, so what is acted on is what the flow named.
      await page.locator(selector).first().waitFor({ state: 'visible', timeout: settleMs });
      revealed = true;
    } catch {
      revealed = false;
    }
  }
  if (disclosures.length === 0) return null;
  return { disclosures, revealed };
}
