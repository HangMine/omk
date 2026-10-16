#!/usr/bin/env bash
# Paired interleaved heap/RSS A/B: mem-ab.sh <A> <B> <pairs> <outdir>
set -euo pipefail
A=$1; B=$2; N=$3; OUT=$4; D=$(dirname "$0"); mkdir -p "$OUT"
for i in $(seq 1 "$N"); do for arm in A B; do wt=$A; [ $arm = B ] && wt=$B
  node --expose-gc "$D/lag-bench.mjs" --mem --worktree "$wt" --size large --providers 1 --models 5 --out "$OUT/mem-$arm-$i.json" >/dev/null 2>>"$OUT/err.log"
done; done
