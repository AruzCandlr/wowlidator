# Handoff — 2026-09-11, afternoon

**Checkout:** `~/Documents/workspace/ai-val/wowUI`, branch `cli-optm`, head before
this session `be4e15e`.

The session began as a catalog run and turned into a diagnosis: a run's verdicts
were compared against the QA tracker, and almost none of the disagreement turned
out to be about the application. Three defects were found and fixed, and one
reporting change was made on top.

## The finding that drove everything

Run `be-sit-high-sonnet-th-20260911-162004` (BE_SIT priority-high, 15 cases)
produced **93 failure events**. Counted by phrasing across its own log:

| Failure phrasing | Count | About |
|---|---|---|
| `could not resolve` the selector | 57 | the harness |
| `the text is not on the page` | 28 | the harness |
| `expected url to contain` (downstream of a failed nav) | 3 | the harness |
| **`resolved, but the claim did not hold`** | **5** | **the application** |

So ~5% of the run's negative evidence said anything about HUMI. A verdict built
on the other 88 is a verdict about wowlidator.

The comparison against the tracker also needed correcting before it meant
anything: the run's own catalog is an **8 September snapshot**, and seven of its
fifteen rows are `Ready to test` — QA had not ruled on them, so they cannot be
conflicts. Of the eight rows the sheet did call Passed, three agreed, two were
no-verdicts, two were the locator chain below, and **one real disagreement
survives: PL_06_01** (the Create Plan button resolved and was not disabled).
That is the only row in the set worth taking to a developer.

The full analysis, with the per-case table, is published at
`https://claude.ai/code/artifact/4c3bc6ff-32ce-42f7-af91-4e4a2f46a5ce`.

## What landed

### 1. The AX capture carries containment (`src/healer/jit-healer.ts`)

`captureAxNodes` pushed into a flat array and `formatAxNode` printed
`role "name" …` with no indent, no parent and no child list. Playwright
selectors are hierarchical, so every `role=search[…] >> role=textbox` and every
row-scoped selector was authored by **guessing** containment. Twenty of the
unresolved selectors in that run were `>>`-scoped.

Two explanations were ruled out first, and both matter to anyone re-reading this:
pruning is *not* the cause (`textbox` and `searchbox` are both in
`INTERACTIVE_ROLES`, so an unnamed input survives), and the node budget is *not*
the cause (exactly **one** `TREE TRUNCATED` in a 731 KB log).

`AxNode.depth` is now the count of **printed** ancestors, derived from CDP
`childIds` inverted into a parent map — `parentId` is not on every build — and
never from document order. Pruned and ignored nodes contribute no level, so
children reattach to the nearest ancestor the tree actually shows.

```
RootWebArea "Plans"
  search "Search"
    searchbox
  table "Plans"
    row "Acme Ltd Delete"
      cell "Acme Ltd"
      button "Delete"
```

