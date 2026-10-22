/** Spec 106 D1 (observe only): lifecycle hooks for goal recall files. Records state; deletes nothing. */
import { registerEvidenceArtifact, updateEvidenceArtifactsByOwner } from "./evidence-lifecycle.ts";

/** The repair turn that reads the file and the re-run check that verifies the fix. */
export const RECALL_CONSUMERS = ["repair-turn", "acceptance-recheck"] as const;

export function registerRecallEvidence(file: string, goalId: string, bytes: number, contentSha256: string): void {
	registerEvidenceArtifact({
		producer: "goal-recall",
		path: file,
		owner: goalId,
		bytes,
		contentSha256,
		requiredConsumers: RECALL_CONSUMERS,
		goalActive: true,
	});
}

/**
 * A settled (non-aborted) re-run of `goalId`'s check consumed its earlier recall files; a pass also ends
 * the goal-active hold. A failing re-run keeps the goal-active hold (the next repair may still need them).
 */
export function observeRecallRecheck(goalId: string, passed: boolean): void {
	updateEvidenceArtifactsByOwner(goalId, {
		consumed: RECALL_CONSUMERS,
		verified: passed,
		...(passed ? { goalActive: false } : {}),
	});
}

/** The goal was blocked with rounds exhausted: classify its recall files; holds stay (no state change). */
export function observeRecallBlockedExhausted(goalId: string): void {
	updateEvidenceArtifactsByOwner(goalId, { blockedExhausted: true });
}
