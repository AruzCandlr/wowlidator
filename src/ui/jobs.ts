/**
 * Running a wowlidator command on behalf of the page, and streaming it back.
 *
 * The UI does not reimplement any of wowlidator — it starts the same CLI you would
 * type, with the same arguments, and forwards its output line by line. That is
 * deliberate: a second execution path would be a second thing to keep correct,
 * and the first symptom of it drifting would be a UI that reports a pass the
 * command line calls a failure.
 *
 * Two rules the rest of the server depends on:
 *
 * - **Browser commands are serialised.** Two runs sharing one CDP endpoint
 *   interleave their clicks and the report describes neither. `start()` refuses
 *   rather than queueing, because a run that begins ten minutes later against a
 *   page that has since changed is not the run anyone asked for.
 * - **Output is kept, not just streamed.** A page reloaded mid-run rejoins from
 *   the buffer instead of watching an empty pane, and a finished job stays
 *   readable until it is replaced.
 */

import { writeFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DOTENV_SOURCED } from '../config.js';
import { formatCommandLine, type CommandSpec } from './commands.js';

/** Lines kept per job. A crawl is chatty; a browser tab is not a log server. */
const MAX_LINES = 4000;

export type JobStatus = 'running' | 'passed' | 'failed' | 'error' | 'stopped';

export interface JobLine {
  stream: 'out' | 'err';
  text: string;
}

/** A file the run said it wrote. Parsed from output so the UI can link to it. */
export interface JobArtifact {
  kind: string;
  path: string;
}

/**
 * How far along a run is, and how much longer it is likely to take.
 *
 * Both are read out of the command's own output rather than computed by a
 * second copy of the engine's bookkeeping — the same reasoning that keeps this
 * file spawning the CLI instead of importing it. `plan` is the denominator the
 * run announced; the step lines that follow are the numerator.
 */
export interface JobProgress {
  /** Steps recorded so far. */
  done: number;
  /** Steps the run said it intends to take, or null before it has said. */
  total: number | null;
  /**
   * Milliseconds left, from this run's own observed pace. Null until a step has
   * finished, because there is nothing to extrapolate from until then — an
   * estimate produced before any evidence would be a guess wearing a number.
   */
  etaMs: number | null;
  /**
   * The smoothed pace, in ms per step — an exponential moving average, seeded
   * from the first observed step and updated with tqdm's default smoothing
   * (0.3) after that. Null until a step has finished, same rule as `etaMs`.
   */
  rateMsPerStep: number | null;
  /** `elapsedMs` when `done` last advanced — the anchor the next step's dt is measured from. */
  lastStepMs: number;
  /**
   * `elapsedMs` when this unit's own work began — a case picked up mid-suite
   * starts its clock at its `started` line, not at the job's. Without it the
   * first observed step's dt spans the whole queue wait (30 minutes of other
   * cases), the EMA is seeded from that, and the ETA reads hours for a
   * ten-second case. Null for job-level progress (the job's clock IS its own).
   */
  startedMs: number | null;
  /**
   * How far along, 0-100, for a command that has no steps to count.
   *
   * Reading a catalog is one model call and a file read — there is no step
   * line, so the step numerator stays 0 and a bar built on it can only sit at
   * "starting…" until the whole thing finishes. That is the shape of work this
   * covers: **named phases, in a known order**, each worth a fixed share. It is
   * coarse on purpose, and it is honest about being coarse — the number moves
   * when the command actually reaches the next thing it does, never on a timer.
   *
   * Null when the command reports steps instead; those divide exactly and need
   * no estimate.
   */
  percent: number | null;
  /** What it is doing right now, in the words the command used. */
  phase: string | null;
}

/**
 * One case of a suite, as the panel follows it.
 *
 * A catalog runs its cases concurrently, so a single job's output carries
 * several runs at once and a single progress bar could only describe their
 * average — which is nothing anybody is waiting for. Each case therefore keeps
 * its own denominator, its own lines and its own verdict, demultiplexed from
 * the `[cN]` tag the CLI prints in front of every line it owns.
 */
