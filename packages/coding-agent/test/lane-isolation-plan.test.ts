import { describe, expect, it } from "vitest";
import {
	assertNoLaneIsolationConflicts,
	createLaneIsolationPlan,
	validateLaneIsolationGrant,
} from "../src/core/lane-isolation-plan.ts";
import type { SubagentLaneGrant } from "../src/core/loadout-runtime.ts";

function grant(overrides: Partial<SubagentLaneGrant> = {}): SubagentLaneGrant {
	return {
		laneId: "impl-a",
		agent: "omk-executor",
		task: "Implement a bounded change",
		scope: "src only",
		authority: "write-scoped",
		allowedPaths: ["src"],
		blockedPaths: ["**/.env*"],
		tools: ["read", "write"],
		skills: ["coding-standards"],
		mcp: ["filesystem"],
		hooks: ["protect-secrets"],
		commands: { mode: "scoped-shell" },
		contextInheritance: "bounded",
		evidenceGates: ["automated-verification"],
		dependsOn: [],
		acceptance: ["tests pass"],
		evidenceOutput: ".omk/runs/run-1/impl-a.md",
		scheduler: { readSet: [], writeSet: [{ path: "src" }], parallelizable: false },
		...overrides,
	};
}

describe("lane isolation scaffold on current lane grants", () => {
	it("plans deterministic paths without materializing them", () => {
		expect(createLaneIsolationPlan(grant(), { runId: "run-1" })).toEqual({
			laneId: "impl-a",
			branchName: "work/run-1/impl-a",
			worktreePath: ".omk/worktrees/run-1/impl-a",
			evidenceOutput: ".omk/runs/run-1/impl-a.md",
			readOnly: false,
			authority: "write-scoped",
		});
	});
	it("requires explicit provisioning", () => {
		for (const field of ["skills", "hooks", "mcp", "acceptance"] as const) {
			expect(() => validateLaneIsolationGrant(grant({ [field]: [] }))).toThrow(field);
		}
	});
	it("allows read scopes for read-only grants but rejects write scopes", () => {
		expect(() => validateLaneIsolationGrant(grant({ authority: "read-only" }))).toThrow("Read-only");
		expect(
			createLaneIsolationPlan(
				grant({
					authority: "read-only",
					scheduler: { readSet: [{ path: "src" }], writeSet: [], parallelizable: true },
				}),
				{ runId: "run-1" },
			).readOnly,
		).toBe(true);
	});
	it("confines evidence and rejects traversal, URI, drive and unsafe identifiers", () => {
		for (const evidenceOutput of [
			"../leak",
			".omk/runs/../../leak",
			"file:.omk/runs/a",
			"C:/runs/a",
			"tmp/a",
			".omk/runs/<goal>/a",
		]) {
			expect(() => createLaneIsolationPlan(grant({ evidenceOutput }), { runId: "run-1" })).toThrow();
		}
		for (const runId of ["../run", "a/b", "..", "a.lock/next"]) {
			expect(() => createLaneIsolationPlan(grant(), { runId })).toThrow("runId");
		}
		expect(() => validateLaneIsolationGrant(grant({ allowedPaths: ["../src"] }))).toThrow("escapes");
	});
	it("rejects duplicate evidence paths and overlapping writer scopes conservatively", () => {
		expect(() => assertNoLaneIsolationConflicts([grant(), grant({ laneId: "impl-b" })])).toThrow("evidenceOutput");
		expect(() =>
			assertNoLaneIsolationConflicts([
				grant(),
				grant({
					laneId: "impl-b",
					evidenceOutput: ".omk/runs/run-1/impl-b.md",
					scheduler: { readSet: [], writeSet: [{ path: "Src/*.ts" }], parallelizable: false },
				}),
			]),
		).toThrow("Parallel writer");
	});
});
