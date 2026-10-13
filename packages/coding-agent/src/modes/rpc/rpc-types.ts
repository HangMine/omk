/**
 * RPC protocol types for headless operation.
 *
 * Commands are sent as JSON lines on stdin.
 * Responses and events are emitted as JSON lines on stdout.
 */

import type { AgentMessage, ThinkingLevel } from "omk-agent-core";
import type { Model } from "omk-ai";
import { type Static, Type } from "typebox";
import type { SessionStats } from "../../core/agent-session.ts";
import type { BashResult } from "../../core/bash-executor.ts";
import type { CompactionResult } from "../../core/compaction/index.ts";
import type { SessionTermination } from "../../core/session-termination.ts";
import type { SourceInfo } from "../../core/source-info.ts";

export const RPC_ENVELOPE_SCHEMA = Type.Object({ id: Type.Optional(Type.String()), type: Type.String() });
const images = Type.Optional(
	Type.Array(Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Type.String() })),
);
const mode = Type.Union([Type.Literal("all"), Type.Literal("one-at-a-time")]);
const thinking = Type.Union([
	Type.Literal("off"),
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
	Type.Literal("max"),
	Type.Literal("ultra"),
]);
export const RPC_COMMAND_BODY_SCHEMA = Type.Union([
	Type.Object({
		type: Type.Literal("prompt"),
		message: Type.String(),
		images,
		streamingBehavior: Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("followUp")])),
	}),
	Type.Object({ type: Type.Literal("steer"), message: Type.String(), images }),
	Type.Object({ type: Type.Literal("follow_up"), message: Type.String(), images }),
	Type.Object({ type: Type.Literal("abort") }),
	Type.Object({ type: Type.Literal("new_session"), parentSession: Type.Optional(Type.String()) }),
	Type.Object({ type: Type.Literal("get_state") }),
	Type.Object({ type: Type.Literal("set_model"), provider: Type.String(), modelId: Type.String() }),
	Type.Object({ type: Type.Literal("cycle_model") }),
	Type.Object({ type: Type.Literal("get_available_models") }),
	Type.Object({ type: Type.Literal("set_thinking_level"), level: thinking }),
	Type.Object({ type: Type.Literal("cycle_thinking_level") }),
	Type.Object({ type: Type.Literal("set_steering_mode"), mode }),
	Type.Object({ type: Type.Literal("set_follow_up_mode"), mode }),
	Type.Object({ type: Type.Literal("compact"), customInstructions: Type.Optional(Type.String()) }),
	Type.Object({ type: Type.Literal("set_auto_compaction"), enabled: Type.Boolean() }),
	Type.Object({ type: Type.Literal("set_auto_retry"), enabled: Type.Boolean() }),
	Type.Object({ type: Type.Literal("abort_retry") }),
	Type.Object({
		type: Type.Literal("bash"),
		command: Type.String(),
		excludeFromContext: Type.Optional(Type.Boolean()),
	}),
	Type.Object({ type: Type.Literal("abort_bash") }),
	Type.Object({ type: Type.Literal("get_session_stats") }),
	Type.Object({ type: Type.Literal("export_html"), outputPath: Type.Optional(Type.String()) }),
	Type.Object({ type: Type.Literal("switch_session"), sessionPath: Type.String() }),
	Type.Object({ type: Type.Literal("fork"), entryId: Type.String() }),
	Type.Object({ type: Type.Literal("clone") }),
	Type.Object({ type: Type.Literal("get_fork_messages") }),
	Type.Object({ type: Type.Literal("get_last_assistant_text") }),
	Type.Object({ type: Type.Literal("set_session_name"), name: Type.String() }),
	Type.Object({ type: Type.Literal("get_messages") }),
	Type.Object({ type: Type.Literal("get_commands") }),
]);
export const RPC_COMMAND_SCHEMA = Type.Intersect([RPC_ENVELOPE_SCHEMA, RPC_COMMAND_BODY_SCHEMA]);
export const RPC_UI_RESPONSE_SCHEMA = Type.Intersect([
	Type.Object({
		type: Type.Literal("extension_ui_response"),
		id: Type.String(),
		value: Type.Optional(Type.String()),
		confirmed: Type.Optional(Type.Boolean()),
		cancelled: Type.Optional(Type.Literal(true)),
	}),
	Type.Union([
		Type.Object({ value: Type.String() }),
		Type.Object({ confirmed: Type.Boolean() }),
		Type.Object({ cancelled: Type.Literal(true) }),
	]),
]);

export type RpcCommand = Static<typeof RPC_COMMAND_SCHEMA>;
export type RpcExtensionUIResponse = Static<typeof RPC_UI_RESPONSE_SCHEMA>;

