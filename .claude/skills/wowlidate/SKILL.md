---
name: wowlidate
description: Start a wowlidator catalog validation run end to end — collect the catalog, app URL, credentials and lane settings, predict persona coverage before spending a browser, then launch and watch it. Use this whenever the user says "/wowlidate", "run the catalog", "validate this sheet", "start a wowlidator run", "run the EC cases against <app>", or hands over a test-case workbook/CSV and an application URL. Also use it when they name only a catalog file and expect a run — ask for the missing parameters rather than guessing them. A single case's report from a finished run ("the report for PL_09_01") goes through §7 here, which hands it to grim-qa-report.
---

# Start a validation run

A catalog run is expensive to start and cheap to get wrong. Eight Chromes, five
model roles and an hour of wall clock can produce one verdict if a single
parameter is missing — that is not hypothetical, it is what happened on
2026-09-07, when 308 of 309 EC cases were refused before any model was called
because no persona credentials were supplied.

So the shape of this skill is: **gather, predict, prove, then launch.** The
prediction step is the whole point. Everything before the launch costs seconds;
everything after it costs hours.

## 0. Resolve the target, when one is named

An environment that has been run before is stored, so it is never re-derived by
hand. `targets.json` holds the named ones; `/wowlidate <catalog> humi-sit` — or
any message naming a known target — resolves through:

```bash
node .claude/skills/wowlidate/target.mjs list        # what is defined
node .claude/skills/wowlidate/target.mjs humi-sit    # resolve and prove one
```

It prints the flags to append (`--url`, `--repo`), and **checks the things that
have each cost a run**: the host resolves over the VPN to the IP it should, the
`--repo` graph exists and carries table nodes, the required `.env` keys are set,
and `WOWLIDATOR_DB_URL` actually points at the host, port, database and user the
target declares. Exit 0 is ready, 1 is not ready, 2 is no such target.

That last check earns its place. On 2026-09-07 a connection string named the
right database, user and password on the **wrong host** (`localhost` instead of
`10.179.72.9`); nothing failed loudly, and every claim asserting database state
quietly degraded to what the UI alone showed. Coordinates are compared and the
port is probed; no password is ever read, printed, or put on a command line.

A target answers **where**, never how hard. Lanes, policy and repair stay a
per-run decision because they belong to the catalog, not the environment — so
steps 1 and 2 still apply in full.

To add a target, put its non-secret coordinates in `targets.json` and name the
`.env` keys it needs under `requires`. **No credential belongs in that file**:
it is tracked in git.

## 1. Gather the parameters

Four things decide whether a run is worth starting. The user usually supplies
one or two; ask for the rest with `AskUserQuestion` rather than assuming, and
ask for them **together in one prompt** — a run held up by four sequential
questions is a run the user abandons.

| Parameter | Flag | Required? | If not given |
|---|---|---|---|
| Catalog | positional | **yes** | Ask. Nothing else matters without it. |
| Application URL | `--url` | **yes** for `--run` | A named target supplies it (step 0). Otherwise ask — there is no sensible default; `CLAUDE.local.md` says targets vary per run. |
| Credentials | `--as`, `--persona`, `WOWLIDATOR_PERSONAS` | **yes** in practice | Step 2 measures the damage exactly. Never invent an account. |
| Lanes | `--concurrency`, `--browsers` | no | 8/8 is the measured working shape for a large catalog; 1/1 is the A/B test when a parallel result looks wrong. |

Read the catalog path and URL out of the user's message when they are there.
`/wowlidate <file>` with nothing else is the common case and is exactly when you
must ask for the rest.

Worth asking about only when the catalog or the user's request implies them:

- `--sheet` / `--category` — a workbook the user wants one slice of.
- `--include-blocked` — rows the sheet's own testers could not run. Off by
  default for a good reason: each names a bug ticket the run would only file
  again. Turn it on when the user is re-validating a fixed build.
- `--policy read-only|forms|mutations` — `mutations` is the default and writes
  data. On a shared environment, confirm the user means it.
- `--report-lang en|th` — the language of each case's own report page (the
  page the catalog index links from every case name: summary, tickets, the DB
  evidence and the queries behind it, film, stills) and of the model-written
  narrative on it. English unless the user asks; a Thai-speaking reader of an
  EC catalog usually wants `th`. Recorded on the ledger, so a rebuild keeps it.
  `--no-case-narrative` skips the one generator call per case that writes the
  narrative — worth offering on a very large catalog.
