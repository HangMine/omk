import type { AgentMessage } from "omk-agent-core";
import type { AssistantMessage, Context, Message } from "omk-ai";
import { describe, expect, it } from "vitest";
import { admissionProjectionLeaves } from "../src/core/admission-json-cache.ts";
import {
	countTextParts,
	createFallbackTokenCounter,
	createTokenCounterRegistry,
	estimateTextTokensFromParts,
	type TokenCounterAdapter,
} from "../src/core/context-budget-token-counter.ts";
import { estimateContextInputTokens } from "../src/core/prompt-budget.ts";
import { snapshotRequestAdmissionPolicy } from "../src/core/request-admission-policy.ts";
import { projectRequestForAdmission } from "../src/core/request-admission-projection.ts";
import { estimateTextTokensFromPartStats, textPartStats } from "../src/core/text-token-estimate.ts";

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const assistant = (content: AssistantMessage["content"], timestamp: number): AssistantMessage => ({
	role: "assistant",
	content,
	api: "openai-completions",
	provider: "fake",
	model: "fake-1",
	usage,
	stopReason: "stop",
	timestamp,
});

function transcript(): AgentMessage[] {
	return [
		{ role: "user", content: "plain 한글 😀 export const x = 1", timestamp: 1 },
		assistant(
			[
				{ type: "thinking", thinking: "closed-turn reasoning that admission drops" },
				{ type: "text", text: "answer one" },
				{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls -la", deep: { n: 1 } } },
			],
			2,
		),
		{
			role: "toolResult",
			toolCallId: "t1",
			toolName: "bash",
			isError: false,
			content: [{ type: "text", text: "secret-token-abc file.txt" }],
			timestamp: 3,
		},
		{ role: "user", content: [{ type: "text", text: "second question" }], timestamp: 4 },
		assistant(
			[
				{ type: "thinking", thinking: "open turn" },
				{ type: "text", text: "answer two" },
			],
			5,
		),
	] as AgentMessage[];
}

const counter = createFallbackTokenCounter();
const estimate = (messages: readonly AgentMessage[], tokenCounter: TokenCounterAdapter = counter) =>
	estimateContextInputTokens({ systemPrompt: "sys", messages, tools: [], modelId: "fake-1", tokenCounter });
/** Uncached truth: fresh objects never hit the WeakMap. */
const truth = (messages: readonly AgentMessage[], tokenCounter: TokenCounterAdapter = counter) =>
	estimate(structuredClone(messages), tokenCounter);

describe("spec 062 admission JSON cache: cached equals uncached", () => {
	it("repeat calls on the same objects give the same estimate", () => {
		const messages = transcript();
		const first = estimate(messages);
		expect(first).toEqual(truth(messages));
		expect(estimate(messages)).toEqual(first);
		expect(estimate(messages)).toEqual(truth(messages));
	});

	it("in-place same-length masking (compaction/redaction) is never served stale", () => {
		const messages = transcript();
		estimate(messages);
		const result = messages[2] as Extract<AgentMessage, { role: "toolResult" }>;
		const block = result.content[0] as { text: string };
		block.text = block.text.replace("secret-token-abc", "****************");
		expect(estimate(messages)).toEqual(truth(messages));
		block.text = "ありがとう 한글 masked".padEnd(block.text.length, "x");
		expect(estimate(messages)).toEqual(truth(messages));
	});

	it("in-place tool-call argument and reasoning edits recompute", () => {
		const messages = transcript();
		estimate(messages);
		const call = (messages[1] as AssistantMessage).content[2] as unknown as { arguments: { deep: { n: number } } };
		call.arguments.deep.n = 2;
		expect(estimate(messages)).toEqual(truth(messages));
		(messages[1] as AssistantMessage).content.splice(0, 1);
		expect(estimate(messages)).toEqual(truth(messages));
		(messages[1] as AssistantMessage).content.push({ type: "text", text: "appended in place" });
		expect(estimate(messages)).toEqual(truth(messages));
		(messages[1] as AssistantMessage).content.unshift({ type: "thinking", thinking: "new reasoning" });
		expect(estimate(messages)).toEqual(truth(messages));
	});

	it("compaction, branch switch and resume (new arrays / new objects) match uncached", () => {
		const messages = transcript();
		estimate(messages);
		const compacted = [
			{ role: "compactionSummary", summary: "summary of earlier work", tokensBefore: 10, timestamp: 6 },
			...messages.slice(3),
		] as AgentMessage[];
		expect(estimate(compacted)).toEqual(truth(compacted));
		const branch = messages.slice(0, 2);
		expect(estimate(branch)).toEqual(truth(branch));
		const resumed = structuredClone(messages);
		expect(estimate(resumed)).toEqual(estimate(messages));
	});

	it("non-fallback counters still receive the full parts", () => {
		const seen: string[] = [];
		const bpe: TokenCounterAdapter = {
			id: "fake-bpe",
			priority: 80,
			isAvailable: () => true,
			supports: () => true,
			countText(input) {
				seen.push(input);
				return { ...counter.countText(input, "fake-1"), tokenizer: "fake-bpe", tokens: input.length };
			},
		};
		const registry = createTokenCounterRegistry({ adapters: [bpe] });
		const messages = transcript();
		estimate(messages, registry);
		expect(estimate(messages, registry)).toEqual(truth(messages, registry));
		expect(seen.length).toBeGreaterThan(0);
	});

	it("non-plain values are never cached", () => {
		expect(admissionProjectionLeaves({ a: new Date(0) })).toBeUndefined();
		expect(admissionProjectionLeaves({ toJSON: 1 })).toBeUndefined();
		const accessor = {};
		Object.defineProperty(accessor, "x", { get: () => 1, enumerable: true });
		expect(admissionProjectionLeaves(accessor)).toBeUndefined();
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(admissionProjectionLeaves(cyclic)).toBeUndefined();
		const shared = { k: 1 };
		expect(admissionProjectionLeaves([shared, shared])).toBeDefined();
	});
});

describe("spec 062 request admission projection cache", () => {
	const context = (messages: Message[]): Context => ({ systemPrompt: "sys", messages, tools: [] });
	const count = (ctx: Context, maxSerializedChars = 2_000_000) => {
		const projection = projectRequestForAdmission(ctx, snapshotRequestAdmissionPolicy({ maxSerializedChars }));
		return {
			parts: projection.messageParts.join(""),
			tokens: countTextParts(counter, projection.messageParts, "fake-1", projection.statsAt),
			plain: estimateTextTokensFromParts(projection.messageParts, "fake-1"),
			images: projection.imageCount,
		};
	};

	it("hits equal uncached, including after in-place edits", () => {
		const messages = transcript().filter((m) => m.role !== "custom") as Message[];
		const first = count(context(messages));
		expect(first.tokens).toEqual(first.plain);
		expect(count(context(messages))).toEqual(count(context(structuredClone(messages))));
		((messages[2] as Extract<Message, { role: "toolResult" }>).content[0] as { text: string }).text =
			"same length but other text";
		const after = count(context(messages));
		expect(after).toEqual(count(context(structuredClone(messages))));
		expect(after.tokens).toEqual(after.plain);
	});

	it("a cache hit still trips the representation limit", () => {
		const messages = transcript() as Message[];
		const size = count(context(messages)).parts.length;
		expect(() => count(context(messages), size - 10)).toThrow("admission.representation_limit");
		expect(() => count(context(structuredClone(messages)), size - 10)).toThrow("admission.representation_limit");
	});
});

describe("spec 062 part statistics", () => {
	it("summed part stats equal the scanning estimator, neutral or not", () => {
		const cases: string[][] = [
			['{"a":1}', ",", '{"b":"한글 😀 function"}'],
			["abc", "def"],
			["", "  [", "1", "]  "],
			["\ud83d", "\ude00"],
			["export", " const", " x"],
		];
		for (const parts of cases) {
			const stats = parts.map(textPartStats);
			expect(estimateTextTokensFromPartStats(parts, (i) => stats[i], "m")).toEqual(
				estimateTextTokensFromParts(parts, "m"),
			);
			expect(estimateTextTokensFromPartStats(parts, () => undefined, "m")).toEqual(
				estimateTextTokensFromParts(parts, "m"),
			);
		}
	});
});
