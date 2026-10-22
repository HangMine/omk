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
import { currentEvidenceSession, EVIDENCE_UNATTRIBUTED } from "./evidence-lifecycle-scope.ts";

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
	/** Registrations dropped once this session's registry hit its bound (counts only). */
	readonly overflow: number;
	/** Artifacts registered with no session context (explicit bucket, not part of this report's counts). */
	readonly unattributed: number;
	/** Artifacts registered in this process across every session bucket and `unattributed` (ratio denominator). */
	readonly processRegistered: number;
}

/** Per session. */
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

interface SessionRegistry {
	readonly records: Map<string, MutableRecord>;
	sequence: number;
	overflow: number;
}

/** Keyed by session id (or `unattributed`); a key is dropped when its session is disposed. */
const sessions = new Map<string, SessionRegistry>();

function registryOf(sessionId: string, create: boolean): SessionRegistry | undefined {
	let registry = sessions.get(sessionId);
	if (registry === undefined && create) {
		registry = { records: new Map(), sequence: 0, overflow: 0 };
		sessions.set(sessionId, registry);
	}
	return registry;
}

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
		const registry = registryOf(currentEvidenceSession(), true) as SessionRegistry;
		const { records } = registry;
		const pathSha256 = sha256(input.path);
		if (!records.has(pathSha256) && records.size >= EVIDENCE_REGISTRY_MAX) {
			registry.overflow += 1;
			return undefined;
		}
		registry.sequence += 1;
		const record: MutableRecord = {
			artifactId: `ev-${registry.sequence}`,
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
	const record = registryOf(currentEvidenceSession(), false)?.records.get(sha256(path));
	if (record !== undefined) applyUpdate(record, update);
}

/** Applies `update` to every present artifact of the current session registered under `owner`. */
export function updateEvidenceArtifactsByOwner(owner: string, update: EvidenceUpdate): void {
	if (!evidenceLifecycleObserveEnabled()) return;
	const ownerSha256 = sha256(owner);
	for (const record of registryOf(currentEvidenceSession(), false)?.records.values() ?? []) {
		if (record.ownerSha256 === ownerSha256 && record.status === "present") applyUpdate(record, update);
	}
}

/** An existing pruner removed (or is about to remove) this path, whichever session owns it. Observation only. */
export function noteEvidenceRemovedByExistingPolicy(path: string): void {
	if (!evidenceLifecycleObserveEnabled()) return;
	const pathSha256 = sha256(path);
	for (const registry of sessions.values()) {
		const record = registry.records.get(pathSha256);
		if (record !== undefined) record.status = "removed-by-existing-policy";
	}
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

export function listEvidenceArtifacts(sessionId: string = currentEvidenceSession()): EvidenceArtifactRecord[] {
	return [...(registryOf(sessionId, false)?.records.values() ?? [])].map(freeze);
}

export function evidenceRegistryStats(sessionId: string): { readonly registered: number; readonly overflow: number } {
	const registry = registryOf(sessionId, false);
	return { registered: registry?.records.size ?? 0, overflow: registry?.overflow ?? 0 };
}

/** All registered artifacts in this process, every bucket included. */
export function evidenceProcessRegistered(): number {
	let total = 0;
	for (const registry of sessions.values()) total += registry.records.size;
	return total;
}

/** Number of session keys (including `unattributed`) currently held. */
export function evidenceRegistrySessionCount(): number {
	return sessions.size;
}

/** Session disposed: forget its artifacts (records only; files are untouched). */
export function dropEvidenceSession(sessionId: string): void {
	sessions.delete(sessionId);
}

export { EVIDENCE_UNATTRIBUTED };

/** Test seam. */
export function resetEvidenceLifecycleForTest(): void {
	sessions.clear();
}
