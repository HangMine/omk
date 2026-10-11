/**
 * Spec 050 R6: keep per-prompt skill choices out of the system prompt after the first user prompt.
 *
 * The first user prompt of a session renders its skill choices into the system prompt exactly as before
 * (provider harness picks, explicit `!skill`, the contextBudget skill ranking), so a single `-p` request
 * is byte-identical to the pre-050 request. That choice is then frozen for the session. From the second
 * prompt on, the system prompt is rebuilt from the frozen choice and the prompt's own choice is sent as
 * one custom message after the user message, so the cacheable system prefix stays stable.
 */

import { createHash } from "node:crypto";
import type { Context } from "omk-ai";
import { getAgentDir } from "../config.ts";
import { type ActiveSkillState, addActiveSkills } from "./active-skill-state.ts";
import { scoreSkillRelevance } from "./context-budget-relevance.ts";
import { escapeXml } from "./context-budget-system-prompt-items.ts";
import { devinHarnessAutoApplyEnabled, isDevinProvider, selectDevinHarnessSkills } from "./devin-harness.ts";
import { grokHarnessAutoApplyEnabled, isGrokOAuthProvider, selectGrokHarnessSkills } from "./grok-harness.ts";
import type { CustomMessage } from "./messages.ts";
import { appendRunLog, RUN_LOG_DIR_ENV } from "./run-log.ts";
import type { SkillSearchSession } from "./skill-search.ts";
import { type SkillSearchActivation, skillSearchActivation, skillSearchSuggestOn } from "./skill-search-mode.ts";
import type { Skill } from "./skills.ts";
import { compactSkillDescription } from "./skills-prompt.ts";
import type { BuildSystemPromptOptions } from "./system-prompt.ts";
import { createSkillSearchToolDefinition } from "./tools/skill-search-tool.ts";

export const PROMPT_SKILLS_CUSTOM_TYPE = "prompt-skills";
/** Most relevant skills listed in the message when contextBudget is on (the system list keeps the first ranking). */
export const PROMPT_SKILLS_RELEVANT_LIMIT = 5;

export interface PromptSkillTurnInput {
	readonly base: BuildSystemPromptOptions;
	readonly provider: string | undefined;
	/** Settings defaults, caller-provided names and explicit `!skill` names for this prompt. */
	readonly selection: ActiveSkillState;
	/** The operator's `defaultActiveSkills` (already in `selection`); a change re-freezes like a rebuilt base. */
	readonly defaults: readonly string[];
	readonly skills: readonly Skill[];
	/** Text the provider harness ranks (the raw `!skill` text for bang invocations, as before). */
	readonly harnessQuery: string;
	/** Expanded prompt text, the contextBudget query. */
	readonly budgetQuery: string;
	readonly contextPressure: () => boolean;
	readonly contextBudget: (query: string) => BuildSystemPromptOptions["contextBudget"];
	readonly env?: NodeJS.ProcessEnv;
	readonly now?: () => number;
}

export interface PromptSkillTurn {
	readonly options: BuildSystemPromptOptions;
	/** Sent right after the user message (empty on the first prompt). */
	readonly messages: readonly CustomMessage[];
}

interface FrozenChoice {
	/** The base options the choice was frozen against; a rebuilt base (tools, model, settings, reload) re-freezes. */
	readonly base: BuildSystemPromptOptions;
	readonly defaults: readonly string[];
	readonly names: readonly string[];
	readonly source: string | undefined;
	readonly budgetQuery: string;
}

type HarnessSource = "grok-harness" | "devin-harness";

export interface SkillSearchSetup {
	/** The loaded skills; read again on each search so `/reload` is picked up (the mode itself stays). */
	readonly skills: () => readonly Skill[];
	readonly hasReadTool: boolean;
	readonly agentDir?: string;
	readonly env?: NodeJS.ProcessEnv;
}

/**
 * One per session: the first `turn()` freezes the skill choice that later system prompts are built from.
 * When the session rebuilds its base system prompt (tool, model or settings change, `/reload`) or the
 * operator's default active skills change, the system prompt changes anyway, so the next prompt's choice is
 * frozen again instead of sent as a message. A skill-search session (spec 050 AC 2) keeps its choice across a
 * base rebuild, so a `/reload` with the same resources rebuilds the same system prompt.
 */
