# jev-ultrafast port — Phase 0 spike (2026-09-18)

Plan: `plans/20260918135009-jev-ultrafast-port.md`. Two facts checked before any
production code, each with a throwaway script in the session scratchpad
(`jev-probe.mjs`, `ref-spike.mjs`), no model in the loop, no browser started.

## (2) One real Jev decision through OpenRouter

Jev is on OpenRouter in beta. `POST https://openrouter.ai/api/alpha/decisions`
takes the **same `{model, state, questions}` body** as `api.typesafe.ai/v1/systemone`,
with the OpenRouter key as bearer and model `~typesafe/jev-latest`. Two
differences learned from the community routing PRs and confirmed live:

- `criteria` values and `instructions` go on the wire as **text** — objects
  are JSON-encoded to strings (jev-ultrafast's OpenRouter PR does exactly
  that). The native API types them `string | null` too.
- The response `model` is the versioned id (`typesafe/jev-1.13-20260917`) and
  `usage` carries `cost` in USD beside `input_tokens`/`output_tokens`.
- The public `/api/v1/models` list does **not** carry the `~typesafe/…` ids;
  `/api/v1/models/~typesafe/jev-latest/endpoints` returns the card with
  modality `text->decisions` and an empty `endpoints` array (beta).

Three requests, jev's own question shape (operation + `click_target` +
`type_text_target`), a six-element sign-in table:

| Turn | Latency | Tokens in/out | Cost | operation (p, conf) | target head (p, conf) |
|---|---|---|---|---|---|
| EN, empty form | 1,771 ms | 1,273 / 136 | $0.000053 | TYPE_TEXT (0.93, 0.91) | type_text_target → [2] Email (0.96, 0.92) |
| EN, both fields filled | 867 ms | 1,368 / 135 | $0.000057 | CLICK (0.98, 0.97) | click_target → [5] Sign in (1.00, 0.99) |
| TH, both filled, with ยกเลิก / ลบบัญชี distractors | 422 ms | 1,596 / 135 | $0.000067 | CLICK (0.96, 0.95) | click_target → [5] เข้าสู่ระบบ (0.99, 0.98) |

Every decision was the one a tester would make; the Thai turn did not go near
the Cancel or Delete distractors. Confidence on the **unused** head (the
`type_text_target` when the operation was CLICK) was low (0.56–0.59), which is
exactly the speculative-head contract: only the chosen operation's head is
consumed. At ~1.3–1.6k input tokens a turn, a 60-turn leg costs ≈ $0.004.

## (1) `aria-ref` over `connectOverCDP` (Playwright 1.62, Chrome 152 headless)

- `page.ariaSnapshot` exists; `locator.ariaSnapshot({ mode: 'ai' })` returns
  the tree with `[ref=eN]` on every named node, over the pre-existing context.
- `page.locator('aria-ref=e12').click()` clicked the **second** of two
  buttons named "Edit" (log `edit-beta`); the name selector's `.first()` took
  the first (`edit-alpha`) — the exact-node targeting the plan wants.
- `locator('aria-ref=eN').ariaSnapshot()` works, so the mutation gate's
  control-name read can run on the ref locator unchanged.
