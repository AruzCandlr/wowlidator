---
name: jev-case
description: Run one catalog row end to end with TypeSafe Jev navigating the app over the OpenRouter decisions route, then deliver its validated Grim QA report package. Use whenever the user says "/jev-case", "run 1.001 with jev", "jev run this row", "run this case with jev-ultrafast and give me the report", or names a single test-case row plus an app and expects a report back rather than a catalog sweep. For a whole catalog use wowlidate instead; this skill is one row, one browser, one package.
---

# One row, Jev driving, a report at the end

`wowlidate` runs a catalog. This runs **one row**, and it exists because a
single row asked for as a deliverable has a different shape: the flow is written
from the sheet with no model call, the navigation is answered by a decision
model instead of a chat model, and the output is a Grim package rather than a
catalog index.

**What Jev is, and what it is not.** Jev answers the navigation decisions inside
`workflow` legs — one operation per turn, with a probability distribution and a
confidence. **Playwright still executes every action and every assertion.** It
is not an alternative browser engine and there is no flag that would make it
one; `jev-policy.ts` imports nothing from Playwright and never touches a page.
Measured 2026-09-18: 56 decision calls, each answering in 0.4–0.8 s, against a
deterministic ladder that ran the sign-in and the form fills for free.

Say in the report that the agent was Jev. Its turns carry `p=` and `confidence`
on every action line, which is how a reader tells its decisions from a chat
model's.

## 0. Gather, and refuse to guess

| Parameter | Needed | If not given |
|---|---|---|
| Catalog + row | **yes** | Ask. `--row` takes the `No.` or the `Scenario ID`. |
| Application URL | **yes** | `node .claude/skills/wowlidate/target.mjs <name>` resolves a known one and proves the VPN, the repo index and the DB coordinates. Otherwise ask. |
| Field map | **yes** | `fieldmaps/<app>.json`. Without one the author has no selectors and will not invent any. |
| DB evidence | **asked every run** | See §3. Never assumed. |
| Write policy | defaults to `mutations` | The row's expected results usually need the record to exist. Say so before launching; `WOWLIDATOR_DB_RESTORE_URL` is unset on this machine, so nothing puts the data back. |

## 1. The run folder and the probe name

```bash
eval "$(python3 .claude/skills/jev-case/scripts/newcase.py --name hrsit-1001 --case HR-SIT-E2E-V01-1-001)"
```

Exports `WOW_CASE`, `WOW_RUN_DIR`, `WOW_GRIM_DIR`, `WOW_PROBE`, `WOW_FLOW`,
`WOW_RUN_LOG` and points `WOWLIDATOR_REPORT_DIR` / `WOWLIDATOR_PROOF_DIR` at the
folder, so every artifact lands in one place.

**The probe name is the spine of the DB evidence.** It is minted once, typed
into the form by the flow, and looked for by the query. A row that holds it
before the run would make the after-snapshot meaningless, so the query must
return zero rows in the before snapshot — check that, do not assume it.

The case id must be uppercase and hyphen-separated for the Grim validator. A
sheet writing `PL_09_01` gives a file prefix of `PL-09-01`; the report's own
header keeps the sheet's spelling so a reader can search the catalog for it.

## 2. Author the flow — no model call

```bash
python3 .claude/skills/jev-case/scripts/author.py \
  --catalog "$CATALOG" --row 1.001 \
  --fieldmap .claude/skills/jev-case/fieldmaps/humi-hire.json \
  --base-url https://humi-sit-int.central.co.th/humi \
  --out "$WOW_FLOW" --probe "$WOW_PROBE"
```

The sheet is the only source. A Test Data pair whose control the field map names
becomes a deterministic step; a pair it does not name rides a `workflow` leg,
which is the one place Jev is asked anything. Numbered Test Steps become legs in
the sheet's own order, a sign-in step is skipped because setup already did it,
and a step that only reads is left to its Expected lines.

**Read the notes it prints; they are refusals, not warnings.** Each one names
something the sheet did not state plainly enough to act on:

