/**
 * Accept-trace for next-task suggestions (default off: `OMK_NEXT_SUGGESTIONS_ACCEPT_TRACE`).
 *
 * One outcome record per shown suggestion, written once its fate is known:
 * `accepted` (Tab) with how it was sent (`exact` / `edited` / `cleared`) and an
 * edit-distance-ratio bucket, or `dismissed` with a reason. Records go to their
 * own file (`suggestion-outcomes.jsonl`) next to `turns.jsonl`, so the turn
 * stream is untouched. Metadata only: the suggestion and prompt text are held in
 * memory for the comparison and never written.
 */
import * as fs from "node:fs";
import { join } from "node:path";

export const ACCEPT_TRACE_ENV = "OMK_NEXT_SUGGESTIONS_ACCEPT_TRACE";
export const SUGGESTION_OUTCOME_SCHEMA_VERSION = "omk-suggestion-outcome-1" as const;
export const SUGGESTION_OUTCOMES_FILE = "suggestion-outcomes.jsonl";
/** Longest prompt prefix compared; keeps the edit-distance work bounded (200 x 2000 cells). */
export const MAX_COMPARED_CHARS = 2000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

export type SentAs = "exact" | "edited" | "cleared";
export type DismissReason = "typed_over" | "new_turn" | "other";
export const EDIT_RATIO_BUCKETS = ["0", "le_0.1", "le_0.3", "le_0.6", "gt_0.6"] as const;
export type EditRatioBucket = (typeof EDIT_RATIO_BUCKETS)[number];

export function isAcceptTraceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return /^(?:1|on|true|yes)$/i.test(env[ACCEPT_TRACE_ENV]?.trim() ?? "");
}

/** Timing and identity of one shown suggestion; numbers and identifiers only. */
export interface ShownSuggestionMeta {
	readonly parentTurnIndex: number;
	readonly provider: string;
	readonly model: string;
	/** `prompt_settled` handled (turn end as seen by the controller). */
	readonly settledAtEpochMs: number;
	/** Quota check finished (the request starts right after). */
	readonly quotaCheckedAtEpochMs: number;
	/** Placeholder set (suggestion visible). */
	readonly shownAtEpochMs: number;
}

export interface SuggestionOutcomeRecord extends ShownSuggestionMeta {
	readonly schemaVersion: typeof SUGGESTION_OUTCOME_SCHEMA_VERSION;
	readonly sessionId: string;
	readonly outcome: "accepted" | "dismissed";
	readonly decidedAtEpochMs: number;
	readonly msToAccept?: number;
	readonly sentAs?: SentAs;
	readonly editRatioBucket?: EditRatioBucket;
	readonly dismissReason?: DismissReason;
}

export function editDistance(a: string, b: string): number {
	if (a === b) return 0;
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;
	let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		const row = [i];
		for (let j = 1; j <= b.length; j++) {
			const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
			row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + cost);
		}
		prev = row;
	}
	return prev[b.length]!;
}

export function editRatioBucket(suggestion: string, sent: string): EditRatioBucket {
	const a = suggestion.slice(0, MAX_COMPARED_CHARS);
	const b = sent.slice(0, MAX_COMPARED_CHARS);
	const longest = Math.max(a.length, b.length);
	const ratio = longest === 0 ? 0 : editDistance(a, b) / longest;
	if (ratio === 0) return "0";
	if (ratio <= 0.1) return "le_0.1";
	if (ratio <= 0.3) return "le_0.3";
	return ratio <= 0.6 ? "le_0.6" : "gt_0.6";
}

/** Printable input replaces the empty editor's placeholder; anything else is `other`. */
export function dismissReasonForKey(data: string): DismissReason {
	return [...data].length === 1 && data >= " " && data !== "\u007f" ? "typed_over" : "other";
}

interface Pending {
	readonly meta: ShownSuggestionMeta;
	readonly text: string;
	acceptedAtEpochMs?: number;
}

/** State machine: shown → (accepted → sent/cleared) | dismissed. Exactly one record per shown suggestion. */
export class SuggestionAcceptTracker {
	private pending: Pending | undefined;
	private readonly write: (record: Omit<SuggestionOutcomeRecord, "schemaVersion" | "sessionId">) => void;

