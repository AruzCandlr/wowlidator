/**
 * An application's own "this page does not exist" surface, read for $0.
 *
 * A Next.js app answers a stale client-side route by rendering its
 * `not-found.tsx` IN PLACE with HTTP 200 — humi's says "404 — ไม่พบหน้าที่ค้นหา"
 * in an eyebrow and "หน้านี้ถูกย้ายหรือลบไปแล้ว" as the h1, with links back
 * home. Nothing in the ladder read that (ec10 HIR-EC-002, 2026-09-03: "View
 * Details" → 404 is a real open defect, BUG 71887 in the workbook): the
 * `goto` status judge sees only a goto's HTTP status, the denial rung matches
 * authorization words, and every later step exhausted the full ladder — the
 * healer proposed the 404 page's own links — before the run read as "controls
 * missing". The right verdict is `failed`, with the page as evidence, on the
 * first step after the click that landed there.
 *
 * Only headings are read (h1–h3, `role=heading`, the short block right
 * before the first h1 — an eyebrow — and `document.title`), never body text:
 * "No options found" in an empty listbox and "Employee not found" in a toast
 * are not a missing page. Runner wiring (the stop rung after the denial rung,
 * the `not-found:` attempt prefix, `detail.landedOnNotFound` on the click
 * that arrived) is the runner's half.
 */
import type { Page } from 'playwright';

/**
 * What a not-found heading says, in either language. `404` bounded by
 * non-alphanumerics rather than `\b` so a Thai eyebrow "404 — ไม่พบหน้า…"
 * matches and "1404 rows" does not.
 */
export const NOT_FOUND_HEADING_PATTERN =
  /(?:^|[^\p{L}\p{N}])404(?![\p{L}\p{N}])|page not found|page (?:could not be|cannot be|can't be) found|this page (?:does not|doesn't) exist|ไม่พบหน้า|หน้านี้ถูกย้ายหรือลบ|ไม่มีหน้านี้/iu;

export interface NotFoundSurface {
  /** The heading text that matched — what the report shows as `pageContext`. */
  heading: string;
  /** Where it was read. */
  via: 'heading' | 'eyebrow' | 'title';
  /** The URL the page had at the time. */
  url: string;
}

/**
 * In-page source, as a STRING on purpose (tsx `__name` landmine — see
 * `reveal.ts`). Returns the visible heading-ish texts of the page:
 * `{ headings: string[], eyebrow: string, title: string }`.
 */
export const NOT_FOUND_SOURCE = String.raw`(function () {
  function shown(el) {
    if (!el) return false;
    if (typeof el.checkVisibility === 'function') return el.checkVisibility({ visibilityProperty: true });
    return el.getClientRects().length > 0;
  }
  function text(el) { return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(); }
  var headings = [];
  var nodes = document.querySelectorAll('h1, h2, h3, [role="heading"]');
  for (var i = 0; i < nodes.length && headings.length < 12; i++) {
    if (!shown(nodes[i])) continue;
    var t = text(nodes[i]);
    if (t) headings.push(t.slice(0, 160));
  }
  var eyebrow = '';
  var h1 = document.querySelector('h1');
  var prev = h1 ? h1.previousElementSibling : null;
  if (prev && shown(prev)) {
    var pt = text(prev);
    if (pt && pt.length <= 80) eyebrow = pt;
  }
  return { headings: headings, eyebrow: eyebrow, title: (document.title || '').trim().slice(0, 160) };
})()`;

/**
 * The not-found surface the page is showing, or `null`. One evaluate,
 * bounded by `timeoutMs`; any failure reads as "not showing one" — this is a
 * stop rung's evidence, and evidence that could not be read must not become
 * a verdict.
 */
export async function notFoundSurface(page: Page, timeoutMs = 1_000): Promise<NotFoundSurface | null> {
  type Surface = { headings?: string[]; eyebrow?: string; title?: string };
  let read: Surface | null;
  try {
    read = (await Promise.race([
      page.evaluate(NOT_FOUND_SOURCE) as Promise<unknown>,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ])) as Surface | null;
  } catch {
    return null;
  }
  if (read === null || typeof read !== 'object') return null;
  const url = page.url();
  for (const heading of read.headings ?? []) {
    if (NOT_FOUND_HEADING_PATTERN.test(heading)) return { heading, via: 'heading', url };
  }
  if (read.eyebrow && NOT_FOUND_HEADING_PATTERN.test(read.eyebrow)) {
    return { heading: read.eyebrow, via: 'eyebrow', url };
  }
  if (read.title && NOT_FOUND_HEADING_PATTERN.test(read.title)) {
    return { heading: read.title, via: 'title', url };
  }
  return null;
}
