import { type Terminal, TUI } from "omk-tui";
import { describe, expect, it } from "vitest";
import { createSplitPaneController, parseSgrMouseEvent } from "../src/split-pane.ts";

function host(width = 140) {
	const writes: string[] = [];
	const terminal = {
		columns: width,
		rows: 36,
		kittyProtocolActive: false,
		start() {},
		stop() {},
		drainInput: async () => {},
		setProgress() {},
		write: (data: string) => {
			writes.push(data);
		},
		moveBy() {},
		hideCursor() {},
		showCursor() {},
		clearLine() {},
		clearFromCursor() {},
		clearScreen() {},
		setTitle() {},
	} satisfies Terminal;
	return { tui: new TUI(terminal), terminal, writes };
}

describe("OMK native Atelier layout", () => {
	it("restores the native gutter callback and does not erase a newer owner's gutter", () => {
		const { tui } = host();
		tui.setRightGutter(() => 30);
		const split = createSplitPaneController();
		split.attach(tui);
		split.show();
		expect(tui.contentWidth).toBe(96);
		split.hide();
		expect(tui.contentWidth).toBe(110);
		split.show();
		expect(tui.contentWidth).toBe(96);
		tui.setRightGutter(20);
		split.dispose();
		expect(tui.contentWidth).toBe(120);
	});
	it("releases resize input and mouse mode even when cleanup error reporting throws", () => {
		const { tui, writes } = host();
		const split = createSplitPaneController({
			subscribeInput: () => () => {
				throw new Error("unsubscribe");
			},
			onError: () => {
				throw new Error("report");
			},
		});
		split.attach(tui);
		split.show();
		split.beginResize();
		split.dispose();
		expect(tui.contentWidth).toBe(140);
		expect(writes.at(-1)).toContain("1006l");
	});
	it("reserves real transcript space and releases it on hide/dispose", () => {
		const { tui } = host();
		const split = createSplitPaneController();
		split.attach(tui);
		split.show();
		expect(tui.contentWidth).toBe(96);
		split.hide();
		expect(tui.contentWidth).toBe(140);
		split.show();
		split.dispose();
		expect(tui.contentWidth).toBe(140);
		expect(() => split.attach(tui)).toThrow(/disposed/);
	});
	it("keeps preferred width, auto hysteresis, and explicit hidden state across resizes", () => {
		const { tui, terminal } = host();
		const split = createSplitPaneController();
		split.attach(tui);
		split.show();
		split.setSidebarWidth(60);
		terminal.columns = 100;
		expect(tui.contentWidth).toBe(64);
		expect(split.getSidebarWidth()).toBe(60);
		terminal.columns = 91;
		expect(tui.contentWidth).toBe(91);
		split.setSidebarWidth(44);
		split.setMode("auto");
		terminal.columns = 123;
		expect(tui.contentWidth).toBe(123);
		terminal.columns = 131;
		expect(tui.contentWidth).toBe(131);
		terminal.columns = 132;
		expect(tui.contentWidth).toBe(88);
		split.hide();
		terminal.columns = 180;
		expect(tui.contentWidth).toBe(180);
		split.dispose();
	});
	it("owns resize input and restores width and mouse mode on cancel", () => {
		const { tui, writes } = host();
		let input: ((data: string) => unknown) | undefined;
		const split = createSplitPaneController({
			subscribeInput(handler) {
				input = handler;
				return () => {
					input = undefined;
				};
			},
		});
		split.attach(tui);
		split.show();
		expect(split.beginResize()).toBe(true);
		input?.("\u001b[D");
		expect(split.getSidebarWidth()).toBe(45);
		input?.("\u001b");
		expect(split.getSidebarWidth()).toBe(44);
		expect(input).toBeUndefined();
		expect(writes.at(-1)).toContain("1006l");
		split.beginResize();
		input?.("\u001b[<0;97;4M");
		input?.("\u001b[<32;90;4M");
		expect(split.getSidebarWidth()).toBe(51);
		input?.("\u001b[<0;90;4m");
		expect(split.isResizing()).toBe(false);
		split.dispose();
	});
	it("rejects malformed mouse reports and bad dimensions", () => {
		expect(parseSgrMouseEvent("\u001b[<0;0;1M")).toBeUndefined();
		expect(parseSgrMouseEvent("\u001b[<0;Infinity;1M")).toBeUndefined();
		const { tui, terminal } = host();
		const split = createSplitPaneController();
		split.attach(tui);
		split.show();
		split.setSidebarWidth(Number.NaN);
		expect(split.getSidebarWidth()).toBe(44);
		terminal.columns = 0;
		expect(split.getStatus().presentation).toBe("too-narrow");
		split.dispose();
	});
});
