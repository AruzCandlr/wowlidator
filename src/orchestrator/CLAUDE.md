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

## The queue governor, and why it is gone (retired 2026-09-11)

One agent per suite run governed parallel queuing from 2026-08-28
(docs/parallel-run-spec.md §2.4) — event-driven turns, a hard budget, hold /
shrink-pool / db-read / db-write tools. From 2026-08-31 its DEFAULT was
already deterministic (`RuleGovernorModel`), because across two live suites
every LLM turn concluded `idle` while restating a set-intersection the
scheduler had already computed. The whole subsystem was removed on
2026-09-11, along with the `governor` role.

**The reason to record is that its own contract predicted this.** It was
written as *"an OPTIMISER, never a dependency: absent, disabled, erroring or
out of budget, the deterministic scheduler runs exactly as it would alone"* —
so removal could only cost advice, never a verdict. The measurement matched:
in 18,704 recorded model calls the `governor` role had **zero** real turns,
every one of its 35 ledger rows being `wowlidator doctor` proving the model
id still resolved, and the rules governor's own output was a restatement of
what `case-plan.ts` already knew.

What went with it: `heldCases` (nothing else ever wrote to it), the pool
override (the pool is `--concurrency` again), the `queue-blocked` and
`case-ended` events, and the db-read/db-write tools — the only place in this
repo where a model could issue SQL, now absent rather than gated. What
stayed: every deterministic rule it advised — the section scheduler, the data
locks, the interference detector and the dependency gate below.

**The lesson for the next optimiser.** A containment rule strong enough to
make a subsystem safe ("nothing changes if it is absent") is also strong
enough to make it removable, and the usage ledger is what turns that from an
argument into a measurement. Build the rule; then check whether the thing
inside it ever fires.

## A finish is accepted on the page's word (S1 of the 2026-08-28 agent-flaw audit)

Audit of be100's latest run: 20 of 22 agent legs on PASSED cases were settled by the agent's own `finish` text — "shows 1–75 of 75, *meaning* 100 was selected"; "picked, *as confirmed by* the successful clicks" — inference presented as observation, never checked. The "what the agent claims is never the evidence" rule had been enforced on failures only. Now: `goalOutcome` (`goal-evidence.ts`, pure) reads the checkable end state a goal names (`set X to Y`, `X = "Y"`); on `finish` the loop re-reads the live tree and `outcomeShown` must find it — on one line (`button "Status: Inactive"`) or as a label→value neighbour within three lines. A miss is refused ONCE with what the tree shows; a second insistence records `claimed finish, but the page does not show X = Y` and `success: false`. A goal naming no state falls through, and the record says so: `AgentRecord.settledBy` is `observed-state` (with the evidencing line) or `agent-claim` (with the bare reasoning), so an all-claim run is visible as one in the report. New action **`read`** (idle, never progress): the harness reports a control's text/value/checked/expanded/disabled into the history at $0, so the agent learns whether a choice took instead of clicking again to find out — the repeat-guard stalls on Country and Rows-per-page were exactly that.

## A separator the page pads is the same value (2026-09-11, PL_06_10)

Live (`be-sit-high-opusheal-th-20260911-175757`, HUMI SIT). The agent set
Benefit Type correctly and the re-read tree said so —
`text "Reimbursement : Employee/HR"` — but the goal spelled the value
`Reimbursement: Employee/HR`, without the space humi draws before the colon.
`foldValue` folded case, dash variants and whitespace *around dashes* and
nothing around a colon, so `shownAs`' bounded-substring test failed and the
finish was refused twice: `agent claimed finish, but the page does not show
Benefit Type = "Reimbursement: Employee/HR"`. The agent's own reasoning had
already noted the two spellings were one value.

What it cost, and why a false "not seen" is not a cheap error: the case sealed
**ERROR at 14 of 20 steps**, with no verdict on the application at all;
`closesDependentTail('workflow', …)` — correct, and not the bug — inherited the
false premise and skipped steps 13–17, one of whose intents read *"Independent
of the agent: the duplicate Plan ID is still the value being submitted"*; and
the post-run diagnosis filed **the navigation agent at 72% confidence** for a
value it had applied.

**The rule.** `foldValue` now canonicalises the spacing around a colon
(`a:b`, `a :b`, `a : b` → `a: b`) and unifies the full-width `：` a Thai or CJK
page draws, exactly as it has folded dash spacing and dash variants since the
ec10 reruns.

**Why a fold of this shape cannot loosen the page side.** `shownAs` bounds a
spelling on anything that is not a letter or digit, so `:` is already a word
boundary on both of its sides; normalising whitespace next to such a mark
cannot move a single boundary, because no letter or digit is ever brought next
to another and nothing but whitespace changes. The only way a punctuation fold
could join two tokens into a value the page does not hold is a canonical form
that **deletes** a space — so both canonical forms here keep one (` - `, `: `).
The fold also makes a padded page answer exactly as an unpadded one, no looser:
where the whole-word rule already conceded `Reimbursement: Employee` inside
`Reimbursement: Employee/HR`, it now concedes it for the padded spelling too —
the same concession, not a new one.

**Weighed and left out** (the reasons are in the function's comment, so the
next person does not re-derive them): `/` — the canonical `/` would delete a
space, and `valueAppearsAnywhere` folds the whole tree into one line, so it
could join two lines' tokens; the alternative ` / ` would break
`valueSpellings`' `code - label` parse, whose code class holds `/`. Both sides
of this case write the slash tight, so it costs nothing today. `,` and
`(`/`)` — no observed padding, and both carry meaning the number and alias
parses read. `;` — no observed case. `%` — a unit, not a separator; number and
currency shaping is `src/engine/normalise.ts`' job and it already does it.

**The duplicate normaliser, unedited.** `src/engine/normalise.ts` has its own
`foldValue`, documented and pinned (`tests/engine-helpers.test.ts`, "foldValue
is a superset of goal-evidence's") as a superset of this one. Its corpus holds
no colon, so it is still green — but the superset claim is now false for a
padded colon, and the execution plane's comparators (`expectText`,
`expectValue`, the entry rung's read-back, the listbox pick's read-back) still
score `Reimbursement : Employee/HR` against `Reimbursement: Employee/HR` as a
mismatch. Same live bug, one plane over. Left to `src/engine/`.

Pinned in `tests/goal-evidence.test.ts` ("a padded colon is the same value").

## The judge may not overrule a human record (S2)

`runFlow`'s auto-review: when the sheet's own Actual Result (`generation.knownResult`) exists and the judge's ruling contradicts it, the ruling is withheld with the disagreement on `notes` and the run stays `needs-review` for a person. PL_04_08: a human passed the case by hand; the judge ruled "failed" at 0.9 on "still visible contradicts hidden" without asking whether "not shown" meant hidden, disabled or inert. A machine's confident reading of two strings does not outrank a tester's hands.

## A dependency wait is the scheduler's (2026-09-04, EC catalog run `ec-runtest-csv@…09-33-38`)

Read from the panel's job-16 log and its ledger (39 cases, 10 lanes). Two shapes
of "depends on" refusal, neither of them the scheduler's fault:

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
in the deterministic scheduler because a dependent's verdict is correctness,
and nothing advisory has ever been allowed to move it — a rule that outlived
the queue governor that first made it necessary.
