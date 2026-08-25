# Consent-Gate Recovery Spec

Derived from the post-mortem of the BE_Test2.csv pass authored 2026-08-20 11:52 (`openrouter:google/gemini-3.6-flash`, 10 flows): 7 passed, PL_02_03 and PL_02_05 `error`, PL_02_09 `dead-end` — every one of the three from the same root cause, and the one flow that met the identical hazard and passed (PL_02_06) demonstrates the exact recovery this spec makes deterministic.

> **Status: implemented** (branch `backend-quest-for-the-grail`, 2026-08-20) — F1–F4 landed; `tests/consent-gate.test.ts` carries all five required tests (browser tier included). Evidence citations: proof dir `valst-output/proofs`, runIds `c0960425`, `a11a622f`, `43477b88`, `a6a80306`, `5df82b8a`; the passing contrast is `d52a7430`.
>
> Two things the implementation learned past the spec: **the gate has a THIRD shape** — the goto lands on the target URL and the client guard bounces to `/en/consent` a beat *after* `domcontentloaded`, so an immediate content check sees nothing; the recovery therefore pays a short bounce-window (2s) **only** when the page was on a consent URL before the goto or is on one now, which taxes no ordinary navigation (measured live: the first re-run of PL_02_09 still died before this; passed the gate after it). And **the live re-runs then converged on the truth the gate had been hiding**: PL_02_09's breadcrumb claim fails honestly because the app renders "Benefit Plan Catalog" where the sheet says "Benefit Plans", and PL_02_03's workflow leg now completes in ONE agent turn (`click "Create Plan"` — the button was always on the recovered page), leaving only an `expectModal "Create Plan"` vs the app's real dialog title "Create Benefit Plan". Both remaining reds are catalog-vs-application wording mismatches — findings, not harness failures.

## The evidence

The application under test (cnext-hrms-fortest) gates a first sign-in per browser context behind a PDPA consent screen, and the gate is **client-side, keyed on localStorage** (`cnext-consent-gate`). Three facts about it, all measured in this run, decide the design:

1. **The gate can render ON the URL the flow asked for.** PL_02_03's `goto http://localhost:3000/en/admin/benefits/plans` landed with the URL unchanged and the page heading reading *"Consent to the Collection, Use, and Disclosure of Personal Data (Revised)"* (`c0960425`, workflow step: `urlBefore=/en/admin/benefits/plans`, `headingsBefore=[Consent…]`). **URL-based detection cannot see this gate.** Detection must read the page.
2. **Accepting the gate abandons the deep link.** After "Accept and continue" the app navigates to its home landing (`/en/admin/system`), not to the page that was asked for (`a11a622f` agent trail: `wait /en/consent → click Accept → wait /en/admin/system`). Whoever accepts must re-navigate, or every later step runs against the wrong page.
3. **Parallel isolated contexts each hit the gate.** `--concurrency` gives each case its own context (empty localStorage), so the gate is not a first-run curiosity — it is the *steady state* of every parallel suite against this class of application.

## How each red flow died

| Flow | Status | Chain |
|---|---|---|
| PL_02_03 (`c0960425`) | error | goto → gate rendered on the plans URL → the `workflow` step's agent accepted consent, was dumped on `/en/admin/system`, **re-navigated by menu label** to `/en/admin/system/benefit-catalog` (the wrong page), honestly reported "Create Plan does not exist", and the `expectModal` after it failed. The button exists — on the page the flow asked for and the agent left. |
| PL_02_05 (`a11a622f`, re-run `43477b88`) | error ×2 | Identical: accept → home landing → menu-label guess → `benefit-catalog` (even wandering into the `/th/` locale) → 8 turns clicking cells on a page with no Insert button → "gave up after 8 turns". |
| PL_02_09 (`a6a80306`, re-run `5df82b8a`) | dead-end ×2 | The model authored the consent accept **after** the first breadcrumb assertion instead of immediately after sign-in; the assertion ran against the gate and failed, the accept then landed the run on `/en/admin/system` with **no re-navigation**, and both remaining breadcrumb steps dead-ended against the home page. Its `expectUrl "/en/admin/benefits/plans"` failure even carries the misleading "derived from a label" hint — the expectation was right; the page was wrong. |
| PL_02_06 (`d52a7430`) | **passed** | Met the same gate on the same URL. Its agent's first two actions: `click "Accept and continue"` → **`goto` back to the exact URL the step started on**. Everything after ran on the right page. |

The whole difference between the pass and the three failures is whether recovery ended with a return to the page the flow had asked for. Today that is left to chance twice over: the authoring model's step ordering, and the agent's mid-goal judgment. Both are requests; neither is a guarantee.

## The fixes, in cost order

### F1 — Runner-level consent-gate recovery on `goto` (deterministic, $0) — the load-bearing one

