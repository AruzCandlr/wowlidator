# jev-ultrafast port — TypeSafe provider, indexed action space, runtime rails

Written 2026-09-18 on branch `typesave-x-jevultra`. Source studied:
`browser-use/jev-ultrafast` (cloned to the session scratchpad; `agent.py`,
`model.py`, `questions.py`, `browser.py`, `snapshot.js`, `docs/design.md`,
`docs/performance.md`) and the TypeSafe docs (`docs.typesafe.ai/api.md`,
`models.md`, `model-jaggedness/jev-1.13.md`, JS SDK reference).

Decisions already taken with the user (2026-09-18): the decision transport is
**TypeSafe's Jev API as a new provider** (not an AI-SDK structured call), and
the port **includes jev's runtime techniques**, not only the control plane.

## 1. What jev-ultrafast is, in five techniques

| # | Technique | Evidence |
|---|---|---|
| T1 | **Indexed action space.** Every observation is a numbered element table; the model picks an *index*, never writes a selector. | `model.py` `action_space()`; README "Model output never becomes selectors" |
| T2 | **One request, speculative heads.** A single TypeSafe `systemone` call carries `operation` (CLICK / TYPE_TEXT / SELECT / SCROLL_UP / SCROLL_DOWN / WAIT / DONE / BLOCKED) plus one target head per offered operation (`click_target`, `type_text_target`, `select_target`); code consumes only the chosen operation's head. | `model.py` `choose()`; TypeSafe fan-out pattern |
| T3 | **Text helper only on TYPE_TEXT.** A small OpenAI-compatible LLM writes the field value from goal + field + page text + recent actions; must return `{text}`; cached across a stale retry only while the whole helper input is identical. | `model.py` `field_text()`, `agent.py` `pending_text` |
| T4 | **Atomic DOM snapshot with code-owned node identity**, semantic freshness guards (page key + per-node guard) checked before acting, geometry and occlusion re-resolved just before input, no screenshots in the loop. | `snapshot.js`, `browser.py` `fresh()`/`act()` |
| T5 | **Event-based settle.** After an interaction wait ≤ 2 animation frames / 50 ms; after typing into an editable combobox wait for a visible `[role=option]` capped at 200 ms; focus emulation keeps background tabs rendering. | `browser.py` `observe()`; README "Wait for useful state" |

Measured claims (three matched pairs, one task): median 9.45 s → 7.09 s, browser
protocol calls 1,092 → 101, TypeSafe latency median 178 ms. Limits the README
states: no shadow roots / frames / uploads / pop-ups; `DONE` is never proof.

TypeSafe facts that shape the design (confirmed from the docs):
- `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer <key>`,
  body `{state, model, questions}`; a `choice` question is `{type, instructions,
  criteria: map<option, description|null>}`; the answer is `{type:'choice',
  choice, probabilities, confidence}`; `usage: {input_tokens, output_tokens}`.
- Model `jev-latest` → `jev-1.13.0`. $0.042 per Mtok **input**, output free.
  64k context, 32k for state + longest question. **Text only** — no images.
  Rate limits "adjusting dynamically"; 429 with `retry-after`.
- Official JS SDK `@typesafe-ai/sdk` 0.6.0 on npm (retries with backoff,
  honours `retry-after`, typed `choice()` helper, reads `TYPESAFE_API_KEY`).
