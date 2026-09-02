# CLAUDE.md — the control panel and wowUI

Split out of the root CLAUDE.md (2026-08-24) so this loads only when working under
`src/ui/`. Same authority as the root file; the root keeps the map of the whole system.

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


## newUI (`src/ui/new-ui-html.ts`, `/new`, `wowlidator ui --new`) — 2026-08-27

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

The `/new` route and `ui --new` flag were removed at the user's request —
`new-ui-html.ts` and its tests remain (they render the module directly), but
no server route serves it; `/wow` is the surface to improve. wowUI's ≤900px
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
