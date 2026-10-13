# Reliability review: 2026-10-13

## Repository snapshot

Reviewed `dmae97/omk` at main `dcaa751e408b8f4d24f90c0a69a7cd273dde682a`, with the existing uncommitted TUI first-frame work preserved.

- Open PRs: 0 at inspection time. [PR #137](https://github.com/dmae97/omk/pull/137) integrated the outstanding changes; [PR #138](https://github.com/dmae97/omk/pull/138) repaired test process lifecycles.
- Main [CI run 38136810779](https://github.com/dmae97/omk/actions/runs/38136810779) passed. The latest public GitHub release was `v1.4.0`.
- `npm audit --omit=dev` returned exit 1: High 2, Critical 0, under Gondolin/node-forge, with no official fix available. The existing [signature mitigation](gondolin-security.md) does not make the audit clean.
- Baseline `npm run check` passed. Its unrelated release-consistency worktree warning was preserved.

This is a targeted source review, not an exhaustive security audit or a production-readiness certification.

## Implemented follow-ups

### Worker trust: PR #132 / spec 053

Permanent positive Git caching granted trust after a registered worktree was removed and replaced at the same path. A path listing alone also failed to distinguish redirected `.git` pointers.

Later spawns now check repository identity, current worktree registration, matching common directories and linked-worktree registration back-pointers. Only in-flight queries are shared. Already-aborted spawns receive no grant, and the gated-items fingerprint is checked again after asynchronous Git queries.

Real Git fixtures exercise removed/recreated directories, stale registration, pointers to the main or another linked worktree, concurrent cancellation, changed settings during verification, and legitimate main/sibling grants from a linked parent.

Residual: the final check and actual child startup are not an atomic filesystem operation. Windows and a real child launched by the subagent extension were not tested here.

### Skill search: PR #134 / spec 058

The previous 64-hit cap ran before exclusions and content-hash de-duplication. An alias-heavy or already-offered prefix could hide every remaining match.

The shared BM25 implementation now exposes bounded corpus ranking separately from result slicing. Skill search preserves full-corpus scores and highest-ranked representatives, removes duplicates and exclusions, then caps the distinct pool at 64. Excluding a previously offered name also excludes its content-identical aliases. Both BM25 and metacon use this path.

Residual: this does not establish semantic relevance on unrelated queries or improve the earlier metacon benchmark verdict. Search stays opt-in; no default, model, network or prompt-cache policy changed.

### TUI: issue #104

Zero seed now means only the live tail. An unset library seed retains full-history rendering. Invalid settings fall back safely, and seed changes or height-only resizes recompute the virtual boundary. Explicit final transcripts include history beyond the normal repaint repair budget; ordinary redraws stay bounded.

The benchmark constructs the same full transcript before enabling the seed and reports emitted lines separately from transcript lines. These are single local headless runs at 120 columns by 40 rows, not paired statistical or live-terminal measurements:

| Seed lines | Transcript lines | Emitted lines | First frame | UTF-8 bytes written |
| --- | --- | --- | --- | --- |
| Unset | 100,016 | 100,016 | 390.8 ms | 15,126,222 |
| 2,000 | 100,016 | 2,125 | 9.8 ms | 327,147 |
| 0 | 100,016 | 123 | 1.8 ms | 24,636 |

Skipped prefix children still undergo identity/settledness checks. The line budget is applied at component boundaries, and terminal scrollback capacity limits retained history.

Reproduce from `packages/coding-agent`:

```bash
TUI_BENCH=1 TUI_BENCH_LINES=100000 TUI_BENCH_FRAMES=10 \
  TUI_BENCH_SEED=2000 ../../node_modules/.bin/vitest run test/chat-windowing-bench.test.ts
```

## Verification and remaining work

- Targeted coding-agent integration: 19 files, 280 tests passed with temporary HOME and agent directories. Without HOME isolation, an existing cold-path test discovered personal skills and failed its small-catalog premise; no pass criterion was weakened.
- TUI suite: 834 passed, 0 failed, 2 existing TODOs. Includes a real xterm-headless final-transcript scenario.
- Coding-agent `tsgo --noEmit -p tsconfig.json`: exit 0. Final root `npm run check`: exit 0, including 408 repository-guard tests, module-size, import, documentation, privacy and browser-smoke gates.
- All three opt-in benchmark variants completed with exit 0. LSP returned no findings but could not confirm clean state; compiler checks are the type-validation evidence.
- Self-review covered trust revocation, concurrent cancellation, unchanged BM25 scores and golden output, opt-out rendering, seed resizing and final-transcript emission. No new dependency, widened security baseline or delegation was introduced.
- Follow up on the official Gondolin/node-forge patch when available; retain the High audit findings until then.
- Old issues #9 and #13 still need current-version reproduction. The former's reported Kimi warning strings are absent from current source; neither issue was declared resolved by this review.
- At review time, no dependency upgrades, commit, push, PR creation, issue closure or release had been performed. This snapshot predates the later authorized commit/push operation.
