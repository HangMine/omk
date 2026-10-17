import { describe, expect, it } from "vitest";
import {
	compactionFailureOutcome,
	compactionIsMandatory,
	isConcurrentWriterFailure,
} from "../src/core/compaction/concurrent-write-policy.ts";

describe("compaction policy for a concurrently written session file", () => {
	it("treats an overflow rejection and a context at the ceiling as mandatory", () => {
		expect(compactionIsMandatory({ reason: "overflow", ceilingTokens: 1000, usageTokens: 10 })).toBe(true);
		expect(compactionIsMandatory({ reason: "manual", ceilingTokens: 1000, usageTokens: 1000 })).toBe(true);
		expect(compactionIsMandatory({ reason: "threshold", ceilingTokens: 1000, usageTokens: 1200 })).toBe(true);
	});

	it("leaves compaction optional below the ceiling or without a known ceiling", () => {
		expect(compactionIsMandatory({ reason: "manual", ceilingTokens: 1000, usageTokens: 999 })).toBe(false);
		// Usage is deliberately null right after a compaction, before the next response.
		expect(compactionIsMandatory({ reason: "manual", ceilingTokens: 1000, usageTokens: null })).toBe(false);
		expect(compactionIsMandatory({ reason: "manual", ceilingTokens: undefined, usageTokens: 9_999 })).toBe(false);
	});

	it("recognizes only the transient failures another writer causes", () => {
		expect(
			isConcurrentWriterFailure("Session changed during compaction (revision_mismatch); summary discarded"),
		).toBe(true);
		expect(isConcurrentWriterFailure("Durable file identity or bytes changed while being read")).toBe(true);
		expect(isConcurrentWriterFailure("Session file changed since this manager accepted its durable head")).toBe(true);
		expect(isConcurrentWriterFailure(new Error("Durable file lock is held by another live process"))).toBe(true);
		const stale = new Error("anything");
		stale.name = "SessionManagerStaleWriteError";
		expect(isConcurrentWriterFailure(stale)).toBe(true);
		expect(isConcurrentWriterFailure("provider returned error 503 service unavailable")).toBe(false);
		expect(isConcurrentWriterFailure("Nothing to compact (session too small)")).toBe(false);
	});
	it("turns a persistent concurrent-writer failure into an actionable outcome", () => {
		const race = new Error("Session file changed since this manager accepted its durable head");
		const afterRetry = compactionFailureOutcome({
			error: race,
			failure: race.message,
			retrying: true,
			controllerAborted: false,
			declineReason: "extension X: no summary fits",
		});
		expect(afterRetry.retry).toBe(false);
		expect(afterRetry.aborted).toBe(false);
		expect(afterRetry.message).toContain("reopen the session");
		expect(afterRetry.message).toContain("extension declined");

		const firstAttempt = compactionFailureOutcome({
			error: race,
			failure: race.message,
			retrying: false,
			controllerAborted: false,
			declineReason: undefined,
		});
		expect(firstAttempt.retry).toBe(true);
		expect(firstAttempt.message).not.toContain("reopen the session");

		const cancelled = compactionFailureOutcome({
			error: new Error("Compaction cancelled"),
			failure: "Compaction cancelled",
			retrying: false,
			controllerAborted: false,
			declineReason: "extension X: nothing to compact",
		});
		expect(cancelled.aborted).toBe(true);
		expect(cancelled.cancelStatus).toContain("nothing to compact");
	});
});
