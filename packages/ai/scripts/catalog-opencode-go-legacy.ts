import type { Api, Model } from "../src/types.ts";

// Still returned by OpenCode's live models endpoint on 2026-10-17, but absent from
// models.dev's Go section. Limits/prices retain the last Go entries (7971c81c2b).
// MiniMax M2.5 uses its documented model limits; its current Go price is unpublished.
export function openCodeGoLegacyModels(): Model<Api>[] {
	const entries = [
		{
			id: "glm-5.1",
			name: "GLM-5.1",
			contextWindow: 202752,
			maxTokens: 32768,
			input: ["text"],
			cost: [1.4, 4.4, 0.26, 0],
		},
		{
			id: "grok-4.6",
			name: "Grok 4.6",
			contextWindow: 500000,
			maxTokens: 500000,
			input: ["text", "image"],
			cost: [2, 6, 0.5, 0],
		},
		{
			id: "kimi-k2.6",
			name: "Kimi K2.6",
			contextWindow: 262144,
			maxTokens: 65536,
			input: ["text", "image"],
			cost: [0.95, 4, 0.16, 0],
		},
		{
			id: "minimax-m2.5",
			name: "MiniMax M2.5",
			contextWindow: 204800,
			maxTokens: 131072,
			input: ["text"],
			cost: [0, 0, 0, 0],
		},
		{
			id: "qwen3.6-plus",
			name: "Qwen3.6 Plus",
			contextWindow: 1000000,
			maxTokens: 65536,
			input: ["text", "image"],
			cost: [0.5, 3, 0.05, 0.625],
		},
		{
			id: "qwen3.7-max",
			name: "Qwen3.7 Max",
			contextWindow: 1000000,
			maxTokens: 65536,
			input: ["text"],
			cost: [2.5, 7.5, 0.5, 3.125],
		},
	] as const;
	return entries.map(({ cost: [input, output, cacheRead, cacheWrite], ...entry }) => ({
		...entry,
		input: [...entry.input],
		api: entry.id === "grok-4.6" ? "openai-responses" : "openai-completions",
		provider: "opencode-go",
		baseUrl: "https://opencode.ai/inference/go/openai/v1",
		reasoning: true,
		cost: { input, output, cacheRead, cacheWrite },
	}));
}
