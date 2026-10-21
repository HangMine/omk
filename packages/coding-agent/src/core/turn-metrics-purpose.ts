/** Spec 103 §2.2b: per-purpose breakdown of turn-metric records (main vs suggestion). */
import type { TurnMetricPurpose, TurnMetricRecord } from "./turn-metrics-record.ts";

export interface PurposeUsageTotals {
	readonly records: number;
	/** Records without usage: missing coverage, never counted as 0. */
	readonly missingUsage: number;
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly costUsd: number;
	/** Suggestion records only: cost of outcomes `aborted` and `timeout`. */
	readonly cancelledCostUsd: number;
}

export function summarizeByPurpose(
	records: readonly TurnMetricRecord[],
): Readonly<Record<TurnMetricPurpose, PurposeUsageTotals>> {
	const empty = () => ({
		records: 0,
		missingUsage: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		costUsd: 0,
		cancelledCostUsd: 0,
	});
	const result = { main: empty(), suggestion: empty() };
	for (const record of records) {
		const bucket = result[record.purpose ?? "main"];
		bucket.records++;
		const usage = record.usage;
		if (!usage) {
			bucket.missingUsage++;
			continue;
		}
		bucket.input += usage.input;
		bucket.output += usage.output;
		bucket.cacheRead += usage.cacheRead;
		bucket.cacheWrite += usage.cacheWrite ?? 0;
		bucket.costUsd += usage.costUsd;
		if (record.suggestionOutcome === "aborted" || record.suggestionOutcome === "timeout") {
			bucket.cancelledCostUsd += usage.costUsd;
		}
	}
	return result;
}
