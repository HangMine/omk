/**
 * Spec 107: new-only diagnostics after edit/write (`OMK_EDIT_DIAGNOSTICS=1`, default off).
 *
 * Idea credited to SWE-agent's `windowed_edit_linting` (MIT) and Aider's auto-lint
 * (Apache-2.0). No code is copied. Unlike SWE-agent this variant is report-only: the
 * edit is never rejected or reverted, and a diagnostics failure never fails the edit.
 *
 * Flow: baseline check inside the file mutation queue (before the write), snapshot
 * (mtime + hash) after the write, release the lock, post-check, re-snapshot, and
 * report only errors that are new vs the baseline. Timeouts, skips and stale files
 * append nothing to the tool text; they go to `details` and the run log only.
 */
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { appendRunLog } from "../run-log.ts";
import {
	type CollectFileDiagnostics,
	collectFileDiagnostics,
	type DiagnosticLine,
	type FileDiagnosticsResult,
	languageForFile,
} from "./diagnostics-checkers.ts";

export const EDIT_DIAGNOSTICS_ENV = "OMK_EDIT_DIAGNOSTICS";
export const EDIT_DIAGNOSTICS_TIMEOUT_ENV = "OMK_EDIT_DIAGNOSTICS_TIMEOUT_MS";
export const EDIT_DIAG_TIMEOUT_LOG = "edit-diag-timeout";
/** One line per checked edit: mechanism metrics (spec 107 §4), never evidence for resolve rate. */
export const EDIT_DIAG_LOG = "edit-diag";

const PER_CHECK_TIMEOUT_MS = 10_000;
const PER_EDIT_TIMEOUT_MS = 20_000;
const MAX_FILES = 5;
const MAX_ENTRIES = 20;

export function isEditDiagnosticsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env[EDIT_DIAGNOSTICS_ENV] === "1";
}

let collector: CollectFileDiagnostics = collectFileDiagnostics;

/** Test seam: replace the checker. Returns a restore function. */
export function setEditDiagnosticsCollectorForTest(next: CollectFileDiagnostics): () => void {
	const previous = collector;
	collector = next;
	return () => {
		collector = previous;
	};
}

export interface NewDiagnosticsDetails {
	readonly outcome: "reported" | "none" | "skipped" | "stale" | "timeout";
	readonly diagnostics: readonly DiagnosticLine[];
	readonly total: number;
	readonly skipped?: string;
}

function keyOf(d: DiagnosticLine): string {
	return `${d.path}\0${d.severity}\0${d.message}`;
}

/**
 * Errors in `after` that are not in `before`, keyed by (path, severity, message) with
 * multiset counts. Line/column are excluded so shifted errors are not "new". Warnings
 * and info are dropped. Order: edited file first, then other files by first appearance.
 */
export function diffNewDiagnostics(
	before: readonly DiagnosticLine[],
	after: readonly DiagnosticLine[],
	editedPath: string,
): DiagnosticLine[] {
	const remaining = new Map<string, number>();
	for (const d of before) {
		if (d.severity !== "error") continue;
		remaining.set(keyOf(d), (remaining.get(keyOf(d)) ?? 0) + 1);
	}
	const fresh: DiagnosticLine[] = [];
	for (const d of after) {
		if (d.severity !== "error") continue;
		const count = remaining.get(keyOf(d)) ?? 0;
		if (count > 0) remaining.set(keyOf(d), count - 1);
		else fresh.push(d);
	}
	const edited = fresh.filter((d) => d.path === editedPath);
	const others = fresh.filter((d) => d.path !== editedPath);
	return [...edited, ...others];
}

/** Cap at 5 files and 20 entries total; `undefined` when there is nothing new. */
export function formatNewDiagnostics(cwd: string, fresh: readonly DiagnosticLine[]): string | undefined {
	if (fresh.length === 0) return undefined;
	const files: string[] = [];
	const shown: DiagnosticLine[] = [];
	for (const d of fresh) {
		if (shown.length >= MAX_ENTRIES) break;
		if (!files.includes(d.path)) {
			if (files.length >= MAX_FILES) continue;
			files.push(d.path);
		}
		shown.push(d);
	}
	const lines = shown.map((d) => `ERROR ${relative(cwd, d.path) || d.path}:${d.line}:${d.column} ${d.message}`);
	if (fresh.length > shown.length) lines.push(`... ${fresh.length - shown.length} more`);
	return [`New diagnostics after this edit (${fresh.length}, vs pre-edit baseline):`, ...lines].join("\n");
}

function perCheckTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	const raw = Number(env[EDIT_DIAGNOSTICS_TIMEOUT_ENV]);
	return Number.isFinite(raw) && raw > 0 ? raw : PER_CHECK_TIMEOUT_MS;
}

interface Snapshot {
	readonly mtimeMs: number;
	readonly hash: string;
}

async function snapshotFile(absolutePath: string): Promise<Snapshot | undefined> {
	try {
		const [st, bytes] = await Promise.all([stat(absolutePath), readFile(absolutePath)]);
		return { mtimeMs: st.mtimeMs, hash: createHash("sha256").update(bytes).digest("hex") };
	} catch {
		return undefined;
	}
}

