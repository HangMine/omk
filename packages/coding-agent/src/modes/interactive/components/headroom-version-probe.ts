import { execFile } from "node:child_process";

/**
 * Off-render-path probe for the installed headroom version (spec 046). It has no imports beyond
 * `node:child_process`, so the test setup can swap the spawn function without loading the control panel.
 */

const VERSION_COMMAND_TIMEOUT_MS = 750;
const HEADROOM_PYTHON_DISTRIBUTIONS = ["headroom", "headroom-ai"] as const;

export interface HeadroomProbeSpawnOptions {
	readonly timeout: number;
	readonly signal: AbortSignal;
	readonly env: NodeJS.ProcessEnv;
}

/** Runs one probe command; resolves its stdout and stderr, or `null` when it failed, timed out or was aborted. */
export type HeadroomProbeSpawn = (
	command: string,
	args: readonly string[],
	options: HeadroomProbeSpawnOptions,
) => Promise<string | null>;

const execFileProbeSpawn: HeadroomProbeSpawn = (command, args, options) =>
	new Promise((resolve) => {
		try {
			execFile(
				command,
				[...args],
				{
					encoding: "utf8",
					timeout: options.timeout,
					shell: false,
					windowsHide: true,
					env: options.env,
					signal: options.signal,
				},
				(error, stdout, stderr) => {
					resolve(error ? null : `${stdout}\n${stderr}`);
				},
			);
		} catch {
			resolve(null);
		}
	});

let headroomProbeSpawn: HeadroomProbeSpawn = execFileProbeSpawn;
let cachedHeadroomVersion: string | null | undefined;
let headroomVersionProbe: Promise<string | null> | undefined;
let headroomVersionProbeAbort: AbortController | undefined;

/** The probe result once settled; `undefined` while it has not run or is still running. */
export function getCachedHeadroomVersion(): string | null | undefined {
	return cachedHeadroomVersion;
}

/** Probe the installed headroom version once per process, off the render path; callers share the result. */
export function loadHeadroomVersion(): Promise<string | null> {
	if (headroomVersionProbe) return headroomVersionProbe;
	const abort = new AbortController();
	headroomVersionProbeAbort = abort;
	const probe = probeInstalledHeadroomVersion(abort.signal).then((version) => {
		// A probe replaced by setHeadroomProbeSpawnForTesting() must not write into the new cache.
		if (headroomVersionProbe === probe) cachedHeadroomVersion = version;
		if (headroomVersionProbeAbort === abort) headroomVersionProbeAbort = undefined;
		return version;
	});
	headroomVersionProbe = probe;
	return probe;
}

/** Repaint exactly once if the probe finds a version; a missing or aborted headroom needs no repaint. */
export function repaintWhenHeadroomVersionResolves(requestRender: () => void): Promise<void> {
	return loadHeadroomVersion().then((version) => {
		if (version) requestRender();
	});
}

/**
 * Kill a probe that is still running (shutdown). The pending probe settles to `null` and is cached,
 * so a hung `headroom` cannot hold shutdown or outlive the process, and nothing restarts it.
 */
export function abortHeadroomVersionProbe(): void {
	headroomVersionProbeAbort?.abort();
	headroomVersionProbeAbort = undefined;
}

/**
 * Tests only: replace the spawn function (`undefined` restores the real `execFile` one). Aborts a running
 * probe and clears the cached result, so the next probe uses the new function.
 */
export function setHeadroomProbeSpawnForTesting(spawn: HeadroomProbeSpawn | undefined): void {
	abortHeadroomVersionProbe();
	headroomProbeSpawn = spawn ?? execFileProbeSpawn;
	cachedHeadroomVersion = undefined;
	headroomVersionProbe = undefined;
}

export function parseHeadroomVersionOutput(output: string): string | null {
	const match = /\bv?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)\b/.exec(output);
	return match?.[1] ?? null;
}

async function probeInstalledHeadroomVersion(signal: AbortSignal): Promise<string | null> {
	const version =
		(await readVersionFromCommand("headroom", ["--version"], signal)) ??
		(await readVersionFromCommand("headroom", ["version"], signal));
	if (version) return version;
	for (const distribution of HEADROOM_PYTHON_DISTRIBUTIONS) {
		const pythonVersion = await readVersionFromCommand(
			"python3",
			["-c", `import importlib.metadata as m; print(m.version('${distribution}'))`],
			signal,
		);
		if (pythonVersion) return pythonVersion;
	}
	return null;
}

async function readVersionFromCommand(
	command: string,
	args: readonly string[],
	signal: AbortSignal,
): Promise<string | null> {
	// After an abort, start nothing new: the remaining fallbacks resolve to null without spawning.
	if (signal.aborted) return null;
	let output: string | null;
	try {
		output = await headroomProbeSpawn(command, args, {
			timeout: VERSION_COMMAND_TIMEOUT_MS,
			signal,
			env: { PATH: process.env.PATH ?? "" },
		});
	} catch {
		return null;
	}
	return output === null || signal.aborted ? null : parseHeadroomVersionOutput(output);
}
