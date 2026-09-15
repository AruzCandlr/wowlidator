# CLAUDE.md — mock data

Split out of the root CLAUDE.md (2026-08-24) so this loads only when working under
`src/data/`. Same authority as the root file; the root keeps the map of the whole system.

## Mock data and `fillRetry` (`src/data/`)

Some failures aren't selector drift at all — "email already exists," "SKU not found" — the selector was right, the *data* was wrong. `fillRetry` is a composite action (same shape as `fillEach`: it does not go through `#resolve`, because the *field* selector is assumed stable and only the *value* is in question): fill, submit, check whether a `failureSelector` is still visible, and if it is, regenerate the value and try again up to `maxAttempts`.

**Five kinds, all the same.** `email`, `username`, `name`, `phone`, `text` generate through `faker` in `mock-data.ts` — deterministic, $0, no model call, ever.

**There was a sixth, and retiring it is the lesson worth keeping** (2026-09-11). `custom` escalated to a `data` model role for a field a heuristic could not classify ("employee ID", "SKU"), and it was the one place in this repo where "AI only where reasoning is required" was decided in advance rather than measured. Measured afterwards, across 1,429 authored flows and 18,704 recorded model calls: **not one `fillRetry` step was ever authored at all**, let alone a `custom` one, and every call the ledger held under the `data` role was `wowlidator doctor` proving the model id still resolved. The kind was unreachable by construction — `FlowAuthor` never emits `fillRetry`, so the only way to write one was by hand through MCP. `data-model.ts` and the role are gone; `fillRetry` and its five free kinds stay, because the composite action is still the right shape for a value the page rejects.

**Attempt 2+ doesn't just re-roll — it makes collision structurally impossible, not merely unlikely.** `generateValue(kind, attempt)` embeds a uniqueness suffix (`Date.now()` base-36 plus the attempt number) from the second attempt onward, placed *before* the `@` for `email` specifically, since `local+tag@domain` is a well-known deliverable-alias convention and keeps the value looking like a real email rather than a garbled one.

**Seeding a backend is now possible, and `fillRetry` still doesn't do it.** This used to be a documented non-goal on the grounds that there was no HTTP capability to build it on. There is now (`src/api/`), so the honest statement is narrower: regenerating a client-side value and creating a missing resource are different jobs, and a `request` step already does the second one explicitly, in the flow, where a reader can see it. Burying a silent POST inside a `fillRetry` retry loop would hide a write behind what reads like a form-filling action. If a test needs a resource to exist, create it with a `request` step in `Flow.setup`.