export interface JobCase {
  /** 1-based, as the tag writes it. */
  number: number;
  name: string;
  /** True when the plan said this case changes data and must run alone. */
  exclusive: boolean;
  status: 'waiting' | 'running' | 'passed' | 'passed-with-issues' | 'needs-review' | 'failed' | 'error' | 'dead-end' | 'blocked';
  /**
   * The reason the CLI printed when it scored this case `blocked` or "no
   * verdict" — the `BLOCKED <case> — <reason>` and `! no verdict: <reason>`
   * lines the suite loop writes. Parsed out of the case's own output, never
   * derived: it is what the row shows under the chip so a person does not
   * have to open the console to learn why nothing was proved. Null until such
   * a line arrives.
   */
  reason: string | null;
  lines: JobLine[];
  progress: JobProgress;
}

export interface Job {
  id: string;
  commandId: string;
  title: string;
  commandLine: string;
  argv: string[];
  /**
   * The secret environment this job was started with — credentials
   * (`WOWLIDATOR_AS`), a database URL. Kept so a RESUME can carry them
   * forward, and kept **in memory only**: never written beside the job,
   * never in `summariseJob`, never in the command line.
   *
   * It exists because of a measured failure (be100, 2026-08-26): a secret
   * field is carried by env overlay and deliberately never becomes argv, so
   * a resume that replays the prior job's argv started a run with no
   * credentials at all. Twenty-five of twenty-six cases then failed on
   * "prove the sign-in took effect" — one lost variable, reported as
   * twenty-five findings about the application.
   */
  secretEnv?: Record<string, string> | undefined;
  browser: boolean;
  longRunning: boolean;
  status: JobStatus;
  exitCode: number | null;
  startedAt: string;
  finishedAt: string | null;
  lines: JobLine[];
  artifacts: JobArtifact[];
  progress: JobProgress;
  /** Empty unless the command announced a per-case plan. */
  cases: JobCase[];
  /**
   * How the job ended, once it has. `cause` is the best one-line account the
   * output gives — the stop request, the signal, the error most cases were
   * blocked on, or the exit code; `resumable` says a `--resume` of the same
   * command would have work to do (a catalog with cases still waiting,
   * running or blocked when it ended); `runtimeError` marks an end that was
   * the machinery's, not a verdict about the application.
   */
  ended: {
    cause: string | null;
    resumable: boolean;
    runtimeError: boolean;
    /** Cases that ended in `error` — re-runnable as a batch. */
    errors: number;
    /** Cases that `failed` / dead-ended — healable as a batch. */
    failed: number;
    /** Cases that were never reached, still running, or blocked when the job ended. */
    unfinished: number;
  } | null;
}

/**
 * `  report     /path/to/x.html` — the shape every wowlidator command uses to say
 * where it put something. Parsed rather than re-derived so a new artifact kind
 * shows up in the UI without this file knowing it exists.
 */
const ARTIFACT_LINE = /^\s{2,}(report|proof|flow|patch|suite|index|junit|ctrf|folder)\s{2,}(\S.*)$/;

/** `  plan       17 step(s)` — the denominator, announced before the first step. */
const PLAN_LINE = /^\s{2,}plan\s{2,}(\d+) step/;

/**
 * `[c3] …` — which case a line belongs to.
 *
 * Printed only when a suite actually runs more than one case at a time, so a
 * sequential run's output carries no tags and every path below is inert. The
 * tag is stripped before the line is parsed for anything else, which is what
 * lets `PLAN_LINE`, `STEP_LINE` and `ARTIFACT_LINE` stay exactly as they were.
 */
const CASE_TAG = /^\[c(\d+)\] ?/;

