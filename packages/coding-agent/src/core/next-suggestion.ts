/**
 * Spec 091 stage 1: one next-task sentence after a completed turn.
 *
 * Default off (`OMK_NEXT_SUGGESTIONS`). When off, nothing here is installed:
 * no stream wrapper, no extra provider call, request bytes unchanged.
 *
 * When on, {@link MainRequestRecorder} wraps the agent's stream function and
 * passes every main request through unchanged, only remembering the last
 * `(model, context, options)`. The suggestion request reuses that context
 * byte-for-byte (same system prompt, tools and message objects), appends the
 * turn's final assistant message and then the suggestion instruction at the
 * very end, so the provider prompt cache covers the shared prefix.
 *
 * The suggestion request and its response never touch agent state, the
 * session log, compaction input, or the next main request.
 */
import type { StreamFn } from "omk-agent-core";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions, ThinkingBudgets, UserMessage } from "omk-ai";

export const NEXT_SUGGESTIONS_ENV = "OMK_NEXT_SUGGESTIONS";
/** PREREG: skip when ≥ 90% of the active quota window is used. */
export const NEAR_USAGE_LIMIT_PERCENT = 90;
/** Cache considered cold this long after the last main request (default/`short` retention). */
export const SHORT_CACHE_TTL_MS = 5 * 60_000;
/** Cache considered cold this long after the last main request with `long` retention. */
export const LONG_CACHE_TTL_MS = 60 * 60_000;
export const MAX_SUGGESTION_CHARS = 200;
/** The suggestion request differs from the main request only in this output cap. */
export const SUGGESTION_MAX_TOKENS = 128;
/**
 * Default thinking budgets, mirroring omk-ai's `adjustMaxTokensForThinking`
 * (xhigh/max/ultra clamp to high). Used only to size the suggestion cap.
 */
export const DEFAULT_THINKING_BUDGETS: Required<ThinkingBudgets> = {
	minimal: 1024,
	low: 2048,
	medium: 8192,
	high: 16384,
};

/**
 * Output cap for the suggestion request. Reasoning is never disabled (that
 * would change the request bytes); with reasoning on the cap is the thinking
 * budget + 128, with reasoning off it is 128.
 */
export function suggestionMaxTokens(options: SimpleStreamOptions | undefined): number {
	const level = options?.reasoning;
	if (!level) return SUGGESTION_MAX_TOKENS;
	const key: keyof ThinkingBudgets = level === "xhigh" || level === "max" || level === "ultra" ? "high" : level;
	const budget = options?.thinkingBudgets?.[key] ?? DEFAULT_THINKING_BUDGETS[key];
	return budget + SUGGESTION_MAX_TOKENS;
}
/** The quota check is abandoned (and the suggestion skipped) after this long. */
export const USAGE_CHECK_TIMEOUT_MS = 2_000;

/**
 * Quota usage for the 90% rule: a used percent, `"no_quota"` when the provider
 * has no quota window at all, or `"unavailable"` when the check failed or timed
 * out (fail closed: the suggestion is skipped).
 */
export type QuotaUsage = number | "no_quota" | "unavailable";

export const SUGGESTION_INSTRUCTION =
	"[next-task suggestion] Based on the conversation so far, write the single next request the user is most " +
	"likely to send. Reply with that one sentence only, in the user's language, with no quotes, no preamble, " +
	"and no tool calls.";

export function isNextSuggestionsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return /^(?:1|on|true|yes)$/i.test(env[NEXT_SUGGESTIONS_ENV]?.trim() ?? "");
}

export interface RecordedMainRequest {
	readonly model: Model<Api>;
	readonly context: Context;
	readonly options: SimpleStreamOptions | undefined;
	readonly atMs: number;
}

/** Pass-through stream wrapper that remembers the last main request. */
export class MainRequestRecorder {
	private last: RecordedMainRequest | undefined;
	private readonly now: () => number;

	constructor(now: () => number = Date.now) {
		this.now = now;
	}

	wrap(inner: StreamFn): StreamFn {
		const wrapped: StreamFn = (model, context, options) => {
			this.last = { model, context, options, atMs: this.now() };
			return inner(model, context, options);
		};
		return wrapped;
	}

