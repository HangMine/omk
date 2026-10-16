/**
 * Spec 061 scenario (run only by oversized-output-hang.test.ts in a child process).
 *
 * One tool output (~400KB, ~100k tokens) is larger than the whole 64k window and the faux
 * provider reports realistic usage (the prompt it received). On main the provider answer is a
 * success-shaped "silent overflow" (stopReason stop, usage.input > contextWindow); overflow
 * recovery compacts, continues, re-runs the tool and overflows again forever, because the
 * recovery counter is reset by the injected continuation user message and by the overflowing
 * assistant itself. The loop never yields to the timer queue, so vitest's own timeout cannot fire.
 */
import type { AgentMessage, AgentTool } from "omk-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream } from "omk-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createTokenCounterForMode } from "../../src/core/context-budget-token-counter.ts";
import { estimateContextInputTokens } from "../../src/core/prompt-budget.ts";
import { createHarness, fauxModel, type Harness } from "../test-harness.ts";

const realisticCounter = createTokenCounterForMode("fallback");
let replyId = 0;

/**
 * Faux reply whose usage reports the prompt it actually received, counted like a provider would
 * (system prompt + tools + messages): a tool call after user input, then a short text reply.
 */
function realisticReply(context: Parameters<Harness["agent"]["streamFn"]>[1]): AssistantMessage {
	const input = estimateContextInputTokens({
		systemPrompt: String(context.systemPrompt ?? ""),
		messages: context.messages as AgentMessage[],
		tools: (context.tools ?? []) as AgentTool[],
		modelId: fauxModel.id,
		tokenCounter: realisticCounter,
	}).localTokens;
	const last = context.messages.at(-1);
	const toolTurn = last?.role === "user";
	return {
		role: "assistant",
		content: toolTurn
			? [{ type: "toolCall", id: `rt_${++replyId}`, name: "out", arguments: {} }]
			: [{ type: "text", text: "ok" }],
		api: fauxModel.api,
		provider: fauxModel.provider,
		model: fauxModel.id,
		usage: {
			input,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: input + 10,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: toolTurn ? "toolUse" : "stop",
		timestamp: Date.now(),
	};
}

function outputTool(text: string): AgentTool {
	return {
		name: "out",
		label: "out",
		description: "returns a fixed output",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text }], details: {} }),
	};
}

/** Answer summarization requests with a valid summary so compaction can actually succeed. */
interface SummaryControl {
	summaries: number;
	/** Model calls in the current prompt; admission (hard-limit) compaction runs before the first. */
	callsThisPrompt: number;
	failEmergency: boolean;
}

function answerSummaries(h: Harness, failEmergency: boolean, realisticUsage = true): SummaryControl {
	const counter: SummaryControl = { summaries: 0, callsThisPrompt: 0, failEmergency };
	const original = h.agent.streamFn;
	h.agent.streamFn = (model, context, options) => {
		if (!/summar/i.test(String(context.systemPrompt ?? ""))) {
			counter.callsThisPrompt++;
			if (!realisticUsage) return original(model, context, options);
			const reply = realisticReply(context);
			const replyStream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				replyStream.push({ type: "start", partial: reply });
				replyStream.push({ type: "done", reason: reply.stopReason as "stop" | "toolUse", message: reply });
			});
			return replyStream;
		}
		counter.summaries++;
		const emergency = counter.failEmergency && counter.callsThisPrompt === 0;
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "## Goal\nbench\n## Progress\nran tool turns" }],
			api: fauxModel.api,
			provider: fauxModel.provider,
			model: fauxModel.id,
			usage: {
				input: 100,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 120,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: emergency ? "error" : "stop",
			errorMessage: emergency ? "faux summarizer unavailable" : undefined,
			timestamp: Date.now(),
		};
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({ type: "start", partial: message });
			if (emergency) stream.push({ type: "error", reason: "error", error: message });
			else stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	};
	return counter;
}

const MAX_OVERFLOW_RECOVERY_ATTEMPTS = 2; // agent-session.ts

describe.runIf(process.env.SPEC061_SCENARIO === "1")("061 oversized tool output scenario", () => {
	it("settles a prompt whose single tool output exceeds the window", async () => {
		const h: Harness = createHarness({
			contextWindow: 64_000,
			baseToolsOverride: { out: outputTool("y".repeat(400_000)) },
			responses: [{ toolCalls: [{ name: "out", args: {} }] }, "ok"],
		});
		try {
			answerSummaries(h, false);
			let overflowStarts = 0;
			h.session.subscribe((event) => {
				if (event.type === "compaction_start" && event.reason === "overflow") {
					overflowStarts++;
					// Breadcrumb for the parent test: the bound is exceeded long before the wall clock.
					if (overflowStarts === 10) process.stderr.write("061: 10 overflow compactions in one prompt\n");
				}
			});
			// Settles either by completing or by a reported recovery failure; it must not hang.
			await h.session.prompt("turn 1").catch(() => undefined);
			expect(overflowStarts).toBeLessThanOrEqual(MAX_OVERFLOW_RECOVERY_ATTEMPTS);
		} finally {
			h.cleanup();
		}
	}, 30_000);
});
