#!/usr/bin/env bash
# Paired interleaved A/B: ab.sh <A-worktree> <B-worktree> <size> <pairs> <outdir>
set -euo pipefail
A=$1; B=$2; SIZE=$3; N=$4; OUT=$5; mkdir -p "$OUT"
for i in $(seq 1 "$N"); do
  for arm in A B; do
    wt=$A; [ $arm = B ] && wt=$B
    if (( i % 2 == 0 )); then :; fi
    node "$(dirname "$0")/lag-bench.mjs" --worktree "$wt" --size "$SIZE" --providers 10 --models 50 --runs 10 --out "$OUT/$arm-$SIZE-$i.json" >/dev/null 2>>"$OUT/err.log"
  done
done
