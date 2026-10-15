import type { TUI } from "omk-tui";
import { setKeybindings } from "omk-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as relevance from "../src/core/context-budget-relevance.ts";
import { createSystemPromptBudgetItems } from "../src/core/context-budget-system-prompt-items.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { Skill } from "../src/core/skills.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";
import { createTestResourceLoader } from "./utilities.ts";

const QUERY = "debug TypeScript model selection latency and test the prompt configuration";
const TOPICS = ["TypeScript model configuration", "Python data plotting", "debug prompt latency", "Docker networking"];

function skillCatalog(): Skill[] {
	return Array.from({ length: 80 }, (_, index) => ({
		name: `skill-${index}`,
		description: TOPICS[index % TOPICS.length],
		filePath: `/skills/${index}/SKILL.md`,
		baseDir: `/skills/${index}`,
		sourceInfo: { source: "test", scope: "user", origin: "top-level", path: `/skills/${index}` },
		disableModelInvocation: index === 79,
	}));
}

function rankedInactive(skills: Skill[], query: string): string[] {
	return skills
		.filter((skill) => !skill.disableModelInvocation && skill.name !== "skill-0")
		.sort((a, b) => relevance.scoreSkillRelevance(b, query) - relevance.scoreSkillRelevance(a, query))
		.slice(0, 15)
		.map((skill) => skill.name);
}

describe("model selection skill-ranking work", () => {
	const harnesses: Harness[] = [];

	beforeEach(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		vi.restoreAllMocks();
	});

	it("scores each inactive skill once while preserving ranking, ties and active/hidden filtering", () => {
		const skills = skillCatalog();
		const expected = rankedInactive(skills, QUERY);
		const score = vi.spyOn(relevance, "scoreSkillRelevance");
		const items = createSystemPromptBudgetItems(
			{
				contextFiles: [],
				skills,
				includeSkills: true,
				options: { queryContext: QUERY, activeSkillNames: ["skill-0"] },
			},
			100_000,
		);

		expect(
			items.filter((item) => item.priority === "low" && item.id.startsWith("skill:")).map((item) => item.id),
		).toEqual(expected.map((name) => `skill:${name}`));
		expect(items.find((item) => item.id === "skill:skill-0")?.priority).toBe("hard");
		expect(items.some((item) => item.id === "skill:skill-79")).toBe(false);
		expect(score).toHaveBeenCalledTimes(skills.length - 2);
	});

	it("recomputes scores for the next query instead of retaining stale model-switch rankings", () => {
		const skills = skillCatalog();
		const expected = rankedInactive(skills, "Python data plotting");
		const build = (queryContext: string) =>
			createSystemPromptBudgetItems(
				{ contextFiles: [], skills, includeSkills: true, options: { queryContext, activeSkillNames: ["skill-0"] } },
				100_000,
			);
		const score = vi.spyOn(relevance, "scoreSkillRelevance");
		build(QUERY);
		const items = build("Python data plotting");

		expect(
			items.filter((item) => item.priority === "low" && item.id.startsWith("skill:")).map((item) => item.id),
		).toEqual(expected.map((name) => `skill:${name}`));
		expect(score).toHaveBeenCalledTimes((skills.length - 2) * 2);
	});

	it("bounds ranking work through the real picker callback and AgentSession.setModel", async () => {
		const skills = skillCatalog();
		const harness = await createHarness({
			models: [{ id: "first" }, { id: "second" }],
			settings: { contextBudget: { enabled: true }, defaultActiveSkills: ["skill-0"] },
			resourceLoader: { ...createTestResourceLoader(), getSkills: () => ({ skills, diagnostics: [] }) },
		});
		harnesses.push(harness);
		harness.session.agent.state.messages.push({ role: "user", content: QUERY, timestamp: Date.now() });
		let selection: Promise<void> | undefined;
		const selector = new ModelSelectorComponent(
			{ requestRender: vi.fn() } as unknown as TUI,
			harness.session.model,
			harness.settingsManager,
			harness.session.modelRegistry,
			[],
			(model) => {
				selection = harness.session.setModel(model);
			},
			() => {},
			"second",
		);
		await Promise.resolve();
		expect(stripAnsi(selector.render(100).join("\n"))).toContain("second");
		const score = vi.spyOn(relevance, "scoreSkillRelevance");

		selector.handleInput("\r");
		expect(selection).toBeDefined();
		await selection;

		expect(harness.session.model?.id).toBe("second");
		expect(harness.settingsManager.getDefaultModel()).toBe("second");
		expect(harness.session.systemPrompt).toContain("<name>skill-0</name>");
		expect(score).toHaveBeenCalledTimes(skills.length - 2);
	});
});
