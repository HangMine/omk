/**
 * Spec 106 D1: evidence lifecycle, observe-only (`OMK_EVIDENCE_LIFECYCLE=observe`, default off).
 *
 * Registers artifacts that omk producers write (goal recall, read/bash spill, tool-bash log, executor
 * `fullOutputPath`) and reports, per artifact, its producer, required consumers, consumed/verified/retry/
 * recovery state and hold reasons, plus which artifacts a future deleter (D2) WOULD remove.
 *
 * This module never deletes, renames or writes a file. It stores no raw output and no path text: only
 * sha256 digests, byte counts and enum values. Existing pruners (recall count caps, goal clear/replace,
 * executor discard) keep running unchanged; when they remove a registered file it is recorded as
 * `removed-by-existing-policy`, never as a lifecycle delete.
 */
import { createHash } from "node:crypto";
import { statSync } from "node:fs";

export type EvidenceProducer = "goal-recall" | "read-spill" | "bash-spill" | "tool-output-log" | "bash-executor-log";

/** `unknown`: no producer/consumer mapping exists yet, so nothing may be deleted on its behalf (D2 gap). */
export type EvidenceHoldReason = "goal-active" | "awaiting-consumer" | "retry" | "recovery" | "unknown";

export type EvidenceArtifactStatus = "present" | "removed-by-existing-policy";

export interface EvidenceArtifactRecord {
	/** Monotonic per process (`ev-<n>`); never reused, never derived from the path. */
	readonly artifactId: string;
	readonly producer: EvidenceProducer;
	readonly pathSha256: string;
	/** sha256 of the owner key (goal id for recall); absent when the producer has no owner mapping. */
	readonly ownerSha256?: string;
	readonly bytes: number;
	readonly contentSha256?: string;
	/** Undefined = consumers unknown (no mapping). */
	readonly requiredConsumers?: readonly string[];
	readonly consumed: readonly string[];
	/** `true`/`false` once a verification consumer settled; undefined = not verified (yet). */
	readonly verified?: boolean;
	readonly retryHold: boolean;
	readonly recoveryHold: boolean;
	readonly holds: readonly EvidenceHoldReason[];
	readonly status: EvidenceArtifactStatus;
	/** Classification only: the owning goal was blocked with rounds exhausted. Holds are NOT released. */
	readonly blockedExhausted: boolean;
}

export type EvidenceProducerGroup = "recall" | "spill" | "bash" | "executor";

export interface UnknownHoldShare {
	readonly present: number;
	readonly unknown: number;
	readonly share: number;
}

export interface EvidenceLifecycleReport {
	readonly mode: "observe";
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
	readonly deletes: 0;
	/** Registrations dropped once the registry hit its bound (counts only). */
	readonly overflow: number;
}

export const EVIDENCE_REGISTRY_MAX = 4096;

export function evidenceLifecycleObserveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.OMK_EVIDENCE_LIFECYCLE === "observe";
}

interface MutableRecord {
	artifactId: string;
	producer: EvidenceProducer;
	pathSha256: string;
	ownerSha256?: string;
	bytes: number;
	contentSha256?: string;
	requiredConsumers?: string[];
	consumed: Set<string>;
	verified?: boolean;
	retryHold: boolean;
	recoveryHold: boolean;
	goalActive: boolean;
	blockedExhausted: boolean;
	status: EvidenceArtifactStatus;
}

const records = new Map<string, MutableRecord>();
let sequence = 0;
let overflow = 0;

function sha256(text: string | Buffer): string {
	return createHash("sha256").update(text).digest("hex");
}

function sizeOf(path: string): number {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
}

function holdsOf(record: MutableRecord): EvidenceHoldReason[] {
	if (record.requiredConsumers === undefined) return ["unknown"];
	const holds: EvidenceHoldReason[] = [];
	if (record.goalActive) holds.push("goal-active");
	if (record.requiredConsumers.some((consumer) => !record.consumed.has(consumer))) holds.push("awaiting-consumer");
	if (record.retryHold) holds.push("retry");
	if (record.recoveryHold) holds.push("recovery");
	return holds;
}

export interface RegisterEvidenceInput {
	readonly producer: EvidenceProducer;
	readonly path: string;
	readonly owner?: string;
	readonly bytes?: number;
	readonly content?: string | Buffer;
	readonly contentSha256?: string;
	readonly requiredConsumers?: readonly string[];
	readonly goalActive?: boolean;
	readonly retryHold?: boolean;
	readonly recoveryHold?: boolean;
}

/** No-op (returns undefined) unless the flag is `observe`. Never throws into the producer. */
export function registerEvidenceArtifact(input: RegisterEvidenceInput): string | undefined {
	if (!evidenceLifecycleObserveEnabled()) return undefined;
	try {
		const pathSha256 = sha256(input.path);
		const existing = records.get(pathSha256);
		if (existing === undefined && records.size >= EVIDENCE_REGISTRY_MAX) {
			overflow += 1;
			return undefined;
		}
		sequence += 1;
		const record: MutableRecord = {
			artifactId: `ev-${sequence}`,
			producer: input.producer,
			pathSha256,
			...(input.owner !== undefined ? { ownerSha256: sha256(input.owner) } : {}),
			bytes: input.bytes ?? (input.content !== undefined ? Buffer.byteLength(input.content) : sizeOf(input.path)),
			contentSha256: input.contentSha256 ?? (input.content !== undefined ? sha256(input.content) : undefined),
			requiredConsumers: input.requiredConsumers === undefined ? undefined : [...input.requiredConsumers],
			consumed: new Set(),
			retryHold: input.retryHold ?? false,
			recoveryHold: input.recoveryHold ?? false,
			goalActive: input.goalActive ?? false,
			blockedExhausted: false,
			status: "present",
		};
		// A path written again is a new artifact (new id); the old record is superseded, not deleted.
		records.delete(pathSha256);
		records.set(pathSha256, record);
		return record.artifactId;
	} catch {
		return undefined;
	}
}

