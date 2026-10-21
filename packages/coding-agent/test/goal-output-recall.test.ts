import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDurableGoal } from "../src/core/durable-goal.ts";
import { DurableGoalStore } from "../src/core/durable-goal-store.ts";
import goalController from "../src/core/extensions/builtin/goal-controller.ts";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "../src/core/extensions/types.ts";
import {
	goalOutputRecallEnabled,
	OUTPUT_RECALL_HEAD_BYTES,
	OUTPUT_RECALL_MAX_BYTES,
	OUTPUT_RECALL_PER_DIR,
	OUTPUT_RECALL_TAIL_BYTES,
	OutputArtifactWriter,
} from "../src/core/goal-output-recall.ts";

const roots: string[] = [];

function tempRoot(prefix: string): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	roots.push(root);
	return root;
}

function gitRepo(): string {
	const root = tempRoot("omk-098-repo-");
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
	git("init", "-q");
	git("config", "user.email", "goal@test.invalid");
	git("config", "user.name", "goal");
	git("config", "commit.gpgsign", "false");
	writeFileSync(join(root, "app.txt"), "v1\n");
	git("add", ".");
	git("commit", "-qm", "init");
	return root;
}

function harness(cwd: string, sessionFile: string | undefined) {
	const commands = new Map<string, RegisteredCommand>();
	const handlers = new Map<string, (event: never, context: never) => unknown>();
	const entries: Array<{ readonly type: string; readonly data: Record<string, unknown> }> = [];
	const messages: string[] = [];
	const omk = {
		registerCommand: (name: string, command: RegisteredCommand) => commands.set(name, command),
		on: (event: string, handler: (event: never, context: never) => unknown) => handlers.set(event, handler),
		appendEntry: (type: string, data: Record<string, unknown>) => entries.push({ type, data }),
		sendUserMessage: (message: string) => messages.push(message),
	} as unknown as ExtensionAPI;
	goalController(omk);
	const ctx = {
		cwd,
		signal: undefined,
		hasUI: false,
		ui: { notify: () => {}, confirm: async () => false },
		isIdle: () => true,
		hasPendingMessages: () => false,
		sessionManager: { getSessionFile: () => sessionFile },
	} as unknown as ExtensionCommandContext;
	return {
		entries,
		messages,
		goal: async (args: string) => commands.get("goal")?.handler(args, ctx),
		settle: async () =>
			handlers.get("agent_settled")?.({ type: "agent_settled", messages: [] } as never, ctx as never),
	};
}

async function failingRound(sessionFile: string | undefined) {
	const cwd = gitRepo();
	await new DurableGoalStore(join(cwd, ".omk", "goals", "current.json")).create(
		createDurableGoal({ id: "session", objective: "Ship the app", maxRounds: 3, now: new Date().toISOString() }),
	);
	const h = harness(cwd, sessionFile);
	await h.goal("verify printf 'line one\\nF821 undefined name x\\n'; exit 4");
	await h.settle();
	return { cwd, h };
}

beforeEach(() => {
	vi.stubEnv("OMK_BASH_SANDBOX", "off");
	vi.stubEnv("OMK_GOAL_OUTPUT_RECALL", undefined);
});

