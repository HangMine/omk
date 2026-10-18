/**
 * Compaction policy for a session file that another process also writes.
 *
 * Two decisions live here so the session keeps only the control flow:
 *
 * - whether a compaction is mandatory (the session cannot admit another request
 *   without it), which decides whether a bare `session_before_compact` cancel is
 *   honored as a veto or overridden by the built-in ladder;
 * - whether a failure is the transient result of a concurrent writer, which may be
 *   retried once against the refreshed head instead of failing a `/compact` the
 *   user explicitly asked for, or an overflow/threshold recovery.
 */

import type { Api, Model } from "omk-ai";

/** Current admission-relevant context for cancellation decisions. */
export function compactionContext(
	session: { readonly model: Model<Api> | undefined; getContextUsage(): { tokens: number | null } | undefined },
	reason: MandatoryCompactionInput["reason"],
	inputLimit: (model: Model<Api> | undefined, contextWindow: number) => number | undefined,
): MandatoryCompactionContext {
	return {
		reason,
		ceilingTokens: inputLimit(session.model, session.model?.contextWindow ?? 0),
		usageTokens: session.getContextUsage()?.tokens,
	};
}

/** Guidance when a concurrent-writer failure persists after one regeneration. */
const CONCURRENT_WRITER_GUIDANCE = "another OMK process wrote this session file; reopen the session to continue";

/** Failure text a concurrent writer of the same session file can produce. */
const CONCURRENT_WRITER_FAILURE =
	/revision_mismatch|changed while being read|session file changed since this manager|Durable file lock is held by another live process/i;

/**
 * True when the failure is only a lost race against another writer: the summary or
 * snapshot is discarded correctly, so one bounded regeneration is safe. Accepts the
 * thrown error so the type name also counts, not just its message text.
 */
export function isConcurrentWriterFailure(error: unknown): boolean {
	if (error instanceof Error) {
		if (error.name === "SessionManagerStaleWriteError") return true;
		return CONCURRENT_WRITER_FAILURE.test(error.message);
	}
	return typeof error === "string" && CONCURRENT_WRITER_FAILURE.test(error);
}

export interface MandatoryCompactionInput {
	readonly reason: "overflow" | "threshold" | "manual";
	/** Admission ceiling for the current model, or undefined when it cannot be computed. */
	readonly ceilingTokens: number | undefined;
	/** Known context tokens; null right after a compaction, before the next response. */
	readonly usageTokens: number | null | undefined;
}

/**
 * True when compaction is the only way this session can send another request: an
 * overflow already rejected the request, or the context is at/over the ceiling the
 * admission gate rejects above. A veto that produces no summary must not be the last
 * word there.
 */
export function compactionIsMandatory(input: MandatoryCompactionInput): boolean {
	if (input.reason === "overflow") return true;
	const { ceilingTokens, usageTokens } = input;
	return ceilingTokens !== undefined && typeof usageTokens === "number" && usageTokens >= ceilingTokens;
}

/** Reason recorded when a handler cancelled without saying why. */
const EXTENSION_DECLINED_WITHOUT_SUMMARY = "the extension cancelled without producing a summary";

export interface MandatoryCompactionContext {
	readonly reason: "overflow" | "threshold" | "manual";
	/** Admission ceiling for the current model, or undefined when it cannot be computed. */
	readonly ceilingTokens: number | undefined;
	/** Known context tokens; null right after a compaction, before the next response. */
	readonly usageTokens: number | null | undefined;
}

export interface HookCancellation {
	/** True when the handler's cancel is an explicit veto that must be honored. */
	readonly veto: boolean;
	/** Why the handler produced no compaction; named if the fallback also fails. */
	readonly declineReason: string;
}

/**
 * What a `session_before_compact` cancel means: a bare cancel is an explicit veto
 * while compaction is optional, while a named reason (or any cancel when compaction
 * is mandatory) yields to the built-in ladder.
 */
