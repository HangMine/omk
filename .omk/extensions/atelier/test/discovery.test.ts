import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { DefaultResourceLoader } from "../../../../packages/coding-agent/src/core/resource-loader.ts";
import { SettingsManager } from "../../../../packages/coding-agent/src/core/settings-manager.ts";

it("discovers the installable package extension and themes through the real resource loader", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "atelier-package-"));
	try {
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir: join(cwd, "agent"),
			settingsManager: SettingsManager.inMemory({ packages: [resolve(".")] }),
			noSkills: true,
			noContextFiles: true,
			noPromptTemplates: true,
		});
		await loader.reload();
		expect(loader.getExtensions().errors).toEqual([]);
		expect(loader.getExtensions().extensions.filter((entry) => entry.path.startsWith(resolve(".")))).toHaveLength(1);
		expect(loader.getThemes().diagnostics).toEqual([]);
		expect(
			loader
				.getThemes()
				.themes.map((theme) => theme.name)
				.sort(),
		).toEqual(["omk-atelier-dark", "omk-atelier-light"]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
