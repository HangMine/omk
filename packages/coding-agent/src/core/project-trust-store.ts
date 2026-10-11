/**
 * The project trust store (spec 053): `~/.omk/project-trust.json`, owner-only.
 *
 * It sits next to the MCP trust store (`~/.omk/mcp-trust.json`) and is keyed on the home
 * directory, not on the agent dir (`OMK_CODING_AGENT_DIR`): one answer per project covers
 * every agent dir the user runs with (bench and test runs point the agent dir at throwaway
 * directories), and the file is outside any repository, so a project cannot write its own
 * trust. Writes are read-merge-write under a lock directory, through a fresh 0600 temp file
 * that is renamed into place.
 */
import { randomBytes } from "node:crypto";
import {
	closeSync,
	existsSync,
	fchmodSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONFIG_DIR_NAME } from "../config.ts";
import { canonicalDir, type ProjectCodeSurface } from "./project-code-fingerprint.ts";

export type ProjectTrustDecision = "trusted" | "denied";

export interface StoredProjectTrust {
	decision: ProjectTrustDecision;
	fingerprint: string;
	decidedAt: string;
}

interface TrustStoreFile {
	version: 1;
	projects: Record<string, StoredProjectTrust>;
}

const LOCK_WAIT_MS = 2000;
const LOCK_STALE_MS = 10_000;

export function projectTrustStorePath(home: string = os.homedir()): string {
	return path.join(home, CONFIG_DIR_NAME, "project-trust.json");
}

function readStore(home: string): TrustStoreFile {
	const file = projectTrustStorePath(home);
	if (!existsSync(file)) return { version: 1, projects: {} };
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<TrustStoreFile>;
		if (parsed.version !== 1 || typeof parsed.projects !== "object" || parsed.projects === null) {
			return { version: 1, projects: {} };
		}
		return { version: 1, projects: parsed.projects };
	} catch {
		// A corrupt store decides nothing: every project is asked again.
		return { version: 1, projects: {} };
	}
}

/** The stored answer for one canonical project path, if any. */
export function readStoredProjectTrust(
	projectKey: string,
	home: string = os.homedir(),
): StoredProjectTrust | undefined {
	return readStore(home).projects[projectKey];
}

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Take the lock directory; break it when stale; give up (unlocked write) after LOCK_WAIT_MS. */
function acquireLock(lock: string): boolean {
	const deadline = Date.now() + LOCK_WAIT_MS;
	for (;;) {
		try {
			mkdirSync(lock, { mode: 0o700 });
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
		}
		try {
			if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
				rmSync(lock, { recursive: true, force: true });
				continue;
			}
		} catch {
			continue; // released between mkdir and stat
		}
		if (Date.now() >= deadline) return false;
		sleepSync(25);
	}
}

function writeStoreFile(file: string, store: TrustStoreFile): void {
	// A fresh, exclusively created temp file, forced to 0600 before any content lands in it.
	const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	const fd = openSync(temp, "wx", 0o600);
	try {
		fchmodSync(fd, 0o600);
		writeSync(fd, `${JSON.stringify(store, null, "\t")}\n`);
	} finally {
		closeSync(fd);
	}
	try {
		renameSync(temp, file);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}

/** Read, change and write the store under the lock, so concurrent omk processes do not drop each other's entries. */
function updateStore(home: string, change: (store: TrustStoreFile) => boolean): void {
	const file = projectTrustStorePath(home);
	mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const lock = `${file}.lock`;
	const locked = acquireLock(lock);
	try {
		const store = readStore(home);
		if (change(store)) writeStoreFile(file, store);
	} finally {
		if (locked) rmSync(lock, { recursive: true, force: true });
	}
}

/** Store the user's answer for this exact code surface. */
export function recordProjectTrustDecision(
	surface: ProjectCodeSurface,
	decision: ProjectTrustDecision,
	home: string = os.homedir(),
	now: Date = new Date(),
): void {
	updateStore(home, (store) => {
		store.projects[surface.projectKey] = { decision, fingerprint: surface.fingerprint, decidedAt: now.toISOString() };
		return true;
	});
}

/** Forget the stored answer, so the next interactive run asks again. */
export function forgetProjectTrustDecision(cwd: string, home: string = os.homedir()): void {
	const key = canonicalDir(cwd);
	updateStore(home, (store) => {
		if (!(key in store.projects)) return false;
		delete store.projects[key];
		return true;
	});
}
