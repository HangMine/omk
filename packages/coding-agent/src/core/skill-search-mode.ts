/**
 * Spec 050 R1/R2: whether a session runs in skill-search mode, and the fixed `skill_search` tool.
 *
 * This module is on the startup path, so it stays small: the index, BM25 ranking and run-log records live
 * in `skill-search.ts`, which is imported only on the first search or candidate computation (R5, AC 3).
 */
import type { Skill } from "./skills.ts";
import { SKILL_PROMPT_COMPACT_THRESHOLD } from "./skills-prompt.ts";

export const SKILL_SEARCH_ENV = "OMK_SKILL_SEARCH";
/** Workers set this to 0 (R7): no automatic candidate messages, `skill_search` still works. */
export const SKILL_SEARCH_SUGGEST_ENV = "OMK_SKILL_SEARCH_SUGGEST";
export const SKILL_SEARCH_TOOL_NAME = "skill_search";
export const SKILL_SEARCH_DEFAULT_LIMIT = 5;
export const SKILL_SEARCH_MAX_LIMIT = 8;
export const SKILL_SEARCH_MAX_QUERY = 512;

/** The one system-prompt line that replaces `<available_skills>` in skill-search mode. Constant by design. */
export const SKILL_SEARCH_PROMPT_LINE =
	"\n\nSkills (specialized instructions for specific tasks) are not listed here. Find them with the skill_search tool, then use the read tool on a skill's location before applying it. Relevant skill candidates may also arrive as messages during the conversation.";

export type SkillSearchInactiveReason = "flag_off" | "few_skills" | "no_read_tool" | "none";

export interface SkillSearchActivation {
	readonly active: boolean;
	readonly inactiveReason: SkillSearchInactiveReason;
}

const ON_VALUES = new Set(["on", "1", "true", "enable", "enabled"]);

export function skillSearchFlagOn(env: NodeJS.ProcessEnv): boolean {
	return ON_VALUES.has(env[SKILL_SEARCH_ENV]?.trim().toLowerCase() ?? "");
}

export function skillSearchSuggestOn(env: NodeJS.ProcessEnv): boolean {
	const raw = env[SKILL_SEARCH_SUGGEST_ENV]?.trim().toLowerCase();
	return !(raw === "0" || raw === "false" || raw === "off" || raw === "no");
}

/** R1: on, more than 24 model-invocable skills at session start, and a `read` tool. */
export function skillSearchActivation(
	env: NodeJS.ProcessEnv,
	skills: readonly Skill[],
	hasReadTool: boolean,
): SkillSearchActivation {
	if (!skillSearchFlagOn(env)) return { active: false, inactiveReason: "flag_off" };
	if (!hasReadTool) return { active: false, inactiveReason: "no_read_tool" };
	const invocable = skills.filter((skill) => !skill.disableModelInvocation).length;
	if (invocable <= SKILL_PROMPT_COMPACT_THRESHOLD) return { active: false, inactiveReason: "few_skills" };
	return { active: true, inactiveReason: "none" };
}
