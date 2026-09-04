# CLAUDE.md — crawling

Split out of the root CLAUDE.md (2026-08-24) so this loads only when working under
`src/crawl/`. Same authority as the root file; the root keeps the map of the whole system.

## Crawling (`src/crawl/crawler.ts`)

A flow proves one journey. It says nothing about the other eleven cards on the same hub, and writing eleven near-identical flows is how a suite becomes unmaintainable. `wowlidator crawl <url>` asks a cheaper question of the whole page: **follow each control, does a real page come back, can we get home again.** It produces an ordinary proof bundle, so the report, JUnit, history and index all work unchanged — a crawl is a test, not a side tool.

**Links by default; buttons only on request.** A link is a GET; a button is anything, and "Approve"/"Delete"/"Submit" are buttons. `--follow-buttons` exists because plenty of applications route from rows and cards, where a link-only crawl is perfectly honest and completely useless — it reports "0 links" about a page full of destinations. Even then a short label that reads like an action (`looksLikeAction`) is never clicked. The residual risk is real and cannot be designed away, which is exactly why it is opt-in.

**Returning is half the test.** After each visit the crawler goes back and checks it landed where it started. A page you can enter but not leave is a real defect — and invisible to any test that navigates by URL instead of clicking.

Four things learned by running it against a real application, each now load-bearing:

- **Wait for the click's navigation on the full budget** (`DEFAULT_TIMEOUT_MS`, 30s), not a fixed settle. A heavy route measured early reports the *origin* page as the destination and then blames history for "not returning" to a page it never left.
- **A control that resolves but does not navigate is not a broken destination.** For a link that is a defect; for a button it is the ordinary case — a theme toggle, a filter, a sort — so it leaves the visited set and is reported as skipped. Otherwise the report fills with failures about controls that were never destinations.
- **Absence is not a healing problem, here.** In a flow, a selector that no longer resolves means the test drifted and a repair is right. In a crawl the selector came from the tree minutes ago, so absence means the page changed underneath us. Found the expensive way: one visit to a language switcher renamed every control, and seventeen candidates were dutifully sent to the healer. Presence is checked first; healing is for a control that *exists* and cannot be clicked.
- **Re-read the page after every visit.** One accessibility capture, no tokens, and it is the difference between surviving a control with global effects and reporting a page of phantoms. `maxPages` bounds destinations *reached*, with a separate attempt ceiling — a header of eight buttons would otherwise spend the whole budget discovering that a theme toggle is not a destination.

**The healer is load-bearing here in a way it is not elsewhere.** A crawl writes its own selectors from accessible names, so when one cannot be clicked the author has nothing to fix. `--max-heal` (default 5) bounds the repairs per control, every attempt is recorded whether it worked or not, and a successful one lands on the step as an ordinary `HealRecord` — so the badge, the callout and the token cost show up in the report exactly as they do for a flow. A link reached only by navigating to its href is recorded as `via: 'url'` and counted separately: the route exists, the control does not work, and blurring those would let a hub full of broken cards report a clean sweep.
