/**
 * Terminal preview strip for prompt image attachments.
 *
 * Default renderer is ANSI truecolor half-block ("▀" = two vertical pixels per
 * cell) — works everywhere, no protocol negotiation. Decoding goes through
 * Photon when available; failures degrade to a metadata-only tile instead of
 * hiding the paste. Previews are cached per (attachment, width).
 */

import { truncateToWidth } from "omk-tui";
import {
	describePromptImageAttachment,
	PROMPT_ATTACHMENT_LIMITS,
	type PromptImageAttachment,
} from "../../../core/prompt-attachment.ts";
import { loadPhoton } from "../../../utils/photon.ts";
import { theme } from "../theme/theme.ts";

const PREVIEW_ROWS = 6;
const MAX_TILES = 3;

export interface AttachmentStripHandle {
	render(width: number): string[];
	invalidate(): void;
	dispose(): void;
}

interface DecodedImage {
	width: number;
	height: number;
	rgba: Uint8Array;
}

interface DecodeEntry {
	result?: DecodedImage | null;
	pending?: Promise<DecodedImage | null>;
}

/** Keyed by the stable attachment metadata object: a dropped draft releases its entry. */
let decodeCache = new WeakMap<PromptImageAttachment, DecodeEntry>();

/**
 * One decode per active attachment. Concurrent previews share the in-flight promise, so a second repaint
 * cannot allocate another full-resolution Photon image for the same bytes.
 */
function decodeToRgba(
	attachment: PromptImageAttachment,
	getBytes: () => Uint8Array | undefined,
): Promise<DecodedImage | null> {
	const cached = decodeCache.get(attachment);
	if (cached?.pending) return cached.pending;
	if (cached?.result !== undefined) return Promise.resolve(cached.result);
	const entry: DecodeEntry = {};
	decodeCache.set(attachment, entry);
	entry.pending = (async () => {
		let decoded: DecodedImage | null = null;
		const bytes = getBytes();
		if (bytes && bytes.length > 0) {
			try {
				const photon = await loadPhoton();
				if (photon) {
					const image = photon.PhotonImage.new_from_byteslice(bytes);
					try {
						const width = image.get_width();
						const height = image.get_height();
						if (width > 0 && height > 0 && width * height <= PROMPT_ATTACHMENT_LIMITS.maxPixels) {
							const scale = Math.min(1, 80 / width, (PREVIEW_ROWS * 2) / height);
							const small = photon.resize(
								image,
								Math.max(1, Math.round(width * scale)),
								Math.max(1, Math.round(height * scale)),
								1,
							);
							try {
								decoded = {
									width: small.get_width(),
									height: small.get_height(),
									rgba: small.get_raw_pixels().slice(),
								};
							} finally {
								small.free();
							}
						}
					} finally {
						image.free();
					}
				}
			} catch {
				decoded = null;
			}
		}
		entry.result = decoded;
		entry.pending = undefined;
		return decoded;
	})();
	return entry.pending;
}

