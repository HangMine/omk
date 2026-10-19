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
	requestNextSuggestion,
	type SuggestionPlan,
} from "../../core/next-suggestion.ts";
import { loadSubscriptionUsage } from "../../core/provider-usage.ts";

export interface SuggestionSessionPort {
	readonly agent: { streamFn: StreamFn; readonly state: { readonly messages: readonly unknown[] } };
	readonly model: { readonly provider: string; readonly id: string } | undefined;
	subscribe(listener: (event: { readonly type: string; readonly outcome?: string }) => unknown): () => void;
}

export interface SuggestionEditorPort {
	getText(): string;
	setText(text: string): void;
	setPlaceholder(text: string): void;
	isShowingAutocomplete(): boolean;
	onBeforeInput?: (data: string) => boolean;
}

export interface NextSuggestionOptions {
	readonly env?: NodeJS.ProcessEnv;
	readonly now?: () => number;
	readonly isTab?: (data: string) => boolean;
	/** Highest used percent of the active quota windows; undefined when unknown. */
	readonly usedPercent?: () => Promise<number | undefined>;
	readonly requestRender?: () => void;
	readonly onPlan?: (plan: SuggestionPlan) => void;
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
			if (event.type === "agent_start") this.cancel();
			else if (event.type === "prompt_settled") void this.onSettled(event.outcome);
		});
		editor.onBeforeInput = this.keyHandler;
	}

	/** Detach from the session and editor; restores the stream function if still ours. */
	dispose(): void {
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
		if (
			suggestion !== undefined &&
			isTab(data) &&
			this.editor.getText().length === 0 &&
			!this.editor.isShowingAutocomplete()
		) {
			this.cancel();
			this.editor.setText(suggestion);
			return true;
		}
		this.cancel();
		return false;
	}

	async onSettled(outcome: string | undefined): Promise<void> {
		this.cancel();
		const generation = this.generation;
		const now = this.options.now ?? Date.now;
		const usedPercent = await this.options.usedPercent?.().catch(() => undefined);
		if (generation !== this.generation) return;
		const plan = planSuggestion({
			record: this.recorder.lastRequest,
			outcome: outcome === "completed" || outcome === "aborted" ? outcome : "failed",
			finalAssistant: lastAssistant(this.session.agent.state.messages),
			currentModel: this.session.model,
			nowMs: now(),
			usedPercent,
		});
		this.options.onPlan?.(plan);
		if (plan.kind !== "request") return;
		const controller = new AbortController();
		this.pending = controller;
		const text = await requestNextSuggestion(this.inner, plan.record, plan.finalAssistant, controller.signal);
		// Late result: the user typed, sent the next turn, or a newer turn settled.
		if (generation !== this.generation || controller.signal.aborted) return;
		this.pending = undefined;
		if (!text || this.editor.getText().length > 0) return;
		this.shown = text;
		this.editor.setPlaceholder(text);
		this.options.requestRender?.();
	}
}

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

/** Highest used percent across the active provider's quota windows, if the provider reports usage. */
export async function activeQuotaUsedPercent(session: AgentSession): Promise<number | undefined> {
	const snapshot = await loadSubscriptionUsage(session);
	const used = (snapshot?.windows ?? [])
		.map((window) => window.usedPercent)
		.filter((value): value is number => typeof value === "number");
	return used.length > 0 ? Math.max(...used) : undefined;
}

/** Interactive wiring: one call site in interactive-mode. */
export function installInteractiveNextSuggestions(
	session: AgentSession,
	editor: SuggestionEditorPort,
	basePlaceholder: string,
	requestRender: () => void,
): void {
	installNextSuggestions(session as unknown as SuggestionSessionPort, editor, basePlaceholder, {
		requestRender,
		usedPercent: () => activeQuotaUsedPercent(session),
	});
}
