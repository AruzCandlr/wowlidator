#!/usr/bin/env bash
# Run a list of catalog rows through the jev-case pipeline, several at a time.
#
#   batch.sh <catalog.csv> <batch-name> <row> [<row> ...]
#   JEV_LANES=4 batch.sh …        # lanes in parallel (default 4; 1 = one after another)
#
# Each lane owns a Chrome: port JEV_CDP_PORT+lane (default 9633…) with its own
# profile — never the default 9333 browser, which a catalog run reads pages
# through while it authors; clearing it killed one mid-authoring on 2026-09-21.
# A lane takes a port by creating its lock directory and frees it when its case
# ends, so no two cases ever share a browser. Every command that touches a run is
# appended to <batch-dir>/commands.log, tagged with its row, and echoed: the log
# is the replay script. WOWLIDATOR_DB_URL must be set by the caller; it is never
# written to the log.
set -u
SK="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SK/../../.." || exit 1      # the repo root: newcase reads its .env, npm run cli needs it
FMAP="$SK/fieldmaps/humi-hire.json"
BASE="https://humi-sit-int.central.co.th/humi"
GRIM="$HOME/.claude/skills/grim-qa-report/scripts"
BASE_PORT="${JEV_CDP_PORT:-9633}"
LANES="${JEV_LANES:-4}"

run() { printf '[%s] %s\n' "$ROW" "$*" | tee -a "$LOG"; eval "$@"; }
say() { printf '[%s] # %s\n' "${ROW:--}" "$*" | tee -a "$LOG"; }

