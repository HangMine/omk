import { describe, expect, it } from "vitest";
import { sanitizeProvenanceText } from "../src/core/compaction/control-state.ts";

describe("sanitizeProvenanceText", () => {
	it("returns a non-empty [empty] placeholder when nothing survives normalization", () => {
		expect(sanitizeProvenanceText("")).toBe("[empty]");
		expect(sanitizeProvenanceText("   \n\t ")).toBe("[empty]");
		expect(sanitizeProvenanceText("\u0001\u0002")).toBe("[empty]");
	});

	it("keeps ordinary text unchanged", () => {
		expect(sanitizeProvenanceText("  open task  ")).toBe("open task");
	});
});
