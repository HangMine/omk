import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { StreamFn } from "omk-agent-core";
import { createAssistantMessageEventStream, fauxAssistantMessage, registerFauxProvider } from "omk-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { wrapBudgetStream } from "../src/core/budget-stream.ts";
import { RequestTrace } from "../src/core/request-trace.ts";
import {
	boundaryChangeReason,
	dispatchFingerprints,
	loadProjectTraceSalt,
} from "../src/core/request-trace-metadata.ts";
import { RunBudget } from "../src/core/run-budget.ts";
import { recordPrefixBoundaryCause } from "../src/core/system-prompt-cache-boundary.ts";

const SECRET_PROMPT = "SYSTEM-PROMPT-CANARY-7f3a do not leak";
const TOOL_CANARY = "TOOL-DESCRIPTION-CANARY-91bd";
const USER_CANARY = "USER-MESSAGE-CANARY-c0de";
const flush = () => new Promise((resolve) => setImmediate(resolve));

let dir: string;
let cwd: string;
beforeEach(() => {
	dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omk-trace-101-")));
	cwd = process.cwd();
	process.chdir(dir);
});
afterEach(() => {
	process.chdir(cwd);
	delete process.env.OMK_EVAL_TRACE;
	fs.rmSync(dir, { recursive: true, force: true });
});

function context() {
	return {
		systemPrompt: SECRET_PROMPT,
		messages: [{ role: "user" as const, content: USER_CANARY, timestamp: 0 }],
		tools: [{ name: "bash", description: TOOL_CANARY, parameters: { type: "object", properties: {} } }],
	};
}

describe("request trace metadata (spec 101)", () => {
	it("creates a 0600 per-project salt and reuses it", () => {
		const salt = loadProjectTraceSalt(dir);
		expect(fs.statSync(path.join(dir, ".omk", "trace-salt")).mode & 0o777).toBe(0o600);
		expect(loadProjectTraceSalt(dir).equals(salt)).toBe(true);
		fs.chmodSync(path.join(dir, ".omk", "trace-salt"), 0o644);
		expect(() => loadProjectTraceSalt(dir)).toThrow("trace.salt_permissions");
	});

	it("fingerprints are salted HMACs, not plain sha256 of the prompt", () => {
		const a = dispatchFingerprints(Buffer.alloc(32, 1), context());
		const b = dispatchFingerprints(Buffer.alloc(32, 2), context());
		expect(a.prefix).not.toBe(b.prefix);
		expect(a.prefix).not.toBe(createHash("sha256").update(SECRET_PROMPT).digest("hex"));
		expect(boundaryChangeReason(undefined, a)).toBe("first");
		expect(boundaryChangeReason(a, a)).toBe("unchanged");
		expect(boundaryChangeReason(a, { ...a, prefix: "x" })).toBe("prefix_changed");
		expect(boundaryChangeReason(a, { ...a, tools: "x" })).toBe("tools_changed");
		expect(boundaryChangeReason(a, undefined)).toBe("unavailable");
	});

	it("records metadata with zero raw prompt bytes and leaves the provider input untouched", async () => {
		const tracePath = path.join(dir, "trace.jsonl");
		process.env.OMK_EVAL_TRACE = tracePath;
		const faux = registerFauxProvider();
		const budget = new RunBudget({ maxRequests: 10 }, () => {});
		const seen: unknown[] = [];
		const streams = [createAssistantMessageEventStream(), createAssistantMessageEventStream()];
		let call = 0;
		const source: StreamFn = (_model, ctx) => {
			seen.push(ctx);
			return streams[call++];
		};
		const ctx = context();
		const snapshot = JSON.stringify(ctx);
		try {
			const wrapped = wrapBudgetStream(source, budget);
			await wrapped(faux.getModel(), ctx, {});
			const done = fauxAssistantMessage("done");
			done.usage = { ...done.usage, input: 100, cacheRead: 800, cacheWrite: 100 };
			done.usage.cost = { ...done.usage.cost, total: 0.01, billed: 0.02 };
			streams[0].end(done);
			await flush();
			await wrapped(faux.getModel(), { ...ctx, systemPrompt: `${SECRET_PROMPT} v2` }, {});
			streams[1].end(fauxAssistantMessage("done"));
			await flush();
		} finally {
			budget.close();
			faux.unregister();
		}
		expect(seen[0]).toBe(ctx);
		expect(JSON.stringify(ctx)).toBe(snapshot);

		const raw = fs.readFileSync(tracePath, "utf8");
		for (const canary of [SECRET_PROMPT, TOOL_CANARY, USER_CANARY, "CANARY"]) expect(raw).not.toContain(canary);
		const bodies = raw
			.trim()
			.split("\n")
			.map((line) => JSON.parse(JSON.parse(line).body));
		const dispatches = bodies.filter((body) => body.kind === "logical_dispatch");
		expect(dispatches[0]).toMatchObject({ purpose: "unknown", cacheScope: "default", boundaryChangeReason: "first" });
		expect(dispatches[0].prefixFingerprint).toMatch(/^[0-9a-f]{64}$/);
		expect(dispatches[1].boundaryChangeReason).toBe("prefix_changed");
		const terminal = bodies.find((body) => body.kind === "logical_terminal");
		expect(terminal).toMatchObject({
			usageMissing: false,
			costSource: "provider_billed",
			usage: { input: 100, uncached: 100, cacheRead: 800, cacheWrite: 100, estimatedUsd: 0.01, billedUsd: 0.02 },
		});
	});

	it("records the spec 102 cause on boundaryChangeReason through the stream wrapper", async () => {
		const tracePath = path.join(dir, "trace-102.jsonl");
		process.env.OMK_EVAL_TRACE = tracePath;
		const faux = registerFauxProvider();
		const budget = new RunBudget({ maxRequests: 10 }, () => {});
		const causes = ["suffix_changed", "flag_off", "bypass_surrogate"] as const;
		const streams = [0, 1, 2, 3].map(() => createAssistantMessageEventStream());
		let call = 0;
		const source: StreamFn = () => streams[call++];
		try {
			const wrapped = wrapBudgetStream(source, budget);
			for (let i = 0; i < 4; i++) {
				const systemPrompt = `${SECRET_PROMPT} tail ${i}`;
				if (i > 0) recordPrefixBoundaryCause(systemPrompt, causes[i - 1]);
				await wrapped(faux.getModel(), { ...context(), systemPrompt }, {});
				streams[i].end(fauxAssistantMessage("done"));
				await flush();
			}
		} finally {
			budget.close();
			faux.unregister();
		}
		const reasons = fs
			.readFileSync(tracePath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(JSON.parse(line).body))
			.filter((body) => body.kind === "logical_dispatch")
			.map((body) => body.boundaryChangeReason);
		expect(reasons).toEqual(["first", ...causes]);
	});

	it("flags missing usage", () => {
		const trace = new RequestTrace(path.join(dir, "t2.jsonl"));
		const id = trace.begin("p", "m");
		trace.terminal(id, undefined);
		trace.closeScope();
		const raw = fs.readFileSync(path.join(dir, "t2.jsonl"), "utf8");
		expect(raw).toContain('\\"usageMissing\\":true');
		expect(raw).toContain('\\"costSource\\":\\"none\\"');
	});
});
