import { afterEach, describe, expect, it, vi } from "vitest";
import type { PinnedQuotaFailoverEvent } from "../src/core/pinned-quota-failover-notice.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { runPrintMode } from "../src/modes/print-mode.ts";
import { createAssistantMessage, createRuntimeHost } from "./print-mode-fixtures.ts";

const printIo = vi.hoisted(() => ({ output: [] as string[] }));

vi.mock("../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	writeRawStdout: (text: string) => printIo.output.push(text),
}));

const notice: PinnedQuotaFailoverEvent = {
	type: "pinned_quota_failover",
	from: "openai/gpt-x",
	to: "deepseek/deepseek-v4-flash",
	message:
		"Quota exhausted on pinned model openai/gpt-x; this turn continues on deepseek/deepseek-v4-flash. " +
		"To stay on the pinned model, set providerResilience.autoFailoverOnQuotaExhaustion: false.",
};

afterEach(() => {
	printIo.output = [];
	vi.restoreAllMocks();
});

describe("pinned quota failover notice rendering (spec 089)", () => {
	it("interactive mode shows the notice as one warning line", async () => {
		const fakeThis: any = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			showWarning: vi.fn(),
			ui: { requestRender: vi.fn() },
		};
		await (InteractiveMode as any).prototype.handleEvent.call(fakeThis, notice);
		expect(fakeThis.showWarning).toHaveBeenCalledTimes(1);
		expect(fakeThis.showWarning).toHaveBeenCalledWith(notice.message);
	});

	it("text print mode writes the notice to stderr, not stdout", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "ok" }));
		runtimeHost.session.subscribe.mockImplementation((listener: (event: unknown) => void) => {
			runtimeHost.session.prompt.mockImplementationOnce(async () => {
				listener(notice);
				listener({ type: "prompt_settled", promptRunId: "fixture", outcome: "completed", durationMs: 1 });
			});
			return () => {};
		});
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		vi.spyOn(console, "error").mockImplementation(() => {});
		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "fixture",
		});
		expect(exitCode).toBe(0);
		const lines = stderr.mock.calls.map((call) => String(call[0])).filter((t) => t.includes("Quota exhausted"));
		expect(lines).toEqual([`Warning: ${notice.message}\n`]);
		expect(printIo.output.join("")).not.toContain("Quota exhausted");
	});
});
