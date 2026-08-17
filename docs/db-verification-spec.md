# Database Verification Spec

Derived from the same code survey as `docs/sequence-testing-spec.md`. The request this answers: *given a database schema, test whether the database is called or modified as planned.* Those are two different questions with two different verdicts, and conflating them is how a tool ends up claiming things it never observed.

> **Status: proposed.** Nothing in this document is implemented. There is no database driver anywhere in the dependency tree today (verified: `package.json` has 13 runtime deps, none DB-related; a repo-wide grep for `postgres|mysql|sqlite|prisma|knex|sequelize|typeorm` over `src/` returns zero hits).

## Verdict

| Question | Verdict | Technique |
|---|---|---|
| Ingest a schema (SQL DDL, Prisma, or live introspection) | **CAN** | Sixth context ingester emitting `table` nodes — the OpenAPI ingester is the template, line for line. Deterministic, no model call. |
| **"Modified as planned"** — is the DB in the planned state after the journey? | **CAN** | Read-only connection + snapshot/delta/row assertions (`dbSnapshot`, `expectDbRow`, `expectDbDelta`, `expectDbUnchanged`), polled through a budget for async writes, keyed by variables the run itself saved. Deterministic, no model call. |
| **"Called as planned"** — did the app execute the statements the plan says, that many times? | **CANNOT from the browser.** Two cooperation tiers make it CAN: | (1) `pg_stat_statements` deltas over the same read-only connection — lighter, correlational, catches "+1 INSERT" and N+1 storms; (2) OTel trace ingestion with `traceparent` injected at the browser — heavier, causal, joins each SQL span to the exact UI action. |
| Generate DB checks from claims | **CAN, grounded only** | The authoring prompt receives the declared table inventory and may reference nothing outside it — the "choose among declared endpoints, never invent URLs" rule, pointed at tables. No schema → no DB steps (`NoSpecError` shape). |
| Assert "this table was **never** touched" | **Partially** | State tier: count-unchanged only (a same-count UPDATE is invisible — disclosed). Statement tier: yes, via technique (1)/(2) above. |

The line to hold: **state effects are observable from outside; the calls themselves are not.** wowlidator can prove the order row exists, has status `pending`, and appeared while the journey ran. It cannot prove an `INSERT` was executed — as opposed to a trigger, a queue worker, or a second service — without evidence from the server side, and it must never word a state check as if it could.

## Evidence base

| Fact | Where |
|---|---|
| The non-browser action pattern to copy: injectable transport seam, `#record` with `selector: null / resolution: null`, `#assert` wrapper, defect ids via `recordDefect` | `ApiActions`, `src/api/api-actions.ts:70,295,322`; `ApiTransport`, `api-client.ts:44-47` |
| Both instantiation sites a sibling family must join | `SmartRunner` constructor `runner.ts:677-684`; `runApiFlow` `runner.ts:4358-4374` |
| `ApiActions` owns its own `VariableStore` — a sibling would silently get a second, disjoint one | `api-actions.ts:72` |
| `interpolateStep` skips the browser-free set entirely and is shallow anyway — a new family must self-interpolate | `runner.ts:3732-3744` |
| `isBrowserFree` decides by inspecting every step's action | `runner.ts:4286-4289`; the `executeApiSteps` switch has a throwing default `:4315` |
| Exit classification is message-regex; an unrecognised infrastructure error exits 1 ("the app is broken") | `src/cli/exit.ts:35-75`; `BrowserGoneError` is the precedent for typing one apart |
| Blocked ≠ failed: `neverRan` → `CaseOutcome.verdict 'blocked'` → `EXIT.environment` | `exit.ts:79-134` |
| The redaction key heuristic exists but is module-private | `SENSITIVE_KEY_PATTERNS`, `src/api/redact.ts:48-67` |
| `Ingester` contract; `meta` is flat `Record<string,string>`; crash containment; edges to unindexed endpoints are pruned, not guessed | `src/context/types.ts:57,20-28`; `context-engine.ts:303-311,196-208` |
| The OpenAPI ingester as template: conventional discovery, silent no-op when absent, warnings never throws, zero edges emitted | `openapi-ingester.ts:34,236-240,311` |
| A generator reads its inventory by filtering nodes by kind — not by the route-centred BFS | `ApiTestGenerator.operations()`, `api-test-generator.ts:403-408` |
| `MutationPolicy` is enforced structurally, twice, and DELETE appears at no tier | `POLICY_METHODS`, `api-test-generator.ts:56-60` |
| `VariableStore.snapshotForReport()` is written and has zero call sites | `variables.ts:104` |
| `DefectCategory` is five members; tier attribution assumes exactly two sides and asserts `frontend.defects + backend.defects === defects` | `proof-bundle.ts:147-166,317-318,767-787`; `Owner`, `verdict.ts:23` |

