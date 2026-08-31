/**
 * How a suite's cases are scheduled: what may run beside what, and how many at
 * once.
 *
 * A catalog becomes a case per approved claim, and running them one after
 * another spends most of a run's wall clock waiting — six cases against one
 * application took 9.3 minutes on the run this was written for, of which the
 * machine was mostly idle holding a browser open. They are independent tests
 * by construction (`setup` re-runs before each one, which is the whole reason
 * `splitIntoCases` exists), so nothing about the *harness* requires them to be
 * sequential.
 *
 * The **application** can, though, and that is what `caseWrites` is for. Six
 * cases pointed at one database, one of them editing a rule while another
 * counts rows, produce failures that are artifacts of the scheduling rather
 * than facts about the app — and a suite that fails differently depending on
 * how fast the machine is teaches people to ignore it. So a case that changes
 * data runs alone, and only read-only cases share the pool.
 *
 * **The classification errs toward "writer", deliberately and in one
 * direction.** A reader wrongly called a writer costs time; a writer wrongly
 * called a reader costs a false verdict, and a false verdict is the thing this
 * codebase spends most of its design refusing to produce. Every ambiguous
 * shape below therefore resolves to `true`.
 */

import type { Flow, FlowStep } from '../engine/runner.js';
import { goalMentionsSignIn, looksLikeSignIn } from '../orchestrator/goal-evidence.js';
import type { AgentRecord } from '../engine/proof-bundle.js';
import { scriptOf } from '../orchestrator/workflow-agent.js';

/** Actions that put something into the page and can therefore submit it. */
const FORM_ACTIONS = new Set([
  'fill',
  'type',
  'selectOption',
  'check',
  'uncheck',
  'fillEach',
  'fillRetry',
]);

/** Every database action. Its presence means the case is about stored state. */
const DB_ACTIONS = new Set([
  'dbSnapshot',
  'expectDbRow',
  'expectDbDelta',
  'expectDbUnchanged',
  'expectDbCalled',
  'expectDbCount',
]);

const READ_ONLY_VERBS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** What a business write is called in a workflow goal. Word-bounded. */
const WRITE_VERB =
  /\b(creat(e|es|ing)|add(s|ing)?|edit(s|ing)?|updat(e|es|ing)|sav(e|es|ing)|submit(s|ted|ting)?|approv(e|es|ing)|reject(s|ing)?|delet(e|es|ing)|remov(e|es|ing)|extend(s|ing)?|decid(e|es|ing)|set(s|ting)? (the )?(status|value|amount|date)|chang(e|es|ing)|fill(s|ing)? (in|out)?|enter(s|ing)? (a|the|an) |typ(e|es|ing) (in|into)|select(s|ing)? (the )?(option|outcome|card)|upload(s|ing)?|send(s|ing)?|assign(s|ing)?|escalat(e|es|ing)|cancel(s|ling|ing)?|confirm(s|ing)?|mark(s|ing)? (as|it)|resolv(e|es|ing)|withdraw(s|ing)?|revok(e|es|ing)|grant(s|ing)?|pass(es|ing)? (the )?probation|fail(s|ing)? (the )?probation)\b/i;

/**
 * Does this fill belong to signing in rather than to the case's own subject?
 *
 * Decided by **where the page is**, never by what the field is called. The
 * first cut of this read the selector for `email|password|username` and called
 * any match authentication — which quietly classified "Manager email" on a
 * business form as a login and let that case run beside others. A name is a
 * guess; the URL is an observation, and the taught idiom for an unlabelled
 * password field (`role=textbox >> nth=N`) carries no name to read anyway.
 *
 * The cost is one false writer: a flow that starts on the sign-in page without
 * navigating to it first has no `goto` to read, so its fills count as writes
 * and the case runs alone. That is the safe direction — it spends time, not
 * correctness.
 */
function isAuthField(_step: FlowStep, afterSignInGoto: boolean): boolean {
  return afterSignInGoto;
}

