/**
 * A signed-in session carried across a suite's cases, as data.
 *
 * The problem (asked for live, 2026-08-25): a catalog against one
 * application runs every case in its own isolated context — correct, two
 * concurrent cases must not share cookies mid-flight — but the session a
 * case establishes dies with its context, so every case pays for sign-in
 * again: authoring tokens for the login steps, run seconds for the form,
 * and the hydration-race tax on top.
 *
 * The fix is the same move the recording context already makes with the
 * attached browser (`storageState()` — the whole session as data), pointed
 * at the suite instead: after a case ends signed in, its context's storage
 * state is banked here; a later case whose flow does NOT sign in itself
 * starts its own isolated context WITH that state, and its first `goto`
 * lands already authenticated. Isolation is preserved — contexts are never
 * shared, only their serialized state — and a flow that signs in itself
 * still declines inheritance for the same reason it always has: it wants to
 * BE the account it types, not the one somebody else left behind.
 *
 * Origin-scoped: state banked on one application is never injected into a
 * flow aimed at another. In-memory and per-suite on purpose — a session on
 * disk would outlive its server-side expiry and every later run would start
 * on a corpse; within one suite, staleness is bounded by the suite itself.
 */

import type { BrowserContext } from 'playwright';

export type StoredSession = Awaited<ReturnType<BrowserContext['storageState']>>;

export class SessionVault {
  #origin: string | null = null;
  #state: StoredSession | null = null;

  /** The banked session for `origin`, or null when none (or another origin's). */
  get(origin: string): StoredSession | null {
    return this.#origin === origin ? this.#state : null;
  }

  /** Bank a session. An empty cookie jar is not a session and is refused. */
  put(origin: string, state: StoredSession): boolean {
    if (state.cookies.length === 0) return false;
    this.#origin = origin;
    this.#state = state;
    return true;
  }
}
