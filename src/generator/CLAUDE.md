# CLAUDE.md — authoring and its rails

Split out of the root CLAUDE.md (2026-08-24) so this loads only when working under
`src/generator/`. Same authority as the root file; the root keeps the map of the whole system.

## The authoring review (`src/generator/flow-review.ts`)

The commonest way an authored case ends in `dead-end` is not a broken application — it is a step written with nothing behind it: a control named from the requirement's wording rather than the tree, a destination guessed from a label, a leg after a `workflow` step on a page no capture ever saw. Each one spends the whole ladder, a healer call and a reconstruction call at run time to rediscover that the evidence never contained it. The lints refuse the shapes a string check can name; the review is the level above them, run inside `FlowAuthor.author` after every lint has had its say, default on (`--no-author-review` disables; no agent key degrades silently — the unreviewed flow is the flow we always wrote). Three parts, in cost order, the ladder's rule applied to authoring:

- **`auditGrounding` — $0.** Every step against the evidence the author was given: a role/name selector must name something in a captured tree (start, journey, probe); a `goto` must be a declared route or a tree link (**a goto is not its own evidence**); an `expectUrl` may also rest on a goto before it; a `workflow` goal's destination must be a declared route. The page the evidence was captured from counts as existing. A truncated tree is not judged for selectors, same rule as the lints. Only the findings go on.
- **One `agent`-role call, only when there are findings** (`LlmFlowReviewModel`, flat schema via `lenientObject`). The model sees the flagged steps, the whole flow, the trees, the declared routes, the repository's context slice and the request as the author saw it — the documents — and says per step `keep` / `replace` / `insertBefore` / `unsure`, quoting the evidence line. It may change **what a step points at** (selector, url, goal), never what it does: action, typed value and asserted text are the claim, and the claim is the author's. `insertBefore` admits preparation only (click, waitFor, goto, press, scrollTo, clickIfVisible→`when`).
- **Every proposal is verified before it is applied** (`applyReview`). A selector's name must be in a tree or in the evidence text (source index, documents); a path must match a declared route or appear in the evidence; a decision with no evidence quoted is dropped; a decision about a step the model was not asked about is ignored; a flagged step it says nothing about is `unsure` by omission. Rejections are recorded with the reason. Replacements mutate the step object in place so the case list sees them; insertions are spliced into the section **and** the case holding the step.

**Only findings some evidence could settle are asked about** (`settleableFindings`, 2026-08-31). Measured on be100-rip: the run's log is a wall of `the review could not ground it either — No tree captured for this page state`, every one of them an `unsure` the audit had already computed for free. A **selector** finding is unanswerable when all three hold — it follows a `workflow` leg so no tree covers its page, the evidence carries no repository slice, and its control's name appears nowhere in the evidence text; under those, `applyReview` would reject any `replace` and the audit already disproved `keep`. Such findings become a note naming the actual remedy (a capture of that page, or `--repo`), and when *every* finding is one the call is not made at all. **Path findings are always asked** — a route is settled by a declared pattern or a document sentence and needs no tree. The record still counts what the AUDIT found, so a skipped call never shrinks the reported problem. The reviewer is handed the **row's own** context slice, not the project-wide one: it judges by the evidence the author saw, and the row's slice is what that is.

The record (`AuthoredFlow.review`) is printed by the CLI (`review  N ungrounded step(s): …` plus one line per change and per rejection) and summarised on the flow's `notes`. A model fault never throws: the flow is as authored, the record says the review could not run. `tests/flow-review.test.ts` is entirely unit-tier.

## The suite's refusal memory (`flow-author.ts`)

The informed re-ask teaches one row at a time, and the teaching dies with the row. Measured on be100-rip (2026-08-31): the same two or three lints fired across the whole catalog — an `expectDbRows` on the case's own test data, a `workflow` goal naming controls the repository declares — and each cost a fresh authoring attempt (57 s, ~$0.44 on opus) to re-learn a rule the row before had already been taught.

One `FlowAuthor` writes a whole catalog, so the memory is suite-scoped by construction. Three rules, each with its reason:

- **Keyed by SHAPE, not by message** (`refusalShape`): quoted names, step indexes and numbers are stripped, so six variants of one lint collapse to one entry instead of filling the budget.
- **A rule travels only once it has been seen twice.** One row's accident is not the suite's pattern, and pre-loading it onto unrelated rows is how a memory turns into a bias.
- **It is a separate prompt field** (`AuthorRequest.commonRefusals`), rendered under its own heading before the row's own `feedback` and never merged into it. `feedback` says "your previous answer to THIS question was wrong", which is a fact; this says "the suite keeps making this mistake", which is a warning — wording the second as the first on a first attempt would be a lie the model would then try to fix.

Bounded at `SUITE_REFUSAL_MEMORY` (6), most frequent first: a lint that fired twenty times is the one worth pre-empting, and a long list would crowd the request itself out of the model's attention.

## Authoring rails from a hand-authored comparison (`flow-author.ts`)

One prompt from the run history was authored twice by the model and once by hand, the hand-written flow being read out of the application's own source and then run until it passed (30/30, no heals). Every difference became a rule, and the checkable ones became lints with the ordinary informed re-ask:

- **`countPinnedName`** refuses a live count inside an accessible name — `role=tab[name="Status (1)"]`. That number counts whatever the application holds *now*, including rows a seed or an earlier run left, so the selector works once and then heals: green, having paid a model call to rediscover that the number moved, and it will pay again next run. Names that merely contain a number ("OT Day 1") are untouched — the trailing parenthesised form is the count idiom specifically.
- **`interruptedCredentialSubmit`** refuses any step between the credential fills and the submit click. Not style — measured: the hydration replay (`nativeFormResubmitDetected`) recognises *an adjacent fill block plus click*, and one `expectValue` in that gap stopped it firing, the click degraded to the form's native GET, and a flow that passed 31/31 stopped logging in at all.
- **`unpinnedDateEntry`** refuses a typed `YYYY-MM-DD` with no `setClock` in setup. Date fields are gated on a window computed from *today* — the live case rejects any date outside the current 21st-to-20th payroll period — so an unpinned flow passes this week and fails when the window moves, blaming the field.
- **`unsettledWorkflowClaim`** refuses a `workflow` step nothing checks afterwards, where `expectUrl` deliberately does not count: a URL says which page is open, not that the thing happened. **It is the one lint here that stops refusing on the last attempt** and records the complaint on `notes` instead. Every other lint refuses a claim that is *false*, where refusing beats emitting; this one refuses a claim that is merely *thin*, and measured, the hard refusal turned a runnable-but-weak flow into no flow at all — the re-ask came back with one step and no assertion. "Feedback must never make the result worse" is already this file's rule for `vacuousFormAssertion`; a note plus a line in front of the person keeps the pressure on the model without the person paying for the model's second answer.

Six prompt rules carry the parts no lint can check: assert the value the page **computed** (a visibility check on a total passes whether the arithmetic is right or wrong); identify a record this flow created by **a value this flow typed**, so "MY row appeared" is the claim rather than "a row appeared"; quote the application's own status wording (a store's `pending` renders as "Awaiting manager"); claim the **database only when the evidence shows the page reaching a backend** — plenty of screens persist to client-side storage and make no request at all, and asserting a row against one of those files a high backend defect against an application working exactly as built; and start from a known state (`clearStorage`, then `goto` again so the app rehydrates from empty) when the journey creates something the application keeps.

**The table inventory is narrowed by relevance** (`TABLE_INVENTORY_MAX`, `bm25` over name + columns, the description as the query). Measured on the live prompt: **386 tables → 9**, and the authoring call went from **56,237 to ~7,000 input tokens** — the inventory had been 50,310 of them, 89% of the prompt, against 63 tokens of what the person actually asked for. Cost is only half of it: the full dump offered four near-identical candidates (`ot_request`, `ot_request_detail`, `ot_request_decision`, `ot_request_attachment`) for one journey, and which one comes back is exactly the coin-flip that makes two runs of one prompt disagree. A description that matches nothing keeps the whole inventory — presence of the inventory *is* the permission to author a DB check, so narrowing to an arbitrary forty would silently remove the capability.

**What none of this fixes, and it is the ceiling on the whole describe path:** the author reads the AX tree of the page the run *starts* on. For "log in, then create an overtime request" that is the login screen, so the entire form is invisible and the middle of the journey goes to a `workflow` step whatever the prompt says. The repo graph can name the destination; only a capture of that page can ground selectors on it.

## Claim-fidelity rails (born from the PB/DB catalog post-mortems)

Every rail below exists because a prior run produced a **false claim** — a green pass that proved nothing, or a red defect about an app that worked — and each names the live case that forced it.

- **The authored deliberate-HTTP family** — `request` / `expectStatus` / `expectJson` joined `AUTHOR_ACTIONS` (flat forms: `name` = `"METHOD /path"`, saves in `key` as `"var = $.json.path"`), because an API-level claim used to be authorable only as a `goto` to the endpoint (a GET against a POST route — DB_07's seed "restore") or as an `expectCalls` the page never fires (DB_09: a high **backend** defect filed against a healthy seed endpoint the run sent zero requests to). The prompt's PLANE RULE says it outright: `expectCalls` watches traffic the *page* makes; a call only the test can make is a `request`. The runtime failure text for a never-observed expectCalls now names the same hazard. Authored `request` verbs are policy-filtered structurally (`REQUEST_VERBS_BY_POLICY`; DELETE at no tier), the `ApiTestGenerator` precedent.
- **`expectDbCount`** (authored) narrows to `expectDbRow` with an exact `count` and empty/partial `where` — and `count` may be a `{{variable}}` string, interpolated at run time. That composition (`request` saves `$.counts.persons` → `expectDbCount` compares it to SQL) is THE cross-check for "the API's number equals the database's number", which DB_01_01 was passing without ever reading a number.
- **`setClock`** pins the page clock via Playwright's clock API (`#bareStep`, in setup, before the first `goto`; verified working over CDP). It exists because PB_04_01 "passed" 13/13 while exercising zero of the four boundary dates it named — a time-dependent claim without a pinned clock tests whatever today is. The author prompt requires it for days-remaining/due-date claims and refuses to let an arithmetic claim be reduced to label-visibility (the "computed claim needs the computed value asserted" rule — PB_01_01's 119-vs-120 defect went undetected behind an `expectVisible`).
- **The hydration replay** (`nativeFormResubmitDetected` + the replay in `executeSteps`): a Sign-in click that lands before the app hydrates degrades to the form's native GET submit — credentials in the URL, no session, and (formerly) every body step dead-ending against `/en/login` as high "frontend" defects. Detection is evidence-based (a password-named query param, or a typed value echoed in the URL) and gated on a credential-shaped fill block so ordinary clicks never pay the recheck. The recovery replays the fill block + click once after `networkidle`; the finding is filed as `usability`/`medium` **and is an app fact too** (a login form that degrades to GET exposes what was typed). Companion authoring lint `unsynchronizedLoginSubmit`: a credential submit immediately followed by `goto` is refused with the informed re-ask — the prompt now demands a post-submit assertion.
- **The session guard exemption is per-goto** (`#lastGotoAskedSignIn`, not a run-wide flag): a flow that logs in first always has a login `goto` in its past, and the run-wide flag exempted exactly the case the guard exists for — a bounced post-login navigation. Only the most recent `goto` says what the flow means to be looking at.
- **A dialog opened by the previous click/press is the intended context, never a blocker** — the ladder's dialog rung no longer dismisses it (DB_07: the rung closed the "Edit rule" modal the test had deliberately opened, destroying the state and cascading four false defects). Left open, the step fails honestly and the healer reads a tree that *contains* the dialog — where the right candidate lives. `expectModal`/`closeModal` are authorable now, and the prompt says to assert the modal before filling its fields.
- **The timing re-check only downgrades genuine resolution failures**: a content mismatch (`expected text to contain`) or an intercepted click re-probes to "TIMING, not absence" only in the sense that the selector resolves — which was never in doubt — so those are excluded (DB_06: a failed `expectText body` downgraded to timing because `body`, of course, resolves).
- **Failure wording follows the failure's shape**: all-content-mismatch attempts headline as `"…" resolved, but its content did not hold` (never "could not resolve" — PB_05_01's control was on screen the whole time); an `expectHidden` timeout reads "stayed on the page", not "never found" (PB_03_01's inversion); and a failing step recorded on a sign-in URL overrides the verdict's frontend/backend side copy with the stranded note (`VERDICT_COPY.strandedSide`).
- **The sheet is read whole**: `Login / Persona`, `Preconditions` and `Note` columns now reach the author verbatim (`describeCase`) and the Note lands in the claim text — the KNOWN-FAIL notes and "the SQL is the only authoritative proof" caveats are exactly what decides an honest assertion. `beyondHarnessReason()` marks a row whose steps stop services (`brew services stop …`) or whose claim pivots on a direct SQL write as `testable: false` with the boundary named — narrow on purpose; a validation SELECT or a cleanup command in the steps strikes nothing.
- **Lane edits are recomputed server-side too** (`recomputeLaneTestability`, applied when `--claims` reads a file with a `sequence` block): a plane corrected by hand in the JSON now takes effect exactly as in the panel's lane editor, the boundary suffix on `source` is re-derived, and a database-named lane marked `user`/`page` earns a printed warning — the browser cannot observe calls a server makes, and a lane confirmation that says otherwise manufactures claims that must fail (seen live: a DB lane "confirmed" as user produced a high backend defect about traffic the browser could never see).
- **A catalog with database claims but no schema indexed says so loudly** in `cmdCatalog` — the author structurally cannot emit a DB step then, and the silent degradation to UI-text proxies is how DB_01_01's vacuous pass happened. `wowlidator context add <repo> --db-schema …` (or `WOWLIDATOR_DB_URL`) plus `--repo` is the fix the message names.
- **The hydration race has a second signature: lost fills.** A pre-hydration click sometimes navigates nowhere at all — React hydration RESETS the controlled inputs, the click submits an empty password, and the page just stays on the login screen with nothing in the URL to detect (run 4's DB_04/06/07, three re-clicks each, none re-filling). `fillsLostToHydration` reads the filled fields back after a credential-block click when the URL signature is absent; a field holding a different value than what was typed triggers the same wait-and-replay, recorded by `recordLostFillFinding`.
- **`expectDbRow`'s failure names which half failed.** `found 0` over a where that matched 1 row hid that the VALUES filter was the miss (run 4's DB_07: the row existed at 72000/mock-seed; the 75000/cnext-ui values never held because the edit never happened). The message and record now carry the redacted values summary and the where-only match count.
- **Two more vacuity lints, both from run 4's audited passes:** `dbClaimWithoutDbCheck` (a claim comparing something to the database, tables declared, zero expectDb* steps anywhere — the DB_01 "counts match exactly" case that asserted only `$.counts` exists) and `loginProofAssertsLoginPage` (a post-submit `expectUrl` of the sign-in path itself — an assertion that holds precisely when the login did NOT take; DB_02's "redirected away" that expected `/en/login`). Both feed the ordinary informed re-ask.
- **A check generated out of the test's scope is re-judged for necessity** (`typedCredentialValues` / `credentialEchoAssertions`): an assertion that a credential the flow itself typed is DISPLAYED came from the input side of the test — the persona lines put the email in every request, which is exactly where the model found it — and it fails on every run against a working application (PL_02_02: `expectVisible text="admin@cnext.test"` against an identity plate that renders name, role and user id, never the email; 42s of ladder, healer and reconstruction to disprove a string the tree never contained, then a high defect). The request text can never rescue such an assertion; the evidence tree can (a page seen to render the value makes it grounded). When the claim's own assertions carry the proof, the echo is dropped mechanically ($0, disclosed on `notes`); only when it is all the proof there is does it earn the informed re-ask. `expectHidden` is never flagged — a credential NOT displayed is a legitimate claim and the canonical login proof's own action. The prompt's sign-in step 4 states the other half: quote the identity from a tree, never from what the flow typed.
- **Expected values are the sheet's word, and a citation is a pointer, never a licence to invent (2026-08-24).** The authoring prompt's EXPECTED VALUES rule (`buildAuthoringPrompt`) says to quote the test case's own expected output exactly; when a row defers to another source for its value ("as per the Master Benefit List", "ตามเอกสาร Requirement"), `referencedSources()` in `catalog/retrieve.ts` extracts the cited phrases (English + Thai markers; bare `ตาม` needs a document-ish noun — "ตามเงื่อนไข" is not a citation) and `authorEachRow` boosts them in the per-row BM25 query (repetition — term frequency is the lever BM25 has) and in the repo-slice ranking, so the cited section outranks sections that merely share step vocabulary and the value is quoted from the source. A value neither the case nor the retrieved context states is not asserted.
- **A wording claim is asserted on labels the spec owns, never on a data row (2026-08-25).** `wordingClaimAssertsDataValue`: when the claim is about spelling/wording (`ข้อความ`, `สะกด`, "label", "wording"…) and an `expectVisible text=…` / `expectText` value appears neither in the test case's words nor in a non-data node of the evidence tree (heading, columnheader, button, link — never `cell`/`row`/`option`), it earns the informed re-ask. PL_02_02's "ข้อความสะกดถูกต้องตรงตาม Spec" was authored as `text=Medical Reimbursement` — a plan name the sheet never mentions; a sibling delete case had removed the plan, and the case dead-ended against a correctly worded page while its earlier authoring (`text="Benefit Plans"`, `text="Benefits Admin"`) had proved.
- **The backend toggle (`--no-backend`, `FlowAuthorOptions.backend`; 2026-08-25).** A run may declare that it does not test the backend at all. Off, no `request` / `expectStatus` / `expectJson` / `expectHeader` / `expectCalls` / `dbSnapshot` / `expectDb*` step is written — the family is dropped in narrowing with `BACKEND_OFF_REASON`, and an indexed schema stops being permission (`allowDb` requires the toggle too). The prompt tells the model to prove each claim through the PAGE instead, and — when a backend check would prove it better — to mark that step by beginning its `intent` with `backend could prove this: …`. The marker is lifted off the intent at `ProofBundleBuilder.addStep` into `ProofStep.backendHint`, shown as a `visual only` tag in wowUI and a callout in the report. Never a defect and never a verdict: the visual check really did pass; the note says a stronger proof exists and this run was told not to take it. **On is the CLI default**, so every existing script and catalog behaves as it always did; the panel offers it as opt-IN (most runs have no database) and states its choice explicitly in both directions via `Field.offFlag`. Turning it on makes the Database URL field required (`Field.requiredWhen`) — a DB claim with no database is a case that dies ten minutes in.
- **A `goto` must name a page the codebase declares (2026-08-26).** `ungroundedGoto` refuses a navigation to a path the indexed repository has no route for, carrying the nearest declared routes into the refusal. PL_02_03 navigated to an invented path, got a 404, and every step after it failed against the error page — filed against the application. Silent without an index, and about another origin, which is not this application's routing table's business. The runtime half is in `src/engine/CLAUDE.md`, "A 404 is two findings".
- **An authored `request`'s METHOD is checked against the indexed operations (2026-08-25).** `unindexedRequestMethod` refuses a `request` whose path the repository declares and whose verb it does not, naming the verbs that path does answer. PL_03_03 called `GET /api/benefit-plans` against a handler exporting POST/PUT/DELETE; the app answered 405 and the run filed two `high` defects against correct behaviour. It fires only when the path IS declared — an endpoint outside the index (a proxy, another host, an unindexed repo) says nothing, and silence must not become a refusal. See `src/context/CLAUDE.md`, "An endpoint is a method AND a path", for where the operations now come from.
- **A model's typography is not evidence:** a selector that is a CSS comment (`/* selector for X not found */`) narrows to no-selector and is dropped (DB_08 burned its whole reconstruction budget parsing one), and U+2011 non-breaking hyphens in selectors normalize to ASCII (`RULE‑FUEL‑002` can never match the ASCII row it means).
- **`workflow` legs are allowed on pages the capture never saw** — the authoring tree describes ONE page state, and DB_04/06/07's modal and row controls are structurally absent from a login-page capture. The prompt now permits a precisely-goaled workflow step for exactly those legs, with the rule that the claim must then be settled by evidence independent of the agent (a DB check, a request assertion, page content read afterwards) — the same "prepare, never perform" honesty applied at authoring scale.

