# One-page UI spec — 2026-08-27

The request, verbatim: **"do not touch any technical and programmatic part of
this repo and revamp the wow UI and wowlidator web interface of this system to
make it exist only one page, make it display more understandable informations
and enhance the easy-to-use of the website, while retain every features."**

Four MUSTs fall out of that sentence, and every item below is tagged with the
one it serves: **[frozen]** nothing programmatic changes, **[one-page]** one
document replaces two surfaces, **[clear]** what is shown is understandable
without reading the source, **[easy]** fewer clicks and fewer traps. A fifth,
**[kept]**, is the retention ledger in §7: every feature of both surfaces,
and where it lives afterwards.

Grounded on 2026-08-27 against `src/ui/app-html.ts` (940 lines, the classic
panel at `/`), `src/ui/wow-ui-html.ts` (5,425 lines, wowUI at `/wow`),
`src/ui/commands.ts` (17 command specs), `src/ui/server.ts` (the HTTP contract)
and the tests that pin them (`tests/wow-ui.test.ts`, `tests/theme.test.ts`,
`tests/failed-runs.test.ts`, `tests/api-keys.test.ts`, `tests/model-check.test.ts`).

## 0. Verdict

Serve **one document from both routes**. `GET /` and `GET /wow` keep existing
in `server.ts` (untouched); `renderApp()` becomes a one-line delegate to
`renderWowUi()`, so the classic panel's route, the `--wow` flag and every test
that imports either function keep working with no server change. The page is
a single scrolling document with six anchored sections and a sticky rail —
no router, no views, no "Elsewhere" link to the other surface, because there is
no other surface.

What changes: three files under `src/ui/` that only render HTML —
`wow-ui-html.ts` (rewritten around sections instead of views),
`app-html.ts` (becomes a re-export shim) and `manual.ts` (the same content,
restructured from HTML strings into data so it can be built through `el()`).

What does not change: `server.ts`, `jobs.ts`, `commands.ts`, `keys.ts`,
`models.ts`, `checks.ts`, `db-status.ts`, `uploads.ts`, `usage-cap.ts`,
`claude-settings.ts`, `proofs.ts`, `catalog-runs.ts`, `failed-runs.ts`, the
CLI, the engine, every provider, every test. The page consumes the HTTP
contract in §8 exactly as it is today.

## 1. The frozen boundary [frozen]

"Technical and programmatic" is read as: **anything that decides what runs,
what is stored, or what is sent** — the server, the job runner, the command
whitelist, the state modules, the CLI and everything below it. The page is
allowed to change how those are *shown* and *asked for*, not what they do.

| May change | Must not change |
|---|---|
| `src/ui/wow-ui-html.ts` — markup, CSS, client script | `src/ui/server.ts` — routes, roots confinement, `Host` check, 409/404 shapes |
| `src/ui/app-html.ts` — reduced to `export function renderApp() { return renderWowUi(); }` | `src/ui/commands.ts` — every field, flag, default, `fixedFlags`, `repeatable`, `requiredWhen`, `offFlag` |
| `src/ui/manual.ts` — same words, as a typed array of sections instead of HTML strings | `src/ui/jobs.ts` — job shape, SSE events, serialisation, `MAX_LINES`, artifact regex |
| `src/ui/CLAUDE.md` — the doc follows the code, at the end | `keys.ts`, `models.ts`, `checks.ts`, `db-status.ts`, `uploads.ts`, `usage-cap.ts`, `claude-settings.ts`, `proofs.ts`, `catalog-runs.ts`, `failed-runs.ts` |
| | `src/cli.ts`, `src/cli/**` (the `ui` dispatch and `--wow` stay as they are) |
| | every file under `tests/` — they stay green **unedited** |

Consequences the implementer must accept rather than work around:

- **`/wow` stays a route.** The server serves it; the page it serves is the
  same document. A bookmark to `/wow#keys` lands on the same page, at the
  Machinery section (§4.6 maps every old hash to a new anchor).
- **Whatever the page shows about a job, it learned from `/api/jobs` and the
  SSE stream.** No new endpoint, no new field on a job. Progress and per-case
  status are already emitted (`progress`, `cases` events, `jobs.ts:501-508`)
  and today *neither page subscribes to them* — the one page does, which is
  the only "new data" it gets, and it was always on the wire.
- **The classic `innerHTML` for the manual goes away**, not because the rule
  changes but because the unified page is `renderWowUi()`, and
  `tests/wow-ui.test.ts:401` forbids `innerHTML`, `trustedHtml`,
  `insertAdjacentHTML` and `document.write` anywhere in it. Hence `manual.ts`
  becomes data. Same words; no escape hatch.
- **Repeatable fields get a real control** (`context-doc` on `draft`,
  `catalog-claims`, `catalog-run`, `context-add`). Today the classic panel
  renders one text box and `buildArgv` refuses the result (`"context-doc" must
  be a list`, `commands.ts:1265`). Fixing it is a client change: send an array.

### 1.1 Test invariants the page keeps, verbatim

The redesign is judged against the existing tests, unedited. The strings
below must survive in the rendered document (they are read from the page
source by `tests/wow-ui.test.ts`; line numbers there):