/**
 * Does this case change anything the next case could see?
 *
 * Signing in is **not** a write for this purpose. It creates a session, and a
 * session is per-context — every run gets its own (see `SmartRunner.connect`).
 * Counting it would make every case in every catalog a writer, since a catalog
 * case that reaches any protected page has to log in first, and the whole
 * feature would collapse back to running one at a time while claiming not to.
 */
export function caseWrites(flow: Flow): boolean {
  let afterSignInGoto = false;

  // A `when` carries steps of its own, and an authored `clickIfVisible` is
  // one; whatever a branch may do, the case may do.
  const flatten = (list: readonly FlowStep[]): FlowStep[] =>
    list.flatMap((step) =>
      step.action === 'when'
        ? [step, ...flatten(step.then), ...flatten(step.else ?? [])]
        : [step],
    );
  const steps = flatten([...(flow.setup ?? []), ...flow.steps, ...(flow.teardown ?? [])]);

  for (const step of steps) {
    const action = step.action;

    if (action === 'goto') {
      afterSignInGoto = looksLikeSignIn((step as { url: string }).url);
      continue;
    }

    // A declared HTTP call says its own intent in its verb. An unstated verb
    // is a GET by the same default the runner uses.
    if (action === 'request') {
      const method = ((step as { method?: string }).method ?? 'GET').toUpperCase();
      if (!READ_ONLY_VERBS.has(method)) return true;
      continue;
    }

    // A case that asserts about the database is a case about stored state, and
    // the row it counts is exactly what a concurrent writer would move.
    if (DB_ACTIONS.has(action)) return true;

    // The agent can click anything its goal implies, so a workflow leg is
    // judged by what its goal asks for. Measured on a real catalog: five of six
    // cases were serialised because their goals said "navigate via Sidebar ->
    // Team -> Probation Reviews" — reads, every one, and the whole point of
    // running cases together was lost to a rule that called any goal without
    // the words "sign in" a write. A goal is a write when it names a mutating
    // verb; a goal that only signs in, navigates, opens, locates or reads is
    // not. This is the one place the classification leans toward "reader" on
    // a heuristic, and it is bounded: the verbs below are what a business
    // write is called in a test request, and an agent given a goal without one
    // has been asked to change nothing.
    if (action === 'workflow') {
      const goal = (step as { goal: string }).goal;
      if (goalMentionsSignIn(goal) && !WRITE_VERB.test(goal)) continue;
      if (WRITE_VERB.test(goal)) return true;
      continue;
    }

    if (FORM_ACTIONS.has(action) && !isAuthField(step, afterSignInGoto)) return true;
  }

  return false;
}

/** What the scheduler decided about one case, for the plan it prints. */
export interface CaseSchedule {
  index: number;
  name: string;
  /** True when this case must run with nothing else in flight. */
  exclusive: boolean;
}

export function planCases(cases: readonly { name: string; flow: Flow }[]): CaseSchedule[] {
  return cases.map((testCase, index) => ({
    index,
    name: testCase.name,
    exclusive: caseWrites(testCase.flow),
  }));
}

/**
 * Readers before writers, each side keeping its own order.
 *
 * A read-assertion is authored against the application state that existed at
 * authoring time, and a suite that mutates that state mid-run invalidates its
 * own remaining reads. Measured (be100 recheck, 2026-08-24): 40 of 65
 * no-verdict cases were read-assertions dead-ending on counts and rows the
 * suite's OWN create/delete cases had already moved — `text="75"` cannot
 * resolve on a page whose total the previous case changed to 76. Running
 * every reader before the first writer lets the reads see the state they
 * were written against; the writers still run alone afterwards, unchanged.
 * `--sheet-order` restores the list's own order for a suite where the
 * sequence itself is the test.
 */
export function readersFirst<T extends { flow: Flow }>(cases: readonly T[]): readonly T[] {
  const readers = cases.filter((c) => !caseWrites(c.flow));
  if (readers.length === 0 || readers.length === cases.length) return cases;
  return [...readers, ...cases.filter((c) => caseWrites(c.flow))];
}