## Negative testing (`MutationPolicy`)

Three tiers on `TestGenerator`, default `mutations` since 2026-09-02 (`DEFAULT_MUTATION_POLICY` in `test-generator.ts` is the single source):

| Policy | May do | Never |
|---|---|---|
| `read-only` | navigate, read, assert | submit anything |
| `forms` | submit **empty/invalid** input to exercise validation | submit valid data that writes |
| `mutations` | fill, submit, create and update — like a human tester | delete, purchase, bulk ops |

`mutations` is the default by request: a human QA fills forms with real data and submits them, and the suite is expected to do the same out of the box. The knob stays — `--policy forms` narrows to validation-only negative testing (its own load-bearing tier: an empty-required-field submit is not destructive, and verifying validation is a real surface), `--policy read-only` to navigate-and-assert for a page where even an invalid submit is unwelcome. DELETE appears at no tier, and `mutations` still refuses purchases and bulk/irreversible ops. The filter is still structural (`REQUEST_VERBS_BY_POLICY`, `POLICY_RULES` + every step re-checked on the way out), not a prompt request.

## Boundary-value analysis (`fillEach`)

One field, several values, an assertion after each. **Every case runs even after one fails** — a partial boundary table is far less useful than the whole one when you are trying to find where behaviour changes.

`submit` is the load-bearing option: validation usually fires on submit, not on input, so without it every case asserts against a form that never ran. That was found by running it, not by reading it.

## The tree's rendering, never the sheet's wording — the guarantee (2026-08-28)

The same case authored by two models, both flows run today with no model in the loop: gemini-3.5-flash-lite asserted `role=heading[name="Benefit Plan Catalog…"]` and passed; claude asserted `text="Benefit Plans"` / `role=heading[name="Benefit Plans" i]` — the requirement's phrase — and dead-ended three times on a page that renders the heading. The LANGUAGE rule in the prompt was a request; `ungroundedTextExpectation` (pure, beside `ungroundedCountRole`) is the guarantee, provider-independent: a presence assertion (`expectVisible`/`expectText`, `text=` or `role=…[name=…]`) whose text is a contiguous case-insensitive substring of NO rendered node name is refused with the nearest real renderings named ("The page renders: "Benefit Plan Catalog" — quote one of those, with its role"), and the ordinary feedback re-ask does the rest. Grounding strips `url="…"` first — word-wise matching would ground "Benefit Plans" on `/benefits/plans`. Exempt after a `workflow` leg and on a truncated tree, the `ungroundedUrlExpectation` rules. Companion in the engine: `relaxTextSelector` now relaxes the HEAD of a chained `text="X" >> nth=0` (every such selector used to skip the rung), so a rendering that differs only in case or surrounding text still resolves at $0.

## No selector may assert a control's implementation (`inventedControlInternals`, 2026-08-28)

A selector like `main select:has(option:text-is("Medical"))` or
`… >> option:checked` is refused at authoring: no accessibility tree ever
shows `<select>`, `<option>` or `:checked` — the tree speaks roles — so an
internals selector is invented by construction, and it dead-ends on any
custom widget. Live driver: PL_04_04 pinned thirty-one steps to a native
`<select>` on a page whose category filter is a custom combobox; every one
failed identically. The refusal steers to the two legal shapes: the control's
role and visible label from a tree it appears in (`role=combobox[name="…" i]`
— `selectOption` drives native and custom dropdowns alike through it), or a
workflow goal in user terms when NO tree shows the control. It also carries
the semantic rule the case's wording needs: a default written "All" / "No
filter" is a state the user can see (the control's visible value, an
unfiltered listing), never an `option:checked` internal. `role=option[name]`
stays legal (tree notation); quoted strings are stripped before matching so
`text="Select all"` never trips it. Tests: `tests/flow-author.test.ts`.

## Code-grounded authoring — deterministic first, agent on error only (2026-08-28)

Asked for in so many words: if a part of the journey can be proved by reading
the codebase, the author writes it as deterministic Playwright steps; the
agent's job shrinks to the part an error actually reaches. Three layers:

- **Prompt**: grounding order is tree → repository → workflow. When a control
  is in no tree but WHAT THE REPOSITORY DECLARES names its rendered string (a
  component's words, a message catalog's values — both already in the graph),
  the step is written against that string (`role=button[name="Create Plan" i]`);
  a workflow leg is legal only where neither a tree nor the repository declares
  the control. The tree still outranks the code where they disagree.
- **Lints**: `declaredControlStrings` extracts the repo section's quoted
  strings (one extractor, so "declared by the code" cannot mean two things);
  `ungroundedTextExpectation` accepts them as evidence (else every
  code-grounded assertion the prompt invites would be refused);
  `workflowOverDeclaredControls` refuses a workflow goal that names a declared
  control, steering to explicit steps and telling the model to keep the goal
  to what is genuinely undeclared. (PL_07 spent 108 model calls on an agent
  leg whose "Make Correction" control `messages/en.json` declares verbatim.)
- **Runtime**: suite runs arm the agent-assist rung whenever an agent was
  built at all (`run-cases.ts`) — so the agent is consulted only at the step
  that actually failed, after the $0 ladder and the healer. `--no-agent`
  disables both; fail-fast still strips assist.

## Expected results are quoted, never invented (2026-08-28)

Driven by PL_03_07: the sheet asked "+1 in Total Plans / +1 in Reimbursement
by Employee and HR" and the authored flow proved a DB delta and a visible row
name — real checks of a different claim, with intents citing "6.1/6.2" over
assertions that never read the counter boxes. Three rails:

- **Prompt**: every NUMBERED Expected line gets its own assertion in the page
  terms that line names, intent citing the line number; a backend check may
  corroborate, never substitute. Every asserted value is quoted from the case
  (Expected / Test data / Note), a document, or the repository — in that
  order — and when none holds one, the flow says so in notes and asserts the
  observable shape instead of inventing.
- **Coverage lint** (`expectedItemsIn` / `unassertedExpectedItems`): numbered
  ids with no asserting carrier (assert step or workflow goal citing the id)
  are refused WEAK — the re-ask drives the rewrite, and an uncovered flow at
  budget end is still handed over with the note, never left flowless.
- **Contextual-sufficiency check** (`expectedLacksAnchors`, authoring loop):
  an Expected with no number, no `field = value` pair and no quoted span
  across Expected+Note+Test data boosts the expected text in the BM25 query
  (the citation-boost lever) and stamps a one-line instruction into the
  described case: anchors come from the documents/repository, never invention.
  Also: the runtime card's Test data cut went 120 → 420 chars — PL_03_07's
  card ended mid-value, so every runtime role saw truncated test data.

## Pre-run dead-end risk (`src/generator/dead-end-risk.ts`, 2026-08-28)

A case whose flow needs a page the application lacks, or a label the spec words differently, cannot be healed into passing — and the machinery used to try anyway: the ladder's heal and agent rungs, in-run reconstruction, then `--repair`'s three attempts, each a model call and a minute of browser. Measured on be100 (2026-08-28, 27 cases in): 3 dead-ends and 3 errors, each paid for up to four times. So, **right after a catalog row is authored** (`authorEachRow`, on the same evidence the author just read — the ranked documents, the repository slice, the declared routes), one small `generator`-role call judges how likely the run is to end as a dead-end or error rather than a verdict. **Above the threshold (default 50%, `WOWLIDATOR_RISK_THRESHOLD`; strictly above) the case runs ONCE with every RERUN path off** — `failFastRunOptions` in `run-cases.ts`: no healer, no step reconstruction, and the `FlowRepairLoop` is skipped. The AGENT stays, once per step (refined 2026-08-28): a workflow leg has exactly one executor, the assist rung is one consult at the step that failed, and once-per-step holds by construction because with reconstruction off a step fails at most once and the dead-end memo blocks identical retries. The verdict is recorded exactly as any other run's; only the retries are withheld. `WOWLIDATOR_RISK=off` disables it; a generator role that does not resolve disables it with one printed line.

Rules worth keeping:

- **Signals first, model second** (`riskSignals`, $0): a `goto` path the repository declares no page route for (`routeIsDeclared`), a selector name (`name="…"`, `text=…`, `:has-text(…)`) that no document, the case, or the repository mentions, a backend step with the backend off, an agent `workflow` step, and "no evidence at all". They ride in the prompt as facts and on the record as `signals`, so a reader sees what the model was told, not only what it concluded.
- **Two dimensions since 2026-08-28: dead-end risk AND expected-fail risk.** `likelihood` still rises only when the run cannot reach the point where the expectation is checked — a claim the page can answer, even by contradicting it, is a verdict, so a negative case is never fail-fast for being negative. `failLikelihood` is the separate estimate that the run, having reached its assertions, ends in a GENUINE FAIL (the sheet's own Actual Result recorded Failed — passed in as `knownResult` and stated as a signal — a note citing a defect number, documents contradicting the expected output). Either dimension above the threshold fail-fasts (`riskVerdict(likelihood, threshold, failLikelihood)`): a near-certain fail is a fact the first run proves, and retries only re-prove it at full price. `describeRisk` and wowUI's tag name which dimension tripped.
- **Never throws.** A judge that fails (rate limit, breaker) is a case that runs the ordinary way, logged once — the retries exist for exactly the runs nobody could judge in advance.
- **Recorded, visibly.** `SuiteCase.risk` → `bundle.risk` (`DeadEndRisk`: likelihood, threshold, verdict, reasons, missing, signals, model, tokens) plus a line on `bundle.notes`; the proof card carries `risk`, wowUI's task row shows a `fail-fast N%` tag with the reason in its tooltip, and the run log prints `risk  fail-fast: …` at pickup. A person who disagrees has the evidence to say so.
- **Catalog rows only, for now.** `go`/`generate` suites do not carry the per-row retrieved evidence the judge needs; a hand-written flow has no `risk` and runs as it always did.

`tests/dead-end-risk.test.ts` is entirely unit-tier: the threshold and env, each signal, the prompt's budget, the model through `MockLanguageModelV4`, and the fail-fast option rule as one function.

## Post-run system-error diagnosis (`src/generator/error-diagnosis.ts`, 2026-08-28)

The companion of the pre-run risk judge, on the other side of the run: **a case that ends as a SYSTEM ERROR — `status: 'error'`, no verdict delivered — gets one `healer`-role call naming which layer broke** and the fix when one exists. Born from PL_07: all ten cases errored because the seeded plan the whole scenario asserts against (`PL_07_01_02_03_04_05_06`, "QA-Make correction") is not in the replica at all — the agent hunted a row that cannot exist, stalled, and the run read "system error" with nothing saying *seed the data*; PL_07_01 alone spent 108 model calls and $3.24 rediscovering it, and a person's next move was to re-run it.

Five origins, each implying its own fix: `test-catalog` (the case or its TEST DATA — a record never seeded, a precondition that never holds; fix the data, not the flow), `generator` (an invented selector/route — re-author), `agent` (a target the evidence DOES describe that the agent still missed — retry, better capture), `environment` (unconfigured DB, provider refusal, lost browser — ops), `application` (a genuine 500/crash). Rules worth keeping:

- **Only `status === 'error'` is diagnosed** (`diagnoseError` returns null otherwise). A test-failure is a verdict; a diagnosis of it would be second-guessing evidence a person can already read.
- **Signals first** (`diagnosisSignals`, $0): the PL_07 signature is load-bearing — a stalled agent whose hunted-for values (from its own failed-action errors) appear in NO evidence (case text, routes, repo hints, background docs via the suite's `HealHintsProvider`) points at test-catalog; the same stall over values the evidence DOES describe points at the agent; provider/quota wording in the run error, or a "never configured" note, points at environment; a cascade (an expect that errored because an earlier step never opened its dialog) is attributed to the first error.
- **It never repairs and never reclassifies.** The verdict stays `error`; the diagnosis lands on `bundle.diagnosis` (origin, confidence, reasoning, `fix: string | null` — null is the honest empty — signals, model, tokens), a `notes` line, a `diagnosis` line in the run log, the proof card, and the panel's why-block ("Diagnosed: … / Suggested fix: …"). Explaining is the feature; acting stays a person's click (`--repair`, a seed script, an env var).
- **Never throws; off by env.** `WOWLIDATOR_DIAGNOSE=off`, or a healer role that does not resolve, and the run reports its error exactly as before.

`tests/error-diagnosis.test.ts` is entirely unit-tier, `MockLanguageModelV4` for the model.

## Three more guarantees from the 2026-08-28 audit (S3, S4, S6, S7)

- **Roles are read from the tree, for every action** (`ungroundedSelectorRole`, S4): the generalisation of `ungroundedCountRole`. Sixteen dead-ends on one page came from `role=combobox`, `role=textbox`, native `select` written for filters the tree exposes as `button "Type:"` and `searchbox "Search benefit name"` — the roles a filter USUALLY has. A role no tree line starts with is refused with the tree's own line for that name; and a `fill`/`click`/`type`/`selectOption` on a line the tree marks `disabled` is refused too (the search box "starts disabled until a filter is chosen" — six flows filled it first). `expectHidden` and `expectCount 0` are exempt; after a `workflow` leg or on a truncated tree it declines.
- **Test data is not an application fact** (`fixtureFacts` / `ungroundedFixtureAssertion`, S3): identifier-shaped values from the Test Data / Expected columns (`PL_07_01_02_03_04_05_06`, `BP-DENTAL-01`, `TH_MED_005`) may be TYPED freely but may be asserted to pre-exist — a DB where-clause, a row click scoped by them, an exact count — only after a step of the same flow typed them into a form (or an agent leg whose goal creates them). Thirteen be100 cases asserted fixtures the database never held and filed the misses against the app.
- **The risk judge's evidence feeds the author** (S6): a `fail-fast` verdict with concrete reasons triggers ONE immediate re-ask with those reasons as `priorFeedback`; the re-authored flow replaces the first only when its re-judged likelihood is lower **AND it asserts at least as much about the claim** (`substantiveAssertions`, the vacuous lint's own predicate) — feedback must never make the result worse. "The search box starts disabled" (0.78) and "no Start-date filter exists" (0.88) were each right and each spent on a full dead-ended run. **The second gate is from 2026-09-02** (HIR-EC-006/HIR-EC-010, live): "lower risk alone" was gameable — a flow that asserts nothing about the claim cannot dead-end on it, so it always scored safer than the first draft that tried. The judge's own reasons named steps 8 and 11–12 of a first draft that reached the hire wizard; the re-ask, avoiding whatever it was told was risky, came back with four steps that never left the sign-in page — 0% risk, 0% proof — replaced the first, and passed green in 5 s about a hire it never attempted.

## The vacuous lint counts the sign-in form's own controls as no proof (2026-09-02)

`vacuous.ts`'s `substantiveAssertions` excluded only the sign-in PROOF (`expectHidden` of the submit control) and `expectUrl`. HIR-EC-006/HIR-EC-010's degenerate flows carried `expectVisible input[type="password"]` and `expectVisible role=button[name="Sign in" i]` — the sign-in form RENDERING its own fields — and those counted as substantive, so the fatal `vacuousClaim` lint in `FlowAuthor.author` never fired and the S6 swap saw "3 assertions". `isLoginFormSurface` now excludes `expectVisible`/`expectEnabled`/`expectDisabled` of the identity field, the password field, and a control literally named sign-in/log-in. **Deliberately narrower than `LOGIN_CONTROL`**: "next"/"continue"/"submit" are real wizard-step buttons far past sign-in and are NOT swept in; and it is selector-anchored (a `role=`/`input[type=` control locator, never `text=`), so a genuine login-validation claim — an error message that happens to contain "password" — is untouched. Because the predicate is shared, this lands in all three places at once: the fatal lint at authoring, the S6 swap gate, and `--rerun-vacuous` (which now marks both live cases blocked and re-authors them on the next resume).
- **The Note column is a gate** (`sheetGate` in `commands/authoring.ts`, S7): a row whose Actual Result is Cancelled, or whose Note says cancelled/dropped, is refused before any model call — four be100 rows were authored against filters the requirement dropped on 6 Jul. A dated requirement change ("pop-up → page 4 Aug", "TBC wording") is prepended to the case card as its own line, so the author reads it before writing `role=dialog` for a page.

## Reconciliation claims and sheet-verbatim wording (EN-2 audit, 2026-08-31)

- **`unreconciledMatchClaim`** refuses a flow whose case claims two readings
  agree ("tile matches the table", "เท่ากับ", "ตรงกับ") or that a number does
  not change ("no change", "ไม่เปลี่ยน") while no step saves a reading and
  compares it (`saveCount`/`saveText` → an expect carrying `{{var}}`; a
  `dbSnapshot` + `expectDbDelta`/`expectDbUnchanged` pair also satisfies).
  Presence assertions pass whether or not the readings agree — ten such bugs
  shipped green. The prompt's companion rule: a number printed in Expected
  ("1-15 of 43") is the sheet-writer's illustration, never a value to assert;
  the saved reading is the value.
- **`ungroundedTextExpectation` exempts the sheet's own words** (new `prompt`
  param): when the asserted text appears verbatim in the case, the sheet's
  wording IS the claim — refusing it rewrote real wording bugs into
  assertions about whatever the page renders, which then passed. The claim
  runs; an exact-miss over text the page holds becomes a near-miss
  needs-review, the right verdict for a wording dispute.
- **A workflow goal carries an Expected item only when a later step asserts
  something** (`unassertedExpectedItems`): an agent leg's claim must be
  settled by evidence independent of the agent — behavioral lines "covered"
  solely by a goal's mention shipped unproved, and their bugs with them.
- **`specQuestion`** (stamped in `runFlow`, engine side): a needs-review whose
  every disputed expected value quotes the case's own wording is marked a
  spec question — deliberate design vs the sheet, a BA call. 29 of 31 genuine
  QA fails in the EN-2 audit were this class; wowUI shows a `spec?` chip.

