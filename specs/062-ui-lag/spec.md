# Spec 062: UI lag at Enter and model selection (measurement + plan)

Status: DRAFT, waiting for Tech Lead approval. Measurement only. No product code changed.
Base: origin/main `e28c260f75`. Node 22 (`~/.local/node22`), dist build, `OMK_TRUST_PROJECT=0`, fake OpenAI-compatible
provider in-process (no real keys), file-backed session (`SessionManager.create`), 20 measured runs + 2 warmups.
No other bench was running (ps checked). load1 was 6.9–7.8 on 8 cores, so the box was busy; read absolute ms with that in mind.

## Harness
```
export PATH=~/.local/node22/bin:$PATH OMK_TRUST_PROJECT=0
cd specs/062-ui-lag/bench
node lag-bench.mjs --worktree <wt> --size small|large --providers 10 --models 50 --runs 20 --out results/x.json
PROF=prof/enter-large.cpuprofile node lag-bench.mjs --worktree <wt> --size large --providers 10 --models 50 --runs 20
node profsum.mjs prof/enter-large.cpuprofile
```
- small = 2 pairs of history. large = 200 user/assistant pairs of ~4 KB each (~1.6 MB of text, ~400k tokens at chars/4), JSONL on disk.
- Enter→request = `session.prompt()` call → the fake server gets the request. This counts only our code; the model does not run.
- Selector: `ModelSelectorComponent` ctor → models loaded → `render(120)`. Filtering is timed per keystroke (7 keys, each with a render). Apply = `session.setModel()`.
- Segment timers wrap private methods on the instance. The CPU profile starts after seeding, so it covers only the measured turns.

## Results (p50 / p90 ms)
| scenario | Enter→request | preflight (prompt→_runAgentPrompt) | user-msg append | admit() |
|---|---|---|---|---|
| small, 1×5 models | 20.7 / 29.2 | 2.0 / 2.6 | 3.3 / 6.7 | 0.9 / 1.1 |
| small, 10×50 | 23.2 / 37.2 | 2.2 / 3.3 | 3.7 / 5.7 | 0.9 / 1.3 |
| large, 1×5 | 94.6 / 110.0 | 19.9 / 27.8 | 16.8 / 21.4 | 18.3 / 25.9 |
| large, 10×50 | 93.1 / 108.7 | 20.3 / 28.1 | 17.4 / 20.1 | 18.7 / 26.3 |

| selector | 1×5 models | 10×50 models |
|---|---|---|
| open→rendered | 2.7 / 5.0 | 12.8 / 16.8 |
| of which `modelRegistry.refresh()` | 0.9 / 1.3 | 11.4 / 12.3 |
| filter keystroke + render | 0.15 / 0.21 | 0.41 / 0.73 |
| setModel apply (small session) | 5.3 / 7.8 | 5.5 / 7.1 |
| setModel apply (large session) | 17.5 / 24.6 | 17.7 / 23.8 |
| of which `appendModelChange` (large) | 18.7 / 25.8 | 19.9 / 32.0 |

Enter→request grows with session length (about 21 → 94 ms) and does not grow with model count. Selector open grows with
model count (refresh). Selector apply grows with session length (durable append).