**The invariant that drove the rest: an indent is a claim of containment.** Both
places that choose a *subset* of a tree could make that claim false, so both now
close under containment via `keepWithAncestors` — the node budget
(`captureAxTreeDetailed`) and the relevance narrowing (`focusTreeText`, which
the heal prompt and the author's journey tree both run through). Without the
second, a `button "Delete"` kept while its row was ranked away would print under
whatever line preceded it.

Cost, measured on a deliberately deep 154-node capture: **≈ +4.5% input tokens
per repair** against the ~3.2k a heal actually bills. An explicit `parent=#id`
marker and a per-control `in=row "…"` hint were both rejected as more expensive.
Node lists with no depths render byte-identically to before.

### 2. A lint no longer certifies a control that cannot work (`src/generator/flow-author.ts`)

HUMI's English-locale page carries a **Thai-named global search** —
`ค้นหาพนักงาน เอกสาร…⌘K`, a ⌘K command-palette trigger. The tree exposes two
`search "ค้นหา"` ARIA **landmarks**. The table's own filter is a separate English
`button "Search"`, which appears once in the whole run and worked when reached.

A case needed the filter. The model wrote `role=searchbox[name="ค้นหา"]`,
`ungroundedSelectorRole` correctly found no `searchbox` — and then said:

> The page exposes it as: `search "ค้นหา"` — **use that role and name verbatim.**

A landmark cannot be filled. Worse, `settleSelectorRole` is "the last word", so
the wrong role was **written onto the step**. The rail built to stop invention
directed the model at a control that could never satisfy the action, and the
healer spent dozens of calls elaborating it.

Now: `rolePerforms(action, role)` gates every candidate, built on
`ENTRY_ACTION_BY_ROLE` — the switch `entryStepFor` already used, lifted into a
map that `entryStepFor` now reads, so the forward reading (write a step for this
role) and the backward one (can this role satisfy this step) cannot drift.
`CONTAINER_ROLES` is deliberately narrow: `row`, `cell`, `gridcell`, `listitem`,
`heading`, `img` and `link` are **not** in it, because clicking a table row is an
ordinary step and a rail that can refuse a true claim is the wrong rail. Every
action the table has no opinion about returns true, so this can only narrow
candidates, never raise a refusal.

In the landmark case the register changes from an imperative to a description,
`settleSelectorRole` returns `null`, and the contradiction tier **withholds** —
a container does not disprove the control's existence, it may hold it.

`tooltipRoleSelector` is a new lint needing **no tree**: nothing hovers while a
capture reads a page, so the absence of a tooltip line is the shape of every
tree that will ever exist. It fires on the selector, not on the case's prose —
previously the guidance was gated on `AUTHORING.hoverClaim` matching the case
text *and* on another refusal firing, and `role=tooltip[name="Make Correction"]`
still reached execution 16 times.

**One latent bug found by the whitespace audit** this change required:
`ungroundedCountRole` matched roles with `new RegExp('^' + role + '\\b', 'im')`
over the whole tree — a bare `^` under `m`. The day lines gained indentation,
every nested role would read as a phantom and honest `expectCount` steps would
be refused. Fixed to `^[ \t]*` and pinned with an indented-tree test.

### 3. A table name is resolved in both directions (`src/generator/value-resolution.ts`)

Caught live, mid-run, in `be-sit-high-opus-th-20260911-174323`:

```
[PL_09_01]   evidence for QA260908_BE_137: the database did not answer — the model
             named table "benefit_management.benefit_plan", which the schema does not declare
  ! PL_09_01 could not be written — refused identically on 2 attempts
[c3] BLOCKED PL_09_01
```

That table **is** declared. Both halves of the mismatch were ours:

- `PgDbClient.introspect` (`src/db/client.ts:176`) spells names **bare for
  `current_schema()`** and `schema.table` otherwise. This checkout's
  `WOWLIDATOR_DB_URL` sets `search_path=benefit_management`, so its tables come
  back as bare `benefit_plan`.
- The `humi-SIT-1fc0` graph's 14 table nodes come from a **DDL file**, where
  names are qualified, and `tableInventory` feeds those to the authoring prompt.

So the harness showed the model one spelling and validated against the other,
and `tableIn`'s fallback was one-directional — it handled *model bare, schema
qualified*, never the reverse.

`resolveTableIn` is now the single resolver returning
`found | ambiguous | undeclared`. **Ambiguity is refused, not guessed**:
`public.benefit_plan` and `benefit_management.benefit_plan` are different
tables, and returning the first-listed would read a real value off the wrong one
— a lookup that *looks* grounded, which is worse than the miss. Because
`DbSchema` carries no `current_schema()`, the reverse tier judges a prefix by the
introspection's own usage: a schema prefix it writes anywhere is one it would
have written here too, so only a prefix it never writes can be the current
schema left bare.

**And "could not look up" is no longer the same fact as "the row does not
exist."** That is what actually cost the row: `resolveStepEvidence` caught the
throw and returned the fixture unproven — byte-for-byte what it returns when the
database answers *absent*. Now a DB that answered absent keeps the **fatal**
refusal, while a lookup that could not run is a **weak** complaint: the flow
ships with a note and the run settles it against the real page. Weak complaints
are not re-asked, so this costs no model call.

### 4. The run notes are a summary, not a wall of text

A case page's paragraph under the coverage bar was `bundle.notes.join(' · ')` —
about 300 words for PL_06_10, covering the session note, the sign-in POST, the
pre-run risk line, a three-case interference stamp and a full system-error
diagnosis with the agent's trail.

`CaseNarrative.verifierNote` is now that content as a **≤70-word** model-written
summary. No extra model call: `case-narrative.ts:357` already fed the notes into
the prompt. The bound lives where the text is *written*
(`NARRATIVE_NOTE_MAX_WORDS`, an over-long field re-asked once, then a
sentence-boundary cut), matching the `NARRATIVE_MAX_CELL_CHARS` precedent.

**Thai needed its own measure.** `split(/\s+/)` counts a 636-character Thai note
as **one word**. Scripts with no word separator (Thai, Lao, Myanmar, Khmer) get a
per-character budget at 4.5 chars/word — ≈315 Thai characters for the same
paragraph — and the same scan returns both the count and the cut index, so the
two cannot disagree. A CJK report language would need its own ratio;
`REPORT_LANGS` holds none today.

All four surfaces render it through one pure projection, `runNotesSummary()` in
`src/reporter/step-facts.ts`: the case page, the catalog report, the per-run
report's callout, and the panel's proof card. **The verbatim fallback is not
dead code** — `--no-case-narrative`, `WOWLIDATOR_CASE_NARRATIVE=off` and an
unkeyed role all yield notes with no narrative, and rendering nothing there would
delete the only account of the run.

## What is running right now

```
catalog .wowlidator/catalogs/BE_SIT_20260908_priority-high.csv
  --url https://humi-sit-int.central.co.th/humi/en/login --repo humi-SIT-1fc0
  --run --resume --concurrency 4 --browsers 4 --headless --video on
  --report-lang th --context-doc .claude/skills/wowlidate/persona-switch.md
```

Roles `healer=opus/low`, `generator=opus/low`, `agent=sonnet/low`.
Folder `valst-output/reports/runs/be-sit-high-opusheal-th-20260911-175757/`.
Run key `be-sit-20260908-priority-high-csv@2026-09-11T10:58:06.536Z`.

At 09:51 elapsed: **8 of 15 sealed — 5 passed, 1 needs-review, 1 dead-end, 1
error.** **PL_09_01 passed**, and the log holds **zero** `does not declare`
errors where the previous run had three across two cases. That is fix 3 proven
against the live application.

### Four runs of the same catalog, for comparison

| Run | Roles | passed | Notes |
|---|---|---|---|
| `…-160954` (9 Sep) | generator opus | 5 | baseline, English reports |
| `…sonnet-th-162004` | all sonnet/low | 3 | 3 errors, **28** schema re-asks |
| `…opus-th-174323` | gen+agent opus | — | killed; PL_09_01 blocked by the DB bug |
| `…opusheal-th-175757` | heal+gen opus, agent sonnet | 5 of 8 so far | first run carrying all three fixes |

Cheap authoring is not free: sonnet-low cost two passes, tripled the
no-verdict errors, and produced 28 `response did not match schema` re-asks that
opus produced none of.

## Caveats a reader must carry

- **Role separation is not proved.** All six persona labels resolve to the same
  `automate01` account. Say so in a report rather than passing quietly.
- **Mutations with no undo.** `WOWLIDATOR_DB_RESTORE_URL` is unset in this
  checkout, so `wowlidator db restore` cannot put `benefit_management` back
  after a mutating run.
- **The indexed schema is `benefit_management` alone** — 14 of 497 tables. A
  claim needing employee or workflow tables cannot see them.
- **HUMI ships a Thai accessible name on its `/en/` pages.** Found incidentally,
  unrelated to `--report-lang`, and worth a ticket of its own regardless of what
  it did to this catalog.

## Known-failing tests, all predating this session

Verified by re-running with this session's changes reverted:

- `tests/vacuous.test.ts` › `dropReasonFor` — expects
  `/not an action this harness has/`, gets "the step could not be narrowed to a
  runnable form".
- `tests/catalog-live-report.test.ts` — two failures asserting on filesystem
  state (`!existsSync(mediaDir)` and the case-page path list). Both test files
  are unmodified in git while `src/cli/catalog-live-report.ts` and case-page's
  `renderBlockedCasePage` are uncommitted work; the tests have not caught up.

Everything else: **2730 of 2733 pass**, `npm run typecheck` and
`npx tsc -p tsconfig.test.json --noEmit` clean.

## Housekeeping done here

`.gitignore` gained `.env.bak` / `.env.bak-*` and `reports/`. Only `.env` itself
was ignored, so five backup files holding 19 credential lines each were
committable — a `git add -A` would have pushed provider keys and the
`automate01` password. The five backups were deleted; `.env` is intact at 83
settings. `reports/` had 252 untracked run artefacts.

## What I would pick up next

1. **PL_06_01** — the one real application disagreement in the set. The Create
   Plan button resolved and was not disabled when the sheet says it should be.
2. **Finish the containment payoff.** Fix 1 makes scoped selectors *authorable*;
   whether the 57 `could not resolve` failures actually drop is a reading only a
   full run gives, and the run above is the first to carry it.
3. **A rejected agent claim seals `error` with no verdict** — three of fifteen in
   the sonnet run. The rule is right (a claim is never evidence) but the
   consequence is silence where a human tester would look at the screen and
   rule. `needs-review` with the captured screen would be the honest outcome.
   Not attempted here; it is a `src/orchestrator/` change.
4. **The three known-failing tests** above deserve owners.
