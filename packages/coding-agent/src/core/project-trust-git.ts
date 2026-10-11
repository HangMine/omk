/**
 * Git checks behind worker project trust (spec 053 R6b, PR #124 re-review). A worker cwd
 * outside the trusted project gets `OMK_TRUST_PROJECT=1` only when it sits in a worktree that
 * the trusted project's own repository has registered:
 *
 * - the parent's `git rev-parse --show-toplevel` (real path) is the trusted project itself, so a
 *   project nested in a larger repository (a dotfiles repo at `~`, a monorepo package) never
 *   vouches for the rest of that repository;
 * - the worker's `--show-toplevel` (real path) is listed by the parent's
 *   `git worktree list --porcelain -z`, and the worker cwd lies inside that top level. A `.git`
 *   file (`gitdir: <trusted>/.git`) or a repository whose `core.worktree` names the trusted
 *   project is not registered, or does not contain the worker cwd, so it gets nothing.
 *
 * git runs asynchronously (no event-loop stall) with a 2 s timeout, `GIT_DIR`-style variables
 * removed and `core.fsmonitor=false`; any failure or timeout means no trust. Results are cached
 * per process (failures included, so a hung git costs one timeout, not one per spawn).
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { canonicalDir } from "./project-code-fingerprint.ts";

export const GIT_TIMEOUT_MS = 2000;

/** Runs `git <args>` in `cwd`. Resolves to stdout, or undefined on any failure or timeout. */
export type GitRunner = (cwd: string, args: readonly string[]) => Promise<string | undefined>;

const STRIPPED_GIT_VARS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"];

export const runGit: GitRunner = (cwd, args) =>
	new Promise((resolve) => {
		const env: NodeJS.ProcessEnv = { ...process.env };
		for (const name of STRIPPED_GIT_VARS) delete env[name];
		execFile(
			"git",
			["-c", "core.fsmonitor=false", ...args],
			{ cwd, env, encoding: "utf8", timeout: GIT_TIMEOUT_MS, windowsHide: true },
			(error, stdout) => resolve(error ? undefined : stdout),
		);
	});

interface GitTrustCache {
	/** Real path of a directory → real path of its git top level (undefined: not a repo / failed). */
	readonly toplevels: Map<string, Promise<string | undefined>>;
	/** Trusted project → real paths of its registered worktrees (undefined: not its repo's top level). */
	readonly worktrees: Map<string, Promise<ReadonlySet<string> | undefined>>;
}

// On a global symbol, like the session trust map, so a separately loaded copy shares it.
const GIT_CACHE_KEY = Symbol.for("omk.projectTrust.gitCache");

function gitCache(): GitTrustCache {
	const holder = globalThis as { [GIT_CACHE_KEY]?: GitTrustCache };
	holder[GIT_CACHE_KEY] ??= { toplevels: new Map(), worktrees: new Map() };
	return holder[GIT_CACHE_KEY];
}

/** @internal Tests only: forget cached git answers. */
export function resetWorkerTrustGitCache(): void {
	const cache = gitCache();
	cache.toplevels.clear();
	cache.worktrees.clear();
}

function memo<T>(map: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
	let pending = map.get(key);
	if (!pending) {
		pending = load();
		map.set(key, pending);
	}
	return pending;
}

async function safeGit(git: GitRunner, cwd: string, args: readonly string[]): Promise<string | undefined> {
	try {
		return await git(cwd, args);
	} catch {
		return undefined;
	}
}

function toplevel(dir: string, git: GitRunner): Promise<string | undefined> {
	return memo(gitCache().toplevels, dir, async () => {
		const output = (await safeGit(git, dir, ["rev-parse", "--show-toplevel"]))?.trim();
		return output ? canonicalDir(path.resolve(dir, output)) : undefined;
	});
}

function registeredWorktrees(projectKey: string, git: GitRunner): Promise<ReadonlySet<string> | undefined> {
	return memo(gitCache().worktrees, projectKey, async () => {
		if ((await toplevel(projectKey, git)) !== projectKey) return undefined;
		const output = await safeGit(git, projectKey, ["worktree", "list", "--porcelain", "-z"]);
		if (output === undefined) return undefined;
		const worktrees = new Set<string>();
		for (const field of output.split("\0")) {
			if (field.startsWith("worktree ")) worktrees.add(canonicalDir(field.slice("worktree ".length)));
		}
		return worktrees;
	});
}

function isInside(dir: string, parent: string): boolean {
	return dir === parent || dir.startsWith(`${parent}${path.sep}`);
}

/**
 * Whether `workerKey` (a real path) lies in a worktree registered by the repository whose top
 * level is `projectKey` (a real path). Both arguments must already be canonical.
 */
export async function isInRegisteredWorktree(
	projectKey: string,
	workerKey: string,
	git: GitRunner = runGit,
): Promise<boolean> {
	const worktrees = await registeredWorktrees(projectKey, git);
	if (!worktrees) return false;
	const workerTop = await toplevel(workerKey, git);
	return workerTop !== undefined && isInside(workerKey, workerTop) && worktrees.has(workerTop);
}
