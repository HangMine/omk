import type { ExtensionAPI, ExtensionContext } from "open-multi-agent-kit";
import { backgroundTaskIndicator, type IndicatorTask } from "./indicator.ts";

const REQUEST = "pi-background-tasks:request:v1";
const RESPONSE = "pi-background-tasks:response:v1";
const TERMINAL = "pi-background-tasks:terminal:v1";
const KEY = "omk-background-indicator";

export default function (omk: ExtensionAPI): void {
	let ctx: ExtensionContext | undefined;
	let interval: ReturnType<typeof setInterval> | undefined;
	let deadline: ReturnType<typeof setTimeout> | undefined;
	let pending: string | undefined;
	let sequence = 0;

	const clear = () => {
		ctx?.ui.setWidget(KEY, undefined);
		ctx?.ui.setStatus(KEY, undefined);
	};
	const refresh = () => {
		if (!ctx?.hasUI || pending) return;
		pending = `omk-bg-indicator-${++sequence}`;
		deadline = setTimeout(() => {
			pending = undefined;
			clear(); // No stale "running" claim if the service disappears.
		}, 5000);
		omk.events.emit(REQUEST, {
			schema_version: "pi-background-tasks.extension-request.v1",
			request_id: pending,
			operation: "status",
			payload: {},
		});
	};
	const unsubscribe = omk.events.on(RESPONSE, (value: unknown) => {
		if (!value || typeof value !== "object") return;
		const response = value as Record<string, unknown>;
		if (response.request_id !== pending || !pending) return;
		clearTimeout(deadline);
		pending = undefined;
		if (response.schema_version !== "pi-background-tasks.extension-response.v1" || response.ok !== true) {
			clear();
			return;
		}
		const result = response.result as { tasks?: unknown } | undefined;
		if (!Array.isArray(result?.tasks)) {
			clear();
			return;
		}
		const tasks: IndicatorTask[] = result.tasks.filter((task): task is IndicatorTask =>
			Boolean(task && typeof task === "object" && typeof task.id === "string" && typeof task.name === "string" &&
				typeof task.status === "string" && Number.isFinite(task.startTime)),
		);
		const lines = backgroundTaskIndicator(tasks);
		ctx?.ui.setWidget(KEY, lines, { placement: "aboveEditor" });
		ctx?.ui.setStatus(KEY, lines?.[0]);
	});
	const terminalUnsubscribe = omk.events.on(TERMINAL, refresh);
	omk.on("session_start", (_event, nextCtx) => {
		ctx = nextCtx;
		if (interval) clearInterval(interval);
		if (!ctx.hasUI) return;
		refresh();
		interval = setInterval(refresh, 1000);
	});
	omk.on("session_shutdown", () => {
		clearInterval(interval);
		clearTimeout(deadline);
		pending = undefined;
		unsubscribe();
		terminalUnsubscribe();
		clear();
		ctx = undefined;
	});
}
