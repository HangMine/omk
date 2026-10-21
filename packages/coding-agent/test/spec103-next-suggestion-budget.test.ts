import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamFn } from "omk-agent-core";
import {
	type AssistantMessage,
	type Context,
	getModel,
	type Model,
	promptCacheCapability,
	type SimpleStreamOptions,
	type Usage,
} from "omk-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseResponsesUsage } from "../../ai/src/providers/openai-responses-usage.ts";
import { wrapBudgetStream } from "../src/core/budget-stream.ts";
import {
	planSuggestion,
	type RecordedMainRequest,
	requestNextSuggestion,
	type SuggestionPlan,
} from "../src/core/next-suggestion.ts";
import {
	cappedSuggestionOptions,
	isSuggestionCapsEnabled,
	type SuggestionBudget,
	suggestionBudgetFromEnv,
} from "../src/core/next-suggestion-budget.ts";
import { type SuggestionSettlement, suggestionMetricInput } from "../src/core/next-suggestion-settlement.ts";
import { RunBudget } from "../src/core/run-budget.ts";
import { summarizeTurnMetrics, TurnMetricsSink } from "../src/core/turn-metrics.ts";
import {
	installNextSuggestions,
	type SuggestionEditorPort,
	type SuggestionSessionPort,
} from "../src/modes/interactive/next-suggestion-controller.ts";

const anthropic = getModel("anthropic", "claude-sonnet-4-5")! as Model<"anthropic-messages">;
const openai = getModel("openai", "gpt-4o")! as Model<"openai-responses">;
const xai = getModel("xai", "grok-3")! as Model<"openai-completions">;
const MIN = 60_000;
const BUDGET: SuggestionBudget = { maxReasoning: "inherit", deadlineMs: 5_000, maxCostUsd: 1 };

function usage(input: number, output: number, total = 0.01): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
	};
}
function assistant(text: string, over: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: anthropic.id,
		usage: usage(10, 5),
		stopReason: "stop",
		timestamp: 1000,
		...over,
	};
}
const context: Context = {
	systemPrompt: "system",
	messages: [{ role: "user", content: [{ type: "text", text: "fix the parser" }], timestamp: 900 }],
	tools: [],
};
function record(model: Model<never> | Model<"anthropic-messages">, options?: SimpleStreamOptions): RecordedMainRequest {
	return { model: model as never, context, options, atMs: 990 };
}
function plan(r: RecordedMainRequest, nowMs: number, caps?: { budget: SuggestionBudget | undefined }): SuggestionPlan {
	return planSuggestion({
		record: r,
		outcome: "completed",
		finalAssistant: assistant("Done."),
		currentModel: { provider: r.model.provider, id: r.model.id },
		nowMs,
		usage: "no_quota",
		...(caps ? { caps } : {}),
	});
}
const reason = (p: SuggestionPlan) => (p.kind === "skip" ? p.reason : p.kind);

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

describe("spec 103: flags", () => {
	it("caps flag is off by default and env budget has no invented defaults", () => {
		expect(isSuggestionCapsEnabled({})).toBe(false);
		expect(isSuggestionCapsEnabled({ OMK_NEXT_SUGGESTIONS_CAPS: "1" })).toBe(true);
		expect(suggestionBudgetFromEnv({})).toBeUndefined();
		expect(suggestionBudgetFromEnv({ OMK_NEXT_SUGGESTIONS_DEADLINE_MS: "3000" })).toBeUndefined();
		expect(
			suggestionBudgetFromEnv({
				OMK_NEXT_SUGGESTIONS_DEADLINE_MS: "3000",
				OMK_NEXT_SUGGESTIONS_MAX_COST_USD: "0.01",
			}),
		).toEqual({ maxReasoning: "inherit", deadlineMs: 3000, maxCostUsd: 0.01 });
	});

	it("caps on with no budget configured skips (fail closed) with zero provider calls", () => {
		expect(reason(plan(record(anthropic), 2000, { budget: undefined }))).toBe("budget_unset");
	});

	it("caps off: plan shape and request bytes equal the spec 091 reuse arm", async () => {
		const options: SimpleStreamOptions = { reasoning: "high", cacheRetention: "short", sessionId: "s" };
		const p = plan(record(anthropic, options), 2000);
		expect(p).toEqual({ kind: "request", record: record(anthropic, options), finalAssistant: assistant("Done.") });
		let seen: Record<string, unknown> | undefined;
		const streamFn = ((_m: unknown, _c: Context, o: Record<string, unknown>) => {
			seen = o;
			return { result: async () => assistant("Next.") };
		}) as unknown as StreamFn;
		const signal = new AbortController().signal;
		await requestNextSuggestion(streamFn, record(anthropic, options), assistant("Done."), signal);
		expect(seen).toEqual({ ...options, maxTokens: 128, signal });
		expect(Object.keys(seen ?? {})).toEqual([...Object.keys(options), "maxTokens", "signal"]);
	});
});

