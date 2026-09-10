# CLAUDE.md — the workflow agent's evidence rules

Split out of the root CLAUDE.md (2026-08-24) so this loads only when working under
`src/orchestrator/`. Same authority as the root file; the root keeps the map of the whole system.

## What the agent claims is never the evidence (`src/orchestrator/goal-evidence.ts`)

The rule was already stated for the ladder's agent rung and enforced there structurally — the agent prepares the page, then the *author's own selector* is retried. The `workflow` action did not have it: `SmartRunner.workflow()` read `record.success` and stopped. Live (PB_03_01, 2026-08-19): the agent signed in successfully at turn 5, spent turns 6–8 re-filling a password field it could not read back, reported "gave up after 8 turns", the step was recorded failed with a `high` defect — and the very next step passed in 14ms **from the destination the goal named**. Thirty-seven seconds and a reconstruction call to file a defect against an app that had done what it was asked.

Four rules now, all deterministic, all in the leaf module (leaf because `runner` imports `workflow-agent`, so a shared predicate cannot live in either):

- **Arriving is finishing.** `destinationReached()` — the goal names a path (`goalDestination()`: the *last* URL or path in the goal, since a goal ends where it arrives; a bare `/` is never a destination) and the page has just reached it, having not been on it when the step began. The agent loop breaks there and spends nothing more; the WORKFLOW GOALS contract in the author prompt asks every page-changing goal to end with its destination path for exactly this reason. Only this rule is consulted mid-flight.
- **The page is asked before the agent's account stands.** `goalEvidence()` after the run: the destination rule, or — *only when the goal names no destination* — a sign-in goal that left the sign-in page and did **not** land on an interstitial (`looksLikeInterstitial`: consent, PDPA, terms, MFA). Every rule requires an observed *transition*, so none can be satisfied by an agent that did nothing; and the destination rule is **exclusive**, because the one genuine non-completion in the measured run was an agent stranded on `/en/consent` short of its named destination, which the weaker rule would have called success. A step judged on evidence still files a `low` usability finding: the goal was met, the agent under-reported it, and every run will pay the turns again until the goal is tightened.
- **A provider failure is not an application failure.** `agentModelUnavailable()` reads the record's summary; "agent model failed: … circuit is open" files **no defect** — six of eleven non-passing workflow steps in the measured run were the structured-output breaker, each filed as a `high` functional defect against an app the agent never clicked. Same rule the healer follows for `HealUnavailableError`.
- **Running out of turns is `medium`, worded as a harness limit.** `high` is for a goal the agent actively determined it could not reach.

## The flow-file script rung (2026-08-24)

A successful agent journey is persisted twice now: in the healed-selector cache
(`AgentMemory`, as before) and **on the flow file itself** — `runCases` folds
`scriptOf(record.actions)` back into the `workflow` step as `script`
(`withWorkflowScripts` in `src/cli/case-plan.ts`). `WorkflowAgent.run` replays
`runOptions.script` after the cache rung and before any model turn, under the
same rules (`#replay`: every selector must re-ground, a named destination must
be reached), and a successful script replay seeds the cache. The point over the
cache alone: the script survives a cleared cache and travels with the flow.
`scriptOf` is the single writer for both — `finish`/`fail`/`wait` never persist.

**Every workflow step is self-evidencing.** The step's `detail` carries `urlBefore`/`urlAfter`, the page's headings before and after (and `appeared`, the diff), and the requests the page made while the agent held it land on `network` — so a leg nothing asserts on afterwards is still auditable from the report. That is why `unsettledWorkflowClaim` (and the e2e `agent-journey` verdict of `notEndToEnd`) are `weak` refusals **accepted at once with a note**, never re-asked: measured, the re-ask came back with the same leg — the model could not see the page the leg ends on — and the weak result was taken anyway once the budget was spent, two calls later. Fatal violations still refuse. The agent's history lines now carry the value typed (a password masked to its length) and `moved A → B` / `still at`, and its prompt has a per-turn procedure whose second step is "an action marked ok is DONE — never repeat it".

## A control clicked past its limit is circling (`repeatedToggleClick`)

Live (PL_03_02, 2026-08-27): a filter button whose listbox options never appeared in the truncated tree was clicked EIGHT times across 38 turns and 310 s — each toggle changed the tree (open ↔ closed) so the repeated-on-unchanged-page guard never fired, and a mid-thrash URL change reset the per-URL done-set too. `repeatedToggleClick` (`agent-guards.ts`, pure) counts ok activations per selector for the WHOLE run: past `TOGGLE_CLICK_LIMIT` (3 — a multi-select legitimately re-opens once per pick, PL_03_17 needed three) the next activation of that selector is refused with the count and alternatives (type the value directly, a faster jump control, another control the tree shows, or fail). Second insistence is `circling:` — recorded REFUSED like the destructive guard, never acted on, counts as no progress, and the no-progress counter ends a model that keeps insisting.

**`press` counts exactly as `click` does, since 2026-09-02.** Live (HIR-EC-009): a Date of Birth calendar's "Previous year" stepper was PRESSED — not clicked — upward of thirty times chasing a decades-distant year, 15.6 minutes on one workflow step (of a 45-minute case), because the guard counted `click` alone: a targeted `press` (a selector given, distinct from a bare key sent to whatever has focus) activates its control identically and is exactly the same pathology wearing a different action name. The one-step goal itself was a giant natural-language sentence ("Complete the new-hire key-in form... born in 1995... employee category \"F - DVT\"...") that `goalOutcome`'s narrow `set X to Y` parse cannot read at all, so the value-hunt guard (`AGENT_VALUE_HUNT_TURNS`, below) never engaged either — this fix is the one that is genuinely universal for that shape of goal, because it counts activations, not values. `DEFAULT_AGENT_MAX_STEPS` (60, also 2026-09-02) is the remaining backstop for a goal neither guard can parse.

## The agent fills forms like a human (`check` / `uncheck` / `selectOption` / `type`, 2026-09-02)

`AGENT_ACTIONS` gained the four form verbs the generator and the engine already had, so a `workflow` leg drives a real form instead of click-and-guess: `check`/`uncheck` set a checkbox, radio or ARIA toggle and confirm the state changed (native `setChecked` first, then read `aria-checked`/`aria-pressed`, click only if it differs, re-read); `selectOption` picks by visible label from a native `<select>` or, on failure, opens a custom listbox and clicks the option by accessible name — never fill a dropdown, never guess its items; `type` fires a real keydown per character for autocomplete/typeahead/masked fields, with no read-back guard because such a field is expected to transform what it holds. `fill` keeps its hydration read-back-and-refill. **The safety argument is unchanged**: none of the four is destructive — the vocabulary still cannot express a purchase or a delete except through a `click` the goal explicitly named. `REVEAL_ACTIONS` (the assertion-repair reveal pass) gained `check`/`uncheck`/`selectOption` — a human revealing a target does tick a gating box or pick a dropdown — but **not** `fill`/`type`: a claim an agent *typed* into existence still proves nothing, so text may never be written into the asserted field on that path. `READ_ONLY_ACTIONS` (the Stage-1 triage look) is untouched.

## The agent's read-only database access (`dbCount`)