# ---------------------------------------------------------------- one row
one_row() {
  ROW="$1"; LOG="$BATCH/commands.log"; SUM="$BATCH/summary.tsv"
  ROWCSV="$BATCH/rows/$ROW.csv"
  [ -f "$ROWCSV" ] || { say "row $ROW not in catalog — skipped"; return; }
  CASE="HR-SIT-E2E-V01-$(echo "$ROW" | tr . -)"
  # Lanes start within the same second; a clock-minted probe would be shared and
  # the DB evidence of two cases would point at one name.
  PROBE="Jev$(date +%m%d%H%M)r$(echo "$ROW" | tr -d .)"
  say "===== row $ROW ($CASE) ====="
  run "eval \"\$(python3 '$SK/scripts/newcase.py' --name 'batch-$ROW' --case '$CASE' --fresh --probe '$PROBE')\""
  run "python3 '$SK/scripts/author.py' --catalog '$ROWCSV' --row '$ROW' --fieldmap '$FMAP' --base-url '$BASE' --out \"\$WOW_FLOW\" --probe \"\$WOW_PROBE\" > \"\$WOW_RUN_DIR/author.log\" 2>&1"
  run "python3 '$SK/scripts/check_flow.py' --flow \"\$WOW_FLOW\" --catalog '$ROWCSV' --row '$ROW' --fieldmap '$FMAP' > \"\$WOW_RUN_DIR/lint.log\" 2>&1"; LINT=$?
  if [ $LINT -ne 0 ]; then
    say "lint refused row $ROW — no browser spent"
    printf '%s\t%s\tFAIL\t-\t-\t-\t-\t-\t%s\n' "$ROW" "$CASE" "$WOW_RUN_DIR" >> "$SUM"; return
  fi
  # What the run would trip over, judged against the app's own rules and the SIT
  # masters. A predicted BLOCKER is the result: spending four minutes and a test
  # account's writes to watch it happen proves nothing more. JEV_FORCE=1 runs anyway.
  run "python3 '$SK/scripts/predict.py' --flow \"\$WOW_FLOW\" --catalog '$ROWCSV' --row '$ROW' --fieldmap '$FMAP' > \"\$WOW_RUN_DIR/predict.log\" 2>&1"; PRED=$?
  if [ $PRED -eq 2 ] && [ "${JEV_FORCE:-0}" != "1" ]; then
    WHY=$(grep '^BLOCKER' "$WOW_RUN_DIR/predict.log" | cut -d: -f1 | sed 's/BLOCKER //' | sort -u | tr '\n' ',' | sed 's/,$//')
    say "row $ROW predicted blocked ($WHY) — no browser spent"
    printf '%s\t%s\tpredicted:%s\t-\t-\t-\t-\t-\t%s\n' "$ROW" "$CASE" "$WHY" "$WOW_RUN_DIR" >> "$SUM"; return
  fi
  run "sed \"s/__PROBE__/\$WOW_PROBE/g\" '$SK/db/humi-hire.sql' > \"\$WOW_GRIM_DIR/\$WOW_CASE-db-query.sql\""
  run "psql \"\$WOWLIDATOR_DB_URL\" --csv -f \"\$WOW_GRIM_DIR/\$WOW_CASE-db-query.sql\" > \"\$WOW_GRIM_DIR/\$WOW_CASE-db-before.csv\""

  # Take a lane: the first port whose lock this process can create.
  PORT=""
  while [ -z "$PORT" ]; do
    for i in $(seq 0 $((LANES - 1))); do
      if mkdir "$BATCH/.lane-$i" 2>/dev/null; then PORT=$((BASE_PORT + i)); LANE=$i; break; fi
    done
    [ -z "$PORT" ] && sleep 2
  done
  PROFILE="/tmp/wowlidator-chrome-profile-jev-$PORT"
  trap 'rmdir "$BATCH/.lane-$LANE" 2>/dev/null' EXIT
  if ps -eo command | grep -E "[c]li.ts run " | grep -q -- "localhost:$PORT"; then
    say "another single-flow run owns port $PORT — row $ROW not run"
    printf '%s\t%s\tport-busy\t-\t-\t-\t-\t-\t%s\n' "$ROW" "$CASE" "$WOW_RUN_DIR" >> "$SUM"; return
  fi
  run "pkill -f 'remote-debugging-port=$PORT'; sleep 2; rm -rf '$PROFILE'"
  T0=$(date +%s)
  # Sign-in can fail to establish a session when several lanes (and a catalog
  # run) log the same account in at once; the run then stops in seconds with
  # nothing tested. That is not a verdict on the case: try again, a little later.
  for TRY in 1 2 3; do
    [ $TRY -gt 1 ] && { say "row $ROW: session was not established — attempt $TRY"; run "pkill -f 'remote-debugging-port=$PORT'; sleep $((TRY * 7)); rm -rf '$PROFILE' \"\$WOW_RUN_DIR\"/proofs/*.json"; }
    run "WOWLIDATOR_REPORT_DIR=\"\$WOW_RUN_DIR\" WOWLIDATOR_PROOF_DIR=\"\$WOW_RUN_DIR/proofs\" WOWLIDATOR_AGENT_PROVIDER=openrouter WOWLIDATOR_AGENT_MODEL='~typesafe/jev-latest' npm run cli -- run \"\$WOW_FLOW\" --cdp http://localhost:$PORT --chrome-profile '$PROFILE' --agent-assist --video on --screenshots all --report-lang th --out \"\$WOW_RUN_DIR/proofs\" --report \"\$WOW_RUN_DIR/\$WOW_CASE-case-page.html\" > \"\$WOW_RUN_LOG\" 2>&1"; EXIT=$?
    grep -aq "session is not established" "$WOW_RUN_LOG" || break
  done
  SECS=$(( $(date +%s) - T0 ))
  run "pkill -f 'remote-debugging-port=$PORT'"
  rmdir "$BATCH/.lane-$LANE" 2>/dev/null; trap - EXIT
  run "psql \"\$WOWLIDATOR_DB_URL\" --csv -f \"\$WOW_GRIM_DIR/\$WOW_CASE-db-query.sql\" > \"\$WOW_GRIM_DIR/\$WOW_CASE-db-after.csv\""
  run "python3 '$GRIM/build_report.py' \"\$WOW_RUN_DIR\" '$ROWCSV' \"\$WOW_CASE\" '$ROW' > \"\$WOW_RUN_DIR/build.log\" 2>&1"
  N=$(ls "$WOW_GRIM_DIR" 2>/dev/null | grep -c -- '-evidence-[0-9]*\.jpg$')
  V=$(ls "$WOW_GRIM_DIR" 2>/dev/null | grep -c '\.webm$')
  run "python3 '$GRIM/validate_report.py' \"\$WOW_CASE\" \"\$WOW_GRIM_DIR\" --expect-images $N --expect-videos $V >> \"\$WOW_RUN_DIR/build.log\" 2>&1"
  TALLY=$(python3 - "$WOW_RUN_DIR" <<'PY'
import json, glob, sys, collections
f = sorted(glob.glob(sys.argv[1] + "/proofs/*.json"))
if not f: print("-\t-"); raise SystemExit
c = collections.Counter(s["status"] for s in json.load(open(f[-1]))["steps"])
print(f'{c["passed"]}\t{sum(v for k, v in c.items() if k != "passed")}')
PY
)
  CHECKS=$(grep -o "checks: {[^}]*}" "$WOW_RUN_DIR/build.log" | tail -1)
  printf '%s\t%s\tok\t%s\t%s\t%s\t%s\t%s\n' "$ROW" "$CASE" "$EXIT" "$SECS" "$TALLY" "$CHECKS" "$WOW_RUN_DIR" >> "$SUM"
  say "row $ROW done in ${SECS}s on port $PORT · exit $EXIT · $CHECKS"
}

if [ "${1:-}" = "--one" ]; then one_row "$2"; exit 0; fi

# ---------------------------------------------------------------- the batch
CATALOG="$1"; NAME="$2"; shift 2
OUT_ROOT="${WOWLIDATOR_BATCH_ROOT:-$HOME/Documents/workspace/ai-val/valst-output/reports/runs}"
export BATCH="$OUT_ROOT/$NAME-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BATCH/rows"
LOG="$BATCH/commands.log"; ROW="-"
printf 'row\tcase\tlint\texit\tseconds\tpassed\tfailed\tchecks\trun_dir\n' > "$BATCH/summary.tsv"
say "batch $NAME · catalog $CATALOG · $LANES lane(s) on ports ${BASE_PORT} to $((BASE_PORT + LANES - 1)) · rows: $*"
run "python3 '$SK/scripts/split_rows.py' '$CATALOG' '$BATCH/rows' $*"
export JEV_LANES="$LANES" JEV_CDP_PORT="$BASE_PORT"
printf '%s\n' "$@" | xargs -P "$LANES" -n 1 bash "$SK/scripts/batch.sh" --one
rmdir "$BATCH"/.lane-* 2>/dev/null
say "batch finished · summary $BATCH/summary.tsv"
echo "$BATCH"
