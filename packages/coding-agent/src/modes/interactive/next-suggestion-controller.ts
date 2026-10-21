/**
 * Spec 091 stage 1 UI: gray next-task suggestion in the empty editor.
 *
 * Installed only when `OMK_NEXT_SUGGESTIONS` is on; otherwise
 * {@link installNextSuggestions} returns without touching the session or the
 * editor. Tab inserts the suggestion into an empty editor (never sends); any
 * other key dismisses it and cancels a pending generation. A result that
 * arrives after the user typed or sent the next turn is discarded.
 */
import type { StreamFn } from "omk-agent-core";
import type { AssistantMessage } from "omk-ai";
import { getKeybindings } from "omk-tui";
import type { AgentSession } from "../../core/agent-session.ts";
import {
	isNextSuggestionsEnabled,
	MainRequestRecorder,
	planSuggestion,
	type QuotaUsage,
	requestNextSuggestion,
	type SuggestionPlan,
	USAGE_CHECK_TIMEOUT_MS,
} from "../../core/next-suggestion.ts";
import {
	dismissReasonForKey,
	type SuggestionAcceptTracker,
	suggestionAcceptTracker,
	traceQueuedDispatch,
	userMessageText,
} from "../../core/next-suggestion-accept-trace.ts";
import {
	isSuggestionCapsEnabled,
	type SuggestionBudget,
	suggestionBudgetFromEnv,
} from "../../core/next-suggestion-budget.ts";
import * as settlement from "../../core/next-suggestion-settlement.ts";
import { loadSubscriptionUsage } from "../../core/provider-usage.ts";
import { type ActiveEditor, followActiveEditor, type SuggestionEditorPort } from "./suggestion-active-editor.ts";

export interface SuggestionSessionPort {
	readonly agent: { streamFn: StreamFn; readonly state: { readonly messages: readonly unknown[] } };
	readonly model: { readonly provider: string; readonly id: string } | undefined;
	subscribe(
		listener: (event: { readonly type: string; readonly outcome?: string; readonly message?: unknown }) => unknown,
	): () => void;
}

export interface NextSuggestionOptions {
	readonly env?: NodeJS.ProcessEnv;
	readonly now?: () => number;
	readonly isTab?: (data: string) => boolean;
	/** Quota usage for the 90% rule; called at most once per settled turn, only with the flag on. */
	readonly quotaUsage?: () => Promise<QuotaUsage>;
	readonly usageTimeoutMs?: number;
	readonly requestRender?: () => void;
	readonly onPlan?: (plan: SuggestionPlan) => void;
	/** Spec 103: settle every suggestion request's usage, including discarded and cancelled ones. */
	readonly settle?: (s: settlement.AnySuggestionSettlement) => void;
	/** Accept-trace sink (`OMK_NEXT_SUGGESTIONS_ACCEPT_TRACE`); absent ⇒ nothing recorded, behavior unchanged. */
	readonly acceptTrace?: SuggestionAcceptTracker;
	/** Spec 103 caps budget (caps flag only); defaults to the env budget. */
	readonly budget?: SuggestionBudget;
	readonly timeoutSignal?: (ms: number) => AbortSignal;
}

function lastAssistant(messages: readonly unknown[]): AssistantMessage | undefined {
	const last = messages.at(-1) as { role?: string } | undefined;
	return last?.role === "assistant" ? (last as AssistantMessage) : undefined;
}

export class NextSuggestionController {
	private readonly session: SuggestionSessionPort;
	private readonly editor: SuggestionEditorPort;
	private readonly basePlaceholder: string;
	private readonly options: NextSuggestionOptions;
	private readonly recorder: MainRequestRecorder;
	private readonly inner: StreamFn;
	private generation = 0;
	private readonly keyHandler = (data: string): boolean => this.handleKey(data);
	private pending: AbortController | undefined;
	private shown: string | undefined;
	private readonly wrapped: StreamFn;
	private readonly unsubscribe: () => void;
	private turnsInRun = 0;
	private restorePrompt: (() => void) | undefined;