/** `  [c3]      alone   PB_03_01 …` — the roster, printed before anything runs. */
const CASE_ROSTER = /^\s{2,}\[c(\d+)\]\s{2,}(alone|shared)\s+(\S.*)$/;

/** `case "…" started` / `case "…" passed` — the boundaries of one case's life. */
const CASE_STARTED = /^case "(.+)" started$/;
const CASE_ENDED = /^case "(.+)" (passed-with-issues|needs-review|passed|failed|error|dead-end|blocked)$/;
/** The two lines on which the suite loop says why a case delivered no verdict. */
const CASE_REASON = /^BLOCKED .+? — (.+)$|^\s*! no verdict: (.+)$/;

/** The recorded reason on a case's output line, or null when the line is not one. */
export function caseReasonOf(text: string): string | null {
  const m = CASE_REASON.exec(text);
  const reason = (m?.[1] ?? m?.[2])?.trim();
  return reason === undefined || reason === '' ? null : reason.slice(0, 300);
}

/**
 * Milestones for the commands that have no steps to count, in the order they
 * happen and with the share of the work each one means it has reached.
 *
 * Matched against the command's own output rather than invented here, so a
 * phase cannot claim to have happened before the command said it did. The
 * shares are judgement, and deliberately conservative near the end: the last
 * stretch of a catalog is a model call whose length nobody can predict, and a
 * bar that sits at 95% for eight seconds is worse than one that sits at 60%.
 */
const PHASE_LINES: readonly { pattern: RegExp; percent: number; phase: string }[] = [
  { pattern: /^read .+ \((csv|markdown|html|text|json|yaml|xlsx|pdf)[,)]/, percent: 5, phase: 'reading the document' },
  { pattern: /^asking the generator role what this document claims/, percent: 20, phase: 'asking the model what it claims' },
  { pattern: /is a test-case table — (\d+) case/, percent: 20, phase: 'reading its columns' },
  { pattern: /^read (\d+) approved claim/, percent: 20, phase: 'reading the approved claims' },
  { pattern: /^writing a flow for/, percent: 40, phase: 'writing the test' },
  { pattern: /^writing ([A-Za-z0-9_]+):/, percent: 45, phase: 'writing the test' },
  { pattern: /^authored /, percent: 60, phase: 'authored — starting the run' },
  { pattern: /^read (\d+) claim\(s\) from/, percent: 90, phase: 'listing the claims' },
  { pattern: /^drafted (\d+) case/, percent: 90, phase: 'writing the catalog' },
];

/**
 * `✓ [3] click role=button…` — one completed step.
 *
 * The index is the engine's own, and it is 0-based, so the count of finished
 * steps is one more than the highest index seen. Read as a maximum rather than
 * a running total because a repair attempt restarts the flow and the indices
 * begin again: counting lines would report 40 steps done out of 20.
 */
const STEP_LINE = /^[✓✗] \[(\d+)\]/;

/** The directory holding package.json, from wherever this file was loaded. */
function projectRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

/**
 * How to invoke the CLI.
 *
 * A built `dist/cli.js` starts noticeably faster, so it wins when it is there;
 * otherwise the same `tsx src/cli.ts` the `cli` npm script uses. Neither path
 * goes through a shell.
 */
function cliCommand(): { file: string; prefix: string[] } {
  const root = projectRoot();
  const built = join(root, 'dist', 'cli.js');
  if (existsSync(built)) return { file: process.execPath, prefix: [built] };

  const tsx = join(root, 'node_modules', '.bin', 'tsx');
  if (existsSync(tsx)) return { file: tsx, prefix: [join(root, 'src', 'cli.ts')] };

  throw new Error(
    'cannot find a way to run wowlidator: neither dist/cli.js nor node_modules/.bin/tsx exists. ' +
      'Run `npm install` (and optionally `npm run build`) first.',
  );
}

export class JobRunner {
  #jobs = new Map<string, Job>();
  #processes = new Map<string, ChildProcess>();
  #subscribers = new Map<string, Set<(event: string, data: unknown) => void>>();
  #order: string[] = [];
  #nextId = 1;

