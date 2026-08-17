# Tester & Evidence-Capture Implementation Spec

Derived from the forensic read of two real PB-02-01 runs. Every flaw below is
evidenced in a stored proof bundle, not hypothesised; every change names its
module, its shape, and its test.

> **Status: implemented.** All 18 changes (C1–C18) are in, each with tests, and
> the full suite is green. Two changes landed sharper than first specified:
> C17's "sampleSize < 2 ⇒ first-run" became the principled version — every
> non-pass status counts as a failure to streaks and flips, and `newly-broken`
> requires an *observed* prior pass (a 1-sample prior pass is real evidence and
> keeps the verdict); `consecutiveFailures` kept its documented "prior runs"
> meaning rather than including the current run, since wowUI, watch and the
> trend tests all depend on it. C2 pays one fresh fast attempt before
> declaring a known dead end, because the page may have changed state since.

## Evidence base

| Run | Date | Outcome | Bundle |
|---|---|---|---|
| `6d69c3ef` | 2026-08-14 | `dead-end`, 10/21 passed, 11 defects, 0 heals | `valst-output/proofs/6d69c3ef-….json` |
| `11f4e42e` | 2026-08-13 | `error`, 7/21 passed, 12 defects, 2 dead `goto`s | `valst-output/proofs/11f4e42e-….json` |

**What actually happened (run `6d69c3ef`):** the flow signs in once (steps 0–3,
all fast-path — the selectors are fine), then tries to *switch personas twice
more by re-filling the login form without navigating back to `/login`*
(steps 6–8, 11–13, 16–18 — all against `/workflows/probation/PB-001`, where no
login field exists). By step 19–20 the run reaches the HR-Admin page as the
wrong identity and the page shows **“ไม่มีสิทธิ์เข้าถึง · Access Denied”** — a fact
recorded nowhere except inside a *rejected* healer proposal
(`role=heading[name="ไม่มีสิทธิ์เข้าถึง · Access Denied"]`, confidence 0.10,
discarded). The report blames selectors; the page had answered with an
authorization failure.

## Flaw register

| # | Flaw | Evidence | Module |
|---|---|---|---|
| F1 | Persona switch authored without navigation — credential fills against a non-login page, three times | steps 6–18 | `generator/flow-author.ts` |
| F2 | No access-denied detection — 15 steps and 9 heal calls spent against a page already showing "Access Denied" | step 20 trace | `engine/runner.ts` |
| F3 | Identical failures repay full cost — the same 3-step block walked the full ladder + healer 3× with no memory | steps 6–8 = 11–13 = 16–18 | `engine/runner.ts` |
| F4 | Rejected heal proposals discard the diagnosis — the denial heading, the real field names ("Admin email", `[placeholder="Work email"]`) exist only as trace strings | steps 6–20 | `healer/jit-healer.ts` + `engine/proof-bundle.ts` |
| F5 | Healer transport failure recorded as page truth — "No object generated" (provider error) produced a dead-end that reads as "the control is absent" | step 5 | `healer/jit-healer.ts`, `providers/llm-factory.ts` |
| F6 | Echo variants slip past `sameSelector` into confidence scoring — proposals differing only by the ` i` flag were scored, not recognised as echoes | steps 8, 13, 18 | `healer/jit-healer.ts` |
| F7 | Vacuous absence passes — `expectHidden` passed twice while the case was already broken, counted as clean green | steps 10, 15 | `reporter/verdict.ts` |
| F8 | Defect inflation — 11 identical `high/functional` "Step failed" defects for two root causes; no clustering | defect list | `engine/proof-bundle.ts` |
| F9 | Verdict ignores captured page state — "could not resolve text=…" instead of "the page said Access Denied" | report for `6d69c3ef` | `reporter/verdict.ts` |
| F10 | Trend fabricates history — `newly-broken`, message "the previous run passed", with `sampleSize: 1` and a prior run that *failed*; `consecutiveFailures: 0` on a failing run | `trend` field | `history/run-history.ts` |
| F11 | Video offsets outlive the cut — recording ends at step 5 (23.8 s) but 15 later steps carry `videoOffsetMs` up to 128 s: dead "play from here" affordances | `video.endsAtStep=5` vs step offsets | `engine/proof-bundle.ts` + `reporter/html-reporter.ts` |
| F12 | Mid-run browser death filed as test failures — `Target page, context or browser has been closed` on two `goto`s, run continued, step defects filed | run `11f4e42e` steps 14, 19 | `engine/runner.ts` + `cli/exit.ts` |
| F13 | Empty network evidence on adjacent failures — fixed 3 s lookback attached calls to steps 5/11/16/20 but nothing to 6–8 | step `network` fields | `api/network-observer.ts` |

Ops note (not a code flaw): the healer role was routed to
`openrouter:google/gemini-3.6-flash`, whose structured output failed once in
this run. `wowlidator doctor` before long catalog runs.

## Changes, per module

### M1 — `src/engine/runner.ts` (tester core)

- **C1 · Denied-surface guard (F2).** After the free rungs fail and before
  `jit`: scan the AX tree headings/landmarks for denial patterns and consult
  the observer for the document's last status. On match — skip healing (same
  argument as the backend rung: a heal can only fail identically or repair
  onto the denial page), record a defect in a new `DefectCategory
  'authorization'` at `high`, and stamp the step's `pageContext` (C12). The
  guard must not fire for a flow that *meant* to test the denial page — same
  three-condition shape as `assertSessionHeld` (no goto in this run asked for
  a denied surface).
