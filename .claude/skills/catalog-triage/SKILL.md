---
name: catalog-triage
description: Triage and resume a wowlidator catalog run that stopped short — read the ledger, tell never-ran from blocked, find the dependency roots worth fixing, rebuild reports without re-running, and re-enter without destroying sealed verdicts. Use whenever the user says "/catalog-triage", "resume the run", "continue the catalog", "the run died", "why did it stop", "what's left", "pick up the handoff", asks what a finished-looking run actually proved, or hands over a ledger, a run log or a findings report and expects the run carried forward. Use it before any relaunch of an existing run — the sibling skill `wowlidate` starts new runs; this one re-enters them.
---

# Resume a run that stopped

`wowlidate` starts a run. This is the other half: a run has stopped, and the
question is what it proved, what is left, and how to re-enter without making
things worse.

Re-entry is where the expensive mistakes live, and they are all quiet. Nothing
errors when you relaunch under a fresh run key and orphan yesterday's verdicts;
nothing warns you that `--rerun-errors` just reset 55 sealed results to unrun.
The ledger is the only witness, so **read it before you type a launch command.**

## First five minutes

1. **Find the ledger** — `node .claude/skills/wowlidate/resume.mjs` lists every
   run on the machine with its run folder and ledger path. A run launched
   through `newrun.mjs` keeps its ledger in
   `<report-dir>/runs/<slug>-<stamp>/catalogs/`; one launched by hand in
   `<report-dir>/catalogs/`; `<report-dir>` is `WOWLIDATOR_REPORT_DIR` if
   `.env` sets it and `.wowlidator/reports` otherwise. See §1.
