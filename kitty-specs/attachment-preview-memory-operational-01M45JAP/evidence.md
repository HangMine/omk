# Verification Evidence

Date: 2026-10-05. Scope: local operating build and attachment-preview fix. No remote release claim.

## Observed Before and After

| Check | Before | After |
|---|---|---|
| 24 discarded 1MiB backing buffers | 24 retained | 0 retained, active control 1 retained |
| Eight attachments, three shown | 8 decodes | 3 decodes |
| Two simultaneous preview rebuilds | 2 decodes | 1 shared decode |
| Real Node Photon preview | browser ImageData path failed | raw pixels render, owned buffer survives native free |
| Compiled real-image/stream smoke | exit 1, pixel background missing | exit 0, 24 discarded buffers collected, active buffer retained |

## Executed Commands

- Relevant current-source regression set: AI EventStream 8/8, coding-agent memory/session/MCP/frontmatter/attachment checks 36/36, native Node TUI checks 8/8; total 52/52, exit 0.
- Primary LSP for changed production source files: no error diagnostics; no unavailable or inconclusive result.
- Canonical runtime `npm run build`: seven workspace packages, exit 0.
- Canonical runtime `node --expose-gc <private-evidence>/compiled-smoke.mjs`: actual installed Photon, built attachment renderer and EventStream, exit 0, provider calls 0.
- Fresh canonical launcher `omk --version`: 1.3.0, exit 0. `omk --help`: exit 0. Runtime repair, local patches and credential hydration were disabled for this offline smoke only.
- Source buffers/draft state are unchanged by the compiled probe; native prototype instrumentation is restored in finally and exists only in the owned short-lived test process.

## Scoped Commit and Shared Runtime Boundaries

The scope-clean review checkout contains only this mission's source/doc/test and Spec Kitty changes. Its full `npm run check` is required before the local commit. The canonical runtime checkout additionally contains 103 preserved user/source worktree changes, including other previously verified memory optimizations. The commit does not claim ownership or acceptance of those other changes.

The shared checkout's combined `npm run check` still stops at an original documentation link: modified `context-files.md` links untracked `project-context.md`. That gate remains truthful; no unrelated file was staged, no guard was weakened. Later individual guards and the compiler passed separately before this operation.

Existing running sessions are not killed or hot-patched. The built files apply to newly started processes; `/reload` is not proof of core-module replacement. No paid provider, auth migration, npm version bump, push, PR or release occurred.

## Rollback and Retention

Private evidence includes pre-operation source hashes and empty-index snapshots for both original checkouts, exact owned-file hashes, the seven dist backups, compiled-before failure, build logs and compiled-after result. Retain these until the operator accepts the new session. Do not publish private paths, user state or raw logs.

## Current Acceptance Evidence

- Scope-clean `npm run build`, four exact attachment files (19 tests), and full `npm run check` exited 0; the check includes 397 constitution tests and document links, with no guard relaxation.
- After operating build, the canonical-source memory regressions passed 52/52 again. Compiled smoke and fresh launcher smoke exited 0.
- Both original checkouts retained all 103 dirty-file hashes, their original HEAD and empty staged diff after the operating build. Source/dist digest binding was saved locally.
- Spec Kitty substantive plan reports phase_complete=true. Task validate-only reports validation_passed for one WP, with all six FRs mapped and no ownership/dependency warnings. Native finalization committed the canonical task artifacts.
- The owned clone has no installed generated pre-commit launcher; full checks were therefore run directly before commits. Repository hook code and guards were not disabled or changed. Local commits use an explicit OMK Assistant identity only in the owned clone because no existing author was configured.

Final local source commit, metadata delivery, WP review/acceptance state and post-delivery digest check are recorded separately. No merged/done claim is inferred from local operating success.