## A refused row is recorded, authored leniently once, then left alone (2026-09-02)

`authorEachRow` used to print `! X could not be written` and move on, and the
row earned no ledger outcome — so `--resume` listed it as still to run,
authored it again against the same captured trees, hit the same
tree-grounding refusal (the page the row needs was never captured, so no tree
renders its wording), and the run ended with the same rows "left". ec10n:
two rows, every resume, two Opus calls each, no progress. Three changes, all
in `cmdCatalog`/`suite-progress.ts`:

- **Recorded.** A refusal (and a sheet gate) becomes a flow-less `SuiteCase`
  with `refused: { reason, attempt }`; the runner records it `blocked` —
  `authoring refused (attempt N): …` — with `LedgerOutcome.authoringRefused`
  = N, so the catalog report's row says why instead of "never ran". Buffered
  until the pipelined runner exists, flushed into its queue then; written
  straight to the ledger (`persistRefusals`) when nothing authored at all.
- **Lenient once.** A resume passes `refusedBefore` to the author; a row
  refused before is authored with `lenientGrounding`, which makes the
  `ungroundedTextExpectation` refusal `weak`: the flow is handed over with the
  note and the RUN proves or dead-ends the wording against the real page.
  Every other lint stays fatal.
- **Capped.** `remaining()` drops a row at `AUTHORING_REFUSAL_CAP` (2)
  refusals — strict, then lenient — so the third resume does not pay again; it
  stays blocked with its reason. `--rerun-errors` (`markForRerun`) clears the
  count, so an explicit ask authors it once more. A sheet-gated row (Cancelled)
  is recorded at the cap outright.

Tests: `tests/suite-progress.test.ts` ("authoring refusals").

## Two lints that refused ec10 for the system's own reasons (2026-09-02)

Confirmed against the sheet, row by row: of ten new-hire rows, four were
refused by rules that were reading the wrong thing.

**The wording classifier read the whole prompt, background included.**
`WORDING_CLAIM` matches the Thai `ข้อความ` — "message" — and a catalog row's
prompt carries the retrieved requirement documents as well as the row. Any Thai
specification says `ข้อความ` many times, so *every* row was classified as a
claim about the page's wording; `wordingClaimAssertsDataValue` then refused
each one for asserting a value those documents happened not to quote — a new
hire's own keyed name (HIR-EC-002 `HIREEC002`), a duplicate notice
(HIR-EC-004), a success message (HIR-EC-008), a count (HIR-EC-001). Measured on
the sheet, only three of the ten rows say `ข้อความ` themselves and none of the
four refused ones is about wording at all. The lint now takes the case's own
words (`extra.caseText`, the row as `describeCase` renders it) and classifies
on those; the prompt still supplies the "is this value stated anywhere"
haystack, and a caller with no case text behaves exactly as before.

**An open question was treated as an expected value.** The sheet's convention
is explicit — `ข้อความ Notice ที่แน่นอน = ? OQ-HIR-140`, "run it, record what
the system shows, send it to BA/SA" — so `OQ-…`/`CF-…` is the NAME of an
unanswered question. HIR-EC-009 asserted `expectVisible text=OQ-HIR-78` against
the New Hire form, which can only fail and fails as though the application were
missing something. `assertsOpenQuestion` refuses it with a message that says to
assert the surrounding fact instead, and the procedure now carries the rule so
the first ask rarely trips it. Deliberately narrow: only the id shape, and only
where the flow ASSERTS it — a `fill` carrying one is the tester's own data, an
intent naming one is a note to a reader.

Tests: `tests/flow-author.test.ts` (`wordingClaimAssertsDataValue`,
`assertsOpenQuestion`).

## The Steps column is a script to perform, not background to read (2026-09-02)

ec10 HIR-EC-001: the sheet's eight numbered steps key an identity, walk the
Province → District → Sub-District cascade, fill position and compensation,
press Submit, then verify the created profile. What was authored signed in,
opened the form, and asserted that an `Employee ID` label and the words
`Auto-generated by system` were on screen — fifteen steps, two `fill`s, both of
them the login. It proved the form exists. It never ran the case, so nothing it
asserted was evidence either way, and the Expected output it answered was not
the sheet's.

`describeCase` had always put the Steps column in the prompt, so the model was
told the script; nothing told it to CARRY IT OUT, and the loudest instruction
in the procedure pulls the other way — *the fewest steps that reach the claim*.
For a key-in case the fewest steps that appear to reach it are to look at the
empty form. Two changes:

- **A procedure rule above the "fewest steps" one**: the Steps column is a
  script to perform in order with the Test data's own values
  (`กรอก`/`คีย์`/enter → fill, `เลือก` → selectOption or click, `กด` → click,
  Submit → the submit control). Asserting a field EXISTS is not performing the
  step that fills it, and the claim of a key-in case is what the system does
  AFTER the data is entered. A step that genuinely cannot be performed is named
  in its intent, never silently dropped.
- **`skipsAuthoredScript`**, a fatal lint: the case's Steps ask for input
  (`กรอก`, `คีย์`, `ระบุ`, `เลือก`, `กด Submit`, fill/key-in/enter/select/submit)
  and the flow's BODY performs none — no `fill`, `fillRetry`, `type`,
  `selectOption`, `check`, `uncheck`. Only the body is examined, so a sign-in's
  own fills neither satisfy nor trip it, and a read-only case (a menu is
  visible, a column list is complete) scripts no input and is never touched.

Tests: `tests/flow-author.test.ts` (`skipsAuthoredScript`).

## The control is the one the label points at, with the role the tree shows (2026-09-02)

ec10 HIR-EC-001 authored `fill role=textbox[name="Select date" i]` with
`1 Sep 2027`, and `selectOption role=combobox[name="Event Reason" i]`. All three
choices were wrong about the page, and the tree had shown the right answers: a
`textbox "Hire Date"` beside the placeholder-named read-only shell, and a
`button "Event Reason"` with `aria-haspopup`. A textbox named by its PLACEHOLDER
is usually a display over the real input; the real one is named by the field's
label. A date input takes `YYYY-MM-DD`. A dropdown the tree lists as a button is
a button — invent no role the tree did not show. One procedure rule now says so;
the engine's read-only shell rung (`src/engine/CLAUDE.md`) rescues the flows
already on disk.


## A row that says it cannot be run is not authored; a script of actions is not answered by assertions (2026-09-02)

ec10_2x CNS-EC-028: five steps — employee 1 signs in, opens the attachment,
accepts; the admin publishes version 2.0; employee 2 does the same; the dev
team reads the bound version codes; restore. The row supplies one account
(`<HR_ADMIN_ACCOUNT>`), and its own Note, from a check of SIT on 31 Aug, says
the admin consent register does not exist and *"ให้บันทึกผลเป็นยังทดสอบไม่ได้"* —
record as not yet testable. Authored anyway, the model did the honest thing it
could: three `expectVisible` on the one admin page that exists, each intent
saying the step "cannot be performed". The case then read as green about a
feature the sheet says is absent.

Two rules. `sheetGate` now reads the Note's own verdict — `ยังรันไม่ได้`,
`ยังทดสอบไม่ได้`, "cannot be run yet", "not testable" — and records the row
blocked in the sheet's words, at the refusal cap, for no model calls.
`skipsAuthoredScript` gained a second tier: a script that asks the tester to
ACT (`กด`, `ยอมรับ`, `ประกาศ`, `เข้าสู่ระบบ`, click/accept/publish/sign in) is not
performed by a body of assertions alone; a `click` or a `workflow` leg
satisfies it, as a fill satisfies the input tier. What no rule can supply: the
two employee accounts the script needs and the row never names. That is the
sheet's to fix.

Tests: `tests/retriever.test.ts` (`sheetGate`), `tests/flow-author.test.ts`
(`skipsAuthoredScript`).

## A token is not a value, and the script runs to its last step (2026-09-02, HIR-EC-012)

Two more refusals from reading one authored flow against its sheet row.

**`<NON_EXISTING_EMPLOYEE_ID>` was typed into the field.** The sheet's
Test data says `Invalid Replaced Employee ID = <NON_EXISTING_EMPLOYEE_ID>` — an
angle-bracket TOKEN for a value the tester supplies, the same convention as
`<HR_ADMIN_ACCOUNT>`. The flow filled the token itself; the page URL-encoded it
(`check-replaced-employee/%3CNON_EXIS…`), the API rejected malformed input, and
the step "proved" a rejection the case never asked about. `typesPlaceholderToken`
(fatal) refuses any `fill`/`type`/`selectOption` whose value still carries
`<LIKE_THIS>`, and the procedure says how to resolve one: from the Test data
when it names the real value, from the run's credentials for an account, and
for a NON_EXISTING / INVALID token from the format the case states — a
well-formed value that cannot exist (an 8-digit Employee ID such as 29999999).

**The flow stopped at step 3 of 7.** It cited "Step 2" and "Step 3" in its
intents and never reached the valid-replacement check, the identity data,
Submit or the profile check — the case's actual claim. Because the author
already cites the script step in each intent, coverage is checkable without
reading Thai prose: `unperformedScriptSteps` parses the script's `N.` lines,
collects the numbers the intents cite, and refuses (fatal) when numbered steps
beyond the highest cited one are neither cited nor marked
`skipped step N: <why>`. A flow that cites no step at all is left alone — there
is nothing to reason from — and the procedure now asks for the citation and the
skip marker explicitly, so a genuine gap is visible rather than silent.
Measured on the live HIR-EC-012 flow: refused with `performedThrough 3 of 7`,
naming steps 4–7; a flow citing every step, or naming its skips, passes.

Both delivered on typecheck plus a scripted check against the live flow; the
unit tests are owed.

## Values the sheet left as tokens are resolved, and a stand-in is flagged (2026-09-02)

`typesPlaceholderToken` refuses `<NON_EXISTING_EMPLOYEE_ID>` typed as data — honest,
and useless to the tester, who still has no run. `value-resolution.ts` runs
BEFORE the lints and resolves every input step whose value is a token or a
description ("ของพนักงานที่มีอยู่จริง"), cheapest source first, recording which one
answered on the step (`FlowStep.valueSource`), in its intent, and in every report:

1. **test-data** — the case's own `Field = value` line; a NON_EXISTING need never
   takes the valid id's line and vice versa. $0.
2. **repo** — `selectRelevantContext` over the documents (or the prompt's own
   paragraphs ranked by overlap), one structured question to the agent role;
   accepted only when the value appears verbatim in a passage.
3. **db** — read-only, only when `WOWLIDATOR_DB_URL` is set: the agent role names
   `{table, column, where}` in `dbCount`'s shape, every identifier is checked
   against the introspected schema (a wrong one is a refusal, not a query), one
   `SELECT … LIMIT 1`, the value through `redactValue` (a sensitive column is
   never used). A NON_EXISTING token is proved absent instead: a candidate from
   the case's stated format (`8 หลัก`, `หลักแรกเป็น 2` → `29999999`), `count(*) = 0`,
   stepping past up to five that exist.
4. **generated** — the generator role invents a well-formed value (or
   `candidateFor` does, deterministically, with no model), and the step is
   FLAGGED: `valueSource.kind = 'generated'`, the intent says so, the proof
   bundle gets a note, the CLI line prints `value generated — …`, both HTML
   reports show a `value generated` badge (`GLOSSARY` entry) and a `value` fact,
   the Excel Proof column a `value source:` line, wowUI's step panel a `value`
   row. A generated value is a stand-in the reader must weigh, never evidence.

Never fatal: a source that throws is a source that did not answer; the lint stays
as the backstop for what nothing could resolve. `--no-value-resolution` /
`WOWLIDATOR_VALUE_RESOLUTION=off` turns the stage off (`buildValueResolution` in
`cli/runtime.ts`); with no agent key the model is null and sources 1 and 4 still
work. Tests: `tests/value-resolution.test.ts`.

## The token stays for the resolver, and a skip is not an escape hatch (2026-09-02, HIR-EC-012 again)

Read against the sheet, the re-authored HIR-EC-012 covered steps 1–3, one field
of step 5, and skipped 4, 6 and 7 — the case's claim untested — and it had
resolved `<NON_EXISTING_EMPLOYEE_ID>` to `29999999` ITSELF, so the value carried
no `valueSource` and a made-up id read as data. Two changes:

- **The procedure now says to leave the token in place.** The resolution stage
  runs after the model and records provenance (test data / repo / db / generated);
  a model that resolves the token on its own destroys exactly that. The
  non-existence proof (`count = 0` in the database) only happens on this path.
- **A step skipped for want of a value is looked up, then re-asked.**
  `#valuesForSkippedSteps` reads each `skipped step N: <why>`; when the reason
  speaks of a missing id/value it extracts the field (`fieldNamesIn`) and asks
  the test-data, repo and db sources. A value found becomes a `weak` refusal —
  "step 4 skipped, but db has Replaced Employee ID = 20004512; author it, and
  the steps skipped only because it was missing" — so the next attempt writes
  step 4 (and, with it, 6 and 7), and the last attempt accepts the skip with a
  note naming the value that was available. Steps skipped for other reasons
  (another module, destructive) are left alone.

What no lint can judge: how COMPLETELY a cited step was performed — step 5's
"กรอกข้อมูล Identity ตามข้อมูลที่กำหนด" is one bullet and a dozen fields, and a
flow that keys one of them has cited the step. That remains the reader's call,
and the report's step list is where to make it.

## "Only" means only (`src/generator/exclusivity.ts`, 2026-09-02)

An Expected line that says ONLY / JUST / EXACTLY / เฉพาะ / แค่ / เพียง / เท่านั้น about an enumerated set ("แสดง 3 ค่า", "A / B / C") is a claim about the whole set, and the whole set is proved by counting it. Measured on ec10_3x HIR-EC-029: the flow proved three options visible and three named codes hidden and went green over a list nothing had counted. Three places share one detector (`exclusivityClaimIn` / `unprovedExclusivity`): the authoring prompt's procedure + self-check, a fatal lint in `FlowAuthor` (refuses a body with no `expectCount`, or one whose numeric count disagrees with the sheet's), and `runCases`, which blocks a flow already on disk the same way it blocks a vacuous one (re-authored on `--resume`). Conservative by design: the marker must be in the Expected block and the line must enumerate — a bare "เฉพาะบางกลุ่ม" is left alone.

## "Only these three" is a count, not three presences (2026-09-02, HIR-EC-029)

The Expected output read *dropdown แสดง 3 ค่า : Event Reason บนหน้า Key-in
แสดงเฉพาะ New Hire / Replacement / Migration*. The page offered a dozen reasons
(DATA MIGRATION, HIREDM, H_NEWHIRE, H_RPLMENT, MT_EMP_INFO …) — the defect the
case exists to catch. The flow asserted `expectVisible` of each of the three:
presences that pass on a dropdown of a hundred. The case went red only because
one presence tripped on wording, so the report blamed a label and never
mentioned the extra options — a fail for the wrong reason, which is a miss.

`unboundedExclusivityClaim` (fatal): when the case text claims a closed set —
a count (`แสดง 3 ค่า`, `exactly 3 options`) or an "only" (`เฉพาะ`, `only these`,
`nothing else`) — the flow must carry an `expectCount`; presences alone are
refused, and the message names the bound (`expectCount role=option = 3`). The
numbered form is read first so the refusal can quote the number. The procedure
carries the same rule, with the shape to write: open the control, count its
options, then assert each named value; an `ไม่แสดง X` line is an `expectHidden`
on top of the count, never instead of it. Tests: `tests/flow-author.test.ts`
(`unboundedExclusivityClaim`).

## What a model hands back is unwrapped before it is typed (`cleanModelValue`, 2026-09-03)

Live (ec09 HIR-EC-009, panel jobs 2 and 3): the value resolver reached its last rung for `National ID / Tax ID = <VALID_NATIONAL_ID>` (no sheet value; the column is sensitive so the database is never asked) and typed the model's answer verbatim — which was the reply envelope nested inside the value, `{"value": "1999900123459"}`, because the system prompt said "output only the value" while the user prompt said "Reply {"value": …}". `cleanModelValue` now runs on every string a resolver model returns (`generated`, `fromRepo`): code fences, a JSON object whose `value` (or lone) key holds the answer — nested envelopes too — surrounding quotes and trailing prose are stripped; a plain value is untouched; a generated value that still contains `{}[]"` falls back to `candidateFor`. The generate prompt no longer contradicts its own reply shape. This is packaging repair only — it knows nothing about any field. (The number itself then failed the app's mod-11 checksum; a field-keyed checksum generator was tried and rejected the same day as hardcoding — a generated value's validity is the app's verdict, shown in the report as `generated`.) Tests: `tests/value-resolution.test.ts` ("what a model hands back is unwrapped…").

## A persona hand-off is one `signIn`, never a `signOut` first (2026-09-03)

Each persona now gets a Chrome of their own for the length of the case and keeps their session (see `src/engine/CLAUDE.md`, "A persona switch is a browser switch"), so the prompt's sign-in rules say: one `signIn` per hand-off, no `signOut` before it, and a `signIn` naming a persona who already signed in earlier returns to their browser with the session intact. `signOut` is authored only when the case itself says to sign out. `groundPersonaSwitches` never spliced a `signOut` before a `signIn`-based switch (it grounds hand-typed credential blocks only), so the change is in the prompt and the refusal wording; `multiPersonaWorkflow` still refuses one workflow goal naming two people.

## The tree is read with the row's tab selected, and the opening click only from that state (2026-09-04, PY-1 TC_SSO_001_001)

The sheet's step 2 says `กดปุ่ม "Add" / "+"`; the flow clicked
`role=button[name="Add Rate" i]` with the intent admitting it — *(rendered as
"Add Rate")* — and every field after it was the RATE form's (Employee Rate (%),
Save (Ctrl+Enter)). The run proved the page: after the flow's own click of the
"SSO Branch Registration" tab, "Add Rate" was absent (`the page's button is
named "SSO Branch Rate"`), and in-run reconstruction had to click BACK to the
"SSO Branch Rate" tab to find it. Not two controls in one tree: the panels
render one at a time, and the Registration panel's own Add control was in no
tree the author ever saw.

The chain was the capture, not the model. `captureJourneyTree`
(`cli/commands/authoring.ts`) read `/admin/config/sso` in its LANDING state —
the default tab — although `destinationOf` had already parsed the row's tab
(`เลือกแท็บ "…"`), and the prompt merely told the model "the row selects the tab
X — click it before reading". Then `captureAfterOpening` matched the script's
`"Add"` by prefix to the default panel's `"Add Rate"`, clicked it, and captured
the wrong form as the row's. Every lint and the $0 audit passed, because
everything the flow named WAS in the tree; the tree was of a state the script
never visits. A grounding lint cannot recover evidence that was never captured,
so nothing changed in either author file; the fix is where the evidence is made:

- **The row's tab is selected on the capture tab before the tree is read**
  (`selectNamedTab`, matched by accessible name in whatever role the strip
  renders it — here buttons). The section header says the tree was read WITH
  that tab selected and that the flow must click it first.
