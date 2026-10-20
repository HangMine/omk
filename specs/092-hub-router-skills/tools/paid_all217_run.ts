// Paid all-217 Jev arm runner (PREREG prereg-paid-all217.md). Exactly one run. Plain fetch, no deps.
// Requires TYPESAFE_API_KEY (never logged) and OMK_COST_CAP_USD (set by 인호). Raw output mode 600, box only.
import { readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
const T = JSON.parse(readFileSync(new URL("./paid-all217-template.json", import.meta.url), "utf8"));
const CAT = "/workspace/omk-eval-092/catalog-v3.json", LAB = "/workspace/omk-eval-091/labels-en-v1.jsonl";
const OUT = "/workspace/omk-eval-092/paid-all217-raw.json";
const PRICE_IN = 0.042 / 1e6, PRICE_OUT = 0; // docs.typesafe.ai/models
const key = process.env.TYPESAFE_API_KEY, cap = Number(process.env.OMK_COST_CAP_USD);
if (!key) throw new Error("TYPESAFE_API_KEY missing");
if (!(cap > 0)) throw new Error("OMK_COST_CAP_USD missing");
if (existsSync(OUT)) throw new Error("output exists: exactly one run");
const cat = JSON.parse(readFileSync(CAT, "utf8")).filter((s: any) => !s.disabled).sort((a: any, b: any) => (a.name < b.name ? -1 : 1));
const criteria: Record<string, string> = Object.fromEntries(cat.map((s: any) => [s.name, s.desc]));
Object.assign(criteria, T.extra_options);
const rows = readFileSync(LAB, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const out: any[] = []; let usd = 0;
const save = () => { writeFileSync(OUT, JSON.stringify({ model: T.model, usd, calls: out }, null, 1), { mode: 0o600 }); chmodSync(OUT, 0o600); };
for (const r of rows) {
	if (usd >= cap) { out.push({ id: r.id, status: "cap_reached" }); continue; }
	const t0 = Date.now(); let rec: any = { id: r.id };
	try {
		const res = await fetch("https://api.typesafe.ai/v1/systemone", {
			method: "POST", signal: AbortSignal.timeout(15000),
			headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
			body: JSON.stringify({ model: T.model, state: r[T.state_field], questions: { [T.question_id]: { type: T.type, instructions: T.instructions, criteria } } }),
		});
		const j: any = await res.json().catch(() => null);
		const a = j?.answers?.[T.question_id];
		const it = j?.usage?.input_tokens ?? 0, ot = j?.usage?.output_tokens ?? 0;
		const c = it * PRICE_IN + ot * PRICE_OUT; usd += c;
		rec = { id: r.id, status: res.status, model: j?.model, choice: a?.choice ?? null, p: a?.probabilities?.[a?.choice] ?? null, confidence: a?.confidence ?? null, input_tokens: it, output_tokens: ot, usd: c, ms: Date.now() - t0 };
	} catch (e: any) { rec = { id: r.id, status: "error", error: String(e?.name ?? "error"), ms: Date.now() - t0 }; }
	out.push(rec); save();
}
save();
console.log(JSON.stringify({ calls: out.length, usd }));
