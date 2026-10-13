/**
 * Project trust for spawned workers (spec 053 R6b). The parent remembers which projects it
 * trusted; a worker gets `OMK_TRUST_PROJECT=1` only when its cwd belongs to such a project
 * (the same directory, a directory inside it, or a worktree registered by the project's own
 * repository, see project-trust-git.ts) and its gated items hash the same. The worker cwd is
 * chosen by the model, so a same-hash directory elsewhere (identical `packages` strings and
 * extension file names) gets nothing.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { CONFIG_DIR_NAME } from "../config.ts";
import { canonicalDir, inspectProjectCode, type ProjectCodeSurface } from "./project-code-fingerprint.ts";
import { TRUST_PROJECT_ENV } from "./project-trust-env.ts";
import { type GitRunner, isInRegisteredWorktree, runGit } from "./project-trust-git.ts";
import type { Settings } from "./settings-manager.ts";

// Projects this process trusted, by path → fingerprint. Kept on a global symbol so the subagent
// extension sees the same map even when its loader gives it a separate copy of this module.
const SESSION_TRUST_KEY = Symbol.for("omk.projectTrust.session");

function sessionTrust(): Map<string, string> {
	const holder = globalThis as { [SESSION_TRUST_KEY]?: Map<string, string> };
	holder[SESSION_TRUST_KEY] ??= new Map();
	return holder[SESSION_TRUST_KEY];
}

/** Record that this process loaded the project's code (called by the gate when it opens). */
export function rememberSessionTrust(surface: ProjectCodeSurface): void {
	sessionTrust().set(surface.projectKey, surface.fingerprint);
}

function readProjectSettingsFile(cwd: string): Settings {
	try {
		const parsed = JSON.parse(readFileSync(path.join(cwd, CONFIG_DIR_NAME, "settings.json"), "utf8")) as unknown;
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Settings) : {};
	} catch {
		return {};
	}
}

/**
 * The worker cwd is the parent project or a directory inside it (real paths, no git needed;
 * a symlink into the project resolves inside it), or lies in a worktree registered by the
 * project's own repository.
 */
async function belongsToProject(
	projectKey: string,
	workerKey: string,
	git: GitRunner,
	signal: AbortSignal | undefined,
): Promise<boolean> {
	if (workerKey === projectKey || workerKey.startsWith(`${projectKey}${path.sep}`)) return true;
	return isInRegisteredWorktree(projectKey, workerKey, git, signal);
}

export interface WorkerProjectTrustOptions {
	readonly parentCwd: string;
	readonly workerCwd: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly home?: string;
	/** Aborts the git check (no trust); pass the spawn's signal so an abort is not delayed by git. */
	readonly signal?: AbortSignal;
	/** @internal Tests only: replaces the git runner. */
	readonly git?: GitRunner;
}

/**
 * @internal Used by the bundled subagent extension; not a stable API.
 * The `OMK_TRUST_PROJECT` value for a spawned worker: "0" when the parent runs with `=0`;
 * "1" only when this process trusted the parent's project, the worker cwd belongs to it
 * (same path, a subdirectory, or a worktree registered by the project's repository, the
 * project being that repository's top level), and the worker cwd's gated items hash the same;
 * otherwise undefined. Async so the git check never blocks the event loop; concurrent callers
 * share in-flight git lookups, but later spawns revalidate. Returns a Promise.
 */
export async function workerProjectTrustEnv(options: WorkerProjectTrustOptions): Promise<"1" | "0" | undefined> {
	if ((options.env ?? process.env)[TRUST_PROJECT_ENV] === "0") return "0";
	if (options.signal?.aborted) return undefined;
	const projectKey = canonicalDir(options.parentCwd);
	const parentFingerprint = sessionTrust().get(projectKey);
	if (parentFingerprint === undefined) return undefined;
	const worker = inspectProjectCode(options.workerCwd, readProjectSettingsFile(options.workerCwd));
	if (!worker || worker.overCap || worker.fingerprint !== parentFingerprint) return undefined;
	// Hash first (cheap, no process), then the path / git check.
	const belongs = await belongsToProject(projectKey, worker.projectKey, options.git ?? runGit, options.signal);
	if (!belongs || options.signal?.aborted) return undefined;
	// Git is asynchronous: do not promote the fingerprint captured before that wait.
	const current = inspectProjectCode(options.workerCwd, readProjectSettingsFile(options.workerCwd));
	return current &&
		!current.overCap &&
		current.projectKey === worker.projectKey &&
		current.fingerprint === parentFingerprint
		? "1"
		: undefined;
}
