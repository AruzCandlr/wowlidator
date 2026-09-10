# CLAUDE.md — the JIT healer

Split out of the root CLAUDE.md (2026-08-24) so this loads only when working under
`src/healer/`. Same authority as the root file; the root keeps the map of the whole system.

## The healer's echo (`HEAL_ATTEMPTS`, `sameSelector`)

**The commonest thing a weak model does when asked to repair a selector is hand back the selector that just failed.** It looks like an answer, passes every schema, and costs a model call plus the full verification timeout to arrive exactly where the step started — and because the healer only ever asked once, that was the end of the step. Found in "Leave Request Submission Flow", whose `role=button[name="Create Leave Request" i]` was echoed straight back: two attempts recorded, no `HealRecord`, `jitHeals: 0`, and a dead end on a page where the control was plainly available.

Three changes, and the third is the one that actually fixes it:

- **An echo is rejected before it is verified.** `sameSelector()` normalises the case flag and spacing, so a repair that differs from the failure only by ` i` is recognised as the no-op it is. That saves the timeout; it does not save the step.
- **The healer is told what it already proposed.** `HealRequest.rejected` carries each dead candidate *with the reason it failed*, and the prompt says not to repeat them. Without it a model has no way to know it is repeating itself.
- **It asks up to `HEAL_ATTEMPTS` (3) times.** One was too few for the failure that actually happens: the first answer is unusable and the repair budget is spent without a repair ever being attempted. The value is entirely in the *second* ask — the first one that knows what did not work.

**A counting step may heal onto a group.** `#verify`'s exactly-one-element rule is the safety net for every ordinary repair — and made repairing an `expectCount` selector structurally impossible, since a *correct* repair matches all the counted items. Verification now permits multiple matches only when the failed action is `expectCount`, and the heal prompt says so ("a group, not one element"). Found via PB-02-01's radio count, which no proposal could ever have fixed.

**A refused candidate is kept as data, and the machinery's failures are typed apart from the page's.** `HealFailedError.rejectedHeals` carries every refused proposal (`{proposed, confidence, reasoning, rejectedBecause}`) onto `ProofStep.rejectedHeals` — a rejected proposal is what the model *saw on the page*, frequently the diagnosis itself (PB-02-01's refused candidate for its final step was the page's own "Access Denied" heading). The echo check runs **before** the confidence gate, so a low-confidence echo is reported as an echo with the full re-ask budget rather than dying as a one-shot "confidence too low". And a provider failure (`HealUnavailableError` — rate limit, transport, unparseable output) is counted in `summary.healUnavailable` and worded "a provider fact, not a page fact" — it must never read as "the control is absent".

**The healer reads retrieved context now (2026-08-24, spec R6).** `LlmHealerModelOptions.hints`
(`healHintsFrom` in `src/context/heal-hints.ts`) adds two advisory sections per
repair: the repository's declarations for the failing page (≤10 lines, the
no-match sentinel suppressed) and background-document slices BM25-ranked by the
failed selector + intent + case card (≤4k chars). **Advisory framing only, never
candidate material** — the tree stays the page, every proposal still passes
`#verify`, and both sections render *before* the tree so re-asks keep the
byte-identical prefix (`rejected` alone grows). The catalog path wires it via
`runCases`' `where.healHints`; without a provider the prompt is byte-identical
to what it always was.

**The prompt also now says the author's role and name are a guess.** That is the deeper half of this case: the flow wanted "the Create Leave Request button" and the page offers a *link* named "Leave request Apply for leave" — a different role and a different name. A healer that treats the failed selector as a description of the element cannot cross that gap; one that treats it as an author's guess and matches on *intent* against the tree can. It now heals to `role=link[name="Leave request Apply for leave" i]` and says why.

## What one heal costs (2026-09-09)

The healer is reached only after a selector has failed every free rung of the
ladder, so every heal is pure added cost on a step already going badly. The
numbers, because a saving proposed without them is a guess:

