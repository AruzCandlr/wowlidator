/**
 * The validation message under ONE field, read the way a person reads it.
 *
 * ~110 sheet rows claim "ระบบแสดง Error message '…' ด้านล่าง Field X" (BE
 * PL_06/PL_08/RU_05/RU_07), "error ใต้ช่องนั้นทันทีเมื่อกด Save" and "error
 * ของแต่ละ field แสดงแยกกัน" (PY-Config TC_SSO/TC_EMP/TC_PA/TC_WT/TC_TAX/
 * TC_SEV/TC_FUND), "ระบบแสดงข้อความที่ช่อง Personal Grade" (HIR-EC-049..081).
 * A page-wide `expectText` passes on a message under the WRONG field, and the
 * kin rung climbs from a label, not from the control, so none of those
 * claims was provable as written (EH-12, 2026-09-03).
 *
 * Where the message is, in order of how much the page vouches for it:
 *
 * 1. `aria-errormessage` — the element the control itself names as its error.
 * 2. `aria-describedby` — humi's FormField wires `<p id="…-error" role="alert">`
 *    here (and the help text; an alert / aria-live element wins, else the
 *    first visible one).
 * 3. The field container: the nearest ancestor (≤ 3 levels) holding a
 *    `<label>` / `<legend>` for this control or a `[data-field]`; inside it,
 *    the visible text of elements AFTER the control in document order, minus
 *    the control's own subtree and its label — an alert / live region first;
 *    else the first block when the control says `aria-invalid`; else a block
 *    whose id/class names it an error. Class names are a hint used last, so
 *    help text under a valid field is never reported as its error.
 *
 * Required-ness is read from the same place: `required` / `aria-required`
 * on the control, or a `*` marker in its label (humi: `<span
 * class="text-danger">*</span>` beside the label text).
 *
 * In-page code is STRING source (tsx `__name` landmine — see `reveal.ts`).
 * The `expectFieldError` / `expectRequired` / `expectNoFieldError` steps
 * that call these are the runner's half.
 */
import type { Locator, Page } from 'playwright';

/**
 * A STRING source as something `locator.evaluate` will ship: a function built
 * at runtime has no name for tsx to wrap in `__name`, and Playwright sends its
 * `toString()`, which is exactly the anonymous wrapper written here.
 */
export function inPage<T>(source: string): (el: unknown) => T {
  return new Function('el', `return (${source})(el);`) as (el: unknown) => T;
}

export interface FieldError {
  /** The message as shown, whitespace collapsed. */
  text: string;
  /** How the page tied the message to the control. */
  via: 'aria-errormessage' | 'aria-describedby' | 'container';
  /** Whether the control itself is flagged `aria-invalid="true"`. */
  invalid: boolean;
}

export interface FieldRequired {
  required: boolean;
  /** Which signal said so — null when nothing did. */
  via: 'required' | 'aria-required' | 'label-marker' | null;
  /** The label text, if one was found. */
  label: string | null;
}

/**
 * `(el) => { text, via, invalid } | null`. Plain ES5, no named functions.
 */
