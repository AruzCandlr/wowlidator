# Sequence-Diagram Testing Spec

Derived from a code survey of the observation plane (`src/api/network-observer.ts`, the marks machinery in `src/engine/runner.ts`) and the input pipeline (`src/catalog/extract.ts`, the claims gate, `src/context/`). Every capability claim below cites the line it stands on; every gap is disclosed rather than papered over.

> **Status: implemented** (branch `backend-quest-for-the-grail`) — S1–S8 landed; S9 (the observed-window → Mermaid renderer) is deferred and still open. Three places the implementation landed sharper than first specified: the flat authored form refuses a prose line outright by requiring path-shaped templates (`"just words"` must not parse as a call); a *missed* presence claim over a truncated window is also blocked rather than failed, since the call may simply have been evicted — B1's rule turned out to cut both ways; and the participant table lives in the claims file and the CLI's `lane` lines — and, since the follow-up UI pass, in wowUI's gate itself: `SequenceGateInfo.messages` maps each claim to its message, and the panel's lane editor recomputes testability live when a guessed plane is corrected (the observability rule is mirrored client-side, cross-referenced with `isObservable`, since the page's script cannot import it). Covered by `tests/sequence.test.ts` (browser tier included) and the gate additions in `tests/wow-ui.test.ts`.

## Verdict

A sequence diagram describes lifelines and ordered messages. wowlidator sits in the browser, so each message is verifiable exactly to the extent the browser can see it:

| Diagram lane | Verdict | Technique |
|---|---|---|
| User → UI ("clicks Submit") | **CAN** | It *is* a flow step. Authored against the live AX tree, as always — the diagram supplies intent, never selectors. |
| UI → Backend (XHR/fetch/document nav) | **CAN** | New `expectCalls` assertion over the existing `NetworkObserver` — order, endpoint template, status. $0, deterministic. |
| Backend → UI (the reply) | **CAN** | Status/latency on the same observed record. Response *bodies* are not captured on observed calls (`NetworkCall` has none — `network-observer.ts:69-88`); a body claim needs a deliberate `request` step instead. |
| Test → Backend (direct HTTP) | **CAN today** | `request` + `expectStatus`/`expectJson` — already shipped. |
| Backend → DB | **CANNOT from the browser** | Beyond the observability boundary. Held as a disclosed assumption (`testable: false`), or made verifiable two ways: state effects via the DB verification spec (`docs/db-verification-spec.md`), or spans via OTel trace ingestion (phase 4, server cooperation required). |
| Backend → Backend / Backend → third party | **CANNOT from the browser** | Same boundary. OTel phase 4; a sandboxed third party with an inspection API (a mail catcher, a payment sandbox) is verifiable *today* via `request` steps against that API. |
| WebSocket lanes | **CANNOT** | The observer records only `XHR`/`Fetch`/`Document`/`EventSource` (`network-observer.ts:49`). Refused at compile time with a named note, never silently dropped. |

The composed answer: a full-stack sequence diagram is **partially verifiable now, fully verifiable only with server cooperation** — and the design below keeps the two halves honestly labelled at every stage, from the claims file to the report.

## Evidence base

| Fact | Where |
|---|---|
| Observed calls carry method, url (redacted), status, timing, headers, request body — never response body | `NetworkCall`, `src/api/network-observer.ts:69-88` |
| Buffer is run-scoped, capped at 300, FIFO-evicted, drops counted and surfaced | `DEFAULT_MAX_CALLS :39`, `#trim() :277`, `runner.ts:3450-3454` |
| Marks are wall-clock timestamps; `since(mark)` filters `startedAt >= mark`, preserves arrival order | `mark() :288`, `since() :293` |
| The ordered call list is read once at `close()` for three counters, then discarded — no sealed bundle holds it | `runner.ts:3449-3459`; `ProofStep.network` is failure-only, capped at 8 (`proof-bundle.ts:223`, `MAX_STEP_EVIDENCE`) |
| A cancelled request is retroactively removed; a redirect duplicates its `requestId` across two records | `#forget :250-252`, `:216-231` |
| The endpoint template matcher already exists, exported | `matchesRoutePattern` / `pathnameOf`, `src/context/context-engine.ts:99/:86`; `toRoutePattern`, `openapi-ingester.ts:93` |
| The "METHOD url vs operation" composition exists only inline, module-private | `linkCoverage`, `context-engine.ts:154-166` |
| A structured document already earns a deterministic, model-free claims path | CSV → `parseTestCaseTable` → `tableToClaims`, `src/cli/commands/authoring.ts:501-510`, `test-case-table.ts:207` |
| `interpolateStep` is shallow — nested arrays are never interpolated by the generic walk | `runner.ts:3732-3744` |
| `API_STEP_ACTIONS` is one flat set doing nine jobs (dispatch, tier, interpolation exemption, screenshot/video/caption suppression, badges, JUnit split) | `proof-bundle.ts:39-44` and the consumer table in `runner.ts` / `html-reporter.ts` / `machine-report.ts` |

## Boundary register

The rules that keep this feature honest. Each is a place a naive implementation would overstate.

| # | Boundary | Consequence in the design |
|---|---|---|
| B1 | The buffer drops beyond 300 calls, silently except for the counter | An absence claim (`never`) evaluated over a window with `dropped > 0` is **blocked, not passed** — a truncated capture reads exactly like a quiet page, the rule the drop counter already exists for. Presence claims survive drops (a match found is found; eviction can hide, not fabricate). |
| B2 | Marks are millisecond wall-clock; two same-ms calls order only by array position | Matching is **ordered-subsequence over array position**, never timestamp comparison between records. |
| B3 | Cancelled requests vanish retroactively | A call the page cancelled before the assertion runs is invisible. Disclosed in the step's evidence, not worked around. |
| B4 | A redirect leaves an orphaned first hop with `status: undefined` | A status-pinned expectation matches **completed records only**; `classifyCall` maps `undefined` → `'ok'` (`network-observer.ts:134`) and that must never satisfy an `ok` pin. |
| B5 | Observation attach failures are swallowed (`runner.ts:794-796`) | `expectCalls` with no observer is an **environment fact, not a page fact**: the step errors with wording modelled on `HealUnavailableError`, exits through the environment arm, never files an app defect. |
| B6 | Traffic attribution is correlational | Every message this feature produces says the calls happened **"while the journey ran"** — never "because step N caused them". Same wording rule the backend rung already obeys. |
| B7 | The page's own concurrency interleaves freely (analytics, polling, prefetch) | Default matching is **partial order** (expected calls appear in relative order; unrelated traffic interleaves). A strict total order would fail every real application and teach people to ignore the instrument. |

## Design

### 1. The assertion primitive: `expectCalls`

One new step action, useful by hand long before any diagram parser exists — which is why it ships first.

```jsonc
{
  "action": "expectCalls",
  "intent": "the order is submitted to the API and confirmed",
  "calls": [
    { "method": "POST", "url": "/api/orders", "status": "2xx" },
    { "method": "GET",  "url": "/api/orders/:id" }
  ],
  "never": [
    { "method": "DELETE", "url": "/api/orders/:id" }
  ],
  "since": "mark"          // "mark" (default) | "run"
}
```

- **`calls` is an ordered subsequence.** Each entry must appear, in this relative order, in the observed window; anything else may interleave (B7). An entry is `{ method, url, status? }` — `url` is a path template accepting both `:id` and `{id}` forms (normalised through `toRoutePattern`), matched with the exported `pathnameOf` + `matchesRoutePattern`, methods compared uppercased. `status` accepts an exact code or a class (`'2xx'`…); omitted means "completed, any status". Status-pinned entries match completed records only (B4).
- **`never` is an absence claim** over the same window: any observed call matching the template fails it, whatever the status. Blocked — not passed — when the window saw drops (B1).
- **The window.** `since: "mark"` evaluates from the flow's *sequence mark* — set at connect, advanced to the evaluation end each time an `expectCalls` settles — so consecutive `expectCalls` steps verify consecutive stretches of the journey (`click → expectCalls → click → expectCalls`). `since: "run"` evaluates the whole buffer, for a single trailing assertion after the journey. This is deliberately **not** the `#evidenceFloorMs` machinery: that floor reaches back into the previous step by design (`runner.ts:2419-2425`), which is right for failure evidence and wrong for a window that must not double-count.
- **It polls.** A `click` returns when the click lands; the XHR it fired is still in flight. `expectCalls` re-evaluates through the healed budget until every expected entry has a completed match or time runs out — the same reasoning that makes `expectUrl` wait rather than peek. No timing defect on a late match: the fast/late distinction is a selector-ladder concept, and there is no ladder here.
- **Ladder position: none.** `#bareStep` family — no selector, nothing to heal, and healing a traffic claim could only repair it onto different traffic. Same category as `expectUrl`/`setLocalStorage`.
- **It is an assertion.** Added to `ASSERTION_ACTIONS` (`runner.ts:3655`) so `hasAssertion()` counts it; named with the `expect` prefix so `classifyStepFailure` (`runner.ts:3761`) reads a miss as `failed`, not `error`, for free.
- **It is browser-bound and backend-tier — which the current sets cannot express.** See refactor R1.
- **It self-interpolates.** `calls` is a nested array, invisible to the shallow `interpolateStep` walk; the executor runs `variables.interpolateDeep` over its own fields. `{ "url": "/api/orders/{{orderId}}" }` — an id saved by an earlier `request` step keying an observed-traffic claim — is the deliberate payoff.
- **Evidence lands on the step.** `detail` carries the match table: each expected entry → the matched record rendered by `describeCall`, or "not observed (N calls in window, M dropped)"; on failure, the observed window itself (capped at `MAX_STEP_EVIDENCE`, already redacted at capture). This closes the "ordered list never reaches a sealed bundle" gap at the step grain — the grain the bundle already works in — instead of adding a run-level journal every bundle would carry whether or not anything asserted on it.

### 2. The diagram as a document: `.mmd` / `.puml` into the catalog

A sequence diagram *is* a claims document, and it enters through the same two-step gate as every other document: `document → claims → (a person prunes) → cases → a run each`.

- **Extensions** `.mmd`, `.mermaid` and `.puml`, `.plantuml` map to one new `DocumentFormat` member, `'sequence'`, in `FORMATS` (`extract.ts:38`). The dispatch switch gains a `'sequence'` arm that validates the text parses (Mermaid detected by the `sequenceDiagram` keyword, PlantUML by `@startuml`) and returns `{ text, note }` — anything skipped (see block support below) comes back on `note`, which the CLI prints and the panel shows, per the module's own rule. A diagram that does not parse **throws**, naming the first bad line: never hand the model text that is not the document's meaning.
- **Claims extraction is deterministic — no model call.** The CSV table short-circuit (`authoring.ts:501-510`) is the precedent and the hook: a `'sequence'`-format document takes a sibling branch through a new `sequenceToClaims()`, model field reading `'read from the diagram (no model call)'`. Each message becomes one claim; `source` carries the message's line number and arrow text so the gate can trace every row to the diagram.
- **Parser scope, v1: participants, linear messages, `alt`.** Both grammars are line-based text. `alt` blocks are the valuable construct — a success/failure fork — and they compile to **separate cases**, one per branch, because a run takes one concrete path; that is `splitIntoCases` philosophy applied at the source. `opt` messages are carried as unasserted notes (a message that may or may not appear can never fail — asserting it would be theatre). `loop` and `par` are **refused with a named note** in v1; `par` is a cheap phase-2 add (an unordered group is a weaker constraint than the default partial order), `loop` becomes a count (`atLeast`) when it comes.
- **Fixtures rule.** Parser fixtures are written by real `mermaid-cli` and real PlantUML, not by the parser's own writer — the `.xlsx`/`.pdf` rule, verbatim.
- **Markdown files keep the markdown path.** A fenced ```` ```mermaid ```` block inside `.md` flows to the model as prose today and continues to; format is decided by extension, not sniffed. Revisit only with evidence it is a real authoring pattern.
- **Touch points the extension list drags along** (found duplicated, none derived from `SUPPORTED_EXTENSIONS`): `DOCUMENT_ACCEPT` in `wow-ui-html.ts:2432`, the human strings at `:2474`/`:2549`, `usage.ts:147`, `commands.ts:523`. The uploads gate (`uploads.ts:68,112,145,176`) derives and needs nothing. Deriving `DOCUMENT_ACCEPT` from `SUPPORTED_EXTENSIONS` while there is worth the one-line change.

### 3. Lifelines and planes: the gate's new column

The diagram never says which participant is the browser and which host is the API. Guessing is exactly what this codebase refuses to do silently — so classification is **proposed deterministically, confirmed at the gate**:

- The claims file gains an optional `sequence` block: `participants: [{ name, plane: 'user' | 'page' | 'backend' | 'external', baseUrl? }]`. Absent for ordinary catalogs; `parseClaimsFile` treats it additively.
- First-pass defaults use only what the notation states: PlantUML's typed participants (`actor` → user, `database` → external), Mermaid's `actor` keyword. A name-pattern guess (`DB`, `postgres`) is written into the file **as a default the person is shown**, not acted on unreviewed. The `baseUrl` mapping for each backend participant (which observed origin counts as "API") is supplied at the gate or inherited from `--url`.
- Messages on `user`/`page`→`backend` lanes become testable claims. Messages between `backend`/`external` participants become `testable: false` claims — kept, shown, listed in the authoring prompt under *assume this is already true*, and listed in the report as **assumptions the run did not check**. The existing `testable: false` semantics carry this whole case unchanged.

### 4. Compilation: claims → flow

- **User-lane messages are authoring intents.** `FlowAuthor` writes the steps against the live AX tree; the diagram contributes the intent text and the ordering. Selectors never come from the document — grounding stays where it is solved.
- **Network-lane messages compile to `expectCalls` entries**, interleaved after the user action that the diagram shows provoking them. A message whose text carries a literal `METHOD /path` compiles deterministically. A prose message ("save the order") is grounded the only honest way available: against an indexed OpenAPI spec, choosing among declared operations (the `NoSpecError` philosophy — with no spec, the endpoint column is left for the person at the gate, and an entry still empty at authoring time is refused loudly).
- **The authored schema stays flat.** `AuthoredStepSchema` gains `expectCalls` with entries as *strings* (`"POST /api/orders -> 2xx"`), one per line, narrowed into the structured form by `flow-author.ts`'s own `toFlowStep` — the "flat objects, narrowed in code" rule for model output schemas, kept. Hand-written flows and the MCP input schema use the structured form directly (a zod discriminated union is fine in an *input* schema).
- **The catalog path authors through `flow-author.ts`, not `test-generator.ts`** — so the action lands in `AUTHOR_ACTIONS` (`flow-author.ts:63`) and that file's `toFlowStep` (`:567`). It deliberately does **not** land in the page generator's `GENERATOR_ACTIONS`: an AX tree cannot see traffic, so the page generator could only invent endpoints — the same precedent that keeps `expectModal` out of that list.
- Case splitting reuses `caseFlows()` (`flow-author.ts:1109`, exported); the compiler constructs `AuthoredCase[]` directly rather than needing the private `splitIntoCases`.

### 5. Diagram out: the observed sequence as evidence

The inverse direction is nearly free and worth shipping with phase 3: render the observed window of a run **as a Mermaid sequence diagram** (text, generated from the same records the step evidence holds — participants from the plane table, one arrow per matched/unmatched call). `--emit-sequence` writes it beside the report; the report's diagnostics link it. Plan and actual then diff as text. This costs no tokens, no new dependencies, and turns "the run disagreed with the diagram" from a table into a picture a reviewer already knows how to read.

## Changes, per module

- **S1 · Lift the call matcher (`src/context/context-engine.ts`).** Extract the inline METHOD-split + `pathnameOf` + `matchesRoutePattern` composition (`:154-166`) into an exported `matchesCall(method, url, expectedMethod, pattern)`; `linkCoverage` and `expectCalls` both call it. Duplicating those 12 lines is precisely the drift `proof-bundle.ts:36-37` warns about.
- **S2 · Split `API_STEP_ACTIONS` (refactor R1, shared with the DB spec).** Two exported sets in `proof-bundle.ts`: `BROWSER_FREE_ACTIONS` (feeds `isBrowserFree`, the `interpolateStep` exemption, screenshot/video-offset/caption suppression — "no page, no picture") and `BACKEND_TIER_ACTIONS` ⊇ it (feeds tier attribution, the `backend` badge, JUnit/CTRF split). `expectCalls` joins only the second: it needs the live observer, so it must never make a flow "browser-free" — an all-API+`expectCalls` flow dispatched to `runApiFlow` would have no observer to ask. The `API_ONLY_ACTIONS` alias (`runner.ts:4277`) is the compatibility seam.
- **S3 · `SmartRunner.expectCalls` (`src/engine/runner.ts`).** `#bareStep` shape; sequence-mark state (`#sequenceMark`, set at connect, advanced on settle); polling to the healed budget; drop-aware absence semantics; self-interpolation via `interpolateDeep`; observer-missing → environment-worded error (B5). Plus the standard touch points: `FlowStep` union arm, `executeStep` switch arm (`runner.ts:4014` — note the CLAUDE.md checklist still says `executeFlow`; fix the doc while here), `ASSERTION_ACTIONS`.
- **S4 · Buffer control (`src/api/network-observer.ts`, `runner.ts`).** `NetworkObserverOptions.maxCalls` exists and nothing passes it (`runner.ts:791`); expose it through `RunFlowOptions.network` so a long journey can raise the cap instead of discovering B1 the hard way. Default stays 300.
- **S5 · Diagram parser (`src/catalog/sequence.ts`, new).** `parseSequenceDiagram(text)` for both notations; `sequenceToClaims()`; the `'sequence'` arm in `extract.ts`; the extension-list touch points from §2.
- **S6 · Claims file + gate (`src/catalog/catalog.ts`, `src/ui/wow-ui-html.ts`).** The optional `sequence.participants` block; the panel renders the plane/baseUrl columns above the tick-boxes it already draws.
- **S7 · Compiler + authoring (`src/generator/flow-author.ts`).** `AUTHOR_ACTIONS`, flat string entries in `AuthoredStepSchema`, narrowing in `toFlowStep`, prompt section for network-lane grounding (labelled apart from the AX tree, the probe-report separation).
- **S8 · MCP + report (`src/mcp/server.ts`, `src/reporter/`).** `flowStepSchema` arm (structured form); report renders the match table; a `GLOSSARY` entry for the new badge — the reporter has a test asserting no badge renders without one, and it will fail until this lands.
- **S9 · Diagram out (`src/reporter/`, CLI).** The observed-window → Mermaid renderer and `--emit-sequence`.

## Test plan

| Tier | Covers |
|---|---|
| Unit ($0, always) | Parser against real mermaid-cli/PlantUML fixtures; plane defaults; claims compilation; `matchesCall`; ordered-subsequence matching incl. same-ms records, redirect orphans, status pins vs `undefined`; drops-block-absence; flat-string narrowing in `toFlowStep`; the claims-file round trip. |
| Browser | A fixture page firing real XHRs: ordered matching through interleaved noise; polling until an in-flight call completes; a cancelled request's invisibility (documented, asserted); `never` under a forced buffer overflow → blocked. |
| Real application | Invariants only: an `expectCalls` compiled from a diagram resolves its window; no business content asserted. |

## Rollout order

1. **S1, S2** — pure refactors, unit-tier, zero engine behavior change.
2. **S3, S4** — `expectCalls` usable in hand-written flows. This alone delivers "verify the UI↔backend lane of a sequence".
3. **S5, S6** — diagrams in, claims out, gate review. No browser involved yet (`--claims-only` analog holds).
4. **S7, S8** — compilation to cases and the full `catalog sequence.mmd --run` path.
5. **S9** — diagram out.
6. **Phase 4 (joint with the DB spec)** — OTel trace ingestion makes the backend→DB and backend→backend lanes verifiable; the plane table gains `traced: true` participants and their messages move from assumption to assertion. Specified in `docs/db-verification-spec.md` §"Called as planned".

## Explicitly out of scope, on purpose

Images and draw.io exports (no OCR — never hand back text that is not in the document); WebSocket lanes (observer boundary, B-table); strict total-order matching (B7); sniffing Mermaid out of `.md`; response-body matching on observed calls (records carry none — a body claim is a `request` step); `loop`/`par` in v1 (refused with note, phased).

**Acceptance:** a diagram of the order journey (`User → Shop: submit`, `Shop → API: POST /api/orders`, `alt success/failure`, `API → DB: INSERT`) run through `wowlidator catalog order.mmd` yields a claims file whose DB message is `testable: false` with the boundary named; after gate approval, two cases (one per `alt` branch) run, each carrying an `expectCalls` whose match table quotes the observed `POST /api/orders → 201` record; the report lists the DB lane under assumptions; and the same diagram with a `never`-listed admin endpoint goes blocked — not green — on a run whose buffer dropped calls (B1 observable end to end).
