# Project Context Bootstrap implementation

status: validation-blocked

- [x] Reuse existing context loader, token estimator, Git isolation and durable filesystem primitives.
- [x] Implement bootstrap, bounded index, incremental refresh, stale detection and selective expansion.
- [x] Integrate compact project evidence with provider policy and context opt-out.
- [x] Validate public source CLI and existing behavior: 9 test files, 78 tests passed, exit 0.
- [x] Typecheck requested sources/tests and transitive source imports with `.omk/context/project-context-typecheck.json`, exit 0.
- [x] Run scoped Biome, import-cycle, relative-import and diff checks, exit 0.
- [x] Bootstrap the local OMK workspace; unchanged refresh reused 81 metadata contributions with zero source reads.
- [ ] Pass full repository checks: blocked by unrelated shared-worktree doctor/capability formatting and doctor/MCP test type errors, the existing TUI module-size ratchet, and the tracked-document link guard for the new untracked document.

## Continuation pointers

Read `packages/coding-agent/docs/project-context.md` and this spec's `spec.md`.
The source implementation is `packages/coding-agent/src/core/project-context/`.
Do not change unrelated work or stage new files merely to bypass the document guard.
No installed-runtime build, restart, commit, publication or release was requested or performed.
