/**
 * Runs that ended without a proof.
 *
 * wowUI's history is built from proof bundles, which is right for every run
 * that got as far as asserting something. It is wrong for the run that never
 * did: a catalog refused because the application was down, a flow that could
 * not attach to Chrome, a job someone stopped. Those produced no bundle, so
 * they vanished from history the moment the live row disappeared — and once
 * the panel restarted, from everywhere. The person who launched it at 11:19
 * and came back at 11:30 saw nothing at all.
 *
 * This keeps them. One JSONL line per job that finished in any state other
 * than `passed` **and announced no proof, report or suite** — if a bundle
 * exists the bundle is the record, and listing the job beside it would show
 * one failure twice. The entry is the job's own account: its command line,
 * exit code and the last lines it printed, because "cannot reach
 * http://localhost:3000 — is the app running?" is the whole diagnosis and
 * must survive the process that printed it.
 *
 * Append-only, temp-file-free: a line is small and a torn trailing line is
 * skipped on read, the same tolerance `RunHistory` shows its own file.
 */

import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';

import type { Job, JobArtifact } from './jobs.js';

export const FAILED_RUNS_FILE = 'failed-runs.jsonl';

/** How many of the job's final lines are kept as its reason. */
export const REASON_LINES = 12;

/** An artifact kind whose presence means a bundle (and so history) exists. */
const PROOF_KINDS: ReadonlySet<string> = new Set(['proof', 'report', 'suite', 'index']);

export interface FailedRun {
  id: string;
  title: string;
  commandId: string;
  commandLine: string;
  status: 'failed' | 'error' | 'stopped';
  exitCode: number | null;
  startedAt: string;
  finishedAt: string;
  /** The last non-empty lines the command printed, oldest first. */
  reason: string[];
  artifacts: JobArtifact[];
}

/** Did this job end without leaving a proof behind? */
export function leftNoProof(job: Job): boolean {
  if (job.status === 'running' || job.status === 'passed') return false;
  return !job.artifacts.some((a) => PROOF_KINDS.has(a.kind));
}

export function toFailedRun(job: Job): FailedRun | null {
  if (!leftNoProof(job) || job.finishedAt === null) return null;
  const reason = job.lines
    .map((line) => line.text.replace(/\s+$/, ''))
    .filter((text) => text.trim() !== '')
    .slice(-REASON_LINES);
  return {
    id: job.id,
    title: job.title,
    commandId: job.commandId,
    commandLine: job.commandLine,
    status: job.status as FailedRun['status'],
    exitCode: job.exitCode,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    reason,
    artifacts: job.artifacts,
  };
}

export class FailedRunLog {
  readonly #file: string;
  #queue: Promise<void> = Promise.resolve();

  constructor(file: string) {
    this.#file = file;
  }

  /** Records the job if it qualifies; a no-op otherwise. Never throws. */
  record(job: Job): Promise<void> {
    const entry = toFailedRun(job);
    if (!entry) return Promise.resolve();
    // A panel restart reuses `job-1`, `job-2`…; the start time keeps ids apart.
    const stamped = { ...entry, id: `${entry.startedAt}#${entry.id}` };
    this.#queue = this.#queue
      .then(async () => {
        await mkdir(dirname(this.#file), { recursive: true });
        await appendFile(this.#file, `${JSON.stringify(stamped)}\n`, 'utf8');
      })
      .catch((error: unknown) => {
        process.stderr.write(`wowlidator ui: could not record failed run: ${String(error)}\n`);
      });
    return this.#queue;
  }

  /** Newest first. A corrupt line is skipped, never fatal. */
  async list(): Promise<FailedRun[]> {
    const raw = await readFile(this.#file, 'utf8').catch(() => '');
    const entries: FailedRun[] = [];
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const parsed = JSON.parse(line) as FailedRun;
        if (typeof parsed.id === 'string' && typeof parsed.title === 'string') entries.push(parsed);
      } catch {
        // torn trailing line
      }
    }
    return entries.reverse();
  }

  async clear(): Promise<void> {
    await this.#queue;
    await writeFile(this.#file, '', 'utf8').catch(() => undefined);
  }
}
