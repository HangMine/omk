/**
 * Spec 104 §2.4: observe-only cost comparison of "continue" vs "compact".
 *
 * Behind `OMK_COMPACTION_COST_OBSERVE` (default off). Logging only: the
 * unchanged threshold policy still decides, and input ceiling, output reserve
 * and verification budget always take precedence. Each observation is
 * metadata (token counts, USD estimates, the decision); never prompt text.
 */
export const COMPACTION_COST_OBSERVE_ENV = "OMK_COMPACTION_COST_OBSERVE";

export function isCompactionCostObserveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return /^(?:1|on|true|yes)$/i.test(env[COMPACTION_COST_OBSERVE_ENV]?.trim() ?? "");
}

/** Per-million-token rates, same units as `Model.cost`. */
export interface CompactionCostRates {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
}

export interface CompactionCostInput {
	readonly contextTokens: number;
	readonly triggerTokens: number;
	/** Below this the band is not "safe" (kept tail + summary reserve). */
	readonly reserveFloorTokens: number;
	/** Cache-read share of the last request's normalized prompt side, in [0, 1]. */
	readonly cacheReadShare: number;
	readonly rates: CompactionCostRates;
	/** Estimated summary output tokens (the compaction reserve). */
	readonly summaryTokens: number;
	/** Recent tail kept verbatim after the summary. */
	readonly keepRecentTokens: number;
}

export interface CompactionCostObservation {
	readonly kind: "compaction_cost_observation";
	readonly contextTokens: number;
	readonly continueCostUsd: number;
	readonly compactCostUsd: number;
	readonly decision: "compact" | "continue";
}

const perToken = (rate: number): number => (Number.isFinite(rate) && rate > 0 ? rate / 1_000_000 : 0);

/** `undefined` outside the safe band (at/above trigger, or at/below the reserve floor). */
export function observeCompactionCost(
	input: CompactionCostInput,
	decision: "compact" | "continue",
): CompactionCostObservation | undefined {
	const tokens = input.contextTokens;
	if (!Number.isFinite(tokens) || tokens >= input.triggerTokens || tokens <= input.reserveFloorTokens)
		return undefined;
	const share = Math.min(1, Math.max(0, Number.isFinite(input.cacheReadShare) ? input.cacheReadShare : 0));
	const r = input.rates;
	// Next request at the current size with the current read/uncached split.
	const continueCostUsd = tokens * (share * perToken(r.cacheRead) + (1 - share) * perToken(r.input));
	// Summary call (same prompt, summary output) + one cache rewrite of the post-summary prefix
	// + the next request reading that prefix.
	const post = input.summaryTokens + input.keepRecentTokens;
	const compactCostUsd =
		continueCostUsd +
		input.summaryTokens * perToken(r.output) +
		post * perToken(r.cacheWrite) +
		post * perToken(r.cacheRead);
	return { kind: "compaction_cost_observation", contextTokens: tokens, continueCostUsd, compactCostUsd, decision };
}
