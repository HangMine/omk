/**
 * Project trust gate (spec 053). A cloned repository's `.omk/` can make OMK install and
 * run code: project `packages` (installed at startup, lifecycle scripts included before
 * spec 053), project `extensions` entries, auto-discovered `.omk/extensions/`, and the
 * `npmCommand` / `shellPath` / `shellCommandPrefix` settings. This module decides whether
 * that project code may load:
 *
 * - `OMK_TRUST_PROJECT=0` keeps the gate closed in every mode, stored trust included.
 * - `OMK_TRUST_PROJECT=1` opens the gate in every mode.
 * - Interactive runs ask once per project and store the answer in
 *   `~/.omk/project-trust.json`, pinned to a fingerprint of the project's code surface;
 *   a changed surface (new package, new file path under `.omk/extensions/`) asks again.
 *   `-p`, json, rpc and workers never ask but follow a stored answer for the same hash.
 * - Anything else keeps the gate closed: OMK starts, but without the project's code.
 *
 * It mirrors the MCP project trust store (`core/mcp/config.ts`) and is independent of it.
 */
import { createHash } from "node:crypto";
import {
	type Dirent,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONFIG_DIR_NAME } from "../config.ts";
import {
	PROJECT_CODE_SETTING_KEYS,
	type ProjectCodeSettingKey,
	presentProjectCodeKeys,
} from "./project-code-settings.ts";
import type { Settings } from "./settings-manager.ts";

export const TRUST_PROJECT_ENV = "OMK_TRUST_PROJECT";

// Compile-time check: every gated key is a real Settings key.
const _gatedKeysAreSettings: readonly (keyof Settings)[] = PROJECT_CODE_SETTING_KEYS;
void _gatedKeysAreSettings;

export type ProjectTrustDecision = "trusted" | "denied";
export type ProjectTrustMode = "interactive" | "headless";
/** The user's answer to the trust prompt; "dismiss" (Esc) decides nothing. */
export type ProjectTrustAnswer = "trust" | "deny" | "dismiss";

/** What a project would load if trusted. */
export interface ProjectCodeSurface {
	readonly projectKey: string;
	readonly settingsKeys: readonly ProjectCodeSettingKey[];
	readonly extensionEntries: readonly string[];
	readonly fingerprint: string;
}

export type ProjectTrustOutcome =
	| { readonly kind: "no-project-code" }
	| { readonly kind: "trusted"; readonly via: "env" | "stored" | "home"; readonly surface: ProjectCodeSurface }
	| {
			readonly kind: "withheld";
			readonly reason: "headless" | "denied" | "env-off";
			readonly surface: ProjectCodeSurface;
	  }
	| { readonly kind: "ask"; readonly changed: boolean; readonly surface: ProjectCodeSurface };

interface TrustStoreFile {
	version: 1;
	projects: Record<string, { decision: ProjectTrustDecision; fingerprint: string; decidedAt: string }>;
}

export function projectTrustStorePath(home: string = os.homedir()): string {
	return path.join(home, CONFIG_DIR_NAME, "project-trust.json");
}

function canonicalDir(dir: string): string {
	const resolved = path.resolve(dir);
	try {
		return realpathSync.native(resolved);
	} catch {
		return resolved;
	}
}

// Bound the walk so a huge tree cannot stall startup; past the cap the list (and hash) stops growing.
const MAX_EXTENSION_ENTRIES = 5000;

/** Relative file paths under `.omk/extensions/` (recursive, `/`-separated, sorted), without node_modules or dot entries. */
function listExtensionEntries(projectKey: string): string[] {
	const root = path.join(projectKey, CONFIG_DIR_NAME, "extensions");
	if (!existsSync(root)) return [];
	const entries: string[] = [];
	const walk = (dir: string, prefix: string): void => {
		let children: Dirent[];
		try {
			children = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const child of children) {
			if (entries.length >= MAX_EXTENSION_ENTRIES) return;
			if (child.name.startsWith(".") || child.name === "node_modules") continue;
			const relative = prefix ? `${prefix}/${child.name}` : child.name;
			if (child.isDirectory()) walk(path.join(dir, child.name), relative);
			else entries.push(relative);
		}
	};
	walk(root, "");
	return entries.sort();
}

/**
 * The project's code surface, or undefined when the project loads no code of its own.
 * `projectSettings` is the raw project `.omk/settings.json` content.
 */
export function inspectProjectCode(cwd: string, projectSettings: Settings): ProjectCodeSurface | undefined {
	const projectKey = canonicalDir(cwd);
	const settingsKeys = presentProjectCodeKeys(projectSettings);
	const extensionEntries = listExtensionEntries(projectKey);
	if (settingsKeys.length === 0 && extensionEntries.length === 0) return undefined;
	const material = JSON.stringify({
		settings: Object.fromEntries(settingsKeys.map((key) => [key, projectSettings[key]])),
		extensions: extensionEntries,
	});
	const fingerprint = createHash("sha256").update(material).digest("hex");
	return { projectKey, settingsKeys, extensionEntries, fingerprint };
}

