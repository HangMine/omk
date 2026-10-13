import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { PromptAttachmentDraft } from "../src/modes/interactive/prompt-attachment-draft.ts";

const clipboard = vi.hoisted(() => vi.fn());
vi.mock("../src/utils/clipboard-image.ts", () => ({ readClipboardImage: clipboard }));
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6v6EAAAAASUVORK5CYII=",
	"base64",
);
let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "omk-image-draft-"));
	clipboard.mockReset();
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

function draft() {
	const host = { cwd: () => root, changed: vi.fn(), status: vi.fn(), warning: vi.fn() };
	return { input: new PromptAttachmentDraft(host), host };
}

function deferredImage() {
	let complete: (value: { bytes: Uint8Array; mimeType: string }) => void = () => {
		throw new Error("uninitialized");
	};
	const pending = new Promise<{ bytes: Uint8Array; mimeType: string }>((resolve) => {
		complete = resolve;
	});
	return { pending, complete };
}

describe("prompt attachment draft", () => {
	it("exposes the attachment command in slash completion", () => {
		expect(BUILTIN_SLASH_COMMANDS.some((command) => command.name === "attach")).toBe(true);
	});
	it("adds file images, retains them for retry and consumes only the accepted snapshot", async () => {
		await writeFile(join(root, "screen shot.png"), PNG);
		const { input, host } = draft();
		await input.command('add "screen shot.png"');
		const ids = [...input.ids];
		expect(input.materialize(ids)).toEqual([{ type: "image", data: PNG.toString("base64"), mimeType: "image/png" }]);
		expect(input.materialize(ids)).toHaveLength(1);
		input.consume(ids);
		expect(input.ids).toEqual([]);
		expect(host.warning).not.toHaveBeenCalled();
	});
	it("rolls back an entire failed multi-file batch without removing older attachments", async () => {
		await writeFile(join(root, "good.png"), PNG);
		await writeFile(join(root, "bad.png"), "not an image");
		const { input, host } = draft();
		await input.command("add good.png");
		const ids = [...input.ids];
		await input.command("add good.png bad.png");
		expect(input.ids).toEqual(ids);
		expect(host.warning).toHaveBeenCalled();
	});
	it("deduplicates clipboard screenshots and never accepts an invalid remove index", async () => {
		clipboard.mockResolvedValue({ bytes: PNG, mimeType: "image/png" });
		const { input, host } = draft();
		await input.clipboard();
		await input.clipboard();
		expect(input.ids).toHaveLength(1);
		await input.command("remove 99");
		expect(input.ids).toHaveLength(1);
		expect(host.warning).toHaveBeenCalled();
		await input.command("remove 1");
		expect(input.ids).toEqual([]);
	});
	it("marks asynchronous acquisition busy and discards a clipboard result after clear", async () => {
		const image = deferredImage();
		clipboard.mockReturnValue(image.pending);
		const { input } = draft();
		const pending = input.clipboard();
		expect(input.busy).toBe(true);
		await Promise.resolve();
		input.clear();
		expect(input.busy).toBe(false);
		image.complete({ bytes: PNG, mimeType: "image/png" });
		await pending;
		expect(input.ids).toEqual([]);
		expect(input.busy).toBe(false);
	});
	it("disposal suppresses late state changes and warnings", async () => {
		const image = deferredImage();
		clipboard.mockReturnValue(image.pending);
		const { input, host } = draft();
		const pending = input.clipboard();
		await Promise.resolve();
		input.dispose();
		host.changed.mockClear();
		host.warning.mockClear();
		host.status.mockClear();
		image.complete({ bytes: PNG, mimeType: "image/png" });
		await pending;
		expect(input.ids).toEqual([]);
		expect(host.changed).not.toHaveBeenCalled();
		expect(host.warning).not.toHaveBeenCalled();
		expect(host.status).not.toHaveBeenCalled();
	});
	it("reports a missing file without hanging the next clipboard operation", async () => {
		const { input, host } = draft();
		await input.command("add missing.png");
		clipboard.mockResolvedValue({ bytes: PNG, mimeType: "image/png" });
		await input.command("paste");
		expect(input.ids).toHaveLength(1);
		expect(input.busy).toBe(false);
		expect(host.warning).toHaveBeenCalledOnce();
	});
});
