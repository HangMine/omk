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
| runner | `specs/092-hub-router-skills/tools/paid_all217_run.ts` sha256 `fd652a0a1019b25e55d22fed7c29a3b9a45f311bdb09e47d4815434f90ee9952`; tests `paid_all217_run.test.ts` sha256 `63c41e3542c1bb6f0094c7d8d8a83a0daaa0f7cf1f23f9ba29d377aa0ffa8051` |
| harness commit | `8965371547bf57e2ae56873b2895998caaacd43e` (branch `spec/092-paid-prereg`; template, runner, tests, diff scan) |
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

- Before any API call the runner checks sha256 of catalog, labels and template against the values above and aborts on any mismatch.
- Retry: 0 times. A failed call (timeout, HTTP or parse error) is recorded once as no attach.
- Cap check before each call: cumulative cost + estimated next-call cost (the larger of body chars/4 and the largest billed
  input so far) must stay ≤ cap, else the call is skipped as `cap_reached`. Overshoot is at most one call (only the first call can be underestimated).
- Cap stop = INVALID, not FAIL; at most one rerun, only with 인호's fresh 1:1 re-approval.
- Failed-call billing: after the run, check on the TypeSafe dashboard whether failed calls were billed, and record it.
- Offline tests (`node --experimental-strip-types --test tools/paid_all217_run.test.ts`, 8/8 pass, fake fetch, no network) cover:
  sha mismatch refuses with zero calls, no calls after cap, request body has no `gold`/`id` field, existing output refuses,
  missing key/cap refuses, no retry, key never leaks (fake key `TEST_SECRET_KEY_123`; HTTP 200/401/429/500 and a network error that embeds the headers: the key and `Authorization` never appear in stdout, stderr, the output file, or thrown messages/stacks; failed calls are logged only as fixed labels `timeout`/`network`), and parsing → hit / miss / no attach / false attach, including the threshold boundary (p = 0.6 attaches, p = 0.5999 does not).

- Exactly one run (the only exception is the single cap-INVALID rerun above). The runner refuses to start if the output file exists. No retries; a failed call = no attach.
- No cleanup or delete step in the run command; chain with `&&`.
- Raw output on the box only, mode 600: `/workspace/omk-eval-092/paid-all217-raw.json`. It holds ids, choices,
  probabilities and usage, no sentence text and no key. Room gets aggregates only.

## Security

- The TypeSafe key previously exposed in the room is never used for this run.
- Only the replacement key that 인호 entered via masked input in OMK's 1:1 chat is used, read at run time from env `TYPESAFE_API_KEY`.
- The key value never appears in this PREREG, in logs, in result files, or in commits.
- 키는 박스 로컬 env에만 두고 저장소에는 넣지 않는다.
- The runner reads the key only from env `TYPESAFE_API_KEY` (`tools/paid_all217_run.ts` line 91:
  `key: process.env.TYPESAFE_API_KEY ?? ""`). It does not read `auth.json`, `/jev` settings, or any other file for the key.
- **Mandatory precondition before the paid run:** 인호 confirms that the env holds the new replacement key
  (the old exposed key is revoked and replaced). Without this confirmation the run does not start.
- Diff scan: `tools/scan_key_in_diff.py` (sha256 `56420df7260ea77aa54a7e279e8279b9a2a47e133fef8ab86070347b58bb9023`) reads the key from env at run time and counts occurrences of
  the full key and of the literal key marker in `git diff a4d150974c..HEAD` and commit messages. It prints counts only and
  stores no key, prefix or hash. Must report 0/0 before any push.
- No new dependencies: plain `fetch` only.

## Risks

- Even 99/100 hits gives a Clopper-Pearson 95% lower bound of only **0.9455** (computed, stdlib), so a pass is weak evidence of ≥ 99% accuracy.
- The same EN set is reused a fifth time; the result is evidence for this arm only.
- The 0.6 threshold was set for a 25-candidate list; with 218 options probabilities may be lower and more items may fall below it.
