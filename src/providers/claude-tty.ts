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
import { extractStructuredJson } from './model-output.js';
import {
  claudeArgsTemplate,
  claudeBinary,
  claudeExtraArgs,
  renderArgsTemplate,
  validateArgsTemplate,
  type ClaudeProviderName,
} from './claude-run-script.js';

/** How long one completion may take — same ceiling as the CLI provider. */
export const CLAUDE_TTY_TIMEOUT_MS = 10 * 60 * 1000;
/** How long the interactive CLI may take to show its prompt. */
export const CLAUDE_TTY_STARTUP_TIMEOUT_MS = 45_000;
/**
 * A cloud session has a sandbox to provision before the prompt appears —
 * measured in minutes on a cold start, not the local CLI's seconds.
 */
export const CLAUDE_CLOUD_STARTUP_TIMEOUT_MS = 4 * 60_000;
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
  /** Settle time before the first request — see `WorkerOptions.readyDelayMs`. */
  readyDelayMs?: number | undefined;
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

type WorkerOptions = ClaudeTtyOptions & {
  timeoutMs: number;
  startupTimeoutMs: number;
  /**
   * The COMPLETE launch vector, rendered from the provider's args template
   * (`claude-run-script.ts`) — when set, `#spawn` runs exactly this and adds
   * nothing of its own. Absent only for a worker constructed bare in a test.
   */
  spawnArgs?: string[] | undefined;
  /**
   * How long the screen must have been QUIET before the FIRST request is
   * typed. A resumed (--teleport / --cloud) session replays its transcript
   * after the input prompt is already on screen, and text typed into that
   * replay is swallowed — measured 2026-08-27: typed at readiness, lost;
   * typed after 6 s of silence, answered in 2 s. The local CLI sets none and
   * pays nothing.
   */
  readyDelayMs?: number | undefined;
};

