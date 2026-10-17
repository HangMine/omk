# Spec 071: subagent runtime — 4 concurrent, no pending, loop guard, git gate (1.5.0)

Status: **spec draft**, no implementation. Base: origin/main `fd495fd77b`. Criteria below are Tech Lead's fixed 1.5.0 criteria
(2026-10-17, room) and must not change after measuring. Order: protocol spec (1) → **this runtime (2)** → optimisation (3) → auto v5 (4);
Spec order (Tech Lead): **072 baseline → 071 runtime → 073 auto v5**; 074 protocol (docs + types) may be written alongside 071. Spec number: 066-070 are taken by local branches; 071 is free.

## What exists (reuse, do not rewrite)
- Subagent extension `packages/coding-agent/examples/extensions/subagent/` (~7.6k lines): parallel mode 8 tasks / 4 concurrent outside Ultra
  (`deadline-budget.ts:18`), the extra tasks **wait**; Ultra has no cap.
- Depth guard already exists: `nesting.ts` `OMK_SUBAGENT_DEPTH` / `OMK_SUBAGENT_MAX_DEPTH`, default max depth 1.
- Worker env policy `worker-env.ts` (adaptive effort off in workers, lead-only vars stripped).
- Loop worktree policy `core/loop-registry.ts:216-221` (`per-item`, `requireCleanCheckout`, `maxConcurrentWorktrees: 1`).
- `packages/protocol/src/run-dag.ts` for task ordering.

## Decisions already fixed (Tech Lead)
- **No pending:** effective limit = min(4, resource-tier cap). A request above it is rejected at once with a typed `busy` error
  (`{ code: "busy", running, limit, reason: "<tier name>" }`), so the lead sees the real cap and why. The resource tier is never disabled to reach 4;
  no hidden queue anywhere (no `p-limit`, no retry loop inside the runtime). The lead decides to do it itself or call again later.
- **No new dependencies:** `child_process.fork()` + Node IPC, JSON-RPC 2.0 written in-house (protocol spec), results written to a file,
  only the path is returned to the lead.
- **Defaults:** the runtime merges behind `OMK_SUBAGENT_RUNTIME=1` (default off); flipped on only in the 1.5.0 release PR after all
  criteria pass. **Loop guard and git gate have no flag and are always on** whenever a subagent runs.

## Loop guard (always on)
Any one trigger stops the subagent and returns a typed error with the reason to the lead; the runtime never retries on its own.
1. Depth 1: subagents cannot spawn subagents (existing `nesting.ts`, now enforced with a test that the tool is absent at depth 1).
2. Per-subagent caps on turns, wall time and billed tokens = **2 × max of the 20 runs in 072, per task family** (larger of the two if a single value is needed), locked in this spec before any A/B, never changed after.
   **Scope:** these 072 caps (18 turns, 70,254 billed tokens per worker, 5.70 s wall; sha256 5c4339659def…837582) are for **mock regression tests only**.
   Real-model caps come from 073's real-model baseline and are locked there before its A/B.
   Hitting a cap returns a **partial-completion** result (Claude Code `maxTurns` behaviour).
3. The same tool with identical arguments **3 times in a row** stops it (N=3). Built on `core/identical-loop.ts` (today warn 3 / stop 6,
   only under `OMK_IDENTICAL_LOOP`): in subagents it is always on, and it also catches **same error 3×** and **A·B ping-pong 6×**
   (OpenHands stuck detector patterns).
