import type { TextPartStats } from "./context-budget-token-counter-types.ts";
import { textPartStats } from "./text-token-estimate.ts";

/**
 * Spec 062: per-message cache of fallback token statistics for admission JSON.
 *
 * The key is the source message object (WeakMap, so dropped messages free their entry). A hit additionally needs
 * the freshly built projection to have exactly the same leaves (every key, primitive and array length, in order,
 * compared with `===`) as when the entry was made. Strings are immutable, so any in-place edit of the message
 * (compaction masking, an edited text, changed tool arguments) changes a leaf and starts a fresh entry. Projections
 * holding anything JSON could treat specially (non-plain prototypes, accessors, `toJSON`, cycles, very deep values)
 * are never cached.
 *
 * Only statistics are kept, never the serialized JSON: callers still render the JSON every turn (it is transient),
 * so the cache retains one small stats object plus a leaf array of references per message. Storing the JSON too
 * retained ~3.5 MiB of heap on a ~400k-token session (spec 062, paired heap A/B).
 */
export interface AdmissionStatsEntry {
	stats?: TextPartStats;
}

interface StoredEntry extends AdmissionStatsEntry {
	readonly leaves: readonly unknown[];
}

const OBJECT_START = Symbol("object");
const ARRAY_START = Symbol("array");
const END = Symbol("end");
const MAX_DEPTH = 64;

/** Ordered leaves of a JSON-plain value, or undefined when the value must not be cached. */
export function admissionProjectionLeaves(value: unknown): unknown[] | undefined {
	const leaves: unknown[] = [];
	const seen = new Set<object>();
	const visit = (current: unknown, depth: number): boolean => {
		if (current === null || typeof current !== "object") {
			leaves.push(current);
			return true;
		}
		if (depth > MAX_DEPTH || seen.has(current)) return false;
		seen.add(current);
		if (Array.isArray(current)) {
			if (Object.getPrototypeOf(current) !== Array.prototype) return false;
			leaves.push(ARRAY_START, current.length);
			for (let index = 0; index < current.length; index++) {
				const desc = Object.getOwnPropertyDescriptor(current, index);
				if (desc && !("value" in desc)) return false;
				if (!visit(desc?.value, depth + 1)) return false;
			}
		} else {
			const prototype = Object.getPrototypeOf(current);
			if (prototype !== Object.prototype && prototype !== null) return false;
			leaves.push(OBJECT_START);
			for (const key of Object.keys(current)) {
				const desc = Object.getOwnPropertyDescriptor(current, key);
				if (!desc || !("value" in desc) || key === "toJSON") return false;
				leaves.push(key);
				if (!visit(desc.value, depth + 1)) return false;
			}
		}
		leaves.push(END);
		seen.delete(current);
		return true;
	};
	return visit(value, 0) ? leaves : undefined;
}

function sameLeaves(left: readonly unknown[], right: readonly unknown[]): boolean {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false;
	return true;
}

export class AdmissionJsonCache {
	private entries = new WeakMap<object, StoredEntry>();

	/** The entry for `source` while its projection has the same leaves; undefined when it must not be cached. */
	resolve(source: unknown, projected: unknown): AdmissionStatsEntry | undefined {
		if (typeof source !== "object" || source === null) return undefined;
		const leaves = admissionProjectionLeaves(projected);
		if (!leaves) return undefined;
		const stored = this.entries.get(source);
		if (stored && sameLeaves(stored.leaves, leaves)) return stored;
		const entry: StoredEntry = { leaves };
		this.entries.set(source, entry);
		return entry;
	}

	clear(): void {
		this.entries = new WeakMap();
	}
}

/** Statistics of `json`, the part this entry's projection rendered to; computed once per entry. */
export function admissionEntryStats(entry: AdmissionStatsEntry, json: string): TextPartStats {
	if (entry.stats === undefined || entry.stats.length !== json.length) entry.stats = textPartStats(json);
	return entry.stats;
}
