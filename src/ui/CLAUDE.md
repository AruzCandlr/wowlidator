# CLAUDE.md — the panel server, wowUI, and the Ledger home page

Split out of the root CLAUDE.md (2026-08-24) so this loads only when working under
`src/ui/`. Same authority as the root file; the root keeps the map of the whole system.

## The control panel (`src/ui/`)

`wowlidator ui` (or `npm run ui`) serves a local page that puts every run, every command, every option, the artefacts on disk and a manual in one place. Zero new dependencies: `node:http`, a command whitelist, and a page rendered from a TypeScript module. Since 2026-09-03 the page at `/` is **Ledger** (`ledger-html.ts`, see the section at the end); the command-first panel that used to live there (`app-html.ts`) is gone, and `/wow` still serves wowUI unchanged until it is retired.

**It runs the CLI; it does not reimplement it.** `JobRunner` spawns the same `wowlidator <command>` a person would type and forwards stdout/stderr line by line. A second execution path would be a second thing to keep correct, and the first symptom of it drifting would be a panel reporting a pass the command line calls a failure. Every run displays its own command line for the same reason: what you learn in the panel has to transfer to a script.

**`commands.ts` is the single declaration the forms and the argv builder share.** The page renders its controls *from* the specs and the server validates every submission *against* them, so a flag the UI offers is a flag the server accepts and a flag missing there is offered by neither. Adding a CLI flag to the panel is one entry in that file and nothing else. There is deliberately **no free-text "extra arguments" box** — submissions become an argv array for `spawn`, never a shell string, and a passthrough box would undo the whole arrangement.

**Browser commands are serialised, and refused rather than queued.** Two runs sharing one CDP endpoint interleave their clicks and the resulting report describes neither. Queueing would be worse than refusing: a run that starts ten minutes later against a page that has since changed is not the run anyone asked for.

Three constraints on the server that are load-bearing rather than tidy:

- **It binds to `127.0.0.1` and checks the `Host` header.** Without the header check any page you visit could point its own domain at 127.0.0.1 and drive this server through your browser — the ordinary DNS-rebinding attack on a localhost tool.
- **File reads are confined to known roots** (the working directory, the report and proof directories, the cache file's directory). `resolve()` collapses `..` *before* the prefix comparison, so a path that climbs out fails rather than being normalised into passing. A report viewer that served any path on the machine would be one crafted link away from being an exfiltration tool.
- **The client builds DOM through `el()`, not HTML strings.** Everything it displays — file paths, model reasoning, application text quoted back by a failing step — comes from somewhere else, and `textContent` cannot be talked into executing any of it. The one `innerHTML` is the manual, which is our own static content and says so at the call site.

**Output is buffered, not only streamed.** A page reloaded mid-run rejoins from the buffer (the SSE stream opens with a `replay` event) instead of watching an empty pane. Artefact links are *parsed out of the output* (`  report     /path…`) rather than re-derived, so a new artifact kind announced by a command shows up in the panel without `jobs.ts` knowing it exists.

**The page is one document, same as the HTML report and for a related reason.** `renderLedger()` (and `renderWowUi()`) returns markup, CSS and script together, so there are no asset paths to resolve and it behaves identically under `tsx src/` and after `tsc` has emitted `dist/` — which copies no non-TypeScript files.

`ui` is dispatched in `src/cli.ts` **before** `parseArgs`, because the panel has its own flags (`--port`, `--no-open`, `--wow` — which only decides which of the two pages the browser opens on) and putting them in the shared option table would make them appear valid on every other command, where they mean nothing.

## wowUI (`src/ui/wow-ui-html.ts`, `src/ui/proofs.ts`)

The older layout, at `/wow` (`wowlidator ui --wow` opens it directly), and the script library the Ledger page composes. The retired `app-html.ts` was organised around **commands** — pick one, fill the form, watch it run — which is right for driving a CLI and wrong for the question asked afterwards: *this flow has run eleven times, which run broke it, and what is the proof?* wowUI is GRIM's QA Command Center layout answering that, with wowlidator's nouns in it:

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

**There is no `trustedHtml` here at all.** The retired `app-html.ts` had exactly one `innerHTML`, for the manual; Ledger renders the manual as data instead, so no page on this server has one now. wowUI has no static content to inject and displays nothing but data — selectors, model reasoning, application text quoted back by a failing step — so the escape hatch is simply absent, and there's a test asserting it stays absent.

Two things in `proofs.ts` exist because a bundle is big:

- **The list carries no steps, and therefore no screenshots.** `toCard()` is the projection; `/api/proofs` returns nothing else, and `/api/proofs/<runId>` fetches one run in full only when someone opens it. The page polls, so a list that carried evidence would move megabytes every five seconds.
- **Parsed bundles are cached on `path + mtime + size`.** A changed file has a changed signature, so a stale card is not a failure mode this can have.

**Hide, rename, and sort (2026-08-24).** Hiding a run (`POST /api/proofs/<id>/hide`, the small ✕ on a cycle chip) MOVES its bundle file to `archived/` inside the proof directory — never a delete; the index walk skips that directory, so the run leaves every list while the evidence stays on disk, and moving the file back is the undo (the toast says where it went). Renaming (`POST /api/proofs/<id>/rename`, the Rename button in the run timeline) rewrites `bundle.name` and keeps the ORIGINAL once on `renamedFrom` — set on the first rename, never overwritten — because the flow-file lookup (`flowPathFor`) and anything keyed on the recorded name must still match; the panel renames every cycle of a task together, or a single renamed run would split off as its own row. Sorting is a view preference (`S.sortTasks`, the Latest/Name chips over the run list): by name it sorts scenarios and tasks with `localeCompare(…, { numeric: true })` so PL_06_2 sorts before PL_06_10; nothing on disk moves.

**A run is addressed by `runId`, never by a path from the client.** The fast path is `<proof dir>/<runId>.json` and it is only taken for an id that cannot be a path at all; anything else falls back to matching the id against bundle *contents* found by walking the directory. There is no join of user input onto a directory to get wrong — the same reasoning as `isAllowed`, applied by making the question not arise.

**Polling, not a socket.** A run started in another terminal produces no event this server could push, and the page has to be right about it anyway.

**The resumable-runs record is the ledgers on disk, not the job list** (`ui/catalog-runs.ts`, 2026-08-24). `JobRunner` forgets everything on a panel restart; a catalog run's `<claims>.progress.json` does not, and it carries the run's unique key (`<catalog>@<stamp>`), the plan, every verdict, how it ended and a `launch` record. `GET /api/catalog-runs` scans the two directories claims files land in (`.wowlidator/catalogs/`, `<report dir>/catalogs/`) and the banner renders from it; **Continue testing** posts `{ledgerPath, mode}` to `POST /api/catalog-runs/resume`, which accepts only a path it itself just listed (the same "the question does not arise" shape as addressing proofs by runId), reuses a same-session job's argv when one exists, and otherwise rebuilds the command from `launch` through the `catalog-run` spec — the whitelist still says what runs. The resumed run keeps the run key, so the cases already tested under it are pulled into the resumed roll-up as finished tests (see `src/reporter/CLAUDE.md`), and the group header shows the key beside the pass. CLI-started runs and runs older than the panel appear too — that is the point.

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

**"Is it ready?" is answered by a call, on a click** (`ui/checks.ts`, over `providers/probe.ts`). The catalogue in `models.ts` says an id exists; the key mask says a key is present; neither says the key has quota left for that model this minute, and that is the question people bring to the page before a twelve-case catalog. So each role row has **Check** (and the header **Check all roles**): one real call — "reply with the single word: ok" — through the exact failover path a run takes, and it is the **same probe `wowlidator doctor` runs**, extracted into `probeRole()` so the two surfaces cannot disagree. Rules worth keeping:

- **The verdict is chosen by cause, not by "it failed"** (`classifyProbeError`): `exhausted` (429/402 — wait, or start on another key), `rejected` (401/403 — the key itself), `model-missing` (404 / "not a valid model" — the id in the row), `unreachable` (5xx, socket, timeout, and z.ai's 429-that-says-"overloaded", which is theirs and not the key's), `no-key`, `empty` (answered with nothing — a thinking model that spent its budget; usable, suspicious). Status code first, message second, and the order matters: `isKeyExhaustedError` lumps auth and quota together on purpose (both mean "rotate"), and this is exactly the distinction it does not make. Where the provider states rate-limit headroom (Groq's `x-ratelimit-remaining-tokens` and friends) the tokens left and the reset are shown; a provider that says nothing yields `null`, never a row of zeros.
- **It probes what the next run would get.** `effectiveConfig()` folds the panel's model override and start-key order into a config, and a **fresh `LlmFactory` per check** — so a rotation the probe discovers ("key 1 exhausted, answered on key 2") is reported as a trail, in the key cards' own numbering, and **never applied** to where runs start. That stays the person's click.
- **On a click, never on a poll.** It spends tokens (~10 in). Results are cached per role until re-checked, and `describe()` **drops a result whose provider or model no longer matches the row** — a "ready" about a model the role has since been moved off is the one thing the page must never show. A second click while one is in flight joins it.
- **No key value reaches the page**, including one a provider echoes back in its own error text — `scrubKeys` replaces any configured key with `<key N>`, and URLs (Google's key travels in one) are stripped from every detail line.

The launch modal takes **documents, never a flow** — see [Catalogs](#catalogs-srccatalog). Three modes: **Add Context** stores background and starts nothing, **Add Catalog** reads a document's claims and proves the ones you tick, **Describe** → `go`, which dispatches a URL to generation and a sentence to authoring.

**Nobody picks a flow here, and that is the change, not an omission.** A flow is what wowlidator writes; asking a person to select one made the panel a file browser for an artefact they do not maintain. There is a test asserting no flow selector comes back.

Two capabilities in `commands.ts` exist for this and are worth knowing about before adding a command:

- **`fixedFlags`** — flags a command always carries with no control of its own. `catalog --claims-only` and `catalog --claims <file>` are two panel actions backed by one CLI command, and the flag that distinguishes them stays *in the whitelist* rather than being appended by the server, so what runs is still exactly what that file declares.
- **`repeatable`** — `--context-doc a.md --context-doc b.md`. The UI sends an array and anything else is refused, so a repeatable flag cannot be smuggled in as one string containing a separator.

Uploaded documents land in `.wowlidator/catalogs/` and `.wowlidator/context-docs/` (`ui/uploads.ts`). **The file name is rebuilt, never used** — only the extension survives, and only if the extractor can read it. Deletion has the narrowest rule in the server: a name, in one known directory, with a readable extension, rather than the general roots check, because it is the one operation here that destroys something.

## Two verdict families, one machine taxonomy (2026-08-27)

Every human-facing verdict tag now reads as one of TWO families — the machine statuses underneath are unchanged (exit codes, resume ledgers, quarantine, `--repair` all key off `RunStatus`, and rewriting stored bundles would orphan history): **test-failed** (red) — the subject missed the case's expectation, covering `failed` (a contradicted assertion) and `dead-end` (a control/content the case needed never resolved; surveyed, every dead-end in this workspace was "could not resolve <selector>", which is the page not offering what was expected, not a harness fact); and **system error** (amber) — `error`, the harness or its models breaking internally with no verdict about the application delivered. `verdictFamily`/`familyLabel` in `engine/proof-bundle.ts` are the single rule; `ui/proofs.ts`'s `VerdictKind` collapsed to `passed | testFailed | systemError | needsReview`, wowUI's tallies/labels/drawer captions and the report's status pill + CSS follow it (the report used to paint `error` red — now amber, matching wowUI). `needs-review` (proved-?) deliberately joins NEITHER family: it is a pending pass-shaped result awaiting a human, and painting it amber would misfile it. The mechanism stays visible in the parenthesis — `test-failed (dead-end)` — and the pill's `title` carries the machine status, so nothing is lost, only un-perplexed.

## The usage cap (`src/ui/usage-cap.ts`, `src/providers/usage-cap.ts`, `/api/usage-cap`)

A hard stop at N% of the signed-in session's own windows (2026-08-27). `cost-guard.sh` capped dollars the repo recorded; this caps what the account meters — the session and weekly percentages `claude-quota.ts` reads — so the number on the card is the number Anthropic enforces. The rule is one pure function (`evaluateUsageCap`: the highest reported window against the cap, named), and it is enforced twice: `UsageCapGuard` in the panel polls on the quota TTL, **stops every running job and holds new ones** (`POST /api/jobs` and both resumes answer 409 with the reason) until a person resets it from the Claude session card; and `assertUnderUsageCap` at the top of every claude-cli `doGenerate` refuses the next call in ANY process, worded as a provider refusal so the exit contract files environment, never an app defect. The hold is persisted (`.wowlidator/usage-cap.json`) so a panel restart keeps holding; a reset does not change the settings, so a still-exceeded window trips again on the next tick — the way out is raise, disable, or wait, all named in the popup. Settings live in `.env` (`WOWLIDATOR_USAGE_CAP`, `WOWLIDATOR_USAGE_CAP_PERCENT`; off by default — a cap is a decision) via the same `upsertEnv` the run-script edits use, so a terminal `wow` reads the cap the panel shows. Both surfaces pop an alert dialog once per trip (keyed on the trip's timestamp) — wowUI on every view through `refresh()`, the classic panel on its own 30 s poll — and wowUI toasts once when a window passes 90% of the cap. Honest about reach: the panel kills its own jobs; a terminal run is stopped at its next model call, not mid-step; non-claude providers do not spend the windows and are untouched.

## The Database card (`src/ui/db-status.ts`, `/api/db`)

The fourth sibling of `keys.ts`/`models.ts`/`checks.ts`, asking about the backend runs verify against instead of a model role. Three kinds of knowledge, kept separate on the card (Models & keys page): **configured** — what `WOWLIDATOR_DB_URL` resolves to, masked (`maskDsn`; the password characters never reach the page, same rule as API keys — the page gets host/port/database/user and a `passwordSet` boolean); **probed** — whether it answers, on a click and never on a poll (`GET /api/db` is cheap and pollable, the probe runs only on `POST /api/db/check`: connect read-only, introspect, count tables, close — `doctor`'s db line in-process, and a probe result about a DSN that has since changed is dropped, the same never-show-a-stale-verdict rule as `RoleChecks.describe`); **hinted** — what registered repositories' own files say their database is (`RepoEntry.dbHint`), shown whether or not a DSN is set so a configured DSN pointing somewhere the repo does not name is visible too, with a ready-to-edit suggestion that never includes a password ("add the password yourself; wowlidator never reads one out of a repo").

## The backend toggle, and looking inside a workflow step

**`Field.requiredWhen` and `Field.offFlag`** (2026-08-25) exist for one control between them. `backend` is a boolean on every command that AUTHORS a test (`go`, `generate`, `author`, `catalog-run`):

- `offFlag: 'no-backend'` — the CLI keeps backend testing ON so existing scripts are unchanged, while the panel offers it as opt-IN, which is what a person actually wants in front of them since most runs have no database configured. The panel therefore states its choice in both directions rather than relying on a default the two surfaces disagree about. An **absent** field still means "not stated" and sends nothing: turning the backend off for callers that predate the toggle would be a behaviour change smuggled in through a default.
- `requiredWhen: { field: 'backend', equals: true }` on the Database URL — enforced in `buildArgv` and, for a secret, in `buildEnvOverlay`, because `buildArgv` skips secrets entirely (argv is exactly where a connection string must never appear). Asking here costs nothing; a DB claim with no database is a case that dies ten minutes in.

**A workflow step expands in place.** It is the one step whose work is invisible from its row — the agent took the browser for N turns and the row can only say "workflow" — so the step list carries a `▸ N agent actions` button that unfolds the goal, what the agent reported, its cost, the `settledBy` evidence when a rule settled the step, and the turn-by-turn log, without leaving for the drawer. `agentActionLog` is shared with the drawer's Trace tab so the two cannot drift, and a password-shaped fill shows its length and never its characters. The emailable report folds the same trace into a `<details>`, open by default when the goal was not reached — the case a reader came for.


## newUI (`src/ui/new-ui-html.ts`, `/new`) — 2026-08-27, deleted 2026-09-03

Superseded by Ledger below, which keeps its composition mechanism (`baseScript()`'s exact-match renames), its spec-rendered command form and its manual parser. The rest of this section is history.

The two surfaces as **one page**, built to `docs/one-page-ui-spec.md`. Six anchored sections — Now, Start, Runs and proof, Library, Machinery, Help — a sticky header with the status a person checks before pressing Start (connection, browser free/in use, CDP, roles keyed, the usage-cap gauge; repainted every poll), a search box that filters everything on the page, and no router: `location.hash` is an anchor, and every hash the older surfaces ever wrote still lands (`#history` → Runs in the every-run density, `#keys` → Machinery, `#doctor` → that command's form).

**It composes wowUI, it does not fork it.** `WOW_SCRIPT` ships verbatim as a library — task rows, the checks table, the evidence drawer, the launcher gate, the Models & keys internals — and the functions that decide *where things go* (`render`, `show`, `boot`, `renderSidebar`, `pageHead`) are declared again after it; a later top-level function declaration replaces an earlier one for the whole script. Four base functions are *wrapped* instead (`openLauncher`, `launcherBox`, `post`, `dataSignature`): `baseScript()` renames them with an exact-match replace that throws on the first `GET /new` if the anchor has moved, so a wowUI refactor cannot silently strip the page's behaviour. wowUI's own trailing `boot()` is removed the same way. The tests in `tests/new-ui.test.ts` pin all of this by page string, the way `wow-ui.test.ts` pins wowUI.

What the page adds on top of the base, each traceable to the spec:

- **A fourth launcher segment, More commands** — every `CommandSpec` the three modes do not cover, as a form rendered *from the spec* (`cmdForm`). The 21 shared browser flags sit in four named drawers (Recording / Behaviour / Chrome / Output — `ADV_GROUPS`, with a test that none falls through to "Other options"); a `no-*` boolean renders as a positively worded switch that is ON by default (`POSITIVE`) and sends `{ 'no-heal': true }` only when switched off — the CLI's own absent-means-not-stated semantics, the checkbox the right way up; a `requiredWhen` field is visible and disabled with its gate named, never hidden; a repeatable field is a chip list submitted as an array (the classic panel's one text box was refused by `buildArgv`); `go`'s three-way `target` is three radios. A 400 naming a field in quotes lands on that field; a 409 is a banner with the action it needs. **`run` is not in the list** — it is `Run…` on a flow row or a task row (`openRunForm`, path locked), which keeps the no-flow-selector rule and the feature both.
- **Vocabulary** (`VOCAB`, `verdictChip`, `caseLabel`): the chip shows the plain word (proved after a repair, needs your ruling, stuck, could not run), the tooltip and the Help glossary carry the exact term (`pass**`, `proved-?`, `dead-end`, `error`). The data is never rewritten, only the label.
- **Numbers with denominators**: "3 of the last 7", "55 of 55 on disk", "1 streak(s) · 0 ruling(s) waiting"; the resumable banners are not capped at three (`and N more — show all`); Needs a human scans every proof, not the first twelve.
- **One destructive idiom**: `post()` gates `cache-forget` and `history-clear` through `confirmModal` (`DESTRUCTIVE`), so every button that reaches them gets the same dialog without knowing; rename and resume-from-case use `promptModal` (validated, with a datalist of known case ids) instead of `window.prompt`; Escape closes whatever is topmost, and modals trap focus.
- **History folded into Runs**: filter pills, Latest/Name sort (the one `src/ui/CLAUDE.md` claimed and wowUI never had), and a By flow / Every run density; Failed runs — no proof was produced stays its own list. **Library** is Reports, Flows (the classic editor inline under the row, with an unsaved badge and a discard confirm) and Healed selectors as collapsible cards; **Machinery** is `renderKeys` and `renderRepos` as cards with their page actions lifted into the card head.
- **The manual is data.** `parseManualHtml` turns `manual.ts` into a node tree on the server (tags and `class` only; everything else dropped) and the page builds it through `el()` — so the one `innerHTML` the classic panel needed is absent here, and the no-`innerHTML` test holds for this surface too.

The base file gained one fix while this was built: a workflow step's `▸ N agent actions` used the same `S.openTask` slot as the task around it, so unfolding a step collapsed the task. It is `S.openStep` now, on both wowUI and here.

## Re-authoring and the work queue (wowUI, 2026-08-28)

Each catalog-planned task row carries **Re-author** (clear this case's verdict,
re-author it from its sheet row on the current code, run it — one
`--rerun-case` resume job) and **Queue** (add it to the work queue). The queue
is per-browser (`localStorage` `wow-work-queue`), rendered as a box above the
catalog banners, and **every add, remove and run asks for confirmation
first** — a queue mutation is a spend decision, and the confirm is where it is
made (`window.confirm`, wowUI's existing `window.prompt` idiom). Run queue
groups queued ids by the newest catalog run that plans them (`CatalogRunEntry.
planned`, added for this) and posts one `mode: "cases"` resume per ledger; ids
no run plans stay queued with a toast. Server side: both resume routes accept
`mode: "cases"` + `caseIds` (plan-id shape enforced), mapping to the
repeatable `--rerun-case` flag the catalog-run spec declares.

## The Machinery run gates (`src/ui/gates.ts`, 2026-08-28)

The Machinery card carries a **Run gates** block: scenario gate
(`WOWLIDATOR_SCENARIO_GATE`, new — off lets every row author as fast as the
pool allows), data sections, queue governor, pre-run risk judge, system-error
diagnosis, auto-review judge. One mechanism, the `persistUsageCap` pattern: a
flip writes `.env` AND `process.env`, so the NEXT spawned job inherits it — a
suite in flight keeps the gates it launched with, and the card says so. The
allowlist in `gates.ts` is the boundary: `/api/gates` edits those vars and no
others. Tests: `tests/gates.test.ts`. Beside the toggles sit the **dials**
(numeric settings, same contract): rows authored at a time
(`WOWLIDATOR_AUTHOR_CONCURRENCY`, the `authorWorkers` default — an explicit
`--author-concurrency` still wins and a serial provider stays at 1) and
authoring attempts per row (`WOWLIDATOR_AUTHOR_ATTEMPTS`, the
`FlowAuthorOptions.attempts` fallback — also a per-run field on the catalog
form, `--author-attempts`).

## The spec? chip (2026-08-31)

`ProofCard.specQuestion` mirrors `bundle.specQuestion`: a needs-review whose
disputed expectations all quote the sheet's own wording while the page renders
it differently. wowUI's task row shows a dashed `spec?` chip (`specTag`) with
the explanation in its tooltip; newUI inherits it through `WOW_SCRIPT`. It is
a triage marker for the BA, never a verdict — the run stays needs-review.

## newUI unwired; /wow is the responsive surface (2026-08-31)

The `/new` route and `ui --new` flag were removed at the user's request; the
module and its test were deleted on 2026-09-03 once Ledger took `/`. wowUI's ≤900px
media query now keeps navigation: the sidebar becomes a sticky, horizontally
scrolling top bar (labels/footer hidden) instead of `display: none`, tables
get `display: block; overflow-x: auto` so the page never scrolls sideways,
and the evidence drawer takes the full viewport width.

## The catalog report in the panel (2026-09-02)

A catalog run's report exists from the run's first moment (see
`src/reporter/CLAUDE.md`, "The report is live"), so the panel offers it
wherever the run is named: a **Report** button on the proof group head beside
the run-key chip, on the resumable-run banner, and on a running catalog job.
`catalog-runs.ts` adds `reportFile` to each entry — the file's name under
`reports/` when it exists on disk — and the button opens
`/reports/<file>`, a route that serves the `reports/` folder AS a folder (one
sub-folder deep, extension-typed: html, xlsx, webm). Not `/view?path=…`: the
report links its per-case workbooks and recordings RELATIVELY so the folder can
travel whole, and a relative link resolved against `/view` lands nowhere. The
per-case `Export (Excel)` buttons inside the report therefore work from the
panel exactly as they do from the file on disk.

## A resume never runs without the account's password (2026-09-02)

The `--as` password rides the job's env and is never written to the ledger. A
resume in the SAME panel session inherits it from the prior job's `secretEnv`;
after a panel restart there is no prior job, and the resume used to replay the
argv alone — a run that authored login-only flows (every journey capture bounced
to the sign-in page), refused six rows, and failed the rest at "Sign in".
The ledger's `launch` now records the `persona` (email only); when a rebuilt
resume has no `WOWLIDATOR_AS` from a prior job, the request or the panel's env,
`/api/catalog-runs/resume` answers 409 `{ needsCredentials, persona }` instead
of starting the job. wowUI's `resumeCatalog` catches that, asks for the
password once (`window.prompt`, the panel's idiom for a spend decision) and
re-posts with `as: "<persona>:<password>"`, which becomes the job's secret env.
The resumable-run banner says which account the run signs in as. Test:
`tests/resume-credentials.test.ts` (real server, temp cwd, the 409 path only —
the 201 path spawns a real run).

## Ledger — the home page at `/` (`src/ui/ledger-html.ts`, 2026-09-03)

The redesign chosen from three prototyped directions ("Ledger", "Bench",
"Board"): keep the GRIM tokens and IBM Plex Sans Thai, remove chrome, not
features. A top bar with six tabs — Runs · History · Learned · Machinery ·
Commands · Help — the status a person checks before pressing Start (connected,
browser free / in use, CDP, roles keyed, the usage cap) repainted on every poll,
one 1120px column, and the evidence drawer as a 520px side sheet (full width on a
phone, where the tabs become a scrolling row under the brand and Start).

**It composes wowUI, it does not fork it.** `WOW_SCRIPT` ships verbatim as a
library; the functions that decide *where things go* (`render`, `show`,
`renderSidebar` — now the top bar — `pageHead`, `renderRuns`, `statsStrip`,
`attentionItems`, `renderAttention`, `boot`) are declared again after it, and two
base functions are wrapped (`post`, `dataSignature`) through `baseScript()`'s
exact-match renames, which throw on the first `GET /` if an anchor moved.
Anything wowUI fixes in a task row, the checks table, the drawer, the launcher or
Models & keys is therefore fixed on both pages at once. `tests/ledger-ui.test.ts`
pins the page the way `wow-ui.test.ts` pins wowUI.

What Ledger adds over `/wow`, and where it lives:

- **Commands** — every `CommandSpec` except `go`, `catalog-*` and `run` (the
  launcher and the row buttons own those), as a form rendered from the spec:
  a `no-*` boolean is a positively worded switch ON by default (`POSITIVE`), the
  advanced browser flags sit in four named drawers (`ADV_GROUPS`, with a test
  that every advanced flag across every command is placed), a `requiredWhen`
  field is visible and disabled with its gate named, a repeatable field is a
  chip list submitted as an array, a secret is a password box, and the command
  line the form would run is shown under it (`commandLineFor`, a preview — the
  server still builds the real argv from the same spec, and secrets are named
  as env, never shown). A 400 naming a field in quotes lands on that field.
  `#doctor` and every other command id still open that command.
- **Help** — the manual as data (`parseManualHtml` on the server, `manualNode`
  on the client), a glossary of the verdict words (`VOCAB`: the chip's plain
  word beside the exact term the proof file carries), and the paths on this
  machine. The last `innerHTML` on the server went with `app-html.ts`.
- **Learned** — Needs a human, Healed selectors and Reports as three sub-tabs
  (`S.learnedTab`, remembered per browser). Needs a human scans every proof,
  not the first twelve, and lists runs waiting for a ruling.
- **One dialog idiom.** `confirmModal` / `promptModal` replace every
  `window.prompt` and `window.confirm` wowUI still makes (rename flow, rename
  group, resume from case, re-author, the three queue confirms, and the resume
  password — asked in a password box). `cache-forget` is gated in `post()`
  through `DESTRUCTIVE`; Clear history keeps its two-click arming button.
- **Old addresses land** (`LEGACY_HASH`): `#healed` `#attention` `#reports`
  `#cache` → Learned, `#keys` `#repos` → Machinery, `#manual` → Help, `#panel`
  `#flows` → Commands. The base usage-cap dialog's `S.view = 'keys'` is mapped
  in `render()`.

- **Machinery in two columns** (`layoutKeys`, 2026-09-03): `renderKeys` still draws
  the role table, the provider sections, the Claude session and the Database
  top to bottom; Ledger re-parents that DOM — roles and the provider keys on
  the left, the Claude session on the right — and folds each provider's keys
  under its head (`S.keysOpen`, remembered per browser). One column under
  1040px.
- **The claims gate is searchable and stays put** (`claimsGate` redeclared):
  a search box, one pill per scenario (`claimScenario`, the sheet's own
  numbering — PL_02_03 → PL_02), Select shown / Clear shown acting on the
  filtered rows only, and Expand to lift the 320px cap. Ticking a claim
  updates that row, the count line and the submit button through
  `syncSubmit()` — never `renderLauncher()` — so the list keeps its scroll
  position and the search box its focus.

Deliberately absent: the old panel's flow editor (a textarea over
`/api/file`). wowUI's rule stands — nobody picks or edits a flow file by hand;
Run again, Repair and Re-author on the row are the actions. No endpoint was
added or changed for any of this.

## Asking for the accounts a catalog signs in as (2026-09-04)

A catalog row that changes hands — the manager submits, the HRBP approves —
needs two logins in one case. Everything below the panel could already do it
(one Chrome per persona, `signIn` by label at $0, the actor on every proof
step), and the panel could not **ask**: the launcher had one credentials box,
`personas` was declared on `catalog-run` but excluded from Ledger's Commands
tab, and nothing anywhere said how many accounts a document needed. The run
learned it by refusing a row ten minutes in, with a browser already open.

**The hand-off is the claims file, and the panel never re-derives it.**
`ClaimsFile.personas` (`catalog/catalog.ts`) is `{ label, cases[] }[]`, written
by the claims phase from `tablePersonas` — the same `personasOf` the authoring
gate uses, which moved to `catalog/test-case-table.ts` for this and is
re-exported from `cli/commands/authoring.ts` so no caller moved. It had to be
written down because `claimTextOf` composes a claim from the title, the
expectation and the note: the Steps column, where `Login ด้วย <MANAGER_ACCOUNT>`
actually lives, is not in it. **Labels and case ids only** — the claims file is
plain JSON a person opens and mails around. Absent (never `[]`) when no row
names an account, so a surface can tell "nobody needed" from "nobody looked".

**`personaBlock(M)` is in `WOW_SCRIPT` and called from `renderCatalogTab`**,
which Ledger does not redeclare — one call site, both pages, pinned by a test
that counts the declarations. One row per label: the label, `N case(s) sign in
as this account`, an email box and a password box. Every handler calls
`syncSubmit()`, never `renderLauncher()`. The values live in `M.personaCreds`
while the launcher is open and are wiped by `closeLauncher`; **never
`localStorage`** — the view-preference rule is for sorts and open panels, not
for secrets. **Start is blocked** until every named account is answered, and
the one-press path (`readClaims(true)`) is gated the same way: a run started
without one of the accounts its own document names does not fail at the start,
it authors, opens a browser and refuses rows minutes in.

**The panel predicts no refusal.** Which account may fall back to the run's own
`--as`, and which row is refused for want of one, is `resolveRowPersonas`'s
rule in the CLI. Re-implementing it here is exactly the drift `commands.ts`
exists to prevent — the gate promising two accounts while authoring refuses a
third. The panel offers a box per label and states the case count; the refusal
stays the CLI's, printed in the run output.

**`personasValueToMap` takes a record as well as the typed lines**
(`commands.ts`), evaluated *before* the string guard. Not a convenience: the
text form splits on `/[\n;]+/` before the first `:`, so a password containing a
semicolon breaks in one of two measured ways — `A=a@x.test:p;w` throws about a
fragment (`got "w"`) matching nothing the person typed, and
`A=a@x.test:p;B=b@x.test:q` **silently** gives A the password `p` and invents an
account B. The second is the reason: a form collecting several accounts at once
cannot offer a syntax whose failure mode is a plausible-looking wrong answer.
An empty record is "not supplied", like an empty box.

**The resume asks for every account, and pairs each with the ledger's email.**
`missingPersonaPasswords(launch, inherited, env, supplied)` in `catalog-runs.ts`
is the pure decision; `/api/catalog-runs/resume` answers 409
`{ needsCredentials, persona?, personas: [{ label, email }] }` — the existing
`persona` key stays, so an older client still gets the answer it understands.
The client sends `personaPasswords: { LABEL: '…' }` and **the server pairs each
password with the email the LEDGER recorded**: the secret half only, so a client
cannot redirect the run at a different account (the same "make the question not
arise" shape as addressing a proof by `runId`). Nothing is asked that the prior
job's `secretEnv` or the machine's own `WOWLIDATOR_PERSONAS` already carries; a
malformed map is "nothing known", never a crash. Both surfaces' `resumeCatalog`
grew the sixth argument — wowUI loops its `window.prompt`, Ledger chains
`promptModal` per label. `launch.personas` (label → email) had been on the wire
at `/api/catalog-runs` since the ledger learned it, read by nothing; the
resumable banner now shows it through the shared `accountsLine(run)`.

**`GET /api/jobs/<id>` published `secretEnv`, and that is fixed first.**
`summariseJob` strips it for the list and says credentials must never leave the
process; the detail route answered with the raw `Job` and did not. `awaitJob`
polls it every 700 ms while the launcher reads a catalog, so today's single
`--as` password was already in the browser — and N passwords on the same overlay
would have multiplied it. `detailJob(job)` beside `summariseJob` strips the
secret and keeps `lines` and `cases`, which is what the detail route is for.
Pinned in `tests/resume-credentials.test.ts` (start a job, assert the body
carries neither the value nor the field name); verified red without the fix.

**One backtick lesson, again.** `WOW_SCRIPT` is a `String.raw` template, so a
backtick anywhere inside it — including in a comment — truncates the page and
takes the launcher with it. The parse assertion in `wow-ui.test.ts` catches it;
write `personas` in a comment there, never in backticks.

## Stills default to `all` (2026-09-04)

The `screenshots` field defaults to **`all`**, not `auto`, on every command that
offers it (`go`, `run`, `generate`, `author`, `catalog-run`, `crawl`, `watch`)
and in the launcher's own state. Under `auto` a filmed run keeps a still only
where a step FAILED — correct for a machine, wrong for the surface a person
reads a run on afterwards, where the evidence for a step that passed was a video
frame they had to scrub to. The cost is report size: the same run captured
twice, plus 50–150 ms per step.

`auto` is still offered and still means what it says. It is expressed by sending
**nothing** — `submitLauncher`'s guard is `M.screenshots !== 'auto'` — because
the run's own fallback (`on-failure` while filming, `all` when not) IS the auto
decision. That guard reads as "don't send auto" rather than "don't send the
default", which is now the load-bearing distinction; there is a comment at the
call site and a test on the pair.

## Every status word says what it means, on the row (2026-09-04)

A run (`c157cf92`) whose session was never established showed the word
"blocked" on the catalog row and "test failed" on the run row, and the person
had to ask what either meant. The meaning was on the page — in `familyChip`'s
hover title and in Help's glossary — and nowhere a reader actually looks.

**One map, `STATUS_MEANING` in `WOW_SCRIPT`** (`wow-ui-html.ts`, beside
`verdictChip`): status word → one sentence. Keyed by the status the proof file
or the job line carries (`passed`, `passed-with-issues`, `needs-review`,
`failed`, `dead-end`, `error`, `blocked`, `quarantined`, `running`, `waiting`)
plus the labels the page itself derives (`human-confirmed`, `needs a human`,
`recorded only`, `no verdict`, `spec?`). Ledger's `VOCAB` keeps its shape and
reads every status entry's `meaning` from the map (`meaning:
STATUS_MEANING['error']`), so the glossary and the row can never say two
different things; only the non-status terms (rung, ledger, bundle…) carry
their own sentence. `meaningLine(key, detail)` builds the visible line —
`div.meaning`, through `el()`, spanning the whole grid row (`grid-column: 1 /
-1`, so no column widens; wraps; muted ink) — and returns nothing for
`passed`, `running` and `waiting`, where the chip says it all. Three call
sites, one function each, both pages: the run row (`taskRow`, taking the branch
the chip took, so a three-run streak reads "needs a human"), the catalog case
row (`caseRow`), and the history row (`appendHistoryRow`).

**A run that delivered no verdict quotes the CLI's recorded reason.**
`ProofCard.noVerdict` (`proofs.ts`) is `neverRan(bundle) ?? harnessOnly(bundle)`
from `cli/exit.ts` — the suite loop's own rule that scores the case `blocked`
on the ledger, imported, not re-derived. `runMeaningLine` uses it: the chip
keeps the bundle's status (`failed`, with the machine word in its title) and
the line under it says "nothing about the application was proved — … a catalog
scores it blocked, not failed — recorded reason: the run is on the sign-in
page (…) — the session is not established …". No wording is matched to find
the session case: the reason IS the engine's message, first line only. On a
live catalog job the same reason comes from the case's own output: `JobCase.
reason` (`jobs.ts`, `caseReasonOf`) is parsed from the `BLOCKED <case> —
<reason>` and `! no verdict: <reason>` lines, capped at 300 characters, and
travels in `summariseCases`. The chip's `title` now carries `status: <word>`
on the case row too — the line adds, never replaces.

Pinned in `tests/wow-ui.test.ts` ("says in plain words, on the row…": the map,
the four load-bearing sentences, the three call sites, the CSS, the page still
parsing; "projects why a run delivered no verdict…": a contradicted claim gives
null, a stranded session gives the guard's first line, an unattached browser
gives the attach error; `caseReasonOf` on the two lines and nothing else) and
`tests/ledger-ui.test.ts` ("explains every status word … from one map": every
status entry of `VOCAB` reads `STATUS_MEANING[...]`, no status sentence written
twice, the glossary still renders `v.meaning`).

## The account is remembered; the password never is (2026-09-04)

Asking for an account per persona label (above) closed a real gap and opened a
smaller one: the addresses do not change between runs, so every launch began
with the same three strings being retyped by the person who typed them
yesterday. The choice made explicitly here was **the account only** — the
password is asked for every run, and nothing that can sign in on its own
reaches disk. A store holding both halves would be a credential in a file
beside a server that binds to a port; an address alone opens nothing.

**`ui/persona-accounts.ts` is the store**, `.wowlidator/persona-accounts.json`
(gitignored already, with the rest of `.wowlidator/`):
`{ version: 1, accounts: { LABEL: [{ email, lastUsedAt }] } }`, newest first,
capped at `MAX_ACCOUNTS_PER_LABEL` (8), written temp-file-then-rename like the
ledger, and a corrupt or foreign-version file read as "nothing remembered" with
one line to stderr — the cache's rule. Labels are keyed through the CLI's own
`personaLabelOf`, so a memory filed under `MANAGER_ACCOUNT` is found by a claims
file that spells it `<manager account>`. **The API boundary is
`remember({ label, email }[])`**, never a persona map: the shape that cannot
carry a password is the one that cannot leak one by accident, and every record
written is rebuilt from those two fields, so a hand-edited `password` key does
not survive a read either.

**Written by the route, on the 201 path only.** `POST /api/jobs` and
`/api/catalog-runs/resume` call `ctx.personaAccounts.remember(...)` after
`jobs.start` succeeds; `personaAccountsOf(spec, values)` in `server.ts` is where
the password is dropped, re-using `personasValueToMap` — the same parse the env
overlay just did — and taking only each entry's `email`. In the route rather
than in the claims phase because it then covers **every** command that declares
`personas` (`go`, `run`, `generate`, `author`, `catalog-run`, `watch`), and does
not wait for a run to get far enough to write a ledger. A submission refused
with 400 or 409 started nothing and teaches the store nothing. Never fatal: a
store that cannot be written is a stderr line, not a failed launch.

Not to be confused with `SuiteLedger.launch.personas`, which records label →
email for **one** run and is what the resumable banner and the resume gate read.
That is a record of a run; this is the panel's memory across runs. Both stay.

**`GET /api/persona-accounts`** answers `{ accounts }` and nothing else — a
separate route rather than a fold into `/api/documents`, because a documents
list answering about accounts is two subjects on one wire, and this one takes no
parameter at all, so there is no client string anywhere near a path. The page
loads it in `openLauncher` beside `loadDocuments` (`loadPersonaAccounts`), never
on a poll: it changes only when a run starts.

**The control is `accountPicker(need, got)` in `WOW_SCRIPT`**, called from
`personaBlock`, so one call site serves `/` and `/wow`. No memory for a label is
the plain text box, unchanged. With memory it is a `<select>` of the addresses,
**most recent preselected** (only while the row is untouched, so late-arriving
data cannot overwrite a choice), plus `Another account…`, which reveals a text
box **in place** — `typed.style.display`, not `renderLauncher()`, because
re-rendering the form to show a field rebuilds the control being used and takes
the caret with it. The sentinel option's value contains a space, which a stored
address never can, so it cannot collide with a real one. The password box is
untouched: never remembered, never offered, always typed, and Start stays
blocked until every account has both halves. The block's copy changed to say so,
since something is now written to disk.

Tests: `tests/persona-accounts.test.ts` (round-trip, newest-first, re-use moves
to the front, the cap, label keying agreeing with `personasValueToMap`, a
corrupt file as empty, an unwritable store that does not throw, and that no
password-shaped property can be written or read back);
`tests/resume-credentials.test.ts` grew a real-server block (the address is
recorded on 201, the answer and the file carry neither the value nor the word
`password`, a 400 teaches nothing); `tests/wow-ui.test.ts` pins the picker, the
in-place reveal, the untouched password half — and that **no `_ACCOUNT` literal
survives comment-stripping of the page**, since `wow-ui-html.ts` is exempt from
the global `no-hardcode` scan; `tests/ledger-ui.test.ts` adds `accountPicker`,
`rememberedAccounts`, `personaLabelKey` and `loadPersonaAccounts` to the
ships-unchanged composition list.

## The console reads the output; it does not rewrite it (2026-09-04)

**Surface:** both pages — the command-output section under a live job row and
under a finished run's report card, and each case's own pane in a suite. One
view, `consoleView(lines)` in `WOW_SCRIPT`, so `/` and `/wow` read a job the
same way; Ledger redeclares nothing here.

**What changed.** A job's output used to be one `div` per line, stderr in red.
It is now *read* before it is drawn, by `classifyLine()` in
`src/ui/console-lines.ts` — plain script shipped verbatim ahead of
`WOW_SCRIPT` and evaluated as-is by `tests/console-lines.test.ts`, so what a
row looks like is decided by a function the tests can call. The rules, all
structural (a channel tag, an arrow, a glyph, `refused:`, a leading bullet),
never a case's wording:

- `[llm HH:MM:SS] → | ← | ✗ …` is a one-line model-call summary with the stamp
  set aside; the `ask:`/`response:` continuation lines fold under it behind a
  `▸ ask · response` toggle (`conFold`). ASCII arrows and a stampless tag read
  the same, because the prefix will move.
- `✓`/`✗` opens a step row: glyph in `--ok`/`--bad`, then `[index]`, the action
  in bold, the `(fast, 812ms)` duration muted, then the target — the column
  order `formatStepLine` writes since 2026-09-04; the older target-then-
  duration order still parses, since a log on disk is read by the same page.
  `agent click` stands where the index would (`formatAgentAction`). The
  detail lines under either (eight or ten spaces: intent, expected/actual,
  observed, the error's first line) ride with the step through every filter
  (`conDetail`, on the classifier's `hang` flag).
- `refused: …` is a refusal row; `  flow: "…"`, the `  (n) …` numbered
  problems and their six-space continuations become its list (`conBullet`,
  `conDetail`), and all of it filters with the headline. The older `  · …`
  bullets read the same.
- The two-column summary (`  authored   57 step(s) on attempt 2/3 in 4m31s`,
  `  elapsed    41.2s …`, `  plan       57 step(s)`, `  report     /path`) is a
  `summary` row with the key in a fixed column — read by shape (a word, two
  spaces, a value), never by which keys exist.
- `case "…" started|passed|…`, `— authoring attempt n/m —` and a phase header
  (`── authoring ID ────…` from `phaseHeader()`, or `## x`, `phase …`, `▶ x`)
  are markers with a dashed rule; the header's own rule of dashes is dropped
  on the page, where the row's border is the cue. The attempt pattern is
  anchored, so a summary that says "on attempt 2/3" is not a marker.
- **The tag comes first on every line of a row or case** — `[ACME-042] [llm
  06:41:47] → …` on stderr too (`withLogTag` in `src/log-format.ts`) — so the
  case tag and the row tag are peeled before the llm channel tag, and a bare
  `[llm]` is never mistaken for a row.
- Everything else is plain, **untouched** — a new CLI line shape degrades to
  text, never to a dropped line. `<script>` in a line is text; the whole view
  is `el()` and `textContent`, and both page tests still assert no
  `innerHTML` exists.
- The `[cN]` tag and a bracketed case id are peeled and become a **sticky
  label over the run of lines they share** (`.con-case`), so the prefix is
  not repeated per line; an id doubled as `ID: …` on the message is folded
  once, by token identity, not by any known id.

**Stderr is a muted `E` in the gutter** (`printed on stderr` on hover), never
colour alone — colour is reserved for what the line *means*. The class is
`from-err`, because wowUI already has an `.err` rule that paints red.

**The filter row** — All / Steps / Model calls / Problems, plus find-in-output
— hides rows in place (`row.hidden`; note the explicit
`.con-row[hidden] { display: none }`, since the row's own `display: flex`
would otherwise beat the UA's `[hidden]`). It never re-renders, so the search
box keeps its focus and the pane its scroll. The mode is a **view preference**
in `localStorage` (`wow-console-filter`, read and written inside `try`); the
query is page memory. **Copy raw** copies every line exactly as printed —
`conRawText` — filters do not apply, because a pasted log must be the log.

**Live output still lands in place, never through `render()`.** `streamJob`
calls `out.view.append(line)` per SSE line and `out.view.reset(lines)` on a
`replay`; `append` never re-pushes a line the caller's array already holds
(the view is built on `S.jobLines[jobId]` itself), which is what a first
version got wrong and doubled the raw copy. Auto-scroll follows the tail
while the reader is at it and stops when they scroll up to read something
(`view.stick`, 24px of slack), resuming when they return to the bottom.

**What this must never become.** The classifier reads text the CLI printed;
it does not compute a verdict, a duration or a count the CLI did not print
(rule 1 above, and `verdictFamily` owns verdicts). If a filter needs a fact the
output does not carry, the fix is a line in the CLI, not a lookup here.

Tests: `tests/console-lines.test.ts` (every kind above, tolerance to the
prefix moving, plain-and-untouched for anything else, the four filters, raw
copy verbatim, no `${` in the shipped string); `tests/wow-ui.test.ts` pins the
one `consoleView`, `outLine` gone, the live path through `append`/`reset`, the
stderr marker, the glyph colours, the sticky label, the fold and the list, the
guarded `localStorage` reads and writes, Copy raw, the `[hidden]` rule and
`conApplyAll` re-reading views in place; `tests/ledger-ui.test.ts` pins the
same composition on `/` so the guarantee does not leave with `/wow`.
