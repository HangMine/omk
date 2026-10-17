import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readDelegateUsage } from "../src/delegate-usage.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function setup() {
	const cwd = await mkdtemp(join(tmpdir(), "atelier-delegate-"));
	dirs.push(cwd);
	const dir = join(cwd, ".pi", "delegate", "parent", "task1");
	await mkdir(dir, { recursive: true });
	const answer = Buffer.from("Child verified answer");
	const sha = createHash("sha256").update(answer).digest("hex");
	const route = { provider: "test", model: "test-model" };
	const usage = {
		input: 10,
		output: 2,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 12,
		cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
	};
	const payload = {
		schema_version: "pi-background-tasks.delegate-result.v1",
		task_id: "task1",
		launch_nonce: "nonce",
		seed_sha256: "seed",
		route,
		usage: { status: "observed", usage },
		answer: {
			byte_length: answer.length,
			sha256: sha,
			blocks: [{ kind: "text", byte_length: answer.length, sha256: sha, data_base64: answer.toString("base64") }],
		},
	};
	const launch = {
		type: "message",
		message: {
			role: "toolResult",
			toolName: "bg_delegate",
			details: {
				schema_version: "pi-background-tasks.delegate-launch.v1",
				seed_sha256: "seed",
				artifact_dir: dir,
				task: { id: "task1", name: "reader", startTime: 100, delegate: { launchNonce: "nonce" } },
				route,
			},
		},
	};
	const result = {
		type: "message",
		message: {
			role: "toolResult",
			toolName: "bg_result",
			timestamp: 500,
			details: {
				schema_version: "pi-background-tasks.delegate-result-view.v1",
				task_id: "task1",
				state: "committed",
				artifact_dir: dir,
				answer_sha256: sha,
				route,
			},
		},
	};
	const path = join(dir, "result.json");
	await writeFile(path, JSON.stringify(payload));
	return { cwd, path, payload, entries: [launch, result], result };
}
describe("native committed delegate accounting", () => {
	it("reads actual receipt fields once and only final usage, without copying answer text", async () => {
		const h = await setup();
		const snapshot = await readDelegateUsage({ cwd: h.cwd, entries: [...h.entries, h.result] });
		expect(snapshot.runs).toHaveLength(1);
		expect(snapshot.runs[0]?.cost).toBe(0.03);
		expect(snapshot.costHistory[0]?.points).toEqual([
			{ at: 100, cost: 0 },
			{ at: 500, cost: 0.03 },
		]);
		expect(snapshot.costHistory[0]?.agent).toContain("final");
		expect(JSON.stringify(snapshot)).not.toContain("Child verified answer");
	});
	it("rejects unowned, mismatched, failed or altered receipts", async () => {
		const h = await setup();
		expect((await readDelegateUsage({ cwd: h.cwd, entries: [h.result] })).runs).toEqual([]);
		await writeFile(h.path, JSON.stringify({ ...h.payload, launch_nonce: "other" }));
		expect((await readDelegateUsage(h)).runs).toEqual([]);
		await writeFile(
			h.path,
			JSON.stringify({
				...h.payload,
				answer: {
					...h.payload.answer,
					blocks: [{ ...h.payload.answer.blocks[0], data_base64: Buffer.from("tamper").toString("base64") }],
				},
			}),
		);
		expect((await readDelegateUsage(h)).runs).toEqual([]);
	});
	it("keeps missing usage unavailable and never converts negative costs to observed zero", async () => {
		const h = await setup();
		await writeFile(h.path, JSON.stringify({ ...h.payload, usage: { status: "unavailable" } }));
		const missing = await readDelegateUsage(h);
		expect(missing.runs).toEqual([]);
		expect(missing.unavailable).toBe(1);
		await writeFile(
			h.path,
			JSON.stringify({
				...h.payload,
				usage: { status: "observed", usage: { ...h.payload.usage.usage, cost: { total: -1 } } },
			}),
		);
		expect((await readDelegateUsage(h)).runs).toEqual([]);
	});
});
