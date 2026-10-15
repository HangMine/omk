# OMK v1.4.2

This patch reduces model-selection latency when the context budget is enabled and many skills are installed. All seven public workspace packages move together to 1.4.2.

## Model-selection latency

- Score each inactive skill once when rebuilding model-specific prompt context, then sort the stored scores instead of recomputing relevance on every comparison.
- Preserve the selected skills, equal-score discovery order, active/hidden filtering and query freshness. No rankings are retained across turns.
- The fix is on the shared prompt-assembly path reached by `/model`, exact model commands and model cycling. Provider authentication, thinking selection, context limits and awaited extension hooks are unchanged.
- Regression tests exercise the real picker callback and `AgentSession.setModel`, compare against the original ranking, and bound scoring work by skill count rather than wall-clock timing.

See [custom models](../packages/coding-agent/docs/models.md) for the behavior and extension-hook limits.

## Existing main-branch fix

- The agent harness exposes the optional before-compaction cancellation reason through `SessionBeforeCompactResult.reason`.

## Compatibility and security limits

This release changes no provider endpoint, credential, tool permission, project-trust grant or sandbox requirement. Extensions can still add model-specific setup time through their `model_select` handlers.

The existing optional Gondolin/Forge production advisories remain visible. The reviewed runtime mitigation is unchanged; this release does not claim the upstream package advisory is fixed. See [Gondolin signature security](../packages/coding-agent/docs/gondolin-security.md). Audit thresholds and protection gates are unchanged.

## Publication

Publishing remains in the tag-triggered CI workflow. Completion requires the release tag to be reachable from `main`, a GitHub Release, and npm `latest` for all seven public packages to agree. npm publishing uses the configured `npm-publish` environment token and does not claim OIDC/Sigstore provenance.
