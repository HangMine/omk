import { Agent, type AgentMessage, type AgentTool } from "omk-agent-core";
import { type Api, type AssistantMessage, type Context, createAssistantMessageEventStream, type Model } from "omk-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	isCompactionCostObserveEnabled,
	observeCompactionCost,
} from "../src/core/compaction/compaction-cost-observe.ts";
import { type CompactionSettings, shouldCompact } from "../src/core/compaction/compaction-headroom.ts";
import type { TokenCounterAdapter } from "../src/core/context-budget-token-counter.ts";
import { GoalAcceptance } from "../src/core/goal-acceptance.ts";
import {
	factFromRequiredCapabilityUnavailable,
	isRequiredToolsEnabled,
	RequiredCapabilityUnavailable,
	type RequiredToolContract,
} from "../src/core/required-tools.ts";
import { SessionTurnAdmission, type SessionTurnAdmissionHost } from "../src/core/session-turn-admission.ts";
import { mcpToolGroup } from "../src/core/tool-schema-budget.ts";

const counter: TokenCounterAdapter = {
	id: "quarter",
	priority: 0,
	isAvailable: () => true,
	supports: () => true,
	countText: (input, modelId) => ({
		tokens: Math.ceil(input.length / 4),
		method: "estimated",
		confidence: "high",
		adapterId: "quarter",
		modelId,
		notes: [],
	}),
};
const settings: CompactionSettings = {
	enabled: true,
	reserveTokens: 8192,
	keepRecentTokens: 10000,
	maxUsageRatio: 0.7,
};
const model = {
	id: "window-262000",
	name: "test",
	api: "openai-completions",
	provider: "test",
	baseUrl: "http://localhost",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 262_000,
	maxTokens: 16384,
} as Model<Api>;
function tool(name: string, tokens: number): AgentTool {
	return {
		name,
		label: name,
		description: "d".repeat(tokens * 4),
		parameters: Type.Object({}),
		execute: async () => ({ content: [], details: {} }),
	};
}
const user: AgentMessage = { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 };
const catalog = () => [
	tool("read", 100),
	tool("notion__query", 100_000),
	tool("runpod__create", 50_000),
	tool("github__pr", 5_000),
];
const ON = { OMK_REQUIRED_TOOLS: "1" };

function harness(options: {
	tools: AgentTool[];
	env?: NodeJS.ProcessEnv;
	contract?: () => RequiredToolContract | undefined;
	withHook?: boolean;
}) {
	const notices: string[] = [];
	const compactions: number[] = [];
	const state = { systemPrompt: "system", messages: [] as AgentMessage[], tools: options.tools };
	const host: SessionTurnAdmissionHost = {
		model: () => model,
		state: () => state,
		contextWindow: (_p, window) => window,
		compactionSettings: () => settings,
		latestCompactionTimestamp: () => undefined,
		toolGroup: (name) => (name.includes("__") ? mcpToolGroup(name) : undefined),
		compact: async () => {
			compactions.push(1);
		},
		notify: (message) => notices.push(message),
		...(options.withHook === false
			? {}
			: { requiredTools: options.contract ?? (() => undefined), env: options.env ?? {} }),
	};
	const admission = new SessionTurnAdmission(host);
	const sent = () => admission.fitTools(state.tools, []).map((t) => t.name);
	return { admission, state, notices, compactions, sent };
}
const contract = (tools: string[], id = "seg-1"): RequiredToolContract => ({
	taskSegmentId: id,
	tools: new Set(tools),
	source: "acceptance",
});

