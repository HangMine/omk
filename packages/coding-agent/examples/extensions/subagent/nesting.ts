/**
 * Subagent nesting guard. Every child omk process inherits the parent's
 * environment, and a child that loads this extension would otherwise get the
 * `subagent` tool again, so a lane could spawn lanes without bound. The parent
 * passes its depth + 1 to each child; a process at or past the max depth does
 * not register the tool. Spec 071 loop guard rule 1: max depth =
 * min(`OMK_SUBAGENT_MAX_DEPTH`, 1). Unset or invalid → 1 (the top-level session
 * can fan out, its children cannot); `0` disables spawning; values > 1 clamp to 1.
 */

export const SUBAGENT_DEPTH_ENV = "OMK_SUBAGENT_DEPTH";
export const SUBAGENT_MAX_DEPTH_ENV = "OMK_SUBAGENT_MAX_DEPTH";
/** Hard ceiling (spec 071 rule 1): the env var can only lower it. */
export const DEFAULT_SUBAGENT_MAX_DEPTH = 1;

type Env = Readonly<Record<string, string | undefined>>;

function nonNegativeInt(value: string | undefined): number | undefined {
	if (value === undefined || !/^\s*\d+\s*$/.test(value)) return undefined;
	return Number.parseInt(value, 10);
}

export function currentSubagentDepth(env: Env): number {
	return nonNegativeInt(env[SUBAGENT_DEPTH_ENV]) ?? 0;
}

export function maxSubagentDepth(env: Env): number {
	return Math.min(
		nonNegativeInt(env[SUBAGENT_MAX_DEPTH_ENV]) ?? DEFAULT_SUBAGENT_MAX_DEPTH,
		DEFAULT_SUBAGENT_MAX_DEPTH,
	);
}

export function canSpawnSubagents(env: Env): boolean {
	return currentSubagentDepth(env) < maxSubagentDepth(env);
}

export function childSubagentEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return { ...env, [SUBAGENT_DEPTH_ENV]: String(currentSubagentDepth(env) + 1) };
}
