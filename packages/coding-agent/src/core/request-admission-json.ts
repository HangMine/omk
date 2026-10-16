import type { AdmissionJsonCache, AdmissionJsonCacheEntry } from "./admission-json-cache.ts";
/** Limits are consumed BEFORE building strings. This is a local projection, not a provider serializer. */
export interface AdmissionJsonBudget {
	remaining: number;
	nodes: number;
}
export function representationLimit(): never {
	throw new RangeError("admission.representation_limit");
}
function charge(budget: AdmissionJsonBudget, length: number): void {
	if (!Number.isSafeInteger(length) || length < 0 || length > budget.remaining) representationLimit();
	budget.remaining -= length;
}
function quoted(text: string, budget: AdmissionJsonBudget): string {
	if (text.length > budget.remaining) representationLimit();
	let length = 2;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13)
			length += 2;
		else if (code < 32) length += 6;
		else if (code >= 0xd800 && code <= 0xdbff) {
			const next = text.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				length += 2;
				i++;
			} else length += 6;
		} else if (code >= 0xdc00 && code <= 0xdfff) length += 6;
		else length++;
		if (length > budget.remaining) representationLimit();
	}
	charge(budget, length);
	return JSON.stringify(text);
}
/**
 * `open + parts.join(",") + close` as one flat string. A template literal around
 * the join leaves a rope, and the token counter then flattens it into a second
 * full-transcript copy on every provider request.
 */
function joinWrapped(open: string, parts: string[], close: string): string {
	if (parts.length === 0) return open + close;
	parts[0] = open + parts[0];
	parts[parts.length - 1] += close;
	return parts.join(",");
}
/** `["[", e0, ",", e1, ..., "]"]`: the pieces of `joinWrapped("[", parts, "]")`, not joined. */
function splitWrapped(parts: readonly string[]): string[] {
	if (parts.length === 0) return ["[]"];
	const pieces = ["["];
	for (let index = 0; index < parts.length; index++) {
		if (index > 0) pieces.push(",");
		pieces.push(parts[index]);
	}
	pieces.push("]");
	return pieces;
}
export function boundedAdmissionJson(value: unknown, budget: AdmissionJsonBudget): string {
	return createAdmissionJsonRenderer(budget)(value, 0, false) as string;
}
/**
 * Pieces whose `join("")` is exactly `boundedAdmissionJson(value, budget)`, with the
 * same budget charges and errors. A top-level array stays split per element so a
 * token counter can read a whole transcript without one joined history-sized copy.
 */
export function boundedAdmissionJsonParts(
	value: unknown,
	budget: AdmissionJsonBudget,
	elementCache?: AdmissionJsonElementCache,
): string[] {
	const rendered = createAdmissionJsonRenderer(budget, elementCache)(value, 0, true);
	return typeof rendered === "string" ? [rendered] : rendered;
}
/**
 * Spec 062: reuse the rendered JSON of top-level array elements whose source object and projection leaves are
 * unchanged. A hit replays the exact budget characters and nodes the element consumed, so limits trip as before.
 * `entries[index]` receives the entry of element `index`.
 */
export interface AdmissionJsonElementCache {
	readonly cache: AdmissionJsonCache;
	readonly sources: readonly unknown[];
	readonly entries: AdmissionJsonCacheEntry[];
}
function createAdmissionJsonRenderer(
	budget: AdmissionJsonBudget,
	elementCache?: AdmissionJsonElementCache,
): (current: unknown, depth: number, split: boolean) => string | string[] {
	const ancestors = new WeakSet<object>();
	const visit = (current: unknown, depth: number): string => render(current, depth, false) as string;
	function render(current: unknown, depth: number, split: boolean): string | string[] {
		if (depth > 64 || ++budget.nodes > 100000) representationLimit();
		if (current === null) {
			charge(budget, 4);
			return "null";
		}
		if (typeof current === "string") return quoted(current, budget);
		if (typeof current === "boolean") {
			const text = String(current);
			charge(budget, text.length);
			return text;
		}
		if (typeof current === "number" && Number.isFinite(current)) {
			const text = JSON.stringify(current);
			charge(budget, text.length);
			return text;
		}
		if (typeof current !== "object" || current === null) throw new TypeError("admission.invalid_json");
		if (ancestors.has(current)) throw new TypeError("admission.cyclic_json");
		const prototype = Object.getPrototypeOf(current);
		if (Array.isArray(current) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
			throw new TypeError("admission.invalid_json_prototype");
		const customJson = Object.getOwnPropertyDescriptor(current, "toJSON");
		if (customJson && (!("value" in customJson) || typeof customJson.value === "function"))
			throw new TypeError("admission.custom_json");
		ancestors.add(current);
		try {
			charge(budget, 2);
			const parts: string[] = [];
			if (Array.isArray(current)) {
				if (current.length > budget.remaining + 1 || current.length > 100000) representationLimit();
				for (let index = 0; index < current.length; index++) {
					if (index > 0) charge(budget, 1);
					const desc = Object.getOwnPropertyDescriptor(current, String(index));
					if (desc && !("value" in desc)) throw new TypeError("admission.json_accessor");
					const element = desc?.value === undefined ? null : desc.value;
					if (split && depth === 0 && elementCache) {
						parts.push(renderCachedElement(elementCache, index, element, depth + 1));
						continue;
					}
					parts.push(visit(element, depth + 1));
				}
				return split ? splitWrapped(parts) : joinWrapped("[", parts, "]");
			}
			// JSON ignores symbols and non-enumerable metadata (including TypeBox markers).
			for (const key of Object.keys(current)) {
				const desc = Object.getOwnPropertyDescriptor(current, key);
				if (!desc || !("value" in desc)) throw new TypeError("admission.json_accessor");
				if (desc.value === undefined) continue;
				if (parts.length > 0) charge(budget, 1);
				const name = quoted(key, budget);
				charge(budget, 1);
				parts.push(`${name}:${visit(desc.value, depth + 1)}`);
			}
			return joinWrapped("{", parts, "}");
		} finally {
			ancestors.delete(current);
		}
	}
	function renderCachedElement(
		elementCache: AdmissionJsonElementCache,
		index: number,
		element: unknown,
		depth: number,
	): string {
		const { entry, hit } = elementCache.cache.resolve(elementCache.sources[index], element, () => {
			const remaining = budget.remaining;
			const nodes = budget.nodes;
			const json = visit(element, depth);
			return { json, charged: remaining - budget.remaining, nodes: budget.nodes - nodes };
		});
		if (hit) {
			if (budget.nodes + entry.nodes > 100000) representationLimit();
			budget.nodes += entry.nodes;
			charge(budget, entry.charged);
		}
		elementCache.entries[index] = entry;
		return entry.json;
	}
	return render;
}
