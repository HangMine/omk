import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "../..");
const lock = JSON.parse(readFileSync(resolve(root, "package-lock.json"), "utf8"));
const packages = ["ai", "agent", "protocol", "coding-agent", "adaptorch-wpl", "book-to-skill"];

function atLeast(version, floor) {
	const actual = version.split(".").map(Number);
	assert.equal(actual.length, 3, `Expected a stable version: ${version}`);
	assert.ok(actual.every(Number.isInteger), `Expected a stable version: ${version}`);
	for (let i = 0; i < 3; i++) {
		if (actual[i] !== floor[i]) return actual[i] > floor[i];
	}
	return true;
}

test("locked Vitest and mocker versions include the supported security fixes", () => {
	for (const name of ["vitest", "@vitest/mocker"]) {
		const rows = Object.entries(lock.packages).filter(
			([path]) => path.endsWith(`/node_modules/${name}`) || path === `node_modules/${name}`,
		);
		assert.ok(rows.length > 0, `${name} must be in the lockfile`);
		for (const [path, entry] of rows) {
			assert.ok(atLeast(entry.version, [4, 1, 11]), `${path}: vulnerable ${name} ${entry.version}`);
		}
	}
});

test("no locked tinypool version retains the prototype-pollution worker gadgets", () => {
	for (const [path, entry] of Object.entries(lock.packages)) {
		if (path.endsWith("/node_modules/tinypool") || path === "node_modules/tinypool") {
			assert.ok(atLeast(entry.version, [2, 1, 2]), `${path}: vulnerable tinypool ${entry.version}`);
		}
	}
});

test("root Vitest peer resolution for Stryker cannot retain an old major", () => {
	const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
	assert.ok(atLeast(pkg.devDependencies.vitest, [4, 1, 11]));
	assert.equal(pkg.devDependencies["@vitest/coverage-v8"], pkg.devDependencies.vitest);
});
test("all workspace Vitest pins are patched and coverage versions stay aligned", () => {
	for (const name of packages) {
		const pkg = JSON.parse(readFileSync(resolve(root, "packages", name, "package.json"), "utf8"));
		const version = pkg.devDependencies.vitest;
		assert.ok(atLeast(version, [4, 1, 11]), `${name}: vulnerable Vitest pin ${version}`);
		const coverage = pkg.devDependencies["@vitest/coverage-v8"];
		if (coverage !== undefined) assert.equal(coverage, version, `${name}: coverage/Vitest mismatch`);
	}
});


test("file-only build tasks no longer pull in the vulnerable braces toolchain", () => {
	for (const name of ["shx", "shelljs", "fast-glob", "micromatch", "braces"]) {
		assert.ok(!Object.keys(lock.packages).some((path) => path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`)), `${name} remains in the build dependency graph`);
	}
});

test("source-map-js lock entries include the offset validation patch", () => {
	for (const [path, entry] of Object.entries(lock.packages)) {
		if (path === "node_modules/source-map-js" || path.endsWith("/node_modules/source-map-js")) {
			assert.ok(atLeast(entry.version, [1, 2, 2]), `${path}: vulnerable source-map-js ${entry.version}`);
		}
	}
});


test("shell-quote lock entries include the comment token injection fix", () => {
	for (const [path, entry] of Object.entries(lock.packages)) {
		if (path === "node_modules/shell-quote" || path.endsWith("/node_modules/shell-quote")) {
			assert.ok(atLeast(entry.version, [1, 11, 0]), `${path}: vulnerable shell-quote ${entry.version}`);
		}
	}
});
