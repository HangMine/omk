/**
 * Project trust for spawned workers (spec 053 R6b). The parent remembers which projects it
 * trusted; a worker gets `OMK_TRUST_PROJECT=1` only when its cwd belongs to such a project
 * (the same directory, a directory inside it, or a git worktree of the same repository) and
 * its gated items hash the same. The worker cwd is chosen by the model, so a same-hash
 * directory elsewhere (identical `packages` strings and extension file names) gets nothing.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CONFIG_DIR_NAME } from "../config.ts";
import { canonicalDir, inspectProjectCode, type ProjectCodeSurface } from "./project-code-fingerprint.ts";
import { TRUST_PROJECT_ENV } from "./project-trust-env.ts";
import type { Settings } from "./settings-manager.ts";

const GIT_TIMEOUT_MS = 2000;

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

/** The canonical `git rev-parse --git-common-dir` of `dir`, or undefined (not a repo, no git, timeout). */
function gitCommonDir(dir: string): string | undefined {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]) delete env[name];
	try {
		const output = execFileSync("git", ["-c", "core.fsmonitor=false", "rev-parse", "--git-common-dir"], {
			cwd: dir,
			env,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: GIT_TIMEOUT_MS,
		}).trim();
		return output ? canonicalDir(path.resolve(dir, output)) : undefined;
	} catch {
		return undefined;
	}
}

/** The worker cwd is the parent project, inside it, or a worktree of the same git repository. */
function belongsToProject(projectKey: string, workerKey: string): boolean {
	if (workerKey === projectKey || workerKey.startsWith(`${projectKey}${path.sep}`)) return true;
	const parentCommon = gitCommonDir(projectKey);
	return parentCommon !== undefined && parentCommon === gitCommonDir(workerKey);
}

export interface WorkerProjectTrustOptions {
	readonly parentCwd: string;
	readonly workerCwd: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly home?: string;
}

/**
 * @internal Used by the bundled subagent extension; not a stable API.
 * The `OMK_TRUST_PROJECT` value for a spawned worker: "0" when the parent runs with `=0`;
 * "1" only when this process trusted the parent's project, the worker cwd belongs to it
 * (same path, a subdirectory, or a git worktree of the same repository), and the worker cwd's
 * gated items hash the same; otherwise undefined.
 */
export function workerProjectTrustEnv(options: WorkerProjectTrustOptions): "1" | "0" | undefined {
	if ((options.env ?? process.env)[TRUST_PROJECT_ENV] === "0") return "0";
	const projectKey = canonicalDir(options.parentCwd);
	const parentFingerprint = sessionTrust().get(projectKey);
	if (parentFingerprint === undefined) return undefined;
	const worker = inspectProjectCode(options.workerCwd, readProjectSettingsFile(options.workerCwd));
	if (!worker || worker.overCap || worker.fingerprint !== parentFingerprint) return undefined;
	// Hash first (cheap, no process), then the path / git check.
	return belongsToProject(projectKey, worker.projectKey) ? "1" : undefined;
}
