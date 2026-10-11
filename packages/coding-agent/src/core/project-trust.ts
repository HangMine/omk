/**
 * Project trust gate (spec 053). A cloned repository's `.omk/` can make OMK install and
 * run code: project `packages` (installed at startup, lifecycle scripts included before
 * spec 053), project `extensions` entries, auto-discovered `.omk/extensions/`, and the
 * `npmCommand` / `shellPath` / `shellCommandPrefix` settings. This module decides whether
 * that project code may load:
 *
 * - `OMK_TRUST_PROJECT=0` keeps the gate closed in every mode, stored trust included.
 * - `OMK_TRUST_PROJECT=1` opens the gate only in non-interactive runs (`-p`, json, rpc,
 *   workers, CI, package commands), and only for the project omk started in: the CLI reads
 *   it once at startup and removes it from `process.env` (project-trust-env.ts).
 *   Interactive omk ignores "1" and asks (048 R7).
 * - Interactive runs ask once per project and store the answer in
 *   `~/.omk/project-trust.json`, pinned to a fingerprint of the project's code surface
 *   (project-code-fingerprint.ts); a changed surface asks again.
 *   `-p`, json, rpc and workers never ask but follow a stored answer for the same hash.
 * - Anything else keeps the gate closed: OMK starts, but without the project's code.
 *
 * It mirrors the MCP project trust store (`core/mcp/config.ts`) and is independent of it.
 */
import os from "node:os";
import { canonicalDir, inspectProjectCode, type ProjectCodeSurface } from "./project-code-fingerprint.ts";
import { PROJECT_CODE_SETTING_KEYS } from "./project-code-settings.ts";
import { projectTrustEnvFor, TRUST_PROJECT_ENV } from "./project-trust-env.ts";
import { readStoredProjectTrust } from "./project-trust-store.ts";
import type { Settings } from "./settings-manager.ts";

export {
	describeProjectCodeSurface,
	inspectProjectCode,
	MAX_EXTENSION_ENTRIES,
	type ProjectCodeSurface,
} from "./project-code-fingerprint.ts";
export { captureStartupProjectTrust, TRUST_PROJECT_ENV } from "./project-trust-env.ts";
export {
	forgetProjectTrustDecision,
	type ProjectTrustDecision,
	projectTrustStorePath,
	recordProjectTrustDecision,
} from "./project-trust-store.ts";
export { rememberSessionTrust, type WorkerProjectTrustOptions, workerProjectTrustEnv } from "./project-trust-worker.ts";

// Compile-time check: every gated key is a real Settings key.
const _gatedKeysAreSettings: readonly (keyof Settings)[] = PROJECT_CODE_SETTING_KEYS;
void _gatedKeysAreSettings;

export type ProjectTrustMode = "interactive" | "headless";
/** The user's answer to the trust prompt; "dismiss" (Esc) decides nothing. */
export type ProjectTrustAnswer = "trust" | "deny" | "dismiss";

export type ProjectTrustOutcome =
	| { readonly kind: "no-project-code" }
	| { readonly kind: "trusted"; readonly via: "env" | "stored" | "home"; readonly surface: ProjectCodeSurface }
	| {
			readonly kind: "withheld";
			readonly reason: "headless" | "denied" | "env-off" | "too-large";
			readonly surface: ProjectCodeSurface;
	  }
	| { readonly kind: "ask"; readonly changed: boolean; readonly surface: ProjectCodeSurface };

export interface DecideProjectTrustOptions {
	readonly cwd: string;
	readonly projectSettings: Settings;
	readonly mode: ProjectTrustMode;
	/** Explicit env for this cwd (tests). Omitted: "1" counts only as captured at CLI startup. */
	readonly env?: NodeJS.ProcessEnv;
	readonly home?: string;
}

/** Decide the gate for one runtime cwd. Pure apart from reading the trust store and `.omk/`. */
export function decideProjectTrust(options: DecideProjectTrustOptions): ProjectTrustOutcome {
	const home = options.home ?? os.homedir();
	const surface = inspectProjectCode(options.cwd, options.projectSettings);
	if (!surface) return { kind: "no-project-code" };
	const envSetting = projectTrustEnvFor(surface.projectKey, options.env);
	// `=0` wins over everything, stored trust and the home directory included (bench runs use it).
	if (envSetting === "closed") return { kind: "withheld", reason: "env-off", surface };
	// The home directory's `.omk/` belongs to the user, not to a cloned repository.
	if (surface.projectKey === canonicalDir(home)) return { kind: "trusted", via: "home", surface };
	// A surface too large to fingerprint completely is never trusted, by env or by store.
	if (surface.overCap) return { kind: "withheld", reason: "too-large", surface };
	// 048 R7: the env opens non-interactive runs only; interactive omk falls through to the store or the prompt.
	if (envSetting === "open" && options.mode === "headless") return { kind: "trusted", via: "env", surface };
	// Same user, same path, same hash: the user already decided, in any mode.
	const stored = readStoredProjectTrust(surface.projectKey, home);
	if (stored && stored.fingerprint === surface.fingerprint) {
		return stored.decision === "trusted"
			? { kind: "trusted", via: "stored", surface }
			: { kind: "withheld", reason: "denied", surface };
	}
	if (options.mode === "headless") return { kind: "withheld", reason: "headless", surface };
	return { kind: "ask", changed: stored !== undefined, surface };
}

/** The single stderr line printed when `OMK_TRUST_PROJECT=1` opens the gate. */
export function formatEnvTrustNotice(projectKey: string): string {
	return `omk: ${TRUST_PROJECT_ENV}=1 trusts project code in ${projectKey}`;
}
