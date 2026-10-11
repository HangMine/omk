import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	formatHeadroomStatusLabel,
	loadHeadroomVersion,
	setHeadroomVersionProbeEnabledForTests,
} from "../src/modes/interactive/components/control-panel-runtime-status.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

/** Only the fields `stop()` touches, for an InteractiveMode that never ran `init()`. */
function stoppableFakeThis() {
	return {
		unregisterSignalHandlers: () => {},
		settingsManager: { getShowTerminalProgress: () => false },
		loadingAnimation: undefined,
		clearExtensionTerminalInputListeners: () => {},
		chatContainer: undefined,
		builtInHeader: undefined,
		customHeader: undefined,
		footer: { dispose: () => {} },
		footerDataProvider: { dispose: () => {} },
		unsubscribeThemedOutputStale: undefined,
		unsubscribe: undefined,
		isInitialized: false,
	};
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForFile(path: string, timeoutMs: number): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(path)) {
			const content = readFileSync(path, "utf8").trim();
			if (content) return content;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`${path} was not written within ${timeoutMs} ms`);
}

describe.skipIf(process.platform === "win32")("InteractiveMode.stop() and a hung headroom probe (spec 046)", () => {
	const originalPath = process.env.PATH;
	let dir: string | undefined;

	afterEach(() => {
		process.env.PATH = originalPath;
		setHeadroomVersionProbeEnabledForTests(undefined);
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	it("kills the running `headroom` child and settles the probe well before its 750 ms timeout", async () => {
		dir = mkdtempSync(join(tmpdir(), "omk-headroom-hang-"));
		const pidFile = join(dir, "headroom.pid");
		// A `headroom` that never answers: it records its pid, then becomes `sleep` under the same pid.
		writeFileSync(join(dir, "headroom"), `#!/bin/sh\necho $$ > '${pidFile}'\nexec /bin/sleep 30\n`);
		chmodSync(join(dir, "headroom"), 0o755);
		process.env.PATH = dir;
		setHeadroomVersionProbeEnabledForTests(true);

		const probe = loadHeadroomVersion();
		const pid = Number(await waitForFile(pidFile, 2_000));
		expect(isAlive(pid)).toBe(true);

		const stoppedAt = Date.now();
		(InteractiveMode.prototype.stop as (this: unknown) => void).call(stoppableFakeThis());

		await expect(probe).resolves.toBeNull();
		expect(Date.now() - stoppedAt).toBeLessThan(500);
		expect(isAlive(pid)).toBe(false);
		expect(formatHeadroomStatusLabel()).not.toMatch(/^headroom:/);
	});
});
