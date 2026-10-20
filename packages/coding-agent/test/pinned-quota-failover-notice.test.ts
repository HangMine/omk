import { describe, expect, it } from "vitest";
import {
	PINNED_QUOTA_FAILOVER_DISABLE_HINT,
	type PinnedQuotaFailoverEvent,
	PinnedQuotaFailoverNotice,
} from "../src/core/pinned-quota-failover-notice.ts";

const gptX = { provider: "openai", id: "gpt-x" };
const claudeY = { provider: "anthropic", id: "claude-y" };

function setup(pinned: boolean) {
	const events: PinnedQuotaFailoverEvent[] = [];
	const logs: unknown[] = [];
	const notice = new PinnedQuotaFailoverNotice(
		(event) => events.push(event),
		() => pinned,
		(record) => logs.push(record),
	);
	return { events, logs, notice };
}

describe("pinned quota failover notice (spec 089)", () => {
	it("emits exactly one notice and one run-log line on a pinned quota failover", () => {
		const { events, logs, notice } = setup(true);
		expect(notice.afterFailover(true, gptX, claudeY)).toBe("anthropic/claude-y");
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			type: "pinned_quota_failover",
			from: "openai/gpt-x",
			to: "anthropic/claude-y",
		});
		expect(events[0].message).toContain("Quota exhausted");
		expect(events[0].message).toContain("this turn continues on anthropic/claude-y");
		expect(events[0].message).toContain(PINNED_QUOTA_FAILOVER_DISABLE_HINT);
		expect(logs).toEqual([
			{ reason: "quota_exhausted", from: "openai/gpt-x", to: "anthropic/claude-y", pinned: true },
		]);
	});

	it("emits nothing when the model is not pinned", () => {
		const { events, logs, notice } = setup(false);
		expect(notice.afterFailover(true, gptX, claudeY)).toBe("anthropic/claude-y");
		expect(events).toHaveLength(0);
		expect(logs).toHaveLength(0);
	});

	it("emits nothing for a pinned non-quota (safety) failover", () => {
		const { events, notice } = setup(true);
		notice.afterFailover(false, gptX, claudeY);
		expect(events).toHaveLength(0);
	});

	it("stays at one notice when the same turn fails over again, and re-arms only on resetTurn", () => {
		const { events, notice } = setup(true);
		notice.afterFailover(true, gptX, claudeY);
		notice.afterFailover(true, claudeY, { provider: "google", id: "z" });
		expect(events).toHaveLength(1);
		notice.resetTurn();
		notice.afterFailover(true, gptX, claudeY);
		expect(events).toHaveLength(2);
	});
});
