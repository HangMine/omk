/**
 * Spec 106 D1 through the real AgentSession (test/suite harness, faux model), flag observe:
 * goal recall artifacts produced by `prompt()` (the `/goal verify` run) and by the agent-loop goal
 * continuation started after `prompt()` returned both land in the owning session's evidence entry;
 * nothing is unattributed; two sessions in one process do not mix. Flag off: no ALS is ever constructed.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "omk-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDurableGoal } from "../../src/core/durable-goal.ts";
import { DurableGoalStore } from "../../src/core/durable-goal-store.ts";
import {
	evidenceRegistrySessionCount,
	evidenceRegistryStats,
	resetEvidenceLifecycleForTest,
} from "../../src/core/evidence-lifecycle.ts";
import { evidenceScopeStatsForTest, resetEvidenceScopeForTest } from "../../src/core/evidence-lifecycle-scope.ts";
import { EVIDENCE_LIFECYCLE_ENTRY_TYPE } from "../../src/core/evidence-lifecycle-session.ts";
import goalController from "../../src/core/extensions/builtin/goal-controller.ts";
import { createReadTool } from "../../src/core/tools/read.ts";
import { createHarness, getUserTexts, type Harness } from "./harness.ts";

const CHECK = "printf 'F821 undefined name x\\n'; exit 4";
const harnesses: Harness[] = [];
let bigFile = "";

interface Report {
	registered: number;
	present: number;
	unattributed: number;
	processRegistered: number;
	byProducer: Record<string, number>;
}

function initGit(cwd: string): void {
	const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
	git("init", "-q");
	git("config", "user.email", "goal@test.invalid");
	git("config", "user.name", "goal");
	git("config", "commit.gpgsign", "false");
	writeFileSync(join(cwd, "README.txt"), "base\n");
	git("add", ".");
	git("commit", "-qm", "init");
}

async function goalHarness(): Promise<Harness> {
	const probe = await createHarness();
	harnesses.push(probe);
	const harness = await createHarness({
		extensionFactories: [goalController],
		tools: [createReadTool(probe.tempDir)],
	});
	harnesses.push(harness);
	initGit(harness.tempDir);
	bigFile = join(probe.tempDir, "big.txt");
	writeFileSync(bigFile, Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n"));
	await new DurableGoalStore(join(harness.tempDir, ".omk", "goals", "current.json")).create(
		createDurableGoal({ id: "session", objective: "Fix it", maxRounds: 1, now: new Date().toISOString() }),
	);
	return harness;
}

async function idle(harness: Harness): Promise<void> {
	await vi.waitFor(
		async () => {
			await harness.session.agent.waitForIdle();
			expect(harness.session.isStreaming).toBe(false);
			expect(harness.getPendingResponseCount()).toBe(0);
		},
		{ timeout: 20_000, interval: 50 },
	);
	await harness.session.agent.waitForIdle();
}

function evidenceEntries(harness: Harness): Array<{ settleIndex: number; report: Report }> {
	return harness.sessionManager
		.getEntries()
		.filter((e) => e.type === "custom" && e.customType === EVIDENCE_LIFECYCLE_ENTRY_TYPE)
		.map((e) => (e as unknown as { data: { settleIndex: number; report: Report } }).data);
}

/**
 * `/goal verify` writes recall #1 inside prompt(); the settled turn re-runs the check (recall #2) and queues
 * the goal continuation; that continuation turn runs after prompt() returned and its settle writes recall #3.
 */
async function runGoalSession(harness: Harness): Promise<{ afterPrompt: number; afterIdle: number }> {
	harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
	const id = harness.sessionManager.getSessionId();
	await harness.session.prompt(`/goal verify ${CHECK}`);
	await harness.session.prompt("go");
	await idle(harness);
	const afterPrompt = evidenceRegistryStats(id).registered;
	// A turn started after prompt() returned, from outside any prompt (as an extension timer or RPC would):
	// the agent loop starts in sendCustomMessage, not prompt(); the model's read of a long file spills.
	const file = bigFile;
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall("read", { path: file })], { stopReason: "toolUse" }),
		fauxAssistantMessage("read it"),
	]);
	await harness.session.sendCustomMessage(
		{ customType: "test-nudge", content: "nudge", display: false },
		{ triggerTurn: true },
	);
	await idle(harness);
	return { afterPrompt, afterIdle: evidenceRegistryStats(id).registered };
}

beforeEach(() => {
	resetEvidenceLifecycleForTest();
	resetEvidenceScopeForTest();
	vi.stubEnv("OMK_BASH_SANDBOX", "off");
	vi.stubEnv("OMK_GOAL_OUTPUT_RECALL", "1");
});

afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
	vi.unstubAllEnvs();
	resetEvidenceLifecycleForTest();
	resetEvidenceScopeForTest();
});

