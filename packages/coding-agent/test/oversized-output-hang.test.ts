import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Spec 061 regression. The hang is a microtask-only loop: vitest's in-process timeout never
// fires, so the scenario runs in a child vitest process killed by a hard wall-clock guard.
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const VITEST_BIN = fileURLToPath(new URL("../../../node_modules/vitest/vitest.mjs", import.meta.url));
const WALL_CLOCK_MS = 20_000;

function runScenario(): Promise<{ code: number | null; timedOut: boolean; elapsedMs: number; output: string }> {
	return new Promise((resolve) => {
		const started = Date.now();
		const child = spawn(
			process.execPath,
			[VITEST_BIN, "run", "--pool=forks", "test/scenarios/oversized-output-hang.scenario.test.ts"],
			{ cwd: PACKAGE_ROOT, env: { ...process.env, SPEC061_SCENARIO: "1" }, detached: true },
		);
		let output = "";
		child.stdout.on("data", (chunk) => {
			output += chunk;
		});
		child.stderr.on("data", (chunk) => {
			output += chunk;
		});
		let timedOut = false;
		const guard = setTimeout(() => {
			timedOut = true;
			// Kill the whole group: the vitest fork that spins is a grandchild.
			if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
		}, WALL_CLOCK_MS);
		child.on("close", (code) => {
			clearTimeout(guard);
			resolve({ code, timedOut, elapsedMs: Date.now() - started, output: output.slice(-4000) });
		});
	});
}

describe("spec 061: single tool output larger than the context window", () => {
	it(
		"settles within the wall-clock guard with bounded overflow recovery",
		async () => {
			const result = await runScenario();
			expect({ timedOut: result.timedOut, code: result.code }, result.output).toEqual({ timedOut: false, code: 0 });
		},
		WALL_CLOCK_MS + 15_000,
	);
});
