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
npm run cli -- context build --db-schema ./schema.sql  # index tables too (or schema.prisma; with WOWLIDATOR_DB_URL set and no file, the live schema is introspected)
npm run cli -- catalog order.mmd --claims-only         # a sequence diagram is a catalog: one claim per message, no model call
npm run cli -- generate --api                          # write API tests from that spec (policy defaults to forms)
npm run cli -- run checkout.api.json                   # browser-free: never opens Chrome
npm run mcp           # serve MCP over stdio
```

Single test:

```bash
npx tsx --test --test-name-pattern "heals a drifted" tests/smoke.test.ts
npx tsx --test --test-name-pattern "navigates two interstitials" tests/full-workflow.test.ts
```

`tests/smoke.test.ts` covers v1 (cache, ladder, healer contract). `tests/full-workflow.test.ts` covers v2 (generation, agent, reporter). `tests/context-engine.test.ts` covers the context engine — entirely unit-tier, since it's file-walk-and-parse with no model or browser involved. `tests/mock-data.test.ts` covers mock data — `mock-data.ts`/`LlmDataModel` at the unit tier, the `fillRetry` loop at the browser tier (needs a real page). `tests/modal.test.ts` covers modal/dialog detection — entirely browser-tier, since detection is `Locator`-based with nothing to unit test in isolation. `tests/flow-repair.test.ts` covers runtime script evolution — `LlmFlowRepairModel`'s schema-narrowing contract at the unit tier, `FlowRepairLoop` against a real browser at the browser tier via a scripted stub (no LLM key needed, same reasoning as `modal.test.ts`). `tests/api.test.ts` covers backend testing across both tiers: redaction, call classification, variables, OpenAPI ingestion and API generation are pure functions and run always; the ladder's backend rung and session inheritance need a real page making real requests. `tests/selector-case.test.ts` covers accessible-name case — `relaxRoleName` and the narrowing/attribution call sites are pure and run always; proving Chrome's and Playwright's accessible-name implementations actually disagree needs a real browser and a `text-transform` fixture. `tests/compose.test.ts` covers `use`/`when` — expansion is pure and runs always, branch selection needs a real page. `tests/page-probe.test.ts` is entirely browser-tier, including the test that asserts a destructive button is never clicked. `tests/cli.test.ts` drives the CLI as a subprocess — exit codes, stdout purity, `--json` parseability — importing nothing, because none of that is observable from inside. `tests/mcp.test.ts` drives the MCP server over real stdio for the same reason: an in-process harness cannot see the protocol stream being polluted. `tests/video.test.ts` covers video evidence — frame sizing, mode parsing, per-step offsets, container trimming (against a real Playwright recording in `tests/fixtures/`, on the same "a reader tested only against its own writer proves nothing" rule as the `.xlsx` and `.pdf` there) and the report's video block are pure and run always; that Playwright records at all over CDP and that a pointer appears in what the browser composites are facts about a real browser, and both were wrong in an early version with nothing at the unit tier able to catch either. `tests/verdict.test.ts` and `tests/machine-report.test.ts` are pure. `tests/form-actions.test.ts` covers the form interaction actions (`selectOption`/`check`/`uncheck`/`type`) — the vocabulary contract and `toFlowStep` narrowing at the unit tier; that a native select, a custom listbox, an ARIA toggle and a per-keystroke field actually respond is browser-tier, because "fill fires no per-key keydown" is a fact about a real browser. `tests/sequence.test.ts` covers sequence-diagram testing — the Mermaid/PlantUML parser, plane classification and the deterministic claims path are pure (fixtures written in the shape the real tools emit, the `.xlsx` rule again), as are the ordered-subsequence matcher and the flat authored form; `expectCalls` against live traffic needs a real page firing real requests and is browser-tier, including the proof that observation-off classifies as environment rather than an app failure. `tests/db.test.ts` covers database verification — the state checks, grounding refusals, redaction (a password column value cannot survive into rendered HTML) and the browser-free hybrid flow run against a scripted `DbClient` stub, always; whether real Postgres accepts the generated SQL and refuses a write on the read-only session is the gated `WOWLIDATOR_DB_TESTS=1` tier, gated rather than auto-skipped because touching a real database should not happen unasked. `tests/schema-ingester.test.ts` is entirely unit-tier, same reasoning as `context-engine.test.ts`. `tests/catalog-report.test.ts` covers the catalog report — the render is pure and runs always; that an embedded recording actually plays is a fact about a real browser (Chrome refuses a `data:` video silently, which is why the Blob indirection exists) and is CDP-gated. `tests/data-locks.test.ts` covers the step-level data locks — window computation is a pure walk over a flow and the lock is an in-memory queue, so it is entirely unit-tier, the same reasoning as `context-engine.test.ts`. `tests/wowlidator-sh.test.ts` and `tests/e2e-app.test.ts` are the two gated tiers above. All twenty-one use the same tiering.

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
- Stopping is judged by logic, not a turn count (2026-08-24; was a hard ceiling of 8, then 12): finish/fail, arriving at the goal's destination, a stall (an ok *page-changing* action repeated on an unchanged page — a repeated `wait`/`scroll` is let through instead, as a turn that advances nothing), `AGENT_NO_PROGRESS_TURNS` consecutive turns in which nothing advanced (failures and idle actions alike; five, since 2026-08-25 — three was tuned for an 8 s miss and became four times stricter once misses failed in 1.5 s), and a model failure each end the loop. A consent gate met on any turn — not only before the first — is cleared without a model turn and the agent returned to the page its goto asked for — and none of them can end a journey that is actually advancing. `maxSteps` / `WOWLIDATOR_AGENT_MAX_STEPS` reinstates a hard ceiling (the capture pilot keeps its own short one); `AgentRecord.maxSteps` is null when the run was unbounded.
- `allowedOrigins` — defaults to the origin it started on, so a confused agent cannot wander onto the public internet.
- History is passed as a **snapshot** (`[...history]`). Passing the live array lets a model implementation observe mutations after the fact.
- `run()` never throws. Failure is reported in the record so the report can show what was attempted.

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

## Where the subsystem guidance lives

The deep sections of this file moved (2026-08-24) into per-directory CLAUDE.md
files, loaded automatically when you work with files under that directory —
same authority as this file, just paid for only when relevant:

- `src/api/CLAUDE.md` — Backend testing; Sequence and database verification
- `src/browser/CLAUDE.md` — Browser lifecycle
- `src/catalog/CLAUDE.md` — Catalogs
- `src/context/CLAUDE.md` — Understanding a page beyond its first render; The capture pilot; Retrieval and the token bill; Repository context engine
- `src/coverage/CLAUDE.md` — UI coverage
- `src/crawl/CLAUDE.md` — Crawling
- `src/data/CLAUDE.md` — Mock data and `fillRetry`
- `src/engine/CLAUDE.md` — The escalation ladder; Composition and control flow; Scrolling and history; Modal and dialog detection; The agent rung; Losing the session; The session bootstrap; Consent-gate recovery; Bare-role selectors; Accessible-name case; In-run step reconstruction; Keyboard and focus
- `src/generator/CLAUDE.md` — The authoring review; Authoring rails from a hand-authored comparison; Claim-fidelity rails; Negative testing; Boundary-value analysis
- `src/healer/CLAUDE.md` — The healer's echo
- `src/history/CLAUDE.md` — Unattended runs and quarantine; Run history and flake detection
- `src/orchestrator/CLAUDE.md` — What the agent claims is never the evidence
- `src/providers/CLAUDE.md` — Structured output on free tiers; Prompt discipline
- `src/repair/CLAUDE.md` — Runtime script evolution
- `src/reporter/CLAUDE.md` — Reading the report; Proof bundles and the report
- `src/ui/CLAUDE.md` — The control panel; wowUI
- `src/visual/CLAUDE.md` — Visual regression