| Test (line) | Must contain | Must **not** contain |
|---|---|---|
| self-contained (103) | — | `<script src=`, `rel="stylesheet"`, `fonts.googleapis`, `@import`, any `http(s)://` except `localhost` / `www.w3.org` |
| both palettes (111) | `#F7F7F4`, `#06b6d4` | — |
| GRIM classes (116) | `.side .nav-item .stats .rows .row .rail .chip .verdict .tbl .cycle .drawer .modal .toast-msg .req-card .f-pill` — all fifteen, as CSS class selectors | — |
| launcher (123) | `Start verification`, `Add Context`, `Add Catalog`, `Describe`, `Anything to look at especially`, `Page to prove it against`, `Options for this run only` | — |
| claims at a glance (130) | `claimsSummary`, `whyBlock`, `Expected vs actual`, `Why it `, `polarityTag`, `expectedActualOf`, `.claims-summary`, `.why-block`, `S.verdicts[` | — |
| catalog accuracy (145) | `accuracyOf`, `accuracyLine`, `'accuracy '`, `knownResult`, `vs sheet`, `unscored`, `if (a.scored === 0) return null` | — |
| autoheal (156) | `Autoheal enabled`, `M.autoheal`, `extras.repair = true` | — |
| backend toggle (164) | `Include backend steps`, `M.backend`, `extras.backend = M.backend === true`, `extras['db-url'] = M.dbUrl.trim()`, `Database URL` | — |
| session cost (178) | `latest.session`, `session.costUsd.toFixed(2)`, `' session'`, `served from cache` | — |
| workflow step (189) | `agent action`, `agentActionLog`, `The goal the agent was given` | — |
| renders whole (195) | length > 200,000, ends `</html>`, `Start verification` | — |
| context docs (205) | `Remember document…`, `'context-doc': [doc.path]`, `.pptx` | — |
| proved-? flow (211) | `proved-?`, `reviewBlock`, `effStatus`, `'/review'`, `Confirm proved`, `Confirm failed`, `needs-review` | — |
| inline launcher (218) | `id: 'launcher'`, `toggleLauncher`, `closeLauncher` | `openStartModal` |
| no flow selector (229) | — | `The flow to run`, `Start from a flow on disk`, `Paste a flow`, `commandId: 'run'` |
| repositories (239) | `'Repositories'`, `post('context-add'`, `Ground in a saved repository`, `extras.repo`, `Machinery › Repositories` | — |
| uploads (262, 270) | every extension in `SUPPORTED_EXTENSIONS`; a diagram image is a catalog only | — |
| claims first (294) | `lists what it claims`, `'catalog-claims'`, `'catalog-run'` | — |
| lanes (302) | `Lanes — who is who in this diagram`, `guessed — confirm`, `recomputeLanes`, `plane === 'user' \|\| plane === 'page'`, `sequence: M.claims.sequence` | — |
| step evidence (319, 325) | `Database check`, `Traffic this step asserted`, `Forbidden calls it observed`, `'Error'`, `'Trace'`, `Raw output (the facts)`, `How to prove it again`, `kept apart from the facts` | — |
| film (333) | `View actual flow`, `Record actual flow`, `openFlowPlayer`, `flow-subtitle`, `active.failed && active.error` | — |
| console in card (342, 352) | `streamJob`, `'/events'`, `outputSection`, `Command output (`, `jobForRun`, `outOpen` | `jobPanel`, `openJobDrawer` |
| runtime per step (362) | `text: 'Took'`, `wall clock ` | — |
| keys (369) | `Models and keys`, `Key in use`, `runs start here` | `apiKey`, `api_key`, `process.env` |
| model picker (378) | `Provider and model`, `/api/models`, `datalist` | `gemini-\d`, `llama-\d` |
| progress (387) | `progressBar`, `estimating…`, `tickProgress`, `tqdmReadout`, `'s/it'`, `'it/s'` | `S.jobs.map(...j.progress` |
| `el()` only (401) | — | `innerHTML`, `trustedHtml`, `insertAdjacentHTML`, `document.write` |
| scope radios (408) | `How far should it reach?`, `type: 'radio', name: 'launch-scope'`, `End-to-end` | — |
| failed runs (`failed-runs.test.ts:79`) | `/api/failed-runs`, `Failed runs — no proof was produced` | — |
| classic shim (1181, `theme.test.ts:122`) | `renderApp()` contains `'secret' ? 'password'`, `#F7F7F4`, `#06b6d4`, no external request | — |

Two of these shape the design rather than merely constrain it. **The
fifteen GRIM class names** mean the page is still GRIM's QA Command Center
dialect — the rail, the row, the chip, the drawer — so the redesign is a
re-composition, not a new visual system. **"No flow selector"** means the
launcher never asks for a flow path; running a flow that already exists on
disk is an action *on that flow's row*, never a box to type into (§4.4).

## 2. The one page [one-page]

