# Spec: behavior-neutral split of `agent-session.ts`

Status: draft (step 1, doc only, no code)
Prerequisite for: spec 104 phase 2 (wire `OMK_REQUIRED_TOOLS` into real sessions; phase 1 merged at `0054023769`).

## 1. Problem

`packages/coding-agent/src/core/agent-session.ts` is 5622 physical lines (4239 pure LOC, its
`scripts/module-size-baseline.json` entry). The module-size check (`scripts/check-module-size.mjs`,
ceiling 250 pure LOC) only lets a baselined file shrink, so any 104 wiring added there must be paid for
by removing lines elsewhere in the same file. Phase 1 states the gap directly: nothing supplies
`requiredTools` to `SessionTurnAdmission` yet ("agent-session.ts wiring is a later PR").

The 104 wiring point today sits inside the `AgentSession` constructor (about lines 895-910):
`new SessionTurnAdmission({ model, state, contextWindow, compactionSettings, latestCompactionTimestamp,
toolGroup, compact, notify })` plus `agent.prepareTools = ... fitTools(...)`. Phase 2 adds one host
callback, `requiredTools: () => RequiredToolContract | undefined` (`session-turn-admission.ts:38`),
fed from the approved acceptance contract. Admission runs at prompt preflight
(`await this._turnAdmission.admit(messages, ...)`, about line 2686).

## 2. Goal

Move cohesive sections out of `agent-session.ts` into new modules so that the 104 wiring lands in a
small new module, without changing any behavior. A later, separate PR does the wiring.

## 3. Proposed extraction (approximate physical lines from `origin/main` `3def31a31e`)

| # | New module (`src/core/`) | Moves from `agent-session.ts` | ~lines |
|---|---|---|---|
| 1 | `agent-session-turn-admission-host.ts` | constructor block that builds the `SessionTurnAdmission` host object and sets `agent.prepareTools` (as a `createTurnAdmission(session)` factory). **104 wiring point.** | ~40 |
| 2 | `agent-session-compaction.ts` | "Compaction" section: `_beginCompactionTransaction`, `_pendingToolResultReserve`, `_runtimeCompactionDecision`, `_recordCompactionCommitForHysteresis`, `_summarizeCompaction`, `compact`, `abortCompaction`, `_effectiveTurnContextWindow`, `_checkCompaction`, `_runAutoCompaction` (about 3477-4270) | ~790 |
| 3 | `agent-session-thinking.ts` | "Thinking Level Management": `_applyAutoThinkingLevelForTurn`, `_appendRouterFeedback`, `_getReasoningRouterBiasSnapshot`, `_getAdaptorchHint`, `_getThinkingLevelForModelSwitch` (about 3108-3455) | ~345 |
| 4 | `agent-session-retry.ts` | "Auto-Retry": `_summarizationRetryCallbacks`, `_maybeRotateModelRoutes`, `_prepareRetry` (about 4823-5078) | ~255 |
| 5 | `agent-session-tree.ts` | "Tree Navigation" + stats/export: `navigateTree`, `getUserMessagesForForking`, `getSessionStats`, `exportToHtml` (about 5147-5562) | ~415 |
| 6 | `agent-session-events.ts` | "Event Subscription" helpers: `_emit`, `_willRetryAfterAgentEnd`, `_findLastAssistantMessage`, `_emitExtensionEvent`, `_recordToolMetric` (about 1304-1640) | ~335 |
| 7 | `agent-session-resources.ts` | MCP/extension resources and runtime: `extendResourcesFromExtensions`, `getExtensionSourceLabel`, `_refreshCurrentModelFromRegistry`, `attachMcpServers`, `mcpProjectTrustReport`, `mcpCheckHealth`, `_buildRuntime`, `_reload` (about 4275-4822) | ~545 |

Expected remainder in `agent-session.ts`: about 2900 physical lines (prompting, model management,
state accessors, public class shell). Every new module must be at or under 250 pure LOC; where a row
above exceeds it (2, 5, 7), that row is split further along existing method boundaries in the code
PR (for example compaction into `-compaction-decision.ts` and `-compaction-run.ts`). No new module is
added to `module-size-baseline.json`.

Shape: the public methods stay on `AgentSession` as one-line delegates with identical signatures;
the moved bodies become functions taking the session (or a narrow host interface) as first argument,
the same pattern `SessionTurnAdmission` already uses. Private fields stay on the class.

## 4. Rules

1. **Mechanical move only.** No logic change, no reordering of awaits, side effects or emitted events,
   no renamed identifiers beyond `this.` -> `session.` at moved call sites. Comments move with code.
2. **Identical public surface.** Exports of `agent-session.ts` (classes, types, `export type {...}`
   re-exports) are unchanged; a `.d.ts` diff of the built package is empty for `agent-session`.
3. **Baselines only go down.** `agent-session.ts` baseline is lowered by `--update`; no entry is
   raised or added in `module-size-baseline.json` or `import-cycle-baseline.json`. New modules must
   not join an import cycle (they import types from `agent-session.ts` with `import type` only).
4. **0 new dependencies.**
5. One extraction per commit so each diff reviews as a move (`git diff --color-moved`).

## 5. Proof of neutrality

- Full `npm test` and `test/suite/` pass with **zero test file changes**.
- `npm run check` passes (module size, import cycles, dep tree, Biome, types).
- **First-request byte equality:** a harness script runs a fixed set of scenarios (plain prompt,
  prompt with MCP tools over budget, prompt forcing compaction, retry after a transient error) against
  a recording faux provider on `origin/main` and on the split branch, with a fixed clock and session id,
  and compares the serialized first request payload (system prompt, cache boundary, tools, messages)
  byte for byte. It also compares the run trace/summary written by the 103b golden scenario. Any diff
  fails the PR. The script lives under `scripts/` or `test/` and is added in the first code commit,
  before any move, so its baseline output is captured from unchanged code.

## 6. Out of scope

The 104 `requiredTools` wiring itself, any behavior or flag change, any test edit.

## 7. Rollback

Pure moves: revert the PR.
