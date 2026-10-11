import { execFile } from "node:child_process";
import type { AgentSession } from "../../../core/agent-session.ts";
import { getHeadroomRuntimeStatus } from "../../../core/context-budget-headroom.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import { loadMcpInventory, type McpServerEntry } from "../../../core/mcp-inventory.ts";
import type { SessionManager } from "../../../core/session-manager.ts";
import { getCurrentTodoState } from "../../../core/todo-runtime-state.ts";
import { readControlPlaneSignals } from "../control-plane-signals.ts";
import { buildControlPlaneViewModel } from "../control-plane-view-model.ts";
import type { ControlPanelStatusSnapshot } from "./control-panel-layout.ts";
import { formatCwdForFooter } from "./footer.ts";

const OMK_HUB_SKILL_NAMES = new Set([
	"omk-skills",
	"omk-engineering",
	"omk-backend-data",
	"omk-security",
	"omk-devops-release",
	"omk-research-docs",
	"omk-design-media",
	"omk-agent-ops",
	"omk-product-ops",
	"omk-workspace-ops",
	"omk-frontend",
	"omk-loop",
	"omk-plan",
]);

const INVALID_MCP_NETWORK_RULES = new Set(["mcp.network.invalid_mode", "mcp.network.empty_allowlist"]);
const PRIVILEGED_MCP_COMMANDS = new Set(["sudo", "su"]);
const VERSION_COMMAND_TIMEOUT_MS = 750;
const HEADROOM_PYTHON_DISTRIBUTIONS = ["headroom", "headroom-ai"] as const;

let cachedHeadroomVersion: string | null | undefined;
let headroomVersionProbe: Promise<string | null> | undefined;
let headroomVersionProbeAbort: AbortController | undefined;
let headroomVersionProbeEnabledOverride: boolean | undefined;

interface McpStabilityInput {
	readonly commandSummary: string;
	readonly overriddenBy?: string;
	readonly networkDecision: Pick<McpServerEntry["networkDecision"], "rule">;
	readonly capabilityDecision: Pick<McpServerEntry["capabilityDecision"], "malformed" | "unknownCapabilities">;
	readonly authDecision: Pick<McpServerEntry["authDecision"], "rule">;
}

/**
 * Render-path label. Never spawns synchronously: before the version probe settles it starts the probe
 * (once, without waiting) and shows the same policy-id fallback as "headroom not installed".
 */
export function formatHeadroomStatusLabel(): string {
	if (cachedHeadroomVersion === undefined) void loadHeadroomVersion();
	return cachedHeadroomVersion ? `headroom:${cachedHeadroomVersion}` : getHeadroomRuntimeStatus().policyId;
}

/** Probe the installed headroom version once per process, off the render path; callers share the result. */
export function loadHeadroomVersion(): Promise<string | null> {
	if (headroomVersionProbe) return headroomVersionProbe;
	// Test runners (VITEST) never spawn the real `headroom`/`python3` unless a test opts in, like the skills catalog cache.
	if (!(headroomVersionProbeEnabledOverride ?? process.env.VITEST !== "true")) {
		cachedHeadroomVersion = null;
		headroomVersionProbe = Promise.resolve(null);
		return headroomVersionProbe;
	}
	const abort = new AbortController();
	headroomVersionProbeAbort = abort;
	headroomVersionProbe = probeInstalledHeadroomVersion(abort.signal).then((version) => {
		cachedHeadroomVersion = version;
		if (headroomVersionProbeAbort === abort) headroomVersionProbeAbort = undefined;
		return version;
	});
	return headroomVersionProbe;
}

/** Repaint exactly once if the probe finds a version; a missing or aborted headroom needs no repaint. */
export function repaintWhenHeadroomVersionResolves(requestRender: () => void): Promise<void> {
	return loadHeadroomVersion().then((version) => {
		if (version) requestRender();
	});
}

/**
 * Kill a probe that is still running (shutdown). The pending probe settles to `null` and is cached,
 * so a hung `headroom` cannot hold shutdown or outlive the process, and nothing restarts it.
 */
export function abortHeadroomVersionProbe(): void {
	headroomVersionProbeAbort?.abort();
	headroomVersionProbeAbort = undefined;
}

/** Tests only: `true` lets a test run the probe under VITEST, `undefined` restores the default. */
export function setHeadroomVersionProbeEnabledForTests(enabled: boolean | undefined): void {
	headroomVersionProbeEnabledOverride = enabled;
}

export function countRoutableNonHubSkills(skills: readonly { readonly name: string }[]): number {
	return skills.filter((skill) => !OMK_HUB_SKILL_NAMES.has(skill.name)).length;
}

