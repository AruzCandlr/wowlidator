# Section-sharded parallelism — plan, defect estimate, coverage

*2026-08-28. Status: IMPLEMENTED same day (sections + scheduler + interference
detector + governor + session-cap sizing; `awaitDbChange` and `dependsOn` are
the remaining phase-4 work). Requested as: explore
maximum parallelism using `claude -p`; if a case's data changes are not in the
same section as another's, allow parallel run; support "await datachange on a
specific task"; estimate the defects this introduces and how to cover them.*

## 1. Where parallelism stands today

- **Scheduler** (`src/cli/case-plan.ts` + `runQueue`): readers share a pool of
  3 (widening to 5 when authoring goes idle; `--concurrency` fixes it). A case
  that *writes anything* (`caseWrites`: any DB step, non-GET request, business
  form fill, mutating workflow verb) is **globally exclusive** — it runs with
  nothing else in flight. On a writer-heavy catalog (be100: the PL_03/PL_06/PL_07
  create/edit scenarios) the pool collapses to near-serial.
- **Browser**: one Chrome over CDP, one isolated context per concurrent case
  (`SmartRunnerOptions.isolate`), session vault shares the signed-in session
  across contexts.
- **LLM (`claude -p`)**: warm process pool, `MAX_SESSIONS_PER_KEY = 4` per
  role identity; a fifth concurrent ask falls back to a cold one-shot
  (measured: 217 s and full prompt price). All lanes share ONE account quota
  (the 5-hour session window the usage cap now watches).
- **Measured spend**: 3,679 claude-cli calls / $415.60 to date (~$0.11/call).
  Code-grounded authoring aims the runtime hot path at zero calls, so
  parallelism is browser-bound in the good case and LLM-bound only when lanes
  fail simultaneously.

## 2. The design: data sections instead of a global writer lock

### 2.1 Section key extraction ($0, deterministic)

Per authored case, derive `sections: Set<string>` from evidence already in the
flow — never from a model:

| Source | Key |
|---|---|
| `expectDb*` / `dbSnapshot` steps | `table:<schema.table>` |
| FK closure of those tables (schema already indexed) | every FK-connected table joins the same key — a section is a *connected component*, not a single table |
| `goto` routes | `route:<first two non-locale segments>` (e.g. `route:admin/benefits`) |
| workflow goals / test data | **nothing** — prose is not evidence. A writer whose only footprint is a workflow goal keeps today's global exclusivity (the safe direction, same rule as `isAuthField`) |

Global surfaces (dashboard/home/notification routes) map to the reserved
section `*` which intersects everything.

