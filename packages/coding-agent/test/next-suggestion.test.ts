import type { AssistantMessage, Context } from "omk-ai";
import { getModel } from "omk-ai";
import { describe, expect, it } from "vitest";
import {
	buildSuggestionContext,
	extractSuggestion,
	isNextSuggestionsEnabled,
	LONG_CACHE_TTL_MS,
	MainRequestRecorder,
	planSuggestion,
	type RecordedMainRequest,
	SHORT_CACHE_TTL_MS,
	SUGGESTION_INSTRUCTION,
} from "../src/core/next-suggestion.ts";

const model = getModel("anthropic", "claude-sonnet-4-5")!;

function assistant(text: string, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1000,
		...overrides,
	};
}

const context: Context = {
	systemPrompt: "system",
	messages: [{ role: "user", content: [{ type: "text", text: "fix the parser" }], timestamp: 900 }],
	tools: [],
};
const record: RecordedMainRequest = { model, context, options: undefined, atMs: 990 };
const base = {
	record,
	outcome: "completed" as const,
	finalAssistant: assistant("Done."),
	currentModel: { provider: model.provider, id: model.id },
	nowMs: 2000,
	usedPercent: undefined,
};

describe("spec 091 stage 1: next-suggestion core", () => {
	it("is off unless OMK_NEXT_SUGGESTIONS is set to an on value", () => {
		expect(isNextSuggestionsEnabled({})).toBe(false);
		expect(isNextSuggestionsEnabled({ OMK_NEXT_SUGGESTIONS: "0" })).toBe(false);
		expect(isNextSuggestionsEnabled({ OMK_NEXT_SUGGESTIONS: "off" })).toBe(false);
		expect(isNextSuggestionsEnabled({ OMK_NEXT_SUGGESTIONS: "1" })).toBe(true);
		expect(isNextSuggestionsEnabled({ OMK_NEXT_SUGGESTIONS: "on" })).toBe(true);
	});

	it("the recorder passes main requests through unchanged", () => {
		const seen: unknown[][] = [];
		const sentinel = {} as never;
		const inner = ((...args: unknown[]) => {
			seen.push(args);
			return sentinel;
		}) as never;
		const recorder = new MainRequestRecorder(() => 5);
		const options = { maxTokens: 10 };
		expect(recorder.wrap(inner)(model, context, options)).toBe(sentinel);
		expect(seen[0]?.[0]).toBe(model);
		expect(seen[0]?.[1]).toBe(context);
		expect(seen[0]?.[2]).toBe(options);
		expect(recorder.lastRequest).toEqual({ model, context, options, atMs: 5 });
	});

	it("keeps the main prefix byte-identical and appends the instruction only at the end", () => {
		const final = assistant("Done.");
		const built = buildSuggestionContext(record, final);
		expect(built.systemPrompt).toBe(context.systemPrompt);
		expect(built.tools).toBe(context.tools);
		const n = context.messages.length;
		expect(JSON.stringify(built.messages.slice(0, n))).toBe(JSON.stringify(context.messages));
		expect(built.messages[n]).toBe(final);
		expect(JSON.stringify(built.messages.at(-1))).toContain(SUGGESTION_INSTRUCTION);
		expect(built.messages).toHaveLength(n + 2);
		expect(context.messages).toHaveLength(n);
	});

	it("plans a request for a fresh cached completed turn", () => {
		expect(planSuggestion(base).kind).toBe("request");
	});

	it.each([
		["aborted outcome", { outcome: "aborted" as const }, "aborted"],
		["failed outcome", { outcome: "failed" as const }, "not_completed"],
		["error turn", { finalAssistant: assistant("", { stopReason: "error" }) }, "error"],
		["aborted turn", { finalAssistant: assistant("", { stopReason: "aborted" }) }, "aborted"],
		["no recorded request", { record: undefined }, "no_record"],
		["model changed", { currentModel: { provider: "openai", id: "gpt-x" } }, "model_changed"],
		[
			"no cache support (cacheRetention none)",
			{ record: { ...record, options: { cacheRetention: "none" as const } } },
			"no_cache_support",
		],
		[
			"no cache support (model has no cache pricing)",
			{ record: { ...record, model: { ...model, cost: { ...model.cost, cacheRead: 0 } } } },
			"no_cache_support",
		],
		["cold cache (short TTL passed)", { nowMs: 990 + SHORT_CACHE_TTL_MS }, "cache_cold"],
		["near usage limit (90%)", { usedPercent: 90 }, "near_usage_limit"],
		["near usage limit (99%)", { usedPercent: 99 }, "near_usage_limit"],
	])("skips on %s", (_name, override, reason) => {
		expect(planSuggestion({ ...base, ...override })).toEqual({ kind: "skip", reason });
	});

	it("keeps a long-retention cache warm past the short TTL and allows 89% usage", () => {
		const long = { ...record, options: { cacheRetention: "long" as const } };
		expect(planSuggestion({ ...base, record: long, nowMs: 990 + SHORT_CACHE_TTL_MS }).kind).toBe("request");
		expect(planSuggestion({ ...base, record: long, nowMs: 990 + LONG_CACHE_TTL_MS }).kind).toBe("skip");
		expect(planSuggestion({ ...base, usedPercent: 89 }).kind).toBe("request");
	});

	it("extracts one trimmed sentence and rejects error replies", () => {
		expect(extractSuggestion(assistant('  "Run the parser tests."\nextra'))).toBe("Run the parser tests.");
		expect(extractSuggestion(assistant("   "))).toBeUndefined();
		expect(extractSuggestion(assistant("x", { stopReason: "error" }))).toBeUndefined();
		expect(extractSuggestion(assistant("a".repeat(500)))?.length).toBe(200);
	});
});
