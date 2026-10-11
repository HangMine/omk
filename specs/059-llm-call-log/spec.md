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
| `effort` | `options.reasoning` sent with this request (the level name omk asked for), or `null` |
| `effortSent` | the provider wire value of `effort`: `clampThinkingLevel(model, effort)`, then `model.thinkingLevelMap?.[level] ?? level`, as the OpenAI-style providers build `reasoning_effort` (`openai-completions.ts:443`, `:622`). grok-4.7 `max`/`ultra` → `"xhigh"`; grok-4.5 `max` → `"high"`; `null` when `effort` is `null` or clamps to `off`. Computed from the same `model` object the provider gets; the request is not touched. For budget-based transports (Anthropic budget thinking, Google) it is the mapped level, not the token budget. |
| `requestedAtMs` | epoch ms when this request started (the `now` clock, `Date.now` by default); join key, see Cost |
| `responseId` | the provider's response id from the result (`AssistantMessage.responseId`, e.g. the xAI `chatcmpl` id), or `null` |
| `input`, `output`, `cacheRead`, `cacheWrite` | final `usage` of the result; `null` when no usage arrived (see `usageMissing`) |
| `costTotal` | omk's `usage.cost.total` (catalog price × omk's token counts); `null` when no usage arrived. **Not a verdict number** (see Cost) |
| `costInUsdTicks` | always `null` in this version: omk's `Usage` does not carry the raw xAI field (see Cost). Kept in the schema so a later parser change fills it without a new field |
| `usageMissing` | `true` when no usage arrived: no message (inner threw), or the message's token counts are all 0 (providers start every message at zero usage and only fill it from the final usage chunk; a real request always has prompt tokens). Then every usage and cost number above is `null`, never 0 |
| `stopReason` | result `stopReason`; without a message, `aborted` if the signal aborted, else `error` |
| `durationMs` | call start → settle |
| `gapMs` | ms since the previous call in this process ended; `null` for the first. One clock per process: see Known limits |
| `systemHash`, `toolsHash` | `systemHash` / `toolsHash` from `omk-ai/prompt-hash` (spec 051 helper, reused) |
| `messageCount` | `context.messages.length` |
| `phase`, `phaseSource` | always `null`; reserved for spec 037 so one schema covers runs before and after it |

**Spec 037 fields.** `effort` and `effortSent` above are already the level and wire value of this request after 037's wrapper and 033's cap (this log sits innermost), so 037 adds no effort-sent field of its own. `phase` and `phaseSource` are written as `null` by this spec. Spec 037 (per-phase effort, opt-in `OMK_ADAPTIVE_EFFORT=1`) fills them and adds the effort fields below through a setter in this module; with 037's flag off they are never set. A verdict script treats a missing 037 field as `null`.

| Field (037) | Value |
| --- | --- |
| `phase` | `"plan" \| "explore" \| "edit" \| "debug" \| "verify" \| "build" \| "run" \| null` |
| `phaseSource` | `"todo" \| "tool" \| null` |
| `effortGroup` | `"high"` (plan, debug, verify: the configured effort, which is the ceiling) or `"low"` (explore, edit, build, run: `high`, or the ceiling if it is below `high`, or the next level below that the model supports) |
| `effortSwitch` | `{ from, to, n }` on the call where the group changed, else `null` |
| `lowerClamped` | `true` when the low-group target sends the same provider value as the ceiling, or the model supports no level at or below it, so nothing different was sent; not counted as a switch |

037 never raises above the configured effort; it only lowers the low group (Tech Lead, 2026-10-11). The earlier `raiseClamped` field is dropped with the raise design.

