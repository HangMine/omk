import { Check } from "typebox/value";
import { error } from "./rpc-response.ts";
import {
	RPC_COMMAND_BODY_SCHEMA,
	RPC_COMMAND_SCHEMA,
	RPC_ENVELOPE_SCHEMA,
	RPC_UI_RESPONSE_SCHEMA,
	type RpcCommand,
	type RpcExtensionUIResponse,
	type RpcResponse,
} from "./rpc-types.ts";
export function parseRpcInput(line: string): RpcCommand | RpcExtensionUIResponse | RpcResponse {
	let input: unknown;
	try {
		input = JSON.parse(line);
	} catch {
		return error(undefined, "parse", "Failed to parse command: invalid JSON");
	}
	const id =
		typeof input === "object" && input !== null && "id" in input && typeof input.id === "string"
			? input.id
			: undefined;
	if (!Check(RPC_ENVELOPE_SCHEMA, input)) {
		return error(id, "parse", "Invalid command: expected an object with a string type and optional string id");
	}
	if (input.type === "extension_ui_response") {
		return Check(RPC_UI_RESPONSE_SCHEMA, input) ? input : error(id, input.type, "Invalid extension UI response");
	}
	if (Check(RPC_COMMAND_SCHEMA, input)) return input;
	const known = RPC_COMMAND_BODY_SCHEMA.anyOf.some((schema) => schema.properties.type.const === input.type);
	return error(id, input.type, known ? "Invalid command fields" : `Unknown command: ${input.type}`);
}