## The seam: `DbClient`

Everything below sits behind one injectable interface, `ApiTransport`-shaped, because that is the rule that let the whole suite run offline and survived a provider migration:

```ts
export interface DbClient {
  readonly id: string;                                   // 'pg', 'stub'
  query(sql: string, params: readonly unknown[]): Promise<DbResult>;
  introspect(): Promise<DbSchema>;                       // information_schema read
  close(): Promise<void>;
}
export interface DbResult { rows: Record<string, unknown>[]; rowCount: number; durationMs: number }
```

- **Drivers are lazy optional imports, not dependencies.** `pg` first (v1 is Postgres-only; dialects differ exactly where this design is strict — identifier quoting and introspection SQL — so each lands behind its own client). A missing driver throws typed `DbUnavailableError` naming the install command; the exit contract maps it to `EXIT.environment` and `runCases` scores the case **blocked, never failed** — the same "a provider fact, not a page fact" wording discipline the healer uses. The role-key degradation pattern, applied to a package.
- **The stub client is the unit tier.** Scripted results, $0, offline — the `HealerModel` argument verbatim. A real disposable Postgres sits behind `WOWLIDATOR_DB_TESTS=1`: gated rather than auto-skipped, because touching a real database "should not run unasked" is the shell-tier reasoning, and it applies here with more force.
- **The DSN travels by env only** (`WOWLIDATOR_DB_URL`), never argv — a connection string on a command line is in `ps` for every process on the machine. It is masked everywhere it is displayed (the `keys.ts` mask discipline) and never reaches a bundle.
- **A non-loopback host requires `--db-remote-ok`.** The `--no-sandbox` reasoning: defaults protect the machine nobody was thinking about, and "I am pointing a test tool at a remote database" is a sentence someone should have to say out loud.

## Read-only, enforced structurally

A prompt instruction is a request; a filter is a guarantee. Three independent layers, any one of which suffices:

1. **wowlidator never accepts SQL from a flow in v1.** Every assertion compiles to a parameterized `SELECT` that wowlidator itself builds: identifiers are validated against the ingested/introspected schema (a table or column not in it is **refused** — grounding and injection defense in one move, since identifiers never come from run-time strings and values always travel as parameters). A raw `dbQuery` escape hatch is explicitly deferred; if it ever lands it is SELECT-gated and opt-in.
2. **The session is opened read-only** (`default_transaction_read_only = on`), so even a bug in layer 1 cannot write.
3. **The documented setup is a read-only DB grant**, so even a bug in layer 2 cannot write.

