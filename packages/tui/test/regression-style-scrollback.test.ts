import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Component, TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

describe("style-only scrollback updates", () => {
	it("does not reprint history when only colors and prompt markers change", async () => {
		const terminal = new VirtualTerminal(80, 10);
		const tui = new TUI(terminal);
		let styled = false;
		let count = 30;
		const component: Component = {
			render: () =>
				Array.from(
					{ length: count },
					(_, i) =>
						`${styled ? "\x1b[36m\x1b]133;A\x07" : ""}한국어 행-${String(i + 1).padStart(3, "0")}${styled ? "\x1b[0m" : ""}`,
				),
			invalidate() {},
		};
		tui.addChild(component);
		tui.start();
		try {
			await terminal.waitForRender();
			for (let i = 0; i < 5; i++) {
				styled = !styled;
				tui.requestRender();
				await terminal.waitForRender();
			}
			assert.equal(terminal.getScrollBuffer().filter((line) => line.includes("행-015")).length, 1);
			assert.equal(tui.fullRedraws, 1);
			count++;
			tui.requestRender();
			await terminal.waitForRender();
			assert.ok(terminal.getViewport().some((line) => line.includes("행-031")));
		} finally {
			tui.stop();
		}
	});
});
