/**
 * Spec 053 R6b, PR #124 re-review: a worker outside the trusted project gets
 * `OMK_TRUST_PROJECT=1` only from a worktree registered by the project's own repository, the
 * project being that repository's top level. git runs async; only positive answers are cached.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyProjectTrustGate } from "../src/cli/project-trust-gate.ts";
import { captureStartupProjectTrust, TRUST_PROJECT_ENV, workerProjectTrustEnv } from "../src/core/project-trust.ts";
import { type GitRunner, gitInvocation, resetWorkerTrustGitCache, runGit } from "../src/core/project-trust-git.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

let root: string;
let home: string;
let project: string;
let agentDir: string;

const SETTINGS = JSON.stringify({ packages: ["npm:pkg"] });

beforeEach(() => {
	root = join(realpathSync(tmpdir()), `omk-worker-trust-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	home = join(root, "home");
	project = join(root, "cloned-repo");
	agentDir = join(home, ".omk", "agent");
	mkdirSync(home, { recursive: true });
	writeSettings(project);
	resetWorkerTrustGitCache();
});

afterEach(() => {
	captureStartupProjectTrust(root, {});
	resetWorkerTrustGitCache();
	rmSync(root, { recursive: true, force: true });
});

/** Same gated items as the trusted project, so only the path / git check decides. */
function writeSettings(dir: string): void {
	mkdirSync(join(dir, ".omk"), { recursive: true });
	writeFileSync(join(dir, ".omk", "settings.json"), SETTINGS);
}

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@local", "-c", "commit.gpgsign=false", ...args], {
		cwd,
		stdio: "ignore",
	});
}

function initProjectRepo(): void {
	git(project, "init", "-q");
	git(project, "add", "-A");
	git(project, "commit", "-qm", "fixture");
}

async function trustParent(): Promise<void> {
	await applyProjectTrustGate({
		cwd: project,
		settingsManager: SettingsManager.create(project, agentDir),
		mode: "headless",
		env: { [TRUST_PROJECT_ENV]: "1" },
		home,
		writeStderr: () => {},
		announced: new Set(),
	});
}

function countingGit(calls: string[][]): GitRunner {
	return (dir, args) => {
		calls.push([dir, ...args]);
		return runGit(dir, args);
	};
}

function trustFor(workerCwd: string, gitRunner?: GitRunner, signal?: AbortSignal): Promise<"1" | "0" | undefined> {
	return workerProjectTrustEnv({ parentCwd: project, workerCwd, env: {}, home, git: gitRunner, signal });
}

