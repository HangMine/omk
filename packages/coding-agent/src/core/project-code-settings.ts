/**
 * Project settings keys that load or run code (spec 053). A cloned repository's
 * `.omk/settings.json` can name npm/git packages, extension paths, the npm command,
 * the shell, and a shell prefix; each of these runs code with the user's privileges.
 * Until the project trust gate opens, these keys are withheld: OMK reads them from the
 * user-global settings only. Skills, prompt templates, themes, and every other key are
 * not code and keep their project values.
 */
// Typed structurally (no import of settings-manager.ts) so settings-manager can depend on this
// module without an import cycle; project-trust.ts checks the keys against Settings.
type SettingsLike = object;

export const PROJECT_CODE_SETTING_KEYS = [
	"packages",
	"extensions",
	"npmCommand",
	"shellPath",
	"shellCommandPrefix",
] as const;

export type ProjectCodeSettingKey = (typeof PROJECT_CODE_SETTING_KEYS)[number];

/** Minimal view of SettingsManager this module needs (keeps the import type-only). */
export interface ProjectCodeSettingsSource<T extends SettingsLike = SettingsLike> {
	getProjectSettings(): T;
	isProjectCodeWithheld(): boolean;
}

/** A copy of `settings` without the code-loading keys. */
export function withoutProjectCode<T extends SettingsLike>(settings: T): T {
	const copy: Record<string, unknown> = { ...(settings as Record<string, unknown>) };
	for (const key of PROJECT_CODE_SETTING_KEYS) {
		delete copy[key];
	}
	return copy as T;
}

/** The code-loading keys that `settings` actually sets (for prompts and diagnostics). */
export function presentProjectCodeKeys(settings: SettingsLike): ProjectCodeSettingKey[] {
	return PROJECT_CODE_SETTING_KEYS.filter((key) => {
		const value = (settings as Record<string, unknown>)[key];
		return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== "";
	});
}

/** Project settings for resource resolution: code keys are dropped while the project is untrusted. */
export function trustedProjectSettings<T extends SettingsLike>(source: ProjectCodeSettingsSource<T>): T {
	const settings = source.getProjectSettings();
	return source.isProjectCodeWithheld() ? withoutProjectCode(settings) : settings;
}

/** Auto-discovered `.omk/extensions/` entries, or none while the project is untrusted. */
export function collectProjectAutoExtensionEntries(
	source: ProjectCodeSettingsSource,
	dir: string,
	collect: (dir: string) => string[],
): string[] {
	return source.isProjectCodeWithheld() ? [] : collect(dir);
}
