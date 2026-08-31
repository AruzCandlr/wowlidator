/**
 * The queue governor — one agent instance per suite run, governing parallel
 * queuing (docs/parallel-run-spec.md §2.4, 2026-08-28).
 *
 * Its job: keep the lanes at maximum while data-change conflicts stay
 * resolved. It follows the repo's agent contract — one compact observation,
 * one structured decision per turn, its claims never the evidence — and it is
 * an OPTIMISER, never a dependency: absent, disabled, erroring or out of
 * budget, the deterministic scheduler runs exactly as it would alone.
 *
 * Cost discipline is the design, because the role may be pointed at an
 * expensive model (claude-cli opus):
 * - **event-driven turns, never per-dispatch**: a turn happens when a case
 *   ends without passing, when the queue is blocked with a free lane, or at
 *   suite start — not on every case;
 * - **a hard per-suite turn budget** (`WOWLIDATOR_GOVERNOR_TURNS`, default 12);
 * - **a compact observation** (bounded lines, no documents, no trees) and a
 *   small structured answer (`maxOutputTokens` 300).
 *
 * Tools, typed and allowlisted — free text never executes:
 * - the observation IS `reportHealth` (quota/cap, pool, timeout rate ride in);
 * - `hold` / `release` / `pool` / `rerun-alone` are `facilitateRun` — narrow
 *   freely; the pool may widen only to the caller-stated ceiling;
 * - `db-read` is a SELECT on a declared table via the read-only client;
 * - `db-write` (INSERT/UPDATE only, one statement, declared tables, no
 *   DELETE) exists to seed a verification fixture a case is starved on — and
 *   only when the operator supplied `WOWLIDATOR_DB_ADMIN_URL`; without it the
 *   tool refuses by name. Every statement is logged before it runs.
 */

import { z } from 'zod';

import { LlmFactory, generateStructuredForModel, type ModelSource } from '../providers/llm-factory.js';
import { DETERMINISM_RULES, procedure } from '../providers/prompt-discipline.js';
import { lenientObject } from '../providers/model-output.js';

export const DEFAULT_GOVERNOR_TURNS = 12;

/** `WOWLIDATOR_GOVERNOR=off` disables the governor; the scheduler runs alone. */
export function governorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return governorMode(env) !== 'off';
}

/**
 * Which governor runs (2026-08-31, asked for after every model turn in two
 * live suites concluded `idle` with a diagnosis a pure function over the same
 * observation could have computed):
 *
 * - `rules` (the default): `RuleGovernorModel` below — deterministic, $0,
 *   instant, and honest about its limits: it diagnoses, resizes and notes,
 *   and it never writes to a database.
 * - `model`: the LLM governor (`WOWLIDATOR_GOVERNOR=model`) — the one thing
 *   it can do that rules cannot is judge WHAT fixture a starved case needs
 *   and seed it (`db-write`).
 * - `off`: no governor at all.
 */
export type GovernorMode = 'off' | 'model' | 'rules';

export function governorMode(env: NodeJS.ProcessEnv = process.env): GovernorMode {
  const raw = (env['WOWLIDATOR_GOVERNOR'] ?? '').trim().toLowerCase();
  if (raw === 'off' || raw === '0' || raw === 'false' || raw === 'no') return 'off';
  if (raw === 'model' || raw === 'llm' || raw === 'agent') return 'model';
  return 'rules';
}

export function governorTurnBudget(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number((env['WOWLIDATOR_GOVERNOR_TURNS'] ?? '').trim());
  return Number.isFinite(raw) && raw >= 1 && raw <= 100 ? Math.floor(raw) : DEFAULT_GOVERNOR_TURNS;
}

/** A case as the RULES governor reads it — structured, not prose. */
export interface GovernorCaseFact {
  name: string;
  writes: boolean;
  sections: readonly string[];
  /** Lanes: ms in flight. Ended cases: the reason line, '' when passed. */
  detail?: string | undefined;
}