- **C2 · Negative resolution cache (F3).** Per-run map
  `origin+pathname :: selector` of dead-ended resolutions. A repeat lands the
  step in one attempt with `identical failure at step N` in its trace and no
  healer call. Never persisted — the page may change between runs.
- **C3 · Downstream marking (F3, F8).** After the first non-pass in a case,
  later non-passes get `ProofStep.downstream: true`. Defect attribution files
  one root defect; downstream failures become references on it.
- **C4 · Post-run timing re-check (hydration honesty).** In `close()`, before
  teardown, re-probe each dead-ended selector once at the healed timeout — the
  mirror of `#flagTimingHeal`. A selector that resolves *now* reclassifies its
  defect to `medium` "slower than the fast-path budget", not absence.
- **C5 · Fatal on closed target (F12).** `Target page, context or browser has
  been closed` becomes a fatal environment error like `SessionLostError`
  (teardown skipped — there is no browser to tear down in). `exitCodeFor`
  maps it to `EXIT.environment`. A dead browser mid-run is the harness's
  problem, never 14 application defects.

### M2 — `src/healer/jit-healer.ts` (+ `providers/llm-factory.ts`)

- **C6 · Structured rejections (F4).** Every rejected candidate is returned as
  `{proposed, confidence, reasoning, rejectedBecause}` and persisted on the
  step as `rejectedHeals` — today the diagnosis survives only as a trace
  substring. The report renders them (C15): a rejected proposal is what the
  model *saw on the page*, which is exactly the evidence a reader needs.
- **C7 · Echo check before confidence (F6).** Run `sameSelector()` (which
  already normalises the ` i` flag) against every candidate *first*; an echo
  is rejected as an echo with the follow-up ask, not scored.
- **C8 · Transport failure is unavailability, not absence (F5).** A provider
  error (`isKeyExhaustedError`, "No object generated", timeouts) raises a
  typed `HealUnavailable` outcome: the rung records
  `jit: unavailable (<reason>)`, one failover rotation is attempted, and
  `summary.healUnavailable` counts it. The step still fails — but the bundle
  never claims the page lacked the control when the machinery never got to ask.

### M3 — `src/generator/flow-author.ts` (authoring)

- **C9 · Identity-switch prompt rule (F1).** Switching identity requires
  signing out or an explicit `goto` to the sign-in page first, and the case
  should assert *who is signed in* after submitting (the account label), not
  only proceed.
- **C10 · Credential-fill lint (F1).** At narrowing time: a fill whose target
  looks like a credential (`password`, `email`+`Sign in` proximity) with no
  preceding login-surface `goto` in the same case is rejected onto
  `GeneratedSuite.rejected` with the reason — the same surfacing as
  assertion-less cases, never silent.

### M4 — `src/engine/proof-bundle.ts` (evidence)

- **C11 · Defect clustering (F8).** Cluster key `action + selector + first
  error line`; one defect with `occurrences` and step references. The
  frontend/backend reconciliation test extends to clustered counts. This run's
  11 defects become 3 (radio count, login block, exemption check).
- **C12 · `ProofStep.pageContext` (F4, F9).** ≤5 lines of headings/landmarks
  from the AX tree *already captured* for the heal — no new capture, no new
  cost. Stamped on failed steps only.
- **C13 · Video offset reconciliation (F11).** `setVideo()` knows
  `durationMs`; any `videoOffsetMs` beyond it is nulled at seal time. Test:
  no bundle may carry an offset past its recording's end.

### M5 — `src/reporter/verdict.ts` + `html-reporter.ts`

- **C14 · Page state outranks mechanics (F9).** When a failed step carries
  `pageContext`, the verdict leads with "the page was showing …" before the
  resolution trace. Captured text stays quoted verbatim, `lang=""` rule
  unchanged.
- **C15 · Rejected heals rendered (F4).** Under failure evidence, ranked after
  the escalation trace; each with its confidence and why it was refused.
  New badge ⇒ new `GLOSSARY` entry (the existing test enforces this).
- **C16 · "Passed, in doubt" (F7).** An absence assertion that passes *after*
  a prior non-pass in the same case gets a doubt badge — the same
  epistemology as wowUI's healed-pass marker: true, but not evidence of the
  feature.

### M6 — `src/history/run-history.ts`

- **C17 · Trend honesty (F10).** `newly-broken` requires an *observed* prior
  passing sample. `sampleSize < 2` ⇒ `first-run`. `consecutiveFailures`
  includes the current run. The message may never assert what the sample does
  not contain — this run's exact shape becomes the regression test.

### M7 — `src/api/network-observer.ts`

- **C18 · Window since previous step (F13).** The evidence window runs from
  the end of the previous step rather than a fixed 3 s lookback, capped in
  entry count. The correlational wording ("while this step was waiting")
  stays — the window widens, the claim does not.

## Rollout order

1. **Evidence first, pure tier** — M4 (C11–C13), M5 (C14–C16), M6 (C17):
   unit-testable against stored bundles, zero engine risk.
2. **Engine guards** — M1 (C1–C5), browser tier.
3. **Healer** — M2 (C6–C8), unit tier via `MockLanguageModelV4` + one browser test.
4. **Authoring + observer** — M3, M7.

**Acceptance:** replay PB-02-01. Expected: the run stops paying after the
first login-block failure (C2), the verdict says the HR-Admin page showed
Access Denied (C1/C14), ≤3 clustered defects (C11), no video offset past the
cut (C13), and the trend says `first-run`/`still-broken` — never a pass that
did not happen (C17).
