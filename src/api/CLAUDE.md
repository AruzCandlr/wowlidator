# CLAUDE.md — backend, sequence and DB verification

Split out of the root CLAUDE.md (2026-08-24) so this loads only when working under
`src/api/`. Same authority as the root file; the root keeps the map of the whole system.

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

### False test failures at backend steps (the 2026-08-24 audit)

544 live proof bundles said the quiet part: **most red at backend steps was not the application.** 136 runs ended status `error`, every recorded cause the machinery's (`database unavailable` ×27, the agent giving up, a provider refusing on quota, `ERR_CONNECTION_REFUSED`) — and the suite scored every one `failed`. The rest of the false family: DB predicates the model mangled into unmatchable SQL, whole-table exact counts drifting with the seed, and 405s from the test's own wrong method. What changed, each with a test:

- **`harnessOnly()` (`cli/exit.ts`)** — a bundle whose every broken step is status `error` scores the CASE `blocked`, never `failed`; `exitCodeFor` consults it too, so an undeclared table or unknown variable exits 3 without the message-regex having to know its phrasing. A single `failed`/`dead-end` step anywhere keeps the failed verdict — an error step must never soften a real finding.
- **`UnknownVariableError` and `NoResponseError` joined the harness-class names** in `classifyStepFailure` and `reconstructionFutile` (`engine/runner.ts`), and `ApiActions.#assert` files **no defect** for either: an unknown `{{var}}` on `expectJson` used to be `failed` + `backend`/`high` while the identical fault on `request` was `error` + `functional` — the asymmetry the "an unknown variable is an error" rule above always meant to rule out. "Nothing to assert against — no request step has run yet" is flow ordering, and now says so as `error` with no backend defect.
- **`expectStatus` names method drift**: a 405/501 failure appends "the request's own method is wrong (test drift), check the spec before filing a defect" — every live 405 was an authored method the API never offered. A failed `save` on a ≥400 response likewise says the missing path is a consequence of the refusal, not a finding about the body.
- **`parseDbConditions` refuses mangled SQL** (unterminated quote, top-level ` OR `, a quote loose mid-value — `benefit_type = REIMBURSEMENT' OR …`, live): unusable, never a predicate that structurally cannot match. A value needing an interior quote is written wrapped in the other quote (`"O'Brien"`).
- **A whole-table exact count names its own brittleness** in the `expectDbRow` failure: no `where` means the number belongs to every test and every seed, so the message says to re-check the claim before the backend.

### Redaction is load-bearing, not a nicety

The HTML report is deliberately self-contained — "opens off a USB stick" — which
is exactly what makes it easy to email. A single `request` step can carry a
session cookie, a bearer token and a password. So `redact.ts` runs at the one
point a live response becomes a stored artefact, and the rule is: **never emit a
payload we could not inspect.** An unrecognised body is replaced with its size
and type, because "we didn't recognise the format" is not evidence it holds no
secret. Saved variables whose *name* looks like a credential are masked in the
report while the run keeps using the real value. There is a test asserting a
bearer token cannot survive into rendered HTML; keep it.

**A typed value is redacted on the same rule, and that half was missing until
2026-08-18.** An earlier version of this section claimed that before `src/api/`
nothing in a bundle could carry a credential — false for as long as `fill` has
existed. Measured on a real bundle on disk:
`{"action":"fill","selector":"input[type=\"password\"]","detail":{"value":"admin2026"}}`,
inlined verbatim into the emailable report by every login flow on every run.
`--as` made it worse by design, since that flag exists so a person supplies a
*real* credential rather than the model inventing one. `isSecretStepValue` /
`maskSecret` decide and mask at the same recording boundary — the run keeps
using the real value; only the record is masked — and the order is **evidence
before wording**: an `--as` value is masked unconditionally wherever it lands,
then the field's own `type="password"` (a fact about the document), then
`looksLikeCredentialField` as the fallback for a step that never resolved and
so has no field to read. Masked, never dropped: `•••• (9 chars)` keeps the step
legible, the same compromise `redactBody` makes for an unrecognised body.

