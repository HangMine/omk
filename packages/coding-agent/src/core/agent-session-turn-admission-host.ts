/**
 * Turn-admission host for `AgentSession`, moved verbatim out of the constructor
 * (specs/agent-session-split, PR 1). Spec 104 phase 2 attaches the
 * `requiredTools` callback here.
 */
import type { Agent, AgentMessage } from "omk-agent-core";
import type { Api, Model } from "omk-ai";
import type { ExtensionRunner } from "./extensions/runner.ts";
import type { RequiredToolContract } from "./required-tools.ts";
import type { SessionManager } from "./session-manager.ts";
import { getLatestCompactionEntry } from "./session-manager.ts";
import type { SessionRunBudget } from "./session-run-budget.ts";
import { SessionTurnAdmission } from "./session-turn-admission.ts";
import type { SettingsManager } from "./settings-manager.ts";
import { mcpToolGroup } from "./tool-schema-budget.ts";

/** The `AgentSession` members the admission host reads, all read lazily at call time. */
export interface TurnAdmissionSession {
	readonly model: Model<Api> | undefined;
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;
	readonly _mcpToolNames: ReadonlySet<string>;
	readonly _runBudget: SessionRunBudget;
	readonly _extensionRunner: ExtensionRunner;
	_effectiveTurnContextWindow(pendingMessages: AgentMessage[], sessionWindow: number): number;
	_runThresholdCompaction(emergency: boolean): Promise<boolean>;
}

/** Supplies the current task segment's required-tool contract (spec 104 v1: the approved acceptance contract). */
export type RequiredToolSource = () => RequiredToolContract | undefined;

/**
 * Spec 104 phase 2: trusted host-side sources, keyed by session. Kept off `AgentSession`'s public
 * surface and out of extension reach; consulted only with `OMK_REQUIRED_TOOLS` on.
 */
const requiredToolSources = new WeakMap<object, RequiredToolSource>();

/** Set (or clear with `undefined`) the required-tool source of `session`; read at every fit. */
export function setRequiredToolSource(session: object, source: RequiredToolSource | undefined): void {
	if (source) requiredToolSources.set(session, source);
	else requiredToolSources.delete(session);
}

export function installTurnAdmission(session: TurnAdmissionSession): SessionTurnAdmission {
	// One tool selection serves admission and the admitted run: MCP servers the model's input
	// budget cannot carry are withheld per request, never removed from the active tool set.
	const turnAdmission = new SessionTurnAdmission({
		model: () => session.model,
		state: () => session.agent.state,
		contextWindow: (pending, window) => session._effectiveTurnContextWindow([...pending], window),
		compactionSettings: () => session.settingsManager.getCompactionSettings(),
		latestCompactionTimestamp: () => getLatestCompactionEntry(session.sessionManager.getBranch())?.timestamp,
		toolGroup: (name) => (session._mcpToolNames.has(name) ? mcpToolGroup(name) : undefined),
		compact: async () => {
			await session._runThresholdCompaction(true);
			session._runBudget.assertActive();
		},
		notify: (message) => session._extensionRunner.getUIContext().notify(message, "warning"),
		// Spec 104: ignored unless OMK_REQUIRED_TOOLS is on (SessionTurnAdmission checks the flag first).
		requiredTools: () => requiredToolSources.get(session)?.(),
	});
	session.agent.prepareTools = (tools, pending) => turnAdmission.fitTools(tools, pending);
	return turnAdmission;
}