A single scrolling document. A sticky rail on the left lists six anchors and
scrolls to them; on narrow screens the rail becomes a chip row under the
header instead of disappearing (today both surfaces hide it below 900 px with
no replacement). The `location.hash` is the anchor and nothing else —
there is no `S.view`, no `show()`, no `render()` dispatch.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ wow//UI   ● connected 4600 · browser free · 4/4 roles keyed · cap 42%   │
│           [search everything…]                     [+ Start verification] │
├──────────┬───────────────────────────────────────────────────────────────┤
│ Now    2 │ NOW      running jobs · paused catalog runs · needs a human    │
│ Start    │ START    the launcher, inline, three modes + every command     │
│ Runs  31 │ RUNS     one row per flow, grouped by authoring pass, filters  │
│ Library  │          ↳ run timeline ↳ steps ↳ evidence (side panel)        │
│ Machinery│ LIBRARY  reports · flows (edit in place) · healed selectors    │
│ Help     │ MACHINERY models and keys · Claude session · database · repos │
│          │ HELP     the manual, plus the glossary the chips link to       │
│ ●  4600  │                                                               │
└──────────┴───────────────────────────────────────────────────────────────┘
```

### 2.1 Header (sticky, always visible)

Everything a person checks *before* pressing Start, refreshed on every poll —
the classic panel's chips were computed once at boot and went stale
(`app-html.ts:818-823`).

- Connection: `panel connected · <port>` / `panel unreachable · showing
  stale data` (from `S.online`), with the **Try again** action inline.
- Browser: `browser free` / `browser in use — one run at a time` (a live
  job with `browser: true`), so the 409 a browser command would get is
  visible before the click, not after.
- `CDP <host:port>` and `N/M roles keyed` (from `/api/meta`, `/api/keys`),
  the latter jumping to Machinery when short.
- Usage cap gauge: the worst window as `cap 42% of 80%` when enabled,
  amber at `nearing`, red and pulsing when tripped (from `/api/usage-cap`).
- **Search everything** — one box that filters Runs, Library tables,
  Machinery rows and Help sections at once (client-side, on the data already
  polled). Neither surface has search today.
- **+ Start verification** — opens the launcher in the Start section and
  scrolls there. Never navigates elsewhere, because there is nowhere else.

### 2.2 Now

What needs a person right now, collapsed to one line when nothing does
("Nothing running · nothing waiting on you").

- **Running** — every live job as a row: title, command line, tqdm
  progress with ETA, per-case rows for catalog runs, **Output** (streams
  into the row via `streamJob`), **Pause** (catalog-run only, as today),
  **Stop**. One implementation, reused; today the live-job card exists twice
  with different buttons (`wow-ui-html.ts:1562` vs `2988`).
- **Paused or stopped catalog runs** — the resumable banners, **not capped
  at three**: three shown, then `and N more — show all`. Buttons unchanged
  (Continue / Rerun all errors / Heal all failed / Re-author vacuous /
  Resume from case…), except *Resume from case* opens a picker listing the
  ledger's case ids instead of a `window.prompt` for an id the person
  cannot see (§5.3).
- **Needs a human** — the `.req-card` list: failing streaks (≥3) and runs
  waiting for a `proved-?` ruling. Scans **every** proof the index carries,
  not the first twelve (`wow-ui-html.ts:3307`), and says so: `12 of 31 runs
  scanned` is exactly the kind of number this spec forbids hiding.
- **Offline banner** and the **usage-cap trip** callout live here too, so
  the alert dialog (kept — it is the one thing that should interrupt) has a
  place to dismiss *to*.

### 2.3 Start

The launcher is inline (test 218) and always present, collapsed to a single
"Start verification" row when idle. Four segments instead of three — the
fourth is where the classic panel's commands go, so nothing needs a second
page:

| Segment | Backs | Notes |
|---|---|---|
| **Add Context** | `POST /api/documents kind=context` | unchanged: upload or paste, stored list with remove |
| **Add Catalog** | `catalog-claims` → gate → `catalog-run` | unchanged flow; the two "Process catalog" buttons become one (§5.2) |
| **Describe** | `go` | unchanged: what to prove, Unit / End-to-end radios |
| **More commands** | every `CommandSpec` in `commands.ts` that the three modes do not already cover | a generic form rendered *from the spec* — the classic panel's `renderCommand`, rebuilt to the rules in §5.1 |

"More commands" lists, grouped as the specs group them: *Test* — Generate
tests, Author one test, Draft a catalog, Crawl, Watch; *Maintain* — Doctor,
Build the project index, Show the project index, Save a repository, Saved
repositories, List healed selectors, Forget a repair, Clear run history.
That is every command the classic sidebar offered **plus the eight it did
not** (`draft`, `catalog-claims`, `catalog-run`, `cache-list`,
`cache-forget`, `history-clear`, `context-add`, `context-list` — reachable
today only by typing a hash, `app-html.ts:279-281`). `run` is not in the
list; it is an action on a flow row (§4.4).

The shared fields (focus, page URL, Sign in as, repository, Autoheal,
backend + Database URL, "Options for this run only") stay exactly as they
are; the test at line 164 pins how `backend` is sent.

### 2.4 Runs and proof

The primary section and the largest. One row per flow, grouped by the
authoring pass that wrote it (`S.groups`, computed server-side), with the
loop rail of the last three runs, the verdict chip, counts, cost and the
two actions (Run again, Repair). Expanding a row opens the **run timeline**
in place (cycle chips, hide, rename, trend), then the claims summary, the
steps table, the review block and the why block — as today.

What it absorbs from the old History view, so History is not a second list:

- The **filter pills** (All / Passed / Failed / Needed a repair) and the
  new **sort** (Latest / Name, numeric-aware — documented in
  `src/ui/CLAUDE.md` as existing, absent from the code) sit above the
  list. Filters apply to the rows; a group whose rows are all filtered out
  collapses to its header with `0 of 4 shown`.
- A density toggle, **By flow / Every run**: "Every run" flattens each
  flow's cycles into one row per run, newest first — the History view's
  shape — with the same row detail. One list, two densities, one
  implementation of the row detail (today `checksTable` + `claimsSummary` +
  `whyBlock` render in two places with different chrome, `wow-ui-html.ts:1970`
  vs `3179`).
- **Failed runs — no proof was produced** stays a distinct sub-list at the
  bottom (the string is pinned; the distinction is real: nothing there is a
  verdict about the application).
- **Clear history** moves into the section header's overflow menu, with the
  same confirmation idiom as delete (§5.3).
- **Open the raw proof** is one label, in one place per row (today three
  labels on three views).

The **evidence drawer** keeps its class, its three tabs (Error / Trace /
Fix) and its footer, but opens as a side panel that *narrows the list
instead of covering it* above 1200 px, so the step a person clicked stays
visible beside its evidence. Below that width it overlays, as today.

### 2.5 Library

Three collapsible cards, collapsed by default, each with its count in the
header and a search-aware table:

- **Reports** — name, rendered, size, Open (in the `/view` overlay, with
  *Open in a tab*).
- **Flows** — the classic Flows tab: name, steps, modified, validity;
  **Run** (§4.4) and **Edit**. Editing opens the flow in place under its
  row (the classic textarea with Save / Save and run), and the row shows an
  *unsaved* badge until saved — today the editor has no hash, no dirty
  guard and is lost on back (`app-html.ts:610-651`). Empty state offers
  *Generate tests* and *Author one test*, which open those forms in Start.
- **Healed selectors** — selector → replacement, strategy with confidence
  bars, hits, per-row Forget and Forget everything (confirmed, §5.3).

### 2.6 Machinery

The old Models & keys and Repositories pages, as cards in one section, in
this order: **Models and keys** (role table with the model picker, Check /
Check all, key cards with *Start here*), **Claude session** (quota bars,
usage cap controls, `claude -p` usage, run-script cards), **Database**
(masked DSN, Check, repo hints), **Repositories** (scan and save, remember
document, re-scan). Every control is unchanged; the header buttons (Check
all roles / Refresh models / Re-read .env) become the Models card's toolbar.
The explainer box ("What Check actually does") becomes a `?` popover on the
Ready column header and a Help entry, not a paragraph under the table.

### 2.7 Help

The manual, rendered from `manual.ts` as data through `el()`, with its
eleven sections and a sticky in-section table of contents. Two additions:

- A **glossary** section — the definitions in §3.1 — and every verdict
  chip, tag and status word on the page links to its entry (`?` on hover,
  Enter on focus). This is how jargon stays on screen without staying
  opaque.
- The manual's tab table is rewritten to name the *sections and controls of
  this page* (today it names tabs that no longer exist and one — "Project
  index" — that never matched the nav, `manual.ts:95`).

## 3. Understandable information [clear]

Three rules, then the vocabulary they produce.

**Every number says what it is a number of.** "Proved 71%" becomes "Proved
5 of the last 7". "Runs today 3" keeps its "latest 14:02". A capped list
says `3 of 11 — show all`. A scan that stopped says how far it got. Silent
truncation reads as "covered everything", and the page has four of them
today (banners at 3, attention at 12 proofs, proof index at 150 files,
history at 300 lines — the last two are server-side and are *displayed*, not
changed).

**A verdict is a word a person already knows, with the exact term one hover
away.** The chip shows the plain word; the tooltip and the glossary carry
the term the proof file uses, because that term is what the CLI prints and
what `grep` finds. Both are on screen; neither is hidden.

**One failure vocabulary.** Today five words describe a run that did not
pass — `failed`, `error`, `runtime error`, `dead-end`, `blocked` — across
three widgets with three colour maps (`wow-ui-html.ts:2095`, `2947`, `3540`).
The page uses one map, in one legend, everywhere a status is drawn.

### 3.1 The vocabulary, shown → meant

| Shown on the chip / label | Exact term (tooltip, glossary, unchanged in data) | Meaning in one line |
|---|---|---|
| **Proved** | `passed` | every step passed, first time |
| **Proved after a repair** | `pass**` / `passed-with-issues` | passed, but only after the healer replaced a selector — check the heal |
| **Needs your ruling** | `proved-?` / `needs-review` | a step could not be sure; confirm proved or failed below |
| **Failed** | `failed` | a step's claim was false in the application |
| **Could not run** | `error` / runtime error | the harness, a key, or the environment stopped it — not a verdict about the app |
| **Stuck** | `dead-end` | the agent could not reach the page the step needed |
| **Blocked** | `blocked` | needed something not configured (a database, a key) — not run, not failed |
| **Quarantined** | `quarantined` | a known-flaky failure, recorded but not counted against the run |
| **Streak** | `failStreak ≥ 3` | failed three or more runs in a row — a person should look |
| **Run** (1, 2, 3…) | cycle | one execution of a flow; the rail shows the last three |
| **Authoring pass** | batch / pass / group | the one generation or catalog run that wrote these flows together |
| **Run key** | `runKey` (`<catalog>@<stamp>`) | the id a paused catalog run resumes under; shown beside Continue |
| **Progress file** | ledger | `<claims>.progress.json` — what Continue reads; shown as a path on hover |
| **Proof file** | bundle | the JSON a run leaves behind; "Open the raw proof" opens it |
| **Settled at** | rung (`fast` / `case` / `dialog` / `cache` / `backend` / `heal`) | which strategy on the escalation ladder made the step pass |
| **Checks that it does / checks that it doesn't** | polarity positive / negative | whether the claim asserts presence or absence |
| **Why it failed — family** | failure family | the one-word class of the failure, with its `FAMILY_NOTE` gloss |
| **Vacuous** | vacuous | a case that passed without checking anything — re-author it |
| **Waiting for the page** | consent gate / interstitial | the agent is clearing a cookie or sign-in screen first |

The five sidebar-era labels are kept where tests pin them and glossed where
they do not: **Machinery** keeps its name (pinned) with the subtitle "models,
keys, database, repositories"; **Needs a human** stays as a Now sub-heading;
"What the runs taught" is dropped (Library is the plain word).

### 3.2 Numbers with their denominators

| Widget | Today | On the one page |
|---|---|---|
| Proved tile | `71%` over the last 7 runs, unsaid | `5 of the last 7` |
| Runs today | count + latest | unchanged |
| Needs a human | `stuck + open` | `2 streaks · 1 ruling waiting` |
| Group tally | `proved 67% (4) · failed 17% (1)` | `4 proved · 1 failed · 1 stuck of 6`, with the accuracy line (pinned) beneath it |
| Cost line | `12.3k in / 2.1M out tok` | unchanged, plus `$0.42 session` where a session-billed provider ran (pinned) |
| Step time | amber ≥ 2 s | unchanged, tooltip names the 2 s fast-path budget |
| Resumable banner | `N of M still to run` | unchanged, plus which mode each button will use |
| Ready cell | chip + note | unchanged, plus `checked 4m ago — re-check?` when older than the models TTL |

## 4. Easy to use [easy]

### 4.1 The command form, rendered from the spec

`commands.ts` is unchanged; the form renderer is rewritten. Rules:

- **Advanced fields are grouped, not piled.** The 21 shared browser fields
  render under four headings — *Recording* (video, screenshots,
  capture-delay, step-delay), *Behaviour* (heal, agent, early stop,
  reconstruct, network, history, quarantine, baselines), *Chrome* (headless,
  ensure, stop-chrome, wait-for, cdp), *Output* (report, no-report, junit,
  ctrf) — each collapsed with its count, not one `More options (21)`.
- **Positive switches, negative flags.** A `no-*` boolean renders as a
  positively worded switch that is **on** by default (*Heal broken
  selectors*, *Let the agent navigate*, *Watch the page's HTTP traffic*,
  *Record run history*, *Write the HTML report*, *Reconstruct steps in-run*,
  *Let the agent give up early*, *Start or repair Chrome*). Turning it off
  sends `{ 'no-heal': true }`; leaving it on sends nothing. This is exactly
  the classic semantics (`absent ≠ false`, `commands.ts:1276-1291`) with
  the checkbox reading the right way round.
- **`requiredWhen` fields are visible and disabled**, not hidden, with the
  gate named beside them (*Database URL — turn on "Include backend steps"
  to fill this*). Today the required field does not exist on screen until
  the gate is ticked (`app-html.ts:394-400`).
- **Repeatable fields are a chip list** — type, Enter, chip; `×` removes —
  and submit as an array. `run.flow` (positional, repeatable) uses the same
  control with the flows datalist.
- **Help text is one line, then `?`.** The first sentence of each field's
  `help` shows; the rest is a popover. `video`'s five sentences stay
  available, not permanently rendered in 12.5 px grey.
- **Errors land next to the field.** A 400 from `buildArgv` names the field
  (`"context-doc" must be a list`, `required when "backend" is on`); the
  renderer parses the quoted name and marks that field. A 409 (browser busy,
  usage cap) is a banner at the top of the form with the action it needs
  (*Stop the running job*, *Reset the hold*).
- **Fieldless commands** (`doctor`, `context-list`) render as a single
  button with the blurb — the same as today, but the button says the verb
  (*Run the doctor*, *List saved repositories*), not "Run".
- `go`'s three-way `target` gets three radios — *A page URL* / *A flow
  file* / *A description* — that set the placeholder and show `url` only
  for the third, so the "required only when the box above is a description"
  rule is enforced by the form rather than described under it.

### 4.2 Fewer clicks to the evidence

| Task | Today | On the one page |
|---|---|---|
| See a finished run's console | expand group → scenario → row → scroll → expand Command output → fetch | row → **Command output (N lines)** is in the row's action strip, expands under the table (fetch on first open, as today) |
| See one step's evidence | drawer covers the table; default tab varies by status | side panel beside the table (≥ 1200 px); tab defaults unchanged, but the step stays highlighted in the table |
| Open the agent's actions | `▸ N agent actions` collapses the whole task (one `S.openTask` slot, `wow-ui-html.ts:1744` vs `2582`) | separate open-state maps for task / run / step; the task stays open |
| Rename a flow / a group | `window.prompt` | inline rename field on the row, Enter saves, Escape cancels |
| Resume from a case | `window.prompt` for an id not on screen | picker listing the ledger's case ids with their last status |
| Run several flows as a suite | Rerun all on the group header | unchanged, plus checkboxes on rows → *Run N selected* |
| Run a flow with options | classic Run tab (prefilled by hash) | **Run…** on the flow's row opens the `run` form prefilled, path read-only (§4.4) |
| Check a role | per-row Check + header Check all | unchanged; stale results (older than TTL) are marked, and Check all is disabled while any is running (as today) |
| Find a run | scroll | search box; filter pills; sort |

### 4.3 One idiom for anything destructive

Three exist today: a self-arming red button with a 4 s timer (Clear
history, `wow-ui-html.ts:3202`), a modal with an "I understand" checkbox
(Delete group, `5237`), and **nothing at all** (Forget everything, Forget
one, Hide run — `app-html.ts:723`, `wow-ui-html.ts:3242`). The page uses
one: the `.modal` with the action named in the button (*Delete 6 proof
files*, *Forget 14 healed selectors*, *Clear 31 runs — reports are kept*),
Escape cancels, focus trapped, first focus on Cancel. Hide keeps its ✕ but
the toast gains **Undo** for 8 s — the undo is a move back, which the server
does not offer, so the toast says where the file went *and* offers to copy
the path. (The move-back endpoint would be a server change and is out of
scope; the spec says so rather than pretending.)

### 4.4 Running a flow without a flow selector

The rule (`tests/wow-ui.test.ts:229`) forbids asking for a flow. The
feature (`run`, with repair / investigate / regenerate / attempts) is kept
as an action on a flow that already exists:

- Every flow row in Library and every task row in Runs has **Run…**, which
  opens the `run` form in Start with the path filled and **read-only**.
- Selecting several flow rows offers **Run N selected**, which fills the
  repeatable `flow` field with all of them — the suite semantics today's
  *Rerun all* uses (`wow-ui-html.ts:5105`).
- The literal `commandId: 'run'` never appears in the source; the generic
  form posts `commandId: spec.id`.

### 4.5 Keyboard, focus, motion

- Escape closes whatever is topmost — launcher, side panel, flow player,
  any modal, the usage-cap dialog (today three of those five ignore it).
- Every modal traps focus and returns it to the control that opened it.
- Rows, group heads and scenario heads stay `role="button" tabindex="0"`
  with Enter/Space, as today; the rail is a `<nav>` of real anchors.
- `prefers-reduced-motion` disables the progress shimmer and the cap pulse.
- The `/view` overlay (reports) keeps *Open in a tab* and Escape.

### 4.6 Old addresses still land

| Old | New anchor |
|---|---|
| `/`, `/#go`, `/#author`, `/#generate`, `/#crawl`, `/#watch`, `/#doctor`, `/#context-*`, `/#cache-*`, `/#history-clear`, `/#draft`, `/#catalog-*` | `#start` with that command's form open |
| `/#run` | `#library` (flows card open) |
| `/#flows`, `/#reports`, `/#cache` | `#library`, that card open |
| `/#history`, `/#runs` | `#runs` (Every run density) / `#now` |
| `/#manual` | `#help` |
| `/wow`, `/wow#runs` | `#runs` |
| `/wow#history` | `#runs` with Every run density |
| `/wow#healed`, `/wow#reports` | `#library` |
| `/wow#attention` | `#now` |
| `/wow#keys`, `/wow#repos` | `#machinery` |

