import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeBashWithOperations } from "../../src/core/bash-executor.ts";
import type { BashOperations } from "../../src/core/tools/bash.ts";

// Regression (found while deflaking the spec 106 D1 test): executeBashWithOperations keeps only the last
// maxOutputBytes (100 KB) by dropping whole leading chunks. A single 120 KB line delivered as 78 KB + 42 KB kept
// only 42 KB; truncateTail then saw < 50 KB on one line and returned truncated: false with no fullOutputPath, so
// ~78 KB was silently lost. Dropping leading chunks must always report truncated: true and keep the spill file.
// Chunks are emitted synchronously from a fake BashOperations, so the split is deterministic (no pipe timing).

const HEAD = "a".repeat(78 * 1024);
const TAIL = `${"b".repeat(42 * 1024)}\n`;

function fakeOperations(chunks: string[], options?: { abortAfter?: AbortController }): BashOperations {
	return {
		exec: async (_command, _cwd, { onData }) => {
			for (const chunk of chunks) {
				onData(Buffer.from(chunk, "utf-8"));
			}
			if (options?.abortAfter) {
				options.abortAfter.abort();
				throw new Error("aborted");
			}
			return { exitCode: 0 };
		},
	};
}

async function readSpill(path: string): Promise<string> {
	await vi.waitFor(() => {
		expect(existsSync(path)).toBe(true);
		expect(readFileSync(path, "utf-8").length).toBe(HEAD.length + TAIL.length);
	});
	return readFileSync(path, "utf-8");
}

describe("bash executor tail-drop truncation", () => {
	const created: string[] = [];
	afterEach(async () => {
		for (const file of created.splice(0)) await rm(file, { force: true });
	});

	it("reports truncated: true and keeps the full spill file when leading chunks are dropped (78 KB + 42 KB single line)", async () => {
		const result = await executeBashWithOperations("one-long-line", process.cwd(), fakeOperations([HEAD, TAIL]));

		expect(result.truncated).toBe(true);
		expect(result.cancelled).toBe(false);
		expect(result.exitCode).toBe(0);
		expect(result.output).toBe(TAIL);
		expect(result.fullOutputPath).toBeDefined();
		const path = result.fullOutputPath as string;
		created.push(path);
		expect(await readSpill(path)).toBe(HEAD + TAIL);
	});

	it("reports truncated: true and keeps the spill file on the cancelled path too", async () => {
		const controller = new AbortController();
		const result = await executeBashWithOperations(
			"one-long-line",
			process.cwd(),
			fakeOperations([HEAD, TAIL], { abortAfter: controller }),
			{ signal: controller.signal },
		);

		expect(result.cancelled).toBe(true);
		expect(result.truncated).toBe(true);
		expect(result.fullOutputPath).toBeDefined();
		const path = result.fullOutputPath as string;
		created.push(path);
		expect(await readSpill(path)).toBe(HEAD + TAIL);
	});

	it("still reports truncated: false with no spill file when nothing was dropped", async () => {
		const result = await executeBashWithOperations("small", process.cwd(), fakeOperations(["hello\n", "world\n"]));

		expect(result.truncated).toBe(false);
		expect(result.output).toBe("hello\nworld\n");
		expect(result.fullOutputPath).toBeUndefined();
	});
});