export function decideHookCancellation(
	reason: string | undefined,
	context: MandatoryCompactionContext,
): HookCancellation {
	return {
		veto: reason === undefined && !compactionIsMandatory(context),
		declineReason: reason ?? EXTENSION_DECLINED_WITHOUT_SUMMARY,
	};
}

/** True when a transient concurrent-writer failure should be regenerated once. */
export function shouldRegenerateAfterConcurrentWrite(error: unknown, retrying: boolean, aborted: boolean): boolean {
	return !retrying && !aborted && isConcurrentWriterFailure(error);
}

/** Human status for a cancelled compaction, naming the extension that produced nothing. */
export function cancellationStatusText(reason: "overflow" | "threshold" | "manual"): string {
	const label =
		reason === "overflow" ? "Context overflow recovery" : reason === "manual" ? "Compaction" : "Auto-compaction";
	return `${label} cancelled: an extension cancelled without producing a summary`;
}

/** The terminal event for a handler veto, kept with its cancellation status policy. */
export function cancellationEvent(reason: MandatoryCompactionInput["reason"]) {
	return {
		type: "compaction_end" as const,
		reason,
		result: undefined,
		aborted: true,
		willRetry: false,
		errorMessage: cancellationStatusText(reason),
	};
}

/** Failure text, with the declined handler named when it produced no summary. */
export function declineMessage(failure: string, declineReason: string | undefined): string {
	return declineReason === undefined ? failure : `${failure} (extension declined: ${declineReason})`;
}

/** Fields a `session_before_compact` cancel may carry. */
export interface CompactionCancelReason {
	readonly cancel?: boolean;
	readonly reason?: string;
}

export interface CompactionFailureOutcome {
	readonly retry: boolean;
	readonly aborted: boolean;
	readonly code: "aborted" | "failed" | "stale" | "quota_exhausted";
	/** Failure text with the declined handler named. */
	readonly message: string;
	/** Status for a cancelled compaction, or undefined when it failed instead. */
	readonly cancelStatus: string | undefined;
}

/**
 * What a failed compaction attempt means: whether to regenerate once, whether it was
 * a cancel rather than a failure, and the message the user should see.
 */
export function compactionFailureOutcome(input: {
	readonly error: unknown;
	readonly failure?: string;
	readonly retrying: boolean;
	readonly controllerAborted: boolean;
	readonly declineReason: string | undefined;
	readonly quotaExhausted?: (message: string) => boolean;
}): CompactionFailureOutcome {
	const failure = input.failure ?? (input.error instanceof Error ? input.error.message : String(input.error));
	const errorName =
		typeof input.error === "object" && input.error !== null && "name" in input.error
			? String((input.error as { name: unknown }).name)
			: "";
	const aborted = failure === "Compaction cancelled" || errorName === "AbortError" || input.controllerAborted;
	// The race survived a regeneration, so the user has to act: another process holds
	// this file and our in-memory head cannot be advanced without reopening it.
	const guidance = input.retrying && isConcurrentWriterFailure(input.error) ? CONCURRENT_WRITER_GUIDANCE : undefined;
	const message = `${declineMessage(failure, input.declineReason)}${guidance === undefined ? "" : ` (${guidance})`}`;
	return {
		retry: shouldRegenerateAfterConcurrentWrite(input.error, input.retrying, input.controllerAborted),
		aborted,
		code: aborted ? "aborted" : compactionFailureCode(message, input.quotaExhausted),
		message,
		cancelStatus:
			aborted && input.declineReason !== undefined ? `Compaction cancelled: ${input.declineReason}` : undefined,
	};
}

/** Termination code for a failed compaction attempt, before the quota check. */
export function compactionFailureCode(
	message: string,
	quotaExhausted?: (message: string) => boolean,
): "aborted" | "failed" | "stale" | "quota_exhausted" {
	if (message.includes("Compaction cancelled")) return "aborted";
	if (/stale|session changed during compaction|already compacted/i.test(message)) return "stale";
	return quotaExhausted?.(message) ? "quota_exhausted" : "failed";
}