## 5. Client architecture (the page's own, nothing below it) [frozen]

- **State** stays one object `S`, polled by `refresh()` every 5 s while
  visible and gated by `dataSignature()` exactly as today; `tickProgress()`
  every second. Two additions: `S.openRun`, `S.openStep` alongside
  `S.openTask` (three slots, not one), and `S.query` for the search box.
- **The SSE stream** gains listeners for `progress` and `cases`, which
  `jobs.ts` already emits; the 5 s poll remains the source of truth for
  anything a terminal-started run produces.
- **`el()` only.** Zero `innerHTML`; the manual is data.
- **One document, no assets.** The `url(data:image/svg+xml…)` marks stay in
  `wow-ui-html.ts` (`theme.ts` asserts it contains no `url(`).
- **`renderApp()`** in `app-html.ts` returns `renderWowUi()`. The
  `'secret' ? 'password'` fragment lives in the generic field renderer and
  therefore in both.
- **Sections are functions** — `nowSection()`, `startSection()`,
  `runsSection()`, `librarySection()`, `machinerySection()`,
  `helpSection()` — each rendering into its own host so a re-render of Now
  does not rebuild Runs. The existing names that tests pin (`renderLauncher`,
  `launcherBox`, `taskRow`, `taskDetail`, `checksTable`, `evidencePanel`,
  `renderKeys`'s internals, `renderClaudeSection`, `renderDbSection`,
  `renderRepos`, `renderFailedRuns`) survive as the section internals.
