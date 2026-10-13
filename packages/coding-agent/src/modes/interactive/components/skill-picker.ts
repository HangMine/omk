import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	SelectList,
	Spacer,
	Text,
	truncateToWidth,
} from "omk-tui";
import type { Skill } from "../../../core/skills.ts";
import { stripAnsi } from "../../../utils/ansi.ts";
import { getSelectListTheme, theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

interface SkillPickerCallbacks {
	readonly select: (skill: Skill) => void;
	readonly cancel: () => void;
}

const VISIBLE_SKILLS = 8;
const plain = (text: string): string => stripAnsi(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

/** Browse the session's discovered metadata without loading or activating skill bodies. */
export class SkillPickerComponent extends Container implements Focusable {
	private readonly input = new Input();
	private readonly listContainer = new Container();
	private readonly details = new Container();
	private readonly title = new Text("", 0, 0);
	private readonly hint = new Text("", 0, 0);
	private readonly skills: Skill[];
	private readonly callbacks: SkillPickerCallbacks;
	private filteredSkills: Skill[] = [];
	private list: SelectList;
	private pasteTail = "";
	private pasting = false;

	get focused(): boolean {
		return this.input.focused;
	}
	set focused(value: boolean) {
		this.input.focused = value;
	}

	constructor(skills: readonly Skill[], callbacks: SkillPickerCallbacks, initialQuery = "") {
		super();
		this.callbacks = callbacks;
		this.skills = [...skills]
			.filter((skill) => skill.name !== "" && !/[\s\x00-\x1f\x7f-\x9f]/u.test(skill.name))
			.sort((a, b) => a.name.localeCompare(b.name));
		this.list = this.createList([]);
		this.input.handleInput(plain(initialQuery));
		this.addChild(new DynamicBorder());
		this.addChild(this.title);
		this.addChild(this.input);
		this.addChild(new Spacer(1));
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(this.details);
		this.addChild(this.hint);
		this.addChild(new DynamicBorder());
		this.filter();
	}

	private createList(skills: readonly Skill[]): SelectList {
		const list = new SelectList(
			skills.map((skill) => ({
				value: skill.name,
				label: skill.name,
				description: `[${skill.sourceInfo.scope}] ${plain(skill.description)}`,
			})),
			VISIBLE_SKILLS,
			getSelectListTheme(),
			{ minPrimaryColumnWidth: 16, maxPrimaryColumnWidth: 40 },
		);
		list.onSelect = (item) => {
			const skill = skills.find((entry) => entry.name === item.value);
			if (skill) this.callbacks.select(skill);
		};
		list.onCancel = this.callbacks.cancel;
		list.onSelectionChange = () => this.updateDetails();
		return list;
	}

	private filter(): void {
		const query = plain(this.input.getValue());
		if (query !== this.input.getValue()) this.input.setValue(query);
		const matches = fuzzyFilter(this.skills, query, (skill) => `${skill.name} ${plain(skill.description)}`);
		this.filteredSkills = matches;
		this.listContainer.clear();
		this.list = this.createList(matches);
		if (matches.length > 0) this.listContainer.addChild(this.list);
		else this.listContainer.addChild(new Text("No matching skills", 0, 0));
		this.invalidate();
	}

	private updateDetails(): void {
		this.details.clear();
		const selected = this.list.getSelectedItem();
		const skill = selected && this.skills.find((entry) => entry.name === selected.value);
		if (!skill) return;
		const invocation = skill.disableModelInvocation ? "explicit invocation only" : "on-demand";
		this.details.addChild(new Text(theme.fg("muted", plain(skill.description)), 0, 0));
		this.details.addChild(
			new Text(
				theme.fg("dim", `${skill.sourceInfo.scope} / ${plain(skill.sourceInfo.source)} / ${invocation}`),
				0,
				0,
			),
		);
		this.details.addChild(new Text(theme.fg("dim", plain(skill.filePath)), 0, 0));
	}

	override invalidate(): void {
		super.invalidate();
		this.title.setText(
			theme.fg("accent", theme.bold(`Skills (${this.filteredSkills.length}/${this.skills.length})`)),
		);
		this.hint.setText(
			rawKeyHint("↑↓", "navigate") +
				"  " +
				keyHint("tui.select.confirm", "insert") +
				"  " +
				keyHint("tui.select.cancel", "cancel"),
		);
		this.updateDetails();
	}

	override render(width: number): string[] {
		if (width < 1) return [];
		return this.children
			.flatMap((child) =>
				child === this.details
					? this.details.children.flatMap((detail, index) => detail.render(width).slice(0, index === 0 ? 2 : 1))
					: child
							.render(width)
							.slice(0, child === this.listContainer && this.filteredSkills.length > 0 ? VISIBLE_SKILLS + 1 : 1),
			)
			.map((line) => truncateToWidth(line, width, ""));
	}

	handleInput(data: string): void {
		if (this.pasting || data.includes("\x1b[200~")) {
			const chunk = this.pasteTail + data;
			this.pasting = !chunk.includes("\x1b[201~");
			this.pasteTail = this.pasting ? chunk.slice(-5) : "";
			this.input.handleInput(data);
			if (!this.pasting) this.filter();
			return;
		}
		const kb = getKeybindings();
		if (
			kb.matches(data, "tui.select.up") ||
			kb.matches(data, "tui.select.down") ||
			kb.matches(data, "tui.select.confirm") ||
			kb.matches(data, "tui.select.cancel")
		) {
			this.list.handleInput(data);
			return;
		}
		if (kb.matches(data, "tui.select.pageUp") || kb.matches(data, "tui.select.pageDown")) {
			const step = kb.matches(data, "tui.select.pageUp") ? -VISIBLE_SKILLS : VISIBLE_SKILLS;
			const selected = this.list.getSelectedItem();
			const index = this.filteredSkills.findIndex((skill) => skill.name === selected?.value);
			this.list.setSelectedIndex(index + step);
			this.updateDetails();
			return;
		}
		const previous = this.input.getValue();
		this.input.handleInput(data);
		if (previous !== this.input.getValue()) this.filter();
	}
}