function hashMessage(message: string): string {
	return createHash("sha256").update(message).digest("hex").slice(0, 16);
}

/**
 * One edit's diagnostics session. Call `baseline()` inside the mutation queue before
 * the write, `afterWrite()` inside the queue after it, then `report()` outside it.
 */
export class EditDiagnosticsRun {
	private readonly started = Date.now();
	private readonly perCheck = perCheckTimeoutMs();
	private base: FileDiagnosticsResult | undefined;
	private baseMs = 0;
	private snap: Snapshot | undefined;

	private readonly tool: "edit" | "write";
	private readonly cwd: string;
	private readonly path: string;
	private readonly absolutePath: string;
	private readonly signal: AbortSignal | undefined;

	constructor(
		tool: "edit" | "write",
		cwd: string,
		path: string,
		absolutePath: string,
		signal: AbortSignal | undefined,
	) {
		this.tool = tool;
		this.cwd = cwd;
		this.path = path;
		this.absolutePath = absolutePath;
		this.signal = signal;
	}

	/** False for files no checker handles: skip everything at zero cost. */
	static applies(path: string): boolean {
		return languageForFile(path) !== undefined;
	}

	private budget(): number {
		return Math.min(this.perCheck, PER_EDIT_TIMEOUT_MS - (Date.now() - this.started));
	}

	private async check(): Promise<FileDiagnosticsResult> {
		const timeoutMs = this.budget();
		if (timeoutMs <= 0) return { lines: [], skipped: "edit deadline exhausted", timedOut: true };
		try {
			return await collector(this.cwd, this.path, { timeoutMs, signal: this.signal, bypassCache: true });
		} catch {
			return { lines: [], skipped: "checker failed" };
		}
	}

	/** `fileExisted === false` (write to a new file) ⇒ empty baseline, no checker run. */
	async baseline(fileExisted = true): Promise<void> {
		const t = Date.now();
		this.base = fileExisted ? await this.check() : { lines: [] };
		this.baseMs = Date.now() - t;
	}

	async afterWrite(): Promise<void> {
		this.snap = await snapshotFile(this.absolutePath);
	}

	private log(
		outcome: NewDiagnosticsDetails["outcome"],
		extra: Record<string, number | string | boolean | readonly { file: string; key: string }[]>,
	): void {
		appendRunLog(EDIT_DIAG_LOG, {
			tool: this.tool,
			path: this.path,
			language: languageForFile(this.path) ?? null,
			outcome,
			baselineMs: this.baseMs,
			totalMs: Date.now() - this.started,
			...extra,
		});
	}

	private timeout(phase: "baseline" | "post"): { text: undefined; details: NewDiagnosticsDetails } {
		appendRunLog(EDIT_DIAG_TIMEOUT_LOG, {
			tool: this.tool,
			path: this.path,
			phase,
			perCheckMs: this.perCheck,
			elapsedMs: Date.now() - this.started,
		});
		this.log("timeout", { phase });
		return {
			text: undefined,
			details: { outcome: "timeout", diagnostics: [], total: 0, skipped: `${phase} timeout` },
		};
	}

	private skip(reason: string): { text: undefined; details: NewDiagnosticsDetails } {
		this.log("skipped", { reason });
		return { text: undefined, details: { outcome: "skipped", diagnostics: [], total: 0, skipped: reason } };
	}

	/** Text to append (or undefined) plus details. Never throws. */
	async report(): Promise<{ text: string | undefined; details: NewDiagnosticsDetails }> {
		const base = this.base;
		if (!base) return this.skip("baseline unavailable");
		if (base.timedOut) return this.timeout("baseline");
		if (base.skipped) return this.skip(`baseline unavailable: ${base.skipped}`);
		const post = await this.check();
		if (post.timedOut) return this.timeout("post");
		if (post.skipped) return this.skip(post.skipped);
		const now = await snapshotFile(this.absolutePath);
		if (!this.snap || !now || now.mtimeMs !== this.snap.mtimeMs || now.hash !== this.snap.hash) {
			this.log("stale", {});
			return { text: undefined, details: { outcome: "stale", diagnostics: [], total: 0, skipped: "stale" } };
		}
		const fresh = diffNewDiagnostics(base.lines, post.lines, resolve(this.absolutePath));
		const text = formatNewDiagnostics(this.cwd, fresh);
		const files = new Set(fresh.map((d) => d.path)).size;
		this.log(fresh.length > 0 ? "reported" : "none", {
			newErrors: fresh.length,
			editedFileErrors: fresh.filter((d) => d.path === resolve(this.absolutePath)).length,
			files,
			// file + message hash so a verdict can compute the next-edit fix rate without message text.
			keys: fresh.map((d) => ({ file: d.path, key: hashMessage(d.message) })),
		});
		return {
			text,
			details: { outcome: fresh.length > 0 ? "reported" : "none", diagnostics: fresh, total: fresh.length },
		};
	}
}
