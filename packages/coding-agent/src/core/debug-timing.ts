import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Spec 065: opt-in per-phase timing for real-world lag, on the existing `OMK_TIMING=1` switch (core/timings.ts).
 * Off: nothing is installed or written. On: one line per finished span is appended to `OMK_TIMING_FILE`
 * (default `<tmpdir>/omk-timing-<pid>.log`), never to stdout/stderr, so the TUI is not disturbed.
 * Spans: `model.open` (selector open → first frame), `model.apply` (setModel), `enter` (prompt → first request).
 */
export type TimingSpanName = "model.open" | "model.apply" | "enter";

interface Span {
	readonly start: number;
	readonly phases: string[];
}

const active = new Map<TimingSpanName, Span>();
let outputPath: string | undefined;

export function debugTimingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.OMK_TIMING === "1";
}

export function debugTimingPath(env: NodeJS.ProcessEnv = process.env): string {
	return env.OMK_TIMING_FILE || join(tmpdir(), `omk-timing-${process.pid}.log`);
}

export function timingStart(name: TimingSpanName): void {
	if (outputPath === undefined) return;
	if (active.has(name)) timingEnd(name, "superseded");
	active.set(name, { start: performance.now(), phases: [] });
}

/** Record one phase's own duration (ms) inside an active span. */
export function timingPhase(name: TimingSpanName, label: string, ms: number): void {
	active.get(name)?.phases.push(`${label}=${ms.toFixed(1)}`);
}

/** Record a phase measured from the span start. */
export function timingMark(name: TimingSpanName, label: string): void {
	const span = active.get(name);
	if (span) span.phases.push(`${label}@${(performance.now() - span.start).toFixed(1)}`);
}

export function timingEnd(name: TimingSpanName, outcome = "ok"): void {
	const span = active.get(name);
	if (!span || outputPath === undefined) return;
	active.delete(name);
	const total = (performance.now() - span.start).toFixed(1);
	const line = `${new Date().toISOString()} ${name} total=${total}ms ${outcome} ${span.phases.join(" ")}\n`;
	try {
		appendFileSync(outputPath, line);
	} catch {
		// Diagnostics must never break a session.
	}
}

export function timingActive(name: TimingSpanName): boolean {
	return active.has(name);
}

type AnyFn = (this: unknown, ...args: unknown[]) => unknown;

/** Wrap `proto[method]` so its own duration is recorded as a phase of `span` (sync or async). */
export function wrapTimedMethod(proto: object, method: string, span: TimingSpanName, label = method): void {
	const target = proto as Record<string, unknown>;
	const original = target[method];
	if (typeof original !== "function") return;
	target[method] = function (this: unknown, ...args: unknown[]) {
		if (!active.has(span)) return (original as AnyFn).apply(this, args);
		const t0 = performance.now();
		const done = () => timingPhase(span, label, performance.now() - t0);
		const result = (original as AnyFn).apply(this, args);
		if (result instanceof Promise) return result.finally(done);
		done();
		return result;
	};
}

/** Wrap `proto[method]` so a call starts `span` and its settlement ends it (when `endOnSettle`). */
export function wrapSpanMethod(proto: object, method: string, span: TimingSpanName, endOnSettle: boolean): void {
	const target = proto as Record<string, unknown>;
	const original = target[method];
	if (typeof original !== "function") return;
	target[method] = function (this: unknown, ...args: unknown[]) {
		timingStart(span);
		let result: unknown;
		try {
			result = (original as AnyFn).apply(this, args);
		} catch (error) {
			if (endOnSettle) timingEnd(span, "error");
			throw error;
		}
		if (result instanceof Promise) {
			return result.then(
				(value) => {
					if (endOnSettle) timingEnd(span);
					else if (span === "enter") timingEnd(span, "no-request");
					return value;
				},
				(error) => {
					timingEnd(span, "error");
					throw error;
				},
			);
		}
		if (endOnSettle) timingEnd(span);
		return result;
	};
}

/** Enable output; returns false (and installs nothing) unless `OMK_TIMING=1`. */
export function enableDebugTiming(env: NodeJS.ProcessEnv = process.env): boolean {
	if (!debugTimingEnabled(env)) return false;
	outputPath = debugTimingPath(env);
	return true;
}

/** Test-only: forget spans and stop writing. */
export function resetDebugTimingForTests(): void {
	active.clear();
	outputPath = undefined;
}
