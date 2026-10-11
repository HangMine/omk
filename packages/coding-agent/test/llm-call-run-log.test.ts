import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamFn } from "omk-agent-core";
import { type AssistantMessage, type Context, createAssistantMessageEventStream, getModel, type Usage } from "omk-ai";
import { systemHash, toolsHash } from "omk-ai/prompt-hash";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createLlmCallRunLogStreamFn,
	effortSentFor,
	LLM_CALL_RUN_LOG,
	resetLlmCallRunLogClock,
} from "../src/core/llm-call-run-log.ts";
import { createResponseReasoningCapStreamFn } from "../src/core/response-reasoning-cap.ts";
import { RUN_LOG_DIR_ENV } from "../src/core/run-log.ts";

// spec 059: one <OMK_RUN_LOG_DIR>/llm-call.jsonl line per provider request.
const SECRET = "SENTINEL_LLM_CALL_7c1e";
// The registered grok-4.7, with the grok thinking map: `max`/`ultra` go out as "xhigh".
const model = getModel("xai", "grok-4.7");

const roots: string[] = [];
function tempDir(): string {
	const root = mkdtempSync(join(tmpdir(), "omk-llm-call-"));
	roots.push(root);
	return root;
}
const lines = (dir: string) =>
	readFileSync(join(dir, `${LLM_CALL_RUN_LOG}.jsonl`), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>);

function usage(input: number, output: number, cacheRead: number, cacheWrite: number, costTotal = 0): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costTotal },
	};
}

/** What a provider's message holds when the stream ended before the final usage chunk. */
const NO_USAGE = usage(0, 0, 0, 0);

function message(u: Usage, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: `answer ${SECRET}` }],
		api: "openai-completions",
		provider: "xai",
		model: "grok-4.7",
		usage: u,
		stopReason,
		timestamp: 0,
		...(stopReason === "aborted" ? { errorMessage: `aborted ${SECRET} /home/user/secret.txt` } : {}),
	};
}

function context(prompt = `Fix the bug. token=${SECRET}`): Context {
	return {
		systemPrompt: `You are a coding agent. ${SECRET}`,
		messages: [{ role: "user", content: prompt, timestamp: 0 }],
		tools: [{ name: "read", description: `Read a file ${SECRET}`, parameters: Type.Object({ path: Type.String() }) }],
	};
}

interface Received {
	readonly bytes: string;
	readonly context: Context;
	readonly options: unknown;
}

/** A fake provider that records exactly what it was handed and replies with `reply`. */
function fakeProvider(reply: (signal: AbortSignal | undefined) => AssistantMessage | Promise<AssistantMessage>) {
	const received: Received[] = [];
	const fn: StreamFn = (m, c, options) => {
		const { signal, ...rest } = options ?? {};
		received.push({ bytes: JSON.stringify({ m, c, rest, hasSignal: signal !== undefined }), context: c, options });
		const stream = createAssistantMessageEventStream();
		void (async () => {
			const final = await reply(signal);
			if (final.stopReason === "aborted" || final.stopReason === "error") {
				stream.push({ type: "error", reason: final.stopReason, error: final });
			} else {
				stream.push({ type: "done", reason: "stop", message: final });
			}
			stream.end(final);
		})();
		return stream;
	};
	return { fn, received };
}

let clock = 0;
const now = () => clock;

