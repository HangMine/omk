/**
 * Spec 052: whether a system prompt changed by `before_agent_start` handlers
 * keeps the planned cache boundary. Text appended after the whole planned
 * prompt (finish-check's discipline, prompt presets) leaves the stable prefix
 * byte-identical, so the boundary still holds. Anything else (a replacement,
 * an edit, a prepend) may move bytes inside the prefix and drops it.
 *
 * Spec 102 (`OMK_PREFIX_BOUNDARY`, default off): with the flag on, the boundary
 * is also kept when only the dynamic tail after it differs, as long as the
 * prefix is byte-identical (UTF-16 code units) and the boundary does not split
 * a surrogate pair in either string. Flag off is exactly the spec 052 rule.
 */

export interface SystemPromptCachePlan {
	readonly prompt: string;
	readonly cacheBoundary: number | undefined;
}

export interface SystemPromptCacheState {
	readonly cacheBoundary: number | undefined;
	readonly bypass: boolean;
	/**
	 * Spec 102 cause, set only when the prefix before the boundary is identical
	 * but the spec 052 rule alone would drop the boundary: `suffix_changed`
	 * (flag on, kept), `bypass_surrogate` (flag on, boundary splits a surrogate
	 * pair), `flag_off` (flag off, the prefix rule would have kept it).
	 */
	readonly cause?: PrefixBoundaryCause;
}

export type PrefixBoundaryCause = "suffix_changed" | "bypass_surrogate" | "flag_off";

export interface SystemPromptCacheOptions {
	/** Spec 102 prefix rule. Defaults to `OMK_PREFIX_BOUNDARY` from the environment. */
	readonly prefixBoundary?: boolean;
}

const ENABLED_VALUES = new Set(["1", "true", "on", "yes"]);

export function isPrefixBoundaryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return ENABLED_VALUES.has((env.OMK_PREFIX_BOUNDARY ?? "").trim().toLowerCase());
}

/** True when `boundary` falls between a high and a low surrogate of `text`. */
export function splitsSurrogatePair(text: string, boundary: number): boolean {
	if (boundary <= 0 || boundary >= text.length) return false;
	const before = text.charCodeAt(boundary - 1);
	const at = text.charCodeAt(boundary);
	return before >= 0xd800 && before <= 0xdbff && at >= 0xdc00 && at <= 0xdfff;
}

export function resolveExtendedSystemPromptCache(
	plan: SystemPromptCachePlan,
	systemPrompt: string,
	options: SystemPromptCacheOptions = {},
): SystemPromptCacheState {
	if (systemPrompt === plan.prompt) return { cacheBoundary: plan.cacheBoundary, bypass: false };
	const boundary = plan.cacheBoundary;
	const validBoundary =
		boundary !== undefined && Number.isSafeInteger(boundary) && boundary > 0 && boundary <= plan.prompt.length;
	if (plan.prompt.length > 0 && validBoundary && systemPrompt.startsWith(plan.prompt)) {
		return { cacheBoundary: boundary, bypass: false };
	}
	const prefixIdentical =
		plan.prompt.length > 0 &&
		validBoundary &&
		systemPrompt.length >= boundary &&
		systemPrompt.slice(0, boundary) === plan.prompt.slice(0, boundary);
	if (!prefixIdentical) return { cacheBoundary: undefined, bypass: true };
	const prefixBoundary = options.prefixBoundary ?? isPrefixBoundaryEnabled();
	if (!prefixBoundary) return { cacheBoundary: undefined, bypass: true, cause: "flag_off" };
	if (splitsSurrogatePair(plan.prompt, boundary) || splitsSurrogatePair(systemPrompt, boundary)) {
		return { cacheBoundary: undefined, bypass: true, cause: "bypass_surrogate" };
	}
	return { cacheBoundary: boundary, bypass: false, cause: "suffix_changed" };
}

/**
 * Hand the cause from the session (which knows the turn plan) to the request
 * trace (which only sees the outgoing context), keyed by the exact system
 * prompt sent. Bounded so a long-lived process keeps only recent prompts.
 */
const CAUSE_LIMIT = 16;
const causes = new Map<string, PrefixBoundaryCause>();

export function recordPrefixBoundaryCause(systemPrompt: string, cause: PrefixBoundaryCause | undefined): void {
	causes.delete(systemPrompt);
	if (cause === undefined) return;
	causes.set(systemPrompt, cause);
	if (causes.size > CAUSE_LIMIT) causes.delete(causes.keys().next().value as string);
}

export function prefixBoundaryCauseFor(systemPrompt: string | undefined): PrefixBoundaryCause | undefined {
	return systemPrompt === undefined ? undefined : causes.get(systemPrompt);
}

/** Resolve for the session's extension override and record the cause for the request trace. */
export function resolveAndRecordSystemPromptCache(
	plan: SystemPromptCachePlan,
	systemPrompt: string,
): SystemPromptCacheState {
	const cache = resolveExtendedSystemPromptCache(plan, systemPrompt);
	recordPrefixBoundaryCause(systemPrompt, cache.cause);
	return cache;
}
