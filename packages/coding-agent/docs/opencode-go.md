# OpenCode Go catalog and reasoning

Checked 2026-10-17 against the [official Go guide](https://opencode.ai/v2/docs/console/go),
[live model list](https://opencode.ai/inference/go/v1/models), and
[models.dev](https://models.dev/api.json). This is catalog and local protocol verification,
not an account entitlement or inference-quality claim.

## Available models

OMK registers 36 of the 37 live IDs. `omen-alpha` is not registered: the live list
provides only its ID, and no verified tool support or context/output limits are available.
The generator warns instead of inventing those values.

New or restored entries are `beam-free`, `gemini-4-argon-contributor`, `glm-5.1`,
`kimi-k2.6`, `minimax-m2.5`, `qwen3.6-plus`, `qwen3.7-max`, and `step-5-preview`.
The no-longer-listed `cat-jam-free`, `step-5-preview-free`, `deepseek-v4-flash`, and
`deepseek-v4-flash-vision-exp` IDs are removed. Use `deepseek-v4.1-flash` for Flash.

A models.dev deprecation flag alone does not remove a model still returned by Go.
Six legacy IDs retain their last known Go metadata, gated by the live list. Their
prices and limits are historical, not newly verified tariffs. MiniMax M2.5 uses its
published model limits and an unpriced zero cost; zero does not mean free inference.
Current catalog prices use the source's base tier, not every long-context or peak tier.

## API endpoints

The model selects its protocol; a single provider-wide `baseUrl` override can break
models using another API family.

| Family | Endpoint |
| --- | --- |
| Chat Completions | `https://opencode.ai/inference/go/openai/v1/chat/completions` |
| Responses | `https://opencode.ai/inference/go/openai/v1/responses` |
| Anthropic Messages | `https://opencode.ai/inference/go/anthropic/v1/messages` |
| Gemini | `https://opencode.ai/inference/go/google/v1beta/models/<id>:streamGenerateContent` |

Go keeps MiniMax M2.7 on Chat Completions for its existing Bearer-auth compatibility;
MiniMax M3 and current Qwen routes use Messages. Gemini 4 Argon uses Google's native
`thinkingLevel`, not a token-budget approximation.

## Thinking levels

| Models | OMK levels / wire behavior |
| --- | --- |
| GLM-5.2 | `high`, `max` |
| GLM-5.3, GLM-5.3-Flash | `low`, `high`, `max` |
| Kimi K3 | `max`; no off |
| Kimi K2.7 Code, MiniMax M2.5/M2.7 | Fixed thinking, shown as `high`; no effort parameter |
| Kimi K2.6, GLM-5.1, MiMo V2.5/V2.6, LongCat | `off`, `high`; toggle only, no fictional xhigh/max |
| DeepSeek V4.1 Flash | `off`, `low`, `high`, `max`; native thinking toggle plus effort |
| DeepSeek V4 Pro | `off`, `high`, `max` |
| Grok 4.6/4.7 | `low`, `medium`, `high`, `xhigh`; no off |
| GPT-5.6 Luna, GPT-6 Luna | `off`, `low`, `medium`, `high`, `xhigh`, `max`; Responses effort, off sends `none` |
| Muse Spark contributor tiers | `minimal` through `xhigh`; OMK `max` aliases `xhigh`; no off |
| Hy3 / Hy4 preview | `off/low/high` / `off/high` |
| Beam Free, Space Bunny | `low`, `medium`, `high`, `xhigh`, `max`; no off |
| Step 5 Preview / Gemini 4 Argon Contributor | `low`, `medium`, `high`; no off |
| Claude Haiku 5.5 | `off`, `low`, `medium`, `high`, `xhigh`, `max`; adaptive thinking and `output_config.effort` |
| Current Qwen Messages routes, MiniMax M3 | `off` through `high` using budgets; top effort labels are hidden because this adapter path cannot transmit them |

Legacy Qwen3.6 Plus/Qwen3.7 Max retain their Chat Completions thinking toggle.
MiMo and LongCat use `thinking.type`; legacy Qwen uses `enable_thinking`.
Thinking text is replayed through `reasoning_content` for Go Chat Completions models.

Haiku uses adaptive thinking rather than the rejected manual budget mode and omits
unsupported temperature controls. Its off request uses the supported default effort.
See [Haiku migration](https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide)
and [thinking configuration](https://platform.claude.com/docs/en/build-with-claude/thinking).
SDK callers asking to disable Argon thinking get the documented lowest `LOW` level,
not a claim that thinking is disabled.

## Session identification and privacy

The public `stream`, `streamSimple`, `complete`, and `completeSimple` APIs attach an
OMK user agent and `x-opencode-session` when a `sessionId` is supplied. This is
independent of prompt caching. Caller-supplied headers win. Automatic identification
is restricted to the official HTTPS Go origin and path, not arbitrary custom proxies.
Direct adapter callers must supply their own routing headers.

Contributor routes have different data policies. The Go guide states that Gemini 4
Argon Contributor and Muse Spark contributor prompts/completions may be used for
training. Do not select them for private code without accepting that policy. Catalog
registration is not consent, does not select a model, and does not spend quota.

## Refresh and local overrides

To refresh only Go without changing other providers or the image catalog:

```bash
npm --prefix packages/ai run generate-models -- --opencode-go-only
```

The full `npm run models:refresh` also uses the new Go join. Failed HTTP responses,
invalid metadata, or an empty usable model list fail before writing the catalog.
Generated files must not be edited manually.

A custom model with the same ID in `~/.omk/agent/models.json` replaces the built-in
entry. Old effort maps, compatibility flags, and endpoint overrides can therefore
hide these corrections. Back up and review only the affected provider configuration;
see [custom models](models.md). Reopen the model list after changing that file.
Source adapter changes additionally require a reviewed build and a new process;
they do not change an already-running or separately installed OMK engine.

Local tests cover model selection, payload serialization, stable headers across all
four API families, and generator failure cases. Live inference, account access,
quota use, billing, and upstream adherence to effort controls are not verified.