Seeding is real and stays out of v1: a `db-seed` policy tier (mirroring `MutationPolicy`'s shape and its structural enforcement) may later allow `INSERT` into declared tables in `setup` only, with teardown permitted to `DELETE` **exactly the rows it inserted, by captured primary key** — the one defensible delete. `UPDATE`, `TRUNCATE`, `DROP`, and any other `DELETE` appear at no tier. Until then, the shipped answer to "the test needs a resource" remains what `CLAUDE.md` already says: create it with a `request` step, visibly, in the flow.

## Design

### 1. Schema in: the sixth ingester

`SchemaIngester` (`src/context/ingesters/schema-ingester.ts`), id `'schema'`, following the OpenAPI ingester's exact manners:

- **Sources**, first match wins: explicit `--db-schema <file>`; else conventional discovery (`schema.prisma`, `schema.sql`, shallowest path — the `SPEC_FILE_RE` pattern); else, when `WOWLIDATOR_DB_URL` is set, **live introspection** through `DbClient.introspect()`. Introspection outranks file parsing wherever a connection exists: the database is the source of truth, and "never assert a table we did not observe" beats any parser. File-only mode (no credentials) still enables planning and generation — the `--claims-only` symmetry: what would be checked, without touching anything.
- **Parsers are narrow and refuse what they cannot read.** SQL DDL subset (`CREATE TABLE`, columns, types, PK/FK); Prisma model blocks. Anything else in the file becomes a warning naming the construct, never a guess — the `$ref`-outside-the-document rule.
- **Emits `table` nodes** — `id: table:orders`, new `ProjectNodeKind` member `'table'` (the `operation` kind's design note at `types.ts:12-17` is the precedent for a new kind over an overloaded one), `meta` flattened to delimited strings as `meta` requires: `columns: "id:uuid pk · status:text · user_id:uuid fk>users.id"`, plus `pk`, `source: ddl|prisma|introspection`, `capturedAt` for introspection. FK relationships become `table → references → table` edges (new `ProjectEdgeKind` member; `describeEdge`'s `default` arm degrades safely).
- **Zero `covers` edges from the ingester.** A flow that ran `expectDbRow orders` is linked by extending `linkCoverage`: test nodes gain `meta.checks` (`"orders"` list, the `meta.calls` encoding) so the graph answers "does anything verify this table?" exactly as it answers it for endpoints. Statically mapping *operations* to tables is not attempted — that requires reading server source this index may not contain, and an edge that cannot be verified is dropped, not guessed.
- **Known inherited hole, disclosed:** the cache signature covers only walked files (`computeSignature`, `context-engine.ts:73`), so an out-of-tree DDL or a changed live schema does not invalidate the cache — the OpenAPI ingester has the same hole today. Introspection results carry `capturedAt`; `--force` refreshes.
- **Reachability caveat:** `toPromptContext` BFSes outward from a matched route, so `table` nodes will rarely reach the *page* generator's prompt — and do not need to. The DB authoring inventory is read the way `ApiTestGenerator.operations()` reads its own: filter nodes by kind, cap, describe.

### 2. State verification: the step family

`DbActions` (`src/db/db-actions.ts`, new) — `ApiActions`' sibling, same constitution: `{ client, bundle, variables, redaction, recordDefect }`, a `#record` that writes `selector: null, resolvedSelector: null, resolution: null`, a `#assert` wrapper, and the module invariant *nothing here touches `Page`*. Instantiated at both sites (`SmartRunner` constructor, `runApiFlow`). All four actions join `BROWSER_FREE_ACTIONS` and `BACKEND_TIER_ACTIONS` (refactor R1, defined in the sequence spec): a flow of `request` + DB checks runs without ever opening Chrome, and its findings land on the backend side of the report.

```jsonc
{ "action": "dbSnapshot",        "tables": ["orders", "audit_log"], "as": "before" },
{ "action": "expectDbRow",       "table": "orders",
  "where": { "id": "{{orderId}}" },
  "values": { "status": "pending", "user_id": "{{userId}}" },
  "timeoutMs": 10000 },
{ "action": "expectDbDelta",     "table": "orders", "since": "before", "delta": 1 },
{ "action": "expectDbUnchanged", "tables": ["users"], "since": "before" }
```

- **`dbSnapshot`** records per-table row counts under a name. `expectDbDelta`/`expectDbUnchanged` **require** a named prior snapshot and fail loudly without one ("no snapshot to diff against — add `dbSnapshot` to setup"): explicit beats an implicit run-start snapshot that would need a connection and a table list before the flow said anything.
- **`expectDbRow` polls through its budget** — a 200 from the API does not mean the write landed; queues exist. Same shape as `expectText`'s polling; `polledMs` is recorded on the step so the report shows eventual-consistency cost. No timing defect in v1 — the budget here is an author-declared consistency allowance, not the selector ladder's drift signal.
- **`expectDbUnchanged` is the underrated half** — "the journey wrote the order and touched nothing else" catches the accidental-write class nothing else can. v1 is count-based, and a same-count `UPDATE` is invisible to it: **disclosed on the step's detail**, not implied away. The statement tier (§3) is the honest upgrade path, not a checksum arms race.
- **Variable-keyed `where` is the causal upgrade.** "Row changed while the flow ran" is correlational on a shared database, and every message says so (the "while this step was waiting, never because of" rule). But a row keyed by `{{orderId}}` — an id the run itself received from the API — is causally tied to this run; the compiler and prompt always prefer it. This is the deliberate payoff of refactor **R2: one shared `VariableStore`**, created by the owner and injected into both `ApiActions` and `DbActions` (today `ApiActions` news up its own at `api-actions.ts:72`; a second store would make `{{orderId}}` mean two different things in one flow).
- **Naming buys correct classification for free:** `expect`-prefixed actions read as `failed` (an app fact); `dbSnapshot` failures read as `error` (an environment fact) — `classifyStepFailure`'s existing rule, unmodified.
- **Evidence is capped and redacted before it exists in a bundle.** New `redactRow()`: column names run through the exported key heuristic (refactor **R3: export `SENSITIVE_KEY_PATTERNS`** or a `maskKey()` from `redact.ts`); evidence is the matched rows only, capped (`DB_EVIDENCE_MAX_ROWS = 3`); an unrecognisable binary column becomes its size and type — "never emit a payload we could not inspect", pointed at tabular data, where the PII odds are strictly worse than HTTP bodies. A `ProofStep.db` field (`DbCheckRecord`: table, kind, redacted where-summary, expected, observed sample, `durationMs`, `polledMs`) mirrors the `request`/`network` split — singular, the check this step made. Required test, mirroring the bearer-token one: a value from a column named `password` cannot survive into rendered HTML.
- **Refactor R4:** wire the already-written `VariableStore.snapshotForReport()` (`variables.ts:104`, currently zero call sites) into diagnostics, since DB checks make saved variables load-bearing evidence.

### 3. "Called as planned": the interaction tier

From the browser: **cannot** — full stop, and the design never fakes it with state checks wearing interaction wording. With cooperation, two techniques, phased:

**3a. Statement-statistics deltas (lighter — phase 3).** `pg_stat_statements` is readable over the *same read-only connection*: `dbSnapshot` additionally captures `(queryid, normalized query, calls)`, and a new `expectDbCalled { match: "INSERT INTO orders", delta: 1, since: "before" }` compares. Catches "the INSERT ran once", "the SELECT ran 51 times" (the N+1 storm), and "nothing ever wrote to `users`" — at statement granularity, with three disclosed limits stated in every message it produces: it requires the extension enabled (absent → **blocked**, an environment fact); statements are normalized, so values are invisible; and on a shared database the delta is **correlational** ("while this flow ran"). Postgres-only, which is one more reason v1's client is.

**3b. OTel trace ingestion (heavier, causal — phase 4, joint with the sequence spec).** The application under test runs with standard OpenTelemetry auto-instrumentation — a config-level ask on dev/staging, no app code changes on Node/Java/Python — exporting to a receiver wowlidator runs for the duration: a small OTLP/HTTP (JSON) listener on `127.0.0.1`, Host-checked, the control panel's server discipline. Correlation is earned at the browser: CDP `Fetch.enable` header injection stamps/records `traceparent` on the page's own requests, so each server span tree — including `db.system`/`db.operation`/`db.sql.table` spans — joins to the exact UI action that provoked it. That makes both this spec's "called as planned" **causal** and the sequence spec's backend→DB lane an assertion instead of an assumption.

Two rails keep 3b honest: **a canary check** — the run's first observed request must yield at least one server span, else every trace-based claim in the run is *blocked*, not failed (absence of spans is not absence of calls until instrumentation is proven live; the `cdpDrivable` "readiness is proved by takeover" rule); and **`db.statement` values are redacted** through the existing body rules before storage. Protobuf-encoded OTLP is refused politely naming the JSON encoding — one wire format, parsed with the discipline `extract.ts` applies to containers.

Considered and rejected for now: query-log tailing (assumes file access wowlidator does not have) and a wire-protocol proxy (maximally invasive, and 3a+3b bracket its value from both sides).

### 4. Authoring from claims, grounded

No new model role and no new generator class. When the graph holds `table` nodes and a claim implies persistence ("the order is saved"), `FlowAuthor`'s prompt gains a labelled table-inventory section (kept apart from the AX tree, the probe-report separation) and may emit DB steps — flat authored forms (`where: "id = {{orderId}}"`, narrowed and schema-validated in `toFlowStep`; an undeclared table or column is refused and fed back through the one informed re-ask). No schema indexed → the prompt never mentions DB steps and the author cannot produce one: enforcement by construction, the `MutationPolicy` inventory-filter move. `wowlidator doctor` gains a `db` line when `WOWLIDATOR_DB_URL` is set — one `SELECT 1`, the "make a real one-token call" philosophy applied to a socket.

### 5. Attribution and the report

DB findings file under category **`backend`** with detail naming the table — a write that did not land is the server's defect, routed to the team that owns it; the five-member `DefectCategory` union, the two-sided `Owner` type (`verdict.ts:23`), and the `frontend + backend = defects` invariant (`proof-bundle.ts:317-318`) all survive v1 untouched. A third `data` tier is a deliberate later decision with its cost named now: a third `TierSummary`, a wider `Owner`, and every reconciliation test.

## Changes, per module

- **D1 · `DbClient` seam + `pg` client + stub** (`src/db/client.ts`, new) — lazy import, typed `DbUnavailableError`, read-only session, remote-host guard, introspection SQL.
- **D2 · `DbActions` + statement builder** (`src/db/db-actions.ts`, new) — the four state actions, schema-validated identifier allowlist, parameterized SELECT construction, polling, self-interpolation via the shared store.
- **D3 · Refactors R1–R4** (shared with the sequence spec; whichever lands first carries them): action-set split (`proof-bundle.ts`), shared `VariableStore` (`runner.ts:677-684`, `:4358-4374`), exported key heuristic (`redact.ts`), `snapshotForReport` wiring.
- **D4 · `redactRow` + `DbCheckRecord`** (`src/db/redact-row.ts`, `proof-bundle.ts`) — plus the reporter's rendering and `GLOSSARY` entries (the no-badge-without-an-entry test enforces this).
- **D5 · Exit contract** (`src/cli/exit.ts`) — `DbUnavailableError`/unreachable-DB messages into the environment arm; `neverRan` already scores the suite outcome right once the classification is right.
- **D6 · `SchemaIngester`** (`src/context/ingesters/schema-ingester.ts`, new) — plus the full option plumb, mirroring `openapi` exactly: `ContextEngineOptions.dbSchema`, the constructor array (`context-engine.ts:258-264`), `cmdContext`/`cmdGenerate`, CLI flag table + `CliOptions`, `usage.ts`, MCP `get_project_context` (`dbSchema` param, `tables` list beside `routes`/`operations` at `server.ts:539-545`), UI `commands.ts` `context-build` field, `index.ts` exports.
- **D7 · `linkCoverage` extension** (`context-engine.ts`) — `meta.checks` on test nodes, `covers` edges to `table` nodes, FK `references` edges rendered by `describeEdge`.
- **D8 · Authoring integration** (`flow-author.ts`) — `AUTHOR_ACTIONS`, flat forms, narrowing, prompt section, feedback re-ask wiring; MCP `flowStepSchema` arms for all five actions.
- **D9 · `expectDbCalled` via `pg_stat_statements`** (`src/db/`) — snapshot extension, delta matcher, blocked-when-absent.
- **D10 · OTLP receiver + `traceparent` injection** (`src/trace/`, new; `runner.ts` CDP wiring) — joint with sequence phase 4; canary rail; span redaction.

## Test plan

| Tier | Covers |
|---|---|
| Unit ($0, always) | DDL/Prisma parsers against fixtures written by real `pg_dump` and real Prisma (the "reader tested only against its own writer proves nothing" rule); statement builder — undeclared identifier refused, values parameterized; delta math; `redactRow` — the password-column test; blocked classification for missing driver/extension; flat-form narrowing; OTLP JSON parse + canary logic against stored payloads. |
| DB (`WOWLIDATOR_DB_TESTS=1`, gated) | Disposable Postgres: introspection matches DDL fixtures; polling rides out a delayed write; the read-only session refuses an injected write attempt (asserting layer 2 catches a hypothetical layer-1 bug); `pg_stat_statements` deltas count a real INSERT. |
| Browser + DB | One hybrid flow: UI click → `request`-saved `{{orderId}}` → `expectDbRow` keyed by it — the causal chain end to end. |
| Real application | Invariants only: a configured schema introspects; a variable-keyed check resolves; never business content. |

## Rollout order

1. **D3** — shared refactors, unit-tier, zero behavior change.
2. **D1, D2, D4, D5** — the state tier, hand-authored flows. This alone delivers **"modified as planned"** and the hybrid UI→API→DB proof chain.
3. **D6, D7, D8** — schema in, coverage answers, authored DB checks. Delivers "inputting a database schema into the tester".
4. **D9** — statement deltas: **"called as planned"**, correlational tier.
5. **D10** — traces: "called as planned", causal tier; unlocks the sequence spec's remaining lanes in the same release.

**Acceptance:** with `WOWLIDATOR_DB_URL` set and a schema indexed, a checkout flow that clicks through the UI, saves `{{orderId}}` from the API's response, and asserts `expectDbRow orders where id={{orderId}} values status=pending` goes green with the matched row (redacted) in the report and `users` proven count-unchanged; the same flow with the driver uninstalled reports **blocked** with the install command, exit 3, filing nothing against the application; and a deliberately broken backend that returns 201 without writing turns exactly one check red — the DB row — with the failure filed as `backend`, worded "while this flow ran", and the API's 201 still recorded as passing, because which side is broken is the question this whole tier exists to answer.
