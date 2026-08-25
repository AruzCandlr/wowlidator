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

## The Database card (`src/ui/db-status.ts`, `/api/db`)

The fourth sibling of `keys.ts`/`models.ts`/`checks.ts`, asking about the backend runs verify against instead of a model role. Three kinds of knowledge, kept separate on the card (Models & keys page): **configured** — what `WOWLIDATOR_DB_URL` resolves to, masked (`maskDsn`; the password characters never reach the page, same rule as API keys — the page gets host/port/database/user and a `passwordSet` boolean); **probed** — whether it answers, on a click and never on a poll (`GET /api/db` is cheap and pollable, the probe runs only on `POST /api/db/check`: connect read-only, introspect, count tables, close — `doctor`'s db line in-process, and a probe result about a DSN that has since changed is dropped, the same never-show-a-stale-verdict rule as `RoleChecks.describe`); **hinted** — what registered repositories' own files say their database is (`RepoEntry.dbHint`), shown whether or not a DSN is set so a configured DSN pointing somewhere the repo does not name is visible too, with a ready-to-edit suggestion that never includes a password ("add the password yourself; wowlidator never reads one out of a repo").
