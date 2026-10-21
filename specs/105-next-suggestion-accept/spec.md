# 105 — next-suggestion Tab accept: measurement spec

Status: draft (spec + measurement only before the 10/23 12:00 KST freeze; behavior changes after)
Base: main `7cd26ee5fa`
Depends on: 103, 103b, accept-trace (`OMK_NEXT_SUGGESTIONS_ACCEPT_TRACE`, default off)

## 1. Scope
- Baseline behavior (unchanged): Tab fills the whole suggestion into an empty editor when the autocomplete menu is closed. Enter keeps its current behavior (dismisses the suggestion); it never accepts, to avoid unintended sends.
- Out of scope before the freeze: word-level partial accept (`OMK_NEXT_SUGGESTIONS_PARTIAL_ACCEPT`), end-of-turn pre-generation, repo-state context. Each is A/B'd one at a time only after the baseline below exists.
- Editor Tab completion (paths, slash commands, `@`) is on hold and tracked separately.

## 2. Data (accept-trace)
One record per suggestion actually shown, in `.omk/metrics/suggestion-outcomes.jsonl`. No suggestion or prompt text is ever written (0 bytes).
- `accepted`, `msToAccept`
- `sentAs`: `exact | edited | cleared | abandoned`
  - `cleared`: accepted, then the editor was emptied.
  - `abandoned`: accepted, never sent (session ended or replaced by the next suggestion).
- `sentVia`: `prompt | steer | followUp`, taken from the actual dispatch branch (`_queueSteer`, `_queueFollowUp`, `deferPrompt`), not from message order. A command handled by an extension or input hook is not a send and writes no record.
- Edit-distance ratio bucket: `0, <=0.1, <=0.3, <=0.6, >0.6`
- Dismiss reason when not accepted: `typed_over | new_turn | other`
- Timestamps: `settled, quotaChecked, shown, decided`
- `sessionHash`: salted per install, not reversible to the session id.
- At 10 MB the writer appends one `cap_reached` record and stops; any analysis must report whether the cap was hit.
- `parentTurnIndex` follows main's `turnsInRun` behavior and is NOT used in any verdict metric.

## 3. Metrics
- Primary: adoption rate = accepted / shown (denominator is shown, not generated).
- Secondary:
  - Immediate-revert rate = (`cleared` + edit bucket `>0.6`) / accepted. `abandoned` is reported separately and not counted as a revert.
  - Latency from turn end (`settled`) to `shown`, p50/p95.
- Every rate is reported with a 95% CI computed two ways: per suggestion and clustered by `sessionHash`. If they disagree, the session-clustered one governs.

## 4. Baseline protocol
1. Free: fake-model latency p50/p95 and trace correctness (flag-off byte-equivalence via the #194 harness). Adoption cannot be measured this way, because a human decides on Tab.
2. Real use: after the accept-trace PR merges, the team works normally with `OMK_NEXT_SUGGESTIONS=1` and `OMK_NEXT_SUGGESTIONS_ACCEPT_TRACE=1`. Only aggregates leave the box; raw files stay local and are never committed.
3. Minimum sample before any verdict: >= 50 shown suggestions from >= 5 sessions, with no single session > 40% of shown suggestions.

## 5. Verdict rules (fixed before measurement)
- Numeric thresholds for adoption and revert are written into a PREREG commit after the minimum sample is reached and before any A/B arm is run. No threshold is chosen from A/B data.
- Each later change (partial accept, pre-generation, repo state) is a separate A/B against this baseline. It passes only if the session-clustered 95% CI of the adoption difference excludes 0 in the favorable direction, and the revert rate does not rise beyond the PREREG margin.

## 6. Open questions
1. All three `sentVia` paths count as sent in the primary metric; adoption is also reported per path, because sends while the agent is running (`steer`, `followUp`) differ from idle `prompt` sends.
2. The salt storage location (proposed `.omk/` with mode 0600).

## 7. Improvement candidates (after the freeze, one A/B each against the section 4 baseline)
Primary metric for these: exact-send rate (`accepted` with `sentAs: exact`, over shown). Guard metric: show rate (shown / settled turns). Latency p50/p95 from `settled` to `shown` is reported for each arm.
1. Metacognitive next-prompt prediction (`OMK_NEXT_SUGGESTIONS_METACON`): the input adds work state (last tool results, failing checks/tests, remaining goal or todos), compared with the current generator. Note: in 058, metacon versus bm25 differed only at noise level, so this stays default off unless the A/B passes.
2. Abstain when unsure: the model also emits a confidence score, and suggestions below a PREREG threshold are hidden. Passes only if the exact-send rate rises and the show rate does not fall below a PREREG floor.
For non-accepted suggestions, the edit-distance bucket between the suggestion and the prompt actually sent may be recorded (no text), to separate "right intent, different wording" from "wrong intent".
Each candidate adds model calls or tokens, so a paid A/B needs 인호's cost cap first.
