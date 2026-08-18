# System Audit and Remediation Spec

Written after re-validating the whole system on 2026-08-18, at the end of a session that added the `--as` credentials path, `--capture-journey`, `--scope unit|e2e`, BM25 context retrieval, the DB write-witness, the native-GET third signature, and nine authoring lints.

> **Status: audit complete, nothing here is implemented.** Every flaw below is evidenced by a measurement in this document, not by reading. Ordered by severity, which here means *how wrong a person could be while trusting the output*.

## Validation baseline

| Tier | Result |
|---|---|
| Unit + contract | 740/740 |
| **Unit + browser (CDP up)** | **870/870** |
| Typecheck (`src` + `tests`) | clean |

**A gap in the validation itself, now closed and worth recording:** every suite run reported during the session ran with `WOWLIDATOR_CDP_URL=http://127.0.0.1:1`, which forces the browser tier to skip. 130 browser-tier tests went unverified across roughly twenty reported "all green" runs. They pass. The lesson is procedural, not technical: *a suite that can silently skip a tier will, and the person reading the number will not know.* See F5.

---

## F1 — A typed password is stored in cleartext in the proof bundle and the HTML report

**Severity: high.** This is the only flaw here that can leak a real secret to a third party.

Measured, from a real bundle on disk:

```json
{ "action": "fill", "selector": "input[type=\"password\"]",
  "detail": { "value": "admin2026" } }
```

`src/api/redact.ts` is thorough about HTTP — `redactHeaders`, `redactBody`, `redactUrl`, `isSensitiveKey` — and a test asserts a bearer token cannot survive into rendered HTML. **None of it covers a `fill` step's value.** So the one thing every login flow does, on every run, writes the password to `.wowlidator/proofs/<runId>.json` and inlines it in a report explicitly designed to be self-contained and emailable.

CLAUDE.md currently states: *"Before `src/api/` nothing in a bundle could carry a credential."* That sentence is false and has been for as long as `fill` has existed. The `src/api/` redaction work fixed the newer, narrower hole and left the older, wider one open.

**`--as` makes it materially worse.** It exists precisely so a person supplies a real working credential, which previously the model would have invented. The feature that improved correctness increased exposure.

### R1 — Redact credential-shaped fill values at the recording boundary

- Redact where a live value becomes a stored artefact — the same rule and the same place `src/api/redact.ts` already applies it. The run keeps using the real value; only the record is masked.
- Decide by **evidence, not by wording**: the field's own `type="password"` where it can be read, plus the existing `isCredentialFill` heuristic (selector or intent naming a password, and the taught `role=textbox >> nth=N` idiom) as the fallback. Prefer the DOM fact; fall back to the heuristic; never rely on the heuristic alone where the DOM can answer.
- Mask, do not drop. `"value": "•••• (8 chars)"` keeps the step legible — a reader still needs to know a value was typed and roughly what shape it had, which is exactly the `redactBody` compromise.
- **A value supplied by `--as` is masked unconditionally**, whatever field it lands in: the person named it as a credential, and that statement outranks any inference.
- Test the invariant the way the API side already does: a password cannot survive into rendered HTML. Add the mirror for a `fill`.

**Explicitly not in scope:** screenshots and video. A password typed into a field that does not mask it on screen is visible in the recording, and no redaction of the bundle changes that. Say so in the docs rather than implying a guarantee that does not exist.

---

## F2 — The refusal surface grows monotonically against a fixed budget

**Severity: high.** It does not produce a wrong answer; it produces *no* answer, which for an authoring tool is the same cost.

`flow-author.ts` now holds **17 throw sites — 16 fatal, 1 weak — against `AUTHOR_ATTEMPTS = 3`.** Nine of those lints were added in one session. Each is individually correct and each was born from a measured false claim. Collectively they are a denial of service on authoring, because a re-ask that fixes lint A is free to trip lint B.

Measured this session, same prompt and model:

| Run | Attempts | Outcome |
|---|---|---|
| `--scope e2e`, first | 3 | refused by 3 *different* lints → **no flow** |
| `--scope e2e`, second | 3 | 2 refusals, then a good flow |
| cold `--capture-journey` | 3 | 2 refusals, then a good flow |
| catalog B3 | 2 | **no flow** |

Roughly one prompt in four returns nothing. The trend is the problem: every future lint lowers that number, and nothing in the design pushes back.

### R2 — Make the budget a function of the refusal surface, and make partial credit real

Three changes, in increasing order of how much they change the design:

1. **Report all violations per attempt, not the first.** Today the chain throws on the first lint that fires, so a model fixing three problems needs three attempts to *learn about* three problems. Collect every violation in one pass and feed them as one `feedback` list — the seam already takes an array. This alone should collapse the multi-lint cases above into a single re-ask.
2. **Scale the budget with the surface.** A fixed 3 was chosen when there were eight lints. Tie it to the count, or raise it and revisit when the count changes — either way, record the reasoning next to the constant so the next person adding a lint sees the coupling.
3. **Widen the weak class deliberately, once.** The fatal/weak split exists and holds exactly one member. Review each of the sixteen: a lint refusing a claim that is *false* must stay fatal; one refusing a claim that is merely *thin* should be weak, so best-attempt-wins can return a usable flow with the complaint on `notes`. `countPinnedName` is the likeliest candidate — a pinned count is a flow that will drift, not a flow that lies.

**The rail:** none of this may weaken a fatal refusal. A flow that asserts something false is worse than no flow, and that ordering is the whole reason the lints exist.

---

## F3 — The new capabilities reach one command out of three