export function countStableMcpServers(entries: readonly McpStabilityInput[]): number {
	return entries.filter((entry) => classifyMcpStability(entry) === "stable").length;
}

/**
 * Classify a single MCP server entry for status display.
 *
 * - `stable`: configured, healthy, and safe to surface as an active server.
 * - `overridden`: a higher-precedence source replaced this entry.
 * - `unstable`: malformed, privileged, or blocked by an auth/network policy.
 */
export type McpStability = "stable" | "overridden" | "unstable";

export function classifyMcpStability(entry: McpStabilityInput): McpStability {
	if (entry.overriddenBy) return "overridden";
	if (entry.commandSummary === "<unknown>") return "unstable";
	if (entry.authDecision.rule === "mcp.auth.invalid") return "unstable";
	if (INVALID_MCP_NETWORK_RULES.has(entry.networkDecision.rule)) return "unstable";
	if (entry.capabilityDecision.malformed || entry.capabilityDecision.unknownCapabilities.length > 0) return "unstable";
	const command = entry.commandSummary.split(/\s+/, 1)[0] ?? "";
	if (PRIVILEGED_MCP_COMMANDS.has(command)) return "unstable";
	return "stable";
}

async function probeInstalledHeadroomVersion(signal: AbortSignal): Promise<string | null> {
	const version =
		(await readVersionFromCommand("headroom", ["--version"], signal)) ??
		(await readVersionFromCommand("headroom", ["version"], signal));
	if (version) return version;
	for (const distribution of HEADROOM_PYTHON_DISTRIBUTIONS) {
		const pythonVersion = await readPythonDistributionVersion(distribution, signal);
		if (pythonVersion) return pythonVersion;
	}
	return null;
}

function readPythonDistributionVersion(
	distribution: (typeof HEADROOM_PYTHON_DISTRIBUTIONS)[number],
	signal: AbortSignal,
): Promise<string | null> {
	return readVersionFromCommand(
		"python3",
		["-c", `import importlib.metadata as m; print(m.version('${distribution}'))`],
		signal,
	);
}

function readVersionFromCommand(command: string, args: readonly string[], signal: AbortSignal): Promise<string | null> {
	// After an abort, start nothing new: the remaining fallbacks resolve to null without spawning.
	if (signal.aborted) return Promise.resolve(null);
	return new Promise((resolve) => {
		try {
			execFile(
				command,
				[...args],
				{
					encoding: "utf8",
					timeout: VERSION_COMMAND_TIMEOUT_MS,
					shell: false,
					windowsHide: true,
					env: { PATH: process.env.PATH ?? "" },
					signal,
				},
				(error, stdout, stderr) => {
					resolve(error || signal.aborted ? null : parseHeadroomVersionOutput(`${stdout}\n${stderr}`));
				},
			);
		} catch {
			resolve(null);
		}
	});
}

export function parseHeadroomVersionOutput(output: string): string | null {
	const match = /\bv?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)\b/.exec(output);
	return match?.[1] ?? null;
}

export function createControlPanelStatusSnapshot(
	session: AgentSession,
	sessionManager: SessionManager,
	footerData?: ReadonlyFooterDataProvider,
): ControlPanelStatusSnapshot {
	// One read of the live signals per snapshot: context usage walks the session branch, so the
	// CTX fields and the view model share this read instead of calling getContextUsage() again.
	const signals = readControlPlaneSignals(session, footerData, session.state.model?.contextWindow ?? 0);
	const mcpInventory = loadMcpInventory(sessionManager.getCwd());
	const loadedSkills = session.resourceLoader.getSkills().skills;
	const ansiColorState = process.env.NO_COLOR ? "off" : "on";
	const cwdLabel = formatCwdForFooter(sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);
	return {
		modelId: session.state.model?.id,
		modelProvider: session.state.model?.provider,
		thinkingLevel: session.state.thinkingLevel ?? "off",
		contextPercent: signals.contextPercent ?? null,
		contextWindowTokens: signals.contextWindowTokens ?? 0,
		headroomStatus: formatHeadroomStatusLabel(),
		optimizerPolicy: getHeadroomRuntimeStatus().selector,
		mcpCount: countStableMcpServers(mcpInventory.entries),
		skillCount: countRoutableNonHubSkills(loadedSkills),
		cwdLabel,
		gitBranch: footerData?.getGitBranch(),
		todoState: getCurrentTodoState(),
		ansiColorState,
		// Authority state is read from the live session each render, never asserted here.
		controlPlane: buildControlPlaneViewModel(signals),
	};
}
