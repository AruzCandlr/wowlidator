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
- **The risk judge's evidence feeds the author** (S6): a `fail-fast` verdict with concrete reasons triggers ONE immediate re-ask with those reasons as `priorFeedback`; the re-authored flow replaces the first only when its re-judged likelihood is lower — feedback must never make the result worse. "The search box starts disabled" (0.78) and "no Start-date filter exists" (0.88) were each right and each spent on a full dead-ended run.
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
