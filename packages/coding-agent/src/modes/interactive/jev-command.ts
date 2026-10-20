import type { Component, TUI } from "omk-tui";
import type { AuthStorage } from "../../core/auth-storage.ts";
import {
	clearJevKey,
	formatJevClear,
	getJevKeySource,
	JEV_PROVIDER_ID,
	JEV_USAGE,
	parseJevCommand,
	setJevKey,
} from "../../core/jev-key.ts";
import { LoginDialogComponent } from "./components/login-dialog.ts";

export interface JevDialogHost {
	show(component: Component): void;
	restoreEditor(): void;
	status(message: string): void;
	error(message: string): void;
}

/** /jev: TypeSafe key management. Output never contains key characters; makes no network calls. */
export async function runJevCommand(
	text: string,
	authStorage: AuthStorage,
	ui: TUI,
	host: JevDialogHost,
): Promise<void> {
	const sub = parseJevCommand(text);
	if (sub === "status") {
		host.status(getJevKeySource(authStorage));
	} else if (sub === "usage" || sub === "unknown") {
		host.status(`${getJevKeySource(authStorage)}\n${JEV_USAGE}`);
	} else if (sub === "clear") {
		host.status(formatJevClear(clearJevKey(authStorage)));
	} else if (sub === "set") {
		await runJevSet(authStorage, ui, host);
	}
}

async function runJevSet(authStorage: AuthStorage, ui: TUI, host: JevDialogHost): Promise<void> {
	const dialog = new LoginDialogComponent(ui, JEV_PROVIDER_ID, () => {}, "TypeSafe", "Set TypeSafe (Jev) key");
	host.show(dialog);
	try {
		const result = setJevKey(authStorage, await dialog.showPrompt("Enter TypeSafe key:"));
		host.restoreEditor();
		if (result.ok) host.status("TypeSafe key stored.");
		else host.error(result.error);
	} catch (error: unknown) {
		host.restoreEditor();
		// Error names only; never the input.
		if (!(error instanceof Error && error.message === "Login cancelled")) host.error("Failed to store TypeSafe key.");
	}
}