4. **5 turns** with no file change and no new tool output stop it (K=5).
5. Ultra mode gets the same cap of 4 concurrent (behaviour change, see below).
6. **Shared run budget:** besides the per-subagent caps, one turn and billed-token cap is shared by the lead and all workers
   (OpenHands shared counter, PR #3703); 4 workers each at their own cap still cannot exceed it.
7. **Stopped worker = error:** a worker stopped by a cap or the loop guard is reported as an error with its partial result,
   never as an empty success (OpenHands #3742).
8. **Resume keeps limits:** a resumed subagent keeps its caps and the amount already used.

## Git gate (always on)
- **Per project:** worktrees live under `<project>/.omk/worktrees/<task>`, each on a new branch from freshly fetched `origin/main`
  (`omk/sub/<task>`). The path is added to `.git/info/exclude` (not the user's `.gitignore`), so the main checkout stays clean;
  test: `git status --porcelain` in the main checkout is empty after 4 concurrent runs.
- **Write confinement:** a subagent writes only inside its worktree. `../`, absolute paths and symlinks resolving outside are refused
  (test with each, via `core/tools/workspace-write-guard.ts`).
- **Before start:** clean status, fetched main, read README / AGENTS.md / CONTRIBUTING if present.
- **Before done:** docs updated when behaviour changed, `git status` clean, main merged in, `git merge-tree` shows no conflict.
  A conflict is never auto-resolved: stop and report. No rebase, no force-push.
- **Order:** `run-dag` dependencies decide order. Only **dependent** tasks wait for their predecessor to merge; independent tasks run
  in parallel. Merges go one at a time in DAG priority; after each merge the next PR is re-checked against the new main.
- Issue vs PR: needs a decision → issue; fixable → PR (opening is the lead's call, never automatic push without approval).

## Success criteria (fixed, Tech Lead 2026-10-17)
Mock, Bench Analyst, 20 runs unless stated, Node >=22.19, `OMK_TRUST_PROJECT=0`, load1 logged, one heavy bench at a time.
1. **Busy:** a 5th request is rejected immediately (no wait), typed `busy`; running count never exceeds 4.
2. **Abort:** 100 aborts → 0 orphan processes; all children exit within 2 s.
3. **Isolation:** same-file conflicts between subagents 0 (per-subagent worktree).
4. **Flag off:** first request byte-identical to main.
5. **Loop guard:** 100 deliberately looping mocks (same call, same error, A·B ping-pong, self re-spawn) all stop inside the caps;
   orphans 0, automatic retries 0. 20 normal tasks: wrongly stopped 0.
   Shared budget never exceeded with 4 workers; stopped workers reported as error 100 % (empty success 0); caps and usage unchanged after resume (unit test).
6. **Git:** 4 concurrent, 20 runs: main conflicts 0, dirty worktrees 0, force-push 0. 20 deliberate-conflict scenarios: wrong merges 0,
   conflicts detected 20/20. 20 mocks that skip the docs or git check: all marked incomplete (20/20); normal runs wrongly marked 0.
7. **Confinement:** `../`, absolute and symlink escapes all refused (unit tests).

## Step 0 baseline (record only, no verdict; measured on main before this spec lands)
Subagents 1 / 2 / 4, 20 runs each: wall time, peak RSS of the whole process tree, CPU time (user+sys), billed tokens per task
including subagents; parallelisable and order-dependent tasks reported separately.

## Risks
- Rejecting instead of queueing can make a naive lead loop on `busy`; covered by the lead's same-call loop guard (3 identical calls).
- `.git/info/exclude` is per clone; worktrees share it with the main checkout (intended).
- Process-tree RSS on Linux needs `/proc` walking; macOS numbers come from `ps` and are reported separately.

## Behaviour changes (CHANGELOG "Behavior changes", confirmed at OMK final approval against 근빈's rules)
- A 5th concurrent subagent is rejected with `busy` instead of waiting.
- Ultra mode is capped at 4 concurrent (was uncapped).

## Concurrency vs resource tier (Tech Lead ②, 인호 confirming via OMK)
072: normal tier caps heavy processes at 2 (`resource-admission-config.ts:47`), constrained/critical at 1. Decision ②: limit = min(4, tier cap), rest `busy`.
Behavior changes lists the real concurrency per tier. Raising normal to 4 is decided separately. 072 addendum (true 4, `normalMaxHeavyProcesses: 4` in settings.json, no source change): wall 2.70 → 2.06 s,
peak RSS 472 → 777 MB, CPU and billed tokens unchanged. Until decided: default 2, README documents the setting. The step-3 optimisation baseline
("4 concurrent peak RSS −20 %") is 777 MB **(mock)**: judged on mock; real-model RSS is only recorded in 073.
Mock wall time understates the gain of 4 (only queue wait is saved); the +150 MB per worker is model-independent.

## Caps: two kinds
- **Mock caps** (072, sha256 locked) are used only in 071 tests.
- **Real runs:** no turn or wall cap from mock numbers until 073 measures a real-model baseline; loops are stopped by N/K/same-error/ping-pong and
  the shared run token cap. Turning subagents on by default requires real-model caps.

## Decisions (Tech Lead, OMK, 2026-10-17)
N=3, K=5, caps = 2 × max of 072 runs per family, loop mocks 100, no pending confirmed. No open questions remain; caps get filled in from 072.
