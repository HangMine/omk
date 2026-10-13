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
 * git runs asynchronously (no event-loop stall) with a 2 s timeout, every `GIT_*` variable
 * removed, `core.fsmonitor=false`, and from a fixed cwd (`os.tmpdir()`) with the target passed
 * as `-C <dir>`, so no git binary inside the model-chosen directory can be picked up. Any
 * failure, timeout or abort means no trust; an abort only stops that caller's wait. Concurrent
 * callers share in-flight lookups, but settled answers are discarded. Each later spawn checks
 * the current repository and registration again, including removed or replaced worktrees.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { canonicalDir } from "./project-code-fingerprint.ts";

export const GIT_TIMEOUT_MS = 2000;

/** Runs `git <args>` against `dir`. Resolves to stdout, or undefined on any failure or timeout. */
export type GitRunner = (dir: string, args: readonly string[]) => Promise<string | undefined>;

/** @internal The exact `execFile` call `runGit` makes (exported for tests). */
export function gitInvocation(
	dir: string,
	args: readonly string[],
	parentEnv: NodeJS.ProcessEnv = process.env,
): { readonly file: string; readonly args: string[]; readonly cwd: string; readonly env: NodeJS.ProcessEnv } {
	const env: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(parentEnv)) {
		if (!name.toUpperCase().startsWith("GIT_")) env[name] = value;
	}
	return { file: "git", args: ["-C", dir, "-c", "core.fsmonitor=false", ...args], cwd: tmpdir(), env };
}

export const runGit: GitRunner = (dir, args) =>
	new Promise((resolve) => {
		const call = gitInvocation(dir, args);
		execFile(
			call.file,
			call.args,
			{ cwd: call.cwd, env: call.env, encoding: "utf8", timeout: GIT_TIMEOUT_MS, windowsHide: true },
			(error, stdout) => resolve(error ? undefined : stdout),
		);
	});

interface RepositoryIdentity {
	readonly top: string;
	readonly gitDir: string;
	readonly commonDir: string;
}

interface RegisteredRepository {
	readonly identity: RepositoryIdentity;
	readonly worktrees: ReadonlySet<string>;
}

interface GitTrustCache {
	readonly repositories: Map<string, Promise<RepositoryIdentity | undefined>>;
	readonly worktrees: Map<string, Promise<RegisteredRepository | undefined>>;
}

// On a global symbol, like the session trust map, so a separately loaded copy shares it.
const GIT_CACHE_KEY = Symbol.for("omk.projectTrust.gitInFlight");

function gitCache(): GitTrustCache {
	const holder = globalThis as { [GIT_CACHE_KEY]?: GitTrustCache };
	holder[GIT_CACHE_KEY] ??= { repositories: new Map(), worktrees: new Map() };
	return holder[GIT_CACHE_KEY];
}

/** @internal Tests only: forget cached git answers. */
export function resetWorkerTrustGitCache(): void {
	const cache = gitCache();
	cache.repositories.clear();
	cache.worktrees.clear();
}

/** Drops `key` only if it still holds `pending` (a newer lookup may have replaced it). */
function forget<T>(map: Map<string, Promise<T>>, key: string, pending: Promise<T>): void {
	if (map.get(key) === pending) map.delete(key);
}

/** Shares concurrent lookups only: a previous grant must never authorize a replaced repository. */
function memoInFlight<T>(
	map: Map<string, Promise<T | undefined>>,
	key: string,
	load: () => Promise<T | undefined>,
): Promise<T | undefined> {
	const cached = map.get(key);
	if (cached) return cached;
	const pending = load().catch(() => undefined);
	map.set(key, pending);
	void pending.then(() => forget(map, key, pending));
	return pending;
}

async function safeGit(git: GitRunner, dir: string, args: readonly string[]): Promise<string | undefined> {
	try {
		return await git(dir, args);
	} catch {
		return undefined;
	}
}

