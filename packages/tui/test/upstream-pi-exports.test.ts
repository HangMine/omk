import assert from "node:assert";
import { describe, it } from "node:test";
import * as publicIndex from "../src/index.ts";

// Upstream Pi extensions import these from "@earendil-works/pi-tui", which OMK aliases to this
// index. A missing export arrives as `undefined` and throws on first use: pi-fff's CollapsedText
// render killed the TUI with "sliceByColumn is not a function"; pi-goal's safeTerminalText needs
// stripTerminalSequences.
describe("public index upstream pi-tui parity", () => {
	it("exports sliceByColumn", () => {
		assert.strictEqual(publicIndex.sliceByColumn("hello world", 6, 5), "world");
	});

	it("exports stripTerminalSequences with upstream semantics", () => {
		const styled = "\x1b[1mbold\x1b[0m \x1b]8;;https://x.dev\x07link\x1b]8;;\x1b\\ \x1b_pi:c\x07end";
		assert.strictEqual(publicIndex.stripTerminalSequences(styled), "bold link end");
		assert.strictEqual(publicIndex.stripTerminalSequences("plain\ttext"), "plain\ttext");
	});
});
