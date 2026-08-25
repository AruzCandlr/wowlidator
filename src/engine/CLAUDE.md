# CLAUDE.md — the execution engine

Split out of the root CLAUDE.md (2026-08-24) so this loads only when working under
`src/engine/`. Same authority as the root file; the root keeps the map of the whole system.

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

`use` and `when` are the two actions that never reach `#resolve` *or* `#bareStep` in the usual way — `use` is gone before the run starts, and `when` records itself while its condition deliberately bypasses healing. When adding an ordinary action (e.g. `hover`), it must go through `#step` → `#resolve`, or it silently loses healing. **Five** places to touch: the method on `SmartRunner`, the `FlowStep` union, the `switch` in `executeStep` (the dispatch moved out of `executeFlow`; there is a second, browser-free switch in `executeApiSteps`), `flowStepSchema` in `src/mcp/server.ts`, and the `GENERATOR_ACTIONS` list plus `toFlowStep` in `src/generator/test-generator.ts` (otherwise the generator can never produce it). An HTTP action has a sixth place: `API_GENERATOR_ACTIONS`/`toApiFlowStep` in `src/generator/api-test-generator.ts`. An *assertion* has a seventh: `ASSERTION_ACTIONS` in the runner, or `hasAssertion()` silently rejects every generated case that relies on it. And an action the *catalog* path should be able to author has an eighth: `AUTHOR_ACTIONS` plus `flow-author.ts`'s own `toFlowStep` — catalogs author through `flow-author.ts`, not `test-generator.ts`.

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

## Scrolling and history

`back`/`forward` turn a list page into a journey — open a card, check it, come back — without re-navigating and losing the state the journey was testing. Two traps, both found live: **`goBack` must use `waitUntil: 'commit'`**, because a back navigation restored from the bfcache fires no load event and the default wait times out on exactly the pages where going back worked; and **it must let an in-flight navigation settle first** (`#settleNavigation`), or a `back` immediately after a click steps past the entry the click was about to create, landing on whatever preceded the test — usually `about:blank`.

`expectScrollable` asks whether a user can reach the content, which is not the same as whether content exists below the fold. Two halves, both required: the content overflows **and** the scroll position moves. **`element.scrollTop = n` works on `overflow: hidden`**, so movement alone proves nothing — script can scroll what a user cannot — which is why the computed `overflow-y` decides. It polls through hydration for the same reason `expectUrl` does: a shell that has not rendered is exactly one viewport tall, and a single reading called a 2806px page unscrollable. The scroll position is restored afterwards, because an assertion that moves the page changes what the next step tests.

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

**The loop refuses a wasted turn before spending it** (`src/orchestrator/agent-guards.ts`). Three rules the prompt already stated became guarantees, each with ONE informed re-ask (the healer's `rejected` seam) before the cheaper honest outcome: a selector whose accessible name is in **no node of the tree** (`selectorGrounded` — the tree is the evidence; a name not in it cost 8 s to disprove), an **ok action repeated on an unchanged page** (`decisionKey` over a per-URL "done here" set — PB_03_01's four password fills; twice refused is a *stall*, recorded and returned, not eight turns), and a **`finish` that the goal's own destination contradicts** — the one hole the post-hoc evidence check could not close, because it ran only on failures and a false finish sailed through as success; twice refused it is recorded as "claimed finish, but …" and `success=false`. Two more accuracy moves: `#target` fails a miss in **1.5 s with "no element matches"** (and notes "N matched, acted on the first" in the history) instead of 8 s of "not found"; and the tree the agent reads is **goal-focused** (`focusTree` — nodes sharing a word with the goal survive the node budget ahead of unrelated interactive ones, document order restored), so the control the goal names is never the one past the cut. The budget line ("Actions remaining: N") left the prompt — it was the one input that changed every turn with nothing on the page changing, and the documented cause of a premature `fail`. The origin guard no longer means "anywhere" on `about:blank` (it used to short-circuit on an empty list); it is the start origin plus any origin the goal names, and nothing else. Measured live on the exact PB_03_01 goal after the change: eight distinct actions, zero repeats, arrives and stops. A provider that refuses the call (Groq's 200k tokens/day cap, hit live) is now worded "could not be asked — the provider refused" rather than "failed to produce a valid structured response", because the fix for the two is different.

