# Repository Context Memory Spec

The request this answers: *point wowlidator at a repository once, have it scan and remember that repository, and have every later testing command against that application retrieve the context automatically — so generation, catalog authoring, healing and repair understand the website they are testing without being re-told where its code lives.*

> **Status: partially implemented** (2026-08-17) — the registry landed with a scope change the user chose after this spec was written: selection is **explicit, not origin-automatic**. `context add <path>` / `context list` and `src/context/repo-registry.ts` are R1 (minus `remove`); a run selects a repo with `--repo <slug|path>` (unknown → loud exit 2), or wowUI's dropdown — the panel's Machinery › Repositories view saves and re-scans through the whitelisted `context-add`, and `/api/repos` lists. Consumers wired: **generation, catalog authoring, and `author`** (`AuthorRequest.projectContext`, its own labelled prompt section; the selected repo's graph also supplies the DB table inventory). **Update (2026-08-18):** the projection is no longer anchored to the starting URL alone — `toPromptContext` also seeds from the routes the *description* names (`routesForDescription`), because the describe path starts on one page and is about another and the url-only walk gave it two lines about a login screen. Still open: R2/R3 origin learning and auto-retrieval (the dropdown made them optional rather than necessary), R6 healer/repair consumption, and `context remove`. Covered by `tests/repo-registry.test.ts`, `tests/flow-author.test.ts`, and `tests/wow-ui.test.ts` (which also pins the checks table's backend-step label mirror against `BACKEND_TIER_ACTIONS`).

## What exists, and the three gaps

The context engine (`src/context/`) already scans a repository deterministically — six ingesters, no model call, cached on a composite size+mtime signature (`computeSignature`, `context-engine.ts:75`). What it cannot do is *remember*:

1. **One cache file, last writer wins.** `DEFAULT_CONTEXT_CACHE_FILE = '.wowlidator/context-graph.json'` (`context-engine.ts:35`) is a single cwd-relative path. Indexing a second repository overwrites the first. There is no registry of repositories, so there is nothing to retrieve *from*.
2. **Retrieval is manual and reaches one consumer.** Only `generate --context` / `generate --api` build and pass a graph (`src/cli/commands/authoring.ts:106–122`). The catalog authoring path — `FlowAuthor`, the surface catalogs actually run through — receives the DB table inventory (`AuthorRequest.tables`, `flow-author.ts:212–218`) but no routes, components, endpoints, or existing-test coverage. The healer and `--repair` see nothing.
3. **No URL→repository association.** A run against `http://localhost:3200` retrieves nothing, even when an indexed repo declares exactly those routes. The manifest ingester does not read dev-server ports today; nothing anywhere maps an origin to a repo.

## Verdict

| Question | Verdict | Technique |
|---|---|---|
| Scan a repo from a path and remember it | **CAN** | `context add <path>`: existing `ContextEngine` with `cacheFile` pointed at a per-repo file, plus a registry entry. Deterministic, no model call, $0. |
| Retrieve the right repo's context from a URL alone | **CAN, when unambiguous** | Origin match first, route-pattern match second (reusing the route matching `linkCoverage` already trusts). Exactly one match loads; zero or several load nothing and name the `--repo` fix. Understate, never overstate. |
| Keep the memory fresh | **CAN** | Signature recheck at retrieval; mismatch rebuilds transparently. The signature walk is the cheap thing the cache was designed around. |
| Let context *improve* healing without letting it *invent* repairs | **CAN, bounded** | The healer receives a hard-capped advisory slice; every candidate still passes the existing exactly-one-element verify. The graph can suggest; only the page can confirm. |
| Understand the website beyond what the repo declares | **CANNOT** | The graph knows what the code says, not what the deployed page does. The AX tree stays the primary evidence everywhere; graph context is always the labelled second source, never a substitute. |

## Evidence base

| Fact | Where |
|---|---|
| Single cache path; signature short-circuit; `loadCached` returns null on unreadable | `context-engine.ts:35,75,270–296` |
| `rootDir` is already an option — external repos index today | `ContextEngineOptions`, `context-engine.ts:218`; CLI `options.root`, `options.ts:130` |
| The route-centred, node-capped prompt projection to reuse | `toPromptContext`, `query.ts:49`; `DEFAULT_CONTEXT_MAX_NODES = 40`, `query.ts:13` |
| Generate's existing wiring — the additive pattern to copy | `authoring.ts:106–122`; `TestGeneratorOptions.projectGraph` |
| Authoring's inventory-as-permission precedent (tables) | `AuthorRequest.tables`, `flow-author.ts:212–218`; `toFlowStep` drops DB steps with no schema |
| Healer request shape; `rejected` seam; verify gate | `HealRequest`, `jit-healer.ts:78–107`; `#verify` exactly-one-element rule |
| Repair request shape; `investigation` as a labelled section — the pattern for a second labelled section | `RepairRequest`, `flow-repair-model.ts:64–88,151` |
| Route matching lifted once already so two features share one rule | `matchesCall`, `src/context/route-match.ts` |
| Crash containment: ingester failures land on `graph.sources`, never throw | `context-engine.ts` merge; history/coverage diagnostic rule |
| Flag-name hazard: `--context` (repo index) vs `--context-doc` (background documents) are different things | CLAUDE.md, Catalogs; `options.ts` |

