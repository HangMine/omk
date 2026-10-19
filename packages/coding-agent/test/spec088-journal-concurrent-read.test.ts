import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRunContract, parseRunStartCommand } from "omk-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDurableFileLockRoot, resolveDurableFileIdentity } from "../src/core/durable-file-identity.ts";
import { durableFileLockPathUnchecked, peekDurableFileLockPathSync } from "../src/core/durable-file-lock-peek.ts";
import {
	acquireSessionOwnerLeaseSync,
	peekSessionOwnerLeaseSync,
	type SessionOwnerLease,
} from "../src/core/session-owner-lease.ts";
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

	it("reader mode retries a journal whose first record is mid-write instead of reporting a missing run", () => {
		new VerifiedRunJournal(root, owner).append(creation());
		const complete = readFileSync(journalPath(root));
		const partial = complete.subarray(0, complete.length - 10);
		let now = 0;
		let attempts = 0;
		const stillPartial = (): Buffer => {
			attempts += 1;
			now += 70;
			return partial;
		};
		expect(() =>
			readRunJournal(root, { mode: "reader", read: stillPartial, now: () => now, sleep: () => {} }),
		).toThrow(/concurrent_change/);
		expect(attempts).toBe(4);

		let calls = 0;
		const completesOnThird = (): Buffer => (++calls < 3 ? partial : complete);
		const read = readRunJournal(root, { mode: "reader", read: completesOnThird, sleep: () => {} });
		expect(calls).toBe(3);
		expect(read?.records).toHaveLength(1);
		expect(read?.records[0]?.event.kind).toBe("created");
	});

	it("reader mode keeps journal_truncated for a torn tail when no owner lease is held (same as base)", () => {
		new VerifiedRunJournal(root, owner).append(creation());
		owner.release();
		appendFileSync(journalPath(root), '{"version":2,"seq":2');
		const before = readFileSync(journalPath(root));
		expect(peekSessionOwnerLeaseSync(journalPath(root))).toBe("absent");
		expect(() => readRunJournal(root, { mode: "reader" })).toThrow(/journal_truncated/);
		expect(() => readRunJournal(root)).toThrow(/journal_truncated/);
		expect(readFileSync(journalPath(root))).toEqual(before);
		owner = acquireSessionOwnerLeaseSync(journalPath(root)); // for afterEach
	});

	it("reader mode drops a torn tail while the owner lease is live (current pid)", () => {
		new VerifiedRunJournal(root, owner).append(creation());
		const committed = readRunJournal(root);
		appendFileSync(journalPath(root), '{"version":2,"seq":2');
		expect(peekSessionOwnerLeaseSync(journalPath(root))).toBe("live");
		expect(readRunJournal(root, { mode: "reader" })?.records.map((r) => r.hash)).toEqual(
			committed?.records.map((r) => r.hash),
		);
	});

	it("peek of a dead owner changes nothing: lock bytes and mtime identical, no reclaim gate", () => {
		new VerifiedRunJournal(root, owner).append(creation());
		const keys = resolveDurableFileIdentity(journalPath(root)).lockKeys;
		const lockDirs = keys
			.map((key) => durableFileLockPathUnchecked("session-owner", key))
			.filter((path) => peekDurableFileLockPathSync(path) === "live");
		expect(lockDirs.length).toBeGreaterThan(0);
		const ownerFiles = lockDirs.map((dir) => join(dir, "owner.json"));
		const originals = ownerFiles.map((file) => readFileSync(file));
		const exited = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
			encoding: "utf8",
		});
		const deadPid = Number(exited.stdout);
		ownerFiles.forEach((file, index) => {
			const record = JSON.parse(originals[index].toString("utf8")) as { pid: number };
			writeFileSync(file, JSON.stringify({ ...record, pid: deadPid }));
		});
		try {
			const bytes = ownerFiles.map((file) => readFileSync(file));
			const mtimes = ownerFiles.map((file) => statSync(file, { bigint: true }).mtimeNs);
			const lockRoot = getDurableFileLockRoot();
			// The lock root is shared with tests running in parallel: compare only this lease's entries.
			const ours = () =>
				readdirSync(lockRoot)
					.filter((name) => keys.some((key) => name.includes(key)))
					.sort();
			const entries = ours();

			for (const dir of lockDirs) expect(peekDurableFileLockPathSync(dir)).toBe("dead");
			expect(peekSessionOwnerLeaseSync(journalPath(root))).toBe("dead");
			appendFileSync(journalPath(root), '{"version":2,"seq":2');
			expect(() => readRunJournal(root, { mode: "reader" })).toThrow(/journal_truncated/);

			ownerFiles.forEach((file, index) => {
				expect(readFileSync(file)).toEqual(bytes[index]);
				expect(statSync(file, { bigint: true }).mtimeNs).toBe(mtimes[index]);
			});
			expect(ours()).toEqual(entries);
			expect(ours().some((name) => name.includes(".reclaim-"))).toBe(false);
		} finally {
			for (const [index, file] of ownerFiles.entries()) writeFileSync(file, originals[index]);
		}
	});
});
