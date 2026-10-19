// Independent writer process: appends back-to-back until told to stop; no idle gaps.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseRunContract, parseRunStartCommand } from "omk-protocol";
import { acquireSessionOwnerLeaseSync, digestObject, journalPath, VerifiedRunJournal } from "./common.ts";
const root = process.argv[2]; const pointer = join(root, "current");
const contract = parseRunContract({ schemaVersion: "omk.verified-run.v1", profile: "linux-scripted-agent-v1", runId: "run-1", goal: "gate", workspace: { root: "/workspace", baseDigest: "a".repeat(64) }, writablePaths: ["answer"], writer: { kind: "scripted-agent", steps: [["/bin/true"]], maxRequests: 32 }, checks: [{ claimId: "answer", argv: ["/bin/true"], stdout: "" }], budget: { workMs: 1000, verifyMs: 1000, cleanupMs: 15000, maxOutputBytes: 1024, maxFiles: 10, maxBytes: 1024 }, apply: "artifact-only" });
const command = parseRunStartCommand({ schemaVersion: "omk.verified-command.v1", kind: "start", runId: contract.runId, commandId: "command-1", expectedRevision: 0, expectedGeneration: 0, contractDigest: digestObject(contract) });
let runIdx = -1, journal: any, owner: any, inRun = 0, appends = 0, maxGapMs = 0, last = Date.now();
const runDirs: string[] = [];
const newRun = () => {
	owner?.release(); runIdx++; const dir = join(root, `run-${runIdx}`); mkdirSync(dir); runDirs.push(dir);
	owner = acquireSessionOwnerLeaseSync(journalPath(dir)); journal = new VerifiedRunJournal(dir, owner);
	journal.append({ kind: "created", contract, command } as any); journal.append({ kind: "writer_opened" } as any); inRun = 0;
	writeFileSync(`${pointer}.tmp`, String(runIdx)); renameSync(`${pointer}.tmp`, pointer);
};
newRun();
let stop = false; process.on("message", (m: any) => { if (m === "stop") stop = true; });
const writerStartMs = Date.now(); process.send!({ started: writerStartMs });
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
	if (stop) { const writerStopMs = Date.now(); owner.release(); process.send!({ done: { writerStartMs, writerStopMs, appends, runs: runDirs.length, maxGapMs, err } }, () => process.exit(0)); }
	else setImmediate(tick);
};
tick();
