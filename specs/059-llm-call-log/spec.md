---
description: "One llm-call.jsonl run-log line per provider request (model, effort, tokens, cache, timing, prefix hashes) when OMK_RUN_LOG_DIR is set"
---

# Feature Specification: `llm-call.jsonl` per-request run log

**Specification ID**: `059-llm-call-log`
**Feature Branch**: `feat/llm-call-log`
**Created**: 2026-10-11
**Status**: Draft
**Constitution**: [specs/constitution.md](../constitution.md)
**Input**: Tech Lead decision for the 1.5.0 plan: spec 037 (per-phase effort) changes the reasoning effort mid-run, and we need per-call evidence of whether that breaks the provider prompt cache before 037 is turned on. Builds on spec 042 (run log dir) and spec 051 (prefix hashes, PR #117).
**OMK Preset**: `omk`

## CLI Harness Target Impact

**Classification**: diagnostics only. No flag besides `OMK_RUN_LOG_DIR`; no model-visible change.

| Dimension | Baseline (main `b60d3c4`) | Acceptance target | Regression floor | Verification command | Evidence artifact |
| --- | --- | --- | --- | --- | --- |
| Per-call evidence | Bench runs (`--no-session --mode json`) leave no per-request usage, effort or cache numbers anywhere. | With `OMK_RUN_LOG_DIR` set, exactly one `llm-call.jsonl` line per provider request, aborted and failed requests included. | `OMK_RUN_LOG_DIR` unset: no wrapper, no hashing, no file. Request bytes identical with the log on and off. | `npx vitest run test/llm-call-run-log.test.ts test/suite/prompt-cache-stability.test.ts` in `packages/coding-agent` | those files |

## Problem

To judge 037 (and any change touching the request prefix) we need, per request: which effort was sent, whether the cache was read or rewritten, how long the request took and how long the run waited between requests (provider cache TTLs), and whether the system prompt or tool list changed. Spec 042 gives a run-log directory; spec 051 gives the prefix hashes; nothing joins them per request.

## Design

New module `packages/coding-agent/src/core/llm-call-run-log.ts`:

```ts
createLlmCallRunLogStreamFn(inner: StreamFn, options?: { env?; now? }) → StreamFn
```

1. **Where**: `createSdkProviderStream` (`sdk-provider-stream.ts`) wraps the provider stream with it, **below** spec 033's reasoning cap: `cap(llmCallLog(provider))`. Every agent turn, compaction and summary call uses `agent.streamFn`, which is this stream, so each real provider request (a cap retry included) gets its own line with the effort it was actually sent with. The run budget wrapper (`wrapBudgetStream`) stays outside, unchanged.
2. **Off**: with `OMK_RUN_LOG_DIR` unset or blank when the stream is created, `inner` is returned as is. No wrapper, no hashing, no clock reads.
3. **On**: the wrapper reads `model`, `context` and `options` and passes the same objects on. It never consumes the returned stream; it waits on `stream.result()`, as `wrapBudgetStream` does. When the call settles (or `inner` throws), it appends one line via `appendRunLog("llm-call", record)`, which adds `t`, `elapsedFraction`, `pid` and `role`.
4. **Record**:

| Field | Value |
| --- | --- |
| `provider`, `model` | `model.provider`, `model.id` of the request |
| `effort` | `options.reasoning` sent with this request, or `null` |
| `input`, `output`, `cacheRead`, `cacheWrite` | final `usage` of the result; `null` when no message arrived (inner threw) |
| `stopReason` | result `stopReason`; without a message, `aborted` if the signal aborted, else `error` |
| `durationMs` | call start → settle |
| `gapMs` | ms since the previous call in this process ended; `null` for the first |
| `systemHash`, `toolsHash` | `systemHash` / `toolsHash` from `omk-ai/prompt-hash` (spec 051 helper, reused) |
| `messageCount` | `context.messages.length` |
| `phase`, `phaseSource` | always `null`; reserved for spec 037 so one schema covers runs before and after it |

**Spec 037 fields.** `phase` and `phaseSource` are written as `null` by this spec. Spec 037 (per-phase effort, opt-in `OMK_ADAPTIVE_EFFORT=1`) fills them and adds the effort fields below through a setter in this module; with 037's flag off they are never set. A verdict script treats a missing 037 field as `null`.

| Field (037) | Value |
| --- | --- |
| `phase` | `"plan" \| "explore" \| "edit" \| "debug" \| "verify" \| "build" \| "run" \| null` |
| `phaseSource` | `"todo" \| "tool" \| null` |
| `effortSent` | not a separate field: `effort` above is already the level sent with this request (below 037's wrapper and 033's cap) |
| `effortGroup` | `"high"` (plan, debug, verify: the configured effort, which is the ceiling) or `"low"` (explore, edit, build, run: `high`, or the ceiling if it is below `high`, or the next level below that the model supports) |
| `effortSwitch` | `{ from, to, n }` on the call where the group changed, else `null` |
| `lowerClamped` | `true` when the low-group target sends the same provider value as the ceiling, or the model supports no level at or below it, so nothing different was sent; not counted as a switch |

037 never raises above the configured effort; it only lowers the low group (Tech Lead, 2026-10-11). The earlier `raiseClamped` field is dropped with the raise design.

5. **Privacy** (spec 042): numbers, ids, sha256 hashes and enum names only. Never prompt text, tool arguments, output, error messages, paths, URLs, headers or secrets.
6. **Best effort**: a failing write or hash never throws into the call.

## Acceptance

1. Unit (`test/llm-call-run-log.test.ts`), fake provider:
   - no `OMK_RUN_LOG_DIR` → the inner function is returned and no file exists;
   - one line per call with every field; `gapMs` `null` then the measured gap;
   - an aborted call logs exactly once with the usage that arrived; a call that throws before a stream logs once with `stopReason: "error"` and `null` usage;
   - a marker secret in the system prompt, tools, prompt, output and error never appears in the file;
   - the provider receives byte-identical arguments (and the same context object) with logging on and off, wired below the cap as in `createSdkProviderStream`.
2. #120 follow-up (`test/suite/prompt-cache-stability.test.ts`): with `OMK_FINISH_CHECK=always`, `OMK_TIME_BUDGET_SEC` set, two tasks and finish-check reading a fake clock that advances every turn, the full system prompt hash is identical on every call.

## Not in scope

- Classifying `phase` (spec 037).
- A verdict script over `llm-call.jsonl` (Bench Analyst).
- Logging requests that bypass `createSdkProviderStream` (extension-registered custom `streamFn`s, scripted writers in tests).
