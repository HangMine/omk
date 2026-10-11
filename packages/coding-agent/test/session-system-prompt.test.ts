import { describe, expect, it } from "vitest";
import { assembleSessionSystemPrompt } from "../src/core/session-system-prompt.ts";

function input(overrides: Partial<Parameters<typeof assembleSessionSystemPrompt>[0]> = {}) {
	return {
		cwd: "/tmp/project",
		toolNames: ["read", "bash", "ghost"],
		hasTool: (name: string) => name !== "ghost",
		toolPromptSnippets: new Map([
			["read", "Read a file"],
			["bash", "Run a command"],
			["ghost", "never"],
		]),
		toolPromptGuidelines: new Map([
			["read", ["Prefer offset/limit"]],
			["bash", ["Quote paths"]],
		]),
		customPrompt: undefined,
		appendSystemPrompt: ["loader extra"],
		providerAppend: "provider extra",
		skills: [],
		contextFiles: [],
		contextBudget: undefined,
		...overrides,
	};
}

describe("assembleSessionSystemPrompt", () => {
	it("filters unknown tools and keeps registration order for snippets and guidelines", () => {
		const assembled = assembleSessionSystemPrompt(input());
		expect(assembled.options.selectedTools).toEqual(["read", "bash"]);
		expect(assembled.options.toolSnippets).toEqual({ read: "Read a file", bash: "Run a command" });
		expect(assembled.options.promptGuidelines).toEqual(["Prefer offset/limit", "Quote paths"]);
	});

	it("joins loader and provider appends, and omits the section when both are empty", () => {
		expect(assembleSessionSystemPrompt(input()).options.appendSystemPrompt).toBe("loader extra\n\nprovider extra");
		expect(
			assembleSessionSystemPrompt(input({ appendSystemPrompt: [], providerAppend: undefined })).options
				.appendSystemPrompt,
		).toBeUndefined();
		expect(assembleSessionSystemPrompt(input({ appendSystemPrompt: undefined })).options.appendSystemPrompt).toBe(
			"provider extra",
		);
	});

	it("returns the exact options object the plan builder consumed", () => {
		const assembled = assembleSessionSystemPrompt(input());
		expect(assembled.options.cwd).toBe("/tmp/project");
		expect(assembled.prompt).toContain("Prefer offset/limit");
		expect(assembled.prompt).toContain("provider extra");
		expect(assembled.prompt.length).toBeGreaterThan(0);
		expect(assembled.cacheBoundary).toBeGreaterThan(0);
		expect(assembled.cacheBoundary).toBeLessThanOrEqual(assembled.prompt.length);
	});
});

describe("assembleSessionSystemPrompt skill-search mode (spec 050, #122 review)", () => {
	const skills = Array.from({ length: 30 }, (_, i) => ({
		name: `s${i}`,
		description: `Skill number ${i}.`,
		filePath: `/skills/s${i}/SKILL.md`,
		baseDir: `/skills/s${i}`,
		sourceInfo: {
			path: `/skills/s${i}/SKILL.md`,
			source: "test",
			scope: "user" as const,
			origin: "top-level" as const,
		},
		disableModelInvocation: false,
	}));
	const base = { skills, toolNames: ["read", "bash"] };
	const withForeign = { skills, toolNames: ["read", "bash", "skill_search"] };

	it("keeps <available_skills> and the exact prompt when a foreign tool is named skill_search", () => {
		const none = assembleSessionSystemPrompt(input(base));
		const foreign = assembleSessionSystemPrompt(input(withForeign));
		expect(foreign.prompt).toContain("<available_skills>");
		expect(foreign.prompt).toBe(none.prompt);
		expect(foreign.options.skillSearch).toBeUndefined();
	});

	it("switches to the search line only for the session's own decision with the tool active", () => {
		const on = assembleSessionSystemPrompt(input({ ...withForeign, skillSearch: true }));
		expect(on.options.skillSearch).toBe(true);
		expect(on.prompt).not.toContain("<available_skills>");
		const toolGone = assembleSessionSystemPrompt(input({ ...base, skillSearch: true }));
		expect(toolGone.options.skillSearch).toBeUndefined();
		expect(toolGone.prompt).toContain("<available_skills>");
	});
});
