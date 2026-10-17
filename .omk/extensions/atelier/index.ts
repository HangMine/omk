import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "open-multi-agent-kit";
import { wslNotificationDependencies } from "./src/notifications.ts";
import { createTmuxSidebarController } from "./src/tmux-sidebar.ts";
import atelierExtension from "./vendor/extensions/index.ts";

export * from "./vendor/extensions/index.ts";

export default function atelier(omk: ExtensionAPI): void {
	atelierExtension(omk, {
		...wslNotificationDependencies(),
		...(process.env.TMUX && process.env.TMUX_PANE ? { createSidebar: createTmuxSidebarController } : {}),
	});
	omk.on("resources_discover", () => ({ themePaths: [fileURLToPath(new URL("./themes", import.meta.url))] }));
	omk.registerCommand("atelier-theme", {
		description: "Select Atelier dark/light theme without replacing an existing theme at startup",
		getArgumentCompletions: (prefix) =>
			["dark", "light"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Atelier themes require TUI mode", "warning");
				return;
			}
			const variant = args.trim();
			if (variant !== "dark" && variant !== "light") {
				ctx.ui.notify("Usage: /atelier-theme dark|light", "warning");
				return;
			}
			const result = ctx.ui.setTheme(`omk-atelier-${variant}`);
			if (!result.success) ctx.ui.notify(result.error ?? "Atelier theme could not be loaded", "error");
		},
	});
}
