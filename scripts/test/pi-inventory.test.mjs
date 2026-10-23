import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const SCRIPT = new URL("../pi-inventory.mjs", import.meta.url).pathname;
const FIX = new URL("./fixtures/pi-inventory/", import.meta.url).pathname;

// Strip GIT_* (set by git hooks) so the temp repo never touches the real index.
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));

function setup() {
	const root = mkdtempSync(join(tmpdir(), "pi-inv-"));
	mkdirSync(join(root, "src"));
	for (const f of readdirSync(FIX).filter((f) => f.endsWith(".txt"))) cpSync(join(FIX, f), join(root, "src", f.slice(0, -4)));
	const git = (...a) => execFileSync("git", ["-C", root, ...a], { env: cleanEnv });
	git("init", "-q");
	git("add", ".");
	const out = join(root, "inv.json");
	const run = (...a) => spawnSync(process.execPath, [SCRIPT, ...a], { env: { ...cleanEnv, PI_INVENTORY_ROOT: root, PI_INVENTORY_OUT: out }, encoding: "utf8" });
	return { root, out, run };
}

test("pi-inventory catches static, type-only, dynamic, require and re-export", () => {
	const { root, out, run } = setup();
	try {
		assert.equal(run().status, 0);
		const inv = JSON.parse(readFileSync(out, "utf8"));
		const got = inv.imports.map((i) => `${i.kind} ${i.specifier}`).sort();
		assert.deepEqual(got, [
			"dynamic @earendil-works/pi-tui",
			"re-export @oh-my-pi/pi-coding-agent",
			"require @mariozechner/clipboard",
			"static @mariozechner/pi-agent-core",
			"type-only @mariozechner/pi-ai",
		]);
		assert.equal(run("--check").status, 0);
		// drop one expected entry -> --check must fail
		inv.imports.pop();
		writeFileSync(out, JSON.stringify(inv, null, "\t") + "\n");
		const r = run("--check");
		assert.equal(r.status, 1);
		assert.match(r.stderr, /differs/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
