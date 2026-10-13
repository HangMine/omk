import type { EditorComponent } from "omk-tui";
import type { Skill } from "../../core/skills.ts";
import { SkillPickerComponent } from "./components/skill-picker.ts";

/** Replace a leading skill invocation, or prefix it without rewriting the question. */
export function applyPickedSkill(editor: EditorComponent, skill: Skill, skills: readonly Skill[]): void {
	const draft = editor.getExpandedText?.() ?? editor.getText();
	const leading = /^(?:!skill:|\/skill:|!)([^\s]+)[ \t]?/.exec(draft);
	const previousName = leading?.[1];
	if (previousName === skill.name) return;
	const question =
		leading && skills.some((entry) => entry.name === previousName) ? draft.slice(leading[0].length) : draft;
	editor.setText(`!skill:${skill.name} ${question}`);
}

export function createSkillPickerForDraft(
	editor: EditorComponent,
	skills: readonly Skill[],
	options: { readonly query: string; readonly done: () => void },
): SkillPickerComponent {
	return new SkillPickerComponent(
		skills,
		{
			select: (skill) => {
				applyPickedSkill(editor, skill, skills);
				options.done();
			},
			cancel: options.done,
		},
		options.query,
	);
}
