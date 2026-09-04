# CLAUDE.md — mock data

Split out of the root CLAUDE.md (2026-08-24) so this loads only when working under
`src/data/`. Same authority as the root file; the root keeps the map of the whole system.

## Mock data and `fillRetry` (`src/data/`)

Some failures aren't selector drift at all — "email already exists," "SKU not found" — the selector was right, the *data* was wrong. `fillRetry` is a composite action (same shape as `fillEach`: it does not go through `#resolve`, because the *field* selector is assumed stable and only the *value* is in question): fill, submit, check whether a `failureSelector` is still visible, and if it is, regenerate the value and try again up to `maxAttempts`.

**Five kinds, one of them different.** `email`, `username`, `name`, `phone`, `text` generate through `faker` in `mock-data.ts` — deterministic, $0, no model call, ever. `custom` escalates to the `data` role's `DataModel` for a field a heuristic can't classify ("employee ID", "SKU"). This is where "AI should only be used where reasoning is required" stops being a slogan: most `fillRetry` steps never reach `data-model.ts` at all.

**Attempt 2+ doesn't just re-roll — it makes collision structurally impossible, not merely unlikely.** `generateValue(kind, attempt)` embeds a uniqueness suffix (`Date.now()` base-36 plus the attempt number) from the second attempt onward, placed *before* the `@` for `email` specifically, since `local+tag@domain` is a well-known deliverable-alias convention and keeps the value looking like a real email rather than a garbled one.

**Seeding a backend is now possible, and `fillRetry` still doesn't do it.** This used to be a documented non-goal on the grounds that there was no HTTP capability to build it on. There is now (`src/api/`), so the honest statement is narrower: regenerating a client-side value and creating a missing resource are different jobs, and a `request` step already does the second one explicitly, in the flow, where a reader can see it. Burying a silent POST inside a `fillRetry` retry loop would hide a write behind what reads like a form-filling action. If a test needs a resource to exist, create it with a `request` step in `Flow.setup`.
