# Context-Document Retrieval Spec (BM25)

The request this answers: *`--context-doc` sends a whole background document into every prompt that mentions it, and the catalog path sends it once per table row. Select the parts of it that bear on the case being written, instead of the parts that happen to come first.*

> **Status: implemented, and defaulted OFF after a live regression** (2026-08-18) — see *§Post-mortem* at the foot of this file before changing anything here. Original notes:
>
> **Implemented** — `src/catalog/retrieve.ts`, wired at the three prompt sites in `src/cli/commands/authoring.ts` (claims extraction, the claims-list flow, and `authorEachRow` per row), `--context-budget` / `WOWLIDATOR_CONTEXT_BUDGET`, and the raised extraction cap for context documents. Covered by `tests/context-retrieval.test.ts` and one `tests/cli.test.ts` case. Two things changed while building it, both folded into the text below: the per-document floor takes its best section **regardless of the budget** (§R3.2), and the fallback path never re-reads `doc.text`, because it is also the catch path and re-reading whatever just threw would rethrow it out of a function whose whole contract is that it cannot fail. Scope is deliberately narrow: this changes what reaches a prompt as *supporting context*, and nothing else. The catalog document, the AX tree, the repo graph and `draft`'s source material are all explicitly out of scope, each for a stated reason.

## The measurement this exists for

| Payload | Size today | Sent |
|---|---|---|
| Authoring system prompt (`flow-author.ts:347`) | ~3.7k tok | per authoring call |
| AX tree, `DEFAULT_AUTHOR_MAX_NODES` | ~2–5k tok | per authoring call |
| **`--context-doc` text** | **up to `DEFAULT_MAX_CHARS` = 120,000 chars (~30k tok) *each***, verbatim (`catalog.ts:141`, `catalog.ts:371`) | claims extraction **once**, authoring **once per row** |

`authorEachRow` opens the page once and authors each row separately — the guarantee that the count out equals the count in (`authoring.ts:400–412`). Every one of those calls rebuilds the prompt through `buildAuthoringPrompt`, whole context documents included (`authoring.ts:437`). A twelve-row sheet with one 120k-char spec spends **~360k input tokens on background alone**, and eleven-twelfths of it is background about rows this call is not writing.

Second, less obvious: extraction truncates **positionally** — `truncated to the first 120,000 of N characters` (`extract.ts:212`). For a spec longer than that, the last sections are unreachable by every consumer, silently, forever. Relevance selection reads the whole document and picks from all of it, so this is a **recall** change as much as a cost change.

## Verdict