- Persisted client state: the hash, plus `localStorage` for three
  preferences only — density, sort, collapsed cards — each read inside
  `try/catch`, each with a default.

## 6. Acceptance criteria

1. `npm test` passes with **no test file modified**. `tests/wow-ui.test.ts`,
   `theme.test.ts`, `failed-runs.test.ts`, `api-keys.test.ts`,
   `model-check.test.ts` in particular.
2. `git diff --stat` touches only `src/ui/wow-ui-html.ts`,
   `src/ui/app-html.ts`, `src/ui/manual.ts`, `src/ui/CLAUDE.md` and this
   document.
3. `GET /` and `GET /wow` return byte-identical documents.
4. Every command id in `COMMANDS` is reachable from the page with at most
   two clicks from the header (Start → segment/command), **including** the
   eight the classic sidebar omitted.
5. Every row in §7 has a location on the page, checked by walking the
   table with the page open.
6. `grep -c innerHTML src/ui/wow-ui-html.ts` is 0; `manual.ts` exports data,
   not HTML strings.
7. Submitting `draft` with two context documents produces a job whose
   command line carries `--context-doc a --context-doc b` (the dead control
   works).
8. Turning off *Heal broken selectors* on `go` produces `--no-heal` on the
   command line; leaving it on produces nothing.
