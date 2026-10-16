import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api } from "omk-ai";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { clearApiKeyCache, ModelRegistry, type ProviderConfigInput } from "../src/core/model-registry.ts";

const model = (id: string) => ({
	id,
	name: id,
	reasoning: false,
	input: ["text" as const],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100000,
	maxTokens: 8000,
});
const provider = (ids: string[]): ProviderConfigInput => ({
	baseUrl: "http://127.0.0.1:9/v1",
	apiKey: "not-a-secret",
	api: "openai-completions" as Api,
	models: ids.map(model),
});

describe("spec 063 ModelRegistry.refreshIfChanged", () => {
	let dir: string;
	let modelsJson: string;
	let auth: AuthStorage;
	const write = (ids: string[]) => writeFileSync(modelsJson, JSON.stringify({ providers: { fake: provider(ids) } }));
	const ids = (registry: ModelRegistry) =>
		registry
			.getAll()
			.filter((m) => m.provider === "fake")
			.map((m) => m.id);

	beforeEach(() => {
		dir = join(tmpdir(), `omk-spec063-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		modelsJson = join(dir, "models.json");
		auth = AuthStorage.create(join(dir, "auth.json"));
	});
	afterEach(() => {
		if (existsSync(dir)) rmSync(dir, { recursive: true });
		clearApiKeyCache();
	});

	test("skips when nothing changed, and the skipped state equals a full refresh", () => {
		write(["model-a"]);
		const registry = ModelRegistry.create(auth, modelsJson);
		expect(registry.refreshIfChanged()).toBe(true);
		expect(registry.refreshIfChanged()).toBe(false);
		const skipped = registry.getAll();
		registry.refresh();
		expect(registry.getAll()).toEqual(skipped);
	});

	test("a same-size models.json edit forces a reload", () => {
		write(["model-a"]);
		const registry = ModelRegistry.create(auth, modelsJson);
		registry.refreshIfChanged();
		write(["model-b"]);
		expect(registry.refreshIfChanged()).toBe(true);
		expect(ids(registry)).toEqual(["model-b"]);
		expect(registry.refreshIfChanged()).toBe(false);
	});

	test("deleting or breaking models.json forces a reload and surfaces the error", () => {
		write(["model-a"]);
		const registry = ModelRegistry.create(auth, modelsJson);
		registry.refreshIfChanged();
		writeFileSync(modelsJson, "{ not json");
		expect(registry.refreshIfChanged()).toBe(true);
		expect(registry.getError()).toContain("Failed to parse models.json");
		unlinkSync(modelsJson);
		expect(registry.refreshIfChanged()).toBe(true);
		expect(registry.getError()).toBeUndefined();
		expect(ids(registry)).toEqual([]);
	});

	test("registerProvider forces the next reload", () => {
		write(["model-a"]);
		const registry = ModelRegistry.create(auth, modelsJson);
		registry.refreshIfChanged();
		registry.registerProvider("ext", provider(["ext-1"]));
		expect(registry.refreshIfChanged()).toBe(true);
		expect(registry.find("ext", "ext-1")).toBeDefined();
	});

	test("an OAuth credential change for a model-modifying provider forces a reload", () => {
		write(["model-a"]);
		const registry = ModelRegistry.create(auth, modelsJson);
		registry.registerProvider("acme", {
			...provider(["acme-1"]),
			oauth: {
				name: "Acme",
				login: async () => ({ access: "a", refresh: "r", expires: 0 }),
				refreshToken: async (c) => c,
				getApiKey: (c) => c.access,
				modifyModels: (models, credentials) =>
					models.map((m) => (m.provider === "acme" ? { ...m, baseUrl: String(credentials.enterpriseUrl) } : m)),
			},
		});
		auth.set("acme", { type: "oauth", access: "a", refresh: "r", expires: 0, enterpriseUrl: "https://one" });
		expect(registry.refreshIfChanged()).toBe(true);
		expect(registry.find("acme", "acme-1")?.baseUrl).toBe("https://one");
		expect(registry.refreshIfChanged()).toBe(false);
		auth.set("acme", { type: "oauth", access: "a", refresh: "r", expires: 0, enterpriseUrl: "https://two" });
		expect(registry.refreshIfChanged()).toBe(true);
		expect(registry.find("acme", "acme-1")?.baseUrl).toBe("https://two");
	});

	test("an API key login needs no reload: availability is read live", () => {
		write(["model-a"]);
		const registry = ModelRegistry.create(auth, modelsJson);
		registry.refreshIfChanged();
		const before = registry.getAvailable().length;
		auth.set("anthropic", { type: "api_key", key: "not-a-secret" });
		expect(registry.refreshIfChanged()).toBe(false);
		expect(registry.getAvailable().length).toBeGreaterThan(before);
	});
});