- Jev 1.13 jaggedness: literal reading, cannot count, weak on dates, accuracy
  falls with irrelevant state, English-first ("CJK … handled but not equally
  well; pay close attention to confidence").

## 2. Confirmed facts about this codebase

- **The seam.** `AgentModel { id; decide(observation): Promise<AgentDecision> }`
  (`src/orchestrator/workflow-agent.ts:703`). `AgentObservation` carries
  `axTree` (a rendered string), `history`, `ledger`, `formGaps`, `skills`,
  `dbCount`, `feedback`, optional `screenshot`. `AgentDecision` is
  `{action, selector, value, url, reasoning, next?, tokens}`. Every guard,
  the mutation gate and `#act` consume that decision — nothing downstream
  knows how it was produced.
- **One tree reader.** `#captureTree` (`workflow-agent.ts:2703`) is the only
  way the class reads the page; it feeds `TargetProvenance.observe(nodes)`
  (`mutation-policy.ts:359`). The focused table the model sees is
  `focusTree(all, goal, maxNodes)` (`agent-guards.ts:89`) rendered by
  `renderTree`. The full tree feeds every judge (`treeKey`, `goalOutcomes`,
  `outcomeShown`, `fixtureAlreadyPresent`, `formGaps`).
- **Selectors are the currency of the guards.** `selectorGrounded` reads the
  *name* out of the selector and checks it against the tree text;
  `decisionKey`, `activationKey`, `reactivation`, `repeatedToggleClick`,
  `unscopedDestructiveClick` all key on the selector string. `#record` and
  `scriptOf` persist the selector (the replay rung and the flow-file script
  rung replay it on later runs).
- **Execution rails hang on a Playwright `Locator`.** `#act` → `#target`
  (1.5 s attach, reveal-hidden), `humanClick`/`humanFill` (`locator.click`,
  `locator.fill` — so Playwright's actionability checks: visible, stable,
  enabled, receives events / hit-target), the mutation gate's
  `ariaSnapshot` read of the control name and `#dialogFor`, `#writable`
  (read-only display vs the date input beside it), the hydration
  read-back-and-refill, the listbox procedure, the film. All by selector.
- **Playwright 1.62 has the node-identity primitive jev hand-rolled.**
  `ariaSnapshot({ mode: 'ai' })` returns a snapshot with `[ref=eN]` markers
  (`node_modules/playwright-core/types/types.d.ts:2077`), and the
  `aria-ref=eN` selector engine ships in `lib/coreBundle.js`. A ref is a
  real `Locator`, so every rail above keeps working when the target is a ref.
- **Provider registry.** `PROVIDERS` / `PROVIDER_META` / `DEFAULT_PROVIDER_MODELS`
  / `parseApiKeys` in `src/config.ts`; `FACTORIES` in
  `src/providers/llm-factory.ts` returns an AI-SDK `LanguageModel`;
  `probeRole` (`probe.ts:145`) calls `generateText` through
  `callWithFailover`; `llm-log.ts` logs every request/response/failure;
  `src/ui/keys.ts`, `models.ts`, `claude-settings.ts`, `server.ts`,
  `src/cli/quota-hold.ts`, `case-plan.ts` read the registry.
- **The agent is built in three places** in `src/cli/runtime.ts` (`buildAgent`,
  `buildInvestigationAgent`, the capture pilot), each `new LlmAgentModel({factory})`.
- **The `data` role** (`src/data/data-model.ts`) is the existing small-value
  model, reached through `generateStructuredForModel({factory, role:'data'})`.
- **No TypeSafe key is set** in this checkout's `.env` (checked by name only).
  The memory's browser-use `AgentEngine` seam is **not** on this branch.
- **Already tested offline against the loop:** `tests/agent-guards.test.ts`
  drives `WorkflowAgent.run` against a `fakePage` (CDP tree + locator stubs)
  with a scripted model; `tests/helpers.ts` `jsonModel()` mocks any AI-SDK role.

## 3. Recommended approach

One policy, one provider, one switch. Pointing the agent role at the new
`typesafe` provider (`WOWLIDATOR_AGENT_PROVIDER=typesafe`) selects the jev
policy; any other provider keeps `LlmAgentModel` byte-for-byte. The loop,
the guards, `#act`, provenance and the mutation gate are not forked: the jev
policy produces an ordinary `AgentDecision`, and the runtime rails are added
*inside* the existing `#act`/settle path, behind the decision's optional ref.

The port maps jev's techniques onto what already exists rather than
replacing the AX tree with a DOM walker (see §8 non-goals).

### Phase 0 — spike (gates everything after it)

Two facts nobody has verified in this repo, each a throwaway script under the
scratchpad, no model, no production code:

1. Over `connectOverCDP` on the existing context, does `ariaSnapshot({mode:'ai'})`
   return refs, does `page.locator('aria-ref=eN')` resolve and click, and what
   exactly does a **stale** ref throw after the page re-renders? (Its error
   wording becomes the freshness signal in Phase 3.)
2. With a `TYPESAFE_API_KEY`: one `systemone` call with jev's own question
   shape (operation + two target heads) against a fixture element table —
   latency, `usage`, and whether `criteria` values may be objects (jev sends
   objects; the docs type them `string | null`).

Outcome recorded in `docs/research/2026-09-18-jev-spike/README.md`. If (1)
fails over CDP, Phase 3's ref rail falls back to a harness-stamped
`data-wow-ref` attribute set in one page evaluate — same shape downstream.

### Phase 1 — the `typesafe` provider (`src/providers/`, `src/config.ts`)

- Registry: `typesafe` in `PROVIDERS`; `PROVIDER_META.typesafe` (env key
  `TYPESAFE_API_KEY`, console `https://console.typesafe.ai/settings/keys`,
  the price/limits line); `DEFAULT_PROVIDER_MODELS.typesafe = 'jev-latest'`;
  keys parsed beside the others.
- **A role other than `agent` on `typesafe` is a `ConfigError`** at config
  time, worded ("TypeSafe answers typed questions, not prompts — it serves
  the agent role's jev policy only"). Same place a bad provider name fails.
- `src/providers/typesafe.ts`: the one client — `askJev(request)` → validated
  answers. Built on `@typesafe-ai/sdk` (latest at implementation time; 0.6.0
  today) unless the provider-expert review prefers the ~40-line fetch jev
  uses; either way: bearer from the factory's key list, key rotation on a
  key-shaped failure through the existing `activeKeyIndex` seam, 429 waited
  out per `retry-after`, errors reworded with the model label and **no key**
  in any message (scrub as `probe.ts` does), every call through
  `logLlmRequest`/`logLlmResponse`/`logLlmFailure` with label
  `typesafe:jev-latest` and the request's `usage`.
- `FACTORIES.typesafe` returns a `LanguageModel` stub whose `doGenerate`
  rejects with the same wording as the config error — so `createModelForRole`,
  `labelFor`, `canResolve` and the breaker stay structurally uniform.
- `probeRole` gains a provider branch: for `typesafe` the doctor's one-token
  call is one `noul` question ("Is this text the word ok?") through the
  client, reporting latency and usage like every other role. Same
  `no-key` / `ready` / error classification.
- Docs: `.env.example` block; `src/providers/CLAUDE.md` section stating why
  this provider is the one that is not an AI-SDK model (it is not an LLM and
  has no AI-SDK adapter; the "never a vendor SDK" rule is about chat
  providers); root `CLAUDE.md` provider count and model table.

### Phase 2 — the indexed policy (`src/orchestrator/jev-policy.ts`, loop changes)

**Observation.** `AgentObservation.elements?: IndexedElement[]` — optional,
so every existing caller and test is untouched and `LlmAgentModel` ignores it.
Built in the loop from the *same* `focusTree` nodes the string tree renders,
so the model's table and the judges' tree can never disagree. Each element:
1-based `index`, `role`, `name`, `value`, `checked/disabled/readonly/required/url`,
`operations` (CLICK for interactive roles; TYPE_TEXT for
textbox/searchbox/spinbutton and a non-readonly combobox; SELECT for a
combobox / popup button), the canonical selector the loop already writes for
its menu walker (`role=<role>[name="<name>" i]`, plus `>> nth=k` for the k-th
duplicate in document order), and — from Phase 3 — `ref`.

**The question set (T2).** `state` = `{goal, url, caseContext, elements
(compact rows), recent_actions (last 10 history lines), ledger, formGaps,
feedback}`; `questions` = `operation` (criteria: the offered operations only,
DONE/BLOCKED always, plus SAVE when the goal is a save-a-value goal) and one
target head per offered operation with criteria `index → "[i] role name ·
value · flags"`. Instructions are jev's `NEXT_ACTION`/`TARGET` rules rewritten
literal and short (Jev reads literally, cannot count), with the loop's own
policy sentences kept out — the guards are the policy layer, exactly as
`agent-skills` pins today. A `readOnly` observation (the engine's triage
look) gets the verdict set instead: `verdict ∈ {proved, can-heal, fail}` +
`proved_target`, so the look rung keeps working on a text-only model
(`screenshot` is ignored, documented).

**Vocabulary mapping.** CLICK→`click`, TYPE_TEXT→`fill`, SELECT→`selectOption`,
SCROLL_UP/DOWN→`scroll`, WAIT→`wait`, SAVE→`save`, DONE→`finish`,
BLOCKED→`fail`. Not offered: `goto` (the loop's $0 destination rungs already
cover it), `press`, `hover`, `check`/`uncheck` (a CLICK on a checkbox is the
engine's click), `dbCount`, `signOut`, `read`. Recorded in the CLAUDE.md
section with the reason for each.

**Answer validation** (jev's `validate_choice`, "never trust a number"):
chosen option must be an offered criterion, probabilities over exactly the
offered set summing to ≈1, confidence clamped to 0–1; anything else is a typed
`JevAnswerError` → the loop's existing `model-error` stop, no action taken.
`reasoning` is synthesised for the record (`CLICK [7] button "Save" · p=0.91
· confidence 0.62`) so reports, `settledBy: agent-claim` evidence and the
history read as today; `confidence` and the head's probability ride the
action record as new descriptive fields (schema-loose, per
`src/artifacts/schemas.ts` rules).

**The value for TYPE_TEXT / SELECT (T3), two rungs.** Rung 1, $0: the loop's
own `goalOutcomes(goal)` pairs — when the chosen field's name matches a pair's
control (the same matching `outcomeShown` uses), the goal's value is typed
verbatim; this honours "AI only where determinism runs out" and the
generator's "tokens are resolved, never typed". Rung 2: a text-helper call on
the **`data` role** (`generateStructuredForModel`, schema `{text: string|null}`
— nullable, flat, per the provider rules), prompt = jev's `TEXT_VALUE` +
`DETERMINISM_RULES`, input = goal, field, visible tree text (capped), last 6
actions. Cached across a stale re-ask only while the whole helper input is
byte-identical; discarded after the action runs. A `null`/empty answer fails
the action with jev's wording ("no text is hardcoded or guessed").

**Selection.** `agentModelFor(factory)` in `src/cli/runtime.ts` replaces the
three `new LlmAgentModel` sites: `typesafe` on the agent role → `JevAgentModel`,
else `LlmAgentModel`. `JevAgentModel.id` is `typesafe:jev-latest`, resolved
lazily like the others (a run with no workflow step demands no key).

### Phase 3 — the runtime rails (T4, T5), inside the existing path

- **Exact targeting by ref.** One `ariaSnapshot({mode:'ai'})` per turn beside
  `#captureTree`; refs are matched to AX nodes by (role, name, document
  order) and ride `IndexedElement.ref`. The policy puts the ref on a new
  optional `AgentDecision.ref`. In `#act`, when `ref` is set, the locator for
  the action, the gate's control-name read and `#dialogFor` is
  `aria-ref=eN`; the decision's `selector` stays the canonical name selector
  for every guard, the history, the record and the replay script — a ref is
  a per-capture execution hint and is **never persisted** (`scriptOf`,
  `PlanStep`, the cache and the flow file are unchanged). A ref that matched
  nothing means the selector path, exactly as today; `refMatched`/`refMissed`
  counts go on the record so the divergence between Playwright's and
  Chrome's accessible names (the root CLAUDE.md's worst-ever defect) is
  measured, not assumed.
- **Freshness before acting.** A stale ref (the error Phase 0 identifies)
  is not a failed action: the loop re-captures and re-asks once at $0 with
  `feedback` "the page changed since you looked", mirroring jev's
  `StalePage` retry; a second stale is the ordinary failed action.
- **Settle after an action** (`#settleAfter`, T5): one page evaluate that
  waits two animation frames or 50 ms; if the acted control is an editable
  combobox (`aria-autocomplete` / `aria-controls`), waits for a visible
  `[role=option]` capped at 200 ms; then the existing networkidle-capped
  settle runs unchanged. Nothing gets shorter than today — the hydration
  race in the root CLAUDE.md is why the networkidle floor stays — but the
  combobox case stops paying a fixed 750 ms retry to see options arrive.
- **Focus emulation.** `Emulation.setFocusEmulationEnabled` on every page
  the runner creates (`runner.ts` 2294 / 2354 / 8549 / 8584 → one helper),
  so a background lane's page keeps running animation frames under
  `--browsers`/`--concurrency`. Engine-expert owns this line.
- **Already present, not ported (stated so nobody ports it twice):** geometry
  and occlusion re-check before input (Playwright actionability in
  `locator.click`/`fill`); native `<select>` and custom listboxes
  (`selectOption`); no screenshots in the driving loop; action recorded
  before the next observation; budget and stall judges.

### Phase 4 — measure, then the keep/remove verdict

Same discipline as the browser-use integration: the native reference run of
HR_SIT 1.001 (`hrsit-e2e01-agentassist-opuslow-20260918-112551`, 36/109,
3 m 46 s, from memory — its bundle must still be on disk) against a
`WOWLIDATOR_AGENT_PROVIDER=typesafe` run of the same case: pass count, agent
requests, agent seconds, in-tokens and dollars, `refMatched/refMissed`,
low-confidence decisions. Written to `docs/research/2026-09-18-jev-spike/`.
Default stays native until this says otherwise.

## 4. Files touched

| Area | Files |
|---|---|
| Config / provider | `src/config.ts`, `src/providers/llm-factory.ts`, **new** `src/providers/typesafe.ts`, `src/providers/probe.ts`, `.env.example`, `package.json` (`@typesafe-ai/sdk`) |
| Policy | **new** `src/orchestrator/jev-policy.ts` (element table, questions, validation, mapping, text helper), `src/orchestrator/workflow-agent.ts` (`elements` on the observation, `ref` on the decision, `#act` ref path, `#settleAfter`, stale-ref re-ask), `src/engine/proof-bundle.ts` + `src/artifacts/schemas.ts` (descriptive fields) |
| Wiring | `src/cli/runtime.ts` (`agentModelFor`), `src/engine/runner.ts` (focus emulation helper) |
| Docs | `src/orchestrator/CLAUDE.md`, `src/providers/CLAUDE.md`, `src/engine/CLAUDE.md`, root `CLAUDE.md`, the memory file |
| Tests | **new** `tests/jev-policy.test.ts`, `tests/typesafe.test.ts`; additions to `tests/agent-guards.test.ts` (loop under a scripted Jev transport), `tests/config.test.ts`/`full-workflow.test.ts` (registry, doctor branch), CDP-gated `tests/agent-economy.test.ts` or a new `tests/jev-runtime.test.ts` (refs, stale ref, combobox settle, focus emulation) |

## 5. Validation

Every tier is opt-in by environment, like the rest of the suite:

- **Unit, always ($0):** element table (operations per role, `nth` for
  duplicates, focused nodes only); question builder (a head only for an
  offered operation, DONE/BLOCKED always, the read-only verdict set);
  answer validation (choice outside criteria, probabilities not summing,
  confidence as `1.4` / a string → typed error, **no action**); op→decision
  mapping; rung-1 value from `goalOutcomes` with the data role **not
  called** (`callsTo === 0`), rung 2 called once and cached across an
  identical stale re-ask; TypeSafe client against an injected fetch (bearer,
  body shape, 429 → `retry-after` wait, no key in any error); config refuses
  `WOWLIDATOR_HEALER_PROVIDER=typesafe`; the loop under `fakePage` with a
  scripted Jev transport goes through the real `#act`, the gate and the
  record; `scriptOf` never carries a ref.
- **Browser (CDP up):** on a fixture with two controls named "Edit", the ref
  path clicks the second one where the name selector would have taken the
  first; a re-render between snapshot and click yields the $0 re-ask; a
  combobox fixture whose options arrive after 120 ms is seen within the
  200 ms window; a hidden page keeps counting animation frames with focus
  emulation on.
- **Live (key + CDP):** `wowlidator doctor` resolves the agent role on
  `typesafe`; one goal on the local fixture reaches its destination.
- **Benchmark (key + VPN + CDP):** Phase 4.
- **Static:** `npm run typecheck`, `npx tsc -p tsconfig.test.json --noEmit`,
  `npm test` (browser tier skipped with the reason printed when CDP is down).
- **Reviews:** provider-expert on Phase 1, orchestrator-optimizer on Phase 2
  and the loop half of Phase 3, engine-expert on the `#act` ref path, settle
  and focus emulation.

## 6. Risks

- **No key here.** Phases 1–2 are verifiable offline; how Jev actually
  behaves on this app is unknown until a key exists. Phase 0 (2) and Phase 4
  block on it.
- **Thai catalogs on an English-first model.** HUMI's controls are named
  `ลบ`, `ยืนยัน`, `กรอกข้อมูล…`; the docs say other languages are "not
  equally well" handled. Mitigation in scope: confidence is recorded per
  action and summarised in Phase 4; a confidence floor that *refuses* a
  decision is deliberately **not** added (Jev is deterministic — a re-ask
  returns the same answer — and a fallback LLM transport is out of scope by
  the user's decision).
- **Accessible-name divergence** between Playwright's snapshot and Chrome's
  AX tree can leave elements without a ref. Mitigated by design: a ref is an
  optimisation with the selector path as the floor, and the miss count is on
  the record.
- **Vocabulary loss.** No `press`/`goto`/`check`: a listbox that only opens on
  Enter and a wizard the tree does not expose stay outside the policy's
  reach; the engine's own rungs (destination goto, menu walker, listbox
  procedure) and the existing judges bound the leg as today.
- **Rate limits are dynamic** at TypeSafe; a catalog at eight lanes may see
  429s. The client waits per `retry-after`; the suite-wide quota hold is
  claude-only and is not extended here.
- **State size.** 32k tokens for state + longest question; a 120-node form
  table plus history is a few thousand tokens — well inside, but the head
  criteria repeat the table once per offered operation.

## 7. Assumptions and open questions

1. The user can obtain a `TYPESAFE_API_KEY` (console.typesafe.ai) for
   Phase 0 (2) and Phase 4. Until then the live tiers skip with the reason.
2. Client: the official `@typesafe-ai/sdk` (recommended: retry/backoff and
   `retry-after` for free, typed answers) rather than a hand-rolled fetch.
3. `SAVE` is offered as an operation (the ~200 "บันทึก … ที่ระบบสร้าง" rows
   need it); the other omitted verbs stay omitted until measurement asks.
4. The HR_SIT 1.001 native reference bundle is still on disk under
   `valst-output` for Phase 4; if not, a native run is taken first.
5. `ariaSnapshot({mode:'ai'})` is called on the page's root locator; whether
   `page.ariaSnapshot` exists directly in 1.62 is checked in Phase 0.

## 8. Non-goals

- Replacing the CDP accessibility tree of record with jev's DOM walker
  (`snapshot.js`): the tree feeds every judge and the provenance ledger, and
  "the AX tree, not the DOM" is a stated rule; refs give the node identity
  without changing the evidence basis.
- CDP-direct input dispatch (`Input.dispatchMouseEvent`, `Input.insertText`)
  bypassing Playwright: it would skip the mutation gate's locator reads, the
  film's humanize, the hydration read-back and `#writable`.
- A second execution plane or engine seam (the browser-use lesson).
- jev's inspector/demo UI, screencast recording, and the AI-SDK transport
  for the indexed policy (declined by the user; could be added later behind
  the same `IndexedElement` seam).
- Plan-ahead (`next`) heads for Jev, and a confidence-gated fallback to an
  LLM — both candidates for a later phase, only if Phase 4 asks for them.

## 9. Status (2026-09-18, end of day)

- **Phase 0 — done.** Both spikes pass; findings in
  `docs/research/2026-09-18-jev-spike/README.md`. Route changed to
  OpenRouter's Decisions endpoint (the user supplied an OpenRouter key; Jev is
  on OpenRouter in beta as `~typesafe/jev-latest`); the SDK choice was
  reversed for one hand-rolled client with two URLs.
- **Phase 1 — done.** `typesafe` provider, `isDecisionModel`, `decisions.ts`,
  the doctor branch, the panel listing, `.env.example`, docs;
  `tests/decisions.test.ts` (17). Live `doctor`: the agent role on
  `openrouter:~typesafe/jev-latest` answers in ~0.7 s.
- **Phase 2 — done.** `indexElements`, `JevAgentModel`, `agentModelFor`,
  `confidence`/`probability` on the record, docs; `tests/jev-policy.test.ts`
  (19). Live: the real loop reached the fixture's destination.
- **Phase 3 — done.** Refs (`withRefs`, `AgentDecision.ref`, `#actingSelector`,
  `StaleRefError`, `#refNames`), the settle (`settleInPage`), focus emulation
  (`enableFocusEmulation`), `AgentRecord.refs`; `tests/jev-runtime.test.ts`
  (5, three CDP). Live: 4 turns / 6.1 s on the fixture.
- **Reviews — folded in** (provider-expert, orchestrator-optimizer; see the spike README's last section). Remaining follow-up from the reviews, not done: an engine-level translation of a `click` on a native `<option>` into `selectOption` (engine-expert's), booking OpenRouter's per-call `cost` into a ledger, and a 120-node Thai form's state size measured against Jev's 32k budget before a catalog run.
- **Phase 4 — open.** The HR_SIT 1.001 benchmark needs the VPN and a native
  run to compare against; not taken today. The default stays native
  (`LlmAgentModel`) until it is.
- Pre-existing, unrelated: two `tests/agent-guards.test.ts` cases fail before
  and after this work ("never presses an unscoped Delete", "refuses a PRESSED
  stepper") — the circling guard now types as a `guardrail` hold and the
  unscoped-delete fixture predates the approval gate.
