import type { Usage } from "../types.ts";
import { uncachedInputFromInclusiveTotal } from "../usage-share.ts";

/** Raw Responses API usage, including the GPT-5.6+ cache-write count when present. */
export interface ResponsesRawUsage {
	input_tokens?: number;
	output_tokens?: number;
	total_tokens?: number;
	cache_write_tokens?: number;
	input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } | null;
}

/**
 * Map Responses usage to `Usage`. OpenAI `input_tokens` includes cache reads
 * and writes, so `input` is normalized to uncached input. Cache writes come
 * from `cache_write_tokens` (GPT-5.6+). A reported value (including 0) is kept;
 * an absent field is *not reported*, not "no write": `cacheWrite` is a 0
 * placeholder and `cacheWriteUnknown` is set. No model is zero-filled, because
 * we have not verified a provider doc stating a model has no cache-write charge.
 * Costs are filled later.
 */
export function parseResponsesUsage(raw: ResponsesRawUsage): Usage {
	const cacheRead = raw.input_tokens_details?.cached_tokens || 0;
	const reported =
		reportedCount(raw.input_tokens_details?.cache_write_tokens) ?? reportedCount(raw.cache_write_tokens);
	const cacheWrite = reported ?? 0;
	return {
		input: uncachedInputFromInclusiveTotal(raw.input_tokens || 0, cacheRead, cacheWrite),
		output: raw.output_tokens || 0,
		cacheRead,
		cacheWrite,
		...(reported === undefined ? { cacheWriteUnknown: true as const } : {}),
		totalTokens: raw.total_tokens || 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function reportedCount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