| Question | Verdict | Why |
|---|---|---|
| Cut context tokens on the per-row authoring path | **CAN, large** | The query is strong (`describeCase(row)` — the row's steps and expectations) and the corpus is small. A char budget replaces an unbounded payload. |
| Improve what the model sees, not just what it costs | **CAN** | Positional truncation is replaced by relevance selection over the *whole* document, so a spec's last section becomes reachable for the first time. |
| Do it with no model call, no key, no dependency | **CAN** | Okapi BM25 and a heading-aware chunker are ~250 lines of arithmetic and string handling. Same call the hand-rolled `.xlsx`/`.pdf` readers made in `extract.ts`. |
| Apply it to the catalog document itself | **MUST NOT** | You cannot retrieve claims you do not yet know exist. A recall miss drops a requirement and the run still reports green — the exact failure `extract.ts`'s "never hand back text that is not in the document" rule exists to prevent. |
| Apply it to `draft`'s context documents | **MUST NOT** | `draft` labels them `--- SOURCE:` (`draft.ts:129`): they *are* the material the cases are enumerated from, so this is the same hazard under a different flag. Deferred to a map-reduce pass that visits every chunk exactly once. |
| Guarantee the model knows the background is partial | **CAN** | The spine (§R3) plus an elision notice, the `captureAxTree` truncation-notice precedent applied a third time. |
| Guess semantically — synonyms, paraphrase | **CANNOT, and does not try** | Lexical only. See *What this deliberately does not do*. |

## Evidence base

| Fact | Where |
|---|---|
| Context docs are labelled background, kept apart from the catalog | `buildClaimsPrompt`, `catalog.ts:124–147` |
| The same separation in the authoring prompt | `buildAuthoringPrompt`, `catalog.ts:353–371` |
| One authoring call per row, each with the full context | `authorEachRow`, `authoring.ts:400–437` |
| Positional truncation, and the note that discloses it | `DEFAULT_MAX_CHARS`, `extract.ts:95,197–216` |
| `extractDocumentFile(path, maxChars)` — the cap is already a parameter | `extract.ts:133` |
| Every context doc's `note` is already printed to stdout | `authoring.ts:328–330`, `authoring.ts:693–695` |
| Truncation-notice wording to mirror | `captureAxTree`, `jit-healer.ts:405–410` |
| Free-tier models degrade as prompts grow (nesting, schema echo) | CLAUDE.md, *Structured output on free tiers* |
| Determinism is a stated requirement of every model call | `temperature: 0`, `llm-factory.ts` |
| Flag-name hazard: `--context` ≠ `--context-doc` | CLAUDE.md, *Catalogs*; `cli.ts:160–168` |
| `draft` treats context as SOURCE, not background | `draft.ts:66,128–130` |

## R1 — The chunker (`src/catalog/retrieve.ts`)

One new module, beside `extract.ts`, because it operates on `ExtractedDocument` and on nothing else. No model call, no network call, no dependency — execution-plane, the `context-engine.ts` constitution.

```ts
export interface ContextChunk {
  doc: string;          // document name, for attribution
  headingPath: string;  // "Sessions > Timeout" — a chunk that cannot say where it is from is not evidence
  index: number;        // position in the document, for restoring order
  text: string;
}
export function chunkDocument(doc: ExtractedDocument): ContextChunk[];
```

Rules, each with a test:

- **A chunk never straddles a heading.** Markdown `#`, underlined headings, and numbered section lines (`3.2 Session timeout`) open a new chunk. A heading with a very long body is split further at blank lines; a paragraph longer than `CHUNK_MAX_CHARS` is split at **line** boundaries, never mid-line — the same rule that keeps a sparse spreadsheet row's column letters in `extract.ts`.
- **`headingPath` is carried, not inferred later.** A retrieved paragraph with no idea which section it came from invites exactly the misattribution `CatalogClaim.source` exists to prevent.
- **Row-shaped text keeps its header.** `csv`/`xlsx` extraction produces one row per line; chunks group rows and **repeat the header line in each chunk**, because a retrieved row without its column names means nothing.
- **Targets, not hard cuts**: `CHUNK_TARGET_CHARS = 1_200`, `CHUNK_MAX_CHARS = 2_400`.

## R2 — BM25 (same module)

Okapi BM25, `K1 = 1.5`, `B = 0.75`, over the chunks of **all** context documents as one corpus, so scores are comparable across documents while `doc` keeps attribution.

- **The Lucene-smoothed IDF**, `ln(1 + (N - n + 0.5)/(n + 0.5))`, not the textbook form. With one small document the textbook IDF goes **negative** for a term appearing in most chunks, so a chunk scores *worse* for containing a query term — which reads as a bug and behaves like one.
- **No stopword list.** IDF already discounts a term that appears in most chunks, and a hand-maintained English stopword list is one more thing to be wrong about on a bilingual corpus.
- **No stemming.** The claims prompt already instructs *"use the document's own words"* (`catalog.ts:117`), so query and corpus share vocabulary by construction; an English stemmer buys little and mangles the other half of a bilingual spec.
- **Tokenisation keeps identifiers whole *and* split.** `PB-05-01` emits `pb-05-01`, `pb`, `05`, `01` — a case id is the highest-signal token in these documents and must be findable both ways.
- **Scripts without word boundaries fall back to character n-grams** (`NGRAM_SIZE = 3`). Thai text is one unbroken run: a whitespace tokeniser makes a Thai section a single token and retrieval silently returns nothing for it. This codebase already has Thai in its failure history (PB-05-01, `scriptMismatchNote`), so it is a live case, not a hypothetical. A run of ≥ `NGRAM_MIN_RUN` characters with no separator is indexed as its n-grams instead; the test pins that a whitespace tokeniser fails the same fixture.

## R3 — Selection, the spine, and the notice

```ts
export interface ContextSelection {
  documents: ExtractedDocument[];  // synthetic: same name/format, selected text
  note: string;                    // one line, for the caller to print
  selected: number; total: number; chars: number;
}
export function selectRelevantContext(
  docs: readonly ExtractedDocument[],
  query: string,
  options?: { budgetChars?: number },
): ContextSelection;
```

**It returns `ExtractedDocument`s, and that is the whole integration.** `buildClaimsPrompt` and `buildAuthoringPrompt` are unchanged — they still receive a list of documents with `name`, `format`, `text`, `note` — and the CLI's existing `! name: note` printing (`authoring.ts:328,693`) discloses the selection for free, through a channel that already exists and is already read.

Selection order:

1. **Under `CONTEXT_RETRIEVAL_MIN_CHARS` (8,000), nothing happens.** The document is returned byte-for-byte. Retrieval that fires on a two-page glossary can only lose information for no gain, and the snapshot test proves the small-document path is unchanged.
2. **Per-document floor**: every document with at least one positive-scoring chunk contributes its best chunk before the global fill. Two documents the user passed are two things they thought mattered; a long one must not crowd out a short one. **That one chunk ignores the budget** — budget-respecting floors were the first cut and were wrong: a budget smaller than one section selected nothing at all and handed the prompt an outline with no content under it, which is worse than the whole document this replaces. The overrun is bounded by one section per document and disclosed in the note, the same trade the catch path makes.
3. **Greedy fill by score** to `budgetChars` (`CONTEXT_BUDGET_CHARS = 24_000`, ~6k tokens).
4. **Neighbour bleed**: with budget left, the chunk immediately after a selected chunk under the same heading is added (`CONTEXT_NEIGHBOUR_BLEED = 1`). Definitions run on past a paragraph break.
5. **A zero-scoring chunk is never included**, even with budget to spare. Padding the prompt with irrelevant background is the cost this feature exists to remove.
6. **Restore document order** before rendering. Order is meaning; a context section sorted by score reads as noise.
7. **A document nothing was left out of is returned unchanged** — no outline, no notice. Between `CONTEXT_RETRIEVAL_MIN_CHARS` and the budget the two would make the prompt *larger* than sending the document did, in exactly the range where this saves nothing. Found by measuring: a 15,112-character spec came back at 15,657.

Each rendered document is:

```
[Outline of spec.md — every section, so nothing below is mistaken for the whole document:]
  1. Overview
  2. Sessions
  2.1 Timeout
  …
[7 of 41 sections are included below, selected by relevance to this case.
 The sections not shown still exist — do NOT conclude the document is silent on anything.]

## 2.1 Timeout
…
```

**The spine — the complete heading outline — is always sent, whatever the budget.** It is small, it makes the elision visible rather than inferable, and it is the difference between a model that says "the spec may cover this elsewhere" and one that asserts absence. Capped at `MAX_SPINE_LINES = 120`, and the cap discloses itself. The elision notice is worded after `captureAxTree`'s, on purpose: *absence of evidence is not evidence of absence* is already this codebase's rule, and it should read like it.

**Determinism.** Ties break by document order, never by iteration order of a map. The same inputs must build the same prompt twice, for the reason `temperature: 0` exists.

**Containment, and it degrades the other way.** Any throw inside chunking or scoring returns the documents **unchanged**, plus a stderr note. History and coverage degrade to *nothing* because they are diagnostic; this one degrades to *everything*, because the safe direction here is more context, not less. Retrieval is an optimisation and must never be able to lose the feature.

## R4 — Extraction reads the whole document when retrieval will select from it

Context documents are extracted with `CONTEXT_DOC_MAX_CHARS` (1,000,000) instead of `DEFAULT_MAX_CHARS`, because the budget is now enforced by relevance downstream rather than by position upstream. `MAX_FILE_BYTES` is unchanged and still refuses an oversized file. With `--context-budget 0` (§R6) the old 120k cap applies again — an unbounded document sent whole is the one combination this must not produce.

The catalog document keeps `DEFAULT_MAX_CHARS` exactly as today. Nothing about the source of claims changes.

## R5 — The two wirings

**Claims extraction** (`cmdCatalog`, before `extractClaims`): query = the catalog document's own text, tokenised, deduplicated, capped at `MAX_QUERY_TERMS = 200`. One call, one selection, one printed note.

**Authoring** — the reason for the feature:

- `authorEachRow`: selection is recomputed **per row**, with query = `describeCase(row)` (the row's steps and expectations — the strongest query available anywhere in the system). Twelve rows now send twelve *different* 6k selections instead of twelve identical 30k documents. Disclosure is one summary line for the loop plus a `log?.` line per row, not twelve stdout notes.
- The claims-list path (`authoring.ts:946`): query = the approved claims joined.

Both call `selectRelevantContext` at the call site and pass the result into the existing `context:` field. **No prompt builder changes.** `catalog.ts`'s two SUPPORTING CONTEXT sections keep their exact wording and their exact separation — this feature changes what is in a document, never where a document goes.

## R6 — One flag, and it is a number

`--context-budget <chars>` (`WOWLIDATOR_CONTEXT_BUDGET`), default `CONTEXT_BUDGET_CHARS`, **`0` meaning no budget — send everything, exactly as today**.

A boolean `--full-context` / `--no-context-retrieval` is deliberately not added: `--context` (the repo index) and `--context-doc` (background documents) are already one flag apart from doing each other's job, and a third context-shaped noun is how that hazard gets worse. A number needs no third noun, and `0` says "off" without inventing one.

wowUI needs no change to work — the panel inherits the default. One `commands.ts` entry adds the control when someone wants it, per the panel's one-declaration rule.

## R7 — Tests (`tests/context-retrieval.test.ts`)

Unit tier throughout — chunk-and-score is arithmetic over strings, the `context-engine.test.ts` reasoning.

- **Chunking**: heading path attached; a chunk never straddles a heading; an oversize paragraph splits at line boundaries; a CSV chunk repeats its header row.
- **BM25**: a known ranking over a tiny corpus; a rare term outranks a common one; smoothed IDF never goes negative on a single-document corpus (the test states why); an empty query selects nothing rather than everything.
- **Scriptless text**: a Thai query term retrieves its chunk via n-grams, *and* a companion assertion that whitespace tokenisation fails the same fixture — the failure is pinned, not just the fix.
- **Identifiers**: `PB-05-01` is retrievable whole and by part.
- **Selection**: never exceeds the budget; per-document floor holds; zero-score chunks are never padded in; output is in document order; neighbour bleed adds the following sibling only.
- **The spine**: always present; the elision notice appears only when something was dropped; the spine cap discloses itself.
- **Under the threshold**: a small document comes through byte-for-byte (snapshot both ways, the `projectGraph` contract precedent).
- **The hard boundary**: `buildClaimsPrompt` still contains the catalog document in full, and `draft`'s prompt is untouched — a test per boundary, because both are silent-failure shaped.
- **Containment**: a throwing chunker returns the documents whole, writes one stderr line, and the prompt still contains the document.
- **Determinism**: identical inputs build an identical prompt string, twice.

## Implementation order

1. `src/catalog/retrieve.ts` — chunker, tokeniser, BM25, selection, rendering. Tests as above, all green before anything is wired.
2. `authorEachRow` — the per-row wiring, the measured win. Report the before/after token counts in the commit message.
3. Claims extraction wiring.
4. `--context-budget` + env, `usage.ts`, and the extraction-cap change in R4.
5. CLAUDE.md: a paragraph under *Catalogs*, and this file's status banner.

## What this deliberately does not do

- **No embeddings, no vector index, no model call.** The query is the document's own vocabulary; the corpus is a handful of files. Semantic retrieval would need an embedding model — a fifth role and a key, or a ~100MB local blob — for a gain lexical matching already gets here, and would make an indexing step *reason*, which is the line `src/context/` is built on.
- **No retrieval over the catalog, over `draft`'s sources, or over the AX tree.** The first two are enumeration problems (you cannot retrieve what you do not know to look for); the third has its own budget, its own truncation notice, and a different query shape.
- **No persistence.** Chunking a document that is already in memory is microseconds; a cache would be a staleness bug in exchange for nothing.
- **No cross-call learning.** Which chunks a previous row selected does not influence the next. Per-row independence is the same guarantee `authorEachRow` already makes for the rows themselves.
- **No summarisation of what was dropped.** A summary of elided sections is a model claim about a document, sitting in a prompt where it will be read as the document. The spine is the honest version: the document's own headings, verbatim.


## Post-mortem: why this is opt-in

Shipped on by default. The next catalog run was slower and less accurate, and three defects were behind it — one of them severe. All three were invisible to the first round of tests because those tests asserted the *behaviour I designed* rather than the *invariant the feature must not break*.

**1. The chunker deleted content (severe).** `headingOf` also read a numbered line as a section heading, guarded on length ≤ 80 and no trailing full stop. An ordinary procedure step — `1. Open the probation hub` — satisfies that guard exactly. A heading's line is carried as `headingPath` and never emitted as body, so every step of every numbered list ceased to exist:

```
## Steps
1. Open the probation hub      →  chunks: 0
2. Select the employee row        "Open the probation hub" survives: false
3. Click Start review
```

A six-step checklist chunked to **nothing at all**, and what reached the authoring model was an outline of the steps with no steps under it. Every case authored from a procedural context document was written blind. The guard was worthless and the heuristic is gone: Markdown `#` only. The test that let it through checked a fixture whose steps ended in full stops — it passed for the wrong reason. It is replaced by the invariant: **no line of a document is lost by chunking**, over five document shapes. That is `extract.ts`'s "never hand back text that is not in the document" rule pointed the other way.

**2. Selection fired where it could only lose.** Any document over `CONTEXT_RETRIEVAL_MIN_CHARS` was selected over, including ones comfortably under the budget — where the spine and the notice make the prompt *larger* and the model reads quoted fragments instead of the author's prose. A 15,112-character spec came back at 15,657. Selection now engages only on a document **bigger than the budget**, where the alternative is not sending it whole anyway.

**3. Ranking without discrimination is positional truncation with a badge on it.** On a spec whose sections share their vocabulary every chunk scored 0.06, the tie broke on document order, and the "selected" sections were 1–7 — the head of the document, presented as relevance. `DISCRIMINATION_MIN` (best ÷ mean ≥ 1.5) now declines to select at all in that case and says so; `RELATIVE_SCORE_FLOOR` (0.35 × best) stops the budget being padded with whatever ranked next, which is how one row's prompt carried nine sections about other rows.

**What was not the cause.** Ranking cost: 60 chunks over a 196,000-character document chunk and rank in **9ms**, and a Thai corpus with n-gram expansion in 8ms — a twelve-row sheet spends a tenth of a second. Swapping BM25 for something faster would buy nothing measurable; the slowdown was downstream, in the runs that failed because the authoring prompt was missing its steps and then paid the ladder, the healer and step reconstruction for it.

**Fixed, and measured again** — 60,477-character spec, four authored rows:

| | background sent | what each row quoted |
|---|---|---|
| before this feature | 4 × 15,119 tok | the whole spec, every row |
| first cut | 4 × ~6,100 tok | 11 sections, mostly other rows' |
| now, opted in | **4 × 881 tok** | exactly its own section (OT-04 correctly took two) |

**And it is off by default anyway.** The measured win is narrow — a long document times many rows — and the thing it decides is what every authoring prompt sees. `--probe`, `--agent-assist`, `--follow-buttons` and `--repair` are all opt-in for that reason; the capture pilot is on by default on the mirror-image argument, that an inaccurate capture poisons every test written from it. This is the same sentence, so it gets the opposite default. `--context-budget 24000` turns it on.
