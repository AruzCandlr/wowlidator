/**
 * Passive network observation for a UI run.
 *
 * wowlidator is already CDP-attached for the AX tree, so watching what the page
 * asks the backend for costs one more session and no model call. That closes
 * the framework's biggest reporting gap: until now a step that failed because
 * `POST /api/shifts` returned 500 was recorded identically to a selector that
 * had genuinely drifted — same red step, same message, and the healer would
 * cheerfully spend a token trying to repair a selector that was never wrong.
 *
 * Two things follow from that, and both are behavioural, not cosmetic:
 *
 * 1. **A backend failure suppresses the JIT heal.** This is the same argument
 *    that puts dialog dismissal ahead of healing in the escalation ladder: if
 *    the target never rendered because the request behind it failed, a heal
 *    can only do one of two things — fail identically, or "successfully"
 *    repair onto whatever *did* render, which is usually an error banner. The
 *    second outcome is worse than the failure, because the test now passes
 *    while checking the wrong thing.
 * 2. **Attribution stays correlational, and says so.** We know a request
 *    failed while a step was waiting. We do not know it caused the step to
 *    fail. Every message this module produces is worded as the former, in the
 *    same spirit as `ax-coverage.ts` refusing to credit a CSS selector it
 *    cannot attribute.
 *
 * Like history and coverage, this is diagnostic: anything that goes wrong in
 * here is swallowed and must never change the verdict of the run it describes.
 */

import type { CDPSession, Page } from 'playwright';

import { redactBody, redactHeaders, redactUrl, type RedactionPolicy } from './redact.js';

/**
 * How many calls to retain. A busy SPA can issue thousands; the report only
 * ever shows the ones adjacent to a step, and an unbounded buffer would turn a
 * long run into a memory leak and a 40 MB bundle.
 */
export const DEFAULT_MAX_CALLS = 300;

/**
 * Resource types worth recording.
 *
 * Images, stylesheets, fonts and scripts are page weight, not backend
 * behaviour, and including them would bury the two XHRs that actually matter.
 * `Document` is kept because a failed navigation is exactly the kind of
 * backend failure this module exists to attribute.
 */
const RECORDED_TYPES: ReadonlySet<string> = new Set(['XHR', 'Fetch', 'Document', 'EventSource']);

/** Why a call counts as failed — or that it doesn't. */
export type CallOutcome = 'ok' | 'client-error' | 'auth-error' | 'server-error' | 'network-error';

/**
 * Outcomes that suppress a JIT heal.
 *
 * A plain 4xx does not: a 404 probing for an optional resource, or a 422 from
 * a validation test that *meant* to submit something invalid, are both normal
 * and neither says the page is broken. A 5xx, a dropped connection, or an
 * expired session says the app could not do its job.
 */
const BLOCKING_OUTCOMES: ReadonlySet<CallOutcome> = new Set([
  'server-error',
  'network-error',
  'auth-error',
]);

/** One observed HTTP call. */
export interface NetworkCall {
  /** CDP request id — stable across the request/response/finished events. */
  id: string;
  method: string;
  /** Query-string credentials already masked. */
  url: string;
  resourceType: string;
  status?: number | undefined;
  statusText?: string | undefined;
  /** Set when the request never produced a response at all. */
  errorText?: string | undefined;
  /** Wall-clock ms when the request was seen, used to align with step boundaries. */
  startedAt: number;
  endedAt?: number | undefined;
  durationMs?: number | undefined;
  requestHeaders?: Record<string, string> | undefined;
  requestBody?: string | undefined;
  responseHeaders?: Record<string, string> | undefined;
  sizeBytes?: number | undefined;
}

export interface NetworkObserverOptions {
  maxCalls?: number | undefined;
  redaction?: RedactionPolicy | undefined;
  /** Record request/response headers at all. Default true (already redacted). */
  headers?: boolean | undefined;
}

interface CdpRequestWillBeSent {
  requestId: string;
  type?: string;
  request: {
    url: string;
    method: string;
    headers?: Record<string, string>;
    postData?: string;
  };
}

interface CdpResponseReceived {
  requestId: string;
  type?: string;
  response: {
    status: number;
    statusText?: string;
    headers?: Record<string, string>;
    encodedDataLength?: number;
  };
}

interface CdpLoadingFailed {
  requestId: string;
  type?: string;
  errorText?: string;
  canceled?: boolean;
}

interface CdpLoadingFinished {
  requestId: string;
  encodedDataLength?: number;
}

/** Classify one call. Pure — exported so the reporter and tests share the rule. */
export function classifyCall(call: NetworkCall): CallOutcome {
  if (call.errorText) return 'network-error';
  if (call.status === undefined) return 'ok'; // still in flight; not evidence of anything yet
  if (call.status === 0) return 'network-error';
  if (call.status === 401 || call.status === 403) return 'auth-error';
  if (call.status >= 500) return 'server-error';
  if (call.status >= 400) return 'client-error';
  return 'ok';
}

/** True when this call is strong enough evidence to stop the ladder. */
export function isBlockingFailure(call: NetworkCall): boolean {
  return BLOCKING_OUTCOMES.has(classifyCall(call));
}

/** One-line human summary, used in defect text and CLI progress lines. */
export function describeCall(call: NetworkCall): string {
  const status = call.errorText ?? (call.status === undefined ? 'no response' : String(call.status));
  const timing = call.durationMs === undefined ? '' : ` in ${call.durationMs}ms`;
  return `${call.method} ${call.url} → ${status}${timing}`;
}