- **The opening click runs only from the state the script clicks it in.** A
  row that names a tab this capture could not select gets NO opening capture
  (logged), and the header says the tab was not selected and that a control
  the script names which is absent below is *not captured*, never absent — a
  workflow goal in the script's words is the honest shape for that leg. No
  tree beats a tree of the wrong panel: the first hands the author a thin
  claim the run can settle; the second handed it a false one that passed
  every check.
- **One matcher for both clicks** (`controlNamedIn`, pure, exported): whole
  name, then prefix, then containment, clickable roles only — so "which
  control did the sheet mean" cannot mean two things. The prefix rule stays;
  it is right on the right panel.

Evaluated and rejected as generator rules: (a) marking the selected tab in the
tree — the strip here is buttons, the tree is flat, and a state flag would
raise every healer call's token bill for a signal this app does not emit;
(b) "an exact tree match for the script's quoted name beats a longer name" —
it refuses a true claim in this very flow (`กด "Save"` is correctly
`Save (Ctrl+Enter)` on the modal wherever a page-level "Save" also exists), and
a rule that can refuse a true claim is wrong; (c) a lint comparing the flow's
clicks against the capture's click path — a filter clicked between arriving and
opening is legitimate, and with the capture fix the header is consistent by
construction. Tests: `tests/flow-author.test.ts` ("journey capture reads the
tab the row selects, before the opening click").

## One author again (2026-09-04)

For a day the CLI ran `flow-author_original.ts` while every test ran `flow-author.ts` — ~1,750 diff lines apart, the hardcode guard skipping the live one by name. The CLI, `src/index.ts` and `cli/options.ts` now import `flow-author.ts`; the older file is a reference artifact at `docs/artifacts/flow-author_original.ts` (outside `src/`, compiled and imported by nothing, and no longer on the no-hardcode SKIP list). Seven prompt tests that pinned the old file's SHOUTED headings were re-pointed at the live prompt's sentences for the same rules (persona sign-in by label, menu path as the first leg, one pair per line, date phrases, `[RECORD ONLY]`, option sets counted with the list open once, wait-until, `expectFieldError`, `expectAnyVisible`, evidence independent of the agent, the disclosure corollary, `request`, one page state, the captured second page, both scopes). No rule was dropped: each was found reworded before its test was changed. Tests: `tests/author-wave2.test.ts`, `tests/flow-author.test.ts`.

## The resolver's vocabulary is data: `value-rules.ts` and `.wowlidator/value-rules.json` (2026-09-04)

The whole QA workbook (`QA_Task_Tracking_Cycle1.xlsx`, 1,286 rows, 8,225 Test data pairs) was read cell by cell through the resolver's own functions. Of the 1,409 pairs that turn out to be needs, the resolver knew tokens, date phrases, reused keys and described values; it did NOT know five shapes the sheet writes constantly, and typed each verbatim:

- a value followed by a remark — `Employee Sub Group = 10 ตามชุดข้อมูล` (HIR-EC-015), `Work Schedule = D05H0830 ตามที่ Position กำหนด`, a bound `Personnel Grade = 11 ขึ้นไป` (PRB-EC-038), a quoted literal with a comment `"32/13/2026" (วันที่ผิดรูปแบบ)` (PL_10_41) — 457 pairs;
- a blank word — `Payment Method = Blank` (HIR-EC-059), `DVT Project = null`, `Transfer out to = เว้นว่างในเคสนี้ …` (HIR-EC-139) — 107;
- a mask standing for a value made elsewhere — `Employee ID = EMXXXX (จาก E2E-01)` (PRB-EC-036), `Benefit plan ID = BE-XXX-999 (ไม่มีในระบบ)` (PL_10_54) — 57;
- an invalid value described by its own examples — `status = ค่าอื่นที่ไม่ถูกต้อง เช่น "Active", "X"` (PL_10_40) — 28; and a text described only by its length — `ข้อความความยาวเกิน 255 ตัวอักษร` (PL_10_48);
- date phrases outside the grammar — `31-Dec-9999`, `13 เมษายน`, `1 มกราคมของปีก่อนหน้า`, `< Current Date`, `วันก่อนวันที่จ้าง`, `Age = 60 พอดี ณ Hire Date`, `ทำให้อายุ ณ Hire Date เท่ากับ 59 ปี 11 เดือน`, `ย้อนหลังจากวันที่ทดสอบ 5`, `วันที่ทดสอบ บวก 30 วัน`, and a value that IS another date field's label (`Probationary Period End Date = Hire Date`, PRB-EC-066) — 85 date misses became 73, and the 73 left are unresolvable in-row (the Hire Date lives in another case's data set, `วันแรกของงวดเวลาปัจจุบัน` needs a payroll calendar, a `Payroll Period Cycle` is not a date) and are left as written, exactly as before.

Every one of those readings rests on a VOCABULARY, and the user's standing rule is no field-, phrase- or locale-keyed fix. So the mechanisms are structural and live in `value-resolution.ts` — `writtenValueOf` (a trailing clause after an introducer, a trailing bound, one parenthetical after a space, a leading quoted literal, the first quoted example after an example introducer), `MASK_VALUE`, `labelOfDatePair`, an anchor clause (`ณ <label>`) and a relation prefix (`< X`, `วันก่อน X`) in the date grammar, a length format — and the WORDS are data in `value-rules.ts`: `DEFAULT_VALUE_RULES`, a zod `ValueRulesSchema`, `loadValueRules()` (built-ins merged with `.wowlidator/value-rules.json`; an invalid file is one stderr warning and the built-ins, never a throw), `saveValueRules()` (validate, temp-file + rename), `compileValueRules()` (the one place the regexes are built: every word is escaped and anchored the way the built-in was — Latin on a word boundary, Thai as a substring, a blank word as the whole value; a bad entry is rejected by list and index). `ValueResolutionContext.rules` injects a rule set; `resolveValues` loads the file once per call when none is given, so the CLI and the panel need no new flag, and the panel can edit the file without a TypeScript change. Externalised from code into the file: key-field words, QA key prefixes, non-existing / described / already-exists wordings, blank words, note introducers, bound words, example introducers, format words, the date vocabulary (today/tomorrow/yesterday/future/past, month words, before/after, anchor prepositions, filler prefixes, exact words, back/forward, units, birth-field and age words, age comparators, age anchor fields), field aliases (`Hire Date` ~ `วันที่จ้าง`), and per-field defaults (a value is recorded as `valueSource.kind = 'rules'`, never as the sheet's word; a format shapes the stand-in).

Why it cannot make a result worse: every new shape is single-source — cleaned, blanked or computed from the case's own words, or left as written; no new shape reaches a model. A `selectOption` keeps its parenthetical (an option's label may BE `CDS (C001)`); a value with several parentheticals, a bracket glued to a name (`Permanent(7-16)-(12/31/9999)`), a lowercase `<runtime>`, a range (`07 ถึง 10`) and an option label that reads like a phrase are all typed as written, pinned. The 34 tests that existed pass unchanged under the built-ins; the file's lists REPLACE the built-in list wholesale (a word can be removed), so a tester's edit is exact. Tests: `tests/value-resolution.test.ts` ("the workbook's own cell shapes", "value rules") — every value quoted from a real cell with its case id.

## A visual snapshot is not authorable (2026-09-04, ec09 HIR-EC-009)

Step 58 of the live HIR-EC-009 run was `snapshot record_oq_hir_78`: the author's reading of the [RECORD ONLY] rule ("snapshot a region when it is a state"). A `snapshot` writes its baseline on the first run and diffs every later run against it, so the second run of the same case failed the step `changed` (10% of pixels — the data the run itself had typed) and a record-only observation became a red step about nothing. `snapshot` is out of `AUTHOR_ACTIONS` (so the schema refuses it and narrowing never sees it), out of the vocabulary list, and the rule now says a state is `saveText` of the region that shows it — the film and the per-step screenshot already keep the picture. The engine action stays for hand-written flows (`src/visual/`). A flow already on disk with a snapshot step keeps it until re-authored. Test: `tests/author-wave2.test.ts` (CG-09, "a visual snapshot is not authorable").

## Two lints no flow could satisfy, and a loop that kept asking (2026-09-04, multirole HIR-EC-001)

Panel jobs 3 and 15 spent three opus calls a row (264 s, 21.7k output tokens,
~$0.95 each) on HIR-EC-001 and blocked it — `authoring refused (attempt 1)`,
which is the RESUME-cap counter, not the model-attempt count — and a `--resume`
would have paid three more for the same result, since `lenientGrounding`
relaxes only `ungroundedTextExpectation`. Read against the sheet, two of the
four refusals were unsatisfiable by construction, one was reading a note
instead of a claim, and one was right.

- **One exclusivity detector.** `FlowAuthor.author` called BOTH the legacy
  `unboundedExclusivityClaim` and `exclusivity.ts`'s `unprovedExclusivity`. The
  legacy `only` regex had no word boundary and read *Time Management Status และ
  O.T. Flag เป็น Read-only และ HR ไม่สามารถแก้ไขเองได้* as a closed set, demanding
  `expectCount role=option` of options that do not exist; the shared detector
  had already said null (nothing enumerated). The legacy call is gone; the
  export is a view over `unprovedExclusivity` so nothing else moves; and
  `ENGLISH_MARKER` is `(?<![\w-])only\b` — a hyphen-joined "only" is a compound
  adjective (read-only, view-only), one thing's mode, never a set's size.
