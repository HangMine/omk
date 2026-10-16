import { readFileSync } from "node:fs";
const p = JSON.parse(readFileSync(process.argv[2])); const byId = new Map(p.nodes.map((n) => [n.id, n]));
const dt = new Map(); for (let i = 0; i < p.samples.length; i++) dt.set(p.samples[i], (dt.get(p.samples[i]) ?? 0) + (p.timeDeltas[i] ?? 0));
const parent = new Map(); for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const self = new Map(), total = new Map();
for (const [id, t] of dt) { const n = byId.get(id); const k = `${n.callFrame.functionName || "(anon)"} ${n.callFrame.url.split("/packages/").pop()}:${n.callFrame.lineNumber + 1}`;
  self.set(k, (self.get(k) ?? 0) + t); const seen = new Set(); let cur = id;
  while (cur !== undefined) { const c = byId.get(cur); const kk = `${c.callFrame.functionName || "(anon)"} ${c.callFrame.url.split("/packages/").pop()}:${c.callFrame.lineNumber + 1}`;
    if (!seen.has(kk)) { seen.add(kk); total.set(kk, (total.get(kk) ?? 0) + t); } cur = parent.get(cur); } }
const show = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).forEach(([k, v]) => console.log((v / 1000).toFixed(0).padStart(7), "ms", k));
console.log("== self"); show(self, 25); console.log("== total (filter coding-agent|agent|ai)"); show(new Map([...total].filter(([k]) => /coding-agent|agent\/dist|ai\/dist/.test(k))), 45);
