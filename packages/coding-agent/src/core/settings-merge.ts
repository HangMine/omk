import { withoutProjectCode } from "./project-code-settings.ts";

/** Deep merge settings: project/overrides take precedence, nested objects merge recursively */
export function deepMergeSettings<T extends object>(base: T, overrides: T): T {
	const baseRecord = base as Record<string, unknown>;
	const overrideRecord = overrides as Record<string, unknown>;
	const result: Record<string, unknown> = { ...baseRecord };

	for (const key of Object.keys(overrideRecord)) {
		const overrideValue = overrideRecord[key];
		const baseValue = baseRecord[key];

		if (overrideValue === undefined) {
			continue;
		}

		// For nested objects, merge recursively
		if (
			typeof overrideValue === "object" &&
			overrideValue !== null &&
			!Array.isArray(overrideValue) &&
			typeof baseValue === "object" &&
			baseValue !== null &&
			!Array.isArray(baseValue)
		) {
			result[key] = { ...baseValue, ...overrideValue };
		} else {
			// For primitives and arrays, override value wins
			result[key] = overrideValue;
		}
	}

	return result as T;
}

/**
 * The effective settings: global, then project on top. While the project trust gate is
 * closed (spec 053), the project's code-loading keys are left out so the global values apply.
 */
export function mergeLayeredSettings<T extends object>(global: T, project: T, withholdProjectCode: boolean): T {
	return deepMergeSettings(global, withholdProjectCode ? withoutProjectCode(project) : project);
}
