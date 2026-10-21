/**
 * Spec 098: keep the raw output of a failing acceptance check on disk and point the model at it,
 * so it reads ranges with `read` instead of re-running the check to see output.
 *
 * Behind `OMK_GOAL_OUTPUT_RECALL=1` (default off). The artifact is diagnostic only: completion and
 * evidence still come from the receipt. Nothing is redacted, and the trace keeps only a digest and counts.
 */
import { createHash } from "node:crypto";
import {
	chmodSync,
	closeSync,
	ftruncateSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { sessionArtifactDir } from "./session-artifacts.ts";
import { defaultTempFilePath } from "./tools/output-accumulator.ts";
import { formatSize } from "./tools/truncate.ts";

export const OUTPUT_RECALL_MAX_BYTES = 4 * 1024 * 1024;
export const OUTPUT_RECALL_HEAD_BYTES = 1024 * 1024;
export const OUTPUT_RECALL_TAIL_BYTES = OUTPUT_RECALL_MAX_BYTES - OUTPUT_RECALL_HEAD_BYTES;
export const OUTPUT_RECALL_PER_GOAL = 3;
export const OUTPUT_RECALL_PER_DIR = 20;
const TEMP_PREFIX = "omk-accept";
const TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const HINT_CHARS = 1_500;

export function goalOutputRecallEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.OMK_GOAL_OUTPUT_RECALL === "1";
}

/** What a session entry may record about an artifact: a digest and counts, never output text. */
export interface OutputArtifactSummary {
	readonly sha256: string;
	readonly bytes: number;
	readonly lines: number;
	readonly complete: boolean;
	readonly elidedBytes: number;
}

export interface OutputArtifact extends OutputArtifactSummary {
	/** Relative to cwd in session mode; absolute in temp mode. */
	readonly displayPath: string;
}

export interface OutputArtifactTarget {
	readonly sessionFile: string | undefined;
	readonly cwd: string;
	readonly goalId: string;
	readonly round: number;
	readonly revision: number;
	readonly now?: () => number;
}

const tempFiles = new Set<string>();
const tempByGoal = new Map<string, string[]>();
let exitHookInstalled = false;

function removeQuietly(path: string): void {
	try {
		rmSync(path, { force: true });
	} catch {
		// Best effort: cleanup must never fail the check.
	}
}

function installExitHook(): void {
	if (exitHookInstalled) return;
	exitHookInstalled = true;
	process.once("exit", () => {
		for (const file of tempFiles) removeQuietly(file);
	});
}

function sweepStaleTemp(now: number): void {
	try {
		const dir = tmpdir();
		for (const name of readdirSync(dir)) {
			if (!name.startsWith(`${TEMP_PREFIX}-`) || !name.endsWith(".log")) continue;
			const file = join(dir, name);
			if (now - statSync(file).mtimeMs > TEMP_MAX_AGE_MS) removeQuietly(file);
		}
	} catch {
		// A temp dir we cannot list is not ours to clean.
	}
}

function safeName(text: string): string {
	return text.replace(/[^a-zA-Z0-9_-]/gu, "_");
}

/** Oldest first by mtime; keep the newest `keep`. */
function keepNewest(files: readonly string[], keep: number): void {
	const dated = files.flatMap((file) => {
		try {
			return [{ file, mtime: statSync(file).mtimeMs }];
		} catch {
			return [];
		}
	});
	dated.sort((a, b) => a.mtime - b.mtime || a.file.localeCompare(b.file));
	for (const { file } of dated.slice(0, Math.max(0, dated.length - keep))) removeQuietly(file);
}

function enforceSessionCaps(dir: string, goalPrefix: string): void {
	const all = readdirSync(dir)
		.filter((name) => name.startsWith("acceptance-") && name.endsWith(".log"))
		.map((name) => join(dir, name));
	keepNewest(
		all.filter((file) => basename(file).startsWith(goalPrefix)),
		OUTPUT_RECALL_PER_GOAL,
	);
	// Files the per-goal pass removed are skipped (stat fails).
	keepNewest(all, OUTPUT_RECALL_PER_DIR);
}

function enforceTempCaps(goalId: string, file: string): void {
	const list = [...(tempByGoal.get(goalId) ?? []).filter((path) => path !== file), file];
	while (list.length > OUTPUT_RECALL_PER_GOAL) {
		const old = list.shift();
		if (old !== undefined) {
			removeQuietly(old);
			tempFiles.delete(old);
		}
	}
	tempByGoal.set(goalId, list);
}

function countLines(bytes: Buffer): number {
	if (bytes.byteLength === 0) return 0;
	let lines = 0;
	for (const byte of bytes) if (byte === 0x0a) lines += 1;
	return bytes[bytes.byteLength - 1] === 0x0a ? lines : lines + 1;
}

/**
 * Streams one check's combined output to a 0600 file. Up to 4 MiB it is the output itself; beyond,
 * the first 1 MiB and the last 3 MiB around one `[omk: N bytes elided]` line.
 */
export class OutputArtifactWriter {
	private readonly file: string;
	private readonly displayPath: string;
	private readonly target: OutputArtifactTarget;
	private readonly sessionDir: string | undefined;
	private fd: number | undefined;
	private total = 0;
	private tail: Buffer[] = [];
	private tailBytes = 0;

