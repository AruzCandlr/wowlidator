# CLAUDE.md — UI coverage

Split out of the root CLAUDE.md (2026-08-24) so this loads only when working under
`src/coverage/`. Same authority as the root file; the root keeps the map of the whole system.

## UI coverage (`src/coverage/ax-coverage.ts`)

Code coverage answers "which lines ran"; UI testing normally has no equivalent, so suites drift into testing the same three buttons forever with no instrument to detect it. The AX tree is already captured for healing, and it *is* an inventory of every operable control — so the question becomes answerable.

`measureCoverage()` runs in `SmartRunner.close()`, before teardown, and compares interactive controls against the selectors steps resolved.

**The number is shown only where it can mean something** (`meaningfulCoverage`). The inventory is one capture, at close, of the page the run *ended* on — so on a multi-page journey the denominator is one page's controls while the numerator drew selectors from every page crossed. "1/72 (1%)" on a login → navigate → detail flow is not a low score, it is a category error, and printing it teaches people to ignore the instrument on the runs where it is real: single-page suites, the designed use. Measurement still happens and the bundle/history still carry it; the CLI line, the report's coverage card, the untouched-controls table and the trend delta are display-gated to runs whose resolved selectors all sat on one origin+path.

The load-bearing detail is **attribution honesty**. A step that resolved `role=button[name="Next"]` maps onto a tree node; `.pagination__next` does not, because a CSS selector carries no role or name. Those land in `unattributed` rather than being silently credited — coverage must understate, never overstate. There's a test asserting CSS selectors are refused.

Coverage failures are swallowed: it is diagnostic, and must never fail an otherwise good run.