2. **Read its state** — `node .claude/skills/catalog-triage/ledger.mjs latest`
   (or a run folder's name, or a ledger path). Note `runKey` and whether
   `ended` is null.
3. **Read the blocked chains** — the top of `reports/<slug>-NNN-findings.md`.
   One root can hold nineteen cases.
4. **Decide** plain `--resume` (almost always) versus surgical `--rerun-case`.
5. **Clean the pool, prove the models, relaunch** — then hand off to `wowlidate` §4.

Report what the run proved before you spend anything continuing it. A stopped
run usually holds more information than the person handing it over realised.

## 1. Find the state

**Look up the report directory before you look for the ledger.** `.env` may set
`WOWLIDATOR_REPORT_DIR`, and then `.wowlidator/reports/` holds nothing current:

```bash
grep -E '^WOWLIDATOR_(REPORT|PROOF)_DIR=' .env    # empty means .wowlidator/reports
```

This is not a corner case — it is how a `--resume` silently becomes a full
re-run. The CLI prints `--resume: no progress ledger at <path> — running
everything` and then a **new** run key, which is §2's trap arriving by a
different road. Measured on 2026-09-07: a ledger restored to
`.wowlidator/reports/catalogs/` while `.env` pointed at
`valst-output/reports` re-authored the whole catalog. Grep that line in the log
right after launching, and confirm the run key is the one you meant to continue:

```bash
grep -E "no progress ledger|catalog run key" <run>.log
```

**Runs launched through `wowlidate`'s `newrun.mjs` are one level deeper.** The
launch exports `WOWLIDATOR_REPORT_DIR=<report-dir>/runs/<slug>-<stamp>` for
that shell only, so the ledger is at
`<report-dir>/runs/<slug>-<stamp>/catalogs/<claims>.progress.json` and a new
session's `.env` does not point there. `ledger.mjs`, `resume.mjs` and the
monitor's `watch.mjs` all search every run folder (`paths.mjs`, `catalogDirs`)
since 2026-09-10, so `ledger.mjs latest` or `ledger.mjs <run name>` finds it;
before that, a triage from a fresh shell printed "no ledger" about a run with a
perfectly good one. **A run folder holding a log and a claims file but no
ledger is a run that died before sealing its first case** — read the log's
last `wowlidator:` line; on 2026-09-10 it was a stale Chrome on port 9333
(§9's `pkill`).

The durable record is the ledger beside the claims file. Its top-level keys are
`version, title, planned, startedAt, updatedAt, generatedAt, runKey, outcomes,
ended, launch, authored`, and four of them carry the whole story:

| Key | What it tells you |
|---|---|
| `ended` | `null` means the run **stopped**; it did not finish. A finished run says when. |
| `runKey` | `<slug>@<ISO timestamp>` — the identity a `--resume` continues. See §2. |
| `outcomes` | Keyed by case id → `{verdict, status, reason}`. Only these are sealed. |
| `authored` | Keyed by case id → `{flowPath, authoredAt, risk}`. Reused free on resume. |
| `launch` | The catalog, url, persona, personas and `includeBlocked` the run actually used. |

`planned.length - Object.keys(outcomes).length` is the **never ran** count, and
it is usually the biggest number on the page.

```bash
node .claude/skills/catalog-triage/ledger.mjs latest [--reasons]        # the newest ledger anywhere
node .claude/skills/catalog-triage/ledger.mjs be-sit-high [--reasons]   # a run folder's name, or a prefix
node .claude/skills/catalog-triage/ledger.mjs <path-to-.claims.progress.json> [--reasons]
```

When nothing matches it prints every directory it searched and the newest
ledgers it found, so the next command is a copy, not a guess.

It prints the run key, whether it ended, the verdict tally, the never-ran and
authored counts, the launch parameters to match, and — the check worth having —
whether every authored `flowPath` still resolves on this machine. `--reasons`
groups the sealed cases by reason so the recurring cause is visible at a glance
rather than one case at a time.

**Read `launch` before choosing flags.** A resume that quietly changes
`--include-blocked` or the persona map is not the same run, and the ledger will
mix two populations without saying so.

## 2. A changed run key orphans the verdicts

This is the trap that has cost the most, and it leaves no error behind.

`runKey` is `<slug>@<ISO timestamp>`. A relaunch that does not resume the same
key **starts a fresh ledger**, and the previous verdicts leave the progress
file. They survive only in reports already built under `reports/`.

Measured: a handoff written 2026-09-07 recorded 8 passed / 16 failed / 283
blocked. A later relaunch under a different provider replaced the ledger, and
those 8 passes were no longer in it — the reports on disk were the only copy.

So before relaunching, read the run key and compare it to the run you mean to
continue. If they differ, **say so out loud** rather than silently starting
over. Someone handing you a run usually believes its results are still there.

## 3. Never-ran is not blocked

They look alike in a summary and need completely different work.

- **Never ran** — no entry in `outcomes`. Nobody reached it. Usually cheap: it
  just needs the run to get further.
- **`blocked`** — a real seal with a reason. Something decided this case could
  not produce a verdict.

The 2026-09-07 EC run is a useful shape for what "283 without a verdict"
actually decomposes into:

| Why | Count | What it needs |
|---|---|---|
| waiting on a prerequisite case | 84 | fix the parent; the children free themselves |
| marked for re-run, never re-run | 69 | just resume |
| cut at the case ceiling | 25 | just resume |
| Chrome died or could not be attached | 67 | a real blocker — diagnose before relaunching |
| authoring lint refused the flow | 12 | judgement, case by case (§4) |
| wrong host in the authored URL | 11 | code fix, then resume |
| harness ended the case some other way | 10 | case by case |
| `เฉพาะ`/"only" exclusivity unproved | 5 | judgement, case by case |

Two thirds of that column is "just resume". Say so — a handover that reads as
283 problems is usually a few dozen.

**Dependency roots are the highest-leverage fix.** One root, HIR-EC-001, had 19
cases waiting on it. The findings Markdown leads with a `## Blocked chains`
section naming each root and how many wait under it; read that before anything
else, and fix roots in descending order of what they free.

## 4. The `--rerun-*` family destroys sealed verdicts

`--rerun-errors`, `--rerun-failed` and `--rerun-vacuous` **reset** every
matching case to unrun *before* the run starts. If the run then stops short —
and a run that stopped once will stop again — the ledger ends up poorer than you
found it.

Measured: 55 sealed `failed` verdicts lost that way in one afternoon on
2026-09-07. Recoverable by re-running, but the afternoon was not.

The rule that follows:

- **Plain `--resume` for essentially every re-entry.** It skips anything holding
  a verdict and keeps what is already proved.
- **A `--rerun-*` only when the run will actually finish** — and say out loud
  that you are passing it, and what it will reset.
- **`--rerun-case <id>` is the safe surgical form.** It is also the *only* way
  back for an authoring refusal: a refusal is sealed at
  `AUTHORING_REFUSAL_CAP`, and a plain `--resume` will not re-author it. Fixing
  the underlying credential or lint afterwards does not lift the seal.

That last point is why §1's persona check matters before the first launch and
not after it.

## 5. Resume is cheap

Authored flows are reused as they are. A real re-entry reused 188 of 284 flows,
leaving ~96 rows to author — the expensive half of a catalog run, already paid
for. Prefer resume over restart every time; restarting is a decision that needs
a reason, not a default.

## 6. Moving a run to another checkout

`authored[].flowPath` is an **absolute** path, so a ledger carried to a
different checkout points at flows that are somewhere else — or nowhere.

Copy the ledger, the claims file and the authored flow tree, rewrite the
prefix, then verify before launching:

```bash
FROM=/path/to/source-checkout
TO=/path/to/this-checkout
SLUG=<slug>

# NOTE: if .env sets WOWLIDATOR_REPORT_DIR, substitute it for
# "$TO/.wowlidator/reports" everywhere below — that is where the run will look.
mkdir -p "$TO/.wowlidator/reports/catalogs"
cp -R "$FROM/.wowlidator/reports/<host-slug>" "$TO/.wowlidator/reports/"
cp "$FROM/.wowlidator/reports/catalogs/$SLUG.claims.json" \
   "$FROM/.wowlidator/reports/catalogs/$SLUG.claims.progress.json" \
   "$TO/.wowlidator/reports/catalogs/"

node -e '
const fs=require("fs"), [f,from,to]=process.argv.slice(1);
const s=fs.readFileSync(f,"utf8"), n=s.split(from).join(to);
fs.writeFileSync(f,n);
console.log("rewrote",s.split(from).length-1,"path(s)");
' "$TO/.wowlidator/reports/catalogs/$SLUG.claims.progress.json" "$FROM" "$TO"
```

Then re-run `ledger.mjs` and confirm it reports no unresolved `flowPath`. A
missing flow is not an error at launch — the row is simply authored again, and
you pay for the expensive half twice without being told.

**Credentials do not travel with the ledger.** `WOWLIDATOR_AS` and
`WOWLIDATOR_PERSONAS` live in `.env`, which is gitignored and per-checkout. A
checkout without them refuses every row, and per §4 those refusals are sticky.
Copy the two lines across and confirm they are there before launching; never
put a password on the command line, where `ps` exposes it to every process on
the machine.

## 7. Rebuild the reports without re-running

Needs no browser and no model:

```bash
npm run cli -- report .wowlidator/reports/catalogs/<slug>.claims.progress.json
```

Point it at **the ledger**. Bare `npm run cli -- report` looks in
`.wowlidator/catalogs/`, which is not where a catalog run's ledger lives — the
mistake is easy and the error message is unhelpful.

Outputs land in `reports/`: `<slug>-NNN.html` (86 MB is normal for a large run,
with a `-media/` folder that **must travel with the HTML**), plus
`-findings.md`, `-findings.xlsx` and `-passed.xlsx`.

A long-lived run keeps the code it started with, so a reporter fix merged
mid-run reaches that run only through a rebuild. When a report looks wrong and
the fix is already committed, rebuild before investigating.

## 8. Read the findings by owner

Every finding carries an owner — `application`, `harness` or `catalog` — and the
Markdown groups by it, application team first.

Only `application` findings are the app team's. Triage the other two yourself:
`harness` is this project's bug, `catalog` is the sheet's. On 2026-09-07, 66
findings covering 276 non-passing cases included 35 that were the harness's own;
handing that over undifferentiated spends someone else's afternoon disproving
your bugs.

## 9. Before any relaunch

Four checks, all seconds, each one having killed a relaunch:

```bash
pkill -f "remote-debugging-port=93"    # a stale Chrome fails confusingly, much later
pgrep -fl "tsx src/cli.ts"             # confirm nothing is still running
npm run cli -- doctor                  # model ids drift faster than the code
```

And check the VPN if the host is internal — the SIT host is NXDOMAIN without
FortiClient, and that alone killed one relaunch.

Then use the launch shape in `wowlidate` §4 rather than restating it here, with
`--resume` added and the `launch` block from §1 matched.

## Known open limits

Recognise these; do not re-diagnose them.

- **A re-run case gets a fresh case timeout.** The interference solo re-run
  restarts the clock, so one case still reached ~55 minutes of wall clock under
  a 20-minute ceiling.
- **The case-timeout abort does not cancel `executeFlow`, it stops awaiting
  it.** The returned bundle is `structuredClone`d so the report is not mutated,
  but the orphan keeps driving the page until `runner.close()` lands.
- **Disk fills fast.** Report media runs ~500 MB per run and `~/.codex` reached
  5.3 GB; one overnight run filled the volume and killed a scheduled relaunch.
  Check free space before an unattended re-entry.
