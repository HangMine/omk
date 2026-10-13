import { beforeEach, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { PromptAttachmentDraft } from "../src/modes/interactive/prompt-attachment-draft.ts";

const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../src/utils/clipboard-image.ts", () => ({ readClipboardImage: mocks.read }));

async function paste(context: object) {
	const method: unknown = Reflect.get(InteractiveMode.prototype, "handleClipboardImagePaste");
	if (typeof method !== "function") throw new Error("Clipboard action missing");
	await method.call(context);
}

function context() {
	const refreshAttachmentStrip = vi.fn();
	const showWarning = vi.fn();
	const showStatus = vi.fn();
	const attachmentDraft = new PromptAttachmentDraft({
		cwd: () => process.cwd(),
		changed: refreshAttachmentStrip,
		warning: showWarning,
		status: showStatus,
	});
	return {
		attachmentDraft,
		attachmentStore: attachmentDraft.store,
		get draftAttachmentIds() {
			return attachmentDraft.ids;
		},
		refreshAttachmentStrip,
		showWarning,
		showStatus,
	};
}

beforeEach(() => {
	mocks.read.mockReset();
});

describe("interactive screenshot paste", () => {
	it("shows a useful message instead of silently ignoring an empty clipboard", async () => {
		mocks.read.mockResolvedValue(null);
		const target = context();
		await paste(target);
		expect(target.showStatus).toHaveBeenCalledWith(expect.stringMatching(/no image/i));
		expect(target.draftAttachmentIds).toEqual([]);
	});

	it("adds a real validated attachment and refreshes the prompt preview", async () => {
		const png = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6v6EAAAAASUVORK5CYII=",
			"base64",
		);
		mocks.read.mockResolvedValue({ bytes: png, mimeType: "image/png" });
		const target = context();
		await paste(target);
		expect(target.draftAttachmentIds).toHaveLength(1);
		expect(target.refreshAttachmentStrip).toHaveBeenCalled();
		expect(target.attachmentStore.materializeImages(target.draftAttachmentIds)).toEqual([
			{ type: "image", data: png.toString("base64"), mimeType: "image/png" },
		]);
		expect(target.showWarning).not.toHaveBeenCalled();
	});

	it("keeps only one draft id when the same screenshot is pasted twice", async () => {
		const png = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6v6EAAAAASUVORK5CYII=",
			"base64",
		);
		mocks.read.mockResolvedValue({ bytes: png, mimeType: "image/png" });
		const target = context();
		await paste(target);
		await paste(target);
		expect(target.draftAttachmentIds).toHaveLength(1);
	});

	it("reports acquisition errors without adding a broken attachment", async () => {
		mocks.read.mockRejectedValue(new Error("Windows clipboard unavailable"));
		const target = context();
		await paste(target);
		expect(target.showWarning).toHaveBeenCalledWith(expect.stringContaining("Windows clipboard unavailable"));
		expect(target.draftAttachmentIds).toEqual([]);
	});
});