Two deliberate limits, both stated rather than implied away. **Over-masking
destroys evidence**, so a boundary table's values (`fillEach`), a generated
retry value (`fillRetry`), a dropdown label and an email address all stay
visible — this codebase's own guidance is to identify a created record by a
value the flow typed, and that value has to be readable. And **screenshots and
video are out of scope**: a password typed into a field that does not mask it on
screen is in the frame and in the recording, and no redaction of the bundle
changes that. `--video off` / `--screenshots off` are the only controls for it.

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

## Sequence and database verification (`src/api/expect-calls.ts`, `src/db/`, `src/catalog/sequence.ts`)

Two capabilities, one boundary rule, specified in `docs/sequence-testing-spec.md` and `docs/db-verification-spec.md`: wowlidator sits in the browser, so a claim is checkable exactly to the extent the browser can see it — and every design below either proves a claim deterministically or discloses that it cannot, never a third thing.

**`expectCalls` asserts the traffic the page made.** Ordered-subsequence matching over the network observer's window (`matchExpectedCalls`): expected calls must appear in this relative order, anything else — analytics, polling, prefetch — interleaves freely, because strict total order fails every real SPA and teaches people to ignore the instrument. Endpoint templates (`/api/orders/:id`, `{id}` both) go through `matchesCall` in `src/context/route-match.ts` — the linkCoverage composition, lifted so coverage and assertion share one rule. It polls through the healed budget (the XHR a click fired is still in flight when the assertion starts — the `expectUrl` argument), supports `never` absence claims, and self-interpolates `{{vars}}`. Four honesty rails: a window the ring buffer truncated makes absence (and unproven presence) **an error naming the dial to turn** (`networkMaxCalls`), never a pass and never an app failure; a missing observer is an environment fact worded like `HealUnavailableError`; a status-pinned entry matches completed records only (a redirect's orphaned first hop has `status: undefined`); and evidence is the match table on the step's `detail`, since the observer's ordered list is otherwise discarded at close. Never on the ladder — no selector, and "healing" a traffic claim could only repair it onto different traffic.

**The one flat `API_STEP_ACTIONS` split into two sets** (`proof-bundle.ts`), because `expectCalls` broke the identity it relied on: `BROWSER_FREE_ACTIONS` (needs no page — dispatch, interpolation exemption, no screenshot/video/caption) and `BACKEND_TIER_ACTIONS` ⊇ it (findings belong to the backend half — tier attribution, badge, JUnit split). `expectCalls` is backend-tier but **not** browser-free: it needs the live observer, so its presence keeps a flow on the browser path — an all-API flow plus one `expectCalls` dispatched browser-free would have nothing to assert on.

**A failed DB check is attributed by what the page actually sent** (`WriteWitness`, injected into `DbActions` from the `NetworkObserver`). "The row is not there" is one observation with two causes that go to different people: the backend refused the write, or **nothing ever asked it to**. Zero non-GET requests across the whole run means the second, and the defect is filed `functional`/`medium` naming the real cause instead of `backend`/`high` — because sending someone to debug an API the page has never called is worse than saying nothing. Found live: an application whose overtime feature is a Zustand store persisted to localStorage (*"Phase: UI mockup. No backend."*) had 386 Postgres tables indexed from a schema file, so the author wrote `expectDbDelta +1` against a table nothing in the browser can reach — a high backend defect on every run of a feature working exactly as built. Three rails: the witness is **the whole run, not a step window**, so the only claim it makes is the unambiguous one; **no observer means no attribution** and the previous behaviour, because "we did not look" is not evidence that nothing was sent; and a browser-free API flow passes no witness at all, so `runApiFlow` is untouched. **An indexed schema is not evidence that the front end talks to it** — that is the rule the authoring prompt now states and this is the runtime half of it.

