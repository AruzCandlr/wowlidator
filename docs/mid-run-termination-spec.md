# Why catalog runs end with cases never reached — and the fix

**Status:** proposed 2026-08-31, implemented same day
**Scope:** `src/generator/flow-author.ts`, `src/orchestrator/goal-evidence.ts`

## The symptom

A catalog run ends before every planned case has a verdict:

```
progress   .wowlidator/catalogs/BE_Test2.claims.progress.json — 2 left; continue with --resume
ended      2 case(s) were never reached or never ran
exit 1
```

The run does not crash. It completes its roll-up, writes its index and truth
table, then exits 1 with cases that never ran. A `--resume` re-authors those
cases, hits the same deterministic refusal, and leaves them unrun again — so
the count never reaches zero however many times it is resumed.

Observed across three consecutive jobs (2026-08-31): job-2 lost 6 cases,
job-3 lost 4, job-4 lost 2, every one to `could not be written`.

## Root cause 1 — `duplicateCredentialSubmit` flags any repeated click

`flow-author.ts:3744`. The lint exists to catch a flow that clicks the
**sign-in submit** twice — a retry the engine already performs itself, where
the second click lands after the control is gone and reads as an application
defect.

`sawCredentialFill` is set by a credential fill and cleared **only by a
`goto`**. After sign-in it stays true for the rest of the flow, so every later
click is treated as a candidate sign-in submit. Any two clicks on the same
selector with no other *click* between them are then reported as a duplicate
credential submit, wherever they occur and whatever they do.

Reproduced against the live function, with the PL_02_03 shape — open a popup,
assert its wording, close it with a keypress, open it again:

```
REAL retry (should flag)      : { first: 4, repeat: 5, selector: 'role=button[name="Sign in" i]' }
wording case, reopened popup  : { first: 5, repeat: 9, selector: 'role=button[name="Create Plan" i]' }
```

The second is a correct flow. The refusal text then tells the model the page
is a sign-in form and its click is a login retry, which is advice for a
situation the flow is not in — so the re-ask cannot converge, and after
`AUTHOR_ATTEMPTS` the row is lost. This is the same failure shape as the
`{{menu-label}}` misdiagnosis fixed earlier today: a lint firing on the wrong
thing, with a message that sends the model somewhere else entirely.

Reopening a control is the *normal* shape for a wording case, which is why
PL_02_03 and PL_02_04 — both wording cases — died on it.

## Root cause 2 — `goalOutcome` parses a case annotation as a promised state

`goal-evidence.ts:331`. `OUTCOME_EQ` reads a bare `control : value` out of a
workflow goal, so the agent's `finish` can be checked against the live tree
instead of taken on trust.

Authored goals carry a provenance annotation — `(test step 1: เข้าสู่เมนู…)`.
The colon in that annotation is matched, and `BARE_CONTROL` runs backwards
into the sentence:

```
goal    "…and land on the Benefit Plan Catalog page (test step 1: เข้าสู่เมนูที่กำหนด)."
parsed  { control: 'he Benefit Plan Catalog page (test step 1',
          value:   'เข้าสู่เมนูที่กำหนด' }
```

(The truncated `he` is the parse, not a typo — it is why the run's error text
reads "the page does not show he Benefit Plan Catalog page".)

No page shows that control, so `outcomeShown` returns null, the finish is
refused, the agent insists, and the leg is recorded as a contradicted claim —
`PL_02_07`, run `a8ae1bb5`, where the agent had in fact navigated to
`/en/admin/benefits/plans`, exactly the page the goal asked for. The same goal
without the annotation parses as `null` and settles on `agent-claim`.

## The fix

Both are misfires, not policy: each lint is right about the case it was
written for and wrong about a case it was never meant to see. Narrow them.

1. **`duplicateCredentialSubmit` ends its window at the sign-in.** Clear
   `sawCredentialFill` once a submit has been clicked and the flow has moved
   on — the credential window is the sign-in, not the rest of the run. A
   repeated click after that point is ordinary interaction and no business of
   this lint.

2. **`goalOutcome` strips a trailing parenthetical before parsing.** A
   `(test step N: …)` annotation is provenance, never a promised end state.

Neither weakens what the lints catch: a genuine double-submit still flags, and
a real `set X to Y` goal still parses.

## Verification

Pure functions, exercised directly against the shapes that failed:

- `duplicateCredentialSubmit` — real retry still flags; reopened popup returns null
- `goalOutcome` — annotated navigation goal returns null; `set the Status filter to Inactive` still parses

Per the standing instruction in this session, no unit tests are added.

## Not in scope

Two things surfaced while diagnosing and are left alone deliberately:

- **`text=Benefits Admin > Benefit Plans`** asserts a breadcrumb as one literal
  string; a breadcrumb renders as separate nodes, so no text node ever contains
  it. An authoring-prompt matter, not a lint bug.
- **The six `usage cap reached (session 52% ≥ cap 50%)` errors** were the cap
  doing its job. It has since been raised to 77% with the session at 22%.