**Cost.**
- Verdicts use xAI `cost_in_usd_ticks` only (1 tick = 1e-10 USD). `costTotal` is logged for reference but undercounts xAI: omk's price comes from its own token counts and leaves out reasoning tokens, which are exactly what an effort change (037) or a reasoning cap (033) moves (Bench Analyst, 2026-10-11).
- `cost_in_usd_ticks` does not survive into omk's `Usage`: the xAI models use `openai-completions` (`models.generated.ts`, `xai` → `api: "openai-completions"`), whose `parseChunkUsage` (`packages/ai/src/providers/openai-completions.ts:1051-1085`) reads only `prompt_tokens`, `completion_tokens`, `prompt_tokens_details.cached_tokens`/`cache_write_tokens` and `prompt_cache_hit_tokens`, and builds a `Usage` (`packages/ai/src/types.ts:289-304`) with no raw field. The Responses path (`openai-responses-shared.ts:502-514`) drops it the same way. No message field carries it either.
- So the ticks come from the bench adapter's `omk_usage_raw.jsonl` (one line per `/chat/completions` response: `t` = response end in epoch seconds, `dt` = seconds from response headers to end, `prompt_tokens`, `completion_tokens`, `cached_tokens`, `reasoning_tokens`, `cost_in_usd_ticks`; no response id today). Join per process in order, matching `requestedAtMs + durationMs ≈ t × 1000` and the token counts (`input + cacheRead + cacheWrite = prompt_tokens`, `cacheRead = cached_tokens`, `output = completion_tokens`). `responseId` is logged so the join becomes exact if the adapter also records the chunk `id`.
- A line with `usageMissing: true` (for example the first attempt of a 033 cap retry, aborted before the final usage chunk) has no cost in either source; a verdict computes such runs as a [lower, upper] interval, as in specs 033/034, never as 0.

5. **Privacy** (spec 042): numbers, ids, sha256 hashes and enum names only. Never prompt text, tool arguments, output, error messages, paths, URLs, headers or secrets.
6. **Best effort**: a failing write or hash never throws into the call.

## Acceptance

1. Unit (`test/llm-call-run-log.test.ts`), fake provider:
   - no `OMK_RUN_LOG_DIR` → the inner function is returned and no file exists;
   - one line per call with every field; `gapMs` `null` then the measured gap;
   - an aborted call logs exactly once with the usage that arrived; a call that throws before a stream logs once with `stopReason: "error"`, `null` usage and cost, and `usageMissing: true`;
   - a call whose usage never arrived (all-zero usage) logs `null` usage and `costTotal`, never 0, with `usageMissing: true`; `costTotal` is the result's `usage.cost.total` when usage arrived; `costInUsdTicks` is `null`;
   - `effortSent` is the wire value (grok-4.7 `max`/`ultra` → `"xhigh"`, grok-4.5 `max` → `"high"`);
   - a 033 cap retry, wired as `cap(llmCallLog(provider))`, writes two lines: the cut attempt (`effort`/`effortSent` `xhigh`, `usageMissing: true`) and the retry (`high`/`high` with its usage, cost and `responseId`);
   - a marker secret in the system prompt, tools, prompt, output and error never appears in the file;
   - the provider receives byte-identical arguments (and the same context object) with logging on and off, wired below the cap as in `createSdkProviderStream`.
2. #120 follow-up (`test/suite/prompt-cache-stability.test.ts`): with `OMK_FINISH_CHECK=always`, `OMK_TIME_BUDGET_SEC` set, two tasks and finish-check reading a fake clock that advances every turn, the full system prompt hash is identical on every call.

## Known limits

- `gapMs` is measured from one process-wide `lastCallEndAt`. When calls overlap in one process (for example in-process parallel workers, or a summary call running beside a turn), `gapMs` is measured from whichever call ended last, so it can read 0 or be shorter than the real idle time of that conversation's cache. Use it for cache-TTL analysis only on sequential calls; `requestedAtMs` and `durationMs` give the exact timeline.
- `usageMissing` relies on all-zero token counts meaning "no usage chunk". A provider that reports a real all-zero usage would be logged as missing; no provider omk ships does that for a real request.
- `effortSent` mirrors the OpenAI-style mapping; for other transports it is the mapped level name, not the exact payload (`thinking.budget_tokens` etc.).

## Not in scope

- Classifying `phase` (spec 037).
- A verdict script over `llm-call.jsonl` (Bench Analyst).
- Logging requests that bypass `createSdkProviderStream` (extension-registered custom `streamFn`s, scripted writers in tests).
