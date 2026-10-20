// Mechanical hub membership: each selectable skill's "name description" (catalog-v3) through the frozen
// `!omk` router (parseBangInvocation, bang-skill-invocation.ts at 86e5044a7b). Single hub per skill.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseBangInvocation } from "/workspace/omk-he-092/packages/coding-agent/src/core/bang-skill-invocation.ts";
import { renderCandidates } from "/workspace/omk-he-091-impl/packages/coding-agent/src/core/skill-search.ts";
const D = "/workspace/omk-eval-092/";
const router = "/workspace/omk-he-092/packages/coding-agent/src/core/bang-skill-invocation.ts";
const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const cat = JSON.parse(readFileSync(D + "catalog-v3.json", "utf8")).filter((s: any) => !s.disabled);
const registry = { hasSkill: () => true }; // every hub resolvable, so the route is never rewritten
const hubs: Record<string, string[]> = {};
for (const s of cat) {
	const r = parseBangInvocation(`!omk ${s.name} ${s.desc}`, registry);
	if (r.kind !== "skill") throw new Error(`unexpected ${r.kind} for ${s.name}`);
	(hubs[r.skillName] ??= []).push(s.name);
}
const sorted = Object.fromEntries(Object.keys(hubs).sort().map((h) => [h, hubs[h].sort()]));
const out = { routerSha256: sha(readFileSync(router)), catalogSha256: sha(readFileSync(D + "catalog-v3.json")), input: "`!omk ${name} ${desc}`", hubs: sorted };
writeFileSync(D + "hub-membership.json", JSON.stringify(out, null, 1) + "\n");
const byName = new Map(cat.map((s: any) => [s.name, s]));
for (const [h, names] of Object.entries(sorted)) {
	const docs = names.map((n) => { const s: any = byName.get(n); return { name: s.name, description: s.desc, location: s.path }; });
	const nd = names.reduce((a, n) => { const s: any = byName.get(n); return a + s.name.length + s.desc.length; }, 0);
	console.log(h, names.length, "block_tok", Math.ceil(renderCandidates(docs as any).length / 4), "namedesc_tok", Math.ceil(nd / 4));
}
console.log("membership sha256", sha(readFileSync(D + "hub-membership.json")));
