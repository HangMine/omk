import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";

const DEFAULT_SCREENS = 50;

afterEach(() => vi.unstubAllEnvs());

describe("scrollback seed settings", () => {
	it.each(["", "   ", "Infinity", "NaN", "garbage"])("defaults an invalid or empty env value %j", (value) => {
		vi.stubEnv("OMK_SCROLLBACK_SCREENS", value);
		expect(SettingsManager.inMemory().getScrollbackSeedScreens()).toBe(DEFAULT_SCREENS);
	});

	it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
		"falls back to env when the configured number %s is non-finite",
		(value) => {
			vi.stubEnv("OMK_SCROLLBACK_SCREENS", "12");
			expect(
				SettingsManager.inMemory({ terminal: { scrollbackSeedScreens: value } }).getScrollbackSeedScreens(),
			).toBe(12);
		},
	);

	it("uses a finite configured value before the environment", () => {
		vi.stubEnv("OMK_SCROLLBACK_SCREENS", "10");
		expect(SettingsManager.inMemory({ terminal: { scrollbackSeedScreens: 3.9 } }).getScrollbackSeedScreens()).toBe(3);
	});

	it.each(["0", "-5"])("keeps zero and clamps a negative env value %j to zero", (value) => {
		vi.stubEnv("OMK_SCROLLBACK_SCREENS", value);
		expect(SettingsManager.inMemory().getScrollbackSeedScreens()).toBe(0);
	});
});