/** However noisy a replay, the first request goes in eventually. */
const READY_QUIET_CAP_MS = 60_000;

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
  #everAsked = false;
  #lastDataAt = 0;

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
    // See `readyDelayMs`: wait for the screen to have been quiet that long —
    // a replay still streaming would swallow what is typed into it. Only
    // ever before the first request of a process, and never past the cap.
    const quiet = this.options.readyDelayMs ?? 0;
    if (!this.#everAsked && quiet > 0) {
      const deadline = Date.now() + READY_QUIET_CAP_MS;
      for (;;) {
        const since = Date.now() - this.#lastDataAt;
        if (since >= quiet || Date.now() >= deadline) break;
        await new Promise((settle) => setTimeout(settle, Math.min(quiet - since, 1_000)));
      }
    }
    this.#everAsked = true;
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
      // The creators render the full vector from the args template; the
      // fallback below reproduces it for a worker built bare in a test.
      const args = this.options.spawnArgs ?? [
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
        this.#lastDataAt = Date.now();
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
          // The input prompt is on screen: the session is ready to be typed
          // at. `❯` is what a resumed (--teleport / --cloud) session shows;
          // a fresh local one shows the shortcut hint or a bare `>`.
          if (/\? for shortcuts|Try "|^\s*>\s*$|❯/m.test(startupText)) finish();
          return;
        }
        this.#onData(text);
      });

      proc.onExit(({ exitCode, signal }) => {
        // A process that died before its prompt appeared said WHY on the way
        // out ("--cloud requires…", "not enabled for your account…"), and
        // that text is the difference between a diagnosable failure and a
        // bare exit code — carry its tail in the error.
        const tail = settled ? '' : startupText.replace(/\s+/g, ' ').trim().slice(-300);
        const error = new Error(
          `claude TTY exited (code=${exitCode}, signal=${signal ?? 'none'})` +
            (tail === '' ? '' : ` — ${tail}`),
        );
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
    // The next process replays its transcript again — pay the settle again.
    this.#everAsked = false;
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
  return [
    options.binary ?? 'claude',
    options.modelId,
    options.effort ?? '',
    ...(options.spawnArgs ?? options.args ?? []),
  ].join('|');
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
  // The adjustable run script — see `claude-run-script.ts`. An explicitly
  // passed binary (tests) still wins over the environment; the args template
  // decides the whole launch vector, with the embedder's `options.args` and
  // the env's extra args landing where `{extra-args}` sits.
  const { template, custom } = claudeArgsTemplate('claude-tty');
  if (custom) validateArgsTemplate('claude-tty', template);
  const resolved: WorkerOptions = {
    ...options,
    binary: options.binary ?? claudeBinary('claude-tty'),
    spawnArgs: renderArgsTemplate(template, {
      'model-args': ['--model', options.modelId],
      'effort-args': options.effort === undefined ? null : ['--effort', options.effort],
      'extra-args': [...(options.args ?? []), ...claudeExtraArgs('claude-tty')],
    }),
    timeoutMs: options.timeoutMs ?? CLAUDE_TTY_TIMEOUT_MS,
    startupTimeoutMs: options.startupTimeoutMs ?? CLAUDE_TTY_STARTUP_TIMEOUT_MS,
  };
  return ttyBackedProvider('claude-tty', 'claude TTY', resolved);
}

export interface ClaudeCloudOptions extends ClaudeTtyOptions {
  /**
   * A cloud session id or claude.ai/code URL to attach to, or a task
   * description to create a fresh session from. Falls back to
   * `WOWLIDATOR_CLAUDE_CLOUD_SESSION`, then to a standing-by description.
   */
  cloudTarget?: string | undefined;
}

/**
 * What a freshly created cloud session is told it is for. A cloud session
 * starts working on its description, so the description IS the system's
 * standing instruction: hold still and answer what arrives.
 */
export const DEFAULT_CLOUD_TASK =
  'You are a worker for an automated test harness. Do not start any work on your own. ' +
  'Wait for messages, and answer each one exactly as asked, with no preamble.';

/** A cloud session id, wherever it appears — bare, or inside a claude.ai URL. */
const CLOUD_SESSION_ID = /session_[A-Za-z0-9]+/;

export function cloudSessionIdOf(target: string): string | null {
  return target.match(CLOUD_SESSION_ID)?.[0] ?? null;
}

/**
 * Create one cloud session and return its id.
 *
 * Measured 2026-08-27 on CLI 2.1.247: `claude --cloud '<task>'` under a PTY
 * answers the trust dialog's question, prints
 * `Created cloud session: … / Resume with: claude --teleport session_…`, and
 * EXITS — creation does not stay attached. So creation is its own short
 * PTY run here, and attachment is a separate process.
 */
function createCloudSession(
  binary: string,
  task: string,
  timeoutMs: number,
): Promise<string> {
  return loadPty().then(
    (ptyModule) =>
      new Promise<string>((resolve, reject) => {
        let text = '';
        let trustAnswered = false;
        let settled = false;
        const finish = (id: string | null, detail: string): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try {
            proc.kill();
          } catch {
            // Usually already exited — creation ends itself.
          }
          if (id !== null) resolve(id);
          else reject(new Error(`could not create a cloud session${detail === '' ? '' : `: ${detail}`}`));
        };
        const timer = setTimeout(
          () => finish(null, `no session id within ${timeoutMs}ms`),
          timeoutMs,
        );
        let proc: pty.IPty;
        try {
          proc = ptyModule.spawn(binary, ['--cloud', task, '--strict-mcp-config'], {
            name: 'xterm-256color',
            cols: TTY_COLS,
            rows: TTY_ROWS,
            cwd: neutralCwd(),
            env: { ...process.env },
          });
        } catch (error) {
          finish(null, error instanceof Error ? error.message : String(error));
          return;
        }
        proc.onData((data) => {
          text = (text + stripAnsi(data)).slice(-16 * 1024);
          if (!trustAnswered && /trust/i.test(text) && /proceed|yes/i.test(text)) {
            trustAnswered = true;
            proc.write('\r');
            text = '';
            return;
          }
          const id = cloudSessionIdOf(text);
          if (id !== null) finish(id, '');
        });
        proc.onExit(() => {
          finish(cloudSessionIdOf(text), text.replace(/\s+/g, ' ').trim().slice(-300));
        });
      }),
  );
}

/** One creation per (binary, target) per process — a worker pool shares it. */
const cloudSessions = new Map<string, Promise<string>>();
/**
 * How this process reaches each session. `--cloud <id>` is the real thing —
 * the model runs in the cloud sandbox — but attaching is not enabled on
 * every account ("Attaching to an existing cloud session is not enabled for
 * your account", seen live 2026-08-27); `--teleport <id>` is the fallback the
 * CLI itself suggests, resuming the session in this terminal. The first
 * refused attach flips the mode once; nothing rediscovers it per call.
 */
const cloudAttachMode = new Map<string, 'cloud' | 'teleport'>();

/** Test seam: session ids and attach modes are process-wide state. */
export function resetClaudeCloudState(): void {
  cloudSessions.clear();
  cloudAttachMode.clear();
}

function cloudSessionFor(binary: string, target: string, timeoutMs: number): Promise<string> {
  const direct = cloudSessionIdOf(target);
  if (direct !== null) return Promise.resolve(direct);
  const key = `${binary}|${target}`;
  let pending = cloudSessions.get(key);
  if (pending === undefined) {
    pending = createCloudSession(binary, target, timeoutMs);
    // A failed creation must not poison every later call.
    pending.catch(() => cloudSessions.delete(key));
    cloudSessions.set(key, pending);
  }
  return pending;
}

/**
 * After the prompt, a cloud attach replays the transcript; typing into the
 * replay is lost. Six seconds of silence was the measured safe threshold.
 */
const CLOUD_READY_DELAY_MS = 6_000;

