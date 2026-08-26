#!/usr/bin/env bash
#
# Wait for the Claude CLI to answer again, then resume the run.
#
# A usage limit is not a failure to diagnose and not something to retry
# aggressively — it is a wait. This polls with the cheapest question it can
# ask (a two-token reply on the smallest model), and the moment one comes
# back it resumes the catalog run and stands down.
#
# It is deliberately separate from `run-watchdog.sh`. That watchdog's job is
# to notice a stop and resume through it; this one's job is to notice a
# *provider* coming back. Folding them together would mean the watchdog
# hammering a rate-limited account every minute, which is how a limit gets
# extended rather than waited out.
#
#   bin/await-limit-reset.sh <ledger.progress.json> [incident.html] [pollSeconds]
set -uo pipefail

LEDGER="${1:?usage: await-limit-reset.sh <ledger.progress.json> [incident.html] [pollSeconds]}"
INCIDENT="${2:-incident.html}"
POLL="${3:-300}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { printf '%s' "$1" | node "$HERE/incident-log.mjs" "$INCIDENT" - >/dev/null 2>&1 || true; }

# One cheap question. `haiku` at low effort with a two-word answer is the
# smallest thing the CLI will do, so waiting costs almost nothing.
probe() {
  timeout 120 claude -p --model haiku --effort low --strict-mcp-config \
    --system-prompt 'Reply with one word.' --output-format json 'Say ready.' >/dev/null 2>&1
}

log '{"kind":"note","title":"Waiting for the Claude usage limit to reset","detail":"Polling with one small question every five minutes. The run resumes automatically the moment a reply comes back; nothing is retried in the meantime, because hammering a limited account is how a limit gets extended rather than waited out."}'

while true; do
  if probe; then
    log '{"kind":"note","title":"The Claude CLI is answering again — resuming","detail":"The usage limit has reset. Resuming the catalog run under its original run key."}'
    job="$(node "$HERE/run-resume.mjs" "$LEDGER" 2>&1)"
    if [ $? -eq 0 ]; then
      log "$(node -e 'console.log(JSON.stringify({kind:"resume",title:`Resumed as ${process.argv[1]} after the limit reset`,detail:"Continued under the original run key with the prior job argv, resume flags stripped and --resume added."}))' "$job")"
      exit 0
    fi
    log "$(node -e 'console.log(JSON.stringify({kind:"note",title:"Limit reset, but the resume was refused",detail:process.argv[1]}))' "$job")"
    exit 1
  fi
  sleep "$POLL"
done
