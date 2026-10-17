import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { visibleWidth } from "omk-tui";
import type { ExtensionContext } from "open-multi-agent-kit";
import { describe, expect, it } from "vitest";
import { loadThemeFromPath } from "../../../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { compositeTuiLine, stripTerminalSequences } from "../src/compat.ts";
import { liveTheme } from "../src/theme.ts";
import { resolveConfig } from "../vendor/src/config.ts";
import { aggregateMetrics } from "../vendor/src/metrics.ts";
import { createPalette } from "../vendor/src/palette.ts";
import { reconstructTodos, todosFromDetails } from "../vendor/src/todos.ts";

function luminance(hex: string) {
	const channels =
		hex
			.slice(1)
			.match(/../g)
			?.map((part) => {
				const value = Number.parseInt(part, 16) / 255;
				return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
			}) ?? [];
	return (channels[0] ?? 0) * 0.2126 + (channels[1] ?? 0) * 0.7152 + (channels[2] ?? 0) * 0.0722;
}

describe("Atelier data boundaries and themes", () => {
	it("follows replacement themes while retired contexts retain their last palette", () => {
		let current = loadThemeFromPath(resolve("themes/omk-atelier-dark.json"), "truecolor");
		let retired = false;
		const ui = {
			get theme() {
				if (retired) throw new Error("stale ctx");
				return current;
			},
		};
		const theme = liveTheme({ ui } as Pick<ExtensionContext, "ui">);
		expect(theme.name).toBe("omk-atelier-dark");
		current = loadThemeFromPath(resolve("themes/omk-atelier-light.json"), "truecolor");
		expect(theme.fg("text", "live")).toBe(current.fg("text", "live"));
		retired = true;
		expect(theme.name).toBe("omk-atelier-light");
	});
	it.each(["dark", "light"])("loads every %s theme token and meets text/boundary contrast floors", (variant) => {
		const path = resolve(`themes/omk-atelier-${variant}.json`);
		const theme = loadThemeFromPath(path, "truecolor");
		const data: { vars: Record<string, string>; colors: Record<string, string> } = JSON.parse(
			readFileSync(path, "utf8"),
		);
		const base: { colors: Record<string, string> } = JSON.parse(
			readFileSync(resolve("../../../packages/coding-agent/src/modes/interactive/theme/dark.json"), "utf8"),
		);
		expect(Object.keys(data.colors).sort()).toEqual(Object.keys(base.colors).sort());
		for (const [role, value] of Object.entries(data.colors)) {
			if (role.endsWith("Bg")) continue;
			for (const background of ["paper", "surface", "selected"]) {
				const a = luminance(data.vars[value] ?? value),
					b = luminance(data.vars[background] ?? "");
				const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
				expect(ratio, `${variant} ${role} on ${background}`).toBeGreaterThanOrEqual(
					/border|mdHr/i.test(role) ? 3 : 4.5,
				);
			}
		}
		const palette = createPalette(theme, true);
		expect(palette.paint("primary", "text")).toBe(theme.fg("text", "text"));
		expect(palette.paint("warning", "text")).toBe(theme.fg("warning", "text"));
	});
	it("rejects invalid accounting instead of inventing observed zero", () => {
		const invalid = aggregateMetrics(
			[{ usage: { input: -1, output: 40, cacheRead: 50, cacheWrite: 0, cost: { total: -1 } } }],
			{ subscription: false, autoCompact: null },
		);
		expect(invalid.usageAvailable).toBe(false);
		expect(invalid.costAvailable).toBe(false);
	});
	it("uses real usage and does not turn unknown cost into observed zero", () => {
		const metrics = aggregateMetrics([{ usage: { input: 100, output: 40, cacheRead: 50, cacheWrite: 0 } }], {
			subscription: false,
			autoCompact: null,
		});
		expect(metrics.input).toBe(100);
		expect(metrics.costAvailable).toBe(false);
		expect(metrics.contextPercent).toBeNull();
	});
	it("normalizes native TODO, preserves blocked labels, and rejects malformed items", () => {
		expect(todosFromDetails({ items: [{ id: "x", label: "waiting", status: "blocked" }] })).toEqual([
			{ id: 1, text: "[blocked] waiting", status: "pending" },
		]);
		expect(todosFromDetails({ items: [{ id: "x", label: "waiting", status: "unknown" }] })).toBeUndefined();
		expect(todosFromDetails({ tasks: [{ id: 1, subject: "gone", status: "deleted" }] })).toEqual([]);
	});
	it("reconstructs native TODO only after its matching successful tool result", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							name: "update_todo",
							id: "call1",
							arguments: { items: [{ id: "x", label: "restore", status: "done" }] },
						},
					],
				},
			},
			{
				type: "message",
				message: { role: "toolResult", toolCallId: "call1", toolName: "update_todo", isError: false },
			},
		];
		const ctx = { sessionManager: { getBranch: () => entries } } as unknown as ExtensionContext;
		expect(reconstructTodos(ctx)).toEqual([{ id: 1, text: "restore", status: "completed" }]);
		const result = entries.find((entry) => entry.message.role === "toolResult");
		if (!result) throw new Error("Missing tool result fixture");
		result.message.isError = true;
		expect(reconstructTodos(ctx)).toEqual([]);
	});
	it("composes colored wide text within columns without leaking style", () => {
		const line = compositeTuiLine("\u001b[31m한국어 main", "\u001b[32mSIDE", 12, 6, 18);
		expect(visibleWidth(line)).toBe(18);
		expect(stripTerminalSequences(line)).toContain("SIDE");
		expect(stripTerminalSequences("\u001b_pi:c\u0007text")).toBe("text");
	});
	it("keeps plain text and validated config available", () => {
		const { config } = resolveConfig({ user: { nerdFont: false, contextWarning: 80, contextDanger: 90 } });
		expect(config.nerdFont).toBe(false);
		expect(config.contextWarning).toBe(80);
	});
});
