# OMK v1.4.0 — release candidate

This candidate integrates the outstanding OMK changes onto the current monorepo.
All seven public packages are intended to move together to 1.4.0. This is a minor
release under the project's version policy because worker extension loading and
session write/edit boundaries change their defaults.

## Compatibility

- Subagent workers skip user extensions by default. The extension that registered
  their model provider still loads. `OMK_WORKER_EXTENSIONS=all` or an explicit
  extension-name list opts into additional worker extensions. Existing command
  safety, project trust and nesting limits remain in force.
- Session write/edit tools stay within the session working directory and global
  `fileTools.writeRoots`, resolving symlinks and missing path prefixes. Project
  settings cannot grant wider writes. SDK tool factories enforce this boundary
  only when callers supply `workspaceRoots`.

## Changes

- Fixed subagent details serialization, heavy-process capacity, checkpoint brief
  retention, top-level provider-harness workspace access and nested worker depth.
- Tightened lane scope normalization and conservative overlap checks. Ported the
  legacy isolation scaffold's validation and path planning to current lane grants;
  it creates no branches, worktrees or processes.
- Counted xAI reasoning usage without double-counting and exposed provider billed
  USD separately from estimated catalog cost.
- Reused stable TUI box output, added faster width paths and bounded undo and bash
  output buffers. Frozen startup headers avoid duplicate transcript scrollback;
  detached tool and bash rows dispose their timers.
- Added typed todo verification and adaptive reasoning effort as opt-in features.
  Both remain disabled by default and are forced off in workers. Adaptive effort
  reads the active todo kind without enabling todo verification, and its run log
  excludes todo label and detail text.
- Excluded official answer lookups from the built-in task harness. Updated progress
  stall detection, border tokens and the historical 1.3.1 release notes.
- Updated the official `shell-quote` dependency override to 1.11.0, fixing
  [GHSA-pqg4-j6r4-53mv](https://github.com/ljharb/shell-quote/security/advisories/GHSA-pqg4-j6r4-53mv).

## Release status

Prepared source is not a published release. Main merge, the release tag, npm
publication and GitHub Release are held until the production dependency audit
passes and the final candidate's required CI succeeds.

The production audit still reports the Gondolin example's `node-forge` dependency
for [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv).
There is no official patched version at preparation time. The advisory reaches
Gondolin's certificate verification path. No audit threshold, dependency scope,
security check or sandbox requirement has been relaxed to suppress this finding.

The existing tag workflow is the release path: npm publication through the
`npm-publish` environment, standalone binaries, attestations and GitHub Release.
Completion requires a tag reachable from main and npm `latest` for all seven
packages to agree, followed by downstream installation verification.
