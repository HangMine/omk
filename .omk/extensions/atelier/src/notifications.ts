import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { AtelierExtensionDependencies } from "../vendor/extensions/index.ts";

const POWERSHELL = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";

/** WSL forwards only the notification payload to the native Windows delivery path. */
export function wslNotificationDependencies(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): AtelierExtensionDependencies {
	if (platform !== "linux" || !env.WSL_DISTRO_NAME || !existsSync(POWERSHELL)) return {};
	return {
		notificationPlatform: "win32",
		spawnNotificationProcess: (command, args, options) =>
			spawn(command === "powershell.exe" ? POWERSHELL : command, args, {
				...options,
				env: {
					...options.env,
					WSLENV: [options.env?.WSLENV, "PI_ATELIER_NOTIFICATION_TITLE", "PI_ATELIER_NOTIFICATION_BODY"]
						.filter(Boolean)
						.join(":"),
				},
			}),
	};
}
