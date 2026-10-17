#!/usr/bin/env node
// Spec 071 loop-guard fixture: a scripted worker in `--mode json`. The task text picks the
// trajectory ("<scenario>:<seed>"). It plays the model and the tools, and reports realistic
// usage: input = tokens of the whole prompt it received so far, output = tokens it emitted.
import { appendFileSync, readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const taskArg = argv[argv.length - 1] ?? "";
// The runtime wraps the task in its execution contract, so find "<scenario>:<seed>" anywhere in it.
const match = /\b(identical|same-error|ping-pong|self-spawn|no-progress|normal):(\d+)\b/.exec(taskArg);
const scenario = match?.[1];
const seed = Number.parseInt(match?.[2] ?? "0", 10);
const promptIndex = argv.indexOf("--append-system-prompt");
const systemPrompt = promptIndex === -1 ? "" : readFileSync(argv[promptIndex + 1], "utf8");
const MAX_TURNS = 60;

// Spec 071 flag-off check: record the first request exactly as this fake model received it.
if (process.env.OMK_FAKE_REQUEST_FILE) {
	const env = Object.fromEntries(
		Object.entries(process.env)
			.filter(([key]) => key.startsWith("OMK_") && key !== "OMK_FAKE_REQUEST_FILE")
			.sort(([a], [b]) => (a < b ? -1 : 1)),
	);
	appendFileSync(process.env.OMK_FAKE_REQUEST_FILE, `${JSON.stringify({ argv, systemPrompt, env })}\n`);
}

let contextChars = systemPrompt.length + taskArg.length;
let callId = 0;
const tokens = (chars) => Math.ceil(chars / 4);
const emit = (message) => process.stdout.write(`${JSON.stringify({ type: "message_end", message })}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assistant(content, stopReason) {
	const outputChars = JSON.stringify(content).length;
	const input = tokens(contextChars);
	const output = tokens(outputChars);
	contextChars += outputChars;
	emit({
		role: "assistant",
		content,
		api: "fake",
		provider: "fixture-provider",
		model: "fixture-model",
		usage: {
			input,
			output,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: input + output,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	});
}

async function turn(name, args, output, isError = false) {
	const id = `call-${callId++}`;
	assistant([{ type: "toolCall", id, name, arguments: args }], "toolUse");
	await sleep(1);
	contextChars += output.length;
	emit({
		role: "toolResult",
		toolCallId: id,
		toolName: name,
		content: [{ type: "text", text: output }],
		isError,
		timestamp: Date.now(),
	});
	await sleep(1);
}

const loops = {
	identical: () => ["bash", { command: `ls src/dir${seed}` }, `a.ts\nb.ts\nseed ${seed}`],
	"same-error": (i) => ["bash", { command: `npm run t${seed}-${i}` }, `Error: Cannot find module 'mod${seed}'`, true],
	"ping-pong": (i) => [
		"read",
		{ path: i % 2 ? `b${seed}.ts` : `a${seed}.ts` },
		i % 2 ? `export const b = ${seed};` : `export const a = ${seed};`,
	],
	"self-spawn": () => ["subagent", { agent: "worker", task: `again ${seed}` }, "Tool subagent not found", true],
	"no-progress": (i) => {
		const k = i % 3;
		return ["grep", { pattern: `TODO${seed}`, path: `pkg${k}` }, `pkg${k}/x.ts:${seed}: TODO${seed}`];
	},
};

// 10 realistic families x seed; none is a loop. Outputs change whenever the world changed.
function normal() {
	const file = `src/mod${seed}.ts`;
	const base = [
		["read", { path: "AGENTS.md" }, `# rules ${seed}\nrun npm test`],
		["grep", { pattern: `fn${seed}`, path: "src" }, `${file}:3: export function fn${seed}() {}`],
		["read", { path: file }, `export function fn${seed}() {\n\treturn ${seed};\n}`],
	];
	const fix = [
		["bash", { command: `npm test -- mod${seed}` }, `FAIL mod${seed}.test.ts\n1 failing`, true],
		["edit", { path: file, oldText: `return ${seed};`, newText: `return ${seed + 1};` }, `Edited ${file}`],
		["bash", { command: `npm test -- mod${seed}` }, `PASS mod${seed}.test.ts\n3 passing`],
	];
	const families = [
		// 0: plain fix, then re-read the edited file (same read, new content)
		() => [...base, ...fix, ["read", { path: file }, `export function fn${seed}() {\n\treturn ${seed + 1};\n}`]],
		// 1: polling a build with the same command and changing output
		() => [
			...base,
			...["queued", "in_progress 20%", "in_progress 60%", "in_progress 90%", `completed ${seed}`].map((status) => [
				"bash",
				{ command: `gh run view ${1000 + seed} --json status` },
				status,
			]),
		],
		// 2: retries with changing errors until a fix lands
		() => [
			...base,
			["bash", { command: "npm run build" }, `error TS2304 at line ${seed}`, true],
			["edit", { path: file, oldText: "a", newText: "b" }, `Edited ${file}`],
			["bash", { command: "npm run build" }, `error TS2322 at line ${seed + 1}`, true],
			["edit", { path: file, oldText: "b", newText: "c" }, `Edited ${file}`],
			["bash", { command: "npm run build" }, `built in ${seed + 3}s`],
		],
		// 3: edit-read-edit-read on the same file, each read sees new content
		() => [
			...base,
			...[1, 2, 3].flatMap((k) => [
				["edit", { path: file, oldText: `v${k - 1}`, newText: `v${k}` }, `Edited ${file}`],
				["read", { path: file }, `// v${k} ${seed}`],
			]),
		],
		// 4: two git status checks with empty output, then a commit
		() => [
			...base,
			["bash", { command: "git status --porcelain" }, ""],
			["bash", { command: "git status --porcelain" }, ""],
			["bash", { command: "git log -1 --format=%s" }, `feat: mod${seed}`],
		],
		// 5: exploring many files, a few missing, then three searches with no match (bash grep/rg exit 1, no output)
		() => [
			...base,
			...Array.from({ length: 6 }, (_, k) =>
				k % 3 === 2
					? ["read", { path: `src/missing${seed}-${k}.ts` }, `ENOENT: no such file, open 'src/missing${seed}-${k}.ts'`, true]
					: ["read", { path: `src/part${seed}-${k}.ts` }, `export const p${k} = ${seed};`],
			),
			...[`grep -rn "deprecatedApi(" src`, `rg -n 'legacy_\\w+' src`, `grep -rn FIXME src/mod${seed}.ts`].map((command) => [
				"bash",
				{ command },
				"(no output)\n\nCommand exited with code 1",
				true,
			]),
		],
		// 6: alternating test/edit with changing results (not a ping-pong)
		() => [
			...base,
			...[3, 2, 1].flatMap((failing) => [
				["bash", { command: "npm test" }, `${failing} failing`, true],
				["edit", { path: file, oldText: `f${failing}`, newText: `f${failing - 1}` }, `Edited ${file}`],
			]),
			["bash", { command: "npm test" }, `all ${seed + 10} passing`],
		],
		// 7: long but varied run (14 tool turns)
		() => [
			...base,
			...Array.from({ length: 11 }, (_, k) => ["grep", { pattern: `sym${k}`, path: "src" }, `src/x${k}.ts:${seed}: sym${k}`]),
		],
		// 8: read A, read B, read A again after a write in between
		() => [
			...base,
			["read", { path: "a.ts" }, "A"],
			["read", { path: "b.ts" }, "B"],
			["write", { path: "a.ts", content: `A${seed}` }, "Wrote a.ts"],
			["read", { path: "a.ts" }, `A${seed}`],
			["read", { path: "b.ts" }, "B"],
		],
		// 9: same error twice, then a different approach succeeds
		() => [
			...base,
			["bash", { command: "npm run lint" }, "Error: config not found", true],
			["bash", { command: "npx biome check ." }, "Error: config not found", true],
			["bash", { command: "npx biome check --config-path . ." }, `Checked ${seed + 5} files`],
		],
	];
	return families[seed % 10]();
}

if (scenario === "normal") {
	for (const step of normal()) await turn(...step);
	assistant([{ type: "text", text: `normal task ${seed} done` }], "stop");
} else {
	const next = loops[scenario];
	if (!next) {
		process.stderr.write(`unknown scenario ${scenario}\n`);
		process.exit(2);
	}
	for (let i = 0; i < MAX_TURNS; i += 1) await turn(...next(i));
	assistant([{ type: "text", text: `loop ${scenario} ${seed} ran ${MAX_TURNS} turns unguarded` }], "stop");
}