- `--repo` / `--db-schema` — without an indexed schema, claims that assert
  database state silently degrade to what the UI alone shows. The run prints
  this as a `!` warning; it is worth one question before launching, not a
  surprise in the report.

## 2. Predict what the run would actually prove

Run the preflight before anything else. It reads the sheet through the
project's own parsers (`parseTestCaseTable`, `parseWorkbookCases`,
`tablePersonas`) so it cannot disagree with the run it is predicting, and it
loads `.env` the same way the CLI does:

```bash
npx tsx .claude/skills/wowlidate/preflight.mjs <catalog> [--include-blocked] [--as <email>:<pw>]
```

It prints how many rows would author, how many would be blocked, and which
persona labels are missing with a count of rows each one costs.

**Why this gate is not optional.** A row whose persona has no credentials is
refused and recorded at `AUTHORING_REFUSAL_CAP`, which is the value that tells a
later `--resume` to stop re-authoring it. The refusal is sticky: fixing the
credentials afterwards and resuming will *not* pick those rows back up — they
need `--rerun-case <id>` one at a time. Ten seconds here saves an unrecoverable
run.

How to act on the number:

- **Coverage is high (say 90%+)** — report it, name the few blocked labels, and
  ask whether to proceed or supply the rest first.
- **Coverage is low** — stop and say so plainly, with the missing labels ranked
  by rows blocked. Offer the `.env` line the preflight already printed. Do not
  launch a run that is mostly refusals to "see what happens".
- **The catalog is not this project's table format** — the preflight says so and
  can predict nothing. Suggest `--claims-only` first so the user reviews what the
  model thinks the document claims before a browser is involved.

Credentials belong in `.env` (gitignored, and loaded before the persona parser),
not on the command line: argv is readable by every process on the machine via
`ps`. If the user offers a password in chat, put it in `.env` and never echo it
back.

One trap worth naming: the **first** persona a row mentions falls back to the
unlabelled `--as` account, but a second never does — one session cannot be two
people. So `WOWLIDATOR_AS` alone often lifts coverage dramatically, and the
preflight already accounts for it.

## 3. Prove the model ids still resolve

```bash
npm run cli -- doctor
```

Model ids drift faster than the code, and `doctor` making one real one-token
call per role is the only evidence a default still resolves. A run that dies
forty minutes in on a retired model id is the failure this prevents.

Providers are chosen **per run, by environment, not by editing config** — every
role reads `WOWLIDATOR_<ROLE>_PROVIDER` / `_MODEL` / `_EFFORT`, where role is one
of `healer`, `generator`, `agent`, `data`, `governor`. Put them on the command's
own environment.

**A running suite cannot be re-pointed.** `loadConfig()` is called once, at
`src/cli.ts:318`; the resulting config is frozen into the `LlmFactory` and
`forRole` memoises per role, so nothing re-reads the environment per call and no
signal or control file changes a model mid-flight — pause is the only live
control there is. To move a role while a catalog is in progress: raise the pause
(`touch <claims>.progress.json.pause`), wait for the suite to seal and exit, then
relaunch with the new environment and `--resume`. It costs only the in-flight
cases, which keep no verdict and are re-run; every sealed verdict survives and
the run key is unchanged. Done on 2026-09-07 at 96 of 440 sealed: paused in five
seconds, resumed on sonnet with 82 verdicts kept and flows reused. Measured on real runs: `codex-cli` sustained ~14 h without a
quota wall; `agy-cli` allowed roughly 18 minutes of 8-lane work per 5 hours.

## 4. Launch

Start from a clean browser pool — a stale Chrome on the run's ports is a
confusing failure much later:

```bash
pkill -f "remote-debugging-port=93"
```

Skipping it is not a warning later — it is a run that dies before its first
case. Measured 2026-09-10 15:17: `browser 1 of 4: Chrome did not open port
9333 within the boot timeout`, a folder holding a log and a claims file and no
ledger, and a monitor saying "no ledger" for as long as anyone looked. A
folder with a log and no ledger is exactly that shape; the log's last
`wowlidator:` line says why (the monitor now prints it in the same place).
Re-run the `newrun.mjs` eval — it reuses the folder — and relaunch.

