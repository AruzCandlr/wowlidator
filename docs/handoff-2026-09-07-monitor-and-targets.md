# Handoff — 2026-09-07, afternoon

**Checkout:** `~/Documents/workspace/ai-val/wowUI`, branch `pken-access`, head `816d8a5`.
Nothing committed this session — every change below is in the working tree.

## What is running right now

A **BE catalog run**, started 15:43 local, still going at 16:10.

```
catalog ~/Downloads/QA_Task_Tracking_Cycle1_SIT_Optimized_BE.csv
  --url https://humi-sit-int.central.co.th/humi/th/login
  --run --resume --repo humi-SIT-1fc0
  --concurrency 8 --browsers 8 --headless --video on
```

58 of 440 reached — passed 14, failed 30, review 4, blocked 10; 119 authored.
Ledger: `valst-output/reports/catalogs/qa-task-tracking-cycle1-sit-optimized-be-csv.claims.progress.json`.
Log: `valst-output/reports/catalogs/be-run-20260907154430.log`.

**It will not finish this window.** Session quota was 31% at 15:30 and 69% at
16:01, on 1,085 claude-cli calls and about $93 today. The hold is 85, so
dispatch pauses well before the session resets at 19:10 local. That pause is
the system working, not a stall — but plan the evening around it.

Two other runs sit unfinished; `node .claude/skills/wowlidate/resume.mjs` lists
all three with their run keys:

| slug | state | reached | left | note |
|---|---|---|---|---|
| `…-be-csv` | running | 58/440 | 382 | the one above |
| `…-ec-csv` (07:58 key) | stopped | 180/309 | 129 | SIGTERM; 164 blocked, 16 failed, **0 passed** |
| `…-ec-csv` (07:12 key) | abandoned | 31/309 | 278 | in-repo `.wowlidator/`, not the report dir |

The two EC ledgers are **different runs under different keys in different
directories**. Resuming the wrong one orphans the other's verdicts.

## What landed this session

### 1. The wowlidate monitor shows Claude, not just the run

`.claude/skills/wowlidate/monitor/` — `watch.mjs` now projects a `claude`
section and `index.html` renders it:

- the account's quota windows (session, week, week-scoped-to-a-model) with the
  **hold line drawn on the session bar**, because dispatch stops at
  `WOWLIDATOR_QUOTA_HOLD_PERCENT` and that, not exhaustion, is the line a long
  run actually meets;
- today's calls, cost, output tokens and average call time, with the per-role
  split that says where the money went;
- the last model calls with role, model, wall time, and any `cold` restart or
  `error` finish;
- header chips for `claude session NN% / 85` and `warm drops`.

Both numbers come from the project's own readers — `fetchClaudeQuota` and
`readClaudeCliUsage` — never a second copy. A monitor that disagrees with the
run it watches is worse than none.

**The watcher now needs `npx tsx`, not `node`:**

```bash
npx tsx .claude/skills/wowlidate/monitor/watch.mjs &
open .claude/skills/wowlidate/monitor/index.html
```

Under plain `node` the TypeScript import fails, the run half still renders, and
the panel says why it is empty.

### 2. A published dashboard for the EC run

`https://claude.ai/code/artifact/69b981dc-b774-4aec-abe5-8321202d15e9` was
repointed from the stale `wowlidator-pken` paths to this checkout, and rebuilt
on the `db` capability: it subscribes to a `state/current` document instead of
carrying a baked-in snapshot, so a reload always shows the newest push. Declaring
`db` makes it organisation-internal — it can no longer be shared publicly.

State is pushed from here with the Artifact tool; a local process cannot write
to it. The reader is in this session's scratchpad (`run-state.mjs`) and is
superseded by `watch.mjs`, which now reads the same things and more.

### 3. Named environments for `/wowlidate` — **built, not yet wired**

Four new files under `.claude/skills/wowlidate/`:

- **`targets.json`** — the `humi-sit` target. Environment only: `--url`,
  `--repo humi-SIT-1fc0`, and the *names* of the `.env` keys that must be set.
  No credential is in it; the file is tracked in git.
- **`target.mjs`** — resolves a target to flags and proves it is reachable
  before a browser is spent: every required env key set (by name, never by
  value), the repo graph present and carrying table nodes, and the host
  resolving to the VPN address. Exit 1 when not ready.
- **`resume.mjs`** — lists every unfinished run across *both* catalog
  directories, newest first, with run key, tally, cases left, the launch it
  came from, whether that catalog file still exists, and its db baseline.
  Reports only; re-enters nothing.
- **`paths.mjs`** — `.env` loading and report-dir resolution, done the way the
  CLI does it, shared by the above.

Verified against the live environment: `humi-sit` reports ready, host resolves
to `10.179.64.39`, graph carries 872 components / 336 routes / 136 operations /
14 tables, and `WOWLIDATOR_AS`, `WOWLIDATOR_PERSONAS`, `WOWLIDATOR_DB_URL` are
all set.

## What is NOT done — start here

**`SKILL.md` does not yet dispatch on either new form.** The scripts exist and
work; nothing calls them. The skill still assumes `/wowlidate <catalog>` and
asks for the URL and credentials every time. Needed:

1. A step ahead of the current §1 that reads the invocation:
   - `/wowlidate <target> <catalog>` → `node target.mjs <target> --json`, stop
     if it exits 1, otherwise append its `flags` to the `catalog` command and
     skip asking for the URL and credentials. Lanes, policy and repair are
     still asked, by the user's own choice — a target says *where*, never *how
     hard*.
   - `/wowlidate resume` → `node resume.mjs --json`. One candidate: confirm and
     re-enter it. Several: `AskUserQuestion` listing each with its tally and
     what it would cost, because resuming the wrong EC ledger orphans the
     other's verdicts.
2. `--rerun-*` stays off a resume unless the user asks and the run will finish:
   it resets the verdicts it names first.

Two smaller loose ends:

- `watch.mjs` still carries its own copy of the report-dir resolution that now
  lives in `paths.mjs`. One import removes the duplicate.
- The quota panel goes blank when the endpoint answers **429**, which it does
  while a run is polling it too. `claude-quota.ts` keeps the last good reading
  per process, so continuous mode self-heals after its first success; a cold
  `--once` has no cache and shows nothing. Persisting the last good snapshot
  beside `run-state.js` would fix it.

## Facts worth keeping

- **The two EC ledgers live in different places.** `.env` here redirects
  reports to `valst-output/reports`; the 07:12 EC ledger is in the in-repo
  `.wowlidator/reports/catalogs` instead. `resume.mjs` looks in both for
  exactly this reason.
- **`--repo` decides whether database claims mean anything.** The EC runs never
  passed it, so claims asserting database state degraded to what the UI showed.
  BE passes it and gets the 14 indexed tables.
- **`WOWLIDATOR_DB_RESTORE_URL` is unset**, so `wowlidator db restore` cannot
  put the SIT tables back after a mutating run. BE took a baseline of
  `benefit_management.benefit_plan`; EC took eight tables. The baselines exist;
  the restore path does not.
- **Every persona still points at one account.** Role-separation cases do not
  prove role separation — say so in a report rather than passing quietly.
