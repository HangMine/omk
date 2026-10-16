import { TUI } from "omk-tui";
import { ModelSelectorComponent } from "../modes/interactive/components/model-selector.ts";
import { AgentSession } from "./agent-session.ts";
import { enableDebugTiming, timingActive, timingEnd, wrapSpanMethod, wrapTimedMethod } from "./debug-timing.ts";
import { ExtensionRunner } from "./extensions/runner.ts";
import { ModelRegistry } from "./model-registry.ts";
import { PromptSkillFreeze } from "./prompt-skill-message.ts";
import { RunJournalStore } from "./run-journal-store.ts";
import { SessionManager } from "./session-manager.ts";
import { SessionTurnAdmission } from "./session-turn-admission.ts";
import { SettingsManager } from "./settings-manager.ts";

let installed = false;

/**
 * Spec 065: install timing wrappers on prototypes, only when `OMK_TIMING=1`. Wrappers call through unchanged;
 * when off this function returns before touching anything.
 */
export function installDebugTimingHooks(env: NodeJS.ProcessEnv = process.env): boolean {
	if (installed || !enableDebugTiming(env)) return installed;
	installed = true;
	const session = AgentSession.prototype;
	const registry = ModelRegistry.prototype;
	// /model open → first frame
	wrapSpanMethod(ModelSelectorComponent.prototype, "loadModels", "model.open", false);
	for (const m of ["refresh", "loadCustomModels", "loadBuiltInModels", "mergeCustomModels"])
		wrapTimedMethod(registry, m, "model.open", `registry.${m}`);
	wrapTimedMethod(registry, "getAvailable", "model.open", "auth.getAvailable");
	const doRender = (TUI.prototype as unknown as Record<string, unknown>).doRender as (...a: unknown[]) => unknown;
	(TUI.prototype as unknown as Record<string, unknown>).doRender = function (this: unknown, ...args: unknown[]) {
		const pending = timingActive("model.open");
		const t0 = performance.now();
		const result = doRender.apply(this, args);
		if (pending) timingEnd("model.open", `firstFrame(render=${(performance.now() - t0).toFixed(1)}ms)`);
		return result;
	};
	// model select apply
	wrapSpanMethod(session, "setModel", "model.apply", true);
	wrapTimedMethod(session, "_rebuildSystemPrompt", "model.apply", "rebuildSystemPrompt");
	wrapTimedMethod(SessionManager.prototype, "appendModelChange", "model.apply", "session.appendModelChange");
	wrapTimedMethod(SettingsManager.prototype, "setDefaultModelAndProvider", "model.apply", "settings.write");
	wrapTimedMethod(session, "_emitModelSelect", "model.apply", "extensions.modelSelect");
	// Enter → first request (ended in budget-stream.ts when the request leaves)
	wrapSpanMethod(session, "prompt", "enter", false);
	wrapTimedMethod(session, "_checkCompaction", "enter", "checkCompaction");
	wrapTimedMethod(PromptSkillFreeze.prototype, "turn", "enter", "skills.turn");
	wrapTimedMethod(ExtensionRunner.prototype, "emitBeforeAgentStart", "enter", "extensions.beforeAgentStart");
	wrapTimedMethod(session, "_checkProjectedCompaction", "enter", "checkProjectedCompaction");
	wrapTimedMethod(SessionTurnAdmission.prototype, "admit", "enter", "admit");
	wrapTimedMethod(SessionManager.prototype, "appendMessage", "enter", "session.appendMessage");
	wrapTimedMethod(RunJournalStore.prototype, "start", "enter", "journal.start");
	return true;
}
