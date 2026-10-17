# Implementation Plan: 첨부 미리보기 운영 반영

## Technical Context

**Language/Version**: TypeScript strict, Node v24.21.0, Spec Kitty CLI 3.2.7
**Primary Dependencies**: existing Photon 0.3.4, Vitest 3.2.6, native Node test runner
**Storage**: existing AttachmentStore, weak attachment-object decode cache, local Git/Spec Kitty artifacts
**Testing**: scoped full `npm run check`, targeted Vitest/Node tests, compiled real-PNG/stream smoke
**Target Platform**: local Linux/WSL canonical launcher; no release or remote deploy
**Project Type**: existing OMK npm workspace; existing spec-kit governance is preserved
**Constraints**: no dependency install, paid provider calls, unrelated staging, guard relaxation, force/reset/stash, or user-process termination.

## Charter Check

Spec Kitty has no separate project charter. Existing `specs/constitution.md` version 1.2.1 remains authoritative and unchanged. Harness classification is preserve. Shared source and review checkout are intentionally separate because user changes must not become part of this commit.

## Architecture and Root Cause

The former process-global UUID-keyed decoded-image map retained RGBA backing buffers after AttachmentStore removal. The new WeakMap is keyed by the stable attachment metadata object; an entry's pending Promise is registered before any await and shared by concurrent rebuilds. The strip decodes only its three shown tiles. `PhotonImage.get_raw_pixels()` provides an owned byte copy that survives native-image free; browser `ImageData` and compressed PNG output are not interchangeable with RGBA.

No public lifecycle API, interface/factory, eviction policy or dependency is introduced. Source, docs, existing width test and memory regression are the four code deliverables. Model image payloads and attachment validation are untouched.

## Implementation Concerns

1. **IC-01 source integrity**: use a clean, local primary clone for Spec Kitty mission creation and scoped commits. The installed CLI refuses linked worktree mission creation; do not bypass it. Existing shared checkout source hashes and index remain fixed.
2. **IC-02 lifecycle regression**: preserve valid RED evidence for retained backing buffers and GREEN evidence with an active-buffer positive control. Exercise actual Photon and native free, not only a fabricated renderer result.
3. **IC-03 operational build**: backup all seven package dist trees before the authorized canonical `npm run build`. The source includes pre-existing user changes that are not part of the scoped commit; verify source hashes before and after, then run existing memory regressions and compiled smoke.
4. **IC-04 delivery boundaries**: a new canonical launcher process must load the built files. Do not kill/restart existing sessions or claim `/reload` replaces core modules. Publish only local commit/artifact status; no push/PR/tag/npm release.

## Work Packages

One single-branch WP is enough: WP01 contains source verification, scoped commit review, operational build, compiled validation and final evidence. No child agents or lane fan-out. Ownership is restricted to the four attachment code/doc/test paths plus this mission and new project-scoped Spec Kitty files.

## Verification Commands

```bash
npm run check
LIVE_E2E=0 node ../../node_modules/vitest/dist/cli.js --run test/attachment-strip-memory.test.ts test/attachment-strip-width.test.ts test/prompt-attachment.test.ts test/interactive-clipboard-paste.test.ts
npm run build
node --expose-gc <private-evidence-dir>/compiled-smoke.mjs
omk --version
omk --help
spec-kitty agent mission finalize-tasks --validate-only --mission attachment-preview-memory-operational --json
spec-kitty accept --mission attachment-preview-memory-operational --mode checklist --no-commit --json
```

Commands with `../../node_modules` run in packages/coding-agent; workspace commands run at the chosen checkout root. Compile-time primary LSP is checked before build. The private evidence script imports the actual canonical dist and makes no provider request.

## Known Boundary

Shared-source `npm run check` is blocked by a pre-existing untracked `project-context.md` link. The scoped review clone does not contain that unrelated local edit and must pass full check without lowering any guard. This does not imply the entire dirty runtime source is commit-clean. The deployment is local and reversible; semantic release acceptance, remote merge, and current-session code replacement remain outside scope.

## Rollback

Restore only this task's backed-up dist trees if compiled verification fails, after checking that their current hashes still belong to this build. Do not reset source or kill another owner's process. Keep the backup and exact build/source manifest for operator recovery. Original specs and user work remain recoverable from the source snapshot.
