import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const checker = fileURLToPath(new URL("../check-ts-relative-imports.mjs", import.meta.url));
for (const [file, expected] of [
	[".omk/external/rea/vendor.ts", 0],
	[".omk/extensions/owned.ts", 1],
	["src/owned.ts", 1],
	["src/.omk/external/owned.ts", 1],
]) {
	test(`relative import boundary: ${file}`, () => {
		const root = mkdtempSync(join(tmpdir(), "omk-import-boundary-"));
		try {
			const target = join(root, file);
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, 'import "./module.js";\n');
			const result = spawnSync(process.execPath, [checker, root], { encoding: "utf8", timeout: 15000 });
			assert.equal(result.status, expected, result.stderr);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
}
