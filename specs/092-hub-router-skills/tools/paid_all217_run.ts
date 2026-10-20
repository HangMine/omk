// Paid all-217 Jev arm runner (PREREG prereg-paid-all217.md). Exactly one run. Plain fetch, no deps.
// Requires TYPESAFE_API_KEY (never logged) and OMK_COST_CAP_USD (set by 인호). Raw output mode 600, box only.
import { readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const PREREG_SHA256 = {
	catalog: "250e637e0163c9884e6c5d261290f5d5444423909510882dbf28a617e723bde4",
	labels: "adadd76d7d543ded09cf8e93472966c36483886bf4b094b13242671a3e0361dd",
	template: "fdce5368063ce81f78133d827483dc45edc4afab2db8f7c943a80f32e3f5ec41",
};
export const PRICE_IN = 0.042 / 1e6; // docs.typesafe.ai/models: $0.042/Mtok input
export const PRICE_OUT = 0; // "Output tokens are free."
export const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

export interface Paths { catalog: string; labels: string; template: string; out: string }
export const sha256File = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

/** Abort before any API call if an input differs from the PREREG value. */
export function verifyInputs(paths: Paths, expected = PREREG_SHA256): void {
	for (const k of ["catalog", "labels", "template"] as const) {
		const got = sha256File(paths[k]);
		if (got !== expected[k]) throw new Error(`sha256 mismatch for ${k}`);
	}
}

/** Request body: state = sentence only. Never includes gold or id. */
export function buildBody(T: any, sentence: string, criteria: Record<string, string>) {
	return { model: T.model, state: sentence, questions: { [T.question_id]: { type: T.type, instructions: T.instructions, criteria } } };
}

/** Pre-call estimate: chars/4 of the body × input price. The loop also uses the largest billed input so far. */
export const estimateCallUsd = (body: unknown) => Math.ceil(JSON.stringify(body).length / 4) * PRICE_IN;

/** Attach decision from a parsed answer. */
export function attachOf(rec: { choice?: string | null; p?: number | null; status?: unknown }, threshold: number): string | null {
	if (rec.status !== 200 || !rec.choice || rec.choice === "none" || typeof rec.p !== "number" || rec.p < threshold) return null;
	return rec.choice;
}

/** G1/G4 outcome per item. gold = null for no-answer items. */
export function outcome(attached: string | null, gold: string | null): "hit" | "miss" | "no_attach_ok" | "false_attach" {
	if (gold === null) return attached === null ? "no_attach_ok" : "false_attach";
	return attached === gold ? "hit" : "miss";
}

export function parseAnswer(status: number, j: any, qid: string) {
	const a = j?.answers?.[qid];
	const choice = typeof a?.choice === "string" ? a.choice : null;
	const p = choice !== null && typeof a?.probabilities?.[choice] === "number" ? a.probabilities[choice] : null;
	return { status, model: j?.model ?? null, choice, p, confidence: a?.confidence ?? null,
		input_tokens: j?.usage?.input_tokens ?? 0, output_tokens: j?.usage?.output_tokens ?? 0 };
}

export async function run(opts: { paths: Paths; key: string; cap: number; fetchFn?: typeof fetch; expected?: typeof PREREG_SHA256 }) {
	const { paths, key, cap } = opts; const fetchFn = opts.fetchFn ?? fetch;
	if (!key) throw new Error("TYPESAFE_API_KEY missing");
	if (!(cap > 0)) throw new Error("OMK_COST_CAP_USD missing");
	if (existsSync(paths.out)) throw new Error("output exists: exactly one run");
	verifyInputs(paths, opts.expected);
	const T = JSON.parse(readFileSync(paths.template, "utf8"));
	const cat = JSON.parse(readFileSync(paths.catalog, "utf8")).filter((s: any) => !s.disabled).sort((a: any, b: any) => (a.name < b.name ? -1 : 1));
	const criteria: Record<string, string> = Object.fromEntries(cat.map((s: any) => [s.name, s.desc]));
	Object.assign(criteria, T.extra_options);
	const rows = readFileSync(paths.labels, "utf8").trim().split("\n").map((l) => JSON.parse(l));
	const out: any[] = []; let usd = 0; let calls = 0; let maxSeenIn = 0;
	const save = () => { writeFileSync(paths.out, JSON.stringify({ model: T.model, usd, calls: out }, null, 1), { mode: 0o600 }); chmodSync(paths.out, 0o600); };
	for (const r of rows) {
		const body = buildBody(T, r[T.state_field], criteria);
		const est = Math.max(estimateCallUsd(body), maxSeenIn * PRICE_IN);
		if (usd + est > cap) { out.push({ id: r.id, status: "cap_reached" }); continue; } // retry 0 times; no overshoot
		const t0 = Date.now(); let rec: any;
		calls++;
		try {
			const res = await fetchFn(ENDPOINT, { method: "POST", signal: AbortSignal.timeout(15000),
				headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) });
			const j: any = await res.json().catch(() => null);
			rec = { id: r.id, ...parseAnswer(res.status, j, T.question_id) };
			rec.usd = rec.input_tokens * PRICE_IN + rec.output_tokens * PRICE_OUT; usd += rec.usd; maxSeenIn = Math.max(maxSeenIn, rec.input_tokens);
		} catch (e: any) { rec = { id: r.id, status: "error", error: e?.name === "TimeoutError" ? "timeout" : "network" }; } // fixed labels only: never copy error text (may embed headers)
		rec.ms = Date.now() - t0; out.push(rec); save();
	}
	save();
	return { calls, usd, invalid: out.some((x) => x.status === "cap_reached") };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const r = await run({
		paths: { catalog: "/workspace/omk-eval-092/catalog-v3.json", labels: "/workspace/omk-eval-091/labels-en-v1.jsonl",
			template: fileURLToPath(new URL("./paid-all217-template.json", import.meta.url)), out: "/workspace/omk-eval-092/paid-all217-raw.json" },
		key: process.env.TYPESAFE_API_KEY ?? "", cap: Number(process.env.OMK_COST_CAP_USD),
	});
	console.log(JSON.stringify(r));
}
