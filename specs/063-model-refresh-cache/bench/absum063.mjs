import { readdirSync, readFileSync } from "node:fs";
const dir = process.argv[2];
const load = (kind, arm) => readdirSync(dir).filter((f) => f.startsWith(`${kind}-${arm}-`)).sort().map((f) => JSON.parse(readFileSync(`${dir}/${f}`)));
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2); };
const get = (o, path) => path.split(".").reduce((x, k) => x?.[k], o);
for (const [kind, path] of [["lag", "selector.openToRendered"], ["lag", "selector.registryRefresh"], ["lag", "selector.setModelApply"], ["render", "openModel"], ["render", "selectModelFrame"]]) {
  const a = load(kind, "A"), b = load(kind, "B"); const row = {};
  for (const [arm, runs] of [["A", a], ["B", b]]) row[arm] = { procs: runs.length, p50: q(runs.map((r) => get(r, path).p50), 0.5), p90: q(runs.map((r) => get(r, path).p50), 0.9), p95: q(runs.map((r) => get(r, path).p95 ?? get(r, path).p90), 0.5), load1: [Math.min(...runs.map((r) => r.load1)), Math.max(...runs.map((r) => r.load1))] };
  const d = a.map((r, i) => get(r, path).p50 - get(b[i], path).p50);
  console.log(kind, path, JSON.stringify(row), "paired A-B p50 median", q(d, 0.5), "min", q(d, 0));
}