  /** The one browser job allowed to be in flight. */
  #browserJobId: string | null = null;

  /** Called once per job, after its status and exit code are final. */
  readonly #onFinish: (job: Job) => void;

  constructor(options: { onFinish?: (job: Job) => void } = {}) {
    this.#onFinish = options.onFinish ?? (() => undefined);
  }

  list(): Job[] {
    return this.#order.map((id) => this.#jobs.get(id)!).filter(Boolean).reverse();
  }

  get(id: string): Job | undefined {
    return this.#jobs.get(id);
  }

  /** The running browser job, if any — what a refusal needs to name. */
  activeBrowserJob(): Job | undefined {
    return this.#browserJobId === null ? undefined : this.#jobs.get(this.#browserJobId);
  }

  /**
   * @param env Extra environment for this run only — the panel uses it to
   *   start a run on the API key someone picked (see `ui/keys.ts`). It is an
   *   overlay on `process.env`, never a replacement: a run has to inherit PATH
   *   and everything else the CLI needs.
   */
  start(spec: CommandSpec, argv: string[], env: Record<string, string> = {}): Job {
    if (spec.browser) {
      const active = this.activeBrowserJob();
      if (active && active.status === 'running') {
        throw new Error(
          `"${active.title}" is still running and also needs the browser. ` +
            'Two runs sharing one Chrome interleave their clicks, so stop that one first.',
        );
      }
    }

    const { file, prefix } = cliCommand();
    const id = `job-${this.#nextId++}`;
    const job: Job = {
      id,
      commandId: spec.id,
      title: spec.title,
      commandLine: formatCommandLine(argv),
      argv,
      // In memory only — see the field note. `Object.keys` of this never
      // reaches the API, and its values never reach a log.
      secretEnv: Object.keys(env).length > 0 ? { ...env } : undefined,
      browser: spec.browser,
      longRunning: spec.longRunning === true,
      status: 'running',
      exitCode: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      lines: [],
      artifacts: [],
      ended: null,
      progress: { done: 0, total: null, etaMs: null, percent: null, phase: null, rateMsPerStep: null, lastStepMs: 0, startedMs: null },
      cases: [],
    };
    this.#jobs.set(id, job);
    this.#order.push(id);
    if (spec.browser) this.#browserJobId = id;

    // What this process loaded from `.env` must not travel to the child: the
    // child runs in the same directory and reads the file itself, so passing
    // the panel's copy along would freeze every run on the values from panel
    // startup — a key corrected in `.env` would keep failing until the panel
    // was restarted, with nothing anywhere saying why. Values from the real
    // environment (PATH, a key exported in the shell) are inherited as ever,
    // and the explicit overlay — a key someone picked in the panel — still
    // wins over everything.
    const inherited: NodeJS.ProcessEnv = { ...process.env };
    for (const key of DOTENV_SOURCED) delete inherited[key];

    const child = spawn(file, [...prefix, ...argv], {
      cwd: process.cwd(),
      // No shell, and argv is an array: nothing here is parsed as a command.
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...inherited, NO_COLOR: '1', FORCE_COLOR: '0', ...env },
    });
    this.#processes.set(id, child);

    this.#pipe(job, child.stdout, 'out');
    this.#pipe(job, child.stderr, 'err');

    child.on('error', (error: Error) => {
      this.#append(job, 'err', `could not start wowlidator: ${error.message}`);
      this.#finish(job, 'error', null);
    });
    child.on('close', (code) => {
      // The CLI's exit-code contract: 0 passed, 1 a real failure, 2 usage,
      // 3 environment. The last two are not test results, so they are not
      // reported as one.
      // A paused suite ends "stopped" whatever its exit code says: the cases
      // that ran may all have passed, but the suite as approved did not run
      // to the end, and a green chip over a half-run list would be a lie the
      // resume banner then contradicts.
      const status: JobStatus = this.#paused.has(job.id)
        ? 'stopped'
        : code === 0
          ? 'passed'
          : code === 1
            ? 'failed'
            : job.status === 'stopped'
              ? 'stopped'
              : 'error';
      this.#paused.delete(job.id);
      this.#finish(job, status, code);
    });

