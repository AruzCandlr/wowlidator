# Read-only input shells and the fill that never lands

*2026-09-02. Status: ALL ITEMS IMPLEMENTED (1–7), typechecked; not yet exercised by
a live run. Evidence from ec10 / ec10_2 against humi-SIT
`/en/admin/hire`.*

## Problem

A catalog case whose script keys a Hire Date, a Date of Birth and an Event
Reason enters none of them. Each input step burns its whole ladder budget and
fails as "could not resolve", the case dead-ends, and every assertion after it
is moot. Measured on ec10_2 (job-2, started 11:21:41 UTC, still on the code
that predates the fixes below):

| lane | step | selector | outcome |
|---|---|---|---|
| c1 HIR-EC-003 | 8 | `fill role=textbox[name="Select date" i]` | ✗ 64.4 s |
| c2 HIR-EC-001 | 8 | `fill role=textbox[name="Select date" i] >> nth=0` | ✗ 2 ms, 4 attempts |
| c3 HIR-EC-002 | 10 | `fill role=textbox[name="Select date" i] >> nth=0` | ✗ 181.9 s |
| c3 HIR-EC-002 | 11 | same, retried | ✗ 2.0 s |

The agent, which does have the new `paste` action in this run, tried it on the
same read-only shell: `✓ agent: paste … (10 s)` — the action "succeeded" and the
field did not change, because a read-only input ignores inserted text. It then
guessed `spinbutton "Day Day"` and `[aria-label="Hire Date"]`, both misses.

## What the page really is