9. With a `catalog-run` running, the header says the browser is in use and
   the launcher's submit for a browser command is disabled with that reason
   — before, not after, a 409.
10. Opening `▸ N agent actions` on a step leaves the task open.
11. Every status chip on the page draws from one `STATUS` map with one
    legend; the strings in §3.1's middle column each appear in the glossary.
12. Below 900 px the rail is a chip row; nothing is unreachable.
13. Lighthouse accessibility on the page ≥ 95; every modal is Escape-closable
    and focus-trapped.

## 7. Retention ledger [kept]

Every feature of both surfaces, and where it lives afterwards. "Same" means
the control, its label and its backing call are unchanged.

### 7.1 Classic panel (`/`)

| Feature | Where |
|---|---|
| Sidebar: Test / Set up / Browse groups | Start › More commands (Test, Maintain); Library; Help |
| Paths footer (here, reports, proofs, cache, CDP) | Help › Where everything lands, live values; CDP also in header |
| `contextGraph` path (returned, never shown) | Help › Where everything lands |
| Topbar chips (CDP, roles keyed) | Header, refreshed every poll |
| Command form: primary fields | Start › More commands, §4.1 renderer |
| Command form: `More options (N)` drawer | four grouped drawers, §4.1 |
| `requiredWhen` gating (Database URL) | visible-disabled, §4.1 |
| Repeatable fields | chip list, §4.1 (was broken) |
| Secret fields as password inputs | same (`'secret' ? 'password'` pinned) |
| Flows datalist on `flow` / `target` | same, on the same fields |
| Missing-key banner on roles commands | same, with a link to Machinery |
| Submit → `POST /api/jobs` → attach console | same; console streams into the Now row |
| `__autorun` prefill | same (row actions use it) |
| Console dock: output toggle, status pill, command line, Stop, artifact buttons | the Now row's `outputSection`; status pill, command line, Stop, artifacts unchanged |
| Artifact click: `.html` → overlay; `.flow.json` → editor; else copy | same, but copy shows a toast and never overwrites the command line |
| Overlay viewer (`/view`, Open in a tab, Close, Escape) | same |
| SSE `replay` / `line` / `artifact` / `done` | same, plus `progress` / `cases` |
| Flows table (name, steps, modified, valid, Run, Edit) | Library › Flows |
| Empty flows state → Generate / Author | same, opens those forms in Start |
| Edit flow (textarea, Save, Save and run, Back) | Library › Flows, inline under the row, with a dirty badge |
| Reports table (Open) | Library › Reports |
| History table (status, flow, finished, steps, heals, defects, took) | Runs › Every run density; status uses the one map (was binary) |
| History count line + `historyPath` empty state | Runs footer / Help |
| Healed selectors table, Forget, Forget everything | Library › Healed selectors, confirmed |
| Runs table (status, command, started, Output, Stop) | Now › Running (live) and Runs › Failed runs (finished without proof) |
| Manual: 11 sections, TOC | Help, as data |
| Usage-cap alert dialog, 30 s poll | same dialog, on the 5 s poll; Escape closes it |
| `wowUI` nav link | gone — nothing to link to |
| Hash routing for commands | mapped, §4.6 |

