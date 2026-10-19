import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// test.sh promises a run "without API keys", and scripts/release.mjs gates every release on it.
// Every provider key that getEnvApiKey reads must therefore be unset there; a key that leaks
// through turns a release into live, rate-limited provider calls made with the operator's key.
const envApiKeysSource = readFileSync(new URL("../../packages/ai/src/env-api-keys.ts", import.meta.url), "utf8");
const testScript = readFileSync(new URL("../../test.sh", import.meta.url), "utf8");

const providerKeyNames = [
	...new Set([...envApiKeysSource.matchAll(/"([A-Z][A-Z0-9_]*(?:_API_KEY|_TOKEN))"/g)].map((match) => match[1])),
].sort();
const unsetNames = new Set([...testScript.matchAll(/^unset ([A-Z][A-Z0-9_]*)$/gm)].map((match) => match[1]));

test("env-api-keys.ts still exposes provider key names to check", () => {
	assert.ok(providerKeyNames.includes("OPENAI_API_KEY"), "parser no longer finds known provider keys");
	assert.ok(providerKeyNames.length >= 20, `only ${providerKeyNames.length} provider keys found`);
});

test("test.sh unsets every provider key that getEnvApiKey reads", () => {
	const leaked = providerKeyNames.filter((name) => !unsetNames.has(name));
	assert.deepEqual(leaked, [], `test.sh does not unset: ${leaked.join(", ")}`);
});
