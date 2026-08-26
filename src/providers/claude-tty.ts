/**
 * One persistent interactive Claude Code terminal as an AI SDK provider.
 *
 * The warm-process counterpart to `claude-cli.ts`:
 *
 *   createClaudeCli() → starts `claude -p` for every generation
 *   createClaudeTty() → starts one interactive `claude` and reuses it
 *
 * It exists for the fact measured at the top of claude-cli.ts: wall-clock
 * minus the API's own duration is a flat 3.4–4.3 s per call — Node boot,
 * config load, session setup — whatever the model or the prompt. At ~20 calls
 * to author and run one case that is a minute of pure startup per case, and
 * nothing but reusing a process moves it.
 *
 * Three things the CLI provider has that this one honestly cannot:
 *
 *   * **No native `--json-schema`.** Structured output is prompt-enforced —
 *     `claude-tty` is in `SCHEMA_IN_PROMPT_PROVIDERS`, so the schema reaches
 *     the model through `promptSchemaInstruction` (the wording measured 8/8
 *     on the models that echo a schema back), and the AI SDK's own parse +
 *     zod pass is the validator. A bad reply is re-asked by the ordinary
 *     `generateStructured` loop, with the complaint attached.
 *   * **No token usage.** Terminal text carries none. Usage is reported as
 *     zero rather than invented; the request log still shows timing.
 *   * **No `--system-prompt` per call.** The process is started once, so the
 *     system text travels at the top of each task instead.
 *
 * **The answer boundary is a sentinel, and the sentinel is what makes the
 * bridge deterministic.** Every task ends with "print your answer between
 * these two markers". The markers carry a per-request id, so a stale answer
 * from an interrupted request can never be taken for the current one. Two
 * traps the naive version fell into, both handled in `handleData`:
 *
 *   * The prompt itself contains the markers (it has to — the model copies
 *     them), and the TUI echoes what was typed. The echo's envelope wraps the
 *     placeholder text, never an answer; a captured body equal to the
 *     placeholder is skipped and scanning continues.
 *   * Ink redraws the screen, so the same text can arrive more than once and
 *     the latest copy can be partial. Scanning takes the LAST opening marker
 *     and waits for its close.
 *
 * **One process answers one request at a time.** A second request queues
 * (FIFO) rather than failing — four parallel runs each asking the healer is
 * the ordinary shape of a catalog run, and a rejection there would file a
 * provider outage over a queue. Workers are pooled per `modelId|effort` in
 * module state, because `LlmFactory.callWithFailover` rebuilds the model on
 * every call: without the pool each call would start its own terminal, which
 * is the exact cost this file exists to remove. `WOWLIDATOR_CLAUDE_TTY_WORKERS`
 * widens a pool; the default is one warm terminal per (model, effort).
 *
 * Long answers wrap at the terminal width, and a wrap inside a JSON string
 * corrupts it — so the terminal is very wide (`TTY_COLS`). A fresh working
 * directory also raises Claude Code's "trust this folder?" dialog on first
 * start; startup watches for it and answers Enter.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type * as pty from 'node-pty';

import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
} from '@ai-sdk/provider';

import { flattenPrompt } from './claude-cli.js';

/** How long one completion may take — same ceiling as the CLI provider. */
export const CLAUDE_TTY_TIMEOUT_MS = 10 * 60 * 1000;
/** How long the interactive CLI may take to show its prompt. */
export const CLAUDE_TTY_STARTUP_TIMEOUT_MS = 45_000;
/**
 * The roles this provider is for — healer, agent, data — make one small
 * decision at a time; low is the measured sweet spot for them.
 */
export const DEFAULT_CLAUDE_TTY_EFFORT = 'low';
/**
 * Wide enough that an authored JSON answer never wraps. Ink wraps at the
 * terminal's columns and a wrap lands a newline inside a string value.
 */
const TTY_COLS = 4000;
const TTY_ROWS = 100;
/** Old screen text kept between requests, so scanning never walks a session's history. */
const IDLE_BUFFER_KEEP = 16 * 1024;

const OPEN = (id: string) => `<WOWLIDATOR_RESULT id="${id}">`;
const CLOSE = '</WOWLIDATOR_RESULT>';
/** What the prompt shows between the markers — never an answer. */
const PLACEHOLDER = '…your answer…';

