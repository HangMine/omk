import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import { TUI } from "../src/tui.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

describe("complete bracketed paste interception", () => {
	it("consumes a split file drop once and retains the current prompt text", () => {
		const editor = new Editor(new TUI(new VirtualTerminal()), defaultEditorTheme);
		editor.setText("Explain this screenshot");
		const pastes: string[] = [];
		editor.onPaste = (text) => {
			pastes.push(text);
			return true;
		};
		editor.handleInput("\x1b[200~'/tmp/Screen ");
		editor.handleInput("Shot.png'\x1b[201~");
		assert.deepEqual(pastes, ["'/tmp/Screen Shot.png'"]);
		assert.equal(editor.getText(), "Explain this screenshot");
	});
	it("retains ordinary text paste and a single undo operation when the hook declines", () => {
		const editor = new Editor(new TUI(new VirtualTerminal()), defaultEditorTheme);
		editor.setText("before");
		editor.onPaste = () => false;
		editor.handleInput("\x1b[200~ pasted\ntext\x1b[201~");
		assert.equal(editor.getText(), "before pasted\ntext");
		editor.handleInput("\x1f");
		assert.equal(editor.getText(), "before");
	});
	it("processes trailing input after an intercepted paste", () => {
		const editor = new Editor(new TUI(new VirtualTerminal()), defaultEditorTheme);
		editor.onPaste = () => true;
		editor.handleInput("\x1b[200~/tmp/image.png\x1b[201~hello");
		assert.equal(editor.getText(), "hello");
	});
});