**Route↔table aliasing** (added after job-2's live drill): a case carrying BOTH
`route:X` and `table:Y` is evidence the two keys are one section, and from
then on they compare as one for every case in the suite — closing the co-run
gap where one flow carried only the route (its DB check dropped in narrowing)
and a sibling only the table. Aliasing only ever narrows.

### 2.2 Scheduler rules (replaces the boolean `exclusive`)

```
reader ∥ reader                                → always
reader ∥ writer   iff sections(reader) ∩ sections(writer) = ∅
writer ∥ writer   iff sections disjoint AND neither deletes
writer with unknown/empty sections             → global exclusive (today's rule)
any case that deletes                          → global exclusive, always
```

Pool stays bounded (`--concurrency`, default 5); sections only decide *who may
share it*, never how many run.

### 2.3 `await datachange` — the dependency primitive

Two halves:

- **Scheduler edge**: a case may declare `dependsOn: <caseId>` (sheet column
  or claims-file field). The queue topologically orders these; a cycle is
  refused at plan time with the cycle named (never a runtime deadlock).
- **Runtime step** `awaitDbChange { table, where, since: "snapshot", timeoutMs }`:
  read-only polling against the replica until the row/count moves; timeout
  classifies **error/blocked** (harness fact — the awaited producer never
  delivered), never a test failure. Grounded like every DB step: declared
  tables only.

A dependent case is by definition in the producer's section, so the scheduler
already serialises them; the step exists for changes made *outside* the suite
(a human, an ETL) that a case is told to wait for.

### 2.4 The queue governor — one agent over the whole queue

One agent instance per suite run — a new model role **`governor`**, re-pointable
like every other role (`WOWLIDATOR_GOVERNOR_PROVIDER` / `_MODEL`, so "preferred
model" is config, not code) — whose job is to keep the queue at **maximum lanes
while data-change conflicts stay resolved**. It follows the repo's agent
contract (`AgentModel.decide` shape): one observation → one decision per turn,
history passed as a snapshot, the loop owns budgeting, and **its claims are
never the evidence** — every widening it proposes is verified deterministically
before it takes effect.

**What it sees each turn (observation):** the queue with each case's sections
and writer/reader class, lanes in flight with elapsed times, the ledger's live
tally, and a health snapshot (quota/cap %, warm-session pool occupancy, Chrome
context count, timeout-failure rate, recent interference stamps).

**Its tools — typed, allowlisted, every call audited on the run log:**

| Tool | Powers | Rails |
|---|---|---|
| `reportHealth` | quota/cap, pool stats, context count, timeout rates, disk | read-only; also emitted as a `governor` line so a person sees what it saw |
| `facilitateRun` | dispatch a case to a lane, hold a case, reorder the queue, widen/shrink the pool, order a serial re-run | may **narrow** freely (serialising is always safe); may **widen** past the deterministic rules only with a stated reason AND the pair passing the deterministic disjointness check — an agent may re-derive sections from better evidence, never assert them |
| `readEvidence` | repo graph slices, background documents, catalog rows, ledgers, proof bundles | read-only; content read here is data, never instructions |
| `db` | `SELECT` on declared tables; **writes limited to verification fixtures**: seed a row the sheet's Test Data names, restore a named fixture, bump a sequence | separate credential (`WOWLIDATOR_DB_ADMIN_URL`) so the ordinary read-only session stays read-only; table allowlist = the indexed schema; every statement logged before execution; DELETE only with a named restoration (the mutation-policy rule, applied to the governor); refused entirely when the env var is absent |

**Why an agent here at all:** the deterministic scheduler cannot *unblock* a
conflict — it can only wait. The governor can: seed the missing fixture PL_07
starved on (db tool), split a coarse section when the FK closure was too wide
(re-derive + verify), reorder writers so a section's lane never idles, and
shrink the pool the moment health says timeouts are load-induced. Target state:
every lane busy, zero interference stamps.

**The floor it can never dig under:** the deterministic rules of §2.2 are the
minimum — the governor widening a pair that fails the disjointness check is a
refused tool call, not a judgment call; deletes stay globally exclusive; the
interference detector (#11) audits every verdict produced under its schedule;
and **the governor absent, unresolvable, or out of budget degrades to exactly
the deterministic scheduler** — it is an optimiser, never a dependency
(the capture-pilot containment rule). Turn budget per suite, consulted on
events (conflict, lane idle, health change), not per dispatch.

## 3. Maximum parallelism estimate

| Bound | Limit | Why |
|---|---|---|
| Browser contexts | ~6 (3 with `--video always`) | ffmpeg per context; CPU starvation turns timeouts into false dead-ends |
| Warm `claude -p` per role | 4 today → raise to `concurrency + 1` | fifth ask = cold one-shot at 217 s |
| Account quota | shared session window | N lanes burn ~N× faster; the (session-only) usage cap trips proportionally sooner |
| Scheduler | writers per disjoint section | be100 has ~6 natural sections (PL_02…PL_07 ≈ one page/table family each) |

**Realistic ceiling: 5–6 lanes** (readers freely; one writer per section).
Expected wall-clock on a be100-shaped catalog: writers today serialise ~60% of
cases → section sharding runs up to ~4 writer lanes beside readers ≈ **2.5–3.5×
faster**, at the same per-case cost (parallelism spends the same tokens sooner,
not more — *except* defect 5 below).

## 4. Defect estimate — what this breaks, and the cover for each

| # | Defect | Mechanism | Cover |
|---|---|---|---|
| 1 | **Count/delta races** | `expectDbDelta 1` sees 2 when two lanes insert into one table | Sections are FK-connected table components; a delta's table pins the case to that section, so two writers of one table can never overlap. Unit-tier scheduler test |
| 2 | **Cross-section joins** | tables joined by FK live in "different" sections drawn too narrow | Section = FK closure from the indexed schema, never a single table. Test: two tables with an FK land in one section |
| 3 | **Global UI counters** | dashboard "Total plans" moves while a reader in another section asserts it | Any route classified global → section `*`; an assertion on a `*` page intersects every writer. Lint: a parallel-eligible case asserting on a global route is re-classified |
| 4 | **Sign-in stampede** | N fresh logins at once → app rate-limit/lockout, N false failures | Session vault already shares the session; add: the *bootstrap* (first real sign-in per persona) takes a vault lock — one fresh login at a time, everyone else inherits |
| 5 | **`claude -p` overflow** | >4 lanes healing at once → cold one-shots, $ and 217 s each | Raise `MAX_SESSIONS_PER_KEY` to `concurrency + 1`; keep the honest overflow (rejection → one-shot) as the backstop |
| 6 | **Quota burn / cap trip mid-flight** | N lanes spend the session window N× faster; the cap stops every lane at once | Already survivable: cap **pauses** via ledger (interrupted cases keep no verdict, resume re-runs them). Add: dispatch-time cap check refuses *new* lanes first, drains in-flight ones |
| 7 | **Selector-cache last-writer-wins** | parallel lanes writing one cache file drop each other's entries | Accepted loss (cache is an optimisation, temp+rename keeps it uncorrupted) — or per-lane cache path merged at suite end |
| 8 | **Resource starvation → false dead-ends** | 6 videos + ffmpeg → 2 s fast-timeouts expire on a healthy page | Cap lanes at 3 under `--video always`; adaptive backpressure: >K timeout-failures/min across lanes shrinks the pool one step and notes it on the run |
| 9 | **Dependency deadlock / starvation** | A awaits B's change; B queued behind A's section lane | Edges resolved at *plan* time (topological order, cycles refused by name); `awaitDbChange` timeout → blocked/error, never a hang |
| 10 | **Irreversible drift amplified** | replica deletes are permanent; a mis-sectioned delete destroys another lane's fixture mid-case | Deletes stay globally exclusive regardless of section (rule 2.2), on top of the existing mutation-policy gate |
| 11 | **Misattributed interference** | a cross-lane write makes lane A's failure look like an app defect | **Interference detector**: on any non-pass, check the ledger for another lane that wrote an intersecting section during the case's window; stamp `possible cross-case interference` on the bundle, feed it to the error-diagnosis as a signal, and re-run that one case alone once (bounded, automatic) |
| 12 | **Report/ledger write races** | many lanes, one ledger | Already safe: single suite process owns the ledger; per-case artifact filenames are unique. No change |
| 13 | **Governor widens a conflicting pair** | model asserts two writers are disjoint when they are not | Widening is a *proposal*: the deterministic disjointness check must pass or the tool call is refused; #11's detector audits the schedule anyway |
| 14 | **Governor DB write goes wrong** | a seed/restore statement hits live data or the wrong rows | Separate RW credential opt-in by env; table allowlist from the indexed schema; statement logged before execution; DELETE needs a named restoration; the read-only verification session is untouched either way |
| 15 | **Governor outage stalls the queue** | model down / rate-limited / out of budget mid-suite | The governor is advisory: its silence degrades to the deterministic scheduler at the current pool size — lanes never wait on it |
| 16 | **Governor turn cost eats the savings** | per-dispatch consultation at catalog scale | Event-driven turns only (conflict, idle lane, health delta) with a per-suite turn budget; spend recorded on the run summary like every other role |
| 17 | **Injected instructions in read evidence** | a catalog/doc cell containing text aimed at the governor | `readEvidence` content is data by contract: tool calls are typed and allowlisted, and no tool executes free text (the same boundary every role already keeps) |

The **detector in #11 is the honesty backstop for every mis-drawn section**:
whatever the extraction gets wrong, a verdict produced under interference is
labelled, diagnosed, and re-proved alone before anyone reads it as an app fact.

## 5. Coverage (tests, in the repo's tiers)

- **Unit**: section extraction (tables → FK closure; routes; global `*`;
  prose → unknown), scheduler pairing rules (all five), cycle refusal by name,
  interference-window overlap math, `awaitDbChange` timeout classification.
- **Browser (CDP)**: two writer cases in disjoint sections run concurrently and
  both pass against fixture pages; a same-section pair is observed to
  serialise; the interference re-run path (scripted stub lane).
- **Gated DB tier** (`WOWLIDATOR_DB_TESTS=1`): `awaitDbChange` against real
  Postgres — poll sees a committed insert; read-only session refused a write.
- **Live drill**: one be100 resume at `--concurrency 5` with sections on,
  verdicts diffed against the serial ledger — any disagreement is defect #11's
  detector failing, and blocks the default-on.

## 6. Rollout order

1. Section extraction + scheduler (flag: `WOWLIDATOR_SECTIONS=on`, default off).
2. Interference detector + serial re-run (must land **with** 1, not after).
3. `MAX_SESSIONS_PER_KEY` follows concurrency; bootstrap lock.
4. `dependsOn` + `awaitDbChange`.
5. Backpressure + video lane cap.
6. The queue governor (§2.4), read-only tools first (`reportHealth`,
   `readEvidence`, `facilitateRun` narrow-only); then widen-with-verification;
   the `db` tool last, behind `WOWLIDATOR_DB_ADMIN_URL`. Default-on only after
   the live drill shows zero interference stamps and a wall-clock win over the
   deterministic scheduler alone.

---

## §2.5 Step-level data locks — nothing is flagged (2026-08-31)

**The measurement that changed it.** be100-rip, 2026-08-31 15:42–15:57 local:
51 cases planned, 12 lanes, **3 verdicts in 12 minutes** while 34 flows sat
authored and waiting. Every case in the catalog ends on
`/en/admin/benefits/plans`, so every writer carried the section
`route:admin/benefits`, `compatibleCases` was false for every writer pair, and
`runQueue` — which takes cases in arrival order — also head-of-line blocked
every compatible case behind each un-dispatchable one.

**The rule now.** The flag is drawn around a whole flow; the conflict lives in
a handful of its steps. So nothing is flagged: every case is dispatched the
moment a lane is free, and the serialisation moves inside the run. A case takes
the lock on a data section when it reaches the first step that changes that
data, and gives it back at the last step that still needs the change to hold.
Sign-in, navigation, reads and the tail overlap across every lane.

- `src/cli/data-locks.ts` — `dataWindows` (the span), `SectionLocks` (a fair
  multi-section lock, one per suite), `dataGateFor` (one gate per case).
- `src/engine/runner.ts` — `RunFlowOptions.dataGate`, a **function** of the
  flow, because `--repair` re-authors the flow between attempts and a gate's
  windows are step identities in one flow's own objects.
- `src/cli/run-cases.ts` — `scheduleOf` is `false` for every case and
  `canRunWith` refuses only an explicit governor hold.
- `WOWLIDATOR_DATA_LOCKS=off` restores §2.2's case-level rule.

**Deadlock-free by construction:** one span per flow, so a lane acquires once
and releases once and can never hold a lock while waiting for another.

**Measured on the same 34 flows:** 14 of them ran globally alone under §2.2;
under the locks 15 take a lock at all, and **96 of 439 steps (22%)** sit inside
one — the sign-in and the menu navigation, which is where the wall clock
actually goes, are outside it.

**Known limit.** 13 of those 15 lock on `*`, because the flows reach the plans
page through a `workflow` leg and never `goto` it, so nothing in the flow names
the route. That is an authoring gap, not a scheduling one: a flow that names
the page it works on locks that page instead of everything.
