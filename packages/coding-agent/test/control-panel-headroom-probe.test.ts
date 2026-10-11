import { beforeEach, describe, expect, it, vi } from "vitest";
import { getHeadroomRuntimeStatus } from "../src/core/context-budget-headroom.ts";

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

const childProcess = vi.hoisted(() => ({
	spawnSync: vi.fn(() => ({ status: 1, stdout: "", stderr: "" })),
	execFile: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	spawnSync: childProcess.spawnSync,
	execFile: childProcess.execFile,
}));

/** Answer each probe by its argv; `null` means the command failed. */
function answerProbes(answer: (command: string, args: readonly string[]) => string | null): void {
	childProcess.execFile.mockImplementation(
		(command: string, args: readonly string[], _options: unknown, callback: ExecFileCallback) => {
			const stdout = answer(command, args);
			queueMicrotask(() =>
				stdout === null ? callback(new Error(`${command} failed`), "", "") : callback(null, stdout, ""),
			);
		},
	);
}

/** The module caches the probe for the process lifetime, so every case loads a fresh copy. */
async function loadModule() {
	vi.resetModules();
	return import("../src/modes/interactive/components/control-panel-runtime-status.ts");
}

const policyLabel = getHeadroomRuntimeStatus().policyId;

describe("headroom version probe off the render path (spec 046)", () => {
	beforeEach(() => {
		childProcess.spawnSync.mockClear();
		childProcess.execFile.mockReset();
	});

	it("never spawns synchronously from the render-path label and starts one probe at most", async () => {
		const pending: ExecFileCallback[] = [];
		childProcess.execFile.mockImplementation(
			(_command: string, _args: readonly string[], _options: unknown, callback: ExecFileCallback) => {
				pending.push(callback);
			},
		);
		const { formatHeadroomStatusLabel } = await loadModule();

		expect(formatHeadroomStatusLabel()).toBe(policyLabel);
		expect(formatHeadroomStatusLabel()).toBe(policyLabel);
		expect(formatHeadroomStatusLabel()).toBe(policyLabel);

		expect(childProcess.spawnSync).not.toHaveBeenCalled();
		expect(childProcess.execFile).toHaveBeenCalledTimes(1);
	});

	it("shows the version once `headroom --version` answers, without trying the other probes", async () => {
		answerProbes((command, args) =>
			command === "headroom" && args[0] === "--version" ? "headroom version 3.0.1\n" : null,
		);
		const { formatHeadroomStatusLabel, loadHeadroomVersion } = await loadModule();

		await expect(loadHeadroomVersion()).resolves.toBe("3.0.1");
		expect(formatHeadroomStatusLabel()).toBe("headroom:3.0.1");
		expect(childProcess.execFile).toHaveBeenCalledTimes(1);
		expect(childProcess.spawnSync).not.toHaveBeenCalled();
	});

	it("falls back through the same probes, args, env and timeout as before", async () => {
		answerProbes((command, args) =>
			command === "python3" && String(args[1]).includes("'headroom-ai'") ? "0.22.4\n" : null,
		);
		const { formatHeadroomStatusLabel, loadHeadroomVersion } = await loadModule();

		await expect(loadHeadroomVersion()).resolves.toBe("0.22.4");
		expect(formatHeadroomStatusLabel()).toBe("headroom:0.22.4");
		const calls = childProcess.execFile.mock.calls.map(([command, args]) => [command, ...(args as string[])]);
		expect(calls).toEqual([
			["headroom", "--version"],
			["headroom", "version"],
			["python3", "-c", "import importlib.metadata as m; print(m.version('headroom'))"],
			["python3", "-c", "import importlib.metadata as m; print(m.version('headroom-ai'))"],
		]);
		for (const [, , options] of childProcess.execFile.mock.calls) {
			expect(options).toMatchObject({
				encoding: "utf8",
				timeout: 750,
				shell: false,
				windowsHide: true,
				env: { PATH: process.env.PATH ?? "" },
			});
		}
	});

	it("caches a failed probe: the label stays the policy id and nothing runs again", async () => {
		answerProbes(() => null);
		const { formatHeadroomStatusLabel, loadHeadroomVersion } = await loadModule();

		await expect(loadHeadroomVersion()).resolves.toBeNull();
		expect(childProcess.execFile).toHaveBeenCalledTimes(4);
		expect(formatHeadroomStatusLabel()).toBe(policyLabel);
		await expect(loadHeadroomVersion()).resolves.toBeNull();
		expect(childProcess.execFile).toHaveBeenCalledTimes(4);
		expect(childProcess.spawnSync).not.toHaveBeenCalled();
	});
});
