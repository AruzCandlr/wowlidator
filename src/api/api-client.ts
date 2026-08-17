/**
 * The HTTP execution plane.
 *
 * Structured the same way every other capability in this codebase is: a small
 * injectable interface (`ApiTransport`) with two real implementations, so the
 * whole thing is stubbable offline and neither implementation leaks into a
 * call site.
 *
 * **The default transport is the browser's, not Node's `fetch`, and that is
 * the entire integration argument.** `BrowserContext.request` shares cookie
 * storage with the page, so a flow can log in once through the real UI —
 * whatever bespoke SSO dance that involves — and then seed and verify over
 * HTTP *as that user*, with no token plumbing and no second auth path that
 * can drift from the one real users take. `FetchTransport` exists for flows
 * that never open a browser at all.
 */

import type { APIRequestContext, BrowserContext } from 'playwright';

import { redactBody, redactHeaders, redactUrl, type RedactionPolicy } from './redact.js';

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface ApiRequestSpec {
  method: string;
  /** Absolute by the time it reaches a transport — `baseUrl` is resolved earlier. */
  url: string;
  headers?: Record<string, string> | undefined;
  /** Serialised by the caller, so a transport never has to guess a content type. */
  body?: string | undefined;
  timeoutMs?: number | undefined;
}

export interface ApiResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  durationMs: number;
  sizeBytes: number;
}

/** The seam. One method, same shape as `HealerModel`/`GeneratorModel`. */
export interface ApiTransport {
  readonly id: string;
  send(spec: ApiRequestSpec): Promise<ApiResponse>;
}

function lowerHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) out[name.toLowerCase()] = value;
  return out;
}

/**
 * Send through the browser context, inheriting its cookies and origin.
 *
 * `failOnStatusCode` stays off deliberately: a 4xx or 5xx is a *result* this
 * framework wants to assert on, not an exception. `expectStatus` is where a
 * status becomes pass/fail.
 */
export class BrowserTransport implements ApiTransport {
  readonly id = 'browser-context';
  readonly #request: APIRequestContext;

  constructor(context: BrowserContext) {
    this.#request = context.request;
  }

  async send(spec: ApiRequestSpec): Promise<ApiResponse> {
    const started = Date.now();
    // Built up rather than declared inline: `exactOptionalPropertyTypes` is on,
    // so an explicit `undefined` is a type error — and a GET carrying an empty
    // body would pick up a spurious `content-length: 0`.
    const options: Parameters<APIRequestContext['fetch']>[1] = {
      method: spec.method,
      headers: spec.headers ?? {},
      timeout: spec.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      failOnStatusCode: false,
    };
    if (spec.body !== undefined) options.data = spec.body;

    const response = await this.#request.fetch(spec.url, options);
    const body = await response.text();
    return {
      status: response.status(),
      statusText: response.statusText(),
      headers: lowerHeaders(response.headers()),
      body,
      durationMs: Date.now() - started,
      sizeBytes: Buffer.byteLength(body, 'utf8'),
    };
  }
}

/** Node's own `fetch`, for a flow that never opens a browser. */
export class FetchTransport implements ApiTransport {
  readonly id = 'node-fetch';

  async send(spec: ApiRequestSpec): Promise<ApiResponse> {
    const started = Date.now();
    const options: RequestInit = {
      method: spec.method,
      headers: spec.headers ?? {},
      signal: AbortSignal.timeout(spec.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
    };
    if (spec.body !== undefined) options.body = spec.body;

    const response = await fetch(spec.url, options);
    const body = await response.text();
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    return {
      status: response.status,
      statusText: response.statusText,
      headers,
      body,
      durationMs: Date.now() - started,
      sizeBytes: Buffer.byteLength(body, 'utf8'),
    };
  }
}

/** Parsed body, or `undefined` when it wasn't JSON. Never throws. */
export function parseJson(body: string): unknown {
  if (body.trim() === '') return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/**
 * Build the report-safe record of a call.
 *
 * Every field that could carry a credential goes through `redact.ts` here, at
 * the single point where a live response becomes a stored artefact — rather
 * than at each of the several places that later read one.
 */
export function recordOf(
  spec: ApiRequestSpec,
  response: ApiResponse | null,
  options: { redaction?: RedactionPolicy | undefined; error?: string | undefined; saved?: readonly string[] | undefined } = {},
): RequestRecord {
  const redaction = options.redaction ?? {};
  return {
    method: spec.method,
    url: redactUrl(spec.url),
    status: response?.status ?? null,
    statusText: response?.statusText || undefined,
    durationMs: response?.durationMs ?? 0,
    sizeBytes: response?.sizeBytes,
    requestHeaders: redactHeaders(spec.headers, redaction),
    requestBody: redactBody(spec.body, redaction),
    responseHeaders: response ? redactHeaders(response.headers, redaction) : undefined,
    responseBody: response ? redactBody(response.body, redaction) : undefined,
    saved: options.saved && options.saved.length > 0 ? [...options.saved] : undefined,
    error: options.error,
  };
}

/**
 * The stored form of one API call.
 *
 * Lives here rather than in `proof-bundle.ts` because this module owns what a
 * call *is*; the bundle only carries it. (`NetworkCall` — the passively
 * observed kind — follows the same rule from `network-observer.ts`.)
 */
export interface RequestRecord {
  method: string;
  url: string;
  /** `null` when the request never produced a response at all. */
  status: number | null;
  statusText?: string | undefined;
  durationMs: number;
  sizeBytes?: number | undefined;
  requestHeaders?: Record<string, string> | undefined;
  requestBody?: string | undefined;
  responseHeaders?: Record<string, string> | undefined;
  responseBody?: string | undefined;
  /** Names of variables extracted from the response — never their values. */
  saved?: string[] | undefined;
  error?: string | undefined;
}
