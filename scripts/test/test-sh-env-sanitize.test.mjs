import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// test.sh must hand `npm test` an environment with no credential-shaped variable. This runs the
// same sanitizing step test.sh sources, with dummy values only, and inspects the child env.
const root = fileURLToPath(new URL("../..", import.meta.url));
const sanitizer = fileURLToPath(new URL("../test-env-sanitize.sh", import.meta.url));
const testScript = readFileSync(new URL("../../test.sh", import.meta.url), "utf8");

const named = [
	"ADAPTORCH_API_KEY",
	"AZURE_API_KEY",
	"CONTEXT7_API_KEY",
	"EXA_API_KEY",
	"FIRECRAWL_API_KEY",
	"FIRECRAWL_OAUTH_TOKEN",
	"GOOGLE_API_KEY",
	"KOREAN_LAW_API_KEY",
];
const dummies = ["FOO_API_KEY", "BAR_TOKEN", "lower_secret_value", "DB_PASSWORD"];
const extra = ["AWS_ACCESS_KEY_ID", "GOOGLE_APPLICATION_CREDENTIALS", "AWS_PROFILE", "AZURE_OPENAI_ENDPOINT"];
const pattern = /KEY|SECRET|TOKEN|PASSWORD/i;

function allowlist() {
	const match = readFileSync(sanitizer, "utf8").match(/^TEST_SH_ENV_ALLOWLIST=\(([^)]*)\)/m);
	assert.ok(match, "TEST_SH_ENV_ALLOWLIST not found");
	return new Set(match[1].split(/\s+/).filter(Boolean));
}

test("test.sh sources the env sanitizer before npm test", () => {
	const source = testScript.indexOf("scripts/test-env-sanitize.sh\"");
	assert.ok(source >= 0 && existsSync(sanitizer), "test.sh does not source scripts/test-env-sanitize.sh");
	assert.ok(source < testScript.indexOf("npm test"), "sanitizer runs after npm test");
});

test("sanitized child env has no credential-shaped name outside the allowlist", () => {
	assert.ok(existsSync(sanitizer), "scripts/test-env-sanitize.sh is missing");
	const env = { PATH: process.env.PATH, HOME: process.env.HOME ?? "/tmp" };
	for (const name of [...named, ...dummies, ...extra]) env[name] = "dummy-not-a-secret";
	const child = spawnSync("bash", ["-c", `. "${sanitizer}"; env -0`], { cwd: root, env, encoding: "utf8" });
	assert.equal(child.status, 0, child.stderr);
	const names = child.stdout.split("\0").filter(Boolean).map((entry) => entry.slice(0, entry.indexOf("=")));
	const allowed = allowlist();
	const leaked = names.filter((name) => (pattern.test(name) || extra.includes(name)) && !allowed.has(name));
	assert.deepEqual(leaked, [], `sanitized env still has: ${leaked.join(", ")}`);
});
