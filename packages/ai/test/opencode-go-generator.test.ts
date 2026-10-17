import { afterEach, describe, expect, it, vi } from "vitest";
import { buildOpenCodeGoModels, fetchOpenCodeGoModels } from "../scripts/catalog-opencode-go.ts";

const source = {
	id: "beam-free",
	name: "Beam Free",
	tool_call: true,
	reasoning: true,
	limit: { context: 1048576, output: 131072 },
	reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
	provider: { api: "https://opencode.ai/inference/go/openai/v1" },
};
const metadata = { models: { "beam-free": source } };
const live = { data: [{ id: "beam-free" }] };
afterEach(() => vi.unstubAllGlobals());

describe("OpenCode Go generation boundaries", () => {
	it("joins only live IDs and deduplicates the model endpoint", () => {
		const models = buildOpenCodeGoModels(metadata, { data: [...live.data, ...live.data] });
		expect(models.map((model) => model.id)).toEqual(["beam-free"]);
	});

	it("does not drop a live Go route merely because models.dev marks it deprecated", () => {
		const models = buildOpenCodeGoModels({ models: { "beam-free": { ...source, status: "deprecated" } } }, live);
		expect(models).toHaveLength(1);
	});

	it("preserves legacy Go metadata only while the service still lists that exact ID", () => {
		const models = buildOpenCodeGoModels({ models: {} }, { data: [{ id: "kimi-k2.6" }] });
		expect(models).toMatchObject([{ id: "kimi-k2.6", maxTokens: 65536, compat: { supportsReasoningEffort: false } }]);
	});

	it("does not assume every discovered model supports tools", () => {
		expect(() => buildOpenCodeGoModels({ models: { "beam-free": { ...source, tool_call: false } } }, live)).toThrow(
			"no usable models",
		);
	});

	it.each([undefined, null, {}, { data: [] }, { data: [{ id: 1 }] }, { data: [{ id: 'broken"id' }] }])(
		"rejects invalid or empty live lists %# instead of deleting the catalog",
		(value) => {
			expect(() => buildOpenCodeGoModels(metadata, value)).toThrow(TypeError);
		},
	);

	it.each([
		null,
		{},
		{ models: null },
		{ models: { "beam-free": { ...source, limit: { context: -1, output: 1 } } } },
		{ models: { "beam-free": { ...source, cost: { input: -1 } } } },
		{ models: { "beam-free": { ...source, reasoning_options: [{ type: "effort", values: "max" }] } } },
	])("rejects malformed route metadata %#", (value) => {
		expect(() => buildOpenCodeGoModels(value, live)).toThrow(TypeError);
	});

	it("rejects unknown effort vocabularies instead of exposing an empty selector", () => {
		expect(() =>
			buildOpenCodeGoModels(
				{
					models: {
						"beam-free": { ...source, reasoning_options: [{ type: "effort", values: ["unknown-tier"] }] },
					},
				},
				live,
			),
		).toThrow("Unsupported OpenCode Go effort metadata");
	});

	it("never adopts an upstream-supplied credential destination", () => {
		const models = buildOpenCodeGoModels(
			{ models: { "beam-free": { ...source, provider: { api: "https://attacker.invalid/v1" } } } },
			live,
		);
		expect(models[0].baseUrl).toBe("https://opencode.ai/inference/go/openai/v1");
	});

	it("fails closed when the authoritative model endpoint fails", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(Response.json({ "opencode-go": metadata }))
			.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
		vi.stubGlobal("fetch", fetch);
		await expect(fetchOpenCodeGoModels()).rejects.toThrow("OpenCode Go HTTP 503");
		expect(fetch).toHaveBeenLastCalledWith(
			"https://opencode.ai/inference/go/v1/models",
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
	});

	it("fails closed on models.dev HTTP errors without querying another service", async () => {
		const fetch = vi.fn().mockResolvedValue(new Response("unavailable", { status: 502 }));
		vi.stubGlobal("fetch", fetch);
		await expect(fetchOpenCodeGoModels()).rejects.toThrow("models.dev HTTP 502");
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});
