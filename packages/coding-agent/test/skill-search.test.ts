import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fingerprintSkills } from "../src/core/skill-index-store.ts";
import {
	SKILL_CANDIDATE_K,
	SKILL_CANDIDATES_CUSTOM_TYPE,
	SKILL_INDEX_ALGORITHM_VERSION,
	SKILL_INDEX_FILE,
	SkillSearchSession,
	shortHash,
} from "../src/core/skill-search.ts";
import {
	SKILL_SEARCH_PROMPT_LINE,
	skillSearchActivation,
	skillSearchFlagOn,
	skillSearchSuggestOn,
} from "../src/core/skill-search-mode.ts";
import type { Skill } from "../src/core/skills.ts";
import { createSkillSearchToolDefinition } from "../src/core/tools/skill-search-tool.ts";

const dirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "omk-skill-search-"));
	dirs.push(dir);
	return dir;
}

/** Real SKILL.md files so the fingerprint sees size, mtime and inode. */
function writeSkills(root: string, entries: readonly [string, string][], hidden: readonly string[] = []): Skill[] {
	return entries.map(([name, description]) => {
		const dir = join(root, "skills", name);
		mkdirSync(dir, { recursive: true });
		const filePath = join(dir, "SKILL.md");
		writeFileSync(filePath, `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`);
		return {
			name,
			description,
			filePath,
			baseDir: dir,
			sourceInfo: { path: filePath, source: "test", scope: "user", origin: "top-level" },
			disableModelInvocation: hidden.includes(name),
		};
	});
}

function filler(count: number): [string, string][] {
	return Array.from({ length: count }, (_, i) => [`filler-${i}`, `General helper number ${i} for everyday chores.`]);
}

const NAMED: [string, string][] = [
	["pdf-forms", "Fill and extract PDF forms with pypdf."],
	["kubernetes-deploy", "Deploy services to a kubernetes cluster with helm charts."],
	["sql-tuning", "Tune slow SQL queries with explain plans and indexes."],
	["secret-pdf", "PDF redaction that only runs when asked explicitly."],
];

function session(root: string, skills: Skill[], logDir?: string) {
	const env: NodeJS.ProcessEnv = logDir ? { OMK_RUN_LOG_DIR: logDir } : {};
	return new SkillSearchSession({ skills: () => skills, agentDir: join(root, "agent"), env });
}