describe("spec 103 §2.1: independent caps (caps flag on)", () => {
	it("deadline fires on a fake clock: outcome timeout, request aborted, partial usage settled, nothing shown", async () => {
		vi.useFakeTimers();
		let requestSignal: AbortSignal | undefined;
		const streamFn = ((_m: unknown, _c: Context, o: SimpleStreamOptions) => {
			requestSignal = o.signal;
			return {
				result: () =>
					new Promise<AssistantMessage>((resolve) =>
						o.signal?.addEventListener("abort", () =>
							resolve(assistant("", { stopReason: "aborted", usage: usage(40, 2) })),
						),
					),
			};
		}) as unknown as StreamFn;
		const p = plan(record(anthropic), 2000, { budget: BUDGET });
		if (p.kind !== "request" || !p.caps) throw new Error("expected caps request");
		const timeoutSignal = (ms: number) => {
			const c = new AbortController();
			setTimeout(() => c.abort(new Error("timeout")), ms);
			return c.signal;
		};
		const pending = requestNextSuggestion(streamFn, p.record, p.finalAssistant, new AbortController().signal, {
			caps: p.caps,
			timeoutSignal,
		});
		await vi.advanceTimersByTimeAsync(BUDGET.deadlineMs);
		const result = await pending;
		expect(requestSignal?.aborted).toBe(true);
		expect(result.outcome).toBe("timeout");
		expect(result.text).toBeUndefined();
		expect(result.usage?.input).toBe(40);
	});

	it("pre-flight estimate over maxCostUsd skips over_cost_cap with zero provider calls", () => {
		const p = plan(record(anthropic), 2000, { budget: { ...BUDGET, maxCostUsd: 1e-9 } });
		expect(reason(p)).toBe("over_cost_cap");
		expect(reason(plan(record(anthropic), 2000, { budget: BUDGET }))).toBe("request");
	});

	it("maxReasoning inherit keeps the options object; a lower cap only lowers", () => {
		const options: SimpleStreamOptions = { reasoning: "high" };
		expect(cappedSuggestionOptions(options, BUDGET)).toBe(options);
		expect(cappedSuggestionOptions(options, { ...BUDGET, maxReasoning: "low" })).toEqual({ reasoning: "low" });
		expect(cappedSuggestionOptions({ reasoning: "minimal" }, { ...BUDGET, maxReasoning: "low" })).toEqual({
			reasoning: "minimal",
		});
	});
});

describe("spec 103 §2.4: capability table", () => {
	it("cacheRead price 0 but table says supported is not skipped; xAI is cache_capability_unknown", () => {
		const free = { ...anthropic, cost: { ...anthropic.cost, cacheRead: 0 } };
		expect(reason(plan(record(free), 2000))).toBe("no_cache_support"); // caps off: today's rule
		expect(reason(plan(record(free), 2000, { budget: BUDGET }))).toBe("request");
		expect(reason(plan(record(xai as never), 2000, { budget: BUDGET }))).toBe("cache_capability_unknown");
		expect(promptCacheCapability(xai, "short").kind).toBe("unknown");
		expect(reason(plan(record(anthropic, { cacheRetention: "none" }), 2000, { budget: BUDGET }))).toBe(
			"no_cache_support",
		);
	});

	it("TTL per provider and retention actually sent", () => {
		const at = (model: Model<never>, retention: SimpleStreamOptions["cacheRetention"], minutes: number) =>
			reason(plan(record(model, { cacheRetention: retention }), 990 + minutes * MIN, { budget: BUDGET }));
		expect(at(openai as never, "long", 31)).toBe("cache_cold");
		expect(at(openai as never, "long", 29)).toBe("request");
		expect(at(anthropic as never, "long", 59)).toBe("request");
		expect(at(anthropic as never, "long", 61)).toBe("cache_cold");
		expect(at(anthropic as never, undefined, 4)).toBe("request");
		expect(at(anthropic as never, undefined, 6)).toBe("cache_cold");
		expect(promptCacheCapability({ ...openai, id: "gpt-5.6" }, "short")).toMatchObject({ coldAfterMs: 30 * MIN });
		expect(promptCacheCapability(openai, "short")).toMatchObject({ coldAfterMs: 5 * MIN });
	});
});

