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

/** True when the model spent the whole summary budget on reasoning and produced no text. */
export function reasoningExhaustedSummary(response: AssistantMessage, options: SimpleStreamOptions): boolean {
	return (
		options.reasoning !== undefined &&
		response.stopReason === "length" &&
		!response.content.some((content) => content.type === "text" && content.text.trim().length > 0)
	);
}

const SUMMARY_TEXT_RESERVE_TOKENS = 2048;
const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

/**
 * Build one fallback request for a reasoning-exhausted summary. Returns undefined
 * when neither disabling thinking, lowering effort, nor raising the cap changes
 * the request.
 */
export function summaryFallbackOptions(
	model: Model<any>,
	options: SimpleStreamOptions,
): SimpleStreamOptions | undefined {
	if (options.reasoning === undefined) return undefined;
	const fallback: SimpleStreamOptions = { ...options };
	const supportsDisabledThinking =
		model.compat && "supportsDisabledThinking" in model.compat
			? model.compat.supportsDisabledThinking !== false
			: true;
	if (model.thinkingLevelMap?.off !== null && supportsDisabledThinking) {
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

function requestSummary(
	model: Model<any>,
	context: Context,
	options: SimpleStreamOptions,
	retry?: RetryPolicy,
	signal?: AbortSignal,
	callbacks?: RetryCallbacks,
): Promise<AssistantMessage> {
	return retryAssistantCall(() => completeSimple(model, context, options), retry, signal, callbacks);
}

/** Request a summary and retry once with the safe fallback when reasoning exhausts the cap. */
export async function requestSummaryWithFallback(
	model: Model<any>,
	context: Context,
	options: SimpleStreamOptions,
	retry?: RetryPolicy,
	signal?: AbortSignal,
	callbacks?: RetryCallbacks,
): Promise<AssistantMessage> {
	const response = await requestSummary(model, context, options, retry, signal, callbacks);
	if (!reasoningExhaustedSummary(response, options)) return response;
	const fallback = summaryFallbackOptions(model, options);
	return fallback ? requestSummary(model, context, fallback, retry, signal, callbacks) : response;
}
