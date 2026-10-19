import { appendRunLog, type RunLogRecord } from "./run-log.ts";

/** Run-log stream for pinned-model quota failovers (spec 089). */
export const PINNED_QUOTA_FAILOVER_RUN_LOG = "pinned-quota-failover";

/** Setting that turns quota failover off; named in the notice so users can opt out. */
export const PINNED_QUOTA_FAILOVER_DISABLE_HINT = "providerResilience.autoFailoverOnQuotaExhaustion: false";

export interface PinnedQuotaFailoverEvent {
	readonly type: "pinned_quota_failover";
	readonly from: string;
	readonly to: string;
	readonly message: string;
}

interface ModelRef {
	readonly provider: string;
	readonly id: string;
}

/**
 * Quota exhaustion fails over even on a `--model` pin (1.5.1 default, unchanged).
 * That switch must not be silent: emit one visible notice per turn and one run-log line.
 */
export class PinnedQuotaFailoverNotice {
	private readonly _emit: (event: PinnedQuotaFailoverEvent) => void;
	private readonly _isPinned: () => boolean;
	private readonly _log: (record: RunLogRecord) => void;
	/** Set once the notice fired; cleared only by {@link resetTurn} at the top-level prompt start. */
	private _shownThisTurn = false;

	constructor(
		emit: (event: PinnedQuotaFailoverEvent) => void,
		isPinned: () => boolean,
		log: (record: RunLogRecord) => void = (record) => appendRunLog(PINNED_QUOTA_FAILOVER_RUN_LOG, record),
	) {
		this._emit = emit;
		this._isPinned = isPinned;
		this._log = log;
	}

	/** Re-arm the notice. The session calls this once per user prompt (turn), not per retry. */
	resetTurn(): void {
		this._shownThisTurn = false;
	}

	/** Call after a failover switched models. Returns the new `provider/id`, notice or not. */
	afterFailover(quotaExhausted: boolean, current: ModelRef | undefined, next: ModelRef): string {
		const to = `${next.provider}/${next.id}`;
		if (!quotaExhausted || !this._isPinned() || this._shownThisTurn) return to;
		this._shownThisTurn = true;
		const from = current ? `${current.provider}/${current.id}` : "unknown";
		const message =
			`Quota exhausted on pinned model ${from}; this turn continues on ${to}. ` +
			`To stay on the pinned model, set ${PINNED_QUOTA_FAILOVER_DISABLE_HINT}.`;
		this._emit({ type: "pinned_quota_failover", from, to, message });
		this._log({ reason: "quota_exhausted", from, to, pinned: true });
		return to;
	}
}

/** One-line rendering shared by interactive (warning) and print (stderr) modes. */
export function formatPinnedQuotaFailoverNotice(event: PinnedQuotaFailoverEvent): string {
	return `Warning: ${event.message}`;
}
