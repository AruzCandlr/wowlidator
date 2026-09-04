/**
 * Matching for the `expectCalls` assertion — pure functions over the calls
 * the `NetworkObserver` recorded, so every rule here is unit-testable without
 * a browser.
 *
 * The semantics that keep this honest against real applications:
 *
 * - **Ordered subsequence, not total order.** Expected calls must appear in
 *   this relative order; anything else (analytics beacons, polling, prefetch)
 *   interleaves freely. A strict total order would fail every real SPA and
 *   teach people to ignore the instrument. Order is *array position* in the
 *   observer's buffer — request-start order — never timestamp comparison,
 *   because two same-millisecond calls are indistinguishable by clock.
 * - **A status-pinned expectation matches completed records only.** A
 *   redirect leaves an orphaned first hop with `status: undefined`, and
 *   `classifyCall` deliberately reads in-flight as "not evidence of anything
 *   yet" — neither may satisfy a pin.
 * - **Absence claims are only as good as the capture.** The buffer is capped
 *   and drop-counted; `never` over a window that dropped calls is evaluated
 *   by the caller as *blocked*, not passed — a truncated capture reads
 *   exactly like a quiet page.
 */

import { matchesCall } from '../context/route-match.js';
import { describeCall, type NetworkCall } from './network-observer.js';

export type StatusClass = '2xx' | '3xx' | '4xx' | '5xx';

/** One expected call, as authored in a flow. */
export interface ExpectedCall {
  method: string;
  /** Path template — `/api/orders/:id` and `/api/orders/{id}` both work. */
  url: string;
  /**
   * Exact status, or a class. Omitted means "completed, any status" — the
   * call happened and got an answer, whatever the answer was.
   */
  status?: number | StatusClass | undefined;
}

/** The `expectCalls` step's parameters, as authored in a `.flow.json`. */
export interface FlowExpectCallsSpec {
  /** Ordered subsequence the window must contain. */
  calls?: ExpectedCall[] | undefined;
  /** Templates no call in the window may match. */
  never?: ExpectedCall[] | undefined;
  /**
   * `mark` (default): since the previous `expectCalls` settled (or the run
   * began) — consecutive steps verify consecutive stretches. `run`: the whole
   * buffer, for one trailing assertion after the journey.
   */
  since?: 'mark' | 'run' | undefined;
  timeoutMs?: number | undefined;
  intent?: string | undefined;
}

/** How one expected entry fared against the observed window. */
export interface CallMatch {
  expected: ExpectedCall;
  /** The record that satisfied it, or null while unmet. */
  call: NetworkCall | null;
}

export interface SequenceMatchResult {
  /** One entry per expected call, in order. */
  matches: CallMatch[];
  /** Every expected entry found a completed match, in order. */
  complete: boolean;
}

/** A call is "completed" once it has an outcome — a status or a hard error. */
function completed(call: NetworkCall): boolean {
  return call.status !== undefined || call.errorText !== undefined;
}

function statusMatches(call: NetworkCall, expected: number | StatusClass | undefined): boolean {
  if (expected === undefined) return completed(call);
  if (call.status === undefined) return false;
  if (typeof expected === 'number') return call.status === expected;
  const floor = Number(expected[0]) * 100;
  return call.status >= floor && call.status < floor + 100;
}

/** Does one observed record satisfy one expected entry? */
export function callSatisfies(call: NetworkCall, expected: ExpectedCall): boolean {
  return (
    matchesCall(call.method, call.url, expected.method, expected.url) &&
    statusMatches(call, expected.status)
  );
}

/**
 * Greedy leftmost subsequence embedding: walk the observed window once,
 * consuming expected entries in order. Greedy leftmost is complete for
 * subsequence matching — if any embedding exists, it finds one.
 */
export function matchExpectedCalls(
  observed: readonly NetworkCall[],
  expected: readonly ExpectedCall[],
): SequenceMatchResult {
  const matches: CallMatch[] = expected.map((entry) => ({ expected: entry, call: null }));
  let cursor = 0;
  for (const call of observed) {
    if (cursor >= matches.length) break;
    const current = matches[cursor]!;
    if (callSatisfies(call, current.expected)) {
      current.call = call;
      cursor += 1;
    }
  }
  return { matches, complete: cursor >= matches.length };
}

/**
 * Absence violations: any observed call matching a `never` template counts,
 * whatever its status — in-flight included, because a call *seen* is a call
 * made. (A call the page cancelled before the check ran is invisible — the
 * observer forgets cancelled requests retroactively; disclosed limitation.)
 */
export function neverViolations(
  observed: readonly NetworkCall[],
  never: readonly ExpectedCall[],
): CallMatch[] {
  const out: CallMatch[] = [];
  for (const entry of never) {
    for (const call of observed) {
      if (matchesCall(call.method, call.url, entry.method, entry.url)) {
        out.push({ expected: entry, call });
      }
    }
  }
  return out;
}

/** `POST /api/orders (2xx)` — for evidence lines and error messages. */
export function describeExpected(entry: ExpectedCall): string {
  const status = entry.status === undefined ? '' : ` (${entry.status})`;
  return `${entry.method.toUpperCase()} ${entry.url}${status}`;
}

/** One evidence line per expected entry — what the step's detail carries. */
export function matchTable(result: SequenceMatchResult): string[] {
  return result.matches.map(({ expected, call }) =>
    call === null
      ? `${describeExpected(expected)} — NOT OBSERVED`
      : `${describeExpected(expected)} — matched: ${describeCall(call)}`,
  );
}

/**
 * `"POST /api/orders -> 2xx"` (and `"never: DELETE /api/orders/:id"`) — the
 * flat authored form, one entry per line, narrowed here into structure. The
 * model writes strings because a generated schema stays flat; hand-written
 * flows and MCP input use the structured form directly.
 */
export function parseExpectedCallEntry(
  line: string,
): { never: boolean; call: ExpectedCall } | null {
  const match = /^(never:)?\s*([A-Za-z]+)\s+(\S+)\s*(?:->\s*(\S+))?$/.exec(line.trim());
  if (!match) return null;
  const [, neverFlag, method, url, status] = match;
  if (!method || !url) return null;
  // An endpoint template is a path (or an absolute URL) — requiring the shape
  // is what keeps a prose line ("just words") from parsing as a call.
  if (!/^(?:\/|https?:)/.test(url)) return null;
  const call: ExpectedCall = { method: method.toUpperCase(), url };
  if (status !== undefined && status !== '') {
    if (/^\d{3}$/.test(status)) call.status = Number(status);
    else if (/^[2-5]xx$/i.test(status)) call.status = status.toLowerCase() as StatusClass;
    else return null;
  }
  return { never: neverFlag !== undefined, call };
}

/**
 * The observer could not answer — a harness fact, never a page fact. The
 * message prefixes are load-bearing: `exit.ts` maps "network observation
 * unavailable/truncated" to `EXIT.environment`, and the step executor
 * classifies these as `error`, not `failed`, by the error's name.
 */
export class ObservationUnavailableError extends Error {
  override readonly name = 'ObservationUnavailableError';
  constructor(detail: string) {
    super(`network observation unavailable: ${detail}`);
  }
}

export class ObservationTruncatedError extends Error {
  override readonly name = 'ObservationTruncatedError';
  constructor(detail: string) {
    super(`network observation truncated: ${detail}`);
  }
}
