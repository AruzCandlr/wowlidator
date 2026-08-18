/**
 * Pure URL/route/endpoint matching, factored out of `context-engine.ts` so a
 * consumer that only needs the matcher (the `expectCalls` assertion in
 * `src/api/`) does not drag the whole context engine — and with it the babel
 * parser the component ingester loads — into the execution plane.
 *
 * `context-engine.ts` re-exports everything here, so existing imports keep
 * working; new code should import from this module directly.
 */

export function pathnameOf(url: string): string | undefined {
  try {
    return new URL(url).pathname;
  } catch {
    // A relative url never parses, so strip the query and hash by hand —
    // `new URL()` would have done it for the absolute case, and a path that
    // kept `?page=2` would fail to match the route pattern it plainly hits.
    if (!url.startsWith('/')) return undefined;
    return url.split(/[?#]/)[0] ?? url;
  }
}

/** `:id` and `*catchAll` segments in `pattern` match anything at that position. */
export function matchesRoutePattern(path: string, pattern: string): boolean {
  const pathParts = path.split('/').filter(Boolean);
  const patternParts = pattern.split('/').filter(Boolean);

  const catchAllIndex = patternParts.findIndex((part) => part.startsWith('*'));
  if (catchAllIndex !== -1) {
    const fixed = patternParts.slice(0, catchAllIndex);
    // A catch-all consumes one or more segments — `/blog` alone does not
    // satisfy `/blog/*slug` (that's what an *optional* catch-all is for, a
    // distinction this matcher's single `*` encoding does not carry).
    if (pathParts.length <= fixed.length) return false;
    return fixed.every((part, i) => part.startsWith(':') || part === pathParts[i]);
  }

  if (pathParts.length !== patternParts.length) return false;
  return patternParts.every((part, i) => part.startsWith(':') || part === pathParts[i]);
}

/**
 * OpenAPI's `{id}` template form → the `:id` form route nodes already use, so
 * one matcher serves both notations. Idempotent on a `:id` input.
 */
export function toRoutePattern(path: string): string {
  return path.replace(/\{([^}]+)\}/g, ':$1');
}

/**
 * Does an observed/recorded call hit a declared endpoint?
 *
 * This is the "METHOD url vs METHOD /path/:param" composition that used to
 * live inline in `linkCoverage` — lifted so the `expectCalls` assertion and
 * coverage linking share one rule instead of drifting. Methods are uppercased
 * on both sides (linkCoverage's producers already uppercase by convention;
 * making the matcher do it means a hand-written `post` still matches). The
 * pattern accepts both `:id` and `{id}` parameter forms, and the url may be
 * absolute or a `/`-rooted path, with query and hash ignored.
 */
export function matchesCall(
  method: string,
  url: string,
  expectedMethod: string,
  pattern: string,
): boolean {
  if (method.toUpperCase() !== expectedMethod.toUpperCase()) return false;
  const path = pathnameOf(url);
  if (path === undefined) return false;
  return matchesRoutePattern(path, toRoutePattern(pattern));
}

/**
 * A locale segment: `en`, `th`, `en-GB`, `pt_BR`. Deliberately narrow.
 *
 * It is the guard on the only route parameter this module will fill. Without
 * it, "take the start URL's segment at the same index" turns `/login` into
 * `/login/overtime` — a URL that grounds nothing and reads exactly like one
 * that does.
 */
const LOCALE_SEGMENT = /^[a-z]{2}([-_][a-z0-9]{2,4})?$/i;

/** Why a route pattern could not be turned into a URL, or the URL it became. */
export type RouteUrlResolution =
  | { ok: true; url: string }
  | { ok: false; reason: string };

/**
 * A route *pattern* (`/:locale/overtime`) plus the URL a run starts on, into a
 * concrete URL — or a refusal naming what could not be grounded.
 *
 * The refusal half is the point. Every parameter this cannot fill from
 * evidence is a segment that would otherwise be *invented*, and an invented
 * `:id` navigates somewhere meaningless while looking exactly like a real
 * destination — the same failure mode `ungroundedUrlExpectation` exists to
 * stop, one layer earlier. So `:locale` is filled only from the start URL's
 * own path, only at the same index, and only when what sits there actually
 * looks like a locale; every other parameter and every catch-all is refused.
 *
 * Pure, so the skip rules are testable without a browser.
 */
export function concreteRouteUrl(pattern: string, startUrl: string): RouteUrlResolution {
  let origin: string;
  let startSegments: string[];
  try {
    const parsed = new URL(startUrl);
    origin = parsed.origin;
    startSegments = parsed.pathname.split('/').filter(Boolean);
  } catch {
    return { ok: false, reason: `the run's start url "${startUrl}" is not absolute` };
  }

  const out: string[] = [];
  const segments = pattern.split('/').filter(Boolean);
  for (const [index, segment] of segments.entries()) {
    if (segment.startsWith('*')) {
      return { ok: false, reason: `"${pattern}" is a catch-all — any path for it would be invented` };
    }
    if (!segment.startsWith(':')) {
      out.push(segment);
      continue;
    }
    const name = segment.slice(1);
    if (name.toLowerCase() !== 'locale') {
      return {
        ok: false,
        reason: `"${pattern}" needs a value for ":${name}" that nothing in this run supplies`,
      };
    }
    const candidate = startSegments[index];
    if (candidate === undefined || !LOCALE_SEGMENT.test(candidate)) {
      return {
        ok: false,
        reason: `"${pattern}" needs a locale, and "${startUrl}" has none at that position`,
      };
    }
    out.push(candidate);
  }

  return { ok: true, url: `${origin}/${out.join('/')}` };
}
