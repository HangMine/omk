/** Plan-time port of the legacy lane isolation scaffold; it creates no branches or worktrees. */
import { posix } from "node:path";
import { lanePathsIntersect, normalizeLanePath } from "./lane-path-scope.ts";
import type { SubagentLaneGrant } from "./loadout-runtime.ts";

export interface LaneIsolationPlan {
	readonly laneId: string;
	readonly branchName: string;
	readonly worktreePath: string;
	readonly evidenceOutput: string;
	readonly readOnly: boolean;
	readonly authority: SubagentLaneGrant["authority"];
}

function safeId(value: string, label: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value.includes("..")) {
		throw new Error(`Invalid ${label}`);
	}
	return value;
}

function evidencePath(value: string | undefined): string {
	if (!value?.trim()) throw new Error("Lane grant requires evidenceOutput");
	const normalized = normalizeLanePath(value);
	if (normalized.escapes || !normalized.path.startsWith(".omk/runs/") || /[*?[\]{}<>]/.test(normalized.path)) {
		throw new Error("Lane evidenceOutput must be a concrete path under .omk/runs");
	}
	return normalized.path;
}

export function isReadOnlyLane(grant: SubagentLaneGrant): boolean {
	return ["advisory", "read-only", "review-only", "security-review"].includes(grant.authority);
}

/** Current grants distinguish read and write scopes; allowedPaths includes both. */
export function validateLaneIsolationGrant(grant: SubagentLaneGrant): SubagentLaneGrant {
	safeId(grant.laneId, "laneId");
	for (const [label, value] of Object.entries({ agent: grant.agent, task: grant.task, scope: grant.scope })) {
		if (typeof value !== "string" || !value.trim()) throw new Error(`Lane grant requires ${label}`);
	}
	for (const [label, values] of Object.entries({
		skills: grant.skills,
		hooks: grant.hooks,
		mcp: grant.mcp,
		acceptance: grant.acceptance,
	})) {
		if (
			!Array.isArray(values) ||
			!values.length ||
			values.some((value) => typeof value !== "string" || !value.trim())
		) {
			throw new Error(`Lane grant requires non-empty ${label}`);
		}
	}
	const writes = grant.scheduler.writeSet;
	if (isReadOnlyLane(grant) && writes.length) throw new Error("Read-only lane must not declare product write paths");
	if (grant.authority === "write-scoped" && !writes.length) {
		throw new Error("Write-scoped lane must declare product write paths");
	}
	for (const path of [
		...grant.allowedPaths,
		...grant.blockedPaths,
		...grant.scheduler.readSet.map((entry) => entry.path),
		...writes.map((entry) => entry.path),
	]) {
		if (normalizeLanePath(path).escapes) throw new Error("Lane path escapes repository scope");
	}
	evidencePath(grant.evidenceOutput);
	return grant;
}

/** Callers that materialize this plan must still enforce realpath/symlink confinement. */
export function createLaneIsolationPlan(
	grant: SubagentLaneGrant,
	options: { readonly runId: string },
): LaneIsolationPlan {
	validateLaneIsolationGrant(grant);
	const runId = safeId(options.runId, "runId");
	return {
		laneId: grant.laneId,
		branchName: `work/${runId}/${grant.laneId}`,
		worktreePath: posix.join(".omk/worktrees", runId, grant.laneId),
		evidenceOutput: evidencePath(grant.evidenceOutput),
		readOnly: isReadOnlyLane(grant),
		authority: grant.authority,
	};
}

export function assertNoLaneIsolationConflicts(grants: readonly SubagentLaneGrant[]): void {
	const outputs = new Set<string>();
	const ids = new Set<string>();
	for (const grant of grants) {
		validateLaneIsolationGrant(grant);
		const id = grant.laneId.toLowerCase();
		if (ids.has(id)) throw new Error("Duplicate lane id");
		ids.add(id);
		const output = evidencePath(grant.evidenceOutput).toLowerCase();
		if (outputs.has(output)) throw new Error("Lane evidenceOutput conflict");
		outputs.add(output);
	}
	for (let i = 0; i < grants.length; i++) {
		for (let j = i + 1; j < grants.length; j++) {
			for (const left of grants[i].scheduler.writeSet) {
				for (const right of grants[j].scheduler.writeSet) {
					if (lanePathsIntersect(left.path, right.path)) throw new Error("Parallel writer conflict");
				}
			}
		}
	}
}
