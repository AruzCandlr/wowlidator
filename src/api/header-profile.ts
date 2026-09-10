/**
 * The header floor for a deliberate `request` — and how a server complains
 * when the floor was not high enough.
 *
 * **The incident (2026-09-08).** `request` steps against a live SPA came back
 * 400 with `{"errorCode":"ERR_BAD_REQUEST","message":"Missing required
 * header(s): …"}` while a person doing the same thing in the same browser got
 * 200, and the bundles recorded `requestHeaders: {}`. `BrowserTransport` sends
 * through `BrowserContext.request`, which shares the cookie jar and *nothing
 * else*: no `referer`, no `origin`, no `user-agent`, no `accept`, and none of
 * the headers the application's own `fetch`/XHR attaches. The server was right
 * to refuse; the harness sent a malformed request and the suite filed it as a
 * backend defect. PL_11_03 and PL_10_23 both scored a false finding that way.
 *
 * **The fix is evidence, not a list.** `NetworkObserver` already sees every
 * `XHR`/`Fetch` the page issues, headers included. A deliberate `request` to
 * the same origin should go out looking like a request the application itself
 * makes, so the floor is *merged from what was observed* — never from a table
 * of header names this or any other app happens to need.
 *
 * Three rules keep that honest, and each is the reason a function below exists:
 *
 * 1. **A per-request unique value is regenerated, never replayed.** The signal
 *    is structural: the same header name observed with a *different* value on
 *    every call. `freshValue` rebuilds it segment by segment, keeping the parts
 *    that never varied (a `traceparent`'s `00` version prefix) and drawing the
 *    parts that did from the same alphabet and the same width. Two observations
 *    are the minimum — with one sample there is nothing to tell constant from
 *    unique, and this module replays it and says so rather than guessing.
 * 2. **Transport-owned headers never travel.** `cookie` (the context already
 *    carries it), `content-length`, `host`, the HTTP/2 pseudo-headers, the
 *    conditional headers, and `sec-fetch-*` — which describe the fetch the
 *    browser made, not the one the harness is making. A `content-type` is only
 *    inherited by a call that actually sends a body.
 * 3. **Scoped to the origin.** A cross-origin `request` inherits nothing: the
 *    application's headers are the application's, and sending its bearer to
 *    somebody else's host would be a leak, not a fix.
 *
 * Nothing here is persisted. The samples this merges are raw and unredacted and
 * live in memory only (see `NetworkObserver`); what reaches a `RequestRecord`
 * goes through `redact.ts` like every other header in this codebase.
 */

import { randomBytes, randomUUID } from 'node:crypto';

/**
 * One observed call's request headers.
 *
 * Carries the ORIGIN, not the url: the origin is the only part of the address
 * this module needs, and a url can hold a credential in its query string.
 */
export interface HeaderObservation {
  origin: string;
  /** Raw and unredacted — in-memory only, never written to an artefact. */
  headers: Readonly<Record<string, string>>;
}

export interface HeaderProfileTarget {
  /** The absolute url the `request` step is about to call. */
  url: string;
  /** A body-less call must not inherit a `content-type` it will not honour. */
  hasBody: boolean;
}

export interface HeaderProfile {
  /** Lowercased header name to the value to send. */
  headers: Record<string, string>;
  /** Names whose observed value varied per call and was generated fresh. */
  regenerated: string[];
  /** How many observed calls the merge drew from. */
  observedCalls: number;
}

/**
 * Headers that belong to the transport, not to the application.
 *
 * Replaying any of these corrupts the new request rather than describing it: a
 * `content-length` from another body, a `host` from another authority, an
 * `if-none-match` that turns a fetch into a 304. `cookie` is excluded because
 * the browser context already carries the jar — inheriting a stale copy of it
 * would be the one way to send the request as somebody the run no longer is.
 */
const TRANSPORT_HEADERS: ReadonlySet<string> = new Set([
  'cookie',
  'set-cookie',
  'content-length',
  'content-encoding',
  'transfer-encoding',
  'accept-encoding',
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'upgrade',
  'expect',
  'if-match',
  'if-none-match',
  'if-modified-since',
  'if-unmodified-since',
  'if-range',
  'range',
]);

/**
 * `sec-fetch-*` states the mode, site and destination of the fetch the BROWSER
 * made. The harness's call has different ones, and sending the page's would
 * contradict the call being made. `sec-ch-*` is kept: a client hint describes
 * the browser, which is genuinely the same browser, exactly like `user-agent`.
 */
const CONTRADICTED_PREFIXES: readonly string[] = ['sec-fetch-'];

