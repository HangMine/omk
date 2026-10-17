import { Type } from "typebox";
import { Value } from "typebox/value";
import type { Api, Model, ModelThinkingLevel, OpenAICompletionsCompat } from "../src/types.ts";
import { openCodeGoLegacyModels } from "./catalog-opencode-go-legacy.ts";

const BASE = "https://opencode.ai/inference/go";
const LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const OptionalNumber = Type.Optional(Type.Number({ minimum: 0 }));
const ModelSchema = Type.Object({
	id: Type.String({ pattern: "^[a-zA-Z0-9._-]+$" }),
	name: Type.String(),
	tool_call: Type.Boolean(),
	reasoning: Type.Optional(Type.Boolean()),
	reasoning_options: Type.Optional(
		Type.Array(Type.Object({ type: Type.String(), values: Type.Optional(Type.Array(Type.String())) })),
	),
	interleaved: Type.Optional(Type.Union([Type.Boolean(), Type.Object({ field: Type.String() })])),
	limit: Type.Object({ context: Type.Integer({ minimum: 1 }), output: Type.Integer({ minimum: 1 }) }),
	cost: Type.Optional(
		Type.Object({
			input: OptionalNumber,
			output: OptionalNumber,
			cache_read: OptionalNumber,
			cache_write: OptionalNumber,
		}),
	),
	modalities: Type.Optional(Type.Object({ input: Type.Array(Type.String()) })),
	provider: Type.Optional(Type.Object({ npm: Type.Optional(Type.String()), api: Type.Optional(Type.String()) })),
});
const ProviderSchema = Type.Object({ models: Type.Record(Type.String(), ModelSchema) });
const LiveSchema = Type.Object({
	data: Type.Array(Type.Object({ id: Type.String({ pattern: "^[a-zA-Z0-9._-]+$" }) }), { minItems: 1 }),
});

function thinkingMap(efforts: readonly string[], off = false): NonNullable<Model<Api>["thinkingLevelMap"]> {
	return Object.fromEntries(
		LEVELS.map((level) => [level, level === "off" ? (off ? "none" : null) : efforts.includes(level) ? level : null]),
	);
}

/** Route declarations override the generator's broad family rules, never the reverse. */
function applyGoThinking(model: Model<Api>, declared: readonly string[], toggle: boolean): void {
	if (!model.reasoning) return;
	if (model.api === "google-generative-ai") {
		model.thinkingLevelMap = thinkingMap(declared);
		for (const level of LEVELS) {
			const mapped = model.thinkingLevelMap[level];
			if (typeof mapped === "string") model.thinkingLevelMap[level] = mapped.toUpperCase();
		}
		return;
	}
	if (model.api === "anthropic-messages") {
		if (model.id === "claude-haiku-5-5") {
			model.thinkingLevelMap = thinkingMap(declared, true);
			model.compat = { forceAdaptiveThinking: true, supportsTemperature: false, supportsLongCacheRetention: false };
		} else {
			// These Go routes use token budgets, not Anthropic adaptive effort.
			model.thinkingLevelMap = thinkingMap(["minimal", "low", "medium", "high"], true);
			model.compat = { allowEmptySignature: true, supportsLongCacheRetention: false };
		}
		return;
	}
	if (model.api === "openai-responses") {
		model.thinkingLevelMap = thinkingMap(
			declared.filter((value) => value !== "none"),
			declared.includes("none"),
		);
		if (model.id.startsWith("muse-spark")) model.thinkingLevelMap.max = "xhigh";
		model.compat = { sendSessionIdHeader: false, supportsLongCacheRetention: false };
		return;
	}
	const compat: OpenAICompletionsCompat = {
		supportsStore: false,
		supportsDeveloperRole: false,
		supportsLongCacheRetention: false,
		supportsStrictMode: false,
		maxTokensField: "max_tokens",
		requiresReasoningContentOnAssistantMessages: true,
	};
	if (/^(?:mimo-|longcat-|kimi-k2\.6$|glm-5\.1$|qwen3\.6-plus$|qwen3\.7-max$)/.test(model.id)) {
		model.thinkingLevelMap = thinkingMap(["high"], true);
		compat.thinkingFormat = model.id.startsWith("qwen") ? "qwen" : "deepseek";
		compat.supportsReasoningEffort = false;
	} else if (model.id === "kimi-k2.7-code" || model.id.startsWith("minimax-m2")) {
		model.thinkingLevelMap = thinkingMap(["high"]);
		compat.supportsReasoningEffort = false;
	} else {
		model.thinkingLevelMap = thinkingMap(declared, toggle || declared.includes("none"));
		compat.supportsReasoningEffort = declared.length > 0;
		if (model.id.startsWith("deepseek")) {
			model.thinkingLevelMap.off = "none";
			compat.thinkingFormat = "deepseek";
		}
	}
	model.compat = compat;
}