`SmartRunner.goto` (and the bootstrap's re-navigation) gains a post-navigation check: if the page the goto landed on **shows the consent gate**, accept it and re-issue the same goto once.

- **Detection is content-based, never URL-based** (fact 1): the name-gated accept control `acceptConsentGate` already knows (`/^(accept and continue|accept|agree|i agree|ยอมรับและดำเนินการต่อ|ยอมรับ)$/i`) **plus** a consent-shaped heading (`/consent|pdpa|personal data|ความยินยอม/i`) — both required, so a page that merely contains an "Accept" button (a cookie banner has its own rung) is not treated as this gate.
- **Reuses `acceptConsentGate` from `src/engine/sign-in.ts`** — the procedure already exists and is browser-tier tested; today it only runs inside `#bootstrapSession`, which is skipped for every flow that signs in itself (`signsInItself`) — exactly the flows this run authored. The recovery must run regardless of who established the session.
- **Re-issue the goto** after accepting (fact 2). Landing wherever the app dumps us is the failure mode, not the recovery.
- **Never when the goto asked for the gate itself** (`CONSENT_GATE_URL_PATTERN` on the *requested* URL): a flow that means to test the consent page keeps its subject. Same shape as the session guard's "a flow that means to be on a sign-in page is never stopped".
- **Once per goto** — a gate that re-renders after acceptance is an application finding, not a loop.
- **Recorded three ways**, the `#bootstrapSession` convention verbatim: `consentAccepted` on the goto's step detail, a run note, and a `usability`/`low` finding saying to author the accept into setup.

This alone un-reds all three cases: PL_02_03/05's workflow steps would begin on `/en/admin/benefits/plans` with the Create Plan / Insert buttons present, and PL_02_09's breadcrumb assertions would run against the page that has the breadcrumb.

### F2 — Agent guard: an interstitial cleared mid-goal returns to the step's own page (deterministic, $0)

PL_02_06 vs 02_03/05 is a coin flip inside `WorkflowAgent`; make the winning side structural. In the loop (`agent-guards` + `workflow-agent`):

- The workflow step's **starting URL is the implicit anchor** when the goal names no destination (`goalDestination() === null`).
- When an accept-shaped click (the `CONSENT_ACCEPT_NAME` list) navigates away from the step's starting URL **before the agent has made any forward progress** (nothing acted yet but gate-clearing, waits and scrolls), **the loop itself re-navigates to the starting URL** before the next model turn. Deterministic, spends no turn, and removes the menu-label guess that sent two flows to `benefit-catalog`. The progress guard is what separates the two accept shapes: an accept fired first thing is an obstacle in front of the step's own page (return); one fired after the agent already advanced is a gate met ALONG a journey (returning would destroy the journey — the two-interstitials fixture proved it, live, as a suite regression).
- History line says so: `cleared an interstitial — returned to <urlBefore>`. The model sees where it is, not where the app dumped it.
- Guarded like everything else in the loop: only when the goal names no destination of its own (a goal that *ends* elsewhere keeps its ending), and at most once per distinct interstitial (`decisionKey` set), so a gate that will not stay cleared becomes a recorded stall, not a loop.

### F3 — Authoring: a misplaced consent settle is repaired mechanically (the `groundCredentialFills` move)

PL_02_09's shape, caught before it runs: walking `[...setup, ...steps]`, a consent-accept step (a `click`/`clickIfVisible` whose name matches the accept pattern) that appears **after** the first post-login `goto` or assertion is spliced to immediately after the login block, and a re-`goto` of the following navigation target inserted after it. Disclosed on `notes` and `onLog`, never silent; no re-ask spent — a step reordering should never cost an authoring call. The prompt already states the rule ("settle a consent gate with the authored `clickIfVisible`" immediately after sign-in); this is the guarantee behind the request, and F1 remains the backstop for the flows already written to disk.

### F4 — Wording: a workflow failure on a page the flow never asked for names the displacement

`agent gave up after 8 turns` / `goal is unreachable` on a step whose `urlAfter` differs from its `urlBefore` should say so in the error headline: `…— note: the agent ended on /en/admin/system/benefit-catalog, not the page the flow asked for (/en/admin/benefits/plans); the control may exist there`. The `expectModal` that follows is already `downstream`; the note is what routes a reader to F1's finding instead of filing "Create Plan is missing" against a page that has it.

## What this deliberately does not do

- **No model call anywhere.** Detection is a heading plus a name-gated button; recovery is a click and a repeated goto. This is execution-plane work.
- **No generic "dismiss anything that looks like a gate".** The accept pattern stays the same short, name-gated list the bootstrap uses; an unrecognized gate still fails honestly and shows up in `pageContext`.
- **No change for flows that test the gate.** Both F1 and F2 are conditioned on the flow/goal not naming the gate as its subject.

## Tests the implementation must carry

1. Browser-tier (fixture with a localStorage-keyed gate that renders in place on any URL and bounces to `/home` on accept): a `goto` through the gate lands on the requested page, with `consentAccepted` on the step detail and the `usability/low` finding filed. — F1
2. The same fixture, flow whose goto targets the consent URL itself: untouched, no recovery. — F1's exemption
3. Agent loop (scripted model): after an accept-click lands on `/home`, the next observation's URL is `urlBefore`, no model turn spent on the return. — F2
4. Authoring (pure): a consent accept found after the first post-login assertion is spliced after the login block with a re-goto, disclosed on `notes`. — F3
5. The recovery runs at most once per goto: a gate that re-renders fails the step with the gate in `pageContext`. — F1's loop guard
