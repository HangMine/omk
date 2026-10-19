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
	requestNextSuggestion,
	SHORT_CACHE_TTL_MS,
	SUGGESTION_INSTRUCTION,
	SUGGESTION_MAX_TOKENS,
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
	usage: "no_quota" as const,
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
		["near usage limit (90%)", { usage: 90 }, "near_usage_limit"],
		["usage check unavailable (fail closed)", { usage: "unavailable" as const }, "usage_unavailable"],
		["near usage limit (99%)", { usage: 99 }, "near_usage_limit"],
	])("skips on %s", (_name, override, reason) => {
		expect(planSuggestion({ ...base, ...override })).toEqual({ kind: "skip", reason });
	});

	it("cache-cold boundary constants are 5 min and 60 min", () => {
		expect(SHORT_CACHE_TTL_MS).toBe(5 * 60 * 1000);
		expect(LONG_CACHE_TTL_MS).toBe(60 * 60 * 1000);
	});

	it.each([
		["default retention", undefined, SHORT_CACHE_TTL_MS],
		["short retention", { cacheRetention: "short" as const }, SHORT_CACHE_TTL_MS],
		["long retention", { cacheRetention: "long" as const }, LONG_CACHE_TTL_MS],
	])("cache-cold boundary with %s: warm 1 ms before, cold at and 1 ms after", (_name, options, ttl) => {
		const r = { ...record, options };
		expect(planSuggestion({ ...base, record: r, nowMs: r.atMs + ttl - 1 }).kind).toBe("request");
		expect(planSuggestion({ ...base, record: r, nowMs: r.atMs + ttl })).toEqual({
			kind: "skip",
			reason: "cache_cold",
		});
		expect(planSuggestion({ ...base, record: r, nowMs: r.atMs + ttl + 1 })).toEqual({
			kind: "skip",
			reason: "cache_cold",
		});
	});

	it("long retention stays warm past the short TTL; 89.9% usage and no quota window proceed", () => {
		const long = { ...record, options: { cacheRetention: "long" as const } };
		expect(planSuggestion({ ...base, record: long, nowMs: 990 + SHORT_CACHE_TTL_MS + 1 }).kind).toBe("request");
		expect(planSuggestion({ ...base, usage: 89.9 }).kind).toBe("request");
		expect(planSuggestion({ ...base, usage: "no_quota" }).kind).toBe("request");
	});

	it("the suggestion request differs from the main request only in maxTokens=128 (and its own abort signal)", async () => {
		const mainOptions = {
			apiKey: "k",
			reasoning: "high" as const,
			cacheRetention: "long" as const,
			sessionId: "s1",
			maxTokens: 32000,
			signal: new AbortController().signal,
			headers: { a: "b" },
		};
		let seen: Record<string, unknown> | undefined;
		let seenModel: unknown;
		let seenContext: Context | undefined;
		const streamFn = ((m: unknown, c: Context, o: Record<string, unknown>) => {
			seenModel = m;
			seenContext = c;
			seen = o;
			return { result: async () => assistant("Next.") };
		}) as never;
		const controller = new AbortController();
		const text = await requestNextSuggestion(
			streamFn,
			{ ...record, options: mainOptions },
			assistant("Done."),
			controller.signal,
		);
		expect(text).toBe("Next.");
		expect(seenModel).toBe(model);
		expect(seenContext?.systemPrompt).toBe(context.systemPrompt);
		expect(SUGGESTION_MAX_TOKENS).toBe(128);
		const { maxTokens, signal, ...rest } = seen ?? {};
		const { maxTokens: _mainMax, signal: _mainSignal, ...mainRest } = mainOptions;
		expect(maxTokens).toBe(128);
		expect(signal).toBe(controller.signal);
		expect(rest).toEqual(mainRest);
		expect(Object.keys(seen ?? {}).sort()).toEqual(Object.keys(mainOptions).sort());
	});

	it("extracts one trimmed sentence and rejects error replies", () => {
		expect(extractSuggestion(assistant('  "Run the parser tests."\nextra'))).toBe("Run the parser tests.");
		expect(extractSuggestion(assistant("   "))).toBeUndefined();
		expect(extractSuggestion(assistant("x", { stopReason: "error" }))).toBeUndefined();
		expect(extractSuggestion(assistant("a".repeat(500)))?.length).toBe(200);
	});
});