**One catalog, one folder.** Ask for the run's own folder before launching;
never write a run into the shared report tree:

```bash
CATALOG="<the sheet>"
APP_URL="<the deployment>"

eval "$(node .claude/skills/wowlidate/newrun.mjs "$CATALOG" --name <short-slug>)"
```

That creates `<report-dir>/runs/<slug>-<stamp>/` with `catalogs/`, `proofs/` and
`monitor/` in it, plants a copy of the monitor page inside, and exports
`WOWLIDATOR_REPORT_DIR` and `WOWLIDATOR_PROOF_DIR` at it. Those two variables
are the whole mechanism — the engine already routes every artifact through
them, so the per-case HTML reports, the catalog report, the `-media` folder
holding the recordings and workbooks, the proof bundles, the claims file and
the ledger all land inside that one folder with no change to `src/`.

It says on stderr which folder it chose, and the choice matters more than the
folder does: **an existing folder for that slug that already holds a ledger is
reused**, because `--resume` finds a ledger by path and a freshly stamped
folder every launch would turn every re-entry into a full re-run. A new folder
is stamped only when there is nothing to resume; `--fresh` forces one. Each
launch still gets its own log — the ledger is the run's memory and must be one
file, but a log is what a single launch said.

Then launch into it. `$WOW_RUN_LOG` is already inside the run's folder:

```bash
npm run cli -- catalog "$CATALOG" --url "$APP_URL" --run --resume \
  --concurrency 8 --browsers 8 --headless --video on \
  > "$WOW_RUN_LOG" 2>&1 &
```

Run it in the background and tell the user the log path. A catalog run outlives
any single command, and holding the foreground blocks the conversation for hours.

**The Jev engine** (TypeSafe's decision model, 2026-09-18) is a per-launch
choice of the agent role, never an edit to `.env`: put the two variables on
the command itself. Authoring then selects the programmatic catalog author on
its own (`--author-mode auto` reads the agent role), so no flag is needed;
`--author-mode llm` keeps the LLM author under Jev, `--author-mode jev`
forces the programmatic one under any agent.

```bash
WOWLIDATOR_AGENT_PROVIDER=openrouter WOWLIDATOR_AGENT_MODEL='~typesafe/jev-latest' \
npm run cli -- catalog "$CATALOG" --url "$APP_URL" --run --resume \
  --concurrency 8 --browsers 8 --headless --video on \
  > "$WOW_RUN_LOG" 2>&1 &
```

Needs `OPENROUTER_API_KEY` in `.env` (`TYPESAFE_API_KEY` with
`WOWLIDATOR_AGENT_PROVIDER=typesafe` for the native endpoint). The `data` role
must stay a chat model: Jev answers no schema, and the value resolver, the
review and the risk judge borrow `data` for their structured questions. Say in
the report that the agent was Jev — its turns carry `p=` and `confidence` on
every action line, and the ledger's `launch.authorMode` records the author.
Measured 2026-09-18 on HUMI SIT: a leg reaches its form in four turns at
~0.4 s each; date pickers and open listboxes are handled by the engine's own
rungs, not by the model.

Every case's own report — the file the catalog index links from the case's name
and the panel's card opens — is the case page (`src/reporter/case-page.ts`:
summary, coverage, tickets, the DB evidence and the queries behind it, film,
stills; since 2026-09-10) with nothing to add to the command. `--report-lang th`
is the only choice to make, for a Thai-reading audience; a run launched from the
panel needs `npm run build` first, because the panel runs `dist/cli.js`.

**Check nothing else is already running first.** Two catalog runs on one
machine share the Chrome pool and the model session, and the `pkill` above
kills the browsers out from under whichever was there first — that happened on
2026-09-08, to a run 51 minutes in. One reading answers it:

```bash
ps -eo pid,etime,command | grep "cli.ts catalog" | grep -v grep
```

Then open the monitor, so the run has a face while it works. Point the watcher
at the run's own copy of the page, not the skill's — the state file has to be a
sibling of the page that loads it, and two runs writing one `run-state.js` is
two runs sharing one monitor:

```bash
npx tsx .claude/skills/wowlidate/monitor/watch.mjs --out "$WOW_RUN_STATE" &
open "$WOW_RUN_PAGE"       # macOS; xdg-open elsewhere
```

The watcher inherits the run's `WOWLIDATOR_REPORT_DIR` from the same `eval`, so
it looks for the ledger and log inside the run's folder and cannot pick up a
different run's counts. From a fresh shell — no `eval` — name the run instead:
`--run be-sit-high` (a run folder's name or any prefix of it, newest match
wins) or `--run <folder path>`. Without either it searches every
`runs/<slug>-<stamp>/catalogs/` newest first, then `<report-dir>/catalogs/`,
then the in-repo default, and pairs the ledger to the newest LOG's own
`claims` header, never to the newest ledger anywhere (`paths.mjs`,
`catalogDirs`). Until 2026-09-10 it searched `<report-dir>/catalogs/` alone
and answered "no ledger" about every run in a run folder.

`tsx`, not `node`: the watcher reads the account's quota through the project's
own `fetchClaudeQuota` and the `claude -p` ledger through
`readClaudeCliUsage`, rather than a second copy of either. Under plain `node`
the TypeScript import fails, the page still shows the run, and the Claude panel
says why it is empty.

It also reads `.env` the way the CLI does, so the quota settings and the role
models it shows are the ones the run is actually using.

**Both paths are re-resolved until they answer** (2026-09-09). They were
resolved once at module load, and the launch order above starts the watcher in
the same breath as the run — so at that instant the log is empty, its `claims`
header is unwritten, and the run's own folder holds nothing. Every source
answered null, and **null latched**: the page said *"no ledger … the run has
not sealed its first case yet"* for the whole run, with a healthy ledger
sitting beside it seconds later and the counts never moving. The watcher now
asks again each tick while a path is still unknown, and stops asking once it
has one — re-resolving a path already held would let a later run's files steal
a running watcher, which is the pairing lie `ledgerFromLog` exists to prevent.
An explicit `--ledger` / `--log` still wins outright.

`watch.mjs` finds the newest log itself — resolving `WOWLIDATOR_REPORT_DIR` the
way the CLI does, so it looks where the run actually writes — and then asks
that log which ledger is its own, by the `claims …` line in its header. Newest
log and newest ledger were once picked independently, and the pair could belong
to two different runs: on 2026-09-07 a single-case run's log was shown beside
the paused 440-case sweep's counts. The header wins, existing or not — an
unwritten ledger reads honestly as "has not sealed its first case yet", which
is worth more than another run's numbers. `--ledger` / `--log` still override. It writes `run-state.js`
beside the page, and the page re-injects that script every three seconds. A
`file://` page cannot `fetch` a sibling file, but it can load one as a script;
that is the whole reason the state is JS rather than JSON, and it is what makes
the page live with no server behind it. Kill the watcher when the run ends.

**The page is view-only, deliberately.** There is no control on it that can
touch the run. The run-log terminal's filter, follow and clear are the only
controls on the page at all, and each of them changes what that page shows and
nothing else. That is what makes it safe to leave open on a second screen for
five hours: a monitor that can also act is a monitor you hesitate to leave
open.

**There is no "run only this case" flag.** The narrowing flags are `--sheet` and
`--category`; `--rerun-case <id>` resets a named case but `--resume` still runs
every other case without a verdict. To prove one row on its own, cut it into a
one-row CSV (header + that row, with a real CSV parser — the Steps and Expected
columns contain newlines) and run that as its own catalog. It gets its own
claims file, ledger and report, and the big run's ledger is untouched and still
resumable under its own key.

**`--resume` belongs on essentially every launch.** It skips anything that
already holds a verdict, and reusing authored flows is nearly free next to
writing them (a real re-entry reused 188 of 284). The `--rerun-*` family is the
opposite: `--rerun-errors` and `--rerun-failed` *reset* those cases to unrun
first, so a run that then stops short leaves the ledger poorer than it found it —
55 sealed `failed` verdicts were lost that way in one afternoon. Pass them only
when the run will finish, and say so when you do.

## 5. Watch it

The monitor from §4 answers "is it alive, and what has it proved" at a glance:
the split progress bar, the six counts, the live log feed and the newest
verdicts with their reasons.