export const DEFAULT_CONCURRENCY = 8;

/**
 * A pipelined catalog's pool sizes, when no `--concurrency` was stated.
 *
 * While rows are still being authored, the run pool is held at 3: the model
 * and the browser are already sharing the machine and the LLM key, and five
 * cases beside three authoring calls is how a free-tier key spends its minute
 * on retries. The moment the queue closes — authoring is done, the model is
 * idle — the pool widens to 5. An explicit `--concurrency` wins over both,
 * fixed for the whole run, exactly as before.
 */
export const PIPELINED_CONCURRENCY_WHILE_AUTHORING = 3;
export const PIPELINED_CONCURRENCY_AFTER_AUTHORING = 5;

/** How many catalog rows are authored at once — see `--author-concurrency`. */
export const DEFAULT_AUTHOR_CONCURRENCY = 3;

/**
 * Providers that serve one request at a time, whatever the client sends.
 *
 * A model on this machine (mlx_lm.server) prefills one prompt at a time
 * (`--prompt-concurrency 1` — two authoring-sized prefills in parallel is an
 * OOM on 16 GB) and batches at most two decodes. Measured 2026-08-21 on the
 * live server: three concurrent calls took 5.7 s / 6.2 s / 9.4 s against
 * 4.0 s alone — every caller waits for the others, and with three 10k-token
 * authoring prompts in flight the third sits behind two full prefills, which
 * is where the "unusable object" timeouts came from. Parallel authoring buys
 * nothing here and costs the failures, so it is not the default.
 */
import { SERIAL_PROVIDERS } from '../config.js';
export { SERIAL_PROVIDERS };

/**
 * Fastest scenario first (2026-08-28).
 *
 * A catalog's scenarios run in sheet order, and the ScenarioGate holds
 * authoring to the scenario the runner is in — so a slow scenario at the top
 * of the sheet delays every verdict behind it. Nothing orders the sheet by
 * cost: PL_01 goes first because someone typed it first. Queuing the fastest
 * scenario first gets the most verdicts on screen soonest and fails fast on
 * cheap scenarios before the expensive ones spend their budget.
 *
 * Cost is ESTIMATED, and only the ordering matters, never the number:
 *  - A row this catalog has run before is priced at its recorded wall clock
 *    (the prior progress ledger's proof bundles — `caseDurationMs`).
 *  - A row never run is priced statically from the sheet itself: its Steps
 *    lines (each step is browser work), half-weighted Expected lines (each
 *    is an assertion), plus a writer penalty — a case that creates or
 *    deletes runs ALONE under the scheduler, so it serializes the pool and
 *    costs more than its lines say.
 * Rows keep their sheet order inside a scenario; scenarios tie-break to
 * sheet order, so the result is deterministic for identical inputs.
 */
export interface SpeedOrderRow {
  caseId: string;
  scenarioId: string;
  testCase?: string;
  steps?: string;
  expected?: string;
}

/** A static unit ≈ one browser step. Only relative cost matters. */
const SPEED_UNIT_MS = 6_000;
const SPEED_WRITE_VERB =
  /\b(create|insert|delete|remove|update|edit|submit|approve|reject|save)\b|สร้าง|เพิ่ม|ลบ|แก้ไข|บันทึก|อนุมัติ/i;

export function estimateRowUnits(row: SpeedOrderRow): number {
  const lines = (text: string | undefined): number =>
    (text ?? '').split('\n').filter((line) => line.trim() !== '').length;
  const units = Math.max(1, lines(row.steps)) + 0.5 * lines(row.expected);
  const writes = SPEED_WRITE_VERB.test(`${row.testCase ?? ''}\n${row.steps ?? ''}`);
  return units + (writes ? 3 : 0);
}

/**
 * Reorder scenario BLOCKS by ascending estimated cost. `priorMs` maps a
 * caseId to a recorded duration from an earlier run of this same catalog —
 * measured beats estimated wherever it exists. Pure and total: rows of one
 * scenario stay contiguous and in their given order, every row survives.
 */
