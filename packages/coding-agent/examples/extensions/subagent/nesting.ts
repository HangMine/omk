/**
 * Subagent nesting guard. Every child omk process inherits the parent's
 * environment, and a child that loads this extension would otherwise get the
 * `subagent` tool again, so a lane could spawn lanes without bound. The parent
 * passes its depth + 1 to each child; a process at or past the max depth does
 * not register the tool. Max depth is 1: the top-level session can fan out, its
 * children cannot. Spec 071 loop guard rule 1 makes this fixed and always on, so
 * `OMK_SUBAGENT_MAX_DEPTH` is no longer read (it used to raise or lower the limit).
 */

export const SUBAGENT_DEPTH_ENV = "OMK_SUBAGENT_DEPTH";
export const DEFAULT_SUBAGENT_MAX_DEPTH = 1;

type Env = Readonly<Record<string, string | undefined>>;

function nonNegativeInt(value: string | undefined): number | undefined {
	if (value === undefined || !/^\s*\d+\s*$/.test(value)) return undefined;
	return Number.parseInt(value, 10);
}

export function currentSubagentDepth(env: Env): number {
	return nonNegativeInt(env[SUBAGENT_DEPTH_ENV]) ?? 0;
}

export function canSpawnSubagents(env: Env): boolean {
	return currentSubagentDepth(env) < DEFAULT_SUBAGENT_MAX_DEPTH;
}

export function childSubagentEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return { ...env, [SUBAGENT_DEPTH_ENV]: String(currentSubagentDepth(env) + 1) };
}
