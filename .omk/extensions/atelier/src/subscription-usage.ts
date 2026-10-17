import { truncateToWidth } from "omk-tui";
import type { ExtensionAPI, ReadonlyFooterDataProvider } from "open-multi-agent-kit";
import {
	registerSidebarPanel,
	type SidebarPanelContribution,
	type SidebarPanelKeyValueRow,
} from "../vendor/src/sidebar-panels.ts";
import { sanitizeInline } from "../vendor/src/text.ts";

export const SUBSCRIPTION_PANEL_ID = "omk:subscription-usage";
export interface SubscriptionUsageData {
	getSubscriptionUsage?(): readonly {
		readonly label: string;
		readonly windows: readonly { readonly label: string; readonly usedPercent: number; readonly resetsAt?: number }[];
		readonly message?: string;
	}[];
}

function resetTime(at: number | undefined, now: number): string {
	if (at === undefined || !Number.isFinite(at) || at < 0) return "";
	const minutes = Math.ceil(Math.max(0, at - now / 1000) / 60);
	if (minutes < 1) return "now";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60),
		rest = minutes % 60;
	return hours < 24
		? `${hours}h${rest ? `${rest}m` : ""}`
		: `${Math.floor(hours / 24)}d${hours % 24 ? `${hours % 24}h` : ""}`;
}

/** Presentation only: the host owns credentials, provider requests, cache and allowlist. */
export function createSubscriptionUsagePanel(
	pi: Pick<ExtensionAPI, "events">,
	data: ReadonlyFooterDataProvider | SubscriptionUsageData,
	now = Date.now,
) {
	let disposed = false;
	let summary = "";
	let previous = "";
	const panel = registerSidebarPanel(pi, { id: SUBSCRIPTION_PANEL_ID, title: "QUOTA", rows: [] });
	return {
		refresh() {
			if (disposed) return;
			const keyValues: SidebarPanelKeyValueRow[] = [];
			const summaries: string[] = [];
			try {
				const snapshots = "getSubscriptionUsage" in data ? data.getSubscriptionUsage?.() : undefined;
				if (!snapshots) {
					keyValues.push({ label: "Host", value: "host usage unavailable", valueRole: "muted" });
					summaries.push("Quota: host usage unavailable");
				} else {
					for (const snapshot of snapshots) {
						const label = sanitizeInline(snapshot.label);
						for (const window of snapshot.windows) {
							const name = `${label} ${sanitizeInline(window.label)}`;
							const used = window.usedPercent;
							const valid = Number.isFinite(used) && used >= 0 && used <= 100;
							const percent = valid ? `${Math.floor(used)}%` : "unavailable";
							const reset = resetTime(window.resetsAt, now());
							keyValues.push({
								label: name,
								value: `${percent}${reset ? ` / ${reset}` : ""}`,
								valueRole: !valid ? "muted" : used >= 90 ? "error" : used >= 75 ? "warning" : "primary",
							});
							summaries.push(`${name} ${percent}`);
						}
						if (snapshot.message || !snapshot.windows.length) {
							const message = sanitizeInline(snapshot.message ?? "usage unavailable");
							keyValues.push({ label, value: message, valueRole: "muted" });
							summaries.push(`${label} ${message}`);
						}
					}
				}
			} catch {
				keyValues.length = 0;
				summaries.length = 0;
				keyValues.push({ label: "Quota", value: "usage unavailable", valueRole: "muted" });
				summaries.push("Quota: usage unavailable");
			}
			summary = summaries.join(" | ");
			const bounded = keyValues.slice(0, 24).map((row) => ({
				...row,
				label: truncateToWidth(row.label, 120, "…"),
				value: truncateToWidth(row.value, 120, "…"),
			}));
			if (keyValues.length > 24)
				bounded[23] = { label: "More", value: `${keyValues.length - 23} quota rows`, valueRole: "muted" };
			const next: SidebarPanelContribution = {
				id: SUBSCRIPTION_PANEL_ID,
				title: "QUOTA",
				role: "accent",
				keyValues: bounded,
				rows: bounded.length
					? bounded.map((row) => ({
							text: truncateToWidth(`${row.label} ${row.value}`, 150, "…"),
							role: row.valueRole,
						}))
					: ["No configured subscription providers"],
			};
			const fingerprint = JSON.stringify(next);
			if (fingerprint !== previous) {
				previous = fingerprint;
				panel.update(next);
			}
		},
		summary: (width: number) => (disposed ? "" : truncateToWidth(summary, Math.max(0, width), "…")),
		dispose() {
			if (disposed) return;
			disposed = true;
			summary = "";
			panel.dispose();
		},
	};
}