export function orderScenariosFastestFirst<T extends SpeedOrderRow>(
  rows: readonly T[],
  priorMs: ReadonlyMap<string, number> = new Map(),
): { rows: T[]; order: { scenario: string; estimateMs: number; rows: number }[] } {
  const blocks = new Map<string, T[]>();
  const sheetOrder: string[] = [];
  for (const row of rows) {
    const key = row.scenarioId || 'ungrouped';
    if (!blocks.has(key)) {
      blocks.set(key, []);
      sheetOrder.push(key);
    }
    blocks.get(key)!.push(row);
  }
  const costOf = (block: readonly T[]): number =>
    block.reduce(
      (sum, row) => sum + (priorMs.get(row.caseId) ?? SPEED_UNIT_MS * estimateRowUnits(row)),
      0,
    );
  const order = sheetOrder
    .map((scenario, at) => ({ scenario, at, estimateMs: Math.round(costOf(blocks.get(scenario)!)) }))
    .sort((a, b) => a.estimateMs - b.estimateMs || a.at - b.at);
  return {
    rows: order.flatMap((entry) => blocks.get(entry.scenario)!),
    order: order.map(({ scenario, estimateMs }) => ({
      scenario,
      estimateMs,
      rows: blocks.get(scenario)!.length,
    })),
  };
}

/**
 * How many rows to author at once: what was asked for, else the default —
 * unless the generator role sits on a provider that answers one call at a
 * time, where the only honest default is 1. An explicit `--author-concurrency`
 * always wins: the person may be running a server configured otherwise.
 */
export function authorWorkers(
  requested: number | undefined,
  generatorProvider: string,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (requested !== undefined) return Math.max(1, requested);
  // The Machinery dial (`WOWLIDATOR_AUTHOR_CONCURRENCY`) sets the default;
  // an explicit --author-concurrency still wins, and a serial provider still
  // forces 1 unless the person overrode it by flag — a dial must not talk a
  // one-lane server into three concurrent calls.
  const dial = Number((env['WOWLIDATOR_AUTHOR_CONCURRENCY'] ?? '').trim());
  if (SERIAL_PROVIDERS.has(generatorProvider)) return 1;
  if (Number.isInteger(dial) && dial >= 1 && dial <= 12) return dial;
  return DEFAULT_AUTHOR_CONCURRENCY;
}

/**
 * Work through `items` with `workers` pulling from a shared cursor.
 *
 * Each worker is handed its own `slot` (0..workers-1) and the index of the
 * item it took, so a caller can give every worker a resource of its own — an
 * authoring tab, say — and still know which item a result belongs to. Items
 * start in order; a worker that finishes early takes the next one, so a slow
 * item delays only itself. A rejection from `work` aborts the whole pool once
 * the other workers' current items are done, and is rethrown.
 */
export async function mapPool<T>(
  items: readonly T[],
  workers: number,
  work: (item: T, index: number, slot: number) => Promise<void>,
  /** Consulted before each item: true stops DISPATCH while started items finish — the pause contract. */
  shouldStop?: () => boolean,
): Promise<void> {
  const count = Math.max(1, Math.min(Math.floor(workers), items.length));
  let cursor = 0;
  const worker = async (slot: number): Promise<void> => {
    for (;;) {
      if (shouldStop?.()) return;
      const index = cursor;
      if (index >= items.length) return;
      cursor += 1;
      await work(items[index]!, index, slot);
    }
  };
  await Promise.all(Array.from({ length: count }, (_, slot) => worker(slot)));
}

/**
 * A list of cases that is still being written to while it is being run.
 *
 * A catalog authors one case per row, one model call each, and used to hand
 * the whole list over only when the last row was done — so the browser sat
 * idle through twelve authoring calls and the model sat idle through twelve
 * runs. The queue is the seam between the two: `cmdCatalog` pushes a case the
 * moment its flow file is written, and `runQueue` starts it as soon as a slot
 * is free. Items are indexed by **arrival**, which for a catalog is sheet
 * order, so outcomes still read as the list someone approved.
 *
 * `close()` says no more will come; `runQueue` returns only after that and
 * after every item has finished. A queue that is never closed never drains —
 * the producer owns that call, and owns it in a `finally`.
 */
