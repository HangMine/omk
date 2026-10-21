/** Next-suggestion accept trace (`OMK_NEXT_SUGGESTIONS_ACCEPT_TRACE`, default off). */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	dismissReasonForKey,
	EDIT_RATIO_BUCKETS,
	editDistance,
	editRatioBucket,
	isAcceptTraceEnabled,
	type ShownSuggestionMeta,
	SuggestionAcceptTracker,
	type SuggestionOutcomeRecord,
	suggestionAcceptTracker,
} from "../src/core/next-suggestion-accept-trace.ts";
import { runAcceptScenario, SENT, SUGGESTION } from "./fixtures/accept-trace/scenario.ts";

const SUGGEST_ON = { OMK_NEXT_SUGGESTIONS: "1" };
const TRACE_ON = { ...SUGGEST_ON, OMK_NEXT_SUGGESTIONS_ACCEPT_TRACE: "1" };
const T0 = 1_800_000_000_000;
const ALLOWED_KEYS = new Set([
	"schemaVersion",
	"sessionId",
	"parentTurnIndex",
	"provider",
	"model",
	"settledAtEpochMs",
	"quotaCheckedAtEpochMs",
	"shownAtEpochMs",
	"outcome",
	"decidedAtEpochMs",
	"msToAccept",
	"sentAs",
	"editRatioBucket",
	"dismissReason",
]);

afterEach(() => {
	vi.useRealTimers();
});

function fakeDate() {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(T0);
}

const meta: ShownSuggestionMeta = {
	parentTurnIndex: 0,
	provider: "anthropic",
	model: "m",
	settledAtEpochMs: 10,
	quotaCheckedAtEpochMs: 12,
	shownAtEpochMs: 40,
};

function tracker() {
	const records: Array<Omit<SuggestionOutcomeRecord, "schemaVersion" | "sessionId">> = [];
	return { t: new SuggestionAcceptTracker((r) => records.push(r)), records };
}

function parse(jsonl: string | undefined): SuggestionOutcomeRecord[] {
	return (jsonl ?? "")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as SuggestionOutcomeRecord);
}

describe("accept trace: tracker state machine", () => {
	it("flag parsing is default off", () => {
		expect(isAcceptTraceEnabled({})).toBe(false);
		expect(isAcceptTraceEnabled({ OMK_NEXT_SUGGESTIONS_ACCEPT_TRACE: "0" })).toBe(false);
		expect(isAcceptTraceEnabled({ OMK_NEXT_SUGGESTIONS_ACCEPT_TRACE: "on" })).toBe(true);
		expect(suggestionAcceptTracker(() => "s", "/nonexistent", SUGGEST_ON)).toBeUndefined();
		expect(
			suggestionAcceptTracker(() => "s", "/nonexistent", { ...TRACE_ON, OMK_TURN_METRICS: "off" }),
		).toBeUndefined();
	});

	it("Tab then exact send ⇒ one accepted record with msToAccept", () => {
		const { t, records } = tracker();
		t.shown(meta, "run tests");
		t.accepted(100);
		t.observeEditor("run tests", 110);
		t.sent("run tests", 120);
		t.sent("run tests", 130); // a later send is not double counted
		t.flush(140);
		expect(records).toEqual([
			{ ...meta, outcome: "accepted", msToAccept: 60, sentAs: "exact", editRatioBucket: "0", decidedAtEpochMs: 120 },
		]);
	});

	it("edited send carries a bucket; emptied editor is cleared; each accept yields exactly one record", () => {
		const { t, records } = tracker();
		t.shown(meta, "run the parser tests");
		t.accepted(50);
		t.sent("run the parser tests now", 60);
		t.shown(meta, "abc");
		t.accepted(70);
		t.observeEditor("", 80);
		t.sent("something else", 90);
		t.shown(meta, "unsent");
		t.accepted(95);
		t.flush(99);
		expect(records.map((r) => [r.outcome, r.sentAs, r.editRatioBucket])).toEqual([
			["accepted", "edited", "le_0.3"],
			["accepted", "cleared", undefined],
			["accepted", "cleared", undefined],
		]);
	});

	it("dismiss reasons: typed_over, new_turn, other; accepted suggestions are never dismissed", () => {
		const { t, records } = tracker();
		t.shown(meta, "a");
		t.dismissed(dismissReasonForKey("x"), 1);
		t.shown(meta, "b");
		t.sent("next prompt", 2);
		t.shown(meta, "c");
		t.dismissed(dismissReasonForKey("\x1b[A"), 3);
		t.shown(meta, "d");
		t.accepted(4);
		t.dismissed("new_turn", 5);
		t.sent("d", 6);
		expect(records.map((r) => r.dismissReason ?? r.sentAs)).toEqual(["typed_over", "new_turn", "other", "exact"]);
	});

	it("edit distance and buckets", () => {
		expect(editDistance("kitten", "sitting")).toBe(3);
		expect(editRatioBucket("abc", "abc")).toBe("0");
		expect(editRatioBucket("abcdefghij", "abcdefghiX")).toBe("le_0.1");
		expect(editRatioBucket("abc", "xyz")).toBe("gt_0.6");
		expect(EDIT_RATIO_BUCKETS).toHaveLength(5);
	});
});

