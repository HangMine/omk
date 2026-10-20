import { readFileSync } from "node:fs";
import { renderCandidates } from "/workspace/omk-he-091-impl/packages/coding-agent/src/core/skill-search.ts";
for (const f of ["/workspace/omk-eval-091/catalog-v2.json", "/workspace/omk-eval-092/catalog-v3.json"]) {
	const c = JSON.parse(readFileSync(f, "utf8")).filter((s: any) => !s.disabled);
	const t = renderCandidates(c.map((s: any) => ({ name: s.name, description: s.desc, location: s.path })) as any);
	console.log(f, t.length, Math.ceil(t.length / 4));
}
