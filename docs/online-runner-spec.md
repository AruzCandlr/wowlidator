# Online runner — progress from anywhere, at $0

*2026-08-31. Status: SPEC (nothing implemented; a Phase-1 prototype of the
access gate was drafted and reverted pending this plan's approval). Goal as
stated: upscale the project so it can report progress and run online, while
still accessing the claude CLI — keeping everything free, costless,
sustainable and scalable.*

## 1. The constraint that shapes everything

**The claude CLI credential cannot leave the operator's machine.** claude-cli
runs on the signed-in session's OAuth token, stored by Claude Code on this
machine; copying it to a cloud host is both against its terms and a security
hole. Chrome-over-CDP and the app under test (localhost:3000) are equally
local. Therefore:

> The RUNNER stays where the credential, the browser and the app live.
> "Online" means the *visibility and control* travel — never the secrets.

Every architecture below follows from that, and every component is a free
tier with no expiry (not a trial).

## 2. Architecture — three layers, all $0

```
[phone / laptop anywhere]
      │  https (token-gated)
      ▼
[free tunnel]  Tailscale (personal, 100 devices) or Cloudflare Tunnel (free)
      │
      ▼
[this machine] wowlidator ui  ── spawns ──►  suite runs (claude-cli, Chrome, Gemini)
      │                                            │
      └── push, per event ──►  ntfy.sh topic (free push to phone)
                               + reports/*.html (already self-contained)
```

### 2.1 Reach the existing panel (pull)

The panel already has everything a remote viewer needs (live SSE job output,
proofs, catalog banners, Machinery). What is missing is safe exposure:

- **`--listen <host>`** — bind beyond loopback (default stays 127.0.0.1,
  byte-for-byte unchanged).
- **Token gate** (`WOWLIDATOR_UI_TOKEN`, auto-generated and printed once when
  listening non-loopback): every request must carry it — `Authorization:
  Bearer`, `?token=` (the share-link form; also what EventSource can send),
  or the HttpOnly cookie the first authenticated page-load sets, so the
  in-page `fetch()`/`EventSource` calls need zero client changes. The Host
  check is waived only in remote mode — the token is the stronger gate, and
  a tunnel hostname cannot be allowlisted in advance.
- **`--read-only`** (`WOWLIDATOR_UI_READ_ONLY=on`): every non-GET answers
  403; watching, SSE and report viewing stay. The mode a share-link should
  default to — a leaked viewer token must not be a run-starter.
- **`GET /api/progress`** — one small JSON for anything that polls: per
  catalog run key {tally, left, running lanes, updatedAt}, active jobs,
  quota/cap snapshot. This is the machine-readable face of the ledger, which
  is already the durable record.

**Tunnel choice (both free, no port-forward, no fixed IP):**
- *Tailscale* (recommended): the panel is reachable only inside your own
  tailnet — the token becomes defence-in-depth rather than the only wall.
  MagicDNS gives `http://runner:4600` on your phone.
- *Cloudflare Tunnel*: a public HTTPS hostname when you need to share with
  someone outside the tailnet; the token is then the only wall — pair it
  with `--read-only`.

### 2.2 Progress that comes to you (push)

Polling a tunnel is fine at a desk; on a phone you want push. **ntfy.sh** is
free, accountless, and one HTTP POST:

- New module `src/history/progress-push.ts`: `pushProgress(event)` POSTs a
  one-line summary to `WOWLIDATOR_NTFY_TOPIC` (or any webhook URL —
  `WOWLIDATOR_PROGRESS_WEBHOOK`, which covers Discord/Slack free webhooks
  with the same code).
- Hooked where the ledger is already written (`noteOutcome` / suite end /
  usage-cap trip / pause): *suite started · case verdicts in batches of N ·
  suite ended with tally · CAP TRIPPED*. Batched (default every 10 cases or
  5 min) so a 236-row catalog is ~30 notifications, not 236.
- Never fatal, never blocking: fire-and-forget with a 3s timeout; a dead
  webhook is one stderr line. Off unless a topic is set — pushing progress
  to a third party is a decision, not a default (the same reasoning as the
  usage cap).
- Privacy rule: the push carries COUNTS and case IDs only — never
  screenshots, selectors, app text or credentials. ntfy topics are public
  namespaces; the content must be safe for one.

### 2.3 The artifacts already travel

`reports/<runKey>.html` (the catalog report) and the emailable per-case
reports are self-contained files. For a standing shareable URL at $0:
**GitHub Pages on a private repo's public Pages site or a free static host**
— a post-run step `git add reports/ && git push` in the operator's artifacts
repo publishes every report. Optional, manual-first (an explicit publish
script, `bin/publish-reports.sh`), because pushing test evidence anywhere
public is again a decision. No server, no cost, survives forever.

## 3. Scaling — N machines, still $0

Free quotas are per-account/per-machine, so the scale axis is *more runners*,
not bigger ones:

- Each runner = a machine with its own signed-in Claude session (its own
  5-hour window) + its own free Gemini key + its own Chrome. The claude CLI
  feature is preserved *per machine* — never shared, never proxied.
- **Sharding is already in the data model**: a catalog run key names its
  ledger; `--resume-from` / scenario filters split a catalog by scenario
  across runners (`runner A: PL_02..PL_06`, `runner B: PL_07..PL_12`), each
  writing its own ledger and its own catalog report.
- **Phase-3 merge tool** (`wowlidator merge-ledgers a.progress.json
  b.progress.json`): union of outcomes (they are disjoint by construction —
  disjoint planned slices), one merged catalog report. Pure function over
  two JSON files; no coordination service, no server, nothing to host.
- Coordination stays human-scale on purpose: two ledgers and a merge beat a
  free-tier message queue that becomes a paid one the day it works.

## 4. Sustainability rules (what keeps it $0 forever)

1. **No component that bills by usage.** Tailscale personal, Cloudflare
   Tunnel, ntfy.sh, GitHub Pages — all free tiers with no metering that our
   volume approaches.
2. **Model spend already governed**: Gemini free tier under the rate pacer
   (RPM/TPM/RPD table), Claude session under the (session-only) usage cap —
   a quota-out pauses with a resumable ledger, and the push layer announces
   it to your phone instead of failing silently overnight (the 05:26 lesson).
3. **The ledger stays the source of truth.** Every remote surface (progress
   API, push, published reports) is a *projection* of files already written —
   nothing new to keep consistent, nothing that can drift.
4. **Secrets never transit**: the token gates the panel; pushes carry counts;
   published reports already mask passwords; the OAuth credential never
   leaves disk.

## 5. Risks and covers

| Risk | Cover |
|---|---|
| Token leaks via a shared link | `--read-only` default for share links; rotate = restart with a new token; Tailscale keeps it intra-tailnet |
| Tunnel provider outage | pull layer degrades to LAN; push layer (ntfy) is an independent path; the run itself never depends on either |
| ntfy topic is guessable | random topic name (it is effectively the token); counts-only content so a guess reads a scoreboard, not evidence |
| Runner machine sleeps on battery | push "no progress in 30 min" heartbeat option; `caffeinate` note in docs (the Aug-31 overnight lesson) |
| Two runners collide on one section | shard by scenario (disjoint by construction); the section scheduler already protects within a runner |
| Free tier terms change | every layer is swappable (tunnel ↔ tunnel, ntfy ↔ any webhook) because each is one small module behind an env var |

## 6. Phases

1. **P1 — hardened remote panel** (the reverted prototype, finished):
   `--listen`, token gate (`accessDecision`, pure + tested), `--read-only`,
   `/api/progress`; tunnel setup notes in the README. ~1 session of work.
2. **P2 — progress push**: `progress-push.ts` + ntfy/webhook env + batching +
   cap/pause alerts. Small, pure-testable.
3. **P3 — multi-runner sharding**: scenario-slice flags documented +
   `merge-ledgers` + merged catalog report.
4. **P4 — publish script** for reports (opt-in, manual-first).

Each phase is independently shippable and independently deletable — the
capture-pilot containment rule applied to infrastructure.
