import { type ThinkingConfig, ThinkingLevel } from "@google/genai";

/** These Gemini models cannot fully disable thinking; use their lowest documented level without thought display. */
export function getDisabledThinkingConfig(model: { readonly id: string }): ThinkingConfig {
	const id = model.id.toLowerCase();
	if (/gemini-3(?:\.\d+)?-pro/.test(id) || /gemini-(?:3\.[78]-flash|4-argon)(?:-|$)/.test(id)) {
		return { thinkingLevel: ThinkingLevel.LOW };
	}
	if (/gemini-3(?:\.\d+)?-flash/.test(id) || /gemma-?4/.test(id)) {
		return { thinkingLevel: ThinkingLevel.MINIMAL };
	}
	return { thinkingBudget: 0 };
}