export class PromptSkillFreeze {
	private frozen: FrozenChoice | undefined;
	private activation: SkillSearchActivation = { active: false, inactiveReason: "flag_off" };
	private setup: SkillSearchSetup | undefined;
	private searchSession: Promise<SkillSearchSession> | undefined;
	private sessionLogged = false;

	/**
	 * Spec 050 R1/R2, at session start: decide the skill-search mode once and add the fixed `skill_search`
	 * tool when it is on. Off or inactive returns the tools unchanged and loads nothing.
	 */
	withSkillSearchTool<T>(tools: readonly T[], setup: SkillSearchSetup): T[] {
		this.setup = setup;
		this.activation = skillSearchActivation(setup.env ?? process.env, setup.skills(), setup.hasReadTool);
		if (!this.activation.active) return [...tools];
		const tool = createSkillSearchToolDefinition(async (query, limit) => (await this.search()).search(query, limit));
		return [...tools, tool as T];
	}

	/** R8 `session` record, once, after the first system prompt is set. Hashes only; nothing without a log dir. */
	async logSession(context: Pick<Context, "systemPrompt" | "tools">): Promise<void> {
		const env = this.setup?.env ?? process.env;
		if (this.sessionLogged || !env[RUN_LOG_DIR_ENV]?.trim()) return;
		this.sessionLogged = true;
		const { systemHash, toolsHash } = await import("omk-ai/prompt-hash");
		const record = {
			type: "session",
			active: this.activation.active,
			inactiveReason: this.activation.inactiveReason,
			systemHash: systemHash(context),
			toolsHash: toolsHash(context),
		};
		appendRunLog("skill-select", record, { env });
	}

	/** R3 task start: the R6 plan plus, in an active session, one candidate message (not in workers, R7). */
	async turn(input: PromptSkillTurnInput): Promise<PromptSkillTurn> {
		const plan = this.planTurn(input);
		if (!this.activation.active || !skillSearchSuggestOn(input.env ?? process.env)) return plan;
		const candidates = (await this.search()).suggest(input.budgetQuery);
		return candidates ? { ...plan, messages: [...plan.messages, candidates] } : plan;
	}

	/** First search or candidate computation imports the index module (never on the startup path, R5). */
	private search(): Promise<SkillSearchSession> {
		const setup = this.setup;
		if (!setup) return Promise.reject(new Error("skill search is not set up"));
		this.searchSession ??= import("./skill-search.ts").then(
			({ SkillSearchSession }) =>
				new SkillSearchSession({
					skills: setup.skills,
					agentDir: setup.agentDir ?? getAgentDir(),
					env: setup.env ?? process.env,
				}),
		);
		return this.searchSession;
	}

	private planTurn(input: PromptSkillTurnInput): PromptSkillTurn {
		const env = input.env ?? process.env;
		const harness = selectProviderHarnessSkills(input, env);
		const current = harness ? addActiveSkills(input.selection, harness.names, harness.source) : input.selection;
		const keep =
			this.frozen !== undefined &&
			(this.frozen.base === input.base || this.activation.active) &&
			sameNames(this.frozen.defaults, input.defaults);
		const frozen: FrozenChoice =
			keep && this.frozen
				? { ...this.frozen, base: input.base }
				: {
						base: input.base,
						defaults: input.defaults,
						names: current.names,
						source: current.source,
						budgetQuery: input.budgetQuery,
					};
		const first = !keep;
		this.frozen = frozen;
		const options: BuildSystemPromptOptions = {
			...input.base,
			contextBudget: input.contextBudget(frozen.budgetQuery),
			activeSkillNames: frozen.names,
			activeSkillSource: frozen.source,
		};
		if (first) return { options, messages: [] };
		const activeChanged = !sameChoice(frozen, current);
		// In skill-search mode the budget renders no skill list, so there is nothing to supersede (R6).
		const relevant =
			budgetSkillsVisible(input.base) && !this.activation.active
				? relevantSkills(input.skills, input.budgetQuery, current.names)
				: [];
		if (!activeChanged && relevant.length === 0) return { options, messages: [] };
		const active = activeChanged ? resolveSkills(input.skills, current.names) : undefined;
		if (active) logMove(harness?.source ?? "explicit", active, env);
		if (relevant.length > 0) logMove("context-budget", relevant, env);
		const message: CustomMessage = {
			role: "custom",
			customType: PROMPT_SKILLS_CUSTOM_TYPE,
			content: renderPromptSkillsMessage(active, current.source ?? harness?.source, relevant),
			display: false,
			timestamp: (input.now ?? Date.now)(),
		};
		return { options, messages: [message] };
	}
}