**Three zero-call rungs and plan-ahead cut the agent's turns** (measured before: 3.8 model turns per `workflow` step, ~3,350 input tokens a turn — the largest token sink in a run and the first role to trip a per-minute quota). In cost order, before any model turn: (1) **replay memory** — a goal solved on this origin+path is remembered in the healed-selector cache (`cacheAgentMemory`, `strategy: 'workflow-replay'`, key `replayKey(startUrl, goal)`; the runner passes it per call) and replayed deterministically, each selector re-grounded in the live tree, so the twelve cases that share "navigate to the plans page" pay the model once; a replay that fails is forgotten and the model asked, with the history saying so. (2) **Pre-flight** — a consent gate in front of the page is accepted and the page returned to (`consentGateShowing`/`acceptConsentGate`); a tree **link whose `url` is the goal's destination** is clicked as the route the goal describes; and a goal that names WHERE but no route word (`ROUTE_WORDS`: via, menu, sidebar, click, tile…) is met by a direct `goto`, the summary saying "by direct navigation" so a leg meant to exercise a menu is never silently passed by a URL. (3) **Plan-ahead** — `DecisionSchema.next` carries up to `AGENT_PLAN_AHEAD` (2) follow-ups the model is certain of (fill email → click Next); each is executed only while it still grounds in the tree *after* the previous action and is not already done, the first that does not hands control back, and follow-ups cost no turn. Every success path writes memory (`#remember`); `tests/agent-economy.test.ts` proves all three against a real page. A test whose fixture links straight to its destination is now solved without the model — which is the point, and why `agent-guards`' contradicted-finish test aims at an unlinked page.

**The agent's vocabulary grew to match** (`AGENT_ACTIONS`): `press`, `scroll` and `wait` alongside `click`/`fill`/`goto`. They are what a *stuck* page actually needs — a listbox that only opens on Enter, a control below the fold, a view that has not hydrated — and a click-and-fill vocabulary can only keep clicking things that are not there yet. None of them can change data, which is what keeps the safety argument intact: the agent cannot express a purchase or a delete except through a `click` the goal explicitly asked for.

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

## The session bootstrap (`src/engine/sign-in.ts`, `SmartRunner.#bootstrapSession`)

A test-case-table catalog's rows are frequently pure UI scripts of one screen — a 'Test Script / Steps' column that starts mid-application, no persona column, unit scope (said out loud at authoring now: "rows author as UNIT tests… pass --scope e2e to demand full journeys"). Authored against a browser that HAS a session, such a flow honestly assumes one; run against a **fresh headless Chrome** it lands on the sign-in page and the session guard kills every case (BE_Test2.csv, 2026-08-19 16:53 — ten for ten, all dead on the login screen).

