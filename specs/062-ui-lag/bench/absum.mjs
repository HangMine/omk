import { readdirSync, readFileSync } from "node:fs";
const [dir, size] = process.argv.slice(2);
const load = (arm) => readdirSync(dir).filter((f) => f.startsWith(`${arm}-${size}-`)).map((f) => JSON.parse(readFileSync(`${dir}/${f}`)));
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2); };
for (const key of ["enterToRequest", "preflightToRunAgentPrompt"]) {
  const row = {};
  for (const arm of ["A", "B"]) { const runs = load(arm); const p50s = runs.map((r) => r[key].p50); row[arm] = { procs: runs.length, p50_of_p50: q(p50s, 0.5), p90_of_p50: q(p50s, 0.9), p95_of_p95: q(runs.map((r) => r[key].p95 ?? r[key].p90), 0.5), load1: [Math.min(...runs.map((r) => r.load1)), Math.max(...runs.map((r) => r.load1))] }; }
  const a = load("A"), b = load("B"); const diffs = a.map((r, i) => r[key].p50 - (b[i]?.[key].p50 ?? NaN)).filter(Number.isFinite);
  console.log(size, key, JSON.stringify(row), "paired p50 diff A-B median", q(diffs, 0.5), "min", q(diffs, 0), "max", q(diffs, 0.999));
}