	private constructor(file: string, displayPath: string, target: OutputArtifactTarget, sessionDir?: string) {
		this.file = file;
		this.displayPath = displayPath;
		this.target = target;
		this.sessionDir = sessionDir;
		this.fd = openSync(file, "wx", 0o600);
		chmodSync(file, 0o600);
	}

	/** Undefined when the file cannot be created; the caller then keeps the `main` follow-up. */
	static open(target: OutputArtifactTarget): OutputArtifactWriter | undefined {
		try {
			if (!target.sessionFile) {
				sweepStaleTemp((target.now ?? Date.now)());
				const file = defaultTempFilePath(TEMP_PREFIX);
				const writer = new OutputArtifactWriter(file, file, target);
				tempFiles.add(file);
				installExitHook();
				return writer;
			}
			const dir = sessionArtifactDir(target.sessionFile);
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			chmodSync(dir, 0o700);
			const name = `acceptance-${safeName(target.goalId)}-${target.round}-${target.revision}.log`;
			const file = join(dir, name);
			// A re-run in the same round and revision replaces the earlier output.
			removeQuietly(file);
			return new OutputArtifactWriter(file, relative(target.cwd, file), target, dir);
		} catch {
			return undefined;
		}
	}

	write(data: Buffer): void {
		if (this.fd === undefined) return;
		try {
			if (this.total + data.byteLength <= OUTPUT_RECALL_MAX_BYTES) writeSync(this.fd, data);
			else if (this.total < OUTPUT_RECALL_MAX_BYTES)
				writeSync(this.fd, data.subarray(0, OUTPUT_RECALL_MAX_BYTES - this.total));
			this.total += data.byteLength;
			this.pushTail(data);
		} catch {
			this.discard();
		}
	}

	private pushTail(data: Buffer): void {
		this.tail.push(data);
		this.tailBytes += data.byteLength;
		while (this.tail.length > 1 && this.tailBytes - (this.tail[0]?.byteLength ?? 0) >= OUTPUT_RECALL_TAIL_BYTES) {
			this.tailBytes -= this.tail.shift()?.byteLength ?? 0;
		}
	}

	/** Abort or runner error: delete the partial file and give no reference. */
	discard(): void {
		if (this.fd !== undefined) {
			try {
				closeSync(this.fd);
			} catch {
				// already closed
			}
			this.fd = undefined;
		}
		removeQuietly(this.file);
		tempFiles.delete(this.file);
	}

	finish(): OutputArtifact | undefined {
		const fd = this.fd;
		if (fd === undefined) return undefined;
		try {
			let elidedBytes = 0;
			if (this.total > OUTPUT_RECALL_MAX_BYTES) {
				elidedBytes = this.total - OUTPUT_RECALL_MAX_BYTES;
				ftruncateSync(fd, OUTPUT_RECALL_HEAD_BYTES);
				const tail = Buffer.concat(this.tail).subarray(-OUTPUT_RECALL_TAIL_BYTES);
				const marker = Buffer.from(`\n[omk: ${elidedBytes} bytes elided]\n`);
				// Positional writes: ftruncate does not move the fd offset.
				writeSync(fd, marker, 0, marker.byteLength, OUTPUT_RECALL_HEAD_BYTES);
				writeSync(fd, tail, 0, tail.byteLength, OUTPUT_RECALL_HEAD_BYTES + marker.byteLength);
			}
			closeSync(fd);
			this.fd = undefined;
			this.tail = [];
			const content = readFileSync(this.file);
			if (this.sessionDir !== undefined)
				enforceSessionCaps(this.sessionDir, `acceptance-${safeName(this.target.goalId)}-`);
			else enforceTempCaps(this.target.goalId, this.file);
			return {
				displayPath: this.displayPath,
				sha256: createHash("sha256").update(content).digest("hex"),
				bytes: content.byteLength,
				lines: countLines(content),
				complete: elidedBytes === 0,
				elidedBytes,
			};
		} catch {
			this.discard();
			return undefined;
		}
	}
}

export function summarizeArtifact(artifact: OutputArtifact): OutputArtifactSummary {
	const { sha256, bytes, lines, complete, elidedBytes } = artifact;
	return { sha256, bytes, lines, complete, elidedBytes };
}

/** The flag-on follow-up. `head` is the main text up to and including the receipt label. */
export function outputRecallFollowUp(head: string, outputTail: string, artifact: OutputArtifact): string {
	const hint = outputTail.slice(-HINT_CHARS).trim();
	const completeness = artifact.complete ? "complete" : `middle elided ${artifact.elidedBytes} bytes`;
	return [
		`${head}.`,
		...(hint.length > 0 ? ["Diagnostic hint (may be incomplete):", hint] : []),
		`Full output: ${artifact.displayPath} (${artifact.lines} lines, ${formatSize(artifact.bytes)}; ${completeness})`,
		"Read ranges with read(path, offset, limit) instead of re-running the check to see output.",
		"Fix the cause, then end your turn; the check re-runs automatically.",
	].join("\n");
}
