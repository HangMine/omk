import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RUN_LOG_DIR_ENV } from "../src/core/run-log.ts";
import { createEditTool } from "../src/core/tools/edit.ts";
import {
	classifyEditMatchFailure,
	EDIT_MATCH_RUN_LOG,
	editMatchObserver,
	editPathHash,
} from "../src/core/tools/edit-match-observe.ts";
import { EDIT_CASES } from "./edit-match-observe-cases.ts";

// Golden captured by running the same cases against main 9e03b40b77 (before this change).
const GOLDEN = JSON.parse(
	readFileSync(join(__dirname, "fixtures/edit-match-observe/golden-main.json"), "utf-8"),
) as Record<string, unknown>;

let dir: string;
let logDir: string;
let savedLogDir: string | undefined;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "omk-edit-obs-"));
	logDir = mkdtempSync(join(tmpdir(), "omk-edit-obs-log-"));
	savedLogDir = process.env[RUN_LOG_DIR_ENV];
});
afterEach(() => {
	if (savedLogDir === undefined) delete process.env[RUN_LOG_DIR_ENV];
	else process.env[RUN_LOG_DIR_ENV] = savedLogDir;
	vi.restoreAllMocks();
	rmSync(dir, { recursive: true, force: true });
	rmSync(logDir, { recursive: true, force: true });
});

const runCase = async (name: string) => {
	const c = EDIT_CASES.find((x) => x.name === name)!;
	const p = join(dir, `${c.name}.txt`);
	writeFileSync(p, c.file);
	const tool = createEditTool(dir);
	try {
		const r = await tool.execute("id", { path: `${c.name}.txt`, edits: c.edits });
		return { ok: true, content: r.content, details: r.details, file: readFileSync(p, "utf-8") };
	} catch (e) {
		return { ok: false, error: (e as Error).message, file: readFileSync(p, "utf-8") };
	}
};

const logLines = () => {
	try {
		return readFileSync(join(logDir, `${EDIT_MATCH_RUN_LOG}.jsonl`), "utf-8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
	} catch {
		return [];
	}
};

describe("edit match observation: tool output unchanged vs main", () => {
	for (const c of EDIT_CASES) {
		for (const logging of [false, true]) {
			it(`${c.name} (run log ${logging ? "on" : "off"}) is byte-identical to main`, async () => {
				if (logging) process.env[RUN_LOG_DIR_ENV] = logDir;
				else delete process.env[RUN_LOG_DIR_ENV];
				const got = await runCase(c.name);
				expect(JSON.stringify(got)).toBe(JSON.stringify(GOLDEN[c.name]));
			});
		}
	}
});

describe("edit match observation: run log lines", () => {
	beforeEach(() => {
		process.env[RUN_LOG_DIR_ENV] = logDir;
	});

	const expectations: [string, Record<string, unknown>][] = [
		["exact", { ok: true, edit_match_stage: 1, matchStages: [1], edits: 1 }],
		["fuzzy-trailing-ws", { ok: true, edit_match_stage: 2, matchStages: [2] }],
		["fuzzy-smart-quote", { ok: true, edit_match_stage: 2, matchStages: [2] }],
		["crlf-bom", { ok: true, edit_match_stage: 1 }],
		["multi", { ok: true, edit_match_stage: 2, matchStages: [1, 2], edits: 2 }],
		["not-found", { ok: false, reason: "not_found", editIndex: 0 }],
		["indent-only", { ok: false, reason: "indent_only", editIndex: 0 }],
		["duplicate", { ok: false, reason: "multiple_matches", editIndex: 0 }],
		["overlap", { ok: false, reason: "unknown", editIndex: null }],
		["no-op", { ok: false, reason: "unknown", editIndex: null }],
	];
	for (const [name, want] of expectations) {
		it(`${name} logs one edit_match line with pathHash`, async () => {
			await runCase(name);
			const lines = logLines();
			expect(lines).toHaveLength(1);
			expect(lines[0]).toMatchObject({ event: "edit_match", ...want });
			expect(lines[0].pathHash).toBe(editPathHash(join(dir, `${name}.txt`)));
			expect(lines[0].pathHash).toMatch(/^[0-9a-f]{16}$/);
			expect(JSON.stringify(lines[0])).not.toContain(dir);
		});
	}

	it("failure then success on the same file share a pathHash; other files differ", async () => {
		const p = join(dir, "same.py");
		writeFileSync(p, "def f():\n    return 1\n");
		const tool = createEditTool(dir);
		await expect(
			tool.execute("a", { path: "same.py", edits: [{ oldText: "def f():\nreturn 1", newText: "x" }] }),
		).rejects.toThrow();
		await tool.execute("b", { path: "./same.py", edits: [{ oldText: "    return 1", newText: "    return 2" }] });
		await runCase("exact");
		const [fail, ok, other] = logLines();
		expect(fail).toMatchObject({ ok: false, reason: "indent_only" });
		expect(ok).toMatchObject({ ok: true, edit_match_stage: 1 });
		expect(fail.pathHash).toBe(ok.pathHash);
		expect(other.pathHash).not.toBe(ok.pathHash);
	});

	it("success path never calls the failure classifier", async () => {
		const spy = vi.spyOn(editMatchObserver, "classify");
		for (const name of ["exact", "fuzzy-trailing-ws", "crlf-bom", "multi"]) await runCase(name);
		expect(spy).not.toHaveBeenCalled();
		await runCase("not-found");
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("writes nothing when the run log is off", async () => {
		delete process.env[RUN_LOG_DIR_ENV];
		await runCase("exact");
		await runCase("not-found");
		expect(logLines()).toEqual([]);
	});
});

describe("classifyEditMatchFailure", () => {
	it("classifies each reason", () => {
		const content = "if x:\n    y = 1\n    y = 1\nz\n";
		expect(classifyEditMatchFailure(content, [{ oldText: "if x:\ny = 1", newText: "" }]).reason).toBe("indent_only");
		expect(classifyEditMatchFailure(content, [{ oldText: "y = 1", newText: "" }]).reason).toBe("multiple_matches");
		expect(classifyEditMatchFailure(content, [{ oldText: "nope", newText: "" }]).reason).toBe("not_found");
		expect(classifyEditMatchFailure(content, [{ oldText: "", newText: "" }]).reason).toBe("unknown");
		expect(classifyEditMatchFailure(content, [{ oldText: "z", newText: "" }])).toEqual({
			reason: "unknown",
			editIndex: null,
		});
	});

	it("partial-line text with different indent is not indent_only", () => {
		expect(
			classifyEditMatchFailure("  x = 1\n  value = 2\n", [{ oldText: "x = 1\nvalue", newText: "" }]).reason,
		).toBe("not_found");
	});

	it("reports the first failing edit index", () => {
		expect(
			classifyEditMatchFailure("a\nb\n", [
				{ oldText: "a", newText: "" },
				{ oldText: "q", newText: "" },
			]),
		).toEqual({ reason: "not_found", editIndex: 1 });
	});
});
