# OMK v1.5.0

OMK 1.5.0 is a minor release. All seven public workspace packages move together to
1.5.0. It adds the opt-in subagent runtime, always-on subagent loop guard, three bash
correctness fixes from PR [#150](https://github.com/dmae97/omk/pull/150), compaction
recovery for reasoning-exhausted summaries, the Experiential Labs provider, Project
Context commands, and the reviewed TUI/runtime changes accumulated since 1.4.3.

There are no intentional breaking CLI, protocol or configuration changes. The generated
model catalog does remove some routes that the live sources no longer returned; see
[Model catalog](#model-catalog) before pinning a model id.

## Subagent runtime and loop guard

The subagent runtime (spec 071) is opt-in with `OMK_SUBAGENT_RUNTIME=1`. When enabled:

- Concurrency is bounded by the smaller of 4 and the resource tier's heavy-process limit.
  The default `normal` tier runs 2 workers at once; constrained tiers run 1. A request over
  the limit is refused immediately with a typed `busy` error that names the limit and tier,
  instead of being queued.
- To allow 4 concurrent workers on the `normal` tier, set
  `{ "resourceGovernor": { "normalMaxHeavyProcesses": 4 } }` in `settings.json`. The lead and
  all workers share one turn and token budget.
- Each worker gets its own git worktree, and writes are confined to it. Before reporting
  done, a worker must leave a clean `git status`, updated docs, and a conflict-free
  `git merge-tree` against main.
- The loop guard is always on whenever a subagent runs, with no flag. A worker stops after
  3 identical calls with the same result, the same error in 3 consecutive turns, an A/B
  ping-pong over 6 calls, 5 turns without a file change or new tool output, or any attempt
  to spawn another subagent. A bash `grep`/`rg` that exits 1 with no output is treated as
  "no match", not an error. A stopped worker returns its partial result as an error and is
  never retried automatically.
- Depth is `min(OMK_SUBAGENT_MAX_DEPTH, 1)`: unset or invalid means 1, `0` disables
  spawning, and values above 1 clamp to 1.

The runtime remains off by default. When it is off, the first subagent request matches the
previous behavior.

## Bash and tool execution correctness

PR [#150](https://github.com/dmae97/omk/pull/150) fixes three audit findings:

- A command killed by a signal (`SIGKILL`, `SIGTERM`, and others) is reported as an error
  with `Command terminated by signal NAME` instead of a successful empty result. `SIGKILL`
  also mentions the memory-pressure possibility. Abort and inner-timeout messages keep
  their existing wording.
- The `write` tool reports the number of UTF-8 bytes written instead of the UTF-16 code-unit
  length. Korean text and emoji now report the size that reached the file.
- An outer tool timeout includes the output streamed before the timeout, capped with the
  existing 2,000-line / 50KB tail limit. If no output was streamed, the result is unchanged.
  The separate work of honoring per-call timeouts above 300 seconds is deferred to 1.5.1.

## Compaction resilience

Auto-compaction and branch summarization retry once when a reasoning model spends the whole
output budget on thinking and returns no text. The retry uses the model's lowest supported
effort and adds a 2,048-token text reserve; models that accept an explicit disable retry
without reasoning. If the retry also has no text, compaction fails instead of committing an
empty summary. A summary response that ends `aborted` is now reported as
`compaction.aborted` rather than a generic failure. The previous fallback always deleted
reasoning, which Claude Opus 5.5 rejects with HTTP 400.

A concurrent write during summarization is regenerated once against the new session head;
the stale summary is discarded. If the durable head still cannot be advanced, compaction
fails closed and asks the user to act.

## Providers and model catalog

- **Experiential Labs** (`experientiallabs`) joins the catalog as an OpenAI-compatible
  gateway at `https://api.experientiallabs.ai/v1`, authenticated by `EXPLABS_API_KEY` or
  `EXPERIENTIAL_API_KEY`. The 235 callable, routable, tool-capable text models were generated
  from the public `/api/models` catalog and the authenticated `/v1/models` surface on
  2026-10-18. Reasoning follows the `/v1/models` contract: 150 models expose a
  `thinkingLevelMap`, `none` maps to off, and unsupported tiers are hidden. GLM-5.2 stays
  provider-default because its gateway surface rejects `reasoning_effort`; GPT-6 Sol and Luna
  expose the declared none/low/medium/high/xhigh/max ladder. Media-only, embedding-only,
  non-tool and non-callable rows are excluded.
- **Claude Opus 5.5** rejects `thinking.type.disabled` with HTTP 400. Anthropic Messages now
  omits the field for that family, and the catalog marks `supportsDisabledThinking: false`, so
  a thinking-off turn uses the API's adaptive default instead of failing.
- **DeepSeek V4.1 Flash 1017** joins OpenRouter and the Vercel AI Gateway while the direct
  DeepSeek API keeps its `deepseek-flash` model name and routes the legacy
  `deepseek-v4-flash` alias to 1017. The undated OpenRouter and Vercel routes remain separate
  pre-1017 snapshots; they do not silently call 1017. OpenCode Zen and Go expose only the
  undated id.
- **Gemini 4 Argon** is available on Google, Google Vertex, OpenCode, the Vercel AI Gateway
  and OpenRouter, with the documented low/medium/high ladder and no off level. The OpenRouter
  `:batch` route declares its larger output cap and separate pricing.

## Model catalog

The catalog was refreshed from live sources on 2026-10-17 and again for Experiential Labs on
2026-10-18. The removals are upstream: the refreshed sources no longer selected those routes,
which does not prove provider deprecation. In particular, `anthropic/claude-3-haiku`,
`anthropic/claude-opus-4` and `anthropic/claude-sonnet-4` are no longer present on OpenRouter
in this catalog; use the current Sonnet/Opus ids or an explicit `models.json` override if you
need them. Other removed routes include several Qwen and free-tier OpenRouter entries.

Claude Haiku 5.5 and Sonnet 5.5 remain on the Copilot, OpenCode Go, OpenRouter and Devin
routes. Native Anthropic Messages, Bedrock, OpenCode and Vercel routes stay deferred until
their adaptive/off/replay contract is implemented. The image catalog moves from 61 to 63
entries with `black-forest-labs/flux-3-image`, `bytedance-seed/seedream-5-0-flash` and the
other refreshed entries.

Do not hand-edit `models.generated.ts`; change the generators under `packages/ai/scripts/`
and refresh deliberately. Releases never regenerate model catalogs.

## Project Context

`omk context bootstrap|status|refresh|show|verify` maintains a bounded, source-backed Project
Context index with incremental metadata refresh, stale detection and selective expansion.
Bootstrapped projects supply compact provider-neutral evidence at context discovery without
importing a mission state machine or weakening AGENTS precedence. See
[Project Context](../packages/coding-agent/docs/project-context.md).

## TUI and runtime

- Built-in `omk-paper-dark` and `omk-paper-light` themes (aliases `paper`, `paper-dark`,
  `paper-light`, `omk-paper`) meet 4.5:1 text contrast and 3:1 boundary contrast against the
  paper surfaces and common terminal backgrounds, including `#1e1e1e`.
- The startup panel and pinned sidebar now derive status from the live session through one
  `ControlPlaneViewModel` instead of printing fixed "ready"/"active"/"tracking" labels.
  Session, run-journal, model, theme, filesystem and failure text is printed as one sanitized
  line; escape sequences, control characters and bidi marks are removed.
- Loaded skills no longer retain every `SKILL.md` file through frontmatter substrings. With
  751 installed skills, measured heap fell from 12.7 MB to 1.9 MB. Prompt-template
  frontmatter is parsed the same way.
- The TUI adds line-level diffs, tmux hyperlinks, backpressure handling, and the tmux sidebar
  with a background indicator. Long-session first frames render the live tail plus the
  configured scrollback seed.
- `omk doctor adaptorch` now reaches AdaptOrch without `ADAPTORCH_API_URL`; the default API
  origin moved from the non-resolving `https://api.adaptorch.com` to `https://adaptorch.com`.
  An explicit `ADAPTORCH_API_URL` still takes precedence.
- Upstream Pi extension compatibility: the package index exports `CONFIG_DIR_NAME`, and
  `ExtensionContext.isProjectTrusted()` returns `true` because OMK loads project-local `.omk/`
  config without a trust gate.
- Removed the unreferenced internal module `tool-dag-read-aware.ts`; the scheduler's
  dependency index already implements the same read/read no-conflict rule.

## Known limits

- The two TUI width defects (a leading zero-width joiner, and SGR splitting an emoji + VS16
  grapheme) are recorded as `todo` tests; they are not fixed in this release.
- Live streaming was not exercised for every new provider/model pair. Catalog metadata comes
  from the provider surfaces checked on the dates above; credentials and account access are
  the operator's responsibility.
- The subagent runtime is opt-in. Its mock-model caps and memory measurements are not
  real-model guarantees.
- The optional Gondolin/Forge advisories and development-tool advisories remain visible. This
  release does not claim the upstream advisories are fixed.
- npm publishing uses the configured `npm-publish` environment token and does not claim
  OIDC/Sigstore npm provenance. GitHub binary attestations are a separate workflow step.

## Install and rollback

```bash
npm install -g open-multi-agent-kit@1.5.0 --ignore-scripts
omk --version
```

Start a new process to use the new version. An existing process or separately managed local
engine is not replaced by publishing a package. If a regression blocks use, reinstall
`open-multi-agent-kit@1.4.3` with `--ignore-scripts`; no credential or session migration is
required.

## Publication

Publishing runs in the tag-triggered `build-binaries.yml` workflow. A release is complete only
when the `v1.5.0` tag is reachable from `main`, the GitHub Release exists, and npm `latest`
agrees for all seven public packages: `open-multi-agent-kit`, `omk-ai`, `omk-agent-core`,
`omk-tui`, `omk-protocol`, `omk-adaptorch-wpl` and `omk-book-to-skill`. A pushed tag alone is
not a completed release.

The subagent runtime, loop guard and bash fixes are code-path changes, not a claim of
universal model quality or benchmark leadership. Local model evaluation and AdaptOrch command
verification, where run, cover only their configured checks and are not deployment
authorization.
