/**
 * Spec 050 R3–R5, R8: lazy skill index, BM25 ranking, candidate messages and `skill-select` run-log records.
 *
 * Imported only on the first `skill_search` call or the first candidate computation of a skill-search
 * session (never on the startup path, AC 3). The index is the list of model-invocable skills
 * (name, short description, location) and is cached at `<agentDir>/cache/skill-index-v1.json`, keyed by a
 * fingerprint of the index algorithm version and each SKILL.md's path, size, mtime and inode
 * (`skill-index-store.ts`). Ranking is `searchCorpus` (BM25) over
 * `name + " " + description`.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { retrievalTokens, searchCorpus } from "../metacognition/retrieval.ts";
import { escapeXml } from "./context-budget-system-prompt-items.ts";
import type { CustomMessage } from "./messages.ts";
import { appendRunLog } from "./run-log.ts";
import {
	fingerprintSkills,
	type IndexDoc,
	readIndexFile,
	SKILL_INDEX_FILE,
	writeIndexFile,
} from "./skill-index-store.ts";
import type { Skill } from "./skills.ts";
import { compactSkillDescription } from "./skills-prompt.ts";
import type { SkillSearchToolDetails } from "./tools/skill-search-tool.ts";

export { SKILL_INDEX_ALGORITHM_VERSION, SKILL_INDEX_FILE } from "./skill-index-store.ts";

export const SKILL_CANDIDATES_CUSTOM_TYPE = "skill-candidates";
/** `searchCorpus` corpus cap. */
export const SKILL_INDEX_MAX_DOCS = 5000;
/** Candidates per user prompt (R3: default 3, at most 5). */
export const SKILL_CANDIDATE_K = 3;
/**
 * BM25 score floor for a candidate message (R3). A single query word that only a handful of skills
 * contain scores about 3–7 on a 1,000-skill index; words most skills share score below 1.
 */
export const SKILL_CANDIDATE_MIN_SCORE = 2;
const MAX_QUERY_CHARS = 4096;
const MATCH_COUNT_CAP = 64;

export interface SkillHit extends IndexDoc {
	readonly score: number;
}

export interface SkillSearchSessionOptions {
	readonly skills: () => readonly Skill[];
	readonly agentDir: string;
	readonly env: NodeJS.ProcessEnv;
}

/** Per-session state: the loaded index, and which skills were already offered (R3, AC 6). */
export class SkillSearchSession {
	private index: { skills: readonly Skill[]; fingerprint: string; docs: readonly IndexDoc[] } | undefined;
	private readonly suggested = new Set<string>();
	private readonly searched = new Set<string>();

	private readonly options: SkillSearchSessionOptions;

	constructor(options: SkillSearchSessionOptions) {
		this.options = options;
	}

	/** `skill_search` tool body. */
	search(query: string, limit: number): { text: string; details: SkillSearchToolDetails } {
		const started = performance.now();
		const all = this.rank(query, MATCH_COUNT_CAP);
		const hits = all.slice(0, limit);
		for (const hit of hits) this.searched.add(hit.name);
		this.log({
			type: "search",
			queryTokens: queryTokenCount(query),
			limit,
			returned: hits.length,
			skillHashes: hits.map((hit) => shortHash(hit.name)),
			ms: elapsed(started),
		});
		const text =
			hits.length === 0
				? "No matching skills."
				: hits.map((hit) => `${hit.name} — ${hit.description} — ${hit.location}`).join("\n");
		return {
			text,
			details: {
				query,
				queryHash: shortHash(query),
				limit,
				matchCount: all.length,
				candidates: hits.map((hit) => ({ name: hit.name, score: round3(hit.score), location: hit.location })),
			},
		};
	}

	/** R3 task start: one message with the top new candidates, or none below the floor. */
	suggest(query: string): CustomMessage | undefined {
		const started = performance.now();
		const ranked = this.rank(taskQuery(query.slice(0, MAX_QUERY_CHARS)), MATCH_COUNT_CAP);
		const top = ranked[0]?.score ?? 0;
		const fresh = ranked
			.filter((hit) => hit.score >= SKILL_CANDIDATE_MIN_SCORE && !this.suggested.has(hit.name))
			.slice(0, SKILL_CANDIDATE_K);
		for (const hit of fresh) this.suggested.add(hit.name);
		this.log({
			type: "suggest",
			trigger: "task",
			todoKind: "none",
			k: fresh.length,
			skillHashes: fresh.map((hit) => shortHash(hit.name)),
			topScore: round3(top),
			belowFloor: top < SKILL_CANDIDATE_MIN_SCORE,
			ms: elapsed(started),
		});
		if (fresh.length === 0) return undefined;
		return {
			role: "custom",
			customType: SKILL_CANDIDATES_CUSTOM_TYPE,
			content: renderCandidates(fresh),
			display: false,
			timestamp: Date.now(),
		};
	}

