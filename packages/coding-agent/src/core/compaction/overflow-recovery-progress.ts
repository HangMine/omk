import type { AgentMessage } from "omk-agent-core";
import type { AssistantMessage } from "omk-ai";
import { estimateTokens } from "./compaction.ts";

/**
 * Spec 061: progress that re-arms overflow recovery. Overflow recovery counts consecutive overflow
 * compactions without progress; it resets on a new user prompt and here, on a successful reply whose
 * usage fits the window and that either
 * - has no tool calls (a text turn completed in the window), or
 * - came right after a tool result (that result was consumed in the window).
 *
 * Not progress: the empty user message Agent.continue() injects after compaction, retries, and a
 * tool call answering that empty prompt. That call fits only because the oversized tool output has
 * not come back yet; counting it (or any in-window reply) made a single tool output larger than the
 * window loop tool -> overflow -> compact -> continue forever.
 *
 * `messages` is agent state at message_end; the finalized reply may be a copy of the last entry.
 */
export function isOverflowRecoveryProgress(
	message: AssistantMessage,
	messages: readonly AgentMessage[],
	contextWindow: number,
): boolean {
	if (message.stopReason === "error") return false;
	if (contextWindow > 0 && message.usage.input + message.usage.cacheRead > contextWindow) return false;
	if (!message.content.some((block) => block.type === "toolCall")) return true;
	const last = messages.at(-1);
	const previous = last?.role === "assistant" ? messages.at(-2) : last;
	return previous?.role === "toolResult";
}

/** Prefix of every overflow-recovery give-up message; headless modes key their non-zero exit on it. */
export const OVERFLOW_RECOVERY_FAILED = "Context overflow recovery failed after two staged compact-and-retry attempts.";

/** User-visible reason when overflow recovery gives up; names a tool output larger than the window. */
export function overflowRecoveryFailureMessage(messages: readonly AgentMessage[], contextWindow: number): string {
	const lastToolResult = [...messages].reverse().find((m) => m.role === "toolResult");
	const toolTokens = lastToolResult ? estimateTokens(lastToolResult) : 0;
	if (lastToolResult && contextWindow > 0 && toolTokens > contextWindow) {
		const toolName = (lastToolResult as { toolName?: string }).toolName ?? "tool";
		return (
			`${OVERFLOW_RECOVERY_FAILED} The output of tool "${toolName}" (~${toolTokens.toLocaleString("en-US")} tokens) ` +
			`is larger than the ${contextWindow.toLocaleString("en-US")}-token context window, so compaction cannot make ` +
			"it fit. Limit the tool output (fewer lines, a narrower query) or switch to a model with a larger context window."
		);
	}
	return `${OVERFLOW_RECOVERY_FAILED} Reduce the latest input or switch to a model with a larger effective context window.`;
}
