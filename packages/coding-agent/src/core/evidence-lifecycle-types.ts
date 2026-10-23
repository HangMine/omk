/** Spec 106 D1 / 118 D2: flag parsing and the counts-only report shape (split out for the module-size cap). */
export type EvidenceProducer = "goal-recall" | "read-spill" | "bash-spill" | "tool-output-log" | "bash-executor-log";

/** `unknown`: no producer/consumer mapping exists yet, so nothing may be deleted on its behalf (D2 gap). */
export type EvidenceHoldReason = "goal-active" | "awaiting-consumer" | "retry" | "recovery" | "unknown";

export type EvidenceLifecycleMode = "off" | "observe" | "delete";

/** Strict `===`: any other value (typo, `Delete`, `1`) fails closed to off. */
export function evidenceLifecycleMode(env: NodeJS.ProcessEnv = process.env): EvidenceLifecycleMode {
	const value = env.OMK_EVIDENCE_LIFECYCLE;
	return value === "observe" || value === "delete" ? value : "off";
}

/** `delete` implies everything `observe` does (spec 118 decision 1). */
export function evidenceLifecycleObserveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return evidenceLifecycleMode(env) !== "off";
}

export function evidenceLifecycleDeleteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return evidenceLifecycleMode(env) === "delete";
}

export type EvidenceProducerGroup = "recall" | "spill" | "bash" | "executor";

export interface UnknownHoldShare {
	readonly present: number;
	readonly unknown: number;
	readonly share: number;
}

export interface EvidenceLifecycleReport {
	readonly mode: "observe" | "delete";
	readonly registered: number;
	readonly present: number;
	readonly presentBytes: number;
	readonly removedByExistingPolicy: number;
	readonly byProducer: Readonly<Partial<Record<EvidenceProducer, number>>>;
	readonly holdReasons: Readonly<Partial<Record<EvidenceHoldReason, number>>>;
	/** Present artifacts with an `unknown` hold over present artifacts; 0 when none are present. */
	readonly unknownHoldShare: number;
	readonly unknownHoldShareByProducer: Readonly<Record<EvidenceProducerGroup, UnknownHoldShare>>;
	/** Present artifacts whose goal was blocked with rounds exhausted (still held; counted separately). */
	readonly blockedExhausted: number;
	readonly wouldDelete: { readonly count: number; readonly bytes: number; readonly artifactIds: readonly string[] };
	/** Always 0 in observe mode; kept in the report so a trace proves it. */
	readonly deletes: number;
	/** Spec 118 D2, `delete` mode only: pending deletes by reason and bytes kept only because of a hold. */
	readonly deletion?: {
		readonly pending: number;
		readonly pendingReasons: Readonly<Record<string, number>>;
		readonly heldBytes: number;
		readonly heldCount: number;
		readonly heldReasons: Readonly<Record<string, number>>;
	};
	/** Registrations dropped once this session's registry hit its bound (counts only). */
	readonly overflow: number;
	/** Artifacts registered with no session context (explicit bucket, not part of this report's counts). */
	readonly unattributed: number;
	/** Artifacts registered in this process across every session bucket and `unattributed` (ratio denominator). */
	readonly processRegistered: number;
}
