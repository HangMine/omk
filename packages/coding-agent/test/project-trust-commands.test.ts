/**
 * Spec 053 R10 and PR #124 review (B1, M1, n2): `omk update|list|config` and `omk package doctor`
 * apply the project trust gate without asking. In an untrusted project they neither install the
 * project's `packages` nor run its `npmCommand`, and they say so on stderr. Each case has a
 * trusted control (`OMK_TRUST_PROJECT=1` captured at startup) so a pass is not vacuous.
 */
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPackageDoctorCli } from "../src/commands/package-doctor-cli.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { ALLOW_SCRIPTS_FLAG } from "../src/core/package-install-args.ts";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { captureStartupProjectTrust, TRUST_PROJECT_ENV } from "../src/core/project-trust.ts";
import { handleConfigCommand, handlePackageCommand } from "../src/package-manager-cli.ts";

const selectConfig = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../src/cli/config-selector.ts", () => ({ selectConfig }));

type RunCommand = (command: string, args: string[], options?: { cwd?: string }) => Promise<void>;
type RunCommandCapture = (command: string, args: string[], options?: unknown) => Promise<string>;

const SAVED_ENV = ["HOME", ENV_AGENT_DIR, "OMK_OFFLINE", TRUST_PROJECT_ENV] as const;

let root: string;
let project: string;
let savedEnv: Record<string, string | undefined>;
let originalCwd: string;
let originalExitCode: typeof process.exitCode;
let stderr: string[];
let commands: Array<{ command: string; args: string[] }>;

function trustAtStartup(): void {
	captureStartupProjectTrust(project, { [TRUST_PROJECT_ENV]: "1" });
}

