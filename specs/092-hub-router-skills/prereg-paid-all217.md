# PREREG: paid all-217 Jev arm (spec only; no run, no API call, no key use)

Status: frozen except the cost cap amount. Nothing may run until 인호 sets the cap and gives an OK in a 1:1 chat.
Context: the 092 free gate is FAIL at G2 before measuring (hubs over 25 skills). The 091 bm25 stage is closed.

## Arm

- One Jev `choice` call per EN sentence: 100 answerable + 10 no-answer = **110 calls**.
- Options: all 217 selectable catalog-v3 skills (option = skill name, description = catalog desc, sorted by name)
  plus one extra option `none` = 218 options (≤ 255 limit). Criteria text is 60,052 chars (≈ 15,013 tokens, chars/4),
  under the 32k per-question limit.

## Frozen before the run

| item | value |
|---|---|
| catalog | catalog-v3 sha256 `250e637e0163c9884e6c5d261290f5d5444423909510882dbf28a617e723bde4` |
| labels | labels-en-v1.jsonl sha256 `adadd76d7d543ded09cf8e93472966c36483886bf4b094b13242671a3e0361dd` |
| model id | `jev-1.14.0` (pinned; not `jev-latest`) |
| temperature | none: the `/v1/systemone` request body has no temperature or sampling field (https://docs.typesafe.ai/api: `state`, `model`, `questions` only). The 091 design sets none either. Nothing is sent. |
| prompt template | `specs/092-hub-router-skills/tools/paid-all217-template.json` sha256 `fdce5368063ce81f78133d827483dc45edc4afab2db8f7c943a80f32e3f5ec41` |
| runner | `specs/092-hub-router-skills/tools/paid_all217_run.ts` sha256 `2ded11dcb80652d301c9065588db1850d5c3698b3223609d19d073f38d5c005d` |
| harness commit | `207dc47feefa3983b14db748c1c420c4b0884b4c` (branch `spec/092-paid-prereg`; template + runner) |
| attach threshold | probability of the chosen option ≥ **0.6** (091 spec stage 3 PREREG value), used for both G1 and G4 |
| cost cap | **TBD — set by 인호 in 1:1 before any run** (env `OMK_COST_CAP_USD`; runner refuses to start without it) |

## Scoring and gates

- Attach = Jev's chosen option is a skill (not `none`) and its probability ≥ 0.6. Otherwise no attach.
- **G1 (accuracy):** an answerable item is a hit iff the attached skill id == the gold skill id exactly.
  No attach, wrong skill, or call failure = miss. Pass iff misses ≤ 1/100.
- **G4 (no-answer false-attach cap):** any attach on a no-answer item = false attach. Pass iff ≤ 1/10.
- Exact Clopper-Pearson 95% intervals for every rate (stdlib beta inverse; verified 61/100 → [0.5073, 0.7060]).
- Pass = G1 and G4 both pass.

## Cost

- Conservative estimate (full rendered all-217 block): 26,088 tokens × 110 calls = 2,869,680 input tokens
  × $0.042 per 1M = **$0.1205**. Actual criteria are smaller (≈ 15,013 tokens/call → ≈ $0.069).
- Output tokens: $0. Source quote (TypeSafe Models, https://docs.typesafe.ai/models, checked 2026-10-20):
  "You pay per input token. Output tokens are free." Jev 1.14 `jev-1.14.0`: "$42 / $0.042" per Btok / per Mtok.
  So the estimate with output included stays **$0.1205** (≈ $0.13 with 10% for state/instructions). Recheck the price on the run day.
- Proposed cap for 인호: $1.00. The runner skips the remaining calls once cumulative cost ≥ cap (recorded as `cap_reached`).
- **Cap stop = INVALID, not FAIL.** If any call is `cap_reached`, the whole run is INVALID and no gate verdict is given.
  At most one rerun is allowed after that, and only with 인호's fresh re-approval in a 1:1 chat (a new cap may be set then).
- Per-call accounting in raw output: `usage.input_tokens`, `usage.output_tokens`, USD, latency, HTTP status, model echoed back.

## Execution rules

- Exactly one run (the only exception is the single cap-INVALID rerun above). The runner refuses to start if the output file exists. No retries; a failed call = no attach.
- No cleanup or delete step in the run command; chain with `&&`.
- Raw output on the box only, mode 600: `/workspace/omk-eval-092/paid-all217-raw.json`. It holds ids, choices,
  probabilities and usage, no sentence text and no key. Room gets aggregates only.

## Security

- The TypeSafe key previously exposed in the room is never used for this run.
- Only the replacement key that 인호 entered via masked input in OMK's 1:1 chat is used, read at run time from env `TYPESAFE_API_KEY`.
- The key value never appears in this PREREG, in logs, in result files, or in commits.
- No new dependencies: plain `fetch` only.

## Risks

- Even 99/100 hits gives a Clopper-Pearson 95% lower bound of only **0.9455** (computed, stdlib), so a pass is weak evidence of ≥ 99% accuracy.
- The same EN set is reused a fifth time; the result is evidence for this arm only.
- The 0.6 threshold was set for a 25-candidate list; with 218 options probabilities may be lower and more items may fall below it.
