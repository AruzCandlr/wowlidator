#!/usr/bin/env bash
#
# Keep a catalog run going until every planned case has been reached.
#
# The durable half of supervision. It observes, logs, and — for a stop that
# looks transient — resumes, up to a bounded number of times. It NEVER edits
# code and never diagnoses: a stop it cannot simply resume through is left
# standing, with its evidence logged, for a person (or Claude) to look at.
#
# Two rules keep it from doing harm:
#
#   * It resumes only while the run is still making progress. If a resume
#     produces no new recorded case, that is the same failure again and
#     resuming a third time would just spend tokens re-proving it — so it
#     stops and waits.
#   * A `supervisor.hold` file beside the log suspends it entirely. That is how
#     someone editing the code takes the wheel without racing it.
#
#   bin/run-watchdog.sh <ledger.progress.json> [incident.html] [pollSeconds]
set -uo pipefail

LEDGER="${1:?usage: run-watchdog.sh <ledger.progress.json> [incident.html] [pollSeconds]}"
INCIDENT="${2:-incident.html}"
POLL="${3:-60}"
HOLD="$(dirname "$INCIDENT")/supervisor.hold"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# How many times a run may be resumed without any new case being recorded
# between attempts. One is the honest number: the second identical stop is
# evidence, not bad luck.
MAX_BARREN_RESUMES=1

log() { node "$HERE/incident-log.mjs" "$INCIDENT" "$1" >/dev/null 2>&1 || true; }
state() { node "$HERE/run-state.mjs" "$LEDGER" 2>/dev/null; }

barren=0
last_recorded=-1

while true; do
  s="$(state)"
  if [ -z "$s" ]; then
    sleep "$POLL"; continue
  fi

  complete=$(printf '%s' "$s" | node -e 'let i="";process.stdin.on("data",d=>i+=d).on("end",()=>console.log(JSON.parse(i).complete))')
  running=$(printf '%s' "$s" | node -e 'let i="";process.stdin.on("data",d=>i+=d).on("end",()=>console.log(JSON.parse(i).running))')
  recorded=$(printf '%s' "$s" | node -e 'let i="";process.stdin.on("data",d=>i+=d).on("end",()=>console.log(JSON.parse(i).recorded))')

  if [ "$complete" = "true" ]; then
    log "$(node -e 'const s=JSON.parse(process.argv[1]);console.log(JSON.stringify({kind:"done",title:"Every planned case has been reached",detail:`All ${s.planned} cases now carry a verdict. The watchdog is standing down.`,state:s}))' "$s")"
    exit 0
  fi

  if [ "$running" = "true" ]; then
    [ "$recorded" != "$last_recorded" ] && { barren=0; last_recorded="$recorded"; }
    sleep "$POLL"; continue
  fi

  # Stopped, and short of the plan.
  if [ -f "$HOLD" ]; then
    sleep "$POLL"; continue
  fi

  if [ "$recorded" = "$last_recorded" ]; then
    barren=$((barren + 1))
  else
    barren=0
    last_recorded="$recorded"
  fi

  if [ "$barren" -gt "$MAX_BARREN_RESUMES" ]; then
    log "$(node -e 'const s=JSON.parse(process.argv[1]);console.log(JSON.stringify({kind:"stop",title:"Stopped again with nothing new recorded — not resuming",detail:"A resume produced no further case, so the same thing is failing. Resuming again would only spend tokens re-proving it. Left standing for diagnosis; the watchdog keeps watching and will pick the run up once it is running again.",state:s}))' "$s")"
    # Keep watching rather than exiting: once someone resumes it by hand or
    # after a fix, this returns to its ordinary job.
    while [ ! -f "$HOLD" ]; do
      s="$(state)"
      r=$(printf '%s' "$s" | node -e 'let i="";process.stdin.on("data",d=>i+=d).on("end",()=>{const j=JSON.parse(i);console.log(j.running||j.complete)})')
      [ "$r" = "true" ] && { barren=0; break; }
      sleep "$POLL"
    done
    continue
  fi

  log "$(node -e 'const s=JSON.parse(process.argv[1]);console.log(JSON.stringify({kind:"stop",title:`The run stopped with ${s.remaining} case(s) unreached`,detail:`Last job: ${s.lastJob?`${s.lastJob.id} ${s.lastJob.status} (exit ${s.lastJob.exitCode})`:"none recorded"}. Environment at the time: CDP ${s.env.cdp?"up":"DOWN"}, app ${s.env.app?"up":"DOWN"}, panel ${s.env.ui?"up":"DOWN"}.`,state:s,evidence:JSON.stringify(s,null,2)}))' "$s")"

  job="$(node "$HERE/run-resume.mjs" "$LEDGER" 2>&1)"
  if [ $? -eq 0 ]; then
    log "$(node -e 'console.log(JSON.stringify({kind:"resume",title:`Resumed as ${process.argv[1]}`,detail:"Continued under the original run key with the prior job’s own argv, resume flags stripped and --resume added: the terms of the suite are unchanged."}))' "$job")"
    last_recorded="$recorded"
  else
    log "$(node -e 'console.log(JSON.stringify({kind:"note",title:"Could not resume",detail:process.argv[1]}))' "$job")"
  fi
  sleep "$POLL"
done
