import { describe, expect, it } from "vitest";
import registerSubagent from "./index.ts";
import {
	canSpawnSubagents,
	childSubagentEnv,
	currentSubagentDepth,
	DEFAULT_SUBAGENT_MAX_DEPTH,
	SUBAGENT_DEPTH_ENV,
} from "./nesting.ts";

function registeredToolNames(env: NodeJS.ProcessEnv): string[] {
	const saved = { ...process.env };
	const names: string[] = [];
	try {
		for (const key of Object.keys(process.env)) delete process.env[key];
		Object.assign(process.env, env);
		registerSubagent({ registerTool: (tool: { name: string }) => names.push(tool.name) } as never);
	} finally {
		for (const key of Object.keys(process.env)) delete process.env[key];
		Object.assign(process.env, saved);
	}
	return names;
}

describe("subagent nesting guard", () => {
	it("lets the top-level session spawn and stops its children by default", () => {
		expect(canSpawnSubagents({})).toBe(true);
		const child = childSubagentEnv({});
		expect(child[SUBAGENT_DEPTH_ENV]).toBe("1");
		expect(canSpawnSubagents(child)).toBe(false);
	});

	it("increments depth for each generation; spec 071 ignores a raised OMK_SUBAGENT_MAX_DEPTH", () => {
		const grandchild = childSubagentEnv(childSubagentEnv({ OMK_SUBAGENT_MAX_DEPTH: "2" }));
		expect(currentSubagentDepth(grandchild)).toBe(2);
		expect(canSpawnSubagents(childSubagentEnv({ OMK_SUBAGENT_MAX_DEPTH: "2" }))).toBe(false);
		expect(canSpawnSubagents(grandchild)).toBe(false);
	});

	it("treats malformed depth values as defaults", () => {
		expect(currentSubagentDepth({ [SUBAGENT_DEPTH_ENV]: "-3" })).toBe(0);
		expect(canSpawnSubagents({ OMK_SUBAGENT_MAX_DEPTH: "lots" })).toBe(true);
	});

	it("does not register the subagent tool in a child at the limit", () => {
		expect(registeredToolNames({})).toEqual(["subagent"]);
		expect(registeredToolNames({ [SUBAGENT_DEPTH_ENV]: "1" })).toEqual([]);
	});

	it("spec 071 rule 1: depth is fixed at 1 regardless of OMK_SUBAGENT_MAX_DEPTH or OMK_SUBAGENT_RUNTIME", () => {
		expect(DEFAULT_SUBAGENT_MAX_DEPTH).toBe(1);
		for (const env of [{}, { OMK_SUBAGENT_RUNTIME: "0" }, { OMK_SUBAGENT_RUNTIME: "1" }]) {
			for (const max of [undefined, "0", "3"]) {
				const top = max === undefined ? env : { ...env, OMK_SUBAGENT_MAX_DEPTH: max };
				expect(canSpawnSubagents(top)).toBe(true);
				expect(canSpawnSubagents(childSubagentEnv(top))).toBe(false);
				expect(registeredToolNames({ ...top, [SUBAGENT_DEPTH_ENV]: "1" })).toEqual([]);
			}
		}
	});
});
