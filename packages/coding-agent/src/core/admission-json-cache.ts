import type { TextPartStats } from "./context-budget-token-counter-types.ts";
import { textPartStats } from "./text-token-estimate.ts";

/**
 * Spec 062: per-message cache for admission JSON and its token statistics.
 *
 * The key is the source message object (WeakMap, so dropped messages free their entry). A hit additionally needs
 * the freshly built projection to have exactly the same leaves (every key, primitive and array length, in order,
 * compared with `===`) as when the entry was made. Strings are immutable, so any in-place edit of the message
 * (compaction masking, an edited text, changed tool arguments) changes a leaf and recomputes. Projections holding
 * anything JSON could treat specially (non-plain prototypes, accessors, `toJSON`, cycles, very deep values) are
 * never cached.
 */
export interface AdmissionJsonCacheEntry {
	readonly json: string;
	/** Budget characters and nodes the uncached render consumed, replayed on a hit. */
	readonly charged: number;
	readonly nodes: number;
	stats?: TextPartStats;
}

interface StoredEntry extends AdmissionJsonCacheEntry {
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

	/**
	 * The entry for `source` whose projection is `projected`. `render` runs on a miss and returns the JSON plus the
	 * budget it consumed; its errors propagate and nothing is stored.
	 */
	resolve(
		source: unknown,
		projected: unknown,
		render: () => { json: string; charged: number; nodes: number },
	): { entry: AdmissionJsonCacheEntry; hit: boolean } {
		const leaves = typeof source === "object" && source !== null ? admissionProjectionLeaves(projected) : undefined;
		if (leaves) {
			const stored = this.entries.get(source as object);
			if (stored && sameLeaves(stored.leaves, leaves)) return { entry: stored, hit: true };
		}
		const rendered = render();
		const entry: StoredEntry = { ...rendered, leaves: leaves ?? [] };
		if (leaves) this.entries.set(source as object, entry);
		return { entry, hit: false };
	}

	clear(): void {
		this.entries = new WeakMap();
	}
}

/** Cached statistics for an entry's JSON, computed once. */
export function admissionEntryStats(entry: AdmissionJsonCacheEntry): TextPartStats {
	entry.stats ??= textPartStats(entry.json);
	return entry.stats;
}
