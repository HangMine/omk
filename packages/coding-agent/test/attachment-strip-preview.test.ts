import { visibleWidth } from "omk-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AttachmentStore } from "../src/core/attachment-store.ts";
import {
	createAttachmentStrip,
	resetAttachmentDecodeCache,
} from "../src/modes/interactive/components/attachment-strip.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { loadPhoton } from "../src/utils/photon.ts";

beforeEach(() => {
	initTheme("dark");
	resetAttachmentDecodeCache();
});

function readyStrip(store: AttachmentStore) {
	let done = () => {};
	const ready = new Promise<void>((resolve) => {
		done = resolve;
	});
	const repaint = vi.fn(done);
	const strip = createAttachmentStrip(store.list(), (id) => store.getBytes(id), repaint);
	return { ready, repaint, strip };
}

async function redImage(): Promise<Uint8Array> {
	const photon = await loadPhoton();
	if (!photon) throw new Error("The installed Photon decoder is required for this preview test.");
	const pixels = new Uint8Array(64 * 32 * 4);
	for (let i = 0; i < pixels.length; i += 4) {
		pixels[i] = 255;
		pixels[i + 3] = 255;
	}
	const image = new photon.PhotonImage(pixels, 64, 32);
	try {
		return image.get_bytes();
	} finally {
		image.free();
	}
}

describe("prompt attachment thumbnail", () => {
	it("uses real decoded RGBA and requests a paint after a pending preview completes", async () => {
		const store = new AttachmentStore();
		store.put(await redImage(), "file");
		const { ready, repaint, strip } = readyStrip(store);
		strip.render(80);
		await ready;
		const lines = strip.render(80);
		expect(lines.join("\n")).toContain("38;2;255;0;0m");
		expect(repaint).toHaveBeenCalledOnce();
		for (const width of [0, 1, 2, 5, 10, 16, 20, 80]) {
			for (const line of strip.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		strip.dispose();
	});
	it("shares one in-flight decode across concurrent previews", async () => {
		const store = new AttachmentStore();
		store.put(await redImage(), "file");
		let reads = 0;
		const getBytes = (id: string) => {
			reads += 1;
			return store.getBytes(id);
		};
		let settled = 0;
		let done = () => {};
		const ready = new Promise<void>((resolve) => {
			done = resolve;
		});
		const onReady = () => {
			settled += 1;
			if (settled === 2) done();
		};
		const first = createAttachmentStrip(store.list(), getBytes, onReady);
		const second = createAttachmentStrip(store.list(), getBytes, onReady);
		first.render(80);
		second.render(80);
		await ready;
		expect(reads).toBe(1);
		expect(first.render(80).join("\n")).toContain("38;2;255;0;0m");
		expect(second.render(80).join("\n")).toContain("38;2;255;0;0m");
		first.dispose();
		second.dispose();
	});
	it("does not request a late repaint after disposal", async () => {
		const store = new AttachmentStore();
		store.put(await redImage(), "file");
		const repaint = vi.fn();
		const strip = createAttachmentStrip(store.list(), (id) => store.getBytes(id), repaint);
		strip.dispose();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(repaint).not.toHaveBeenCalled();
	});
});
