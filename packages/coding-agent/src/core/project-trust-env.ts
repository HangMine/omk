/**
 * `OMK_TRUST_PROJECT` (spec 053). Read once when the CLI starts:
 *
 * - "1" is bound to the real path of the startup cwd and removed from `process.env`, so the
 *   bash tool, RPC clients and any other child process do not inherit it. Otherwise a model
 *   could run `cd /tmp/x && omk -p` and have /tmp/x trusted. Workers get "1" only through
 *   `workerProjectTrustEnv()` (project-trust-worker.ts), which checks the worker cwd first.
 * - "0" stays in the environment: inheriting "keep project code off" is safe, and benches rely on it.
 *
 * The decision (project-trust.ts) applies "1" only to non-interactive runs (048 R7).
 */
import { canonicalDir } from "./project-code-fingerprint.ts";

export const TRUST_PROJECT_ENV = "OMK_TRUST_PROJECT";

// On a global symbol so a separately loaded copy of this module (extension loader) sees the same value.
const STARTUP_TRUST_KEY = Symbol.for("omk.projectTrust.startupEnv");

type StartupTrustHolder = { [STARTUP_TRUST_KEY]?: string };

/** Call once at CLI startup, before anything spawns a child. */
export function captureStartupProjectTrust(cwd: string, env: NodeJS.ProcessEnv = process.env): void {
	const holder = globalThis as StartupTrustHolder;
	if (env[TRUST_PROJECT_ENV] === "1") {
		holder[STARTUP_TRUST_KEY] = canonicalDir(cwd);
		delete env[TRUST_PROJECT_ENV];
	} else {
		delete holder[STARTUP_TRUST_KEY];
	}
}

/** The canonical startup project that `OMK_TRUST_PROJECT=1` was bound to, if any. */
export function startupTrustedProject(): string | undefined {
	return (globalThis as StartupTrustHolder)[STARTUP_TRUST_KEY];
}

/**
 * The env's say for one project: "closed" for "0"; "open" for "1". With an explicit `env`
 * (tests, callers deciding for that cwd) its value is used as is; without one, "1" counts only
 * for the startup project captured above, and "0" is read from `process.env`.
 */
export function projectTrustEnvFor(projectKey: string, env?: NodeJS.ProcessEnv): "open" | "closed" | undefined {
	const value = (env ?? process.env)[TRUST_PROJECT_ENV];
	if (value === "0") return "closed";
	if (env) return value === "1" ? "open" : undefined;
	return startupTrustedProject() === projectKey ? "open" : undefined;
}