/**
 * The same signed-in account, with the work in a Claude Code CLOUD session.
 *
 * `--cloud` refuses to run without a TTY, `-p --cloud <id>` only ENQUEUES a
 * message (`{"ok":true}` immediately, no answer channel), and creating with
 * `--cloud '<task>'` exits after printing the id — all measured 2026-08-27.
 * So the shape that actually works is: create (or take
 * `WOWLIDATOR_CLAUDE_CLOUD_SESSION`) once, then hold this file's warm
 * terminal attached to it — `--cloud <id>` where the account allows it,
 * `--teleport <id>` otherwise — and speak the same sentinel protocol as
 * `claude-tty`.
 */
export function createClaudeCloud(options: ClaudeCloudOptions): ClaudeTtyProvider {
  const binary = options.binary ?? claudeBinary('claude-cloud');
  const target =
    options.cloudTarget ??
    (process.env['WOWLIDATOR_CLAUDE_CLOUD_SESSION']?.trim() || DEFAULT_CLOUD_TASK);
  const startupTimeoutMs = options.startupTimeoutMs ?? CLAUDE_CLOUD_STARTUP_TIMEOUT_MS;
  const { template, custom } = claudeArgsTemplate('claude-cloud');
  if (custom) validateArgsTemplate('claude-cloud', template);
  const base: WorkerOptions = {
    ...options,
    binary,
    timeoutMs: options.timeoutMs ?? CLAUDE_TTY_TIMEOUT_MS,
    startupTimeoutMs,
    readyDelayMs: options.readyDelayMs ?? CLOUD_READY_DELAY_MS,
  };
  const optionsFor = (sessionId: string, mode: 'cloud' | 'teleport'): WorkerOptions => ({
    ...base,
    spawnArgs: renderArgsTemplate(template, {
      'attach-args': [mode === 'cloud' ? '--cloud' : '--teleport', sessionId],
      'model-args': ['--model', base.modelId],
      'effort-args': base.effort === undefined ? null : ['--effort', base.effort],
      'extra-args': [...(options.args ?? []), ...claudeExtraArgs('claude-cloud')],
    }),
  });

  return {
    specificationVersion: 'v4',
    provider: 'claude-cloud',
    modelId: base.modelId,
    supportedUrls: {},

    async doGenerate(call: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
      const { system, text } = flattenPrompt(call.prompt);
      const id = randomId();
      const task = buildTask(system, text, id);
      let answer: string;
      try {
        const sessionId = await cloudSessionFor(binary, target, startupTimeoutMs);
        const mode = cloudAttachMode.get(sessionId) ?? 'cloud';
        try {
          answer = await workerFor(optionsFor(sessionId, mode)).generate(task, id);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (mode !== 'cloud' || !/not enabled for your account/i.test(message)) throw error;
          cloudAttachMode.set(sessionId, 'teleport');
          process.stderr.write(
            `[wowlidator] this account cannot attach with --cloud — resuming session ${sessionId} with --teleport instead\n`,
          );
          answer = await workerFor(optionsFor(sessionId, 'teleport')).generate(task, id);
        }
      } catch (error) {
        // Same wording as the CLI provider: the callers key off "the
        // provider refused the call" to file an outage, not an app defect.
        throw new Error(
          `claude cloud session could not be asked — the provider refused the call: ${
            error instanceof Error ? (error.message.split('\n')[0] ?? error.message) : String(error)
          }`,
        );
      }
      // Terminal text has no schema channel at all, so a fenced or
      // prose-wrapped JSON answer is the EXPECTED failure shape here —
      // unwrap the packaging before the SDK parses; content untouched.
      if (call.responseFormat?.type === 'json') answer = extractStructuredJson(answer);
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
      throw new Error('claude-cloud does not stream; this system never asks it to');
    },

    restart(): void {
      // Whichever attach mode the session landed on, its workers are keyed by
      // the args that mode produced — restart both shapes.
      const sessionId = cloudSessionIdOf(target);
      for (const mode of ['cloud', 'teleport'] as const) {
        if (sessionId === null) continue;
        for (const worker of pools.get(poolKeyFor(optionsFor(sessionId, mode))) ?? []) {
          worker.restart();
        }
      }
    },
  };
}

function ttyBackedProvider(
  providerName: ClaudeProviderName,
  humanName: string,
  resolved: WorkerOptions,
): ClaudeTtyProvider {
  return {
    specificationVersion: 'v4',
    provider: providerName,
    modelId: resolved.modelId,
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
          `${humanName} could not be asked — the provider refused the call: ${
            error instanceof Error ? (error.message.split('\n')[0] ?? error.message) : String(error)
          }`,
        );
      }
      // No schema channel on a terminal: unwrap fence/prose packaging from a
      // JSON answer before the SDK parses. Content untouched — zod decides.
      if (call.responseFormat?.type === 'json') answer = extractStructuredJson(answer);
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
      throw new Error(`${providerName} does not stream; this system never asks it to`);
    },

    restart(): void {
      for (const worker of pools.get(poolKeyFor(resolved)) ?? []) worker.restart();
    },
  };
}
