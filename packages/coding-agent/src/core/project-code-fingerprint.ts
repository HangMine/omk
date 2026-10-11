/**
 * Project code fingerprint (spec 053 R5). What a project would load if trusted: the gated
 * `.omk/settings.json` values, the file list under `.omk/extensions/`, and the contents of the
 * `package.json` manifests the extension loader reads there (`.omk/extensions/package.json`
 * and `<entry>/package.json`), since a manifest can point the loader at any path.
 *
 * The walk follows symlinked directories like the loader does (with an ancestor check against
 * cycles) and is bounded: past MAX_EXTENSION_ENTRIES files it stops and marks the surface
 * `overCap`, and the gate keeps such a project closed instead of trusting a truncated list.
 */
import { createHash } from "node:crypto";
import { type Dirent, existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { CONFIG_DIR_NAME } from "../config.ts";
import { type ProjectCodeSettingKey, presentProjectCodeKeys } from "./project-code-settings.ts";
import type { Settings } from "./settings-manager.ts";

export const MAX_EXTENSION_ENTRIES = 5000;

/** What a project would load if trusted. */
export interface ProjectCodeSurface {
	readonly projectKey: string;
	readonly settingsKeys: readonly ProjectCodeSettingKey[];
	readonly extensionEntries: readonly string[];
	readonly fingerprint: string;
	/** More than MAX_EXTENSION_ENTRIES files under `.omk/extensions/`: the fingerprint is incomplete. */
	readonly overCap: boolean;
}

export function canonicalDir(dir: string): string {
	const resolved = path.resolve(dir);
	try {
		return realpathSync.native(resolved);
	} catch {
		return resolved;
	}
}

function hashFile(file: string): string {
	try {
		return createHash("sha256").update(readFileSync(file)).digest("hex");
	} catch {
		return "unreadable";
	}
}

interface ExtensionWalk {
	entries: string[];
	manifests: Record<string, string>;
	overCap: boolean;
}

/** Relative file paths under `.omk/extensions/` (recursive, `/`-separated, sorted), without node_modules or dot entries. */
function walkExtensions(projectKey: string): ExtensionWalk {
	const root = path.join(projectKey, CONFIG_DIR_NAME, "extensions");
	const result: ExtensionWalk = { entries: [], manifests: {}, overCap: false };
	if (!existsSync(root)) return result;
	const manifestPaths: string[] = [];
	const ancestors = new Set<string>();
	const walk = (dir: string, prefix: string, depth: number): void => {
		const real = canonicalDir(dir);
		if (ancestors.has(real)) return; // symlink cycle
		let children: Dirent[];
		try {
			children = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		ancestors.add(real);
		for (const child of children) {
			if (result.overCap) break;
			if (child.name.startsWith(".") || child.name === "node_modules") continue;
			const full = path.join(dir, child.name);
			const relative = prefix ? `${prefix}/${child.name}` : child.name;
			let isDir = child.isDirectory();
			let isFile = child.isFile();
			if (child.isSymbolicLink()) {
				try {
					const stats = statSync(full);
					isDir = stats.isDirectory();
					isFile = stats.isFile();
				} catch {
					continue; // broken link: the loader skips it too
				}
			}
			if (isDir) {
				walk(full, relative, depth + 1);
				continue;
			}
			if (!isFile) continue;
			if (result.entries.length >= MAX_EXTENSION_ENTRIES) {
				result.overCap = true;
				break;
			}
			result.entries.push(relative);
			// The loader reads `.omk/extensions/package.json` and `.omk/extensions/<dir>/package.json`.
			if (child.name === "package.json" && depth <= 1) manifestPaths.push(relative);
		}
		ancestors.delete(real);
	};
	walk(root, "", 0);
	result.entries.sort();
	for (const relative of manifestPaths.sort()) {
		result.manifests[relative] = hashFile(path.join(root, ...relative.split("/")));
	}
	return result;
}

/**
 * The project's code surface, or undefined when the project loads no code of its own.
 * `projectSettings` is the raw project `.omk/settings.json` content.
 */
export function inspectProjectCode(cwd: string, projectSettings: Settings): ProjectCodeSurface | undefined {
	const projectKey = canonicalDir(cwd);
	const settingsKeys = presentProjectCodeKeys(projectSettings);
	const walk = walkExtensions(projectKey);
	if (settingsKeys.length === 0 && walk.entries.length === 0) return undefined;
	const material = JSON.stringify({
		settings: Object.fromEntries(settingsKeys.map((key) => [key, projectSettings[key]])),
		extensions: walk.entries,
		manifests: walk.manifests,
	});
	const fingerprint = createHash("sha256").update(material).digest("hex");
	return { projectKey, settingsKeys, extensionEntries: walk.entries, fingerprint, overCap: walk.overCap };
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