export const FIELD_ERROR_SOURCE = String.raw`(function (el) {
  var doc = el.ownerDocument;
  function shown(n) {
    if (!n) return false;
    if (typeof n.checkVisibility === 'function') return n.checkVisibility({ visibilityProperty: true });
    return n.getClientRects().length > 0;
  }
  function text(n) { return (n.innerText || n.textContent || '').replace(/\s+/g, ' ').trim(); }
  function byIds(attr) {
    var ids = (el.getAttribute(attr) || '').split(/\s+/).filter(Boolean);
    var found = [];
    for (var i = 0; i < ids.length; i++) {
      var n = doc.getElementById(ids[i]);
      if (!n || !shown(n)) continue;
      var t = text(n);
      if (t) found.push({ node: n, text: t });
    }
    return found;
  }
  var invalid = el.getAttribute('aria-invalid') === 'true';
  var byError = byIds('aria-errormessage');
  if (byError.length) return { text: byError[0].text, via: 'aria-errormessage', invalid: invalid };
  var byDesc = byIds('aria-describedby');
  if (byDesc.length) {
    // The alert / live region among them is the error; help text is the rest.
    for (var d = 0; d < byDesc.length; d++) {
      var n = byDesc[d].node;
      if (n.getAttribute('role') === 'alert' || n.getAttribute('aria-live') || /error|invalid|danger/i.test(n.id + ' ' + n.className)) {
        return { text: byDesc[d].text, via: 'aria-describedby', invalid: invalid };
      }
    }
    if (invalid) return { text: byDesc[0].text, via: 'aria-describedby', invalid: invalid };
  }
  // The field container: the nearest ancestor that holds this control's label.
  var labels = [];
  if (el.labels && el.labels.length) for (var L = 0; L < el.labels.length; L++) labels.push(el.labels[L]);
  if (el.id) {
    var forLabel = doc.querySelector('label[for="' + CSS.escape(el.id) + '"]');
    if (forLabel && labels.indexOf(forLabel) < 0) labels.push(forLabel);
  }
  var container = null;
  var probe = el.parentElement;
  for (var depth = 0; probe && depth < 3 && !container; depth++, probe = probe.parentElement) {
    if (probe.hasAttribute('data-field') || probe.tagName === 'FIELDSET') { container = probe; break; }
    for (var k = 0; k < labels.length; k++) if (probe.contains(labels[k])) { container = probe; break; }
    if (!container && probe !== doc.body && probe.tagName !== 'FORM') {
      if (probe.querySelector(':scope > label, :scope > legend, :scope > * > label')) container = probe;
    }
  }
  if (!container) return null;
  var candidates = container.querySelectorAll('*');
  var after = [];
  for (var c = 0; c < candidates.length; c++) {
    var n2 = candidates[c];
    if (n2 === el || el.contains(n2) || n2.contains(el)) continue;
    var isLabel = false;
    for (var q = 0; q < labels.length; q++) if (labels[q] === n2 || labels[q].contains(n2)) isLabel = true;
    if (isLabel) continue;
    if (!(el.compareDocumentPosition(n2) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
    if (!shown(n2)) continue;
    if (n2.children.length > 0 && n2.querySelector('input, select, textarea, button')) continue;
    var t2 = text(n2);
    if (!t2) continue;
    after.push({ node: n2, text: t2 });
  }
  if (!after.length) return null;
  for (var a = 0; a < after.length; a++) {
    var m = after[a].node;
    if (m.getAttribute('role') === 'alert' || m.getAttribute('aria-live')) {
      return { text: after[a].text, via: 'container', invalid: invalid };
    }
  }
  // No alert: the following text is the error only when the control says it
  // is invalid, or the block itself is named as one (a class-name hint, used
  // last — help text under a valid field is not an error). Document order
  // puts the outermost text block first; its text holds its children's.
  if (invalid) return { text: after[0].text, via: 'container', invalid: invalid };
  for (var h = 0; h < after.length; h++) {
    var hn = after[h].node;
    if (/error|invalid|danger|warn/i.test((hn.id || '') + ' ' + (typeof hn.className === 'string' ? hn.className : ''))) {
      return { text: after[h].text, via: 'container', invalid: invalid };
    }
  }
  return null;
})`;

/** `(el) => { required, via, label }`. */
export const FIELD_REQUIRED_SOURCE = String.raw`(function (el) {
  var doc = el.ownerDocument;
  function text(n) { return (n.innerText || n.textContent || '').replace(/\s+/g, ' ').trim(); }
  var label = null;
  if (el.labels && el.labels.length) label = el.labels[0];
  if (!label && el.id) label = doc.querySelector('label[for="' + CSS.escape(el.id) + '"]');
  if (!label) {
    var lb = el.getAttribute('aria-labelledby');
    if (lb) label = doc.getElementById(lb.split(/\s+/)[0]);
  }
  var labelText = label ? text(label) : (el.getAttribute('aria-label') || null);
  if (el.required === true || el.getAttribute('required') !== null) return { required: true, via: 'required', label: labelText };
  if (el.getAttribute('aria-required') === 'true') return { required: true, via: 'aria-required', label: labelText };
  if (label && /\*/.test(label.textContent || '')) return { required: true, via: 'label-marker', label: labelText };
  return { required: false, via: null, label: labelText };
})`;

/**
 * The validation message tied to `control`, or `null` when the page shows
 * none. `control` should resolve to the input/select/button itself (the
 * ladder's job); a locator that matches several reads the first.
 */
export async function readFieldError(
  page: Page,
  control: Locator,
  options: { timeout?: number | undefined } = {},
): Promise<FieldError | null> {
  void page;
  const timeout = options.timeout ?? 1_000;
  try {
    const read = await control
      .first()
      .evaluate(inPage<{ text?: unknown; via?: unknown; invalid?: unknown } | null>(FIELD_ERROR_SOURCE), undefined, { timeout });
    if (read === null || typeof read !== 'object' || typeof read.text !== 'string' || read.text === '') return null;
    const via = read.via === 'aria-errormessage' || read.via === 'aria-describedby' ? read.via : 'container';
    return { text: read.text, via, invalid: read.invalid === true };
  } catch {
    return null;
  }
}

/** Whether `control` is required — by attribute or by the `*` marker in its label. */
export async function readFieldRequired(
  page: Page,
  control: Locator,
  options: { timeout?: number | undefined } = {},
): Promise<FieldRequired | null> {
  void page;
  const timeout = options.timeout ?? 1_000;
  try {
    const read = await control
      .first()
      .evaluate(inPage<{ required?: unknown; via?: unknown; label?: unknown } | null>(FIELD_REQUIRED_SOURCE), undefined, { timeout });
    if (read === null || typeof read !== 'object') return null;
    const via =
      read.via === 'required' || read.via === 'aria-required' || read.via === 'label-marker' ? read.via : null;
    return { required: read.required === true, via, label: typeof read.label === 'string' ? read.label : null };
  } catch {
    return null;
  }
}
