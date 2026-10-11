/**
 * Spec 050 R5: the on-disk skill index (`<agentDir>/cache/skill-index-v1.json`), its fingerprint and the
 * atomic write. Loaded only with `skill-search.ts`. The file is per agent directory, not per project: sessions
 * in different projects with different skill sets overwrite each other's cache, and the next session in the
 * other project rebuilds it (a miss, never wrong results).
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Skill } from "./skills.ts";

export const SKILL_INDEX_FILE = "skill-index-v1.json";
/**
 * Part of the index fingerprint. Bump it whenever what an index entry holds changes for the same SKILL.md
 * (`compactSkillDescription`, the fields kept), so an older cache is rebuilt instead of reused.
 */
export const SKILL_INDEX_ALGORITHM_VERSION = 1;
/** A `.tmp` sibling older than this is left over from a crashed or failed write and is removed. */
const STALE_TMP_MS = 60_000;

export interface IndexDoc {
	readonly name: string;
	readonly description: string;
	readonly location: string;
}

export interface IndexFile {
	readonly version: 1;
	readonly fingerprint: string;
	readonly truncated: boolean;
	readonly docs: readonly IndexDoc[];
}

/**
 * Index algorithm version, then path, size, mtime and inode of every SKILL.md, plus name and description
 * (they can come from elsewhere).
 */
export function fingerprintSkills(skills: readonly Skill[], version = SKILL_INDEX_ALGORITHM_VERSION): string {
	const hash = createHash("sha256");
	hash.update(`skill-index-algorithm:${version}\n`);
	for (const skill of skills) {
		let meta = "missing";
		try {
			const stat = statSync(skill.filePath);
			meta = `${stat.size}:${stat.mtimeMs}:${stat.ino}`;
		} catch {}
		hash.update(`${skill.filePath}\0${meta}\0${skill.name}\0${skill.description}\n`);
	}
	return hash.digest("hex");
}

export function readIndexFile(path: string): IndexFile | undefined {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<IndexFile>;
		if (parsed.version !== 1 || typeof parsed.fingerprint !== "string" || !Array.isArray(parsed.docs))
			return undefined;
		const docs = parsed.docs.filter(
			(doc): doc is IndexDoc =>
				typeof doc?.name === "string" && typeof doc.description === "string" && typeof doc.location === "string",
		);
		if (docs.length !== parsed.docs.length) return undefined;
		return { version: 1, fingerprint: parsed.fingerprint, truncated: parsed.truncated === true, docs };
	} catch {
		return undefined;
	}
}

/**
 * Atomic (tmp + rename); a failed write only costs the next session a rebuild. Returns bytes written.
 * A failed write removes its own `.tmp`; stale ones from other processes are swept first.
 */
export function writeIndexFile(path: string, file: IndexFile): number {
	const tmp = `${path}.${process.pid}.tmp`;
	try {
		const text = JSON.stringify(file);
		mkdirSync(dirname(path), { recursive: true });
		removeStaleTmpFiles(path);
		writeFileSync(tmp, text);
		renameSync(tmp, path);
		return Buffer.byteLength(text);
	} catch {
		try {
			unlinkSync(tmp);
		} catch {}
		return 0;
	}
}

/** `<index>.<pid>.tmp` files older than a minute; a younger one may belong to a concurrent writer. */
function removeStaleTmpFiles(path: string, now = Date.now()): void {
	const dir = dirname(path);
	const prefix = `${SKILL_INDEX_FILE}.`;
	for (const name of readdirSync(dir)) {
		if (!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
		try {
			const file = join(dir, name);
			if (now - statSync(file).mtimeMs > STALE_TMP_MS) unlinkSync(file);
		} catch {}
	}
}
