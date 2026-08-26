/**
 * A warm `claude` process, reused across calls.
 *
 * **Why this exists.** Measured 2026-08-26: a one-shot `claude -p` costs
 * 3.4–4.3 s of process startup before the model is even asked — Node boot,
 * config load, session setup — on every call, whatever the model or the
 * prompt. At roughly twenty calls to author and run one case, that is over a
 * minute of pure startup per case and the single largest fixed cost in a run.
 * Fed through `--input-format stream-json` instead, the same question comes
 * back in ~1.2 s: the startup is paid once and amortised over everything that
 * follows.
 *
 * **One process per role, not one per call.** The JSON schema is a launch
 * flag rather than a per-message field, so a warm process is locked to the
 * schema it was started with. That is less limiting than it first appears:
 * each ROLE asks one shape of question — the generator authors flows, the
 * healer proposes selectors, the agent decides one action — so a session
 * keyed by (model, effort, system prompt, schema) is in practice a session
 * per role, which is exactly the granularity wanted.
 *
 * **Three rules keep a long-lived process honest:**
 *
 *  - *Serial.* One question in flight at a time. The transport is a pipe with
 *    no request ids, so answers are matched by arrival order, and a second
 *    concurrent question would make that matching a guess.
 *  - *Recycled.* A session is conversational — every call adds to its
 *    context. After `MAX_TURNS_PER_SESSION` the process is retired and the
 *    next call starts a fresh one, which bounds context growth and pays one
 *    startup per forty calls rather than one per call.
 *  - *Disposable.* Any failure — a crash, a malformed line, a timeout — kills
 *    the session and reports upward, and the caller falls back to a one-shot
 *    call. A warm process is an optimisation; it must never become a new way
 *    for a run to fail.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';

/**
 * How many questions one process answers before it is retired.
 *
 * Measured 2026-08-26 on real be100 calls: a session left to run to 40 turns
 * accumulated 700k-1.7M cached input tokens, and per-call wall time grew from
 * ~5s early in the session to 26-82s by turn 20-30 — cached tokens are cheap
 * in dollars but the model still attends over them, so a bloated session gets
 * slower call by call even though nothing else changed. Ten keeps the
 * attended context small enough that a call stays well under the 20s target
 * for the run's whole lifetime, at the cost of paying the ~1.2s warm-restart
 * more often (still far cheaper than the 3.4-4.3s cold-start it replaces).
 */
export const MAX_TURNS_PER_SESSION = 10;
/** A session with nothing to do is closed rather than left holding a process. */
export const SESSION_IDLE_MS = 90_000;
/** No single answer may hang the run. */
export const SESSION_ANSWER_TIMEOUT_MS = 5 * 60_000;

export interface SessionAnswer {
  text: string;
  costUsd: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

export interface SessionKey {
  binary: string;
  /** Where the process runs — a directory with no CLAUDE.md. See `claude-cli.ts`. */
  cwd: string;
  modelId: string;
  effort: string;
  system: string;
  /** The JSON schema as a string, or null when the session takes none. */
  schema: string | null;
  tools?: string | null;
  allowedTools?: string | null;
  disallowedTools?: string | null;
}

/** Stable identity for a session's launch flags — the same flags reuse a process. */
export function sessionKeyOf(key: SessionKey): string {
  return createHash('sha1')
    .update(
      [
        key.binary,
        key.cwd,
        key.modelId,
        key.effort,
        key.system,
        key.schema ?? '',
        key.tools ?? '',
        key.allowedTools ?? '',
        key.disallowedTools ?? '',
      ].join(' '),
    )
    .digest('hex');
}

class ClaudeSession {
  readonly #child: ChildProcess;
  #buffer = '';
  #turns = 0;
  #closed = false;
  #idleTimer: NodeJS.Timeout | null = null;
  /** The question in flight, if any. Serial by construction — see the header. */
  #pending: {
    resolve: (answer: SessionAnswer) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  } | null = null;

