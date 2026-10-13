import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Text } from "../src/components/text.ts";
import { TUI } from "../src/tui.ts";
import { WindowedContainer } from "../src/windowed-container.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

function transcript(): WindowedContainer {
	const container = new WindowedContainer();
	container.setLiveLineBudget(10);
	for (let i = 0; i < 300; i++) container.addChild(new Text(`line-${i}`, 0, 0));
	return container;
}

describe("virtual prefix seed configuration", () => {
	it("writes history beyond the ordinary repair budget when an explicit final transcript is supplied", async () => {
		const terminal = new VirtualTerminal(80, 10);
		const tui = new TUI(terminal);
		const container = transcript();
		for (let i = 300; i < 900; i++) container.addChild(new Text(`line-${i}`, 0, 0));
		container.setPrefixSeed(50);
		tui.addChild(container);
		tui.start();
		try {
			await terminal.waitForRender();
			assert.ok(!terminal.getScrollBuffer().some((line) => line.trimEnd() === "line-0"));
			tui.stop({ finalLines: container.renderAll(80) });
			await terminal.flush();
			const output = terminal.getScrollBuffer().map((line) => line.trimEnd());
			for (let i = 0; i < 900; i++) assert.ok(output.includes(`line-${i}`), `missing line-${i}`);
		} finally {
			tui.stop();
		}
	});
	it("zero seed emits only the live tail, while an unset seed retains full-history rendering", () => {
		const container = transcript();
		const full = container.render(80);
		assert.equal(full.length, 300);
		container.setPrefixSeed(0);
		assert.deepEqual(container.render(80), full.slice(-10));
	});

	it("applies an increased fixed seed after the prefix has frozen", () => {
		const container = transcript();
		container.setPrefixSeed(10);
		container.render(80);
		container.setPrefixSeed(30);
		assert.equal(container.render(80).length, 40);
	});

	it("recomputes the seed when terminal height grows below the live-budget floor", () => {
		const container = transcript();
		let rows = 10;
		container.setViewportRows(() => rows);
		container.setPrefixSeedViewport(2, () => rows);
		assert.equal(container.render(80).length, 140);
		rows = 20;
		assert.equal(container.render(80).length, 160);
	});

	it("treats a non-finite seed as unset rather than silently rendering an empty frame", () => {
		const container = transcript();
		container.setPrefixSeed(Number.NaN);
		assert.equal(container.render(80).length, 300);
	});
});
