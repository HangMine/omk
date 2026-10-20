/**
 * Spec 096: the TUI rendering of `task_result` (emitted only with OMK_TASK_RESULT on).
 * Kept out of interactive-mode.ts; ChatContainer feeds every session event through here.
 */
import { type Component, Spacer, Text } from "omk-tui";
import { formatTaskResultLine, type TaskResultEvent } from "../../core/task-result.ts";
import { theme } from "./theme/theme.ts";

function isTaskResultEvent(event: { type: string }): event is TaskResultEvent {
	return event.type === "task_result" && typeof (event as Partial<TaskResultEvent>).projection === "object";
}

/** The dim status line for a `task_result` event, the same text print mode writes; undefined otherwise. */
export function taskResultStatusLine(event: { type: string }): string | undefined {
	return isTaskResultEvent(event) ? formatTaskResultLine(event.projection) : undefined;
}

/** Spacer + dim line for the transcript, or undefined for any other event. */
export function taskResultStatusComponents(event: { type: string }): Component[] | undefined {
	const line = taskResultStatusLine(event);
	return line === undefined ? undefined : [new Spacer(1), new Text(theme.fg("dim", line), 1, 0)];
}