`AGENT_ACTIONS` includes `dbCount`: count the rows of a table (in `selector`) matching equality pairs (in `value`, `"column=value, column2=value2"`), through `RunOptions.dbProbe` — which the runner wires to its own `DbActions.probeCount`, so the agent gets the same table/column grounding and the same read-only session as every `expectDbRow`, and nothing else. The observed count rides the history line as the action's note ("dbCount benefit_management.benefit_plan — ok (observed 3 row(s))"), so the model reasons from what the database actually said and the record shows the evidence — the same "what the agent claims is never the evidence" rule, satisfied by making the observation itself the record. It cannot write, which keeps the vocabulary's safety argument intact. When no database is configured the probe is simply absent and the action fails with advice ("verify through the page instead"), never a connection error. **`--no-backend` withdraws the probe too** (2026-08-27): a run that declared backend-off had its agent settle a UI-reading goal with three `dbCount` calls (PL_03_02) — a pass whose evidence the run's own limits said not to touch, on a replica whose counts drift. The gate lives in `SmartRunner.#agentDbProbe`. Born from PL_03_03 (2026-08-25): a claim of the form "the count in the box matches the database" was authored as a hardcoded `count: 0` because nothing could read both sides; an agent goal can now hold the box and the table together.

## Looking again is not a stall, and three turns was not evidence

Measured the day after the turn ceiling went (be100, 2026-08-25, 22 error runs with a bundle): 17 ended in the loop's own stops, not on the page. Seven were `stalled: repeated "scroll "` / `"wait "` — the model asked to look again, was told it already had, insisted once, and the run was recorded as a harness error with the goal's control on screen. Ten were `nothing succeeded in 3 consecutive turns`, most on a dropdown leg where the option's role was guessed three ways (`option`, `menuitem`, `text=`) at 1.5 s a miss. Three were an agent reasoning from `/en/consent` after a mid-run goto was redirected there.

- **`IDLE_ACTIONS` (`wait`, `scroll`) are never a stall.** They cannot change the application, so repeating one is not the shape the repeat guard exists for (the same fill into the same field, four times). A repeated idle action is refused once with the reason (the tree lists off-screen elements too), then let through — and the turn it spends counts toward `AGENT_NO_PROGRESS_TURNS`, because it is never progress either. A loop that only looks still ends; it ends on the judge, not on the second look.
- **`AGENT_NO_PROGRESS_TURNS` is five, and counts turns in which nothing *advanced*** — no ok click/fill/press/hover/goto. Three was tuned when a miss cost the 8 s action timeout; once `#target` made a miss cost 1.5 s, three turns was four seconds of evidence, which is the ordinary price of finding out how a widget is built, not proof the page cannot do it.
- **A `wait` on a page whose network is already quiet pays `WAIT_SETTLE_MS`.** The idle wait returns at once there, and a wait that does nothing costs a model turn to do nothing. Paid only when the idle wait had nothing to wait on, so settled pages are not taxed on every wait (the 2026-08-24 concern).
- **`scroll` goes through `#target` and the grounding refusal.** A row a virtualised table has not rendered is "no element matches" in 1.5 s, with the reason, not a 5 s `scrollIntoViewIfNeeded` timeout the next turn cannot read.
- **The consent-gate rung runs on every turn, not only in the preflight.** A goto redirected to `/en/consent` (the session had not accepted; the preflight's 5 s poll had found no accept control on a page still hydrating under an eight-way run) is cleared without a model turn, and the agent is returned to `intendedUrl` — the page its last goto asked for, else the step's own page — never left on the app's home. The model is never asked to decide from the gate.

## A leg that never engages a control ends fast, and a reload is not progress

Live (PL_07_03, 2026-08-27): three workflow legs told to "locate the row for PL_07_… and click its Make Correction icon" on a 76-row table whose **filter and search controls are absent from the AX tree** — every `role=combobox`, `role=textbox`, `role=button[name="Category"]` a 1.5 s miss, while buttons that ARE exposed resolve. Two harness faults made a hopeless leg slow instead of quick: the looked-only handoff (`AGENT_LOOK_ONLY_TURNS`) fired only when EVERY action was a scroll/wait, so a leg that *tried* clicks and missed was disqualified and rode the full 5-turn stall at 1.5 s a miss (77 s on one leg); and a `goto` reload of the same page counted as progress and reset the no-progress judge, so the agent reloaded "to get a clean tree" and bought five fresh turns each time.

Two fixes in the loop's progress judge (both keyed on new `INTERACTION_ACTIONS` — the acts that engage a control; `goto` is not one):

- **A leg that never once lands a control-engaging action hands off at `AGENT_LOOK_ONLY_TURNS`**, softly — the same reading/unreachable outcome as the pure-scroll case, extended to "attempted a click and every one missed" (`missedEveryInteraction`). The handoff is soft (`lookedOnly`, inconclusive-not-failed), so a goal the agent truly could not fulfil still fails — at the flow's next assertion in 2 s, not after 77 s. A leg of failed **gotos** is excluded (navigation that did not arrive is an ordinary stall), and a leg that DID engage a control earlier (`interactedEver`) stays on the 5-turn judge.
- **A `goto` to a URL already visited this leg is not progress** (`visitedUrls`): a reload no longer resets the no-progress counter, so a leg that keeps reloading the same page is bounded instead of running indefinitely.

The still-open half is the target app's own: those filter/search controls render without `combobox`/`textbox`/`searchbox` roles, so nothing — agent or authored selector — can drive them. Until they carry ARIA roles (or authoring learns to locate the row another way, e.g. a URL search param the app honours), the correct outcome for these legs is the fast soft handoff above, with the assertion carrying the verdict.

## The early give-up is a toggle

The agent's two early-stop judges — the look-only soft handoff at `AGENT_LOOK_ONLY_TURNS` (3) and the no-progress stall at `AGENT_NO_PROGRESS_TURNS` (5) — are on by default and can be turned off per run (`--no-agent-early-stop`, the panel's "Disable the agent's early give-up") or process-wide (`WOWLIDATOR_AGENT_EARLY_STOP=off`). Off raises BOTH ceilings to `AGENT_NO_PROGRESS_OFF_TURNS` (25) rather than to `maxSteps` (unbounded by default): "off" must mean "try much harder before conceding," never "loop forever spending model calls on a control that will never appear." The ceilings live as instance fields (`#noProgressTurns`/`#lookOnlyTurns`, resolved in the constructor from `WorkflowAgentOptions.earlyStop ?? agentEarlyStopDefault()`), so the toggle is one decision applied everywhere the two judges fire. This is one of three retry rules the operator can switch off — the others are in-run step reconstruction (`WOWLIDATOR_RECONSTRUCT`/`--no-reconstruct`, `src/engine/`) and whole-flow repair (`WOWLIDATOR_REPAIR`/`--repair`, `src/repair/`).

## A destructive click must name its row

Live (be100 PL_03_18, 2026-08-25 06:28): the goal named the plan to delete, the agent could not find its row, clicked `role=button[name="Delete" i] >> nth=0` — the first Delete on a 75-row table — confirmed the dialog, and the step's own network evidence shows `DELETE /api/benefit-plans?planId=TH_MED_001`. Its reasoning said it was the right row. On an authoritative database that delete is permanent, and PL_02_02 (re-authored 45 minutes later against that plan's name) dead-ended on every run after. The prompt's "no destructive action unless the goal asks" was satisfied on paper.

`unscopedDestructiveClick` (`agent-guards.ts`, pure) is the structural form: when the goal names an identifier (`PL_03_15_16_17_18`, `TH_MED_001`) and the click's target control is destructive by name (`DESTRUCTIVE_NAME`), the selector must carry one of those identifiers — or sit inside a `role=dialog`, the confirmation of a delete already scoped. Refused on the first ask with the scoped shape shown; on the second ask it is **never acted on**: recorded as a failed action (`REFUSED` in the history), the turn counts as no progress, and the loop goes on — the right row may still be found, or `fail` said honestly. A goal that names no identifier has nothing to scope to and is left to the prompt.

## The tree the agent is shown must contain the answer

