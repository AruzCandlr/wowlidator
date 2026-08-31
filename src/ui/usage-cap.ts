/**
 * The panel's half of the usage cap (`providers/usage-cap.ts` holds the rule).
 *
 * Every quota TTL the guard reads the account's windows and, when one is at
 * or past the cap, **stops every running job and holds new ones** until a
 * person resets it from the Models & keys page. The hold survives a panel
 * restart (`.wowlidator/usage-cap.json`): a cap a restart could clear is a
 * cap that only works while nobody is looking. A reset does not change the
 * settings — with the window still past the cap the next tick trips again
 * at once, which is the point: the way out is to raise the cap, turn it off,
 * or wait for the reset time, all of which are stated in the popup.
 *
 * What it can and cannot stop, said plainly: jobs THIS panel spawned are
 * killed here; a run started from a terminal is not visible to the panel
 * and is refused at its next claude-cli call by `assertUnderUsageCap`
 * instead. Non-claude providers are untouched — the cap is about the
 * signed-in session's windows, which they do not spend.
 */

import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { DOTENV_SOURCED } from '../config.js';
import { fetchClaudeQuota, quotaTtlMs, type ClaudeQuotaSnapshot } from '../providers/claude-quota.js';
import {
  USAGE_CAP_ENV,
  USAGE_CAP_PERCENT_ENV,
  describeTrip,
  evaluateUsageCap,
  parseCapPercent,
  usageCapSettings,
  type UsageCapVerdict,
} from '../providers/usage-cap.js';
import { ClaudeSettingsError, upsertEnv } from './claude-settings.js';

/** What the guard needs from the job runner — structural, so a test can stub it. */
export interface StoppableJobs {
  list(): { id: string; title: string; status: string }[];
  stop(id: string): boolean;
}

export interface UsageCapTrip {
  at: string;
  /** `session 92% ≥ cap 90%`. */
  reason: string;
  window: string;
  percent: number;
  capPercent: number;
  resetsAt: string | null;
  /** Titles of the jobs this panel stopped when it tripped. */
  stoppedJobs: string[];
}

export interface UsageCapView {
  enabled: boolean;
  capPercent: number;
  maxPercent: number;
  worst: { label: string; percent: number; resetsAt: string | null } | null;
  nearing: boolean;
  /** Present while the panel is holding: new jobs are refused until reset. */
  tripped: UsageCapTrip | null;
  note: string;
  checkedAt: string | null;
  envVars: { enabled: string; percent: string };
}

export function usageCapStatePath(cwd = process.cwd()): string {
  return join(cwd, '.wowlidator', 'usage-cap.json');
}

export class UsageCapGuard {
  readonly #jobs: StoppableJobs;
  readonly #statePath: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #quota: (env: NodeJS.ProcessEnv) => Promise<ClaudeQuotaSnapshot>;
  #trip: UsageCapTrip | null = null;
  #last: UsageCapVerdict | null = null;
  #checkedAt: string | null = null;
  #timer: NodeJS.Timeout | null = null;

  constructor(
    jobs: StoppableJobs,
    options: {
      statePath?: string;
      env?: NodeJS.ProcessEnv;
      /** Test seam: answer quota questions without a credential or a network. */
      quota?: (env: NodeJS.ProcessEnv) => Promise<ClaudeQuotaSnapshot>;
    } = {},
  ) {
    this.#jobs = jobs;
    this.#statePath = options.statePath ?? usageCapStatePath();
    this.#env = options.env ?? process.env;
    this.#quota = options.quota ?? fetchClaudeQuota;
  }

