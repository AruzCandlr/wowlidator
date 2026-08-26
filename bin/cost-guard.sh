#!/usr/bin/env bash
#
# Kill the panel if this system's own claude-cli spend crosses a hard cap.
#
# "This session and claude -p called by this system" is read narrowly: the
# spend this repo's own provider (src/providers/claude-cli.ts) has RECORDED,
# because that is the only spend the repo can see or prove. Every proof
# bundle a run produces carries `summary.session.costUsd` — the CLI's own
# reported total_cost_usd for the calls that authored and ran that one case
# (see engine/runner.ts's noteSessionUsage). Summing that field across every
# bundle on disk is the running total of everything this system's test flow
# has spent, independent of which run or which day produced it.
#
# It does NOT see: interactive claude-cli usage outside this repo, or a
# `claude -p` invoked by a process that never went through the provider (a
# one-off shell probe). Those are outside what a file on disk can account
# for; the guard is honest about that limit rather than pretending to a
# number it cannot compute.
#
#   bin/cost-guard.sh [capUsd] [pollSeconds] [proofsDir] [incident.html]
set -uo pipefail

CAP="${1:-60}"
POLL="${2:-120}"
PROOFS="${3:-/Users/ThArus/Documents/workspace/ai-val/valst-output/proofs}"
INCIDENT="${4:-incident.html}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { printf '%s' "$1" | node "$HERE/incident-log.mjs" "$INCIDENT" - >/dev/null 2>&1 || true; }

total_spend() {
  node -e '
    const fs = require("node:fs");
    const glob = fs.readdirSync(process.argv[1]).filter((f) => f.endsWith(".json"));
    let sum = 0;
    for (const f of glob) {
      try {
        const b = JSON.parse(fs.readFileSync(process.argv[1] + "/" + f, "utf8"));
        sum += b?.summary?.session?.costUsd ?? 0;
      } catch {
        /* a bundle mid-write or unreadable contributes nothing rather than crashing the guard */
      }
    }
    console.log(sum.toFixed(4));
  ' "$PROOFS"
}

log "$(node -e 'console.log(JSON.stringify({kind:"note",title:"Cost guard armed",detail:`Watching this system'"'"'s own recorded claude-cli spend (sum of summary.session.costUsd across every proof bundle in ${process.argv[1]}) every ${process.argv[2]}s. If it reaches $${process.argv[3]}, the panel on :4600 is killed and the run stopped — a hard stop, not a warning, because a cost cap that only warns is not a cap.`,evidence:`cap=$${process.argv[3]} poll=${process.argv[2]}s proofs=${process.argv[1]}`}))' "$PROOFS" "$POLL" "$CAP")"

warned=0
while true; do
  spend="$(total_spend)"
  over="$(node -e "console.log(Number(process.argv[1]) >= Number(process.argv[2]))" "$spend" "$CAP")"
  nearing="$(node -e "console.log(Number(process.argv[1]) >= Number(process.argv[2]) * 0.8)" "$spend" "$CAP")"

  if [ "$over" = "true" ]; then
    pid="$(lsof -tnP -iTCP:4600 -sTCP:LISTEN 2>/dev/null | head -1)"
    log "$(node -e 'console.log(JSON.stringify({kind:"stop",title:`Cost cap reached — $${process.argv[1]} recorded of a $${process.argv[2]} cap`,detail:`localhost:4600 is being killed (pid ${process.argv[3] || "none found"}) and every claude-cli spend this repo can see has crossed the cap. This is a hard stop: the panel must be restarted by hand, deliberately, once the spend is reviewed — an auto-restart here would defeat the point of a cap.`}))' "$spend" "$CAP" "$pid")"
    [ -n "$pid" ] && kill "$pid" 2>/dev/null
    touch supervisor.hold 2>/dev/null || true
    exit 0
  fi

  if [ "$nearing" = "true" ] && [ "$warned" = "0" ]; then
    log "$(node -e 'console.log(JSON.stringify({kind:"note",title:`Approaching the cost cap — $${process.argv[1]} of $${process.argv[2]}`,detail:"Over 80% of the cap. No action taken yet; logged once so it is not a surprise when the hard stop lands."}))' "$spend" "$CAP")"
    warned=1
  fi

  sleep "$POLL"
done
