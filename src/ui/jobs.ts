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

export interface Job {
  id: string;
  commandId: string;
  title: string;
  commandLine: string;
  argv: string[];
  browser: boolean;
  longRunning: boolean;
  status: JobStatus;
  exitCode: number | null;
  startedAt: string;
  finishedAt: string | null;
  lines: JobLine[];
  artifacts: JobArtifact[];
  progress: JobProgress;
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
export function cliCommand(): { file: string; prefix: string[] } {
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
      browser: spec.browser,
      longRunning: spec.longRunning === true,
      status: 'running',
      exitCode: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      lines: [],
      artifacts: [],
      progress: { done: 0, total: null, etaMs: null, percent: null, phase: null, rateMsPerStep: null, lastStepMs: 0 },
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
      const status: JobStatus =
        code === 0 ? 'passed' : code === 1 ? 'failed' : job.status === 'stopped' ? 'stopped' : 'error';
      this.#finish(job, status, code);
    });

    return job;
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
    this.#processes.delete(job.id);
    if (this.#browserJobId === job.id) this.#browserJobId = null;
    this.#emit(job.id, 'done', { status, exitCode: code, finishedAt: job.finishedAt });
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
    // honest 0 instead of dividing into Infinity.
    progress.etaMs = Math.round(progress.rateMsPerStep * (total - done));
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