export interface EvidenceUpdate {
	readonly consumed?: readonly string[];
	readonly verified?: boolean;
	readonly goalActive?: boolean;
	readonly retryHold?: boolean;
	readonly recoveryHold?: boolean;
	readonly blockedExhausted?: boolean;
}

function applyUpdate(record: MutableRecord, update: EvidenceUpdate): void {
	for (const consumer of update.consumed ?? []) record.consumed.add(consumer);
	if (update.verified !== undefined) record.verified = update.verified;
	if (update.goalActive !== undefined) record.goalActive = update.goalActive;
	if (update.retryHold !== undefined) record.retryHold = update.retryHold;
	if (update.recoveryHold !== undefined) record.recoveryHold = update.recoveryHold;
	if (update.blockedExhausted !== undefined) record.blockedExhausted = update.blockedExhausted;
}

export function updateEvidenceArtifact(path: string, update: EvidenceUpdate): void {
	if (!evidenceLifecycleObserveEnabled()) return;
	const record = records.get(sha256(path));
	if (record !== undefined) applyUpdate(record, update);
}

/** Applies `update` to every present artifact registered under `owner`. */
export function updateEvidenceArtifactsByOwner(owner: string, update: EvidenceUpdate): void {
	if (!evidenceLifecycleObserveEnabled()) return;
	const ownerSha256 = sha256(owner);
	for (const record of records.values()) {
		if (record.ownerSha256 === ownerSha256 && record.status === "present") applyUpdate(record, update);
	}
}

/** An existing pruner removed (or is about to remove) this path. Observation only. */
export function noteEvidenceRemovedByExistingPolicy(path: string): void {
	if (!evidenceLifecycleObserveEnabled()) return;
	const record = records.get(sha256(path));
	if (record !== undefined) record.status = "removed-by-existing-policy";
}

function freeze(record: MutableRecord): EvidenceArtifactRecord {
	return {
		artifactId: record.artifactId,
		producer: record.producer,
		pathSha256: record.pathSha256,
		...(record.ownerSha256 !== undefined ? { ownerSha256: record.ownerSha256 } : {}),
		bytes: record.bytes,
		...(record.contentSha256 !== undefined ? { contentSha256: record.contentSha256 } : {}),
		...(record.requiredConsumers !== undefined ? { requiredConsumers: [...record.requiredConsumers] } : {}),
		consumed: [...record.consumed].sort(),
		...(record.verified !== undefined ? { verified: record.verified } : {}),
		retryHold: record.retryHold,
		recoveryHold: record.recoveryHold,
		holds: holdsOf(record),
		status: record.status,
		blockedExhausted: record.blockedExhausted,
	};
}

export function listEvidenceArtifacts(): EvidenceArtifactRecord[] {
	return [...records.values()].map(freeze);
}

const PRODUCER_GROUP: Readonly<Record<EvidenceProducer, EvidenceProducerGroup>> = {
	"goal-recall": "recall",
	"read-spill": "spill",
	"bash-spill": "spill",
	"tool-output-log": "bash",
	"bash-executor-log": "executor",
};

function share(unknown: number, present: number): number {
	return present === 0 ? 0 : Math.round((unknown / present) * 10_000) / 10_000;
}

export function evidenceLifecycleReport(): EvidenceLifecycleReport {
	const groups: Record<EvidenceProducerGroup, { present: number; unknown: number }> = {
		recall: { present: 0, unknown: 0 },
		spill: { present: 0, unknown: 0 },
		bash: { present: 0, unknown: 0 },
		executor: { present: 0, unknown: 0 },
	};
	let blockedExhausted = 0;
	const byProducer: Partial<Record<EvidenceProducer, number>> = {};
	const holdReasons: Partial<Record<EvidenceHoldReason, number>> = {};
	let present = 0;
	let presentBytes = 0;
	let removed = 0;
	let unknown = 0;
	const would: EvidenceArtifactRecord[] = [];
	for (const record of listEvidenceArtifacts()) {
		byProducer[record.producer] = (byProducer[record.producer] ?? 0) + 1;
		if (record.status !== "present") {
			removed += 1;
			continue;
		}
		present += 1;
		presentBytes += record.bytes;
		const group = groups[PRODUCER_GROUP[record.producer]];
		group.present += 1;
		if (record.holds.includes("unknown")) group.unknown += 1;
		if (record.blockedExhausted) blockedExhausted += 1;
		for (const hold of record.holds) holdReasons[hold] = (holdReasons[hold] ?? 0) + 1;
		if (record.holds.includes("unknown")) unknown += 1;
		if (record.holds.length === 0) would.push(record);
	}
	return {
		mode: "observe",
		registered: records.size,
		present,
		presentBytes,
		removedByExistingPolicy: removed,
		byProducer,
		holdReasons,
		unknownHoldShare: share(unknown, present),
		unknownHoldShareByProducer: Object.fromEntries(
			Object.entries(groups).map(([name, g]) => [name, { ...g, share: share(g.unknown, g.present) }]),
		) as Record<EvidenceProducerGroup, UnknownHoldShare>,
		blockedExhausted,
		wouldDelete: {
			count: would.length,
			bytes: would.reduce((sum, record) => sum + record.bytes, 0),
			artifactIds: would.map((record) => record.artifactId),
		},
		deletes: 0,
		overflow,
	};
}

/** Test seam. */
export function resetEvidenceLifecycleForTest(): void {
	records.clear();
	sequence = 0;
	overflow = 0;
}