afterEach(() => {
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("spec 098 flag", () => {
	it("is off unless OMK_GOAL_OUTPUT_RECALL=1", () => {
		expect(goalOutputRecallEnabled({})).toBe(false);
		expect(goalOutputRecallEnabled({ OMK_GOAL_OUTPUT_RECALL: "0" })).toBe(false);
		expect(goalOutputRecallEnabled({ OMK_GOAL_OUTPUT_RECALL: "true" })).toBe(false);
		expect(goalOutputRecallEnabled({ OMK_GOAL_OUTPUT_RECALL: "1" })).toBe(true);
	});
});

describe("spec 098 controller wiring", () => {
	it("flag off: the follow-up request text and the trace entry are byte-identical to main, no file written", async () => {
		const session = join(tempRoot("omk-098-sess-"), "s.jsonl");
		const { h } = await failingRound(session);

		expect(h.messages).toHaveLength(1);
		const receipt = /\(receipt ([0-9a-f]{8})\)/u.exec(h.messages[0] ?? "")?.[1];
		expect(receipt).toMatch(/^[0-9a-f]{8}$/u);
		// The exact string `main` (29933049fe) sends as the next request's user message.
		expect(h.messages[0]).toBe(
			"Continue the active goal (1/3): Ship the app\n\n" +
				"Acceptance check `printf 'line one\\nF821 undefined name x\\n'; exit 4` failed with exit code 4 " +
				`(receipt ${receipt}). Run it to see the output, fix the cause, and end your turn when it passes.`,
		);
		for (const entry of h.entries) {
			expect(Object.keys(entry.data).sort()).toEqual(
				["digest", "exitCode", "goalId", "goalRevision", "passed", "receiptId", "status", "trigger"].sort(),
			);
		}
		expect(existsSync(`${session.replace(/\.jsonl$/u, "")}.artifacts`)).toBe(false);
	});

	it("flag on: points the model at the raw artifact and the trace keeps only a digest and counts", async () => {
		vi.stubEnv("OMK_GOAL_OUTPUT_RECALL", "1");
		const session = join(tempRoot("omk-098-sess-"), "s.jsonl");
		const { cwd, h } = await failingRound(session);

		const message = h.messages[0] ?? "";
		expect(message).not.toContain("Run it to see the output");
		expect(message).toContain("Diagnostic hint (may be incomplete):\nline one\nF821 undefined name x");
		const path = /Full output: (\S+) \(2 lines, 31B; complete\)/u.exec(message)?.[1];
		expect(path).toBeDefined();
		expect(path?.startsWith("/")).toBe(false);
		const file = join(cwd, path ?? "");
		expect(readFileSync(file, "utf8")).toBe("line one\nF821 undefined name x\n");
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(statSync(join(file, "..")).mode & 0o777).toBe(0o700);
		expect(message).toContain("Read ranges with read(path, offset, limit) instead of re-running the check");

		const traced = h.entries.map((entry) => JSON.stringify(entry));
		for (const line of traced) expect(line).not.toContain("F821");
		expect(h.entries.at(-1)?.data.outputArtifact).toEqual({
			sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
			bytes: 31,
			lines: 2,
			complete: true,
			elidedBytes: 0,
		});
	});

	it("flag on without a session writes a 0600 temp file with an absolute path", async () => {
		vi.stubEnv("OMK_GOAL_OUTPUT_RECALL", "1");
		const { h } = await failingRound(undefined);
		const path = /Full output: (\S+) \(/u.exec(h.messages[0] ?? "")?.[1] ?? "";
		expect(path.startsWith(join(tmpdir(), "omk-accept-"))).toBe(true);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		rmSync(path, { force: true });
	});

	it("flag on: a passing check leaves no artifact", async () => {
		vi.stubEnv("OMK_GOAL_OUTPUT_RECALL", "1");
		const cwd = gitRepo();
		const session = join(tempRoot("omk-098-sess-"), "s.jsonl");
		const h = harness(cwd, session);
		await h.goal("Ship the app");
		await h.goal("verify grep -q v1 app.txt");
		const dir = `${session.replace(/\.jsonl$/u, "")}.artifacts`;
		expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
		expect(h.entries.at(-1)?.data.outputArtifact).toBeUndefined();
	});
});

describe("spec 098 artifact writer", () => {
	const target = (sessionFile: string, goalId = "g", round = 0) => ({
		sessionFile,
		cwd: join(sessionFile, ".."),
		goalId,
		round,
		revision: 1,
	});

	it("keeps the first 1 MiB and the last 3 MiB around one elision line past 4 MiB", () => {
		const session = join(tempRoot("omk-098-w-"), "s.jsonl");
		const writer = OutputArtifactWriter.open(target(session));
		const chunk = 256 * 1024;
		const total = OUTPUT_RECALL_MAX_BYTES + 3 * chunk + 5;
		const all = Buffer.alloc(total);
		for (let i = 0; i < total; i++) all[i] = 97 + (i % 26);
		for (let at = 0; at < total; at += chunk) writer?.write(all.subarray(at, at + chunk));
		const artifact = writer?.finish();
		const elided = total - OUTPUT_RECALL_MAX_BYTES;
		expect(artifact).toMatchObject({ complete: false, elidedBytes: elided });
		const content = readFileSync(join(target(session).cwd, artifact?.displayPath ?? ""));
		const marker = Buffer.from(`\n[omk: ${elided} bytes elided]\n`);
		expect(content.subarray(0, OUTPUT_RECALL_HEAD_BYTES).equals(all.subarray(0, OUTPUT_RECALL_HEAD_BYTES))).toBe(
			true,
		);
		expect(
			content.subarray(OUTPUT_RECALL_HEAD_BYTES, OUTPUT_RECALL_HEAD_BYTES + marker.byteLength).equals(marker),
		).toBe(true);
		expect(
			content.subarray(OUTPUT_RECALL_HEAD_BYTES + marker.byteLength).equals(all.subarray(-OUTPUT_RECALL_TAIL_BYTES)),
		).toBe(true);
		expect(artifact?.bytes).toBe(content.byteLength);
	});

	it("discard deletes the partial file", () => {
		const session = join(tempRoot("omk-098-w-"), "s.jsonl");
		const writer = OutputArtifactWriter.open(target(session));
		writer?.write(Buffer.from("partial"));
		writer?.discard();
		expect(readdirSync(`${session.replace(/\.jsonl$/u, "")}.artifacts`)).toEqual([]);
		expect(writer?.finish()).toBeUndefined();
	});

	it("keeps the newest 3 per goal and 20 per artifact dir", () => {
		const session = join(tempRoot("omk-098-w-"), "s.jsonl");
		const dir = `${session.replace(/\.jsonl$/u, "")}.artifacts`;
		const stamp = (round: number, goalId: string) => {
			const writer = OutputArtifactWriter.open(target(session, goalId, round));
			writer?.write(Buffer.from(`${goalId} ${round}\n`));
			writer?.finish();
			const file = join(dir, `acceptance-${goalId}-${round}-1.log`);
			if (existsSync(file)) utimesSync(file, round, round);
		};
		for (let round = 1; round <= 5; round++) stamp(round, "a");
		expect(readdirSync(dir).sort()).toEqual(["acceptance-a-3-1.log", "acceptance-a-4-1.log", "acceptance-a-5-1.log"]);
		for (let goal = 0; goal < 10; goal++)
			for (let round = 10; round < 13; round++) stamp(round + goal * 3, `g${goal}`);
		expect(readdirSync(dir)).toHaveLength(OUTPUT_RECALL_PER_DIR);
		expect(readdirSync(dir).some((name) => name.startsWith("acceptance-a-"))).toBe(false);
	});

	it("sweeps omk-accept temp files older than 24 h", () => {
		const stale = join(tmpdir(), "omk-accept-00000000deadbeef.log");
		writeFileSync(stale, "old", { mode: 0o600 });
		const old = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
		utimesSync(stale, old, old);
		const writer = OutputArtifactWriter.open({
			sessionFile: undefined,
			cwd: tmpdir(),
			goalId: "t",
			round: 0,
			revision: 1,
		});
		writer?.discard();
		expect(existsSync(stale)).toBe(false);
	});
});
