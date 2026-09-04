/**
 * Admission control for a provider that answers one call at a time.
 *
 * A local MLX server (`rerise`) prefills serially and batches decode two
 * wide. Four roles calling it at once do not run in parallel — they queue
 * inside the server, blind to who is waiting on what, and measured live the
 * third concurrent call came back as garbage. The server's throughput is
 * fixed; what this module decides is WHICH call gets it next, HOW MANY are in
 * flight, and that no call is made twice for the same question.
 *
 * Three rules, each a measured fact about the server rather than a preference:
 *
 * - **At most `maxInFlight` calls at once, and at most ONE large prompt.**
 *   `maxInFlight` matches the server's decode batch (2): a small healer call
 *   rides the batch beside a generating authoring call for free. A second
 *   large prompt does not — its prefill blocks everyone, and two 25k-char
 *   authoring prompts in flight is exactly the shape that produced timeouts.
 * - **Priority by who is waiting.** `agent` first (a browser turn is blocked
 *   and the page may change under it), then `healer` (a step is mid-failure),
 *   then `data`, then `generator` (a row can be authored later; nothing is
 *   held open). FIFO inside a class, so authoring keeps sheet order.
 * - **Identical in-flight questions are asked once.** Parallel cases whose
 *   login selector drifted the same way used to pay the healer N times for
 *   one answer. A second caller with the same role, system and prompt joins
 *   the first call's promise and is charged no tokens.
 *
 * One gate per *server* (keyed on base URL), not per provider: two local
 * servers on different ports are two resources. Temperature is 0 everywhere,
 * so ordering changes when an answer arrives, never what it is.
 */

import type { LlmRole } from '../config.js';

export const SERIAL_MAX_IN_FLIGHT = 2;
export const SERIAL_MAX_LARGE_IN_FLIGHT = 1;
/** Roughly 8k tokens: the authoring/repair prompts, never a heal or a decision. */
export const SERIAL_LARGE_PROMPT_CHARS = 32_000;

/** Lower runs first. A role not listed queues behind everything. */
export const SERIAL_ROLE_PRIORITY: Readonly<Record<string, number>> = {
  agent: 0,
  healer: 1,
  data: 2,
  generator: 3,
};

export interface SerialGateOptions {
  maxInFlight?: number;
  maxLargeInFlight?: number;
  largePromptChars?: number;
}

interface Waiter {
  role: string;
  large: boolean;
  seq: number;
  admit: () => void;
}

export interface SerialGateSnapshot {
  inFlight: number;
  largeInFlight: number;
  waiting: number;
}

export class SerialGate {
  readonly #maxInFlight: number;
  readonly #maxLarge: number;
  readonly #largeChars: number;
  readonly #waiting: Waiter[] = [];
  readonly #inFlightDedupe = new Map<string, Promise<unknown>>();
  #inFlight = 0;
  #largeInFlight = 0;
  #seq = 0;

  constructor(options: SerialGateOptions = {}) {
    this.#maxInFlight = Math.max(1, options.maxInFlight ?? SERIAL_MAX_IN_FLIGHT);
    this.#maxLarge = Math.max(1, options.maxLargeInFlight ?? SERIAL_MAX_LARGE_IN_FLIGHT);
    this.#largeChars = options.largePromptChars ?? SERIAL_LARGE_PROMPT_CHARS;
  }

  snapshot(): SerialGateSnapshot {
    return {
      inFlight: this.#inFlight,
      largeInFlight: this.#largeInFlight,
      waiting: this.#waiting.length,
    };
  }

  isLarge(promptChars: number): boolean {
    return promptChars >= this.#largeChars;
  }

  /**
   * Run `call` once a slot is free. `dedupeKey`, when given, lets a caller
   * with the same key join a call already in flight instead of queueing a
   * duplicate; `joined` tells the caller which happened, so it can decline to
   * count tokens it did not spend.
   */
  async run<T>(
    role: LlmRole | string,
    promptChars: number,
    call: () => Promise<T>,
    dedupeKey?: string,
  ): Promise<{ result: T; joined: boolean }> {
    if (dedupeKey !== undefined) {
      const existing = this.#inFlightDedupe.get(dedupeKey);
      if (existing !== undefined) {
        return { result: (await existing) as T, joined: true };
      }
    }
    const large = this.isLarge(promptChars);
    // Registered BEFORE waiting for a slot: a second identical question that
    // arrives while the first is still queued must join it, not queue again.
    const pending = (async () => {
      await this.#acquire(role, large);
      try {
        return await call();
      } finally {
        this.#release(large);
        if (dedupeKey !== undefined) this.#inFlightDedupe.delete(dedupeKey);
      }
    })();
    if (dedupeKey !== undefined) this.#inFlightDedupe.set(dedupeKey, pending);
    return { result: await pending, joined: false };
  }

  #canAdmit(large: boolean): boolean {
    if (this.#inFlight >= this.#maxInFlight) return false;
    if (large && this.#largeInFlight >= this.#maxLarge) return false;
    return true;
  }

  #acquire(role: string, large: boolean): Promise<void> {
    if (this.#waiting.length === 0 && this.#canAdmit(large)) {
      this.#take(large);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.#waiting.push({ role, large, seq: this.#seq++, admit: resolve });
      // A newly queued small call may be admissible right now even while a
      // large one waits ahead of it — the large cap, not the in-flight cap,
      // is what holds the large one back.
      this.#drain();
    });
  }

  #take(large: boolean): void {
    this.#inFlight++;
    if (large) this.#largeInFlight++;
  }

  #release(large: boolean): void {
    this.#inFlight--;
    if (large) this.#largeInFlight--;
    this.#drain();
  }

  #drain(): void {
    // Highest priority first, FIFO within it; skip what the large cap holds.
    for (;;) {
      if (this.#inFlight >= this.#maxInFlight) return;
      let best = -1;
      for (let i = 0; i < this.#waiting.length; i++) {
        const w = this.#waiting[i]!;
        if (!this.#canAdmit(w.large)) continue;
        if (best === -1) {
          best = i;
          continue;
        }
        const b = this.#waiting[best]!;
        const pw = SERIAL_ROLE_PRIORITY[w.role] ?? Number.MAX_SAFE_INTEGER;
        const pb = SERIAL_ROLE_PRIORITY[b.role] ?? Number.MAX_SAFE_INTEGER;
        if (pw < pb || (pw === pb && w.seq < b.seq)) best = i;
      }
      if (best === -1) return;
      const [next] = this.#waiting.splice(best, 1);
      this.#take(next!.large);
      next!.admit();
    }
  }
}

const gates = new Map<string, SerialGate>();

/** The gate for one server. Process-wide: every role in this process shares the server. */
export function serialGateFor(serverKey: string): SerialGate {
  let gate = gates.get(serverKey);
  if (gate === undefined) {
    gate = new SerialGate();
    gates.set(serverKey, gate);
  }
  return gate;
}

/** Test seam. */
export function resetSerialGates(): void {
  gates.clear();
}

/** A cheap, stable key for "the same question": role, model and the full text. */
export function dedupeKeyFor(parts: readonly string[]): string {
  // Two FNV-style hashes over the concatenation; a collision at this scale
  // is astronomically unlikely and would only share one correct answer.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const text = parts.join('\u0000');
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x2f0b4a13) >>> 0;
  }
  return `${text.length}:${h1.toString(16)}:${h2.toString(16)}`;
}
