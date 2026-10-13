import { describe, expect, it } from "vitest";
import { type RankDoc, rankSkills } from "../src/core/skill-select-rankers.ts";

function doc(name: string, description: string, contentHash = name): RankDoc {
	return { name, description, contentHash, location: `/skills/${name}/SKILL.md` };
}

const copies = Array.from({ length: 80 }, (_, i) => doc(`copy-${i}`, "PDF forms PDF fields", "same-content"));
const distinct = doc("pdf-merge", "PDF merge and split documents with bookmarks");

describe.each(["bm25", "metacon"] as const)("%s skill search cap", (mode) => {
	it("returns a distinct candidate when duplicates fill the raw top 64", () => {
		const result = rankSkills(mode, "pdf", [...copies, distinct], { limit: 3 });
		expect(result.hits.map((hit) => hit.name)).toContain("pdf-merge");
		expect(result.matchCount).toBe(2);
	});

	it("fills the candidate pool after excluding the raw top 64", () => {
		const high = copies.map((entry) => ({ ...entry, contentHash: entry.name }));
		const result = rankSkills(mode, "pdf", [...high, distinct], {
			limit: 3,
			exclude: new Set(high.map((entry) => entry.name)),
		});
		expect(result.hits.map((hit) => hit.name)).toEqual(["pdf-merge"]);
		expect(result.matchCount).toBe(1);
	});

	it("keeps the highest-ranked alias rather than the first lexical name", () => {
		const aliases = [doc("a-generic", "General document helper", "same"), doc("z-pdf", "PDF forms", "same")];
		const result = rankSkills(mode, "pdf", aliases, { limit: 3 });
		expect(result.hits.map((hit) => hit.name)).toEqual(["z-pdf"]);
	});

	it("excludes aliases of an already offered skill by content hash", () => {
		const result = rankSkills(mode, "pdf", [...copies, distinct], {
			limit: 3,
			exclude: new Set([copies[0].name]),
		});
		expect(result.hits.map((hit) => hit.name)).toEqual(["pdf-merge"]);
	});
});
