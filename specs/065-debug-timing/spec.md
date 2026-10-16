# Spec 065: opt-in per-phase timing log for UI lag (default off)

Status: implemented locally, waiting for Tech Lead review. Target 1.4.3 (diagnostics only). Base: origin/main `e28c260f75`.
Independent of 062/063: it hooks only methods that exist on main.

## How to turn it on (for 근빈)
```
OMK_TIMING=1 omk                                   # log goes to $TMPDIR/omk-timing-<pid>.log
OMK_TIMING=1 OMK_TIMING_FILE=~/omk-timing.log omk  # or pick the file
tail -f ~/omk-timing.log                           # in another terminal
```
This reuses the existing `OMK_TIMING=1` switch (`core/timings.ts`, startup timings on stderr). The new phase lines go
to a file only, never to stdout/stderr, so the TUI is not corrupted. Nothing else reads `OMK_TIMING_FILE`.

## What is logged (one line per span; `x=ms` is a phase's own duration, `x@ms` is time since span start)
- `model.open`: `/model` selector `loadModels` → first TUI frame after it. Phases: `registry.refresh` with
  `loadCustomModels` / `loadBuiltInModels` / `mergeCustomModels` inside it, `auth.getAvailable`, and
  `firstFrame(render=…)`. OAuth token refresh and provider model fetches are not on this path on main, so they have
  no phase.
- `model.apply`: `AgentSession.setModel`. Phases: `rebuildSystemPrompt`, `session.appendModelChange` (durable JSONL
  write), `settings.write`, `extensions.modelSelect`.
- `enter`: `AgentSession.prompt` → the request leaving `budget-stream` (`request.sent`). Phases: `checkCompaction`,
  `skills.turn`, `extensions.beforeAgentStart`, `checkProjectedCompaction`, `admit`, `journal.start`,
  `session.appendMessage`, `streamFn.entered@`, `requestAdmission.done@` (request build/admission check).
  A prompt that sends no request (slash command, abort) ends as `no-request`.

Sample (fake provider, test run; the timestamp is UTC):
```
2026-10-16T17:57:30.366Z model.open total=13.9ms firstFrame(render=0.8ms) registry.loadCustomModels=0.6 registry.loadBuiltInModels=0.3 registry.mergeCustomModels=0.1 registry.refresh=1.1 auth.getAvailable=3.7
2026-10-16T17:57:30.407Z model.apply total=9.1ms ok rebuildSystemPrompt=0.5 session.appendModelChange=7.1 settings.write=0.1 extensions.modelSelect=1.0
2026-10-16T17:57:30.423Z enter total=16.6ms request.sent skills.turn=0.1 extensions.beforeAgentStart=0.4 checkProjectedCompaction=0.3 admit=1.3 journal.start=6.7 session.appendMessage=1.8 streamFn.entered@16.1 requestAdmission.done@16.6
```
Only method names and durations are written. No prompt text, model output, keys or paths.

## Design / zero behavior change when off
- `main.ts` installs the hooks only when `OMK_TIMING === "1"`, via a dynamic import of `core/debug-timing-hooks.ts`.
  Off means the module is not loaded and no prototype is touched.
- The hooks wrap prototype methods and call through with the same arguments, `this` and return value (promises are
  passed through with `finally`/`then` that re-throw). Diagnostics errors are swallowed when the file is written.
- `budget-stream.ts` calls `timingMark` / `timingEnd` directly. When off, that is a lookup in an empty Map.
- Not installed for SDK embedders (only the `omk` CLI entry).

## Tests (`test/spec065-debug-timing.test.ts`)
- off: `installDebugTimingHooks` returns false, the `AgentSession.prompt` and `ModelSelectorComponent.loadModels`
  prototypes are unchanged after a full open/apply/prompt drive, and no log file exists.
- on: the same drive with a fake OpenAI-compatible server writes `model.open` (firstFrame, refresh, getAvailable),
  `model.apply` (appendModelChange, settings.write) and `enter` (request.sent, admit, appendMessage, streamFn.entered),
  and the log does not contain the fake API key.

## Limits
- Spans live in a process-global Map (`core/debug-timing.ts` `active`), so this is for the TUI's single session only. Concurrent sessions in one process (SDK/RPC hosting several) would mix records.
- Hooked method names are listed in `debugTimingHookTargets()`; a test asserts each exists on current code, so a rename fails CI instead of silently dropping a phase.