`HumiDatePicker` (and StepIdentity's own Hire Date) render **two inputs**:

```html
<label for="hire-date">Hire Date</label>
<input type="text" readonly placeholder="Select date" value="2 Sep 2026">  <!-- the display -->
<input id="hire-date" type="date" style="opacity:0; position:absolute; inset:0">  <!-- the input -->
```

Facts, each reproduced with a Playwright probe:

- `role=textbox[name="Select date" i]` resolves to the read-only display; there
  are **four** of them on the form (the healer reported the strict-mode
  violation), so `nth=N` is what the flow ended up using.
- `fill` on a read-only input does **not** throw — it waits for editability until
  the timeout. That is why every rung spent its full budget.
- `role=textbox[name="Hire Date" i]` resolves to the hidden date input (the
  label names it). `fill('1 Sep 2027')` on it → `Malformed value`;
  `fill('2027-09-01')` → holds `2027-09-01`.
- Event Reason is `<button aria-haspopup="listbox">` (`HumiSearchableSelect`),
  not a `combobox`.

## Root causes, by module

| module | fault | status |
|---|---|---|
| generator | took the textbox named by its PLACEHOLDER (the shell) instead of the one named by the LABEL; wrote the date as displayed instead of `YYYY-MM-DD`; wrote `role=combobox` for a control the tree showed as a `button` | rule added to the procedure (`flow-author.ts`) |
| engine | treated Playwright's editability wait as a resolution failure and walked every rung on the same read-only element | `#readOnlyShell` rung + `isoDateOf` (`runner.ts`) |
| orchestrator | the agent found the truth and was barred from acting; `paste`/`fill`/`type` on a read-only element succeed silently, so the agent learns nothing from the miss | `#agentEnter` rung; `#writable` refuses read-only/disabled/non-editable targets in one turn; prompt names the shell idiom (done) |
| tree capture | a read-only textbox is listed like any other, so neither the generator nor the agent can tell the shell from the input | `AxNode.readonly` from Chrome's AX property, printed as `readonly` on the line; `fillsReadOnlyNode` lint refuses a fill on it and names the writable textboxes (done) |
| healer | off under fail-fast; would propose the same shell anyway | not a cause |
| provider, reporter | every call answered; evidence recorded exactly | not a cause |

## Changes

### Done (in the tree, not yet run)

1. **Engine — read-only shell rung** (`runner.ts`, ladder step 1.02). After the
   fast miss on a `fill`/`fillRetry`, ask the element whether it is read-only.
   If so: fill the single editable input beside it
   (`>> xpath=.. >> input:not([readonly]):not([type="hidden"]):not([disabled])`),
   converting to ISO when that input is `type="date"` (`isoDateOf`: `01 Sep
   2027`, `1 September 2027`, `Sep 1, 2027` → `2027-09-01`; `01/09/2027` is
   ambiguous and left alone). Recorded `narrow` with a note. If there is no
   such input, go straight to the agent entry rung — never time out four more
   times.
2. **Engine — agent entry rung** (`#agentEnter`). For input steps only, after
   every other rung: ask the agent to put the value in by whatever the page
   offers, then **read the value back** (author's selector first, else the
   control the agent last acted on). `valueMatches` is tolerant one way only.
   Not gated by `--agent-assist`: the flow's own step is the authorisation.
3. **Orchestrator — `paste`**. `keyboard.insertText` after focus and clear; in
   `INTERACTION_ACTIONS`, excluded from `REVEAL_ACTIONS`/`READ_ONLY_ACTIONS`.
4. **Generator — one procedure rule**: the control is the one the label points
   at; a placeholder-named textbox is usually a shell; a date input takes
   `YYYY-MM-DD`; a dropdown the tree lists as a button is a button.

### Also done (2026-09-02, later the same day)

5. **Agent input actions check editability first** — `#writable` in
   `workflow-agent.ts`, before `fill`/`type`/`paste`. Fails in one turn with: *"read-only display — the input the label points at is
   beside it; try `role=textbox[name="<label>" i]` or the `<input>` sibling"*.
   Today the agent's paste on the shell returns ✓ and the field is unchanged,
   which is the worst outcome: a success that taught nothing. One turn, ~1.5 s,
   the same fail-fast contract as `#target`.
6. **Read-only nodes are marked in the tree** — `AxNode.readonly`, printed as
   `textbox "Select date" readonly`. `fillsReadOnlyNode` (fatal lint) refuses a
   `fill`/`type` on such a node when no writable textbox of that name exists,
   and names the writable ones the tree offers; the agent's prompt explains the
   marker. So the generator
   sees the shell for what it is, and the agent's tree says which of four
   "Select date" boxes is the input. This is the change that stops the
   problem upstream instead of rescuing it downstream.
7. **The label before the neighbour** — inside the read-only shell rung,
   `fieldNamesIn(intent)` extracts the field the step speaks of (`Hire Date`,
   `Date of Birth`, `National ID / Tax ID`) and `role=textbox[name="<field>" i]`
   is tried, writable and unique, before the positional sibling; a date input
   still gets ISO. Cheap, deterministic, and it is what the label already says.

## Acceptance

- `tests/form-actions.test.ts` — read-only shell fixture: `fill
  role=textbox[name="Select date" i]` with `01 Sep 2027` passes, resolution
  `narrow`, the hidden date input holds `2027-09-01`, under 20 s. **Passing.**
- `isoDateOf` unit cases, `valueMatches` unit cases, `paste` vocabulary
  placement. **Passing.**
- Items 5–7 were delivered on typecheck alone (asked for, to ship fast) and
  still owe their tests: a scripted-agent fixture where a paste on the shell
  gets the read-only refusal in one turn; a tree-render case showing `readonly`
  on the line and `fillsReadOnlyNode` refusing it; `fieldNamesIn` on the live
  intents (checked by hand: `Hire Date`, `Date of Birth`, `National ID / Tax
  ID` come out; a quoted value such as `"2 Sep 2026"` is harmless — it matches
  no textbox and is skipped).
- End to end: HIR-EC-001 on ec10_2 enters Hire Date, Date of Birth and Event
  Reason and reaches Submit. Not yet run.

## Rollout

The running job-2 predates items 1, 2 and 4 (its process started 11:21:41 UTC;
`runner.ts` and `flow-author.ts` were saved after). It will keep failing the
same way. Stop it and relaunch, or let it end and resume — the resume authors
refused rows leniently and runs on current code. Items 5–7 are small and should
land before the next full ec10 pass so the run is diagnostic rather than a
repeat.
