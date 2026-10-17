import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("UPSTREAM.json", root), "utf8"));
assert.equal(manifest.repository, "https://github.com/michaelmjhhhh/pi-atelier");
assert.equal(manifest.commit, "776c1e3701d7fced2115cdef27a58ca9f0f0bf07");
assert.equal(manifest.license, "MIT");
for (const [path, hashes] of Object.entries(manifest.files)) {
	assert.match(path, /^(?:src\/[a-z-]+\.ts|extensions\/index\.ts|LICENSE|UPSTREAM\.md)$/);
	const digest = createHash("sha256").update(readFileSync(new URL(`vendor/${path}`, root))).digest("hex");
	assert.equal(digest, hashes.localSha256, `Vendor drift: ${path}`);
}
assert.match(readFileSync(new URL("vendor/LICENSE", root), "utf8"), /Copyright \(c\) 2026 Michael/);
console.log(`Verified ${Object.keys(manifest.files).length} pinned runtime files at ${fileURLToPath(root)}`);
