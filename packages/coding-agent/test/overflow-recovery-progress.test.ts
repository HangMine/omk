import type { AgentMessage } from "omk-agent-core";
import { describe, expect, it } from "vitest";
import { overflowRecoveryFailureMessage } from "../src/core/compaction/overflow-recovery-progress.ts";

const toolResult = (toolName: string, chars: number): AgentMessage =>
	({
		role: "toolResult",
		toolCallId: `${toolName}-${chars}`,
		toolName,
		content: [{ type: "text", text: "x".repeat(chars) }],
		isError: false,
		timestamp: 0,
	}) as AgentMessage;

describe("overflowRecoveryFailureMessage (spec 061)", () => {
	it("names the oversized tool output even when a small result follows it", () => {
		// End-to-end through `omk -p`, the identical-loop guard appends a small blocked result last.
		const message = overflowRecoveryFailureMessage([toolResult("big", 400_000), toolResult("big", 60)], 64_000);
		expect(message).toMatch(
			/The output of tool "big" \(~100,000 tokens\) is larger than the 64,000-token context window/,
		);
	});

	it("keeps the generic advice when no tool output exceeds the window", () => {
		const message = overflowRecoveryFailureMessage([toolResult("read", 40_000)], 64_000);
		expect(message).toBe(
			"Context overflow recovery failed after two staged compact-and-retry attempts. Reduce the latest input or switch to a model with a larger effective context window.",
		);
	});
});
