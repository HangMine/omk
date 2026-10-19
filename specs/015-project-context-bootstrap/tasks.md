# Project Context Bootstrap implementation

status: validation-blocked

> Correction (2026-10-20): all previously checked items were reverted to unchecked because their code was never committed. `packages/coding-agent/src/core/project-context/` does not exist in any release or on main (`git log -- src/core/project-context` is empty).

- [ ] Reuse existing context loader, token estimator, Git isolation and durable filesystem primitives.
- [ ] Implement bootstrap, bounded index, incremental refresh, stale detection and selective expansion.
- [ ] Integrate compact project evidence with provider policy and context opt-out.
- [ ] Validate public source CLI and existing behavior: 9 test files, 78 tests passed, exit 0.
- [ ] Typecheck requested sources/tests and transitive source imports with `.omk/context/project-context-typecheck.json`, exit 0.
- [ ] Run scoped Biome, import-cycle, relative-import and diff checks, exit 0.
- [ ] Bootstrap the local OMK workspace; unchanged refresh reused 81 metadata contributions with zero source reads.
- [ ] Pass full repository checks: blocked by unrelated shared-worktree doctor/capability formatting and doctor/MCP test type errors, the existing TUI module-size ratchet, and the tracked-document link guard for the new untracked document.

## Continuation pointers

Read `packages/coding-agent/docs/project-context.md` and this spec's `spec.md`.
The planned source location is `packages/coding-agent/src/core/project-context/`; it was never committed and does not exist.
Do not change unrelated work or stage new files merely to bypass the document guard.
No installed-runtime build, restart, commit, publication or release was requested or performed.
