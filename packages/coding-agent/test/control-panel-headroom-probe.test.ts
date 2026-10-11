import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getHeadroomRuntimeStatus } from "../src/core/context-budget-headroom.ts";

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;
type ExecFileOptions = { readonly timeout: number; readonly signal: AbortSignal };

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

/**
 * A command that never answers on its own, like a hung `headroom`: it ends only the way Node's execFile
 * ends it, by the `timeout` option or by the abort `signal`, with Node's error shape for each.
 */
function hangProbes(): void {
	childProcess.execFile.mockImplementation(
		(command: string, _args: readonly string[], options: ExecFileOptions, callback: ExecFileCallback) => {
			const timer = setTimeout(() => {
				callback(Object.assign(new Error(`${command} timed out`), { killed: true, signal: "SIGTERM" }), "", "");
			}, options.timeout);
			options.signal.addEventListener("abort", () => {
				clearTimeout(timer);
				callback(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }), "", "");
			});
		},
	);
}

/** Let the probe's promise chain run to its next spawn or settle (a few awaits per probe). */
async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

/**
 * The module caches the probe for the process lifetime, so every case loads a fresh copy. Under VITEST the
 * probe is off by default; these cases opt in because `node:child_process` is mocked here.
 */
async function loadModule() {
	vi.resetModules();
	const module = await import("../src/modes/interactive/components/control-panel-runtime-status.ts");
	module.setHeadroomVersionProbeEnabledForTests(true);
	return module;
}

const policyLabel = getHeadroomRuntimeStatus().policyId;

describe("headroom version probe off the render path (spec 046)", () => {
	beforeEach(() => {
		childProcess.spawnSync.mockClear();
		childProcess.execFile.mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
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
				signal: expect.any(AbortSignal),
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

	it("repaints exactly once when a version turns up", async () => {
		answerProbes((command, args) => (command === "headroom" && args[0] === "--version" ? "3.0.1\n" : null));
		const { repaintWhenHeadroomVersionResolves } = await loadModule();
		const requestRender = vi.fn();

		await repaintWhenHeadroomVersionResolves(requestRender);
		await flushMicrotasks();

		expect(requestRender).toHaveBeenCalledTimes(1);
	});

	it("does not repaint when no headroom is found", async () => {
		answerProbes(() => null);
		const { repaintWhenHeadroomVersionResolves } = await loadModule();
		const requestRender = vi.fn();

		await repaintWhenHeadroomVersionResolves(requestRender);

		expect(requestRender).not.toHaveBeenCalled();
	});

	it("bounds a hung headroom by the 750 ms timeout per probe and then falls back", async () => {
		vi.useFakeTimers();
		hangProbes();
		const { formatHeadroomStatusLabel, loadHeadroomVersion } = await loadModule();
		const settled = vi.fn();
		void loadHeadroomVersion().then(settled);

		await vi.advanceTimersByTimeAsync(749);
		expect(childProcess.execFile).toHaveBeenCalledTimes(1);
		expect(settled).not.toHaveBeenCalled();
		expect(formatHeadroomStatusLabel()).toBe(policyLabel);

		await vi.advanceTimersByTimeAsync(1);
		await flushMicrotasks();
		expect(childProcess.execFile).toHaveBeenCalledTimes(2);

		for (let probe = 3; probe <= 4; probe++) {
			await vi.advanceTimersByTimeAsync(750);
			await flushMicrotasks();
			expect(childProcess.execFile).toHaveBeenCalledTimes(probe);
		}
		await vi.advanceTimersByTimeAsync(750);
		await flushMicrotasks();
		expect(childProcess.execFile).toHaveBeenCalledTimes(4);
		expect(settled).toHaveBeenCalledWith(null);
		expect(formatHeadroomStatusLabel()).toBe(policyLabel);
	});

	it("abort kills the running probe, settles to null and starts no further probe", async () => {
		vi.useFakeTimers();
		hangProbes();
		const { abortHeadroomVersionProbe, formatHeadroomStatusLabel, loadHeadroomVersion } = await loadModule();
		const settled = vi.fn();
		void loadHeadroomVersion().then(settled);
		const [, , options] = childProcess.execFile.mock.calls[0] as [string, string[], ExecFileOptions];

		abortHeadroomVersionProbe();
		await flushMicrotasks();

		expect(options.signal.aborted).toBe(true);
		expect(settled).toHaveBeenCalledWith(null);
		await vi.advanceTimersByTimeAsync(10 * 750);
		expect(childProcess.execFile).toHaveBeenCalledTimes(1);
		expect(formatHeadroomStatusLabel()).toBe(policyLabel);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("never spawns under the test runner unless a test opts in", async () => {
		answerProbes(() => "3.0.1\n");
		const { formatHeadroomStatusLabel, loadHeadroomVersion, setHeadroomVersionProbeEnabledForTests } =
			await loadModule();
		setHeadroomVersionProbeEnabledForTests(undefined);

		await expect(loadHeadroomVersion()).resolves.toBeNull();
		expect(formatHeadroomStatusLabel()).toBe(policyLabel);
		expect(childProcess.execFile).not.toHaveBeenCalled();
	});
});
