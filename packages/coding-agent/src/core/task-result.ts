/**
 * Spec 096 (P0-B): one fact-based, read-only task-result projection shared by
 * TUI, print and RPC.
 *
 * This is a pure projection of facts that already exist (prompt settlement,
 * goal acceptance receipts, finish-check skips and ledger lines). It is not a
 * second canonical task state: nothing here is persisted, and the same inputs
 * always give the same projection.
 *
 * Two orthogonal axes (doc §5.1):
 * - execution: how the prompt run settled (`prompt_settled.outcome`).
 * - check: what host-recorded checks observed.
 *
 * Only a host-recorded receipt can make the check `passed`. Anything the model
 * wrote ("passed", "REQ 1: PASS", a pasted digest) is kept as a `model_text`
 * claim and never counts as a host pass (B2, B6, B10).
 *
 * Behind `OMK_TASK_RESULT` (default off). With the flag off no `task_result`
 * event exists and every surface is unchanged.
 */
import type { FinishCheckSkipReason } from "./finish-check.ts";
import type { FinishCheckLedgerItem } from "./finish-check-requirements.ts";
import type { GoalAcceptanceResult } from "./goal-verification.ts";
import type { PromptSettledEvent, PromptSettlementOutcome } from "./prompt-settlement.ts";

export const TASK_RESULT_VERSION = 1 as const;

/** Check-observation axis (spec 096 change 2). */
export type TaskCheckObservation =
	| "none"
	| "passed"
	| "required_failed"
	| "insufficient"
	| "cancel_pending"
	| "cancelled";

/** Who recorded a fact. Only `host_receipt` can reach `passed`. */
export type TaskResultSource = "host_receipt" | "model_text";

export type TaskCheckFactStatus = "passed" | "failed" | "insufficient" | "cancel_pending" | "cancelled";

/** Why a fact is `insufficient` rather than a pass or a failure. */
export type TaskCheckInsufficientReason =
	| "partial"
	| "missing"
	| "stale"
	| "zero_tests"
	| "skipped"
	| "unavailable"
	| "gate_closed"
	| "aborted";

/** One observation from one registered check. */
export interface TaskCheckFact {
	/** Stable id within the run, e.g. `goal-acceptance:<receiptId>`. */
	readonly id: string;
	readonly source: TaskResultSource;
	readonly status: TaskCheckFactStatus;
	/** A required check gates `passed`; an optional one only adds coverage. */
	readonly required: boolean;
	readonly reason?: TaskCheckInsufficientReason;
	/** The host receipt id, set only for `host_receipt` facts. */
	readonly receiptId?: string;
}

/** What the model said about the result. Never promoted to a host fact. */
export interface TaskModelClaim {
	readonly source: "model_text";
	readonly says: "passed" | "failed" | "unknown";
	/** The claim's text, bounded, for the operator. */
	readonly text: string;
}

export interface TaskResultCoverage {
	/** Host-registered checks that ran to a pass or a failure. */
	readonly checksRun: number;
	/** Host-registered checks, run or not. */
	readonly checksTotal: number;
}

export interface TaskResultProjection {
	readonly version: typeof TASK_RESULT_VERSION;
	readonly promptRunId: string;
	readonly execution: PromptSettlementOutcome;
	readonly check: TaskCheckObservation;
	/** Source of the `check` value: `host_receipt` only when host facts decided it. */
	readonly checkSource: TaskResultSource | "none";
	readonly coverage: TaskResultCoverage;
	readonly facts: readonly TaskCheckFact[];
	readonly modelClaims: readonly TaskModelClaim[];
}

/** The new versioned event; `*_settled` events are unchanged (D1). */
export interface TaskResultEvent {
	readonly type: "task_result";
	readonly version: typeof TASK_RESULT_VERSION;
	readonly projection: TaskResultProjection;
}

export interface TaskResultInput {
	readonly settled: Pick<PromptSettledEvent, "promptRunId" | "outcome">;
	readonly facts?: readonly TaskCheckFact[];
	readonly modelClaims?: readonly TaskModelClaim[];
}

/** `OMK_TASK_RESULT` is on only for `1` or `true`; unset, empty and `0` are off. */
export function isTaskResultEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
	const value = env.OMK_TASK_RESULT?.trim().toLowerCase();
	return value === "1" || value === "true";
}

function hostFacts(facts: readonly TaskCheckFact[]): TaskCheckFact[] {
	return facts.filter((fact) => fact.source === "host_receipt");
}

/** The check axis from facts alone. `model_text` facts are ignored here by construction. */
export function projectCheckObservation(
	facts: readonly TaskCheckFact[],
	execution: PromptSettlementOutcome,
): TaskCheckObservation {
	const host = hostFacts(facts);
	if (host.length === 0) return "none";
	const required = host.filter((fact) => fact.required);
	if (required.some((fact) => fact.status === "failed")) return "required_failed";
	if (host.some((fact) => fact.status === "cancel_pending")) return "cancel_pending";
	if (required.some((fact) => fact.status === "cancelled")) return "cancelled";
	if (required.length === 0) return "none";
	if (required.some((fact) => fact.status !== "passed")) return "insufficient";
	// An aborted run cannot be verified even when every check it ran passed.
	if (execution !== "completed") return "insufficient";
	return "passed";
}

export function projectCoverage(facts: readonly TaskCheckFact[]): TaskResultCoverage {
	const host = hostFacts(facts);
	return {
		checksRun: host.filter((fact) => fact.status === "passed" || fact.status === "failed").length,
		checksTotal: host.length,
	};
}