export class CaseQueue<T> {
  readonly #items: T[] = [];
  #closed = false;
  #wake: (() => void) | null = null;

  /** Add an item; returns its index in arrival order. */
  push(item: T): number {
    if (this.#closed) throw new Error('CaseQueue: push after close');
    this.#items.push(item);
    this.#signal();
    return this.#items.length - 1;
  }

  close(): void {
    this.#closed = true;
    this.#signal();
  }

  get closed(): boolean {
    return this.#closed;
  }

  get length(): number {
    return this.#items.length;
  }

  /** Everything pushed so far, in arrival order. */
  get items(): readonly T[] {
    return this.#items;
  }

  /**
   * The item at `index`, waiting for it to arrive; `null` once the queue is
   * closed and no item will ever have that index.
   */
  async take(index: number): Promise<T | null> {
    while (index >= this.#items.length) {
      if (this.#closed) return null;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
    return this.#items[index]!;
  }

  #signal(): void {
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }
}

/**
 * Run a queue's items with at most `concurrency` in flight, and an exclusive
 * item alone — the same rules as `runWithConcurrency`, over a list that may
 * still be growing. Items start in arrival order; an exclusive one waits for
 * the pool to drain, runs by itself, and only then does the pool refill.
 *
 * `run` is never allowed to reject (see `runWithConcurrency`).
 */
export async function runQueue<T>(
  queue: CaseQueue<T>,
  /**
   * A number is the fixed pool size it always was. A function is re-read
   * before every dispatch, so a pool can widen mid-run — the pipelined
   * catalog grows from 3 to 5 the moment authoring finishes. Only growth is
   * meaningful: cases already in flight are never revoked by a shrink.
   */
  concurrency: number | (() => number),
  isExclusive: (item: T, index: number) => boolean,
  run: (item: T, index: number) => Promise<void>,
  /**
   * Consulted before each dispatch: `true` stops TAKING new cases while the
   * ones in flight finish normally. This is what makes Pause graceful — a
   * case never stops mid-step, so every started case ends with a verdict and
   * a resume begins at exactly the first case that never started. Un-taken
   * items simply never earn an outcome, which is precisely what the suite
   * ledger's `remaining()` reads as "still to run".
   */
  shouldPause?: () => boolean,
  /**
   * Section-aware sharing (docs/parallel-run-spec.md §2.2). Consulted for a
   * NON-exclusive item against everything currently in flight: false holds
   * the dispatch until a lane finishes and the answer is asked again. Absent
   * = the old rule (any two non-exclusive items share).
   */
  canRunWith?: (item: T, index: number, inflight: readonly { item: T; index: number }[]) => boolean,
  /**
   * A soft hold: while true, nothing new is dispatched but in-flight lanes
   * finish normally and the loop resumes when it clears. What the
   * interference re-run and the governor's `hold` use — unlike `shouldPause`,
   * which ends the loop for good.
   */
  waitWhile?: () => boolean,
): Promise<void> {
  const limitOf =
    typeof concurrency === 'function'
      ? (): number => Math.max(1, Math.floor(concurrency()))
      : (): number => Math.max(1, Math.floor(concurrency));
  const inFlight = new Set<Promise<void>>();
  const inFlightItems = new Map<Promise<void>, { item: T; index: number }>();

  const start = (item: T, index: number): void => {
    const promise = run(item, index).finally(() => {
      inFlight.delete(promise);
      inFlightItems.delete(promise);
    });
    inFlight.add(promise);
    inFlightItems.set(promise, { item, index });
  };

  const drainOne = async (): Promise<void> => {
    if (inFlight.size > 0) await Promise.race([...inFlight]);
    // A held loop with an empty pool must not spin hot.
    else await new Promise((resolve) => setTimeout(resolve, 200));
  };

  for (let index = 0; ; index += 1) {
    if (shouldPause?.()) break;
    const item = await queue.take(index);
    if (item === null) break;
    // Checked again AFTER the take: a streaming queue can hold the loop in
    // take() for minutes while a row authors, and a pause raised in that gap
    // must not start the case that finally arrives. The un-run item simply
    // earns no outcome, which is exactly what a resume reads as still-to-run.
    if (shouldPause?.()) break;
    while (waitWhile?.() === true) {
      if (shouldPause?.()) break;
      await drainOne();
    }
    if (shouldPause?.()) break;
    if (isExclusive(item, index) || limitOf() === 1) {
      if (inFlight.size > 0) await Promise.all([...inFlight]);
      while (waitWhile?.() === true && !shouldPause?.()) await drainOne();
      if (shouldPause?.()) break;
      await run(item, index);
      continue;
    }
    // Re-read after every completion, not once: the limit may have grown
    // while this dispatch waited for a slot — and the section check is asked
    // again too, because the conflicting lane may be the one that finished.
    for (;;) {
      if (inFlight.size >= limitOf()) {
        await Promise.race([...inFlight]);
        continue;
      }
      if (canRunWith !== undefined && !canRunWith(item, index, [...inFlightItems.values()])) {
        if (shouldPause?.()) break;
        await drainOne();
        continue;
      }
      break;
    }
    if (shouldPause?.()) break;
    start(item, index);
  }

  await Promise.all([...inFlight]);
}

/**
 * Run `items` with at most `concurrency` in flight, and an exclusive item
 * alone.
 *
 * Items are *started* in order, which is what keeps the plan a reader can
 * follow; they finish in whatever order they finish. An exclusive item waits
 * for everything already running to drain, runs by itself, and only then does
 * the pool refill — so "runs alone" means alone, not merely one-of-four.
 *
 * `run` is never allowed to reject: a case that throws is the caller's to
 * record (see `runCases`, where it becomes a blocked outcome), and a rejection
 * escaping here would abandon the runs still in flight.
 *
 * A closed `CaseQueue` run through `runQueue`: one scheduler, two ways to
 * hand it the list.
 */
export async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  isExclusive: (item: T, index: number) => boolean,
  run: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const queue = new CaseQueue<T>();
  for (const item of items) queue.push(item);
  queue.close();
  await runQueue(queue, concurrency, isExclusive, run);
}

/**
 * Keeps authoring from running ahead of the runs it feeds.
 *
 * A pipelined catalog used to author every row as fast as the pool allowed —
 * PL_05 and PL_06 flows were being written while the runner was still inside
 * PL_03, and every one of those early flows was authored against a page state
 * (and a database state) the intervening scenarios would change. The gate
 * holds authoring to the scenario the runner is actually in: a row of
 * scenario S may be authored only when every scenario before S is **cleared**
 * — all of its rows authored (or refused) and every case it queued finished
 * running. Authoring scenario 3 while scenario 3's cases run is allowed;
 * scenario 4 waits until scenario 3 is done. `lookahead` widens that by N
 * scenarios; `Infinity` restores the old eager behaviour.
 *
 * Deadlock-free by construction: clearing needs only facts that arrive
 * without the gate's help (authoring of *allowed* scenarios, runs the queue
 * consumer drains on its own), and a refused row counts as authored so a
 * scenario that authors nothing still clears. `waitFor` also wakes on a
 * poll so a pause raised while every counter is quiet still releases the
 * waiting workers — the same contract as `mapPool`'s `shouldStop`.
 */
export class ScenarioGate {
  readonly #order: string[] = [];
  readonly #rows = new Map<string, number>();
  readonly #authored = new Map<string, number>();
  readonly #queued = new Map<string, number>();
  readonly #ran = new Map<string, number>();
  readonly #lookahead: number;
  readonly #pollMs: number;
  #waiters: (() => void)[] = [];