export interface ClaudeTtyOptions {
  /** `fable`, `opus`, `sonnet`, `haiku`, or a full id. */
  modelId: string;
  /** Reasoning effort; `undefined` omits the flag. */
  effort?: string | undefined;
  /** Overridable for tests — the binary to run. */
  binary?: string | undefined;
  timeoutMs?: number | undefined;
  startupTimeoutMs?: number | undefined;
  /**
   * Extra startup arguments for the installed Claude Code version, e.g.
   * `['--permission-mode', 'plan']`. Version-specific controls live here
   * rather than in the engine.
   */
  args?: string[] | undefined;
}

/**
 * node-pty is a native module, loaded only when a terminal is actually
 * started. A static import would make its compiled binding a requirement of
 * merely importing the factory — every test, `doctor`, and a run on any other
 * provider — when it is only a requirement of this one.
 */
async function loadPty(): Promise<typeof pty> {
  try {
    return await import('node-pty');
  } catch (error) {
    throw new Error(
      'node-pty is not built on this machine — run `npm approve-scripts node-pty && npm rebuild node-pty`: ' +
        (error instanceof Error ? (error.message.split('\n')[0] ?? error.message) : String(error)),
    );
  }
}

/**
 * A directory with no CLAUDE.md. Not `tmpdir()` itself: a stray CLAUDE.md
 * left there by anything else would silently steer every request.
 */
function neutralCwd(): string {
  return mkdtempSync(join(tmpdir(), 'wowlidator-claude-tty-'));
}

/** Terminal control characters would be read by the TUI as keystrokes. */
function escapeTerminalText(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

export function stripAnsi(value: string): string {
  return value.replace(
    // CSI, OSC (BEL- or ST-terminated), and charset selection sequences.
    // eslint-disable-next-line no-control-regex
    /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|[()][0-2AB]|[@-Z\\-_])/g,
    '',
  );
}

function randomId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The text typed into the terminal for one request. The schema, when there
 * is one, is already in `system` — see `SCHEMA_IN_PROMPT_PROVIDERS`.
 */
export function buildTask(system: string, text: string, id: string): string {
  return [
    system.trim() === ''
      ? 'You answer exactly what is asked, with no preamble and no commentary.'
      : system,
    '',
    'USER TASK:',
    text,
    '',
    'When you are done, print your complete answer between exactly these two marker lines, and nothing outside them:',
    OPEN(id),
    PLACEHOLDER,
    CLOSE,
    'Do not use any tool. Do not use markdown fences. Do not write commentary before or after the markers.',
  ].join('\n');
}

/**
 * Find a real answer for `id` in terminal text: the LAST opening marker that
 * has a close after it and does not wrap the prompt's own placeholder. Returns
 * the answer and the offset just past its close, or null while still waiting.
 */
export function extractAnswer(buffer: string, id: string): { answer: string; end: number } | null {
  const open = OPEN(id);
  let from = buffer.length;
  for (;;) {
    const start = buffer.lastIndexOf(open, from);
    if (start === -1) return null;
    const contentStart = start + open.length;
    const close = buffer.indexOf(CLOSE, contentStart);
    if (close === -1) {
      // The latest copy is still arriving. An earlier complete copy (from a
      // redraw) would only ever be the same answer, so waiting is correct.
      return null;
    }
    const answer = buffer.slice(contentStart, close).trim();
    if (answer !== PLACEHOLDER) return { answer, end: close + CLOSE.length };
    // The echoed prompt. Look for an earlier occurrence — there is none that
    // is an answer, but the loop terminates cleanly either way.
    from = start - 1;
    if (from < 0) return null;
  }
}

