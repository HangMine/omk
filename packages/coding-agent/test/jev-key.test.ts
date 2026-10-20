import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TUI } from "omk-tui";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import {
	clearJevKey,
	formatJevClear,
	getJevKeySource,
	isJevEnabled,
	JEV_COMMAND_KEY_ERROR,
	JEV_EMPTY_KEY_ERROR,
	JEV_PROVIDER_ID,
	parseJevCommand,
	setJevKey,
} from "../src/core/jev-key.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { LoginDialogComponent } from "../src/modes/interactive/components/login-dialog.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

initTheme("dark");

// Fake key only. Tests never read the real TYPESAFE_API_KEY: it is stubbed before every test.
const KEY = "TEST_SECRET_KEY_123";
const ENV_KEY = "TEST_SECRET_KEY_123_ENV";

/** Any 3+ char run of the key counts as a leak (fixed label text contains none). */
function leaks(text: string, secret = KEY): boolean {
	for (let i = 0; i + 3 <= secret.length; i++) {
		if (text.includes(secret.slice(i, i + 3))) return true;
	}
	return false;
}

function filesUnder(dir: string): string[] {
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((d) => d.isFile())
		.map((d) => join(d.parentPath, d.name));
}

describe("/jev TypeSafe key (093 PR2)", () => {
	let dir: string;
	let authPath: string;
	let auth: AuthStorage;
	let fetchSpy: ReturnType<typeof vi.fn>;
	const logged: string[] = [];

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "omk-jev-"));
		authPath = join(dir, "agent", "auth.json");
		vi.stubEnv("HOME", dir);
		vi.stubEnv("OMK_CODING_AGENT_DIR", join(dir, "agent"));
		vi.stubEnv("TYPESAFE_API_KEY", "");
		fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		logged.length = 0;
		for (const m of ["log", "info", "warn", "error", "debug"] as const) {
			vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
				logged.push(args.map(String).join(" "));
			});
		}
		auth = AuthStorage.create(authPath);
	});

	afterEach(() => {
		// Test 10: no /jev path makes a network call.
		expect(fetchSpy).toHaveBeenCalledTimes(0);
		// Test 3: nothing logged contains the key.
		expect(leaks(logged.join("\n"))).toBe(false);
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		rmSync(dir, { recursive: true, force: true });
	});

	test("registered as builtin, parses subcommands, OMK_JEV default off", () => {
		expect(BUILTIN_SLASH_COMMANDS.some((c) => c.name === "jev")).toBe(true);
		expect(parseJevCommand("/jev")).toBe("usage");
		expect(parseJevCommand("/jev set")).toBe("set");
		expect(parseJevCommand("/jev status")).toBe("status");
		expect(parseJevCommand("/jev clear")).toBe("clear");
		expect(parseJevCommand("/jev bogus")).toBe("unknown");
		expect(parseJevCommand("/jevx")).toBeUndefined();
		vi.stubEnv("OMK_JEV", "");
		expect(isJevEnabled()).toBe(false);
		vi.stubEnv("OMK_JEV", "1");
		expect(isJevEnabled()).toBe(true);
	});

	test("3: key absent from status/errors and from every written file except auth.json", async () => {
		const tui = { requestRender: () => {} } as unknown as TUI;
		const dialog = new LoginDialogComponent(tui, JEV_PROVIDER_ID, () => {}, "TypeSafe", "Set TypeSafe (Jev) key");
		const pending = dialog.showPrompt("Enter TypeSafe key:");
		for (const ch of KEY) dialog.handleInput(ch);
		dialog.handleInput("\r");
		const value = await pending;
		expect(value).toBe(KEY);
		expect(setJevKey(auth, value)).toEqual({ ok: true });
		expect(leaks(getJevKeySource(auth))).toBe(false);
		expect(leaks(formatJevClear(clearJevKey(auth)))).toBe(false);
		expect(leaks(JSON.stringify(setJevKey(auth, "   ")))).toBe(false);
		// Every file written except auth.json (session JSONL, run log, history) has zero matches.
		for (const f of filesUnder(dir).filter((f) => f !== authPath)) {
			expect(leaks(readFileSync(f, "utf8")), f).toBe(false);
		}
	});

	test("4: status output is exactly stored, env or none", () => {
		expect(getJevKeySource(auth)).toBe("none");
		vi.stubEnv("TYPESAFE_API_KEY", ENV_KEY);
		expect(getJevKeySource(auth)).toBe("env");
		setJevKey(auth, KEY);
		expect(getJevKeySource(auth)).toBe("stored");
	});

	test("5: key never in input/autocomplete history or any other written file", () => {
		setJevKey(auth, KEY);
		const others = filesUnder(dir).filter((f) => f !== authPath);
		for (const f of others) expect(readFileSync(f, "utf8").includes(KEY), f).toBe(false);
		expect(readFileSync(authPath, "utf8").includes(KEY)).toBe(true);
	});

	test.skipIf(process.platform === "win32")("6: auth.json is 0600 and its dir 0700 after set", () => {
		setJevKey(auth, KEY);
		expect(statSync(authPath).mode & 0o777).toBe(0o600);
		expect(statSync(join(dir, "agent")).mode & 0o777).toBe(0o700);
	});

	test("7: stored key wins over env; env used when nothing stored", async () => {
		vi.stubEnv("TYPESAFE_API_KEY", ENV_KEY);
		setJevKey(auth, KEY);
		expect(await auth.getApiKey(JEV_PROVIDER_ID)).toBe(KEY);
		expect(getJevKeySource(auth)).toBe("stored");
		auth.remove(JEV_PROVIDER_ID);
		expect(await auth.getApiKey(JEV_PROVIDER_ID)).toBe(ENV_KEY);
		expect(getJevKeySource(auth)).toBe("env");
	});

	test("8: clear removes stored key; status none, or env if env set", () => {
		setJevKey(auth, KEY);
		expect(clearJevKey(auth)).toEqual({ removed: true, envStillSet: false });
		expect(getJevKeySource(auth)).toBe("none");
		expect(AuthStorage.create(authPath).has(JEV_PROVIDER_ID)).toBe(false);
		setJevKey(auth, KEY);
		vi.stubEnv("TYPESAFE_API_KEY", ENV_KEY);
		const result = clearJevKey(auth);
		expect(result).toEqual({ removed: true, envStillSet: true });
		expect(formatJevClear(result)).toContain("still set");
		expect(getJevKeySource(auth)).toBe("env");
	});

	test("9: empty or whitespace input rejected, nothing written", () => {
		expect(setJevKey(auth, "")).toEqual({ ok: false, error: JEV_EMPTY_KEY_ERROR });
		expect(setJevKey(auth, "  \t ")).toEqual({ ok: false, error: JEV_EMPTY_KEY_ERROR });
		expect(auth.has(JEV_PROVIDER_ID)).toBe(false);
		expect(getJevKeySource(auth)).toBe("none");
	});

	test("set rejects a '!' key (would run as shell command), writes nothing, never executes", async () => {
		const marker = join(dir, "executed");
		for (const raw of [`!${KEY}`, `  !${KEY}  `, `!touch ${marker}`]) {
			const result = setJevKey(auth, raw);
			expect(result).toEqual({ ok: false, error: JEV_COMMAND_KEY_ERROR });
			expect(leaks(JSON.stringify(result))).toBe(false);
		}
		expect(auth.has(JEV_PROVIDER_ID)).toBe(false);
		expect(existsSync(authPath) ? readFileSync(authPath, "utf8").includes(KEY) : false).toBe(false);
		expect(await auth.getApiKey(JEV_PROVIDER_ID)).toBeUndefined();
		expect(existsSync(marker)).toBe(false);
	});

	test("10: set/status/clear make zero fetch calls", async () => {
		setJevKey(auth, KEY);
		getJevKeySource(auth);
		clearJevKey(auth);
		await auth.getApiKey(JEV_PROVIDER_ID);
		expect(fetchSpy).toHaveBeenCalledTimes(0);
	});
});