  constructor(rowScenarios: readonly string[], options: { lookahead?: number; pollMs?: number } = {}) {
    this.#lookahead = Math.max(0, options.lookahead ?? 0);
    this.#pollMs = Math.max(1, options.pollMs ?? 250);
    for (const scenario of rowScenarios) {
      if (!this.#rows.has(scenario)) {
        this.#order.push(scenario);
        this.#rows.set(scenario, 0);
      }
      this.#rows.set(scenario, this.#rows.get(scenario)! + 1);
    }
  }

  /** May a row of this scenario be authored right now? */
  allowed(scenario: string): boolean {
    const at = this.#order.indexOf(scenario);
    // A scenario the plan never named is never held: the gate bounds the
    // plan it was built from, not rows it has no facts about.
    if (at === -1) return true;
    if (!Number.isFinite(this.#lookahead)) return true;
    for (let i = 0; i < at - this.#lookahead; i += 1) {
      if (!this.#cleared(this.#order[i]!)) return false;
    }
    return true;
  }

  /** Resolves when the scenario is allowed, or `shouldStop` says to give up. */
  async waitFor(scenario: string, shouldStop?: () => boolean): Promise<void> {
    while (!this.allowed(scenario) && !shouldStop?.()) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, this.#pollMs);
        function done(): void {
          clearTimeout(timer);
          resolve();
        }
        this.#waiters.push(done);
      });
    }
  }