	constructor(
		session: SuggestionSessionPort,
		editor: SuggestionEditorPort,
		basePlaceholder: string,
		options: NextSuggestionOptions,
	) {
		this.session = session;
		this.editor = editor;
		this.basePlaceholder = basePlaceholder;
		this.options = options;
		this.recorder = new MainRequestRecorder(options.now);
		this.inner = session.agent.streamFn;
		this.wrapped = this.recorder.wrap(this.inner);
		session.agent.streamFn = this.wrapped;
		this.unsubscribe = session.subscribe((event) => {
			if (event.type === "agent_start") {
				this.options.acceptTrace?.dismissed("new_turn", Date.now());
				this.cancel();
				this.turnsInRun = 0;
			} else if (event.type === "turn_end") this.turnsInRun++;
			else if (event.type === "prompt_settled") void this.onSettled(event.outcome);
			else if (event.type === "message_start" && this.options.acceptTrace) {
				const text = userMessageText(event.message);
				// Queued (steer/followUp) sends were already settled at dispatch; this is the prompt path.
				if (text !== undefined) this.options.acceptTrace.sent(text, Date.now(), "prompt");
			}
		});
		editor.onBeforeInput = this.keyHandler;
		if (options.acceptTrace) this.restorePrompt = traceQueuedDispatch(session, options.acceptTrace);
	}

	/** Detach from the session and editor; restores the stream function if still ours. */
	dispose(): void {
		this.options.acceptTrace?.flush(Date.now());
		this.restorePrompt?.();
		this.cancel();
		this.unsubscribe();
		if (this.session.agent.streamFn === this.wrapped) this.session.agent.streamFn = this.inner;
		if (this.editor.onBeforeInput === this.keyHandler) this.editor.onBeforeInput = undefined;
	}

	get suggestion(): string | undefined {
		return this.shown;
	}

	/** Dismiss the visible suggestion and cancel any pending generation. */
	cancel(): void {
		this.generation++;
		this.pending?.abort();
		this.pending = undefined;
		if (this.shown !== undefined) {
			this.shown = undefined;
			this.editor.setPlaceholder(this.basePlaceholder);
			this.options.requestRender?.();
		}
	}

	private handleKey(data: string): boolean {
		const suggestion = this.shown;
		const isTab = this.options.isTab ?? ((key: string) => getKeybindings().matches(key, "tui.input.tab"));
		const trace = this.options.acceptTrace;
		trace?.observeEditor(this.editor.getText(), Date.now());
		if (
			suggestion !== undefined &&
			isTab(data) &&
			this.editor.getText().length === 0 &&
			!this.editor.isShowingAutocomplete()
		) {
			trace?.accepted(Date.now());
			this.cancel();
			this.editor.setText(suggestion);
			return true;
		}
		if (suggestion !== undefined) trace?.dismissed(dismissReasonForKey(data), Date.now());
		this.cancel();
		return false;
	}

	/** Fail closed: an error, a timeout or a missing reader all count as unavailable. */
	private async checkUsage(): Promise<QuotaUsage> {
		const read = this.options.quotaUsage;
		if (!read) return "unavailable";
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<QuotaUsage>((resolve) => {
			timer = setTimeout(() => resolve("unavailable"), this.options.usageTimeoutMs ?? USAGE_CHECK_TIMEOUT_MS);
		});
		try {
			return await Promise.race([read().catch((): QuotaUsage => "unavailable"), timeout]);
		} finally {
			clearTimeout(timer);
		}
	}

