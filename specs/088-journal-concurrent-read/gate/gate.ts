import { execSync, fork } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { readRunJournal } from "./common.ts";
const READERS = 8, TOTAL = Number(process.env.GATE_TOTAL ?? 30000), PER = TOTAL / READERS, GAP_US = Number(process.env.GATE_READ_GAP_US ?? 0);
const root = mkdtempSync(join(tmpdir(), "omk088-gate-"));
const fsType = execSync(`stat -f -c %T ${root}`).toString().trim();
const ex = ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"];
const load1Start = loadavg()[0], t0 = Date.now();
const writer = fork(join(import.meta.dirname, "writer.ts"), [root], { execArgv: ex });
await new Promise((r) => writer.once("message", r)); // writer appending before any reader exists
const writerDone = new Promise<any>((r) => writer.on("message", (m: any) => m.done && r(m.done)));
const kids = Array.from({ length: READERS }, () => fork(join(import.meta.dirname, "reader.ts"), [root, String(PER), String(GAP_US)], { execArgv: ex }));
let ready = 0; await new Promise<void>((res) => kids.forEach((k) => k.once("message", () => { if (++ready === READERS) res(); })));
const results = await Promise.all(kids.map((k) => { const p = new Promise<any>((res) => k.on("message", (m: any) => m.out && res(m))); k.send("go"); return p; }));
writer.send("stop"); const w = await writerDone;
const runs = readdirSync(root).filter((d) => d.startsWith("run-")).length;
const finals = Array.from({ length: runs }, (_, i) => readRunJournal(join(root, `run-${i}`))!);
const cache = new Map<string, string>(); const counts: Record<string, number> = {}; const examples: Record<string, unknown> = {};
for (const r of results.flatMap((x) => x.out)) {
	let k = r.o;
	if (k === "ok") { const key = `${r.run}:${r.n}`; if (!cache.has(key)) { const x = createHash("sha256"); for (const rec of finals[r.run].records.slice(0, r.n)) x.update(rec.hash); cache.set(key, x.digest("hex")); } if (cache.get(key) !== r.d) k = "non_prefix"; }
	counts[k] = (counts[k] ?? 0) + 1; if (k !== "ok" && !examples[k]) examples[k] = r;
}
const sum = (f: string) => results.reduce((a, x) => a + x.c[f], 0);
const firstRead = Math.min(...results.map((x) => x.c.firstReadMs)), lastRead = Math.max(...results.map((x) => x.c.lastReadMs));
const tornDrops = sum("tornDrops"), distinct = new Set(results.flatMap((x) => x.torn)).size;
const failures = (counts.integrity ?? 0) + (counts.non_prefix ?? 0) + (counts.concurrent_change ?? 0) + (counts.journal_truncated ?? 0) + Object.keys(counts).filter((k) => !["ok", "integrity", "non_prefix", "concurrent_change", "journal_truncated"].includes(k)).reduce((a, k) => a + counts[k], 0);
const validA = w.writerStartMs <= firstRead && w.writerStopMs >= lastRead && !w.err, validB = tornDrops >= 300;
const rec = {
	head: execSync(`git -C ${import.meta.dirname} rev-parse HEAD`).toString().trim(), wallMs: Date.now() - t0, load1Start, load1End: loadavg()[0], fsType, readGapUs: GAP_US,
	writer: w, firstReadMs: firstRead, lastReadMs: lastRead,
	attemptsPerReader: results.map((x) => x.out.length), totalAttempts: results.reduce((a, x) => a + x.out.length, 0), finalRecordsTotal: finals.reduce((a, f) => a + f.records.length, 0),
	counts, falseJournalTruncatedUnderLiveLease: counts.journal_truncated ?? 0, failures, examples,
	reportOnly: { tornDrops, distinctTornTails: distinct, concurrentChangeRetries: sum("retries"), zeroBytePrefixEncounters: sum("zeroPrefix") },
	validity: { a_writerCoversReaders: validA, b_tornDropsAtLeast300: validB },
	verdict: !(validA && validB) ? "INVALID" : failures === 0 ? "PASS" : "FAIL",
	upperBound95: failures === 0 ? { perAttempt: 3 / TOTAL, perTornDrop: tornDrops ? 3 / tornDrops : null, perDistinctTail: distinct ? 3 / distinct : null } : null,
};
console.log(JSON.stringify(rec, null, 1));