- **A stale ref does not throw a typed error**: after a re-render the click
  waited out its timeout (`waiting for locator('aria-ref=e12')`). So freshness
  must be checked *before* acting (a 0-timeout `count()` on the ref, or the
  turn's own snapshot), not caught after.
- **Refs are per snapshot, not per node**: after the re-render a fresh
  snapshot numbered the same buttons `e21`/`e25`, and refs from an earlier
  snapshot resolve only against the snapshot they came from. The loop must
  take the ai snapshot once per turn, act on that turn's refs, and never
  persist one.
- Combobox fixture: options injected 120 ms after input were visible to a
  `waitFor` in 185 ms — the settle rail's window (200 ms) is realistic.
- `Emulation.setFocusEmulationEnabled` is accepted on a page of the
  connected browser.

## Consequences for the plan

- Phase 1's transport is a **decisions route**, not a chat model: primary
  route OpenRouter (`openrouter` provider, model id `~typesafe/jev-latest`),
  optional native route (`typesafe` provider, `TYPESAFE_API_KEY`,
  `jev-latest`). One hand-rolled client with two URLs — the official
  `@typesafe-ai/sdk` posts to `<baseURL>/v1/systemone` and cannot be pointed
  at OpenRouter's `/api/alpha/decisions` without a fetch shim, so the SDK
  choice is reversed.
- Phase 3's freshness check is a pre-act `count()` on the ref, and refs are
  taken fresh each turn and never persisted.

## Phase 2 live check (2026-09-18): the real loop driving the jev policy

`WorkflowAgent` + `JevAgentModel` (agent role `openrouter:~typesafe/jev-latest`,
data role `claude-cli:sonnet`, never called) on a three-page fixture served
from the spike script, over the CDP Chrome already running. Goal: *Fill the
new-hire form: set Full name to "Ada Lovelace", set Department to
"Engineering", then press Next and confirm, ending on /done.*

| | |
|---|---|
| Outcome | `success: true`, `endedBy: arrived` (the destination rule), final URL `/done` |
| Turns / wall | 7 / 14.2 s |
| Tokens | 17,844 in / 1,357 out (≈ $0.0007 at Jev's price) |
| Values | both from the goal at $0 (`goalValueFor`); the text helper was never called |
| Confidence | 0.30–0.97 per decision, on the record |

The two wasted turns: after `CLICK combobox "Department"` (a native
`<select>`), the tree listed `option "Engineering"` and Jev chose `CLICK` on it
twice — a native select's options cannot be clicked, so each cost the 5 s
action timeout — before choosing `SELECT` on the combobox, which the engine's
`selectOption` performed at once. The policy's next-action rules now say so
literally (SELECT on the control; CLICK an option only when it is a suggestion
under a typed-into field), which is the shape of fix TypeSafe's own
jaggedness notes ask for. Not changed: the engine's `click` on an option, which
is right for a custom listbox.

## Phase 3 diagnostics and live check (2026-09-18)

Three Playwright/esbuild facts found while wiring refs and the settle into
the loop, each measured with a scratch script before the code changed:

1. **A default-mode `ariaSnapshot` regenerates the ref map and restarts its
   numbering** (`e1, e2, e3…` again). The mutation gate's control-name read
   is such a call, so a ref decision's name is now taken from the turn's own
   AI snapshot (`#refNames`) and no default-mode snapshot runs on the ref
   path. Before this every ref click failed at `#target` with "no element
   matches aria-ref=eN" although `count()` had just said 1.
2. **A stale ref does not throw** — `waitFor`/`click` time out — while
   `count()` answers 0 at once, so freshness is checked before acting.
3. **`locator.evaluate` never calls a string** (it evaluates it and returns
   the function), and a TypeScript arrow with named inner closures reaches
   the page as `__name(fn, …)`, which is not defined there; both fail
   silently under a `catch`. The settle is `settleInPage`, built with
   `new Function` from a plain string body.

Live, the same fixture form as the Phase 2 check, refs on, the SELECT rule in
the prompt:

| | Phase 2 | Phase 3 |
|---|---|---|
| Turns / wall | 7 / 14.2 s | **4 / 6.1 s** |
| Tokens in / out | 17,844 / 1,357 | **10,125 / 720** |
| Wasted actions | 2 (CLICK on a native select's option) | 0 |
| Outcome | arrived on /done | arrived on /done |

Every action was the shortest correct one: fill the name from the goal,
SELECT the department from the goal, Next, Confirm.

## After the expert reviews (2026-09-18, later)

The provider-expert and orchestrator-optimizer reviews were folded in: a
capped, abortable retry wait (`DECISIONS_MAX_WAIT_MS`), the refusing stub on
both routes, one shared `decisionModelRefusal` for config, the panel picker
and the probe, `number | null` usage, `nth` counted over the whole tree and by
substring, `text="…"` rows for non-ARIA roles, the typed `no-value` harness
stop after one re-ask, SCROLL_UP withdrawn, target heads carrying the target
rules only. Same fixture, same goal, after: **4 turns / 4.6 s / 7,745 in /
684 out** (the slimmer heads took ~25 % off the Phase 3 token bill), every
action the shortest correct one.

## The catalog generator (Phase 4 of its own plan, 2026-09-18)

Plan: `plans/20260918155200-jev-catalog-generator.md`. Two measurements before
the real run, one real run.

**Programmatic coverage on the EC catalog** (`QA_Task_Tracking_Cycle1_SIT_Optimized_EC.csv`,
first 40 of 272 rows, `planCatalogCase` at $0, no model, no browser):

| | |
|---|---|
| Legs written | 144 (one per numbered sheet step; sign-in and verify-only steps excluded) |
| Sign-ins from persona tokens | 40 of 40 rows (`HR_ADMIN_ACCOUNT`, `MANAGER_ACCOUNT`, hand-offs mid-row) |
| Menu path on the first leg | 40 of 40 |
| Goal ↔ pairs round trip (`goalOutcomes`) | 36 misses → 0 after four rules (no generated stand-in, no blank, quoted controls, last-line-wins, metadata and tokens withheld) |
| Expected lines readable at $0 | 2 of 368 — the EC sheet's expectations are prose (`Employee Status = Active`, `ระบบสร้าง Employee ID เป็นตัวเลข 8 หลัก`), so every row pays one assertions-only model call |

**Authoring tokens on the fixture catalog** (`tests/fixtures/master-data-cases.csv`,
7 rows, no `--url`, generator on `claude-cli:opus`, every row with one unread
Expected line):

| Mode | Model answers | Input / output tokens | Rows authored (incl. risk re-asks) |
|---|---|---|---|
| `llm` | 36 | 660k / 29.6k | 10 |
| `jev` (full prompt in the fallback ask) | 45 | 1,132k / 18.8k | 13 |
| `jev` (row-only ask) | 44 (32 author + 24 risk, at the time of reading) | 1,210k / 21.7k | 12 |

The assertions-only call is NOT small: `LlmFlowAuthorModel` wraps whatever
prompt it is given in the full authoring system prompt plus the repository
slice, so each ask is ~30k input tokens whether it writes a journey or one
assertion, and the dead-end risk judge fires on every attempt. On a catalog
whose Expected lines are prose, jev mode therefore saves no authoring tokens
today; what it changes is WHAT is written (legs the engine reads at $0) and
what the model may touch (assertions only). An assertions-only author with a
small system prompt is the follow-up that would make the fallback cheap.

**Real run 1, HIR-EC-001 on HUMI SIT** (jev author, Jev agent, deny manifest):
authored 34 steps (6 legs + the model's 28 assertions/captures for 24 unread
lines); the run ended at step 1 — the programmatic `signIn` carried no `url`
and the engine refuses to sign in from a page it is not on. Also seen: five
"provider failures" on the agent role — the value resolver, the reviewer and
the risk judge borrow the agent role for a structured question and hit the
decisions-only stub. Both fixed (a `signIn` carries the run's sign-in page;
a decision-model role lends its structured questions to `data`). Run 2 below.

**Real run 2, HIR-EC-001 on HUMI SIT** (same setup): `signIn` passed — the
POST to `local-login` was accepted and HUMI landed the page back on
`/th/login`, as it does. The first leg then started ON the login page: its
menu walker found no "EC" there and handed the turn to Jev, which clicked
"เข้าสู่ระบบด้วย Microsoft" (p 0.42, confidence 0.30), typed into Microsoft's
email box, pressed Next and reported BLOCKED; the five legs after it blocked
in one turn each. 18 s, 6 defects filed, all about a valid session. The text
helper had supplied the OPERATOR'S OWN account email for that box — the
`data` role is served by `claude-cli`, whose session knows who is signed in.
Also seen: the Identity leg carried 29 of 31 pairs (the step's fields are in
the bullets under the number, which `attachPairs` never read), among them
values the sheet says the application derives.

Three fixes, each with its test: the engine records the surface the app went
to between the accepted POST and the bounce (`/th` → `/th/me/home`) and moves
a leg that starts on the sign-in page there before its first turn
(`src/engine/CLAUDE.md`); the text helper refuses an identifier-shaped answer
the goal and the case never state (`inventedIdentifier`); the author matches
pairs against a step's whole block, never uses a verification or sign-in step
as a home, and leaves an Expected-only pair to the assertions as derived.
Run 3 below.

**Real run 3, HIR-EC-001 on HUMI SIT** (same setup, stopped by hand
mid-case): the hand-off worked — `signIn` recorded `/humi/th/home` as the
surface, the first leg was moved there, and Jev reached the hire form in four
turns (ขยายเมนู → สร้างคำขอใหม่ → บุคคล → เพิ่มพนักงานใหม่, then the Identity
section). It then clicked `button "วันเริ่มงาน"` (the Hire Date picker
trigger) five times and was stopped as circling — the table offered no text
entry for a button, and a decision model cannot walk a calendar. Fixed as the
date rung (`src/orchestrator/CLAUDE.md`): a click on a control the goal pairs
with a date becomes a `fill` through the engine's existing date-input
redirect, and a picker trigger now redirects like a read-only display. The
second leg opened `button "จังหวัด"` and then chose SELECT on the open
`listbox "จังหวัด"`, which timed out five times — the next thing to fix. Not
re-run: runs are stopped at the user's request.