    return job;
  }

  /** Jobs asked to pause: their eventual exit reports "stopped", never "passed". */
  #paused = new Set<string>();

  /**
   * Instant pause: SIGUSR2 makes the suite loop (`runCases`) write the
   * ledger's pause record and exit on the spot — interrupted cases keep no
   * verdict, and the resume banner picks the suite up from the ledger.
   * A resume is a fresh spawn of the same command plus `--resume`: it re-runs
   * each interrupted case from its own first step, keeps every finished
   * verdict, and runs on whatever the code says at resume time, not on the
   * paused process's image.
   */
  pause(id: string): boolean {
    const child = this.#processes.get(id);
    const job = this.#jobs.get(id);
    if (!child || !job || job.status !== 'running') return false;
    if (process.platform === 'win32') return false;
    this.#paused.add(id);
    this.#append(job, 'err', '— pausing instantly: in-flight cases are interrupted and keep no verdict; Continue testing re-runs them from their first step —');
    // Belt AND braces: the signal is instant when it lands, and the pause
    // file beside the progress ledger is what still works when it cannot —
    // the suite polls for `<claims>.progress.json.pause` before every case it
    // would start. (A run orphaned by a panel restart can be paused from a
    // terminal the same way: touch that file.)
    const at = job.argv.indexOf('--claims');
    const claims = at >= 0 ? job.argv[at + 1] : undefined;
    if (claims !== undefined) {
      // The ledger's real name strips the claims file's own `.json` first
      // (`be100.claims.json` → `be100.claims.progress.json` — see
      // `suite-progress.ts`). Appending to the full path wrote the pause
      // marker under a name no suite polls, so the file route silently did
      // nothing whenever the signal was absorbed by the tsx wrapper (live,
      // 2026-08-28: job-12 ran on for minutes after "pausing instantly").
      const ledger = resolvePath(claims).replace(/\.json$/i, '') + '.progress.json';
      void writeFile(`${ledger}.pause`, `pause requested ${new Date().toISOString()}\n`, 'utf8').catch(() => undefined);
    }
    child.kill('SIGUSR2');
    return true;
  }

  /** Ctrl-C, then a hard kill if it does not go. */
  stop(id: string): boolean {
    const child = this.#processes.get(id);
    const job = this.#jobs.get(id);
    if (!child || !job || job.status !== 'running') return false;
    job.status = 'stopped';
    this.#append(job, 'err', '— stopping —');
    child.kill('SIGINT');
    setTimeout(() => {
      if (this.#processes.has(id)) child.kill('SIGKILL');
    }, 4000).unref();
    return true;
  }

  subscribe(id: string, listener: (event: string, data: unknown) => void): () => void {
    let set = this.#subscribers.get(id);
    if (!set) {
      set = new Set();
      this.#subscribers.set(id, set);
    }
    set.add(listener);
    return () => set!.delete(listener);
  }

  #pipe(job: Job, stream: NodeJS.ReadableStream | null, kind: 'out' | 'err'): void {
    if (!stream) return;
    let pending = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      pending += chunk;
      const parts = pending.split('\n');
      pending = parts.pop() ?? '';
      for (const line of parts) this.#append(job, kind, line);
    });
    stream.on('end', () => {
      if (pending !== '') this.#append(job, kind, pending);
    });
  }

  #append(job: Job, stream: 'out' | 'err', text: string): void {
    const line: JobLine = { stream, text };
    job.lines.push(line);
    if (job.lines.length > MAX_LINES) job.lines.splice(0, job.lines.length - MAX_LINES);

    const elapsed = Date.now() - new Date(job.startedAt).getTime();

    // The roster comes before anything runs, so a reader sees the whole list
    // — including the cases still waiting — rather than watching rows appear.
    const roster = CASE_ROSTER.exec(text);
    if (roster) {
      const number = Number(roster[1]);
      if (!job.cases.some((c) => c.number === number)) {
        job.cases.push(emptyCase(number, roster[3]!.trim(), roster[2] === 'alone'));
        job.cases.sort((a, b) => a.number - b.number);
        this.#emit(job.id, 'cases', summariseCases(job.cases));
      }
      this.#emit(job.id, 'line', line);
      return;
    }

    // A tagged line belongs to one case and to no other. Everything about it
    // — its progress, its output pane, its verdict — is that case's.
    const tagged = CASE_TAG.exec(text);
    if (tagged) {
      const number = Number(tagged[1]);
      const body = text.slice(tagged[0].length);
      let entry = job.cases.find((c) => c.number === number);
      if (entry === undefined) {
        // A tag with no roster line in front of it: keep the output rather
        // than drop it, and let the case name arrive with its `started` line.
        entry = emptyCase(number, `case ${number}`, false);
        job.cases.push(entry);
        job.cases.sort((a, b) => a.number - b.number);
      }
      const caseLine: JobLine = { stream, text: body };
      entry.lines.push(caseLine);
      if (entry.lines.length > MAX_LINES) entry.lines.splice(0, entry.lines.length - MAX_LINES);

      const started = CASE_STARTED.exec(body);
      if (started) {
        entry.name = started[1]!;
        entry.status = 'running';
        // Anchor the case's own clock here: its pace and ETA measure from the
        // moment it was picked up, never from the job's start.
        entry.progress.startedMs ??= elapsed;
        entry.progress.lastStepMs = Math.max(entry.progress.lastStepMs, elapsed);
      }
      const ended = CASE_ENDED.exec(body);
      if (ended) {
        entry.name = ended[1]!;
        entry.status = ended[2] as JobCase['status'];
      }
      const reason = caseReasonOf(body);
      if (reason !== null) entry.reason = reason;
      applyProgressLine(entry.progress, body, elapsed);
      this.#emit(job.id, 'cases', summariseCases(job.cases));
      this.#emit(job.id, 'line', line);
      return;
    }

    if (applyProgressLine(job.progress, text, elapsed)) {
      this.#emit(job.id, 'progress', job.progress);
    }

    const match = ARTIFACT_LINE.exec(text);
    if (match) {
      const artifact = { kind: match[1]!, path: match[2]!.trim() };
      // The same report can be announced twice (once per attempt, say).
      if (!job.artifacts.some((a) => a.path === artifact.path)) {
        job.artifacts.push(artifact);
        this.#emit(job.id, 'artifact', artifact);
      }
    }
    this.#emit(job.id, 'line', line);
  }

  #finish(job: Job, status: JobStatus, code: number | null): void {
    if (job.finishedAt !== null) return;
    job.status = status;
    job.exitCode = code;
    job.finishedAt = new Date().toISOString();
    job.ended = endedOf(job, status, code);
    this.#processes.delete(job.id);
    if (this.#browserJobId === job.id) this.#browserJobId = null;
    this.#emit(job.id, 'done', { status, exitCode: code, finishedAt: job.finishedAt });
    this.#onFinish(job);
  }

  #emit(id: string, event: string, data: unknown): void {
    for (const listener of this.#subscribers.get(id) ?? []) listener(event, data);
  }
}