describe("spec 106 D1 evidence attribution through a live session", () => {
	it("flag observe: prompt and post-prompt continuation recalls land in this session, unattributed 0", async () => {
		vi.stubEnv("OMK_EVIDENCE_LIFECYCLE", "observe");
		const harness = await goalHarness();
		const counts = await runGoalSession(harness);
		const texts = getUserTexts(harness);
		// The goal continuation turn ran inside the agent loop.
		expect(texts.some((t) => t.startsWith("Continue the active goal"))).toBe(true);
		const entries = evidenceEntries(harness);
		expect(entries.length).toBeGreaterThanOrEqual(2);
		const last = entries.at(-1)?.report as Report;
		// Recalls were written by a loop started after prompt() returned and are still attributed here.
		expect(counts.afterPrompt).toBeGreaterThanOrEqual(1);
		expect(counts.afterIdle).toBeGreaterThan(counts.afterPrompt);
		expect(last.registered).toBe(counts.afterIdle);
		expect(last.byProducer["goal-recall"]).toBe(counts.afterPrompt);
		expect(last.byProducer["read-spill"]).toBe(counts.afterIdle - counts.afterPrompt);
		expect(last.unattributed).toBe(0);
		expect(last.processRegistered).toBe(last.registered);
		// The continuation's settle saw more artifacts than the first settle.
		expect(last.registered).toBeGreaterThan(entries[0]?.report.registered ?? 0);
	});

	it("flag observe: two sessions in one process do not mix", async () => {
		vi.stubEnv("OMK_EVIDENCE_LIFECYCLE", "observe");
		const a = await goalHarness();
		const b = await goalHarness();
		const ca = await runGoalSession(a);
		const cb = await runGoalSession(b);
		const ra = evidenceEntries(a).at(-1)?.report as Report;
		const rb = evidenceEntries(b).at(-1)?.report as Report;
		expect(ra).toMatchObject({ registered: ca.afterIdle, unattributed: 0 });
		expect(rb).toMatchObject({ registered: cb.afterIdle, unattributed: 0 });
		// b's last entry sees the whole process: a's artifacts are counted there, never in b's own counts.
		expect(rb.processRegistered).toBe(ca.afterIdle + cb.afterIdle);
		expect(evidenceRegistryStats(a.sessionManager.getSessionId()).registered).toBe(ca.afterIdle);
		expect(a.sessionManager.getSessionId()).not.toBe(b.sessionManager.getSessionId());
		a.session.dispose();
		b.session.dispose();
		expect(evidenceRegistrySessionCount()).toBe(0);
	});

	it("flag off: the AsyncLocalStorage is never constructed or entered and no entry is written", async () => {
		vi.stubEnv("OMK_EVIDENCE_LIFECYCLE", undefined);
		const harness = await goalHarness();
		await runGoalSession(harness);
		await harness.session.executeBash("true");
		expect(evidenceScopeStatsForTest()).toEqual({ constructed: false, runs: 0 });
		expect(evidenceEntries(harness)).toHaveLength(0);
		expect(evidenceRegistrySessionCount()).toBe(0);
	});

	it("flag observe: a turn started by the deferred-turn drain (after manual compaction) is attributed", async () => {
		vi.stubEnv("OMK_EVIDENCE_LIFECYCLE", "observe");
		const probe = await createHarness();
		harnesses.push(probe);
		const harness = await createHarness({ tools: [createReadTool(probe.tempDir)] });
		harnesses.push(harness);
		const file = join(probe.tempDir, "big.txt");
		writeFileSync(file, Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n"));
		harness.setResponses([fauxAssistantMessage("hello")]);
		await harness.session.prompt("start");
		await idle(harness);
		const id = harness.sessionManager.getSessionId();
		expect(evidenceRegistryStats(id).registered).toBe(0);
		harness.setResponses([
			fauxAssistantMessage("summary of the session"),
			fauxAssistantMessage([fauxToolCall("read", { path: file })], { stopReason: "toolUse" }),
			fauxAssistantMessage("read it"),
		]);
		// Public trigger, from outside any session scope: a triggerTurn message while manual compaction owns
		// the session is deferred; compaction's finally drains it with setTimeout → _runAgentPrompt.
		const compaction = harness.session.compact();
		expect(harness.session.isCompacting).toBe(true);
		await harness.session.sendCustomMessage(
			{ customType: "test-deferred", content: "after compaction", display: false },
			{ triggerTurn: true },
		);
		await compaction;
		await idle(harness);
		const last = evidenceEntries(harness).at(-1)?.report as Report;
		expect(last.byProducer["read-spill"]).toBe(1);
		expect(last.registered).toBe(1);
		expect(last.unattributed).toBe(0);
		expect(evidenceRegistryStats("unattributed").registered).toBe(0);
	});
});
