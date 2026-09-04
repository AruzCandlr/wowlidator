/**
 * More than one Chrome for a parallel run (`--browsers <n>`, 2026-09-03).
 *
 * A parallel suite used to put every lane in the same browser process — one
 * Chrome, one context per case. That is correct for isolation (contexts do
 * not share cookies) and wrong for throughput: every renderer, every video
 * encoder and every CDP session shares one browser's main thread, and a run
 * at concurrency 8 spent its time queued behind that thread rather than
 * behind the application. Headless makes this cheap to fix — a window nobody
 * looks at costs nothing to have five of — so a pool of headless browsers is
 * launched up front and each lane leases the least-loaded one for the length
 * of its case.
 *
 * Two pure pieces live here so they can be tested without a browser:
 * - `poolMember` — where the i-th browser listens and which profile it owns.
 *   Ports are consecutive from the primary's; profiles get a `-<i>` suffix, so
 *   `chromeIsOurs` and `stopChrome` (which match on port AND profile) treat
 *   each member as a browser of its own and never confuse two.
 * - `BrowserLease` — the least-loaded pick. Lanes are not numbered stably
 *   (the queue dispatches by arrival, and exclusive cases drain the pool), so
 *   "lane i uses browser i" would pile cases onto one browser after a drain;
 *   counting what is in flight does not.
 */

/** Where the i-th browser of a pool lives. Member 0 is the primary, untouched. */
export function poolMember(
  cdpUrl: string,
  profile: string,
  index: number,
): { cdpUrl: string; profile: string } {
  if (index <= 0) return { cdpUrl, profile };
  let url: URL;
  try {
    url = new URL(cdpUrl);
  } catch {
    url = new URL('http://localhost:9222');
  }
  const base = Number(url.port || '9222');
  url.port = String(base + index);
  // `toString()` adds a trailing slash the CDP helpers never expect.
  const member = url.toString().replace(/\/$/, '');
  return { cdpUrl: member, profile: `${profile}-${index + 1}` };
}

/**
 * Hands a lane the browser with the fewest cases on it.
 *
 * Synchronous on purpose: a lease is a bookkeeping decision, not an I/O one,
 * and a lane that had to await it would be a lane holding a queue slot while
 * doing nothing. Ties go to the lowest index, so a serial run (one case at a
 * time) always lands on the primary and behaves exactly as before.
 */
export class BrowserLease {
  readonly #cdpUrls: string[];
  readonly #inFlight: number[];

  constructor(cdpUrls: readonly string[]) {
    if (cdpUrls.length === 0) throw new Error('a browser lease needs at least one browser');
    this.#cdpUrls = [...cdpUrls];
    this.#inFlight = cdpUrls.map(() => 0);
  }

  /** The browsers in the pool, primary first — including any added later. */
  get cdpUrls(): readonly string[] {
    return this.#cdpUrls;
  }

  /** How many browsers are in the pool. */
  get size(): number {
    return this.#cdpUrls.length;
  }

  /** Cases currently leased to each browser, by index. */
  load(): readonly number[] {
    return [...this.#inFlight];
  }

  /**
   * A browser that joined after the pool was built (`growPool`, for a case
   * that needs one Chrome per persona). Idempotent: a URL already in the
   * pool is left where it is.
   */
  add(cdpUrl: string): void {
    if (this.#cdpUrls.includes(cdpUrl)) return;
    this.#cdpUrls.push(cdpUrl);
    this.#inFlight.push(0);
  }

  acquire(): string {
    return this.acquireMany(1).cdpUrls[0]!;
  }

  /**
   * `k` browsers for one case — one per persona. Distinct members when the
   * pool has them, least-loaded first, ties to the lowest index so a serial
   * single-persona run still lands on the primary. When the pool is smaller
   * than `k` the least-loaded member is leased again and `distinct` says so:
   * the case still runs (contexts isolate cookies on their own), the report
   * discloses which people shared a Chrome.
   */
  acquireMany(k: number): { cdpUrls: string[]; distinct: boolean } {
    const wanted = Math.max(1, Math.floor(k));
    const picked: string[] = [];
    const taken = new Set<number>();
    let distinct = true;
    for (let n = 0; n < wanted; n += 1) {
      let pick = -1;
      for (let i = 0; i < this.#inFlight.length; i += 1) {
        if (taken.has(i)) continue;
        if (pick < 0 || this.#inFlight[i]! < this.#inFlight[pick]!) pick = i;
      }
      if (pick < 0) {
        // Every member is already in this case's hands: double up on the
        // least-loaded one.
        distinct = false;
        pick = 0;
        for (let i = 1; i < this.#inFlight.length; i += 1) {
          if (this.#inFlight[i]! < this.#inFlight[pick]!) pick = i;
        }
      } else {
        taken.add(pick);
      }
      this.#inFlight[pick] = (this.#inFlight[pick] ?? 0) + 1;
      picked.push(this.#cdpUrls[pick]!);
    }
    return { cdpUrls: picked, distinct };
  }

  release(cdpUrl: string): void {
    const i = this.#cdpUrls.indexOf(cdpUrl);
    if (i < 0) return;
    this.#inFlight[i] = Math.max(0, this.#inFlight[i]! - 1);
  }

  /** The counterpart of `acquireMany`: a URL leased twice is released twice. */
  releaseMany(cdpUrls: readonly string[]): void {
    for (const url of cdpUrls) this.release(url);
  }
}
