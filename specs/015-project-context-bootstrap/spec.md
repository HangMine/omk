# Project Context Bootstrap

## Scope

Add a provider-neutral repository index owned by OMK, not a second source of architectural or execution truth. Bootstrap discovers coordinates once; refresh updates changed source contributions; compact context carries bounded pointers; expansion reads selected source only. Existing spec-kit governance is preserved. No Spec Kitty state machine, model call, or external service is required.

## Existing primitives

Reuse the context-file loader and prompt budget pipeline, `estimateTextTokens`, the isolated read-only Git runner, durable mutation locks, atomic rewrites, installed YAML and TypeBox parsers, and forced redaction. Keep project index evidence separate from AGENTS instructions and verified source-quote memory.

## Artifacts

- `.omk/context/project.yaml`: schema version, generation, repository binding, project identity, context budget, source pointers, contribution statistics and digests of companion artifacts.
- `.omk/context/modules.yaml`: manifest-derived module boundaries, entrypoints and declared local dependency edges. Unproven import relationships are not inferred.
- `.omk/context/state.yaml`: observed Git state, mission/task/handoff pointers and short source-backed constraints/decisions.
- `.omk/context/snapshot.json`: bounded incremental cache of file inventory and metadata-source contributions; never injected into prompts.

Index files share a generation and hashes. Partial writes fail closed. Filesystem paths are repository-relative, regular, bounded and cannot traverse symlinks or secret paths. Documentation contents are untrusted evidence, not authorization.

## Commands and lifecycle

`omk context bootstrap|status|refresh|show|verify` run offline before session creation. Support `--root`, `--json`, `--budget`. `show --section modules|state|pointers` selects a section; `show --module <id>` and `show --file <indexed-path>` provide progressive disclosure. Initialization never creates commits or changes source files. Existing index bootstrap is preserved. Refresh uses Git inventory/diff and cached source fingerprints rather than re-reading code. Git-free projects support bounded filesystem discovery with an explicit freshness limitation.

A bootstrapped index is automatically included as bounded project evidence by the existing loader, including under provider changes. No index means no scan, write or payload. Context opt-out still works. Stale/corrupt context is explicitly signaled; no stale mission or constraint is claimed current. Project instructions are not dropped or elevated by this feature.

## Acceptance

1. Empty, existing and monorepo projects bootstrap with deterministic, bounded YAML records and no source/Git-history changes.
2. Changed/deleted/renamed manifests and mission files refresh their contributions; unchanged sources are reused. Same dirty path edited twice and branch changes are detected.
3. Source hashes, schema/generation/hash mismatches, missing/unsafe pointers and new structural files are detected. Symlinks, traversal, malformed YAML, binary/oversize sources and secret filenames fail closed or report explicit omitted counts.
4. A 2,000 estimated-token compact budget is honored with omission markers and detail commands. Token accounting is an estimate, not provider-token attestation.
5. Startup loads compact evidence without a full repository summary, original document bodies or incremental cache. Selective expansion reads only admitted files and respects its own budget.
6. Mission state is an observation of original specs/state/ADR artifacts, not a new state machine. Constraints and decisions retain their source path and line.
7. Actual source CLI, loader, provider-policy and prompt-budget tests pass; repository check results distinguish unrelated pre-existing failures.

## Harness impact: preserve

Preserve instruction precedence, provider-cache boundaries, session opt-out, source-quote authority, secret boundaries and absence of startup model/network calls. No comparative efficiency/SOTA claim is made. Baseline: OMK 1.3.0 context-file behavior. Verification: targeted Project Context, loader, prompt-budget and model-policy tests plus `npm run check`. Evidence artifact: targeted test output and reported changed paths/exit codes.