describe("spec 104: required-tool contract in turn admission", () => {
	it("flag is off by default", () => {
		expect(isRequiredToolsEnabled({})).toBe(false);
		expect(isRequiredToolsEnabled(ON)).toBe(true);
	});

	it("1. flag off: sent tools, schema bytes and notices equal main for an over-budget MCP set", async () => {
		const base = harness({ tools: catalog(), withHook: false });
		const off = harness({ tools: catalog(), env: {}, contract: () => contract(["notion__query"]) });
		await base.admission.admit([user], counter);
		await off.admission.admit([user], counter);
		const bytes = (h: ReturnType<typeof harness>) =>
			JSON.stringify(h.admission.fitTools(h.state.tools, []).map((t) => [t.name, t.description, t.parameters]));
		expect(bytes(off)).toBe(bytes(base));
		expect(off.sent()).toEqual(["read", "runpod__create", "github__pr"]);
		expect(off.notices).toEqual(base.notices);
	});

	it("2. required tool in the largest group: that group stays, the next-largest optional group is withheld", async () => {
		const h = harness({ tools: catalog(), env: ON, contract: () => contract(["notion__query"]) });
		await h.admission.admit([user], counter);
		expect(h.sent()).toEqual(["read", "notion__query", "github__pr"]);
		expect(h.notices.at(-1)).toContain("runpod");
	});

	it("3. required groups alone exceed the ceiling after one compaction: RequiredCapabilityUnavailable, never complete", async () => {
		const h = harness({
			tools: [tool("read", 100), tool("notion__query", 250_000)],
			env: ON,
			contract: () => contract(["notion__query"]),
		});
		const error = await h.admission.admit([user], counter).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(RequiredCapabilityUnavailable);
		expect((error as RequiredCapabilityUnavailable).missing).toEqual(["notion__query"]);
		expect(h.compactions.length).toBeLessThanOrEqual(1);
		const fact = factFromRequiredCapabilityUnavailable(error as RequiredCapabilityUnavailable);
		expect(fact).toMatchObject({ status: "insufficient", reason: "required_capability_missing", required: true });

		const acceptance = new GoalAcceptance();
		const at = "2026-10-21T00:00:00.000Z";
		const goal = { ref: { id: "g1" }, createdAt: at, updatedAt: at, generationStartedAt: at } as never;
		let transitions = 0;
		const store = { transition: () => transitions++ } as never;
		acceptance.recordRequiredCapabilityMissing(goal, (error as RequiredCapabilityUnavailable).missing);
		await expect(acceptance.complete(store, goal, "/nonexistent")).rejects.toThrow("required tools unavailable");
		expect(transitions).toBe(0);
		acceptance.forget(goal);
		await acceptance.complete(store, goal, "/nonexistent");
		expect(transitions).toBe(1);
	});

	it("flag off keeps today's error for the same over-ceiling set", async () => {
		const h = harness({
			tools: [tool("read", 100), tool("notion__query", 250_000)],
			env: {},
			contract: () => contract(["notion__query"]),
		});
		await expect(h.admission.admit([user], counter)).resolves.toBeUndefined();
		expect(h.sent()).toEqual(["read"]);
	});

	it("4. revoked permission takes effect at once on the provider payload; required ⇒ missing before the request", async () => {
		const payloads: string[][] = [];
		const tools = [tool("read", 100), tool("browser__verify", 1_000), tool("github__pr", 1_000)];
		let required: string[] = [];
		const h = harness({ tools, env: ON, contract: () => (required.length ? contract(required) : undefined) });
		const agent = new Agent({
			getApiKey: () => "fake",
			initialState: { model, systemPrompt: "system", tools },
			streamFn: (_m, context: Context) => {
				payloads.push((context.tools ?? []).map((t) => t.name));
				const stream = createAssistantMessageEventStream();
				const message: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				};
				queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
				return stream;
			},
		});
		agent.prepareTools = (t, pending) => h.admission.fitTools(t, pending);
		h.state.tools = agent.state.tools;
		await agent.prompt("N");
		expect(payloads.at(-1)).toContain("browser__verify");
		// Revoked between N and N+1 (optional): gone from the very next payload.
		agent.state.tools = tools.filter((t) => t.name !== "browser__verify");
		h.state.tools = agent.state.tools;
		await agent.prompt("N+1");
		expect(payloads.at(-1)).not.toContain("browser__verify");
		// Required and revoked: refused before any request is sent.
		required = ["browser__verify"];
		const before = payloads.length;
		expect(() => h.admission.fitTools(agent.state.tools, [])).toThrow(RequiredCapabilityUnavailable);
		await agent.prompt("N+2").catch(() => {});
		expect(payloads.length).toBe(before);
	});

	it("5. required tool added mid-segment is present on the next request", async () => {
		let required = ["github__pr"];
		const h = harness({ tools: catalog(), env: ON, contract: () => contract(required) });
		await h.admission.admit([user], counter);
		expect(h.sent()).not.toContain("notion__query");
		required = ["github__pr", "notion__query"];
		expect(h.sent()).toContain("notion__query");
	});

	it("6. within a segment with no changes: names, order and schema bytes identical across 3 requests", async () => {
		const h = harness({ tools: catalog(), env: ON, contract: () => contract(["github__pr"]) });
		await h.admission.admit([user], counter);
		const snap = () => JSON.stringify(h.admission.fitTools(h.state.tools, []).map((t) => [t.name, t.description]));
		const first = snap();
		expect(snap()).toBe(first);
		expect(snap()).toBe(first);
	});

	it("7. a contract change alone re-fits (key includes the required set)", async () => {
		let required = ["runpod__create"];
		const h = harness({ tools: catalog(), env: ON, contract: () => contract(required) });
		await h.admission.admit([user], counter);
		expect(h.sent()).toEqual(["read", "runpod__create", "github__pr"]);
		required = ["notion__query"];
		expect(h.sent()).toEqual(["read", "notion__query", "github__pr"]);
	});

	it("§2.3: optional groups withheld at segment start stay withheld unless the budget frees", async () => {
		let segmentTools = ["read"];
		const tools = [tool("read", 100), tool("a__x", 90_000), tool("b__x", 80_000), tool("c__x", 1_000)];
		const h = harness({ tools, env: ON, contract: () => contract(segmentTools) });
		await h.admission.admit([user], counter);
		expect(h.sent()).toEqual(["read", "b__x", "c__x"]);
		// a shrinks below b: a plain re-fit would swap; within the segment b stays in, a stays out.
		h.state.tools = [tool("read", 100), tool("a__x", 70_000), tool("b__x", 100_000), tool("c__x", 1_000)];
		expect(h.sent()).not.toContain("a__x");
		// Budget frees (everything fits): all restored.
		h.state.tools = [tool("read", 100), tool("a__x", 1_000), tool("b__x", 1_000), tool("c__x", 1_000)];
		expect(h.sent()).toEqual(["read", "a__x", "b__x", "c__x"]);
		segmentTools = ["read", "c__x"];
		expect(h.sent()).toEqual(["read", "a__x", "b__x", "c__x"]);
	});
});

