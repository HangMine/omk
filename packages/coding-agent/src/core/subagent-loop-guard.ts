/**
 * Spec 071 loop guard for subagent workers. Always on whenever a subagent runs (no flag);
 * the lead's own session keeps `identical-loop.ts` as before.
 *
 * The guard watches a worker's completed messages (assistant turns and tool results) and
 * returns a typed stop the first time any rule fires. It never retries or steers: the caller
 * stops the worker and reports the stop as an error with the worker's partial result.
 *
 * Rules (spec 071 "Loop guard"):
 *  - identical_call: same tool, structurally equal args AND the same result, 3 times in a row (N=3).
 *                    A repeated call whose output changes (polling) is not a loop.
 *  - same_error:     the same error text in 3 turns in a row (parallel calls in one turn count once).
 *  - ping_pong:      A·B alternation over 6 calls whose results alternate the same way.
 *  - no_progress:    K=5 finished tool turns in a row with no file change and no new tool output.
 *  - nested_spawn:   a worker calls the `subagent` tool (depth 1: workers cannot spawn workers).
 *  - turn_cap / token_cap / wall_cap: optional per-worker caps; mock caps only until 073.
 *
 * The identical_call (action + observation), same_error (action-error) and ping_pong
 * (alternating action-observation) rules port the logic of OpenHands StuckDetector:
 *   https://github.com/OpenHands/software-agent-sdk/blob/1fbfd37f6fb2/openhands-sdk/openhands/sdk/conversation/stuck_detector.py
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
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Message } from "omk-ai";
import type { LoopRecord } from "./identical-loop.ts";
import { isFileMutatingTool } from "./progress-stall.ts";

export const SUBAGENT_LOOP_GUARD_RULES = {
	identicalCalls: 3,
	sameErrors: 3,
	pingPongCalls: 6,
	noProgressTurns: 5,
} as const;

/** Tool name a worker would call to spawn another worker. */
export const SUBAGENT_TOOL_NAME = "subagent";

export type LoopGuardRule =
	| "identical_call"
	| "same_error"
	| "ping_pong"
	| "no_progress"
	| "nested_spawn"
	| "turn_cap"
	| "token_cap"
	| "wall_cap";

export interface LoopGuardCaps {
	readonly maxTurns?: number;
	readonly maxBilledTokens?: number;
	readonly maxWallMs?: number;
}

export interface LoopGuardUsage {
	readonly turns: number;
	readonly billedTokens: number;
	readonly elapsedMs: number;
}

export interface LoopGuardStop {
	readonly code: "loop_guard";
	readonly rule: LoopGuardRule;
	readonly message: string;
	readonly count: number;
	readonly toolName?: string;
	/** Caps return partial completion; loop rules return the partial result as an error. */
	readonly partial: true;
	readonly usage: LoopGuardUsage;
}

/** Serializable state so a resumed worker keeps its caps and the amount already used (rule 8). */
export interface LoopGuardSnapshot {
	readonly caps: LoopGuardCaps;
	readonly usage: LoopGuardUsage;
}

export interface SubagentLoopGuardOptions {
	readonly caps?: LoopGuardCaps;
	readonly resume?: LoopGuardSnapshot;
	readonly now?: () => number;
}

export interface SubagentLoopGuard {
	observe(message: Message): LoopGuardStop | undefined;
	snapshot(): LoopGuardSnapshot;
	readonly stopped: LoopGuardStop | undefined;
}

interface CallRecord extends LoopRecord {
	readonly id: string;
	result?: string;
}

const WINDOW = 32;