## R1 — The registry (`src/context/repo-registry.ts`)

`.wowlidator/context/repos.json`, plus one graph per repo at `.wowlidator/context/<slug>.graph.json`. The slug is `basename(path)` + a short hash of the resolved absolute path — human-readable, collision-proof, and stable across sessions.

```jsonc
{
  "version": 1,
  "repos": [
    {
      "slug": "cnext-hrms-fortest-3f9a",
      "path": "/Users/…/GitHub/cnext-hrms-fortest",
      "origins": [
        { "origin": "http://localhost:3200", "source": "declared" },   // --origin flag
        { "origin": "http://localhost:3000", "source": "learned" }     // dev-script port
      ],
      "indexedAt": "2026-08-17T…",
      "signature": "…",
      "nodes": 214
    }
  ]
}
```

Commands, all under the existing `context` family:

- `wowlidator context add <path> [--origin <url>] [--openapi <spec>] [--db-schema <file>]` — build (through `ContextEngine` with `cacheFile` set per-repo) + register. Re-adding an existing path re-indexes and updates the entry; it is how "re-scan" is spelled.
- `wowlidator context list` — slug, path, origins, node count, and staleness (signature checked live, since the answer is cheap and the alternative is a table that lies).
- `wowlidator context remove <path|slug>` — deletes the entry *and its graph file*, nothing else. Narrow by the same reasoning as upload deletion in the panel.
- `context build`/`show` keep their exact current behaviour on the single default cache file — additive, nothing existing moves.

Registry writes are temp-file + rename; a corrupt registry is reported to stderr and treated as empty, the cache-file rule verbatim.

## R2 — Learned origins

Three sources, ranked, each labelled in the entry so `context list` can say which is which:

