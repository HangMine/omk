import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { copyAssets } from "../../packages/coding-agent/scripts/copy-assets.mjs";

function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), "omk-assets-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const pkg = join(root, "packages", "coding-agent");
	const files = [
		"src/modes/interactive/theme/dark.json", "src/modes/interactive/theme/light.json",
		"src/modes/interactive/assets/image-{literal}.png", "src/core/export-html/template.html",
		"src/core/export-html/template.css", "src/core/export-html/template.js", "src/core/export-html/vendor/lib.js",
		"package.json", "README.md", "CHANGELOG.md", "docs/usage.md", "examples/extension.ts",
		"resources/neo/skills/omk-fixture/SKILL.md", "resources/.retained",
		"../../node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm",
	];
	for (const file of files) {
		const path = join(pkg, file);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `asset:${file}`);
	}
	return pkg;
}

function same(pkg, source, dest) {
	assert.deepEqual(readFileSync(join(pkg, source)), readFileSync(join(pkg, "dist", dest)));
}

test("source build copies exact themes, literal filenames and HTML assets", (t) => {
	const pkg = fixture(t);
	copyAssets(pkg);
	for (const name of ["dark.json", "light.json"]) same(pkg, `src/modes/interactive/theme/${name}`, `modes/interactive/theme/${name}`);
	same(pkg, "src/modes/interactive/assets/image-{literal}.png", "modes/interactive/assets/image-{literal}.png");
	for (const ext of ["html", "css", "js"]) same(pkg, `src/core/export-html/template.${ext}`, `core/export-html/template.${ext}`);
	same(pkg, "src/core/export-html/vendor/lib.js", "core/export-html/vendor/lib.js");
	assert.deepEqual(readdirSync(join(pkg, "dist")).sort(), ["core", "modes"]);
});

test("binary build preserves all public resource directories, WASM and destination layout", (t) => {
	const pkg = fixture(t);
	copyAssets(pkg, true);
	for (const name of ["package.json", "README.md", "CHANGELOG.md", "docs/usage.md", "examples/extension.ts", "resources/neo/skills/omk-fixture/SKILL.md", "resources/.retained"]) same(pkg, name, name);
	same(pkg, "../../node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm", "photon_rs_bg.wasm");
	same(pkg, "src/modes/interactive/theme/dark.json", "theme/dark.json");
	same(pkg, "src/modes/interactive/assets/image-{literal}.png", "assets/image-{literal}.png");
	same(pkg, "src/core/export-html/template.html", "export-html/template.html");
	same(pkg, "src/core/export-html/vendor/lib.js", "export-html/vendor/lib.js");
});

test("missing required assets fail rather than silently shipping incomplete output", (t) => {
	const pkg = fixture(t);
	rmSync(join(pkg, "src/modes/interactive/assets/image-{literal}.png"));
	assert.throws(() => copyAssets(pkg), /No .png assets/);
});