| Stage | Cost |
|---|---|
| `captureAxTree` | `DEFAULT_MAX_AX_NODES` 120, rendered to `HEAL_TREE_MAX_LINES` 60 after relevance ranking |
| `probeInteractions` | disclosure probing upfront, `MAX_POPUP_VALUE_READS` 60 — failures swallowed, because a probe must never abort a repair |
| model calls | up to `HEAL_ATTEMPTS` (3) |
| `#verify`, per attempt reaching it | up to `verifyTimeoutMs`, **default 5,000 ms** |

**Nothing overrides `verifyTimeoutMs`.** All three construction sites —
`cli/runtime.ts:32`, `mcp/server.ts:484`, `mcp/server.ts:602` — take the
default, so 5 s is the real budget everywhere. Worst case for one heal is three
model calls plus ~15 s of verification timeout.

`HEAL_TREE_MAX_LINES` is deliberately half the capture cap: generous enough that
the intent's neighbourhood survives, small enough to matter on the token bill.

**The tree is captured once, before the attempt loop, and only `rejected` grows
between attempts.** That is what keeps the prompt prefix byte-identical across
re-asks so the provider's prompt cache hits. Moving the capture inside the loop
looks harmless — fresher, even — and silently destroys caching, making a "more
accurate" healer several times more expensive. Same invariant as the memoised
agent contract in `src/orchestrator/CLAUDE.md`.

## The gate order is the design

`echo check → confidence gate → verify`, and each position was placed by an
incident:

- **The echo check is first** because an echo is the same step again for a model
  call and a 5 s timeout. Cut it before either is spent.
- **It precedes the confidence gate** because an echo scored on confidence
  reports "confidence too low" and hides the actual finding — that the model had
  nothing new to say (PB-02-01, where echoes differing only by the case flag
  were reported as low confidence).
- **The confidence gate throws immediately, with no retry.** The prompt tells
  the model to answer with low confidence when nothing in the tree serves the
  intent; re-asking would only pressure it into being less honest. An honest
  decline is a result, not a failure to retry.

A check tidied into a different position here changes what the report says
happened, not just what it cost.

## The verify contract (`#verify`)

A repair is cached only if it resolves to **exactly one element** — the safety
net for every ordinary repair — **except for `expectCount`**, where matching
several is the entire point (see the echo section above for why that exception
had to exist).

The state required varies by action, and the distinction is load-bearing:
`attached` for `HIDDEN_OK_ACTIONS`, `visible` for `ACTING_ACTIONS`, `rendered`
otherwise. Attached is not enough for a step that clicks, fills or reads — a
hidden-only match passes a naive check and then fails the re-run at the healed
timeout, having spent both. The refusal says so explicitly ("matched N
element(s), none visible — a hidden control cannot serve this step") so the
re-ask knows the candidate is off-screen rather than absent.

## The cheapest heal is the one that never happens

Two rungs upstream exist to keep this plane out of the loop, and extending them
is usually a better move than making a heal cheaper:

- **A content-only miss skips the healer entirely** (`isContentMiss`). Measured
  on be100 PL_03_01: asked why `text=Total plans` did not contain "75", the
  model proposed `text="68"` — find an element containing the expected value,
  which is circular — at 0.20 confidence. The healer reads a static tree and
  proposes a different string: the right tool for a WRONG SELECTOR, the wrong
  one for a CONTENT miss.
- **The free kin rung** (`ancestorSelectors`, `MAX_KIN_CLIMB` 2) sits ahead of
  it: a summary card is a label and a value in sibling elements, and climbing to
  the container that holds both costs nothing.

## What is not pinned yet (2026-09-09)

`HEAL_ATTEMPTS` was module-private until the economy assertions landed, and
there is still **no dedicated healer test file** — coverage is indirect, through
`tests/smoke.test.ts` (healer contract, `jitHeals` counters),
`tests/model-fence.test.ts` and `tests/role-statelessness.test.ts`, plus
`tests/healer-economy.test.ts` for the attempt budget and gate order.

Anything not asserted in those is unprotected: a later change can restore the
cost and nothing goes red. Before optimising this plane, write the assertion
first — the shape to copy is `tests/agent-economy.test.ts`, which asserts the
model was *not* called, the only assertion that catches a regression whose
symptom is a bill rather than a failure.