	/** Whether this session offered the skill, and how (R8 `read`). */
	offeredVia(name: string): "suggest" | "search" | "none" {
		if (this.suggested.has(name)) return "suggest";
		if (this.searched.has(name)) return "search";
		return "none";
	}

	private rank(query: string, limit: number): SkillHit[] {
		const docs = this.docs();
		if (query.trim() === "" || docs.length === 0) return [];
		const corpus = docs.map((doc) => ({ id: doc.name, uri: doc.location, body: `${doc.name} ${doc.description}` }));
		const byName = new Map(docs.map((doc) => [doc.name, doc]));
		return searchCorpus(query.slice(0, MAX_QUERY_CHARS), corpus, limit).flatMap((hit) => {
			const doc = byName.get(hit.id);
			return doc ? [{ ...doc, score: hit.score }] : [];
		});
	}

	/** Builds or loads the index on first use; `/reload` with different skills rebuilds it (new fingerprint). */
	private docs(): readonly IndexDoc[] {
		const loaded = this.options.skills();
		// Same loaded list (no /reload since the last build): no need to stat every SKILL.md again.
		if (this.index?.skills === loaded) return this.index.docs;
		const skills = loaded.filter((skill) => !skill.disableModelInvocation);
		const fingerprint = fingerprintSkills(skills);
		if (this.index?.fingerprint === fingerprint) {
			this.index = { ...this.index, skills: loaded };
			return this.index.docs;
		}
		const started = performance.now();
		const path = join(this.options.agentDir, "cache", SKILL_INDEX_FILE);
		const cached = readIndexFile(path);
		let docs: readonly IndexDoc[];
		let truncated: boolean;
		let cacheBytes = 0;
		const cacheHit = cached?.fingerprint === fingerprint;
		if (cached && cacheHit) {
			docs = cached.docs;
			truncated = cached.truncated;
		} else {
			truncated = skills.length > SKILL_INDEX_MAX_DOCS;
			docs = skills.slice(0, SKILL_INDEX_MAX_DOCS).map((skill) => ({
				name: skill.name,
				description: compactSkillDescription(skill.description),
				location: skill.filePath,
			}));
			cacheBytes = writeIndexFile(path, { version: 1, fingerprint, truncated, docs });
		}
		this.index = { skills: loaded, fingerprint, docs };
		this.log({
			type: "index",
			skills: skills.length,
			docsUsed: docs.length,
			buildMs: elapsed(started),
			cacheHit,
			cacheBytes,
			fingerprintHash: fingerprint.slice(0, 12),
			truncated,
		});
		return docs;
	}

	private log(record: Parameters<typeof appendRunLog>[1]): void {
		appendRunLog("skill-select", record, { env: this.options.env });
	}
}

export function renderCandidates(hits: readonly IndexDoc[]): string {
	return [
		"<skill_candidates>",
		"Skills that may help with this task. Read a skill's location with the read tool before applying it; use skill_search to find others.",
		...hits.flatMap((hit) => [
			"  <skill>",
			`    <name>${escapeXml(hit.name)}</name>`,
			`    <description>${escapeXml(hit.description)}</description>`,
			`    <location>${escapeXml(hit.location)}</location>`,
			"  </skill>",
		]),
		"</skill_candidates>",
	].join("\n");
}

export function shortHash(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
}

function queryTokenCount(query: string): number {
	return retrievalTokens(query).length;
}

/**
 * Common words a task sentence is full of. In a small catalog the few descriptions that contain "and" or
 * "to" give them a high IDF, so the automatic candidates rank on content words only.
 */
const TASK_STOP_WORDS = new Set(
	"a an and are as at be by can do for from in into is it its me my now of on or our please so that the then this to up us we with you your".split(
		" ",
	),
);

function taskQuery(query: string): string {
	return retrievalTokens(query)
		.filter((token) => token.length > 1 && !TASK_STOP_WORDS.has(token))
		.join(" ");
}

function round3(value: number): number {
	return Math.round(value * 1000) / 1000;
}

function elapsed(started: number): number {
	return round3(performance.now() - started);
}