  /** A row finished authoring — written, or refused; both advance the plan. */
  authored(scenario: string): void {
    this.#bump(this.#authored, scenario);
  }

  /** A case of this scenario was pushed to the run queue. */
  queued(scenario: string): void {
    this.#bump(this.#queued, scenario);
  }

  /** A queued case finished running (whatever its verdict). */
  ran(scenario: string): void {
    this.#bump(this.#ran, scenario);
  }

  #cleared(scenario: string): boolean {
    const rows = this.#rows.get(scenario) ?? 0;
    return (
      (this.#authored.get(scenario) ?? 0) >= rows &&
      (this.#ran.get(scenario) ?? 0) >= (this.#queued.get(scenario) ?? 0)
    );
  }

  #bump(counter: Map<string, number>, scenario: string): void {
    counter.set(scenario, (counter.get(scenario) ?? 0) + 1);
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const wake of waiters) wake();
  }
}

/**
 * Fold the agent's successful journeys back into the flow as deterministic
 * scripts, so the next run of this flow replays them at $0 — the flow-file
 * half of what `AgentMemory` already does in the healed-selector cache. Only
 * a `workflow` step whose agent leg **succeeded** earns a script, matched by
 * its goal's exact wording; a step that already carries the same script is
 * left alone. Returns the rewritten flow, or `null` when nothing changed —
 * the caller then has nothing to write.
 */
export function withWorkflowScripts(
  flow: Flow,
  records: readonly AgentRecord[],
): Flow | null {
  const byGoal = new Map<string, AgentRecord>();
  for (const record of records) {
    if (record.success) byGoal.set(record.goal, record);
  }
  if (byGoal.size === 0) return null;

  let changed = false;
  const rewrite = (steps: readonly FlowStep[] | undefined): FlowStep[] | undefined => {
    if (steps === undefined) return undefined;
    return steps.map((step) => {
      if (step.action === 'when') {
        const then = rewrite(step.then) ?? [];
        const otherwise = rewrite(step.else);
        return { ...step, then, ...(otherwise === undefined ? {} : { else: otherwise }) };
      }
      if (step.action !== 'workflow') return step;
      const record = byGoal.get(step.goal);
      if (record === undefined) return step;
      const script = scriptOf(record.actions);
      if (script.length === 0) return step;
      if (JSON.stringify(step.script ?? null) === JSON.stringify(script)) return step;
      changed = true;
      return { ...step, script };
    });
  };

  const setup = rewrite(flow.setup);
  const steps = rewrite(flow.steps) ?? [];
  const teardown = rewrite(flow.teardown);
  if (!changed) return null;
  return {
    ...flow,
    ...(setup === undefined ? {} : { setup }),
    steps,
    ...(teardown === undefined ? {} : { teardown }),
  };
}