afterEach(() => {
	while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe("skill-search mode (spec 050 R1)", () => {
	const skills = (count: number) =>
		Array.from({ length: count }, (_, i) => ({ name: `s${i}`, disableModelInvocation: false }) as Skill);

	it("reads the flag values on/1/true/enable/enabled", () => {
		for (const value of ["on", "1", "true", "enable", "enabled", " ON "]) {
			expect(skillSearchFlagOn({ OMK_SKILL_SEARCH: value })).toBe(true);
		}
		for (const value of [undefined, "", "0", "off", "yes"]) {
			expect(skillSearchFlagOn({ OMK_SKILL_SEARCH: value })).toBe(false);
		}
		expect(skillSearchSuggestOn({})).toBe(true);
		expect(skillSearchSuggestOn({ OMK_SKILL_SEARCH_SUGGEST: "0" })).toBe(false);
	});

	it("is active only above 24 model-invocable skills with a read tool", () => {
		const on = { OMK_SKILL_SEARCH: "on" };
		expect(skillSearchActivation({}, skills(30), true)).toEqual({ active: false, inactiveReason: "flag_off" });
		expect(skillSearchActivation(on, skills(24), true)).toEqual({ active: false, inactiveReason: "few_skills" });
		const hidden = [...skills(24), { name: "x", disableModelInvocation: true } as Skill];
		expect(skillSearchActivation(on, hidden, true).inactiveReason).toBe("few_skills");
		expect(skillSearchActivation(on, skills(25), false)).toEqual({ active: false, inactiveReason: "no_read_tool" });
		expect(skillSearchActivation(on, skills(25), true)).toEqual({ active: true, inactiveReason: "none" });
	});

	it("has a fixed tool schema: query (<=512 chars) and limit 1..8", () => {
		const tool = createSkillSearchToolDefinition(async () => ({ text: "", details: {} as never }));
		expect(tool.name).toBe("skill_search");
		expect(JSON.stringify(tool.parameters)).toContain('"maxLength":512');
		expect(JSON.stringify(tool.parameters)).toContain('"maximum":8');
		expect(SKILL_SEARCH_PROMPT_LINE).toContain("skill_search");
	});
});

describe("SkillSearchSession (spec 050 R2–R5)", () => {
	it("returns name — short description — location lines, best first, without hidden skills", () => {
		const root = tempDir();
		const skills = writeSkills(root, [...NAMED, ...filler(30)], ["secret-pdf"]);
		const result = session(root, skills).search("fill a pdf form", 5);
		expect(result.text.split("\n")[0]).toBe(
			`pdf-forms — Fill and extract PDF forms with pypdf. — ${join(root, "skills", "pdf-forms", "SKILL.md")}`,
		);
		expect(result.text).not.toContain("secret-pdf");
		expect(result.details).toMatchObject({
			query: "fill a pdf form",
			queryHash: shortHash("fill a pdf form"),
			limit: 5,
		});
		expect(result.details.matchCount).toBeGreaterThanOrEqual(1);
		expect(result.details.candidates[0]).toMatchObject({ name: "pdf-forms", location: skills[0].filePath });
		expect(result.details.candidates[0].score).toBeGreaterThan(0);
		expect(session(root, skills).search("zzzz", 5).text).toBe("No matching skills.");
	});

	it("builds the index on first use, caches it on disk, and rebuilds when a SKILL.md changes", () => {
		const root = tempDir();
		const logDir = tempDir();
		const skills = writeSkills(root, [...NAMED, ...filler(30)]);
		const indexPath = join(root, "agent", "cache", SKILL_INDEX_FILE);
		const first = session(root, skills, logDir);
		expect(existsSync(indexPath)).toBe(false);
		first.search("sql", 3);
		expect(existsSync(indexPath)).toBe(true);
		first.search("pdf", 3);
		session(root, skills, logDir).search("sql", 3);
		writeFileSync(skills[2].filePath, "---\nname: sql-tuning\ndescription: changed\n---\n");
		session(root, skills, logDir).search("sql", 3);
		writeFileSync(indexPath, "{not json");
		session(root, skills, logDir).search("sql", 3);
		const index = readLog(logDir).filter((record) => record.type === "index");
		expect(index.map((record) => record.cacheHit)).toEqual([false, true, false, false]);
		expect(index[0]).toMatchObject({ skills: 34, docsUsed: 34, truncated: false });
	});

	it("rebuilds a cache written by another index algorithm version", () => {
		const root = tempDir();
		const logDir = tempDir();
		const skills = writeSkills(root, [...NAMED, ...filler(30)]);
		const indexPath = join(root, "agent", "cache", SKILL_INDEX_FILE);
		session(root, skills, logDir).search("sql", 3);
		const written = JSON.parse(readFileSync(indexPath, "utf8"));
		expect(written.fingerprint).toBe(fingerprintSkills(skills, SKILL_INDEX_ALGORITHM_VERSION));
		expect(fingerprintSkills(skills, SKILL_INDEX_ALGORITHM_VERSION + 1)).not.toBe(written.fingerprint);
		// Same SKILL.md files, an older algorithm: the entry text may differ, so it is a miss.
		const old = { ...written, fingerprint: fingerprintSkills(skills, SKILL_INDEX_ALGORITHM_VERSION - 1) };
		writeFileSync(indexPath, JSON.stringify(old));
		session(root, skills, logDir).search("sql", 3);
		const index = readLog(logDir).filter((record) => record.type === "index");
		expect(index.map((record) => record.cacheHit)).toEqual([false, false]);
	});

	it("removes stale .tmp files next to the index and keeps fresh ones", () => {
		const root = tempDir();
		const skills = writeSkills(root, [...NAMED, ...filler(30)]);
		const cacheDir = join(root, "agent", "cache");
		mkdirSync(cacheDir, { recursive: true });
		const stale = join(cacheDir, `${SKILL_INDEX_FILE}.111.tmp`);
		const fresh = join(cacheDir, `${SKILL_INDEX_FILE}.222.tmp`);
		const unrelated = join(cacheDir, "other.111.tmp");
		for (const file of [stale, fresh, unrelated]) writeFileSync(file, "{}");
		const old = new Date(Date.now() - 10 * 60_000);
		utimesSync(stale, old, old);
		utimesSync(unrelated, old, old);
		session(root, skills).search("sql", 3);
		expect(existsSync(stale)).toBe(false);
		expect(existsSync(fresh)).toBe(true);
		expect(existsSync(unrelated)).toBe(true);
		expect(existsSync(join(cacheDir, SKILL_INDEX_FILE))).toBe(true);
	});

	it("offers each skill once per session and nothing below the score floor (AC 6)", () => {
		const root = tempDir();
		const skills = writeSkills(root, [...NAMED, ...filler(30)]);
		const search = session(root, skills);
		const first = search.suggest("Tune this slow SQL query and fill the PDF form");
		expect(first?.customType).toBe(SKILL_CANDIDATES_CUSTOM_TYPE);
		expect(first?.display).toBe(false);
		const content = String(first?.content);
		expect(content).toContain("<name>sql-tuning</name>");
		expect(content).toContain("<name>pdf-forms</name>");
		expect(content.match(/<skill>/g)?.length).toBeLessThanOrEqual(SKILL_CANDIDATE_K);
		expect(search.suggest("Tune this slow SQL query and fill the PDF form")).toBeUndefined();
		expect(search.suggest("say hello")).toBeUndefined();
		expect(search.offeredVia("sql-tuning")).toBe("suggest");
	});

	it("ranks task candidates on content words, not on words like 'and' or 'to'", () => {
		const root = tempDir();
		const skills = writeSkills(root, [...NAMED, ...filler(30)]);
		const content = String(session(root, skills).suggest("Fill the PDF forms and save the result to a.txt")?.content);
		expect(content).toContain("<name>pdf-forms</name>");
		expect(content).not.toContain("kubernetes-deploy");
		expect(content).not.toContain("sql-tuning");
	});

	it("logs hashes and numbers only (AC 7)", () => {
		const root = tempDir();
		const logDir = tempDir();
		const marker = "zebracornmarker";
		const skills = writeSkills(root, [[`${marker}-skill`, `Handles ${marker} tasks.`], ...filler(30)]);
		const search = session(root, skills, logDir);
		search.search(`find ${marker} please`, 3);
		search.suggest(`do the ${marker} task`);
		const text = readFileSync(join(logDir, "skill-select.jsonl"), "utf8");
		expect(text).not.toContain(marker);
		expect(text).not.toContain(root);
		const records = readLog(logDir);
		expect(records.map((record) => record.type)).toEqual(["index", "search", "suggest"]);
		expect(records[1]).toMatchObject({
			queryTokens: 3,
			limit: 3,
			returned: 1,
			skillHashes: [shortHash(`${marker}-skill`)],
		});
		expect(records[2]).toMatchObject({ trigger: "task", todoKind: "none", k: 1, belowFloor: false });
	});
});

function readLog(dir: string): Record<string, unknown>[] {
	return readFileSync(join(dir, "skill-select.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
}
