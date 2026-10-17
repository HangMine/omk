import { resolve } from "node:path";
import { visibleWidth } from "omk-tui";
import { describe, expect, it } from "vitest";
import { loadThemeFromPath } from "../../../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { stripTerminalSequences } from "../src/compat.ts";
import { resolveConfig } from "../vendor/src/config.ts";
import { renderFooterLine } from "../vendor/src/footer.ts";
import { aggregateMetrics } from "../vendor/src/metrics.ts";
import { buildSidebarSnapshot, renderSidebarLines } from "../vendor/src/sidebar.ts";

describe("session and provider usage share a sidebar", () => {
	it("keeps session totals and configured quotas visible at the default terminal height", () => {
		const { config } = resolveConfig({ user: { nerdFont: false } });
		config.sidebarPanelLayout.splice(5, 0, { id: "omk:subscription-usage", visible: true });
		const metrics = aggregateMetrics(
			[{ usage: { input: 100, output: 40, cacheRead: 50, cacheWrite: 10, cost: { total: 0.25 } } }],
			{
				subscription: true,
				autoCompact: true,
				context: { tokens: 1000, contextWindow: 10000, percent: 10 },
			},
		);
		const snapshot = buildSidebarSnapshot({
			cwd: "/tmp/project",
			branchEntryCount: 3,
			activeToolCount: 3,
			availableToolCount: 4,
			state: {
				modelId: "model",
				provider: "openai-codex",
				activity: "ready",
				dirty: false,
				workspacePulse: { status: "not-repo" },
				metrics,
				extensionStatuses: [],
			},
			sidebarPanels: [
				{
					id: "omk:subscription-usage",
					title: "QUOTA",
					source: "omk",
					rows: [],
					keyValues: [
						{ label: "CODEX 5H", value: "35% / 1h" },
						{ label: "CLAUDE 7D", value: "75% / 1d" },
					],
				},
			],
		});
		const theme = loadThemeFromPath(resolve("themes/omk-atelier-dark.json"), "truecolor");
		const lines = renderSidebarLines(snapshot, config, theme, 44, 44, { colorEnabled: false });
		expect(lines.join("\n")).toContain("CODEX 5H");
		expect(lines.join("\n")).toContain("Cache write");
		expect(stripTerminalSequences(lines.join("\n"))).toMatch(/Total\s+200/);
		expect(stripTerminalSequences(lines.join("\n"))).toMatch(/Cost\s+\$0.250/);
		for (const width of [20, 36, 44, 60])
			for (const height of [12, 24, 44, 60]) {
				const rendered = renderSidebarLines(snapshot, config, theme, width, height, { colorEnabled: false });
				expect(rendered).toHaveLength(height);
				for (const line of rendered) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
	});

	it("keeps setup notices out of the USAGE panel while real usage readouts stay", () => {
		const { config } = resolveConfig({ user: { nerdFont: false } });
		const metrics = aggregateMetrics(
			[{ usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } } }],
			{
				subscription: true,
				autoCompact: true,
				context: { tokens: 100, contextWindow: 10000, percent: 1 },
			},
		);
		const snapshot = buildSidebarSnapshot({
			cwd: "/tmp/project",
			branchEntryCount: 0,
			activeToolCount: 0,
			availableToolCount: 0,
			state: {
				modelId: "model",
				provider: "commandcode",
				activity: "ready",
				dirty: false,
				workspacePulse: { status: "not-repo" },
				metrics,
				extensionStatuses: ["telegram not configured", "codex 5h 92% / 2h"],
			},
		});
		const theme = loadThemeFromPath(resolve("themes/omk-atelier-dark.json"), "truecolor");
		const rendered = stripTerminalSequences(
			renderSidebarLines(snapshot, config, theme, 44, 60, { colorEnabled: false }).join("\n"),
		);
		expect(rendered).toContain("codex 5h 92% / 2h");
		expect(rendered).not.toContain("telegram not configured");
	});
});

describe("footer extension status text", () => {
	it("omits setup notices while real usage readouts stay on the line", () => {
		const { config } = resolveConfig({ user: { nerdFont: false } });
		const metrics = aggregateMetrics([], {
			subscription: true,
			autoCompact: true,
			context: { tokens: 0, contextWindow: 10000, percent: 0 },
		});
		const theme = loadThemeFromPath(resolve("themes/omk-atelier-dark.json"), "truecolor");
		const line = stripTerminalSequences(
			renderFooterLine(
				{
					modelId: "model",
					provider: "commandcode",
					activity: "ready",
					dirty: false,
					workspacePulse: { status: "not-repo" },
					metrics,
					extensionStatuses: ["telegram not configured", "codex 5h 92% / 2h"],
				},
				config,
				theme,
				200,
				{ colorEnabled: false },
			),
		);
		expect(line).toContain("codex 5h 92% / 2h");
		expect(line).not.toContain("telegram not configured");
	});
});
