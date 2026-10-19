import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { peekSessionOwnerLeaseSync, readRegularFile, readRunJournal } from "./common.ts";
const [root, nStr, gapStr] = process.argv.slice(2); const n = Number(nStr); const gapUs = Number(gapStr ?? 0);
const out: unknown[] = []; const torn = new Set<string>();
const c = { tornDrops: 0, retries: 0, zeroPrefix: 0, firstReadMs: 0, lastReadMs: 0 };
const pause = new Int32Array(new SharedArrayBuffer(4));
process.send!({ ready: true });
process.on("message", () => {
	c.firstReadMs = Date.now();
	for (let i = 0; i < n; i++) {
		const run = Number(readFileSync(join(root, "current"), "utf8"));
		const runPath = join(root, `run-${run}`); const path = join(runPath, "journal.v2.jsonl");
		let pending: { end: number; len: number } | null = null; let dropped = false;
		// Seams wrap the defaults: observation only, same return values and side effects.
		const read = (p: string, max: number) => { const b = readRegularFile(p, max); const end = b.lastIndexOf(10) + 1; pending = end < b.length || end === 0 ? { end, len: b.length } : null; if (end === 0) c.zeroPrefix++; return b; };
		const ownerLive = () => { const live = peekSessionOwnerLeaseSync(path) === "live"; if (live && pending && pending.end > 0) { dropped = true; torn.add(`${run}:${pending.end}`); } return live; };
		const sleep = (ms: number) => { c.retries++; Atomics.wait(pause, 0, 0, ms); };
		try {
			const s = readRunJournal(runPath, { mode: "reader", read, ownerLive, sleep });
			if (dropped) c.tornDrops++;
			if (!s) { out.push({ o: "null", run }); continue; }
			const h = createHash("sha256"); for (const r of s.records) h.update(r.hash);
			out.push({ o: "ok", run, n: s.records.length, d: h.digest("hex") });
		} catch (e: any) { out.push({ run, o: e?.code ?? e?.name ?? "throw" }); }
		if (gapUs) Atomics.wait(pause, 0, 0, gapUs / 1000);
	}
	c.lastReadMs = Date.now();
	process.send!({ out, c, torn: [...torn] }, () => process.exit(0));
});
