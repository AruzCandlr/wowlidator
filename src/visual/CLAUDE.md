# CLAUDE.md — visual regression

Split out of the root CLAUDE.md (2026-08-24) so this loads only when working under
`src/visual/`. Same authority as the root file; the root keeps the map of the whole system.

## Visual regression (`src/visual/baseline.ts`)

Screenshots were already captured as *evidence*; `snapshot` turns them into *assertions*. A CSS regression that makes a page unreadable passes every functional test ever written, because the DOM is fine and only the pixels are wrong.

- **PNG, never JPEG** — lossy artefacts register as pixel drift.
- **A missing baseline is created and passes**, with `outcome: 'created'` and a message saying nothing was verified. Failing the first run would make the feature unusable in CI.
- Baselines are keyed by **author-chosen name**, not step index, so inserting a step earlier does not invalidate everything after it.
- A viewport change reports `size-mismatch` rather than a meaningless 90%-drift number.