	get lastRequest(): RecordedMainRequest | undefined {
		return this.last;
	}
}

export type SuggestionSkipReason =
	| "no_record"
	| "not_completed"
	| "error"
	| "aborted"
	| "model_changed"
	| "no_cache_support"
	| "cache_cold"
	| "near_usage_limit"
	| "usage_unavailable";

export interface SuggestionPlanInput {
	readonly record: RecordedMainRequest | undefined;
	readonly outcome: "completed" | "failed" | "aborted";
	readonly finalAssistant: AssistantMessage | undefined;
	readonly currentModel: { readonly provider: string; readonly id: string } | undefined;
	readonly nowMs: number;
	readonly usage: QuotaUsage;
}

export type SuggestionPlan =
	| { readonly kind: "skip"; readonly reason: SuggestionSkipReason }
	| { readonly kind: "request"; readonly record: RecordedMainRequest; readonly finalAssistant: AssistantMessage };

export function cacheTtlMs(options: SimpleStreamOptions | undefined): number {
	if (options?.cacheRetention === "none") return 0;
	return options?.cacheRetention === "long" ? LONG_CACHE_TTL_MS : SHORT_CACHE_TTL_MS;
}

export function supportsPromptCache(model: Model<Api>, options: SimpleStreamOptions | undefined): boolean {
	return options?.cacheRetention !== "none" && (model.cost?.cacheRead ?? 0) > 0;
}

export function planSuggestion(input: SuggestionPlanInput): SuggestionPlan {
	const skip = (reason: SuggestionSkipReason): SuggestionPlan => ({ kind: "skip", reason });
	if (input.outcome === "aborted") return skip("aborted");
	if (input.outcome !== "completed") return skip("not_completed");
	const final = input.finalAssistant;
	if (final?.stopReason === "aborted") return skip("aborted");
	if (!final || final.stopReason === "error") return skip("error");
	const record = input.record;
	if (!record || record.atMs > final.timestamp + 1) return skip("no_record");
	const model = input.currentModel;
	if (!model || model.provider !== record.model.provider || model.id !== record.model.id) {
		return skip("model_changed");
	}
	if (!supportsPromptCache(record.model, record.options)) return skip("no_cache_support");
	if (input.nowMs - record.atMs >= cacheTtlMs(record.options)) return skip("cache_cold");
	if (input.usage === "unavailable") return skip("usage_unavailable");
	if (typeof input.usage === "number" && !(input.usage < NEAR_USAGE_LIMIT_PERCENT)) {
		return skip("near_usage_limit");
	}
	return { kind: "request", record, finalAssistant: final };
}

/** The recorded main context with the final answer and the instruction appended at the end only. */
export function buildSuggestionContext(record: RecordedMainRequest, finalAssistant: AssistantMessage): Context {
	const instruction: UserMessage = {
		role: "user",
		content: [{ type: "text", text: SUGGESTION_INSTRUCTION }],
		timestamp: finalAssistant.timestamp + 1,
	};
	return { ...record.context, messages: [...record.context.messages, finalAssistant, instruction] };
}

export function extractSuggestion(message: AssistantMessage): string | undefined {
	if (message.stopReason === "error" || message.stopReason === "aborted") return undefined;
	const text = message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join(" ");
	const line = text
		.split(/\r?\n/)
		.map((part) => part.trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, ""))
		.find((part) => part.length > 0);
	if (!line) return undefined;
	return line.length > MAX_SUGGESTION_CHARS ? `${line.slice(0, MAX_SUGGESTION_CHARS - 1)}…` : line;
}

/** Run the background suggestion request; never throws. */
export async function requestNextSuggestion(
	streamFn: StreamFn,
	record: RecordedMainRequest,
	finalAssistant: AssistantMessage,
	signal: AbortSignal,
): Promise<string | undefined> {
	try {
		const stream = await streamFn(record.model, buildSuggestionContext(record, finalAssistant), {
			...record.options,
			maxTokens: suggestionMaxTokens(record.options),
			signal,
		});
		const result = await stream.result();
		return signal.aborted ? undefined : extractSuggestion(result);
	} catch {
		return undefined;
	}
}
