// Independent writer process: appends back-to-back until told to stop; no idle gaps.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseRunContract, parseRunStartCommand } from "omk-protocol";
import { appendFileSync, closeSync, fsyncSync, openSync } from "node:fs";
import { IMPL, lib } from "./impl.ts";
const { acquireSessionOwnerLeaseSync, digestObject, journalPath, VerifiedRunJournal } = lib;
// GATE_WRITER=chunked: GATE-ONLY writer, NOT the product writer. It is passed through the journal's
// `persist` seam and writes each record in pieces with 1 ms between them, so readers can see torn
// tails. GATE_WRITER=product (default) uses the product's appendFileDurablySync.
const MODE = process.env.GATE_WRITER === "chunked" ? "chunked" : "product";
const pause = new Int32Array(new SharedArrayBuffer(4));
const chunkedPersist = (path: string, bytes: Uint8Array) => {
	const pieces = 4, size = Math.ceil(bytes.length / pieces);
	for (let i = 0; i < bytes.length; i += size) {
		appendFileSync(path, bytes.subarray(i, i + size));
		if (i + size < bytes.length) Atomics.wait(pause, 0, 0, 1);
	}
	const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
};
const root = process.argv[2]; const pointer = join(root, "current");
const contract = parseRunContract({ schemaVersion: "omk.verified-run.v1", profile: "linux-scripted-agent-v1", runId: "run-1", goal: "gate", workspace: { root: "/workspace", baseDigest: "a".repeat(64) }, writablePaths: ["answer"], writer: { kind: "scripted-agent", steps: [["/bin/true"]], maxRequests: 32 }, checks: [{ claimId: "answer", argv: ["/bin/true"], stdout: "" }], budget: { workMs: 1000, verifyMs: 1000, cleanupMs: 15000, maxOutputBytes: 1024, maxFiles: 10, maxBytes: 1024 }, apply: "artifact-only" });
const command = parseRunStartCommand({ schemaVersion: "omk.verified-command.v1", kind: "start", runId: contract.runId, commandId: "command-1", expectedRevision: 0, expectedGeneration: 0, contractDigest: digestObject(contract) });
let runIdx = -1, journal: any, owner: any, inRun = 0, appends = 0, maxGapMs = 0, last = Date.now();
const runDirs: string[] = [];
const newRun = () => {
	owner?.release(); runIdx++; const dir = join(root, `run-${runIdx}`); mkdirSync(dir); runDirs.push(dir);
	owner = acquireSessionOwnerLeaseSync(journalPath(dir)); journal = (MODE === "chunked" ? new VerifiedRunJournal(dir, owner, chunkedPersist) : new VerifiedRunJournal(dir, owner));
	journal.append({ kind: "created", contract, command } as any); journal.append({ kind: "writer_opened" } as any); inRun = 0;
	writeFileSync(`${pointer}.tmp`, String(runIdx)); renameSync(`${pointer}.tmp`, pointer);
};
newRun();
let stop = false; process.on("message", (m: any) => { if (m === "stop") stop = true; });
const writerStartMs = Date.now(); process.send!({ started: writerStartMs, mode: MODE, impl: IMPL });
let err: string | null = null;
const tick = () => {
	const until = Date.now() + 20; // burst of back-to-back appends, then yield briefly only to receive "stop"
	try {
		while (Date.now() < until) {
			if (inRun === 32) { journal.append({ kind: "failed", code: "load-done" } as any); newRun(); }
			else { journal.append({ kind: "model_request", requestId: `r-${inRun}` } as any); inRun++; }
			appends++; const t = Date.now(); maxGapMs = Math.max(maxGapMs, t - last); last = t;
		}
	} catch (e: any) { err = String(e?.code ?? e?.name ?? "error"); stop = true; }
	if (stop) { const writerStopMs = Date.now(); owner.release(); process.send!({ done: { writerStartMs, writerStopMs, mode: MODE, impl: IMPL, appends, runs: runDirs.length, maxGapMs, err } }, () => process.exit(0)); }
	else setImmediate(tick);
};
tick();