	async onSettled(outcome: string | undefined): Promise<void> {
		this.cancel();
		const generation = this.generation;
		const now = this.options.now ?? Date.now;
		const settledAtEpochMs = Date.now();
		const usage = await this.checkUsage();
		const quotaCheckedAtEpochMs = Date.now();
		if (generation !== this.generation) return;
		const capsOn = isSuggestionCapsEnabled(this.options.env);
		const plan = planSuggestion({
			record: this.recorder.lastRequest,
			outcome: outcome === "completed" || outcome === "aborted" ? outcome : "failed",
			finalAssistant: lastAssistant(this.session.agent.state.messages),
			currentModel: this.session.model,
			nowMs: now(),
			usage,
			...(capsOn ? { caps: { budget: this.options.budget ?? suggestionBudgetFromEnv(this.options.env) } } : {}),
		});
		this.options.onPlan?.(plan);
		const parentTurnIndex = Math.max(0, this.turnsInRun - 1);
		if (plan.kind !== "request") {
			// Spec 103b: skip records only with the caps flag on; flag off writes nothing (bytes as main).
			if (capsOn) this.options.settle?.(settlement.skipSettlement(plan, this.session.model, parentTurnIndex));
			return;
		}
		const controller = new AbortController();
		this.pending = controller;
		const startedAtEpochMs = Date.now();
		const result = await requestNextSuggestion(this.inner, plan.record, plan.finalAssistant, controller.signal, {
			caps: plan.caps,
			now: this.options.now,
			timeoutSignal: this.options.timeoutSignal,
		});
		const { provider, id } = plan.record.model;
		const caps = plan.caps ? { caps: { reasoningCapped: plan.caps.reasoningCapped } } : {};
		this.options.settle?.({ result, provider, model: id, parentTurnIndex, startedAtEpochMs, ...caps });
		// Late result: the user typed, sent the next turn, or a newer turn settled.
		if (generation !== this.generation || controller.signal.aborted) return;
		this.pending = undefined;
		const current = this.session.model;
		if (plan.caps && (current?.provider !== provider || current?.id !== id)) return;
		const text = result.text;
		if (!text || this.editor.getText().length > 0) return;
		this.shown = text;
		this.editor.setPlaceholder(text);
		const timing = { settledAtEpochMs, quotaCheckedAtEpochMs, shownAtEpochMs: Date.now() };
		this.options.acceptTrace?.shown({ parentTurnIndex, provider, model: id, ...timing }, text);
		this.options.requestRender?.();
	}
}

export { type ActiveEditor, followActiveEditor, type SuggestionEditorPort };

let active: NextSuggestionController | undefined;
let activeSession: SuggestionSessionPort | undefined;

/**
 * No-op unless the flag is on. Idempotent per session: rebinding the same
 * session keeps one controller; binding a new session disposes the old one.
 */
export function installNextSuggestions(
	session: SuggestionSessionPort,
	editor: SuggestionEditorPort,
	basePlaceholder: string,
	options: NextSuggestionOptions = {},
): NextSuggestionController | undefined {
	if (!isNextSuggestionsEnabled(options.env)) return undefined;
	if (active && activeSession === session) return active;
	active?.dispose();
	activeSession = session;
	active = new NextSuggestionController(session, editor, basePlaceholder, options);
	return active;
}

/**
 * Highest used percent across the active provider's quota windows. A provider
 * with no quota source reports `"no_quota"`; a source that returns no windows
 * (offline, credential missing, API error) reports `"unavailable"`.
 */
export async function activeQuotaUsage(session: AgentSession): Promise<QuotaUsage> {
	const snapshot = await loadSubscriptionUsage(session);
	if (snapshot === undefined) return "no_quota";
	const used = snapshot.windows
		.map((window) => window.usedPercent)
		.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
	return used.length > 0 ? Math.max(...used) : "unavailable";
}

/** Interactive wiring: one call site in interactive-mode. */
export function installInteractiveNextSuggestions(
	session: AgentSession,
	activeEditor: () => ActiveEditor,
	basePlaceholder: string,
	requestRender: () => void,
): void {
	const editor = followActiveEditor(activeEditor, basePlaceholder);
	installNextSuggestions(session as unknown as SuggestionSessionPort, editor, basePlaceholder, {
		requestRender,
		quotaUsage: () => activeQuotaUsage(session),
		settle: settlement.suggestionMetricsSettler(() => session.sessionId, session.sessionManager.getCwd()),
		acceptTrace: suggestionAcceptTracker(() => session.sessionId, session.sessionManager.getCwd()),
	});
}