/** The origin of an absolute url, or `null` when it is not one. */
export function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function inheritable(name: string, target: HeaderProfileTarget): boolean {
  if (name === '' || name.startsWith(':')) return false; // HTTP/2 pseudo-headers
  if (TRANSPORT_HEADERS.has(name)) return false;
  if (CONTRADICTED_PREFIXES.some((prefix) => name.startsWith(prefix))) return false;
  if (name === 'content-type' && !target.hasBody) return false;
  return true;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALNUM_SEGMENT = /^[A-Za-z0-9]+$/;

/**
 * A fresh value of the same shape as the ones observed, or `null` when the
 * observations have no shape in common to copy.
 *
 * Segment-wise on `-`, because that is how every id format in practice puts a
 * constant part next to a random one: a `traceparent`'s version and flags stay,
 * its trace and span ids are redrawn. A column that varied but is not a plain
 * alphanumeric run of one width is not something this can safely invent, so the
 * whole value falls back to the most recent observation.
 */
export function freshValue(values: readonly string[]): string | null {
  if (values.every((value) => UUID.test(value))) return randomUUID();

  const parts = values.map((value) => value.split('-'));
  const width = parts[0]?.length ?? 0;
  if (width === 0 || !parts.every((part) => part.length === width)) return null;

  const out: string[] = [];
  for (let index = 0; index < width; index += 1) {
    const column = parts.map((part) => part[index] ?? '');
    const first = column[0] ?? '';
    if (column.every((segment) => segment === first)) {
      out.push(first);
      continue;
    }
    if (!column.every((segment) => segment.length === first.length && ALNUM_SEGMENT.test(segment))) {
      return null;
    }
    out.push(randomSegment(column));
  }
  return out.join('-');
}

/** A random run of the same width, from the narrowest alphabet the column used. */
function randomSegment(column: readonly string[]): string {
  const length = column[0]?.length ?? 0;
  const joined = column.join('');
  const alphabet = /^[0-9]+$/.test(joined)
    ? '0123456789'
    : /^[0-9a-f]+$/.test(joined)
      ? '0123456789abcdef'
      : /^[0-9A-F]+$/.test(joined)
        ? '0123456789ABCDEF'
        : /^[0-9a-z]+$/.test(joined)
          ? '0123456789abcdefghijklmnopqrstuvwxyz'
          : '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const bytes = randomBytes(length);
  let out = '';
  for (let index = 0; index < length; index += 1) {
    out += alphabet[(bytes[index] ?? 0) % alphabet.length];
  }
  return out;
}

/**
 * Merge the observed calls into the header floor for one request.
 *
 * `null` when nothing was observed on the target's own origin — a cross-origin
 * request, a browser-free flow, or an observer that never attached. The caller
 * then sends exactly what it sent before this module existed.
 */
export function buildHeaderProfile(
  samples: readonly HeaderObservation[],
  target: HeaderProfileTarget,
): HeaderProfile | null {
  const origin = originOf(target.url);
  if (origin === null) return null;

  const seen = new Map<string, string[]>();
  let observedCalls = 0;
  for (const sample of samples) {
    if (sample.origin !== origin) continue;
    observedCalls += 1;
    for (const [rawName, value] of Object.entries(sample.headers)) {
      const name = rawName.toLowerCase();
      if (!inheritable(name, target)) continue;
      const values = seen.get(name);
      if (values) values.push(value);
      else seen.set(name, [value]);
    }
  }
  if (observedCalls === 0) return null;

  const headers: Record<string, string> = {};
  const regenerated: string[] = [];
  for (const [name, values] of seen) {
    const latest = values[values.length - 1] ?? '';
    // One distinct value across every call that carried the header is a
    // constant as far as anything can tell: send it. More than one is the
    // signal that the application computes it per request.
    if (new Set(values).size === 1) {
      headers[name] = latest;
      continue;
    }
    const fresh = freshValue(values);
    if (fresh === null) {
      headers[name] = latest;
      continue;
    }
    headers[name] = fresh;
    regenerated.push(name);
  }
  return { headers, regenerated: regenerated.sort(), observedCalls };
}

/**
 * A 4xx whose body says the request was malformed at the HEADER level.
 *
 * Structural on purpose: the pattern is ordinary HTTP-error English around the
 * word "header", never one application's error codes. It is consulted ONLY on a
 * status assertion that has already failed, so a negative test that means to
 * provoke a 400 and asserts one still passes untouched.
 *
 * Returns the header names the body seems to be about (possibly empty — the
 * refusal stands either way), or `null` when this is not that class of refusal.
 */
export function headerRefusal(status: number, body: string): readonly string[] | null {
  if (status < 400 || status >= 500) return null;
  const text = body.slice(0, 2_000);
  if (!HEADER_COMPLAINT.test(text)) return null;
  return namedHeaders(text);
}

const HEADER_COMPLAINT =
  /(?:missing|invalid|required|absent|unsupported|unrecognis|unrecognized|malformed|expected|no)[^.;!?]{0,60}\bheaders?\b|\bheaders?\b[^.;!?]{0,60}(?:missing|invalid|required|absent|malformed|not\s+(?:present|provided|supplied|set))/i;

/** Hyphenated word runs — the shape of a header name, and of very little else. */
const NAME_TOKEN = /\b[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+\b/g;

/**
 * The header names a complaint mentions, name-shaped tokens only.
 *
 * Deliberately does not quote the body. An error body is still a payload, and
 * this codebase's rule is never to emit one it could not inspect — a token that
 * could be an id (a uuid, a long hex run) is dropped rather than reproduced.
 */
function namedHeaders(text: string): readonly string[] {
  const out: string[] = [];
  for (const match of text.matchAll(NAME_TOKEN)) {
    const token = match[0].toLowerCase();
    if (token.length > 48) continue;
    if (/^[0-9a-f-]{16,}$/.test(token)) continue; // a uuid or a hex id, not a name
    if (!out.includes(token)) out.push(token);
    if (out.length === 6) break;
  }
  return out;
}
