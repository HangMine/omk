import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyCheckKind, parseTestCounts } from "../src/core/test-counts.ts";

/**
 * Spec 100 decision 3/6: counts come from the runner's own output text. Every fixture below is
 * real output captured from node 22.20 (node:test), vitest 4.1.11 and jest 29.7.0 run outside this
 * repo; no runner or reporter is a dependency here.
 */
const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", "test-counts", name), "utf8");

describe("parseTestCounts on real runner output", () => {
	it.each([
		["node-test-tap-pass-skip.txt", { executed: 2, matched: 3, skipped: 1 }],
		["node-test-spec-pass-skip.txt", { executed: 2, matched: 3, skipped: 1 }],
		["node-test-tap-fail.txt", { executed: 2, matched: 2, skipped: 0 }],
		["node-test-tap-zero.txt", { executed: 0, matched: 0, skipped: 0 }],
		["vitest-pass-skip.txt", { executed: 2, matched: 3, skipped: 1 }],
		["vitest-fail.txt", { executed: 2, matched: 2, skipped: 0 }],
		["vitest-zero.txt", { executed: 0, matched: 3, skipped: 3 }],
		["jest-pass-skip.txt", { executed: 2, matched: 3, skipped: 1 }],
		["jest-fail.txt", { executed: 2, matched: 2, skipped: 0 }],
		["jest-zero.txt", { executed: 0, matched: 3, skipped: 3 }],
	])("%s", (name, expected) => {
		expect(parseTestCounts(fixture(name))).toEqual(expected);
	});

	it("unreadable output gives undefined, never a guessed 0", () => {
		expect(parseTestCounts("")).toBeUndefined();
		expect(parseTestCounts("ok\nall good\n")).toBeUndefined();
		expect(parseTestCounts("# tests 3\n# pass 2\n")).toBeUndefined();
		// Inconsistent totals are refused rather than trusted.
		expect(parseTestCounts("      Tests  2 passed | 1 skipped (9)\n")).toBeUndefined();
		expect(parseTestCounts("Tests:       2 passed, 7 total\n")).toBeUndefined();
	});

	it("ANSI colors do not change the counts", () => {
		expect(
			parseTestCounts("\u001b[2m      Tests \u001b[22m \u001b[1m\u001b[32m2 passed\u001b[39m\u001b[22m (2)\n"),
		).toEqual({
			executed: 2,
			matched: 2,
			skipped: 0,
		});
	});
});

describe("classifyCheckKind", () => {
	it.each([
		["node --test", "test_runner"],
		["node --test-name-pattern=x a.test.mjs", "test_runner"],
		["npx vitest run", "test_runner"],
		["jest --ci", "test_runner"],
		["npm test", "test_runner"],
		["npm run test -- --run", "test_runner"],
		["npx tsc --noEmit", "typecheck"],
		["tsgo --noEmit", "typecheck"],
		["test -f done.txt", "shell"],
		["node build.mjs", "shell"],
	])("%s -> %s", (command, kind) => {
		expect(classifyCheckKind(command)).toBe(kind);
	});
});
