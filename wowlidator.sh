#!/usr/bin/env bash
#
# wowlidator.sh — a shim, kept for muscle memory.
#
# Everything this script used to do lives in the CLI now:
#
#   find/start Chrome     -> src/browser/chrome.ts, on by default
#   "is it driveable?"    -> a real connectOverCDP takeover, not a status check
#   stale-Chrome recovery -> restarts ours, refuses to touch yours
#   open a tab            -> ensureTab()
#   wait for the app      -> --wait-for
#   pick a mode from the  -> `wowlidator go`, the same three shapes
#     shape of the argument
#   open the report       -> --open
#
# The move was not tidying. That logic decides whether anything can run at all,
# and in bash the only way to exercise it was to execute it; in the CLI it is
# covered by the same suite as everything else (tests/chrome.test.ts). Keeping
# two implementations would have guaranteed they drift.
#
#   ./wowlidator.sh "check pagination is disabled" -u http://localhost:3000/products
#   ./wowlidator.sh my-test.flow.json
#   ./wowlidator.sh http://localhost:3000/products
#
# is now, equivalently:
#
#   wowlidator go "check pagination is disabled" --url http://localhost:3000/products
#   wowlidator go my-test.flow.json
#   wowlidator go http://localhost:3000/products

set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [[ $# -eq 0 || "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'EOF'
wowlidator.sh is now a shim around the CLI. Use wowlidator directly:

  wowlidator go <flow.json>                     run an existing test
  wowlidator go <url>                           let wowlidator write tests for a page
  wowlidator go "<what to test>" --url <url>    describe a test, write it, run it

Useful flags (wowlidator --help has the rest):

  --open               open the HTML report when it finishes
  --wait-for <url>     wait for a dev server that is still booting
  --headless           launch Chrome without a window
  --stop-chrome        quit the browser afterwards, if this run started it
  --no-ensure-chrome   do not start or repair Chrome; use whatever is there

Chrome is started, checked and — when it is wowlidator's own profile and has gone
stale — restarted automatically. A browser on any other profile is reported,
never touched.
EOF
  exit 0
fi

# Translate the flags people have in their fingers, then hand over.
args=()
open_report=1
for arg in "$@"; do
  case "$arg" in
    -u) args+=(--url) ;;
    -w) args+=(--wait-for) ;;
    --no-open) open_report=0 ;;
    *) args+=("$arg") ;;
  esac
done

# The script always opened the report, so the shim preserves that default.
if (( open_report == 1 )); then args+=(--open); fi

exec npm run --silent cli -- go "${args[@]}"
