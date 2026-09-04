# CLAUDE.md — run history, watch and quarantine

Split out of the root CLAUDE.md (2026-08-24) so this loads only when working under
`src/history/`. Same authority as the root file; the root keeps the map of the whole system.

## Unattended runs and quarantine (`src/watch.ts`, `src/history/quarantine.ts`)

`wowlidator watch` is a loop around machinery that already existed: `analyseTrend` over the append-only history already knows what "changed" means, so watch computes nothing new. **It notifies only on a transition** (`classifyChange`) — green→red, red→green, newly-flaky — because a notification that fires every run gets muted, and a muted notifier is worse than none. `now-flaky` is a change in its own right even when the pass/fail result is unchanged, for the same reason `flaky` outranks pass/fail in the trend module.

**The notify seam is a command, not an integration.** `--notify <cmd>` runs it with the verdict as JSON on stdin. A Slack client inside a test runner would be a second thing to maintain, a second place for credentials, and useless to anyone whose chat tool is different. `runNotify` never throws and never blocks the loop — a broken notifier is a broken notifier, reported on stderr, not a reason to stop watching.

**Quarantine (`--quarantine-flaky`) never engages by itself.** Silently downgrading a flaky failure is precisely the "green suite that checks nothing" outcome `src/history/` exists to prevent, so entry is opt-in and a *consistently* failing test is refused with a reason. Leaving needs `CONSECUTIVE_PASSES_TO_CLEAR` trailing passes read from real history, not the trend verdict: `analyseTrend` calls a test flaky on two flips in a twenty-run window, which stays true long after it settles, so the verdict alone could never let anything out. A quarantined bundle carries `ProofBundle.quarantined`, and every consumer — HTML, JUnit (`<skipped>`), CTRF, the suite index, the exit code — reads that one flag, because a quarantine only some of them knew about would be worse than none.

## Run history and flake detection (`src/history/run-history.ts`)

Append-only JSONL. A single bundle answers "did this pass"; it cannot answer *is this newly broken or has it been broken for a week*, which demand completely different responses.

`analyseTrend` returns `first-run` / `newly-broken` / `still-broken` / `newly-fixed` / `stable` / `flaky`. **`flaky` outranks the pass/fail verdicts on purpose** — a suite that alternates is untrustworthy whichever side the coin landed on this time, and reporting "passed" would hide exactly that.

**Every non-pass status is a failure to a trend, and "the previous run passed" requires an observed pass.** The streak walk once tested the literal status `'failed'`, so an `error` or `dead-end` predecessor read as "not a failure" — and a failing run was declared `newly-broken` ("the previous run passed") over a prior that had failed. Streaks and flips now compare pass/non-pass, and `newly-broken` fires only when the last prior sample actually passed. An `error` → `dead-end` history is two ways of failing, not a flip toward `flaky`.

**Heals that mask timing bugs** (`#flagTimingHeal`): after a successful heal, the *original* selector is re-checked. If it now resolves, it was never broken — it was slower than the 2s fast-path budget, and the heal is hiding a race condition permanently. That becomes a `medium` defect instead of silent success.

History and coverage are both diagnostic: failures inside them are swallowed and must never change the verdict of the run they describe.
