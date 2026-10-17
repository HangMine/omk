/**
 * Spec 071 loop guard unit tests. The "short history", "below threshold", "different actions",
 * "same action with changing observation", "alternating pattern" and "error streak" cases are
 * adapted from OpenHands tests/cross/test_stuck_detector.py:
 *   https://github.com/OpenHands/software-agent-sdk/blob/1fbfd37f6fb2/tests/cross/test_stuck_detector.py
 *
 * MIT License
 *
 * Copyright (c) 2026 OpenHands contributors
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import type { AssistantMessage, Message, ToolResultMessage } from "omk-ai";
import { describe, expect, it } from "vitest";
import { isSearchNoMatch, lastShellStage } from "../src/core/shell-search-no-match.ts";
import {
	createSubagentLoopGuard,
	type LoopGuardStop,
	SUBAGENT_LOOP_GUARD_RULES,
	type SubagentLoopGuard,
} from "../src/core/subagent-loop-guard.ts";

let nextId = 0;
let promptChars = 0;

interface Step {
	readonly tool?: string;
	readonly args?: Record<string, unknown>;
	readonly output?: string;
	readonly isError?: boolean;
	readonly text?: string;
}

/** Usage mirrors the prompt the fake model received: the context grows with every message. */
function assistant(calls: readonly { name: string; args: Record<string, unknown> }[], text = ""): AssistantMessage {
	const content: AssistantMessage["content"] = [];
	if (text) content.push({ type: "text", text });
	for (const call of calls)
		content.push({ type: "toolCall", id: `call-${nextId++}`, name: call.name, arguments: call.args });
	const outputChars = JSON.stringify(content).length;
	const input = Math.ceil(promptChars / 4);
	const output = Math.ceil(outputChars / 4);
	promptChars += outputChars;
	return {
		role: "assistant",
		content,
		api: "fake",
		provider: "fake",
		model: "fake-model",
		usage: {
			input,
			output,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: input + output,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: calls.length > 0 ? "toolUse" : "stop",
		timestamp: 0,
	} as AssistantMessage;
}

function toolResult(call: AssistantMessage, index: number, output: string, isError = false): ToolResultMessage {
	const part = call.content.filter((entry) => entry.type === "toolCall")[index];
	if (!part || part.type !== "toolCall") throw new Error("no tool call");
	promptChars += output.length;
	return {
		role: "toolResult",
		toolCallId: part.id,
		toolName: part.name,
		content: [{ type: "text", text: output }],
		isError,
		timestamp: 0,
	};
}

/** Feed one turn per step; returns the first stop and the index of the step that caused it. */
function run(guard: SubagentLoopGuard, steps: readonly Step[]): { stop?: LoopGuardStop; at: number } {
	for (const [at, step] of steps.entries()) {
		const messages: Message[] = [];
		if (!step.tool) messages.push(assistant([], step.text ?? "done"));
		else {
			const call = assistant([{ name: step.tool, args: step.args ?? {} }], step.text);
			messages.push(call, toolResult(call, 0, step.output ?? "", step.isError));
		}
		for (const message of messages) {
			const stop = guard.observe(message);
			if (stop) return { stop, at };
		}
	}
	return { at: -1 };
}

const fresh = () => {
	promptChars = 2_000;
	return createSubagentLoopGuard();
};

describe("spec 071 loop guard rules", () => {
	it("fixes the spec thresholds", () => {
		expect(SUBAGENT_LOOP_GUARD_RULES).toEqual({
			identicalCalls: 3,
			sameErrors: 3,
			pingPongCalls: 6,
			noProgressTurns: 5,
		});
	});

	it("does not stop on a history shorter than any threshold", () => {
		const { stop } = run(fresh(), [{ tool: "read", args: { path: "a" }, output: "x" }, { text: "done" }]);
		expect(stop).toBeUndefined();
	});

	it("N=3: stops on the third identical call, not the second", () => {
		const same = { tool: "bash", args: { command: "ls" }, output: "a\nb" };
		expect(run(fresh(), [same, same]).stop).toBeUndefined();
		const { stop, at } = run(fresh(), [same, same, same]);
		expect(at).toBe(2);
		expect(stop).toMatchObject({
			code: "loop_guard",
			rule: "identical_call",
			count: 3,
			toolName: "bash",
			partial: true,
		});
	});

	it("N=3 compares args structurally (key order does not matter)", () => {
		const { stop } = run(fresh(), [
			{ tool: "grep", args: { pattern: "x", path: "src", opts: { i: true, n: 1 } }, output: "hit" },
			{ tool: "grep", args: { path: "src", opts: { n: 1, i: true }, pattern: "x" }, output: "hit" },
			{ tool: "grep", args: { opts: { i: true, n: 1 }, pattern: "x", path: "src" }, output: "hit" },
		]);
		expect(stop?.rule).toBe("identical_call");
	});

	it("N=3 needs the same result too: polling with a changing output is not stopped", () => {
		const poll = (status: string) => ({
			tool: "bash",
			args: { command: "gh run view 123 --json status" },
			output: status,
		});
		const steps = [
			poll("queued"),
			poll("in_progress 10%"),
			poll("in_progress 40%"),
			poll("in_progress 80%"),
			poll("completed"),
		];
		expect(run(fresh(), [...steps, { text: "done" }]).stop).toBeUndefined();
	});

	it("N=3: same call with a changing result, then three identical results, stops", () => {
		const poll = (status: string) => ({ tool: "bash", args: { command: "gh run view 123" }, output: status });
		const { stop, at } = run(fresh(), [poll("queued"), poll("running"), poll("running"), poll("running")]);
		expect(at).toBe(3);
		expect(stop?.rule).toBe("identical_call");
	});

	it("does not stop on different actions", () => {
		const steps = Array.from({ length: 12 }, (_, i) => ({
			tool: "read",
			args: { path: `f${i}` },
			output: `body ${i}`,
		}));
		expect(run(fresh(), [...steps, { text: "done" }]).stop).toBeUndefined();
	});

	it("same error x3 stops even when the args differ", () => {
		const err = (i: number) => ({
			tool: "bash",
			args: { command: `make t${i}` },
			output: "EACCES: permission denied",
			isError: true,
		});
		expect(run(fresh(), [err(1), err(2)]).stop).toBeUndefined();
		const { stop, at } = run(fresh(), [err(1), err(2), err(3)]);
		expect(at).toBe(2);
		expect(stop).toMatchObject({ rule: "same_error", count: 3 });
	});

	it("a success between errors resets the error streak", () => {
		const err = (i: number) => ({ tool: "bash", args: { command: `t${i}` }, output: "boom", isError: true });
		expect(
			run(fresh(), [err(1), err(2), { tool: "read", args: { path: "a" }, output: "ok" }, err(3), { text: "done" }])
				.stop,
		).toBeUndefined();
	});

	it("parallel calls failing together in one turn count as one error attempt (replay: provider abort)", () => {
		const guard = fresh();
		const writes = ["a.h", "b.h", "c.h", "d.h"].map((path) => ({ name: "write", args: { path, content: "x" } }));
		const turn = assistant(writes);
		const skipped = "Skipped because the provider terminated before tool execution";
		expect(guard.observe(turn)).toBeUndefined();
		for (const [i] of writes.entries()) expect(guard.observe(toolResult(turn, i, skipped, true))).toBeUndefined();
		// Two more turns with the same error make three attempts.
		const { stop } = run(guard, [
			{ tool: "write", args: { path: "e.h" }, output: skipped, isError: true },
			{ tool: "write", args: { path: "f.h" }, output: skipped, isError: true },
		]);
		expect(stop).toMatchObject({ rule: "same_error", count: 3 });
	});

	it("reading different images with the same caption is new output, not a stall (replay: video frames)", () => {
		const guard = fresh();
		for (let turn = 0; turn < 8; turn += 1) {
			const call = assistant(
				[0, 1, 2, 3].map((i) => ({ name: "read", args: { path: `/tmp/f${turn * 4 + i}.jpg` } })),
			);
			expect(guard.observe(call)).toBeUndefined();
			for (const i of [0, 1, 2, 3]) {
				const result = toolResult(call, i, "");
				result.content = [
					{ type: "text", text: "Read image file [image/jpeg]" },
					{ type: "image", mimeType: "image/jpeg", data: Buffer.from(`frame-${turn}-${i}`).toString("base64") },
				];
				expect(guard.observe(result)).toBeUndefined();
			}
		}
		expect(guard.observe(assistant([], "moves: U D L R"))).toBeUndefined();
	});

	describe("grep/rg no-match exception (exit 1, empty output)", () => {
		const noMatch = "Command exited with code 1";
		const bash = (command: string, output = noMatch, isError = true) => ({
			tool: "bash",
			args: { command },
			output,
			isError,
		});
		it("three different greps with no match do not stop (incl. rg, pipes, env prefix, absolute path)", () => {
			const steps = [
				bash('grep -n "deprecatedApi(" src/widget.ts'),
				bash(`grep -n "legacy_\\w+" src/widget.ts`, `(no output)\n\n${noMatch}`),
				bash("rg -n 'a|b' src"),
				bash("cat src/widget.ts | grep -c FIXME"),
				bash("cd src && LC_ALL=C /usr/bin/grep -rn TODO ."),
				bash("egrep 'x|y' a.ts 2>&1"),
			];
			expect(run(fresh(), [...steps, { text: "no deprecated calls" }]).stop).toBeUndefined();
		});
		it("the same grep three times with the same empty result still stops via identical_call", () => {
			const same = bash('grep -n "FIXME" src/widget.ts');
			expect(run(fresh(), [same, same, same])).toMatchObject({ at: 2, stop: { rule: "identical_call" } });
		});
		it("grep exit 2 counts toward same_error", () => {
			const err = "Command exited with code 2";
			const { stop, at } = run(fresh(), [bash("grep x a", err), bash("grep y a", err), bash("grep z a", err)]);
			expect(at).toBe(2);
			expect(stop).toMatchObject({ rule: "same_error", count: 3 });
		});
		it("rg: exit 1 empty is not counted, exit 2 is", () => {
			expect(run(fresh(), [bash("rg a"), bash("rg b"), bash("rg c"), { text: "none" }]).stop).toBeUndefined();
			const err =
				"rg: d: IO error for operation on d: No such file or directory (os error 2)\n\nCommand exited with code 2";
			expect(run(fresh(), [bash("rg a d", err), bash("rg b d", err), bash("rg c d", err)]).stop?.rule).toBe(
				"same_error",
			);
		});
		it("exit 1 with any output, or from a non-search last stage, still counts", () => {
			const withOutput = `grep: warning: stray \\\n\n${noMatch}`;
			expect(
				run(fresh(), [bash("grep a f", withOutput), bash("grep b f", withOutput), bash("grep c f", withOutput)])
					.stop?.rule,
			).toBe("same_error");
			expect(
				run(fresh(), [bash("grep a f | head"), bash("grep b f | head"), bash("grep c f | head")]).stop?.rule,
			).toBe("same_error");
			expect(run(fresh(), [bash("make t1"), bash("make t2"), bash("make t3")]).stop?.rule).toBe("same_error");
		});
		it("finds the last shell stage, ignoring quoted separators and redirections", () => {
			expect(lastShellStage(`grep -E "a|b;c" f`)).toBe(`grep -E "a|b;c" f`);
			expect(lastShellStage("cd x && cat f | rg y 2>&1")).toBe("rg y 2>&1");
			expect(lastShellStage("grep a f; ")).toBe("grep a f");
			expect(lastShellStage("rg a f &>/dev/null")).toBe("rg a f &>/dev/null");
			expect(isSearchNoMatch("bash", { command: "rg a" }, noMatch)).toBe(true);
			expect(isSearchNoMatch("bash", { command: "grep a f || true" }, noMatch)).toBe(false);
			expect(isSearchNoMatch("read", { command: "grep a" }, noMatch)).toBe(false);
			expect(isSearchNoMatch("bash", { command: "grep a" }, "Command exited with code 2")).toBe(false);
		});

		it("a no-match neither counts toward nor resets the error streak", () => {
			const boom = (i: number) => bash(`make t${i}`, "boom");
			const { stop, at } = run(fresh(), [boom(1), bash("grep x a"), boom(2), boom(3)]);
			expect(at).toBe(3);
			expect(stop).toMatchObject({ rule: "same_error", count: 3 });
		});
	});

	it("A·B ping-pong compares args structurally (key order does not matter)", () => {
		const a1 = { tool: "read", args: { path: "a.ts", offset: 1, limit: 50 }, output: "A" };
		const a2 = { tool: "read", args: { limit: 50, offset: 1, path: "a.ts" }, output: "A" };
		const b1 = { tool: "grep", args: { pattern: "x", path: "b" }, output: "B" };
		const b2 = { tool: "grep", args: { path: "b", pattern: "x" }, output: "B" };
		expect(run(fresh(), [a1, b1, a2, b2, a1, b2]).stop).toMatchObject({ rule: "ping_pong" });
	});

	it("A·B ping-pong over 6 calls stops; 5 calls do not", () => {
		const a = { tool: "read", args: { path: "a.ts" }, output: "A" };
		const b = { tool: "read", args: { path: "b.ts" }, output: "B" };
		expect(run(fresh(), [a, b, a, b, a]).stop).toBeUndefined();
		const { stop, at } = run(fresh(), [a, b, a, b, a, b]);
		expect(at).toBe(5);
		expect(stop).toMatchObject({ rule: "ping_pong", count: 6 });
	});

	it("A·B alternation with changing results is progress, not ping-pong", () => {
		const steps = Array.from({ length: 8 }, (_, i) =>
			i % 2 === 0
				? { tool: "edit", args: { path: "a.ts", oldText: "x", newText: "y" }, output: `edited ${i}` }
				: { tool: "bash", args: { command: "npm test" }, output: `${8 - i} failing` },
		);
		expect(run(fresh(), [...steps, { text: "done" }]).stop).toBeUndefined();
	});

	it("K=5: five finished turns without a file change or new output stop the worker", () => {
		const cycle = ["a", "b", "c"].map((path) => ({ tool: "read", args: { path }, output: `body ${path}` }));
		const { stop, at } = run(fresh(), [...cycle, ...cycle, ...cycle]);
		// turns 1-3 are new output; turns 4-8 repeat earlier outputs.
		expect(at).toBe(7);
		expect(stop).toMatchObject({ rule: "no_progress", count: 5 });
	});

	it("K=5: a successful write resets the stall counter", () => {
		const cycle = ["a", "b", "c"].map((path) => ({ tool: "read", args: { path }, output: `body ${path}` }));
		const write = { tool: "write", args: { path: "out", content: "x" }, output: "ok" };
		const steps = [...cycle, cycle[0], cycle[1], cycle[2], cycle[0], write, cycle[1], cycle[2], cycle[0], cycle[1]];
		expect(run(fresh(), [...steps, { text: "done" }]).stop).toBeUndefined();
	});

	it("a final text answer after stalled turns is not a wrong stop", () => {
		const cycle = ["a", "b", "c"].map((path) => ({ tool: "read", args: { path }, output: `body ${path}` }));
		expect(run(fresh(), [...cycle, ...cycle.slice(0, 2), cycle[2], { text: "answer" }]).stop).toBeUndefined();
	});

	it("depth 1: a worker calling the subagent tool is stopped at once", () => {
		const { stop, at } = run(fresh(), [
			{ tool: "subagent", args: { agent: "x", task: "y" }, output: "Tool subagent not found", isError: true },
		]);
		expect(at).toBe(0);
		expect(stop).toMatchObject({ rule: "nested_spawn", toolName: "subagent" });
	});

	it("keeps returning the first stop once stopped", () => {
		const guard = fresh();
		const same = { tool: "bash", args: { command: "ls" }, output: "a" };
		const first = run(guard, [same, same, same]).stop;
		expect(guard.stopped).toBe(first);
		expect(guard.observe(assistant([], "late"))).toBe(first);
	});
});

describe("spec 071 caps (mock caps from 072: 18 turns, 70,254 billed tokens, 5.70 s)", () => {
	const caps = { maxTurns: 18, maxBilledTokens: 70_254, maxWallMs: 5_700 };
	const distinct = (n: number) =>
		Array.from({ length: n }, (_, i) => ({ tool: "read", args: { path: `f${i}` }, output: `body ${i}` }));

	it("turn cap returns a partial stop when the worker wants an extra turn", () => {
		promptChars = 0;
		const { stop, at } = run(createSubagentLoopGuard({ caps: { maxTurns: 18 } }), distinct(30));
		expect(at).toBe(17);
		expect(stop).toMatchObject({ rule: "turn_cap", partial: true, usage: { turns: 18 } });
	});

	it("a worker finishing exactly at the turn cap is not stopped", () => {
		promptChars = 0;
		expect(
			run(createSubagentLoopGuard({ caps: { maxTurns: 18 } }), [...distinct(17), { text: "done" }]).stop,
		).toBeUndefined();
	});

	it("token cap counts billed tokens from realistic, growing usage", () => {
		promptChars = 0;
		const big = Array.from({ length: 40 }, (_, i) => ({
			tool: "read",
			args: { path: `f${i}` },
			output: `${i}`.padEnd(20_000, "x"),
		}));
		const { stop } = run(createSubagentLoopGuard({ caps }), big);
		expect(stop?.rule).toBe("token_cap");
		expect(stop?.usage.billedTokens).toBeGreaterThan(70_254);
		expect(stop?.usage.turns).toBeLessThan(18);
	});

	it("wall cap uses the injected clock", () => {
		let now = 0;
		const guard = createSubagentLoopGuard({ caps, now: () => now });
		now = 5_701;
		expect(run(guard, distinct(1)).stop).toMatchObject({ rule: "wall_cap" });
	});

	it("resume keeps caps and the usage already counted (rule 8)", () => {
		let now = 0;
		promptChars = 0;
		const first = createSubagentLoopGuard({ caps, now: () => now });
		run(first, distinct(10));
		now = 1_000;
		const snapshot = first.snapshot();
		expect(snapshot).toEqual({ caps, usage: { turns: 10, billedTokens: expect.any(Number), elapsedMs: 1_000 } });
		const resumed = createSubagentLoopGuard({
			resume: JSON.parse(JSON.stringify(snapshot)),
			caps: { maxTurns: 999 },
			now: () => now,
		});
		expect(resumed.snapshot()).toEqual(snapshot);
		const { stop, at } = run(resumed, distinct(30).slice(10));
		expect(at).toBe(7);
		expect(stop).toMatchObject({ rule: "turn_cap", usage: { turns: 18 } });
	});
});
