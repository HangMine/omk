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
 * from `cache_write_tokens` (GPT-5.6+); absent means 0. Costs are filled later.
 */
export function parseResponsesUsage(raw: ResponsesRawUsage): Usage {
	const cacheRead = raw.input_tokens_details?.cached_tokens || 0;
	const cacheWrite = raw.input_tokens_details?.cache_write_tokens || raw.cache_write_tokens || 0;
	return {
		input: uncachedInputFromInclusiveTotal(raw.input_tokens || 0, cacheRead, cacheWrite),
		output: raw.output_tokens || 0,
		cacheRead,
		cacheWrite,
		totalTokens: raw.total_tokens || 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}
