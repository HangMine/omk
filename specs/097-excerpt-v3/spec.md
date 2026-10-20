---
description: "Excerpt v3: location-robust acceptance-diagnostic excerpt (failure-marker + diagnostic-shape anchors, decoy-safe, middle-aware fallback); default-off OMK_GOAL_DIAGNOSTICS_V3; spec only"
status: draft
supersedes: 095
---

# 097 — Acceptance-diagnostic excerpt v3

## Problem

Spec 095 (two-window excerpt) failed its single official holdout3 measurement: **0/10** (see
`specs/095-excerpt-two-window/holdout3-result.md`, output sha256 `6a215ea3…dff33d`). Reference-only,
"both GT lines anywhere in the excerpt" would be 7/10; the remaining 3 never show the first real error.

## Root causes (from holdout3, now training data)

1. **First real error not shown (deno, pytest, golangci).**
   - Decoy anchoring: the word "error" in *passing* test names (deno lines 3-5) anchors window 1.
   - Failure markers missing: `… FAILED (12ms)` (deno), `path::test FAILED [ 44%]` (pytest) match no pattern; anchor falls on a later block.
   - Diagnostic shape missing: `path:line:col: message (linter)` (golangci) matches nothing; warnings are excluded, so fallback head = warnings, tail = summary, errors elided in the middle.
2. **Fallback in the wrong spot (ruff, cmake).** Keyword-less `path:line:col: CODE msg` and `note:` / `make: *** … Stop` lines match no pattern; head/tail fallback spends window 1 on preamble.
3. **Window-2 rule vs merged/close windows (rspec, maven, ctest, exunit, webpack).** When first and last errors are close, windows merge or both land in window 1, and the 095 rule "last in window 2" fails although the user sees both. This is a rule-design issue, not a scorer bug (Tech Lead ruling).

## Proposed design (flag-gated, default off)

Flag `OMK_GOAL_DIAGNOSTICS_V3=1`; flag off = byte-identical 095/094 behaviour (golden test). Same caps (1,536 B / 40 lines).

- **D1 Failure-marker anchors** (tool-agnostic): line-level `FAILED`/`FAIL`/`Failed`/`***Failed`/`✗`/`failing` tokens as whole words or status columns.
- **D2 Diagnostic-shape anchor**: `^\S+:\d+(:\d+)?:\s` (file:line[:col]:) regardless of keyword, ranked below explicit errors, above fallback.
- **D3 Decoy suppression**: a line with a success marker (`ok`, `PASSED`, `✓`, `passed`) on the same line never anchors, even if it contains "error".
- **D4 Middle-aware fallback**: if no anchor, window 1 = first diagnostic-shape or non-log-prefix (`level=info|warning`) block, not raw head.
- **D5 Warnings**: warnings never anchor window 1 when a D1/D2 line exists later.
- Windows: window 1 around first anchor; window 2 around last anchor; if they overlap they merge into one window (allowed).

## Pass rule (fixed before implementation)

Per fixture: the real first error line (`groundTruthLine`) **and** the real last error line
(`groundTruthLastLine`) are each **inside the emitted excerpt** (any window, not inside an elision marker).
Fixtures that fit the cap whole are invalid (hard stop), as in 095.

### Numeric acceptance criteria

| ID | Test | Pass |
|---|---|---|
| A1 | holdout4 (≥10 fixtures) | **10/10** by the rule above |
| A2 | holdout1 + holdout2 + holdout3 (regression, training) | ≥ 28/30 by the same rule; no fixture that passed under 095 rule turns from "first shown" to "first not shown" |
| A3 | flag off | byte-identical to main on all existing goal-diagnostics fixtures |
| A4 | caps | every excerpt ≤ 1,536 B and ≤ 40 lines |
| A5 | unit | decoy (success line containing "error") never anchors |

## Ordering (each a separate commit, in this order)

1. This spec (rule + criteria).
2. Scorer change + **unit tests asserting the scorer implements the 097 rule exactly** (inside-excerpt, merged windows count, elision markers don't, hard stop on fits-whole). Before any implementation commit.
3. **holdout4** committed: ≥10 new fixtures, authored blind by someone other than the implementer who has not read 097's patterns (D1-D5); manifest with 1-based `groundTruthLine`/`groundTruthLastLine`; ≥3 decoy, ≥2 keyword-less, ≥2 warnings-first, ≥2 ">24-before", at least 5 tools not in holdout1-3.
4. Implementation (flag-gated).
5. **Single measurement** of holdout4 at the implementation head. FAIL ⇒ result recorded, no retune, new spec.

holdout3 is training only; it is not acceptance.

## Known risks

- Rule relaxation makes A1 easier than 095's; offset by fresh blind holdout4 and A2 regression.
- D2 may anchor on harmless `file:line:` log output (e.g. stack traces of passing tests) → noise.
- D1 whole-word `FAILED` may hit text like "0 FAILED" summaries; summary still informative but may displace window 1.
- Overfitting to holdout3 tool formats; mitigated by "5 new tools" in holdout4.
- Author independence of holdout4 cannot be enforced technically; recorded in commit message.

## Open questions (Tech Lead)

1. Is A2 threshold 28/30 right, or require 30/30?
2. Should D4 skip `level=info|warning` structured logs generically or only known formats?
3. Who authors holdout4 (Agent Researcher or Library Scout)?
4. Separate flag (`…_V3`) vs reuse `OMK_GOAL_DIAGNOSTICS` with version value?
