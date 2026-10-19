import type { Api, Model, SimpleStreamOptions, StreamOptions, ThinkingBudgets, ThinkingLevel } from "../types.ts";
import { isAnthropicClaudeModel, supportsAdaptiveThinking } from "./bedrock-thinking.ts";

/** Default token budgets per thinking level (token-based providers). */
export const DEFAULT_THINKING_BUDGETS: Readonly<Required<ThinkingBudgets>> = {
	minimal: 1024,
	low: 2048,
	medium: 8192,
	high: 16384,
};

/**
 * True when the provider's simple stream adds the thinking budget on top of an
 * explicit `maxTokens` via {@link adjustMaxTokensForThinking} (so a caller cap
 * sizes only the answer).
 */
export function addsThinkingBudgetToMaxTokens(model: Model<Api>): boolean {
	if (model.api === "anthropic-messages") return true;
	if (model.api === "bedrock-converse-stream") {
		const bedrock = model as Model<"bedrock-converse-stream">;
		return isAnthropicClaudeModel(bedrock) && !supportsAdaptiveThinking(bedrock.id, bedrock.name);
	}
	return false;
}

export function buildBaseOptions(_model: Model<Api>, options?: SimpleStreamOptions, apiKey?: string): StreamOptions {
	return {
		temperature: options?.temperature,
		maxTokens: options?.maxTokens,
		signal: options?.signal,
		apiKey: apiKey || options?.apiKey,
		transport: options?.transport,
		cacheRetention: options?.cacheRetention,
		sessionId: options?.sessionId,
		cwd: options?.cwd,
		headers: options?.headers,
		onPayload: options?.onPayload,
		onResponse: options?.onResponse,
		onRateLimit: options?.onRateLimit,
		timeoutMs: options?.timeoutMs,
		websocketConnectTimeoutMs: options?.websocketConnectTimeoutMs,
		maxRetries: options?.maxRetries,
		maxRetryDelayMs: options?.maxRetryDelayMs,
		metadata: options?.metadata,
	};
}

export function clampReasoning(
	effort: ThinkingLevel | undefined,
): Exclude<ThinkingLevel, "xhigh" | "max" | "ultra"> | undefined {
	return effort === "xhigh" || effort === "max" || effort === "ultra" ? "high" : effort;
}

export function adjustMaxTokensForThinking(
	// Undefined means no explicit caller cap. Use the model cap and fit thinking inside it.
	baseMaxTokens: number | undefined,
	modelMaxTokens: number,
	reasoningLevel: ThinkingLevel,
	customBudgets?: ThinkingBudgets,
): { maxTokens: number; thinkingBudget: number } {
	const budgets = { ...DEFAULT_THINKING_BUDGETS, ...customBudgets };

	const minOutputTokens = 1024;
	const level = clampReasoning(reasoningLevel)!;
	let thinkingBudget = budgets[level]!;
	const maxTokens =
		baseMaxTokens === undefined ? modelMaxTokens : Math.min(baseMaxTokens + thinkingBudget, modelMaxTokens);

	if (maxTokens <= thinkingBudget) {
		thinkingBudget = Math.max(0, maxTokens - minOutputTokens);
	}

	return { maxTokens, thinkingBudget };
}
