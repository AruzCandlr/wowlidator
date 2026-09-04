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
