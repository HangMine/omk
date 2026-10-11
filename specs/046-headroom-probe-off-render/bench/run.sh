#!/usr/bin/env bash
# spec 046: informal timing of the first formatHeadroomStatusLabel() call, main vs branch.
# usage (from repo root): specs/046-headroom-probe-off-render/bench/run.sh <base-ref> [pairs=7] > raw.tsv
# Each run is a fresh tsx process; arms alternate (base, branch) per pair. load1 is recorded per run.
# The two module copies sit next to the original so relative imports resolve; they are removed on exit.
set -euo pipefail
BASE=${1:?base ref, e.g. 7961ae2}
PAIRS=${2:-7}
DIR=packages/coding-agent/src/modes/interactive/components
SRC=$DIR/control-panel-runtime-status.ts
BASE_MOD=$DIR/zz-bench046-base.ts
BRANCH_MOD=$DIR/zz-bench046-branch.ts
trap 'rm -f "$BASE_MOD" "$BRANCH_MOD"' EXIT
git show "$BASE:$SRC" > "$BASE_MOD"
cp "$SRC" "$BRANCH_MOD"
echo "# base=$(git rev-parse --short "$BASE") branch=$(git rev-parse --short HEAD) node=$(node --version) headroom=$(command -v headroom || echo none) python3=$(command -v python3 >/dev/null && echo present || echo none)"
printf 'pair\tload1\tarm\tfirst_label_ms\tprobe_settled_ms\tversion\tlabel\n'
for i in $(seq 1 "$PAIRS"); do
	for arm in base branch; do
		mod=$BASE_MOD; [ "$arm" = branch ] && mod=$BRANCH_MOD
		load1=$(cut -d' ' -f1 /proc/loadavg)
		row=$(node_modules/.bin/tsx specs/046-headroom-probe-off-render/bench/first-label.mts "$mod" "$arm")
		printf '%s\t%s\t%s\n' "$i" "$load1" "$row"
	done
done