function repositoryIdentity(dir: string, git: GitRunner): Promise<RepositoryIdentity | undefined> {
	return memoInFlight(gitCache().repositories, dir, async () => {
		const output = await safeGit(git, dir, [
			"rev-parse",
			"--show-toplevel",
			"--absolute-git-dir",
			"--git-common-dir",
		]);
		const fields = output?.trimEnd().split(/\r?\n/);
		// Ambiguous output (including paths with embedded newlines) fails closed.
		if (!fields || fields.length !== 3 || fields.some((field) => field.length === 0)) return undefined;
		const [top, gitDir, commonDir] = fields.map((field) => canonicalDir(path.resolve(dir, field)));
		return { top, gitDir, commonDir };
	});
}

function registeredWorktrees(projectKey: string, git: GitRunner): Promise<RegisteredRepository | undefined> {
	return memoInFlight(gitCache().worktrees, projectKey, async () => {
		const identity = await repositoryIdentity(projectKey, git);
		if (identity?.top !== projectKey) return undefined;
		const output = await safeGit(git, projectKey, ["worktree", "list", "--porcelain", "-z"]);
		if (output === undefined) return undefined;
		const worktrees = new Set<string>();
		for (const field of output.split("\0")) {
			if (field.startsWith("worktree ")) worktrees.add(canonicalDir(field.slice("worktree ".length)));
		}
		return { identity, worktrees };
	});
}

function isInside(dir: string, parent: string): boolean {
	return dir === parent || dir.startsWith(`${parent}${path.sep}`);
}

async function checkRegisteredWorktree(projectKey: string, workerKey: string, git: GitRunner): Promise<boolean> {
	const registered = await registeredWorktrees(projectKey, git);
	if (!registered) return false;
	const worker = await repositoryIdentity(workerKey, git);
	if (!worker || worker.commonDir !== registered.identity.commonDir) return false;
	// A forged .git file pointing at the main .git must not borrow a stale registration.
	if (worker.gitDir === worker.commonDir) {
		if (worker.top !== registered.worktrees.values().next().value) return false;
	} else {
		if (!isInside(worker.gitDir, path.join(worker.commonDir, "worktrees"))) return false;
		try {
			const backPointer = (await readFile(path.join(worker.gitDir, "gitdir"), "utf8")).trimEnd();
			if (canonicalDir(path.dirname(path.resolve(worker.gitDir, backPointer))) !== worker.top) return false;
		} catch {
			return false; // Missing or unreadable registration metadata never authorizes code.
		}
	}
	return isInside(workerKey, worker.top) && registered.worktrees.has(worker.top);
}

/** Resolves to `false` as soon as `signal` aborts; `work` itself keeps running for other callers. */
function raceAbort(work: Promise<boolean>, signal: AbortSignal | undefined): Promise<boolean> {
	if (!signal) return work;
	if (signal.aborted) return Promise.resolve(false);
	return new Promise((resolve) => {
		const onAbort = () => resolve(false);
		signal.addEventListener("abort", onAbort, { once: true });
		const settle = (value: boolean) => {
			signal.removeEventListener("abort", onAbort);
			resolve(value);
		};
		work.then(settle, () => settle(false));
	});
}

/**
 * Whether `workerKey` (a real path) lies in a worktree registered by the repository whose top
 * level is `projectKey` (a real path). Both arguments must already be canonical. Settled answers
 * are never reused: a removed worktree or changed git configuration revokes the next grant.
 * Concurrent callers share in-flight git lookups with no caller's signal (each is bounded by
 * its timeout); `signal` only makes this caller stop waiting and get `false`. An already aborted
 * signal runs no git.
 */
export function isInRegisteredWorktree(
	projectKey: string,
	workerKey: string,
	git: GitRunner = runGit,
	signal?: AbortSignal,
): Promise<boolean> {
	if (signal?.aborted) return Promise.resolve(false);
	return raceAbort(checkRegisteredWorktree(projectKey, workerKey, git), signal);
}
