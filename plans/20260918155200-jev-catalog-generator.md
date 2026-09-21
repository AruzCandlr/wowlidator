# The catalog generator for the Jev engine

Planned 2026-09-18 in a Lavish review (`.lavish/jev-catalog-generator-plan.html`
holds the full artifact: the pipeline figure, the column-by-column mapping, the
fixture row end to end, the risks). Decisions taken there, all four the
recommended ones:

- **A — inside `FlowAuthor`.** `src/generator/jev-catalog-author.ts` is a
  second `FlowAuthorModel` — programmatic — that answers first; the LLM author
  is its fallback for the Expected lines it cannot read; every lint, the
  reviewer, the risk judge, value resolution, rounds and unique keys still
  run on what it writes. One lint, `workflowOverDeclaredControls`, is withheld
  under `FlowAuthorOptions.indexed`.
- **Unread Expected lines → the LLM author, for those lines only**, with the
  programmatic steps stated as already written; only the assertion steps of
  its answer are kept. A row whose every line is readable costs no model call.
- **Selection is automatic** when the agent role is a decision model
  (`authorModeOf`, `src/cli/runtime.ts`), `--author-mode jev|llm` overriding;
  the panel's catalog form carries the same field; the ledger's `launch`
  records `authorMode`.
- **One `workflow` leg per numbered sheet step**, annotated `(test step N)`,
  carrying the Test data pairs whose field the step names, resolved through
  the $0 value sources (relative dates, blank words, unique-per-run keys,
  written values) before the goal is written — in the exact grammar
  `goalOutcomes` parses, pinned by a round-trip test per fixture row.

## Status (2026-09-18)

- Phases 1–3 built: the planner (`planCatalogCase`, `attachPairs`,
  `legsRoundTrip`), the model (`JevCatalogAuthorModel`), the request fields
  (`AuthorRequest.caseText/caseId/runKey/now/testDataPairs`), the indexed lint
  mode, `--author-mode`, the panel field, the ledger field.
  `tests/jev-catalog-author.test.ts` (10) green; `tests/flow-author.test.ts` +
  `tests/author-wave2.test.ts` (369) unchanged.
- Phase 4: measured — `docs/research/2026-09-18-jev-spike/README.md`, "The catalog generator". Coverage on 40 EC rows: 144 legs, 0 round-trip misses, 2 of 368 Expected lines readable at $0. Authoring tokens on the fixture are not lower in jev mode (the fallback ask still pays the full authoring system prompt + repository slice + risk judge); follow-up: an assertions-only author with a small system prompt. Real run 1 on HUMI SIT ended at `signIn` (no `url`) and surfaced the agent-role borrowers; both fixed, run 2 in progress.
