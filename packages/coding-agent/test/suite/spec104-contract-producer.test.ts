/**
 * Spec 104 phase 3 e2e: the real goal controller produces the required-tool contract from an
 * explicit `/goal verify --requires` declaration; the real AgentSession admission host enforces it.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage } from "omk-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DurableGoalStore } from "../../src/core/durable-goal-store.ts";
import goalController from "../../src/core/extensions/builtin/goal-controller.ts";
import { RequiredCapabilityUnavailable } from "../../src/core/required-tools.ts";
import type { TaskResultEvent } from "../../src/core/task-result.ts";
import { createHarness, type Harness } from "./harness.ts";

const FAKE_MCP_SERVER = fileURLToPath(new URL("../mcp/fake-server.mjs", import.meta.url));
const server = (name: string) => ({
	name,
	command: process.execPath,
	args: [FAKE_MCP_SERVER],
	env: { FAKE_MCP_MODE: "ok", FAKE_MCP_DESCRIPTION_CHARS: "0" },
	inheritEnv: false,
});

const harnesses: Harness[] = [];

beforeEach(() => {
	vi.stubEnv("OMK_BASH_SANDBOX", "off");
	vi.stubEnv("OMK_TASK_RESULT", "1");
});

afterEach(() => {
	vi.unstubAllEnvs();
	for (const h of harnesses.splice(0)) h.cleanup();
});

async function newHarness(servers: string[]): Promise<Harness> {
	const harness = await createHarness({ extensionFactories: [(omk) => goalController(omk)] });
	harnesses.push(harness);
	writeFileSync(join(harness.tempDir, "done.txt"), "done\n");
	const git = (...args: string[]) => execFileSync("git", args, { cwd: harness.tempDir, stdio: "ignore" });
	git("init", "-q");
	git("config", "user.email", "goal@test.invalid");
	git("config", "user.name", "goal");
	git("config", "commit.gpgsign", "false");
	git("add", ".");
	git("commit", "-qm", "init");
	await harness.session.attachMcpServers({ servers: servers.map(server) });
	return harness;
}

async function waitIdle(harness: Harness): Promise<void> {
	await vi.waitFor(
		async () => {
			await harness.session.agent.waitForIdle();
			expect(harness.session.isStreaming).toBe(false);
		},
		{ timeout: 20_000, interval: 50 },
	);
}

async function goalStatus(harness: Harness): Promise<string | undefined> {
	return (await new DurableGoalStore(join(harness.tempDir, ".omk", "goals", "current.json")).current())?.status;
}

function capabilityEntries(harness: Harness): unknown[] {
	return harness.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === "goal_required_capability")
		.map((entry) => (entry as { data?: unknown }).data);
}

function requiredFacts(harness: Harness) {
	return harness
		.eventsOfType("task_result")
		.flatMap((event) => (event as TaskResultEvent).projection.facts)
		.filter((fact) => fact.reason === "required_capability_missing");
}

async function rejection(harness: Harness, prompt: string): Promise<unknown> {
	return harness.session.prompt(prompt).catch((caught: unknown) => caught);
}

describe("spec 104 phase 3: goal-controller contract producer", () => {
	it("flag on: an explicitly declared tool that is absent -> insufficient/required_capability_missing, recorded, never completed", async () => {
		vi.stubEnv("OMK_REQUIRED_TOOLS", "1");
		const h = await newHarness(["slim"]);
		h.setResponses([fauxAssistantMessage("done")]);
		await h.session.prompt("/goal Ship it");
		await h.session.prompt("/goal verify --requires browser__verify test -f done.txt");

		const error = await rejection(h, "go");
		await waitIdle(h);

		expect(error).toBeInstanceOf(RequiredCapabilityUnavailable);
		expect(error).toMatchObject({ kind: "absent", missing: ["browser__verify"] });
		expect(h.faux.state.callCount).toBe(0);
		// Rejected in prompt preflight, before any run began: there is no task_result run to carry the fact.
		expect(h.eventsOfType("task_result")).toEqual([]);
		const entries = capabilityEntries(h);
		expect(entries).toEqual([
			{ goalId: "session", state: "missing", kind: "absent", missingCount: 1, requiredCount: 1 },
		]);
		// Counts only: no tool name, command or prompt text in the trace.
		expect(JSON.stringify(entries)).not.toMatch(/browser|verify|done\.txt|Ship/);
		expect(await goalStatus(h)).not.toBe("completed");
		await h.session.prompt("/goal complete");
		expect(await goalStatus(h)).not.toBe("completed");
	});

	it("flag on: only declared tools are required; a tool the command or goal merely names is not", async () => {
		vi.stubEnv("OMK_REQUIRED_TOOLS", "1");
		const h = await newHarness(["slim"]);
		h.setResponses([fauxAssistantMessage("done")]);
		await h.session.prompt("/goal Verify with browser__verify");
		await h.session.prompt("/goal verify --requires slim__echo test -f done.txt || echo browser__verify");

		await h.session.prompt("go");
		await waitIdle(h);

		expect(h.faux.state.callCount).toBe(1);
		expect(requiredFacts(h)).toEqual([]);
		expect(capabilityEntries(h)).toEqual([]);
		expect(await goalStatus(h)).toBe("completed");
	});

	it("flag on: a check that declares nothing has no required tools", async () => {
		vi.stubEnv("OMK_REQUIRED_TOOLS", "1");
		const h = await newHarness(["slim"]);
		h.setResponses([fauxAssistantMessage("done")]);
		await h.session.prompt("/goal Use browser__verify");
		await h.session.prompt("/goal verify test -f done.txt");

		await h.session.prompt("go");
		await waitIdle(h);

		expect(h.faux.state.callCount).toBe(1);
		expect(capabilityEntries(h)).toEqual([]);
		expect(await goalStatus(h)).toBe("completed");
	});

	it("flag off: --requires is not parsed, nothing is required and nothing is recorded", async () => {
		const h = await newHarness(["slim"]);
		const notify = vi.spyOn(h.session.extensionRunner.getUIContext(), "notify");
		h.setResponses([fauxAssistantMessage("done")]);
		await h.session.prompt("/goal Ship it");
		await h.session.prompt("/goal verify test -f done.txt");
		await h.session.prompt("/goal verify --requires browser__verify test -f done.txt");
		// Unchanged pre-104 behavior: the whole text is the approved command.
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("--requires browser__verify"), "info");

		await h.session.prompt("/goal verify test -f done.txt");
		await h.session.prompt("go");
		await waitIdle(h);

		expect(h.faux.state.callCount).toBe(1);
		expect(requiredFacts(h)).toEqual([]);
		expect(capabilityEntries(h)).toEqual([]);
		expect(await goalStatus(h)).toBe("completed");
	});

	it("flag on: a declared tool revoked before the goal's follow-up run -> task_result insufficient/required_capability_missing", async () => {
		vi.stubEnv("OMK_REQUIRED_TOOLS", "1");
		const h = await newHarness(["slim", "mid"]);
		h.setResponses([
			() => {
				// Revocation: slim's tool leaves the active set; the goal's follow-up run is the next request.
				h.session.setActiveToolsByName(h.session.getActiveToolNames().filter((name) => name !== "slim__echo"));
				return fauxAssistantMessage("not yet");
			},
		]);
		await h.session.prompt("/goal Ship it");
		await h.session.prompt("/goal verify --requires slim__echo test -f done2.txt");

		// The follow-up run is rejected. Open question for Tech Lead: on this agent.continue path the
		// rejection currently surfaces as a run-journal error, not RequiredCapabilityUnavailable.
		const failure = await rejection(h, "go");
		expect(failure).toBeInstanceOf(Error);
		await vi.waitFor(() => expect(requiredFacts(h).length).toBeGreaterThan(0), { timeout: 20_000 });
		await waitIdle(h);

		// Request 1 carried the tool; the follow-up run was rejected before any provider request.
		expect(h.faux.state.callCount).toBe(1);
		expect(requiredFacts(h)[0]).toMatchObject({
			status: "insufficient",
			reason: "required_capability_missing",
			required: true,
		});
		const entries = capabilityEntries(h);
		expect(entries.length).toBeGreaterThan(0);
		for (const entry of entries) {
			expect(entry).toEqual({
				goalId: "session",
				state: "missing",
				kind: "absent",
				missingCount: 1,
				requiredCount: 1,
			});
		}
		writeFileSync(join(h.tempDir, "done2.txt"), "done\n");
		await h.session.prompt("/goal complete");
		expect(await goalStatus(h)).not.toBe("completed");
	});
});