/**
 * tqdm's default smoothing factor, and tqdm (the Python progress library) is
 * the reference algorithm for the whole estimator below: an exponential moving
 * average of the per-step pace, seeded from the first observation —
 * `rate = smoothing * rate_instant + (1 - smoothing) * rate_prev`. A plain
 * average weighs the first step forever, so a run that healed three selectors
 * early carries that cost in its estimate to the end; the EMA follows the pace
 * the run has *now*, without the whiplash of trusting only the last step.
 */
const SMOOTHING = 0.3;

/**
 * Read one output line for progress. True when it changed anything.
 *
 * Pure, and separate from the runner, because this is the part with a rule in
 * it: everything else in `JobRunner` is process plumbing that can only be
 * tested by spawning something.
 *
 * The estimate is deliberately from *this* run's pace rather than from how long
 * this flow took last time. A historical average is confidently wrong the
 * moment anything differs — a slower machine, a cold cache, a page that now
 * heals three selectors — whereas the pace observed thirty seconds ago is
 * evidence about the run someone is actually watching. It also improves as the
 * run goes, which is what people expect of an estimate and what no constant can
 * do.
 */
/** Lines that say why a run stopped, most specific first. */
const CAUSE_LINE =
  /never ran: (.+)$|BLOCKED .+? — (.+)$|^(?:wowlidator[^:]*: )?(.*(?:Error|error:|refused|unavailable|circuit is open|could not attach|quota|budget).*)$/;

