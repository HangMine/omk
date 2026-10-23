# Spec 112: `OMK_JSON_SESSION_INFO`: system prompt + tool definitions in `--mode json`

Status: draft (spec only, no code). Depends on spec 110 (ATIF export, PR #231) masking rules.

## Problem

Spec 110 Q3 found that `--mode json` carries neither the system prompt nor the tool
definitions (pinned at omk `9e03b40b77`):

- `packages/coding-agent/src/modes/print-mode.ts:198-202`: json mode writes
  `sessionManager.getHeader()` first.
- `packages/coding-agent/src/core/session-listing.ts:7-14`: `SessionHeader` is only
  `type, version, id, timestamp, cwd, parentSession`.
- `packages/coding-agent/src/modes/print-mode.ts:186-188`: then each `AgentEvent` verbatim
  (`print-mode.ts:58` adds `session_termination`).
- `packages/agent/src/types.ts:705-725` (`AgentEvent`) and
  `packages/agent/src/provider-request-types.ts:42-63` (`ProviderRequestEvent`): no tool
  schemas, no system prompt.
- Tools exist only in memory: `packages/coding-agent/src/core/agent-session.ts:2041`
  (`tools: this.agent.state.tools`). The run log holds only `systemHash` / `toolsHash`
  (`packages/coding-agent/src/core/llm-call-run-log.ts`).

So the spec 110 exporter always falls back to a hash placeholder for the system step and
omits ATIF `agent.tool_definitions` (optional, harbor `209a48a`
`src/harbor/models/trajectories/agent.py:23`).

## Change

New env flag `OMK_JSON_SESSION_INFO`, **default off**.

- **Off (unset, empty, or anything but `1`)**: no code path changes; `--mode json` stdout is
  byte-identical to main.
- **On (`1`) and `--mode json`**: emit exactly one extra line, once per process, right after
  the header line (`print-mode.ts:198-202`), before any event:

  ```json
  {"type":"omk_session_info","systemPrompt":"<string>","tools":[{"name":"...","description":"...","parameters":{...}}]}
  ```

  Only these fields. `tools[]` entries carry only `name`, `description`, `parameters` (JSON
  schema as given to the model). Nothing else (no cwd, env, model, settings).
- Other modes (text, interactive, rpc): flag ignored.
- Model input unchanged: the line is built from the same in-memory values the session
  already sends; it does not alter the system prompt, tool list, order or cache prefix.
- **Run log rule unchanged**: `appendRunLog` records keep hashes only; this spec writes
  nothing to `OMK_RUN_LOG_DIR`.
- 0 new dependencies.

## Masking

The flag writes raw text to stdout (same trust level as the existing json event stream,
which already contains prompts and tool output). Masking is done by the spec 110 exporter,
not in omk runtime: the `systemPrompt` and `tools[].description` strings go through spec 110's
masking pass (secret-named env vars, `sk-`/`xai-`/`ghp_`/`Bearer` shapes) before
`trajectory.json` is written. Mapping: `systemPrompt` → first step `source:"system"`
`message`; `tools` → `agent.tool_definitions`.

## Success criteria

1. Flag off: `--mode json` stdout byte-identical to main for a fixed fake-provider run
   (golden comparison test).
2. Flag on: exactly one `omk_session_info` line, at line index 1 (right after header), with
   exactly the keys `type, systemPrompt, tools` and per tool exactly `name, description,
   parameters`; values equal the session's system prompt and tool list.
3. Flag on: the provider request (system prompt, tools, messages) is identical to flag off
   (captured via fake stream function).
4. Run log files byte-identical (modulo `t`/`pid`) between on and off.
5. Researcher criterion: after spec 110 masking of a flag-on stream seeded with fake
   `TYPESAFE_API_KEY` and key-shaped strings in the system prompt, a rescan of the exported
   trajectory finds 0 hits.

## Test plan

Unit tests only, no A/B, no live model:
- print-mode json test with fake stream: off golden, on line position/shape, on/off request equality.
- run-log unchanged test.
- spec 110 exporter test (in that PR's suite): consumes `omk_session_info`, masks, rescan = 0.

## Out of scope

No change to run-log content, session files, rpc/interactive modes, or the model request;
no ATIF exporter code (spec 110); no paid runs.

## Open questions

1. Workers (`OMK_RUN_LOG_ROLE=worker`): do subagent processes run in `--mode json` so the flag
   reaches them, or does the lead need to forward it for spec 110's `subagent_trajectories`?
2. If extensions/skills change the system prompt or tools mid-run, emit once (start state) or
   re-emit on change? This spec says once; confirm a change is rare enough to record only as
   `extra.omk` hash drift in spec 110.
3. Where exactly the resolved system prompt is available before the first event (session
   construction vs first provider request) — confirm in implementation.
