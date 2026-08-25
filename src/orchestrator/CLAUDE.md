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

## The agent's read-only database access (`dbCount`)

`AGENT_ACTIONS` includes `dbCount`: count the rows of a table (in `selector`) matching equality pairs (in `value`, `"column=value, column2=value2"`), through `RunOptions.dbProbe` — which the runner wires to its own `DbActions.probeCount`, so the agent gets the same table/column grounding and the same read-only session as every `expectDbRow`, and nothing else. The observed count rides the history line as the action's note ("dbCount benefit_management.benefit_plan — ok (observed 3 row(s))"), so the model reasons from what the database actually said and the record shows the evidence — the same "what the agent claims is never the evidence" rule, satisfied by making the observation itself the record. It cannot write, which keeps the vocabulary's safety argument intact. When no database is configured the probe is simply absent and the action fails with advice ("verify through the page instead"), never a connection error. Born from PL_03_03 (2026-08-25): a claim of the form "the count in the box matches the database" was authored as a hardcoded `count: 0` because nothing could read both sides; an agent goal can now hold the box and the table together.

## Looking again is not a stall, and three turns was not evidence

Measured the day after the turn ceiling went (be100, 2026-08-25, 22 error runs with a bundle): 17 ended in the loop's own stops, not on the page. Seven were `stalled: repeated "scroll "` / `"wait "` — the model asked to look again, was told it already had, insisted once, and the run was recorded as a harness error with the goal's control on screen. Ten were `nothing succeeded in 3 consecutive turns`, most on a dropdown leg where the option's role was guessed three ways (`option`, `menuitem`, `text=`) at 1.5 s a miss. Three were an agent reasoning from `/en/consent` after a mid-run goto was redirected there.

- **`IDLE_ACTIONS` (`wait`, `scroll`) are never a stall.** They cannot change the application, so repeating one is not the shape the repeat guard exists for (the same fill into the same field, four times). A repeated idle action is refused once with the reason (the tree lists off-screen elements too), then let through — and the turn it spends counts toward `AGENT_NO_PROGRESS_TURNS`, because it is never progress either. A loop that only looks still ends; it ends on the judge, not on the second look.
- **`AGENT_NO_PROGRESS_TURNS` is five, and counts turns in which nothing *advanced*** — no ok click/fill/press/hover/goto. Three was tuned when a miss cost the 8 s action timeout; once `#target` made a miss cost 1.5 s, three turns was four seconds of evidence, which is the ordinary price of finding out how a widget is built, not proof the page cannot do it.
- **A `wait` on a page whose network is already quiet pays `WAIT_SETTLE_MS`.** The idle wait returns at once there, and a wait that does nothing costs a model turn to do nothing. Paid only when the idle wait had nothing to wait on, so settled pages are not taxed on every wait (the 2026-08-24 concern).
- **`scroll` goes through `#target` and the grounding refusal.** A row a virtualised table has not rendered is "no element matches" in 1.5 s, with the reason, not a 5 s `scrollIntoViewIfNeeded` timeout the next turn cannot read.
- **The consent-gate rung runs on every turn, not only in the preflight.** A goto redirected to `/en/consent` (the session had not accepted; the preflight's 5 s poll had found no accept control on a page still hydrating under an eight-way run) is cleared without a model turn, and the agent is returned to `intendedUrl` — the page its last goto asked for, else the step's own page — never left on the app's home. The model is never asked to decide from the gate.

## A destructive click must name its row

Live (be100 PL_03_18, 2026-08-25 06:28): the goal named the plan to delete, the agent could not find its row, clicked `role=button[name="Delete" i] >> nth=0` — the first Delete on a 75-row table — confirmed the dialog, and the step's own network evidence shows `DELETE /api/benefit-plans?planId=TH_MED_001`. Its reasoning said it was the right row. On an authoritative database that delete is permanent, and PL_02_02 (re-authored 45 minutes later against that plan's name) dead-ended on every run after. The prompt's "no destructive action unless the goal asks" was satisfied on paper.

`unscopedDestructiveClick` (`agent-guards.ts`, pure) is the structural form: when the goal names an identifier (`PL_03_15_16_17_18`, `TH_MED_001`) and the click's target control is destructive by name (`DESTRUCTIVE_NAME`), the selector must carry one of those identifiers — or sit inside a `role=dialog`, the confirmation of a delete already scoped. Refused on the first ask with the scoped shape shown; on the second ask it is **never acted on**: recorded as a failed action (`REFUSED` in the history), the turn counts as no progress, and the loop goes on — the right row may still be found, or `fail` said honestly. A goal that names no identifier has nothing to scope to and is left to the prompt.
