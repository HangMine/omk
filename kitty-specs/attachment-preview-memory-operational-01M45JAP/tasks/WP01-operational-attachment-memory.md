---
work_package_id: WP01
title: Verified attachment-memory operational application
dependencies: []
requirement_refs:
- FR-001
- FR-002
- FR-003
- FR-004
- FR-005
- FR-006
planning_base_branch: fix/attachment-memory-kitty-20261005
merge_target_branch: fix/attachment-memory-kitty-20261005
branch_strategy: Planning artifacts for this mission were generated on fix/attachment-memory-kitty-20261005. During /spec-kitty.implement this WP may branch from a dependency-specific base, but completed changes must merge back into fix/attachment-memory-kitty-20261005 unless the human explicitly redirects the landing branch.
subtasks:
- T001
- T002
- T003
- T004
- T005
- T006
history: []
agent_profile: implementer-ivan
authoritative_surface: packages/coding-agent/
create_intent: []
execution_mode: code_change
owned_files:
- packages/coding-agent/src/modes/interactive/components/attachment-strip.ts
- packages/coding-agent/test/attachment-strip-memory.test.ts
- packages/coding-agent/test/attachment-strip-width.test.ts
- packages/coding-agent/docs/usage.md
- .gitignore
- .gitattributes
- .claudeignore
- .kittify/config.yaml
- .kittify/metadata.yaml
- .kittify/canonical-events.jsonl
role: implementer
tags: []
tracker_refs: []
---

## Do This First: Agent Profile and Authority

The installed CLI lists `implementer-ivan`. Its role is task metadata, not authorization to launch another agent. Execution and self-review stay in the current root agent. Current user approval permits only a local scoped branch and commits, plus canonical operating build application. Existing `specs/constitution.md` is retained; no global/private agent content is published.

## Objective

Deliver the already tested attachment-preview memory fix into newly launched local OMK processes with reviewed, reproducible specification and validation evidence.

## Branch Strategy

Planning and local delivery stay on `fix/attachment-memory-kitty-20261005` in an owned primary local clone. The installed Spec Kitty CLI refuses mission creation in linked worktrees; do not bypass this. Original shared engine and Windows checkout branches stay unchanged. No remote push, PR or main merge occurs.

## Subtasks

### T001: Current source contract

Read spec.md, plan.md and evidence.md. Verify baseline RED failures and later GREEN results. Keep the operator's vocabulary and observed constraints, not newly inferred features. Confirm installed CLI 3.2.7 with its live upgrade check. Do not edit original specs or user-global settings.

### T002: Scope-clean source verification

Read all four attachment deliverables and their callers. Confirm WeakMap lifetime follows stable AttachmentStore metadata, pending decode is admitted before await, only three visible images decode, and owned raw pixels survive native free. Run the four exact attachment tests (19 expected checks) and full `npm run check` in the clone after its own build removes stale copied dist. Guards must not be changed.

### T003: Reversible backup

Snapshot both original dirty source sets, HEAD, staged binary diff, and seven package dist directories. Preserve the original 103 worktree hashes. Keep backup paths private and task-owned. Never stash/reset/blanket-stage another session's work.

### T004: Canonical operating build

Run `npm run build` in the launcher-resolved engine checkout. Run primary LSP first. Then run the actual compiled real-Photon PNG/renderer and EventStream check in an owned short-lived process. Require 24 discarded backing buffers collected, one active retained, one shared pending decode and proper terminal/cancelled-reader settlement. Run fresh launcher --version/help with no provider prompt.

### T005: Scope and review

Inspect the whole staged diff and exact allowlist before each commit. Commit only this WP's code, user docs, mission artifacts and new project-scoped Spec Kitty settings. Run direct self-review of correctness, cleanup, output width, error fallback, compatibility and size. Do not report another reviewer or delegation that did not occur. Use CLI validate-only before any task finalization. Treat acceptance readiness separately from merge-complete.

### T006: Evidence and handoff

Record exact command exits and source/dist SHA-256 binding after build. Verify original 103 hashes and index unchanged. Import only the local delivery branch's commit objects into the original repository without merging main. Copy mission/config artifacts to the actual checkouts only after collision guards. Report that new startup loads the fixed build; current sessions are not hot-patched. Shared-source original doc-link failure remains a separate unresolved gate.

## Tests and Limits

- Targeted source regressions: 52 expected checks across existing AI, coding-agent and native Node TUI files.
- Scope-clean full check, canonical build and compiled smoke: exit 0.
- Original shared full check: known untracked-document link failure, not suppressed.
- No paid provider call, no dependency install, no release version change.
- Byte retention checks do not promise process RSS or WASM allocation immediately returns to the OS.

## Definition of Done

Source/doc/test contract, original-state backup, observed build, compiled smoke, scoped checks, direct review and final evidence are all present. A local scoped commit is durable and no unrelated paths entered it. Spec Kitty readiness is diagnosed truthfully; no `done` or merged label is forced when the CLI still requires merge ancestry or uncommitted artifacts. The operating files may be verified while mission merge acceptance remains pending.
