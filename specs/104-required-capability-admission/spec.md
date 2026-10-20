# Spec 104 — required-tool contract in turn admission; compaction cost observation

Status: draft (spec only, no implementation)
Base: `origin/main` @ `e898c19e44`. All `file:line` refs are `e898c19e44`, under `packages/coding-agent/`.
Source: 인호's review, priority F / section 6.

## 1. Problem (verified in code)

1. **MCP servers are withheld whole, largest first, with no notion of "required".** `SessionTurnAdmission.fitTools` computes a schema budget and calls `fitToolSchemas` (`src/core/session-turn-admission.ts:52-90`), which withholds whole groups largest-first until schemas fit (`src/core/tool-schema-budget.ts:42-56`). Group = MCP server (`src/core/agent-session.ts:902`); ungrouped (built-in) tools are always sent (`tool-schema-budget.ts:45-46`). `SessionTurnAdmissionHost` (`session-turn-admission.ts:17-29`) has no required-capability input.
2. **Withholding only notifies.** `announce` emits a UI notice (`session-turn-admission.ts:116-125`); nothing reaches completion/task_result. A task whose acceptance needs a browser-verification MCP tool can have that server withheld and still "complete".
3. **Re-fit is keyed by content.** The fit is reused only while `admissionKey` (provider, model, window, ceiling, settings, system prompt, serialized schemas, group map, counter id/epoch) matches (`session-turn-admission.ts:65-77`), and the counter epoch increments every `admit` (`:93-97`). So any change in the tool set already forces a re-fit on the next request; a revoked tool absent from `tools` is not sent. 104 must keep that property.
4. **Compaction decision is threshold-only.** `shouldCompact` compares context tokens to a headroom trigger (`src/core/compaction/compaction-headroom.ts:133-136`); no cost of "continue" vs "compact" is recorded.

## 2. Proposed change

Flag: `OMK_REQUIRED_TOOLS=1` (default off). Off ⇒ byte-identical requests and identical notices to `e898c19e44`.

### 2.1 Required-tool contract
- `RequiredToolContract { readonly taskSegmentId: string; readonly tools: ReadonlySet<string>; readonly source: "acceptance" | "user" | "skill" }`. Sources: the approved acceptance contract (099 receipt owner) and explicit user/skill declarations. No inference from prompt text.
- Host gains `requiredTools: () => RequiredToolContract | undefined` (evaluated at call time like other accessors).
- In `fitTools`: groups containing a required tool are **never** passed to `fitToolSchemas` as withholdable (pinned like ungrouped tools). The required set is part of `admissionKey` so a contract change re-fits.
- If pinning required groups still exceeds the input ceiling after the existing single compaction recovery (`admit`, `:93-114`): the turn is rejected with `RequiredCapabilityUnavailable { missing: string[] }` instead of silently dropping them.
- A required tool that is not present at all (server down, permission revoked) ⇒ same error.

### 2.2 Outcome
- `RequiredCapabilityUnavailable` is published as task_result `insufficient/required_capability_missing` (reuses spec 100 projection; new reason) and blocks `acceptance.complete()` for that segment. It can **never** produce `complete`.

### 2.3 Stability within a task segment
- Within one `taskSegmentId`, the sent tool list keeps its order and schemas (already canonical via `serializePromptToolSchemas`, `session-turn-admission.ts:74`); optional groups withheld at segment start stay withheld for the segment unless the budget frees (avoids churn).
- **Additions** of a required tool and **permission revocations** apply on the very next request: revocation removes the tool from `state.tools` ⇒ new key ⇒ re-fit (§1.3). If the revoked tool is required ⇒ `required_capability_missing` immediately. Cache preservation never keeps a revoked tool or a stale schema.

### 2.4 Compaction: observe-only
Behind `OMK_COMPACTION_COST_OBSERVE=1` (default off; logging only, no model-behavior change). At each `shouldCompact` evaluation in the safe band (below trigger, above a reserve), record one trace line:
- `continueCost` = estimated remaining input cost of the next request at current size with current cache read/write split (normalized usage, see 103 §2.3);
- `compactCost` = summary-call estimate + one cache rewrite of the post-summary prefix + next-request cost after summary;
- plus `decision` actually taken by the unchanged policy. No raw text; metadata only. Input ceiling, output reserve and verification budget always take precedence; this spec changes no policy.

## 3. Deterministic tests
1. Flag off: request bytes and notices identical to `e898c19e44` for an over-budget MCP set.
2. Required tool in the largest group: that group stays; the next-largest optional group is withheld instead.
3. Required groups alone exceed the ceiling after one compaction ⇒ `RequiredCapabilityUnavailable`, task_result `insufficient/required_capability_missing`, `complete()` refused; never `completed`.
4. **Revoked permission takes effect at once**: tool present on request N, revoked between N and N+1 ⇒ request N+1 does not carry it (asserted on provider payload), and if required ⇒ `required_capability_missing` before request N+1 is sent.
5. Required tool added mid-segment ⇒ present on the next request.
6. Within a segment with no changes: tool names/order/schema bytes identical across 3 requests.
7. Contract change alone re-fits (key includes required set).
8. Compaction observe flag: one metadata line per evaluation, no prompt/payload change, decision identical to flag-off run.

## 4. Flags / deps / rollback
- `OMK_REQUIRED_TOOLS` (default off; changes which tools a model sees), `OMK_COMPACTION_COST_OBSERVE` (default off; logging only). New dependencies: 0.
- Rollback: unset flags; revert is confined to session-turn-admission.ts, tool-schema-budget call, one task_result reason, one trace line.
- Default-on for `OMK_REQUIRED_TOOLS`: after tests pass, decided by Tech Lead with the same rule as 103 §6 (95% CI upper bound of per-verified-task cost change < 0 is not required here since it is a correctness guard; required: zero false completions and success drop ≤ 5 pp on paired tasks). Paid runs only after 인호 posts a cost cap.

## 5. Open questions
1. Which acceptance contracts declare required tools first (browser verification only, or any MCP-backed check)? Proposal: only those whose approved command names an MCP tool.
