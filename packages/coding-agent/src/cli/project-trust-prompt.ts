import { describeProjectCodeSurface, type ProjectCodeSurface, type ProjectTrustAnswer } from "../core/project-trust.ts";
import type { SettingsManager } from "../core/settings-manager.ts";

const TRUST = "Trust this project and load its code";
const DENY = "Don't trust (start without the project's code)";

export function formatProjectTrustPrompt(surface: ProjectCodeSurface, changed: boolean): string {
	const lead = changed
		? "This project's code changed since you last decided."
		: "This project wants to load code that runs with your privileges.";
	return `${lead}\n${surface.projectKey}\n${describeProjectCodeSurface(surface)}\nOnly trust repositories you know.`;
}

/** Interactive Trust/Don't-trust prompt shown before the TUI starts (same pattern as the missing-cwd prompt). */
export async function promptForProjectTrust(
	surface: ProjectCodeSurface,
	changed: boolean,
	settingsManager: SettingsManager,
): Promise<ProjectTrustAnswer> {
	const [
		{ ProcessTerminal, setKeybindings, TUI },
		{ KeybindingsManager },
		{ ExtensionSelectorComponent },
		{ initTheme },
	] = await Promise.all([
		import("omk-tui"),
		import("../core/keybindings.ts"),
		import("../modes/interactive/components/extension-selector.ts"),
		import("../modes/interactive/theme/theme.ts"),
	]);
	initTheme(settingsManager.getTheme());
	setKeybindings(KeybindingsManager.create());

	return new Promise((resolve) => {
		const ui = new TUI(new ProcessTerminal(), settingsManager.getShowHardwareCursor());
		ui.setClearOnShrink(settingsManager.getClearOnShrink());

		let settled = false;
		const finish = (answer: ProjectTrustAnswer) => {
			if (settled) {
				return;
			}
			settled = true;
			ui.stop();
			resolve(answer);
		};

		const selector = new ExtensionSelectorComponent(
			formatProjectTrustPrompt(surface, changed),
			[TRUST, DENY],
			(option) => finish(option === TRUST ? "trust" : "deny"),
			() => finish("dismiss"),
			{ tui: ui },
		);
		ui.addChild(selector);
		ui.setFocus(selector);
		ui.start();
	});
}
