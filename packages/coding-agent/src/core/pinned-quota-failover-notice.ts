import { appendRunLog, type RunLogRecord } from "./run-log.ts";

/** Run-log stream for pinned-model quota failovers (spec 089). */
export const PINNED_QUOTA_FAILOVER_RUN_LOG = "pinned-quota-failover";

/** Setting that turns quota failover off; named in the notice so users can opt out. */
export const PINNED_QUOTA_FAILOVER_DISABLE_HINT = "providerResilience.autoFailoverOnQuotaExhaustion: false";

/**
 * Marker stored in the session's per-turn refused-model set. That set is cleared at every
 * turn boundary, so the notice re-arms per turn without extra reset calls. Failover keys are
 * `provider/id`, so a NUL-prefixed marker cannot collide with a model key.
 */
export const PINNED_QUOTA_NOTICE_TURN_MARKER = "\u0000pinned-quota-failover-notice";

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

	constructor(
		emit: (event: PinnedQuotaFailoverEvent) => void,
		isPinned: () => boolean,
		log: (record: RunLogRecord) => void = (record) => appendRunLog(PINNED_QUOTA_FAILOVER_RUN_LOG, record),
	) {
		this._emit = emit;
		this._isPinned = isPinned;
		this._log = log;
	}

	/** Call after a failover switched models. Returns the new `provider/id`, notice or not. */
	afterFailover(
		turnState: Set<string>,
		quotaExhausted: boolean,
		current: ModelRef | undefined,
		next: ModelRef,
	): string {
		const to = `${next.provider}/${next.id}`;
		if (!quotaExhausted || !this._isPinned() || turnState.has(PINNED_QUOTA_NOTICE_TURN_MARKER)) return to;
		turnState.add(PINNED_QUOTA_NOTICE_TURN_MARKER);
		const from = current ? `${current.provider}/${current.id}` : "unknown";
		const message =
			`Quota exhausted on pinned model ${from}; this turn continues on ${to}. ` +
			`To stay on the pinned model, set ${PINNED_QUOTA_FAILOVER_DISABLE_HINT}.`;
		this._emit({ type: "pinned_quota_failover", from, to, message });
		this._log({ reason: "quota_exhausted", from, to, pinned: true });
		return to;
	}
}