export function projectTaskResult(input: TaskResultInput): TaskResultProjection {
	const facts = input.facts ?? [];
	const check = projectCheckObservation(facts, input.settled.outcome);
	return {
		version: TASK_RESULT_VERSION,
		promptRunId: input.settled.promptRunId,
		execution: input.settled.outcome,
		check,
		checkSource: check === "none" ? "none" : "host_receipt",
		coverage: projectCoverage(facts),
		facts: facts.map((fact) => ({ ...fact })),
		modelClaims: (input.modelClaims ?? []).map((claim) => ({ ...claim })),
	};
}

export function buildTaskResultEvent(input: TaskResultInput): TaskResultEvent {
	return { type: "task_result", version: TASK_RESULT_VERSION, projection: projectTaskResult(input) };
}

// ---------------------------------------------------------------------------
// Read-only adapters (goal acceptance, finish-check). verified-run is out (D2).

export interface GoalAcceptanceFactOptions {
	/** Workspace SHA-256 now; a different value means an edit after the check (stale). */
	readonly currentWorkspaceSha256?: string;
	/** Tests the check matched, when the runner reports it; 0 is never a pass. */
	readonly matchedTests?: number;
	readonly required?: boolean;
}

/** One host fact from a goal acceptance receipt. */
export function factFromGoalAcceptance(
	result: Pick<GoalAcceptanceResult, "receiptId" | "status" | "passed" | "workspace">,
	options: GoalAcceptanceFactOptions = {},
): TaskCheckFact {
	const base = {
		id: `goal-acceptance:${result.receiptId}`,
		source: "host_receipt" as const,
		required: options.required ?? true,
		receiptId: result.receiptId,
	};
	switch (result.status) {
		case "failed":
			return { ...base, status: "failed" };
		case "aborted":
			return { ...base, status: "cancelled" };
		case "timeout":
			return { ...base, status: "insufficient", reason: "unavailable" };
		case "passed":
			break;
	}
	const completeness = result.workspace.completeness;
	if (completeness === "unavailable") return { ...base, status: "insufficient", reason: "unavailable" };
	if (completeness !== "complete") return { ...base, status: "insufficient", reason: "partial" };
	if (!result.passed) return { ...base, status: "insufficient", reason: "gate_closed" };
	if (options.matchedTests === 0) return { ...base, status: "insufficient", reason: "zero_tests" };
	if (options.currentWorkspaceSha256 !== undefined && options.currentWorkspaceSha256 !== result.workspace.sha256)
		return { ...base, status: "insufficient", reason: "stale" };
	return { ...base, status: "passed" };
}

/** A finish check that was registered but skipped: host-recorded, never a pass. */
export function factFromFinishCheckSkip(reason: FinishCheckSkipReason, required = false): TaskCheckFact {
	return {
		id: `finish-check:skipped:${reason}`,
		source: "host_receipt",
		status: reason === "aborted" ? "cancelled" : "insufficient",
		required,
		...(reason === "aborted" ? {} : { reason: "skipped" as const }),
	};
}

const CLAIM_TEXT_CHARS = 160;

function boundClaim(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= CLAIM_TEXT_CHARS ? flat : `${flat.slice(0, CLAIM_TEXT_CHARS - 1)}…`;
}

/** Finish-check ledger lines are the model's own report: claims, not host facts. */
export function claimsFromFinishCheckLedger(items: readonly FinishCheckLedgerItem[]): TaskModelClaim[] {
	return items
		.filter((item) => item.status !== "unreported")
		.map((item) => ({
			source: "model_text" as const,
			says: item.status === "pass" ? ("passed" as const) : ("failed" as const),
			text: boundClaim(`REQ ${item.id}: ${item.status.toUpperCase()}${item.measured ? ` - ${item.measured}` : ""}`),
		}));
}

const MODEL_PASS = /\b(?:all\s+(?:tests|checks)\s+pass(?:ed)?|tests?\s+pass(?:ed)?|passed|PASS|done|verified)\b/i;
const MODEL_FAIL = /\b(?:failed|FAIL|failing|failures?|errors?)\b/i;
/** Zero-count phrases ("0 failed", "no failures") report the absence of a failure, not a failure. */
const MODEL_ZERO_FAIL =
	/\b(?:0|zero|no)\s+(?:tests?\s+|checks?\s+)?(?:failed|failing|failures?|errors?|fail)\b|\bwithout\s+(?:any\s+)?(?:failures?|errors?)\b/gi;

/**
 * A free-text model claim, if the text makes one. Kept as `model_text` whatever it quotes.
 * Zero-count failure phrases are not failures; any remaining (nonzero) failure phrase is `failed`,
 * even next to a pass phrase. `passed` needs an explicit pass phrase; zero-count-only text is `unknown`.
 */
export function claimFromModelText(text: string): TaskModelClaim | undefined {
	const hasZeroFail = new RegExp(MODEL_ZERO_FAIL.source, "i").test(text);
	const rest = text.replace(MODEL_ZERO_FAIL, " ");
	const fail = MODEL_FAIL.test(rest);
	const pass = MODEL_PASS.test(rest);
	if (fail) return { source: "model_text", says: "failed", text: boundClaim(text) };
	if (pass) return { source: "model_text", says: "passed", text: boundClaim(text) };
	if (hasZeroFail) return { source: "model_text", says: "unknown", text: boundClaim(text) };
	return undefined;
}

// ---------------------------------------------------------------------------
// Surface renderers. Every surface renders the same projection object (B1).

/** One line for print text mode and the TUI. */
export function formatTaskResultLine(projection: TaskResultProjection): string {
	const { checksRun, checksTotal } = projection.coverage;
	return `task result: execution ${projection.execution}, check ${projection.check} (${projection.checkSource}), checks ${checksRun}/${checksTotal}`;
}

/** The RPC / print-json line: the event itself, serialized once. */
export function serializeTaskResultEvent(event: TaskResultEvent): string {
	return JSON.stringify(event);
}
