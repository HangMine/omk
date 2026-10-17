import { matchesKey, type OverlayOptions, type TUI } from "omk-tui";

export const DEFAULT_SIDEBAR_WIDTH = 44;
export const MIN_SIDEBAR_WIDTH = 28;
export const MAX_SIDEBAR_WIDTH = 72;
export const MIN_MAIN_WIDTH = 64;
const MOUSE_ON = "\u001b[?1002h\u001b[?1006h";
const MOUSE_OFF = "\u001b[?1006l\u001b[?1002l";
const DEFAULT_RESIZE_KEYBINDINGS = [
	["shift+left", 4],
	["shift+right", -4],
	["left", 1],
	["right", -1],
] as const;
export type SidebarMode = "auto" | "manual";
export type SidebarPresentation = "shown" | "auto-collapsed" | "too-narrow" | "off";
export interface SidebarStatus {
	mode: SidebarMode;
	enabled: boolean;
	presentation: SidebarPresentation;
}
type InputResult = { consume?: boolean; data?: string } | undefined;
export interface SplitPaneControllerOptions {
	subscribeInput?(handler: (data: string) => InputResult): () => void;
	onResizeChange?(resizing: boolean): void;
	onVisibilityChange?(): void;
	onWarning?(message: string): void;
	onError?(error: unknown): void;
}
export interface SgrMouseEvent {
	button: number;
	x: number;
	y: number;
	release: boolean;
	motion: boolean;
}
export function parseSgrMouseEvent(data: string): SgrMouseEvent | undefined {
	const match = /^\u001b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
	if (!match) return undefined;
	const button = Number(match[1]),
		x = Number(match[2]),
		y = Number(match[3]);
	if (![button, x, y].every(Number.isFinite) || x < 1 || y < 1) return undefined;
	return { button, x, y, release: match[4] === "m", motion: (button & 32) !== 0 };
}
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Native OMK gutter: no Pi 0.84 renderer/prototype or terminal-write patching. */
export function createSplitPaneController(options: SplitPaneControllerOptions = {}) {
	let tui: TUI | undefined;
	let enabled = false,
		disposed = false,
		resizing = false,
		dragging = false;
	let mode: SidebarMode = "manual";
	let width = DEFAULT_SIDEBAR_WIDTH,
		resizeStartWidth = width;
	let expanded: boolean | undefined;
	let lastPresentation: SidebarPresentation = "off";
	let unsubscribe: (() => void) | undefined;
	type Gutter = Parameters<TUI["setRightGutter"]>[0];
	let previousGutter: Gutter = 0;
	let ownedGutter: Gutter = 0;
	const isGutter = (value: unknown): value is Gutter => typeof value === "number" || typeof value === "function";
	const safely = (action: () => void) => {
		try {
			action();
		} catch (error) {
			try {
				options.onError?.(error);
			} catch {
				/* Reporting must not interrupt resource cleanup. */
			}
		}
	};
	const layout = (columns: number) => {
		if (enabled && mode === "auto" && Number.isFinite(columns) && columns > 0)
			expanded = columns >= 80 + width + (expanded === false ? 8 : 0);
		const presentation: SidebarPresentation = !enabled
			? "off"
			: !Number.isFinite(columns) || columns < MIN_MAIN_WIDTH + MIN_SIDEBAR_WIDTH
				? "too-narrow"
				: mode === "auto" && !expanded
					? "auto-collapsed"
					: "shown";
		if (presentation !== lastPresentation) {
			lastPresentation = presentation;
			queueMicrotask(() => {
				if (!disposed) options.onVisibilityChange?.();
			});
		}
		return {
			presentation,
			width:
				presentation === "shown"
					? clamp(width, MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, columns - MIN_MAIN_WIDTH))
					: 0,
		};
	};
	const requestRender = () => safely(() => tui?.requestRender());
	const stopResize = (restore: boolean) => {
		if (!resizing) return;
		resizing = false;
		dragging = false;
		if (restore) width = resizeStartWidth;
		const off = unsubscribe;
		unsubscribe = undefined;
		safely(() => off?.());
		safely(() => tui?.terminal.write(MOUSE_OFF));
		safely(() => options.onResizeChange?.(false));
		requestRender();
	};
	const setSidebarWidth = (next: number) => {
		if (Number.isFinite(next))
			width = clamp(
				Math.trunc(next),
				MIN_SIDEBAR_WIDTH,
				resizing && tui ? Math.min(MAX_SIDEBAR_WIDTH, tui.terminal.columns - MIN_MAIN_WIDTH) : MAX_SIDEBAR_WIDTH,
			);
		requestRender();
	};
	const handleResizeInput = (data: string): InputResult => {
		if (!tui || layout(tui.terminal.columns).presentation !== "shown") {
			stopResize(true);
			return;
		}
		const mouse = parseSgrMouseEvent(data);
		if (mouse) {
			if (mouse.release) {
				if (dragging) stopResize(false);
			} else if (!mouse.motion && (mouse.button & 3) === 0 && !(mouse.button & 64))
				dragging = Math.abs(mouse.x - (tui.terminal.columns - layout(tui.terminal.columns).width + 1)) <= 1;
			else if (mouse.motion && dragging) setSidebarWidth(tui.terminal.columns - mouse.x + 1);
			return { consume: true };
		}
		const step = DEFAULT_RESIZE_KEYBINDINGS.find(([key]) => matchesKey(data, key))?.[1];
		if (step !== undefined) setSidebarWidth(layout(tui.terminal.columns).width + step);
		else if (matchesKey(data, "enter")) stopResize(false);
		else if (matchesKey(data, "escape")) stopResize(true);
		else return;
		return { consume: true };
	};
	return {
		attach(next: TUI) {
			if (disposed) throw new Error("Cannot attach a disposed split pane");
			if (tui === next) return;
			if (tui) throw new Error("Split pane is already attached to another TUI");
			if (typeof next.setRightGutter !== "function") throw new Error("Atelier requires OMK TUI setRightGutter");
			tui = next;
			const previous: unknown = Reflect.get(tui, "rightGutter");
			previousGutter = isGutter(previous) ? previous : 0;
			ownedGutter = (columns) => {
				const result = layout(columns);
				if (resizing && result.presentation !== "shown") queueMicrotask(() => stopResize(true));
				return result.width;
			};
			tui.setRightGutter(ownedGutter);
		},
		show() {
			if (disposed) return;
			enabled = true;
			expanded = undefined;
			if (tui) {
				const current: unknown = Reflect.get(tui, "rightGutter");
				if (current !== ownedGutter && isGutter(current)) previousGutter = current;
				tui.setRightGutter(ownedGutter);
			}
			requestRender();
		},
		hide() {
			stopResize(true);
			enabled = false;
			if (tui && Reflect.get(tui, "rightGutter") === ownedGutter) tui.setRightGutter(previousGutter);
			requestRender();
		},
		setMode(next: SidebarMode) {
			stopResize(true);
			mode = next;
			expanded = undefined;
			requestRender();
		},
		getStatus: (): SidebarStatus => ({ mode, enabled, presentation: layout(tui?.terminal.columns ?? 0).presentation }),
		setSidebarWidth,
		getSidebarWidth: () => width,
		isEnabled: () => enabled,
		isResizing: () => resizing,
		beginResize() {
			if (resizing) return true;
			if (
				!tui ||
				!enabled ||
				mode !== "manual" ||
				layout(tui.terminal.columns).presentation !== "shown" ||
				!options.subscribeInput
			) {
				options.onWarning?.("Show the sidebar in Manual mode in a terminal at least 92 columns wide before resizing");
				return false;
			}
			resizeStartWidth = width;
			resizing = true;
			try {
				unsubscribe = options.subscribeInput(handleResizeInput);
				tui.terminal.write(MOUSE_ON);
				options.onResizeChange?.(true);
				requestRender();
				return true;
			} catch (error) {
				stopResize(true);
				options.onError?.(error);
				return false;
			}
		},
		cancelResize: () => stopResize(true),
		overlayOptions: (): OverlayOptions => ({
			anchor: "top-right",
			width: (columns) => layout(columns).width,
			maxHeight: "100%",
			margin: 0,
			nonCapturing: true,
			visible: (columns) => layout(columns).presentation === "shown",
		}),
		requestRender,
		dispose() {
			if (disposed) return;
			stopResize(true);
			disposed = true;
			enabled = false;
			if (tui && Reflect.get(tui, "rightGutter") === ownedGutter) tui.setRightGutter(previousGutter);
			tui = undefined;
		},
	};
}
export type SplitPaneController = ReturnType<typeof createSplitPaneController>;