**A verdict is a way in, not just a line.** Every sealed case the ledger records
a `reportPath` for is a link straight to that case's own HTML report — the
proof behind the verdict, one click from the row that states it. A case the
harness never wrote a report for (a dependency-blocked row, most often) is
shown plainly as un-clickable rather than as a link to a blank page. The panel
holds **every** sealed outcome, not the newest few, because the search box above
it is there to answer "where is PL_04_13", which a list of forty cannot. Search
matches the case id, its scenario, its status and its reason; the chips beside
it filter by verdict and carry their own counts.

The **Claude panel** answers the other half — not "what has the run proved" but
"can it keep going". Three things sit there: the account's quota windows
(session, week, and the week scoped to a model) with the **hold line drawn on
the session bar**, because dispatch stops at `WOWLIDATOR_QUOTA_HOLD_PERCENT`
and that, not exhaustion, is the line a long run actually meets; today's calls,
cost, output tokens and average call time, with the per-role split that says
where the money went; and the last model calls with their role, model, wall
time and any `cold` restart or `error` finish. A run that has gone quiet is
usually one of these — the window held, or the warm session dropped — and the
header carries a `warm drops` chip when the log shows the latter.

It shows **two clocks** on purpose — when the run
last *wrote*, and when the watcher last *read* — because a dead watcher in front
of a healthy run looks exactly like a live watcher in front of a wedged run, and
only the pair tells them apart.

**Whether the run still exists is a third reading, and neither clock gives it.**
Every other number on the page says what the run *wrote*; only the process table
says whether it is *there*. The watcher scans `ps` for the catalog process each
tick and the header carries a `pid … · up …` chip while it lives. That matters
because a killed run seals no `ended` — before this the page called a corpse
`idle`, which is the same word it uses for a run between cases. A fresh log
outranks the scan: something is plainly writing, so a pattern that failed to
match is the scan's problem. Only when the log has *also* been silent for two
minutes does the absence of a process become the `gone` phase, and then the page
says so in red, because that run needs a `--resume`, not patience.

**The run log terminal** below the two feeds is the log verbatim — the activity
feed is filtered so a person can read it, and this is what the run actually
wrote. Lines are appended by absolute byte offset, so none is ever printed
twice and the scrollback keeps far more than the watcher's 256 KB window holds
at once. `follow` sticks to the bottom and releases the moment you scroll up;
the filter and `clear view` are local to the page. Raise the per-tick ceiling
with `--tail-lines <n>` (400 by default) if a very fast run outruns it.

For anything the page does not answer, poll every few minutes; never with a
foreground `sleep` alone. The suite prints
a running tally (`passed N · failed N · blocked N · left N`), and the ledger
beside the claims file is the durable record:

```
$WOW_RUN_DIR/catalogs/<claims>.progress.json
```

What to look for, in the order it usually bites:

- **`skipped — persona …`** — the step-2 gate was missed. Stop the run; it will
  not get better, and every refusal is sticky.
- **`  ! ` lines** — the harness saying something it could not do: no DB schema
  indexed, a report that could not be written, autoheal requested without a key.
- **`no verdict:`** — a case the harness ended without proving anything. This is
  a framework problem, not an application one, and is where the interesting bugs
  live.
- **quota holds** — with a `claude-*` provider, dispatch stops at
  `WOWLIDATOR_QUOTA_HOLD_PERCENT` of the session window (default 85) and resumes
  when it reopens. A pause here is the system working, not stalling.

`/monitor` attributes wall-clock time to authoring, agent legs or the ladder when
the question is "why is this slow" rather than "what broke".

## 6. Report

The report rebuild needs no browser and no model, so it is how to re-render a
finished run — and a long-lived run keeps the code it started with, so a
reporter fix merged mid-run only reaches that run through this:

```bash
npm run cli -- report "$WOW_RUN_DIR/catalogs/<claims>.progress.json"
```

Point it at the **ledger**. Bare `report` reads `.wowlidator/catalogs/`, which is
not where a catalog run's ledger lives. The rebuild also rewrites **every
case's own page** at the path the ledger names (the per-case report inside the
run folder is the case page since 2026-09-10) — so a run launched before a
reporter change gets the new page at the same address it always had. Add
`--case-narrative` to back-fill the model-written narrative on those pages;
without it the rebuild spends no model call. Re-export the run's
`WOWLIDATOR_REPORT_DIR` first (re-run the `newrun.mjs` eval, which reuses the
folder) or the rebuilt report is written outside the run it describes.

