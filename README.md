# wowlidator

**UI tests that repair themselves.**

You write a test once. When someone renames a button and the test breaks, wowlidator
looks at the page, works out which element you meant, fixes the selector, and
carries on — then tells you it had to. When you have no tests at all, it reads a
page (or a requirements document) and writes them for you. Every run produces a
self-contained HTML report with screenshots, video, network evidence, and a
plain-language verdict of what broke and which side of the system to blame.

The repo also ships **wowUI** — a local web surface for launching runs and
reading their evidence — started with `bin/wow`.

---

## What it does

| Capability | How |
|---|---|
| **Run tests fast and free** | Plain Playwright over CDP. Full form interaction — dropdowns (native or custom), checkboxes and toggles, key-by-key typing — with no model call on the happy path, ever. |
| **Run suites in parallel, safely** | Cases run up to 8 at a time (`--concurrency`), each in its own browser context. A case that changes data — fills a form, calls a writing endpoint, asserts on the database — always runs alone, and **readers run before writers**, so a suite cannot invalidate its own remaining read-assertions by mutating the state they were authored against (`--sheet-order` keeps the list's own order). |
| **Heal broken selectors just-in-time** | When a selector fails, an LLM reads the page's accessibility tree, proposes a repair, and the repair is verified before it is trusted — then cached so the next run is free again. |
| **Generate tests from a page** | Point it at a URL; a model reads the accessibility tree and writes runnable test cases, each with a real assertion. |
| **Turn documents into test suites** | Feed it a spreadsheet, PDF, Markdown checklist — or a **Mermaid/PlantUML sequence diagram**, read deterministically with no model call; it extracts the document's claims, you approve them, and it writes and runs one case per claim. A sequence diagram **as an image** (png/jpg/webp — an export, a screenshot, a whiteboard photo) or **as a rendered SVG** works too: a model transcribes it to Mermaid text first (pixels for pictures, markup for svg), the transcript is written next to the file for review, and everything after that is the same deterministic path. |
| **Score itself against the sheet** | A test-case table that records its own results (an *Actual Result* column) becomes ground truth: the recorded verdict travels with every authored case, and wowUI shows **accuracy** per catalog — how often wowlidator's verdict agrees with the human's. An error or dead-end run agrees with nothing, and rows the sheet never scored are disclosed, never invented. |
| **Navigate the unknown** | An agent drives the browser through interstitials — consent screens, wizards, redirect chains — one budgeted, origin-checked decision at a time. It stops when logic says stop (arrival at the goal's destination, a stall, consecutive turns without progress) rather than at a fixed turn count, and a successful journey is saved onto the flow file itself, so the next run replays it for $0. |
| **Repair whole test scripts** | `--repair` asks a model for a targeted fix to the failing step (optionally reinvestigating the failure live, or regenerating the script from the failed step onward) and retries — never overwriting your file. |
| **Resume what stopped short** | A suite run keeps a ledger: `--resume` continues from the first case that never started, `--rerun-errors` re-runs the cases the harness ended in error, `--rerun-failed` sends failures back through the repair loop. wowUI shows resumable runs — including ones started from a terminal — with a Continue button. |
| **Test the backend too** | `request`/`expectStatus`/`expectJson` steps share the browser's session; `expectCalls` asserts the traffic the *page* made — order, endpoints, and calls that must never happen; passive network observation tells a frontend failure apart from a 500. Browser-free API flows never open Chrome at all. |
| **Verify the database** | Read-only, schema-grounded checks (`expectDbRow`, `expectDbDelta`, `expectDbUnchanged`) prove the API's 201 is backed by a real row — keyed by the very id the run saved — and `expectDbCalled` counts statement executions via `pg_stat_statements`. No SQL from flows, ever; the driver is optional and a missing one blocks the case instead of failing the app. |
| **Crawl** | Follow every link (and, opt-in, buttons) on a page: does a real page come back, and can you get home again. |
| **Prove it** | Every run emits a proof bundle (JSON) and a single-file HTML report: verdict, timeline, filmstrip, video of the run up to the failure, escalation traces, network calls, coverage, and trend. |
| **Watch, quarantine, report to CI** | `watch` re-runs on an interval and notifies only on transitions; flaky tests can be quarantined explicitly; JUnit/CTRF output for CI. |
| **Integrate** | An MCP stdio server exposes the whole engine to developer tooling; the library is importable (`wowlidator/engine`, `/generator`, `/api`, …). |

**The design rule that holds all of it together:** deterministic execution is
free and always tried first; a model is paid for only at the moment determinism
runs out — and everything a model produces is verified before it is trusted.

---

## Installation

Requirements:

- **Node.js ≥ 22.6**
- **Google Chrome** (driven over CDP; wowlidator starts it for you on its own profile)
- At least one **LLM API key** for the AI features (healing, generation, agent).
  Running existing flows with `--no-heal --no-agent` needs no key at all.

```bash
git clone <this-repo>
cd wowUI
npm install

cp .env.example .env      # fill in the provider keys you actually have
npm run cli -- doctor     # one real call per role — verifies keys and model ids
```

Free-tier keys are enough: every role is re-pointable with two env vars (see
[Configuration](#configuration)), and `doctor` is the only way to know a model
id still resolves — ids drift far faster than code.

---

## Quickstart

```bash
# The browser way — every command as a form, output streaming live:
npm run ui                # control panel at http://localhost:4600
npm run ui -- --wow       # wowUI at /wow: runs, verdicts, and the proof behind them

# The terminal way — one command, start to report:
npm run cli -- go examples/login.flow.json      # a .json is a test → run it
npm run cli -- go https://your-app.test/page    # a URL is a page → write tests for it
npm run cli -- go "check that login rejects a wrong password"   # words → author a test

# Or via the launcher:
bin/wow                   # start wowUI + control panel on :7401
bin/wow go <url>          # same dispatch as above
```

wowlidator starts and recycles Chrome by itself (on its own profile — it never
touches a browser you are personally browsing with). To start one by hand:
`npm run chrome`.

---

## Usage

### Running flows

```bash
wowlidator run examples/login.flow.json
wowlidator run a.flow.json b.flow.json c.flow.json   # several files run as one suite
wowlidator run checkout.api.json               # pure API flow: never opens Chrome
wowlidator run flow.json --repair              # on failure, AI rewrites the flow and retries
wowlidator run flow.json --repair-investigate  # …after an agent reinvestigates the failure live
wowlidator run flow.json --repair-regenerate   # …and may regenerate the flow from the failed step on
wowlidator run flow.json --json                # full proof bundle on stdout, nothing else
```

`--repair` never overwrites your file: each attempt lands beside it as
`<name>.attempt-N.flow.json` plus a human-readable `.patch` explaining what
changed and why. A dead end is reported, not thrown.

### Suites: order, concurrency, resume

A multi-case run (several files, a catalog, a generated suite) is scheduled,
not just looped:

- up to **8 cases at a time** (`--concurrency <n>`; `1` is the strictly
  sequential A/B test for a parallel result that looks wrong), each case in its
  own browser context;
- a case that **changes data runs alone** — two writers interleaved against one
  application produce a report that describes neither;
- **readers run first.** A read-assertion is authored against the data as it
  stood; a suite that creates and deletes records mid-run invalidates its own
  remaining reads. `--sheet-order` keeps the list's own order when the
  sequence itself is what the suite tests.

Every suite writes a ledger as it goes, so stopping is cheap:

```bash
wowlidator catalog cases.xlsx --claims c.json --url <page> --run   # …interrupted
wowlidator catalog cases.xlsx --claims c.json --url <page> --run --resume        # finish it
wowlidator catalog … --run --rerun-errors    # re-run only what the HARNESS broke
wowlidator catalog … --run --rerun-failed    # send real failures back through --repair
```

Cases already proven keep their verdicts; the resumed roll-up carries them in.
wowUI lists resumable runs — including runs started from a terminal — with a
Continue button.

### Writing tests automatically

```bash
wowlidator generate http://localhost:3000/some/page --run   # read the page, write cases, run them
wowlidator generate <url> --probe             # also open ARIA-marked menus first, to see more
wowlidator generate <url> --no-agent-capture  # skip the agent that steadies the page pre-capture
wowlidator generate <url> --context           # feed it the indexed repo (routes, components, tests)
wowlidator generate --api                     # write API tests from an indexed OpenAPI spec
wowlidator author "submitting an empty form shows validation errors" --url <page>
```

Generation is policy-gated (`--policy read-only|forms|mutations`): the default
is `forms` — navigate, read, assert, and submit *empty or invalid* input to
exercise validation (the write is stopped by the very validation under test);
`read-only` never submits anything; `mutations` adds valid writes. DELETE is never generated at any tier. A case
without an assertion is refused — a test that only clicks proves nothing.

### Catalogs: documents → suites

```bash
wowlidator catalog cases.xlsx --claims-only            # step 1: what does this document claim?
# …review/edit the claims JSON it wrote (everything starts approved; untick lines)…
wowlidator catalog cases.xlsx --claims claims.json --url <page> --run   # step 2: prove them
```

Reads Markdown, CSV, HTML, text, JSON, YAML, **Excel and PDF** — and
**sequence diagrams** (`.mmd` Mermaid, `.puml` PlantUML), read deterministically
with no model call: one claim per message. Each approved claim becomes its own
case sharing setup/teardown, so one failure never blocks the rest. The review
gate is deliberate: nothing is authored or run until a person has seen the
claims.

Two columns of a test-case table do extra work:

- **Positive/Negative** states what a case *means* to prove and travels into
  every bundle and report — a negative case still passes by proving the app
  refused.
- **Actual Result** (Passed / Failed / Re-Test Passed / …) is ground truth: it
  is stamped onto each authored case as the sheet's recorded verdict, and
  wowUI's catalog header shows **accuracy** — agreement between wowlidator's
  latest verdict per case and the human's. A run that ended error or dead-end
  agrees with nothing, and rows the sheet never scored count as `unscored`,
  never as either side.

### Backend testing: traffic, sequence diagrams, the database

The boundary rule that shapes all three: wowlidator sits in the browser, so a
claim is checkable exactly to the extent the browser can see it — and anything
past that line is *disclosed as an assumption*, never silently promised.

**Assert the traffic the page makes** — `expectCalls`, in any flow, no setup:

```json
{ "action": "expectCalls",
  "calls":  [ { "method": "POST", "url": "/api/orders", "status": "2xx" },
              { "method": "GET",  "url": "/api/orders/:id" } ],
  "never":  [ { "method": "DELETE", "url": "/api/orders/:id" } ] }
```

Expected calls must appear in that relative order; analytics and polling
interleave freely. It polls out in-flight XHRs, and an absence claim over a
window the ring buffer truncated is **blocked, not passed**.

**A sequence diagram is a catalog:**

```bash
wowlidator catalog order.mmd --claims-only     # one claim per message — no model call
```

Participant lanes are classified (`actor` → user, `database` → external, the
rest flagged as guesses), messages the browser can see become testable claims,
and backend→DB messages come out `testable: false` with the boundary named.
In wowUI's gate the lane table is editable — correct a guessed plane and the
claim list recomputes live. `alt` branches become separate cases.

**Verify the database.** One-time setup:

```bash
npm install pg                                              # optional by design
echo 'WOWLIDATOR_DB_URL=postgres://wowlidator_ro:pw@localhost:5432/app' >> .env
wowlidator doctor                                           # …now also pings the DB read-only
```

Then in a flow (works browser-free too — `request` + DB steps never open Chrome):

```json
{
  "setup": [ { "action": "dbSnapshot", "tables": ["orders", "users"] } ],
  "steps": [
    { "action": "request", "method": "POST", "url": "/api/orders",
      "body": { "sku": "A1" }, "save": { "orderId": "$.id" } },
    { "action": "expectStatus", "status": 201 },
    { "action": "expectDbRow", "table": "orders",
      "where": { "id": "{{orderId}}" }, "values": { "status": "pending" } },
    { "action": "expectDbDelta", "table": "orders", "delta": 1 },
    { "action": "expectDbUnchanged", "tables": ["users"] }
  ]
}
```

Keying the row on `{{orderId}}` — the id this run's own request saved — is what
makes the check causal rather than correlational. The rails, all structural:
wowlidator never accepts SQL from a flow (every check compiles to a parameterized
SELECT against schema-validated identifiers), the session opens read-only, a
non-loopback DSN is refused without `WOWLIDATOR_DB_REMOTE_OK=1`, rows are
redacted before they reach a bundle, and a missing driver or unreachable
database exits 3 and scores **blocked** — never a bug filed against an app the
check never reached. `expectDbRow` polls through a budget, so an async write
is waited out and the wait is on the record. `expectDbCalled` (statement
counts since a snapshot, via `pg_stat_statements`) is the "was it *called*"
tier — statement-level, correlational, and worded so. A failed DB check also
separates "the write was refused" from "no write was ever sent" using the
traffic the page made, before blaming the backend.

**Let authoring write the DB checks** — index the schema once:

```bash
wowlidator context build --db-schema ./schema.sql   # or schema.prisma; with
# WOWLIDATOR_DB_URL set and no file, the live schema is introspected instead
```

Catalog authoring then receives the declared-table inventory and may emit DB
checks against those tables only — with no schema indexed it structurally
cannot emit one.

### Grounding runs in a repository

```bash
wowlidator context build                    # index THIS repo: routes, components, tests — no model call
wowlidator context add ~/code/shop-web      # scan another repo and remember it by slug
wowlidator context list                     # the saved repositories
wowlidator run flow.json --repo shop-web    # ground healing/repair in that repo's reality
```

The context engine is static analysis, not AI: it walks the project for routes,
components, API operations (with `--openapi`) and tables (with `--db-schema`),
and the generator, healer and repair loop read from that index. A saved
repository is matched to a run by origin automatically; an unknown `--repo`
value is a loud error, never a silent skip.

### Crawling

```bash
wowlidator crawl http://localhost:3000/hub
wowlidator crawl <url> --follow-buttons     # opt-in: apps that route from cards/rows
```

Follows each control, checks a real page comes back, checks it can return.
Produces an ordinary proof bundle and report.

### Watching

```bash
wowlidator watch flow.json --every 10m --notify ./notify.sh   # verdict as JSON on stdin
wowlidator watch flow.json --quarantine-flaky
```

Notifies only on transitions (green→red, red→green, newly-flaky) — a
notification that fires every run gets muted.

### Everything else

```bash
wowlidator doctor              # one real call per LLM role (+ a read-only DB ping when configured)
wowlidator cache list|forget   # inspect / invalidate healed selectors
wowlidator recall              # list and re-run saved launches
wowlidator mcp                 # serve MCP over stdio
```

### Exit codes (frozen contract)

| Code | Meaning |
|---|---|
| 0 | Ran to completion, everything passed |
| 1 | Ran to completion, at least one step/case failed — a real result |
| 2 | Could not start: bad arguments, missing file, invalid flow |
| 3 | Could not start: no browser, undriveable Chrome, missing provider key |

CI can tell "the test found a bug" (open a ticket) from "the runner is broken"
(fix the environment).

---

## Flow files

A flow is plain JSON — readable, diffable, and exactly what runs:

```json
{
  "name": "login smoke",
  "baseUrl": "http://127.0.0.1:8781",
  "setup":    [ { "action": "goto", "url": "/" } ],
  "steps": [
    { "action": "fill",       "selector": "#username", "value": "alice", "intent": "the username field" },
    { "action": "click",      "selector": "#signin",   "intent": "the sign in button" },
    { "action": "expectText", "selector": "#status",   "value": "Signed in as alice" }
  ],
  "teardown": [ ]
}
```

`setup` runs first and short-circuits the body on failure; `teardown` always
runs. `intent` is the author's own words, carried verbatim into the report.

**Step vocabulary** (the highlights):

- **Act**: `goto`, `click`, `fill`, `press`, `back`/`forward`, `scrollTo`
- **Forms**: `selectOption` (any dropdown — native `<select>` or custom combobox — by the option's visible label, one step), `check`/`uncheck` (checkbox, radio, or ARIA toggle, verifying the state actually changed), `type` (key-by-key with real keyboard events, for autocomplete/typeahead/masked fields `fill` can't wake)
- **Assert**: `expectText`, `expectVisible`, `expectHidden`, `expectUrl`, `expectCount`, `expectFocused`, `expectTabOrder`, `expectScrollable`, `expectModal`/`closeModal`, `snapshot` (visual baseline)
- **HTTP**: `request` (with `save: { orderId: "$.data.id" }` → `{{orderId}}` anywhere later), `expectStatus`, `expectJson`, `expectHeader`, `expectCalls` (ordered-subsequence + never-claims over the traffic the *page* made)
- **Database** (read-only, schema-grounded — see Backend testing above): `dbSnapshot`, `expectDbRow`, `expectDbDelta`, `expectDbUnchanged`, `expectDbCalled`
- **Compose**: `use` splices another flow file in (with `{{param}}` substitution); `when` branches on `visible`/`hidden`/`enabled`/`disabled`
- **Data**: `fillEach` (boundary tables — every case runs even after one fails), `fillRetry` (regenerate colliding form data; deterministic faker kinds cost \$0, only `custom` asks a model)
- **State**: `setLocalStorage`, `clearStorage`, `workflow` (hand the browser to the agent with a goal)

A flow containing only HTTP and database steps is detected automatically and
runs without a browser — same report, history, and repair loop.

---

## System architecture

Two planes, and the boundary between them is the whole design:

```
┌────────────────────────────────────────────────────────────────────────────┐
│  EXECUTION PLANE — deterministic, $0 per action                            │
│                                                                            │
│  src/engine/    SmartRunner: Playwright over CDP, short timeouts,          │
│                 the escalation ladder, dialogs, video/screenshots          │
│  src/api/       deliberate HTTP + passive network observation,             │
│                 expectCalls sequence assertions over observed traffic      │
│  src/db/        read-only DB verification: schema-grounded row/delta       │
│                 checks, statement counts (lazy optional pg driver)         │
│  src/browser/   Chrome lifecycle: find, start, recycle, never hijack       │
│  src/crawl/     link/button crawling                                       │
│  src/cache/     healed-selector cache (a failing cached repair is deleted) │
└───────────────────────────────┬────────────────────────────────────────────┘
                                │  invoked only where determinism runs out
┌───────────────────────────────▼────────────────────────────────────────────┐
│  CONTROL PLANE — an LLM, behind small injectable interfaces                │
│                                                                            │
│  src/healer/       repairs a selector after it failed        (HealerModel) │
│  src/generator/    writes tests by reading a page          (GeneratorModel)│
│  src/orchestrator/ drives the browser through the unknown     (AgentModel) │
│  src/repair/       rewrites a failing flow file, reviewably                │
│  src/data/         regenerates conflicting form data          (DataModel)  │
│  src/catalog/      document → claims → (human gate) → cases                │
│                                                                            │
│  All via the Vercel AI SDK — provider choice is config, never code.        │
│  src/config.ts routes roles; src/providers/ constructs models lazily.      │
└───────────────────────────────┬────────────────────────────────────────────┘
                                │
┌───────────────────────────────▼────────────────────────────────────────────┐
│  EVIDENCE & SURFACES                                                       │
│                                                                            │
│  src/engine/proof-bundle.ts   what actually happened, per step             │
│  src/reporter/                verdict → timeline → diagnostics, one file   │
│  src/history/                 append-only run history, flake detection     │
│  src/coverage/                which controls the suite actually exercised  │
│  src/ui/                      control panel + wowUI (one server, :4600)    │
│  src/mcp/                     MCP stdio server                             │
│  src/cli.ts + src/cli/        the CLI: entrypoint + commands               │
│  src/context/                 static repo index (routes/components/tests)  │
└────────────────────────────────────────────────────────────────────────────┘
```

### The escalation ladder

Every action walks up to seven rungs, in cost order — six free ones before a
model is ever paid:

1. **fast** — the author's selector, 2 s timeout. A selector that will work works immediately.
2. **case** — same selector, accessible name matched case-insensitively (Chrome and Playwright disagree about CSS `text-transform`).
3. **narrow** — exact-text retry after a strict-mode ambiguity on a `text=` selector.
4. **dialog** — if a cookie banner/modal is blocking the page, dismiss it (ARIA-detected only) and retry the *original* selector.
5. **cache** — a previously healed selector for this page+selector. If it fails, it is deleted, not retried.
6. **backend** — a *stop*: if a request the page made just failed hard (5xx, dropped, auth), don't heal a selector that was never wrong.
7. **jit** — ask the healer. The candidate must resolve to exactly one element before it is trusted, then it is cached.

With `--agent-assist` there is an eighth rung: the agent makes the control
*reachable* (opens the menu, scrolls, waits) — then the author's original
selector is retried exactly as written. The agent never performs the step, and
assertions are never offered to it: a claim an agent made true proves nothing.

Deliberate refusals, because a wrong green is worse than a red:
absence assertions (`expectHidden`, `expectCount: 0`) never heal; `when`
conditions never heal (not resolving *is* an answer); a run bounced to a
sign-in page stops fatally rather than letting the healer "rescue" steps
against the login screen.

### The agent

A `workflow` step hands the browser to the agent with a goal in plain words.
The loop is observe → decide → act, one structured decision per turn, and it is
judged by logic, not a turn counter: it ends on finish/fail, on **arriving at
the destination the goal names** (arriving is finishing — no turn is spent
confirming it), on a stall (a page-changing action repeated against an
unchanged page — a repeated wait or scroll is let through, as a turn that
advances nothing), on consecutive turns in which nothing advanced, or on a
model failure — and none of those can end a journey that is actually
advancing. A consent gate met on any turn is cleared without a model turn.
`WOWLIDATOR_AGENT_MAX_STEPS` reinstates a hard ceiling when you want one.

Safety rails: the agent is origin-locked to where it started, a provider
failure is never filed as an application defect, and **what the agent claims is
never the evidence** — a goal that names a destination is judged by the page
reaching it, and every workflow step records the page's own before/after state
so an unasserted leg is still auditable. A successful journey is folded back
onto the flow file as a script and replayed next run for $0; the model is only
consulted again when the replay stops matching the page.

### The LLM roles

| Role | Job | Default | Override |
|---|---|---|---|
| `healer` | repair a dead selector (small, latency-sensitive) | Groq | `WOWLIDATOR_HEALER_PROVIDER` / `_MODEL` |
| `generator` | write tests / claims / repairs (biggest prompts) | Google Gemini | `WOWLIDATOR_GENERATOR_PROVIDER` / `_MODEL` |
| `agent` | one browser decision per turn | Groq | `WOWLIDATOR_AGENT_PROVIDER` / `_MODEL` |
| `data` | regenerate a `custom` form value | Groq | `WOWLIDATOR_DATA_PROVIDER` / `_MODEL` |

Each role sits behind a one-or-two-method interface (`HealerModel`,
`GeneratorModel`, `AgentModel`, `DataModel`), which is what lets the entire
test suite run offline and what let the project survive a full provider
migration without a call site changing. Models are constructed lazily — a run
that never heals never demands a key. Multiple keys per provider
(`GROQ_API_KEY=key1,key2`) rotate automatically on quota/rate-limit errors,
and wowUI's role panel has a **Check** button per role — the same probe
`doctor` runs — so "does this key have quota this minute" is a click, not a
twelve-case experiment.

### Evidence

- **Proof bundle** (`.wowlidator/proofs/<runId>.json`): per step — how the selector resolved (fast/case/cache/jit/dialog/agent), pass/fail, heal and agent records, screenshot, video offset, network calls. Summaries split frontend vs backend, count token spend, and attribute defects.
- **HTML report**: one self-contained file ("opens off a USB stick"). Verdict first, timeline second, diagnostics collapsed. Everything escaped; secrets redacted before they can reach disk.
- **Video**: runs are filmed by default; the recording is kept only when a step fails — from the start of the flow to the failure — with a page-drawn cursor and step captions. `--video off` restores stills-only (and a session inherited by hand needs it).
- **History** (`.wowlidator/history.jsonl`): append-only; verdicts like `newly-broken` / `still-broken` / `flaky` — and `flaky` outranks pass/fail, because an alternating suite is untrustworthy whichever side the coin landed on.
- **wowUI** (`/wow`): the question the report can't answer alone — *this flow has run eleven times; which run broke it, and what is the proof?* Runs grouped by the authoring pass that produced them, verdict tallies and per-catalog accuracy in the header, every step's runtime against its budget, the healer's proposals and the agent's turns under each run, and hide/rename/sort that never deletes evidence (hiding moves the bundle to `archived/`; moving it back is the undo).

---

## Configuration

Everything is env (or `.env`), validated at startup — a bad provider name fails
on line one, not 30 seconds into a run. The interesting ones:

```bash
WOWLIDATOR_CDP_URL=http://localhost:9222     # where Chrome answers
WOWLIDATOR_REPORT_DIR=…                      # where HTML reports land
WOWLIDATOR_PROOF_DIR=…                       # where proof bundles land
WOWLIDATOR_CACHE_PATH=healed-selectors.json  # the healed-selector cache
WOWLIDATOR_HEADLESS=1                        # window mode (also --headless/--no-headless)
WOWLIDATOR_SCREENSHOTS=all|on-failure|off|auto
WOWLIDATOR_AGENT_MAX_STEPS=…                 # optional hard ceiling on agent turns
WOWLIDATOR_JUNIT_PATH=… / WOWLIDATOR_CTRF_PATH=…   # CI outputs
WOWLIDATOR_DB_URL=postgres://…               # read-only DB verification (env only, never argv)
WOWLIDATOR_DB_REMOTE_OK=1                    # required for a non-loopback database host
```

See `.env.example` for the full annotated list, and run `wowlidator doctor`
after touching any model id — ids drift far faster than code.

---

## Development

```bash
npm test              # unit tests always; browser tests only if CDP is up
npm run typecheck     # src + tests
npm run build         # emit dist/
```

Tests are tiered by cost, and every skip prints its reason:

| Tier | Runs when |
|---|---|
| Unit + contract | always (all model calls mocked, $0) |
| Browser | a CDP endpoint answers at `WOWLIDATOR_CDP_URL` |
| Live model | the healer role's key is set **and** CDP is up |
| Shell / Chrome lifecycle | `WOWLIDATOR_SH_TESTS=1` / `WOWLIDATOR_CHROME_TESTS=1` (they start and kill real Chrome processes) |
| Database | `WOWLIDATOR_DB_TESTS=1` (it talks to a real Postgres, so it never runs unasked) |
| Real application | `WOWLIDATOR_E2E_APP_URL` answers and CDP is up |

Single test: `npx tsx --test --test-name-pattern "heals a drifted" tests/smoke.test.ts`

For the design rationale behind each subsystem — why every rung of the ladder
is ordered the way it is, why absence never heals, why redaction is
load-bearing — see [CLAUDE.md](CLAUDE.md) and the per-directory `CLAUDE.md`
files under `src/`, which document the codebase in depth.