// ============================================================================
// RPC Slash Command (for get_commands response)
// ============================================================================

/** A command available for invocation via prompt */
export interface RpcSlashCommand {
	/** Command name (without leading slash) */
	name: string;
	/** Human-readable description */
	description?: string;
	/** What kind of command this is */
	source: "extension" | "prompt" | "skill";
	/** Source metadata for the owning resource */
	sourceInfo: SourceInfo;
}

// ============================================================================
// RPC State
// ============================================================================

export interface RpcSessionState {
	model?: Model<any>;
	thinkingLevel: ThinkingLevel;
	isStreaming: boolean;
	isCompacting: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	autoCompactionEnabled: boolean;
	messageCount: number;
	pendingMessageCount: number;
	lastTermination?: SessionTermination;
}

// ============================================================================
// RPC Responses (stdout)
// ============================================================================

// Success responses with data
export type RpcResponse =
	// Prompting (async - events follow)
	| { id?: string; type: "response"; command: "prompt"; success: true }
	| { id?: string; type: "response"; command: "steer"; success: true }
	| { id?: string; type: "response"; command: "follow_up"; success: true }
	| { id?: string; type: "response"; command: "abort"; success: true }
	| { id?: string; type: "response"; command: "new_session"; success: true; data: { cancelled: boolean } }

	// State
	| { id?: string; type: "response"; command: "get_state"; success: true; data: RpcSessionState }

	// Model
	| {
			id?: string;
			type: "response";
			command: "set_model";
			success: true;
			data: Model<any>;
	  }
	| {
			id?: string;
			type: "response";
			command: "cycle_model";
			success: true;
			data: { model: Model<any>; thinkingLevel: ThinkingLevel; isScoped: boolean } | null;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_available_models";
			success: true;
			data: { models: Model<any>[] };
	  }

	// Thinking
	| { id?: string; type: "response"; command: "set_thinking_level"; success: true }
	| {
			id?: string;
			type: "response";
			command: "cycle_thinking_level";
			success: true;
			data: { level: ThinkingLevel } | null;
	  }

	// Queue modes
	| { id?: string; type: "response"; command: "set_steering_mode"; success: true }
	| { id?: string; type: "response"; command: "set_follow_up_mode"; success: true }

	// Compaction
	| { id?: string; type: "response"; command: "compact"; success: true; data: CompactionResult }
	| { id?: string; type: "response"; command: "set_auto_compaction"; success: true }

	// Retry
	| { id?: string; type: "response"; command: "set_auto_retry"; success: true }
	| { id?: string; type: "response"; command: "abort_retry"; success: true }

	// Bash
	| { id?: string; type: "response"; command: "bash"; success: true; data: BashResult }
	| { id?: string; type: "response"; command: "abort_bash"; success: true }

	// Session
	| { id?: string; type: "response"; command: "get_session_stats"; success: true; data: SessionStats }
	| { id?: string; type: "response"; command: "export_html"; success: true; data: { path: string } }
	| { id?: string; type: "response"; command: "switch_session"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "fork"; success: true; data: { text: string; cancelled: boolean } }
	| { id?: string; type: "response"; command: "clone"; success: true; data: { cancelled: boolean } }
	| {
			id?: string;
			type: "response";
			command: "get_fork_messages";
			success: true;
			data: { messages: Array<{ entryId: string; text: string }> };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_last_assistant_text";
			success: true;
			data: { text: string | null };
	  }
	| { id?: string; type: "response"; command: "set_session_name"; success: true }

	// Messages
	| { id?: string; type: "response"; command: "get_messages"; success: true; data: { messages: AgentMessage[] } }

	// Commands
	| {
			id?: string;
			type: "response";
			command: "get_commands";
			success: true;
			data: { commands: RpcSlashCommand[] };
	  }

	// Error response (any command can fail)
	| {
			id?: string;
			type: "response";
			command: string;
			success: false;
			error: string;
			termination?: SessionTermination;
	  };

// ============================================================================
// Extension UI Events (stdout)
// ============================================================================

/** Emitted when an extension needs user input */
export type RpcExtensionUIRequest =
	| { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
	| {
			type: "extension_ui_request";
			id: string;
			method: "input";
			title: string;
			placeholder?: string;
			timeout?: number;
	  }
	| { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "notify";
			message: string;
			notifyType?: "info" | "warning" | "error";
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setStatus";
			statusKey: string;
			statusText: string | undefined;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWidget";
			widgetKey: string;
			widgetLines: string[] | undefined;
			widgetPlacement?: "aboveEditor" | "belowEditor";
	  }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string };

// ============================================================================
// Helper type for extracting command types
// ============================================================================

export type RpcCommandType = RpcCommand["type"];
