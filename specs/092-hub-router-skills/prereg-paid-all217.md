# PREREG: paid all-217 Jev arm (spec only; no run, no API call, no key use)

Status: DRAFT. Nothing may run until every frozen item below is recorded and 인호 has set the cost cap and given an OK in a 1:1 chat.
Context: the 092 free gate is FAIL at G2 before measuring (hubs over 25 skills). The 091 bm25 stage is closed.

## Arm

- All 217 selectable skills of catalog-v3 go to Jev as `choice` options in every call (217 ≤ 255 option limit),
  rendered as one candidate block (`renderCandidates`): 26,088 tokens (chars/4) ≤ 32k per-question limit.
- One call per EN sentence: 100 answerable + 10 no-answer = **110 calls**.

## Frozen before the run (record value + sha here; any change = new PREREG)

| item | value |
|---|---|
| catalog | catalog-v3 sha256 `250e637e0163c9884e6c5d261290f5d5444423909510882dbf28a617e723bde4` |
| labels | labels-en-v1.jsonl sha256 `adadd76d7d543ded09cf8e93472966c36483886bf4b094b13242671a3e0361dd` |
| hub membership (for R1 hub scoring) | hub-membership.json sha256 `f435ead0b72a4a27d04ff6eda25c58b60f393a5906623d5e6a8025be73fcc2cc` |
| model id | `jev-1.14.0` (pinned; not `jev-latest`) |
| temperature / sampling | TBD; record the exact request fields, or "none exposed" if the API has none |
| prompt template | file path + sha256 TBD (state text, question text, option list order) |
| harness commit | omk commit sha of the runner script TBD |
| attach threshold | probability ≥ 0.6 (091 PREREG) |
| cost cap | **TBD — set by 인호 in 1:1 before any run** |

## Scoring and gates

- R1: an answerable item is a hit iff Jev's attached skill's membership hub == the gold skill's membership hub,
  including gold = `omk-skills`. Hits for gold = `omk-skills` (19/100) are reported separately.
  Below threshold or unavailable = no attach = miss for answerable items.
- Exact-skill accuracy (attached skill == gold skill) is reported, not gated.
- **G1 (accuracy lower bound):** hub-level miss ≤ 1/100.
- **G4 (no-answer false-attach cap):** any attach on a no-answer item = false attach; ≤ 1/10.
- Exact Clopper-Pearson 95% intervals for every rate (stdlib beta inverse; verified 61/100 → [0.5073, 0.7060]).

## Cost

- Estimate: 26,088 tokens × 110 calls = 2,869,680 input tokens (plus state/question text, a few hundred tokens per call).
  At $0.042 per 1M input tokens with output free: **about $0.12** for the block (about $0.13 with +10% overhead).
- Pricing source: TypeSafe Models page, https://docs.typesafe.ai/models (Jev 1.14 `jev-1.14.0`: $42/Btok = $0.042/Mtok,
  output free), checked 2026-10-20. Recheck on the day of the run.
- Proposed cap for 인호: $1.00 (about 8× the estimate). The run aborts if the cumulative `usage.input_tokens` × price exceeds the cap.
- Per-call accounting in raw output: `usage.input_tokens`, `usage.output_tokens`, computed USD, latency, HTTP status, model echoed back.

## Execution rules

- Exactly one run. No retries of the whole run. Per-call failures are recorded as unavailable (no attach); no substitute.
- No cleanup or delete step in the run command; chain with `&&`.
- Raw output on the box only, mode 600: `/workspace/omk-eval-092/paid-all217-raw.json`. No sentence text or key in logs or the room; aggregates only.
- Key: 인호 provides it in 1:1 by env var only; never written to disk or logs.

## Risks

- The same EN set is reused a fifth time; the result is evidence for this arm only.
- Jev may behave differently with 217 options than with 25; the 0.6 threshold was set for the smaller list.
