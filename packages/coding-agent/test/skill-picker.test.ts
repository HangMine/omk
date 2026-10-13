import { stripVTControlCharacters } from "node:util";
import { CURSOR_MARKER, visibleWidth } from "omk-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Skill } from "../src/core/skills.ts";
import { SkillPickerComponent } from "../src/modes/interactive/components/skill-picker.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function skill(name: string, description = "Skill description"): Skill {
	return {
		name,
		description,
		filePath: `/fixture/${name}/SKILL.md`,
		baseDir: `/fixture/${name}`,
		sourceInfo: { path: `/fixture/${name}/SKILL.md`, source: "local", scope: "project", origin: "top-level" },
		disableModelInvocation: false,
	};
}

const catalog = [skill("browser", "Review screenshot layout"), skill("pdf", "Extract contract clauses")];
const text = (picker: SkillPickerComponent): string => stripVTControlCharacters(picker.render(80).join("\n"));
beforeEach(() => initTheme("dark"));

describe("skill picker", () => {
	it("matches a case-insensitive description and confirms the discovered skill", () => {
		const select = vi.fn();
		const picker = new SkillPickerComponent(catalog, { select, cancel: vi.fn() }, "LAYOUT");
		picker.handleInput("\r");
		expect(select).toHaveBeenCalledWith(catalog[0]);
		expect(text(picker)).toContain("Skills (1/2)");
	});

	it("updates matches from typed search rather than loading skill bodies", () => {
		const select = vi.fn();
		const picker = new SkillPickerComponent(catalog, { select, cancel: vi.fn() });
		picker.handleInput("clauses");
		picker.handleInput("\r");
		expect(select).toHaveBeenCalledWith(catalog[1]);
	});

	it("shows source and explicit-only status without hiding user-invocable skills", () => {
		const selected = { ...catalog[1], disableModelInvocation: true };
		const select = vi.fn();
		const picker = new SkillPickerComponent([selected], { select, cancel: vi.fn() });
		expect(text(picker)).toContain("project / local / explicit invocation only");
		expect(text(picker)).toContain("/fixture/pdf/SKILL.md");
		picker.handleInput("\r");
		expect(select).toHaveBeenCalledWith(selected);
	});

	it("navigates with arrows and updates the selected metadata preview", () => {
		const select = vi.fn();
		const picker = new SkillPickerComponent(catalog, { select, cancel: vi.fn() });
		picker.handleInput("\x1b[B");
		expect(text(picker)).toContain("/fixture/pdf/SKILL.md");
		picker.handleInput("\r");
		expect(select).toHaveBeenCalledWith(catalog[1]);
	});

	it("pages through a large catalog while keeping rendering bounded", () => {
		const largeCatalog = Array.from({ length: 1000 }, (_, i) => skill(`skill-${String(i).padStart(4, "0")}`));
		const select = vi.fn();
		const picker = new SkillPickerComponent(largeCatalog, { select, cancel: vi.fn() });
		picker.handleInput("\x1b[6~");
		expect(picker.render(80).length).toBeLessThanOrEqual(20);
		picker.handleInput("\r");
		expect(select).toHaveBeenCalledWith(largeCatalog[8]);
	});

	it.each([{ skills: [] }, { skills: catalog }])(
		"keeps an empty result open on Enter and lets Escape cancel",
		({ skills }) => {
			const select = vi.fn();
			const cancel = vi.fn();
			const picker = new SkillPickerComponent(skills, { select, cancel }, "zzzz-no-match");
			expect(text(picker)).toContain("No matching skills");
			picker.handleInput("\r");
			expect(select).not.toHaveBeenCalled();
			picker.handleInput("\x1b");
			expect(cancel).toHaveBeenCalledOnce();
		},
	);

	it.each([1, 2, 10, 40, 80])("fits every rendered line within %i columns", (width) => {
		const picker = new SkillPickerComponent([skill("한글-long-name", "안내 ".repeat(300))], {
			select: vi.fn(),
			cancel: vi.fn(),
		});
		expect(picker.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
		expect(picker.render(width).length).toBeLessThanOrEqual(20);
	});

	it("propagates focus to the search input for IME cursor positioning", () => {
		const picker = new SkillPickerComponent(catalog, { select: vi.fn(), cancel: vi.fn() });
		picker.focused = true;
		expect(picker.render(80).some((line) => line.includes(CURSOR_MARKER))).toBe(true);
		picker.focused = false;
		expect(picker.render(80).some((line) => line.includes(CURSOR_MARKER))).toBe(false);
	});

	it("does not execute selection or cancellation control bytes inside chunked paste", () => {
		const select = vi.fn();
		const cancel = vi.fn();
		const picker = new SkillPickerComponent(catalog, { select, cancel });
		picker.handleInput("\x1b[200~layout");
		picker.handleInput("\r");
		picker.handleInput("\x1b");
		picker.handleInput("\x1b[201");
		picker.handleInput("~");
		expect(select).not.toHaveBeenCalled();
		expect(cancel).not.toHaveBeenCalled();
	});

	it("rebuilds theme colors without resetting selection when invalidated", () => {
		const select = vi.fn();
		const picker = new SkillPickerComponent(catalog, { select, cancel: vi.fn() });
		picker.handleInput("\x1b[B");
		const before = picker.render(80);
		initTheme("light");
		picker.invalidate();
		expect(picker.render(80)).not.toEqual(before);
		picker.handleInput("\r");
		expect(select).toHaveBeenCalledWith(catalog[1]);
	});

	it("allows editing an initial search at its end", () => {
		const picker = new SkillPickerComponent(catalog, { select: vi.fn(), cancel: vi.fn() }, "lay");
		picker.handleInput("out");
		expect(text(picker)).toContain("> layout");
		expect(text(picker)).toContain("Skills (1/2)");
	});

	it("strips terminal escape sequences from pasted search text", () => {
		const picker = new SkillPickerComponent(catalog, { select: vi.fn(), cancel: vi.fn() });
		picker.handleInput("\x1b[200~layout\x1b]52;c;payload\x07\x1b[2J\x1b[201~");
		const rendered = picker.render(80).join("\n");
		expect(rendered).not.toContain("\x1b]52");
		expect(rendered).not.toContain("\x1b[2J");
	});

	it("strips terminal control sequences from discovered metadata", () => {
		const unsafe = skill("safe", "Review\x1b]52;c;payload\x07\x1b[2J screenshot");
		const picker = new SkillPickerComponent([unsafe], { select: vi.fn(), cancel: vi.fn() });
		const rendered = picker.render(80).join("\n");
		expect(rendered).not.toContain("\x1b]52");
		expect(rendered).not.toContain("\x1b[2J");
	});
});
