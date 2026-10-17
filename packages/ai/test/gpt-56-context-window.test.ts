import { describe, expect, it } from "vitest";
import { getModels, getProviders } from "../src/models.ts";

describe("GPT-5.6 context metadata", () => {
	it("advertises a 1M context window for every family model", () => {
		const family = getProviders()
			.flatMap((provider) => getModels(provider))
			.filter((model) => model.id.toLowerCase().includes("gpt-5.6"));

		expect(family.length).toBeGreaterThan(0);
		expect(
			family
				// models.dev and OpenCode Go declare 1,050,000 for several GPT-5.6 routes.
				.filter((model) => model.contextWindow !== 1_000_000 && model.contextWindow !== 1_050_000)
				.map((model) => `${model.provider}/${model.id}:${model.contextWindow}`),
		).toEqual([]);
	});
});
