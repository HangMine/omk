import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageContent, TextContent } from "omk-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import type { McpClient, McpContentBlock } from "../src/core/mcp/client.ts";
import { capMcpContent } from "../src/core/mcp/output-cap.ts";
import { createMcpToolDefinition, mapMcpContent } from "../src/core/mcp/tools.ts";
import { deleteSessionFile, sessionArtifactDir } from "../src/core/session-artifacts.ts";
import { DEFAULT_MAX_BYTES, truncateHead, truncateHeadTail } from "../src/core/tools/truncate.ts";

const MARKER =
	/^\[MCP output truncated: kept the start and the end; cut \d+ of \d+ lines \([\d.]+K?B of [\d.]+KB\) from the middle \(2000 lines \/ 50\.0KB limit\)\. /;

function session(): { dir: string; file: string; ctx: ExtensionContext } {
	const dir = mkdtempSync(join(tmpdir(), "omk-spec066-"));
	const file = join(dir, "sessions", "2026_abc.jsonl");
	return {
		dir,
		file,
		ctx: { cwd: dir, sessionManager: { getSessionFile: () => file } } as unknown as ExtensionContext,
	};
}

function tool(blocks: readonly McpContentBlock[], isError = false) {
	const client = { callTool: async () => ({ content: blocks, isError }) } as unknown as McpClient;
	return createMcpToolDefinition("srv", client, { name: "big", inputSchema: { type: "object" } });
}

const texts = (content: (TextContent | ImageContent)[]) =>
	content.filter((b): b is TextContent => b.type === "text").map((b) => b.text);

afterEach(() => {
	delete process.env.OMK_MCP_OUTPUT_CAP;
});

describe("spec 066 MCP output cap", () => {
	it("an oversized multi-line output reaches the model as head + one marker + tail <= 50KB, full text spilled 0600", async () => {
		const s = session();
		const full = Array.from({ length: 8000 }, (_, i) => `row ${i} ${"x".repeat(40)}`).join("\n");
		const result = await tool([{ type: "text", text: full }]).execute("call/1", {}, undefined, undefined, s.ctx);
		const [head, marker, tail, ...rest] = texts(result.content as (TextContent | ImageContent)[]);
		expect(rest).toEqual([]);
		expect(Buffer.byteLength(head + tail, "utf-8")).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
		expect(full.startsWith(`${head}\n`)).toBe(true);
		expect(full.endsWith(`\n${tail}`)).toBe(true);
		expect(tail.endsWith("row 7999 " + "x".repeat(40))).toBe(true);
		expect(marker).toMatch(MARKER);
		expect(marker).toContain(`of 8000 lines`);
		const keptLines = head.split("\n").length + tail.split("\n").length;
		expect(marker).toContain(`cut ${8000 - keptLines} of 8000 lines`);
		const rel = /Full output: (\S+) \(use read/.exec(marker)?.[1] ?? "";
		expect(rel.startsWith("/")).toBe(false);
		const spill = join(s.dir, rel);
		expect(readFileSync(spill, "utf-8")).toBe(full);
		expect(statSync(spill).mode & 0o777).toBe(0o600);
		expect(statSync(sessionArtifactDir(s.file)).mode & 0o777).toBe(0o700);
		expect(spill.startsWith(sessionArtifactDir(s.file))).toBe(true);
	});

	it("large MCP output with error at the end: head+tail keeps it, head-only loses it", async () => {
		const s = session();
		const error = "ERROR: step 42 failed: connection refused (exit 1)";
		const full = `${Array.from({ length: 8000 }, (_, i) => `log ${i} ${"x".repeat(40)}`).join("\n")}\n${error}`;
		const result = await tool([{ type: "text", text: full }]).execute("c-err", {}, undefined, undefined, s.ctx);
		const seen = texts(result.content as (TextContent | ImageContent)[]).join("\n");
		expect(seen).toContain(error);
		// Recorded contrast (spec 066 criterion 6): the head-only strategy drops it.
		expect(truncateHead(full).content).not.toContain(error);
	});

	it("a single 400KB line keeps a byte prefix and suffix (no empty preview)", async () => {
		const s = session();
		const full = `{${'"k":"vé",'.repeat(40_000)}"error":"boom"}`;
		const result = await tool([{ type: "text", text: full }]).execute("c2", {}, undefined, undefined, s.ctx);
		const [head, marker, tail] = texts(result.content as (TextContent | ImageContent)[]);
		expect(head.length).toBeGreaterThan(20_000);
		expect(Buffer.byteLength(head + tail, "utf-8")).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
		expect(full.startsWith(head)).toBe(true);
		expect(full.endsWith(tail)).toBe(true);
		expect(tail).toContain('"error":"boom"}');
		expect(marker).toMatch(MARKER);
		expect(marker).toContain("cut 0 of 1 lines");
	});

	it("isError results and multi-block results are capped combined; images kept", async () => {
		const s = session();
		const img: McpContentBlock = { type: "image", data: "AAAA", mimeType: "image/png" };
		const big = "e".repeat(30_000);
		const result = await tool([{ type: "text", text: big }, img, { type: "text", text: big }], true).execute(
			"c3",
			{},
			undefined,
			undefined,
			s.ctx,
		);
		const content = result.content as (TextContent | ImageContent)[];
		expect(content.map((b) => b.type)).toEqual(["text", "text", "text", "image"]);
		expect(texts(content)[1]).toMatch(MARKER);
		expect(result.details.isError).toBe(true);
	});

	describe("truncateHeadTail", () => {
		it("line-limited: keeps 1000 + 1000 lines and counts the cut", () => {
			const full = Array.from({ length: 5000 }, (_, i) => `${i}`).join("\n");
			const cut = truncateHeadTail(full);
			expect(cut.head.split("\n")).toHaveLength(1000);
			expect(cut.tail.split("\n")).toHaveLength(1000);
			expect(cut.head.split("\n")[0]).toBe("0");
			expect(cut.tail.split("\n").at(-1)).toBe("4999");
			expect(cut.omittedLines).toBe(3000);
			expect(cut.omittedBytes).toBe(
				Buffer.byteLength(full) - Buffer.byteLength(cut.head) - Buffer.byteLength(cut.tail),
			);
		});
		it("at the limits it is not truncated", () => {
			const at = "b".repeat(DEFAULT_MAX_BYTES);
			expect(truncateHeadTail(at)).toMatchObject({ truncated: false, head: at, tail: "", omittedLines: 0 });
		});
		it("multibyte text stays valid UTF-8 at both cuts", () => {
			const cut = truncateHeadTail("가".repeat(100_000));
			expect(cut.head.includes("\uFFFD") || cut.tail.includes("\uFFFD")).toBe(false);
			expect(Buffer.byteLength(cut.head + cut.tail)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
		});
	});

	it("a context without a session manager (or none) still caps, and leaves small outputs untouched", async () => {
		const small = await tool([{ type: "text", text: "ok" }]).execute(
			"n1",
			{},
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(small.content).toEqual([{ type: "text", text: "ok" }]);
		const none = await tool([{ type: "text", text: "ok" }]).execute(
			"n2",
			{},
			undefined,
			undefined,
			undefined as unknown as ExtensionContext,
		);
		expect(none.content).toEqual([{ type: "text", text: "ok" }]);
		const big = await tool([{ type: "text", text: "z\n".repeat(5000) }]).execute(
			"n3",
			{},
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(texts(big.content as (TextContent | ImageContent)[])[1]).toContain("Full output was not saved");
	});

	it("no session file: marker says the full output was not saved", () => {
		const out = capMcpContent([{ type: "text", text: "z\n".repeat(5000) }], {
			sessionFile: undefined,
			cwd: tmpdir(),
			toolCallId: "c4",
		});
		expect(texts(out)[1]).toContain("Full output was not saved (no session file).");
	});

	it("OMK_MCP_OUTPUT_CAP=0 restores the uncapped output", async () => {
		const s = session();
		const full = "q".repeat(400_000);
		process.env.OMK_MCP_OUTPUT_CAP = "0";
		const result = await tool([{ type: "text", text: full }]).execute("c5", {}, undefined, undefined, s.ctx);
		expect(result.content).toEqual([{ type: "text", text: full }]);
		expect(existsSync(sessionArtifactDir(s.file))).toBe(false);
	});

	it("deleting the session removes its spill directory", async () => {
		const s = session();
		await tool([{ type: "text", text: "w".repeat(60_000) }]).execute("c6", {}, undefined, undefined, s.ctx);
		writeFileSync(s.file, "{}\n");
		expect(existsSync(sessionArtifactDir(s.file))).toBe(true);
		const deleted = await deleteSessionFile(s.file);
		expect(deleted.ok).toBe(true);
		expect(existsSync(s.file)).toBe(false);
		expect(existsSync(sessionArtifactDir(s.file))).toBe(false);
	});

	describe("small outputs are byte-identical to the uncapped path (golden)", () => {
		const exactLines = Array.from({ length: 2000 }, () => "l").join("\n");
		const cases: [string, McpContentBlock[]][] = [
			["empty", []],
			["empty text", [{ type: "text", text: "" }]],
			["one char", [{ type: "text", text: "a" }]],
			["short json", [{ type: "text", text: '{"ok":true,"n":1}' }]],
			["korean", [{ type: "text", text: "안녕하세요 결과입니다" }]],
			["emoji", [{ type: "text", text: "done ✅🎉" }]],
			["crlf", [{ type: "text", text: "a\r\nb\r\n" }]],
			["trailing newline", [{ type: "text", text: "line\n" }]],
			["tabs", [{ type: "text", text: "a\tb\tc" }]],
			["exactly 50KB", [{ type: "text", text: "b".repeat(DEFAULT_MAX_BYTES) }]],
			["exactly 2000 lines", [{ type: "text", text: exactLines }]],
			[
				"two blocks",
				[
					{ type: "text", text: "one" },
					{ type: "text", text: "two" },
				],
			],
			[
				"two blocks at limit",
				[
					{ type: "text", text: "c".repeat(25_000) },
					{ type: "text", text: "d".repeat(25_000) },
				],
			],
			["image only", [{ type: "image", data: "AAAA", mimeType: "image/png" }]],
			[
				"text + image",
				[
					{ type: "text", text: "see" },
					{ type: "image", data: "AAAA", mimeType: "image/png" },
				],
			],
			["resource text", [{ type: "resource", resource: { uri: "file:///x", text: "body" } }]],
			["resource blob", [{ type: "resource", resource: { uri: "file:///x", blob: "AAAA" } }]],
			["unknown block", [{ type: "audio", data: "AAAA" } as unknown as McpContentBlock]],
			["markdown table", [{ type: "text", text: "| a | b |\n|---|---|\n| 1 | 2 |" }]],
			["error text", [{ type: "text", text: "Error: not found" }]],
			["nul and control", [{ type: "text", text: "a\u0000b\u0007c" }]],
			["49KB multibyte", [{ type: "text", text: "가".repeat(16_000) }]],
		];
		it.each(cases)("%s", async (_name, blocks) => {
			const s = session();
			const capped = await tool(blocks).execute("g", {}, undefined, undefined, s.ctx);
			process.env.OMK_MCP_OUTPUT_CAP = "0";
			const uncapped = await tool(blocks).execute("g", {}, undefined, undefined, s.ctx);
			expect(JSON.stringify(capped)).toBe(JSON.stringify(uncapped));
			const mapped = mapMcpContent(blocks);
			expect(capMcpContent(mapped, { sessionFile: s.file, cwd: s.dir, toolCallId: "g" })).toBe(mapped);
			expect(existsSync(sessionArtifactDir(s.file))).toBe(false);
		});
		it("has >= 20 cases", () => expect(cases.length).toBeGreaterThanOrEqual(20));
	});
});
