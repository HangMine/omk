// spec 046: first call of formatHeadroomStatusLabel() in a fresh process.
// usage (from repo root): node_modules/.bin/tsx specs/046-headroom-probe-off-render/bench/first-label.mts <module.ts> <arm>
// Prints one TSV row: arm, first_label_ms, probe_settled_ms (branch only), version, label
import { resolve } from "node:path";

const [modPath, arm] = process.argv.slice(2);
const mod = await import(resolve(modPath));
const t0 = performance.now();
const label = mod.formatHeadroomStatusLabel();
const t1 = performance.now();
let settled = "";
let version = "";
if (mod.loadHeadroomVersion) {
	version = String(await mod.loadHeadroomVersion());
	settled = (performance.now() - t0).toFixed(1);
}
console.log([arm, (t1 - t0).toFixed(2), settled, version, label].join("\t"));