1. **Declared** — `--origin` on `context add`. Always wins.
2. **Learned from the manifest** — the manifest ingester grows one narrow skill: extract ports from `package.json` scripts (`--port N`, `-p N`, `PORT=N`) and framework config it already walks past (`next.config.*` is read for existence today). Every learned origin is `http://localhost:<port>`. A script with no visible port learns nothing — never guess a default port; a wrong association silently attaches the wrong codebase to a run, which is the one failure mode this feature must not have.
3. **Confirmed by use** — when a run was matched by route pattern (R3's second rung) rather than by origin, the origin that matched is appended as `{ source: "confirmed" }`, so the next run takes the cheap first rung. Written on successful retrieval only.

## R3 — Retrieval (`resolveRepoContext(url, options)`)

One function, called by every consumer, in strict order:

1. **`--repo <path|slug>`** — explicit, always wins, errors loudly if unknown. The override the disclosure lines name.
2. **Origin match** — URL origin equals a registered origin. One repo → hit.
3. **Route-pattern match** — URL pathname matched against each repo's `route` nodes via the existing route matcher. One repo whose routes match → hit.
4. **Zero or ambiguous** → no context, plus one stderr line: `context: no registered repo matches http://…` or `context: 2 repos match (a, b) — pass --repo to choose`. A guess between two repos would be worse than none, for the reason R2 names.

On a hit: recheck the signature; on mismatch rebuild through `ContextEngine` (disclosed: `context: cnext-hrms-fortest re-indexed, 214 → 219 nodes`); if the path no longer exists, skip with a note naming `context remove`. Every hit prints one line: `context: cnext-hrms-fortest-3f9a (214 nodes)`.

**Retrieval is diagnostic-grade infrastructure**: any failure inside it — unreadable registry, crashed rebuild — degrades to "no context" with a stderr note and must never change a run's verdict or exit code. Same constitution as history and coverage.

## R4 — Catalog authoring consumes the graph

`AuthorRequest.projectContext?: string` — a labelled section built by `toPromptContext` walked outward from the target URL, capped at `DEFAULT_CONTEXT_MAX_NODES`. It sits **apart from** the catalog claims, the context documents, and the table inventory, with its own heading in `buildUserPrompt` — the probe-report separation rule, applied a fourth time: what the repository declares is a different claim from what the document asserts or the page shows.

What it buys the authoring prompt, concretely: the routes the app declares (grounding for `expectUrl` — a third source alongside the tree's `url=` attributes and the flow's own `goto`s, feeding `ungroundedUrlExpectation`'s existing check, which should accept a route the graph declares), the API operations behind the page (grounding for `expectCalls` templates), and which flows already cover neighbouring routes (steering a catalog away from re-testing what is proven). Absent, authoring is byte-for-byte today's — the `projectGraph` contract, kept.

## R5 — Generation retrieves without being asked

`generate` (and `go`'s generate arm) call `resolveRepoContext` when `--context` was not given: a registry hit auto-loads exactly what `--context` would have built, disclosed by the R3 line. `--context` keeps its meaning (build from cwd/`--root` explicitly); a new `--no-context` declines both. Precedence: `--no-context` > `--context`/`--root` > registry. The flag-name collision hazard is already documented — nothing here touches `--context-doc`.

## R6 — Healer and repair, at two different sizes

Confirmed in scope, and the cost asymmetry decides the design:

**`--repair` gets the full section.** `RepairRequest.projectContext?: string` — same `toPromptContext` walk from the failed step's URL, carried as its own labelled section beside `investigation` (`flow-repair-model.ts:151` is the pattern). Repair is already the biggest prompt in the system, runs once per attempt, and its job — rebuild a step against a page — is exactly where "the app declares these routes and operations" prevents an invented URL or endpoint. The prompt says what the section is: *what the repository declares, which may lag what the page does*.

**The JIT healer gets a slice, hard-capped.** `HealRequest.repoHints?: readonly string[]` — at most `HEAL_REPO_HINTS_MAX` (10) lines: the matched route's declared title/components and its outgoing route links, nothing else. The healer runs per failed selector, its prompt is deliberately small, and the AX tree it already carries outranks any static claim about the page — so the slice is advisory framing ("this page is the app's `/admin/benefits/plans` route; it links to `/admin/benefits/claims`"), never candidate material. Two guards make it safe: the prompt states the hints describe the *codebase*, not the current page; and every candidate still passes `#verify`'s exactly-one-element resolution against the live page — the graph can suggest, only the page confirms. If the budget is tight, the hints are the first thing dropped, disclosed in the request builder rather than silently.

Neither consumer *fetches*: both receive what the runner resolved once at connect time (`SmartRunner` resolves per-run against the first `goto`'s URL and threads the graph down) — one signature check per run, not per heal.

## R7 — Staleness, honestly

- Signature mismatch at retrieval → rebuild, disclose, update the entry. The rebuild is the same walk the signature check already did most of.
- Rebuild failure (repo half-deleted, parse crash) → **stale graph with a dated warning** (`context: using index from 2026-08-10 — re-scan failed: …`), because for prompts, last week's routes beat nothing, and the warning keeps it honest. The registry entry is flagged so `context list` shows it red.
- Path gone entirely → skip with a note naming `context remove`. Never an error that fails a run.

## R8 — Deferred: the wowUI surface

Disclosed, not designed here: the launch modal's Add Context gains a repository-path field (→ `context add` through the command whitelist — one `commands.ts` entry, per the panel's one-declaration rule), and a registered-repos card with node counts, staleness, re-scan and remove. Every server-side piece it needs (R1's commands) ships in this spec, so the panel work is UI only.

## Tests (`tests/repo-context.test.ts`)

Unit tier throughout — registry and matching are file-walk-and-parse, the `context-engine.test.ts` reasoning:

- Registry CRUD; slug stability; re-add re-indexes in place; corrupt registry reads as empty with a stderr note.
- Origin learning: port extraction from the script shapes above; a portless script learns nothing (the never-guess rule has its own test).
- Retrieval: explicit `--repo` beats origin beats route; ambiguity returns none and names both slugs; zero matches returns none; a route-pattern hit writes a `confirmed` origin.
- Staleness: mismatch rebuilds; rebuild failure returns the stale graph with the dated warning; missing path skips.
- Prompt assembly: `projectContext` is a separate labelled section in authoring and repair prompts; absent means byte-for-byte unchanged prompts (snapshot both ways).
- Healer slice: never exceeds `HEAL_REPO_HINTS_MAX`; contains no selector syntax; dropped-first under budget, with the drop disclosed.
- Containment: a throwing registry/rebuild changes no verdict and no exit code.

## What this deliberately does not do

- **No model call anywhere in scan, registry, or retrieval** — indexing is not reasoning; this is execution-plane memory.
- **No content beyond what the ingesters read today** (plus R2's ports). Reading route *bodies*, component *implementations*, or business copy into prompts is a different, bigger decision about token budgets and secrets, and it is not smuggled in behind "memory".
- **No cross-repo merging.** One run, one repo's context. Two apps under one test suite pick per-run via `--repo`.
- **No persistence of anything derived from a live page into the registry** except R2's confirmed origins. The graph stays a claim about code; the proof bundle stays the claim about the page.
