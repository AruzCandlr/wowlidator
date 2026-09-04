# Token & latency optimization spec — 2026-08-27

Three MUSTs, in the requester's words: **1. make the system faster, 2. make the
system cost less quota, 3. make the system scalable.** Every work item below is
tagged with which of the three it serves and carries an acceptance criterion a
person can check. Items are ordered by measured value, not by how clever they
sound.

The measurement infrastructure this spec relies on already exists as of today:
the `claude -p` ledger (`src/providers/claude-cli-usage-log.ts` — per-call
tokens, cache read/write, cost, wall time, across processes), the live quota
reader (`src/providers/claude-quota.ts` — session / weekly / per-model-type
percentages), and the editable args template
(`src/providers/claude-run-script.ts`). Nothing here needs new plumbing to be
verified.

## 0. What is already true — do not re-solve it

Grounded against the code and against live calls on 2026-08-27, because half of
the generic advice circulating about "Claude token burn" describes problems
this system does not have:

- **The healer already receives a small failure packet, not the world.** Its
  evidence is the AX tree capped at `DEFAULT_MAX_AX_NODES = 120` nodes
  (`src/healer/jit-healer.ts`) and its output budget is 1,024 tokens. There is
  no 650k-token healer input to rescue.
- **Warm-session growth is already bounded.** `MAX_TURNS_PER_SESSION = 10`
  (`src/providers/claude-cli-session.ts`) exists precisely because a session
  left to 40 turns was measured at 700k–1.7M cached input tokens with per-call
  wall time growing to 26–82 s. The "TTY context grows forever" failure mode
  was found and fixed before this spec.
- **Model routing per role already exists.** Each role picks its provider and
  model independently (`src/config.ts`), the panel edits it, and the serial
  gate already dedupes identical in-flight questions and prioritises the
  blocking roles.
- **`--bare` is NOT usable here.** Measured: `claude -p --bare` returns
  `is_error: true` at $0 — bare mode reads no OAuth and no keychain, and the
  entire point of the claude-* providers is billing the signed-in session
  without an API key. Strike it from every plan. The achievable subset of what
  `--bare` promises is exactly items 1a–1c below.

## 1. Slim the `claude -p` base context — the headline item [cheaper] [faster]

**Measured today, same prompt, same model (haiku), same system prompt:**

| launch | input weight per call | cost | API time |
|---|---|---|---|
| current default (no `--tools` flag) | 10 in + 15,820 cache-read + 3,345 cache-write ≈ **19,165 tok** | $0.0094 | 2.32 s |
| `--tools "" --max-turns 1` | **244 tok**, zero cache traffic | $0.0014 | 2.17 s |

The ~19k is Claude Code's built-in tool definitions and agent scaffolding,
paid (as cache traffic) on **every** call even though every wowlidator call
replaces the system prompt and never uses a tool. At ~20 calls per authored
case, this is ~380k tokens of pure scaffolding per case.

Work items:

- **1a.** Default `--tools ""` for every claude-cli call **when the role has
  no tools configured** — `WOWLIDATOR_<ROLE>_TOOLS` and the existing
  `tools`/`allowedTools` options keep working and win when set. Apply to both
  the one-shot vector and the warm session's launch args
  (`claude-cli-session.ts`), which carries the same scaffolding today.
- **1b.** Default `--max-turns 1` on the one-shot path. Every wowlidator call
  is one completion; a second agentic turn is only ever a failure mode.
- **1c.** New knob `WOWLIDATOR_CLAUDE_CLI_MAX_BUDGET_USD` → `--max-budget-usd`
  per call: a hard circuit breaker under the soft ones (breaker, re-ask
  budget) that already exist.

**Acceptance:** the ledger (`.wowlidator/claude-cli-usage.jsonl`) shows
healer/agent/data calls under ~1k input weight and author calls carrying only
their real prompt; per-case cost drops accordingly. `wowlidator doctor` still
passes on every role.

## 2. Cache-stable prompts [cheaper]

Claude Code caches repeated prefixes (the ledger's `cachedInputTokens` is the
proof either way). The rule that makes caching pay is byte-stability of the
front of the request. Two audits, no redesign:

- **2a.** In each role's prompt assembly (`prompt-discipline.ts`, the author
  prompt in `src/generator/`, catalog context in `src/catalog/`): stable
  blocks first (system rules, product/context docs, the spec), per-job delta
  last, and the stable blocks emitted in a deterministic order. Anything that
  interleaves a timestamp, a random id, or a re-ordered list into the prefix
  breaks the cache for every call after it.
- **2b.** Warm sessions already key on `(model, effort, system, schema)` — one
  session per role-shape. Add **batch affinity**: a catalog run's author calls
  share one session for the run and the session is closed at batch end
  (`closeClaudeSessions()` at the suite boundary), instead of whatever
  process-lifetime reuse happens to occur. The 10-turn recycle stays as the
  ceiling.