describe("workerProjectTrustEnv git checks (PR #124 re-review)", () => {
	it("a project nested in a larger repository does not vouch for a sibling in that repository", async () => {
		git(root, "init", "-q"); // e.g. a dotfiles repo at ~ or a monorepo; the project is not its top level
		const sibling = join(root, "sibling");
		writeSettings(sibling);
		await trustParent();
		expect(await trustFor(sibling)).toBeUndefined();
		// A subdirectory of the project still follows the parent, without git.
		const sub = join(project, "packages", "app");
		writeSettings(sub);
		const calls: string[][] = [];
		expect(await trustFor(sub, countingGit(calls))).toBe("1");
		expect(calls).toEqual([]);
	});

	it("a .git file pointing at the trusted repository's .git is not a registered worktree", async () => {
		initProjectRepo();
		const fake = join(root, "fake");
		writeSettings(fake);
		writeFileSync(join(fake, ".git"), `gitdir: ${join(project, ".git")}\n`);
		await trustParent();
		expect(await trustFor(fake)).toBeUndefined();
	});

	it("a repository whose core.worktree names the trusted project does not contain the worker cwd", async () => {
		initProjectRepo();
		const evil = join(root, "evil");
		writeSettings(evil);
		git(evil, "init", "-q");
		git(evil, "config", "core.worktree", project);
		await trustParent();
		expect(await trustFor(evil)).toBeUndefined();
	});

	it("a real git worktree gets 1, and a second spawn does not run git again", async () => {
		initProjectRepo();
		const worktree = join(root, "worktree");
		git(project, "worktree", "add", "-q", worktree);
		await trustParent();
		const calls: string[][] = [];
		const counting = countingGit(calls);
		expect(await trustFor(worktree, counting)).toBe("1");
		// parent top level, parent worktree list, worker top level
		expect(calls).toHaveLength(3);
		expect(await trustFor(worktree, counting)).toBe("1");
		expect(calls).toHaveLength(3);
	});

	it("concurrent spawns share one git run per question", async () => {
		initProjectRepo();
		const worktree = join(root, "worktree");
		git(project, "worktree", "add", "-q", worktree);
		await trustParent();
		const calls: string[][] = [];
		const counting = countingGit(calls);
		expect(await Promise.all([trustFor(worktree, counting), trustFor(worktree, counting)])).toEqual(["1", "1"]);
		expect(calls).toHaveLength(3);
	});

	it("a git failure or timeout means no trust", async () => {
		initProjectRepo();
		const worktree = join(root, "worktree");
		git(project, "worktree", "add", "-q", worktree);
		await trustParent();
		// The runner resolves undefined on a non-zero exit or after its 2 s timeout.
		const failing: GitRunner = async () => undefined;
		expect(await trustFor(worktree, failing)).toBeUndefined();
		resetWorkerTrustGitCache();
		const throwing: GitRunner = async () => {
			throw new Error("spawn git ENOENT");
		};
		expect(await trustFor(worktree, throwing)).toBeUndefined();
		resetWorkerTrustGitCache();
		// Only the worker's top level fails: still nothing.
		const workerFails: GitRunner = (dir, args) => (dir === worktree ? Promise.resolve(undefined) : runGit(dir, args));
		expect(await trustFor(worktree, workerFails)).toBeUndefined();
	});

	it("a worktree added after the first check still gets 1 (the list is read again once)", async () => {
		initProjectRepo();
		const first = join(root, "worktree-a");
		git(project, "worktree", "add", "-q", first);
		await trustParent();
		expect(await trustFor(first)).toBe("1"); // caches [project, worktree-a]
		const later = join(root, "worktree-b");
		git(project, "worktree", "add", "-q", later);
		const calls: string[][] = [];
		expect(await trustFor(later, countingGit(calls))).toBe("1");
		// worker top level, then one re-read of the list (the parent top level stays cached)
		expect(calls.map((call) => call.slice(1).join(" "))).toEqual([
			"rev-parse --show-toplevel",
			"worktree list --porcelain -z",
		]);
	});

	it("a git failure is not cached: a later check gets 1", async () => {
		initProjectRepo();
		const worktree = join(root, "worktree");
		git(project, "worktree", "add", "-q", worktree);
		await trustParent();
		let failing = true;
		const flaky: GitRunner = (dir, args) => (failing ? Promise.resolve(undefined) : runGit(dir, args));
		expect(await trustFor(worktree, flaky)).toBeUndefined();
		failing = false;
		expect(await trustFor(worktree, flaky)).toBe("1");
	});

	it("an aborted spawn runs no git and gets nothing", async () => {
		initProjectRepo();
		const worktree = join(root, "worktree");
		git(project, "worktree", "add", "-q", worktree);
		await trustParent();
		const calls: string[][] = [];
		const controller = new AbortController();
		controller.abort();
		expect(await trustFor(worktree, countingGit(calls), controller.signal)).toBeUndefined();
		expect(calls).toEqual([]);
		expect(await trustFor(worktree)).toBe("1"); // the abort was not cached
	});

	it("aborting one of two concurrent checks does not take trust from the other", async () => {
		initProjectRepo();
		const worktree = join(root, "worktree");
		git(project, "worktree", "add", "-q", worktree);
		await trustParent();
		const calls: string[][] = [];
		const counting = countingGit(calls);
		const controller = new AbortController();
		const first = trustFor(worktree, counting, controller.signal);
		const second = trustFor(worktree, counting);
		controller.abort();
		expect(await first).toBeUndefined();
		expect(await second).toBe("1");
		expect(calls).toHaveLength(3); // one shared lookup, not killed by the first caller's abort
	});

	it("runs git from a fixed cwd with -C <dir> and without any GIT_* variable", () => {
		const call = gitInvocation(project, ["rev-parse", "--show-toplevel"], {
			PATH: "/usr/bin",
			GIT_DIR: "/elsewhere/.git",
			GIT_CONFIG_PARAMETERS: "'core.fsmonitor'='evil'",
			GIT_CONFIG_COUNT: "1",
			GIT_CEILING_DIRECTORIES: "/",
		});
		expect(call.file).toBe("git");
		expect(call.cwd).toBe(tmpdir());
		expect(call.args).toEqual(["-C", project, "-c", "core.fsmonitor=false", "rev-parse", "--show-toplevel"]);
		expect(call.env).toEqual({ PATH: "/usr/bin" });
	});

	it("a GIT_DIR or GIT_CONFIG_PARAMETERS in the parent does not reach git", async () => {
		initProjectRepo();
		const saved = { GIT_DIR: process.env.GIT_DIR, GIT_CONFIG_PARAMETERS: process.env.GIT_CONFIG_PARAMETERS };
		process.env.GIT_DIR = join(root, "nope");
		process.env.GIT_CONFIG_PARAMETERS = "garbage"; // git refuses to start with this if it sees it
		try {
			expect((await runGit(project, ["rev-parse", "--show-toplevel"]))?.trim()).toBe(project);
		} finally {
			for (const [name, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
	});

	it("runGit resolves undefined outside a repository", async () => {
		expect(await runGit(home, ["rev-parse", "--show-toplevel"])).toBeUndefined();
	});

	it.skipIf(process.platform === "win32")(
		"a symlinked worker dir resolves by real path: into the project is inside, elsewhere is not",
		async () => {
			const sub = join(project, "packages", "app");
			writeSettings(sub);
			const outside = join(root, "outside");
			writeSettings(outside);
			symlinkSync(sub, join(root, "link-in"));
			symlinkSync(outside, join(root, "link-out"));
			await trustParent();
			const calls: string[][] = [];
			expect(await trustFor(join(root, "link-in"), countingGit(calls))).toBe("1");
			expect(calls).toEqual([]);
			expect(await trustFor(join(root, "link-out"))).toBeUndefined();
		},
	);
});
