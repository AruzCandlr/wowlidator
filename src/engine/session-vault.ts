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
 *
 * **Keyed per account since 2026-09-03 (EH-10).** One slot per origin
 * handed a later case whichever account the previous case ended as — a
 * suite alternating employee and manager cases (ML_01_*, PRB-EC-*, CNS-EC-*)
 * put the manager's approval leg on the employee's session. `put` banks
 * under the account the run ended as (`origin :: email`), and `get` with an
 * account returns only that account's state; without one it returns the
 * most recently banked for the origin — the single-slot behaviour every
 * caller that knows no account had before.
 */

import type { BrowserContext } from 'playwright';

export type StoredSession = Awaited<ReturnType<BrowserContext['storageState']>>;

/** The slot a session lands in when nobody said whose it is. */
const ANONYMOUS = '';

export class SessionVault {
  /** `origin :: account` → state. Insertion order is the banking order. */
  readonly #sessions = new Map<string, { origin: string; account: string; state: StoredSession }>();

  static #key(origin: string, account: string | undefined): string {
    return `${origin} :: ${(account ?? ANONYMOUS).trim().toLowerCase()}`;
  }

  /**
   * The banked session for `origin` — for `account` when one is named (or
   * null when that account never banked one), else the most recently banked
   * for the origin whoever it belonged to. Another origin's state is never
   * returned.
   */
  get(origin: string, account?: string | undefined): StoredSession | null {
    if (account !== undefined && account.trim() !== '') {
      return this.#sessions.get(SessionVault.#key(origin, account))?.state ?? null;
    }
    let latest: StoredSession | null = null;
    for (const entry of this.#sessions.values()) {
      if (entry.origin === origin) latest = entry.state;
    }
    return latest;
  }

  /**
   * Bank a session under `account` (the email the run ended signed in as;
   * omitted when unknown). An empty cookie jar is not a session and is
   * refused. Re-banking moves the entry to the newest position, so "the most
   * recent for this origin" stays true.
   */
  put(origin: string, state: StoredSession, account?: string | undefined): boolean {
    if (state.cookies.length === 0) return false;
    const key = SessionVault.#key(origin, account);
    this.#sessions.delete(key);
    this.#sessions.set(key, { origin, account: (account ?? ANONYMOUS).trim().toLowerCase(), state });
    return true;
  }

  /** The accounts with a banked session on `origin`, in banking order (the anonymous slot as ''). */
  accounts(origin: string): string[] {
    return [...this.#sessions.values()].filter((e) => e.origin === origin).map((e) => e.account);
  }
}
