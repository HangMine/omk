import { type EvaluationResult, PROTOCOL_VERSION, type SemanticVerdict } from "omk-protocol";
import { describe, expect, it, vi } from "vitest";
import { type AdvisoryJudge, chooseWithAdvisoryJudge } from "../src/index.ts";

const RUBRIC = [
	{ id: "correctness", description: "Satisfies the task and cited evidence", weight: 3 },
	{ id: "safety", description: "Preserves security and deterministic gates", weight: 2 },
] as const;

function evaluation(attemptId: string, semanticVerdict: SemanticVerdict): EvaluationResult {
	return {
		schemaVersion: PROTOCOL_VERSION,
		evaluationId: `evaluation-${attemptId}`,
		taskId: "task-1",
		attemptId,
		evaluatedAt: "2026-08-19T00:00:00.000Z",
		claims: [
			{
				claimId: "required-checks",
				requirement: "required",
				result: semanticVerdict === "pass" ? "satisfied" : semanticVerdict === "fail" ? "violated" : "inconclusive",
				reasonCode:
					semanticVerdict === "pass"
						? "claim.satisfied"
						: semanticVerdict === "fail"
							? "claim.violated"
							: "claim.observation_missing",
				observationIds: semanticVerdict === "inconclusive" ? [] : [`observation-${attemptId}`],
			},
		],
		semanticVerdict,
	};
}

function validScores(first: number, second: number): string {
	return JSON.stringify({
		scores: [
			{
				candidateId: "candidate-a",
				criteria: [
					{ criterionId: "correctness", score: first },
					{ criterionId: "safety", score: first },
				],
			},
			{
				candidateId: "candidate-b",
				criteria: [
					{ criterionId: "correctness", score: second },
					{ criterionId: "safety", score: second },
				],
			},
		],
	});
}

describe("advisory best-of-N judge", () => {
	it("falls back deterministically when the judge throws or returns malformed scores", async () => {
		const candidates = [
			{ id: "candidate-b", deterministicRank: 2, material: "B", evaluation: evaluation("b", "pass") },
			{ id: "candidate-a", deterministicRank: 1, material: "A", evaluation: evaluation("a", "pass") },
		];
		const unavailable = await chooseWithAdvisoryJudge({
			taskGoal: "Choose",
			judgeId: "reviewer-1",
			judge: async () => {
				throw new Error("provider included secret-shaped diagnostics");
			},
			rubric: RUBRIC,
			candidates,
		});
		const malformed = await chooseWithAdvisoryJudge({
			taskGoal: "Choose",
			judgeId: "reviewer-1",
			judge: async () => '{"scores":[{"candidateId":"candidate-failed","criteria":[]}]}',
			rubric: RUBRIC,
			candidates,
		});
		const nonString = await chooseWithAdvisoryJudge({
			taskGoal: "Choose",
			judgeId: "reviewer-1",
			judge: async () => null,
			rubric: RUBRIC,
			candidates,
		});

		expect(unavailable).toMatchObject({
			status: "fallback",
			reason: "judge-unavailable",
			source: "deterministic",
			selectedCandidateId: "candidate-a",
		});
		expect(malformed).toMatchObject({
			status: "fallback",
			reason: "judge-response-invalid",
			source: "deterministic",
			selectedCandidateId: "candidate-a",
		});
		expect(nonString).toMatchObject({
			status: "fallback",
			reason: "judge-response-invalid",
			selectedCandidateId: "candidate-a",
		});
		expect(JSON.stringify(unavailable)).not.toContain("provider included");
	});

	it("uses deterministic order for score ties and skips the judge for zero or one eligible candidate", async () => {
		const tied = await chooseWithAdvisoryJudge({
			taskGoal: "Choose",
			judgeId: "reviewer-1",
			judge: async () => validScores(4, 4),
			rubric: RUBRIC,
			candidates: [
				{ id: "candidate-b", deterministicRank: 2, material: "B", evaluation: evaluation("b", "pass") },
				{ id: "candidate-a", deterministicRank: 1, material: "A", evaluation: evaluation("a", "pass") },
			],
		});
		const judge = vi.fn<AdvisoryJudge>(async () => validScores(4, 4));
		const one = await chooseWithAdvisoryJudge({
			taskGoal: "Choose",
			judgeId: "reviewer-1",
			judge,
			rubric: RUBRIC,
			candidates: [
				{ id: "candidate-a", deterministicRank: 1, material: "A", evaluation: evaluation("a", "pass") },
				{ id: "candidate-failed", deterministicRank: 0, material: "F", evaluation: evaluation("f", "fail") },
			],
		});
		const none = await chooseWithAdvisoryJudge({
			taskGoal: "Choose",
			judgeId: "reviewer-1",
			judge,
			rubric: RUBRIC,
			candidates: [
				{ id: "candidate-failed", deterministicRank: 0, material: "F", evaluation: evaluation("f", "fail") },
			],
		});

		expect(tied.selectedCandidateId).toBe("candidate-a");
		expect(one).toMatchObject({ status: "skipped", reason: "single-eligible", selectedCandidateId: "candidate-a" });
		expect(none).toMatchObject({ status: "skipped", reason: "no-eligible", source: "none" });
		expect(none.selectedCandidateId).toBeUndefined();
		expect(judge).not.toHaveBeenCalled();
	});

	it("rejects duplicate IDs, ranks, and cross-task evaluation inputs before invoking the judge", async () => {
		const judge = vi.fn<AdvisoryJudge>(async () => validScores(4, 4));
		const base = { id: "candidate-a", deterministicRank: 1, material: "A", evaluation: evaluation("a", "pass") };
		const otherTask = { ...evaluation("b", "pass"), taskId: "task-2" };

		await expect(
			chooseWithAdvisoryJudge({
				taskGoal: "Choose",
				judgeId: "reviewer-1",
				judge,
				rubric: RUBRIC,
				candidates: [base, { ...base, evaluation: evaluation("b", "pass") }],
			}),
		).rejects.toThrow("candidate IDs must be unique");
		await expect(
			chooseWithAdvisoryJudge({
				taskGoal: "Choose",
				judgeId: "reviewer-1",
				judge,
				rubric: RUBRIC,
				candidates: [base, { ...base, id: "candidate-b", evaluation: evaluation("b", "pass") }],
			}),
		).rejects.toThrow("deterministic ranks must be unique");
		await expect(
			chooseWithAdvisoryJudge({
				taskGoal: "Choose",
				judgeId: "reviewer-1",
				judge,
				rubric: RUBRIC,
				candidates: [base, { ...base, id: "candidate-b", deterministicRank: 2, evaluation: otherTask }],
			}),
		).rejects.toThrow("one taskId");
		expect(judge).not.toHaveBeenCalled();
	});
});
