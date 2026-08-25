# Project evaluation — 2026-08-25

Successor to `system-audit-2026-08-18.md`. Method: the be100 catalog campaign
(108 human-recorded cases run against HRCenter-DEV, three full passes plus a
repair-assisted rerun), live-page probing of every failure class, the full test
suite, and a dead-code sweep of `src/`.

## The numbers

| Measure | Value |
|---|---|
| Source | 110 files, ~56,900 lines of TypeScript |
| Tests | 56 files, ~24,000 lines — 19 suites, all green including the browser tier (0 fail, 0 skip with CDP up, ~5 min) |
| Runtime dependencies | 16 (4 dev) — the AI SDK, provider adapters, Playwright, xlsx/pdf readers |
| Self-documentation | 18 `CLAUDE.md` files (root map + per-directory rationale) |
| Largest files | `engine/runner.ts` 6,543 · `ui/wow-ui-html.ts` 4,916 · `generator/flow-author.ts` 3,595 |

## What the be100 campaign measured

Ground truth: the sheet's human-recorded *Actual Result* (98 scored rows, 10
unscored). Positive = wowlidator files a defect.

- **Strict agreement with the human tester: 27–29%** per full pass. Among cases
  where wowlidator actually delivered a verdict, agreement is ~70% — the gap is
  not wrong judgments, it is **no judgment**: 59–65 of 98 cases per pass ended
  `error`/`dead-end`.
- The no-verdict causes, measured (65 cases, latest pass):
  - **40× authored selectors that cannot match** — `role=region >> …` (Chrome's
    AX tree shows a `region`; ARIA grants that role only to a *named* section,
    so Playwright finds none), headings that are really breadcrumb links, and
    **hardcoded volatile counts** (`text="75"`) stale the moment the suite's own
    writers touch the data.
  - **14× agent stalls** on unresponsive controls (the stall guard working as
    designed — the turns were going nowhere).
  - **9× goal unreachable** — data rows earlier delete-cases had removed.
  - **2× provider failure** (structured-output circuit breaker on a free tier).
- False positives (7–8 per pass) are mostly count/DB assertions against data
  the suite itself had mutated — same root as the 40 above.

**The bottleneck is authoring fidelity and data-state discipline, not the
runtime.** The engine's ladder, the healer, and the agent guards all behaved as
documented; what they were given to run was unprovable as written.

## What was changed on this evidence (2026-08-24/25)

- **Readers run before writers** in every suite (`readersFirst`, `--sheet-order`
  to opt out) — a suite no longer invalidates its own remaining reads.
- **Agent stops are judged by logic, not a turn ceiling** — arrival, stall,
  no-progress; `WOWLIDATOR_AGENT_MAX_STEPS` reinstates a cap.
- **Dead waits removed** — post-navigation `networkidle` holds capped at 2 s,
  the consent-shell wait polls for the gate itself, action timeout 8→5 s,
  per-turn prompt slimmed (60 AX nodes, 8 history lines).
- **Suite concurrency default 4→8**; catalog accuracy (`knownResult`) now
  travels sheet → flow → bundle → wowUI chip.
- **The volatility rail** (`volatileCountAssertion`, 2026-08-25): authoring now
  refuses an assertion whose whole claim is a bare number the request never
  stated — the `text="75"` class — with the informed re-ask pointing at the
  labeled anchor or `expectDbCount`. A number the request itself states is
  still asserted exactly; the sheet's word remains the claim.

## Strengths worth keeping

1. **The two-plane design held under fire.** A provider circuit-breaker outage
   mid-suite produced *misclassified-as-environment* errors, not false defects —
   `goal-evidence.ts`'s "a provider failure is not an application failure" rule
   is load-bearing and worked.
2. **Evidence-first reporting.** Every claim in this evaluation was checkable
   from proof bundles — failure screenshots, per-step resolutions, agent
   histories. Few test tools can audit themselves this way.