- **An empty `expectValue` is the cleared-field claim.** *เมื่อเปลี่ยน Province
  ระบบเคลียร์ District / Sub-District / Postal Code เดิม* is a claim that a field
  holds NOTHING; the model wrote `expectValue ""`, narrowing dropped it
  ("expectValue needs a value"), and the drop was refused fatally — a shape the
  vocabulary offered no way to write. The engine compares `inputValue` to `""`,
  which fails on any textbox still holding something, so the pass can fail.
  The one control that cannot carry it is a dropdown the tree lists as a
  button: the engine falls back to the trigger's own text (its placeholder) and
  the step would be red against a correctly cleared dropdown. That shape alone
  is dropped, with `EMPTY_VALUE_ON_BUTTON_REASON` naming the legal ones
  (`expectText` of the trigger's wording, `expectHidden` of the cleared choice);
  the vocabulary line says the same.
- **The fixture lint reads the claim, never the note, and knows a derived
  field.** `ungroundedFixtureAssertion` stringified the whole step, intent
  included — and the prompt itself tells the model to write *skipped step 4:
  unconfirmed test data — Policy Profile = … ดู CF-SIT-19*, so any
  `expectVisible` carrying that note was refused for "asserting CF-SIT-19".
  The intent is now excluded; `fixtureFacts` skips `OPEN_QUESTION`-shaped ids
  (a question's name is never a fixture — `assertsOpenQuestion` owns that
  shape, and now also reads `role=…[name="…"]` and past a `>> nth=N` chain);
  and an `expectText`/`expectValue` anchored on a value-holding control after
  a body `fill`/`selectOption`/`type` is the application's answer to what was
  entered — *ระบบดึงข้อมูลจาก Department ได้แก่ … Store/Branch Location*, Branch
  `T153_1733` after selecting the Department — which the run settles. A
  `text=` presence, a row click, a DB where-clause and a count stay judged:
  those are the be100 shapes the lint was written for, and a lookup BEFORE
  anything was entered is still refused.
- **An open-question id beside a value is a reference.** `Policy Profile = CDS
  ใช้แทน CDS ที่เคยระบุ ดู CF-SIT-19` was classified unconfirmed on the raw cell
  (`unconfirmedValue`, `catalog/test-case-table.ts`) although `writtenValueOf`
  already reads it as `CDS` and the same data set lists `[TD-01] Policy Profile
  = CDS`; the author was told to skip the field and `usesUnconfirmedValue`
  would have refused `selectOption "CDS"` into it. The OQ/CF alternative now
  counts only at the START of the value (`? CF-HIR-08 OQ-HIR-50`, `OQ-HIR-13`
  stay unconfirmed) — the rule `fixtureFacts` already applies to a case id
  after "same as". No vocabulary was added; the note introducer that strips
  the remark (` ใช้`) was already data in `value-rules.ts`.
- **The same fatal refusal twice is not re-asked.** The loop had no notion of
  a refusal the flow cannot satisfy. In the `catch` of `FlowAuthor.author`,
  when this attempt's fatal `refusalShape` set equals the previous attempt's,
  the loop stops and throws the refusal prefixed *refused identically on N
  attempts — a rule the model cannot satisfy or a lint that misreads the case;
  review the lint*, and the repeat is NOT counted by `#rememberRefusals` (so an
  unsatisfiable rule cannot become suite memory; a rule now travels only once
  two ROWS broke it). Weak refusals are untouched — they are meant to be
  re-asked, then accepted. Why it cannot make the result worse: the outcome is
  the BLOCKED the budget would have reached anyway, one attempt earlier, and
  the ledger line now says whether to look at the lint or at the model. It
  cannot detect an unsatisfiable rule on the first attempt; only the lint
  fixes above do that.
- **What was right:** `unperformedScriptSteps` (the flow stopped at step 7 of 8).
  The earlier run reached step 8 unprompted; with one item of feedback instead
  of four the re-ask has a chance to converge. Kept fatal.

Measured offline on the real row through the lints: `unconfirmedTestData` empty,
`fixtureFacts` without the three OQ/CF ids, both exclusivity detectors null, the
skip-note and derived-Branch shapes accepted, `usesUnconfirmedValue` null for
`selectOption "CDS"`. Expected on the panel: one or two attempts instead of
three-and-blocked. Tests: `tests/flow-author.test.ts` (`unboundedExclusivityClaim`
"Read-only", the fixture and `assertsOpenQuestion` HIR-EC-001 cases, "stops after
two identical fatal refusals", the memory test now needing two rows),
`tests/author-wave2.test.ts` ("narrows an empty expectValue …"),
`tests/value-resolution.test.ts` ("an open-question id beside a value is a
reference"). Cost is out of this module's hands: the 92k "in" per attempt is the
claude-cli session's cache re-written per call (`provider-expert`), and the 264 s
is 21.7k output tokens; `WOWLIDATOR_GENERATOR_RETRY_MODEL` and
`WOWLIDATOR_AUTHOR_ATTEMPTS` are the dials, unmeasured.

## The lints' words are data, and a choice is made by clicking (2026-09-04, multirole PRB-EC-001 / ML_01_04)

Two lint defects read off the multirole run, and the audit they forced. The
user's standing rule (2026-09-03) is the frame: no field-, phrase- or
locale-keyed fix; a lint keys on STRUCTURE — a role from the tree, a step
shape, an action kind, a line's numbering, a `= ?` beside an id — and the
words it reads that structure through belong in data, in both of the
languages the sheets use.

- **`skipsAuthoredScript` has three tiers, and each names what performs it.**
  `เลือก` / select / choose sat in the TYPING tier, satisfied only by
  `INPUT_ACTIONS` — no `click` — while the refusal told the model a click
  counts. PRB-EC-001's `click role=radio[name="Pass probation (normal)"]` was
  refused for a script it had performed. Now: TYPING (`กรอก`, `คีย์`, fill,
  key in …) is performed by a fill / fillRetry / type / setValue / upload — and
  a selectOption / check, a chosen cascade being data entered (HIR-EC-001,
  kept); CHOOSING (`เลือก`, `ติ๊ก`, select, choose, tick …) by those, or a
  `click` whose selector role is a choice role (`CHOICE_ROLES`: radio, option,
  checkbox, switch, menuitemradio, menuitemcheckbox, tab, treeitem), or a
  `click` that another body step follows — a choice made by clicking is the
  ordinary shape and the step after it is what the choice was for; ACTING
  (`กด`, `ยอมรับ`, `ประกาศ`, click, accept, publish, sign in …) by any action
  or a workflow leg, as before. Tiers are judged in that order, the result
  carries the `tier`, and the refusal prints `describeScriptDemand(tier)` —
  the sentence lives beside the sets it describes, so the message and the
  code cannot say two things.
- **`unperformedScriptSteps` reads three carriers.** It read only an intent's
  `step N`. A `workflow` step's GOAL is where an agent leg names its script
  step (the carrier rule `unassertedExpectedItems` already applies), and the
  sheet's own sub-numbering at the head of an intent (`5.4 กด Approve`) cites
  step 5 — excluding any id that is an EXPECTED line's (`expectedItemsIn`), so
  the two numberings cannot be confused, and only for a number the script has.
  `skipped step N: <why>` still marks a skip. The step and skip words are data
  (`authoring.script.stepWords` / `skipWords`: step / ขั้นตอน / ข้อ, skip /
  ข้าม).
- **`expectedItemsIn` anchors an id at the line's head.** "Requested hours :
  0.52 hrs" was read as Expected item `0.52` and demanded an assertion. A
  decimal id or a bare `N.` counts only after optional whitespace and a
  bullet, never mid-line.
- **`ENGLISH_MARKER` keeps its `(?<![\w-])` lookbehind** (read-only, view-only
  are one thing's mode).

**`value-rules.ts` now exists** — the section above ("The resolver's
vocabulary is data") described it before the file did; the resolver's
`VOCABULARY` was an inline constant. It is one module with two halves under one
zod schema: `values` (the resolver's vocabulary, moved there verbatim and
re-exported by `value-resolution.ts` under its old name) and `authoring` (the
lints' and gates' words). `loadValueRules()` merges the built-ins with
`.wowlidator/value-rules.json` — a present list REPLACES the built-in one
wholesale so a word can be removed, an absent key keeps the built-in, an
unknown key or an invalid file is one stderr line and the built-ins, never a
throw. Loaded once per process (`VALUE_RULES`, `AUTHORING`), which is once per
panel job since the panel runs `dist/cli.js` per run; not per call, and there is
no `ValueResolutionContext.rules` — the earlier section overstated both.
`compileAuthoringRules` is the one place the lint regexes are built: Latin on a
word boundary, Thai as a substring after a line start / space / bullet / step
number (the anchoring the lints always used), longest word first.

Moved into data (`DEFAULT_AUTHORING_RULES`), every list Thai + English:
`script.typing` / `choosing` / `acting` (was `SCRIPT_DEMANDS_INPUT` /
`SCRIPT_DEMANDS_ACTION`), `script.routeLine` (was inline in
`withoutRouteLabels`), `script.stepWords` / `skipWords` (was the citation
regex), `wordingClaim` (was `WORDING_CLAIM`), `matchClaim.agree` /
`unchanged` / `readings` / `quantities` (was `unreconciledMatchClaim`'s
regex — the shape, an agree-word within a clause of a reading or an
unchanged-word within a clause of a quantity in either order, stays in code),
`openQuestionPrefixes` (was `OQ|CF` in three files), `sheetNote.cancelled` /
`notYet` / `retest` (was `sheetGateReason`'s regexes in
`catalog/test-case-table.ts`, whose English-only cancelled list gained the
Thai phrases). The catalog parser now imports this one leaf module of the
generator; it imports nothing of the parser, so the dependency still runs one
way.

Became structural: **an open question is any id the case writes after its
`?`** (`openQuestionIdsIn`) — `OQ-`/`CF-` were one workbook's convention;
`assertsOpenQuestion` takes the case text and `fixtureFacts` reads it too, the
prefixes staying as a configurable fallback; **a sibling case id is one whose
skeleton (digits blanked, `HIR-EC-#`) matches the case's own id or an id the
row cites as a case** — `fixtureFacts`' `caseIdShape` was a literal list of
one workbook's suffixes (EC / BE / TM / PY), and `เคส <id>` now counts as a
case citation beside `same as`; **`unconfirmedValue`** reads the open-question
prefix at the START of a value through the same rules. Prompt examples that
steered toward one application were generalised or marked: the procedure
opens by saying every quoted name in its examples is an illustration from some
other application; "an OQ-/CF- id" is "the id the sheet writes after its
`= ?`"; "Login web humi" is "Login web <app>"; the placeholder-token refusal
no longer names an 8-digit Employee ID. `vacuous.ts`'s `LOGIN_FORM_CONTROL`
reads `email` rather than one application's `work email`.

Left alone, on purpose: `beyondHarnessReason`'s `brew services stop` family
(shell commands, language-neutral); `referencedSources` (bilingual already, in
the catalog); the four inline claim shapes `ALTERNATIVE_CLAIM` / `DELTA_CLAIM`
/ `FIELD_ERROR_CLAIM` / `WAIT_UNTIL_CLAIM` (bilingual and symmetric; moving
them is mechanical and owed); `LOGIN_CONTROL` / `LOGIN_URL_PATTERN` (the
documented sign-in generic); `ageAnchorFields` / `fieldAliases` (data already,
now overridable); and, in the catalog parser, `CASE_ID` / `DATA_REF` /
`GENERATED_NAME` / `personasOf`'s role words / `OTHER_TEAM_RE` — one
workbook's id prefixes, QA name prefixes, persona words and a Thai-only
"handed to another team" list, each needing the whole table's ids or a driver
row in the other language to replace structurally; named here so they are not
mistaken for generic.

Probed offline on the PRB shape: the radio / Submit / signIn / Approve /
workflow body passes, a body of assertions is refused `choosing`, a goal-only
`Step 5:` and a `5.4 …` intent each clear step 5, a flow citing 1–4 alone is
still refused, `0.52` is no longer an item. Tests: `tests/flow-author.test.ts`
("a choice is made by clicking", "a citation in a goal or in the sheet's
sub-numbering", "an id is at the head of its line", "the authoring vocabulary
is data").

## The last word is a rewrite, not a refusal (2026-09-04, multirole HIR-EC-001 / PRB-EC-001)

Read against the panel's two multirole runs. The 07:10 ledger blocked HIR-EC-001
with the two refusals the section above had already fixed at 14:28 local
(`only` inside `Read-only`; `expectValue ""` dropped) — the panel runs
`dist/cli.js`, and dist was built after both runs, so the report was the OLD
author's; and the ledger's `(attempt 1)` is the RESUME-cap counter, not the
model-attempt count (the loop asked three times, then stopped identically).
The 05:46 run blocked PRB-EC-001 — not HIR-EC-001 — with *depends on E2E-01,
which is not in this catalog*: `E2E-01` is the SCENARIO ID of HIR-EC-001, two
rows above it, and `linkDependencies` resolved references against Test Case
IDs only. ML_01_04's "no verdict" is `status: error` on
`expectVisible text=Full day` straight after the date-picking `workflow` leg —
the agent leg's outcome, `orchestrator-optimizer`'s, not an authoring shape
(the assertion after the leg is exactly what `unsettledWorkflowClaim` asks
for). What changed, all in `flow-author.ts` unless named:

- **A scenario id is a name the table may hold** (`catalog/test-case-table.ts`
  `linkDependencies`): a reference resolves against Test Case IDs first, then
  the Scenario ID column — the row's OWN scenario is itself (never a
  dependency), another scenario in the table is its first row of the same
  sheet (`dependsOn`), and only a scenario the table lacks is `externalRefs`.
  Structural: the ids come from the table's own columns. The parser also had a
  literal NUL byte inside three template-literal keys (`grep` read the whole
  file as binary and found nothing in it); it is the `\u0000` escape now.
- **A step the harness cannot run is rewritten before it is dropped**
  (`repairAuthoredStep`, in `LlmFlowAuthorModel`'s narrowing, $0): the nearest
  runnable form from the evidence the model was given — `expectValue ""` on a
  dropdown BUTTON becomes `expectText` of the trigger's own wording as a tree
  line names it (the cleared state; no tree line, no rewrite); an `expectText`
  / `expectCount` / `expectAttribute` with no value takes the intent's own
  `= value` pair (digits for a count) or narrows to `expectVisible` of the same
  control and says it is thinner; a `type` / `selectOption` with no value takes
  the Test data pair the control is named after, `valueSource.kind =
  'test-data'`; a one-alternative `expectAnyVisible` is the `expectVisible` it
  meant. `fill ""` is never touched — clearing a field is a real step. Every
  rewrite ends the step's intent with `[generated: <how> — the authored
  <action> could not run: <reason>]` (`markGenerated`; the HEAD of the intent
  stays, so `unperformedScriptSteps` and `expectedItemsIn` still read their
  citations), lands on `AuthorResult.substituted`, is logged `substituted …`
  beside `dropped …`, and is written to the flow's `notes` — the report reads
  what was substituted for what. Found on the way: `expectCount ""` narrowed to
  **count 0** (`Number('')`), a claim the model never made that passes on any
  empty list; digits are required now.
- **`Violation.settle`** — the structural fallback a fatal lint may carry, run
  by `settleViolations` at the LAST WORD only: the budget's final attempt, or
  the attempt whose fatal shapes equal the previous attempt's (the identical
  refusal, one attempt earlier). Every fatal complaint with a grounded rewrite
  performs it in place — the step objects are shared between `steps` and
  `cases`, and `insertStepBefore` / `removeStep` edit both — and the flow goes
  out with the covered steps as written and each uncovered claim in `notes`;
  one fatal complaint that cannot be settled keeps the whole refusal, so a
  FALSE claim is still never handed over. Weak complaints keep their notes.
  The five that settle: `unprovedExclusivity` → `settleExclusivity` inserts
  `expectCount role=<item role> = N` before the first member presence, the
  role read from the tree/probe lines that name EVERY enumerated member under
  one role (a member in no tree is no evidence, null — the same phantom
  `ungroundedCountRole` refuses); `unperformedScriptSteps` → `not covered:
  script step(s) N (<text>)`; `assertsOpenQuestion` → the step is removed
  unless it is the only assertion; `ungroundedTextExpectation` → the step is
  annotated with the nearest renderings and left for the run (what
  `lenientGrounding` did one resume later); `ungroundedSelectorRole` →
  `settleSelectorRole` repoints the role to the tree's own line for the SAME
  name, never a different one and never a disabled control. Without a
  fallback, as before: vacuity, no assertion, a script performed by assertions
  alone, a placeholder token typed, a credential echoed, a login proof on the
  login page, an unpinned date, an unindexed verb, a goto to no route, a
  fixture asserted as fact, a wording claim on a data row, an unreconciled
  match — each is a false claim, and `CLAUDE.md`'s premise 3 says refusing it
  is the right answer. Owed, if a live row shows them refusing a true claim:
  a `settle` for `unpinnedDateEntry` (a `setClock` of the run's own `now`) and
  for `countPinnedName` (the name without its count).
- **The procedure says to cover every claim in one answer** and names the
  accepted forms for the two shapes the row tripped on (a cleared textbox is
  `expectValue ""`; a closed set is `expectCount` + presences), so the first
  ask rarely needs the fallback.

Why it cannot make the result worse: a rewrite reads a tree line, the intent's
own pair, or the sheet's own Test data — never a guess — and a settlement is
either the lint's OWN remedy performed from the evidence (the count, the
tree's role) or a note that names what is not covered; a refusal with no
grounded rewrite is the refusal the budget would have reached anyway. Long
Test data cells were checked, not fixed: `describeCase` renders the whole cell
(HIR-EC-001's 1,550 characters, one pair per line); only the RUNTIME card
(`caseCard`) cuts at 420, and the exclusivity fragment came from the
word-boundary bug, not from truncation. Not verified live: the authoring
itself (opus via `claude-cli`, whose output side `provider-expert` is changing
today); verified offline through the lints and the parser on the real rows.
Tests: `tests/sheet-grammar.test.ts` (CG-12, "resolves a reference against
the Scenario ID column"), `tests/author-wave2.test.ts` ("a step the harness
cannot run as written is rewritten and marked"; CG-08's one-alternative case
re-pinned), `tests/flow-author.test.ts` ("the last word is a rewrite, not a
refusal": `settleViolations`, the step-7-of-8 hand-over, the identical
refusal settled on attempt 2, a token still refused, the ungrounded text
annotated, `settleSelectorRole`, `settleExclusivity`).

### Addendum, same day: ML_01_04 — a noun read as a verb, and what the last word could not settle

The panel's job-6 (`--author-attempts 1`, so attempt 1 IS the last word) blocked ML_01_04 on `skipsAuthoredScript` (fatal, no `settle`) plus the weak `workflowOverDeclaredControls`; the rebuilt dist was in use (job started 08:54Z, dist 15:46 local = 08:46Z). What stopped the settle was simply that the fatal lint had none — and it should not have fired: the script says `5. เลือก Leave type = Sick Leave`, and the typing tier matched the NOUN "type" (the head of a `Field = value` pair). Fixes, all structural:

- **`scriptDemand`**: a demand word immediately followed by `=` / `:` is a field name (the sheet's own pair grammar), never the verb. A `workflow` leg performs the typing and choosing tiers as it already performed the acting tier — whether its claim is settled is `unsettledWorkflowClaim`'s question. ML_01_04's body (choosing through agent legs) now passes the lint outright.
- **`workflowOverDeclaredControls`**: a declared word inside a longer CAPITALISED run in the goal ("Type" in "Leave Type", "Leave" in "Sick Leave") names that longer thing; a declared compound matches on its own turn; every occurrence is judged; a lower-case goal keeps the plain match (`capitalisedRunAround`, read from casing, no word list).
- **`settleScriptDemand`** (the fallback for `skipsAuthoredScript`): each uncited script line of the demanded tier is performed — every `Field = value` pair on the line (or the Test data pair the line names) whose field a tree/probe line names becomes the entry step the tree's ROLE dictates (`entryStepFor`: textbox → fill, button/combobox → selectOption, checkbox → check, radio/option → click), cited `Step N:` and marked; a line nothing grounds becomes a `workflow` leg whose goal is the sheet's own line, marked the same way. Placed before the first body step citing a later script step, else before the first assertion.
- **`settleWorkflowGoal`** (for the weak lint, applied on acceptance — `settleViolations` now lets a weak complaint run its own settle before falling back to its note): the goal's `Field = value` pairs a tree names are split out as entry steps before the leg, and the leg is annotated. Values in prose are cut by casing (`valueHeadOf`: "Sick Leave and pick today" → "Sick Leave").
- `insertStepBefore` / `appendOrInsert` skip a case whose `steps` IS the body's array (the folded single case shares it) — found by the test, it would have inserted twice.

Tests: `tests/flow-author.test.ts` ("a script step is performed, never read as a noun, and the last word performs it (multirole ML_01_04)"): the noun rule, the workflow-leg rule, the compound rule, `settleScriptDemand` from the tree and to an agent leg, `settleWorkflowGoal`, and the pipeline shipping the ML_01_04 shape on attempt 1 of 1.

## The authored host is the deployment host (2026-09-07)

`foreignAuthoredHost` is a fatal authoring lint over setup and body steps. Every
absolute HTTP(S) URL carried by a step must use the deployment URL's exact host;
relative URLs and `{{variable}}` placeholders remain portable. The informed
re-ask names both the authored and expected hosts and says that the run's own
host is the only one this catalog may reach. This runs before route grounding:
a typo in an origin is authored evidence failure, not an application environment
error, and applies equally to `goto`, `signIn`, `request`, and any future step
that carries a string `url`. Tests: `tests/flow-author.test.ts` ("authored
absolute URLs stay on the deployment host").

## Every step in plain language (`src/generator/step-narration.ts`, 2026-09-07)

A step reads `✗ [10] selectOption (jit, 8412ms) role=combobox[name="Condition" i]  DEAD END`.
That is precise and unreadable to anyone who did not build the harness, so
`--narrate` (`WOWLIDATOR_NARRATE=on` is the same switch) has the healer-role
model write one or two plain sentences per step onto `ProofStep.narration`
before the bundle is persisted. Every surface then renders it from the bundle;
`src/reporter/` still calls no model.

Three properties are what make it safe to put model prose beside evidence, and
none of them is decoration:

- **It narrates the step's own line and is given nothing else.** The prompt
  carries `formatStepLine(step)` verbatim — the text the run log already prints
  — so a narration has no second source to contradict, and nothing reaches the
  model that the log does not already show (an account is withheld by
  `stepTarget`/`signInPersona` before it gets there; there is a test).
- **It is descriptive, never authoritative.** `applyNarration` is the whole
  trust boundary: an index the run never had is dropped, a superseded attempt is
  never narrated, an empty answer leaves the step untouched, an existing
  narration is never overwritten, and an essay is clipped. Nothing here sets a
  status, files a defect or reaches the findings signature — that signature is
  computed from typed fields precisely so one cause stays one finding whatever
  language it is worded in, and prose would split it.
- **It is attributed.** `StepNarration.by` carries the model id. `decisionFrom`
  in `engine/runner.ts` established that synthesised words must never wear the
  harness's voice; this obeys that rule by wearing the model's.

**One call per case, not one per step** (`NARRATION_BATCH`, 40): a 440-case
catalog narrating every step is 440 calls, not 4,000. **Off by default**, unlike
the error diagnosis beside it — that one fires only on a case that ended as a
system error, this one fires on every case that runs, and a suite that spends
its window on prose finishes the rest of its cases on refusals (2026-09-05, 243
cases). A missing healer key degrades silently to the step lines the report has
always shown, and `narrateBundle` never throws: a batch that fails leaves its
steps unnarrated.

`wowlidator report --narrate` back-fills finished runs from the ledgers with no
browser and no re-run, writing the narration into the proof bundle
(temp-file + rename) and re-rendering that case's HTML report from it — so a run
that was executed without the switch can be narrated afterwards, off the model
window it did not spend at the time. Tests: `tests/step-narration.test.ts`.

## A step the trees do not account for is looked up, never guessed (`src/generator/step-evidence.ts`, 2026-09-08)

`value-resolution.ts` answers *"the sheet left this VALUE as a token — what is
the value?"* from the cheapest source that can answer, and records which one
did. This is the other half of the same question: **"the sheet names a control
the captured tree does not show — does anything else state that the application
renders it?"**

Measured on be-cycle1-sit (440 rows, 2026-09-07/08). The run's authoring log
holds **507** `the review could not ground it either` lines, and their reasons
are one shape: *"the กฎเงื่อนไขสิทธิ์ page's accessibility tree was never
captured, so there is no tree evidence for a button named 'ส่งออก CSV'"* —
pages reached only through a `workflow` leg, an upload wizard, or a route the
journey capture ranked past. Twice in the same run the review answered `keep`
instead, quoting `messages/th.json` (RU_06_13, RU_06_10): the repository had
declared the string all along, and an `agent` call was spent discovering what a
string comparison settles for nothing. Of the 25 rows the run could not write,
eight were `unperformedScriptSteps` and the missing line was always the leg on
that uncaptured page.

The chain is the EVIDENCE, not the model — but unlike the PY-1 capture case
(2026-09-04), the evidence existed and was never consulted: the prompt's
repository slice is ranked against the row's words and capped at
`DEFAULT_CONTEXT_MAX_NODES`, so it is chosen *before* anyone knows which
controls the model will name. So the stage is keyed on the STEP's own name,
sited exactly where value resolution is — after the model, before the lints:

- **The repository** (`fromRepository`, $0, no model). Every quoted string of a
  `message` or `component` node's own detail, from the WHOLE index
  (`declaredStringsOf`, built once per run by `declaredRenderings` in
  `commands/authoring.ts`, never sent to a prompt), plus the row's own slice.
  An EXACT fold-match is grounding; a longer declaration that merely contains
  the name is an evidence line only — the run must match an accessible name
  whole. This is the grounding order the prompt already states (tree, then
  repository, then a workflow leg) and the source `ungroundedTextExpectation`
  has accepted since 2026-08-28; what is new is that it is searched per step.
- **The database** (`fromDatabase`), read-only, under `value-resolution`'s own
  rails — the resolver's client and its `chooseDbLookup` question, every
  identifier checked against the introspected schema before it reaches SQL, one
  `SELECT count(*)`, `MAX_DB_LOOKUPS` (2) per row. Only `count > 0` answers,
  and it answers exactly `ungroundedFixtureAssertion`'s doubt: that lint exists
  because thirteen be100 cases asserted records the database never held, so a
  fixture the data DOES hold is not a fixture it can doubt. A count of zero —
  the shape of the `BE-XXX-999` mask the sheet writes for a value that must NOT
  exist — leaves the refusal exactly where it was.
- **The documents are deliberately NOT a source for a control.** A requirement
  document's wording is what the tree's rendering is checked against, not a
  substitute for it; the same run's own refusal of RU_09_03 (*"that is the
  requirement document's wording, and the step will dead-end on every run"*) is
  the rule this stage must not undo. Documents stay where they already ground
  things: values (`fromRepo`) and paths (`applyReview`).

What it may touch, and the asymmetry that keeps it honest:

- **It may excuse a claim, never accuse one.** The lines it finds go to the
  checks that read a declared string as GROUNDING — `ungroundedTextExpectation`
  and `wordingClaimAssertsDataValue` (`groundingEvidence`) — and never to
  `workflowOverDeclaredControls`, which reads one as a PROHIBITION on an agent
  leg (`codeEvidence`). A lookup meant to ground a step must not become a new
  way to refuse it.
- **The $0 audit stops paying for what the index already says.**
  `ReviewEvidence.declaredControls` carries the names matched EXACTLY, and
  `auditGrounding` treats a selector on one as grounded; `declaredEvidence`
  puts the lines in the reviewer's own evidence so a decision it does make can
  quote one. Nothing here is a model's word for it — the match is a string
  comparison the harness performed. Roles are untouched:
  `ungroundedSelectorRole` stays tree-only, because the index says what the app
  renders, not what role it renders it as.
- **Provenance travels on the step**, the value resolver's shape: the intent
  ends `[evidence: repository — messages/th.json declares "ส่งออก CSV"]`, the
  flow's `notes` carry the summary, the log prints one line per lookup. No
  `FlowStep` field was added — an intent suffix is what every report already
  renders, and `unperformedScriptSteps` / `expectedItemsIn` read the intent's
  HEAD.
- **Silence declines.** No tree, or a truncated one, and the stage returns
  nothing — the rule every grounding lint follows. `expectHidden` and a zero
  `expectCount` are exempt: asserting that something is not rendered needs no
  rendering. Never fatal: a source that throws is a source that did not answer,
  and the refusal that follows is the one this had before.

**And the script steps the flow never reached are now performed, not merely
noted** (`settleUnperformedScript`). `unperformedScriptSteps` was fatal with a
`settle` that wrote a note — while the machinery to perform an uncovered script
line from evidence already existed for `skipsAuthoredScript`
(`settleScriptDemand`) and was simply not wired to it. At the last word only,
each missing numbered line in script order: every `Field = value` pair on it
(or the Test data pair whose key it names) whose field a captured tree names
becomes the entry step that tree line's ROLE dictates; a line nothing grounds
becomes ONE `workflow` leg carrying the sheet's own words, inserted before the
first step citing a later script step — else before the flow's first assertion,
so the action precedes the check. Two limits are the whole safety of it:
**only a line that asks the tester to ACT** (`scriptDemand`, any tier) is
performed — `8. ตรวจสอบ Employee Profile ใน EC` is an assertion the flow
omitted, and performing it as an agent leg would make the agent the witness for
its own claim — and `MAX_SETTLED_SCRIPT_LEGS` (3) bounds the delegation, the
rest being named as not covered. It **never returns null**: a settlement that
can insert nothing returns exactly the note this used to return, so no row that
was handed over before is refused because of this. `import` / `นำเข้า` joined
`authoring.script.acting` in `value-rules.ts` beside `upload`/`อัปโหลด` — the
live rows' own verb, in both of the sheets' languages.

Why none of it can make a result worse: the lookup adds evidence and never a
step, a claim or an assertion; a name nothing declares is reported `unanswered`
and the lint refuses it as before; the audit stand-down replaces an `unsure`
the review was already returning for free; the fixture filter drops a fact only
when the database states the row exists; the settlement inserts preparation the
sheet itself scripts, into flows that were being BLOCKED outright, and cannot
reduce `substantiveAssertions` — so a vacuous flow cannot be made out of a
proving one.

Two pure readers moved to the new module so there is one definition of each
beside the lookup that uses them — `selectorsOf` and `declaredControlStrings`,
both re-exported from `flow-author.ts`, so every caller and test keeps its
import. Verified offline against the live rows through the modules themselves
(no catalog command, a run was in flight): RU_10_11's `ส่งออก CSV` grounded
from a message node with the audit's finding going 1 → 0, RU_09_54's step 2
performed as a leg before its assertion, a `ตรวจสอบ` line left as not covered,
a mask answering nothing, and no tree answering nothing. Tests:
`tests/step-evidence.test.ts` (21, the module), `tests/flow-author.test.ts`
("a step the trees do not account for is looked up, never guessed", "the script
steps the flow never reached are performed, not merely noted"),
`tests/flow-review.test.ts` (the audit's declared-control rule, and the
either/or alternative judged on its own).

## A thin claim is looked up before it is merely noted (`src/generator/concretise.ts`, 2026-09-09)

A `weak` refusal is handed over with a note and nothing else, and the comment
in `#authorWithRetries` says why: the re-ask used to run for weak violations
too and **bought nothing measurable** — the model was told its leg was
unchecked, came back with the same leg because it could not see the page, and
the weak result was accepted anyway two calls and a minute later. That
reasoning is about a **re-ask**, and it still holds. What it never covered is
the case where a NEW FACT exists and nobody looked it up.

Measured on be-high-en (2026-09-09, the 15 High rows of be-cycle1-sit): **12 of
15 flows carried `the sheet's Destination (…/humi/en/login) is not followed`**,
every one of them navigating perfectly well. The chain:

- The sheet's Steps column opens EVERY row with the same preamble — *QA default
  locale = en; เริ่มที่ https://…/humi/en/login และใช้ /humi/en/ สำหรับทุก route* —
  and states the case's real page on the next line as a **bare path**,
  `0. Route อ้างอิง /humi/en/admin/benefits/plans`.
- `destinationOf` (`catalog/test-case-table.ts`) takes the FIRST url in Steps.
  `URL_RE` needs a scheme, so the bare path cannot match and the login URL
  always wins: every row in the workbook records the sign-in page as its
  `Destination`.
- `ignoresMenuPath` then reports, truly and uselessly, that the body never
  navigates there — and its remedy is *"After the sign-in, goto that URL"*,
  which no correct flow can perform. Two rows (PL_07_02, PL_08_01) crossed the
  refusal threshold when a second, genuine complaint joined it and burned all
  three attempts producing variants that tripped the same lint.

So a weak complaint may now carry a **`concretise`** hook beside `settle`, run
in the accept path before the notes are composed. It is handed
`ConcreteEvidence`, assembled from what the run **already knows** at that point
— no query, no model, no I/O:

- `routes` — `FlowAuthor`'s `#declaredRoutes`, the indexed repository's route
  patterns;
- `existingFixtures` — `StepEvidenceOutcome.existingFixtures`, which
  `step-evidence.ts` has already resolved from the read-only database **before
  any lint ran**. There is deliberately no second database path here: a lookup
  this module performed itself would be `fromDatabase` written twice.

Three rules, and each is load-bearing:

- **It may make an existing claim concrete; it may never add one.** Naming a
  route, inserting the navigation that reaches it, or scoping a step to the row
  the case is about are things the sheet already asked for. An `expect*` the
  sheet never wrote would be an expected result nobody specified — what the
  whole claim-fidelity family exists to prevent. Navigation and scoping only.
  The guard is the contract in `concretise.ts` and the shape of the code, not a
  mechanical assertion count (a deliberate choice, 2026-09-09); a future
  concretiser that adds an assertion would break it silently, so read the
  contract before writing one.
- **Evidence may excuse a claim, never accuse one** — `step-evidence.ts`'s own
  asymmetry, applied again. Nothing here can raise a refusal or change a
  severity; a concretiser that finds nothing returns null and the lint's note
  stands exactly as written.
- **Travelling counts, not just `goto`.** A menu case is explicitly told NOT to
  jump by URL (*ไม่เปิด URL ข้าม assertion*) and reaches its page by clicking
  crumbs. `flowTravels` counts a `click` and a `workflow` leg, so a correctly
  authored menu case is `honoured` rather than having a `goto` spliced into it
  — which would destroy the very thing that case tests.

`concretiseRoute` is the one wired concretiser and returns a pure decision the
caller performs: `honoured` (the case's real page is declared and the flow
reaches it — the note becomes the fact, and the 12 false positives go quiet),
`navigate` (declared, and the flow reaches no page at all — a `goto` is
inserted through `insertStepBefore`, marked `[generated: …]`), or `null` (the
repository declares none of the paths the case names — silence declines, the
rule every grounding lint here follows).

**The root cause was fixed the same day** — see the section below. This layer
stays: it is the general mechanism for sharpening a thin claim from evidence,
and the route half now fires only where the extractor legitimately has no URL.

Tests: `tests/concretise.test.ts` (13, unit tier, every case quoting the live
sheet's preamble).

## A sign-in URL is never a destination (`catalog/test-case-table.ts`, 2026-09-09)

The extractor half of the section above, fixed at the root after the
be-high-sonnet run measured what it costs.

`destinationOf` took the FIRST absolute URL in Steps, then in Menu. The live
sheet opens **every** row's Steps column with the same preamble — *QA default
locale = en; เริ่มที่ https://…/humi/en/login และใช้ /humi/en/ สำหรับทุก route* —
and writes the case's real page on the next line as a **bare path**
(`0. Route อ้างอิง /humi/en/admin/benefits/plans`), which carries no scheme and
so cannot match. Every one of the workbook's 429 rows therefore recorded the
sign-in page as its destination.

Measured on the 15 High rows (2026-09-09, sonnet-low authoring): **14 of ~30
authoring complaints** were `ignoresMenuPath` reporting, truly and uselessly,
that the flow never navigates to the sign-in page — with a remedy ("after the
sign-in, goto that URL") that no correct flow can perform, so the model burned
its whole budget producing variants that tripped the same lint. It induced the
**seven `loginProofAssertsLoginPage` refusals** beside it, too: told its
destination was `/humi/en/login`, the model proved the login by expecting the
URL to contain `/humi/en` — which the login page already satisfies, so the
assertion holds precisely when the sign-in did NOT take.

`statedDestinationUrl` is now the reader, and the rule is absolute: **a sign-in
URL is never a destination.** Not deprioritised — never. Signing in is what
setup does, and `ignoresMenuPath` judges the BODY alone, so a login destination
can only ever be a complaint no flow can answer, even on a row that genuinely
is about signing in. A row naming a real page anywhere in Steps or Menu still
gets it, wherever in the cell it appears; a row naming only sign-in surfaces
answers null, and `CaseDestination` still carries the tab and the menu path, so
`describeCase` renders `Destination: (the menu path above)` and the flow is
judged against the crumbs — which is what these sheets intend, since they also
say *ไม่เปิด URL ข้าม assertion*.

`LOGIN_URL_PATTERN` moved from `flow-author.ts` to `value-rules.ts` — the leaf
module the catalog parser already imports, the precedent set when the authoring
vocabulary became data — and is re-exported from `flow-author.ts`, so every
caller and test keeps its import. `concretise.ts`'s own `ENTRY_PATH` was
deleted in favour of it: that constant's comment says two spellings of "is this
a login URL" would drift, and a looser one had already misread a payroll app's
`/admin/config/sso` once (PY-1 TC_SSO_001_001).

Why it cannot make a result worse: the reader only ever declines to name a
destination it used to name wrongly, and declining routes the judgement to the
menu path the same row already carries. Nothing gains a destination it did not
have. Tests: `tests/sheet-grammar.test.ts` ("a sign-in URL is never a
destination"), including the `sso` case that must NOT be read as sign-in.

## Three date-grammar gaps the second pass left (2026-09-09)

`tests/value-resolution.test.ts`'s "the date grammar the second pass needed"
had been red, and because `node:test` stops a test at its first failed
assertion, one visible failure was hiding three independent gaps. Each is fixed
structurally — the sheets' words stay data in `value-rules.ts`, and no phrase is
special-cased.

- **A relation may be preceded by the word for "date".** `ก่อน Hire Date 1 ปี`
  and `วันก่อน Hire Date 1 ปี` both resolved; `วันที่ก่อน Hire Date 1 ปี`
  resolved to nothing, because `before` listed `วันก่อน` and `ก่อน` but not the
  third compound — the same enumeration that had already forced `วันที่ตั้งแต่`
  into `prefixes` beside `ตั้งแต่`. `dates.dateNouns` (`วันที่`, `วัน`, `date`)
  is now its own list and compiles as an OPTIONAL prefix on the `before` /
  `after` matchers and on the phrase-shape probe. It consumes nothing alone —
  a relation WORD must follow — so `วันที่ 20`, a bare day, parses exactly as
  before. Pairs no longer multiply: any relation word gains the compound free.
- **The amount may be written on either side of the relation.** English fronts
  it (`2 weeks after Hire Date`), Thai trails it (`ก่อน Hire Date 1 ปี`), and
  only the trailing order parsed — every fronted phrase was null. A leading
  `<n> <unit>` is now consumed before the relation, but only when a relation
  word actually follows (a lookahead leaves the word for the matcher below), so
  a phrase that merely opens with a quantity — `3 วันก่อน`, an offset in its own
  right — is untouched.
- **A sign glued to a word is part of the word, not an operator.** The
  remark-set-aside branch refused any trailing text matching `/[+\-−]\s*\d/`,
  unanchored — so the `-41` inside the case id `E2E-41` read as "minus 41
  days" and `14 เมษายน รันคู่กับ E2E-41` returned null instead of 14 April with
  the remark set aside. The guard now requires the sign to open the remark or
  follow a space. This is the rule `relationWord` already applies to `<` (a
  symbol relation must be followed by a space, so `<runtime>` is never a date),
  applied to the other end of the same problem.

Why none can make a result worse: each widens what parses and narrows nothing.
A phrase that resolved before resolves to the same date — the optional noun and
the leading amount are both gated on a relation word that must still be there,
and the guard change only stops a false positive inside a token. Tests:
`tests/value-resolution.test.ts` (57, all green; the suite had been 56/57).

## A tooltip is in no tree, and a confession is evidence (2026-09-09, be-high-sonnet PL_07_01 / RU_06_01)

One 14-row slice carried the same Expected line six times — `2.1 แสดง Tooltip
ข้อความ "Make Correction" เมื่อนำเมาส์ไปวาง` — and four lanes authored four
different things for it: `expectAttribute role=button[name="Insert" i] title=
"Insert"` (RU_07_01, passed, the grounded shape); `expectVisible role=button
[name="Delete" i]` (RU_08_01, passed); `expectVisible text="Make Correction"`
(RU_06_01, failed, healed to `>> visible=true >> nth=0`, then **passed against
`span "Make Correction" · 110×23 at (549,100)` — the breadcrumb**, a green
about a tooltip nobody hovered; `[c9] text=Create` did the same against `span
"Create Plan"`); and `expectVisible role=tooltip[name="Make Correction" i]`
(PL_07_01, 5 attempts × 5000 ms, three times, `dead-end`, filed against the
application). The preceding agent leg had hovered successfully — the proof
bundle's step 5 records `hover role=button[name="Make Correction" i] >> nth=0
— ok` — so the app exposes no `tooltip` role at all.

**No grounding lint spoke on any of them, and two separate guards were why.**
`ungroundedSelectorRole` bails on line one when the tree carries `TREE
TRUNCATED` (the journey capture of the plans table blew the 200-node budget)
and bails again at a `workflow` step — and journey capture puts a leg at index
0 of every row whose destination is not the start page, so 9 of 14 flows in
this run had a leg and 3 were unjudged from step 0. Three changes, and one the
evidence talked me out of:

- **`ungroundedSelectorRole` has two tiers, because silence and contradiction
  are different evidence.** SILENCE — the role is in no tree line — is still
  judged only on a COMPLETE tree with no leg before the step: past the node
  budget or past a leg, a missing role may be perfectly real. CONTRADICTION —
  a tree line renders this very accessible NAME under a DIFFERENT role — is
  judged always. That line is positive evidence in hand: it says what the
  thing called "Make Correction" IS on the page the capture read. Truncation
  cannot take a line away and a leg does not unwrite one. The contradicting
  line is now returned FIRST in `nearest`, which is what `settleSelectorRole`
  needs to repoint from, so the last word is `role=button[name="Make
  Correction" i]` rather than a blocked row. The disabled tier keeps both of
  its original guards: "disabled at rest" is a fact about the captured page,
  and past a leg the flow is no longer on it.
- **`admitsUngroundedSelector` (fatal, settles by annotating).** Twice in one
  run the model wrote its own verdict into the step's intent — *"not confirmed
  by any captured tree so this is best-effort"* (PL_07_01), *"not captured in
  the tree; selector guessed from the case wording"* (PL_06_01, three steps) —
  and the harness shipped the step because no rule read the intent. A
  confession is the cheapest evidence there is: no tree, no lookup, no model
  call. Two structural exclusions: a `workflow` step (its goal is the shape
  the other refusals steer TO), and everything past the `[generated:` marker
  (this file's own settles write "no captured tree names its control" as a
  disclosure of a rewrite already made — reading that back as the model's
  confession would refuse the harness's own honesty; the PL_06_01 flow has
  both shapes, one step apart, and the lint separates them). Every admission
  word names the EVIDENCE or the guess about a selector: a bare hedge was
  tried and removed the same hour, having over-fired on RU_06_12's *"Line 3.1
  (best-effort, blocked): … exact quoted values cannot be asserted because …"*
  — an honest note about a value the sheet leaves unavailable, on a selector
  the tree does render.
- **`unanchoredHoverAssertion` (fatal, settles by anchoring).** The case's own
  words claim a hover surface, the assertion's selector head names no role,
  and a captured tree renders that very text as some control's accessible
  NAME: refused, and the last word rewrites `text="Make Correction"` to
  `role=button[name="Make Correction" i]`, keeping any `>> nth=0` tail. A
  roleless `text=` matches every node holding those words; the anchored form
  only the nodes of that role, so the rewrite is strictly narrower and can
  cost the flow no claim it had. Where no tree line renders the text there is
  nothing to point at and the step is left alone — absence is
  `ungroundedTextExpectation`'s business, with its sheet-verbatim exemption.
- **A `<claims>` rule states the shape once**: a tooltip is in NO tree —
  nothing hovers while the page is read — so on the page at rest its words are
  the accessible NAME of the control that shows it; assert that control by the
  role and name the tree gives it, or `expectAttribute` the same control with
  `"name": "title"` (else `aria-label`) where the app carries it there. Never
  a bare `text="X"`. The words are data (`value-rules.ts`,
  `authoring.hoverClaim` / `authoring.admission`); the structure is in the
  lints.

**What the evidence talked me out of:** making the `workflow` bail-out a
`continue` in `ungroundedOnTruncatedTree` and `ungroundedTextExpectation` too.
Both judge only ABSENCE, and past a leg the captured part does not describe the
page at all. Measured on PL_07_01's own body with that change in place:
`expectVisible role=button[name="Cancel" i]` — a control of the make-correction
page, which the after-click capture holds and the narrowing had cut — was
flagged and would have been demoted to an agent leg, which is precisely what
the truncated-tree lint's own never-the-last-proof guard exists to prevent.
They keep the stop; what speaks past a leg is positive evidence, and a name has
no contradiction tier. The gap that remains is real: a step after a leg, on a
page the JOURNEY capture did read, is judged by nothing — the harness cannot
tell which of the captured pages a given step is on. Naming that would need
page tracking through the flow, not a wider lint.

**Not fixable here:** `hover` is an AGENT action (`workflow-agent.ts`), not an
engine one — there is no `hover` in `FlowStep`, and the `script: [{action:
"hover", …}]` visible in PL_07_01's flow file was written back after the run by
the flow-file script rung (`scriptOf`), not authored. So the authoring plane
cannot write "hover C, then assert"; the strongest grounded shape it has is
the control's own name plus `expectAttribute`. RU_07_01's model said so itself
— *"no hover action available; asserted via title"*. An engine `hover` action
is `engine-expert`'s to add if the claim is judged worth it.

Tests: `tests/flow-author.test.ts` — "the two tiers: silence needs a complete
tree, contradiction never does" (PL_07_01's exact body as the fixture),
"admitsUngroundedSelector (the author's own confession)",
"unanchoredHoverAssertion (a hover claim proved by a roleless presence check)",
"a hedge about the VALUE is not a confession about the selector". Verified
offline by running the three lints over all 14 flow files of the live run
against its own trees: exactly the five wrong flows are refused (PL_06_01,
PL_07_01, PL_09_01, RU_06_01, RU_08_01) and the nine others, RU_07_01's
`expectAttribute … title` among them, are untouched.

## The record is identified before its fields are, and a repeated control is one of many (2026-09-10, be-sit-high PL_07_02 / RU_06_12)

Run `be-sit-high-20260909-170213`, 15 rows of a Thai/English sheet against HUMI
SIT: 5 passed, 6 failed, 3 needs-review, 1 blocked, and its own truth table
scored **TP 0 · FP 3**. Of ~40 defects filed, ~34 describe the harness or the
sheet. Three authoring causes, and only two of them earned a rail.

**PL_07_02 alone filed 16 defects against a working application.** Its job is
to open the Make Correction form for the plan the sheet names and check every
field against that plan's data. What was authored opens
`role=button[name="Make Correction" i] >> nth=0` — **whatever sits in row
zero**; the proof bundle shows every step running on
`.../make-correction?planId=319` — and then asserts eighteen plan-specific
values. Country and Status passed (the same for every plan); twelve failed, each
a `high` or `medium` defect about a page displaying plan 319 perfectly
correctly.

What made it undetectable is the second half, and it is this module's own doing.
The sheet's line 3.3 is *Benefit Plan ID แสดง "PL_07_01_02_03_04_05_06"* — the
identity of the record every other line is about — and it was authored
`expectVisible role=textbox[name="Benefit Plan ID" i]`, a presence check that
passes whatever the field holds. The model said why in the step's own intent:
*"the sheet's id … is fixture data this flow does not create, so only the
field's presence is asserted"*. **Two lints were pulling opposite ways on one
line**: `unassertedExpectedItems` demands an assertion for 3.3, and
`ungroundedFixtureAssertion` refuses the only assertion that makes it — so the
one shape both accept is the vacuous one. Verified on the live flow: with the
settle applied, the old lint returns `{fact: PL_07_01_02_03_04_05_06, action:
expectValue}` and the new one returns null.

- **`presenceForStatedValue`** (fatal, settles). An Expected line that STATES a
  value — the sheet's own `<control> … "<value>"` grammar, read by
  `statedValuesIn` — proved by an `expectVisible`/`expectEnabled`/
  `expectDisabled` that cites that line and names that control, where the value
  appears in no step of the flow. The prompt's `<claims>` first bullet has
  always said *"a visibility check of the field is the claim going untested"*;
  this is the guarantee for the rule the prompt already states. The last word
  (`settleStatedValue`, up to `MAX_SETTLED_STATED_VALUES`) sharpens the step it
  already has — `expectValue` for a textbox, `expectText` for a trigger the
  tree lists as a button — keeping its selector and its cited line, so a row is
  never blocked over it.
- **`ungroundedFixtureAssertion` takes the case's stated pairs.** Reading a
  record's identity off the record's OWN field is the flow's SCOPE, not a claim
  that the record exists in a listing. Exempt only where the case itself pairs
  that value with that control's label, and only as `expectValue`/`expectText`
  on a value-holding role; a DB where-clause, an exact count, a row click
  scoped by the fact and a `text=` presence are the be100 shapes the lint was
  written for and stay judged. Exempted, PL_07_02 fails at line 3.3 with one
  TRUE finding — the record on screen is not the one the sheet names — instead
  of twelve false ones behind a pass.
- **The pairing is folded EQUAL, never overlapping.** The label is the words
  the Expected clause OPENS with (`Benefit Plan ID แสดง`), every prefix offered
  and the author's own selector picking; `squash` already drops the decoration
  an application adds (`Country*`). Containment was tried and removed the same
  hour: the single prefix "Benefit" matched a control named "Benefit Name", and
  a control name found mid-sentence ("…Entitlement Amount History สอดคล้อง…"
  against "History Sidebar", RU_06_16) is a coincidence, not a pairing. A
  quoted value carrying an ellipsis is the sheet showing a SHAPE and states
  nothing (RU_06_16 again).

**The settle is deliberately strict, and that is the one path that can still
block a row.** `valueAssertionFor` — the single definition the refusal's
wording and `settleStatedValue` both read — answers `expectValue` for a
textbox/searchbox/spinbutton and `expectText` for a button/combobox/listbox/
link/heading/cell, and null for anything else; a cited step naming a landmark
or region therefore refuses with no rewrite, and one unsettled fatal keeps the
whole refusal. An any-role `expectText` fallback was considered and **rejected**
(2026-09-10): the engine reads `innerText`, so an `expectText` on a container
passes whenever the value appears anywhere inside it — the RU_06_01 shape, a
roleless presence check that healed to `>> visible=true >> nth=0` and passed
green against the breadcrumb — which trades a blocked row for a false pass, and
premise 3 says the refusal is the right answer then. What bounds the cost is
the informed re-ask plus `AUTHORING_REFUSAL_CAP` (2), and the refusal's own
wording for that shape names the remedy rather than the fault: it says the
cited role holds no value of its own and that the assertion belongs on the
control the Expected line names, never on the region containing it. A row still
blocked after two asks cited a stated-value line against a landmark twice, and
is worth a person's eyes. Not seen in the 15 live flows; reachable.

**`ambiguousRepeatedControl`** (fatal, settles) is RC-3: one application, one
table, one control, authored two ways. PL_07_01/PL_07_02/RU_07_01 wrote
`>> nth=0` and resolved; RU_06_12 and RU_06_16 wrote the same selector bare and
Playwright refused it — *strict mode violation: … resolved to 25 elements* — so
both dead-ended and filed three defects each about a table having rows. A
control in a repeated row is ambiguous BY CONSTRUCTION and the tree says so:
twenty-five lines, one accessible name. That is **positive evidence**, so —
`ungroundedSelectorRole`'s contradiction tier's own rule — it is judged on a
truncated tree and past a `workflow` leg alike. Three limits are the safety of
it: `ONE_ELEMENT_ACTIONS` only (everything that acts, plus the value reads;
`expectCount`/`expectVisible`/`expectHidden` are exempt because "one of these
is on the page" is satisfied by any match, and the ladder's rungs 1.3/1.35/1.36
exist for those); a selector the author already narrowed is not judged; and
`treeSections` counts within ONE capture, splitting on the harness's own
section markers, because the evidence concatenates three pages and one
`button "Cancel"` on each is not an ambiguous trio. The message names
row-scoping and searching FIRST and `>> nth=0` last — `nth=0` is the minimum
fix for ambiguity and the wrong answer when the row's identity matters, which
is `presenceForStatedValue`'s question — and `settleRepeatedControl` marks that
which row it opens is not established.

**Two smaller things, and three deliberately not fixed.**

- **`guessed accessible name` joined `authoring.admission`** in
  `value-rules.ts`. PL_06_01's step 12 intent reads *"the close (X) control at
  the top right; guessed accessible name "Close""* — the author knew it was
  guessing, wrote it down where a person reads it, and the step shipped and
  failed, because the list held `selector guessed`/`guessed from` and not this
  spelling. Data only; measured on the run's own flows, it now fires on
  PL_06_01 and on nothing else.
- **The journey capture says which surface the click opened**
  (`journeySection`/`captureAfterOpening` in `cli/commands/authoring.ts`). The
  header read *"the dialog, form or wizard step the row's fields live in"*
  whatever had happened — so RU_06_01, whose sheet says *แสดงป็อปอัพ* (shows a
  popup), authored `expectModal` against an application that had just
  NAVIGATED, and the step could only fail. The capture already compares the URL
  before and after its own click; `opened.navigated` now carries the answer and
  the header states it ("the click NAVIGATED: this is a PAGE, not a dialog,
  whatever the row's own wording calls it"). The PY-1 precedent applies
  unchanged — the fix is where the evidence is made. **No lint**: refusing an
  `expectModal` needs a rewrite target the evidence may not hold, and blocking
  a row over a claim the run settles in two seconds is the worse trade.
- **`expectAttribute @required` is the ENGINE's** (PL_06_05, routed). The flow
  asserted the HTML `required` attribute; the application marks it
  `aria-required="true"`, so the step failed — and the harness's own sighted
  agent look returned `proved` with the explanation, then the rail re-ran the
  author's own comparison and failed anyway. There is no legal shape to steer
  to: CDP's own `required` property (`propertyFlag(node, 'required')`, printed
  on the tree line the author read) unifies both spellings, so the author
  cannot know which the app uses, and an authoring lint would refuse a true
  claim with nowhere to send it. The fix is one place in
  `runner.ts:expectAttribute` — answer the ARIA-state names (`required`,
  `disabled`, `checked`, `readonly`, `selected`, `expanded`) from the
  accessibility property, which is the evidence the author was shown.
- **Not fixed, and why**: RU_06_12's `role=complementary[name="History
  Sidebar" i]` is silenced by a truncated tree, and that guard stays — absence
  of evidence past the node budget is not evidence of absence. PL_06_05's
  workflow leg for a field the screen does not have, and RU_08_01's "Confirm
  delete plan" on a rule case, are the sheet's to fix; a lint that reads a live
  dialog's title back against the sheet would be judging the sheet by the
  application, which is the case's own verdict to reach.

**A cascade this does not stop, and whose it is.** With line 3.3 asserted as a
value, PL_07_02 fails at its third assertion with the true cause named — and
the twenty steps after it still run and still fail, because nothing suppresses
the tail of a failed VALUE assertion the way `dependentTail` suppresses the tail
of a failed `workflow` leg. Making the first true finding the only one is the
engine's and the reporter's, not this module's.

Measured offline through the modules on all 15 flow files of the live run
against their own case texts (`parseTestCaseTable` → `describeCase`, no browser,
no model): `presenceForStatedValue` fires on **exactly one** step —
PL_07_02's step 5, line 3.3 — and `admitsUngroundedSelector` on exactly one
more, PL_06_01's step 12; the five passing flows and the other eight are
untouched. Tests: `tests/flow-author.test.ts`
(`ambiguousRepeatedControl` — the count, the truncation/leg tiers, the
per-capture counting, the exempt shapes, the settle; `presenceForStatedValue` —
`statedValuesIn`'s pairs, the live PL_07_02 body, both settle roles, the five
silences, the ellipsis and mid-clause cases; and the fixture lint's pairing,
with the three shapes it must still refuse), `tests/cli-wave2.test.ts` and
`tests/flow-author.test.ts`'s `journeyTreeSection` fixtures for the new field.

## The sign-in page going away is never a login proof (2026-09-10, be-sit-high-20260909-170213)

**Incident.** HUMI SIT lands a SUCCESSFUL local sign-in back on its sign-in
page: click Sign in → `POST /api/auth/local-login` 200 with the session cookie
set → `/en` → `/en/me/home` → the client navigates to `/en/login` and re-mounts
the form with empty fields and the Sign in button showing. The session is
valid — the flow's next `goto` to `/en/admin/benefits/plans` renders signed in
(Account menu, heading "Benefit Plans") — and the landing is intended by the
app team. Every authored flow in the run proved the sign-in with `expectHidden`
of the submit control: authored by the model (`{"action":"expectHidden",
"selector":"role=button[name=\"Sign in\"] >> nth=1","intent":"Prove the
sign-in succeeded."}`) or written by `groundLoginProof` in place of a vacuous
`expectUrl`. That claim is false on this application by design: four cases
failed on it, and the in-run reconstruction then re-clicked Sign in on empty
fields ("Please fill out this field").

**Rule.** A login proof is a positive claim about a signed-in surface, and it
belongs on the page the flow goes to NEXT — a control only a signed-in page
shows (the account menu, the greeting, the page heading), quoted from a tree.
Nothing on the sign-in page after the submit is a proof: not the submit control
disappearing, not the URL leaving the sign-in path. The engine, not the flow,
judges the session — a `goto` to a protected page that bounces to a sign-in URL
stops the run with the stranded verdict (`#strandedMessage`) — so dropping a
submit-control proof cannot reduce what the flow proves, and a drop that leaves
nothing is refused through the ordinary no-assertion rail, never patched with
an invented assertion. What changed, all in `flow-author.ts`:

- **`groundLoginProof` drops, never rewrites.** Its `replaceWith` (the
  `expectHidden`-of-the-submit rewrite) is gone. Three shapes after a
  credential submit, to the next `goto`, each dropped with its own disclosure
  on `notes` and the log: a vacuous `expectUrl` the sign-in URL contains
  (*"dropped: the sign-in is proved by the flow's assertions on the next
  page"*, or *"…already proved by the assertion before it"* when a sound proof
  stands); an `expectHidden` whose selector is the submit control the flow
  clicked (`controlKey` folds `>> nth=N`, the ` i` flag, case and whitespace);
  and a quoted-text proof (`expectVisible`/`expectText`) that no tree and not
  the request shows. The scan now collects every drop in one pass rather than
  returning at the first, so the be-high-sonnet-all shape (a real proof at
  step 4 and a vacuous one at step 5) is settled in one call. An `expectHidden`
  of any OTHER control is a claim and stays.
- **The no-assertion / vacuity rail runs again after the drop**, once
  (`provesNothing` in `FlowAuthor.author`; a flow already refused as written is
  not refused twice for the same emptiness).
- **`unsynchronizedLoginSubmit` accepts the proof on the next page.** It used
  to refuse any credential click followed by a `goto` — the exact shape the
  rule now asks for — with a remedy ("add an expectUrl … or expectVisible …
  between the click and the goto") that no flow on this app can perform. It
  now refuses only a submit → `goto` whose page nothing asserts before the
  next `goto`/`signIn`/`workflow` (`assertsBeforeNextNavigation`); a check
  between the click and the goto still satisfies it. The hydration race it
  was written for is handled at the click itself by the engine's replay
  (`nativeFormResubmitDetected` / `fillsLostToHydration` run inside the
  click's own step), so no authoring-side assertion was ever what caught it.
- **The three "means to succeed" gates read the flow's continuation, not the
  proof.** `groundCredentialValues` (the invented-password fix, 19 of 107
  be100 flows), `groundPersonaSignIns` (the `signIn`-by-label rewrite) and
  `handTypedPersonaSignIn` all gated on `expectHidden` in the block — with the
  proof no longer authored, all three would have gone silent and an invented
  password would have reached the browser. `signInMeansToSucceed` is the one
  predicate: the legacy `expectHidden` still counts (flows on disk), else the
  block or the step ending it travels on as a signed-in person — a `goto` to a
  non-sign-in URL, a `signIn` hand-off, a `workflow` leg, a click on a
  `role=link`. A negative sign-in (wrong password, error asserted, flow ends
  or returns to the sign-in page) is left exactly as written, as before. A
  link click also ends `groundPersonaSignIns`'s block now, so the flow's own
  travel is never swallowed into the `signIn` it replaces.
- **The prompt** (`<sign_in>` steps 4–5, `<final_check>`) and the three
  refusal messages say the same rule: assert nothing on the sign-in page after
  the click; prove the sign-in on the next page with a control only a
  signed-in page shows; never that the sign-in button is hidden or that the
  URL left the sign-in page. The SIGN-IN LANDING line stays as evidence for a
  `goto`, not a claim.

**Why it cannot make a result worse.** Every drop removes a claim that holds
on a failed sign-in or is false on a successful one; the positive proof on the
next page is untouched (test (b)); a flow left with no assertion is refused as
the no-assertion rail always refused it (test in "groundLoginProof"); the
relaxed lint refuses only what asserts nothing anywhere; and the intent gates
fire on strictly more flows than before (the legacy proof plus the
continuation), never fewer for a flow that meant to sign in. Not this
module's: whether the engine's `goto` should settle an in-flight login request
before navigating (the click's own step ends when the click lands, not when
the POST returns), and the engine's own `signInDidNotTakeMessage`, whose
remedy still says "assert something only a signed-in page shows immediately
after the submit click" — both `engine-expert`'s, a sibling change in flight
the same day. `vacuous.ts`'s `isLoginProof` keeps excluding the old shape
from `substantiveAssertions`, for flows on disk. `docs/artifacts/
flow-author_original.ts` is untouched.

Tests: `tests/flow-author.test.ts` — "the repair reaches as far as the lint"
((a) the vacuous `expectUrl` dropped with nothing inserted, (b) the incident's
own `expectHidden … >> nth=1` dropped with the next page's proof kept, an
`expectHidden` of another control kept), "groundLoginProof" ((d) the quoted
proof dropped, the no-assertion refusal through the pipeline, (c) a flow whose
only proof is `expectVisible role=button[name="Account menu" i]` after its
goto refused by nothing), "unsynchronizedLoginSubmit" (the next-page proof
satisfies it, a second navigation before any assertion does not, the re-ask's
wording), "groundCredentialValues" (the intent read off a goto, a link, and a
return to the sign-in page); `tests/author-wave2.test.ts`'s hand-typed persona
fixture now travels after its sign-in, as the rule requires.

## The case narrative (`case-narrative.ts`, 2026-09-10)

The sibling of step narration, for the case page (`src/reporter/case-page.ts`):
one `generator`-role call per case, after the run, that writes `bundle.narrative`
— a lede, the pre-read summary, the test data as the record shows it, the
expectation restated, a ticket per recorded defect (plus at most one test-side
ticket), the verifier's note and the questions the sheet leaves open that the
record answers — in the run's report language (`--report-lang`). Same three
rules as narration: **it is given the record and nothing else** (the step
lines, `dbProofLines`, the defects, the masked variables, the notes, and the
one sheet-owned source every runtime role already sees — the case card; a
typed credential is not on the line it is shown), **it decides nothing** (no
status, no defect, no finding; `applyNarrative` DROPS an `app` ticket that
restates no recorded defect id — a model does not file a defect — keeps at
most one `test`-side ticket, caps the lists, clips every field, and an empty
answer leaves the bundle untouched; a test pins that `effectiveStatus` is the
same with and without it), **it is attributed** (`by` is the model id, and
the page labels every sentence). The generator role because the whole case
is one prompt — 120 step lines and 200 DB lines is tens of thousands of
tokens, past the healer's default tier; `WOWLIDATOR_GENERATOR_*` re-points it.
ON by default for a RUN because the page is built around it —
`--no-case-narrative` / `WOWLIDATOR_CASE_NARRATIVE=off` skips the call, a
run sealed `blocked` (a ceiling, never ran, the harness alone) is never
narrated, and no generator key degrades silently to the evidence-only page.
A `wowlidator report` rebuild back-fills it only under `--case-narrative`,
the `--narrate` rule one flag over: a rebuild is "no re-run", and one call
per case across every ledger on disk is asked for, never assumed; it reads
the case card back from the outcome's flow file, in the language the ledger
recorded (`report` cannot change it). `needsNarrative(bundle, lang)` keeps a
narrative already in that language, so a rebuild costs nothing twice. Tests:
`tests/case-narrative.test.ts`.

## The catalog generator for the indexed engine (`jev-catalog-author.ts`, 2026-09-18)

Plan and decisions: `plans/20260918155200-jev-catalog-generator.md`. A second
`FlowAuthorModel` — programmatic — behind the same `FlowAuthor`, selected by
`authorModeOf` (`src/cli/runtime.ts`): automatic when the agent role is on a
decision model (TypeSafe Jev), `--author-mode jev|llm` overriding.

**What it reads, and what it writes, at $0.** The described row `FlowAuthor`
already renders (`describeCase`) is the input — `AuthorRequest.caseText`, with
`caseId`, `runKey`, `now` and the parsed `testDataPairs` beside it — and every
reader is one this directory already had: the persona token → `signIn as:
<LABEL>` in setup (`DEFAULT` when the row names none and the run has `--as`);
the Menu column → the first leg's `open A > B > C via the menu`, the shape the
engine's walker reads; each numbered Step → one `workflow` leg, verbatim,
annotated `(test step N)`, carrying the Test data pairs whose field the step
names (`attachPairs`; a stray pair rides the first input step) as `set Field =
"value"` — the grammar `goalOutcomes` parses, so the engine's TYPE_TEXT /
SELECT rung never pays a text helper; each pair resolved through
`resolveValues` with `model: null` (relative dates, blank words, unique keys,
written values) BEFORE the goal is written; each Expected line with a quoted
literal → `expectVisible text="…"`, with a path → `expectUrl`. A sign-in step
and a verification-only step (`verificationOnlyGoal`) are never legs.
`legsRoundTrip` pins that every leg's pairs parse back out of its goal.

**What is not programmatic.** An Expected line with no literal ("the form
opens"), and a record-only line (a capture needs a selector), are UNREAD: the
row pays ONE call to the LLM author, asked for those lines only with the
programmatic steps stated as already written, and only the assertion steps of
its answer are kept — the model cannot rewrite a leg. A request with no
`caseText` (a free-text `author` prompt) goes to the LLM author whole.

**One lint is withheld, none is weakened.** `FlowAuthorOptions.indexed` skips
`workflowOverDeclaredControls`: a goal naming a control the repository
declares is the design here — the engine's numbered table is how that control
is found. `skipsAuthoredScript` already counts a `workflow` leg as performing
(2026-09-04); `unsettledWorkflowClaim`, the vacuous lints, `groundLoginProof`
and the rest apply unchanged, which is why the model sits behind `FlowAuthor`
and not beside it. Tests: `tests/jev-catalog-author.test.ts` — the Thai row
(persona, menu, pairs by step, a resolved date, the round trip), the fixture
row (`DEFAULT`, one leg, an unread line), `attachPairs`, the model with a
scripted fallback (no call for a readable row; one call naming only the
unread line; a click the model wrote dropped), the whole `FlowAuthor` under
indexed mode, and `authorModeOf`.

**Measured on the EC catalog (40 rows, 2026-09-18), and what it changed.** Read at $0 through `planCatalogCase`: 144 legs, every persona token a `signIn`, the menu path on every first leg, 0 round-trip misses after four rules were added — the resolver's generated stand-in never enters a goal (it had put `Sub-District = 29999999` into a leg; only `relative-date`, `unique-per-run` and `test-data` sources may rewrite a pair), a blank value is not written (`= ""` parses as no pair), both halves of a pair are quoted (a bare control stops at a slash or a Thai phrase word), a key the sheet writes twice takes the LAST line (`Branch code = TA57_1001` then `T153_1733`), the sheet's routing metadata (`Entry Route = Keyin`, `Menu = …`, the engine's `NOT_A_CONTROL` shapes) and an unresolved `<TOKEN>` are never pairs — each noted in the rationale. What stays the model's: 366 of 368 Expected lines quote no literal (`Employee Status = Active`, `ระบบสร้าง Employee ID เป็นตัวเลข 8 หลัก`), so every EC row pays one assertions-only call; the round trip is `legsRoundTrip`, which honours the engine's `cleanControl` (`คีย์ Employee Group` is read as `Employee Group`).

**The pairs ride the step whose BLOCK names them, and a derived value is never
set (2026-09-18, HIR-EC-001 live).** The first real run's Identity leg carried
29 of the row's 31 pairs — Cost Center, Division, Work Location, O.T. Flag
among them — because `attachPairs` matched a field against the NUMBERED LINE
only, and the sheet lists a step's fields in the bullets under it ("2.
กรอกข้อมูล Identity ตาม Test Data" / "- กรอก Salutation, First Name … Hire Date
และ Event Reason"). Three rules now, all read off the sheet's own sections:
a step is its numbered line plus the unnumbered lines until the next number
(`SheetStep.block`), and a pair rides the first step whose block names its
field; a verification-only step and a sign-in step are never homes (step 8
"ตรวจสอบ Employee ID / Status / Employee Group" names what it READS, and step
1's "Manual Key-in" reads as an input verb); and a pair no step names, but an
Expected LINE that says the application PRODUCES the value does, is DERIVED —
"ระบบดึงข้อมูลจาก Department ได้แก่ Cost Center / SSO Location …", "ระบบ
Auto-Derive … O.T. Flag = Yes ตาม Rule Table" — so it is left to the
assertions and never set, with the rationale saying so. The marker words are
data (`authoring.derived` in `value-rules.ts`: derive, auto-fill, pulled from,
ดึงข้อมูล, คำนวณ, อัตโนมัติ …), because a first cut that read ANY Expected
mention as derived withheld HIR-EC-002's "Hire Date" — an Expected line that
merely echoes a keyed value ("Hire Date = Today ตามค่าที่กรอก") marks nothing.
A pair named nowhere still rides the first input step. Measured on the 272 EC
rows: 1,572 legs, 4,506 pairs in goals, and the derived set went from 184
pairs under the wide rule to 17 under the marker rule; the 33
round-trip misses are pre-existing shapes (a `*` in a key, `Hire Date + 119
Day`, a Thai phrase value), untouched today. Why it cannot make a result worse:
every rule only moves a pair to a narrower home or withholds one the sheet
says the application fills in; nothing is invented, and the round trip
(`legsRoundTrip`) still pins every written pair. The sign-in hand-off the same
run exposed — the first leg starting on the login page HUMI lands a sign-in
back on — is the engine's (`src/engine/CLAUDE.md`, the signed-in surface
rule), not this author's: it has no route to write, and a guessed one would
be exactly what `ungroundedGoto` refuses. Test: `tests/jev-catalog-author.test.ts`
("a field is named in the bullets under a step, a verification step is no
home, and an Expected-only field is derived").

## A match against a value the sheet states is a stated-value claim, not a reconciliation (2026-09-18, HR SIT E2E-01)

Read against the hrsit-jev run of 09:32Z: the free-form E2E sheet
(`HR_SIT_E2E_V01-1.001.csv`, one scenario, not the table format, so the row
went down the claims path with no `caseText` and a login-page tree), authored
by opus through `claude-cli` with `--repo`. Attempt 1 was refused by
`unreconciledMatchClaim` on *"ตรงกับ Rule Table"* — the TM line *"Time
Management Status / O.T. Flag ใน TM ตรงกับ Rule Table"* — and told to save one
surface and compare it on the other. There is no other surface: the "Rule
Table" is a master the sheet cites (its formula is itself an open question,
*"สูตร/เงื่อนไข Rule Table = ? OQ-HIR-13"*), and the sheet wrote the values two
lines up — *"ระบบ Auto-Derive Time Management Status = 01 - Clocking และ O.T.
Flag = Yes ตาม Rule Table"*, with *"Time Status = 01 O.T. Flag = yes"* in Test
data besides. The claim is that the derived field shows the stated value. The
lint had no `settle`, so the re-ask was the only way out; attempt 2 died on the
provider after 501 s (a quota warning, 41k output tokens) and the row blocked.
Two changes, both in `flow-author.ts`, the words in `value-rules.ts`:

- **`matchClaimsIn` reads a match claim structurally.** The subjects are the
  words left of the agree word on its own line (bullet, number and a `[tag]`
  dropped, anything before a colon dropped), split on `/`, `,` and the
  conjunction words (`matchClaim.conjunctions`: และ, and, &). A subject is
  STATED when some line of the case writes `<subject> = value` — every `=` on
  every line is a candidate, the key matched by squashed suffix over the
  subject's longest word window (*"O.T. Flag ใน TM"* → *"O.T. Flag"*, *"the
  Total Plans tile"* → *"Total Plans"*), the value cut at the first conjunction
  and then by `writtenValueOf` (so *"Yes ตาม Rule Table"* is *"Yes"*); a value
  that still holds a later `=` is two pairs on one line and keeps its first
  token, marked uncertain so a clean statement of the same field wins. An open
  question (`= ? OQ-…`), a `<TOKEN>` and an instruction (`isDescription`) state
  nothing. The pairs come from the CASE's words only — the row when the caller
  has it, else the prompt after `END_SUPPORTING_CONTEXT` (premise 8: a
  document's pair is not the sheet's). The agree form with every subject
  stated is a stated-value claim; one unstated subject, or the unchanged form
  (a quantity before and after), is the reconciliation it always was.
- **`unreconciledMatchClaim` skips stated-value claims and gains a `settle`.**
  For a genuine two-surface claim it refuses as before; at the last word it now
  names the claim as *not covered* — the same note `settleUnperformedScript`
  writes for a script line nobody performs — and the flow goes out with its
  other claims. Never a rewrite: no tree names "the other surface", and a
  guessed save-and-compare would be invention.
- **`unassertedStatedMatch` is the weak companion.** Each stated pair must be
  asserted by a step that names the field (selector, name or intent) AND
  carries the value (selector, value, text or count — the intent alone is an
  explanation, not a claim); a flow that saves and compares instead has made
  the stronger claim and is left alone. A miss is THIN, not false — nothing
  asserts anything untrue — so it is `weak`: accepted at once with the note,
  never re-asked. Its settle, `settleStatedMatch`, runs on acceptance: each
  pair whose field a captured tree or the probe report names as a control that
  HOLDS a value (`valueAssertionFor`: textbox → `expectValue`, trigger/cell →
  `expectText`) is asserted at the end of the flow (`appendStep`, after every
  leg that could have produced it), marked `[generated: …]`; a field no tree
  names, or one under a role that holds no value (a region, a group), stays in
  the note — never an `expectText` over a container, which passes when the
  value is anywhere inside it.
- **The prompt says the same in one rule** (`<claims>`, beside the
  save-and-compare bullet): a field that matches a rule, a master or a table
  the page does not show, whose value the case states, is asserted as that
  value; save nothing; only two readings ON THE PAGE are a save-and-compare.
  The refusal message for the two-surface form names the same distinction, so
  a re-ask that is really a stated value is steered right.

Why it cannot make the result worse: the stated-value form used to be refused
outright and is now the flow the model wrote plus a note or a grounded
assertion — the assertion reads the sheet's own value and the tree's own role,
never a guess; the two-surface form is refused exactly as before through every
re-ask, and its last word is a disclosure the report carries, not a pass on the
line. Structural throughout: the agree word, the `=`, the tree's role; the only
words added are three conjunctions, as data. Measured on the live row offline
(the run's own claims file rebuilt into the author's prompt, attempt 1's flow
from the log): before, `unreconciledMatchClaim` → *"ตรงกับ Rule Table"*, fatal,
no settle; after, null, and `unassertedStatedMatch` names *Time Management
Status = "01 - Clocking"* and *O.T. Flag = "Yes"* as unasserted — a weak note
on the login tree, two inserted assertions on a tree that names the fields.
What this does not fix, and who owns it: attempt 1 was a sign-in-only flow
("none of the E2E-01 new-hire claims are observable on this page") because the
tree the author read is the login page — the describe-path ceiling (a capture
of the key-in page, or the indexed catalog author) — and the provider failure
that actually blocked the row is `provider-expert`'s. Tests:
`tests/flow-author.test.ts` ("a match against a value the case states is a
stated-value claim, not a reconciliation"): the live subjects and pairs, the
silent reconciliation lint, satisfaction after an agent leg, the intent-only
miss, the two-surface claim in both languages and an English stated subject,
a document's pair / an open question / an instruction stating nothing, the
settle on the login tree and on a tree naming the fields, `appendStep`, the
pipeline accepting the live shape on attempt 1 of 1 and inserting from the
tree, and the two-surface last word as *not covered*.

## Settle first: a complaint that knows its rewrite is not re-asked (2026-09-18, HR SIT E2E-01)

The last word (2026-09-04) performs every fatal complaint's grounded rewrite
once the budget is spent. Measured on HR SIT E2E-01 under Jev: attempt 1 was
refused by `admitsUngroundedSelector` (settles by annotating) beside the weak
stated-value note; the informed re-ask then ran 501 s on `claude-cli:opus`,
produced 41k output tokens, and died on the provider — no flow, no ledger,
and the settlement the last word would have made never happened. The re-ask
had bought only the chance that the model writes the rewrite itself.

`FlowAuthorOptions.settleFirst` (default on; `WOWLIDATOR_AUTHOR_SETTLE_FIRST=off`
restores the old order): when every FATAL complaint of an attempt carries a
`settle`, that attempt is the last word — the rewrites are performed, the flow
goes out with the notes and the `[generated: …]` marks, and the run proves or
fails each settled claim with the defect on the case page. A complaint with no
rewrite still re-asks exactly as before: for a FALSE claim the model's second
answer is the only way out, and premise 3 says a false claim is never handed
over. Why it cannot make a result worse: the flow is the one the last word
would have produced, one model call earlier; nothing new is authored, and a
settle that finds no evidence leaves its complaint unsettled and the refusal
whole. The log line says `(on this attempt, no re-ask: every complaint knew
its rewrite)`. Tests: `tests/flow-author.test.ts` ("settle first…"; the
identical-refusal test now pins the old order under `settleFirst: false`).

## A flow that stops at the sign-in is a journey nobody wrote (2026-09-18, HR SIT E2E-01)

**Incident.** A free-form E2E sheet (one scenario, a hire across EC/BE/TM/PY)
went down the claims path: no `caseText`, and the only tree the author saw was
the sign-in page. The model named its own answer *"E2E-01 new hire — login page
only"* — goto, fill Username, fill password, click Sign in, goto the home,
`expectHidden` of the Username field — and the suite sealed it **PASSED 6/6 in
7.7 s** about a hire it never attempted. Its one assertion holds whenever a
session was created. Nothing spoke: `skipsAuthoredScript` needs the sheet's
Steps, which the claims path does not carry; `vacuous.ts` excluded only
`expectVisible`/`expectEnabled`/`expectDisabled` of the sign-in form, so the
`expectHidden` counted as substantive; and the 2026-09-10 rule ("the sign-in
page going away is never a login proof") had dropped the submit-control form of
that proof, not the identity field's.

**Rule.** `isLoginFormSurface` now covers `expectHidden` of the identity or
password field — the same surface seen from the other side — so no flow can be
substantive on it. `signInOnlyFlow` (fatal, settles) is the shape itself: the
flow signed in (a `signIn` step, a credential block, or a run that started on a
sign-in URL), `vacuousClaim` finds nothing substantive, and no step acts on a
page other than a sign-in page — a `workflow` leg or an action after a
navigation away is the flow going somewhere and is judged as before. **Two
older rails keep what is not this shape**: a flow that never signed in is the
plain vacuous refusal's, because "sign in, then reach the page" is advice about
a journey it never began. Asserting nothing at all IS this shape when the
sign-in happened — `groundLoginProof` drops a "proof" that was none, and what
it leaves is the incident with its one false assertion removed.

**The settle writes the journey the flow never wrote** (`settleSignInOnly`),
from the row's own evidence and nothing else: every numbered script step no
step cites becomes an entry step where a captured tree names its control, else
ONE `workflow` leg carrying the sheet's own line (`settleUnperformedScript`,
capped at `MAX_SETTLED_JOURNEY_LEGS`); the sign-in line is never a leg, because
the flow's own `signIn` performs it; the sheet's Menu path rides the first leg
in the walker's grammar; then the assertions — every stated `Field = value` a
tree names as a value-holding control (`settleStatedMatch`), and every Expected
line the case QUOTES (`quotedExpectedLiterals`, capped at
`MAX_SETTLED_EXPECTED_LITERALS`), which needs no tree because the sheet's
wording IS the claim, the exemption `ungroundedTextExpectation` has carried
since 2026-08-31. The sign-in surface is annotated so no report reads "Username
hidden" as proof. **The gate**: no substantive assertion after all of it, and
the settle returns null — a journey nobody checks is the vacuous flow with legs
in front of it, and the refusal stands. On the claims path there is no script,
so no leg is written: a claim is an outcome, never an instruction to hand an
agent, and an agent asked to make a claim true is the witness for its own
claim.

**Why it cannot make a result worse.** The flow is refused today; what the
settle hands over performs the sheet's own steps and asserts the sheet's own
words, both marked `[generated: …]`, so the run proves or fails them and the
case page records the defect — which is the whole point: a case that reaches
its claim and fails is worth more than a green that never tried. Nothing is
invented: a leg is a line of the script, an assertion is a value or a quotation
the case wrote. With settle-first (the section above) this lands on attempt 1.
`verificationOnlyGoal` is deliberately NOT consulted when deciding which script
line becomes a leg: it reads "Import ไฟล์และตรวจสอบผลลัพธ์" — a line that acts
AND checks — as verification only, and `scriptDemand` is what the 2026-09-08
rule made the decider.

**What this does not fix.** The author still saw only the sign-in page, because
a free-form catalog authors as a UNIT test; `--scope e2e` is the launch flag
that demands a full journey and turns on the journey capture that grounds it.
The rail is the guarantee, the flag is the fix.

Tests: `tests/flow-author.test.ts` ("a flow that stops at the sign-in": the
predicate's two halves on the live shape, the shapes the older rails keep, the
pipeline's refusal wording, and the settle producing legs + assertions on
attempt 1).

### The claims path is many claims, and one of them about wording does not make the flow one (2026-09-18, HR SIT E2E-01)

The 2026-09-02 fix — "the wording classifier reads the case's own words, never
the background" — holds only where the caller can hand over a case
(`extra.caseText`, the table path). A free-form catalog has none: the prompt
IS the claim list. Live, the row carried 35 claims, exactly ONE of which says
`ข้อความ` and is about an in-app notification (*"ข้อความ In App =
Congratulations! You have a new direct report…"*); the other 34 are about a
hire. Classified from the joined claims, a 67-step flow became a wording flow,
and `wordingClaimAssertsDataValue` refused it twice for asserting "Minimum Job
Grade" — a value the sheet states and the case is about. The row was blocked
with no verdict and two opus calls spent (173 s + 20 s).

So when no case text is given AND the prompt holds more than one claim line
(`claimLinesOf`), the lint judges a STEP only when the step's own `case` name
or intent says it is about wording. A step carries the claim it serves; the
background claims of fourteen other cases in one prompt do not make it one,
and an attribution nobody can make is silence — the rule every grounding check
here follows. A single-claim prompt and a `caseText` call are classified
exactly as before. Tests: `tests/flow-author.test.ts` ("a claims-path prompt is
many claims…").

**The source a value is pulled from is not itself derived (2026-09-18, the
same row one run later).** "ระบบดึงข้อมูลจาก Department ได้แก่ Cost Center / …"
names Department as the SOURCE and the list after `ได้แก่` as what the
application fills, and the first cut of the derived rule matched the whole
line, so Department and Position read as derived too. On that row a step named
them first, so nothing was lost — but on a sheet whose source appears only in
Test Data it would have been withheld and never typed. The clause
`จาก/from <source>` up to the list marker (`ได้แก่`, `including`, `such as`,
`:`) is now dropped before a field is matched against the line. The same rule
is mirrored in the `/jev-case` skill's `author.py`, which carries its own copy
of the marker words and must be kept in step with `authoring.derived`. Test:
`tests/jev-catalog-author.test.ts` ("the source a value is pulled FROM is the
tester's input").