### 7.2 wowUI (`/wow`)

| Feature | Where |
|---|---|
| Sidebar with live counts and alert badges | rail with counts; alerts on Now |
| Footer connection dot + proof dir | header status |
| `pageHead` + Start button | header; Start opens the launcher |
| Stats strip (Runs today, Proved, Running, Needs a human) | Runs section head, with denominators (§3.2) |
| Offline banner + Try again | Now / header |
| Resumable catalog-run banners, five buttons | Now, uncapped, case picker |
| Running-now rows: rail, title, command line, progress, Output, Pause, Stop | Now › Running |
| Case rows (`c1`, exclusive, status, progress, per-case output) | same, under the running row |
| Empty "Nothing has been proved yet" | Runs empty state |
| Group header: badge, origin, model, run key, tally, accuracy, cost, Rerun all, Heal all, Rename, Delete | same; collapsed groups disable the action strip (was live while hidden) |
| Hand-authored group + browser-busy dot | same; busy state also in header |
| Scenario heads with tally, cost, suite buttons | same |
| Task row: rail, name, polarity, sub, verdict chip, counts, session cost tooltip, per-role cost, Run again, Repair | same; Repair enabled for `failed`, `dead-end` and `error` (was `failed` only, contradicting the suite buttons) |
| Task detail: Run timeline, Rename, cycle chips, Hide (✕), trend, claims summary, checks table, review block, why block, Command output, View / Record actual flow, Open the raw proof, Run again | same; Command output moves into the action strip |
| Checks table: 5 columns, backend / family / proved-? / visual-only tags, amber ≥ 2 s, healed tag, agent actions, See evidence, footer sums | same; step highlighted while its evidence is open |
| Workflow step expansion (goal, reported, turns, settledBy, action log) | same, own open-state |
| Evidence drawer: Error / Trace / Fix tabs, footer copy actions | same; side panel ≥ 1200 px |
| Trace: video seek, screenshot (base64), URL, prove-again command, Database check, asserted traffic, forbidden calls, recorded calls | same |
| Fix: healer proposal, agent, defects | same |
| Flow player modal | same, Escape closes |
| Delete-group modal | same idiom, used everywhere (§4.3) |
| History: live jobs card | Now (once) |
| History: Failed runs section, 12 reason lines | Runs › Failed runs |
| History: filter pills | Runs filters |
| History: Clear history (self-arming) | Runs overflow, one idiom |
| History: group headers, scenario heads, rows with Raw proof | Runs › Every run density |
| Healed selectors page | Library › Healed selectors |
| Needs a human: streak cards, defect cards, Repair it, Show the evidence, Open the raw proof | Now › Needs a human, full scan |
| Reports page | Library › Reports |
| Launcher: three modes, all shared fields, options drawer, `syncSubmit` | Start, plus More commands |
| Add Context: upload, paste, stored list, remove | same |
| Add Catalog: upload / paste, Process catalog, reading progress, claims gate, lanes table, non-testable lines, attachable context, Prove N claims | same; one Process button |
| Describe: textarea, Unit / End-to-end | same |
| `readClaims` → `awaitJob` polling → claims file | same |
| Models and keys: Check all / Refresh models / Re-read .env, unkeyed banner, role table, model picker (provider, model datalist, port), put it back, key cell, fallback cell, Ready cell with note | Machinery › Models and keys |
| Provider key cards: Get a key, free-tier note, Start here / in use | same |
| Claude session: quota bars, usage cap (enable, percent, Save, status, Reset hold), `claude -p` usage, run-script cards (binary, args, extra, Save, hardcoded note) | Machinery › Claude session |
| Database card: masked DSN, Check, facts, probe result, repo hints, suggestion | Machinery › Database |
| Repositories: path input, Scan and save, table, Remember document…, Re-scan | Machinery › Repositories |
| Explainer box (Check / key swap) | `?` popover + Help |
| Toasts, copy, nearing-cap toast, cap alert dialog | same |
| Polling 5 s / tick 1 s / launcher 700 ms | same |
| Hide → `archived/`, rename flow, rename group, delete group | same; inline rename |
| Sort (documented, unimplemented) | implemented, Latest / Name |
| Command panel link | gone — nothing to link to |

