import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repo = fileURLToPath(new URL("../../../", import.meta.url));

function runRpc(input: string) {
	const home = mkdtempSync(join(tmpdir(), "omk-rpc-input-"));
	try {
		return spawnSync(
			process.execPath,
			[
				"--import",
				"tsx",
				"packages/coding-agent/src/cli.ts",
				"--mode",
				"rpc",
				"--no-session",
				"--no-extensions",
				"--no-context-files",
			],
			{
				cwd: repo,
				env: { PATH: process.env.PATH, HOME: home, OMK_OFFLINE: "1", OMK_SKIP_VERSION_CHECK: "1", NO_COLOR: "1" },
				input,
				encoding: "utf8",
				timeout: 20000,
				maxBuffer: 1048576,
			},
		);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

function responses(stdout: string): Record<string, unknown>[] {
	return stdout
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

const after = JSON.stringify({ id: "after-1", type: "get_state" });

describe("RPC public CLI input boundary", () => {
	it("reports invalid envelopes and continues without a process crash", () => {
		const result = runRpc(`null\n[]\n1\ntrue\n"get_state"\n{}\n${after}\n`);
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		const records = responses(result.stdout);
		expect(records.filter((record) => record.command === "parse" && record.success === false)).toHaveLength(6);
		expect(records).toContainEqual(expect.objectContaining({ id: "after-1", command: "get_state", success: true }));
	});

	it("returns a correlated error for an unknown command", () => {
		const result = runRpc(`{"id":"unknown-1","type":"unsupported"}\n${after}\n`);
		expect(result.status, result.stderr).toBe(0);
		expect(responses(result.stdout)).toContainEqual({
			id: "unknown-1",
			type: "response",
			command: "unsupported",
			success: false,
			error: "Unknown command: unsupported",
		});
	});

	it("does not change settings or invoke handlers for invalid command fields", () => {
		const result = runRpc(`{"id":"bad-setting","type":"set_auto_compaction","enabled":"false"}\n${after}\n`);
		expect(result.status, result.stderr).toBe(0);
		const records = responses(result.stdout);
		expect(records).toContainEqual(
			expect.objectContaining({ id: "bad-setting", command: "set_auto_compaction", success: false }),
		);
		expect(records).toContainEqual(
			expect.objectContaining({ id: "after-1", data: expect.objectContaining({ autoCompactionEnabled: true }) }),
		);
	});

	it("returns fixed parse diagnostics without private input text", () => {
		const result = runRpc(`{"private":"DO_NOT_ECHO_SECRET"\n${after}\n`);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout + result.stderr).not.toContain("DO_NOT_ECHO_SECRET");
		expect(responses(result.stdout)).toContainEqual(expect.objectContaining({ command: "parse", success: false }));
	});
});