**The DB family answers "modified as planned"; `expectDbCalled` answers "called as planned", correlationally.** `dbSnapshot` / `expectDbRow` / `expectDbDelta` / `expectDbUnchanged` in `src/db/db-actions.ts` — `ApiActions`' sibling, same constitution, nothing touches `Page`. Read-only is enforced in layers, not requested: wowlidator never accepts SQL from a flow (every check compiles to a parameterized SELECT against schema-validated identifiers — an undeclared table or column is a `DbGroundingError`, grounding and injection defense in one move), the session opens `default_transaction_read_only = on`, and the documented grant is read-only. The driver is a **lazy optional import** (`pg`, not a dependency): a run with no DB steps never demands it, and a missing driver / unreachable database is `DbUnavailableError` — "database unavailable" maps to `EXIT.environment`, the step classifies `error` not `failed`, and **no app defect is filed** for a check the harness could not make. The DSN travels by env only (`WOWLIDATOR_DB_URL`; a non-loopback host needs `WOWLIDATOR_DB_REMOTE_OK=1` / `--db-remote-ok`), rows are redacted before they exist in a bundle (`redact-row.ts`, the exported `isSensitiveKey` heuristic, evidence capped at 3 rows), and `expectDbRow` polls through its budget with `polledMs` on the record — eventual consistency is evidence, not noise. The strong attribution form is a `where` keyed on a `{{variable}}` the run itself saved — which is why one shared `VariableStore` is now injected into both action families; `expectDbUnchanged` is count-based and its record says so (a same-count UPDATE is invisible — disclosed, not implied away). `expectDbCalled` reads `pg_stat_statements` deltas between snapshots — statement-level, correlational, and worded so; the extension being absent is blocked, not failed. Snapshot-less deltas are refused loudly: explicit beats an implicit baseline nobody can audit.

**A sequence diagram is a catalog** (`.mmd`/`.puml` → `DocumentFormat 'sequence'`): one claim per message, read deterministically — the CSV-table precedent, no model call. Planes are classified from what the notation states (`actor` → user, `database` → external) plus flagged name-heuristic defaults the **gate** confirms (`ClaimsFile.sequence` carries the participant table; the CLI prints each lane with "guessed — confirm in the claims file"). Messages past the boundary (backend→DB, backend→backend) come out `testable: false` with the boundary named in `source` — kept, listed under *assume this is already true*, never checked, never dropped. `alt` branches label their claims so authoring splits them into cases; `opt` becomes a note (a claim that cannot fail is not asserted); `loop`/`par` are refused with a note counting what was skipped. Unparseable diagrams **throw** naming the line — never hand the model prose that is not the document's meaning.

**The schema is the sixth ingester** (`schema-ingester.ts`): SQL DDL and Prisma parsers (warnings for what they cannot read, never guesses), conventional discovery (`schema.sql`/`schema.prisma`, shallowest wins), live introspection as fallback when `WOWLIDATOR_DB_URL` is set — the database is the source of truth wherever a connection exists. Emits `table` nodes and FK `references` edges; `linkCoverage` matches flows' `meta.checks` against them, so the graph answers "does anything verify this table?" the way it already answers it for routes and endpoints. Authoring gets the inventory as a labelled prompt section **only when a schema is indexed**, and `toFlowStep` drops any DB step emitted without one — presence of the inventory is the permission, the `MutationPolicy` filter-not-sentence move. The authored forms stay flat (`expectCalls` entries as `"POST /api/orders -> 2xx"` strings in `value`, DB conditions as `"col = value AND …"` in `key`), narrowed in code, because a nested array is exactly what `AUTHOR_ACTIONS` excludes `fillEach` for.

**Deferred, on purpose, both disclosed in the specs' status banners:** the observed-window→Mermaid renderer (spec A's S9) and OTel trace ingestion with `traceparent` injection (spec B's D10 — the causal "called as planned" tier and the unlock for the diagram's backend lanes).