## 8. The contract the page consumes, unchanged

Every call the page makes, and nothing else. Method, path, and the module
that owns it (untouched).

| Call | Owner |
|---|---|
| `GET /api/meta` | `server.ts:318` |
| `GET /api/jobs`, `POST /api/jobs {commandId, values}`, `GET /api/jobs/:id`, `POST …/stop`, `…/pause`, `…/resume {mode, caseId?}`, `GET …/events` (SSE: `replay`, `line`, `artifact`, `progress`, `cases`, `done`) | `server.ts:343-505`, `jobs.ts` |
| `GET /api/catalog-runs`, `POST /api/catalog-runs/resume {ledgerPath, mode, caseId?}` | `server.ts:513-605`, `catalog-runs.ts` |
| `GET /api/proofs`, `GET /api/proofs/:runId`, `POST …/review {verdict}`, `…/hide`, `…/delete`, `…/rename {name}\|{group}` | `server.ts:925-1097`, `proofs.ts` |
| `GET /api/failed-runs` | `failed-runs.ts` |
| `GET /api/flows`, `GET /api/reports`, `GET /api/history`, `GET /api/cache`, `GET /api/repos` | `server.ts` |
| `GET /api/file?path=`, `PUT /api/file?path= {content}` | `server.ts:1116-1160` |
| `GET /api/keys`, `POST /api/keys {provider, index}`, `POST /api/keys/reload` | `keys.ts` |
| `GET /api/models`, `POST /api/models {role, provider, modelId, port?}\|{role, reset}`, `POST /api/models/check {role?}`, `POST /api/models/refresh` | `models.ts`, `checks.ts` |
| `GET /api/documents?kind=`, `POST /api/documents`, `DELETE /api/documents?kind=&path=` | `uploads.ts` |
| `GET /api/db`, `POST /api/db/check` | `db-status.ts` |
| `GET /api/claude`, `POST /api/claude/run-script` | `claude-settings.ts` |
| `GET /api/usage-cap`, `POST /api/usage-cap`, `POST /api/usage-cap/reset` | `usage-cap.ts` |
| `GET /view?path=` | `server.ts:1164` |

Error shapes the page must render, not swallow: **409** browser busy /
usage-cap hold / catalog run still running / already ruled; **400** field
errors from `buildArgv` (quoted field name), bad resume mode, bad case id;
**404** no such job / proof / catalog run; **403** path outside roots.

## 9. Work plan

Each step leaves the tests green; none touches the frozen list.

1. **Shim and scaffold.** `renderApp()` → `renderWowUi()`. Add the six
   section hosts and the rail to the existing page *around* the existing
   views, with the views still rendering into `#runs`. Tests green. Old
   hashes mapped (§4.6).
2. **Manual to data.** Restructure `manual.ts` into
   `{ id, title, blocks: Block[] }` where a block is a paragraph, a table, a
   code block or a list; render in Help through `el()`. Add the glossary.
3. **Generic command form.** Port `renderCommand` from `app-html.ts` under
   the §4.1 rules; wire as the fourth launcher segment; chip list for
   repeatables; positive switches. Acceptance 4, 7, 8.
4. **Fold History into Runs.** Filter pills, sort, density toggle, one row
   detail; move Clear history; keep Failed runs. Retire `renderHistory`.
5. **Now.** Move running rows, resumable banners (uncapped, case picker),
   attention cards (full scan), offline and cap callouts. Retire
   `renderAttention`. Header status refreshed per poll.
6. **Library.** Reports, Flows (with the inline editor from the classic
   panel), Healed selectors as cards. Retire `renderReports`, `renderHealed`.
7. **Machinery.** `renderKeys` internals + `renderRepos` as cards.
8. **Evidence side panel** and the three open-state slots. Acceptance 10.
9. **One destructive idiom**, Escape and focus everywhere. Acceptance 13.
10. **Delete `app-html.ts`'s old body** (it is a shim from step 1; its
    `STYLE`, `SCRIPT`, `renderSidebar` and friends are dead), update
    `src/ui/CLAUDE.md` to describe one surface, and add the sort the doc
    already claims.

## 10. What this deliberately does not do

- No new endpoint, field, flag or command. Where the page would be better
  with one (an *unhide* that moves a bundle back; a `contextGraph` size on
  `/api/meta`) the page says what it cannot do instead of pretending.
- No change to `commands.ts` labels or help text, even the duplicated ones
  (`no-author-review` three times, two "Autoheal enabled" explanations) —
  the renderer chooses which sentence to show; the source stays.
- No theme toggle. The page follows `prefers-color-scheme` and
  `[data-theme]` from `theme.ts` as both surfaces do today.
- No sockets. Polling stays, for the reason `src/ui/CLAUDE.md` gives: a run
  started in another terminal produces no event this server could push.
- No removal of the `/wow` route or the `--wow` flag: both are server and
  CLI code.