**Severity: medium-high**, because the command they miss is the one that produced every false positive this session's engine work was written to fix.

| Capability | `cmdAuthor` | `cmdCatalog` | `cmdGenerate` |
|---|---|---|---|
| `credentials` (`--as`) | ✅ | ✅ | ❌ |
| `declaredRoutes` grounding | ✅ | ✅ | ❌ |
| `scope` (`unit`/`e2e`) | ✅ | ❌ | ❌ |
| `captureJourney` | ✅ | ❌ | ❌ |

`wowlidator go <url>` routes to `cmdGenerate`, so the URL arm of the headline command gets **none** of it. And the catalog path — `catalog … --run`, which is how the DB_0x suite executes — cannot capture the page it is about, nor be forced end-to-end.

### R3 — Close the parity gaps, or state each one as a decision

- **`captureJourney` on the catalog path** is the valuable half. A catalog's cases are authored per row against one open page; the same argument that justified capturing the journey's destination for a described test applies unchanged, and the measured effect there was `workflow` delegation 9/9 → 0/3.
- **`scope` on the catalog path** needs a design answer first, and it is not obvious: a catalog's shape comes from approved claims, so "what is an E2E *claim*" is a real question. Either answer it or write down that it is deliberately absent.
- **`cmdGenerate`** generates per-page suites from an AX tree, where `credentials` is plainly useful and `captureJourney` plainly is not (there is no journey). Wire the first; document the second as N/A.
- The rule to hold: a capability that exists on one authoring surface and not another is a trap unless the absence is *stated*. Parity or a written reason — not silence.

---

## F4 — wowUI cannot reach three of the four new flags

**Severity: medium.** `src/ui/commands.ts` is the single declaration the panel's forms and the server's argv builder share; a flag absent there is a flag the panel cannot send and the server would refuse.

| Flag | Declared |
|---|---|
| `--scope` | ✅ (`SCOPE_FIELD`, on `go` and `author`) |
| `--as` | ❌ |
| `--capture-journey` | ❌ |
| `--context-budget` | ❌ |

So the radio the panel gained this session works, while the credentials that make an authored flow actually sign in are CLI-only.

### R4 — Declare the three, with `--as` treated as a credential and not a text box

- `--capture-journey` and `--context-budget` are ordinary fields; one entry each.
- **`--as` is not.** A password typed into the launcher would be echoed in the announced command line, stored in the launcher state, and visible in any screenshot of the window — the exact exposure `ui/keys.ts` refuses for API keys, where the browser only ever receives a mask and an index. Follow that precedent: either keep `--as` deliberately CLI-only and say so in the panel, or plumb it the way keys are plumbed. **Do not add it as a plain text field.**

---

## F5 — A skipped tier reads exactly like a passing tier

**Severity: medium**, and it is about trust in the instrument rather than the instrument's output.

`WOWLIDATOR_CDP_URL=http://127.0.0.1:1` makes the browser tier skip. The summary line then reports `pass 740, fail 0, skipped 0` — because the tier's tests are never registered, not skipped. Nothing in that output says a tier did not run. CLAUDE.md's promise is *"Skips are printed with the reason, so a green run that skipped the browser tier says so explicitly"*, and for the suite-level summary that is not what happens.

### R5 — Make the tier's absence appear in the result, not only in the log

- Print a one-line tier roll-up at the end: which tiers ran, which did not, and why not. The information exists at registration time.
- The number that matters is *tests that did not run*, and `skipped 0` beside a suppressed tier is the misleading part.
- Consider making a *deliberately unreachable* CDP URL a distinct case from an absent one: the first is someone forcing a skip, the second is a machine without a browser, and only the second is routine.

---

## F6 — `--scope e2e` cannot verify what it forces

**Severity: low, and it is a design honesty question rather than a bug.**

`scope: 'e2e'` turns `captureJourney` on and refuses a single-page flow (`notEndToEnd`). But it deliberately does **not** require the capture to have succeeded — the capture legitimately declines (no `--repo`, an ungroundable route parameter, a sign-in it cannot pass), and failing authoring because a best-effort capture was skipped would turn a degradation into an outage. That call was right.

The consequence is that `--scope e2e` can produce a flow authored entirely from the start page, having promised end-to-end. `notEndToEnd` catches the flat case, not the thin one.

### R6 — Disclose the degradation on the artefact, not only in the log

When `scope === 'e2e'` and no journey tree was captured, say so on `AuthoredFlow.notes` — the channel `unsettledWorkflowClaim` already uses for a complaint that must not block. The flow is still worth having; the reader needs to know it was written blind to its destination.

---

## What this audit deliberately does not claim

- **No new false-positive class was found in the engine.** The nine catalog runs re-validated cleanly against the three root-cause fixes: the native-GET third signature, the sign-in-did-not-take guard, and the session-lost verdict. DB_07_01 went 5 high defects → 1 honest one.
- **Nothing here was found by reading alone.** Every flaw above has a measurement in this document. Where I could not measure — the agent decision path against a real consent screen — it is named as unverified rather than assumed sound (see below).
- **The agent-decision feature is unit-verified only.** `StepDecision` is covered by stubbed-agent tests; it has never met a live PDPA screen. That is a gap in evidence, not a known flaw, and the honest next step is one run against `localhost:3000` with `--agent-assist`.

## Suggested order

1. **R1** — it is the only one that can leak a secret, and `--as` widened it this week.
2. **R2.1** (all violations in one re-ask) — the cheapest change with the largest measured effect.
3. **R3** — `captureJourney` on the catalog path.
4. **R5**, **R4**, **R6**, then the rest of R2.
