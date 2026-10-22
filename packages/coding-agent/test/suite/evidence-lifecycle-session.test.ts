/**
 * Spec 106 D1 session sink: a goal-less session gets exactly one `evidence_lifecycle` custom entry per
 * settled prompt when OMK_EVIDENCE_LIFECYCLE=observe; flag off writes none. Never in model context.
 */
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { fauxAssistantMessage } from "omk-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEvidenceLifecycleForTest } from "../../src/core/evidence-lifecycle.ts";
import { EVIDENCE_LIFECYCLE_ENTRY_TYPE } from "../../src/core/evidence-lifecycle-session.ts";
import type { SessionManager } from "../../src/core/session-manager.ts";
import { spillTruncatedOutput } from "../../src/core/tools/artifact-spill.ts";
import { createHarness, type Harness } from "./harness.ts";

const SECRET = "SECRET-RAW-d1-session-91c2";
const harnesses: Harness[] = [];
const spills: string[] = [];

beforeEach(() => resetEvidenceLifecycleForTest());
afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
	for (const dir of spills.splice(0)) rmSync(dir, { recursive: true, force: true });
	vi.unstubAllEnvs();
	resetEvidenceLifecycleForTest();
});

function entries(sm: SessionManager) {
	return sm.getEntries().filter((e) => e.type === "custom" && e.customType === EVIDENCE_LIFECYCLE_ENTRY_TYPE);
}

function spill(): string {
	const { path } = spillTruncatedOutput({ kind: "read", preview: "p", full: SECRET, truncated: true, path: "/x" });
	spills.push(dirname(path));
	return path;
}

describe("spec 106 D1 session sink", () => {
	it("flag off: no evidence_lifecycle entry, even after settle and dispose", async () => {
		vi.stubEnv("OMK_EVIDENCE_LIFECYCLE", undefined);
		const harness = await createHarness();
		harnesses.push(harness);
		spill();
		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("hello");
		harness.session.dispose();
		expect(entries(harness.sessionManager)).toHaveLength(0);
	});

	it("flag observe: a goal-less session gets the entry exactly once per settle, counts only, not in context", async () => {
		vi.stubEnv("OMK_EVIDENCE_LIFECYCLE", "observe");
		const harness = await createHarness();
		harnesses.push(harness);
		const path = spill();
		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("hello");
		const written = entries(harness.sessionManager);
		expect(written).toHaveLength(1);
		const data = (written[0] as { data: Record<string, unknown> }).data;
		expect(data).toMatchObject({
			schemaVersion: 1,
			report: {
				mode: "observe",
				deletes: 0,
				present: 1,
				unknownHoldShare: 1,
				unknownHoldShareByProducer: { spill: { present: 1, unknown: 1, share: 1 } },
			},
		});
		const serialized = JSON.stringify(harness.sessionManager.getEntries());
		expect(serialized).not.toContain(SECRET);
		expect(serialized).not.toContain(path);
		expect(JSON.stringify(harness.session.messages)).not.toContain(EVIDENCE_LIFECYCLE_ENTRY_TYPE);
		harness.session.dispose();
		expect(entries(harness.sessionManager)).toHaveLength(1);
	});

	it("flag observe: a second prompt adds one more entry (one per settle)", async () => {
		vi.stubEnv("OMK_EVIDENCE_LIFECYCLE", "observe");
		const harness = await createHarness();
		harnesses.push(harness);
		for (const text of ["a", "b"]) {
			harness.setResponses([fauxAssistantMessage("ok")]);
			await harness.session.prompt(text);
		}
		expect(entries(harness.sessionManager)).toHaveLength(2);
	});
});