## Hotspots, ranked (large session, per turn; CPU profile totals / 22 turns plus the timers)
| # | where (src) | ms/turn | why |
|---|---|---|---|
| H1 | `core/session-manager.ts:858` `_assertAcceptedDurableHead` → `loadEntriesFromFile` + `session-file-head.ts:50` `readSessionFileDurableMetadata` (sha256 over the whole file) | ~17 per append (user-msg append happens before the request; `appendModelChange` in setModel too) | Every append rereads, reparses and rehashes the whole JSONL under a sync lock: O(file size) per write. |
| H2 | `core/budget-stream.ts:16` → `core/request-context-admission.ts:38` `check` → `projectRequestForAdmission` + `countTextParts` | ~26 | Re-estimates tokens for the full request at send time, after admit() already did the same work. |
| H3 | `core/session-turn-admission.ts:93` `admit` → `prompt-budget.ts:203` `estimateContextInputTokens` → `text-token-estimate.ts:43` `countCharClasses` | ~19 (p90 26) | Full-history char-class token estimate on every turn. Confirms the room hypothesis. `_checkProjectedCompaction` is cheap (0.2 ms) because it uses recorded usage. |
| H4 | `core/run-journal-store.ts:282` `start` → `commit` (durable lock + fsync) | ~11 | Sync durable journal write before the request. |
| H5 | durable lock acquire/release (`durable-file-lock-storage.ts`, `fsyncDirectorySync`) inside H1/H4 | part of H1/H4 | Several fsyncs per turn, all sync on the main thread. |
| H6 | `components/model-selector.ts:186` `loadModels` → `model-registry.ts:318` `refresh()` | 11.4 with 500 models | Rereads models.json, resets API/OAuth providers and re-merges every time the selector opens. |
| — | provider serialization (`messages.ts` stringify, openai encoder) | ~9 | Inherent. Not a target. |

The selector numbers are modest (≤17 ms p90). The lag users see on model select is more likely:
(a) setModel → H1 in long sessions, (b) the follow-up `showThinkingSelector()` re-render, (c) a TUI re-render of a long
chat. (b) and (c) are NOT measured here; that is a follow-up with the TUI render harness. Library Scout is checking
skills/settings reload on every Enter (omk-scout-mem). I did not see skills or settings reloads in this profile:
`promptSkillFreeze.turn` was 0.04 ms and `setDefaultModelAndProvider` 0.1 ms.

## Proposed fixes (expected savings are estimates from the segments above, not A/B results)
| fix | target | expected saving (large) | default behavior change? |
|---|---|---|---|
| F1 Incremental durable head: keep (bytes, recordCount, running sha256 state, generation) in memory after our own append. On the next append, fstat and verify size/generation, then hash only the bytes appended since. Fall back to a full reread on any mismatch. | H1 | ~15 ms per append (Enter and setModel) | No. Same stale-write detection; foreign writes still change size/ino/ctime. Needs a careful review because this is the durability guard. |
| F2 Per-message token-estimate cache (WeakMap keyed by message object plus counter id/epoch). Reuse it in admit() and in the request admission check. | H2+H3 | ~35–40 ms | No (same numbers). |
| F3 Reuse admit()'s estimate in `budget-stream` check when the context is unchanged (same messages array identity/length + system prompt hash). | H2 | ~20 ms (covered by F2 if F2 lands) | No. |
| F4 Selector: skip `refresh()` when models.json mtime/size and the auth revision are unchanged. | H6 | ~10 ms with many models | No (refresh still happens on change). |
| F5 Run-journal start fsync batching / async | H4 | ~5–10 ms | Yes, durability semantics change. Only behind a default-off flag, or drop it. |

## Success criteria (paired A/B, same box, same load window, interleaved runs, n=20 each)
- Large session Enter→request p50 drops ≥ 40 ms (93 → ≤ 53) and p90 ≤ 70 ms. Small session does not regress (> +2 ms p50).
- Large session `setModel` p50 ≤ 6 ms. Selector open with 500 models p50 ≤ 4 ms when models.json is unchanged.
- Report load1 for every run. If load1 differs by > 2 between arms, rerun.

## Tests
- F1: an append after a foreign append (another SessionManager instance), a truncation, or an inode replace still throws `SessionManagerStaleWriteError`. The incremental hash equals the full-file sha256 after N appends (property test).
- F2/F3: admit() and request admission produce identical token counts with and without the cache, across edit/compaction/branch. Cache invalidates on a counter change.
- F4: the selector picks up a models.json edit made while omk runs and an auth change from /login.
- Bench script stays in `specs/062-ui-lag/bench/` (not in CI). A vitest timing gate is optional and should be loose (CI noise).

## Not in scope / follow-ups
- TUI render cost of long chat history and of the thinking selector after a model switch (needs a TUI harness).
- Library Scout's skills/settings reload check (omk-scout-mem).
