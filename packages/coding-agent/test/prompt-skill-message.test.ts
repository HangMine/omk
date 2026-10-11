import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createActiveSkillState } from "../src/core/active-skill-state.ts";
import {
	PROMPT_SKILLS_CUSTOM_TYPE,
	PROMPT_SKILLS_RELEVANT_LIMIT,
	PromptSkillFreeze,
	type PromptSkillTurnInput,
	shortHash,
} from "../src/core/prompt-skill-message.ts";
import type { Skill } from "../src/core/skills.ts";
import type { BuildSystemPromptOptions } from "../src/core/system-prompt.ts";

function skill(name: string, description: string, disableModelInvocation = false): Skill {
	return {
		name,
		description,
		filePath: `/skills/${name}/SKILL.md`,
		baseDir: `/skills/${name}`,
		sourceInfo: { path: `/skills/${name}/SKILL.md`, source: "test", scope: "user", origin: "top-level" },
		disableModelInvocation,
	};
}

const SKILLS = [
	skill("programming", "Write, change and refactor code and files in any programming language."),
	skill("debugging", "Find and fix bugs: failing checks, wrong results, errors, verify each requirement."),
	skill("headroom", "Keep the context window small under context pressure."),
];

const BUDGET = { tokenizerMode: "fallback" } as unknown as NonNullable<BuildSystemPromptOptions["contextBudget"]>;

const BASE: BuildSystemPromptOptions = { cwd: "/w", skills: SKILLS };

function input(overrides: Partial<PromptSkillTurnInput> & { query?: string } = {}): PromptSkillTurnInput {
	const query = overrides.query ?? "Fix the failing parser bug in parse.py";
	return {
		base: BASE,
		provider: "faux",
		selection: createActiveSkillState([], [], undefined),
		defaults: [],
		skills: SKILLS,
		harnessQuery: query,
		budgetQuery: query,
		contextPressure: () => false,
		contextBudget: () => undefined,
		env: {},
		now: () => 1,
		...overrides,
	};
}