export interface GovernorObservation {
  /** Why this turn is happening — the event, in one word. */
  event: 'suite-start' | 'case-ended' | 'queue-blocked';
  /**
   * The same queue/lanes as structured facts, for the rules governor. The
   * prose lines above them stay the model's food; parsing our own display
   * strings back would be the brittle version of this field.
   */
  pendingFacts?: readonly GovernorCaseFact[] | undefined;
  flyingFacts?: readonly GovernorCaseFact[] | undefined;
  /** Non-pass reasons of recently ended cases, newest last. */
  recentFailures?: readonly string[] | undefined;
  /** One line per pending case: `PL_03_07 [writer table:x route:y] waiting`. */
  queue: readonly string[];
  /** One line per lane in flight: `PL_04_02 [reader] 42s`. */
  lanes: readonly string[];
  /** `passed 12 · failed 3 · error 1 · left 40`. */
  tally: string;
  /** Health facts: cap %, warm-pool occupancy, timeout failures in the last 5 min, interference stamps. */
  health: readonly string[];
  /** The pool ceiling the governor may widen to, and the current size. */
  pool: { current: number; max: number };
}

export type GovernorAction =
  | { kind: 'idle'; reason: string }
  | { kind: 'hold'; caseId: string; reason: string }
  | { kind: 'release'; caseId: string; reason: string }
  | { kind: 'pool'; size: number; reason: string }
  | { kind: 'rerun-alone'; caseId: string; reason: string }
  | { kind: 'db-read'; sql: string; reason: string }
  | { kind: 'db-write'; sql: string; reason: string }
  | { kind: 'note'; reason: string };

export interface GovernorModel {
  readonly id: string;
  decide(observation: GovernorObservation, lastToolResult: string | null): Promise<GovernorAction>;
}

/* ------------------------------------------------------------- validation */

