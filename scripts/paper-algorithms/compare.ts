import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VerifiedMemoryStore } from "../../packages/coding-agent/src/core/verified-memory-store.ts";
import { planJointBudget, updateBudgetShadowPrice, type JointBudgetInput } from "../../packages/coding-agent/src/core/paper-joint-budget.ts";
import { assignProvenanceCredit } from "../../packages/coding-agent/src/core/paper-provenance-credit.ts";
import { evaluateExperiencePromotion } from "../../packages/coding-agent/src/core/paper-experience-gate.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const strategies = ["static", "cost-only", "jove-lite"] as const;
const comparison = strategies.map((strategy) => {
	const observed = new Map<string, { wins: number; count: number }>();
	let shadowPrice = 0.004;
	let successes = 0;
	let abstentions = 0;
	let spent = 0;
	let verificationSpend = 0;
	let errorsDiscovered = 0;
	let labels = 0;
	let pathMs = 0;
	for (let graph = 0; graph < 30; graph++) {
		const type = graph % 3;
		const models = ["small", "medium", "large"];
		const truth = type === 0 ? [0.82, 0.84, 0.91] : type === 1 ? [0.3, 0.72, 0.94] : [0.55, 0.8, 0.9];
		const nodes = Array.from({ length: 3 }, (_, node) => ({
			id: `node-${node}`,
			dependencies: node === 2 ? ["node-0", "node-1"] : [],
			mandatoryVerification: false,
			candidates: models.map((model, index) => {
				const prior = observed.get(`${type}:${model}`);
				return { model, quality: prior ? (prior.wins + 1) / (prior.count + 2) : [0.6, 0.75, 0.9][index], uncertainty: 1 / Math.sqrt((prior?.count ?? 0) + 1), costMicros: [6, 12, 20][index], latencyMs: [4, 8, 14][index], verificationCostMicros: 3 };
			}),
		}));
		const input: JointBudgetInput = { nodes, budgetMicros: 44, deadlineMs: 40, overheadCostMicros: 2, overheadLatencyMs: 2, shadowPrice, verificationWeight: 0.8 };
		const policy = strategy === "jove-lite" ? input : {
			...input, verificationWeight: 0, shadowPrice: 0,
			nodes: nodes.map((node) => ({ ...node, candidates: node.candidates.filter((option) => option.model === (strategy === "static" ? "medium" : "small")) })),
		};
		const report = planJointBudget(policy);
		if (report.status !== "planned") { abstentions++; spent += input.overheadCostMicros; continue; }
		if (report.totalCostMicros > input.budgetMicros || report.criticalPathMs > input.deadlineMs) throw new Error("comparison exceeded bounds");
		spent += report.totalCostMicros;
		verificationSpend += report.verificationCostMicros;
		pathMs += report.criticalPathMs;
		let allCorrect = true;
		const feedback: Array<{ key: string; correct: boolean }> = [];
		for (const choice of report.decisions) {
			const modelIndex = models.indexOf(choice.model);
			// Shared frozen synthetic outcomes, independent of the policy's choices or training labels.
			const draw = Number.parseInt(hash(`${graph}:${choice.node}:${choice.model}`).slice(0, 8), 16) / 0x100000000;
			const correct = draw < truth[modelIndex];
			allCorrect &&= correct;
			if (choice.verify) { labels++; errorsDiscovered += Number(!correct); feedback.push({ key: `${type}:${choice.model}`, correct }); }
		}
		successes += Number(allCorrect);
		// Delayed labels affect only later graphs. This toy Beta estimator is not paper LinUCB.
		for (const label of feedback) {
			const prior = observed.get(label.key) ?? { wins: 0, count: 0 };
			observed.set(label.key, { wins: prior.wins + Number(label.correct), count: prior.count + 1 });
		}
		shadowPrice = updateBudgetShadowPrice({ price: shadowPrice, actualCostMicros: report.totalCostMicros, targetCostMicros: 30, step: 0.0001, maxPrice: 1 });
	}
	return { strategy, graphs: 30, successes, abstentions, totalCostMicros: spent, verificationCostMicros: verificationSpend, meanCriticalPathMs: pathMs / (30 - abstentions || 1), verifiedLabelsForLaterGraphs: labels, errorsDiscovered, errorsCorrectedInCurrentResponse: 0 };
});

