// Offline tests: fake fetch, temp files. No network, no key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { run, sha256File, attachOf, outcome, parseAnswer, buildBody } from "./paid_all217_run.ts";

function fixture(n = 3) {
	const d = mkdtempSync(join(tmpdir(), "paid217-"));
	const paths = { catalog: join(d, "c.json"), labels: join(d, "l.jsonl"), template: join(d, "t.json"), out: join(d, "out.json") };
	writeFileSync(paths.catalog, JSON.stringify([{ name: "a", desc: "skill a", disabled: false }, { name: "b", desc: "skill b", disabled: false }]));
	writeFileSync(paths.labels, Array.from({ length: n }, (_, i) => JSON.stringify({ id: `s${i}`, sentence: `task ${i}`, gold: i % 2 ? "a" : null })).join("\n"));
	writeFileSync(paths.template, JSON.stringify({ model: "jev-1.14.0", state_field: "sentence", question_id: "skill", type: "choice", instructions: "pick", extra_options: { none: "none" } }));
	const expected = { catalog: sha256File(paths.catalog), labels: sha256File(paths.labels), template: sha256File(paths.template) };
	return { paths, expected };
}
function fakeFetch(bodies: any[], tokens = 100) {
	return (async (_u: any, init: any) => { bodies.push(init.body);
		return new Response(JSON.stringify({ model: "jev-1.14.0", answers: { skill: { choice: "a", probabilities: { a: 0.9 }, confidence: 0.9 } }, usage: { input_tokens: tokens, output_tokens: 3 } }), { status: 200 }); }) as typeof fetch;
}

test("sha mismatch refuses before any call", async () => {
	const { paths, expected } = fixture(); const bodies: any[] = [];
	await assert.rejects(run({ paths, key: "k", cap: 1, fetchFn: fakeFetch(bodies), expected: { ...expected, labels: "0".repeat(64) } }), /sha256 mismatch for labels/);
	await assert.rejects(run({ paths, key: "k", cap: 1, fetchFn: fakeFetch(bodies), expected: { ...expected, template: "0".repeat(64) } }), /sha256 mismatch for template/);
	await assert.rejects(run({ paths, key: "k", cap: 1, fetchFn: fakeFetch(bodies), expected: { ...expected, catalog: "0".repeat(64) } }), /sha256 mismatch for catalog/);
	assert.equal(bodies.length, 0); assert.equal(existsSync(paths.out), false);
});

test("no calls after cap (next-call estimate included) and run is INVALID", async () => {
	const { paths, expected } = fixture(5); const bodies: any[] = [];
	const per = 1_000_000 * 0.042 / 1e6; // 1M tokens per call = $0.042
	const r = await run({ paths, key: "k", cap: per * 2.5, fetchFn: fakeFetch(bodies, 1_000_000), expected });
	assert.equal(bodies.length, 2); assert.equal(r.calls, 2); assert.ok(r.usd <= per * 2.5); assert.equal(r.invalid, true);
	const o = JSON.parse(readFileSync(paths.out, "utf8"));
	assert.deepEqual(o.calls.slice(2).map((x: any) => x.status), ["cap_reached", "cap_reached", "cap_reached"]);
	assert.equal(statSync(paths.out).mode & 0o777, 0o600);
});

test("request body has no gold or id field", async () => {
	const { paths, expected } = fixture(3); const bodies: any[] = [];
	await run({ paths, key: "k", cap: 1, fetchFn: fakeFetch(bodies), expected });
	assert.equal(bodies.length, 3);
	for (const b of bodies) { assert.doesNotMatch(b, /"gold"/); assert.doesNotMatch(b, /"id"/); assert.deepEqual(Object.keys(JSON.parse(b)).sort(), ["model", "questions", "state"]); }
	assert.equal(JSON.stringify(buildBody({ model: "m", question_id: "q", type: "choice", instructions: "i" }, "x", {})).includes("gold"), false);
});

test("existing output refuses (exactly one run)", async () => {
	const { paths, expected } = fixture(); writeFileSync(paths.out, "{}");
	await assert.rejects(run({ paths, key: "k", cap: 1, fetchFn: fakeFetch([]), expected }), /exactly one run/);
});

test("missing key or cap refuses", async () => {
	const { paths, expected } = fixture();
	await assert.rejects(run({ paths, key: "", cap: 1, fetchFn: fakeFetch([]), expected }), /KEY missing/);
	await assert.rejects(run({ paths, key: "k", cap: Number.NaN, fetchFn: fakeFetch([]), expected }), /CAP_USD missing/);
});

test("failed call is recorded once, not retried", async () => {
	const { paths, expected } = fixture(2); let n = 0;
	const f = (async () => { n++; throw new Error("net"); }) as typeof fetch;
	const r = await run({ paths, key: "k", cap: 1, fetchFn: f, expected });
	assert.equal(n, 2); assert.equal(r.calls, 2);
});

test("parsing → hit / miss / no-attach / false attach", () => {
	const ok = (choice: string, p: number) => parseAnswer(200, { answers: { skill: { choice, probabilities: { [choice]: p } } } }, "skill");
	assert.equal(outcome(attachOf(ok("a", 0.9), 0.6), "a"), "hit");
	assert.equal(outcome(attachOf(ok("a", 0.6), 0.6), "a"), "hit");
	assert.equal(outcome(attachOf(ok("b", 0.9), 0.6), "a"), "miss");
	assert.equal(outcome(attachOf(ok("a", 0.59), 0.6), "a"), "miss");
	assert.equal(outcome(attachOf(ok("none", 0.99), 0.6), "a"), "miss");
	assert.equal(outcome(attachOf(parseAnswer(500, null, "skill"), 0.6), "a"), "miss");
	assert.equal(outcome(attachOf(parseAnswer(200, { answers: {} }, "skill"), 0.6), "a"), "miss");
	assert.equal(outcome(attachOf({ status: "error" }, 0.6), "a"), "miss");
	assert.equal(outcome(attachOf(ok("none", 0.9), 0.6), null), "no_attach_ok");
	assert.equal(outcome(attachOf(ok("a", 0.5), 0.6), null), "no_attach_ok");
	assert.equal(outcome(attachOf(ok("a", 0.7), 0.6), null), "false_attach");
});