  constructor(key: SessionKey) {
    const args = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      // stream-json output requires it; without it the CLI refuses to start.
      '--verbose',
      '--model',
      key.modelId,
      '--effort',
      key.effort,
      '--system-prompt',
      key.system === ''
        ? 'You answer exactly what is asked, with no preamble and no commentary.'
        : key.system,
      '--strict-mcp-config',
      ...(key.tools !== undefined && key.tools !== null ? ['--tools', key.tools] : []),
      ...(key.allowedTools !== undefined && key.allowedTools !== null ? ['--allowed-tools', key.allowedTools] : []),
      ...(key.disallowedTools !== undefined && key.disallowedTools !== null ? ['--disallowed-tools', key.disallowedTools] : []),
      ...(key.schema === null ? [] : ['--json-schema', key.schema]),
    ];
    this.#child = spawn(key.binary, args, { stdio: ['pipe', 'pipe', 'pipe'], cwd: key.cwd });
    this.#child.stdout?.on('data', (chunk: Buffer) => this.#onData(chunk.toString()));
    // A dead process must fail the question it was holding, not hang it.
    this.#child.on('exit', () => this.#die(new Error('the claude session exited')));
    this.#child.on('error', (error: unknown) =>
      this.#die(error instanceof Error ? error : new Error(String(error))),
    );
    // stderr is drained so the pipe cannot fill and wedge the child.
    this.#child.stderr?.on('data', () => undefined);
  }

  /** True while this process can still take another question. */
  get usable(): boolean {
    return !this.#closed && this.#turns < MAX_TURNS_PER_SESSION && this.#pending === null;
  }

  ask(text: string): Promise<SessionAnswer> {
    if (this.#closed) return Promise.reject(new Error('the claude session is closed'));
    if (this.#pending !== null) {
      return Promise.reject(new Error('the claude session is already answering'));
    }
    this.#clearIdle();
    this.#turns += 1;
    return new Promise<SessionAnswer>((resolve, reject) => {
      const timer = setTimeout(
        () => this.#die(new Error(`no answer within ${SESSION_ANSWER_TIMEOUT_MS} ms`)),
        SESSION_ANSWER_TIMEOUT_MS,
      );
      this.#pending = { resolve, reject, timer };
      const message = {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
      };
      this.#child.stdin?.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) this.#die(error);
      });
    });
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const at = this.#buffer.indexOf('\n');
      if (at < 0) break;
      const line = this.#buffer.slice(0, at);
      this.#buffer = this.#buffer.slice(at + 1);
      if (line.trim() === '') continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // A line that is not JSON is the CLI talking to a human, not to us.
        continue;
      }
      if (event['type'] !== 'result') continue;
      const held = this.#pending;
      if (held === null) continue; // an answer nobody is waiting for
      this.#pending = null;
      clearTimeout(held.timer);
      this.#startIdle();
      if (event['is_error'] === true) {
        held.reject(new Error(String(event['result'] ?? 'the claude session reported an error')));
        continue;
      }
      const usage = (event['usage'] ?? {}) as Record<string, number>;
      held.resolve({
        text: String(event['result'] ?? ''),
        costUsd: Number(event['total_cost_usd'] ?? 0),
        inputTokens: Number(usage['input_tokens'] ?? 0),
        cachedInputTokens: Number(usage['cache_read_input_tokens'] ?? 0),
        cacheWriteTokens: Number(usage['cache_creation_input_tokens'] ?? 0),
        outputTokens: Number(usage['output_tokens'] ?? 0),
      });
    }
  }

  #startIdle(): void {
    this.#clearIdle();
    this.#idleTimer = setTimeout(() => this.close(), SESSION_IDLE_MS);
    // Never hold the process open on this timer alone.
    this.#idleTimer.unref?.();
  }

  #clearIdle(): void {
    if (this.#idleTimer !== null) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = null;
    }
  }

  #die(error: Error): void {
    const held = this.#pending;
    this.#pending = null;
    this.#closed = true;
    this.#clearIdle();
    if (held !== null) {
      clearTimeout(held.timer);
      held.reject(error);
    }
    this.#child.kill();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearIdle();
    this.#child.stdin?.end();
    this.#child.kill();
  }
}

/** Live sessions by launch-flag identity. At most one process per role in practice. */
const sessions = new Map<string, ClaudeSession>();

/**
 * Ask a warm process, starting one if there is none.
 *
 * Rejects on any transport failure so the caller can fall back to a one-shot
 * call — the warm path is an optimisation and must never be the reason a run
 * fails.
 */
export async function askWarm(key: SessionKey, text: string): Promise<SessionAnswer> {
  const id = sessionKeyOf(key);
  let session = sessions.get(id);
  if (session !== undefined && !session.usable) {
    // Retired (turn budget) or busy: close and replace rather than queue —
    // the caller already serialises its own calls per role.
    session.close();
    sessions.delete(id);
    session = undefined;
  }
  if (session === undefined) {
    session = new ClaudeSession(key);
    sessions.set(id, session);
  }
  try {
    return await session.ask(text);
  } catch (error) {
    session.close();
    sessions.delete(id);
    throw error instanceof Error ? error : new Error(String(error));
  }
}

/** Close every warm process. Safe to call twice. */
export function closeClaudeSessions(): void {
  for (const session of sessions.values()) session.close();
  sessions.clear();
}
