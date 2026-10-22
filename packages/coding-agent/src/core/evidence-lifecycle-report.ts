/** Spec 106 D1: the counts-only report for ONE session's evidence registry, plus the unattributed count. */
import {
	EVIDENCE_UNATTRIBUTED,
	type EvidenceArtifactRecord,
	type EvidenceHoldReason,
	type EvidenceLifecycleReport,
	type EvidenceProducer,
	type EvidenceProducerGroup,
	evidenceRegistryStats,
	listEvidenceArtifacts,
	type UnknownHoldShare,
} from "./evidence-lifecycle.ts";
import { currentEvidenceSession } from "./evidence-lifecycle-scope.ts";

const PRODUCER_GROUP: Readonly<Record<EvidenceProducer, EvidenceProducerGroup>> = {
	"goal-recall": "recall",
	"read-spill": "spill",
	"bash-spill": "spill",
	"tool-output-log": "bash",
	"bash-executor-log": "executor",
};

function share(unknown: number, present: number): number {
	return present === 0 ? 0 : Math.round((unknown / present) * 10_000) / 10_000;
}

export function evidenceLifecycleReport(sessionId: string = currentEvidenceSession()): EvidenceLifecycleReport {
	const groups: Record<EvidenceProducerGroup, { present: number; unknown: number }> = {
		recall: { present: 0, unknown: 0 },
		spill: { present: 0, unknown: 0 },
		bash: { present: 0, unknown: 0 },
		executor: { present: 0, unknown: 0 },
	};
	const byProducer: Partial<Record<EvidenceProducer, number>> = {};
	const holdReasons: Partial<Record<EvidenceHoldReason, number>> = {};
	let [present, presentBytes, removed, unknown, blockedExhausted] = [0, 0, 0, 0, 0];
	const would: EvidenceArtifactRecord[] = [];
	for (const record of listEvidenceArtifacts(sessionId)) {
		byProducer[record.producer] = (byProducer[record.producer] ?? 0) + 1;
		if (record.status !== "present") {
			removed += 1;
			continue;
		}
		present += 1;
		presentBytes += record.bytes;
		const group = groups[PRODUCER_GROUP[record.producer]];
		group.present += 1;
		if (record.holds.includes("unknown")) {
			group.unknown += 1;
			unknown += 1;
		}
		if (record.blockedExhausted) blockedExhausted += 1;
		for (const hold of record.holds) holdReasons[hold] = (holdReasons[hold] ?? 0) + 1;
		if (record.holds.length === 0) would.push(record);
	}
	const stats = evidenceRegistryStats(sessionId);
	return {
		mode: "observe",
		registered: stats.registered,
		present,
		presentBytes,
		removedByExistingPolicy: removed,
		byProducer,
		holdReasons,
		unknownHoldShare: share(unknown, present),
		unknownHoldShareByProducer: Object.fromEntries(
			Object.entries(groups).map(([name, g]) => [name, { ...g, share: share(g.unknown, g.present) }]),
		) as Record<EvidenceProducerGroup, UnknownHoldShare>,
		blockedExhausted,
		wouldDelete: {
			count: would.length,
			bytes: would.reduce((sum, record) => sum + record.bytes, 0),
			artifactIds: would.map((record) => record.artifactId),
		},
		deletes: 0,
		overflow: stats.overflow,
		// Process-wide count of artifacts with no owning session; never merged into this session's counts.
		unattributed: sessionId === EVIDENCE_UNATTRIBUTED ? 0 : evidenceRegistryStats(EVIDENCE_UNATTRIBUTED).registered,
	};
}