describe("PromptSkillFreeze (spec 050 R6)", () => {
	const dirs: string[] = [];
	afterEach(() => {
		while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
	});

	it("puts the first prompt's choice into the system options exactly as before and sends no message", () => {
		const queries: string[] = [];
		const turn = new PromptSkillFreeze().turn(
			input({
				provider: "xai",
				selection: createActiveSkillState(["programming"], [], undefined),
				defaults: ["programming"],
				contextBudget: (query) => {
					queries.push(query);
					return BUDGET;
				},
			}),
		);
		expect(turn.messages).toEqual([]);
		expect(turn.options.activeSkillNames).toEqual(["programming", "debugging"]);
		expect(turn.options.activeSkillSource).toBe("settings+grok-harness");
		expect(turn.options.contextBudget).toBe(BUDGET);
		expect(queries).toEqual(["Fix the failing parser bug in parse.py"]);
	});

	it("freezes the system options and moves a different later choice into one message", () => {
		const freeze = new PromptSkillFreeze();
		const first = freeze.turn(input({ provider: "xai" }));
		const queries: string[] = [];
		const second = freeze.turn(
			input({
				provider: "xai",
				query: "Write the summary file in python code",
				contextBudget: (query) => {
					queries.push(query);
					return undefined;
				},
			}),
		);
		expect(second.options).toEqual(first.options);
		expect(queries).toEqual(["Fix the failing parser bug in parse.py"]);
		expect(second.messages[0]?.customType).toBe(PROMPT_SKILLS_CUSTOM_TYPE);
		expect(second.messages[0]?.display).toBe(false);
		expect(second.messages[0]?.content).toBe(
			[
				"<prompt_skills>",
				"Skills for this prompt. They take precedence over the <active_skills> and <available_skills> choices in the system prompt, which were made for the first prompt of this session. Apply only when relevant and read full instructions before use.",
				'<active_skills source="grok-harness">',
				"  <name>programming</name>",
				"</active_skills>",
				"</prompt_skills>",
			].join("\n"),
		);
	});

	it("freezes again, without a message, after the session rebuilt its base options", () => {
		const freeze = new PromptSkillFreeze();
		freeze.turn(input({ provider: "xai" }));
		const rebuilt = { ...BASE };
		const turn = freeze.turn(
			input({ provider: "xai", base: rebuilt, query: "Write the summary file in python code" }),
		);
		expect(turn.messages).toEqual([]);
		expect(turn.options.activeSkillNames).toEqual(["programming"]);
		const next = freeze.turn(input({ provider: "xai", base: rebuilt }));
		expect(next.options.activeSkillNames).toEqual(["programming"]);
		expect(String(next.messages[0]?.content)).toContain("<name>debugging</name>");
	});

	it("freezes again when the operator's default active skills change", () => {
		const freeze = new PromptSkillFreeze();
		freeze.turn(
			input({ selection: createActiveSkillState(["programming"], [], undefined), defaults: ["programming"] }),
		);
		const turn = freeze.turn(input());
		expect(turn.messages).toEqual([]);
		expect(turn.options.activeSkillNames).toEqual([]);
	});

	it("sends no message when a later prompt makes the same choice", () => {
		const freeze = new PromptSkillFreeze();
		freeze.turn(input({ provider: "xai" }));
		expect(freeze.turn(input({ provider: "xai", query: "Fix another failing bug" })).messages).toEqual([]);
	});

	it("says so when a later prompt has no active skills", () => {
		const freeze = new PromptSkillFreeze();
		freeze.turn(input({ selection: createActiveSkillState([], ["debugging"], "bang") }));
		const content = String(freeze.turn(input()).messages[0]?.content);
		expect(content).toContain(
			'<active_skills source="prompt">\nNo skills are active for this prompt.\n</active_skills>',
		);
		const harness = new PromptSkillFreeze();
		harness.turn(input({ provider: "xai" }));
		const none = String(
			harness.turn(input({ provider: "xai", query: "Now write the summary to b.txt." })).messages[0]?.content,
		);
		expect(none).toContain('<active_skills source="grok-harness">\nNo skills are active for this prompt.');
	});

	it("moves an explicit `!skill` of a later prompt into the message", () => {
		const freeze = new PromptSkillFreeze();
		freeze.turn(input());
		const turn = freeze.turn(input({ selection: createActiveSkillState([], ["headroom"], "bang") }));
		expect(turn.options.activeSkillNames).toEqual([]);
		expect(String(turn.messages[0]?.content)).toContain('<active_skills source="bang">\n  <name>headroom</name>');
	});

	it("lists the most relevant model-invocable skills when contextBudget renders skills", () => {
		const many = [
			...Array.from({ length: 8 }, (_, i) => skill(`parser-${i}`, "parser tools for parse.py bugs")),
			skill("parser-hidden", "parser parse.py bugs", true),
		];
		const freeze = new PromptSkillFreeze();
		const budgeted = { base: { cwd: "/w", skills: many, contextBudget: BUDGET }, skills: many };
		freeze.turn(input({ ...budgeted, contextBudget: () => BUDGET }));
		const content = String(freeze.turn(input({ ...budgeted, contextBudget: () => BUDGET })).messages[0]?.content);
		expect(content.match(/<skill>/g)).toHaveLength(PROMPT_SKILLS_RELEVANT_LIMIT);
		expect(content).toContain("<location>/skills/parser-0/SKILL.md</location>");
		expect(content).not.toContain("parser-hidden");
		expect(content).not.toContain("<active_skills source");
		const noRead = { ...budgeted, base: { ...budgeted.base, selectedTools: ["bash"] } };
		const other = new PromptSkillFreeze();
		other.turn(input(noRead));
		expect(other.turn(input(noRead)).messages).toEqual([]);
	});

	it("logs harness-move records with hashes and counts only", () => {
		const dir = mkdtempSync(join(tmpdir(), "omk-prompt-skills-"));
		dirs.push(dir);
		const env = { OMK_RUN_LOG_DIR: dir };
		const freeze = new PromptSkillFreeze();
		freeze.turn(input({ provider: "xai", env }));
		freeze.turn(input({ provider: "xai", env, query: "Write the summary file in python code" }));
		const text = readFileSync(join(dir, "skill-select.jsonl"), "utf8");
		const records = text
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			type: "harness-move",
			source: "grok-harness",
			k: 1,
			skillHashes: [shortHash("programming")],
		});
		expect(text).not.toContain("programming");
		expect(text).not.toContain("/skills/");
	});
});
