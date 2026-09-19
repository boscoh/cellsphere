#!/usr/bin/env bash
# Full gait sweep (cell-aj9). Runs one process per config in parallel, each over
# SEEDS seeds for DURATION sim-seconds, then prints a summary table.
#
#   scripts/gait-sweep.sh                 # 1800s, seeds 1-5
#   DURATION=2400 SEEDS=1,2,3,4,5,6,7 scripts/gait-sweep.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DURATION="${DURATION:-1800}"
SEEDS="${SEEDS:-1,2,3,4,5}"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

run() {
  node "$HERE/gait-sweep.mjs" --label "$1" --config "$2" --seeds "$SEEDS" --duration "$DURATION" \
    > "$OUT/$1.json" 2> "$OUT/$1.err" &
}

run baseline '{}'
run both '{"GAIT_MODE":1}'
run prey-only '{"GAIT_MODE":1,"GAIT_PRED":0}'
run pred-only '{"GAIT_MODE":1,"GAIT_PREY":0}'
run td-0.35 '{"GAIT_MODE":1,"GAIT_TURN_DRIVE":0.35}'
run td-0.5 '{"GAIT_MODE":1,"GAIT_TURN_DRIVE":0.5}'
run mt-1.2 '{"GAIT_MODE":1,"GAIT_MOVE_TIME":1.2}'
run no-drift '{"GAIT_MODE":1,"GAIT_DRIFT_FRAC":1}'
run tumble '{"GAIT_MODE":1,"GAIT_TUMBLE":2}'

wait
cat "$OUT"/*.json | node "$HERE/gait-sweep-table.mjs"