beforeEach(() => {
	root = join(realpathSync(tmpdir()), `omk-trust-commands-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	project = join(root, "cloned-repo");
	mkdirSync(join(root, "home", ".omk", "agent"), { recursive: true });
	mkdirSync(join(project, ".omk"), { recursive: true });
	writeFileSync(
		join(project, ".omk", "settings.json"),
		JSON.stringify({ packages: ["npm:evil-pkg"], npmCommand: ["evil-npm"] }),
	);
	savedEnv = Object.fromEntries(SAVED_ENV.map((name) => [name, process.env[name]]));
	process.env.HOME = join(root, "home");
	process.env[ENV_AGENT_DIR] = join(root, "home", ".omk", "agent");
	delete process.env.OMK_OFFLINE;
	delete process.env[TRUST_PROJECT_ENV];
	captureStartupProjectTrust(project, {}); // no startup trust unless a test asks for it
	originalCwd = process.cwd();
	originalExitCode = process.exitCode;
	process.chdir(project);
	stderr = [];
	commands = [];
	vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
		stderr.push(String(chunk));
		return true;
	}) as typeof process.stderr.write);
	vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
		stderr.push(args.map(String).join(" "));
	});
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(DefaultPackageManager.prototype as unknown as { runCommand: RunCommand }, "runCommand").mockImplementation(
		async (command, args) => {
			commands.push({ command, args });
		},
	);
});

afterEach(() => {
	vi.restoreAllMocks();
	selectConfig.mockClear();
	captureStartupProjectTrust(project, {});
	process.chdir(originalCwd);
	process.exitCode = originalExitCode;
	for (const name of SAVED_ENV) {
		if (savedEnv[name] === undefined) delete process.env[name];
		else process.env[name] = savedEnv[name];
	}
	rmSync(root, { recursive: true, force: true });
});

describe("omk update in an untrusted project (B1)", () => {
	it("update --extensions --allow-scripts runs no command and warns on stderr", async () => {
		expect(await handlePackageCommand(["update", "--extensions", ALLOW_SCRIPTS_FLAG])).toBe(true);
		expect(commands).toHaveLength(0);
		expect(stderr.join("")).toContain(`Project code not loaded from ${project}`);
	});

	it("control: with OMK_TRUST_PROJECT=1 at startup it updates the project package with its npmCommand", async () => {
		trustAtStartup();
		expect(await handlePackageCommand(["update", "--extensions", ALLOW_SCRIPTS_FLAG])).toBe(true);
		expect(commands).toHaveLength(1);
		expect(commands[0]?.command).toBe("evil-npm");
		expect(commands[0]?.args).toContain("evil-pkg@latest");
		expect(commands[0]?.args).not.toContain("--ignore-scripts");
	});

	it("names --allow-scripts only for failures that look like a skipped install script", async () => {
		const update = vi.spyOn(DefaultPackageManager.prototype, "update");
		update.mockRejectedValueOnce(new Error("npm ERR! 404 Not Found"));
		await handlePackageCommand(["update", "--extensions"]);
		expect(stderr.join("\n")).not.toContain(ALLOW_SCRIPTS_FLAG);

		update.mockRejectedValueOnce(new Error("Error: Could not locate the bindings file"));
		await handlePackageCommand(["update", "--extensions"]);
		expect(stderr.join("\n")).toContain(`omk update ${ALLOW_SCRIPTS_FLAG}`);
	});
});

describe("omk list and omk config in an untrusted project (R10, n2)", () => {
	it("list prints the gate warning on stderr and still lists the configured project package", async () => {
		const logged: string[] = [];
		vi.mocked(console.log).mockImplementation((...args: unknown[]) => {
			logged.push(args.map(String).join(" "));
		});
		expect(await handlePackageCommand(["list"])).toBe(true);
		expect(stderr.join("")).toContain(`Project code not loaded from ${project}`);
		expect(logged.join("\n")).toContain("npm:evil-pkg");
		expect(commands).toHaveLength(0);
	});

	it("config resolves without installing project packages and warns on stderr", async () => {
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw new Error(`exit ${code}`);
		}) as never);
		await expect(handleConfigCommand(["config"])).rejects.toThrow("exit 0");
		expect(selectConfig).toHaveBeenCalledTimes(1);
		expect(commands).toHaveLength(0);
		expect(stderr.join("")).toContain(`Project code not loaded from ${project}`);
	});

	it("control: config with OMK_TRUST_PROJECT=1 at startup installs the missing project package, scripts off", async () => {
		trustAtStartup();
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw new Error(`exit ${code}`);
		}) as never);
		await expect(handleConfigCommand(["config"])).rejects.toThrow("exit 0");
		expect(commands.map((call) => call.command)).toContain("evil-npm");
		expect(commands.find((call) => call.command === "evil-npm")?.args).toContain("--ignore-scripts");
	});
});

describe("omk package doctor in an untrusted project (M1)", () => {
	async function packCommand(): Promise<string | undefined> {
		let packed: string | undefined;
		vi.spyOn(
			DefaultPackageManager.prototype as unknown as { runCommandCapture: RunCommandCapture },
			"runCommandCapture",
		).mockImplementation(async (command, args) => {
			if (args.includes("pack")) packed = command;
			throw new Error("stop after npm pack");
		});
		const lines: string[] = [];
		const outcome = await runPackageDoctorCli(["package", "doctor", "npm:some-pkg"], {
			cwd: project,
			agentDir: join(root, "home", ".omk", "agent"),
			writeLine: (line) => lines.push(line),
		});
		expect(outcome).toEqual({ handled: true, exitCode: 1 });
		// stdout stays JSON; the gate warning went to stderr.
		expect(() => JSON.parse(lines.join("\n"))).not.toThrow();
		return packed;
	}

	it("runs npm pack with plain npm, not the project's npmCommand, and warns on stderr", async () => {
		expect(await packCommand()).toBe("npm");
		expect(stderr.join("")).toContain(`Project code not loaded from ${project}`);
	});

	it("control: with OMK_TRUST_PROJECT=1 at startup it uses the project's npmCommand", async () => {
		trustAtStartup();
		expect(await packCommand()).toBe("evil-npm");
	});
});
