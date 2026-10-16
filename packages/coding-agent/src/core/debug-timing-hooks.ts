import { TUI } from "omk-tui";
import { ModelSelectorComponent } from "../modes/interactive/components/model-selector.ts";
import { AgentSession } from "./agent-session.ts";
import {
	enableDebugTiming,
	type TimingSpanName,
	timingActive,
	timingEnd,
	wrapSpanMethod,
	wrapTimedMethod,
} from "./debug-timing.ts";
import { ExtensionRunner } from "./extensions/runner.ts";
import { ModelRegistry } from "./model-registry.ts";
import { PromptSkillFreeze } from "./prompt-skill-message.ts";
import { RunJournalStore } from "./run-journal-store.ts";
import { SessionManager } from "./session-manager.ts";
import { SessionTurnAdmission } from "./session-turn-admission.ts";
import { SettingsManager } from "./settings-manager.ts";

let installed = false;

type HookTarget = readonly [target: object, method: string, span: TimingSpanName, label?: string];

/** Every method wrapped below, by name. Exported so a test fails when a rename leaves a hook pointing at nothing. */
export function debugTimingHookTargets(): { spans: HookTarget[]; timed: HookTarget[]; render: HookTarget } {
	const session = AgentSession.prototype;
	const registry = ModelRegistry.prototype;
	return {
		spans: [
			[ModelSelectorComponent.prototype, "loadModels", "model.open"],
			[session, "setModel", "model.apply"],
			[session, "prompt", "enter"],
		],
		timed: [
			...["refresh", "loadCustomModels", "loadBuiltInModels", "mergeCustomModels"].map(
				(m): HookTarget => [registry, m, "model.open", `registry.${m}`],
			),
			[registry, "getAvailable", "model.open", "auth.getAvailable"],
			[session, "_rebuildSystemPrompt", "model.apply", "rebuildSystemPrompt"],
			[SessionManager.prototype, "appendModelChange", "model.apply", "session.appendModelChange"],
			[SettingsManager.prototype, "setDefaultModelAndProvider", "model.apply", "settings.write"],
			[session, "_emitModelSelect", "model.apply", "extensions.modelSelect"],
			[session, "_checkCompaction", "enter", "checkCompaction"],
			[PromptSkillFreeze.prototype, "turn", "enter", "skills.turn"],
			[ExtensionRunner.prototype, "emitBeforeAgentStart", "enter", "extensions.beforeAgentStart"],
			[session, "_checkProjectedCompaction", "enter", "checkProjectedCompaction"],
			[SessionTurnAdmission.prototype, "admit", "enter", "admit"],
			[SessionManager.prototype, "appendMessage", "enter", "session.appendMessage"],
			[RunJournalStore.prototype, "start", "enter", "journal.start"],
		],
		render: [TUI.prototype, "doRender", "model.open"],
	};
}

/**
 * Spec 065: install timing wrappers on prototypes, only when `OMK_TIMING=1`. Wrappers call through unchanged;
 * when off this function returns before touching anything.
 */
export function installDebugTimingHooks(env: NodeJS.ProcessEnv = process.env): boolean {
	if (installed || !enableDebugTiming(env)) return installed;
	installed = true;
	const { spans, timed } = debugTimingHookTargets();
	const endsOnReturn: Record<string, boolean> = { loadModels: false, setModel: true, prompt: false };
	for (const [target, method, span] of spans) wrapSpanMethod(target, method, span, endsOnReturn[method] ?? false);
	for (const [target, method, span, label] of timed) wrapTimedMethod(target, method, span, label);
	// /model open → first frame
	const doRender = (TUI.prototype as unknown as Record<string, unknown>).doRender as (...a: unknown[]) => unknown;
	(TUI.prototype as unknown as Record<string, unknown>).doRender = function (this: unknown, ...args: unknown[]) {
		const pending = timingActive("model.open");
		const t0 = performance.now();
		const result = doRender.apply(this, args);
		if (pending) timingEnd("model.open", `firstFrame(render=${(performance.now() - t0).toFixed(1)}ms)`);
		return result;
	};
	// "enter" is ended in budget-stream.ts when the request leaves.
	return true;
}
