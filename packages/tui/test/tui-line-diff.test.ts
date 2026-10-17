import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findChangedLines } from "../src/tui-line-diff.ts";

describe("TUI line comparison", () => {
	it("ignores only presentation changes outside the viewport", () => {
		assert.deepEqual(findChangedLines(["old", "visible"], ["\x1b[31mold\x1b[0m", "\x1b[32mvisible"], 1), {
			firstChanged: 1,
			lastChanged: 1,
		});
	});
	it("keeps text replacement and deletion in immutable scrollback observable", () => {
		assert.deepEqual(findChangedLines(["old", "tail"], ["new", "tail"], 1), { firstChanged: 0, lastChanged: 0 });
		assert.deepEqual(findChangedLines(["old", "tail"], ["old"], 2), { firstChanged: 1, lastChanged: 1 });
	});
	it("does not discard hyperlink URL changes or image replacements", () => {
		const link = (url: string) => `\x1b]8;;${url}\x07label\x1b]8;;\x07`;
		assert.deepEqual(findChangedLines([link("https://old.example")], [link("https://new.example")], 1), {
			firstChanged: 0,
			lastChanged: 0,
		});
		assert.deepEqual(findChangedLines(["\x1b_Gi=1;old\x1b\\"], ["\x1b_Gi=2;new\x1b\\"], 1), {
			firstChanged: 0,
			lastChanged: 0,
		});
	});
});