function endedOf(job: Job, status: JobStatus, code: number | null): NonNullable<Job['ended']> {
  const unfinished = job.cases.filter(
    (c) => c.status === 'waiting' || c.status === 'running' || c.status === 'blocked',
  );
  const resumable = job.commandId === 'catalog-run' && status !== 'passed' && unfinished.length > 0;
  let cause: string | null = null;
  if (status === 'stopped') cause = 'stopped from the panel';
  else if (code === null) cause = 'the process was killed before it could finish';
  else if (status !== 'passed') {
    // The reason most blocked cases share beats the last line: seventy
    // "never ran: <same cause>" lines are one cause, and the last line of a
    // run is usually the summary.
    const tally = new Map<string, number>();
    for (const line of job.lines) {
      const m = CAUSE_LINE.exec(line.text.replace(/^\[c\d+\]\s*/, ''));
      const reason = (m?.[1] ?? m?.[2] ?? m?.[3])?.trim();
      if (reason) tally.set(reason, (tally.get(reason) ?? 0) + 1);
    }
    const top = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
    cause = top ? `${top[0]}${top[1] > 1 ? ` (${top[1]} cases)` : ''}` : `exit code ${code}`;
  }
  if (cause !== null) cause = cause.slice(0, 300);
  return {
    cause,
    resumable,
    runtimeError: status === 'error' || (status === 'failed' && unfinished.length > 0),
    errors: job.cases.filter((c) => c.status === 'error').length,
    failed: job.cases.filter((c) => c.status === 'failed' || c.status === 'dead-end').length,
    unfinished: unfinished.length,
  };
}

/**
 * The cases without their output — what the stream and the polled list carry.
 * The lines are already going past on the same stream; sending them a second
 * time, in full, on every line, is how a progress feed becomes a bandwidth
 * problem.
 */
function summariseCases(cases: readonly JobCase[]): Record<string, unknown>[] {
  return cases.map(({ lines, ...entry }) => ({ ...entry, lineCount: lines.length }));
}

/** A case as it stands before its first line of output. */
function emptyCase(number: number, name: string, exclusive: boolean): JobCase {
  return {
    number,
    name,
    exclusive,
    status: 'waiting',
    reason: null,
    lines: [],
    progress: {
      done: 0,
      total: null,
      etaMs: null,
      percent: null,
      phase: null,
      rateMsPerStep: null,
      lastStepMs: 0,
      startedMs: null,
    },
  };
}

