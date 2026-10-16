export type ContextBudgetTokenCountMethod = "exact" | "estimated";
export type ContextBudgetTokenConfidence = "high" | "medium" | "low";
export type ContextBudgetTokenizerMode = "auto" | "fallback" | "openai-js" | "openai-wasm";

export interface TokenCountResult {
	readonly tokens: number;
	readonly method: ContextBudgetTokenCountMethod;
	readonly confidence: ContextBudgetTokenConfidence;
	readonly adapterId: string;
	readonly modelId: string;
	readonly notes: readonly string[];
}

export interface TokenCounterAdapter {
	readonly id: string;
	readonly priority: number;
	isAvailable(): boolean;
	supports(modelId: string): boolean;
	countText(input: string, modelId: string): TokenCountResult;
	/** Optional: the result of `countText(parts.join(""), modelId)` without building the joined text. */
	countTextParts?(parts: readonly string[], modelId: string): TokenCountResult;
	/**
	 * Optional: same result as `countTextParts`, reading cached per-part statistics where `statsAt` has them.
	 * Only adapters whose count is a pure sum of per-part statistics implement it (the fallback estimator).
	 */
	countTextPartsWithStats?(parts: readonly string[], statsAt: TextPartStatsAt, modelId: string): TokenCountResult;
}

/** Character-class statistics of one text part; the fallback estimate of a joined text is a function of their sum. */
export interface TextPartStats {
	readonly asciiWord: number;
	readonly whitespace: number;
	readonly cjk: number;
	readonly hangul: number;
	readonly kana: number;
	readonly emojiOrWide: number;
	readonly punctuation: number;
	readonly other: number;
	readonly length: number;
	readonly keyword: boolean;
}

/** Cached statistics for `parts[index]`, or undefined when the caller has none for that part. */
export type TextPartStatsAt = (index: number) => TextPartStats | undefined;

export interface OptionalModuleLoader {
	resolve(specifier: string): string | undefined;
	load(specifier: string): unknown;
}

export interface TokenCounterRegistryOptions {
	readonly adapters?: readonly TokenCounterAdapter[];
	readonly fallback?: TokenCounterAdapter;
}
