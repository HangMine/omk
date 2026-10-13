# OMK v1.4.1

This patch release hardens the RPC input boundary and includes the TUI, project-trust, skill-search and prompt-attachment changes already merged after v1.4.0. All seven public workspace packages move together to 1.4.1.

## RPC fixes

- Validate command envelopes, required fields, boolean and enum values, image shapes and extension UI response fields before dispatch.
- Return an error for malformed JSON, `null`, arrays and primitive records without crashing the RPC process or changing session settings.
- Preserve a valid request `id` when an unsupported command is rejected, so clients can settle the originating request.
- Keep command types and runtime validation derived from the same schema. Normal commands and unknown additional fields remain compatible.
- Parse diagnostics omit private input snippets. This change does not add a JSONL frame-size limit or an event-retention limit.

See [RPC input validation](../packages/coding-agent/docs/rpc.md#input-validation).

## Changes already merged since v1.4.0

- Searchable skill picker through `/skills [query]` and the configurable `Alt+S` shortcut, preserving the draft when selecting or cancelling.
- Prompt image attachment through `/attach add`, `/attach paste` and supported bracketed-paste file drops. Acquisition is bounded and serialized; rejected or stale acquisition retains the appropriate draft state.
- Long-session first frames render a bounded live tail and configurable terminal-scrollback seed. Explicit exit logging still emits the complete transcript.
- Worker project-trust checks revalidate repository registration and worktree identity instead of reusing permanent positive answers.
- Skill search removes identical aliases and already-offered skills before capping the distinct candidate pool.

See the [reliability review](../packages/coding-agent/docs/reliability-review-20261013.md) for those changes' verification scope and remaining limits.

## Regression test portability

Proxy-routing tests now inject a deterministic connection failure. Compact-resource and authority-store fixtures use controlled paths and clocks. The production proxy, renderer, authorization deadlines and default monotonic clock are unchanged.

## Compatibility and security limits

Valid RPC wire shapes are unchanged. Records that violate the documented field types are now rejected before handlers run. This does not change provider authentication, tool permissions, project-trust grants or sandbox requirements.

The existing optional Gondolin/Forge advisory remains visible in the production dependency audit. Its reviewed runtime mitigation is unchanged; this release does not claim that the upstream package advisory is fixed. See [Gondolin signature security](../packages/coding-agent/docs/gondolin-security.md). Development dependency audit warnings also remain visible; no audit threshold or protection gate was relaxed.

## Verification and publication

The RPC change passed 119 local regression tests, a clean build and the full repository check under the local AdaptOrch CommandVerifier. These are scoped execution results, not a proof of universal correctness or long-duration workload stability.

The tag workflow remains the publication path. Release completion requires the tag to be reachable from `main`, the GitHub Release, and npm `latest` for all seven public packages to agree. Signed binary attestations and npm publication are separate surfaces: npm publishing uses the configured `npm-publish` environment token and does not claim OIDC/Sigstore provenance. Local runtime application is verified separately and preserves the operator's existing local patches.
