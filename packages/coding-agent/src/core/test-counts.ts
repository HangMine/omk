/**
 * Spec 100: test counts read from a check's own output text.
 *
 * Only the summary formats of node:test (TAP and spec reporters), vitest and
 * jest are understood. Nothing is installed or run here; a summary this module
 * cannot read gives `undefined`, never a guessed number.
 */
import { stripAnsi } from "../utils/ansi.ts";

/** What kind of check an approved command is, from the command text alone. */
export type CheckKind = "test_runner" | "typecheck" | "shell";

/** Counts a runner printed. `executed` ran (passed or failed); `skipped` includes todo; `matched` is the runner's total. */
export interface TestCounts {
	readonly executed: number;
	readonly matched: number;
	readonly skipped: number;
}

const TEST_RUNNER =
	/(?:^|[\s;&|(])(?:npx\s+|pnpm\s+(?:exec\s+)?|yarn\s+)?(?:vitest|jest)\b|\bnode\b[^;&|]*(?:--test\b|--test-[a-z-]+|\.test\.[cm]?[jt]s\b)|\bnpm\s+(?:run\s+)?test\b/;
const TYPECHECK = /(?:^|[\s;&|(])(?:npx\s+)?(?:tsc|tsgo)\b/;

export function classifyCheckKind(command: string): CheckKind {
	if (TEST_RUNNER.test(command)) return "test_runner";
	if (TYPECHECK.test(command)) return "typecheck";
	return "shell";
}

function lastMatch(text: string, pattern: RegExp): RegExpMatchArray | undefined {
	let found: RegExpMatchArray | undefined;
	for (const match of text.matchAll(pattern)) found = match;
	return found;
}

/** A top-level pass whose name is a script file: node:test's stand-in for a file that ran no test (TAP, spec). */
const FILE_ONLY_PASS = /^(?:ok \d+ - |\u2714 )\S+\.[cm]?[jt]sx?(?: \([\d.]+m?s\))?$/gm;

/** node:test: `# tests N` (TAP) or `ℹ tests N` (spec), with pass/fail/cancelled/skipped/todo lines. */
function nodeTestCounts(text: string): TestCounts | undefined {
	const field = (name: string): number | undefined => {
		const match = lastMatch(text, new RegExp(`^(?:#|\\u2139)\\s+${name}\\s+(\\d+)\\s*$`, "gm"));
		return match ? Number(match[1]) : undefined;
	};
	const tests = field("tests");
	const pass = field("pass");
	const fail = field("fail");
	const cancelled = field("cancelled");
	const skipped = field("skipped");
	const todo = field("todo");
	if ([tests, pass, fail, cancelled, skipped, todo].some((value) => value === undefined)) return undefined;
	const skippedAll = (skipped as number) + (todo as number);
	const executed = (pass as number) + (fail as number) + (cancelled as number);
	if (executed + skippedAll !== tests) return undefined;
	// A file whose own tests were all filtered out is reported as one passing test named after the file.
	const files = [...text.matchAll(FILE_ONLY_PASS)].length;
	if (files > (pass as number)) return undefined;
	return { executed: executed - files, matched: (tests as number) - files, skipped: skippedAll };
}

function partsOf(list: string): Map<string, number> | undefined {
	const parts = new Map<string, number>();
	for (const part of list.split(/\s*[|,]\s*/)) {
		const match = /^(\d+)\s+(passed|failed|skipped|todo|pending)$/.exec(part.trim());
		if (!match) return undefined;
		parts.set(match[2] as string, Number(match[1]));
	}
	return parts;
}

function fromParts(parts: Map<string, number>, total: number): TestCounts | undefined {
	const skipped = (parts.get("skipped") ?? 0) + (parts.get("todo") ?? 0) + (parts.get("pending") ?? 0);
	const executed = (parts.get("passed") ?? 0) + (parts.get("failed") ?? 0);
	if (executed + skipped !== total) return undefined;
	return { executed, matched: total, skipped };
}

/** vitest: `      Tests  2 passed | 1 skipped (3)`. */
function vitestCounts(text: string): TestCounts | undefined {
	const match = lastMatch(text, /^\s*Tests\s{2,}(.+?)\s+\((\d+)\)\s*$/gm);
	if (!match) return undefined;
	const parts = partsOf(match[1] as string);
	return parts ? fromParts(parts, Number(match[2])) : undefined;
}

/** jest: `Tests:       1 skipped, 2 passed, 3 total`. */
function jestCounts(text: string): TestCounts | undefined {
	const match = lastMatch(text, /^Tests:\s+(?:(.+?),\s+)?(\d+)\s+total\s*$/gm);
	if (!match) return undefined;
	const total = Number(match[2]);
	if (match[1] === undefined) return total === 0 ? { executed: 0, matched: 0, skipped: 0 } : undefined;
	const parts = partsOf(match[1]);
	return parts ? fromParts(parts, total) : undefined;
}

/** Counts from the runner's own summary, or undefined when no known summary is readable. */
export function parseTestCounts(output: string): TestCounts | undefined {
	const text = stripAnsi(output).replace(/\r/g, "");
	return nodeTestCounts(text) ?? vitestCounts(text) ?? jestCounts(text);
}
