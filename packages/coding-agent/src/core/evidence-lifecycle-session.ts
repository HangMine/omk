/**
 * Spec 106 D1 session sink (flag `OMK_EVIDENCE_LIFECYCLE=observe` only): one versioned custom session entry
 * per settled prompt, so goal-less sessions are sampled too. A `custom` entry (not a custom message) is
 * never sent to the model. Digests and counts only; flag off writes nothing.
 */
import {
	type EvidenceLifecycleReport,
	evidenceLifecycleObserveEnabled,
	evidenceLifecycleReport,
} from "./evidence-lifecycle.ts";

export const EVIDENCE_LIFECYCLE_ENTRY_TYPE = "evidence_lifecycle";

export interface EvidenceLifecycleEntryData {
	readonly schemaVersion: 1;
	/** Each entry is the whole report so far, not a delta: analyse the last entry per session. */
	readonly aggregation: "cumulative";
	/** 0-based, monotonic per session (counts this session's earlier entries, so it survives resume). */
	readonly settleIndex: number;
	readonly report: EvidenceLifecycleReport;
}

export function appendEvidenceLifecycleEntry(sink: {
	appendCustomEntry(customType: string, data?: unknown): string;
	getEntries(): readonly { type: string; customType?: string }[];
}): void {
	if (!evidenceLifecycleObserveEnabled()) return;
	try {
		const settleIndex = sink
			.getEntries()
			.filter((e) => e.type === "custom" && e.customType === EVIDENCE_LIFECYCLE_ENTRY_TYPE).length;
		const data: EvidenceLifecycleEntryData = {
			schemaVersion: 1,
			aggregation: "cumulative",
			settleIndex,
			report: evidenceLifecycleReport(),
		};
		sink.appendCustomEntry(EVIDENCE_LIFECYCLE_ENTRY_TYPE, data);
	} catch {
		// Observation must never fail the prompt.
	}
}
