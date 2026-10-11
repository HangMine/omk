/**
 * Applies the project trust gate (spec 053) to one runtime's SettingsManager before its
 * resources load. Kept out of main.ts so the CLI only wires it.
 */
import type { AgentSessionRuntimeDiagnostic } from "../core/agent-session-services.ts";
import {
	decideProjectTrust,
	describeProjectCodeSurface,
	formatEnvTrustNotice,
	type ProjectCodeSurface,
	type ProjectTrustAnswer,
	type ProjectTrustMode,
	projectTrustStorePath,
	recordProjectTrustDecision,
	rememberSessionTrust,
	TRUST_PROJECT_ENV,
} from "../core/project-trust.ts";
import type { SettingsManager } from "../core/settings-manager.ts";

export type { ProjectTrustAnswer };

export interface ProjectTrustGateOptions {
	readonly cwd: string;
	readonly settingsManager: SettingsManager;
	readonly mode: ProjectTrustMode;
	/** Ask the user; undefined when no prompt can be shown now (headless, or a TUI already runs). */
	readonly prompt?: (surface: ProjectCodeSurface, changed: boolean) => Promise<ProjectTrustAnswer>;
	readonly env?: NodeJS.ProcessEnv;
	readonly home?: string;
	readonly writeStderr?: (line: string) => void;
	/** Project paths already announced in this process (the env notice prints once per path). */
	readonly announced?: Set<string>;
}

const defaultAnnounced = new Set<string>();

/** The pre-TUI prompt, loaded only when a project actually needs a decision. */
export function interactiveProjectTrustPrompt(
	settingsManager: SettingsManager,
): (surface: ProjectCodeSurface, changed: boolean) => Promise<ProjectTrustAnswer> {
	return async (surface, changed) =>
		(await import("./project-trust-prompt.ts")).promptForProjectTrust(surface, changed, settingsManager);
}

function withheldDiagnostic(surface: ProjectCodeSurface, why: string): AgentSessionRuntimeDiagnostic {
	return {
		type: "warning",
		message: `Project code not loaded from ${surface.projectKey} (${describeProjectCodeSurface(surface)}): ${why}`,
	};
}

/** Decide, ask if needed, and close the gate on `settingsManager` unless the project is trusted. */
export async function applyProjectTrustGate(
	options: ProjectTrustGateOptions,
): Promise<AgentSessionRuntimeDiagnostic[]> {
	const home = options.home;
	const outcome = decideProjectTrust({
		cwd: options.cwd,
		projectSettings: options.settingsManager.getProjectSettings(),
		mode: options.mode,
		env: options.env,
		home,
	});
	if (outcome.kind === "no-project-code") return [];
	if (outcome.kind === "trusted") {
		rememberSessionTrust(outcome.surface);
		const announced = options.announced ?? defaultAnnounced;
		if (outcome.via === "env" && !announced.has(outcome.surface.projectKey)) {
			announced.add(outcome.surface.projectKey);
			(options.writeStderr ?? ((line) => process.stderr.write(line)))(
				`${formatEnvTrustNotice(outcome.surface.projectKey)}\n`,
			);
		}
		return [];
	}
	if (outcome.kind === "withheld") {
		options.settingsManager.withholdProjectCode();
		const why =
			outcome.reason === "headless"
				? `untrusted project in a non-interactive run; trust it once in interactive omk or set ${TRUST_PROJECT_ENV}=1`
				: outcome.reason === "env-off"
					? `${TRUST_PROJECT_ENV}=0 keeps project code off`
					: `you declined to trust this project; remove its entry from ${projectTrustStorePath(home)} to be asked again`;
		return [withheldDiagnostic(outcome.surface, why)];
	}
	const answer = options.prompt ? await options.prompt(outcome.surface, outcome.changed) : "dismiss";
	if (answer === "trust") {
		recordProjectTrustDecision(outcome.surface, "trusted", home);
		rememberSessionTrust(outcome.surface);
		return [];
	}
	options.settingsManager.withholdProjectCode();
	if (answer === "deny") {
		recordProjectTrustDecision(outcome.surface, "denied", home);
		return [withheldDiagnostic(outcome.surface, "you declined to trust this project")];
	}
	return [withheldDiagnostic(outcome.surface, "trust not decided yet; restart OMK in this project to answer")];
}
