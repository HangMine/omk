/**
 * Spec 103 §2.2b: settle one suggestion request as its own turn-metric record
 * (`purpose: "suggestion"`, `parentTurnIndex`), so it never folds into the
 * parent turn's totals. Metadata only: no prompt or suggestion text is stored.
 */
import { join } from "node:path";
import type { SuggestionResult } from "./next-suggestion.ts";
import { type TurnMetricInput, TurnMetricsSink, turnUsageMetricFromUsage } from "./turn-metrics.ts";

export interface SuggestionSettlement {
	readonly result: SuggestionResult;
	readonly provider: string;
	readonly model: string;
	/** Index of the main turn the suggestion followed (same numbering as main records). */
	readonly parentTurnIndex: number;
	readonly startedAtEpochMs: number;
}

export function suggestionMetricInput(sessionId: string, settlement: SuggestionSettlement): TurnMetricInput {
	const { result } = settlement;
	return {
		sessionId,
		turnIndex: settlement.parentTurnIndex,
		purpose: "suggestion",
		parentTurnIndex: settlement.parentTurnIndex,
		suggestionOutcome: result.outcome,
		provider: settlement.provider,
		model: settlement.model,
		startedAtEpochMs: settlement.startedAtEpochMs,
		endedAtEpochMs: settlement.startedAtEpochMs + result.latencyMs,
		...(result.usage ? { usage: turnUsageMetricFromUsage(result.usage), stopReason: stopReasonOf(result) } : {}),
	};
}

function stopReasonOf(result: SuggestionResult): "stop" | "aborted" | "error" {
	if (result.outcome === "aborted" || result.outcome === "timeout") return "aborted";
	return result.outcome === "error" ? "error" : "stop";
}

const DISABLED = new Set(["0", "false", "off", "disable", "disabled"]);

/** Same location and opt-out as the session's own sink (`OMK_TURN_METRICS`, `OMK_TURN_METRICS_DIR`). */
export function suggestionMetricsSettler(
	sessionId: () => string,
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
): ((settlement: SuggestionSettlement) => void) | undefined {
	const flag = env.OMK_TURN_METRICS;
	if (flag !== undefined && DISABLED.has(flag.trim().toLowerCase())) return undefined;
	const sink = new TurnMetricsSink({ dir: env.OMK_TURN_METRICS_DIR ?? join(cwd, ".omk", "metrics") });
	return (settlement) => {
		try {
			sink.record(suggestionMetricInput(sessionId(), settlement));
		} catch {
			// Advisory only.
		}
	};
}
