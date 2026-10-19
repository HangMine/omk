import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRunContract, parseRunStartCommand } from "omk-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireSessionOwnerLeaseSync, type SessionOwnerLease } from "../src/core/session-owner-lease.ts";
import type { RunEvent } from "../src/core/verified-run/events.ts";
import { journalPath, readRunJournal, VerifiedRunJournal } from "../src/core/verified-run/journal.ts";
import { digestObject, VerifiedRunConcurrentChangeError } from "../src/core/verified-run/storage.ts";

let root: string;
let owner: SessionOwnerLease;
const creation = (): RunEvent => {
	const contract = parseRunContract({
		schemaVersion: "omk.verified-run.v1",
		profile: "linux-command-v1",
		runId: "run-1",
		goal: "test",
		workspace: { root: "/workspace", baseDigest: "a".repeat(64) },
		writablePaths: ["answer"],
		writer: ["/bin/true"],
		checks: [{ claimId: "answer", argv: ["/bin/true"], stdout: "" }],
		budget: { workMs: 1000, verifyMs: 1000, cleanupMs: 15000, maxOutputBytes: 1024, maxFiles: 10, maxBytes: 1024 },
		apply: "artifact-only",
	});
	const command = parseRunStartCommand({
		schemaVersion: "omk.verified-command.v1",
		kind: "start",
		runId: contract.runId,
		commandId: "command-1",
		expectedRevision: 0,
		expectedGeneration: 0,
		contractDigest: digestObject(contract),
	});
	return { kind: "created", contract, command };
};

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "spec088-journal-"));
	owner = acquireSessionOwnerLeaseSync(journalPath(root));
});
afterEach(() => {
	owner.release();
	rmSync(root, { recursive: true, force: true });
});

describe("spec 088: journal reader during a live append", () => {
	it("reader mode drops an in-progress (torn) tail and returns the complete-record prefix", () => {
		const journal = new VerifiedRunJournal(root, owner);
		journal.append(creation());
		journal.append({ kind: "dispatch", executionId: "execution-1", role: "writer", claimId: null });
		const committed = readRunJournal(root);
		appendFileSync(journalPath(root), '{"version":2,"seq":3,"generation":1,"prev');
		const before = readFileSync(journalPath(root));

		const read = readRunJournal(root, { mode: "reader" });

		expect(read?.records.map((record) => record.hash)).toEqual(committed?.records.map((record) => record.hash));
		expect(read?.state).toEqual(committed?.state);
		expect(readFileSync(journalPath(root))).toEqual(before);
		// Strict mode (writer/recovery) is unchanged.
		expect(() => readRunJournal(root)).toThrow(/journal_truncated/);
	});

	it("reader mode reports concurrent_change after consecutive changes exhaust the 250 ms budget", () => {
		new VerifiedRunJournal(root, owner).append(creation());
		let now = 0;
		let attempts = 0;
		const sleeps: number[] = [];
		const read = (): Buffer => {
			attempts += 1;
			now += 70; // each attempt observes a change and costs 70 ms: the 4th change exhausts 250 ms
			throw new VerifiedRunConcurrentChangeError();
		};

		expect(() =>
			readRunJournal(root, { mode: "reader", read, now: () => now, sleep: (ms) => sleeps.push(ms) }),
		).toThrow(/concurrent_change/);
		expect(attempts).toBe(4);
		expect(now + sleeps.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(250 + 70);
	});
});
