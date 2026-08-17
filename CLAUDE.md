# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What wowlidator is

An in-house hybrid UI automation framework. The organising idea is **decoupled fast execution with JIT healing**: keep the hot path free and fast, and pay for intelligence only at the moment something breaks.

Two planes, and the boundary between them is the whole design:

- **Execution plane** (`src/engine/`) — plain Playwright over CDP, short timeouts, $0 per action.
- **Control plane** — an LLM, invoked only where determinism runs out:
  - `src/healer/` repairs a selector *after* it has already failed
  - `src/generator/` writes the tests in the first place by reading a page
  - `src/orchestrator/` drives the browser through unknown interstitials

  All three go through the **Vercel AI SDK** (`ai`), never a vendor SDK, so
  provider choice is config rather than code. Routing lives in `src/config.ts`;
  instantiation in `src/providers/llm-factory.ts`.

`src/api/` is a **second execution plane, not a second control plane**: HTTP the test makes deliberately, plus passive observation of what the page itself requests. It costs no tokens and calls no model — see [Backend testing](#backend-testing-srcapi) below.

`src/reporter/` turns a run into a standalone HTML report, and an MCP stdio server (`src/mcp/`) exposes the whole thing to developer tooling and to Claude. `src/context/` is a fourth, non-AI source the generator can optionally read from: a static index of the *project* (routes, components, existing tests, and — when a spec exists — API operations), as opposed to the one *page* the AX tree shows — see [Repository context engine](#repository-context-engine-srccontext) below.

**The rule that keeps this honest:** every control-plane module sits behind a small injectable interface — `HealerModel`, `GeneratorModel`, `AgentModel`. Each is one or two methods. That is what lets the entire test suite run offline, and it survived a full provider migration without a single call site changing shape. The `Llm*Model` classes are the only place a `LanguageModel` is constructed; nothing else imports a provider package.

## Commands

```bash
npm run ui            # the control panel: every command below, in a browser, with a manual
npm run ui -- --wow   # wowUI: the same server at /wow — runs, verdicts and the proof behind them
npm run cli -- go <flow.json | url | "what to test">   # one command, start to report
npm run cli -- catalog cases.xlsx --claims-only        # what does this document claim? no browser
npm run cli -- catalog cases.xlsx --claims c.json --url <page> --run   # prove the approved ones
npm run chrome        # start Chrome by hand (the CLI does this itself now)
npm test              # unit tests always; browser tests only if CDP is up
npm run typecheck     # src + tests (tsconfig.test.json covers both)
npm run build         # emit dist/
npm run cli -- run examples/login.flow.json
npm run cli -- generate http://localhost:3000/some/page --run
npm run cli -- context build          # index the project into .wowlidator/context-graph.json, no model call
npm run cli -- run examples/login.flow.json --repair   # self-repair on failure, up to 3 attempts
npm run cli -- run login.flow.json --repair-investigate  # agent reinvestigates each failure live first
npm run cli -- run login.flow.json --repair-regenerate   # a fix may rewrite the flow from the failed step on
npm run cli -- context build --openapi ./openapi.yaml  # index endpoints alongside the code
npm run cli -- generate --api                          # write API tests from that spec (policy defaults to forms)
npm run cli -- run checkout.api.json                   # browser-free: never opens Chrome
npm run mcp           # serve MCP over stdio
```

Single test:

```bash
npx tsx --test --test-name-pattern "heals a drifted" tests/smoke.test.ts
npx tsx --test --test-name-pattern "navigates two interstitials" tests/full-workflow.test.ts
```

`tests/smoke.test.ts` covers v1 (cache, ladder, healer contract). `tests/full-workflow.test.ts` covers v2 (generation, agent, reporter). `tests/context-engine.test.ts` covers the context engine — entirely unit-tier, since it's file-walk-and-parse with no model or browser involved. `tests/mock-data.test.ts` covers mock data — `mock-data.ts`/`LlmDataModel` at the unit tier, the `fillRetry` loop at the browser tier (needs a real page). `tests/modal.test.ts` covers modal/dialog detection — entirely browser-tier, since detection is `Locator`-based with nothing to unit test in isolation. `tests/flow-repair.test.ts` covers runtime script evolution — `LlmFlowRepairModel`'s schema-narrowing contract at the unit tier, `FlowRepairLoop` against a real browser at the browser tier via a scripted stub (no LLM key needed, same reasoning as `modal.test.ts`). `tests/api.test.ts` covers backend testing across both tiers: redaction, call classification, variables, OpenAPI ingestion and API generation are pure functions and run always; the ladder's backend rung and session inheritance need a real page making real requests. `tests/selector-case.test.ts` covers accessible-name case — `relaxRoleName` and the narrowing/attribution call sites are pure and run always; proving Chrome's and Playwright's accessible-name implementations actually disagree needs a real browser and a `text-transform` fixture. `tests/compose.test.ts` covers `use`/`when` — expansion is pure and runs always, branch selection needs a real page. `tests/page-probe.test.ts` is entirely browser-tier, including the test that asserts a destructive button is never clicked. `tests/cli.test.ts` drives the CLI as a subprocess — exit codes, stdout purity, `--json` parseability — importing nothing, because none of that is observable from inside. `tests/mcp.test.ts` drives the MCP server over real stdio for the same reason: an in-process harness cannot see the protocol stream being polluted. `tests/video.test.ts` covers video evidence — frame sizing, mode parsing, per-step offsets, container trimming (against a real Playwright recording in `tests/fixtures/`, on the same "a reader tested only against its own writer proves nothing" rule as the `.xlsx` and `.pdf` there) and the report's video block are pure and run always; that Playwright records at all over CDP and that a pointer appears in what the browser composites are facts about a real browser, and both were wrong in an early version with nothing at the unit tier able to catch either. `tests/verdict.test.ts` and `tests/machine-report.test.ts` are pure. `tests/form-actions.test.ts` covers the form interaction actions (`selectOption`/`check`/`uncheck`/`type`) — the vocabulary contract and `toFlowStep` narrowing at the unit tier; that a native select, a custom listbox, an ARIA toggle and a per-keystroke field actually respond is browser-tier, because "fill fires no per-key keydown" is a fact about a real browser. `tests/wowlidator-sh.test.ts` and `tests/e2e-app.test.ts` are the two gated tiers above. All sixteen use the same tiering.

Test tiers, in cost order — all are opt-in by environment, nothing hidden:

| Tier | Runs when | Covers |
|---|---|---|
| Unit + contract | always | cache, proof bundle, config/routing, reporter, and all three AI SDK request shapes via `MockLanguageModelV4` ($0) |
| Browser | a CDP endpoint answers at `WOWLIDATOR_CDP_URL` (default `http://localhost:9222`) | the escalation ladder, multi-page navigation, screenshots, reporting |
| Live model | the **healer role's** provider key is set **and** CDP is up | whether a real free-tier model obeys the healing prompt |
| Shell | `WOWLIDATOR_SH_TESTS=1` | `wowlidator.sh` itself — start, stale-Chrome recovery, port propagation. Gated rather than auto-skipped because it starts and kills real Chrome processes: "cannot run" and "should not run unasked" are different things. |
| Chrome lifecycle | `WOWLIDATOR_CHROME_TESTS=1` | starting, recycling and refusing to touch someone else's browser. Gated for the same reason as the shell tier: it kills real Chrome processes. |
| Real application | `WOWLIDATOR_E2E_APP_URL` answers **and** CDP is up | the bug class fixtures cannot see. Both worst-ever defects — the Chrome/Playwright accessible-name divergence and the hydration race in a `hidden` condition — were invisible to every fixture and immediate against a real app. Assertions here are **invariants only** (a tree exists, captured names resolve, probing does not navigate); never business content, or the tier goes red when the app changes and people learn to ignore it. |

Skips are printed with the reason, so a green run that skipped the browser tier says so explicitly.

## Browser lifecycle (`src/browser/chrome.ts`)

`wowlidator.sh` used to find Chrome, start it, wait for the port, open a tab and only then run wowlidator. That worked and split the project in two: the interesting half in TypeScript with a test suite, and the half that decides *whether anything can run at all* in bash, exercisable only by executing it. It is TypeScript now, `wowlidator.sh` is a shim, and `tests/chrome.test.ts` covers it.

**Readiness is proved by taking the browser over, never by a status check.** A Chrome left running for a day keeps serving `/json/version` perfectly while refusing to hand out browser-level context management, and the failure surfaces much later as `Browser.setDownloadBehavior: Browser context management is not supported` on every step — an error that reads like a missing `--remote-debugging-port` and is not one. So `cdpDrivable()` connects and disconnects for real.

**A stale browser on wowlidator's own profile is recycled; anything else is reported and left alone.** The distinction is made on the process command line, and it uses `pgrep -f` rather than `ps | grep` because the pattern appears in the grep's own arguments — a piped grep matches itself and calls every profile ours. `--stop-chrome` obeys the same rule via `startedByUs`: a run may only stop a browser it started.

**The browser is launched detached and `unref`'d**, because it has to outlive the command that started it. A `nohup … &` inside an ordinary shell call dies with that call's process group, which then makes the browser tier *skip* rather than fail — a quieter failure mode, and worse.

**A recording context inherits the attached browser's session.** Recording is a property of a context and can only be set when one is created, so a filmed run cannot reuse the browser's own context — and a bare `newContext()` starts with an empty cookie jar. Against an application that requires a login every protected URL then redirects to the sign-in page, and the whole run tests that page while the report blames the selectors. `SmartRunner.connect` therefore copies `storageState()` across, so filming is invisible to the application; if the copy fails, or the browser had cookies and the new context received none, that is recorded as a high-severity finding rather than left to be inferred. See `inheritSession`.

**Chrome is launched with `about:blank`, explicitly.** Given no URL it opens its startup page — `chrome://newtab`, which renders Google's search box and a `one-google-bar` iframe — so every run that had to start a browser popped what looks like a random Google tab, on a profile nobody browses with, and they accumulated on the persistent profile. `ensureTab` already knew a blank tab is the right thing here; this is the same decision made at launch, before the wrong tab exists.

**Window mode is part of what "a browser wowlidator can drive" means, so a mismatch recycles.** `--headless` used to apply only to a browser this *started*, so the second run of the day silently kept the first run's window: you pass the flag, windows keep appearing, nothing says why. `CliOptions.headless` is therefore `boolean | undefined` and **`undefined` is not `false`** — with no preference stated a running browser is left exactly as it is, rather than being restarted to acquire a window nobody asked for. `--headless` / `--no-headless` / `WOWLIDATOR_HEADLESS` set it (flag, then env); a mismatch on our own profile goes through the same `restart()` a stale browser does, and a browser on someone else's profile is reported and left alone.

Two traps in detecting the mode, both found by running it:

- **`/json/version` cannot tell.** `--headless=new` reports `Chrome/151.0.7922.76`, identical to headful — the `HeadlessChrome/…` product string belonged to the old headless implementation. `chromeIsHeadless()` reads the process command line instead, the same way and of the same process as `chromeIsOurs`.
- **`pgrep -a` is not BSD.** macOS pgrep has no `-a`, and instead of refusing it prints bare pids and exits 0 — so the command lines came back empty, every browser read as windowed, and each run restarted a perfectly good one. It is `-fl`. And the pattern matches Chrome's helper processes, which never carry `--headless` whatever the browser is doing, so the browser process is picked out as the one with no `--type=`.

**`--no-sandbox` is no longer implied by headless** (`WOWLIDATOR_CHROME_NO_SANDBOX=1` opts in, for containers). It rode along on the assumption that headless means CI, but headless is also how someone keeps the browser out of their way on a desktop all day, and turning off the renderer sandbox for a browser that is about to load the application under test is not a windowing decision.

`wowlidator go` is the dispatch the shell script used to do, on the same evidence: a `.json` is a test, a URL is a page to explore, anything else is a description of a test to write. Preparation (`prepare()`) runs before every browser command, not just `go`, so `run`, `generate`, `author`, `crawl` and `watch` all get a working browser without anyone thinking about it.

## The escalation ladder

`SmartRunner.#resolve` in `src/engine/runner.ts` is the core of the framework. Every action walks seven rungs, and the ordering is load-bearing:

1. **fast** — the author's selector, `DEFAULT_FAST_TIMEOUT_MS` (2s). Free.
2. **case** — the same selector with the accessible name matched case-insensitively (`relaxRoleName()`). Free, deterministic, and still the author's own selector. Only runs for a `role=…[name=…]` selector that isn't already flagged. See [Accessible-name case](#accessible-name-case-srcengineselectorts) below.
3. **narrow** — `exactTextSelector()`. Free, deterministic, and only after a *strict-mode violation* on a `text=` selector (a plain not-found means the text is absent and must stay a failure). Unquoted `text=4 days` is a substring match, so on a page also showing "Overdue 54 days" and "≤ 14 days" it resolves several elements and the step reports "could not resolve" about text that is genuinely there — found by running PB_04_01 against a real app, and unhealable for the same reason as a case mismatch: the model proposes the same text and rejects its own multi-match answer at verify. The rung retries the exact form `text="4 days"`; if even that is ambiguous, a *presence* assertion (`expectText`/`expectVisible` only, per `PRESENCE_ACTIONS`) accepts the first visible match — safe because a text-engine match contains the asserted text by construction. Actions that *do* something (click, fill) never get the any-of half: acting on an arbitrary match changes what the test exercises.
4. **dialog** — `#dismissBlockingDialog()`. Still free, still deterministic. A surprising share of "selector" failures are really "something is blocking the page" failures — a cookie banner, a promo modal, a newsletter signup, appearing after the page settles. If a dialog is open right now, dismiss it via its Close/Accept control and retry the *original* selector once before paying for anything. See [Modal and dialog detection](#modal-and-dialog-detection-srcenginemodalts) below.
5. **cache** — a prior repair keyed by `${origin+pathname} :: ${selector}`. Free. A cached selector that fails is *deleted*, not retried — a stale repair is worse than none.
6. **backend** — a *stop*, not another attempt. If a request the page made while this step was waiting has already failed hard (5xx, dropped connection, expired session), give up here rather than paying for a repair. Free, deterministic. See [Backend testing](#backend-testing-srcapi) below.
7. **jit** — `JitHealer.heal()`. Costs tokens. Captures the AX tree, asks the model, **verifies the candidate resolves to exactly one element**, then caches it.

**Patience is the last free rung** (resolution `late`): a *presence* assertion (`expectText`/`expectVisible`/`waitFor`, and `expectCount` — any count reaching the ladder claims > 0; a zero-count runs through `#bareStep`) that failed every free rung gets the author's own selector one more window at the healed timeout before any model is paid. `body` resolves instantly on a hydrating shell, so the fast window closes on the wrong page state by construction — PB-05-01's detail page renders ~3s after the route commits, and a working feature filed a defect. A `late` pass still records a `medium` timing defect ("passed, slower than the budget" is a finding, not a free pass) and wears a `resolved late` badge. Actions that *do* something get no patience: acting late is not the same as observing late.

**`expectText` is language-flexible when told to be, and reads what a user sees.** `anyOf` lists accepted equivalent renderings of the same content — a bilingual app rendering "สมชาย สุขใจ" for a requirement written "Somchai Sukjai" is the same claim about the same employee (PB-05-01's false fail). The engine never invents an equivalence: omit `anyOf` and the check is strict, which is how a case that *means* to check one language keeps its teeth; which rendering matched is recorded on the step (`matchedRendering`). Matching reads `innerText`, not `textContent` — against `body` the latter happily reads `<script>` payloads, and PB-05-01's "got …" evidence was mostly Next.js flight data no user has ever seen. It also *polls* through the window, same rule as `expectUrl` and `expectScrollable`, because an instantly-resolving selector otherwise gets zero benefit from the timeout. On a cross-script failure the error carries a one-line note ("the page renders content in a different script…") — `scriptMismatchNote()`, advisory only. The authoring prompt's LANGUAGE section is the other half: prefer language-neutral anchors (IDs, codes, numbers), and quote the accessibility tree's own rendering, never the requirement document's wording.

Three more stops, all free, all born from PB-02-01's post-mortem (`docs/tester-evidence-spec.md`):

- **Known dead end** (rung 1.05): a selector that already exhausted the whole ladder on this exact page earlier *in this run* gets one fresh fast attempt and then fails with "identical failure at step N" — never a second ladder walk or healer call. Per-run only; never persisted.
- **Denied surface** (rung 2.6): if the page's headings match `DENIAL_HEADING_PATTERN` ("Access Denied", "ไม่มีสิทธิ์เข้าถึง", 403…), healing is skipped — it could only repair onto the denial page's own furniture — and the heading becomes an `authorization`/`high` defect plus `ProofStep.pageContext`. A flow that means to test the denial page never reaches this rung: its assertions resolve on the fast path.
- **Timing re-check** (in `close()`): every dead-ended selector is re-probed once at the end of the run, on the page the run ended on. One that resolves *now* was never absent — its defect downgrades to `medium` "TIMING, not absence". The mirror of `#flagTimingHeal`, pointed at failures.

**A dead browser is fatal and environmental** (`BrowserGoneError`): `Target page/context/browser has been closed` stops the run like `SessionLostError` does, but *skips* teardown (there is no browser to run it in) and exits `EXIT.environment` — the predecessor PB-02-01 run filed fourteen "defects" against an app it could no longer reach.

The short fast-path timeout is deliberate: a selector that is going to work works immediately, so waiting longer only delays the failure we actually care about. Don't raise it to "fix" flakiness — that trades a 2s failure for a 30s one.

**Rungs 2–4 and 6 run before rung 7 for the same reason, and it is not that they are cheaper.** If a dialog really is blocking the target, JIT healing would either fail the exact same way (the AX tree shows the dialog, not the real target) or worse, "successfully" repair the selector onto some control *inside* the dialog — a heal that silently changes what the test is exercising. Dismissing the blocker first and retrying the same selector is the only rung that can't corrupt the test this way. Rung 5 is the same argument for a different cause: if the control never rendered because the data behind it never arrived, a heal can only fail identically or "successfully" repair onto the error banner the app rendered instead — and the second outcome is strictly worse than failing, because the suite goes green while checking the wrong thing. Rung 2 is the sharpest version of it: the healer reads the *same* AX tree the selector was written from, so against a case mismatch it proposes the same name and then rejects its own correct answer at the verify step, having spent a call.

**A form case whose assertions cannot fail is rejected, and the model is told why.** The live failure shape: "submit malformed email" that fills, clicks, then asserts `expectValue` of the very value it typed — which holds whether or not validation exists. `vacuousFormAssertion()` refuses any fill+submit case whose assertions are all expectValue-on-a-filled-field or expectUrl; a rejection earns **one informed re-ask** (`GenerateRequest.feedback`, the healer's `rejected` seam applied to generation), and the better attempt wins — feedback must never make the result worse. Token spend reports both attempts. The `forms` policy prompt also teaches: fill EVERY field the form needs except the one under test, address a nameless field positionally (`role=textbox >> nth=N`), and never assert your own typed value.

**Assertions are the point of a test.** `ASSERTION_ACTIONS` / `hasAssertion()` in the runner define what counts. The generator refuses to emit a case without one — a case that only clicks and navigates passes whether or not the feature works, which is worse than no test because it displaces manual checking. Rejections surface on `GeneratedSuite.rejected`, never silently.

**`expectUrl` waits; it does not peek.** `click` returns when the click lands, not when the router finishes, so a synchronous `page.url()` read raced every client-side navigation and lost — in under a millisecond, reporting the *old* URL. Found against a real app where `click` → `expectUrl` is the most ordinary pair a suite can contain. It now waits up to the fast-path budget via `waitForURL` and, on timeout, still reports "expected X, got Y" rather than a bare timeout: that comparison is the entire diagnostic value of the step.

**`AxNode.url` carries where a link points.** Chrome reports it as an AX property and wowlidator used to discard it, so a generator could only see the label — which is how a card reading "E-Patient" produced `expectUrl "e-patient"` against a route of `/benefits-hub/referral`. The URL was in the tree the whole time. Both generator prompts now say to take a path from `url=`, never from a label; it is emitted only for nodes that have one, since the tree's size is the healer's cost per repair.

**Absence assertions must not heal.** `expectHidden`, and `expectCount` with 0, run through `#bareStep` and skip the escalation ladder entirely. Healing a selector whose whole purpose is to *not* resolve would let the healer repair it onto an unrelated element and turn a correct pass into a meaningless one. Same reasoning for `expectUrl` and the storage-seeding steps: no selector, nothing to repair.

**`Flow.setup` runs before `steps`; `Flow.teardown` always runs.** A setup failure short-circuits the body, because a test whose preconditions did not hold cannot produce a meaningful result. Teardown never masks a body failure. This is what makes authentication expressible — `goto` then `setLocalStorage` then the real flow.

**`clearStorage` before the first `goto` has nothing to clear, and that is done, not an error.** Storage is origin-scoped and a page sits on `about:blank` until it navigates, where reading `localStorage` throws `SecurityError: Access is denied for this document`. A model reliably opens `setup` with it as hygiene, and setup short-circuits the body — so every case authored from one catalog failed at step 0, each filing a high-severity *frontend* defect about a page none of them had visited. `hasStorableOrigin()` decides by inspecting the URL (http/https only) before the call is made, and the skip is recorded on the step's `detail` rather than left to be inferred from a fast pass. On a real origin the call still happens and a `SecurityError` there still fails: storage refused by a page that *has* storage is a genuine finding. **`setLocalStorage` deliberately does not get this treatment** — its intent is to put a value somewhere, which an opaque origin cannot honour, so a flow that seeds auth before navigating must fail loudly rather than run on unauthenticated and fail later somewhere confusing. Clearing is the opposite: "leave no storage behind" is already true of a page that has none.

**Form interaction is four actions beyond `click`/`fill`, all deterministic, all through the ladder.** `selectOption` picks a dropdown option by its visible label — a native `<select>` via Playwright's own `selectOption` (label first, value attribute second), anything else the way a user does it: click to open, then click the option (`role=option`/`menuitem`/`menuitemradio`, searched page-wide because custom dropdowns portal their options to the end of the document; Escape on failure so a retry starts from a closed dropdown). `check`/`uncheck` verify the state actually moved — Playwright's `setChecked` for native inputs, an `aria-checked`/`aria-pressed` read-click-reread fallback for styled toggles, and a control exposing no state at all is refused rather than clicked blind. `type` presses keys one at a time (`pressSequentially`) for the fields `fill` cannot wake — autocomplete, typeahead, masked input — with the typing itself charged to the healed budget, not the rung's: resolving the field is the race the ladder times, typing N characters at a human pace is not. These existed because the old vocabulary could complete no form containing a dropdown: `fill` throws on a `<select>` and `click` can only open one.

`use` and `when` are the two actions that never reach `#resolve` *or* `#bareStep` in the usual way — `use` is gone before the run starts, and `when` records itself while its condition deliberately bypasses healing. When adding an ordinary action (e.g. `hover`), it must go through `#step` → `#resolve`, or it silently loses healing. **Five** places to touch: the method on `SmartRunner`, the `FlowStep` union, the `switch` in `executeFlow`, `flowStepSchema` in `src/mcp/server.ts`, and the `ACTIONS` list plus `toFlowStep` in `src/generator/test-generator.ts` (otherwise the generator can never produce it). An HTTP action has a sixth place: `API_GENERATOR_ACTIONS`/`toApiFlowStep` in `src/generator/api-test-generator.ts`.

`workflow` is the deliberate exception: it bypasses `#resolve` entirely because it has no selector to escalate. It calls the agent directly and records an `AgentRecord` on the step.

## Composition and control flow (`src/engine/compose.ts`)

Two step types, both execution-plane, no model anywhere near them. They exist because a real journey has preludes and forks that a flat step list cannot express: "act as the HRBP" is three clicks that are identical in every HRBP test and are not what any of those tests is about.

- **`use`** splices another `.flow.json` in where it appears. A fragment is an ordinary flow — runnable and debuggable on its own — and `with` substitutes `{{name}}` inside it.
- **`when`** picks a branch on `visible` / `hidden` / `enabled` / `disabled`. Exactly one condition per step.

**Expansion happens before the run, not during it.** `runFlow` calls `expandFlow()` once, up front, and everything downstream sees an ordinary flow. That is what keeps the proof bundle a record of what *actually ran* (a report shows the two clicks, not "used a fragment") and what keeps `--repair`'s `locateFailedStep()` — which maps bundle entries onto `setup`/`steps` positionally — working untouched. `RunFlowOptions.flowDir` is how a fragment path stays relative to the flow that used it rather than to the process's cwd.

**A `when` condition is a probe, not an assertion, and it must never heal.** Healing answers "which element did the author really mean?", which presumes the selector ought to resolve. Here *not resolving is a legitimate answer* — usually the answer being asked for ("is the switcher already showing HRBP?"). A repair would turn "no" into "yes, some other element" and silently take the wrong branch. Same reasoning that keeps `expectHidden` off the ladder. A condition never fails the flow either: unresolvable means false, and `else` (or nothing) runs. The branch taken is recorded on the step via `noteBranch()`, because a report that says "already HRBP, so the switch was skipped" explains an otherwise puzzling gap in the step list.

**Fragment parameters are substituted at expansion; every other `{{...}}` is left alone.** Those belong to the runtime variable store (`src/api/variables.ts`), which is how a value saved from a `request` reaches a later UI step — `interpolateStep()` in the runner applies it at the one point every step passes through. Substituting everything at expansion would break that; leaving everything to runtime would mean a fragment's real selectors never appear in the flow you can read on disk.

**A fragment with a `teardown` is refused, loudly.** Dropping it would leave the fragment's author believing their cleanup runs; running it inline would run cleanup in the middle of the caller's body. Cycles and depth over `DEFAULT_MAX_INCLUDE_DEPTH` are errors for the same reason: silence here produces a test that quietly does less than it says.

**Guard a `hidden` condition behind a `waitFor` on the container.** Found by running it against a hydrating React page: the condition evaluated 17ms after `goto`, when nothing had rendered, so "is the HRBP label hidden?" answered *yes* and the flow re-ran a role switch it should have skipped — clicking a persona button that is `disabled` for the active persona, which then hangs for the full timeout. "Not attached yet" and "not there" are the same thing to a point-in-time probe, and only the flow author knows which one they meant.

## Crawling (`src/crawl/crawler.ts`)

A flow proves one journey. It says nothing about the other eleven cards on the same hub, and writing eleven near-identical flows is how a suite becomes unmaintainable. `wowlidator crawl <url>` asks a cheaper question of the whole page: **follow each control, does a real page come back, can we get home again.** It produces an ordinary proof bundle, so the report, JUnit, history and index all work unchanged — a crawl is a test, not a side tool.

**Links by default; buttons only on request.** A link is a GET; a button is anything, and "Approve"/"Delete"/"Submit" are buttons. `--follow-buttons` exists because plenty of applications route from rows and cards, where a link-only crawl is perfectly honest and completely useless — it reports "0 links" about a page full of destinations. Even then a short label that reads like an action (`looksLikeAction`) is never clicked. The residual risk is real and cannot be designed away, which is exactly why it is opt-in.

**Returning is half the test.** After each visit the crawler goes back and checks it landed where it started. A page you can enter but not leave is a real defect — and invisible to any test that navigates by URL instead of clicking.

Four things learned by running it against a real application, each now load-bearing:

- **Wait for the click's navigation on the full budget** (`DEFAULT_TIMEOUT_MS`, 30s), not a fixed settle. A heavy route measured early reports the *origin* page as the destination and then blames history for "not returning" to a page it never left.
- **A control that resolves but does not navigate is not a broken destination.** For a link that is a defect; for a button it is the ordinary case — a theme toggle, a filter, a sort — so it leaves the visited set and is reported as skipped. Otherwise the report fills with failures about controls that were never destinations.
- **Absence is not a healing problem, here.** In a flow, a selector that no longer resolves means the test drifted and a repair is right. In a crawl the selector came from the tree minutes ago, so absence means the page changed underneath us. Found the expensive way: one visit to a language switcher renamed every control, and seventeen candidates were dutifully sent to the healer. Presence is checked first; healing is for a control that *exists* and cannot be clicked.
- **Re-read the page after every visit.** One accessibility capture, no tokens, and it is the difference between surviving a control with global effects and reporting a page of phantoms. `maxPages` bounds destinations *reached*, with a separate attempt ceiling — a header of eight buttons would otherwise spend the whole budget discovering that a theme toggle is not a destination.

**The healer is load-bearing here in a way it is not elsewhere.** A crawl writes its own selectors from accessible names, so when one cannot be clicked the author has nothing to fix. `--max-heal` (default 5) bounds the repairs per control, every attempt is recorded whether it worked or not, and a successful one lands on the step as an ordinary `HealRecord` — so the badge, the callout and the token cost show up in the report exactly as they do for a flow. A link reached only by navigating to its href is recorded as `via: 'url'` and counted separately: the route exists, the control does not work, and blurring those would let a hub full of broken cards report a clean sweep.

## Scrolling and history

`back`/`forward` turn a list page into a journey — open a card, check it, come back — without re-navigating and losing the state the journey was testing. Two traps, both found live: **`goBack` must use `waitUntil: 'commit'`**, because a back navigation restored from the bfcache fires no load event and the default wait times out on exactly the pages where going back worked; and **it must let an in-flight navigation settle first** (`#settleNavigation`), or a `back` immediately after a click steps past the entry the click was about to create, landing on whatever preceded the test — usually `about:blank`.

`expectScrollable` asks whether a user can reach the content, which is not the same as whether content exists below the fold. Two halves, both required: the content overflows **and** the scroll position moves. **`element.scrollTop = n` works on `overflow: hidden`**, so movement alone proves nothing — script can scroll what a user cannot — which is why the computed `overflow-y` decides. It polls through hydration for the same reason `expectUrl` does: a shell that has not rendered is exactly one viewport tall, and a single reading called a 2806px page unscrollable. The scroll position is restored afterwards, because an assertion that moves the page changes what the next step tests.

## Understanding a page beyond its first render (`src/context/page-probe.ts`)

Every reader in wowlidator reads one AX tree, captured once, of the page as it loaded. That is right by default and has a hard limit: an application's most important controls are frequently one click away from *existing*. A generator pointed at a page whose role switcher lives behind an identity menu cannot write a role-switching test, because at the moment it looked, the menu items were not in the document — it writes a smaller test, and the reason is invisible.

`probeInteractions()` opens each disclosure, records what appeared, closes it, and hands the result to the prompt as a clearly-labelled separate section. Opt in with `--probe` (CLI) or `probe: true` (`TestGenerator`/`FlowAuthor`); omit it and generation is byte-for-byte what it was.

**Only ARIA-marked disclosures are ever clicked** — `aria-haspopup`, `aria-expanded="false"`, `role="combobox"` — never a bare button. This is the safety model, not a heuristic: "Submit", "Delete" and "Approve" carry none of those attributes, so they are not candidates. It is the same understate-never-overstate rule `ax-coverage.ts` applies to attribution, pointed at a much riskier operation — a missed disclosure costs coverage, a mistakenly clicked *action* writes to someone's database. There is a test asserting a destructive button is never clicked; keep it.

**Provenance is kept separate from the tree.** "Behind this menu" and "on the page" are different claims, and a model that conflates them writes a flow that clicks a menu item without opening the menu. `formatProbeReport()` says `click "X" reveals:` and the request carries it in its own field.

**Each probe is verified closed before the next one opens.** A dialog that ignores Escape would put its contents in the next control's results, so probing stops there and says why. A capped run reports how many disclosures it did not open — a truncated probe otherwise reads exactly like a page with nothing more to show.

**One level deep, on purpose.** The probe opens a menu, not the dialog that menu's item opens. Two-level probing multiplies the clicking on a live application for a rapidly diminishing return, and the second level is exactly where destructive controls start appearing.

## The capture pilot (`src/context/capture-pilot.ts`)

The AX tree generation and authoring read is a photograph, and the deterministic settles (`load`, `networkidle`, the lazy-content walk, `document.fonts.ready` + double-RAF in `evidence.ts`) can only wait for things a heuristic can *name*. What they cannot do is look: a skeleton screen is "loaded" as far as the network is concerned, a spinner outlives `networkidle` on a polling app, a cookie banner covers the controls that matter. Before a generate/author capture, the workflow agent briefly takes the browser with a deliberately narrow goal — wait out loading states, dismiss blocking overlays, scroll once for lazy content, **then stop** — and the capture that follows is the evidence, whatever the pilot claims. Same "prepare, never perform" contract as the ladder's agent rung.

- **On by default, `--no-agent-capture` disables** — unlike `--probe`/`--agent-assist`, because the pilot's goal forbids navigation, form submission, data changes and menu-opening (disclosures are the probe's job — two features clicking the same menus would double a risk the probe's design already paid for once), and because an inaccurate capture poisons every test written from it.
- **Degrades silently to an unpiloted capture** when the agent role has no key (`buildCapturePilot` returns null) — a capture without a pilot is the capture we always took.
- **Bounded hard**: `CAPTURE_PILOT_MAX_STEPS` (5). A pre-flight check, not an exploration.
- A broken pilot never breaks a capture — `pilotCapture` never throws, and the capture proceeds regardless.

## Modal and dialog detection (`src/engine/modal.ts`)

Deterministic, no model call — this is execution-plane code, called on every failed fast-path attempt, so it has to be cheap and it has to be honest about what it can't see.

**Detection is ARIA-based only:** `role="dialog"`, `role="alertdialog"`, or a native `<dialog open>`. A fixed-position `<div>` with no dialog role is not detected — the same "understate, never overstate" choice `ax-coverage.ts` makes for CSS selectors, applied to a much richer signal. Every mainstream component library (Radix, MUI, Headless UI, Bootstrap 5) marks this correctly; a hand-rolled non-ARIA popup is a disclosed gap, not something silently guessed at.

**The overlay rung covers what ARIA detection cannot — using Playwright's own evidence.** Detection stays ARIA-only for anything wowlidator goes *looking* for. But when a click fails because a non-ARIA overlay swallowed the pointer (a Semantic-UI dimmer, a hand-rolled promo — homepro.co.th's, live), Playwright's actionability log **names the exact blocker** ("<div class=…> intercepts pointer events"), and acting on a named element overstates nothing. `parseInterception()` reads the blocker off the interception line (the *last* element on it — the log's first is just whichever leaf sat under the pointer), the rung tries a name-gated dismiss control inside it (`findDismissButton`, so a promo's anonymous link is never clicked and can never navigate), falls back to Escape, and retries the author's own selector once. Resolution `dialog`, same record, same usability defect.

**A click that opens a new tab is a navigation, and the runner follows it.** `target="_blank"` (or a `window.open` in the handler) navigates a page the runner would otherwise never watch: the click lands, nothing changes, and every later step asserts against the page the user left — homepro's "ติดต่อเรา" contact link, live. `SmartRunner.click` now adopts the popup: a declared `_blank` waits for it properly, everything else gets a `POPUP_GRACE_MS` window; the adopted page becomes `this.page`, the step records `detail.openedNewTab`, and the original page is left open (closing it mid-run could take a recording with it).

**Named `dialog`/`DialogRecord`, never `interstitial`.** "Interstitial" already means something specific and different in this codebase — an unknown intermediate *page* the workflow agent navigates through (`orchestrator/workflow-agent.ts`, the `workflow` action). This feature is about a blocking *dialog on the current page*. Reusing the word would have collided two genuinely different concepts; don't reintroduce it here.

**`findDismissButton()` picks the first plausible match, not the "correct" one.** When a dialog offers more than one plausible affordance (a cookie banner with both "Accept" and "Reject"), it returns whichever it finds first in document order. That ambiguity is exactly why `closeModal` accepts an explicit `button` selector — automatic matching is a recovery mechanism for the *unrequested* case, not a substitute for asserting what a test actually means to click.

**Two ways this shows up, sharing the same detection code:**
- **Automatic recovery** — rung 3 of the escalation ladder (see above). Uses `openDialogNow()` (no wait — the fast path already spent its timeout failing) and records a `DialogRecord` plus a `usability`/`medium` runtime defect, one notch above an ordinary JIT heal's `low`: an unexpected dialog is a real friction point for human users too, not just automation.
- **Explicit `expectModal`/`closeModal` actions** — for a test that intentionally opens and interacts with a modal. Uses `waitForDialog()` (waits up to `#healedTimeoutMs`, since the dialog may not exist yet when the step starts). Both go through `#bareStep`, not `#resolve` — there's no author-supplied selector on the *dialog itself* to heal, same reasoning as `setLocalStorage`/`clearStorage`. Not wired into the autonomous generator's `ACTIONS` list, same precedent as `fillEach`: the AX tree is a snapshot and can't see a modal that only appears after an interaction, so this is authored by hand or via MCP.

**`waitForDialog()` polls rather than using `locator.first().waitFor()`.** A page can have more than one dialog-role container in the DOM at once — several possible modals, only one shown at a time — and `.first()` resolves to whichever matches first in *DOM order*, not whichever one actually becomes visible. Found by writing a test with two dialogs on one fixture page; don't "simplify" this back to `.first().waitFor()`.

## The agent rung (`SmartRunner.#agentRescue`)

The healer and the agent fix **opposite** problems, and until now only one of them was on the ladder:

| | the healer | the agent |
|---|---|---|
| fixes | a *wrong selector* on the right page | a *right selector* on the wrong page state |
| how | reads one static AX tree, proposes a different string | drives the browser: opens, scrolls, waits |
| helpless when | the control is not in the tree at all | the control is there under another name |

A control behind a closed menu, below the fold, or on a view still hydrating is simply **not in the tree**, so the healer has nothing to propose — it can only echo. That is not a repair problem; it is a reachability problem, and only something that can *act* can solve it. `--agent-assist` adds that as the last rung, below `jit`.

Four rules make it safe enough to exist:

- **The agent prepares the page; it never performs the step.** Its goal is explicitly "make this control reachable, then stop — the test will click it itself". Afterwards the **author's original selector** (and its free variants) is retried exactly as written, and if it still does not resolve the step still fails. Same guarantee the dialog rung gives, and the reason this is not a machine for making tests pass. Demonstrated live: the agent's second turn errored outright, but its first action had already opened the panel, and the step passed anyway — because what the agent *claims* is never the evidence.
- **An assertion is never offered it.** A claim that holds only because an agent went and made it true is worse than a failed claim: the suite goes green while the feature is broken. `ASSERTION_ACTIONS` decides — the same list that stops the generator emitting a case with nothing to prove.
- **Opt-in.** Unlike every rung above it, this one *changes the application* before the step runs — it clicks, types, navigates. That is a decision about someone's system, not a default. Same reasoning as `--follow-buttons` and `--probe`.
- **It is recorded as a defect, not just a resolution.** A `usability`/`medium` finding says the control exists but the flow does not say how to reach it, so the fix is to add the revealing step rather than to keep paying a model every run.

**The healer gets a second look at the page the agent opened.** This is the other half of the integration and the reason the two belong on one ladder: the healer's blind spot is a tree that did not contain the answer, and the agent has just changed the page. So if the author's selector still fails after the agent acts, one more repair is attempted against the *new* state. A step can therefore end up carrying both an `AgentRecord` and a `HealRecord` — the agent opened the menu, the healer named what was inside — and that combination is reported at `medium`, because two model calls for one step is worth fixing in the flow.

**The agent's vocabulary grew to match** (`AGENT_ACTIONS`): `press`, `scroll` and `wait` alongside `click`/`fill`/`goto`. They are what a *stuck* page actually needs — a listbox that only opens on Enter, a control below the fold, a view that has not hydrated — and a click-and-fill vocabulary can only keep clicking things that are not there yet. None of them can change data, which is what keeps the safety argument intact: the agent cannot express a purchase or a delete except through a `click` the goal explicitly asked for.

## The healer's echo (`HEAL_ATTEMPTS`, `sameSelector`)

**The commonest thing a weak model does when asked to repair a selector is hand back the selector that just failed.** It looks like an answer, passes every schema, and costs a model call plus the full verification timeout to arrive exactly where the step started — and because the healer only ever asked once, that was the end of the step. Found in "Leave Request Submission Flow", whose `role=button[name="Create Leave Request" i]` was echoed straight back: two attempts recorded, no `HealRecord`, `jitHeals: 0`, and a dead end on a page where the control was plainly available.

Three changes, and the third is the one that actually fixes it:

- **An echo is rejected before it is verified.** `sameSelector()` normalises the case flag and spacing, so a repair that differs from the failure only by ` i` is recognised as the no-op it is. That saves the timeout; it does not save the step.
- **The healer is told what it already proposed.** `HealRequest.rejected` carries each dead candidate *with the reason it failed*, and the prompt says not to repeat them. Without it a model has no way to know it is repeating itself.
- **It asks up to `HEAL_ATTEMPTS` (3) times.** One was too few for the failure that actually happens: the first answer is unusable and the repair budget is spent without a repair ever being attempted. The value is entirely in the *second* ask — the first one that knows what did not work.

**A counting step may heal onto a group.** `#verify`'s exactly-one-element rule is the safety net for every ordinary repair — and made repairing an `expectCount` selector structurally impossible, since a *correct* repair matches all the counted items. Verification now permits multiple matches only when the failed action is `expectCount`, and the heal prompt says so ("a group, not one element"). Found via PB-02-01's radio count, which no proposal could ever have fixed.

**A refused candidate is kept as data, and the machinery's failures are typed apart from the page's.** `HealFailedError.rejectedHeals` carries every refused proposal (`{proposed, confidence, reasoning, rejectedBecause}`) onto `ProofStep.rejectedHeals` — a rejected proposal is what the model *saw on the page*, frequently the diagnosis itself (PB-02-01's refused candidate for its final step was the page's own "Access Denied" heading). The echo check runs **before** the confidence gate, so a low-confidence echo is reported as an echo with the full re-ask budget rather than dying as a one-shot "confidence too low". And a provider failure (`HealUnavailableError` — rate limit, transport, unparseable output) is counted in `summary.healUnavailable` and worded "a provider fact, not a page fact" — it must never read as "the control is absent".

**The prompt also now says the author's role and name are a guess.** That is the deeper half of this case: the flow wanted "the Create Leave Request button" and the page offers a *link* named "Leave request Apply for leave" — a different role and a different name. A healer that treats the failed selector as a description of the element cannot cross that gap; one that treats it as an author's guess and matches on *intent* against the tree can. It now heals to `role=link[name="Leave request Apply for leave" i]` and says why.

## Losing the session (`SessionLostError`)

**A run that has been bounced to a sign-in page cannot answer the question it was asked, so it stops.** This is the only fatal error in the engine, and it exists because the alternative is actively misleading rather than merely useless: every later step is asserted against the login screen, so some fail for the wrong reason — and the healer *rescues* others by repairing them onto whatever the login page offers, verifying that the new selector resolves, and reporting them green. Seen exactly that way in PB_01_01: `waitFor role=heading[name="Sign in"] … passed (jit)`. A pile of defects about an application that was working perfectly.

`assertSessionHeld()` runs before every step. Three conditions, all required, so a flow that *means* to be on a sign-in page is never stopped: the page is on a sign-in URL now; no `goto` in this run asked for one; and the last `goto` asked for a different page, so being here was not the plan. A `click` is exempt — following a "Sign out" control is a legitimate way to arrive.

**`#strandedMessage()` is split out from the assertion so the ladder can consult it without stopping the run.** A step whose page was redirected *while it ran* could not have been caught beforehand, and there the rule is narrower: it is an ordinary failed step, but it **must not heal** — same shape as the backend rung, where a repair can only fail identically or succeed against the wrong thing, and the second is strictly worse.

Teardown still runs (`executeFlow` catches the fatal, runs cleanup, then rethrows): "teardown always runs" holds, and a flow that signed in and created something still has to put it back.

The other half of the fix is at authoring time: the author prompt now says to sign in explicitly and completely — **fill every field the form has**, because a password field usually has no accessible name of its own and a form missing one field never submits — and that a token seeded with `setLocalStorage` needs a `goto` after it, since an application reads its session once, at load.

**A prompt instruction is a request; `strandedCredentialFill()` is the guarantee — and the guarantee repairs before it refuses.** The prompt has always said to go back to the sign-in page before switching user, and PB-02-01 is what it looks like when a model ignores that: three credential blocks filled against a probation page. The lint walks `[...setup, ...steps]` in execution order; a credential-shaped fill (`password` in selector/intent, or the taught `role=textbox >> nth=N` idiom) whose most recent preceding `goto` does not look like a login surface is a violation. A flow with no `goto` before the fill is allowed: the page the author was given may *be* the login screen.

Handling runs in cost order, like the ladder — the first cut of this feature refused outright, which turned every stranded persona switch into a blocked case the system knew the exact fix for:

1. **$0 mechanical repair** (`groundCredentialFills`): when the flow itself names a sign-in URL (its first login's `goto`), splice that `goto` back in front of each stranded credential *block* (walking back over the contiguous fill run — the block starts at the email field, not the password field the detector flags). Applied to the body and to each case's step list, disclosed on `notes` and `onLog`, never silent. Same move `qualifyBareRole` makes for selectors. With no sign-in URL to learn from, nothing is invented.
2. **One informed re-ask** (`AUTHOR_ATTEMPTS` = 2): any `AuthoringError` from validation (no assertion, still-stranded credentials) goes back to the model as `AuthorRequest.feedback` — the healer's `rejected` seam applied to authoring, and for the same reason: the value of a retry is entirely in the ask that knows what was refused.
3. **The loud refusal stays** as the floor, naming the step and the fix; `runCases` already scores it blocked, not failed.

The prompt also now asks the flow to assert *who* is signed in after submitting, and says persona-specific claims belong in **separate cases** (setup re-runs per case, so each persona signs in from a clean start).

**`ungroundedUrlExpectation()` / `inventedUrlReason()` refuse a URL derived from a label.** The recurring shape (documented once for `AxNode.url`, back live anyway): a card labelled "Time & Attendance" routes to `/en/overtime`, the model asserts `expectUrl "time-attendance"`, and a correctly-navigating app gets a high defect. An expected fragment must appear in the tree's `url=` attributes or in one of the flow's own `goto`s; the authoring variant exempts expectations *after* a `workflow` step (the agent's journey ends on pages the authoring tree never saw, and the agent verifies its goal live). Both feed the ordinary feedback re-ask; the runtime `expectUrl` failure also names the hazard ("if the page shown IS the correct destination, the expectation was derived from a label"). Truncated-tree honesty as always.

**`ungroundedCountRole()` refuses a count of a role the page never exposes.** The habit it catches: the model reads a `radiogroup` in the tree and *infers* `role=radio` children — PB-02-01's app renders the outcome "cards" as `<button aria-pressed>` toggles, so `expectCount role=radio, 4` (and its CSS spelling `[role="radio"]`) resolves zero elements on every run, forever. Tree lines start with the node's role token, so "does this role exist" is a deterministic string check; a refusal feeds the ordinary feedback re-ask. It declines to judge a truncated tree — past the node budget, absence of evidence is not evidence of absence, the same rule the truncation notice itself states.

## Bare-role selectors (`src/engine/selector.ts`)

**`textbox >> nth=1` is a valid selector that can never match anything.** Playwright reads a leading token with no engine prefix as a *CSS tag name*, and there is no `<textbox>` element — so the selector resolves 0 on every page, at any timeout. Same for `heading[name="Employees"]` and `button[name="Extend until"]`: a `<button>` with a `name` attribute of "Extend until" does not exist either. The step then reports "could not resolve", which reads as *the control is missing* and files a front-end defect about an application that is fine.

This is the most damaging thing a model gets wrong when writing a selector, because it fails silently and it fails **completely** — and it clusters on exactly the controls that have no accessible name, since that is when the model falls back to a positional selector and drops the prefix. Found by investigating PB_02_01: the login page's password field is reported by Chrome as `role=textbox` with an **empty name** (the app's `<label>` is not associated), so the authored step was `textbox >> nth=1`. It matched nothing, the form never submitted, and all 26 steps ran against the sign-in page — six "defects", none real.

`qualifyBareRole()` adds the missing `role=`, and it is applied at every point a selector is written from a tree (`toFlowStep`, `flow-author`, the agent's decision, the healer's candidate — composed *before* `relaxRoleName`, since relaxing only recognises `[name=…]` on a role selector) plus **rung 1.15 of the ladder**, which is what rescues flows already written to disk.

Three guards keep the rewrite from doing harm, and each has a test:

- **A real CSS selector is never touched.** Anything structurally CSS — `.card`, `#id`, `a > span`, `input:checked`, `[data-testid]`, a descendant combinator — is left alone, and so is any leading token that is not an ARIA role. Turning a selector that resolves correctly into a role selector that matches something *else* is the one outcome worse than the bug.
- **An attribute the role engine does not accept declines the rewrite.** `role=textbox[placeholder="Password"]` throws `Unknown attribute "placeholder"`; qualifying there would swap a silent miss for a thrown step, and a miss is at least repairable by the healer. (Seen live in PB_01_01.)
- **It returns `null`, not the input, when there is nothing to do** — the same contract as `relaxRoleName`, so the ladder skips a second attempt instead of paying the fast-path timeout twice for an identical selector.

## Accessible-name case (`src/engine/selector.ts`)

wowlidator reads accessible names through Chrome (`captureAxNodes` →
`Accessibility.getFullAXTree`) and resolves selectors through Playwright's
`role=` engine. Those are two independent accessible-name implementations and
they disagree: **Chrome applies CSS `text-transform` when it computes a name,
Playwright does not.** A control styled `text-transform: uppercase` is captured
as `"DUE SOON 1 15–29 days"` and matched against `"Due soon 1 15–29 days"`.

This is not drift and not flake — `locator.count()` is 0 at any timeout, and
every selector written for such a control was unresolvable *by construction*.
Found by generating against a real app: 2 of 5 generated cases failed on the
same filter tabs, and the healer could not rescue either one.

The rule: **never assert a case we did not observe.** `relaxRoleName()` turns
`[name="X"]` into `[name="X" i]`, and it is applied at every point a selector
is written from a tree name — `toFlowStep` in `test-generator.ts` (shared with
`src/repair/`), `flow-author.ts`, the agent's decision in `workflow-agent.ts`,
and the healer's candidate *before* `#verify` (otherwise the healer spends a
call and then rejects its own correct answer). Rung 2 of the ladder covers what
those cannot: hand-written and pre-existing flows.

Three details worth keeping:

- **Case-insensitivity is a loosening, and the guards that make it safe are the
  existing ones.** The healer still verifies a candidate resolves to exactly one
  element, and a step matching two controls that differ only in case fails on
  Playwright's strict-mode violation rather than silently picking one.
- **`relaxRoleName` returns `null`, not the input, when there is nothing to
  relax** — a CSS/text/testid selector, a role selector with no name, or one
  already flagged. That is what lets rung 2 skip a second attempt instead of
  paying the fast-path timeout twice for the identical selector.
- **Coverage attribution folds case too** (`attributionKey()` in
  `ax-coverage.ts`). The inventory's names come from Chrome, a hand-authored
  selector carries the untransformed text; comparing them exactly would miss
  the attribution *and* add the same control again as a phantom "transient" —
  understating the numerator while inflating the denominator. `parseRoleSelector`
  also has to accept the trailing ` i`, or every generated step lands in
  `unattributed`.

## The model-backed modules

| Role | Default provider | Invoked when | Interface to stub |
|---|---|---|---|
| `healer` (`healer/jit-healer.ts`) | Groq | a selector already failed | `HealerModel.suggest()` |
| `generator` (`generator/test-generator.ts`) | Google (Gemini) | you ask it to write tests | `GeneratorModel.generate()` |
| `orchestrator` → `agent` (`orchestrator/workflow-agent.ts`) | Groq | a `workflow` step runs | `AgentModel.decide()` |
| `data` (`data/data-model.ts`) | Groq | a `fillRetry` step's kind is `custom` | `DataModel.generate()` |

Each role is matched to a tier's strength, not to a favourite vendor: repair is small and latency-sensitive (Groq is fastest), generation sends the biggest prompt in the system (Gemini has the largest free context), navigation is one small structured decision per turn (Groq again — the loop, not the model, owns the reasoning; OpenRouter remains the natural re-point for a stronger agent model), data regeneration is another small latency-sensitive call (Groq again). Every role is re-pointable with two env vars — see `.env.example`.

`data`'s deterministic kinds (`email`, `username`, `name`, `phone`, `text`) never actually touch a model — see `src/data/mock-data.ts`. Only `kind: 'custom'` reaches `data-model.ts`, which is why the role exists so escalation is *possible*, not so it's *routine*.

**Model ids are the most fragile thing in this repo.** They drift far faster than the code. `wowlidator doctor` makes a real one-token call per role and is the only way to know a default still resolves. Treat the values in `DEFAULT_ROLE_MODELS` as starting points, not facts.

Two layers, kept separate on purpose:
- `src/config.ts` — validates env into a `WowlidatorConfig`. No SDK imports. A bad provider name fails here with `ConfigError`, not 30 seconds into a run.
- `src/providers/llm-factory.ts` — turns a `RoleConfig` into an AI SDK `LanguageModel`, **lazily**. A run that never heals never demands a key. `generateStructured()` is the single `generateObject` call site; it wraps failures with the model label, because "which of my four free models can't do JSON schema" is the question you'll actually be asking.

Adding a fourth provider: one entry in `FACTORIES`, one string in `PROVIDERS`, one entry in `PROVIDER_META`. No call site moves.

**The agent owns its loop.** `AgentModel.decide()` returns exactly one action per call; `WorkflowAgent.run()` does observe → decide → act → repeat. This is not the SDK tool runner, and that is intentional: every turn needs budgeting, origin-checking, and screenshotting against live browser state, and a one-decision-per-turn seam is what makes the whole thing stubbable. Do not "upgrade" it to `client.beta.messages.toolRunner` without re-solving those four things.

Agent safety rails, all load-bearing:
- `maxSteps` (default 8) — a hard turn ceiling; the agent reports failure rather than looping.
- `allowedOrigins` — defaults to the origin it started on, so a confused agent cannot wander onto the public internet.
- History is passed as a **snapshot** (`[...history]`). Passing the live array lets a model implementation observe mutations after the fact.
- `run()` never throws. Failure is reported in the record so the report can show what was attempted.

## Mock data and `fillRetry` (`src/data/`)

Some failures aren't selector drift at all — "email already exists," "SKU not found" — the selector was right, the *data* was wrong. `fillRetry` is a composite action (same shape as `fillEach`: it does not go through `#resolve`, because the *field* selector is assumed stable and only the *value* is in question): fill, submit, check whether a `failureSelector` is still visible, and if it is, regenerate the value and try again up to `maxAttempts`.

**Five kinds, one of them different.** `email`, `username`, `name`, `phone`, `text` generate through `faker` in `mock-data.ts` — deterministic, $0, no model call, ever. `custom` escalates to the `data` role's `DataModel` for a field a heuristic can't classify ("employee ID", "SKU"). This is where "AI should only be used where reasoning is required" stops being a slogan: most `fillRetry` steps never reach `data-model.ts` at all.

**Attempt 2+ doesn't just re-roll — it makes collision structurally impossible, not merely unlikely.** `generateValue(kind, attempt)` embeds a uniqueness suffix (`Date.now()` base-36 plus the attempt number) from the second attempt onward, placed *before* the `@` for `email` specifically, since `local+tag@domain` is a well-known deliverable-alias convention and keeps the value looking like a real email rather than a garbled one.

**Seeding a backend is now possible, and `fillRetry` still doesn't do it.** This used to be a documented non-goal on the grounds that there was no HTTP capability to build it on. There is now (`src/api/`), so the honest statement is narrower: regenerating a client-side value and creating a missing resource are different jobs, and a `request` step already does the second one explicitly, in the flow, where a reader can see it. Burying a silent POST inside a `fillRetry` retry loop would hide a write behind what reads like a form-filling action. If a test needs a resource to exist, create it with a `request` step in `Flow.setup`.

## Backend testing (`src/api/`)

Three capabilities, one module, **no new LLM role and no model call anywhere in
it**. This is execution-plane code: HTTP is deterministic, so there is nothing
here for a control plane to do.

### 1. Passive observation — what the page asked for

wowlidator is already CDP-attached for the AX tree, so watching the page's traffic
costs one more session and no tokens. `NetworkObserver` records
`XHR`/`Fetch`/`Document` calls into a capped ring buffer (300, with the dropped
count surfaced rather than swallowed — a truncated capture otherwise reads
exactly like a quiet page).

That buys the thing wowlidator could not previously say: **which side is broken.** A
step that failed because `POST /api/shifts` returned 500 used to be recorded
identically to a drifted selector, and the healer would spend a token trying to
repair a selector that was never wrong. Now it becomes a `backend`/`high`
defect — its own `DefectCategory`, because it routes to a different team and no
amount of selector work will fix it — and rung 5 of the ladder declines to heal.

Two rules keep this honest and must survive any change here:

- **A plain 4xx is not blocking.** Only 5xx, a dropped connection, and 401/403
  suppress the heal. A 404 probing for an optional resource, or a 422 from a
  negative test that *meant* to submit something invalid, are normal — treating
  them as blocking would silently disable healing for every negative test in a
  suite.
- **The evidence window looks backwards, to wherever the previous step began**
  (`#takeNetMark`; `NETWORK_LOOKBACK_MS` 3s is the floor, the previous step's
  mark extends it). The request that starves a step is almost always fired by
  the step *before* it: a `click` returns as soon as the click lands, the XHR
  is still in flight, and the following `expectVisible` is what fails. A fixed
  window loses exactly that call as soon as the prior step runs long —
  PB-02-01's login block spent 20s+ per step and three failed steps in a row
  carried no network evidence while their neighbours did. The cost is that
  attribution is correlational — which is why every message this produces says
  "while this step was waiting", never "because of".

Observation is diagnostic: like history and coverage, anything that goes wrong
inside it is swallowed and must never change a run's verdict.

### 2. `request` steps — HTTP the test makes deliberately

`request`, `expectStatus`, `expectJson`, `expectHeader`. All go through a
`#bareStep` shape, never `#resolve` — no selector, nothing to heal, same
category as `setLocalStorage`/`expectUrl`.

**The default transport is the browser context's, not Node's `fetch`, and that
is the entire integration argument.** `BrowserContext.request` shares cookie
storage with the page, so a flow logs in once through the real UI — whatever
bespoke SSO dance that involves — and then seeds and verifies over HTTP *as
that user*, with no token plumbing and no second auth path that can drift from
the one real users take.

**A non-2xx does not fail a `request` step.** The status is a result to assert
on; `expectStatus` is where it becomes pass/fail. Only a call that never got a
response at all fails there. Without this, no test could exercise an error path.
For the same reason `request` is **not** in `ASSERTION_ACTIONS`: a call whose
status nobody checks passes whether the endpoint returns the right data or a
500, which is the exact false-confidence failure mode that list exists to stop.

**Variables are the one genuinely new primitive.** `save: { orderId: '$.data.id' }`
on a `request`, `{{orderId}}` anywhere afterwards. Two deliberate limits: a tiny
JSONPath subset written locally rather than a dependency (filters and recursive
descent are the parts that turn a test into a program), and **an unknown
variable is an error, never an empty string** — silently interpolating `''`
produces a request to `/api/orders/` and a failure three steps later that reads
like a backend bug.

Two ordering traps, both found by running it:
- **Interpolate before resolving `baseUrl`.** `new URL()` percent-encodes
  `{{orderId}}` into `%7B%7BorderId%7D%7D`, so resolving first turns every
  placeholder in a relative url into literal garbage that reaches the server.
  This is why `FlowRequestSpec` carries `baseUrl` through instead of having
  `executeSteps` apply it.
- **A `save` path that misses fails the step it is on**, not the one that later
  uses the variable.

### 3. Browser-free flows

`isBrowserFree()` decides by inspecting the steps, not by a flag — a flow of
pure API steps has nothing to click, and a flag would only add a way to get it
wrong. `runFlow` dispatches to `runApiFlow`, which never calls
`chromium.connectOverCDP`. The proof bundle, HTML report, run history, flake
analysis and `--repair` all work unchanged, because none of them ever depended
on there having been a page. `ApiActions` is shared by both paths so there is
one implementation of request/save/assert rather than two that drift.

### Redaction is load-bearing, not a nicety

The HTML report is deliberately self-contained — "opens off a USB stick" — which
is exactly what makes it easy to email. Before `src/api/` nothing in a bundle
could carry a credential; a single `request` step can carry a session cookie, a
bearer token and a password. So `redact.ts` runs at the one point a live
response becomes a stored artefact, and the rule is: **never emit a payload we
could not inspect.** An unrecognised body is replaced with its size and type,
because "we didn't recognise the format" is not evidence it holds no secret.
Saved variables whose *name* looks like a credential are masked in the report
while the run keeps using the real value. There is a test asserting a bearer
token cannot survive into rendered HTML; keep it.

### Generating API tests

`ApiTestGenerator` reuses the `generator` role — no fifth role, same reasoning
as `src/repair/`: a large inventory in, a small flat structured shape out. The
OpenAPI operation list plays exactly the part the AX tree plays for a page, and
that is the whole justification: **the model chooses among declared endpoints
rather than inventing URLs.** With no spec indexed it raises `NoSpecError`
rather than generating something plausible.

`MutationPolicy` maps onto HTTP verbs, and is enforced **structurally, not by
asking nicely**: the inventory is filtered by policy before the prompt is built,
and `toApiFlowStep` re-checks every generated step on the way out. A prompt
instruction is a request; a filter is a guarantee. `read-only` = GET/HEAD,
`forms` adds invalid-payload probes on POST/PUT/PATCH, `mutations` adds valid
writes. **DELETE appears at no tier**, including `mutations`.

## Structured output on free tiers

`generateStructured()` in `src/providers/llm-factory.ts` is the one place `generateObject` is called. **Every call runs at `temperature: 0`** — nothing here is creative writing, and sampling around the most-likely answer is where run-to-run inconsistency came from (the same claim authored as 25 steps one run and 29 the next, with different invented roles). Two more rules follow from running on free models:

- **Keep generated schemas flat.** `GeneratedStepSchema` and `DecisionSchema` are flat objects with every field required and empty strings for unused fields, then narrowed in code (`toFlowStep`). Weaker models handle that far more reliably than a five-variant `discriminatedUnion`. The zod discriminated union in `src/mcp/server.ts` is fine — that one is an MCP *input* schema, not a model *output* schema.
- **Never trust a number.** Smaller models return confidence as `0–100`, `1.4`, or a string. The healer clamps to `0–1` in code; the schema is not the guard.
- **Every property of a generated schema must appear in its `required`.** Strict structured-output providers — Groq's `openai/gpt-oss-*`, OpenAI's own — reject an object schema whose `required` omits any key of `properties`, and they reject it *before the model is asked*, so the whole call fails with a schema-validation error rather than a bad generation. `.optional()` and `.default()` both produce exactly that shape, which makes them unusable in a model-*output* schema however reasonable they look. An optional field is spelled `.nullable()` instead: the key stays in `required`, and `null` is how the model declines it. When the field must *also* survive a lenient provider omitting it, wrap the object in `z.preprocess` and fill the key — `AuthoredStepSchema` in `flow-author.ts` is the worked example, and the reason `case` is the only field there not following the flat empty-string convention. Env schemas in `src/config.ts` are exempt: they validate `process.env` and never reach a model.

- **Ask a schema-in-prompt provider for an *instance*, and say so.** A provider with no structured-output channel (`emmiedev`, `zai` — `SCHEMA_IN_PROMPT_PROVIDERS`) is told the schema in prose by `promptSchemaInstruction`, and **the wording of that instruction is load-bearing**. "Respond with a JSON object that matches this JSON schema exactly" is ambiguous, and GLM 4.7 reads it the wrong way: it replies with *the schema*, its answers tucked into `const` fields. That is valid JSON, so `json_object` mode is satisfied and nothing catches it until zod rejects every field as `undefined` — surfacing as "No object generated: response did not match schema", which reads like a model that cannot do structured output at all. It can; it answered the wrong question. Two things provoke it: **nesting** (the failure tracks schema shape, not model quality — measured on glm-4.7-flash, the healer's flat four-key object came back correct 4/4 while the generator's `steps: array of objects` managed 3/8) and **`$schema`**, which `z.toJSONSchema` emits and which reads as a document worth echoing. So the key is dropped and the instruction names the distinction outright, listing the keywords a schema echo would contain rather than hoping against it. Same prompts, same model: **8/8**. `echoedTheSchema()` also names this failure in the error when it does happen, because "response did not match schema" is otherwise opaque.

**A model that cannot do schema output is a SYSTEM failure, and it stops being paid.** Exhausting the re-ask budget throws typed `StructuredOutputUnavailableError`; the exit contract maps it to `EXIT.environment` (fix the role's routing, never file a bug against the app). Two exhausted cycles in one process trip a **circuit breaker** (`BREAKER_TRIPS`): every further call to that model fails immediately with "circuit is open" instead of spending three calls and their timeouts to relearn the same fact — seen live with `openrouter:google/gemini-3.6-flash` on the healer role, which burned a re-ask cycle per failing step. A success halves the count rather than clearing it, so one good roll from a mostly-broken model does not reset the evidence. `resetStructuredBreaker()` is the test seam.

Not every free model can emit schema-constrained JSON at all. When one can't, `generateStructured` throws with the model label in the message — that's deliberate, because the useful question is *which* role broke, not that JSON parsing failed. **The advice attached to that message is chosen by cause, not boilerplated:** a key failure (rate limit, quota, expired credential — `isKeyExhaustedError`) says so, because "try a different model id" would send someone editing config over a call that was rate-limited and whose model was fine. Note z.ai signals overload as error code `1305` and the SDK does surface it as a rate limit, so key rotation already works.

## In-run step reconstruction (`executeSteps` in `src/engine/runner.ts`)

Between the ladder (one selector, mid-step) and `--repair` (whole flow, between runs) sits the level a failed *step* actually wants: on failure, the repair model rebuilds the step against the **live page** — no re-run, session intact — and the step retries, until its failures reach `STEP_RECONSTRUCT_TRIES` (3, total, including the original). Only then does the ordinary classification (failed / error / dead end) land. On by default; `--no-reconstruct` disables; no generator key degrades silently to pre-reconstruction behaviour.

Four rails hold it honest:

- **A rescued run passes, and the attempts stay visible.** Failed tries a later reconstruction rescued are marked `ProofStep.superseded`: still listed (what was tried is evidence), counted toward nothing — not the tallies, not the run status, not the trend's failure signatures — and their defects are withdrawn (`supersedeSteps`). Without this, "retry until it works" would be indistinguishable from "failed" and nobody would leave it on.
- **An assertion keeps its claim verbatim.** A reconstruction may only insert preparation *before* it; the replacement is discarded for `ASSERTION_ACTIONS`. A claim rewritten until it passes proves nothing — the same argument that keeps the agent rung off assertions.
- **Every rescue is a finding.** The passing step carries a `ReconstructionRecord` (as written / as rebuilt / inserted / reasoning) and files a `medium` drift defect: the run is green, the flow no longer matches the app.
- **Futile stops stay stopped.** A failure the ladder already attributed elsewhere (`backend:`, `authorization:`, `declined to heal:`, `known dead end:`) is never reconstructed — the same "a rewrite can only fail identically or succeed against the wrong thing" argument, verbatim.

Bad interpolation is also never reconstructed: an unknown `{{var}}` is the flow's problem, and nothing a rebuilt step does can save a variable the run never saved.

## Runtime script evolution (`src/repair/`)

A JIT heal fixes *one selector* inside a run that's still in flight. `--repair` is the level above that: when a whole run fails, ask the `generator` role for a targeted fix to the `.flow.json` itself, retry the whole flow, and keep going until it passes or `maxAttempts` (default `DEFAULT_MAX_REPAIR_ATTEMPTS = 3`) is spent — at which point it reports `dead-end`, never throws.

**Reuses the `generator` role rather than adding a fifth one.** The job shape is identical to what `generator` already does — a big prompt in (the whole flow, the failure, a fresh AX tree), a small structured shape out (`RepairSchema`, built from the same flat `GeneratedStepSchema`/`toFlowStep` the generator and `flow-author` share, exported from `test-generator.ts` as `GENERATOR_ACTIONS` specifically for this reuse). `LlmFlowRepairModel.id` is a lazy getter, same fix as `LlmDataModel`'s — constructing the class must never itself demand an API key.

**A repair proposal is `canFix` + `insertBefore` + `replacement`, not a whole-flow rewrite.** The model may insert steps before the failing one (dismiss a popup, wait for a load) and/or replace the failing step itself (a different selector, action, or value) — every other step in the flow is untouched, and the model never sees them. `canFix: false` is an explicit, expected outcome, not a fallback: when the evidence doesn't support a fix — the app looks genuinely broken, or nothing in the tree resembles what the step needed — a wrong guess that makes a test appear to pass while checking the wrong thing is worse than an honest failure, so the loop stops immediately rather than burning the rest of the attempt budget.

**Reviewable, never silent — the flow you pointed at is never overwritten.** Same principle as everywhere else generated output touches disk in this repo. Each repair beyond the first attempt lands as `<name>.attempt-N.flow.json` (a complete, directly-runnable file, not a diff) plus `<name>.attempt-N.patch` (human-readable: why the previous attempt failed, the model's reasoning, and the exact before/after of the changed step).

**`locateFailedStep()` maps a `ProofBundle`'s flat step list back to `Flow.setup`/`Flow.steps` by construction, not by re-deriving indices**: `setup` and `steps` each execute strictly in order and stop at the first failure, so the first `setup.length` bundle entries are exactly the setup attempts, and — only if every one of those passed — the entries after that are exactly the `steps` attempts. Teardown failures are never repaired: teardown's job is to clean up regardless of the body's outcome, so rewriting it wouldn't change whether the flow's actual goal was reached.

**Fresh context per attempt.** `runFlow()` closes the browser before returning, so the loop re-navigates to the failed step's URL and re-captures the AX tree (best-effort — a repair proposal without a fresh tree is still better than none) before asking for the next fix, and threads prior attempts' summaries through as `history` so the model doesn't repeat a fix that already didn't work.

**`--repair-investigate` sends the agent back to the page before each fix is asked for.** The static revisit reads the page as it loads, which is exactly the tree the failure was already invisible in — a control behind a menu or a view still hydrating is not in it. The agent's goal is the same contract as the ladder's `#agentRescue`: reach the state the failed step needed (open the menu, wait, scroll), then stop — **never perform the step itself**, because its actions are evidence for a proposal, not a result, and a repair that only works because an agent did the step for it is repaired wrong. The AX tree handed to the repair model is captured *after* the agent acts — the tree of the page the agent opened up is the one that contains the answer — and the findings travel as `RepairRequest.investigation`, a labelled section apart from the tree (same "what an agent did" vs "what the page shows" separation as `page-probe.ts`), and are narrated in the `.patch` file. Unlike the ladder's rung, an assertion failure *is* investigated: the repaired flow re-runs from scratch on its own, so nothing the agent does can make the flow pass. Opt-in for the same reason as `--agent-assist` — it acts on the application — and gated on the `agent` role's key. It is deliberately a separate opt-in from `--no-agent`/`buildAgent` (may `workflow` steps run?) — conflating them would let one opt-in silently grant the other.

**`--repair-regenerate` lets a fix regenerate the flow from the failed step onward** — replacing the failed step and every later step in its section via `RepairProposal.rewriteFollowing` — for the failure a one-step patch cannot reach: a tail written against a page that does not exist, which the following steps inherit. Steps *before* the failure are never touched. The permission is enforced **structurally, not by asking nicely**, the same way `MutationPolicy` filters the API inventory: with it off, `RepairRequest.followingSteps` is absent, so the prompt never even describes the tail; `LlmFlowRepairModel` discards any tail a model returns unbidden; and the loop clears `rewriteFollowing` again before applying — three layers, each of which alone suffices. The `.patch` shows the whole before/after of the regenerated tail.

Both flags imply `--repair`. Exposed via `wowlidator run <flow.json> --repair [--repair-attempts N] [--repair-investigate] [--repair-regenerate]` (gated on the `generator` role having a resolvable key) and the MCP tool `repair_flow` (`investigate` / `regenerateFrom` inputs; screenshots stripped from the response the same way `run_flow` already strips them).

## Repository context engine (`src/context/`)

Generation and healing default to seeing *one page* — an AX tree, nothing else. The context engine is a second, complementary source: a static index of the *project*, so a prompt can be told what a route renders and what already tests it without spending a token to find out.

Deliberately not an AI feature — this is where "AI should only be used where reasoning is required" actually draws a line: indexing is not reasoning, so `ContextEngine.build()` never calls a model, only `readdir`/`readFile` and a real parse. That parse is `@babel/parser`, not the TypeScript compiler — see the comment atop `component-ingester.ts` for why: this repo's own `typescript` devDependency is pinned to the v7 native rewrite, whose public surface no longer exposes the classic `createSourceFile`/`forEachChild` API a walk like this needs, only an early "unstable" service-based one tied to that exact version. A dedicated, stable, synchronous parser that doesn't move whenever the host project's own compiler does is the right call for something meant to run against arbitrary target repositories, not just this one.

Four ingesters, each independent and pluggable (`Ingester` in `types.ts`): manifest (`package.json`/`tsconfig`/`README`), component (React/JSX usage via real AST, not regex), route (Next.js App Router and Pages Router file conventions), and test (existing test titles, plus — because it's *our own* format and therefore actually readable — the URLs a `.flow.json` navigates to). `ContextEngine.build()` merges their output, and two rules carry over from elsewhere in this codebase rather than being reinvented:

- **An edge whose endpoint was never indexed is dropped, not guessed at.** Same "understate, never overstate" rule as `ax-coverage.ts`'s attribution honesty. A route ingester's guess at which component a page renders is only ever a guess at an *id* — if the component ingester didn't independently produce a node with that exact id, the edge is pruned in the merge step, not kept as a maybe.
- **A crashing ingester doesn't take the graph down with it.** Its warning lands on `graph.sources`, the other three still run — same reasoning as history/coverage being diagnostic and swallowed rather than failing a run.

`covers` edges are a second pass after merge (`linkCoverage`): a flow's recorded URLs are matched against route name patterns (`:id`, `*catchAll`), so the graph can answer "does anything already test this route?"

**Caching is a cheap composite signature, not per-file content hashing.** Every walked file's size and mtime feed one hash (`computeSignature`); a match short-circuits straight to the cached graph in `.wowlidator/context-graph.json` without touching an ingester. Content-hashing every file on each `generate` call would cost more than the parse it's meant to avoid repeating.

Wired into the generator additively: `TestGeneratorOptions.projectGraph` and `GenerateRequest.projectContext` are both optional. Omit them and generation is byte-for-byte what it was before this existed. When a graph is supplied, `toPromptContext()` walks outward from the URL's matched route — capped at `DEFAULT_CONTEXT_MAX_NODES`, same token-budget reasoning as `DEFAULT_MAX_AX_NODES` — never the whole graph. The CLI and MCP surfaces mirror this: `--context` / `context: true` opt in per call, `wowlidator context build`/`show` manage the graph on its own.

OpenAPI is the fifth ingester (`openapi-ingester.ts`), producing `operation` nodes — one per method+path, because two operations can share a path and `GET /orders` and `DELETE /orders` are different promises. `linkCoverage` matches them against the `METHOD url` pairs a flow's `request` steps record, so the graph answers "does anything already test this endpoint?" the same way it answers it for routes. **The method must match exactly**; crediting a `GET` against a declared `DELETE` would overstate coverage in precisely the way `ax-coverage.ts` refuses to.

**What it doesn't cover yet, on purpose, not by omission:** Vue Router, Angular's `RouterModule`, SvelteKit, Storybook, GraphQL schemas, OpenAPI `$ref`s that point outside the document (recorded as unresolved rather than guessed at), and Playwright/Cypress/Jest/Vitest test bodies beyond their `describe`/`it` titles (their bodies are opaque — arbitrary code, not a format we own the way `.flow.json` is). The `Ingester` interface is what makes adding one of those an additive, single-file change rather than a redesign — any file in `src/context/ingesters/` shows the shape.

## The control panel (`src/ui/`)

`wowlidator ui` (or `npm run ui`) serves a local page that puts every command, every option, the artefacts on disk and a manual in one place. Zero new dependencies: `node:http`, a command whitelist, and a page rendered from a TypeScript module.

**It runs the CLI; it does not reimplement it.** `JobRunner` spawns the same `wowlidator <command>` a person would type and forwards stdout/stderr line by line. A second execution path would be a second thing to keep correct, and the first symptom of it drifting would be a panel reporting a pass the command line calls a failure. Every run displays its own command line for the same reason: what you learn in the panel has to transfer to a script.

**`commands.ts` is the single declaration the forms and the argv builder share.** The page renders its controls *from* the specs and the server validates every submission *against* them, so a flag the UI offers is a flag the server accepts and a flag missing there is offered by neither. Adding a CLI flag to the panel is one entry in that file and nothing else. There is deliberately **no free-text "extra arguments" box** — submissions become an argv array for `spawn`, never a shell string, and a passthrough box would undo the whole arrangement.

**Browser commands are serialised, and refused rather than queued.** Two runs sharing one CDP endpoint interleave their clicks and the resulting report describes neither. Queueing would be worse than refusing: a run that starts ten minutes later against a page that has since changed is not the run anyone asked for.

Three constraints on the server that are load-bearing rather than tidy:

- **It binds to `127.0.0.1` and checks the `Host` header.** Without the header check any page you visit could point its own domain at 127.0.0.1 and drive this server through your browser — the ordinary DNS-rebinding attack on a localhost tool.
- **File reads are confined to known roots** (the working directory, the report and proof directories, the cache file's directory). `resolve()` collapses `..` *before* the prefix comparison, so a path that climbs out fails rather than being normalised into passing. A report viewer that served any path on the machine would be one crafted link away from being an exfiltration tool.
- **The client builds DOM through `el()`, not HTML strings.** Everything it displays — file paths, model reasoning, application text quoted back by a failing step — comes from somewhere else, and `textContent` cannot be talked into executing any of it. The one `innerHTML` is the manual, which is our own static content and says so at the call site.

**Output is buffered, not only streamed.** A page reloaded mid-run rejoins from the buffer (the SSE stream opens with a `replay` event) instead of watching an empty pane. Artefact links are *parsed out of the output* (`  report     /path…`) rather than re-derived, so a new artifact kind announced by a command shows up in the panel without `jobs.ts` knowing it exists.

**The page is one document, same as the HTML report and for a related reason.** `renderApp()` returns markup, CSS and script together, so there are no asset paths to resolve and it behaves identically under `tsx src/` and after `tsc` has emitted `dist/` — which copies no non-TypeScript files.

`ui` is dispatched in `src/cli.ts` **before** `parseArgs`, because the panel has its own flags (`--port`, `--no-open`, `--wow`) and putting them in the shared option table would make them appear valid on every other command, where they mean nothing.

## wowUI (`src/ui/wow-ui-html.ts`, `src/ui/proofs.ts`)

The second surface on the same server, at `/wow` (`wowlidator ui --wow` opens it directly). `app-html.ts` is organised around **commands** — pick one, fill the form, watch it run — which is right for driving a CLI and wrong for the question asked afterwards: *this flow has run eleven times, which run broke it, and what is the proof?* wowUI is GRIM's QA Command Center layout answering that, with wowlidator's nouns in it:

| GRIM | wowUI |
|---|---|
| builder / catalog | where the flow came from — authored, or generated from a page |
| task | a flow |
| cycle (loop 1..3) | a run of that flow |
| check (claim + verdict) | a step (`intent` + passed/failed) |
| evidence (screenshot, repro) | the step's screenshot, selector and recorded calls |
| fix targets (AI proposals) | the heal the healer proposed, and the agent's turns |

**The mapping is one-way and never invents a concept wowlidator lacks.** There is no oracle, so the panel that would show one shows defects instead; there is no builder to send feedback to, so the button that would is `run --repair`, which is what sending it back for a fix actually means here. Where GRIM marks a *vacuous* PASS ("did this really check anything?"), wowUI marks a step that only passed after a heal — a different doubt about the same thing, and one the bundle actually records.

**Two surfaces, one server, one command whitelist.** Every action posts to `/api/jobs` with a `commands.ts` id, and the command line it produced is shown while it runs. A second server would be a second place to get `fromLocalhost`, `isAllowed` and the argv-not-shell rule wrong.

**The stylesheet is GRIM's, ported onto the tokens in `reporter/theme.ts`** — `--teal` becomes `--accent`, `--paper` becomes `--bg` — so wowUI follows the same light/dark system as the report and the panel rather than being a third dialect. Class names are kept verbatim (`.side`, `.row`, `.rail`, `.chip`, `.tbl`, `.drawer`) so the two can be diffed by anyone who knows either. The `url(data:image/svg+xml…)` marks for the loop rail and verdict dots stay in this file: `theme.ts` has a test asserting it contains no `url(` at all.

**There is no `trustedHtml` here at all.** `app-html.ts` has exactly one `innerHTML`, for the manual it ships. wowUI has no static content to inject and displays nothing but data — selectors, model reasoning, application text quoted back by a failing step — so the escape hatch is simply absent, and there's a test asserting it stays absent.

Two things in `proofs.ts` exist because a bundle is big:

- **The list carries no steps, and therefore no screenshots.** `toCard()` is the projection; `/api/proofs` returns nothing else, and `/api/proofs/<runId>` fetches one run in full only when someone opens it. The page polls, so a list that carried evidence would move megabytes every five seconds.
- **Parsed bundles are cached on `path + mtime + size`.** A changed file has a changed signature, so a stale card is not a failure mode this can have.

**A run is addressed by `runId`, never by a path from the client.** The fast path is `<proof dir>/<runId>.json` and it is only taken for an id that cannot be a path at all; anything else falls back to matching the id against bundle *contents* found by walking the directory. There is no join of user input onto a directory to get wrong — the same reasoning as `isAllowed`, applied by making the question not arise.

**Polling, not a socket.** A run started in another terminal produces no event this server could push, and the page has to be right about it anyway.

**A finished run's command output sits collapsed under its report card.** The live job row disappears the moment the proof lands, which used to orphan the stream it carried — authoring narration, agent turns, progress lines. `jobForRun()` matches a run to the job that produced it by the run id in the job's announced artifact paths; the section renders only when a match exists (a run started from a terminal gets no dead control), fetches `GET /api/jobs/<id>` on first expand, and stays collapsed by default — the evidence is the point, the console is the receipts.

**Every step's runtime is in the checks table, with the run's total under it.** "It passed" and "it passed in 4.1s against a 2s fast-path budget" are different facts, and only the second one predicts next week: a step much over the budget either walked a rung past `fast` or is close enough to the edge that the next change breaks it. Anything ≥ 2s is amber. The footer states the sum of the steps *and* the wall clock separately, because the gap between them is connect and report time, not testing.

### API keys, and which one a run starts on

Two mechanisms, deliberately kept separate because confusing them would make the page lie.

**Rotation happens by itself, inside a run, and predates wowUI.** `LlmFactory.callWithFailover` walks a provider's configured keys (`GROQ_API_KEY=key1,key2`) whenever a call fails in a way that looks like the *key* — auth, quota, rate limit, per `isKeyExhaustedError` — and stays on whichever answered. The move is **sticky and shared across every role on that provider**, so a healer and a data role pointed at the same exhausted Google key do not independently rediscover it, and the cursor advances *before* the retry so a concurrent call does not either. A failure that is not about the key never rotates: spending a second key on a call that was never going to succeed would waste it and hide which model actually failed. Every move is written to stderr, so it lands in the run's output and is visible in wowUI's run drawer.

**`ui/keys.ts` is the other half: where a run *starts*.** Three rules:

- **A key value never leaves the panel's process.** The browser gets a mask (`gsk_…a91f`) and an index; selecting a key POSTs the *index*. Rendering a live credential into a page would put it in the DOM, in browser memory, and in any screenshot of the window, for no gain — nothing in the UI needs the characters. There is a test asserting no key value survives into `describe()`.
- **Selecting reorders, it never removes.** The chosen key is moved to the front of the list the spawned CLI inherits and *every other key follows*. Sending only the chosen one would silently turn a two-key setup into a one-key one at the exact moment someone was working around a bad key.
- **Nothing writes to `.env`.** The selection lives as long as the panel does. `POST /api/keys/reload` re-reads the file (and prunes a selection that now points past the end); editing it is a decision about the machine, not about this run.

`JobRunner.start()` takes an env overlay for this, applied *on top of* `process.env` — a run still needs PATH and everything else.

The launch modal takes **documents, never a flow** — see [Catalogs](#catalogs-srccatalog). Three modes: **Add Context** stores background and starts nothing, **Add Catalog** reads a document's claims and proves the ones you tick, **Describe** → `go`, which dispatches a URL to generation and a sentence to authoring.

**Nobody picks a flow here, and that is the change, not an omission.** A flow is what wowlidator writes; asking a person to select one made the panel a file browser for an artefact they do not maintain. There is a test asserting no flow selector comes back.

Two capabilities in `commands.ts` exist for this and are worth knowing about before adding a command:

- **`fixedFlags`** — flags a command always carries with no control of its own. `catalog --claims-only` and `catalog --claims <file>` are two panel actions backed by one CLI command, and the flag that distinguishes them stays *in the whitelist* rather than being appended by the server, so what runs is still exactly what that file declares.
- **`repeatable`** — `--context-doc a.md --context-doc b.md`. The UI sends an array and anything else is refused, so a repeatable flag cannot be smuggled in as one string containing a separator.

Uploaded documents land in `.wowlidator/catalogs/` and `.wowlidator/context-docs/` (`ui/uploads.ts`). **The file name is rebuilt, never used** — only the extension survives, and only if the extractor can read it. Deletion has the narrowest rule in the server: a name, in one known directory, with a readable extension, rather than the general roots check, because it is the one operation here that destroys something.

## Catalogs (`src/catalog/`)

The thing a team already has is not a flow. It is a requirements page, a QA checklist, a spreadsheet of cases, a PDF spec. `wowlidator catalog <file>` is the path from that to a test, and it is **two steps with a gate between them**:

```
document ──► claims ──► (a person prunes) ──► cases ──► a run each
```

**The gate is the point.** Handing a whole document to a model and running whatever comes back spends tokens and a browser on work nobody has looked at, against claims the model may have read out of a heading. Claims extraction is one cheap call and no browser; a list of sentences is something a person scans in seconds. `--claims-only` stops there and writes a claims file; `--claims <path>` authors from what survived. Running it in one go is allowed and is the wrong default — the panel never does it.

**Claims extraction is not authoring.** It asks only *what does this document assert*, never *how would you test it* — no selectors, no steps, no page. Grounding stays where it is already solved: `FlowAuthor` writes the steps against a live AX tree, so selectors come from the page rather than from the document. Routing reuses the `generator` role for the same reason `src/repair/` does — a large prompt in, a small flat shape out.

**Every listed case is reported, including the ones that could not be run.** `runCases()` in `src/cli/run-cases.ts` is the one loop behind both `catalog --run` and `generate --run`: it runs the list, prints one roll-up line per case, writes the suite index, and returns outcomes for `suiteExit()`. Three verdicts, not two — `passed`, `failed`, and **`blocked`**, which means the case produced no verdict about the application at all.

- **A dead browser is not an exception, it is a bundle.** `runFlow` catches a failure to attach and returns a bundle with status `failed`, zero steps and the error on it — so a `try`/`catch` around the call almost never fires, and every case after the browser went away was reported as a red ✗ with nothing under it. Read literally that says the application broke in seven new ways. `neverRan(bundle)` is the real test: **the run failed but no step of it did**, so either nothing ran or it broke off with no assertion contradicted. (The `try`/`catch` stays for the narrower case of something throwing before there is a bundle.)
- **Blocked is not failed**, the same distinction `proofs-to-artifacts.py` makes for a step that never ran: scoring the harness's own gap as a defect sends someone hunting a bug nobody claimed existed. It is not a pass either — `suiteExit` returns `EXIT.failed` if anything really failed, else `EXIT.environment` if anything was blocked, else `ok`. Sibling of `exitCodeFor`, which does the same for a single run by matching the error string; this one decides structurally and so also catches a browser that died mid-run.
- **Blocked cases appear in the suite index** (`BlockedEntry`), listed first, counted in the denominator, linked to their report when one was written. An index showing 7 rows for a 10-case suite reads as a 7-case suite, and "7/7 passed" is a lie the reader has no way to catch.
- **Every non-pass line says why.** A bare ✗ was the worst of both: it read as a defect and gave nobody anything to act on. Reasons are trimmed to their first line — the attach error carries a two-line "start Chrome like this" hint, and seven of those turn a ten-line summary into a wall.

Still open: JUnit/CTRF count a blocked case as a 0-test suite, so CI sees it as absent rather than as blocked. `neverRan` is the seam to fix that through.

**A catalog authors discrete cases, and each is run on its own — one failure is noted, never fatal.** A document asserts several independent things; a flat step list stops at its first failure, correctly, because everything after it is in an unknown state. Put six approved claims in one flow and the second failure leaves four claims unanswered while the report shows only the one that broke — the exact opposite of what the review gate was for. So the authoring prompt asks for one case per claim, `AuthoredStepSchema.case` labels which case each body step belongs to, and `splitIntoCases()` partitions the body; the CLI turns each case into its own flow (**sharing `setup` and `teardown`, which is what makes a case independent of the one before it — setup runs again before each**), runs them all, and prints a roll-up plus a suite index. Same principle as `fillEach`, one level up. Three rules hold the split honest:

- **Consecutive steps with one label are one case, and order never changes.** Two runs of the same name are two cases (`rows`, `rows (2)`), because gathering them would move steps past ones they depend on.
- **A case with no assertion is not a case** — it is preparation for the case that follows, or cleanup for the one before, and is folded into that neighbour. Run alone it would pass whether or not the feature worked. A body that asserts nothing *anywhere* is handed back whole so `FlowAuthor` refuses it as it always did.
- **`case` is the one authored field a step may decline to fill.** It decides how the body is divided, not what any step does, so a model that omits it costs the isolation between cases and not the whole authoring call: unlabelled everywhere is one case, byte-for-byte what this produced before cases existed. That degradation is what the `LlmFlowAuthorModel` payload in `tests/flow-author.test.ts` exercises. It is expressed as **`z.string().nullable()` behind a `z.preprocess` wrapper**, not `.default('')`, and the split is load-bearing in both directions: zod emits a defaulted field as *absent from* `required`, which strict providers reject outright (see [Structured output on free tiers](#structured-output-on-free-tiers)), while a plain `.nullable()` would put the key in `required` and then reject the lenient provider that drops it — the very degradation this field exists to allow. The wrapper emits the `.nullable()` schema and fills a missing key with `null` on the way in, so both halves hold.

**A claim marked `testable: false` is kept and never checked.** "The user is signed in as an admin" sets up the claims around it; dropping it loses what they depend on, and turning it into an assertion reports a failure about a precondition. It goes into the authoring prompt under *assume this is already true*.

**Context documents are a second input, labelled apart from the catalog.** `--context-doc` is background the model may read to understand a term; it asserts nothing and is never a source of claims. The two are separate sections in both prompts for the same reason a probe report is kept apart from the AX tree in `flow-author.ts`: a model that conflates them writes claims about the API documentation instead of about the application. Note the flag is **`--context-doc`, not `--context`** — the latter already means the static repository index, and two things called context would be one flag away from silently doing the other's job.

**The claims file is the gate as a file.** Plain JSON, one `approved` boolean per claim, so the review can happen in an editor, in a diff, or in a browser without any of those being the only way — and so what ran is a file you still have afterwards. Everything starts ticked: a gate that begins empty is one everyone clicks "select all" through. An absent `approved` key means approved, so a hand-written claims file does not have to say yes to every line.

### Reading the document (`src/catalog/extract.ts`)

Markdown, CSV, HTML, text, JSON, YAML, **Excel and PDF** — and both binary formats are parsed here rather than by a dependency. Each is a container this needs one narrow thing from (cell strings; text-showing operators), and a library that can render a spreadsheet or rasterise a page is a lot of surface to carry into a test framework for that. `node:zlib` supplies the only hard part.

**The rule that outranks the formats: never hand back text that is not in the document.** This is the one step where a silent mistake is invisible downstream — a model asked to write tests from mangled text writes plausible tests about nothing, and the claims, the steps, the run and the green report all inherit the error while looking exactly like success. So an unreadable format is **refused by extension, not sniffed**; a PDF with no text layer **throws** naming the likely cause instead of returning a scan's stray characters; and anything approximated comes back on `note`, which the CLI prints and the UI shows rather than logging.

Four details found by running it against real files:

- **Only what sits between `BT` and `ET` is a PDF's text.** An embedded ICC profile or font program inflates just as happily as page content and is full of bytes that look like string operands. Scanning whole streams turned a three-line checklist into three lines followed by 15,000 characters of mojibake.
- **PDF fonts are not read.** A custom encoding yields plausible-looking nonsense rather than an obvious failure, so `garbledNote()` warns when too much of the result is outside the scripts this codebase expects. One wrong em-dash is not worth a warning; a page of them is.
- **A ZIP is read through its central directory**, never by scanning for local headers: a local header's sizes may be zero with the real values in a trailing data descriptor, and a scanner that trusts them walks into the middle of a compressed stream.
- **A sparse spreadsheet row keeps its column letters.** A row with values in A, D and Q is not a three-column row, and flattening it would move data under the wrong heading.

There is a real `.xlsx` (written by openpyxl) and a real `.pdf` in `tests/fixtures/`: a ZIP reader tested only against its own writer proves the two agree, not that either is right.

## Conventions and gotchas

- **The CLI is one entrypoint plus a package.** `src/cli.ts` keeps only what must stay at the bin path — the shebang, `main` (with the `ui` pre-`parseArgs` dispatch and the full option table), `cmdRecall`, and the test-facing re-exports (`EXIT`, `neverRan`, `suiteExit`, `exitCodeFor`, `classifyError`, `CaseOutcome`). Everything else lives in `src/cli/`: `usage.ts` (help text), `exit.ts` (the exit-code contract and suite verdicts), `options.ts` (`CliOptions` + flag parsing helpers), `runtime.ts` (model/logger builders, role gate), `artifacts.ts` (report/flow/Chrome side-effect helpers — `chromeStartedByUs` is module-private there on purpose), `run-cases.ts` (the shared suite loop), and `commands/{run,authoring,maintenance,go}.ts`. Dependencies flow strictly downward; `commands/go.ts` is the only cross-family edge.
- **CDP is connect-only.** `SmartRunner.connect()` calls `chromium.connectOverCDP` and never launches a browser. `close()` disconnects rather than killing Chrome, so a developer's browser survives a run. `SmartRunner.attach()` exists for embedders that own the browser lifecycle.
- **The AX tree, not the DOM.** `captureAxTree` goes through a raw CDP session (`Accessibility.getFullAXTree`), not Playwright's deprecated `page.accessibility`. It prunes ignored nodes, structural noise, and unnamed non-interactive nodes, and caps at `DEFAULT_MAX_AX_NODES`. This is a token-budget decision — raising the cap raises the cost of every repair.
- **MCP owns stdout.** Anything written to stdout in `src/mcp/` corrupts the protocol stream. Diagnostics go to stderr.
- **`exactOptionalPropertyTypes` is on.** Optional properties need `?: T | undefined`, not `?: T`, wherever `undefined` may be assigned. This bites most often on `FlowStep.intent`.
- **`parseArgs` has no `--no-x` negation.** `--no-heal` and `--no-agent` are declared literally as the options `'no-heal'` / `'no-agent'` in `src/cli.ts`.
- **`types: ["node"]` is pinned in tsconfig.** Automatic `@types` discovery broke once the AI SDK dependency tree landed — every Node global vanished. Being explicit also stops unrelated `@types/*` leaking globals into the build. Don't remove it.
- **AI SDK v4 provider shapes are nested.** `finishReason` is `{ unified, raw }`, not a string, and provider-level usage is `usage.inputTokens.total`, not a number. (The `generateObject` *result* flattens it back to `usage.inputTokens`.) `tests/helpers.ts` encapsulates this — build mocks with `jsonModel()` rather than hand-rolling the shape.
- **Fixture servers need `closeAllConnections()`.** Chrome holds keep-alive sockets; without it the test suite's `after` hook blocks for ~60s.
- Cache writes are temp-file + rename, and a corrupt cache file is reported to stderr and ignored rather than aborting a run.

## Negative testing (`MutationPolicy`)

Three tiers on `TestGenerator`, default `forms` (`DEFAULT_MUTATION_POLICY` in `test-generator.ts` is the single source):

| Policy | May do | Never |
|---|---|---|
| `read-only` | navigate, read, assert | submit anything |
| `forms` | submit **empty/invalid** input to exercise validation | submit valid data that writes |
| `mutations` | create and update | delete, purchase, bulk ops |

`forms` is the interesting tier and the reason it is now the default: submitting an empty required field is *not* destructive — validation is what stops the write, and verifying that is the entire negative-testing surface, which a `read-only` default silently excluded from every generated suite. `mutations` stays opt-in because an autonomous test writer that can mutate data is not something to opt *out* of; DELETE appears at no tier.

## Boundary-value analysis (`fillEach`)

One field, several values, an assertion after each. **Every case runs even after one fails** — a partial boundary table is far less useful than the whole one when you are trying to find where behaviour changes.

`submit` is the load-bearing option: validation usually fires on submit, not on input, so without it every case asserts against a form that never ran. That was found by running it, not by reading it.

## Visual regression (`src/visual/baseline.ts`)

Screenshots were already captured as *evidence*; `snapshot` turns them into *assertions*. A CSS regression that makes a page unreadable passes every functional test ever written, because the DOM is fine and only the pixels are wrong.

- **PNG, never JPEG** — lossy artefacts register as pixel drift.
- **A missing baseline is created and passes**, with `outcome: 'created'` and a message saying nothing was verified. Failing the first run would make the feature unusable in CI.
- Baselines are keyed by **author-chosen name**, not step index, so inserting a step earlier does not invalidate everything after it.
- A viewport change reports `size-mismatch` rather than a meaningless 90%-drift number.

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

## Keyboard and focus

`press`, `expectFocused`, `expectTabOrder`. Focus order is the one accessibility property that cannot be read from a static tree — it only exists while tabbing.

**Two traps in `expectTabOrder`, both found by running it:**
- `body.focus()` alone is a no-op; body is not focusable without a `tabindex`.
- `activeElement.blur()` clears `activeElement` but leaves Chrome's *sequential focus navigation starting point* on the old element, so the next Tab resumes from there.

Temporarily setting `tabindex="-1"` on body and focusing it resets both. Don't "simplify" that back to a blur.

## UI coverage (`src/coverage/ax-coverage.ts`)

Code coverage answers "which lines ran"; UI testing normally has no equivalent, so suites drift into testing the same three buttons forever with no instrument to detect it. The AX tree is already captured for healing, and it *is* an inventory of every operable control — so the question becomes answerable.

`measureCoverage()` runs in `SmartRunner.close()`, before teardown, and compares interactive controls against the selectors steps resolved.

**The number is shown only where it can mean something** (`meaningfulCoverage`). The inventory is one capture, at close, of the page the run *ended* on — so on a multi-page journey the denominator is one page's controls while the numerator drew selectors from every page crossed. "1/72 (1%)" on a login → navigate → detail flow is not a low score, it is a category error, and printing it teaches people to ignore the instrument on the runs where it is real: single-page suites, the designed use. Measurement still happens and the bundle/history still carry it; the CLI line, the report's coverage card, the untouched-controls table and the trend delta are display-gated to runs whose resolved selectors all sat on one origin+path.

The load-bearing detail is **attribution honesty**. A step that resolved `role=button[name="Next"]` maps onto a tree node; `.pagination__next` does not, because a CSS selector carries no role or name. Those land in `unattributed` rather than being silently credited — coverage must understate, never overstate. There's a test asserting CSS selectors are refused.

Coverage failures are swallowed: it is diagnostic, and must never fail an otherwise good run.

## Reading the report (`src/reporter/verdict.ts`)

The report used to answer "what did the machinery do" before "what happened and who should act". Three layers now, strictly ordered: **verdict** (what broke, which side, is it new), **timeline** (intent-first steps, failures auto-expanded), **diagnostics** (rungs, tokens, coverage, trend — collapsed).

**Every sentence in the verdict is a pure function of the bundle** (`buildVerdict`), which is what makes the wording testable rather than buried in a template, and what guarantees it cannot contradict the evidence below it. `ownerOf` deliberately mirrors `ProofSummary`'s defect attribution — a report that says "frontend problem" above a defect table filing it under backend is worse than one that says nothing.

**Jargon is renamed only in layers 1–2**; layer 3 and the JSON keep the precise terms, so nothing downstream has to care. Every badge that survives carries its plain-language explanation inline via `GLOSSARY`, and there is a test asserting no badge can be rendered without an entry — a new badge with no explanation is exactly the failure this section fixed. `fast` is deliberately unbadged: every ordinary step resolves that way, so labelling it adds noise to the steps needing no attention.

**Failure evidence is ranked by diagnostic value**, not by source: intent and one-line error, screenshot, the escalation trace as prose (`escalationTrace`), failed network calls, then raw detail. An unrecognised rung passes through with its own name rather than being dropped — a rung added later must never silently vanish from the account of what was tried.

**Captured application text is quoted, never translated**, and marked `lang=""` when it leaves the Latin script: a report is evidence, a translation is a claim about evidence, and naming a language we did not detect would be a second claim. Only non-Latin text is marked, or every selector in the report grows an attribute that says nothing.

## Proof bundles and the report

`ProofBundleBuilder` records, per step, *how* the selector resolved (`fast` / `cache` / `jit`) alongside pass/fail, plus any `AgentRecord` and screenshot. The summary rolls that up with heal latency, agent latency, token usage, and defect count. That breakdown is the point: a suite whose `jitHeals` count is climbing is drifting, and the bundle is what tells an MCP client so. Bundles land in `.wowlidator/proofs/<runId>.json` by default.

Steps with no selector (`goto`, `workflow`, and every action in `API_STEP_ACTIONS`) have `resolution: null` and are excluded from the `fastPath` count — a 4-step flow with one `goto` reports `fastPath: 3`. An HTTP step is free, but `fastPath` counts *selector resolutions on a page*; crediting a `request` there would put backend work inside a frontend number.

**`summary.frontend` / `summary.backend` split the run by which side of the system a step exercised** (`API_STEP_ACTIONS` in `proof-bundle.ts` is the one definition of "this is an HTTP step", shared with `isBrowserFree()`). A mixed flow's headline pass/fail cannot answer the question anyone actually asks when it goes red — *which side is broken* — and a failed `expectVisible` and a failed `expectStatus` go to different people. Defects are attributed by a three-step rule, and the ordering is the load-bearing part: **category `backend` wins outright** (it is raised for traffic the *page* made, so it can sit on a `click` step and still belong to the API side), otherwise **the step's own side decides** (a malformed `request` counts against the half of the test it lives in), otherwise **frontend** (a static generator finding has no step, and the generator only ever looked at the UI). `frontend.defects + backend.defects` always equals `defects`; there is a test asserting the halves reconcile with the headline. The CLI prints the two lines only when there is a backend half to report — `backend 0/0` on every UI run would be noise pretending to be information.

**`ProofStep.intent` is carried through verbatim from `FlowStep.intent`, never regenerated.** Both `#step` (the escalation-ladder path) and `#bareStep` (absence assertions, storage seeding — anything with no selector to heal) copy it onto the recorded step; `html-reporter.ts` renders it as an always-visible line under the step header, in the author's own words from the `.flow.json`, so a report reads as "what this step checks" rather than only "what selector it hit." It is deliberately dropped from the generic detail key/value dump so it isn't shown twice.

**Live console progress is opt-in callbacks, not `console.log` calls buried in engine code.** `ProofBundleBuilder`'s `onStep`, threaded through `RunFlowOptions.onStep`, fires synchronously right after every `addStep()` — the single choke point every action (`goto`/`click`/`#step`/`#bareStep`/`fillEach`/`fillRetry`/`snapshot`/`workflow`) already goes through, so one hook covers all of them for free. `WorkflowAgent`'s pre-existing `onAction` gives the same thing per agent turn (a `workflow` step can run for several seconds across multiple model calls with no other visibility into it before the step as a whole finishes). `FlowRepairLoop`, `TestGenerator`, and `FlowAuthor` each take a plain `onLog?: (line: string) => void` for their own lifecycle narration ("asking the generator role for a fix…", "got N case(s)…"). None of this prints anything by itself — `src/cli/runtime.ts`'s `stepLogger()`/`lineLogger()` wire `console.log` in, gated off under `--json` (whose stdout must stay one parseable document), and `src/mcp/server.ts` passes neither, so MCP's stdout stays exactly as clean as the "MCP owns stdout" rule already requires. `formatStepLine()`/`formatAgentAction()` in `proof-bundle.ts` own the line formatting, same separation as `formatProofSummary`.

**Defects** come from two sources and the report labels which: `generator` (static findings from the AX tree, no run required) and `runtime` (a failed step, a failed workflow goal, or — at `low` severity — a selector that had to be healed, since that means the test is drifting from the app).

**Identical runtime defects cluster at recording time** (`addDefect`: same title, selector, category, severity → one defect with `occurrences` and `stepIndexes`) — eleven copies of one broken login block read as eleven problems when they are one problem hit eleven times. Generator findings never cluster. **Failures after the first are marked `ProofStep.downstream`** — possibly consequences, not findings — and the report badges them so. **`ProofStep.pageContext`** carries what the page was showing at a failure (AX headings already captured for the heal — never a fresh capture), and the verdict leads with it: "the page was showing 'Access Denied'" outranks "could not resolve". **Video offsets are reconciled at `setVideo()`**: the recording is cut at the first failure, so any step offset at or past `durationMs` is stripped — a "play from here" that seeks past the last frame is a dead control pretending to be evidence. An absence assertion that passes after an earlier failure gets a **"passed, in doubt"** badge: "not shown" is also what a broken page looks like.

`html-reporter.ts` is a pure function (`renderReport`) plus a writer. Constraints that must hold:
- **Self-contained.** Inline CSS and JS, screenshots as `data:` URIs. No `<script src>`, no external stylesheet, no remote image — the report has to open off a USB stick. There's a test asserting this.
- **Escape everything.** Page text, model reasoning, and defect titles all reach the HTML. Use `esc()` on every interpolation; there's a test that feeds `<script>alert()</script>` through a defect title.
- Failed steps auto-expand on load; everything else starts collapsed.

**Report destinations** resolve through `resolveReportPath()` in the reporter — one function, used by the CLI and MCP alike. It handles file vs directory vs `{placeholder}` template and returns `null` when reporting is off, so callers branch once instead of threading a flag around. Two things to preserve if you touch it:
- `{name}` / `{kind}` go through `slugify()` because they can come from a model. Dropping that reintroduces a path-traversal write. There's a test for it.
- The trailing-separator check must happen **before** `resolve()`, which strips it.

Precedence is CLI flag → env (`WOWLIDATOR_REPORT_PATH` / `WOWLIDATOR_REPORT_DIR` / `WOWLIDATOR_DISABLE_REPORT`) → `.wowlidator/reports/`. Multi-report commands pass `index` and `kind` in the context so generated cases can't overwrite each other.

### The run on film (`src/engine/video.ts`)

**A still cannot show a click.** It shows the page before one and the page after one, and those two images are identical whether the click landed on the right control, the wrong control, or nothing at all. So the default evidence is a **recording** (`VideoMode`, default `on`), and stills are kept only where someone will zoom in.

**A recording is evidence of a failure, and it is kept only when there is one.** The rule, in full: *when a step fails, keep the film from the start of the flow to that step; if that cannot be done, keep none of it.* Three parts, each load-bearing:

- **From the start**, because the state leading up to a failure is most of what makes it diagnosable — the click two steps earlier that went to the wrong control is the thing worth seeing, and it is unrecoverable afterwards.
- **To that step**, because a recording that carries on past the failure buries the moment it was kept for. The cut is clamped so it can never reach the *next* filmed step (`SmartRunner.#videoCut`): a run continues after a failure, and film of what happened afterwards is no longer film "up to the failure". The **first** failure, not the last — after one step fails the run is in a state the test no longer understands, so later failures are usually consequences.
- **A superseded failure is not the failure.** In-run reconstruction can rescue a step mid-flight; cutting the film at the rescued attempt produced a PASSED run whose recording showed two steps of five (seen live: "Navigate to Contact Us Page"). `#videoCut` skips superseded steps, and a run that was rescued keeps its **whole** film — the break and the rescue are exactly the footage the drift defect asks someone to look at.
- **Otherwise nothing.** A run that passed cleanly keeps no recording at all, which is what makes filming affordable as a default: the reports that carry one are exactly the ones somebody opens. And a recording that cannot be cut faithfully is discarded rather than handed over whole — see `webm.ts`.

Two things had to be established by running it, and both shape the design:

- **Playwright records over a CDP connection, but only on a context it created.** `recordVideo` is a `newContext` option with no way to switch it on for a context the browser already has. So `SmartRunner.connect` stops reusing `browser.contexts()[0]` when filming — **which means a fresh cookie jar**, and that is the real cost of this feature, not a detail. It is the entire reason `--video off` exists: a run that depends on a session someone signed into by hand must turn filming off.
- **Playwright videos contain no mouse pointer.** The browser composites the page, not the cursor the OS draws on top of it, so a recording of a perfectly good click is a recording of a page changing for no visible reason. **The pointer is drawn by the page**, from `CURSOR_OVERLAY_SOURCE` injected via `addInitScript` — a dot that follows the synthetic input, turns green and pulses a ring on mousedown, plus a caption naming the step now running (`SmartRunner.narrate`), so the video is still an account of a test after it has been pulled out of the report and attached to a bug.

**`CURSOR_OVERLAY_SOURCE` is a source string, not a function, and that is load-bearing.** `addInitScript` serialises a function with `Function.prototype.toString`, so what reaches the browser is whatever the *build* left behind — and under `tsx` the transpiled arrow installs nothing at all: no error, no warning, no pointer. Passing source verbatim removes the build from the path. There is a test asserting it stays a string.

The overlay is injected into the application under test, so three rules keep it from becoming part of what the test measures: a **closed shadow root** (the page's own queries, every flow selector and the healer see one anonymous zero-size host and nothing inside it), **`aria-hidden` + `pointer-events: none`** (absent from the AX tree the healer and coverage inventory read; can never intercept a click), and **it installs itself late and repeatedly** — at document-start `document.documentElement` is still `null`, so a single attempt is guaranteed to be too early. There is a test asserting the overlay changes nothing a flow can see.

**One recording per run, addressed per step.** `ProofStep.videoOffsetMs` is stamped in `ProofBundleBuilder.addStep` — one derivation rather than eighteen call sites — and the report turns it into a "play from here" on every step. That is what makes a single clip per-step evidence instead of something a reader has to scrub. An HTTP step gets no offset for the same reason it gets no screenshot: nothing about a `request` happened on screen.

Frames are capped at 960 on the long edge and the whole recording at 24MB; over that the report says the recording was made and not embedded, because "it did not fit" and "nothing was recorded" are different facts. Sealing happens **between closing the context and closing the browser**, in that order — Playwright finalises a video when its context closes, so asking earlier reads a truncated file no player will open.

**The cut happens in the container, with no encoder** (`src/engine/webm.ts`). Playwright can only stop recording by closing the context, which is the end of the run, so the trim is done afterwards on the finished file — and dropping the *tail* of a WebM needs no re-encoding, because frames are stored in order and nothing kept still refers to what was removed. (Cutting the *head* would be a different problem: every frame after a keyframe depends on it. The segment always starts at zero, so that never arises.) Playwright writes one cluster per ~5 seconds, which is far too coarse to end at a step, so the cut is made **block by block inside the last kept cluster**; `Cues` and `SeekHead` are dropped rather than rewritten, since their byte offsets do not survive it. The output is then **re-parsed and verified before it is returned** — same rule as `catalog/extract.ts`: never hand back something we could not check. Anything unexpected returns `null`, and `null` means no video at all. A subtly malformed recording is worse than none, because it plays for three seconds and quietly misrepresents when the run ended.

Three more found by running it, each now load-bearing:

- **Chrome will not load a `data:` video.** The element sits at `readyState 0` / `networkState 2` forever with no error, which reads exactly like a corrupt recording — and it is not: the same bytes play instantly from a Blob. So the base64 is carried on a `data-webm` attribute and the page's own script turns it into an object URL. The bytes are still inline, so the report is still one file. Diagnosed by extracting the base64 back out of a rendered report and playing it, which worked.
- **A named function inside `page.evaluate` is a landmine under `tsx`.** esbuild rewrites `const wait = (ms) => …` into `__name(wait, "wait")` to preserve `fn.name`, Playwright ships the function's *source* to the browser, and `__name` does not exist there — so the whole callback dies with `ReferenceError: __name is not defined`. This is the same hazard as `CURSOR_OVERLAY_SOURCE` being a string, in a second place. It was live in `evidence.ts`'s `primeLazyContent`, where `captureEvidence` swallows everything, so the symptom was not an error but a silence: the lazy-content walk never ran under `tsx`, and full-page captures of a lazy-loading page were the skeleton loaders that function exists to prevent. **Keep every function inside an `evaluate` callback anonymous.**
- **A caption does not survive a navigation.** It lives on the window, and a navigation replaces the window — so without `keepCaption` (a `framenavigated` listener, not a re-caption inside `goto`, because a click can navigate too) the film runs uncaptioned from the moment a page loads until the *next* step starts. That is precisely the stretch a `goto` is on screen for, so the one step whose caption matters most would be the one that never showed it.
- **Nothing else will close the recording context.** Between `newContext` and a constructed `SmartRunner` there is a window where a throw would abandon it, and an abandoned context is not garbage — it is a live context in a Chrome that outlives the process, one per failed run. `connect()` unwinds it explicitly.

**`--video always` keeps the whole recording whatever the outcome** — the film of the mock user performing the task, end to end, untrimmed (still parsed and measured before it is trusted, like every cut). It exists for "view actual flow": wowUI's run detail plays the film in a modal with a **live subtitle bar** driven by the bundle's own `videoOffsetMs` segments — which step the mock user is performing at this moment — and a step-chip timeline; the failing segment and chip turn red and carry the error's first line, so the film shows *where* it broke and the subtitle says *how*. A run with no film offers **Record actual flow**, which re-runs the flow with `video: always`. The HTML report's player carries the same subtitle bar (`data-segments`, server-rendered). Superseded attempts get no subtitle highlight — they are attempts, not outcomes.

**Steps are paced for a viewer only when a viewer is the point.** `stepDelayMs` pauses before each step — after the caption, so the viewer reads what is about to happen and sees the state it starts from. Defaults: `DEMONSTRATION_STEP_DELAY_MS` (1.5s) under `--video always`, zero everywhere else — the hot path stays hot. `--step-delay <ms>` / `WOWLIDATOR_STEP_DELAY` set it explicitly for any run; a crawl is never paced (nothing films it).

**`--video off` restores the old behaviour wholesale**: no recording, and stills on every step.

**Stills follow the recording unless set explicitly** (`ScreenshotMode`; `--screenshots auto` and `WOWLIDATOR_SCREENSHOTS=auto` are how "unset" is said out loud, which is otherwise inexpressible once the env var is set). Filming drops them to `on-failure`: the film already carries every other step, and what a still adds over a frame is resolution, which matters at exactly one place. With `--video off` the mode returns to `all` and everything below is exactly as it was.

**A crawl is never filmed.** It drives a page borrowed through `withPage` rather than a recording context, so stills remain its only evidence — and `--video` says so rather than offering a control that does nothing.

### Stills

**When they are captured, they are captured on every step, not only the one that broke** (`ScreenshotMode`, `all`). A failure screenshot shows the wreckage; the frame *before* it is usually where the wrong thing actually happened, and that frame cannot be recovered afterwards — re-running to look changes the very timing that produced it. `SmartRunner.#shoot` takes an `EvidenceKind` rather than two booleans, and the three kinds are what make "every step" affordable:

- `failure` — the step that broke.
- `notable` — passed, but something happened worth seeing: a heal, a dismissed dialog, an agent turn, a regenerated data value.
- `routine` — passed, uneventfully. Individually dull, collectively the filmstrip.

Two size decisions, because a report is one self-contained file and every byte lands in it: **`scale: 'device'`** (full native resolution — a capture someone zooms into must not have been downsampled; the JPEG quality tiers absorb the size pressure), and **routine frames encode at a lower JPEG quality than the ones being examined** — a filmstrip frame is looked at to see roughly what was on screen, a failure screenshot is looked at closely.

**An HTTP step gets no screenshot even under `all`.** It never touched the page, so a picture of the page is not evidence about it — the request/response pair already recorded is. Evidence proportionate to what the step exercised.

**The filmstrip reads as one connected journey, and the eye lands where it snapped.** Frames are chained with arrow connectors (step N → step N+1), each labelled with its index and action; the connector *into* a broken frame turns red, the frame itself wears a red ring and ✗, and "broken" covers every non-pass status — `failed` alone once missed `error` and `dead-end` frames entirely. On load the strip scrolls the first broken frame into view, and the video player opens pre-seeked to the failing step's offset (`data-failure-offset`, server-rendered): the recording exists because a step broke, so the first frame a reader sees is the one it was kept for.

The report shows this as a **filmstrip above the timeline, assembled in the browser from the images already in the document** — each screenshot is emitted exactly once, inside its own step, and the strip reuses those `src` strings. Rendering the strip server-side would double the size of a file that already carries every image inline; there's a test asserting the count of embedded images equals the number of frames. There is deliberately **no `screenshot` badge** any more: every step has one, so it marks the ordinary case and tells a reader nothing — the same reason `fast` is unbadged. The Diagnostics cards state how many steps carry evidence and what it weighs, because report size is the whole cost of this default and should not be a mystery.

**The MCP `run_flow` response strips screenshots** and returns `hasScreenshot: boolean` instead; megabytes of base64 in a tool result is a model-context disaster, and that matters roughly nine times more now than it did when only failures carried one. **The recording is stripped the same way**, leaving its width, height and byte count — it is the largest single thing a bundle can carry, and there is nothing a model can do with a webm.
