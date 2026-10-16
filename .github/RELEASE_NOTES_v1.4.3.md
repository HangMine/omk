# OMK v1.4.3

This patch ships the four reviewed harness changes from PRs [#141](https://github.com/dmae97/omk/pull/141), [#142](https://github.com/dmae97/omk/pull/142), [#143](https://github.com/dmae97/omk/pull/143) and [#144](https://github.com/dmae97/omk/pull/144). All seven public workspace packages move together to 1.4.3.

## Bounded overflow recovery

A single tool result larger than the model's context window no longer causes an endless tool/overflow/compaction loop. Recovery stops after two staged compact-and-retry attempts without progress and names the largest oversized result. Reduce the tool output or select a larger context window before retrying.

Successful in-window text replies and consumed tool results reset the recovery counter. Print mode reports an exhausted recovery on stderr and exits with status 1 instead of silently returning success.

## Admission and model-selection caches

- Admission reuses per-message fallback token statistics without retaining the serialized JSON. In-place edits invalidate entries; unusual JSON projections bypass the cache. The token-estimation contract is unchanged.
- Opening the model selector skips registry rebuilding when its model-file, provider and OAuth inputs have not changed. Model-file edits, provider registration and selected-credential changes still trigger refresh. Credentials are not written to diagnostic logs.

These changes reduce repeated local work; they do not change provider context limits, authentication, tool permissions or model thinking settings. They are not a claim of universally lower end-to-end model latency.

## Opt-in phase timing

Start OMK with `OMK_TIMING=1` to record model-selector opening, model application and prompt-to-request phases. `OMK_TIMING_FILE` selects a local output file; the default is a per-process file in the operating system's temporary directory.

Timing is disabled by default. The log records timestamps, phase names and durations, not prompt contents or credentials, and does not write into the TUI's stdout/stderr. Spans target one interactive session; overlapping SDK sessions are not independently attributed. See [the timing specification](../specs/065-debug-timing/spec.md).

## Compatibility and security limits

No provider endpoint, generated model catalog, external dependency version, project-trust grant or sandbox requirement changes in this release. Local uncommitted experiments are not part of the release candidate.

The existing optional Gondolin/Forge advisory and development-tool advisories remain visible. The reviewed Gondolin runtime mitigation is unchanged; this release does not claim the upstream advisory is fixed. See [Gondolin signature security](../packages/coding-agent/docs/gondolin-security.md). No audit threshold or protection gate was relaxed.

## Install and rollback

```bash
npm install -g open-multi-agent-kit@1.4.3 --ignore-scripts
omk --version
```

Start a new process to use the new version. An existing process or separately managed local engine is not replaced by publishing a package. If a regression blocks use, reinstall the preceding `open-multi-agent-kit@1.4.2` with `--ignore-scripts`; no credential or session migration is required.

## Publication

Publishing remains in the tag-triggered `build-binaries.yml` workflow. Completion requires the `v1.4.3` tag reachable from `main`, the GitHub Release and npm `latest` for all seven public packages to agree. A pushed tag alone is not a completed release.

npm publishing uses the configured `npm-publish` environment token and does not claim OIDC/Sigstore npm provenance. GitHub binary attestations are a separate workflow step. AdaptOrch command verification, where run, records only its configured local checks and is not a semantic-correctness proof or deployment authorization.
