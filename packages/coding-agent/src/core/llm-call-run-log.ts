/**
 * `llm-call.jsonl`: one run-log line per LLM provider call (spec 059, on top of spec 042).
 *
 * Bench runs use `--no-session --mode json`, so per-call usage never reaches a session file.
 * This wrapper sits directly around the provider stream in `createSdkProviderStream`, below
 * spec 033's reasoning cap, so every real request (main turns, compaction and summary calls,
 * and a cap retry as its own request) gets exactly one line with the effort it was sent with.
 *
 * OFF BY DEFAULT: with `OMK_RUN_LOG_DIR` unset when the stream is created, the inner stream
 * function is returned unchanged: no wrapper, no hashing, no clock reads, no file.
 *
 * REQUEST BYTES: the wrapper passes `model`, `context` and `options` through as the same
 * objects and only reads them. It observes the returned stream through `result()` and never
 * consumes or reorders its events.
 *
 * PRIVACY (spec 042): numbers, ids, sha256 hashes and enum names only. Never prompt text,
 * tool arguments, model output, paths, URLs, headers or error messages.
 *
 * `phase` and `phaseSource` are reserved for spec 037 (per-phase effort) and are always `null`
 * here, so a verdict script can read one schema before and after 037 lands.
 */
import type { StreamFn } from "omk-agent-core";
import type { AssistantMessage, StopReason } from "omk-ai";
import { systemHash, toolsHash } from "omk-ai/prompt-hash";
import { appendRunLog, RUN_LOG_DIR_ENV, type RunLogRecord } from "./run-log.ts";

export const LLM_CALL_RUN_LOG = "llm-call";

export interface LlmCallRunLogOptions {
	readonly env?: NodeJS.ProcessEnv;
	/** Monotonic-enough clock for `durationMs`/`gapMs`; defaults to `Date.now`. */
	readonly now?: () => number;
}

/** End time of the most recent finished call in this process; `gapMs` is measured from it. */
let lastCallEndAt: number | undefined;

/** Test hook: forget the previous call so the next one logs `gapMs: null`. */
export function resetLlmCallRunLogClock(): void {
	lastCallEndAt = undefined;
}

const count = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

function stopReasonOf(message: AssistantMessage | undefined, signal: AbortSignal | undefined): StopReason {
	if (message?.stopReason) return message.stopReason;
	return signal?.aborted ? "aborted" : "error";
}

/**
 * Wrap a provider stream so each call appends one `llm-call` line when it settles.
 * Returns `inner` itself when `OMK_RUN_LOG_DIR` is unset.
 */
export function createLlmCallRunLogStreamFn(inner: StreamFn, options: LlmCallRunLogOptions = {}): StreamFn {
	const env = options.env ?? process.env;
	if (!env[RUN_LOG_DIR_ENV]?.trim()) return inner;
	const now = options.now ?? Date.now;
	const wrapped: StreamFn = async (model, context, streamOptions) => {
		const startedAt = now();
		const gapMs = lastCallEndAt === undefined ? null : Math.max(0, startedAt - lastCallEndAt);
		let base: RunLogRecord;
		try {
			base = {
				provider: String(model.provider),
				model: String(model.id),
				effort: streamOptions?.reasoning ?? null,
				messageCount: context.messages.length,
				systemHash: systemHash(context),
				toolsHash: toolsHash(context),
				phase: null,
				phaseSource: null,
			};
		} catch {
			base = { provider: String(model.provider), model: String(model.id), phase: null, phaseSource: null };
		}
		let logged = false;
		const log = (message: AssistantMessage | undefined) => {
			if (logged) return;
			logged = true;
			const endedAt = now();
			lastCallEndAt = endedAt;
			const usage = message?.usage;
			try {
				appendRunLog(
					LLM_CALL_RUN_LOG,
					{
						...base,
						input: count(usage?.input),
						output: count(usage?.output),
						cacheRead: count(usage?.cacheRead),
						cacheWrite: count(usage?.cacheWrite),
						stopReason: stopReasonOf(message, streamOptions?.signal),
						durationMs: Math.max(0, endedAt - startedAt),
						gapMs,
					},
					{ env },
				);
			} catch {
				// best effort (spec 042): logging never changes the call
			}
		};
		let stream: Awaited<ReturnType<StreamFn>>;
		try {
			stream = await inner(model, context, streamOptions);
		} catch (error) {
			log(undefined);
			throw error;
		}
		void stream.result().then(log, () => log(undefined));
		return stream;
	};
	// Preserve source-owned identity brands, as wrapBudgetStream does.
	for (const key of Object.getOwnPropertySymbols(inner)) {
		const descriptor = Object.getOwnPropertyDescriptor(inner, key);
		if (descriptor) Object.defineProperty(wrapped, key, descriptor);
	}
	return wrapped;
}