- `'Age < 60' is not a date this author can resolve` — a phrase, not a value.
- `states no literal value — recorded, not asserted` — an Expected line written
  as an instruction (`ตามค่าที่กรอก`, `ตาม Rule Table`, an open `?`). Asserting
  a Thai instruction as page text passes or fails for reasons unrelated to the
  claim, so the author declines and the report records it as not covered.
- `'Active' is too generic for a text match` — a word that appears somewhere on
  almost any page. A generic assertion is worse than none: it goes green while
  proving nothing.

That is the trade this skill makes: **fewer assertions, none of them vacuous.**
On row 1.001 it authors 34 steps — 9 deterministic, 13 legs, 4 read-backs and 2
assertions — and says why the other Expected lines were not asserted.

**The sheet's steps own the data.** Each Test Data pair is emitted inside the
numbered step whose own words name it, bullet by bullet, so the flow performs
the case the way it is written. Emitting every pair up front instead produced a
run that filled the address before doing the identity step and left the legs
with goals like "fill Identity per Test Data" — no values, nothing to act on,
and the agent answered BLOCKED or timed out on all six.

Four rules the author enforces, each from a run that went wrong without it:

- **A page-2 control is touched only after the `Next` click**, and a page-1
  field never after it. A stray identity field entered on page 2 is typed into
  a page that no longer shows it.
- **Everything the sheet asked for goes in before the step that submits**, or
  the record is created without it.
- **"change X and check Y cleared" is two instructions.** The change is
  performed first; asserting the clearing alone passes on the state the page was
  already in.