The recovery: when a `goto` asked for an ordinary page and landed on a sign-in URL, the run holds `--as` credentials, the flow contains **no sign-in of its own** (`signsInItself` — the same predicate that decides session inheritance; the bootstrap must never race a flow's own login or a persona test stops testing its persona), and it has not been tried this run — the runner performs the deterministic sign-in and re-navigates to the page the flow asked for. Establishing a documented precondition is preparation, not the claim: the same contract as the agent rung, done with the person's own account, no model anywhere. It is recorded three ways — `sessionEstablished: <email>` on the goto's detail, a run note, and a `usability`/`low` finding saying to author the sign-in into setup — and a consent gate met on arrival is accepted as part of it. When it cannot act, nothing changes: no credentials leaves the honest fatal, which now names the fix ("pass --as <email>:<password> and the run will establish the session itself"); a sign-in that does not take is a note, never a fake session.

**A persona switch signs out the way a user does, and marks the flow end-to-end** (`performSignOut`, the `signOut` action, `switchesPersona` / `groundPersonaSwitches` in `flow-author.ts`). A flow that signs in as two different people is a journey across the application's session machinery whatever scope was asked for, so `Flow.scope` is stamped `'e2e'` at assembly — in the file, like `polarity`, so re-runs and repairs keep it. The switch itself must travel the application's own sign-out path: never fill a login form while still signed in (the app hides it from signed-in users), never substitute `clearStorage` (a cookie-backed session survives the wipe and the form never appears). `performSignOut` finds a name-gated sign-out control (`SIGN_OUT_NAME` — menuitem/button/link, never an anonymous link) on the page and then behind ARIA-marked identity disclosures (`aria-haspopup`, the probe's safety model — a bare button is never opened); the runner's `signOut` step falls back to clearing cookies+storage with the step's `detail` saying the real path was NOT exercised. The prompt asks for `signOut` before every switch; `groundPersonaSwitches` is the guarantee — segmented by `goto` so a two-step login stays one segment, identity = the first email-shaped value typed — splicing `{ action: 'signOut' }` in front of the switch's sign-in `goto` (after `groundCredentialFills`, so a stranded block has its goto by then), disclosed on notes. A `signOut` landing on the sign-in page is exempted by the session guard the same way a click is: the run means to be there.

**One procedure, three callers.** `performSignIn` / `acceptConsentGate` moved to the engine and the journey capture and navigation-map learner delegate to them — a sign-in that works for a capture works for a run by construction. The procedure is everything the live application taught: a hydration settle, the two-step form (identity + Next before any password field exists), a wait on the URL actually leaving the sign-in page, one hydration replay, and a name-gated consent accept. `tests/session-bootstrap.test.ts` proves it at the browser tier against a real two-step fixture, including the never-races-the-flow half.

## The suite session vault (`src/engine/session-vault.ts`)

A catalog's cases each run in their own isolated context — required, concurrent cases must not share cookies — but that meant the session a case established died with its context and every case paid for sign-in again. The vault is the recording context's own move (`storageState()` — the session as data) pointed at the suite: after a run that ENDS signed in on the flow's origin (observation-gated: on-origin, off the sign-in page, cookies in the jar), `runFlow` banks the context's state; a later case whose flow does NOT sign in itself starts its isolated context WITH that state and its first `goto` lands authenticated. Contexts are never shared, only serialized state; the suite's vault outranks the attached browser's state when both exist. A flow that signs in itself still declines inheritance — the same `signsInItself` reasoning as always: it wants to BE the account it types. Origin-scoped, in-memory, per-suite (a session on disk would outlive its server-side expiry). The reuse is on the bundle's notes ("reused the session a sibling case of this suite established"); wired in `run-cases.ts`, one vault per suite. `tests/session-vault.test.ts` proves the carry against a real cookie-gated fixture.

## Consent-gate recovery (`SmartRunner.#settleConsentGate`, spec in `docs/consent-gate-recovery-spec.md`)

A client-side consent gate (localStorage-keyed, so every parallel isolated context hits it) has three measured shapes on the live application: it bounces the sign-in to `/en/consent`, it renders **in place on the URL a goto asked for** (URL unchanged, consent heading showing — URL-based detection is blind to it), and it bounces to `/en/consent` a beat **after** `domcontentloaded`. Accepting it dumps the run on the app's home landing, abandoning the deep link. Recovery was a coin flip left to models — the one BE_Test2 flow whose agent returned to the asked-for page passed, the three that wandered off by menu label went red — and is now deterministic, four layers, no model call:

- **F1** — after every `goto`, `#settleConsentGate` detects the gate **by content** (`consentGateShowing`: the name-gated accept control `CONSENT_ACCEPT_NAME` *and* a consent heading `CONSENT_HEADING_PATTERN`, both required — a page that merely carries an "Accept" button is never treated as this gate), accepts, and **re-issues the same goto once**. The late-bounce shape pays a 2s window only when the page was on a consent URL before the goto or is on one now — ordinary navigations are never taxed. Never when the goto asked for the gate's own page; recorded as `consentAccepted` on the step, a run note, and a `usability`/`low` finding. Once per goto — a gate that re-renders is an application finding.
- **F2** — in the agent loop: when the goal names no destination and the agent has made **no forward progress yet** (nothing acted but gate-clears, waits, scrolls), an accept-shaped click (`CONSENT_ACCEPT_NAME` on the selector's name) that navigated away from the step's starting URL is followed by a **deterministic return to that URL** — no model turn spent, once per distinct accept, history line says so. The progress guard is load-bearing: an accept fired first thing is an obstacle in front of the step's own page; one fired after real work is a gate met along a journey, and returning would destroy the journey (the two-interstitials test caught exactly that).
- **F3** — `settleConsentEarly()` in `flow-author.ts`: a consent-accept step the model placed after the first post-login navigation/assertion is spliced to immediately after the login block (bare `click` converted to the `when { visible }` form — the gate shows once per context), so the flow's own goto becomes the re-navigation. Mechanical, disclosed on `notes`, never a re-ask.
- **F4** — a workflow failure whose `urlAfter` differs from `urlBefore` names the displacement in the error and the defect ("the agent ended on X, not the page this step began on"), so "the control is missing" is never filed against a page that has it.

`tests/consent-gate.test.ts` carries all of it, browser tier included, against a fixture gate with all three shapes.

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

## In-run step reconstruction (`executeSteps` in `src/engine/runner.ts`)

Between the ladder (one selector, mid-step) and `--repair` (whole flow, between runs) sits the level a failed *step* actually wants: on failure, the repair model rebuilds the step against the **live page** — no re-run, session intact — and the step retries, until its failures reach `STEP_RECONSTRUCT_TRIES` (3, total, including the original). Only then does the ordinary classification (failed / error / dead end) land. On by default; `--no-reconstruct` disables; no generator key degrades silently to pre-reconstruction behaviour.

Four rails hold it honest:

- **A rescued run passes, and the attempts stay visible.** Failed tries a later reconstruction rescued are marked `ProofStep.superseded`: still listed (what was tried is evidence), counted toward nothing — not the tallies, not the run status, not the trend's failure signatures — and their defects are withdrawn (`supersedeSteps`). Without this, "retry until it works" would be indistinguishable from "failed" and nobody would leave it on.
- **An assertion keeps its claim verbatim.** A reconstruction may only insert preparation *before* it; the replacement is discarded for `ASSERTION_ACTIONS`. A claim rewritten until it passes proves nothing — the same argument that keeps the agent rung off assertions.
- **Every rescue is a finding.** The passing step carries a `ReconstructionRecord` (as written / as rebuilt / inserted / reasoning) and files a `medium` drift defect: the run is green, the flow no longer matches the app.
- **Futile stops stay stopped.** A failure the ladder already attributed elsewhere (`backend:`, `authorization:`, `declined to heal:`, `known dead end:`) is never reconstructed — the same "a rewrite can only fail identically or succeed against the wrong thing" argument, verbatim.

Bad interpolation is also never reconstructed: an unknown `{{var}}` is the flow's problem, and nothing a rebuilt step does can save a variable the run never saved.

## Keyboard and focus

`press`, `expectFocused`, `expectTabOrder`. Focus order is the one accessibility property that cannot be read from a static tree — it only exists while tabbing.

**Two traps in `expectTabOrder`, both found by running it:**
- `body.focus()` alone is a no-op; body is not focusable without a `tabindex`.
- `activeElement.blur()` clears `activeElement` but leaves Chrome's *sequential focus navigation starting point* on the old element, so the next Tab resumes from there.

Temporarily setting `tabindex="-1"` on body and focusing it resets both. Don't "simplify" that back to a blur.

## Where determinism ends, it ends in two calls

The standing rule (2026-08-26). A step whose deterministic ladder has failed gets **ONE look** and, only if that look earns it, **ONE repair**. `#agentTriage` owns both and can spend no more; `#agentRescue` is gone, its contract absorbed.

1. **The look** — `readOnly`, so it structurally cannot click, type or navigate. It answers with one of three verdicts in the decision's `value` (a field the schema already has, so no prompt pays for a new one): `proved` + the selector of the element that shows it; `can-heal` + what stands in the way; `fail`. Anything unrecognised reads as `fail` — the safe direction is to spend nothing.
2. **The repair** — only on `can-heal`, and only under `--agent-assist`, because this stage changes the application and that has always been a decision about someone's system rather than a default. The look is ungated precisely because it cannot act. For an **assertion** the repair is further restricted to `REVEAL_ACTIONS` (open, focus, follow; never `fill`, never `dbCount`): a claim an agent typed into existence proves nothing.

**Neither verdict is believed.** After `proved` the harness re-runs the author's own comparison against the element named; after a repair it re-runs the author's own selector. A step whose claim does not then hold fails exactly as it would have. That is what lets an assertion be offered this at all, where the old `#agentRescue` refused one — its rule was about ACTING, and forbidding action structurally is what makes a reading question safe to ask.

**The healer keeps its place, for the one thing it is good at.** It reads a static tree and proposes a different string — the right tool for a WRONG SELECTOR, the wrong one for a CONTENT miss. Measured (be100 PL_03_01, 2026-08-25): asked why `text=Total plans` did not contain "75", it proposed `text="68"` — find an element containing the expected value, which is circular — at 0.20 confidence, and was rightly refused. So a content-only miss (`isContentMiss` across every attempt) skips the healer entirely and goes straight to triage. Ahead of both sits the free **kin** rung (`ancestorSelectors`, two levels): a summary card is a label and a value in sibling elements, and climbing to the container that holds both costs nothing.

## Backend off means not even present

Three layers, because a rule enforced in one place is a rule with a hole in it:

| Layer | Where | Behaviour |
|---|---|---|
| Authoring | `flow-author.ts` | The family is dropped in narrowing with `BACKEND_OFF_REASON`; an indexed schema stops being permission |
| Loading | `runFlow` | A flow carrying any backend step under `backend: false` is **refused before a browser opens**, naming the steps |
| Dispatch | `SmartRunner.assertBackendAllowed` | Throws `BackendDisabledError` per step, for a caller that drove the runner directly (MCP, the repair loop, an embedder) |

**Refused, never silently skipped.** A suite that quietly drops assertions goes green having proved less than it claims — the vacuous pass in a new coat. `BackendDisabledError` is harness-class (`classifyStepFailure` → `error`, `reconstructionFutile` → true), so the case is recorded **blocked**: a limit the run was given, never a finding about the application.

## A 404 is two findings, and only the codebase tells them apart

`page.goto` resolves for any response at all, so a navigation that came back 404 was recorded as a **passing** step and every step after it failed against the error page — attributed to the application. Live (be100 PL_02_03, 2026-08-25): the flow had invented a plausible-looking path, and the repository had held the real route list all along.

`#judgeNavigationStatus` reads the response against `declaredRoutes` (the indexed graph's page routes; api handlers excluded, since a navigation is not a request):

- **the path is declared** → the application should serve this page and did not. A real `high` defect, filed as one.
- **the path is NOT declared** → the TEST asked for a page that does not exist. `RouteNotFoundError`, harness-class (`classifyStepFailure` → `error`, `reconstructionFutile` → true), so the case records **blocked**. The nearest declared routes are named — "that page does not exist" is far less useful than "you meant this one".
- **nothing indexed** → no opinion. The navigation stands as it always did, and the steps after it fail on their own evidence.

Judged **after** the session bootstrap and the consent gate, never before: either can turn a first 4xx into a perfectly good page, and failing on the first answer would blame the app for a redirect it was always going to make.

`nearestRoutes` (`context/route-match.ts`) scores segment-wise — a matched leading prefix is worth most, a `:param` less than a literal — and requires **at least one literal segment in common**. Without that rule a pattern of nothing but `:param` matches every path of its length, so `/en/totally/made/up` "resembles" three routes and a reader learns to skip the line. The same function serves the authoring lint `ungroundedGoto`, so both halves give one answer about one codebase.

**`runFlow` forwards to `SmartRunner.connect` field by field.** A field added to `RunFlowOptions` and not listed there reaches the runner as `undefined` and its guard silently never fires. Both `backend` and `declaredRoutes` were added and not listed; the 404 test caught it by seeing `routes=0` inside the runner, and `assertBackendAllowed` would otherwise have been dead code shipped green.

