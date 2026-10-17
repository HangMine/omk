import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function launch(inside: boolean, executable: "tmux" | "omk" | undefined, ...args: string[]) {
	const directory = mkdtempSync(join(tmpdir(), "omk-tmux-launcher-"));
	directories.push(directory);
	if (executable)
		writeFileSync(join(directory, executable), `#!/bin/bash\nprintf '${executable}\\0'\nprintf '%s\\0' "$@"\n`, {
			mode: 0o700,
		});
	return spawnSync("/bin/bash", [resolve("../../../scripts/omk-tmux.sh"), ...args], {
		encoding: "utf8",
		env: { ...process.env, PATH: directory, TMUX: inside ? "owned-test-socket,1,0" : "" },
	});
}

describe("explicit tmux launcher", () => {
	it("preserves arguments as data when creating a new tmux session", () => {
		const args = ["--resume", "session with spaces", "$(printf injection); echo ignored"];
		const result = launch(false, "tmux", ...args);
		expect(result.status).toBe(0);
		expect(result.stdout.split("\0").slice(0, -1)).toEqual([
			"tmux",
			"new-session",
			"-c",
			process.cwd(),
			"-e",
			"OMK_PIN_STATUS_SIDEBAR=0",
			"--",
			"omk",
			...args,
		]);
	});

	it("does not nest tmux when already inside a pane", () => {
		const result = launch(true, "omk", "--resume", "session-id");
		expect(result.status).toBe(0);
		expect(result.stdout.split("\0").slice(0, -1)).toEqual(["omk", "--resume", "session-id"]);
	});

	it("reports missing tmux rather than silently changing launch mode", () => {
		const result = launch(false, undefined);
		expect(result.status).toBe(127);
		expect(result.stderr).toContain("tmux is required");
	});
});
