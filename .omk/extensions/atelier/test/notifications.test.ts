import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { wslNotificationDependencies } from "../src/notifications.ts";
import { createCompletionNotifier, type NotificationProcess } from "../vendor/src/completion-notifier.ts";

const { spawn, exists } = vi.hoisted(() => ({ spawn: vi.fn(), exists: vi.fn(() => true) }));
vi.mock("node:child_process", () => ({ spawn }));
vi.mock("node:fs", () => ({ existsSync: exists }));
class Child extends EventEmitter implements NotificationProcess {
	kill = vi.fn(() => true);
	unref = vi.fn();
}
afterEach(() => {
	vi.useRealTimers();
	vi.clearAllMocks();
});

function start(platform: NodeJS.Platform) {
	const child = new Child();
	spawn.mockReturnValue(child);
	const notifier = createCompletionNotifier({ platform, spawn, isEnabled: () => true });
	return { child, notifier };
}

describe("native completion notification boundary", () => {
	it("keeps user text out of executable macOS and Windows scripts", () => {
		for (const platform of ["darwin", "win32"] as const) {
			const { notifier, child } = start(platform);
			notifier.turnSettled({ projectName: "\u001b[31mproject", sessionName: '"; exit 99 #\n한국어' });
			const [command, args, options] = spawn.mock.calls.at(-1) ?? [];
			expect(command).toBe(platform === "darwin" ? "osascript" : "powershell.exe");
			if (platform === "darwin") expect(args.slice(0, -2).join(" ")).not.toContain("exit 99");
			else {
				expect(args.join(" ")).not.toContain("exit 99");
				expect(options.env.PI_ATELIER_NOTIFICATION_BODY).toContain("exit 99");
			}
			child.emit("exit", 0);
			notifier.reset();
			expect(child.kill).not.toHaveBeenCalled();
		}
	});
	it("deduplicates delivery and cancels exactly once at timeout/reset", () => {
		vi.useFakeTimers();
		const { notifier, child } = start("darwin");
		notifier.turnSettled({ projectName: "omk" });
		notifier.turnSettled({ projectName: "omk" });
		expect(spawn).toHaveBeenCalledOnce();
		vi.advanceTimersByTime(5000);
		notifier.reset();
		expect(child.kill).toHaveBeenCalledOnce();
	});
	it("only routes WSL to an available Windows executable and forwards bounded message variables", () => {
		const child = new Child();
		spawn.mockReturnValue(child);
		const host = wslNotificationDependencies("linux", { WSL_DISTRO_NAME: "Ubuntu", WSLENV: "KEEP/u" });
		expect(host.notificationPlatform).toBe("win32");
		host.spawnNotificationProcess?.("powershell.exe", ["-NoProfile"], {
			env: { PI_ATELIER_NOTIFICATION_TITLE: "title", PI_ATELIER_NOTIFICATION_BODY: "body", WSLENV: "KEEP/u" },
		});
		expect(spawn).toHaveBeenLastCalledWith(
			"/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
			["-NoProfile"],
			expect.objectContaining({
				env: expect.objectContaining({ WSLENV: "KEEP/u:PI_ATELIER_NOTIFICATION_TITLE:PI_ATELIER_NOTIFICATION_BODY" }),
			}),
		);
		expect(wslNotificationDependencies("linux", {})).toEqual({});
		expect(wslNotificationDependencies("darwin", { WSL_DISTRO_NAME: "ignored" })).toEqual({});
		exists.mockReturnValueOnce(false);
		expect(wslNotificationDependencies("linux", { WSL_DISTRO_NAME: "Ubuntu" })).toEqual({});
	});
});
