import { describe, expect, it } from "vitest";
import * as ai from "../src/index.ts";

describe("Pi Responses compatibility factory", () => {
	it("exposes provider-specific streamers", () => {
		expect(ai.openAIResponsesApi).toBeTypeOf("function");
		const provider = ai.openAIResponsesApi();
		expect(provider.api).toBe("openai-responses");
		expect(provider.stream).toBe(ai.streamOpenAIResponses);
		expect(provider.streamSimple).toBe(ai.streamSimpleOpenAIResponses);
		expect(provider.streamSimple).not.toBe(ai.streamSimple);
	});

	it("returns independent configurations", () => {
		const first = ai.openAIResponsesApi();
		const second = ai.openAIResponsesApi();
		expect(first).not.toBe(second);
		expect(first.streamSimple).toBe(second.streamSimple);
	});
});