/** Deterministic join: live IDs establish availability, models.dev supplies route metadata. */
export function buildOpenCodeGoModels(metadata: unknown, live: unknown): Model<Api>[] {
	if (!Value.Check(ProviderSchema, metadata)) throw new TypeError("Invalid OpenCode Go model metadata");
	if (!Value.Check(LiveSchema, live)) throw new TypeError("Invalid or empty OpenCode Go live model list");
	const legacy = new Map(openCodeGoLegacyModels().map((model) => [model.id, model]));
	const models: Model<Api>[] = [];
	const ids = new Set(live.data.map(({ id }) => id));
	for (const id of ids) {
		const source = metadata.models[id];
		let model: Model<Api>;
		if (source) {
			if (!source.tool_call) continue;
			const npm = source.provider?.npm;
			const api: Api =
				id === "minimax-m2.7"
					? "openai-completions"
					: npm === "@ai-sdk/openai"
						? "openai-responses"
						: npm === "@ai-sdk/anthropic"
							? "anthropic-messages"
							: npm === "@ai-sdk/google"
								? "google-generative-ai"
								: "openai-completions";
			model = {
				id,
				name: source.name,
				api,
				provider: "opencode-go",
				baseUrl:
					api === "anthropic-messages"
						? `${BASE}/anthropic`
						: api === "google-generative-ai"
							? `${BASE}/google/v1beta`
							: `${BASE}/openai/v1`,
				reasoning: source.reasoning === true,
				input: source.modalities?.input.includes("image") ? ["text", "image"] : ["text"],
				contextWindow: source.limit.context,
				maxTokens: source.limit.output,
				cost: {
					input: source.cost?.input ?? 0,
					output: source.cost?.output ?? 0,
					cacheRead: source.cost?.cache_read ?? 0,
					cacheWrite: source.cost?.cache_write ?? 0,
				},
			};
		} else {
			const fallback = legacy.get(id);
			if (!fallback) {
				console.warn(`OpenCode Go: skipping ${id}; no verified tool/limit metadata`);
				continue;
			}
			model = fallback;
		}
		const options = source?.reasoning_options ?? [];
		const efforts = options.find((option) => option.type === "effort")?.values ?? [];
		if (efforts.some((effort) => effort !== "none" && !LEVELS.some((level) => level === effort))) {
			throw new TypeError(`Unsupported OpenCode Go effort metadata for ${id}`);
		}
		applyGoThinking(
			model,
			id === "grok-4.6" ? ["low", "medium", "high", "xhigh"] : efforts,
			options.some((option) => option.type === "toggle"),
		);
		models.push(model);
	}
	if (!models.length) throw new Error("OpenCode Go returned no usable models");
	return models;
}

export async function fetchOpenCodeGoModels(): Promise<Model<Api>[]> {
	const metadataResponse = await fetch("https://models.dev/api.json", { signal: AbortSignal.timeout(30000) });
	if (!metadataResponse.ok) throw new Error(`models.dev HTTP ${metadataResponse.status}`);
	const catalog: unknown = await metadataResponse.json();
	if (typeof catalog !== "object" || catalog === null || !("opencode-go" in catalog))
		throw new TypeError("Missing OpenCode Go metadata");
	const liveResponse = await fetch(`${BASE}/v1/models`, { signal: AbortSignal.timeout(30000) });
	if (!liveResponse.ok) throw new Error(`OpenCode Go HTTP ${liveResponse.status}`);
	return buildOpenCodeGoModels(catalog["opencode-go"], await liveResponse.json());
}