Live (be100 PL_03_01, 2026-08-25). Goal: *"verify the Total Plans summary card shows count 75"*. The agent spent five turns scrolling, reported *"the required numeric values are not present in the accessibility tree"*, the step failed with a `high` defect — and the next step's `expectText "75"` passed against the very page it had been standing on.

Both halves were the harness's own:

- **`focusTree` dropped the goal's number.** Goal terms were filtered by `length > 2`, and `75` is two characters — so the one term naming the answer scored nothing, the node called `"75"` ranked below sixty sidebar links, and the budget evicted it. A numeric token now survives the filter; it is the most specific term a goal can carry.
- **`focusTree` kept the label and cut the value.** A summary card is a label and a value as sibling nodes (`StaticText "TOTAL PLANS"`, then `StaticText "75"`), and the value shares no word with the goal. A node that MATCHES the goal now brings its document neighbours with it, on the match's own rank — so it cannot outrank a better node, only fill the budget ahead of unrelated ones. Verified against the live page: before, `TOTAL PLANS` present and `75` absent; after, both.

**And the goal was never the agent's to answer.** `verificationOnlyGoal` (`goal-evidence.ts`): a goal carrying a verify verb and no action verb asks the agent to be the oracle, which it structurally cannot be — an agent produces an account of itself, never evidence, which is this module's whole premise. Such a leg now **hands off**: `goalEvidence` returns `verification-deferred`, the step passes, and whatever the flow asserts next is the proof (a leg with nothing after it is caught at authoring time by `unsettledWorkflowClaim`, never invented into a defect at runtime). It still files the `low` usability finding, worded for this case: write the leg as the assertion it is, and keep the agent for the navigation that reaches the page. Deliberately narrow — any action verb anywhere disqualifies it, so "open the dialog and verify the title" stays a real leg whose failure is real.

## The queue governor (`queue-governor.ts`, 2026-08-28)

One agent per suite run governing parallel queuing (docs/parallel-run-spec.md
§2.4): role `governor` (default groq; point at claude-cli opus via
`WOWLIDATOR_GOVERNOR_*` — the TURN BUDGET bounds the spend, not the model).
Event-driven (`suite-start`, `case-ended` on a non-pass, `queue-blocked` after
~25 refused dispatch polls), hard-budgeted (`WOWLIDATOR_GOVERNOR_TURNS`, 12),
compact observation, one structured action per turn. It may NARROW on its own
authority (hold, shrink pool, note); the deterministic section rules are the
floor. `db-read` = one SELECT; `db-write` = one INSERT/UPDATE on a declared
table, only with `WOWLIDATOR_DB_ADMIN_URL`, logged BEFORE execution, DELETE
refused outright. Absent/off/erroring/out-of-budget → the deterministic
scheduler runs exactly as it would alone (the capture-pilot containment rule).
`WOWLIDATOR_GOVERNOR=off` disables. Tests: `tests/queue-governor.test.ts`.

## A finish is accepted on the page's word (S1 of the 2026-08-28 agent-flaw audit)

Audit of be100's latest run: 20 of 22 agent legs on PASSED cases were settled by the agent's own `finish` text — "shows 1–75 of 75, *meaning* 100 was selected"; "picked, *as confirmed by* the successful clicks" — inference presented as observation, never checked. The "what the agent claims is never the evidence" rule had been enforced on failures only. Now: `goalOutcome` (`goal-evidence.ts`, pure) reads the checkable end state a goal names (`set X to Y`, `X = "Y"`); on `finish` the loop re-reads the live tree and `outcomeShown` must find it — on one line (`button "Status: Inactive"`) or as a label→value neighbour within three lines. A miss is refused ONCE with what the tree shows; a second insistence records `claimed finish, but the page does not show X = Y` and `success: false`. A goal naming no state falls through, and the record says so: `AgentRecord.settledBy` is `observed-state` (with the evidencing line) or `agent-claim` (with the bare reasoning), so an all-claim run is visible as one in the report. New action **`read`** (idle, never progress): the harness reports a control's text/value/checked/expanded/disabled into the history at $0, so the agent learns whether a choice took instead of clicking again to find out — the repeat-guard stalls on Country and Rows-per-page were exactly that.

## The judge may not overrule a human record (S2)

`runFlow`'s auto-review: when the sheet's own Actual Result (`generation.knownResult`) exists and the judge's ruling contradicts it, the ruling is withheld with the disagreement on `notes` and the run stays `needs-review` for a person. PL_04_08: a human passed the case by hand; the judge ruled "failed" at 0.9 on "still visible contradicts hidden" without asking whether "not shown" meant hidden, disabled or inert. A machine's confident reading of two strings does not outrank a tester's hands.

Since 2026-08-31 the DEFAULT governor is deterministic (`RuleGovernorModel`,
same `GovernorModel` seam, effectively unbudgeted): measured across two live
suites, every LLM turn concluded `idle` while restating a set-intersection the
scheduler had already computed. The rules: name a fully-conflicting blocked
queue as a real conflict (once per distinct blockage), call out a compatible
case that is not dispatching, and shrink the pool one step after 3
timeout-shaped failures in 5 minutes (never below 2). `WOWLIDATOR_GOVERNOR=
model` restores the LLM governor — its remaining unique power is judging and
seeding a starved fixture (`db-write`); `off` disables both.

## A dependency wait is the scheduler's; the governor explains it (2026-09-04, EC catalog run `ec-runtest-csv@…09-33-38`)

Read from the panel's job-16 log and its ledger (39 cases, 10 lanes). Two shapes
of "depends on" refusal, neither the governor's:

- **PRB-EC-021 ← HIR-EC-064.** HIR-EC-064 ran in `[c31]`, its sign-in did not
  take (a runtime error, 22 s), and it was recorded `blocked`; PRB-EC-021
  (`[c34]`) was decided AFTER that, quoting it. The gate behaved: a dependent is
  never decided before its prerequisite ended. What was wrong upstream is the
  sign-in, not the queue. The wording "which never ran" for a case the harness
  ended is now "which could not run (runtime error — …)"; a refused/never-
  started case keeps "never ran".