interface Pending {
  id: string;
  resolve: (answer: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Queued {
  task: string;
  id: string;
  resolve: (answer: string) => void;
  reject: (error: Error) => void;
}

type WorkerOptions = ClaudeTtyOptions & { timeoutMs: number; startupTimeoutMs: number };

/**
 * One persistent interactive terminal, answering requests one at a time in
 * arrival order.
 */
class ClaudeTtyWorker {
  #process: pty.IPty | null = null;
  #starting: Promise<void> | null = null;
  #pending: Pending | null = null;
  readonly #queue: Queued[] = [];
  #buffer = '';
  #stopped = false;

  constructor(private readonly options: WorkerOptions) {}

  get busy(): boolean {
    return this.#pending !== null || this.#queue.length > 0;
  }

  /** Requests ahead of a new one — the pool spreads load by this. */
  get depth(): number {
    return this.#queue.length + (this.#pending === null ? 0 : 1);
  }

  async generate(task: string, id: string): Promise<string> {
    if (this.#stopped) throw new Error('claude TTY worker has been stopped');
    const answer = new Promise<string>((resolve, reject) => {
      this.#queue.push({ task, id, resolve, reject });
    });
    void this.#drain();
    return answer;
  }

  async #drain(): Promise<void> {
    if (this.#pending !== null) return;
    const next = this.#queue.shift();
    if (next === undefined) return;
    try {
      await this.#ensureStarted();
    } catch (error) {
      next.reject(error instanceof Error ? error : new Error(String(error)));
      void this.#drain();
      return;
    }
    const proc = this.#process;
    if (proc === null) {
      next.reject(new Error('claude TTY failed to start'));
      void this.#drain();
      return;
    }
    const timer = setTimeout(() => {
      if (this.#pending?.id !== next.id) return;
      this.#pending = null;
      // A timed-out session may be mid-generation. Kill it so the next
      // request starts from a clean process instead of an unknown one.
      this.restart();
      next.reject(
        new Error(`claude TTY could not be asked — the provider timed out after ${this.options.timeoutMs}ms`),
      );
      void this.#drain();
    }, this.options.timeoutMs);
    this.#pending = { id: next.id, resolve: next.resolve, reject: next.reject, timer };
    // Scanning starts at what arrives from here on; the session's earlier
    // screen text is irrelevant to this id and would only slow the search.
    this.#buffer = '';
    // Bracketed paste keeps every newline inside the prompt a newline: typed
    // bare, the first `\n` would submit a fragment. Enter after the paste is
    // what submits.
    proc.write(`\x1b[200~${escapeTerminalText(next.task)}\x1b[201~`);
    proc.write('\r');
  }

  #ensureStarted(): Promise<void> {
    if (this.#process !== null) return Promise.resolve();
    if (this.#starting !== null) return this.#starting;

    this.#starting = loadPty().then((ptyModule) => this.#spawn(ptyModule));
    this.#starting.catch(() => {
      // Whoever awaited it sees the rejection; the field must not pin it.
    });
    return this.#starting;
  }

  #spawn(ptyModule: typeof pty): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const binary = this.options.binary ?? 'claude';
      const args = [
        '--model',
        this.options.modelId,
        ...(this.options.effort === undefined ? [] : ['--effort', this.options.effort]),
        // Connected MCP servers are a different application's concern, and
        // their startup is paid on every process — same reason as the CLI.
        '--strict-mcp-config',
        ...(this.options.args ?? []),
      ];
      let settled = false;
      let trustAnswered = false;
      let startupText = '';
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(startupTimer);
        this.#starting = null;
        if (error === undefined) resolve();
        else reject(error);
      };
      const startupTimer = setTimeout(() => {
        this.restart();
        finish(new Error(`claude TTY did not show a prompt within ${this.options.startupTimeoutMs}ms`));
      }, this.options.startupTimeoutMs);

      let proc: pty.IPty;
      try {
        proc = ptyModule.spawn(binary, args, {
          name: 'xterm-256color',
          cols: TTY_COLS,
          rows: TTY_ROWS,
          cwd: neutralCwd(),
          env: {
            ...process.env,
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:
              process.env['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'] ?? '1',
          },
        });
      } catch (error) {
        finish(new Error(`could not start claude TTY: ${error instanceof Error ? error.message : String(error)}`));
        return;
      }
      this.#process = proc;

      proc.onData((data) => {
        const text = stripAnsi(data);
        if (!settled) {
          startupText = (startupText + text).slice(-8 * 1024);
          // A fresh directory asks whether to trust it; Enter takes the
          // default ("Yes, proceed"). Answered once per process.
          if (!trustAnswered && /trust/i.test(startupText) && /proceed|yes/i.test(startupText)) {
            trustAnswered = true;
            proc.write('\r');
            startupText = '';
            return;
          }
          // The input prompt is on screen: the session is ready to be typed at.
          if (/\? for shortcuts|Try "|^\s*>\s*$/m.test(startupText)) finish();
          return;
        }
        this.#onData(text);
      });

      proc.onExit(({ exitCode, signal }) => {
        const error = new Error(`claude TTY exited (code=${exitCode}, signal=${signal ?? 'none'})`);
        if (this.#process === proc) this.#process = null;
        const pending = this.#pending;
        this.#pending = null;
        this.#buffer = '';
        if (pending !== null) {
          clearTimeout(pending.timer);
          pending.reject(error);
        }
        if (!settled) finish(error);
        // Anything queued behind the crash gets a fresh process.
        void this.#drain();
      });
    });
  }

  #onData(text: string): void {
    this.#buffer += text;
    const pending = this.#pending;
    if (pending === null) {
      if (this.#buffer.length > IDLE_BUFFER_KEEP) this.#buffer = this.#buffer.slice(-IDLE_BUFFER_KEEP);
      return;
    }
    const found = extractAnswer(this.#buffer, pending.id);
    if (found === null) return;
    clearTimeout(pending.timer);
    this.#pending = null;
    this.#buffer = this.#buffer.slice(found.end);
    pending.resolve(found.answer);
    void this.#drain();
  }

  /** Kill the process; the next request starts a clean one. */
  restart(): void {
    const proc = this.#process;
    this.#process = null;
    this.#buffer = '';
    if (proc !== null) {
      try {
        proc.kill();
      } catch {
        // Already gone.
      }
    }
  }

  stop(): void {
    this.#stopped = true;
    const pending = this.#pending;
    this.#pending = null;
    if (pending !== null) {
      clearTimeout(pending.timer);
      pending.reject(new Error('claude TTY worker was stopped'));
    }
    for (const queued of this.#queue.splice(0)) {
      queued.reject(new Error('claude TTY worker was stopped'));
    }
    this.restart();
  }
}

// --- Pool -------------------------------------------------------------------

/** Warm terminals per (model, effort). */
function poolSize(): number {
  const raw = Number(process.env['WOWLIDATOR_CLAUDE_TTY_WORKERS'] ?? '1');
  return Number.isInteger(raw) && raw >= 1 ? raw : 1;
}

const pools = new Map<string, ClaudeTtyWorker[]>();

function poolKeyFor(options: WorkerOptions): string {
  return [options.binary ?? 'claude', options.modelId, options.effort ?? '', ...(options.args ?? [])].join('|');
}

/** The least-loaded worker for these options, started lazily; a new one while the pool has room. */
function workerFor(options: WorkerOptions): ClaudeTtyWorker {
  const key = poolKeyFor(options);
  const pool = pools.get(key) ?? [];
  pools.set(key, pool);
  const idle = pool.find((w) => !w.busy);
  if (idle !== undefined) return idle;
  if (pool.length < poolSize()) {
    const fresh = new ClaudeTtyWorker(options);
    pool.push(fresh);
    return fresh;
  }
  return pool.reduce((least, w) => (w.depth < least.depth ? w : least));
}

/** Kill every warm terminal. Called on process exit; a test seam otherwise. */
export function stopAllClaudeTty(): void {
  for (const pool of pools.values()) for (const worker of pool) worker.stop();
  pools.clear();
}

// A pty child outlives a parent that exits without killing it.
process.once('exit', stopAllClaudeTty);

// --- Provider -----------------------------------------------------------------

export interface ClaudeTtyProvider extends LanguageModelV4 {
  /** Kill this model's warm terminals; the next call starts fresh ones. */
  restart(): void;
}

export function createClaudeTty(options: ClaudeTtyOptions): ClaudeTtyProvider {
  const resolved: WorkerOptions = {
    ...options,
    timeoutMs: options.timeoutMs ?? CLAUDE_TTY_TIMEOUT_MS,
    startupTimeoutMs: options.startupTimeoutMs ?? CLAUDE_TTY_STARTUP_TIMEOUT_MS,
  };

  return {
    specificationVersion: 'v4',
    provider: 'claude-tty',
    modelId: options.modelId,
    supportedUrls: {},

    async doGenerate(call: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
      const { system, text } = flattenPrompt(call.prompt);
      const id = randomId();
      let answer: string;
      try {
        answer = await workerFor(resolved).generate(buildTask(system, text, id), id);
      } catch (error) {
        // Same wording as the CLI provider: the callers key off "the
        // provider refused the call" to file an outage, not an app defect.
        throw new Error(
          `claude TTY could not be asked — the provider refused the call: ${
            error instanceof Error ? (error.message.split('\n')[0] ?? error.message) : String(error)
          }`,
        );
      }
      return {
        content: answer === '' ? [] : [{ type: 'text', text: answer }],
        finishReason: { unified: 'stop', raw: 'stop' },
        // Terminal text carries no usage. Zero is a stated absence, not a count.
        usage: {
          inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 0, text: 0, reasoning: 0 },
        },
        warnings: [],
      };
    },

    doStream(): never {
      throw new Error('claude-tty does not stream; this system never asks it to');
    },

    restart(): void {
      for (const worker of pools.get(poolKeyFor(resolved)) ?? []) worker.restart();
    },
  };
}
