/**
 * Shared summarization completion with a reasoning-budget fallback.
 *
 * A reasoning model can spend the entire output budget on thinking and stop for
 * `length` with no text (observed with claude-opus-5-5 at effort `max`). That is
 * not a durable summary. Retry once with a lower effort, or with reasoning
 * disabled when the model accepts it, and add a text reserve to the output cap.
 * A second empty `length` response still fails in `summaryTextOrThrow` instead
 * of committing an empty summary.
 */
import type { StreamFn } from "omk-agent-core";
import { uuidv7 } from "omk-agent-core";
import {
	type AssistantMessage,
	type Context,
	completeSimple,
	type Model,
	type RetryCallbacks,
	type RetryPolicy,
	retryAssistantCall,
	type SimpleStreamOptions,
} from "omk-ai";

/** True when a summary response used the whole output budget on reasoning and left no text. */
function reasoningExhaustedSummary(response: AssistantMessage, options: SimpleStreamOptions): boolean {
	if (options.reasoning === undefined || response.stopReason !== "length") return false;
	return !response.content.some((block) => block.type === "text" && block.text.trim().length > 0);
}

const SUMMARY_TEXT_RESERVE_TOKENS = 2048;
const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

/**
 * Build one fallback request for a reasoning-exhausted summary. Returns undefined
 * when neither disabling thinking, lowering effort, nor raising the cap changes
 * the request.
 */
function summaryFallbackOptions(model: Model<any>, options: SimpleStreamOptions): SimpleStreamOptions | undefined {
	if (options.reasoning === undefined) return undefined;
	const fallback: SimpleStreamOptions = { ...options };
	const supportsDisabledThinking =
		model.compat && "supportsDisabledThinking" in model.compat
			? model.compat.supportsDisabledThinking !== false
			: true;
	const canDisableThinking = model.thinkingLevelMap?.off !== null && supportsDisabledThinking;
	if (canDisableThinking) {
		delete fallback.reasoning;
	} else {
		const lower = THINKING_LEVELS.find((level) => typeof model.thinkingLevelMap?.[level] === "string");
		if (!lower) return undefined;
		fallback.reasoning = lower;
	}

	if (options.maxTokens !== undefined) {
		const modelMaxTokens = model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY;
		const withReserve = Math.min(options.maxTokens + SUMMARY_TEXT_RESERVE_TOKENS, modelMaxTokens);
		if (withReserve > options.maxTokens) fallback.maxTokens = withReserve;
	}

	if (fallback.reasoning === options.reasoning && fallback.maxTokens === options.maxTokens) return undefined;
	return fallback;
}

/**
 * Single choke point for every compaction/branch-summary summarization call.
 * Transient stream drops honor the configured retry policy; deterministic errors
 * and aborts return immediately. A reasoning-exhausted summary is retried once
 * with the safe fallback request.
 */
export async function completeSummarization(
	model: Model<any>,
	context: Context,
	options: SimpleStreamOptions,
	streamFn?: StreamFn,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
): Promise<AssistantMessage> {
	// Summaries are standalone requests, so isolate routing and avoid cache writes that cannot be reused.
	const requestOptions: SimpleStreamOptions = {
		...options,
		cacheRetention: "none",
		sessionId: uuidv7(),
	};
	const produce = async (request: SimpleStreamOptions): Promise<AssistantMessage> =>
		streamFn ? (await streamFn(model, context, request)).result() : completeSimple(model, context, request);
	const response = await retryAssistantCall(() => produce(requestOptions), retry, requestOptions.signal, callbacks);
	if (!reasoningExhaustedSummary(response, requestOptions)) return response;
	const fallbackOptions = summaryFallbackOptions(model, requestOptions);
	if (!fallbackOptions) return response;
	return retryAssistantCall(() => produce(fallbackOptions), retry, fallbackOptions.signal, callbacks);
}