3. **The test tiering is honest.** Gated tiers say why they skip; the browser
   tier runs against real Chrome; fixtures are cross-validated against real
   tools ("a reader tested only against its own writer proves nothing").
4. **Frozen contracts** (exit codes, injectable model seams, MCP-owns-stdout)
   have survived provider migrations and feature growth without call sites
   moving.

## Risks, in order of teeth

1. **Typed passwords reach proof bundles in cleartext.** `redact.ts` covers
   HTTP evidence; `fill` values (and the emailable report) do not pass through
   it. Anyone sharing a bundle shares the credential. Highest-value fix in the
   repo right now.
2. **Authoring rails lack a volatility rule.** The generator freely asserts
   exact counts (`text="75"`) and invents container roles the runtime cannot
   match. A rail — "never assert a bare number read off the page; assert the
   labeled thing" — would have prevented most of the 40 dead-ends.
3. **Free-tier provider fragility.** One key per provider in practice; the
   structured-output breaker took out two suites this week. Mitigations that
   exist: key rotation (`PROVIDER_KEY=k1,k2`), re-pointing roles via env,
   `doctor`/wowUI Check probes. Missing: a cross-provider fallback chain per
   role.
4. **Cross-run data state.** Readers-first protects a single suite; nothing
   resets the application between suites, so counts captured at authoring time
   rot. A seed/reset hook (or authoring-time re-probe of volatile values)
   is the structural fix.
5. **Maintainability hotspots.** `runner.ts` (6.5k lines) and the two
   HTML-template modules are approaching the size where the prose conventions
   that keep this repo navigable stop scaling. The `cli/` split (2026-08-24)
   is the model to follow.
6. **The proof directory accepts foreign bundles.** CLI test subprocesses wrote
   41 unrelated bundles into a live proof dir during the campaign; grouping
   absorbs them but dashboards count them. A bundle should carry, and readers
   should prefer, its suite identity.

## Hygiene sweep (and what it changed)

A full dead-code audit of `src/` found the codebase unusually clean:
`noUnusedLocals` + `noUnusedParameters` make unused imports and locals build
errors; there are **zero** debug leftovers, zero commented-out code blocks, and
exactly one TODO-shaped string in all of `src/` (a prompt telling a model *not*
to write "TODO"). Applied on the sweep's evidence (2026-08-25, all tests green
after):

- **Three source files contained raw NUL bytes** (`serial-gate.ts`,
  `launch-presets.ts`, `tests/api.test.ts` — deliberate separators written as
  literal bytes), which made `file(1)` call them binary and grep/ripgrep skip
  them **silently**. Rewritten as JS `\u0000` escapes — byte-identical at runtime,
  and every future audit of this repo now actually sees them.
- Deleted the only two dead exports (`probeAllRoles`, superseded by both
  callers looping `probeRole` themselves; `CONTEXT_BUDGET_SUGGESTED`, a
  duplicate of `CONTEXT_BUDGET_CHARS`) and the one dead CSS rule
  (`.step-intent`, already annotated `/* legacy */`).
- De-exported 22 module-private functions/classes that nothing outside their
  file references — the compiler now enforces what the sweep found.
- `pg` moved from `dependencies` to `optionalDependencies`, matching
  `src/db/pg.d.ts`'s stated design ("a run that never executes a DB step must
  never demand it") which the manifest had drifted from; the phantom
  `@ai-sdk/provider` import in `tests/helpers.ts` is now pinned in
  devDependencies instead of riding `ai`'s dependency tree.

Left alone, deliberately: ~140 exported types/constants with no external
referent (exporting types is house style), the `src/index.ts` barrel (the
package's `exports["."]` surface), and every test-facing export.

## Verdict

The architecture is sound and the safety rails are real — measured under
provider outages, app drift, and its own writers corrupting state, the system
failed *closed* (no verdict) rather than *wrong* (false verdicts), which is the
correct failure direction for a testing tool. The work that moves the accuracy
number now is unglamorous: authoring fidelity rails, data-state hygiene, and
credential redaction — not new capabilities.