let uniformIrrelevant = 0;
let provenanceIrrelevant = 0;
for (let index = 0; index < 100; index++) {
	const trace = { verificationAtMs: 10, passed: true, inspectedResources: ["output"], steps: [
		{ id: "read", atMs: 1, reads: ["source"], writes: [], dependencies: [] },
		{ id: "write", atMs: 2, reads: ["source"], writes: ["output"], dependencies: ["read"] },
		{ id: "noise", atMs: 3, reads: [], writes: ["other"], dependencies: [] },
		{ id: "future", atMs: 11, reads: ["output"], writes: [], dependencies: ["write"] },
	] };
	uniformIrrelevant += 2;
	const credit = assignProvenanceCredit(trace);
	provenanceIrrelevant += Number(credit.weights.noise > 0) + Number(credit.weights.future > 0);
}
const rejectedPromotion = evaluateExperiencePromotion({
	candidateHash: hash("candidate"), evaluatedCandidateHash: hash("candidate"), baselineHash: hash("baseline"), frozenBaselineHash: hash("baseline"),
	baselineModelHash: hash("model"), candidateModelHash: hash("model"), baselineVerifierHash: hash("verifier"), candidateVerifierHash: hash("verifier"), cohortImproved: true,
	trainingIds: ["train"], holdoutIds: Array.from({ length: 20 }, (_, i) => `held-${i}`),
	baselineHoldoutSuccesses: Array(20).fill(true), candidateHoldoutSuccesses: Array(20).fill(false),
	humanApproved: false, verificationPassed: true, costLimitMicros: 10,
	costs: { execution: 2, verification: 2, director: 1, skillUpdate: 1, candidateSearch: 1, rejectedAttempts: 1 },
});
const memory20 = { scenarios: 20, factOnlyRecalled: 0, typedRecalled: 0, causalTimeRecalled: 0, futureRecordsOmitted: 0, revokedRecordsRecalled: 0, retainedTombstones: 0 };
for (let scenario = 0; scenario < 20; scenario++) {
	const directory = mkdtempSync(join(tmpdir(), "omk-paper-memory-"));
	const clock = Date.now;
	const cutoff = 1_700_000_000_000 + scenario * 100;
	try {
		writeFileSync(join(directory, "facts.txt"), "Factual storage uses events.\nCollaboration method uses bounded checks.\nLater fact uses snapshots.\n");
		const store = new VerifiedMemoryStore(directory);
		Date.now = () => cutoff;
		const fact = store.remember({ path: "facts.txt", startLine: 1, endLine: 1, memoryType: "fact" });
		store.remember({ path: "facts.txt", startLine: 2, endLine: 2, memoryType: "agent_method" });
		Date.now = () => cutoff + 1;
		store.remember({ path: "facts.txt", startLine: 3, endLine: 3, memoryType: "fact" });
		Date.now = () => cutoff + 2;
		const current = store.retrieve().records;
		memory20.factOnlyRecalled += current.filter((record) => record.version === 2 && record.memoryType === "fact").length;
		memory20.typedRecalled += current.length;
		const bounded = store.retrieve({ asOfMs: cutoff });
		memory20.causalTimeRecalled += bounded.records.length;
		memory20.futureRecordsOmitted += bounded.omitted;
		if (fact.verdict !== "accept") throw new Error("synthetic memory admission failed");
		store.forget(fact.recordId);
		memory20.revokedRecordsRecalled += Number(store.retrieve().records.some((record) => record.id === fact.recordId));
		memory20.retainedTombstones += Number(JSON.parse(readFileSync(join(directory, ".omk", "verified-memory", `${fact.recordId}.revoked.json`), "utf8")).revoked === true);
	} finally { Date.now = clock; rmSync(directory, { recursive: true, force: true }); }
}
console.log(JSON.stringify({
	schemaVersion: "omk.paper-comparison.v1", evidenceKind: "synthetic-offline-mechanism-check", providerCalls: 0,
	isPaperReproduction: false, isAccuracyClaim: false, hardBudgetPerGraphMicros: 44, hardDeadlineMs: 40,
	comparison, provenance100: { uniformIrrelevant, provenanceIrrelevant }, memory20,
	heldout20: { decision: rejectedPromotion.decision, blockers: rejectedPromotion.blockers, activatesSkill: rejectedPromotion.activatesSkill },
	limitations: ["Synthetic fixtures, not real OMK tasks", "30 graphs are one deterministic cohort, not independent evolution seeds", "Beam heuristic and toy Beta feedback, not exact MILP/LinUCB", "Verification observes errors for future learning and does not repair current answers", "No deployment or automatic skill promotion"],
}, null, 2));