function selectProviderHarnessSkills(
	input: PromptSkillTurnInput,
	env: NodeJS.ProcessEnv,
): { names: readonly string[]; source: HarnessSource } | undefined {
	if (isGrokOAuthProvider(input.provider) && grokHarnessAutoApplyEnabled(env)) {
		const options = { contextPressure: input.contextPressure() };
		return { names: selectGrokHarnessSkills(input.harnessQuery, input.skills, options), source: "grok-harness" };
	}
	if (isDevinProvider(input.provider) && devinHarnessAutoApplyEnabled(env)) {
		const options = { contextPressure: input.contextPressure() };
		return { names: selectDevinHarnessSkills(input.harnessQuery, input.skills, options), source: "devin-harness" };
	}
	return undefined;
}

function sameChoice(frozen: FrozenChoice, current: ActiveSkillState): boolean {
	return frozen.source === current.source && sameNames(frozen.names, current.names);
}

function sameNames(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((name, i) => b[i] === name);
}

/** contextBudget renders a skill list only when it is on and the session has the `read` tool. */
function budgetSkillsVisible(base: BuildSystemPromptOptions): boolean {
	return base.contextBudget !== undefined && (!base.selectedTools || base.selectedTools.includes("read"));
}

function relevantSkills(skills: readonly Skill[], query: string, activeNames: readonly string[]): Skill[] {
	if (query.trim() === "") return [];
	const active = new Set(activeNames);
	return skills
		.filter((skill) => !skill.disableModelInvocation && !active.has(skill.name))
		.map((skill, index) => ({ skill, index, score: scoreSkillRelevance(skill, query) }))
		.filter((entry) => entry.score > 0)
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.slice(0, PROMPT_SKILLS_RELEVANT_LIMIT)
		.map((entry) => entry.skill);
}

function resolveSkills(skills: readonly Skill[], names: readonly string[]): Skill[] {
	const byName = new Map(skills.map((skill) => [skill.name, skill]));
	return names.map((name) => byName.get(name)).filter((skill): skill is Skill => skill !== undefined);
}

/**
 * Fixed layout. `active` (when the prompt's active set differs from the frozen one) uses the same entry
 * rules as the system prompt's `<active_skills>`; an empty list means none of them apply to this prompt.
 */
export function renderPromptSkillsMessage(
	active: readonly Skill[] | undefined,
	source: string | undefined,
	relevant: readonly Skill[],
): string {
	const lines = [
		"<prompt_skills>",
		"Skills for this prompt. They take precedence over the <active_skills> and <available_skills> choices in the system prompt, which were made for the first prompt of this session. Apply only when relevant and read full instructions before use.",
	];
	if (active) {
		lines.push(`<active_skills source="${escapeXml(source ?? "prompt")}">`);
		if (active.length === 0) lines.push("No skills are active for this prompt.");
		for (const skill of active) {
			lines.push(`  <name>${escapeXml(skill.name)}</name>`);
			if (skill.disableModelInvocation) lines.push(`  <location>${escapeXml(skill.filePath)}</location>`);
		}
		lines.push("</active_skills>");
	}
	if (relevant.length > 0) {
		lines.push("<relevant_skills>");
		for (const skill of relevant) {
			lines.push(
				"  <skill>",
				`    <name>${escapeXml(skill.name)}</name>`,
				`    <description>${escapeXml(compactSkillDescription(skill.description))}</description>`,
				`    <location>${escapeXml(skill.filePath)}</location>`,
				"  </skill>",
			);
		}
		lines.push("</relevant_skills>");
	}
	lines.push("</prompt_skills>");
	return lines.join("\n");
}

/** Spec 050 R8 `harness-move`: hashes and counts only. */
function logMove(
	source: HarnessSource | "explicit" | "context-budget",
	skills: readonly Skill[],
	env: NodeJS.ProcessEnv,
) {
	appendRunLog(
		"skill-select",
		{ type: "harness-move", source, k: skills.length, skillHashes: skills.map((skill) => shortHash(skill.name)) },
		{ env },
	);
}

export function shortHash(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
}
