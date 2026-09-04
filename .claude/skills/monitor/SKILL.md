---
name: monitor
description: Monitor the wowlidator run currently in flight (the panel's running job, or the last one) and diagnose what makes it slow — which phase, which model call, which step or agent leg — then name the optimizable part whose change stays local. Use when the user says "/monitor", "monitor the run", "why is this run slow", "inspect the current run", "find the slow part".
---

# Monitor the current run and find the slow part

The panel (`npm run ui`, port 4600) spawns every run as a job and keeps its
stdout/stderr lines. That log is the only place the timings live: `[llm HH:MM:SS] → role · model · request #N` / `← … · 12.3s · in/out tokens` for every model call, `[cN] ✓/✗ [i] action selector (ms)` for every step, and `[cN]   ✓ agent: …` for every agent turn.

## Procedure

1. **Find the job.** `node .claude/skills/monitor/joblog.mjs latest` prints the running job (or the last one), its command line, the timeline, the model-time totals per role, and the slowest steps. `… latest all` prints every line; `… job-N` picks a job. The panel API is `GET /api/jobs` and `GET /api/jobs/<id>` if the script cannot answer. `ps -eo pid,etime,command | grep dist/cli.js` shows the child and how long it has run. The jobs run `dist/cli.js`, so a code change needs `npm run build`; the panel serves its UI from source and needs a restart for UI changes.
2. **Wait, don't poll every second.** A generator call is 1–4 minutes on opus; poll every 30–60 s with a bounded loop (`for i in $(seq 1 N); do …; sleep 30; done`), never a foreground `sleep` alone.
3. **Attribute the time.** Wall clock splits into: authoring (generator calls + lint refusals + re-asks), the review/value-resolver calls, the step ladder (a failing assertion walks 5 rungs ≈ 17 s; a failing action ≈ 1.5–2 s), agent legs (turns × 3–9 s of sonnet each), and DB baseline/report writing. Sum each from the log; the biggest bucket is the answer, not the longest single line.
4. **Then read the code path for that bucket only**, and propose a change that is local to it: `src/generator/flow-author.ts` (attempt loop, lints, `mergePriorCases`, `priorCases`, `singleCase`), `src/orchestrator/workflow-agent.ts` (the no-progress judge at `advanced`, `AGENT_NO_PROGRESS_TURNS`, `IDLE_ACTIONS`), `src/engine/runner.ts` (the ladder, `DEFAULT_FAST_TIMEOUT_MS`, `stepPatience`), `src/cli/run-cases.ts` (suite loop, concurrency).
5. **Report**: a table of phase → seconds → cause, then the one or two changes that are contained (say which file/function and why they cannot slow a passing run), then what is NOT fixable locally (model output speed, an app that really is missing the control).

## Known shapes (measured 2026-09-03, ec09 HIR-EC-009)

- **One prompt, many claims → one 190 s opus answer, refused, re-asked whole.** Fixed: the retry rewrites only the refused cases (`priorCases`), and `WOWLIDATOR_GENERATOR_RETRY_MODEL` can put re-asks on a faster model.
- **Model split one row into 4 cases.** Fixed: `singleCase` when a table row is authored; the fold logs `folded back into one`.
- **`[RECORD ONLY]` read as an "ONLY" exclusivity claim** → a false refusal, and the retry then asserted the placeholder. Fixed in `exclusivity.ts`.
- **Agent leg hunting a control on the wrong wizard step**: 35 turns / 73 s because clicking a section header is an ok engaging action and resets the no-progress judge every time. The harness's own failure text already says "the field is probably on a later step". Candidate change, local to `advanced` in `workflow-agent.ts`: a click on a control already clicked in this leg on the same page does not count as progress unless the tree changed.
- **Assertions after a failed step each wait the full ladder** (8 × 16.8 s here). Candidate change, local to the runner: once a step in the case has failed, later `expect*` steps take one fast rung — the reading is the record, the wait cannot change the verdict.