**Acceptance:** cache-read share (`cachedInputTokens / total input`) per role
visible from the ledger; for the author role on claude-cli it should be high
*because of the shared prefix*, not because of scaffolding (post-1a).

## 3. Tier routing with escalation — never start on the expensive model [cheaper] [faster]

The claude tiers map onto the roles the same way the free-tier providers
already do: the roles called every few seconds want the cheap fast tier, and
only authoring earns thinking.

- **3a.** Documented defaults for claude-backed roles: healer/data → `haiku` /
  low, agent → `sonnet` / low, author → `sonnet` / high. `fable`/`opus` are
  never a default.
- **3b.** **Escalation, not habit:** new `WOWLIDATOR_<ROLE>_ESCALATE_MODEL` —
  when `generateStructured` exhausts its re-ask budget
  (`RECOVERABLE_ATTEMPTS`) on the role's model, retry once on the named
  stronger model before the circuit breaker counts a cycle. Same shape as key
  failover, one tier up, logged the same way. Opus is where hard cases *end*,
  not where the pipeline *starts*.

**Acceptance:** a catalog run's ledger shows the expensive tier appearing only
after a cheaper-tier failure; SYSTEM-failure rate does not rise.

## 4. Quota-aware scheduling [cheaper] [scale]

The quota reader already returns session / weekly / per-model-type percentages
with severities. Spend it:

- **4a.** Pre-flight gate: before a catalog run starts (CLI and panel), print
  the quota line; refuse to start (overridable flag) when the session window
  is above `WOWLIDATOR_QUOTA_START_CEILING` (default ~90%). A 108-case run
  that dies at case 22 on an exhausted window wastes everything it spent.
- **4b.** Mid-run downshift: when a quota severity leaves `normal` during a
  run, roles with an escalation model configured stop escalating, and the run
  logs the downshift — finish cheap rather than die rich. (The resumable
  ledger already makes "stop cleanly, resume later" real; this leans on it.)
- **4c.** Per-run budget: `WOWLIDATOR_RUN_BUDGET_USD` — the run sums its own
  ledger delta and stops cleanly at the ceiling, resumable.

**Acceptance:** a run started at 95% session quota refuses with the reset time
in the message; a run crossing the budget stops with a resumable ledger and
says what was spent.

## 5. Scale-out by context behaviour [scale] [faster]

Each engine where its context behaviour pays, exactly one of each:

- **claude-cli one-shot** (fresh context, cache-stable prefix): author, and
  any batch-shaped work. One-shot processes are parallel-safe — author
  concurrency on claude-cli is *not* gated by `SERIAL_PROVIDERS`, so raising
  `--author-concurrency` there is free scale that the local/tty providers
  cannot offer.
- **claude-tty warm** (context accumulates, startup amortised): healer, agent,
  data — the every-few-seconds roles. Pool width is
  `WOWLIDATOR_CLAUDE_TTY_WORKERS`; scaling reads = more workers, each with the
  10-turn recycle.
- **claude-cloud** (context isolated off-machine): long autonomous agent legs,
  where the machine's own load matters and the leg's context should not share
  a local session. It is the slowest engine (session provisioning + replay) —
  route to it deliberately, never by default.

**Acceptance:** a catalog run with author on claude-cli at concurrency N shows
near-linear authoring throughput in the run log; healer latency stays flat
while authoring scales.

## 6. Attribution in the ledger [enables all of the above]

The ledger rows carry model and cost but not *who asked*. Add an optional
`task` field (role · case label, the same string `llm-log` already prints),
plumbed from `llm-factory` into the claude-cli provider. Without it, "which
role is spending the quota" is answered by eyeballing stderr; with it, the
panel's per-model table can also slice per role.

**Acceptance:** the Claude session card can show spend per role for today.

## Order of work and expected effect

| phase | items | faster | cheaper | scalable | effort |
|---|---|---|---|---|---|
| 1 | 1a–1c slim base context | ✓ (less to attend) | **✓✓✓ measured 6.7× per call** | — | small |
| 2 | 2a–2b cache stability | ✓ | ✓✓ | — | small–medium |
| 3 | 3a–3b tier escalation | ✓ | ✓✓ | — | medium |
| 4 | 4a–4c quota gates | — | ✓ (waste prevention) | ✓ (runs survive) | medium |
| 5 | engine routing | ✓ | ✓ | ✓✓ | medium |
| 6 | ledger attribution | — | — | ✓ (visibility) | small |

Phase 1 first, alone, and measure a full catalog run's ledger before and
after — it is the only item with a hard number already attached, and it sets
the baseline every later phase is judged against.

## Open questions

- **The "$100/month separate credit for `claude -p` on Max 5x" claim** (from
  the advice that prompted this spec) is not verified here. The OAuth usage
  endpoint this repo reads shows the account's live windows either way; check
  the support article against this account before planning around a separate
  pool, and treat the quota reader as ground truth.
- Whether `--max-turns` has the intended per-exchange meaning inside a warm
  stream-json session (vs. per process) needs one measurement before 1b is
  applied to the warm path; it is safe on the one-shot path today.
