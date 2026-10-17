import type { ApiProvider } from "./api-registry.ts";
import type { OpenAIResponsesOptions } from "./providers/openai-responses.ts";
import { streamOpenAIResponses, streamSimpleOpenAIResponses } from "./providers/register-builtins.ts";

// Extensions may override the registry, so keep these streamers provider-local.
export function openAIResponsesApi(): ApiProvider<"openai-responses", OpenAIResponsesOptions> {
	return {
		api: "openai-responses",
		stream: streamOpenAIResponses,
		streamSimple: streamSimpleOpenAIResponses,
	};
}
