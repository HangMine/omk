import { describe, expect, it } from "vitest";
import type { Skill } from "../src/core/skills.ts";
import { applyPickedSkill } from "../src/modes/interactive/skill-picker-draft.ts";

function skill(name: string): Skill {
	return {
		name,
		description: "Fixture",
		filePath: `/fixture/${name}/SKILL.md`,
		baseDir: `/fixture/${name}`,
		sourceInfo: { path: `/fixture/${name}/SKILL.md`, source: "local", scope: "user", origin: "top-level" },
		disableModelInvocation: false,
	};
}
const browser = skill("browser");
const pdf = skill("pdf");
const catalog = [browser, pdf];

function draftEditor(draft: string) {
	let text = draft;
	return {
		getText: () => text,
		setText: (next: string) => {
			text = next;
		},
		handleInput: () => {},
		render: () => [],
		invalidate: () => {},
	};
}

describe("picked skill draft insertion", () => {
	it.each(["", "question", "  question\n  keep spacing", "! shell-command", "$HOME", "/model"])(
		"prefixes without rewriting draft %j",
		(draft) => {
			const editor = draftEditor(draft);
			applyPickedSkill(editor, browser, catalog);
			expect(editor.getText()).toBe(`!skill:browser ${draft}`);
		},
	);

	it.each(["!skill:pdf", "/skill:pdf", "!pdf"])(
		"replaces leading %s rather than stacking skill invocations",
		(prefix) => {
			const editor = draftEditor(`${prefix} question\n  details`);
			applyPickedSkill(editor, browser, catalog);
			expect(editor.getText()).toBe("!skill:browser question\n  details");
		},
	);

	it("does not duplicate a selection already in the draft", () => {
		const editor = draftEditor("!skill:browser question");
		applyPickedSkill(editor, browser, catalog);
		expect(editor.getText()).toBe("!skill:browser question");
	});

	it("preserves unknown skill text rather than silently stripping it", () => {
		const editor = draftEditor("!skill:unknown question");
		applyPickedSkill(editor, browser, catalog);
		expect(editor.getText()).toBe("!skill:browser !skill:unknown question");
	});

	it("materializes large-paste markers before changing the editor text", () => {
		const editor = { ...draftEditor("[paste #1]"), getExpandedText: () => "pasted\nquestion" };
		applyPickedSkill(editor, browser, catalog);
		expect(editor.getText()).toBe("!skill:browser pasted\nquestion");
	});
});
