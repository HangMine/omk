# Spec 071: subagent runtime — 4 concurrent, no pending, loop guard, git gate (1.5.0)

Status: **spec draft**, no implementation. Base: origin/main `fd495fd77b`. Criteria below are Tech Lead's fixed 1.5.0 criteria
(2026-10-17, room) and must not change after measuring. Order: protocol spec (1) → **this runtime (2)** → optimisation (3) → auto v5 (4);
step 0 (baseline) is measured on main before any of it. Spec number: 066-070 are taken by local branches; 071 is free.

## What exists (reuse, do not rewrite)
- Subagent extension `packages/coding-agent/examples/extensions/subagent/` (~7.6k lines): parallel mode 8 tasks / 4 concurrent outside Ultra
  (`deadline-budget.ts:18`), the extra tasks **wait**; Ultra has no cap.
- Depth guard already exists: `nesting.ts` `OMK_SUBAGENT_DEPTH` / `OMK_SUBAGENT_MAX_DEPTH`, default max depth 1.
- Worker env policy `worker-env.ts` (adaptive effort off in workers, lead-only vars stripped).
- Loop worktree policy `core/loop-registry.ts:216-221` (`per-item`, `requireCleanCheckout`, `maxConcurrentWorktrees: 1`).
- `packages/protocol/src/run-dag.ts` for task ordering.

## Decisions already fixed (Tech Lead)
- **No pending:** a 5th concurrent request is rejected at once with a typed `busy` error (`{ code: "busy", running: 4, limit: 4 }`);
  no hidden queue anywhere (no `p-limit`, no retry loop inside the runtime). The lead decides to do it itself or call again later.
- **No new dependencies:** `child_process.fork()` + Node IPC, JSON-RPC 2.0 written in-house (protocol spec), results written to a file,
  only the path is returned to the lead.
- **Defaults:** the runtime merges behind `OMK_SUBAGENT_RUNTIME=1` (default off); flipped on only in the 1.5.0 release PR after all
  criteria pass. **Loop guard and git gate have no flag and are always on** whenever a subagent runs.

## Loop guard (always on)
Any one trigger stops the subagent and returns a typed error with the reason to the lead; the runtime never retries on its own.
1. Depth 1: subagents cannot spawn subagents (existing `nesting.ts`, now enforced with a test that the tool is absent at depth 1).
2. Per-subagent caps on turns, wall time and billed tokens (values set in the protocol spec, fixed before measuring).
3. The same tool with identical arguments **3 times in a row** stops it.
4. No progress for K turns (no file change and no new tool output hash) stops it. K is fixed before measuring.

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
5. **Loop guard:** 20 deliberately looping mocks (OMK asked for 100: run 100) all stop inside the caps; 0 orphans.
6. **Git:** 4 concurrent, 20 runs: main conflicts 0, dirty worktrees 0, force-push 0; a run missing the docs or git check is counted as failed;
   a deliberately conflicting scenario produces 0 wrong merges.
7. **Confinement:** `../`, absolute and symlink escapes all refused (unit tests).

## Step 0 baseline (record only, no verdict; measured on main before this spec lands)
Subagents 1 / 2 / 4, 20 runs each: wall time, peak RSS of the whole process tree, CPU time (user+sys), billed tokens per task
including subagents; parallelisable and order-dependent tasks reported separately.

## Risks
- Rejecting instead of queueing can make a naive lead loop on `busy`; covered by the lead's same-call loop guard (3 identical calls).
- `.git/info/exclude` is per clone; worktrees share it with the main checkout (intended).
- Process-tree RSS on Linux needs `/proc` walking; macOS numbers come from `ps` and are reported separately.

## Open questions (Tech Lead)
1. Turn / time / token caps and no-progress K: propose turns 40, 15 min, 400k billed tokens, K = 5 — approve or set.
2. Loop-guard run count: Tech Lead said 20, OMK said 100 — proposal 100 (cheap on mock).