describe("spec 104 §2.4: compaction cost observe-only", () => {
	it("8. one metadata line per evaluation in the safe band; decision identical to flag-off", () => {
		expect(isCompactionCostObserveEnabled({})).toBe(false);
		const lines: string[] = [];
		const rates = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
		for (const tokens of [100_000, 120_000, 190_000]) {
			const plain = shouldCompact(tokens, 200_000, settings);
			const observed = shouldCompact(tokens, 200_000, settings, (decision, trigger) => {
				const obs = observeCompactionCost(
					{
						contextTokens: tokens,
						triggerTokens: trigger ?? 0,
						reserveFloorTokens: 18_192,
						cacheReadShare: 0.8,
						rates,
						summaryTokens: 8192,
						keepRecentTokens: 10000,
					},
					decision ? "compact" : "continue",
				);
				if (obs) lines.push(JSON.stringify(obs));
			});
			expect(observed).toBe(plain);
		}
		expect(lines).toHaveLength(2); // 190k is at/above the 140k trigger: outside the safe band.
		const first = JSON.parse(lines[0]!);
		expect(Object.keys(first).sort()).toEqual([
			"compactCostUsd",
			"contextTokens",
			"continueCostUsd",
			"decision",
			"kind",
		]);
		expect(first.continueCostUsd).toBeCloseTo((100_000 * (0.8 * 0.3 + 0.2 * 3)) / 1e6, 10);
		expect(first.decision).toBe("continue");
	});
});