  /** Reload a hold left by an earlier panel process. Missing file = no hold. */
  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.#statePath, 'utf8')) as UsageCapTrip;
      if (typeof parsed?.at === 'string' && typeof parsed.reason === 'string') this.#trip = parsed;
    } catch {
      this.#trip = null;
    }
  }

  /** New jobs are refused while this is true. */
  get held(): boolean {
    return this.#trip !== null;
  }

  /** The refusal a job start gets under the hold. */
  holdMessage(): string {
    const t = this.#trip;
    return t === null
      ? ''
      : `usage cap reached (${t.reason}) — every run was stopped at ${t.at}; reset the cap on the Models & keys page` +
          (t.resetsAt ? `, or wait for the window to reset at ${t.resetsAt}` : '');
  }

  /**
   * One check. Trips at most once per hold — a held guard does not re-stop
   * (there is nothing running to stop), it just keeps holding.
   */
  async tick(): Promise<UsageCapView> {
    const settings = usageCapSettings(this.#env);
    let verdict: UsageCapVerdict;
    try {
      verdict = evaluateUsageCap(await this.#quota(this.#env), settings);
    } catch (error) {
      verdict = evaluateUsageCap(
        { limits: [], note: error instanceof Error ? error.message : String(error), fetchedAt: new Date().toISOString() },
        settings,
      );
    }
    this.#last = verdict;
    this.#checkedAt = new Date().toISOString();
    if (verdict.tripped && this.#trip === null) await this.#trip_(verdict);
    return this.describe();
  }

  async #trip_(verdict: UsageCapVerdict): Promise<void> {
    const stopped: string[] = [];
    for (const job of this.#jobs.list()) {
      if (job.status === 'running' && this.#jobs.stop(job.id)) stopped.push(job.title);
    }
    this.#trip = {
      at: new Date().toISOString(),
      reason: describeTrip(verdict),
      window: verdict.worst?.label ?? '',
      percent: verdict.maxPercent,
      capPercent: verdict.capPercent,
      resetsAt: verdict.worst?.resetsAt ?? null,
      stoppedJobs: stopped,
    };
    process.stderr.write(
      `[wowlidator] USAGE CAP REACHED — ${this.#trip.reason}; stopped ${stopped.length} job(s); new runs are held until reset\n`,
    );
    try {
      await mkdir(dirname(this.#statePath), { recursive: true });
      await writeFile(this.#statePath, `${JSON.stringify(this.#trip, null, 2)}\n`, 'utf8');
    } catch {
      // The hold still stands in memory; only its survival across a restart is lost.
    }
  }

  /** Lift the hold. Settings unchanged — a still-exceeded window trips again next tick. */
  async reset(): Promise<UsageCapView> {
    this.#trip = null;
    await unlink(this.#statePath).catch(() => undefined);
    return this.tick();
  }

  describe(): UsageCapView {
    const settings = usageCapSettings(this.#env);
    const v = this.#last;
    return {
      enabled: settings.enabled,
      capPercent: settings.capPercent,
      maxPercent: v?.maxPercent ?? 0,
      worst: v?.worst ? { label: v.worst.label, percent: v.worst.percent, resetsAt: v.worst.resetsAt } : null,
      nearing: v?.nearing ?? false,
      tripped: this.#trip,
      note: v?.note ?? '',
      checkedAt: this.#checkedAt,
      envVars: { enabled: USAGE_CAP_ENV, percent: USAGE_CAP_PERCENT_ENV },
    };
  }

  /** Poll on the quota's own TTL. `unref` so the guard never holds the process open. */
  start(): void {
    if (this.#timer !== null) return;
    void this.tick().catch(() => undefined);
    this.#timer = setInterval(() => void this.tick().catch(() => undefined), quotaTtlMs(this.#env));
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }
}

/**
 * Save the cap to `.env` and this process's environment — the same two
 * places `persistClaudeRunScript` writes, for the same reason: a spawned run
 * must read the cap the panel shows, and so must a `wow` typed in a terminal.
 */
export async function persistUsageCap(
  edit: { enabled?: boolean | undefined; capPercent?: unknown },
  envPath = '.env',
): Promise<void> {
  const assignments: [string, string | null][] = [];
  if (edit.enabled !== undefined) assignments.push([USAGE_CAP_ENV, edit.enabled ? 'on' : 'off']);
  if (edit.capPercent !== undefined) {
    let pct: number;
    try {
      pct = parseCapPercent(edit.capPercent);
    } catch (error) {
      throw new ClaudeSettingsError(error instanceof Error ? error.message : String(error));
    }
    assignments.push([USAGE_CAP_PERCENT_ENV, String(pct)]);
  }
  if (assignments.length === 0) return;
  await upsertEnv(assignments, envPath);
  for (const [key, value] of assignments) {
    if (value === null) delete process.env[key];
    else process.env[key] = value;
    DOTENV_SOURCED.add(key);
  }
}