- **Twelve E2E-nn references, fourteen rows.** `E2E-04`, `-11`, `-18`, `-42`,
  `-45`, `-46`, `-105`, `-115`, `-118`, `-119`, `-125`, `-128` are scenarios of
  another sheet ("Sheet E2E All Module", which the rows' own notes name); the
  CSV holds one sheet, and none of them is a Scenario ID in it. Scenario-id
  resolution (`linkDependencies`, 2026-09-04) is correct — these are external.
  They were fourteen identical per-row lines; the plan now says each ONCE,
  with the rows that need it (`unresolvedReferences`, `case-plan.ts`, printed
  by `cmdCatalog` right after `orderDependentsAfterSources`). A cycle is
  printed there too (`dependencyCycles`), before either side is blocked on the
  other at run time.

**Where the gate lives, and why.** `dependencyStanding` (`src/cli/case-plan.ts`,
pure) is the whole rule — wait while a prerequisite queued ahead is unfinished,
ready when every one passed, blocked with the prerequisite's own outcome line
otherwise (failed / review / never ran / could not run / not in this run /
queued after it / a cycle) — and `runCases` only supplies its lookups. It is
in the deterministic scheduler and not here because a dependent's verdict is
correctness, and this module's governor is an optimiser that may be absent,
off, erroring or out of budget without any verdict changing (the containment
rule at the top of the governor section). The governor OBSERVES the gate:
`GovernorCaseFact.waitingOn` carries the prerequisite a pending case is
parked on (set from `dependencyStanding`, never inferred here), the WAITING
prose line shows ` waits-for:X`, and the rules governor's queue-blocked rule
says `"B" is waiting on prerequisite A, in flight in lane N` (or "queued
ahead of it and not yet started" / "not yet queued") once per pair, keeps
such cases out of the "looks compatible yet has not dispatched" diagnosis —
which had misread every parked dependent as a scheduler fault — and answers
idle when the whole queue is parked on prerequisites.

**The queue defect this found.** `runQueue` dispatches in index order, and a
dependent's `false` from `canRunWith` held the HEAD of the queue: a ten-lane
pool drained to the one lane running the prerequisite while every case behind
the dependent waited on nothing. `canRunWith` may now answer `'defer'` (what
a dependency wait answers): the item is parked, the loop goes on, and parked
items are re-offered before each take, whenever a lane ends while a streaming
queue waits for its next authored row (the take races the lanes), and after
close until none is left; an exclusive dependent is parked the same way
instead of draining the pool to wait. A suite that never answers `'defer'`
takes exactly the path it always did — pinned by `tests/case-plan.test.ts`
("a suite that never answers defer takes the old path exactly"). The wait
still counts toward the queue-blocked event (25 polls), so a long one reaches
the governor and is explained rather than silent.

Tests: `tests/case-plan.test.ts` (`runQueue parks a deferred item…`,
`dependencyStanding…`, `dependencyCycles / dependsBackOn /
unresolvedReferences…`), `tests/queue-governor.test.ts` (`the rules governor
explains a dependency wait`). Live before/after on the EC catalog still to be
recorded: the 09:33 run never hit the wait (HIR-EC-064 ended before PRB-EC-021
was authored), so the number to watch on the next run is lanes in flight while
a `waits for` line is open — previously 1, expected the pool size.

## A readOnly run's finish is the answer, never a claim to refuse (2026-08-31)

The observed-state finish settlement (`goalOutcome`/`outcomeShown`) is skipped
when the run is `readOnly`: such a run cannot act, so refusing its finish to
make it "set" the state burns a turn by construction — and the triage look's
verdict travels IN its finish. Found live: the look's goal text parses as an
outcome, the settlement refused the verdict once, and every `fail` verdict
cost two model calls instead of one (tests/smoke.test.ts pins one call).

## The model copies the tree's notation back as a selector (2026-09-02)

`region "Dependents Dependents"`, `spinbutton "Day Day"`, `heading "National ID
/ Tax ID"` — the AX tree's own line shape, handed back as a selector and read by
Playwright as a CSS tag with a stray string. Live (ec10 HIR-EC-003) five such
misses in a row ended a leg as a stall while the same model had written the
correct `role=…[name=… i]` two turns earlier. `normaliseAgentSelector`
(`src/engine/selector.ts`) rewrites the line to the role selector before the
grounding guard sees it, in `LlmAgentModel.decide`, for the decision and every
planned step alike — see the engine CLAUDE.md for the rule and its siblings.

## A leg off its page has a small allowance (`wanderedOffPage`, `AGENT_OFF_PAGE_TURNS`, 2026-09-03)

Live (HIR-EC-002, 2026-09-03 13:00 run): steps 16 "Reopen the saved New Hire"
and 19 "Leave the New Hire form" burned 903 s of a 1,377 s case. Each leg left
the step's page (/en/admin/hire/draft → /en/requests → on through the admin
area) and every goto or click onto a fresh page was progress by the no-progress
judge's own rule (`advanced`: an ok interaction, or a goto to an unvisited
URL), so nothing but `DEFAULT_AGENT_MAX_STEPS` (60) ended them, at ~7 s a
turn. The judge that should have fired did not exist: no rule distinguished a
journey from a wander.