export class NetworkObserver {
  readonly #session: CDPSession;
  readonly #maxCalls: number;
  readonly #redaction: RedactionPolicy;
  readonly #headers: boolean;

  /** Completed and in-flight calls, oldest first. */
  readonly #calls: NetworkCall[] = [];
  readonly #byId = new Map<string, NetworkCall>();
  #dropped = 0;
  #detached = false;

  private constructor(session: CDPSession, options: NetworkObserverOptions) {
    this.#session = session;
    this.#maxCalls = options.maxCalls ?? DEFAULT_MAX_CALLS;
    this.#redaction = options.redaction ?? {};
    this.#headers = options.headers ?? true;
  }

  /**
   * Start observing. Throws if CDP refuses — callers treat that as "run
   * without observation", never as a failed run.
   */
  static async attach(page: Page, options: NetworkObserverOptions = {}): Promise<NetworkObserver> {
    const session = await page.context().newCDPSession(page);
    const observer = new NetworkObserver(session, options);
    await session.send('Network.enable');
    observer.#listen();
    return observer;
  }

  #listen(): void {
    // Playwright types CDP event payloads as `any`; the local interfaces above
    // are the same shim pattern `captureAxNodes` uses for the AX tree.
    this.#session.on('Network.requestWillBeSent', (event) => {
      this.#guard(() => this.#onRequest(event as unknown as CdpRequestWillBeSent));
    });
    this.#session.on('Network.responseReceived', (event) => {
      this.#guard(() => this.#onResponse(event as unknown as CdpResponseReceived));
    });
    this.#session.on('Network.loadingFailed', (event) => {
      this.#guard(() => this.#onFailed(event as unknown as CdpLoadingFailed));
    });
    this.#session.on('Network.loadingFinished', (event) => {
      this.#guard(() => this.#onFinished(event as unknown as CdpLoadingFinished));
    });
  }

  /** Diagnostic code must never throw into the execution plane. */
  #guard(fn: () => void): void {
    try {
      fn();
    } catch {
      // Losing one event costs a line in a report; throwing would cost the run.
    }
  }

  #onRequest(event: CdpRequestWillBeSent): void {
    const type = event.type ?? '';
    if (!RECORDED_TYPES.has(type)) return;

    // A redirect reuses the same requestId. Keep the newest hop — that's the
    // one whose outcome the page actually acted on.
    const call: NetworkCall = {
      id: event.requestId,
      method: event.request.method,
      url: redactUrl(event.request.url),
      resourceType: type,
      startedAt: Date.now(),
      requestHeaders: this.#headers
        ? redactHeaders(event.request.headers, this.#redaction)
        : undefined,
      requestBody: redactBody(event.request.postData, this.#redaction),
    };

    this.#byId.set(call.id, call);
    this.#calls.push(call);
    this.#trim();
  }

  #onResponse(event: CdpResponseReceived): void {
    const call = this.#byId.get(event.requestId);
    if (!call) return;
    call.status = event.response.status;
    call.statusText = event.response.statusText || undefined;
    if (this.#headers) {
      call.responseHeaders = redactHeaders(event.response.headers, this.#redaction);
    }
  }

  #onFailed(event: CdpLoadingFailed): void {
    const call = this.#byId.get(event.requestId);
    if (!call) return;
    // A canceled request is usually the page itself abandoning a fetch on
    // navigation or an aborted controller — not a backend failure, and
    // reporting it as one would train people to ignore this whole feature.
    if (event.canceled) {
      this.#forget(call);
      return;
    }
    call.errorText = event.errorText || 'request failed';
    this.#complete(call);
  }

  #onFinished(event: CdpLoadingFinished): void {
    const call = this.#byId.get(event.requestId);
    if (!call) return;
    if (event.encodedDataLength !== undefined) call.sizeBytes = event.encodedDataLength;
    this.#complete(call);
  }

  #complete(call: NetworkCall): void {
    call.endedAt = Date.now();
    call.durationMs = call.endedAt - call.startedAt;
    this.#byId.delete(call.id);
  }

  #forget(call: NetworkCall): void {
    this.#byId.delete(call.id);
    const index = this.#calls.indexOf(call);
    if (index >= 0) this.#calls.splice(index, 1);
  }

  #trim(): void {
    while (this.#calls.length > this.#maxCalls) {
      const evicted = this.#calls.shift();
      if (evicted) {
        this.#byId.delete(evicted.id);
        this.#dropped += 1;
      }
    }
  }

  /** Timestamp to hand back to `since()`. Taken at the start of a step. */
  mark(): number {
    return Date.now();
  }

  /** Calls that began at or after `mark`, oldest first. */
  since(mark: number): NetworkCall[] {
    return this.#calls.filter((call) => call.startedAt >= mark);
  }

  /**
   * Calls since `mark` whose outcome is strong enough to explain a step
   * failure — 5xx, dropped connection, or expired session.
   */
  blockingFailuresSince(mark: number): NetworkCall[] {
    return this.since(mark).filter(isBlockingFailure);
  }

  /** Every call seen, oldest first. */
  all(): readonly NetworkCall[] {
    return this.#calls;
  }

  /**
   * How many calls fell out of the buffer.
   *
   * Surfaced rather than swallowed: a report that silently dropped half the
   * traffic reads exactly like a report of a quiet page.
   */
  get dropped(): number {
    return this.#dropped;
  }

  async detach(): Promise<void> {
    if (this.#detached) return;
    this.#detached = true;
    try {
      await this.#session.send('Network.disable');
    } catch {
      // The page may already be gone; nothing here is worth failing a run over.
    }
    await this.#session.detach().catch(() => undefined);
  }
}
