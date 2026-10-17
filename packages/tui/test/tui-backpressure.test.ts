import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Component, TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class SlowTerminal extends VirtualTerminal {
	blocked = false;
	writes = 0;
	override write(data: string): void {
		this.writes++;
		super.write(data);
	}
	getOutputStats() {
		return {
			writeCalls: this.writes,
			submittedBytes: 0,
			writeFalseCount: 0,
			drainCount: 0,
			errorCount: 0,
			peakWritableLength: 0,
			writableLength: this.blocked ? 1 : 0,
			backpressured: this.blocked,
		};
	}
}

describe("TUI output backpressure", () => {
	it("coalesces intermediate renders while blocked and paints the latest state after recovery", async () => {
		const terminal = new SlowTerminal(80, 10);
		const tui = new TUI(terminal);
		let text = "first";
		let renders = 0;
		const component: Component = {
			render: () => {
				renders++;
				return [text];
			},
			invalidate() {},
		};
		tui.addChild(component);
		tui.start();
		try {
			await terminal.waitForRender();
			const before = terminal.writes;
			terminal.blocked = true;
			for (let i = 0; i < 10; i++) {
				text = `intermediate-${i}`;
				tui.requestRender(i === 5);
				await terminal.waitForRender();
			}
			assert.equal(terminal.writes, before);
			assert.equal(renders, 1);
			text = "latest state";
			terminal.blocked = false;
			await terminal.waitForRender();
			assert.equal(renders, 2);
			assert.ok(terminal.getViewport().some((line) => line.includes(text)));
		} finally {
			tui.stop();
		}
	});
});
