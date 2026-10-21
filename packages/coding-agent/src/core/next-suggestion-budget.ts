/**
 * Spec 103 §2.1/§2.4: independent caps for the next-task suggestion request.
 *
 * Everything here is used only with `OMK_NEXT_SUGGESTIONS_CAPS` on (default
 * off). With the flag off the suggestion request and its skip decisions are
 * byte-identical to the spec 091 "reuse" arm. No default cap values are
 * invented: a missing or invalid budget skips the suggestion (fail closed).
 */
import type { Api, Context, Model, SimpleStreamOptions, ThinkingLevel } from "omk-ai";
import { promptCacheCapability } from "omk-ai";

export const NEXT_SUGGESTIONS_CAPS_ENV = "OMK_NEXT_SUGGESTIONS_CAPS";
export const SUGGESTION_DEADLINE_ENV = "OMK_NEXT_SUGGESTIONS_DEADLINE_MS";
export const SUGGESTION_MAX_COST_ENV = "OMK_NEXT_SUGGESTIONS_MAX_COST_USD";
export const SUGGESTION_MAX_REASONING_ENV = "OMK_NEXT_SUGGESTIONS_MAX_REASONING";

export interface SuggestionBudget {
	readonly maxReasoning: ThinkingLevel | "inherit";
	readonly deadlineMs: number;
	readonly maxCostUsd: number;
}

const LEVELS: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

export function isSuggestionCapsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return /^(?:1|on|true|yes)$/i.test(env[NEXT_SUGGESTIONS_CAPS_ENV]?.trim() ?? "");
}

function positive(raw: string | undefined): number | undefined {
	if (raw === undefined || raw.trim() === "") return undefined;
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Budget from env; `undefined` when any required value is missing or invalid. */
export function suggestionBudgetFromEnv(env: NodeJS.ProcessEnv = process.env): SuggestionBudget | undefined {
	const deadlineMs = positive(env[SUGGESTION_DEADLINE_ENV]);
	const maxCostUsd = positive(env[SUGGESTION_MAX_COST_ENV]);
	const rawLevel = env[SUGGESTION_MAX_REASONING_ENV]?.trim() || "inherit";
	const maxReasoning = rawLevel === "inherit" ? "inherit" : LEVELS.find((level) => level === rawLevel);
	if (deadlineMs === undefined || maxCostUsd === undefined || maxReasoning === undefined) return undefined;
	return { maxReasoning, deadlineMs: Math.floor(deadlineMs), maxCostUsd };
}

/** `inherit` keeps the recorded options object; a lower cap only lowers reasoning, never raises it. */
export function cappedSuggestionOptions(
	options: SimpleStreamOptions | undefined,
	budget: SuggestionBudget,
): SimpleStreamOptions | undefined {
	const current = options?.reasoning;
	if (budget.maxReasoning === "inherit" || !current) return options;
	if (LEVELS.indexOf(current) <= LEVELS.indexOf(budget.maxReasoning)) return options;
	return { ...options, reasoning: budget.maxReasoning };
}

/** Rough prompt-side token count: serialized context length / 3 (leans high on purpose). */
export function estimateContextInputTokens(context: Context): number {
	return Math.ceil(JSON.stringify(context).length / 3);
}

/**
 * Pre-flight upper-bound estimate in USD: every input token at the highest of
 * the model's input / cache-read / cache-write rates, plus the full output cap.
 * Rates are per million tokens.
 */
export function estimateSuggestionCostUsd(model: Model<Api>, context: Context, maxOutputTokens: number): number {
	const cost = model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	const inputRate = Math.max(cost.input ?? 0, cost.cacheRead ?? 0, cost.cacheWrite ?? 0);
	return (estimateContextInputTokens(context) * inputRate + maxOutputTokens * (cost.output ?? 0)) / 1_000_000;
}

export type CacheCheck = "ok" | "no_cache_support" | "cache_capability_unknown" | "cache_cold";

/** Table-based replacement for `supportsPromptCache` + `cacheTtlMs`; record start time is the anchor. */
export function checkSuggestionCache(
	model: Model<Api>,
	options: SimpleStreamOptions | undefined,
	elapsedMs: number,
): CacheCheck {
	const capability = promptCacheCapability(model, options?.cacheRetention);
	if (capability.kind === "none") return "no_cache_support";
	if (capability.kind === "unknown") return "cache_capability_unknown";
	return elapsedMs >= capability.coldAfterMs ? "cache_cold" : "ok";
}
