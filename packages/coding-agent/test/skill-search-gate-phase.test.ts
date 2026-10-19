import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkillSearchGate } from "../src/core/skill-search-gate.ts";
import type { Skill } from "../src/core/skills.ts";
import { resetCurrentTodoState, setCurrentTodoState } from "../src/core/todo-runtime-state.ts";

const dirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "omk-skill-gate-phase-"));
	dirs.push(dir);
	return dir;
}

/** More than SKILL_PROMPT_COMPACT_THRESHOLD invocable skills so skill search activates. */
function writeSkills(root: string, count: number): Skill[] {
	return Array.from({ length: count }, (_, index) => {
		const name = `phase-skill-${index}`;
		const dir = join(root, "skills", name);
		mkdirSync(dir, { recursive: true });
		const filePath = join(dir, "SKILL.md");
		writeFileSync(
			filePath,
			`---\nname: ${name}\ndescription: Handles debugging and verification task number ${index}.\n---\nbody\n`,
		);
		return {
			name,
			description: `Handles debugging and verification task number ${index}.`,
			filePath,
			baseDir: dir,
			sourceInfo: { path: filePath, source: "test", scope: "user", origin: "top-level" },
			disableModelInvocation: false,
		};
	});
}

function readRecords(path: string): Record<string, unknown>[] {
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(() => {
	resetCurrentTodoState();
});

afterEach(() => {
	resetCurrentTodoState();
	while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe("SkillSearchGate todo phase wiring (spec 058 R4)", () => {
	it("passes the active todo kind into metacon ranking", async () => {
		const root = tempDir();
		const logDir = tempDir();
		const env: NodeJS.ProcessEnv = { OMK_SKILL_SELECT: "metacon", OMK_RUN_LOG_DIR: logDir };
		const skills = writeSkills(root, 30);
		const gate = new SkillSearchGate();
		gate.setup({ skills: () => skills, hasReadTool: true, agentDir: join(root, "agent"), env });
		expect(gate.active).toBe(true);
		setCurrentTodoState({
			items: [{ id: "1", label: "debug the failing test", status: "active", kind: "debug" }],
			updatedAt: 0,
		});

		await gate.candidates("debug the failing test", env);

		const records = readRecords(join(logDir, "skill-select.jsonl"));
		const suggested = records.find((record) => record.type === "suggest");
		expect(suggested).toMatchObject({ mode: "metacon", phase: "debug", phaseSource: "todo" });
	});

	it("keeps the task default when no todo is active", async () => {
		const root = tempDir();
		const logDir = tempDir();
		const env: NodeJS.ProcessEnv = { OMK_SKILL_SELECT: "metacon", OMK_RUN_LOG_DIR: logDir };
		const skills = writeSkills(root, 30);
		const gate = new SkillSearchGate();
		gate.setup({ skills: () => skills, hasReadTool: true, agentDir: join(root, "agent"), env });

		await gate.candidates("verify the change", env);

		const records = readRecords(join(logDir, "skill-select.jsonl"));
		const suggested = records.find((record) => record.type === "suggest");
		expect(suggested).toMatchObject({ phase: "task", phaseSource: "default" });
	});
});