- **A value the application fills is never typed.** An Expected line with a
  derive marker ("ระบบดึงข้อมูลจาก Position ได้แก่ Company / Employee Group /
  Work Schedule") names what the page fills itself; the SOURCE after
  `จาก`/`from` is still the tester's input. `derived_keys` in `author.py` is
  the one definition, and `check_flow.py` reads it to accept those pairs'
  absence. Before it, legs asked Jev to set Employee Group and Work Schedule,
  it answered BLOCKED on fields the page fills, and Submit was never reached
  (2026-09-18 → fixed 2026-09-21: the three data legs now pass).
- **A verification bullet never sets anything.** The values it names are the
  criteria it checks against. "ตรวจสอบค่าที่ระบบ Auto-Derive เทียบกับ Rule Table
  ตาม Business Unit / Employee Group" once became a leg that *set* those three.

**Fill, verify, advance, verify.** Every press of an advance control (the
field map's `$advance.controls` — Next, Submit) is wrapped by `advance_gate`:
before it, an `expectValue` for every field the flow put on the page being
left; after it, `expectHidden` on the app's error dialog and on the marker that
proved the old page. A press that succeeds mechanically is not an advance: on
2026-09-21 Next "passed" in 526 ms while a validation modal listed Company,
Date of Birth and an identity format error, and the flow typed page-2 data
into page 1. The contract is declared per app in the field map, never in the
author.

**A field has a typed value and a displayed value, and a check reads the
second.** `1103701234563` is typed, the page shows `1-1037-01234-56-3`, and a
gate comparing against the typed string failed a correctly filled field. The
field map declares the shape per control — `mask` (`#` takes the next typed
character) for text, `display` (a strftime pattern) for dates — and the author
tracks the displayed form for every later check. When a check fails with the
same characters differently punctuated, the report files it under "the check
was wrong, not the form" and the fix is a mask, not a retry.

**Only actions the engine dispatches.** `$engineActions` in the field map is
read out of `src/engine/runner.ts`; the flow parser drops anything else without
a word. Seven `expectFilled` steps were authored once, none ran, and the form
went unverified into the modal three times. Refresh the list when the engine
gains an action.

**Dates are `fill` on the button, ISO in.** The calendar rung in
`runner.ts` is reached only for `fill` / `type` / `fillRetry`, and it finds the
trigger by `aria-haspopup="dialog"` — so `selectOption` never reaches it and a
`role=textbox` selector never resolves. `fill` + `role=button[...]` + an ISO
value lets `engine/calendar.ts` open the dialog, navigate, click the day and
read back the display form (Hire Date: 484 ms, 12 month steps).

## 2a. Lint the flow before a browser is spent

```bash
python3 .claude/skills/jev-case/scripts/check_flow.py \
  --flow "$WOW_FLOW" --catalog "$CATALOG" --row 1.001 \
  --fieldmap .claude/skills/jev-case/fieldmaps/humi-hire.json
```

Exit 1 means do not launch. It reads the flow against the sheet and refuses
fourteen faults, every one of which has cost a real run: steps out of the sheet's
order, a leg with no concrete work, data entered after the submit, a page-2
control touched before `Next`, a Test Data pair placed nowhere, a value the page
cannot render, a vacuous assertion, and a sheet step with no trace in the flow.

A browser run costs minutes and writes to a shared environment. All eight faults
are visible in the JSON, so they are found there.

## 2b. Predict what the run will trip over

```bash
python3 .claude/skills/jev-case/scripts/predict.py \
  --flow "$WOW_FLOW" --catalog "$CATALOG" --row 1.001 \
  --fieldmap .claude/skills/jev-case/fieldmaps/humi-hire.json
```

The lint judges the flow's shape; this judges it against the world it runs in.
It needs `WOWLIDATOR_DB_URL` for the master checks and says so when it has none.
Exit 2 means a **BLOCKER** is predicted and the run cannot reach Submit — report
the prediction as the result instead of spending a browser on watching it happen.
Every rule is a fault that cost a real run or that the app's source makes certain:

| Code | What it catches |
|---|---|
| `no-route` | no menu read from the sheet, so every field step would run on the landing page (8 of 25 rows, 2026-09-21) |
| `entry-route` | `Entry Route = RCM`: the record must arrive from the recruitment system first; the key-in map cannot create it |
| `hire-date`, `required-missing` | a field the app's own validity rule needs and no step enters |
| `work-permit`, `dvt-fields`, `contract-type`, `contract-end` | requirements the app adds for a foreign nationality, group F, or a non-A/B/C group |
| `not-in-master`, `position-company` | a value its dropdown will never offer: not in the SIT master, or a position of another company |
| `position-occupied`, `duplicate-id` (RISK) | data the app may refuse on a vacancy or duplicate check |
| `unverified-selectors`, `agent-heavy` (RISK) | selectors read from source but never seen live; more than four agent legs |
| `out-of-band`, `other-modules`, `unperformed` (GAP) | what the sheet asks that this run will not prove — another team's step, a batch job, TM/BE/PY lines |

A relative date in the sheet (`Today`, `< Today`, `Start of Month`, `วันที่ทดสอบ`,
`วันในอนาคต`, `ย้อนหลัง … 5 วัน`, `วันที่ 25 ของเดือนปัจจุบัน`, `01/01 ของปีก่อนหน้า`)
is resolved by `relative_date` in `author.py`; one it cannot read is left
unentered and shows up here as `hire-date`, never as a guess.

## 2c. Many rows: `batch.sh`

```bash
WOWLIDATOR_DB_URL=… bash .claude/skills/jev-case/scripts/batch.sh <catalog.csv> <batch-name> 1.001 1.003 …
```

`JEV_LANES` cases at a time (default 4), each lane on **its own Chrome** (port `JEV_CDP_PORT`+lane, default 9633…,
own profile) — never the default 9333 browser, which a catalog run reads pages
through while it authors; clearing it killed one mid-authoring on 2026-09-21.
Per row: split → author → lint → predict → DB before → run → DB after → build →
validate. A lint refusal or a predicted BLOCKER spends no browser (`JEV_FORCE=1`
overrides the prediction). Every command is appended to `<batch>/commands.log`
and echoed — the log is the replay script and never holds the DB URL — and
`<batch>/summary.tsv` has one line per row. `split_rows.py` turns a whole-sheet
export (title row above the header, a million blank rows below) into one
two-line catalog per row, which is also what the report packages.

## The field map's rules, beyond selectors

- `$required` — what the app refuses to submit without and the sheet does not
  state, in the order it must be entered. A value is a literal (`value`), a date
  taken from another field (`from: "hire date"`, optional `plusDays`), or a row
  of a map keyed on what another field holds (`byField`); `skipWhen` leaves a
  field to the app (Contract Type for groups A/B/C). The sheet's own value always wins.
- `$afterAdvance.next` — what to press once the next page is reached. HUMI's
  Step 2 opens with every section but Position collapsed, and a collapsed
  section hides its controls **and never fetches its options**.
- `$appDerived` — fields the app fills and renders read-only; never typed, never
  handed to a leg.
- `codeOnly` on a field — a sheet writing `10 ตามชุดข้อมูล` means `10`.
- The flow stops at a refused advance: everything after a gate sits in a
  `when hidden: <errorDialog>`, and the dialog's own text is saved as
  `refused_<control>` so the report prints what the app said was missing.

## 3. Ask about the DB evidence, then take the before snapshot

**Ask the user every run** which tables and fields the case should be judged on.
Do not carry over a previous run's spec silently and do not guess from table
names. Offer what the sheet implies as a proposal and let them correct it.

Write the answer as one read-only `.sql` file — the exact text the report cites,
with no DSN, credential or token in it — then take the snapshot:

```bash
psql "$WOWLIDATOR_DB_URL" --csv -f "$WOW_GRIM_DIR/$WOW_CASE-db-query.sql" \
  > "$WOW_GRIM_DIR/$WOW_CASE-db-before.csv"
```

Gotchas that have cost a rebuild: name columns are `jsonb` on HUMI, so a
lookup needs `first_name->>'en_GB'`, not `first_name`; and `psql --csv` prints
each query's header even when it returns no rows, which is what the report's
snapshot parser keys on.

## 4. Launch, with Jev on the agent role

```bash
# refuse to clear the 93xx Chrome while another single-flow run is using it;
# a catalog run's LANES live on the 94xx pool, but its authoring reads pages through 9333 too —
# clearing it killed a catalog run mid-authoring on 2026-09-21, so either kind of run means hands off
if ps -eo command | grep -qE "[c]li.ts (run|catalog) "; then echo "another run owns port 9333 — ask first"; else
  pkill -f "remote-debugging-port=93"; sleep 2; rm -rf /tmp/wowlidator-chrome-profile
fi

WOWLIDATOR_AGENT_PROVIDER=openrouter WOWLIDATOR_AGENT_MODEL='~typesafe/jev-latest' \
npm run cli -- run "$WOW_FLOW" \
  --agent-assist --video on --screenshots all --report-lang th \
  --out "$WOW_RUN_DIR/proofs" --report "$WOW_RUN_DIR/$WOW_CASE-case-page.html" \
  > "$WOW_RUN_LOG" 2>&1 &
```

**`--agent-assist` is load-bearing here, not a nicety.** A date field on this
form is exposed as a button that opens a picker; the engine has a calendar rung
that enters an ISO value and reads back what the field displays, but it needs
the picker open first. Without the flag the step times out at 20 s, the
reconstruction rung clicks the control and leaves it empty, and the wizard
bounces back to Step 1 with the date flagged required. The one run that ever
set both dates correctly had this flag on.

Needs `OPENROUTER_API_KEY` in `.env`; `WOWLIDATOR_AGENT_PROVIDER=typesafe` with
`TYPESAFE_API_KEY` uses the native endpoint instead. Prove the id still resolves
first — `wowlidator doctor` making one real token call per role is the only
evidence a default has not drifted.

**Keep the `data` role on a chat model.** Jev answers no schema, so the value
resolver, the review and the risk judge borrow `data` for their structured
questions. The run prints this as a banner; if it is missing, the role was not
what you thought.

**Check nothing else is running first, and read the whole line.** The `pkill`
above takes the Chrome pool out from under any run already using it:

```bash
ps -eo pid,etime,command | grep "[c]li.ts" | grep -v grep
```

`cli.ts agent-proxy` is a long-lived helper and is not a run — leave it alone.
A `cli.ts catalog` or `cli.ts run` line is someone's work in progress; ask
before taking its browsers.

**A killed Chrome leaves a profile the next launch cannot drive.** The run dies
in seconds with `Chrome opened port 9333 but cannot be driven — try removing
/tmp/wowlidator-chrome-profile`, which is the fix, not a hint. After any `pkill`
of the pool:

```bash
pkill -f "remote-debugging-port=93"; sleep 2; rm -rf /tmp/wowlidator-chrome-profile
```

A folder holding a log of six lines and no proof bundle is exactly this shape.

Watch it with a filter that catches failure as well as progress — a grep for the
success marker alone stays silent through a crash:

```bash
tail -f "$WOW_RUN_LOG" | grep -E "^(✓|✗) \[|workflow|BLOCKED|p=|run completed|wowlidator:"
```

## 5. After snapshot, then the package

```bash
psql "$WOWLIDATOR_DB_URL" --csv -f "$WOW_GRIM_DIR/$WOW_CASE-db-query.sql" \
  > "$WOW_GRIM_DIR/$WOW_CASE-db-after.csv"

python3 ~/.claude/skills/grim-qa-report/scripts/build_report.py \
  "$WOW_RUN_DIR" "$CATALOG" "$WOW_CASE" "<sheet id>"

python3 ~/.claude/skills/grim-qa-report/scripts/validate_report.py \
  "$WOW_CASE" "$WOW_GRIM_DIR" --expect-images N --expect-videos 1
```

The builder and the page contract belong to `grim-qa-report`; read its
`reference/layout.md` rather than restating it. The parts that change per case
are its Expected-line list and its DB field map.

**A row-count delta is not proof the case wrote anything.** On a shared SIT box
other people are working in the same tables. Attribute the delta to a record, or
say plainly that you could not — on 2026-09-18 the three counts each rose by one
while this case's probe wrote nothing at all.

## 6. Prove the page before handing it over

The validator checks structure, not rendering. Open it too:

```bash
cd "$WOW_GRIM_DIR" && python3 -m http.server 8931 --bind 127.0.0.1
```

Chrome may refuse a `file://` navigation from a fresh tab, which is why the
loopback server exists; stop it afterwards. Then confirm every image has
non-zero natural dimensions **after forcing `loading=eager`** (a lazy image
below the fold reports zero and looks broken when it is merely unloaded), the
video reaches `readyState` ≥ 1 (a multi-megabyte data URL takes seconds to
decode — a short timeout reads as a failure that is not there), the console is
clean, and there is no page-level horizontal overflow at 500px.

## Known gap: the date controls

Four approaches were measured on this form's Date of Birth and Hire Date
(2026-09-18, runs jev14–jev19). Only one lets the run continue, and none sets
the value:

| Approach | Result |
|---|---|
| `selectOption` with an ISO value | times out at 20 s, the reconstruction rung clicks the control and the run carries on — **46 passed, 0 skipped** |
| `fill` on a textbox selector | never resolves; the tree exposes the control as a button |
| one leg naming the value | BLOCKED at p=0.36 — 15 passed, 26 skipped |
| click to open the calendar, then a leg to pick inside it | the click resolves, the leg BLOCKED — 21 passed |

The control looks like a text input, is exposed as a button, and opens a
calendar. The engine chooses its listbox rung (`via: "custom"`) and the picker
never opens; the screenshot shows the field centred and empty, so it is not a
scroll or visibility problem. **This is a gap in the engine's calendar rung, not
in this skill's authoring.** Hire Date also arrives pre-filled with today, so the
case must change it rather than set it.

Say so in the report: no Hire-Date or age claim of the case is proven while this
stands. Do not paper over it with a workaround that leaves the field wrong and
the run green.

## Reporting back

Lead with the verdict and what stopped the run, then the counts with their unit
named, then the path. Three things are worth stating every time because each has
been misread:

- **Expected occurrences, harness step results and catalog outcomes are three
  different counts.** Never add them. Zero failed outcomes means nothing was
  observed failing, not that the run passed.
- **A step the reconstruction rung rescued did not stop the run.** Keep it out
  of the blocking list and count it separately.
- **Say who owns each failure.** An agent leg that ran out of turns, a selector
  that never resolved and a decision the client itself rejected are all verifier
  problems. Only a control that refused a valid value is the application's.

Every persona on this machine points at one account, so a row that depends on
role separation has not proven it. Say that in the report rather than letting it
pass quietly.
