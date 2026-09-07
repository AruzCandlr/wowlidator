---
name: wowlidate
description: Start a wowlidator catalog validation run end to end — collect the catalog, app URL, credentials and lane settings, predict persona coverage before spending a browser, then launch and watch it. Use this whenever the user says "/wowlidate", "run the catalog", "validate this sheet", "start a wowlidator run", "run the EC cases against <app>", or hands over a test-case workbook/CSV and an application URL. Also use it when they name only a catalog file and expect a run — ask for the missing parameters rather than guessing them.
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

## 1. Gather the parameters

Four things decide whether a run is worth starting. The user usually supplies
one or two; ask for the rest with `AskUserQuestion` rather than assuming, and
ask for them **together in one prompt** — a run held up by four sequential
questions is a run the user abandons.

| Parameter | Flag | Required? | If not given |
|---|---|---|---|
| Catalog | positional | **yes** | Ask. Nothing else matters without it. |
| Application URL | `--url` | **yes** for `--run` | Ask. There is no sensible default; `CLAUDE.local.md` says targets vary per run. |
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
own environment. Measured on real runs: `codex-cli` sustained ~14 h without a
quota wall; `agy-cli` allowed roughly 18 minutes of 8-lane work per 5 hours.

## 4. Launch

Start from a clean browser pool — a stale Chrome on the run's ports is a
confusing failure much later:

```bash
pkill -f "remote-debugging-port=93"
```

Then launch. Keep every path relative to the repo root or in a variable; nothing
handed to another person may carry an absolute path from this machine:

```bash
CATALOG="<the sheet>"
APP_URL="<the deployment>"

npm run cli -- catalog "$CATALOG" --url "$APP_URL" --run --resume \
  --concurrency 8 --browsers 8 --headless --video on \
  > .wowlidator/reports/catalogs/<run-name>.log 2>&1 &
```

Run it in the background and tell the user the log path. A catalog run outlives
any single command, and holding the foreground blocks the conversation for hours.

**`--resume` belongs on essentially every launch.** It skips anything that
already holds a verdict, and reusing authored flows is nearly free next to
writing them (a real re-entry reused 188 of 284). The `--rerun-*` family is the
opposite: `--rerun-errors` and `--rerun-failed` *reset* those cases to unrun
first, so a run that then stops short leaves the ledger poorer than it found it —
55 sealed `failed` verdicts were lost that way in one afternoon. Pass them only
when the run will finish, and say so when you do.

## 5. Watch it

Poll every few minutes; never with a foreground `sleep` alone. The suite prints
a running tally (`passed N · failed N · blocked N · left N`), and the ledger
beside the claims file is the durable record:

```
.wowlidator/reports/catalogs/<claims>.progress.json
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
npm run cli -- report .wowlidator/reports/catalogs/<claims>.progress.json
```

Point it at the **ledger**. Bare `report` reads `.wowlidator/catalogs/`, which is
not where a catalog run's ledger lives.

## Reporting back to the user

After launching, tell them in a few lines: what is running, the coverage
prediction from step 2, the log path, and the one thing most likely to go wrong
given what step 2 found. Do not narrate every flag you passed — they chose them.