beforeEach(() => {
	clock = 1_000;
	resetLlmCallRunLogClock();
});
afterEach(() => {
	while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

describe("llm-call run log (spec 059)", () => {
	it("writes nothing and returns the provider stream itself when OMK_RUN_LOG_DIR is unset", async () => {
		const dir = tempDir();
		const provider = fakeProvider(() => message(usage(10, 2, 0, 0)));
		const wrapped = createLlmCallRunLogStreamFn(provider.fn, { env: {}, now });
		expect(wrapped).toBe(provider.fn);
		await (await wrapped(model, context(), { reasoning: "high" })).result();
		expect(readdirSync(dir)).toEqual([]);
		expect(existsSync(join(dir, `${LLM_CALL_RUN_LOG}.jsonl`))).toBe(false);
	});

	it("appends one line per call with the fields, gapMs null then the gap since the last call ended", async () => {
		const dir = tempDir();
		const provider = fakeProvider(() => {
			clock += 250;
			return { ...message(usage(1_200, 80, 900, 300, 0.0123)), responseId: "chatcmpl-059" };
		});
		const wrapped = createLlmCallRunLogStreamFn(provider.fn, { env: { [RUN_LOG_DIR_ENV]: dir }, now });
		const ctx = context();
		await (await wrapped(model, ctx, { reasoning: "high" })).result();
		await new Promise((resolve) => setImmediate(resolve));
		clock += 40;
		await (await wrapped(model, { ...ctx, messages: [...ctx.messages, ctx.messages[0]] }, {})).result();
		await new Promise((resolve) => setImmediate(resolve));

		const [first, second] = lines(dir);
		expect(lines(dir)).toHaveLength(2);
		expect(first).toEqual({
			provider: "xai",
			model: "grok-4.7",
			effort: "high",
			effortSent: "high",
			messageCount: 1,
			systemHash: systemHash(ctx),
			toolsHash: toolsHash(ctx),
			phase: null,
			phaseSource: null,
			requestedAtMs: 1_000,
			responseId: "chatcmpl-059",
			input: 1_200,
			output: 80,
			cacheRead: 900,
			cacheWrite: 300,
			costTotal: 0.0123,
			costInUsdTicks: null,
			usageMissing: false,
			stopReason: "stop",
			durationMs: 250,
			gapMs: null,
			t: expect.any(Number),
			elapsedFraction: null,
			pid: process.pid,
			role: "lead",
		});
		expect(second).toMatchObject({
			effort: null,
			effortSent: null,
			requestedAtMs: 1_290,
			responseId: "chatcmpl-059",
			messageCount: 2,
			durationMs: 250,
			gapMs: 40,
		});
		expect(second.systemHash).toBe(first.systemHash);
		expect(first.systemHash).toMatch(/^[0-9a-f]{64}$/);
	});

	it("logs an aborted call exactly once, with the usage that arrived", async () => {
		const dir = tempDir();
		const controller = new AbortController();
		const provider = fakeProvider(async (signal) => {
			await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
			return message(usage(500, 7, 0, 0), "aborted");
		});
		const wrapped = createLlmCallRunLogStreamFn(provider.fn, { env: { [RUN_LOG_DIR_ENV]: dir }, now });
		const stream = await wrapped(model, context(), { signal: controller.signal });
		controller.abort();
		await stream.result();
		await new Promise((resolve) => setImmediate(resolve));
		expect(lines(dir)).toEqual([expect.objectContaining({ stopReason: "aborted", input: 500, output: 7 })]);

		// A call that fails before a stream exists still gets its one line, with no usage.
		const failing: StreamFn = () => {
			throw new Error(`auth failed ${SECRET}`);
		};
		const failingWrapped = createLlmCallRunLogStreamFn(failing, { env: { [RUN_LOG_DIR_ENV]: dir }, now });
		await expect(Promise.resolve().then(() => failingWrapped(model, context(), {}))).rejects.toThrow("auth failed");
		expect(lines(dir)).toHaveLength(2);
		expect(lines(dir)[1]).toMatchObject({
			stopReason: "error",
			input: null,
			output: null,
			cacheRead: null,
			costTotal: null,
			usageMissing: true,
		});
	});

	it("writes null, never 0, for usage and cost when no usage arrived, and flags usageMissing", async () => {
		const dir = tempDir();
		const provider = fakeProvider(() => message(NO_USAGE, "aborted"));
		const wrapped = createLlmCallRunLogStreamFn(provider.fn, { env: { [RUN_LOG_DIR_ENV]: dir }, now });
		await (await wrapped(model, context(), { reasoning: "xhigh" })).result();
		await new Promise((resolve) => setImmediate(resolve));
		expect(lines(dir)).toEqual([
			expect.objectContaining({
				stopReason: "aborted",
				input: null,
				output: null,
				cacheRead: null,
				cacheWrite: null,
				costTotal: null,
				costInUsdTicks: null,
				usageMissing: true,
			}),
		]);
	});

	it("resolves effortSent to the provider wire value", () => {
		expect(effortSentFor(model, "max")).toBe("xhigh");
		expect(effortSentFor(model, "ultra")).toBe("xhigh");
		expect(effortSentFor(model, "xhigh")).toBe("xhigh");
		expect(effortSentFor(model, "high")).toBe("high");
		expect(effortSentFor(model, undefined)).toBeNull();
		expect(effortSentFor(getModel("xai", "grok-4.5"), "max")).toBe("high");
	});

	it("logs a cap retry as its own line, with the lowered effort and its wire value", async () => {
		const dir = tempDir();
		const sent: unknown[] = [];
		const provider: StreamFn = (_model, _context, options) => {
			sent.push(options?.reasoning);
			const firstAttempt = sent.length === 1;
			const signal = options?.signal;
			const stream = createAssistantMessageEventStream();
			void (async () => {
				const partial = message(NO_USAGE);
				stream.push({ type: "start", partial });
				if (firstAttempt) {
					stream.push({ type: "thinking_start", contentIndex: 0, partial });
					stream.push({ type: "thinking_delta", contentIndex: 0, delta: "x".repeat(400), partial });
					// The cap aborts here; like a real stream, it ends without the final usage chunk.
					await new Promise<void>((resolve) => {
						if (signal?.aborted) resolve();
						else signal?.addEventListener("abort", () => resolve(), { once: true });
					});
					const aborted = message(NO_USAGE, "aborted");
					stream.push({ type: "error", reason: "aborted", error: aborted });
					stream.end(aborted);
					return;
				}
				const final = { ...message(usage(1_100, 40, 900, 0, 0.004)), responseId: "chatcmpl-retry" };
				stream.push({ type: "text_start", contentIndex: 0, partial: final });
				stream.push({ type: "done", reason: "stop", message: final });
				stream.end(final);
			})();
			return stream;
		};
		const logged = createLlmCallRunLogStreamFn(provider, { env: { [RUN_LOG_DIR_ENV]: dir }, now });
		// Wired as createSdkProviderStream does: cap(llmCallLog(provider)).
		const capped = createResponseReasoningCapStreamFn(logged, { maxReasoningTokens: 50, maxWallMs: 60_000 });
		const response = await capped(model, context(), { reasoning: "xhigh" });
		for await (const _event of response) {
			// drain
		}
		await response.result();
		await new Promise((resolve) => setImmediate(resolve));

		expect(sent).toEqual(["xhigh", "high"]);
		expect(lines(dir)).toHaveLength(2);
		const [first, retry] = lines(dir);
		expect(first).toMatchObject({
			effort: "xhigh",
			effortSent: "xhigh",
			stopReason: "aborted",
			usageMissing: true,
			input: null,
			output: null,
			costTotal: null,
			costInUsdTicks: null,
		});
		expect(retry).toMatchObject({
			effort: "high",
			effortSent: "high",
			stopReason: "stop",
			usageMissing: false,
			input: 1_100,
			cacheRead: 900,
			costTotal: 0.004,
			costInUsdTicks: null,
			responseId: "chatcmpl-retry",
		});
		expect(first.effortSent).not.toBe(retry.effortSent);
	});

	it("never writes prompt text, tool text, output, error text or paths", async () => {
		const dir = tempDir();
		const provider = fakeProvider(() => message(usage(1, 1, 0, 0), "aborted"));
		const wrapped = createLlmCallRunLogStreamFn(provider.fn, { env: { [RUN_LOG_DIR_ENV]: dir }, now });
		await (await wrapped(model, context(`please use ${SECRET} at /home/user/secret.txt`), {})).result();
		await new Promise((resolve) => setImmediate(resolve));
		const text = readFileSync(join(dir, `${LLM_CALL_RUN_LOG}.jsonl`), "utf8");
		expect(text).not.toContain(SECRET);
		expect(text).not.toContain("/home/user");
		expect(text).not.toContain("Fix the bug");
	});

	it("hands the provider the same request with logging on and off", async () => {
		const dir = tempDir();
		const run = async (env: NodeJS.ProcessEnv) => {
			const provider = fakeProvider(() => message(usage(3, 1, 0, 0)));
			const wrapped = createLlmCallRunLogStreamFn(provider.fn, { env, now });
			// Wired as createSdkProviderStream does: below spec 033's cap.
			const capped = createResponseReasoningCapStreamFn(wrapped, { maxReasoningTokens: 10_000, maxWallMs: 60_000 });
			const ctx = context();
			const options = { reasoning: "medium" as const, sessionId: "s1", maxTokens: 512 };
			await (await capped(model, ctx, options)).result();
			return { received: provider.received, ctx };
		};
		const off = await run({});
		const on = await run({ [RUN_LOG_DIR_ENV]: dir });
		expect(on.received).toHaveLength(1);
		expect(on.received[0].bytes).toBe(off.received[0].bytes);
		expect(on.received[0].context).toBe(on.ctx);
		await new Promise((resolve) => setImmediate(resolve));
		expect(lines(dir)).toHaveLength(1);
	});
});