/** Render one attachment as truecolor half-block lines inside a thin box. */
function renderTile(index: number, attachment: PromptImageAttachment, tileWidth: number): string[] {
	const muted = (text: string) => theme.fg("muted", text);
	/** Hard width cap: a wrapped border row drifts the line-count-based viewport. */
	const fitToTileWidth = (text: string) => truncateToWidth(text, tileWidth);
	const title = ` Image ${index} `;
	const top = fitToTileWidth(muted(`┌${title}${"─".repeat(Math.max(0, tileWidth - title.length - 1))}┐`));
	const footerText = describePromptImageAttachment(attachment);
	const footer = fitToTileWidth(
		muted(`└ ${footerText}${"─".repeat(Math.max(0, tileWidth - footerText.length - 3))}┘`),
	);

	const inner = Math.max(0, tileWidth - 2);
	const lines: string[] = [top];

	if (inner < 8) {
		lines.push(fitToTileWidth(muted(`│ ${footerText.slice(0, inner)} │`)), footer);
		return lines;
	}

	const decoded = decodeCache.get(attachment)?.result;
	if (!decoded) {
		// Metadata-only fallback (decode unavailable or still pending).
		for (let row = 0; row < PREVIEW_ROWS; row += 1) {
			const label = row === Math.floor(PREVIEW_ROWS / 2) ? "🖼 no preview" : "";
			lines.push(fitToTileWidth(muted(`│${(label + " ".repeat(inner)).slice(0, inner)}│`)));
		}
		lines.push(footer);
		return lines;
	}

	const cellRows = PREVIEW_ROWS * 2;
	const scale = Math.min(inner / decoded.width, cellRows / decoded.height);
	const offsetX = (inner - decoded.width * scale) / 2;
	const offsetY = (cellRows - decoded.height * scale) / 2;
	const pixel = (x: number, y: number): [number, number, number] => {
		const sx = Math.floor((x - offsetX) / scale);
		const sy = Math.floor((y - offsetY) / scale);
		return sx < 0 || sy < 0 || sx >= decoded.width || sy >= decoded.height
			? [0, 0, 0]
			: samplePixelAt(decoded, sx, sy);
	};
	for (let row = 0; row < PREVIEW_ROWS; row += 1) {
		let line = "";
		for (let col = 0; col < inner; col += 1) {
			const top_ = pixel(col + 0.5, row * 2 + 0.5);
			const bottom = pixel(col + 0.5, row * 2 + 1.5);
			line += `\x1b[38;2;${top_[0]};${top_[1]};${top_[2]}m\x1b[48;2;${bottom[0]};${bottom[1]};${bottom[2]}m▀\x1b[0m`;
		}
		lines.push(fitToTileWidth(muted("│") + line + muted("│")));
	}
	lines.push(footer);
	return lines;
}

function samplePixelAt(decoded: DecodedImage, x: number, y: number): [number, number, number] {
	const clampedX = Math.min(x, decoded.width - 1);
	const clampedY = Math.min(y, decoded.height - 1);
	const offset = (clampedY * decoded.width + clampedX) * 4;
	const alpha = decoded.rgba[offset + 3] / 255;
	return [
		Math.round(decoded.rgba[offset] * alpha),
		Math.round(decoded.rgba[offset + 1] * alpha),
		Math.round(decoded.rgba[offset + 2] * alpha),
	];
}

/**
 * Build the strip component. `getBytes` supplies raw bytes for decoding;
 * `onReady` requests a paint after asynchronous decode; disposed strips never request one.
 */
export function createAttachmentStrip(
	attachments: readonly PromptImageAttachment[],
	getBytes: (id: string) => Uint8Array | undefined,
	onReady?: () => void,
): AttachmentStripHandle {
	let cachedWidth: number | undefined;
	let cachedLines: string[] | undefined;
	let disposed = false;

	void (async () => {
		for (const attachment of attachments.slice(0, MAX_TILES)) {
			if (disposed) return;
			await decodeToRgba(attachment, () => getBytes(attachment.id));
		}
		if (disposed) return;
		cachedWidth = undefined;
		onReady?.();
	})();

	return {
		render(width: number): string[] {
			if (cachedLines && cachedWidth === width) return cachedLines;
			const lines: string[] = [];
			const shown = attachments.slice(0, MAX_TILES);
			const tileWidth = Math.min(44, Math.max(0, width));
			shown.forEach((attachment, index) => {
				lines.push(...renderTile(index + 1, attachment, tileWidth));
			});
			const hidden = attachments.length - shown.length;
			if (hidden > 0) {
				lines.push(
					truncateToWidth(theme.fg("muted", `+${hidden} more attached (${attachments.length} total)`), width),
				);
			}
			cachedWidth = width;
			cachedLines = lines;
			return lines;
		},
		invalidate(): void {
			cachedWidth = undefined;
			cachedLines = undefined;
		},
		dispose(): void {
			disposed = true;
			cachedLines = undefined;
		},
	};
}

/** Test hook: drop memoized decodes. */
export function resetAttachmentDecodeCache(): void {
	decodeCache = new WeakMap();
}
