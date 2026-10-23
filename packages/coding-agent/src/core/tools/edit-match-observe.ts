/**
 * Edit match observation (run log only, no flag): `<OMK_RUN_LOG_DIR>/edit-match.jsonl`.
 * Success lines record which stage matched each edit (1 = exact, 2 = normalized/fuzzy).
 * Failure lines record a reason class computed only on the failure path, so a successful
 * edit pays nothing beyond one log append. Never changes the tool result or model input.
 * Lines hold enums, numbers and a short path hash only (no paths, no file text).
 */
import { createHash } from "node:crypto";
import { normalize } from "node:path";
import { appendRunLog } from "../run-log.ts";
import { normalizeForFuzzyMatch, normalizeToLF } from "./edit-diff.ts";

export const EDIT_MATCH_RUN_LOG = "edit-match";

export type EditMatchFailureReason = "indent_only" | "multiple_matches" | "not_found" | "unknown";

interface EditLike {
	oldText: string;
	newText: string;
}

/** sha256 of the normalized path, first 16 hex chars. */
export function editPathHash(path: string): string {
	return createHash("sha256").update(normalize(path)).digest("hex").slice(0, 16);
}

function countFuzzy(content: string, oldText: string): number {
	return normalizeForFuzzyMatch(content).split(normalizeForFuzzyMatch(oldText)).length - 1;
}

/** True when oldText matches a run of whole file lines once each line is trimmed on both sides. */
function matchesIgnoringIndent(content: string, oldText: string): boolean {
	const trim = (line: string) => normalizeForFuzzyMatch(line).trim();
	const want = oldText.split("\n").map(trim);
	while (want.length > 1 && want[want.length - 1] === "") want.pop();
	if (want.every((line) => line === "")) return false;
	const lines = content.split("\n").map(trim);
	for (let start = 0; start + want.length <= lines.length; start++) {
		let ok = true;
		for (let j = 0; j < want.length; j++) {
			if (lines[start + j] !== want[j]) {
				ok = false;
				break;
			}
		}
		if (ok) return true;
	}
	return false;
}

/** Classify why an edit call failed. `content` is BOM-stripped, LF-normalized file text. */
export function classifyEditMatchFailure(
	content: string,
	edits: readonly EditLike[],
): { reason: EditMatchFailureReason; editIndex: number | null } {
	for (let i = 0; i < edits.length; i++) {
		const oldText = normalizeToLF(edits[i].oldText);
		if (oldText.length === 0) return { reason: "unknown", editIndex: i };
		const occurrences = countFuzzy(content, oldText);
		if (occurrences > 1) return { reason: "multiple_matches", editIndex: i };
		if (occurrences === 1 || content.includes(oldText)) continue;
		return { reason: matchesIgnoringIndent(content, oldText) ? "indent_only" : "not_found", editIndex: i };
	}
	// Every edit matched uniquely: the failure was elsewhere (overlap, no-op, ...).
	return { reason: "unknown", editIndex: null };
}

/** Methods live on an object so tests can spy on them. */
export const editMatchObserver = {
	classify: classifyEditMatchFailure,
	/**
	 * Stage per edit: 1 when oldText occurs verbatim, else 2. Mirrors fuzzyFindText's
	 * exact-first order, so it equals its usedFuzzyMatch for every edit that applied.
	 */
	logSuccess(path: string, content: string, edits: readonly EditLike[], env: NodeJS.ProcessEnv = process.env): void {
		const matchStages = edits.map((edit) => (content.includes(normalizeToLF(edit.oldText)) ? 1 : 2));
		appendRunLog(
			EDIT_MATCH_RUN_LOG,
			{
				event: "edit_match",
				ok: true,
				pathHash: editPathHash(path),
				edits: matchStages.length,
				edit_match_stage: Math.max(...matchStages),
				matchStages: [...matchStages],
			},
			{ env },
		);
	},
	logFailure(path: string, content: string, edits: readonly EditLike[], env: NodeJS.ProcessEnv = process.env): void {
		try {
			const { reason, editIndex } = editMatchObserver.classify(content, Array.isArray(edits) ? edits : []);
			appendRunLog(
				EDIT_MATCH_RUN_LOG,
				{
					event: "edit_match",
					ok: false,
					pathHash: editPathHash(path),
					edits: Array.isArray(edits) ? edits.length : 0,
					reason,
					editIndex,
				},
				{ env },
			);
		} catch {
			// Observation must never change the tool outcome.
		}
	},
};
