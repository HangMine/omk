import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { getGraphemeSegmenter, visibleWidth } from "../src/utils.ts";

describe("visibleWidth cache bounds", () => {
	it("caches short display lines but never retains long streamed strings", () => {
		const segmenter = getGraphemeSegmenter();
		const segment = mock.method(segmenter, "segment");
		try {
			const short = `짧은-😀-${process.pid}`;
			const shortWidth = visibleWidth(short);
			const beforeShort = segment.mock.callCount();
			assert.equal(visibleWidth(short), shortWidth);
			assert.equal(segment.mock.callCount(), beforeShort);
			const long = `${"한".repeat(8192)}😀끝`;
			assert.equal(visibleWidth(long), 16388);
			const beforeLong = segment.mock.callCount();
			assert.equal(visibleWidth(long), 16388);
			assert.ok(segment.mock.callCount() > beforeLong, "long text must bypass the retaining cache");
		} finally {
			segment.mock.restore();
		}
	});
});