/** One statement, INSERT or UPDATE, on a declared table. The reason each rule exists is in the spec's defect #14. */
export function validateGovernorWrite(
  sql: string,
  declaredTables: readonly string[],
): { ok: true; table: string } | { ok: false; reason: string } {
  const trimmed = sql.trim().replace(/;\s*$/, '');
  if (trimmed === '') return { ok: false, reason: 'empty statement' };
  if (trimmed.includes(';')) return { ok: false, reason: 'one statement only — a second after ";" is refused' };
  const verb = /^(insert|update)\b/i.exec(trimmed);
  if (verb === null) {
    return {
      ok: false,
      reason: 'only INSERT or UPDATE — DELETE and DDL are refused outright (deletes on the replica are permanent)',
    };
  }
  const table =
    /^insert\s+into\s+([a-z0-9_."]+)/i.exec(trimmed)?.[1] ?? /^update\s+(?:only\s+)?([a-z0-9_."]+)/i.exec(trimmed)?.[1];
  if (table === undefined) return { ok: false, reason: 'could not read the target table' };
  const clean = table.replace(/"/g, '').toLowerCase();
  const declared = declaredTables.map((t) => t.toLowerCase());
  if (!declared.includes(clean) && !declared.some((t) => t.endsWith(`.${clean}`) || clean.endsWith(`.${t}`))) {
    return { ok: false, reason: `table "${clean}" is not in the indexed schema — only declared tables may be touched` };
  }
  return { ok: true, table: clean };
}

/** SELECT-only gate for db-read, same shape. */
export function validateGovernorRead(sql: string): { ok: true } | { ok: false; reason: string } {
  const trimmed = sql.trim().replace(/;\s*$/, '');
  if (!/^select\b/i.test(trimmed)) return { ok: false, reason: 'db-read takes a single SELECT' };
  if (trimmed.includes(';')) return { ok: false, reason: 'one statement only' };
  return { ok: true };
}

/* ------------------------------------------------------------- the model */

const ActionSchema = lenientObject({
  kind: z.enum(['idle', 'hold', 'release', 'pool', 'rerun-alone', 'db-read', 'db-write', 'note']),
  caseId: z.string().describe('For hold/release/rerun-alone: the case id. Empty otherwise.'),
  size: z.number().describe('For pool: the new size. 0 otherwise.'),
  sql: z.string().describe('For db-read (one SELECT) / db-write (one INSERT or UPDATE on a declared table). Empty otherwise.'),
  reason: z.string().describe('One sentence citing the observation line that justifies this.'),
});

const SYSTEM_PROMPT = `You govern the parallel queue of a UI test suite. Your one goal: every lane busy,
zero data conflicts. You get one compact observation per event and answer ONE action.

You may only NARROW on your own authority (hold a case, shrink the pool, order a serial
re-run). Widening runs through deterministic verification you do not control — propose it
and the scheduler checks it. The deterministic section rules are the floor, not a suggestion.

Actions:
- idle          nothing worth doing — the cheapest correct answer, prefer it.
- hold/release  keep a named case out of dispatch / let it back in.
- pool          resize the lane count (never above the stated max).
- rerun-alone   a finished case whose verdict may be interference — run it once with nothing else in flight.
- db-read       one SELECT on a declared table, to check a fixture a case needs.
- db-write      one INSERT or UPDATE seeding a verification fixture a case is starved on. No DELETE, ever.
- note          say something a person should read (a mis-drawn section, a health concern).

${DETERMINISM_RULES}

${procedure('HOW TO DECIDE', [
  'Read the health lines first: cap nearing or timeout failures rising means shrink, not widen.',
  'A blocked queue with a free lane means either a real conflict (leave it — the scheduler is right) or a starved fixture (db-read to confirm, db-write to seed).',
  'A case that failed while a writer overlapped its sections is rerun-alone.',
  'When nothing is wrong, answer idle. Turns are budgeted; spend them on conflicts, not commentary.',
])}`;

export interface LlmGovernorModelOptions {
  model?: unknown;
  id?: string | undefined;
  factory?: LlmFactory | undefined;
  maxRetries?: number | undefined;
}

export class LlmGovernorModel implements GovernorModel {
  readonly #source: ModelSource;
  readonly #explicitId: string | undefined;
  readonly #maxRetries: number;

  constructor(options: LlmGovernorModelOptions = {}) {
    if (options.model) {
      this.#source = { model: options.model as never };
      this.#explicitId = options.id ?? 'custom:governor';
      this.#maxRetries = options.maxRetries ?? 1;
    } else {
      const factory = options.factory ?? new LlmFactory();
      this.#source = { factory, role: 'governor' };
      this.#explicitId = options.id;
      this.#maxRetries = options.maxRetries ?? factory.maxRetries;
    }
  }

  get id(): string {
    if (this.#explicitId !== undefined) return this.#explicitId;
    return 'factory' in this.#source ? this.#source.factory.forRole('governor').id : 'custom:governor';
  }

  async decide(observation: GovernorObservation, lastToolResult: string | null): Promise<GovernorAction> {
    const lines = [
      `EVENT: ${observation.event}`,
      `TALLY: ${observation.tally}`,
      `POOL: ${observation.pool.current} of max ${observation.pool.max}`,
      'LANES IN FLIGHT:',
      ...(observation.lanes.length ? observation.lanes.map((l) => `- ${l}`) : ['- none']),
      'WAITING:',
      ...(observation.queue.length ? observation.queue.slice(0, 20).map((q) => `- ${q}`) : ['- none']),
      'HEALTH:',
      ...observation.health.map((h) => `- ${h}`),
      ...(lastToolResult === null ? [] : ['LAST TOOL RESULT:', lastToolResult.slice(0, 500)]),
    ];
    const { object } = await generateStructuredForModel(this.#source, {
      modelLabel: this.id,
      schema: ActionSchema,
      system: SYSTEM_PROMPT,
      prompt: lines.join('\n'),
      maxOutputTokens: 300,
      maxRetries: this.#maxRetries,
      task: 'governor',
    });
    const reason = object.reason.trim() || 'no reason given';
    switch (object.kind) {
      case 'hold':
      case 'release':
      case 'rerun-alone':
        return { kind: object.kind, caseId: object.caseId.trim(), reason };
      case 'pool':
        return { kind: 'pool', size: Math.floor(object.size), reason };
      case 'db-read':
      case 'db-write':
        return { kind: object.kind, sql: object.sql.trim(), reason };
      case 'note':
        return { kind: 'note', reason };
      default:
        return { kind: 'idle', reason };
    }
  }
}

/* ------------------------------------------------------------- the loop */

export interface GovernorHooks {
  /** Hold/release a pending case by id prefix. Returns whether anything matched. */
  hold(caseId: string): boolean;
  release(caseId: string): boolean;
  /** Resize the pool, clamped by the loop to [1, max]. Returns the applied size. */
  resizePool(size: number): number;
  /** Mark a finished case for one serial re-run. Returns whether the id matched. */
  rerunAlone(caseId: string): boolean;
  /** One SELECT via the read-only client; formatted result or the refusal. */
  dbRead(sql: string): Promise<string>;
  /** One validated INSERT/UPDATE via the admin client; result or the refusal. */
  dbWrite(sql: string): Promise<string>;
}

/**
 * The event-driven loop: consult the model, apply ONE action through the
 * typed hooks, log everything. Never throws — a governor fault is one logged
 * line and the deterministic scheduler carries on (the capture-pilot
 * containment rule).
 */
export class QueueGovernor {
  readonly #model: GovernorModel;
  readonly #hooks: GovernorHooks;
  readonly #log: (line: string) => void;
  #budget: number;
  #lastToolResult: string | null = null;

  constructor(options: {
    model: GovernorModel;
    hooks: GovernorHooks;
    budget?: number | undefined;
    log?: ((line: string) => void) | undefined;
  }) {
    this.#model = options.model;
    this.#hooks = options.hooks;
    this.#budget = options.budget ?? governorTurnBudget();
    this.#log = options.log ?? ((): void => undefined);
  }

  get turnsLeft(): number {
    return this.#budget;
  }

  /** One event → at most one model turn → at most one applied action. */
  async onEvent(observation: GovernorObservation): Promise<void> {
    if (this.#budget <= 0) return;
    this.#budget -= 1;
    let action: GovernorAction;
    try {
      action = await this.#model.decide(observation, this.#lastToolResult);
    } catch (error) {
      const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
      this.#log(`governor: turn skipped (${message}) — the deterministic scheduler carries on`);
      return;
    }
    this.#lastToolResult = null;
    try {
      await this.#apply(action, observation);
    } catch (error) {
      const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
      this.#log(`governor: ${action.kind} failed (${message}) — nothing was changed`);
    }
  }

  async #apply(action: GovernorAction, observation: GovernorObservation): Promise<void> {
    const say = (line: string): void => this.#log(`governor: ${line} — ${action.reason}`);
    switch (action.kind) {
      case 'idle':
        this.#log(`governor: idle — ${action.reason}`);
        return;
      case 'note':
        this.#log(`governor note: ${action.reason}`);
        return;
      case 'hold':
        say(this.#hooks.hold(action.caseId) ? `holding ${action.caseId}` : `hold: no pending case matches "${action.caseId}"`);
        return;
      case 'release':
        say(this.#hooks.release(action.caseId) ? `released ${action.caseId}` : `release: nothing held matches "${action.caseId}"`);
        return;
      case 'pool': {
        const clamped = Math.max(1, Math.min(observation.pool.max, action.size));
        const applied = this.#hooks.resizePool(clamped);
        say(`pool → ${applied}${clamped !== action.size ? ` (asked ${action.size}, clamped)` : ''}`);
        return;
      }
      case 'rerun-alone':
        say(this.#hooks.rerunAlone(action.caseId) ? `queued serial re-run of ${action.caseId}` : `rerun-alone: no finished case matches "${action.caseId}"`);
        return;
      case 'db-read': {
        this.#log(`governor db-read: ${action.sql} — ${action.reason}`);
        this.#lastToolResult = await this.#hooks.dbRead(action.sql);
        this.#log(`governor db-read result: ${this.#lastToolResult.slice(0, 200)}`);
        return;
      }
      case 'db-write': {
        // Logged BEFORE execution — the audit must exist even if the write hangs.
        this.#log(`governor db-write (audited): ${action.sql} — ${action.reason}`);
        this.#lastToolResult = await this.#hooks.dbWrite(action.sql);
        this.#log(`governor db-write result: ${this.#lastToolResult.slice(0, 200)}`);
        return;
      }
    }
  }
}

/* ------------------------------------------------- the deterministic governor */

/**
 * The rules governor — the same `GovernorModel` seam, no model behind it.
 *
 * Asked for 2026-08-31 after watching the LLM governor in two live suites:
 * every turn concluded `idle`, each time explaining a fact the scheduler had
 * already computed ("waiting cases are all writers on the same route — a real
 * conflict, not starvation"). That diagnosis is a set intersection over data
 * we built; paying a model to restate it was the waste. What stays with the
 * model (`WOWLIDATOR_GOVERNOR=model`): judging WHAT a starved case needs
 * seeded and writing it — synthesising SQL is exactly the part rules should
 * not do.
 *
 * Three rules, each stated with its reason:
 * 1. **queue-blocked** → say WHY, once per distinct blockage: every waiting
 *    case conflicts with a lane = "correctly serialising, not starving"; a
 *    compatible case waiting = name it (that is a scheduler bug worth a
 *    person's eye).
 * 2. **repeated timeout failures** → shrink the pool one step (never below
 *    2): N lanes producing timeout-shaped failures is load, and less
 *    parallelism that passes beats more that flakes (spec defect #8).
 * 3. Everything else → idle, silently (no budget, no log spam).
 */
export class RuleGovernorModel implements GovernorModel {
  readonly id = 'rules:governor';
  #saidKeys = new Set<string>();
  #timeoutFailures: number[] = [];
  #now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  async decide(observation: GovernorObservation): Promise<GovernorAction> {
    // Rule 2 first — health outranks commentary.
    if (observation.event === 'case-ended') {
      const last = observation.recentFailures?.[observation.recentFailures.length - 1] ?? '';
      if (/timeout|timed out|Timeout \d+ms exceeded/i.test(last)) {
        const now = this.#now();
        this.#timeoutFailures = this.#timeoutFailures.filter((t) => now - t < 5 * 60_000);
        this.#timeoutFailures.push(now);
        if (this.#timeoutFailures.length >= 3 && observation.pool.current > 2) {
          this.#timeoutFailures = [];
          return {
            kind: 'pool',
            size: observation.pool.current - 1,
            reason: `3 timeout-shaped failures inside 5 minutes across ${observation.pool.current} lanes — load, not the application; one lane fewer`,
          };
        }
      }
    }
    if (observation.event === 'queue-blocked') {
      const flying = observation.flyingFacts ?? [];
      const pending = observation.pendingFacts ?? [];
      const conflicts = (c: GovernorCaseFact): boolean =>
        flying.some((f) => {
          const a = { writes: c.writes, sections: c.sections, deletes: false };
          const b = { writes: f.writes, sections: f.sections, deletes: false };
          if (!a.writes && !b.writes) return false;
          const set = new Set(a.sections);
          return a.sections.length === 0 || b.sections.length === 0 || set.has('*') || b.sections.includes('*') || b.sections.some((x) => set.has(x));
        });
      const compatible = pending.filter((c) => !conflicts(c));
      if (pending.length > 0 && compatible.length === 0) {
        const key = `serialising:${[...new Set(flying.flatMap((f) => f.sections))].sort().join(',')}`;
        if (this.#saidKeys.has(key)) return { kind: 'idle', reason: 'still the same real conflict' };
        this.#saidKeys.add(key);
        return {
          kind: 'note',
          reason: `queue is correctly serialising a real data conflict — every waiting case intersects the in-flight sections (${[...new Set(flying.flatMap((f) => f.sections))].join(' ') || 'unknown'}); not starvation`,
        };
      }
      if (compatible.length > 0) {
        const key = `stuck:${compatible[0]!.name}`;
        if (!this.#saidKeys.has(key)) {
          this.#saidKeys.add(key);
          return {
            kind: 'note',
            reason: `"${compatible[0]!.name}" looks compatible with every lane yet has not dispatched — worth a look at the scheduler or a hold`,
          };
        }
      }
    }
    return { kind: 'idle', reason: 'nothing to change' };
  }
}
