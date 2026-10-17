import { describe, expect, it } from "vitest";
import { wslNotificationDependencies } from "../src/notifications.ts";
import { createCompletionNotifier } from "../vendor/src/completion-notifier.ts";

// Opt-in: delivers one real local OS notification, never contacts a provider.
describe.skipIf(process.env.ATELIER_NATIVE_NOTIFICATION !== "1")("real WSL Windows notification", () => {
	it("delivers through the production adapter and observes native process exit", async () => {
		const host = wslNotificationDependencies();
		const spawn = host.spawnNotificationProcess;
		if (!spawn) throw new Error("WSL native Windows notification executable unavailable");
		const exits: Promise<unknown>[] = [];
		const notifier = createCompletionNotifier({
			platform: host.notificationPlatform,
			isEnabled: () => true,
			spawn: (command, args, options) => {
				const scriptIndex = args.indexOf("-Command") + 1;
				const script = args[scriptIndex];
				if (!script) throw new Error("Native notification script missing");
				const probe = [...args];
				probe[scriptIndex] =
					`${script}; if ($env:PI_ATELIER_NOTIFICATION_BODY -notlike '*Atelier verification 한국어*') { exit 9 }`;
				const child = spawn(command, probe, options);
				exits.push(
					new Promise((resolve, reject) => {
						child.once("exit", resolve);
						child.once("error", reject);
					}),
				);
				return child;
			},
		});
		try {
			notifier.turnSettled({ projectName: "OMK verification", sessionName: "Atelier verification 한국어" });
			expect(exits).toHaveLength(1);
			expect(await exits[0]).toBe(0);
		} finally {
			notifier.reset();
		}
	}, 15000);
});