## 7. An individual case report

The case page from §4 and §6 is what the harness writes for every row, and it
stays the link the catalog index and the monitor open. When the user asks for
**one case's report as a deliverable** — a package a reviewer can pick up by
test case id, "the report for PL_09_01", "write up EC-026", a ticket
attachment — do not hand-write it and do not point them at the case page.
Invoke the `grim-qa-report` skill (the Skill tool, `/grim-qa-report`) and
feed it from the run folder; it owns the naming, the evidence contract and the
delivery checks, so a report written any other way is the one that will not
validate.

What it needs and where a run keeps it (the ledger's outcome for the case
names the exact files):

| Grim input | Source in `$WOW_RUN_DIR` |
|---|---|
| Test case, test data, expected result | the row in the catalog the run was launched from (`catalogs/<slug>.claims.json` → `catalog` names the file; `claims[].source` is the case id). The claim text is a summary, not the row. |
| Verdict, status, reason | `catalogs/<slug>.claims.progress.json` → `outcomes[<id>]` — the seal, never re-derived from the proof |
| Steps, defects, per-step DB checks (`db`, `dbChanges`, `dbProbeError`) | the proof bundle at `outcomes[<id>].proofPath` (`proofs/<uuid>.json`) |
| Screenshots | `steps[].screenshot` — base64 JPEG, failure stills only when video is on; decode to `<ID>-evidence-NN.jpg` (they are JPEG bytes) and embed a `sips -Z 440` thumbnail, not the full frame |
| Recording | `video.data` in the same bundle — base64 webm; decode to `<ID>-run-01.webm` and give it a still as `poster` |
| DB before / after | `dbBaseline.tables` + each step's `dbChanges` sample against the baseline; a value the run never measured is `NOT_CAPTURED`, never inferred |
| The authored flow | `outcomes[<id>].flowPath`, for the exact selectors and DB queries the run performed |

Two things the harness's ids do that the validator does not accept: the sheet
writes `PL_09_01` and the validator wants uppercase hyphen-separated
(`PL-09-01`), so the file prefix is the id with `_` → `-`, and the report's
own header keeps the sheet's spelling so a reader can search the catalog for
it. And a bundle carries a `summary.session` cost line — leave it out of the
package, it is not evidence of the case.

**Do not hand-write the page.** `grim-qa-report` ships
`scripts/build_report.py`, which reads exactly the files in the table above and
writes the whole package in the layout its `reference/layout.md` fixes: sticky
contents, lead verdict card, one card per Expected line, tickets, the case as
the sheet states it, what actually ran, the DB table, the screenshot timeline
and the file list. Adapt its two per-case parts — the Expected-line list and
the DB field map — and leave the rest. Three rules from that contract bite
here in particular:

- **Label every count's unit.** Expected occurrences, the harness's own step
  results and catalog outcomes are three different numbers and are never added
  together. Zero failed outcomes means nothing was observed failing, not that
  the run passed.
- **Embed thumbnails, link the full frames.** A page with forty full-resolution
  stills inline runs to tens of megabytes and the embedded film never gets the
  decode budget to become playable. `sips -Z 440` for the embed, the anchor
  points at the full file beside it.
- **A step the reconstruction rung rescued did not stop the run**, so it stays
  out of the blocking list and is counted on its own.

Write the package beside the run, not inside it:
`$WOW_RUN_DIR/../<slug>-grim/<ID>-report.html` and siblings, so `report`
rebuilds (§6) never overwrite it and the run folder stays what the CLI wrote.
Then run the bundled validator and open the prefixed report before handing
over the path — that is the skill's own last step. The validator checks
structure, not rendering, so open the page as well; Chrome may refuse a
`file://` navigation from a new tab, and a loopback `http.server` in the
package folder answers the same question.

## Reporting back to the user

After launching, tell them in a few lines: what is running, the coverage
prediction from step 2, the log path, and the one thing most likely to go wrong
given what step 2 found. Do not narrate every flag you passed — they chose them.