describe("spec 103 §2.3: normalized usage fixtures (doc examples)", () => {
	it("OpenAI and Anthropic produce the documented ordinary input", () => {
		const o = parseResponsesUsage({
			input_tokens: 12000,
			output_tokens: 0,
			input_tokens_details: { cached_tokens: 4000, cache_write_tokens: 7000 },
		});
		expect({ input: o.input, cacheRead: o.cacheRead, cacheWrite: o.cacheWrite }).toEqual({
			input: 1000,
			cacheRead: 4000,
			cacheWrite: 7000,
		});
		// Anthropic maps fields directly (anthropic.ts message_start): input_tokens is already uncached.
		const a = { input_tokens: 50, cache_read_input_tokens: 100000, cache_creation_input_tokens: 0 };
		expect(a.input_tokens).toBe(50);
		expect(a.cache_read_input_tokens + a.cache_creation_input_tokens + a.input_tokens).toBe(100050);
	});
});

describe("spec 103 §2.2: usage settlement", () => {
	function fakeSession(streamFn: StreamFn) {
		const listeners: Array<(e: { type: string; outcome?: string }) => unknown> = [];
		const session = {
			agent: { streamFn, state: { messages: [] as unknown[] } },
			model: { provider: anthropic.provider, id: anthropic.id } as { provider: string; id: string } | undefined,
			subscribe: (l: (e: { type: string; outcome?: string }) => unknown) => {
				listeners.push(l);
				return () => {};
			},
		};
		const emit = (e: { type: string; outcome?: string }) => {
			for (const l of listeners) l(e);
		};
		return { session, emit };
	}
	function editor(): SuggestionEditorPort {
		let text = "";
		return {
			getText: () => text,
			setText: (t) => {
				text = t;
			},
			setPlaceholder: () => {},
			isShowingAutocomplete: () => false,
		};
	}
	async function mainTurn(
		session: ReturnType<typeof fakeSession>["session"],
		emit: (e: { type: string; outcome?: string }) => void,
	) {
		emit({ type: "agent_start" });
		const stream = await session.agent.streamFn(anthropic, context, { cacheRetention: "short" });
		const final = await stream.result();
		session.agent.state.messages = [...context.messages, final];
		emit({ type: "turn_end" });
	}

	it("caps off: one purpose:suggestion record per suggestion; parent turn totals unchanged", async () => {
		const settled: SuggestionSettlement[] = [];
		const { session, emit } = fakeSession(((_m: unknown, c: Context) => ({
			result: async () =>
				c.messages.length > 1
					? assistant("Run tests next.", { usage: usage(7, 3, 0.002) })
					: assistant("Done.", { timestamp: Date.now(), usage: usage(100, 20, 0.05) }),
		})) as unknown as StreamFn);
		const c = installNextSuggestions(session as unknown as SuggestionSessionPort, editor(), "base", {
			env: { OMK_NEXT_SUGGESTIONS: "1" },
			quotaUsage: async () => "no_quota",
			settle: (s) => settled.push(s),
		})!;
		await mainTurn(session, emit);
		await c.onSettled("completed");
		expect(c.suggestion).toBe("Run tests next.");
		c.dispose();
		expect(settled).toHaveLength(1);
		const input = suggestionMetricInput("sess", settled[0]!);
		expect(input).toMatchObject({ purpose: "suggestion", parentTurnIndex: 0, suggestionOutcome: "shown" });
		const dir = mkdtempSync(join(tmpdir(), "omk-103-"));
		try {
			const sink = new TurnMetricsSink({ dir });
			sink.record({
				sessionId: "sess",
				turnIndex: 0,
				startedAtEpochMs: 1,
				endedAtEpochMs: 2,
				usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, costUsd: 0.05 },
			});
			sink.record(input);
			const summary = summarizeTurnMetrics(readFileSync(sink.path, "utf8").split("\n"));
			expect(summary.byPurpose?.main).toMatchObject({ records: 1, input: 100, costUsd: 0.05 });
			expect(summary.byPurpose?.suggestion).toMatchObject({ records: 1, input: 7, costUsd: 0.002 });
			expect(summary.totals.input).toBe(107);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("no suggestion records: summary has no byPurpose field (flag-off output unchanged)", () => {
		const line = JSON.stringify({
			schemaVersion: "omk-turn-metrics-2",
			sessionId: "s",
			turnIndex: 0,
			startedAtEpochMs: 1,
			endedAtEpochMs: 2,
			durationMs: 1,
			toolCalls: [],
			toolCallCount: 0,
			toolFailureCount: 0,
		});
		expect("byPurpose" in summarizeTurnMetrics([line])).toBe(false);
	});

	it("cancel by keypress mid-stream: cost counted as cancelled, nothing shown", async () => {
		const settled: SuggestionSettlement[] = [];
		const { session, emit } = fakeSession(((_m: unknown, c: Context, o: SimpleStreamOptions) => ({
			result: () =>
				c.messages.length > 1
					? new Promise<AssistantMessage>((resolve) =>
							o.signal?.addEventListener("abort", () =>
								resolve(assistant("", { stopReason: "aborted", usage: usage(9, 1, 0.003) })),
							),
						)
					: Promise.resolve(assistant("Done.", { timestamp: Date.now() })),
		})) as unknown as StreamFn);
		const ed = editor();
		const c = installNextSuggestions(session as unknown as SuggestionSessionPort, ed, "base", {
			env: { OMK_NEXT_SUGGESTIONS: "1" },
			quotaUsage: async () => "no_quota",
			settle: (s) => settled.push(s),
		})!;
		await mainTurn(session, emit);
		const pending = c.onSettled("completed");
		await vi.waitFor(() => expect((c as unknown as { pending?: unknown }).pending).toBeDefined());
		ed.onBeforeInput?.("x");
		await pending;
		c.dispose();
		expect(c.suggestion).toBeUndefined();
		expect(settled[0]?.result.outcome).toBe("aborted");
		const summary = summarizeTurnMetrics(
			[JSON.stringify({ ...suggestionMetricInput("s", settled[0]!) })].map((l) => {
				const dir = mkdtempSync(join(tmpdir(), "omk-103-"));
				const sink = new TurnMetricsSink({ dir });
				sink.record(JSON.parse(l));
				const out = readFileSync(sink.path, "utf8");
				rmSync(dir, { recursive: true, force: true });
				return out;
			}),
		);
		expect(summary.byPurpose?.suggestion.cancelledCostUsd).toBe(0.003);
	});

	it("missing usage is missing coverage, never 0", () => {
		const input = suggestionMetricInput("s", {
			result: { outcome: "error", latencyMs: 5 },
			provider: "anthropic",
			model: anthropic.id,
			parentTurnIndex: 2,
			startedAtEpochMs: 10,
		});
		expect(input.usage).toBeUndefined();
	});

	it("model switched before the result (caps on): late result discarded, cost still settled", async () => {
		const settled: SuggestionSettlement[] = [];
		let releaseSuggestion: () => void = () => {};
		const { session, emit } = fakeSession(((_m: unknown, c: Context) => ({
			result: () =>
				c.messages.length > 1
					? new Promise<AssistantMessage>((resolve) => {
							releaseSuggestion = () => resolve(assistant("Late.", { usage: usage(5, 1, 0.001) }));
						})
					: Promise.resolve(assistant("Done.", { timestamp: Date.now() })),
		})) as unknown as StreamFn);
		const c = installNextSuggestions(session as unknown as SuggestionSessionPort, editor(), "base", {
			env: { OMK_NEXT_SUGGESTIONS: "1", OMK_NEXT_SUGGESTIONS_CAPS: "1" },
			budget: BUDGET,
			quotaUsage: async () => "no_quota",
			settle: (s) => settled.push(s),
		})!;
		await mainTurn(session, emit);
		const pending = c.onSettled("completed");
		await vi.waitFor(() => expect((c as unknown as { pending?: unknown }).pending).toBeDefined());
		session.model = { provider: "openai", id: "gpt-4o" };
		releaseSuggestion();
		await pending;
		c.dispose();
		expect(c.suggestion).toBeUndefined();
		expect(settled[0]?.result.usage?.cost.total).toBe(0.001);
	});

	it("totals reconcile: Σ(main + suggestion) == trace Σ with the suggestion labelled", async () => {
		const dir = mkdtempSync(join(tmpdir(), "omk-103-trace-"));
		const tracePath = join(dir, "trace.jsonl");
		vi.stubEnv("OMK_EVAL_TRACE", tracePath);
		vi.stubEnv("OMK_REQUEST_ADMISSION_MODE", "off");
		const budget = new RunBudget(undefined, () => {});
		try {
			const source = ((_m: unknown, c: Context) => {
				const message =
					c.messages.length > 1
						? assistant("Next.", { usage: usage(7, 3) })
						: assistant("Done.", { usage: usage(100, 20) });
				return { result: async () => message };
			}) as unknown as StreamFn;
			const wrapped = wrapBudgetStream(source, budget);
			const main = await (await wrapped(anthropic, context, { cacheRetention: "short" })).result();
			const sug = await requestNextSuggestion(
				wrapped,
				record(anthropic, { cacheRetention: "short" }),
				main,
				new AbortController().signal,
			);
			await budget.waitForIdle();
			const rows = readFileSync(tracePath, "utf8")
				.trim()
				.split("\n")
				.map((l) => JSON.parse(JSON.parse(l).body));
			const dispatch = rows.filter((r) => r.kind === "logical_dispatch").map((r) => r.purpose);
			expect(dispatch).toEqual(["unknown", "suggestion"]);
			const traceInput = rows.filter((r) => r.kind === "logical_terminal").reduce((n, r) => n + r.usage.input, 0);
			expect(traceInput).toBe(main.usage.input + (sug.usage?.input ?? 0));
			const raw = readFileSync(tracePath, "utf8");
			expect(raw).not.toContain("fix the parser");
			expect(raw).not.toContain("Next.");
		} finally {
			budget.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