`wanderedOffPage(goal, startUrl, url)` (`goal-evidence.ts`, pure): the page is
on a different origin or path from the step's start (`differentPage` — a
`?step=` change is the same page), is not BELOW the step's own page
(`childPage`, 2026-09-09 — see the next paragraph) **and** is not at the
destination the goal names (`goalDestination`/`atGoalDestination`; a goal
naming none has nowhere off its page that counts, which is most goals — a goal
is written in the user's terms and rarely holds a path at all). While that
holds, the loop spends `AGENT_OFF_PAGE_TURNS` (8). Returning to the
start page resets the allowance; a consent URL is the gate rung's to clear and
is never counted (`CONSENT_GATE_URL_PATTERN`); arriving at a named destination
still ends the leg by the destination rule before this one is consulted. Past
the allowance the leg ends with `agent wandered: left the step's page … spent N
turn(s) elsewhere … without reaching …`, naming the page it is on. Lifted to
`AGENT_NO_PROGRESS_OFF_TURNS` when early-stop is off, like the other two
judges (`#offPageTurns`). Why it cannot slow a passing leg: a journey to a
named destination is two to four page moves and arrives before the eighth; a
leg whose work is on one other page pays nothing for the turns that do that
work. Tests:
`tests/goal-evidence.test.ts` (`wanderedOffPage`, `childPage`),
`tests/agent-guards.test.ts`
(the constant's place among the ceilings). Measured on the HIR-EC-002
benchmark (`e2e-02/02-…flow.json`, 2026-09-03 12:59 UTC, both rails, agent on
opus): 558 s / 56 agent requests / 1.03M in-tokens / agent 296 s, longest
leg 57 s — against the 13:00 run's 1,377 s / 182 requests / 3.55M / 1,188 s
with steps 16 and 19 at 425 s and 478 s. The former wanderers (now steps 18
and 20) ended in 56 s and 38 s by the agent's own `unreachable`; the
allowance's stop message itself did not fire on either benchmark, and on ec09
HIR-EC-009 (job-3, 12:39 UTC) no leg wandered at all.

**Two corrections, both from PL_09_01 of run `be-high-sonnet-20260909-153617`
(2026-09-09, lane c14).** That leg's goal was to create a fixture row: it
started on the plans list, clicked the page's own Create control, filled the
form correctly and submitted — and was ended as a wander on the turn AFTER the
submit, while the model's own reasoning read *"the button now shows 'Creating…'
disabled … wait for it to complete"*. The case scored `never ran: runtime
error`: no verdict about the application at all. Two flaws combined, and each
is fixed where it was.

- **A page below the step's own is not off it** (`childPage`,
  `goal-evidence.ts`, pure). `/…/plans` → `/…/plans/create` is a different
  pathname, so `differentPage` called it another page and the allowance began
  counting on a leg that had gone exactly where its goal sent it. A descendant
  path is where a list page's own create / edit / detail view lives. The other
  end of the journey is already read this way — `atGoalDestination` is
  containment, so a goal naming `/plans` counts `/plans/create` as arrival —
  and this applies the same reading to the page a step began on. Same origin
  and a prefix at a SEGMENT boundary only, so a sibling (`/plans` → `/rules`)
  and a near-miss (`/plans-archive`) still spend the allowance, which is the
  wander HIR-EC-002 was. A start path of `/` has no children: everything is
  below a site root, and the rule would otherwise withdraw the rail from every
  leg that began on one — the same reason `goalDestination` refuses a bare `/`.
  `atGoalDestination` was deliberately NOT widened: it ENDS a leg successfully,
  and accepting a child there would settle a leg standing inside a form the
  goal never named.
- **A turn that did work off the page is free; a turn that moved the page is
  not.** The old exemption was a first-time `FORM_ENTRY_ACTIONS` entry, and a
  real form needs clicks: on this leg a date picker, an overlay dismissal and a
  submit each spent a turn, and only the two `fill`s were exempt. The
  exemption is now the structural one — **an ok action that engaged a control
  (not an `IDLE_ACTIONS` look) after which the FULL tree changed** — which is
  the work a page is visited for, however it is expressed. A turn that moved
  the page again ALWAYS spends the allowance, whatever else it did: a wander is
  made of page moves, so the eight-turn bound on HIR-EC-002's shape is
  unchanged. A FAILED action is never free either — a leg that keeps missing
  must still be bounded, and it is the miss that the allowance then counts.
  The tree hash is the one the look judge (OA-10) and the re-activation credit
  already compute; all three now share **one** measurement per turn
  (`treeChangedSince`), so no turn pays two AX reads for one question. The
  off-page block moved below the OA-10 block for that reason and for no other.
  `FORM_ENTRY_ACTIONS` had no other reader and is gone.

Not fixed here, and not this module's: the leg spent 716 s of its 777 s waiting
for a data lock before its first click, and the goal itself is a 15-pair
key-in sentence the generator wrote — both outside the loop.

## A record the application says is already there IS there (`fixtureAlreadyPresent`, 2026-09-09)

Live twice in one run (`be-high-sonnet-20260909-153617`), both fixture-creation
legs whose row had survived an earlier run:

- **PL_09_01** filled the create form with the plan id its goal names,
  submitted, and read back `Plan ID already exists.` Its next decision was to
  fill the SAME field with a different id — reasoning, verbatim, *"the goal
  explicitly requires Plan ID=…; …best conservative action is to retry"* — a
  value the flow's very next step (`expectVisible text=<the goal's id>`) could
  never have matched.
- **PL_06_05** called `fail` on the same message and the case ended `never ran:
  no verdict — the agent's own account, unverified`.

Two cases lost to a fixture that was present the whole time, and in both the
application had answered the leg's question outright.

`fixtureAlreadyPresent(goal, axTree)` (`goal-evidence.ts`, pure) is the settle,
and every part of it is the PAGE's word:

- a line of the tree **the harness itself read** carries a duplicate-key
  refusal (`DUPLICATE_KEY_ERROR`: already exists / in use / taken / registered,
  must be unique, is duplicated, duplicate key|entry|value|record|id, and the
  sheets' own ซ้ำ / มีอยู่แล้ว / มีอยู่ในระบบ) **and** the words of a control the goal
  names a value for — a refusal naming no field ("this record already exists")
  scopes to nothing and is left alone;
- `outcomeShown` finds that control still holding **the goal's own value** on
  the live tree, so the value the application called taken is demonstrably the
  value the goal requires and not a value the model says it typed.

The loop consults it once per turn, on the full tree, and **only after the leg
has acted** (`actions.length > 0`) — every rule in this module requires an
observed transition, and a refusal standing on the page before the agent
touched it is not this leg's evidence. It is withheld from a `readOnly` run
for the same reason the observed-state settlement is: that rung cannot act,
its goal is a question and its own `finish` carries the verdict. It settles the leg `success`, with
`settledBy: 'fixture-present'` (a new value beside `observed-state` and
`agent-claim`, never folded into either) and `endedBy: 'fixture-present'` (a
PAGE-sourced stop, beside `arrived` and `cannot-offer`; mirrored into
`AGENT_ENDED_BY_VALUES`, which refuses an unlisted value on read).

**Why this is not a false pass.** The settle claims exactly one thing — the
keyed record exists — and nothing about the other pairs of a multi-field goal.
The deterministic step the flow puts after such a leg (`expectVisible
text=<the id>`) is the independent witness, and if the row is not really there
that step fails and the case fails honestly, which is strictly better than
today's "never ran" with no verdict at all. The agent is never given a way to
delete or overwrite the existing record, and it may not change the goal's
value — the settle is what removes its reason to try.

One deliberate withholding: a leg settled this way is **not** remembered
(`#remember` is skipped). It performed no journey worth replaying — its script
stops short of the creation — and a later run whose fixture is absent would
replay it, succeed on every action and still leave the row uncreated.

Tests: `tests/goal-evidence.test.ts` (`fixtureAlreadyPresent` — the live
shape, the different-value case the leg made for itself, no refusal, a refusal
naming no field, a field the goal states no value for, a goal with no readable
pair, the Thai spelling, and a truncated tree) and `tests/agent-guards.test.ts`
(the loop under a scripted model: the settle fires, the record says
`fixture-present`, the turn that would have invented a new id is never spent,
and a refusal already on the page before the leg acts settles nothing).

## The same control on the same page is not progress (`reactivation`, 2026-09-03)

Live twice in one day. ec09 HIR-EC-009 job-3 leg [14]: 320 s / ~60 turns
re-clicking section headers on one wizard page — every click ok, every ok
click resetting the no-progress judge, and `repeatedToggleClick` (three per
selector, whole run) worth thirty-six free turns across a dozen headers. Then
job-2, the Position / Employee Sub-Group picker: 122 agent requests and 18
minutes of ok `fill` into `role=textbox[name="Search options" i]` with a
different search string each time ("40106337", "401063", "MKB12.12", "",
"4010", …), between failed `selectOption`s on the button and ok re-clicks of
it. The judge saw an ok interaction on every turn.

`reactivation(decision, url, activatedHere)` (`agent-guards.ts`, pure) reads an
ok activation (`ACTIVATION_ACTIONS`: click, press, hover, check, uncheck, fill,
type, paste, selectOption) against the selectors already ok-activated **on
that URL this leg** (`activationKey`; a miss records nothing, and the same
selector on another page is a new control): `first`, `repeat` (a click-shaped
re-activation), or `text-again` (another fill/type/paste into the same field).
`reactivationAdvanced(kind, treeChanged)`: `first` is progress as before;
`repeat` is progress **only if the full tree changed after it** — the loop
re-reads the tree for that case alone and charges the credit to
`AGENT_TREE_CHANGE_CREDITS`, shared with the scroll/wait looks, so a control
that toggles forever still ends the leg; `text-again` is **never** progress,
because the typed value is echoed into the tree's `value=` and would pass a
change test on its own evidence (the picker's six strings would each have
been credited). A turn not credited for this reason tells the model so in the
history. `repeatedToggleClick` is untouched — it refuses the fourth activation
outright; this rule only decides whether an ok one counted. Why it cannot slow
a passing leg: a multi-select re-opened once per pick changes the tree and is
credited; a search box used twice has a pick between the fills, and the pick
is `first`. Tests: `tests/agent-guards.test.ts` (`reactivation`, with both
legs' action sequences as fixtures). Measured on ec09 HIR-EC-009 (panel
job-3, 2026-09-03 12:39 UTC, agent on opus): case 533 s / 55 agent calls /
1.43M in-tokens, agent time 262 s, the five workflow legs 14–77 s each and
every one ended by the agent's own honest `unreachable` — against the morning
run's 1,090 s / 122 calls / 3.4M in / 763 s agent time (old prompt, old
loop). The stall message itself never fired: the history note handed back
on a re-activation was enough for the model to stop hunting. Job-2 in between
(new prompt, old loop) had cut leg [14] to 40 s but was at 122 requests on
the Position picker when it was interrupted.

## The agent runs as whoever is active (2026-09-03)

`SmartRunner.workflow` hands the agent `this.page`, and `page` is a view of the active `PersonaSession` — so after `signIn MANAGER_ACCOUNT` the leg runs in the manager's own Chrome, and the step's record carries `persona` and `browser`. Nothing in the loop changed; OA-15 stands: a goal naming two people is still refused, and the authored form is two legs with a `signIn` between them.

## Two people, one address (2026-09-04)

Two corrections to the loop, both from the same case shape: a catalog row that
changes hands — the manager submits a probation review, the approver approves
the same case — where both legs start on the same URL with near-identical goal
wording.

**The replay memory is keyed by persona.** `replayKey(startUrl, goal, persona)`
takes the active persona's LABEL, fed from `RunOptions.persona`, which the
runner supplies from `activePersona` at every `#agent.run` call site that passes
`memory` (the `workflow` step, the entry rung, the heal pass). Without it the
second leg replays the first person's recorded journey on the second person's
browser, at zero model turns, and reports success — the very hazard
`#deadResolutions` was already keyed by persona to avoid, its comment saying so
outright: *an employee's 403 page and the manager's real page share a URL and
nothing else*. The agent's memory had not been given the same treatment.

The label is used for the key and for nothing else. It is never put in a
prompt, never offered to the model, and carries no email and no password — the
agent has no sign-in verb and no credentials by design, and this must not
become the hole in that. A run with no personas passes `undefined` and its keys
are byte-identical to before, so no cache entry written earlier is orphaned.
The trade is deliberate: on a multi-persona run a leg that could have replayed
another person's journey now pays the model instead. Correctness over a saved
turn, and only where two people are actually involved.

**A refused goal is an authoring fault, not a broken feature.**
`multiPersonaSummary`'s `multi-persona goal:` prefix was declared to be "the
protocol `run-cases` reads so it can file this as an authoring refusal" and had
no reader anywhere in `src/`. The refused leg fell through to the ordinary
failed-leg path and became `functional` / `high`, "Workflow goal not reached" —
a fact about how the goal was worded, filed as a defect in the application under
test. `personaRefusal(summary)` in `goal-evidence.ts` is the reader; the runner
branches on it beside the provider refusal, records the step `error`, files **no
defect**, and throws a message naming the fix. Like `agentModelUnavailable`, it
can only be true of a summary produced by a return that happens before turn 1,
so it can never change the outcome of a leg that actually ran.

## The judging turn sees the page (2026-09-08)

`AgentObservation.screenshot` and the `sighted` run option. The loop is
otherwise unchanged: one decision per turn, the same schema, the same guards.

The split is between **driving** and **judging**. Driving asks "which control
do I press next", and the accessibility tree answers it better than pixels do —
it names controls, and a name is what a selector is built from. Judging asks
"does the page show this", and the tree is frequently wrong about that: a value
rendered into a plain div, a field that only looks disabled, a date whose
displayed form is not its value, a popover standing where a textbox was asked
for. All of those are invisible to the tree and obvious on screen.

So `sighted` is off by default and set in exactly one place — the engine's
`#agentTriage` read-only look, the rung that runs only after determinism has
already failed. `LlmAgentModel.decide` forwards the image to
`generateStructured`, which has taken `images` since the factory was written.

Three rails, all load-bearing:
- **The image never becomes the verdict.** `proved` still has to name an
  element, and the harness still re-runs the author's own comparison against
  it. Sight makes the agent a better witness, not the judge — the same rule as
  everywhere else here.
- **No vision is not a failure.** `looksLikeNoVision` matches the provider's
  refusal of an image part (a text test, because the AI SDK surfaces it as a
  message and the wording differs per provider), marks the agent instance
  blind for good, and re-asks the same turn without the picture. A rung that
  used to answer from the tree must never start erroring instead. Every other
  error is re-thrown, so a real outage stays loud.
- **One shot per turn, beside its own tree.** A screenshot from a different
  moment is evidence about a different page. A failed capture is no image and
  no change.

Tests: `tests/smoke.test.ts` — the refusal/outage split in `looksLikeNoVision`,
and that the image reaches the model only when one was taken.

## Action authority: the mutation gate, the provenance ledger, and `blocked` (Phase B, 2026-09-05)

Phase B of `docs/research/commerce-agents-patterns.md`. The loop refused an
unscoped destructive click since PL_03_18, but three things were still missing:
an identifier in the goal was taken as proof the session had seen the row; a
batch had no way to say which categories of change it permits; and a refusal
was an `ok: false` with a prefix in `error`, which every reader had to parse to
learn that the application was never touched. All three live in
`mutation-policy.ts` (pure) and one choke point in the loop.

- **`ActionOutcome` on every `AgentAction`** (`engine/proof-bundle.ts`): `ok`,
  `failed`, or `blocked` with a machine-readable `reason`
  (`capability | provenance | approval | guardrail`), `rule`, `category`,
  `target`, `policySource` and, for a provenance hold, the ledger's facts. The
  boolean `ok` and the `error` string stay for every reader that predates it.
  The existing destructive-scope and circling refusals are typed `guardrail`
  and end the leg as blocked.
- **`TargetProvenance`** is fed by `#captureTree` — the ONE way the class reads
  the accessibility tree — and by nothing else: not the goal, not the model's
  reasoning, not the selector it emitted. Reset at the top of every `run()`. A
  `delete`/`approve` click must scope to identifiers that were observed this
  session AND are in the latest capture, which the gate re-reads at the moment
  of the click (`#provenanceForGate`), so a row that scrolled away, was
  filtered out, or was already deleted is never acted on because it was once
  on screen.
- **`MutationPolicy`** is the host's manifest (`WOWLIDATOR_MUTATION_POLICY`,
  `WorkflowAgentOptions.mutationPolicy`, `RunOptions.mutationPolicy`,
  `SmartRunnerOptions.mutationPolicy`): `allow` (exhaustive when present),
  `deny` (wins), `approved` entries for the irreversible categories, and an
  `approveMutation` hook for the host's explicit yes. Categories are read off
  the accessible name of the control the click lands on (`mutationCategoryOf`:
  `delete`, `approve`, `submit`); everything else is ordinary and never gated.
  Without a policy manifest, provenance is enforced, capability is
  unrestricted, and an irreversible action still requires the host's explicit
  approval hook. Goal text and model output can never supply that approval.
- **A destructive flow has two halves, and the gate had them backwards**
  (2026-09-08, RU_08_03). The category was read off the clicked control's name
  alone, so a row's `ลบ` icon — which in humi's `rules-table-columns.tsx` only
  calls `setDeleteTarget(rule)` and raises a dialog — was classified `delete`
  and held, while the `ยืนยัน` INSIDE that dialog, the click that actually
  destroys the row, matched `SUBMIT_NAME` and passed as reversible. The
  harness held the harmless half and guarded nothing on the half that counts.
  `MutationPhase` names them: a click inside a dialog is a `commit`, anything
  else is an `open`, and a confirming control inside a dialog whose own text
  is destructive **inherits that category** instead of `submit`. The dialog is
  read off the live element (`#dialogFor`, `el.closest('[role=dialog]')`) and
  from nowhere else — the same standard as provenance — and only when the
  control's name already means something to the gate, so an ordinary click
  still pays nothing. A confirmation names the record its button does not, so
  the identifiers in the dialog's text scope the commit; without that the
  commit half would be held as `destructive-unscoped`, which moves the block
  to a rule that cannot be satisfied rather than making anything safer.
  An `approved` entry may name a `phase`: `{ category: 'delete', phase:
  'open' }` lets a case raise a confirmation and cancel it while every commit
  still stops dead — which is what **56 of the 447 rows** of one BE catalog
  need, the whole `PL_09_*` family among them. An entry naming no phase means
  both, as every entry written before phases did.
- **The gate runs inside `#act`**, before the browser is touched, so a planned
  follow-up, a replayed script and the menu walker all pass it. A held
  mutation is terminal for the leg (`WorkflowResult.blocked`): another model
  turn does not change a policy, insisting does not make a row observed, and
  an approval cannot be talked into existence. The runner records the step
  `error` with `ProofStep.blocked`, files **no defect**, throws
  `MutationBlockedError` (an `error` in `classifyStepFailure`, futile for
  reconstruction), `harnessOnly` names it `blocked (reason, rule)`, and the
  case scores blocked — exit 3, never 1. The report shows a "Held by the
  run's rules" callout, the panel a `HELD (…)` line.

Tests: `tests/mutation-policy.test.ts` — the gate, the ledger and the manifest
parser (pure), and the loop under a scripted model on a real page (CDP): an
unobserved id, a row that vanished, an observed row under an approving policy,
a denied category, a missing approval, the host's yes, an ordinary journey
under the strictest policy, a `runFlow` whose held leg is an error with no
defect and a held report, and — for the two halves — a confirm that inherits
its dialog's category, one that stays a `submit` inside a harmless dialog, and
a `phase: 'open'` approval that runs the opener while still holding the commit.

**The mutation hook waits after authority and before contact (2026-09-05).** `RunOptions.onMutation` (per-run before instance) observes only an allowed, classified `click` or targeted `press`, after `gateMutation` returned no hold and before the browser action starts. It may wait for a route-scoped data lock but never decides authority, changes a verdict, writes provenance, or runs for an ordinary click; its exception propagates as the action failure.

## Skills and the contract (Phase C, 2026-09-05)

Phase C of `docs/research/commerce-agents-patterns.md`, items 1 and 2.

- **`agentContract({ dbCount, skills })`** (workflow-agent.ts) is the static
  half of every turn — the system prompt and the decision schema — memoised
  per configuration so equal options hand back the same string and schema
  instances. Every turn is a fresh single-shot call and the only discount is a
  provider's prompt cache on a byte-identical prefix; the contract is that
  prefix, so nothing in it may vary turn to turn. `dbCount: false` (a run
  with no database probe — `RunOptions.dbProbe` absent) withdraws the action
  from the prompt and the schema's enum together; the dispatch already failed
  it with advice, and now the model is never offered it. `AGENT_ACTIONS`
  itself is unchanged. `AgentObservation.dbCount`/`skills` carry the
  configuration to `LlmAgentModel.decide`; absent means "everything, no
  skills", so every older caller reads as before.
- **Skills** (`agent-skills.ts`): the sign-in, forms, tables, date-picker and
  wizard paragraphs moved out of the base prompt VERBATIM into
  `AGENT_SKILLS`, and `selectSkills` picks the ones a leg needs from the
  goal, the first full tree and the first required-fields line — once per
  leg, in `run()`, at $0 — so the system bytes hold for the leg. Selected
  bodies are appended under `GUIDANCE FOR THIS GOAL:`; the base prompt keeps
  the action contract, `DETERMINISM_RULES`, the EACH TURN procedure, WHAT THE
  LOOP WILL REFUSE and the Rules for every variant. A skill is tactics only
  and may never weaken the policy layer — `tests/agent-skills.test.ts` pins
  the policy sentences out of every body. The chosen ids ride
  `AgentRecord.skills` and the workflow step's `detail.skills`.
- **Cache telemetry**: `StructuredResponse.cachedInputTokens` (the SDK's
  `usage.inputTokenDetails.cacheReadTokens`) → `AgentDecision.cachedInputTokens`
  → summed onto `AgentRecord.cachedInputTokens` and the step's
  `detail.cachedInputTokens`, so whether the stable-first order is paying is a
  number in the bundle rather than a belief.

Tests: `tests/agent-contract.test.ts` (memoisation, the dbCount withdrawal,
the policy blocks in every variant, the stable-prefix invariant of
`buildUserPrompt`, cache reads reported by a mock model),
`tests/agent-skills.test.ts` (selection per shape, determinism and order, no
policy in a body, the base prompt without the moved paragraphs).

## Why the leg ended is data: `endedBy`, and three classes of failed leg (task C3, 2026-09-05)

Every failing `workflow` step used to end as step status `error` under one
message, whatever ended it: the runner recorded the leg failed, threw
`workflow agent failed: …`, and `classifyStepFailure` scored it `error`. So
an evidence-backed "the list offers 9 options and none is the value" (the
harness read the options itself, twice, after a settle) scored the same as
"the agent gave up after 15 turns" (a harness limit) and the same as the
model saying `fail` with a reason (a bare claim) — and a case with no later
assertion scored blocked with "runtime error — the harness ended this case"
for all three.

**`AgentRecord.endedBy`** (`engine/proof-bundle.ts`, `AGENT_ENDED_BY`) is the
loop's own stop, typed. It is set at every place `run()` already set its
final `summary` and stopped, and changes nothing about WHEN the loop stops —
the same walk through the loop records the same actions and the same
summary as before, plus one word. By the source of the evidence:

- page: `arrived` (the destination rule, including the zero-call rungs — a
  replayed journey, a link the tree showed, a state already showing, a gate
  cleared onto the destination), `cannot-offer` (`listboxCannotOffer`: the
  goal's control enumerated twice, identically, `WAIT_SETTLE_MS` apart, and
  the goal's value on none of the options), `fixture-present` (2026-09-09,
  `fixtureAlreadyPresent`: the application's own duplicate-key refusal named
  the goal's key while the tree showed that control holding the goal's value);
- harness: `budget`, `stalled` (an ok action repeated on an unchanged page
  after being told so), `no-progress` (the five-turn judge AND the look-only
  handoff — `lookedOnly` tells them apart), `value-hunt`, `wandered`,
  `model-error`, `blocked` (a mutation or guardrail hold — `blocked` carries
  the record — or the multi-persona refusal before turn one, which has none);
- model: `finish` (accepted; `settledBy` says whether the page or the claim
  settled it), `fail`, `contradicted` (a finish the page refuted — the
  destination rule or the observed-state settlement).

**A `fail` is kept as a claim beside what the page showed.**
`AgentRecord.unreachable = { claim, urlAfter, headingsAfter }`: `claim` is
the model's reasoning verbatim (redacted like every other string on the
record) and is labelled a claim in the type, because that is all it is; the
URL and the headings are what `#captureTree` read that turn. A reader weighs
one against the other. Nothing in `src/` files the claim as a finding.

