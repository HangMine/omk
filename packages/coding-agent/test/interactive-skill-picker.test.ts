import { Container, TUI } from "omk-tui";
import { describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KEYBINDINGS, KeybindingsManager } from "../src/core/keybindings.ts";
import type { Skill } from "../src/core/skills.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";

function invoke(name: string, context: object, ...args: unknown[]): void {
	const method: unknown = Reflect.get(InteractiveMode.prototype, name);
	if (typeof method !== "function") throw new Error(`Missing method ${name}`);
	method.apply(context, args);
}

const skills: Skill[] = [
	{
		name: "browser",
		description: "Review screenshot layout",
		filePath: "/fixture/browser/SKILL.md",
		baseDir: "/fixture/browser",
		sourceInfo: { path: "/fixture/browser/SKILL.md", source: "local", scope: "user", origin: "top-level" },
		disableModelInvocation: false,
	},
	{
		name: "pdf",
		description: "Extract contract clauses",
		filePath: "/fixture/pdf/SKILL.md",
		baseDir: "/fixture/pdf",
		sourceInfo: { path: "/fixture/pdf/SKILL.md", source: "local", scope: "project", origin: "top-level" },
		disableModelInvocation: true,
	},
];

function scenario() {
	initTheme("dark");
	const terminal = new VirtualTerminal(80, 30);
	const ui = new TUI(terminal);
	const editor = new CustomEditor(ui, getEditorTheme(), new KeybindingsManager());
	const context = {
		ui,
		editor,
		defaultEditor: editor,
		editorContainer: new Container(),
		session: {
			isCompacting: false,
			isStreaming: false,
			isBashRunning: false,
			resourceLoader: { getSkills: () => ({ skills }) },
		},
		settingsManager: { getEnableSkillCommands: () => true },
		showSelector: (create: (done: () => void) => { component: Container; focus: Container }) => {
			invoke("showSelector", context, create);
		},
		attachmentDraft: { ids: ["existing-image"], busy: false, paste: () => false },
		pendingPromptPayloads: [] as Array<{ text: string }>,
		showSkillPicker: vi.fn(),
		showWarning: vi.fn(),
		flushPendingBashComponents: vi.fn(),
		materializeDraftImages: () => [],
		isVisionCapable: () => true,
		isBangBashInput: () => false,
		updateEditorBorderColor: vi.fn(),
	};
	invoke("setupEditorSubmitHandler", context);
	return { editor, context, terminal };
}

describe("interactive skill picker entry points", () => {
	it.each(["/skills", "/skills screenshot"])("opens %s without submitting or consuming images", async (command) => {
		const { editor, context } = scenario();
		await editor.onSubmit?.(command);
		expect(context.showSkillPicker).toHaveBeenCalledWith(command.slice("/skills".length).trim());
		expect(context.pendingPromptPayloads).toEqual([]);
		expect(context.attachmentDraft.ids).toEqual(["existing-image"]);
	});

	it("advertises the picker in slash completion", () => {
		expect(BUILTIN_SLASH_COMMANDS.some((command) => command.name === "skills")).toBe(true);
	});

	it("offers a configurable skill-picker shortcut", () => {
		expect(Reflect.get(KEYBINDINGS, "app.skills.select")).toEqual({
			defaultKeys: "alt+s",
			description: "Open skill picker",
		});
	});

	it("lets operators rebind or disable the shortcut without losing the command fallback", () => {
		const rebound = new KeybindingsManager({ "app.skills.select": "ctrl+s" });
		const disabled = new KeybindingsManager({ "app.skills.select": [] });
		expect(rebound.matches("\x13", "app.skills.select")).toBe(true);
		expect(rebound.matches("\x1bs", "app.skills.select")).toBe(false);
		expect(disabled.matches("\x1bs", "app.skills.select")).toBe(false);
	});

	it("opens through Alt+S without replacing the draft", () => {
		const { editor, context } = scenario();
		editor.setText("draft question");
		invoke("setupKeyHandlers", context);
		editor.handleInput("\x1bs");
		expect(context.showSkillPicker).toHaveBeenCalledOnce();
		expect(editor.getText()).toBe("draft question");
	});

	it("does not hijack dollar input or pasted shortcut bytes", () => {
		const { editor, context } = scenario();
		invoke("setupKeyHandlers", context);
		editor.handleInput("$HOME");
		editor.handleInput("\x1b[200~literal");
		editor.handleInput("\x1bs");
		editor.handleInput("\x1b[201~");
		expect(context.showSkillPicker).not.toHaveBeenCalled();
		expect(editor.getText()).toContain("$HOME");
	});

	it("selects by description without submitting or losing a multiline draft", () => {
		const { editor, context } = scenario();
		editor.setText("Review this\n  keep spacing");
		invoke("showSkillPicker", context, "screenshot");
		expect(context.editorContainer.render(80).join("\n")).toContain("browser");
		context.editorContainer.children[0].handleInput?.("\r");
		expect(editor.getText()).toBe("!skill:browser Review this\n  keep spacing");
		expect(context.pendingPromptPayloads).toEqual([]);
		expect(context.attachmentDraft.ids).toEqual(["existing-image"]);
	});

	it("restores the editor and exact draft on cancel", () => {
		const { editor, context } = scenario();
		editor.setText("  Original\nquestion");
		invoke("showSkillPicker", context);
		context.editorContainer.children[0].handleInput?.("\x1b");
		expect(editor.getText()).toBe("  Original\nquestion");
		expect(context.editorContainer.children).toEqual([editor]);
	});

	it("routes real TUI keystrokes through selection and only sends on a separate submit", async () => {
		const { editor, context, terminal } = scenario();
		context.showSkillPicker.mockImplementation((query?: string) => invoke("showSkillPicker", context, query));
		invoke("setupKeyHandlers", context);
		context.editorContainer.addChild(editor);
		context.ui.addChild(context.editorContainer);
		context.ui.setFocus(editor);
		editor.setText("Review my screenshot");
		context.ui.start();
		try {
			terminal.sendInput("\x1bs");
			await terminal.waitForRender();
			expect(terminal.getViewport().join("\n")).toContain("Skills (2/2)");
			terminal.sendInput("screenshot");
			terminal.sendInput("\r");
			await terminal.waitForRender();
			expect(editor.getText()).toBe("!skill:browser Review my screenshot");
			expect(terminal.getViewport().join("\n")).not.toContain("Skills (1/2)");
			expect(context.pendingPromptPayloads).toEqual([]);
			terminal.sendInput("\r");
			expect(context.pendingPromptPayloads[0]?.text).toBe("!skill:browser Review my screenshot");
		} finally {
			context.ui.stop();
		}
	});

	it("lets one undo restore the question after a selection", () => {
		const { editor, context } = scenario();
		editor.setText("original question");
		invoke("showSkillPicker", context, "screenshot");
		context.editorContainer.children[0].handleInput?.("\r");
		editor.handleInput("\x1f");
		expect(editor.getText()).toBe("original question");
	});

	it("respects disabled skill commands without changing the draft", () => {
		const { editor, context } = scenario();
		context.settingsManager.getEnableSkillCommands = () => false;
		editor.setText("keep");
		invoke("showSkillPicker", context);
		expect(context.showWarning).toHaveBeenCalled();
		expect(editor.getText()).toBe("keep");
		expect(context.editorContainer.children).toEqual([]);
	});
});