describe("accept trace: controller wiring", () => {
	it("golden (required): trace flag off ⇒ turns, files, editor and main requests byte-identical to main 7cd26ee5fa", async () => {
		const golden = JSON.parse(
			readFileSync(join(import.meta.dirname, "fixtures", "accept-trace", "flag-off-golden.json"), "utf8"),
		);
		fakeDate();
		const off = await runAcceptScenario(SUGGEST_ON, (dir) => ({
			acceptTrace: suggestionAcceptTracker(() => "golden", "/nonexistent", {
				...SUGGEST_ON,
				OMK_TURN_METRICS_DIR: dir,
			}),
		}));
		expect(JSON.stringify(off, null, "\t")).toBe(JSON.stringify(golden, null, "\t"));
		expect(off.outcomes).toBeUndefined();
	});

	it("trace on: same turns/editor/main requests as off, plus exactly one record per shown suggestion, 0 bytes of text", async () => {
		const golden = JSON.parse(
			readFileSync(join(import.meta.dirname, "fixtures", "accept-trace", "flag-off-golden.json"), "utf8"),
		);
		fakeDate();
		const on = await runAcceptScenario(SUGGEST_ON, (dir) => ({
			acceptTrace: suggestionAcceptTracker(() => "golden", "/nonexistent", {
				...TRACE_ON,
				OMK_TURN_METRICS_DIR: dir,
			}),
		}));
		expect(on.turns).toBe(golden.turns);
		expect(on.editor).toEqual(golden.editor);
		expect(on.mainRequests).toEqual(golden.mainRequests);
		const records = parse(on.outcomes);
		// Two shown suggestions ⇒ two records: the Tab accept (edited) and the typed-over dismissal.
		expect(records.map((r) => [r.outcome, r.sentAs ?? r.dismissReason])).toEqual([
			["accepted", "edited"],
			["dismissed", "typed_over"],
		]);
		expect(records.filter((r) => r.outcome === "accepted")).toHaveLength(1);
		expect(records[0]).toMatchObject({ msToAccept: 0, editRatioBucket: "le_0.1", shownAtEpochMs: T0 });
		for (const r of records) {
			for (const k of Object.keys(r)) expect(ALLOWED_KEYS.has(k), k).toBe(true);
			expect(r.settledAtEpochMs <= r.quotaCheckedAtEpochMs && r.quotaCheckedAtEpochMs <= r.shownAtEpochMs).toBe(
				true,
			);
		}
		// No suggestion or prompt text, nor any fragment of it.
		for (const secret of [SUGGESTION, SENT, "SECRET", "parser", "first"]) expect(on.outcomes).not.toContain(secret);
	});
});
