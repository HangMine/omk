import { inflateSync } from "node:zlib";
import { setCapabilities, setCellDimensions, Text, TUI, visibleWidth } from "omk-tui";
import { afterEach, describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../../../packages/tui/test/virtual-terminal.ts";
import { stripTerminalSequences } from "../src/compat.ts";
import { createImageCompositorBinding } from "../vendor/src/image-compositor.ts";
import { createPalette } from "../vendor/src/palette.ts";
import { subagentCostChart } from "../vendor/src/subagent-cost-chart.ts";
import { renderCostImage } from "../vendor/src/subagent-cost-image.ts";
import { emptySubagentUsage } from "../vendor/src/subagent-usage.ts";

const curves = [
	{
		id: "owned",
		points: [
			{ u: 0, v: 0 },
			{ u: 1, v: 1 },
		],
		color: [20, 180, 200] as const,
		opacity: 0.9,
	},
];
afterEach(() => {
	setCapabilities({ images: null, trueColor: false, hyperlinks: false });
	setCellDimensions({ widthPx: 9, heightPx: 18 });
});

describe("terminal graphics protocol and real OMK compositor", () => {
	it("emits a bounded decodable RGBA PNG through the actual Kitty encoder and reuses placement", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 9, heightPx: 18 });
		const owner = {};
		const rows = renderCostImage(owner, curves, 60, 10);
		expect(rows).toBeDefined();
		expect(renderCostImage(owner, curves, 60, 10)).toBe(rows);
		const chunks = [...(rows?.join("") ?? "").matchAll(/\u001b_G([^;]*);([^\u001b]*)\u001b\\/g)];
		expect(chunks.length).toBeGreaterThan(0);
		const first = chunks[0];
		if (!first) throw new Error("Kitty transmit absent");
		expect(first[1]).toContain("f=100");
		const png = Buffer.from(chunks.map((chunk) => chunk[2]).join(""), "base64");
		expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
		const width = png.readUInt32BE(16),
			height = png.readUInt32BE(20);
		expect(width).toBeLessThanOrEqual(1400);
		expect(height).toBeLessThanOrEqual(800);
		const compressed: Buffer[] = [];
		for (let offset = 8; offset < png.length; ) {
			const size = png.readUInt32BE(offset);
			if (png.toString("ascii", offset + 4, offset + 8) === "IDAT")
				compressed.push(png.subarray(offset + 8, offset + 8 + size));
			offset += size + 12;
		}
		const pixels = inflateSync(Buffer.concat(compressed));
		expect(pixels.length).toBe((width * 4 + 1) * height);
		expect(pixels.some((value) => value > 0)).toBe(true);
		const changed = renderCostImage(owner, curves, 40, 6)?.join("") ?? "";
		expect(changed).toContain(/i=(\d+)/.exec(first[1])?.[0]);
	});
	it.each([null, "iterm2"] as const)("uses bounded readable cost text when image capability is %s", (images) => {
		setCapabilities({ images, trueColor: false, hyperlinks: false });
		expect(renderCostImage({}, curves, 50, 6)).toBeUndefined();
		const snapshot = {
			...emptySubagentUsage(),
			costHistory: [
				{
					id: "owned:0",
					runId: "owned",
					stepIndex: 0,
					agent: "reader",
					startedAt: 0,
					points: [
						{ at: 0, cost: 0 },
						{ at: 500, cost: 0.1 },
					],
					partial: false,
				},
			],
		};
		const rows = subagentCostChart(snapshot, 50, 3, false, createPalette({ fg: (_role, text) => text }, false), {
			imageOwner: {},
		});
		expect(stripTerminalSequences(rows.join("\n"))).toContain("$0.100");
		for (const row of rows) {
			expect(row).not.toContain("\u001b_G");
			expect(visibleWidth(row)).toBeLessThanOrEqual(50);
		}
	});
	it.each(["\u001b_Ga=T,f=100,r=1;AA==\u001b\\", "\u001b]1337;File=inline=1:AA==\u0007"])(
		"hides graphics under a real capturing overlay and restores after close",
		(image) => {
			const terminal = new VirtualTerminal(80, 24),
				tui = new TUI(terminal);
			const binding = createImageCompositorBinding(tui);
			const composite = Reflect.get(tui, "compositeOverlays");
			const frame = (): string => {
				const rows: unknown = Reflect.apply(composite, tui, [[`content ${image}`], 80, 24]);
				if (!Array.isArray(rows)) throw new Error("Unexpected compositor frame");
				return rows.join("\n");
			};
			expect(frame()).toContain(image);
			const modal = tui.showOverlay(new Text("MODAL", 0, 0), { width: 40, anchor: "top-left" });
			expect(frame()).toContain("MODAL");
			expect(frame()).not.toContain(image);
			modal.hide();
			expect(frame()).toContain(image);
			binding.dispose();
			terminal.stop();
		},
	);
});