**A listbox miss is kept as facts, not only as a message.**
`AgentAction.listbox` (`AgentListboxFacts`: trigger, value, shownCount,
shownHead ≤ 8, filtered, searchedEmpty) is copied off the
`ListboxOptionMissingError` in the one `catch` where `#act` misses, BEFORE
`describe()` flattens it to the action's `error` string; on the settle-and-
retry the second enumeration is the one kept. `listboxFacts()` is the pure
writer.

**The runner classes a failed leg by that source** (`agentLegFailure`,
`engine/runner.ts`, pure over the redacted record), after the existing
blocked / provider / authoring branches:

- harness (`AGENT_HARNESS_STOPS`) → `AgentBudgetError`, message naming the
  limit ("the 12-turn ceiling", "an action repeated on an unchanged page"),
  still `error` in `classifyStepFailure`, still a blocked case — exactly the
  outcome the untyped message produced, now saying which limit;
- page (`cannot-offer`) → `AgentEvidenceError`, **`failed`** in
  `classifyStepFailure`, with `detail.expected` (the value asked) and
  `detail.actual` (the trigger's label, the count and head of the options)
  written onto the step by `agentLegComparison`, so `expectedActual()` reads
  the leg like an `expectText`. Reconstruction is futile for it: a rewrite
  cannot make an option appear that the list enumerated twice without;
- model (`fail`, `contradicted`, and every record from before the field
  existed) → the plain `workflow agent failed:` error, `error` as before.
  `harnessOnly` (`src/cli/exit.ts`) reads `agent.endedBy === 'fail'` off the
  step's record — never the message — and words the case "no verdict — the
  agent's own account, unverified: <claim>" instead of "runtime error — the
  harness ended this case"; the case still scores blocked and exits 3.

The bundle schema (`src/artifacts/schemas.ts`, `AgentRecordSchema`) accepts
all three fields as the descriptive optionals they are and refuses an
`endedBy` outside `AGENT_ENDED_BY_VALUES` (it steers a wording), mirrored
from the engine's list and pinned equal by test. The reporter's wording
tables were not touched: the new error messages are what it already prints.

Tests: `tests/agent-guards.test.ts` ("the typed stop reason on the record
(no browser)" — the loop driven against a fake `Page` whose CDP session and
locators answer fixed data, so the REAL `#act` → `selectFromListbox` path
throws a REAL `ListboxOptionMissingError`: budget, fail with the claim,
finish, the listbox facts and the `cannot-offer` stop in one turn;
`listboxFacts` and `headingsOf` pure), `tests/full-workflow.test.ts` ("a
failed workflow leg is classed by the source of its evidence"),
`tests/exit.test.ts` (the wording and the exit code), and
`tests/artifact-schemas.test.ts` (a hand-written bundle with and without the
fields, the refused vocabulary, the mirror).

## A count is never a control (`QUANTIFIER_CONTROL`, 2026-09-08)

Live (PL_06_07 on HUMI SIT, run key `pl-06-07-v2-csv@2026-09-08T07:53`, leg
[11]). The authored goal was *"In the Condition searchable multi-select, select
more than one value: 'ePatient' and 'Tops care', so that both appear as selected
chips."* — and `goalOutcomes` read it as the pair `more than one` = `ePatient`.
`OUTCOME_EQ` fired on the colon, which there INTRODUCES the values to pick and
names no field; `CONTROL_LEAD` took the verb `select` and `CONTROL_TAIL` the
generic noun `value`, leaving the quantifier alone as the control. `outcomeShown`
then demanded one tree line carrying *more*, *than*, *one* AND `ePatient`, which
no page can render, so every `finish` was refused, the leg was sealed short of
its goal, the nine steps after it were skipped and the case ended `blocked` /
`status: error`. The page was correct throughout: the agent's own `read` observed
`text "ePatient Tops care", label "เงื่อนไข (Condition)*"` and the tree carried
both `ลบ ePatient` and `ลบ Tops care` chips.

Neither existing guard could reach it. The value side was a clean quoted
literal, so `DESCRIBED_GOAL_VALUE` (built for HIR-EC-009 leg [13]) never saw the
junk — it was on the CONTROL side. The colon-introduces-a-list rule (HIR-EC-009
leg [38]) drops a colon pair only when ANOTHER pair begins inside its value
span, and this sentence holds one pair. `NOT_A_CONTROL` screens sheet artifacts,
not quantifiers.

**The rule.** `QUANTIFIER_CONTROL` (`goal-evidence.ts`, consulted by
`cleanControl` after `NOT_A_CONTROL`): a control that is ENTIRELY a count —
a comparison or range (`more/less/fewer/greater than N`, `at least/at most N`,
`no more/fewer than N`, `up to N`, `N or more/fewer`), a determiner
(`all/any/both/each/every/either/some/several/multiple/many/various`, with an
optional `of the N`), or a bare number word — with at most one generic counted
noun after it (`value(s)`, `option(s)`, `item(s)`, `entries`, `choice(s)`,
`chip(s)`, `tag(s)`, `row(s)`, `field(s)`, …) is not a control, and its pair is
dropped. Dropping is the honest outcome the module already documents: the goal
names no field a page can show, `goalOutcomes` returns `[]`, and the record says
`settledBy: 'agent-claim'`. Nothing is invented — a "Condition" control is NOT
guessed out of the sentence.

Three narrowness choices, each load-bearing:
- **Anchored on the whole cleaned control.** `Multiple Choice`, `All Employees`,
  `Any Status` and `Number of Dependents` are field names and keep their pairs.
- **A bare determiner may take only a PLURAL counted noun**, because
  `Multiple Choice` is a real field name while `multiple choices` is a wording;
  a count phrase and `each`/`every` take the singular too (`more than one
  value`, `each value`).
- **`at` is optional in `at least/at most`**, because `CONTROL_LEAD` strips it
  as a preposition — `select at least two values: 'A'` reaches the screen as
  `least two values`.

**The value side is screened for the COUNTING phrases only**
(`COUNTED_GOAL_VALUE` in `cleanValue`): a sheet writes the same expectation the
other way round (`selected values = more than one`) and no tree renders that
either. Bare determiners are deliberately NOT screened there — `Status = All`,
`Coverage = Both`, `Type = Multiple` are real option labels, and dropping them
would trade a checkable pair for a claim. Anchored, so `Company = More Than One
Ltd` keeps its pair.

Why it cannot slow or fail a passing leg: pure string work in a leaf module, no
model call, no browser, no new state; it can only turn a pair the page could
never show into no pair, which moves a leg from "finish refused twice, leg
sealed" to "finish accepted on the claim". The one thing it gives up is that
`goalCitedValues` no longer cites a value for such a goal, so the value-hunt
judge (`AGENT_VALUE_HUNT_TURNS`) does not engage on it — the same position every
goal this parse cannot read is already in, and the activation and off-page
judges still bound the leg. Tests: `tests/goal-evidence.test.ts` (`a count is
never a control (PL_06_07, 2026-09-08)` — the verbatim goal, the wording spread,
the surviving field names, the value side, and the live pairs re-asserted
unchanged). No benchmark re-run was taken: a catalog run was live on the machine
and this change cannot move a turn count on a leg whose goal parses today.

## A verified undo answers the approval question (2026-09-09)

The mutation gate asked one question about an irreversible action — *did
someone say yes to this?* — and until now that was the only question it could
ask. So a delete on a run that had snapshotted the very tables it writes to was
held exactly as hard as a delete on a run with no safety net at all.

Live, be-high-ctx PL_09_01. The case exists to prove the Delete control opens
its confirmation. It ended `ERROR: workflow blocked (approval,
approval-missing)` having asked the application nothing, and the advice it
printed — add an `approved` entry — is a person's yes, which a batch run at
eight lanes has nobody to give.

A verified restore is a **different answer to the same question**. It is not
"someone approved this"; it is "this cannot outlive the run".

`MutationPolicy.reversible` carries it, and four rules keep it honest:

- **It is measured, never declared.** `run-cases.ts` sets it only where all
  three facts the restore itself needs are true: a baseline was taken, a write
  credential resolved (`restoreDbConfig()`), and tables came back
  `restorable`. A snapshot with no credential — the common misconfiguration,
  and this machine's own state until today — leaves it absent and the gate
  holds as it always did. `resolveBaselineMode` had already degraded that case
  to `snapshot`; this reads the same fact rather than a second opinion of it.
- **The manifest cannot assert it.** `MutationPolicySchema` is `.strict()` and
  gains no `reversible` key, so `WOWLIDATOR_MUTATION_POLICY` naming one is a
  parse error, not a licence. The env manifest is a person's word; the undo is
  the runner's measurement, and a typo in JSON must never license a delete.
- **It grants approval only, never capability or provenance.** The check sits
  after every capability and scope rule and before the host hook: a `deny`d
  category stays denied, and a delete scoped to a row nobody has observed stays
  held. An undo says the change will not outlive the run — never that the
  action was well-formed or allowed.
- **Its reach is recorded, because it is not total.** `tables` is the honest
  bound: a baseline covers the tables the plan named, and a mutation reaching
  beyond them is NOT undone by the restore. The gate approves on the strength
  of the undo it has and the record states how far that undo goes, so a reader
  judges the residue rather than infers it.

The restore stays **per-run** — snapshot before the suite, restore after it.
Per-case restore was considered and rejected: eight lanes share one database, so
restoring after each verdict would undo the other seven lanes' in-flight state,
and serialising to make it safe turns a ten-minute run into an hour.

Tests: `tests/mutation-policy.test.ts` ("a verified undo answers the approval
question"), including the empty-table, denied-category, unobserved-row and
manifest-rejection cases.