function digest(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

function resultText(message: Extract<Message, { role: "toolResult" }>): string {
	// Images carry their own digest: two different screenshots with the same caption are different output.
	return message.content
		.map((part) => (part.type === "text" ? part.text : `[image ${part.mimeType} ${digest(part.data)}]`))
		.join("\n");
}

function billed(message: Extract<Message, { role: "assistant" }>): number {
	const usage = message.usage;
	if (!usage) return 0;
	return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/** Same tool, structurally equal args (key order independent) and the same result. */
function sameStep(left: CallRecord, right: CallRecord): boolean {
	return left.toolName === right.toolName && left.result === right.result && isDeepStrictEqual(left.args, right.args);
}

function sameCall(left: CallRecord, right: CallRecord): boolean {
	return left.toolName === right.toolName && isDeepStrictEqual(left.args, right.args);
}

/** Order-independent key for set membership (isDeepStrictEqual cannot index a Set). */
function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`).join(",")}}`;
}

/** OpenHands `_is_stuck_repeating_action_observation`: the last N calls and their results are equal. */
function identicalRun(calls: readonly CallRecord[], need: number): boolean {
	if (calls.length < need) return false;
	const tail = calls.slice(-need);
	if (tail.some((call) => call.result === undefined)) return false;
	return tail.every((call) => sameStep(tail[0], call));
}

/** OpenHands `_is_stuck_alternating_action_observation`: a[i] == a[i+2] for calls and results. */
function isPingPong(calls: readonly CallRecord[], need: number): boolean {
	if (calls.length < need) return false;
	const tail = calls.slice(-need);
	if (tail.some((call) => call.result === undefined)) return false;
	if (sameCall(tail[0], tail[1])) return false; // A·A·A… is identical_call or polling, not ping-pong
	for (let index = 0; index + 2 < tail.length; index += 1) {
		if (!sameStep(tail[index], tail[index + 2])) return false;
	}
	return true;
}

export function createSubagentLoopGuard(options: SubagentLoopGuardOptions = {}): SubagentLoopGuard {
	const caps = options.resume?.caps ?? options.caps ?? {};
	const now = options.now ?? (() => performance.now());
	const usedBefore = options.resume?.usage ?? { turns: 0, billedTokens: 0, elapsedMs: 0 };
	const startedAt = now();
	let turns = usedBefore.turns;
	let billedTokens = usedBefore.billedTokens;
	const calls: CallRecord[] = [];
	const pending = new Map<string, CallRecord>();
	const seenOutputs = new Set<string>();
	let errorStreak: { text: string; count: number; turn: number } | undefined;
	let turnOpen = false;
	let turnProgress = false;
	let stalledTurns = 0;
	let stopped: LoopGuardStop | undefined;

	const usage = (): LoopGuardUsage => ({
		turns,
		billedTokens,
		elapsedMs: usedBefore.elapsedMs + Math.max(0, now() - startedAt),
	});
	const stop = (rule: LoopGuardRule, message: string, count: number, toolName?: string): LoopGuardStop => {
		stopped = {
			code: "loop_guard",
			rule,
			message,
			count,
			...(toolName ? { toolName } : {}),
			partial: true,
			usage: usage(),
		};
		return stopped;
	};
	const finishTurn = (): LoopGuardStop | undefined => {
		turnOpen = false;
		stalledTurns = turnProgress ? 0 : stalledTurns + 1;
		if (stalledTurns >= SUBAGENT_LOOP_GUARD_RULES.noProgressTurns)
			return stop("no_progress", `${stalledTurns} turns without a file change or new tool output`, stalledTurns);
		return undefined;
	};
	const checkCaps = (wantsMore: boolean): LoopGuardStop | undefined => {
		const used = usage();
		if (caps.maxBilledTokens !== undefined && used.billedTokens > caps.maxBilledTokens)
			return stop(
				"token_cap",
				`billed tokens ${used.billedTokens} exceed cap ${caps.maxBilledTokens}`,
				used.billedTokens,
			);
		if (caps.maxWallMs !== undefined && used.elapsedMs > caps.maxWallMs)
			return stop(
				"wall_cap",
				`wall time ${Math.round(used.elapsedMs)}ms exceeds cap ${caps.maxWallMs}ms`,
				used.turns,
			);
		if (wantsMore && caps.maxTurns !== undefined && used.turns >= caps.maxTurns)
			return stop("turn_cap", `turn cap ${caps.maxTurns} reached`, used.turns);
		return undefined;
	};

	const onAssistant = (message: Extract<Message, { role: "assistant" }>): LoopGuardStop | undefined => {
		if (turnOpen) {
			const stall = finishTurn();
			if (stall) return stall;
		}
		turns += 1;
		billedTokens += billed(message);
		turnOpen = true;
		turnProgress = false;
		const toolCalls = message.content.filter((part) => part.type === "toolCall");
		for (const part of toolCalls) {
			if (part.name === SUBAGENT_TOOL_NAME)
				return stop("nested_spawn", "workers cannot spawn subagents (depth 1)", 1, part.name);
			const record: CallRecord = { id: part.id, toolName: part.name, args: part.arguments };
			calls.push(record);
			pending.set(part.id, record);
			if (calls.length > WINDOW) calls.splice(0, calls.length - WINDOW);
		}
		// A text-only turn is the worker's answer, not a stalled tool turn.
		if (toolCalls.length === 0) turnOpen = false;
		return checkCaps(toolCalls.length > 0);
	};

	const onToolResult = (message: Extract<Message, { role: "toolResult" }>): LoopGuardStop | undefined => {
		const record = pending.get(message.toolCallId);
		pending.delete(message.toolCallId);
		const text = resultText(message);
		if (record) record.result = digest(`${message.isError ? "E" : "O"}:${text}`);
		// Empty output says nothing about effects, so a new call with empty output still counts as new.
		const outputKey = text.trim()
			? `${message.toolName}:${digest(text)}`
			: `${message.toolName}:${digest(canonical(record?.args ?? message.toolCallId))}`;
		if (!seenOutputs.has(outputKey)) turnProgress = true;
		seenOutputs.add(outputKey);
		if (!message.isError && isFileMutatingTool(message.toolName)) turnProgress = true;
		const need = SUBAGENT_LOOP_GUARD_RULES.identicalCalls;
		if (identicalRun(calls, need))
			return stop(
				"identical_call",
				`${message.toolName} called ${need} times in a row with the same args and the same result`,
				need,
				message.toolName,
			);
		if (message.isError) {
			// Parallel calls failing together in one turn (e.g. all skipped after a provider abort) are one attempt.
			if (errorStreak?.text !== text) errorStreak = { text, count: 1, turn: turns };
			else if (errorStreak.turn !== turns) errorStreak = { text, count: errorStreak.count + 1, turn: turns };
			if (errorStreak.count >= SUBAGENT_LOOP_GUARD_RULES.sameErrors)
				return stop(
					"same_error",
					`same error ${errorStreak.count} times in a row: ${text.slice(0, 200)}`,
					errorStreak.count,
					message.toolName,
				);
		} else errorStreak = undefined;
		if (isPingPong(calls, SUBAGENT_LOOP_GUARD_RULES.pingPongCalls))
			return stop(
				"ping_pong",
				`A·B ping-pong over ${SUBAGENT_LOOP_GUARD_RULES.pingPongCalls} calls`,
				SUBAGENT_LOOP_GUARD_RULES.pingPongCalls,
				message.toolName,
			);
		if (turnOpen && pending.size === 0) return finishTurn() ?? checkCaps(false);
		return checkCaps(false);
	};

	return {
		observe(message) {
			if (stopped) return stopped;
			if (message.role === "assistant") return onAssistant(message);
			if (message.role === "toolResult") return onToolResult(message);
			return undefined;
		},
		snapshot: () => ({ caps, usage: usage() }),
		get stopped() {
			return stopped;
		},
	};
}