export function applyProgressLine(
  progress: JobProgress,
  text: string,
  elapsedMs: number,
): boolean {
  const plan = PLAN_LINE.exec(text);
  if (plan) {
    progress.total = Number(plan[1]);
    // Steps divide exactly. Once they are being counted the coarse phase share
    // is not just unnecessary, it is a second answer to the same question.
    progress.percent = null;
    progress.phase = null;
    return true;
  }

  if (progress.total === null) {
    for (const milestone of PHASE_LINES) {
      if (!milestone.pattern.test(text)) continue;
      // Never backwards. Output arrives in order, but a command that mentions an
      // earlier phase again (a second document, a retry) must not rewind a bar
      // someone is watching.
      if (progress.percent !== null && milestone.percent <= progress.percent) return false;
      progress.percent = milestone.percent;
      progress.phase = milestone.phase;
      return true;
    }
  }

  const step = STEP_LINE.exec(text);
  if (!step) return false;

  const done = Math.max(progress.done, Number(step[1]) + 1);
  if (done === progress.done) return false;

  // tqdm's rate_instant: the dt of the last completed unit. The first observed
  // line may cover several units (a run joined at step [3]), so the delta is
  // divided across them rather than read as one very slow step.
  const advanced = done - progress.done;
  const dtPerStep = Math.max(0, elapsedMs - progress.lastStepMs) / advanced;
  progress.rateMsPerStep = progress.rateMsPerStep === null
    ? dtPerStep // seeded from the first observation, as tqdm seeds its EMA
    : SMOOTHING * dtPerStep + (1 - SMOOTHING) * progress.rateMsPerStep;
  progress.lastStepMs = elapsedMs;
  progress.done = done;

  const total = progress.total;
  if (total !== null && done < total) {
    // ETA = remaining / rate, expressed as remaining × ms-per-step so a
    // zero-pace burst (two step lines in the same millisecond) rounds to an
    // honest 0 instead of dividing into Infinity. When the unit's own start
    // is known (a case's `started` line), the EMA is blended half-and-half
    // with the unit's overall average pace: steps here are heterogeneous — a
    // 5ms assert beside a 90s workflow leg — and a pure EMA whipsaws the
    // estimate on every fast step while the average alone drags the first
    // slow step to the end. The blend tracks both without trusting either.
    const anchored = progress.startedMs;
    const avg = anchored !== null && elapsedMs > anchored && done > 0 ? (elapsedMs - anchored) / done : null;
    const rate = avg === null ? progress.rateMsPerStep : (progress.rateMsPerStep + avg) / 2;
    progress.etaMs = Math.round(rate * (total - done));
  } else if (total !== null) {
    // Every planned step is accounted for; what remains is the report and the
    // disconnect, which this cannot time and must not pretend to.
    progress.etaMs = 0;
  }
  return true;
}

/**
 * tqdm's readout, verbatim: `3/10 [00:12<00:28, 4.0s/it]` — done over total,
 * elapsed `<` remaining, then the pace, flipping to `it/s` when the run is
 * faster than a step per second, exactly as tqdm prints it. Null whenever any
 * half is missing (no denominator, no completed step yet): a partial readout
 * in this format would read as a measurement that was never made.
 *
 * The page renders this next to the bar and cannot import it (the client is a
 * template string), so `tqdmReadout` in wow-ui-html.ts is a pinned mirror.
 */
export function formatProgressReadout(progress: JobProgress, elapsedMs: number): string | null {
  if (progress.total === null || progress.done === 0 || progress.rateMsPerStep === null) return null;
  const rate = progress.rateMsPerStep;
  const rateText = rate > 0 && rate < 1000
    ? (1000 / rate).toFixed(1) + 'it/s'
    : (rate / 1000).toFixed(1) + 's/it';
  const remaining = progress.etaMs === null ? '?' : clock(progress.etaMs);
  return progress.done + '/' + progress.total + ' [' + clock(elapsedMs) + '<' + remaining + ', ' + rateText + ']';
}

/** tqdm's clock: MM:SS under an hour, H:MM:SS over it. */
function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const pad = (n: number): string => String(n).padStart(2, '0');
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const base = pad(minutes) + ':' + pad(total % 60);
  return hours > 0 ? hours + ':' + base : base;
}