function readStore(home: string): TrustStoreFile {
	const file = projectTrustStorePath(home);
	if (!existsSync(file)) return { version: 1, projects: {} };
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<TrustStoreFile>;
		if (parsed.version !== 1 || typeof parsed.projects !== "object" || parsed.projects === null) {
			return { version: 1, projects: {} };
		}
		return { version: 1, projects: parsed.projects };
	} catch {
		// A corrupt store decides nothing: every project is asked again.
		return { version: 1, projects: {} };
	}
}

function writeStore(home: string, store: TrustStoreFile): void {
	const file = projectTrustStorePath(home);
	mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const temp = `${file}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(store, null, "\t")}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temp, file);
}

/** Store the user's answer for this exact code surface. */
export function recordProjectTrustDecision(
	surface: ProjectCodeSurface,
	decision: ProjectTrustDecision,
	home: string = os.homedir(),
	now: Date = new Date(),
): void {
	const store = readStore(home);
	store.projects[surface.projectKey] = { decision, fingerprint: surface.fingerprint, decidedAt: now.toISOString() };
	writeStore(home, store);
}

/** Forget the stored answer, so the next interactive run asks again. */
export function forgetProjectTrustDecision(cwd: string, home: string = os.homedir()): void {
	const store = readStore(home);
	const key = canonicalDir(cwd);
	if (!(key in store.projects)) return;
	delete store.projects[key];
	writeStore(home, store);
}

export interface DecideProjectTrustOptions {
	readonly cwd: string;
	readonly projectSettings: Settings;
	readonly mode: ProjectTrustMode;
	readonly env?: NodeJS.ProcessEnv;
	readonly home?: string;
}

/** `OMK_TRUST_PROJECT`: "1" opens the gate, "0" forces it closed, anything else leaves it to the stored answer. */
export function projectTrustEnv(env: NodeJS.ProcessEnv = process.env): "open" | "closed" | undefined {
	const value = env[TRUST_PROJECT_ENV];
	return value === "1" ? "open" : value === "0" ? "closed" : undefined;
}

/** Decide the gate for one runtime cwd. Pure apart from reading the trust store. */
export function decideProjectTrust(options: DecideProjectTrustOptions): ProjectTrustOutcome {
	const home = options.home ?? os.homedir();
	const surface = inspectProjectCode(options.cwd, options.projectSettings);
	if (!surface) return { kind: "no-project-code" };
	const envSetting = projectTrustEnv(options.env ?? process.env);
	// `=0` wins over everything, stored trust and the home directory included (bench runs use it).
	if (envSetting === "closed") return { kind: "withheld", reason: "env-off", surface };
	// The home directory's `.omk/` belongs to the user, not to a cloned repository.
	if (surface.projectKey === canonicalDir(home)) return { kind: "trusted", via: "home", surface };
	if (envSetting === "open") return { kind: "trusted", via: "env", surface };
	// Same user, same path, same hash: the user already decided, in any mode.
	const stored = readStore(home).projects[surface.projectKey];
	if (stored && stored.fingerprint === surface.fingerprint) {
		return stored.decision === "trusted"
			? { kind: "trusted", via: "stored", surface }
			: { kind: "withheld", reason: "denied", surface };
	}
	if (options.mode === "headless") return { kind: "withheld", reason: "headless", surface };
	return { kind: "ask", changed: stored !== undefined, surface };
}

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

export interface WorkerProjectTrustOptions {
	readonly parentCwd: string;
	readonly workerCwd: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly home?: string;
}

/**
 * The `OMK_TRUST_PROJECT` value for a spawned worker: "0" when the parent runs with `=0`;
 * "1" only when this process trusted the parent's project and the worker cwd's gated items
 * hash the same (same project, or a worktree of it at another path); otherwise undefined.
 */
export function workerProjectTrustEnv(options: WorkerProjectTrustOptions): "1" | "0" | undefined {
	if (projectTrustEnv(options.env ?? process.env) === "closed") return "0";
	const parentFingerprint = sessionTrust().get(canonicalDir(options.parentCwd));
	if (parentFingerprint === undefined) return undefined;
	const worker = inspectProjectCode(options.workerCwd, readProjectSettingsFile(options.workerCwd));
	return worker?.fingerprint === parentFingerprint ? "1" : undefined;
}

/** The single stderr line printed when `OMK_TRUST_PROJECT=1` opens the gate. */
export function formatEnvTrustNotice(projectKey: string): string {
	return `omk: ${TRUST_PROJECT_ENV}=1 trusts project code in ${projectKey}`;
}

/** One-line summary of what the project would load, for prompts and diagnostics. */
export function describeProjectCodeSurface(surface: ProjectCodeSurface): string {
	const parts: string[] = surface.settingsKeys.map((key) => `settings.${key}`);
	if (surface.extensionEntries.length > 0) {
		const topLevel = [...new Set(surface.extensionEntries.map((entry) => entry.split("/")[0]))];
		parts.push(`${CONFIG_DIR_NAME}/extensions/ (${topLevel.join(", ")})`);
	}
	return parts.join(", ");
}
