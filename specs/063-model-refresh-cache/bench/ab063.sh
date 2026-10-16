#!/usr/bin/env bash
# Paired interleaved A/B for spec 063: ab063.sh <A-worktree> <B-worktree> <pairs> <outdir>
set -euo pipefail
A=$1; B=$2; N=$3; OUT=$4; D=$(dirname "$0"); mkdir -p "$OUT"
for i in $(seq 1 "$N"); do
  for arm in A B; do
    wt=$A; [ $arm = B ] && wt=$B
    node "$D/lag-bench.mjs" --worktree "$wt" --size small --providers 10 --models 50 --runs 10 --out "$OUT/lag-$arm-$i.json" >/dev/null 2>>"$OUT/err.log"
    node "$D/render-bench.mjs" --worktree "$wt" --pairs 200 --runs 10 --out "$OUT/render-$arm-$i.json" >/dev/null 2>>"$OUT/err.log"
  done
done
