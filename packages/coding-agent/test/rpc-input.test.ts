import { describe, expect, it } from "vitest";
import { isValidThinkingLevel } from "../src/cli/args.ts";
import { parseRpcInput } from "../src/modes/rpc/rpc-input.ts";
import type { RpcCommand } from "../src/modes/rpc/rpc-types.ts";

const commands = [
	{
		type: "prompt",
		message: "hello",
		images: [{ type: "image", data: "AA==", mimeType: "image/png" }],
		streamingBehavior: "steer",
	},
	{ type: "steer", message: "hello" },
	{ type: "follow_up", message: "hello" },
	{ type: "abort" },
	{ type: "new_session", parentSession: "parent.jsonl" },
	{ type: "get_state" },
	{ type: "set_model", provider: "anthropic", modelId: "test-model" },
	{ type: "cycle_model" },
	{ type: "get_available_models" },
	{ type: "set_thinking_level", level: "high" },
	{ type: "cycle_thinking_level" },
	{ type: "set_steering_mode", mode: "all" },
	{ type: "set_follow_up_mode", mode: "one-at-a-time" },
	{ type: "compact", customInstructions: "keep rules" },
	{ type: "set_auto_compaction", enabled: true },
	{ type: "set_auto_retry", enabled: false },
	{ type: "abort_retry" },
	{ type: "bash", command: "echo hello", excludeFromContext: true },
	{ type: "abort_bash" },
	{ type: "get_session_stats" },
	{ type: "export_html", outputPath: "export.html" },
	{ type: "switch_session", sessionPath: "other.jsonl" },
	{ type: "fork", entryId: "entry-1" },
	{ type: "clone" },
	{ type: "get_fork_messages" },
	{ type: "get_last_assistant_text" },
	{ type: "set_session_name", name: "name" },
	{ type: "get_messages" },
	{ type: "get_commands" },
] satisfies RpcCommand[];

const invalid = [
	{ type: "prompt" },
	{ type: "prompt", message: 3 },
	{ type: "prompt", message: "hello", images: [null] },
	{ type: "prompt", message: "hello", images: [{ type: "image", data: "AA==" }] },
	{ type: "prompt", message: "hello", streamingBehavior: "invalid" },
	{ type: "steer", message: [] },
	{ type: "follow_up", message: null },
	{ type: "new_session", parentSession: false },
	{ type: "set_model", provider: "anthropic" },
	{ type: "set_thinking_level", level: "invalid" },
	{ type: "set_steering_mode", mode: "invalid" },
	{ type: "set_follow_up_mode", mode: false },
	{ type: "compact", customInstructions: null },
	{ type: "set_auto_compaction", enabled: "false" },
	{ type: "set_auto_retry", enabled: 0 },
	{ type: "bash", command: {} },
	{ type: "bash", command: "echo hello", excludeFromContext: "false" },
	{ type: "export_html", outputPath: 42 },
	{ type: "switch_session", sessionPath: null },
	{ type: "fork", entryId: false },
	{ type: "set_session_name", name: {} },
];

describe("RPC input validation", () => {
	it("accepts a command without optional fields or a correlation id", () => {
		expect(parseRpcInput('{"type":"prompt","message":""}')).toEqual({ type: "prompt", message: "" });
	});
	it.each(commands)("accepts the documented $type command", (command) => {
		const input = { id: "request-1", ...command, futureField: true };
		expect(parseRpcInput(JSON.stringify(input))).toEqual(input);
	});

	it.each(invalid)("rejects invalid fields for $type before dispatch", (command) => {
		expect(parseRpcInput(JSON.stringify({ id: "bad-1", ...command }))).toMatchObject({
			type: "response",
			id: "bad-1",
			command: command.type,
			success: false,
		});
	});

	it.each([null, [], "get_state", 1, true, {}, { type: null }, { id: "bad-type", type: [] }])(
		"rejects invalid envelopes: %j",
		(input) => {
			expect(parseRpcInput(JSON.stringify(input))).toMatchObject({
				type: "response",
				command: "parse",
				success: false,
			});
		},
	);

	it("retains only a valid string id in malformed-envelope errors", () => {
		expect(parseRpcInput('{"id":"bad-type","type":null}')).toMatchObject({ id: "bad-type", success: false });
		expect(parseRpcInput('{"id":{"secret":"private"},"type":"get_state"}')).toMatchObject({
			id: undefined,
			success: false,
		});
	});

	it("correlates unknown commands with their request", () => {
		expect(parseRpcInput('{"id":"unknown-1","type":"unsupported"}')).toEqual({
			id: "unknown-1",
			type: "response",
			command: "unsupported",
			success: false,
			error: "Unknown command: unsupported",
		});
	});

	it("does not echo invalid JSON or invalid field values", () => {
		for (const input of [
			'{"secret":"DO_NOT_ECHO_SECRET"',
			'{"type":"bash","command":{"secret":"DO_NOT_ECHO_SECRET"}}',
		]) {
			const result = parseRpcInput(input);
			expect(result).toMatchObject({ type: "response", success: false });
			expect(JSON.stringify(result)).not.toContain("DO_NOT_ECHO_SECRET");
		}
	});

	it.each(["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"])(
		"preserves CLI thinking level %s",
		(level) => {
			expect(isValidThinkingLevel(level)).toBe(true);
			expect(parseRpcInput(JSON.stringify({ type: "set_thinking_level", level }))).toEqual({
				type: "set_thinking_level",
				level,
			});
		},
	);

	it.each([{ value: "yes" }, { confirmed: true }, { cancelled: true }])(
		"accepts extension UI responses: %j",
		(fields) => {
			const input = { type: "extension_ui_response", id: "ui-1", ...fields };
			expect(parseRpcInput(JSON.stringify(input))).toEqual(input);
		},
	);

	it.each([
		{},
		{ value: 7 },
		{ confirmed: "false" },
		{ cancelled: false },
		{ value: "yes", cancelled: "false" },
		{ value: "yes", confirmed: 1 },
		{ confirmed: true, value: 7 },
		{ cancelled: true, confirmed: "yes" },
	])("rejects invalid UI responses: %j", (fields) => {
		expect(parseRpcInput(JSON.stringify({ type: "extension_ui_response", id: "ui-1", ...fields }))).toMatchObject({
			id: "ui-1",
			type: "response",
			command: "extension_ui_response",
			success: false,
		});
	});

	it("requires extension UI correlation ids", () => {
		expect(parseRpcInput('{"type":"extension_ui_response","value":"yes"}')).toMatchObject({
			type: "response",
			success: false,
		});
	});
});