	constructor(write: (record: Omit<SuggestionOutcomeRecord, "schemaVersion" | "sessionId">) => void) {
		this.write = write;
	}

	get awaitingSend(): boolean {
		return this.pending?.acceptedAtEpochMs !== undefined;
	}

	shown(meta: ShownSuggestionMeta, text: string): void {
		this.flush(meta.shownAtEpochMs);
		this.pending = { meta, text };
	}

	accepted(atEpochMs: number): void {
		if (this.pending && this.pending.acceptedAtEpochMs === undefined) this.pending.acceptedAtEpochMs = atEpochMs;
	}

	/** A shown, not-yet-accepted suggestion went away. No-op after an accept. */
	dismissed(reason: DismissReason, atEpochMs: number): void {
		const p = this.pending;
		if (!p || p.acceptedAtEpochMs !== undefined) return;
		this.pending = undefined;
		this.write({ ...p.meta, outcome: "dismissed", dismissReason: reason, decidedAtEpochMs: atEpochMs });
	}

	/** Editor text seen before a key; an emptied editor after an accept is `cleared`. */
	observeEditor(text: string, atEpochMs: number): void {
		if (this.awaitingSend && text.length === 0) this.settleAccepted("cleared", undefined, atEpochMs);
	}

	/** The next prompt was sent; `text` is its user text. */
	sent(text: string, atEpochMs: number): void {
		const p = this.pending;
		if (!p) return;
		if (p.acceptedAtEpochMs === undefined) {
			this.dismissed("new_turn", atEpochMs);
			return;
		}
		const bucket = editRatioBucket(p.text, text);
		this.settleAccepted(bucket === "0" ? "exact" : "edited", bucket, atEpochMs);
	}

	/** Close whatever is open (dispose, or a new suggestion replacing an unsent accept). */
	flush(atEpochMs: number): void {
		if (this.awaitingSend) this.settleAccepted("cleared", undefined, atEpochMs);
		else this.dismissed("other", atEpochMs);
	}

	private settleAccepted(sentAs: SentAs, bucket: EditRatioBucket | undefined, atEpochMs: number): void {
		const p = this.pending;
		if (!p || p.acceptedAtEpochMs === undefined) return;
		this.pending = undefined;
		this.write({
			...p.meta,
			outcome: "accepted",
			msToAccept: Math.max(0, p.acceptedAtEpochMs - p.meta.shownAtEpochMs),
			sentAs,
			...(bucket ? { editRatioBucket: bucket } : {}),
			decidedAtEpochMs: atEpochMs,
		});
	}
}

const DISABLED = new Set(["0", "false", "off", "disable", "disabled"]);

/** Tracker writing to `<metrics dir>/suggestion-outcomes.jsonl`; `undefined` when flag off or metrics opted out. */
export function suggestionAcceptTracker(
	sessionId: () => string,
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
): SuggestionAcceptTracker | undefined {
	if (!isAcceptTraceEnabled(env)) return undefined;
	const metrics = env.OMK_TURN_METRICS;
	if (metrics !== undefined && DISABLED.has(metrics.trim().toLowerCase())) return undefined;
	const file = join(env.OMK_TURN_METRICS_DIR ?? join(cwd, ".omk", "metrics"), SUGGESTION_OUTCOMES_FILE);
	return new SuggestionAcceptTracker((record) => {
		try {
			const line = `${JSON.stringify({ schemaVersion: SUGGESTION_OUTCOME_SCHEMA_VERSION, sessionId: sessionId(), ...record })}\n`;
			fs.mkdirSync(join(file, ".."), { recursive: true });
			if ((fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0) + line.length > MAX_FILE_BYTES) return;
			fs.appendFileSync(file, line, "utf8");
		} catch {
			// Advisory only.
		}
	});
}

/** Text of a user message (string or text parts). */
export function userMessageText(message: unknown): string | undefined {
	if (typeof message !== "object" || message === null || (message as { role?: unknown }).role !== "user")
		return undefined;
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}
