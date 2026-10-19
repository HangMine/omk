import { describe, expect, it } from "vitest";
import {
	MAX_RETRY_WAIT_MS,
	planRetryWait,
	QuotaExhaustedNoRetryError,
	quotaAllowsRetry,
	quotaRetryAction,
	retryAfterHintMs,
	retryWaitMs,
} from "../src/core/quota-retry-policy.ts";

const QUOTA = "429 You've hit the free limit for DeepSeek V4.1 Flash 1017 free (your free daily allowance).";

describe("spec 090 quota retry policy", () => {
	it("separates quota exhaustion from a transient 429 using the existing classifier", () => {
		expect(quotaRetryAction(QUOTA, true)).toBe("failover");
		expect(quotaRetryAction(QUOTA, false)).toBe("end");
		expect(quotaRetryAction("429 Too Many Requests", true)).toBe("not_quota");
		expect(quotaRetryAction("429 Too Many Requests", false)).toBe("not_quota");
		expect(quotaRetryAction(undefined, true)).toBe("not_quota");
	});

	it("types the no-retry quota error", () => {
		const error = new QuotaExhaustedNoRetryError(QUOTA);
		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe("QuotaExhaustedNoRetryError");
		expect(error.code).toBe("quota_exhausted");
		expect(error.retryable).toBe(false);
		expect(error.message).toContain("quota exhausted, no retry");
	});

	it("parses Retry-After hints from provider error text", () => {
		expect(retryAfterHintMs("429 Too Many Requests. Retry-After: 2")).toBe(2000);
		expect(retryAfterHintMs("please retry after 600 seconds")).toBe(600_000);
		expect(retryAfterHintMs("Rate limited. Try again in 1.5s")).toBe(1500);
		expect(retryAfterHintMs("retry-after-ms: 250")).toBe(250);
		expect(retryAfterHintMs("overloaded_error")).toBeUndefined();
		expect(retryAfterHintMs(undefined)).toBeUndefined();
	});

	it("waits 0 on quota failover, honors Retry-After, and caps every wait at 60s", () => {
		expect(MAX_RETRY_WAIT_MS).toBe(60_000);
		expect(retryWaitMs({ quotaFailover: true, backoffMs: 4000, errorMessage: QUOTA })).toBe(0);
		expect(retryWaitMs({ quotaFailover: false, backoffMs: 4000, errorMessage: "529 overloaded" })).toBe(4000);
		expect(retryWaitMs({ quotaFailover: false, backoffMs: 4000, errorMessage: "429 retry after 2" })).toBe(2000);
		expect(retryWaitMs({ quotaFailover: false, backoffMs: 4000, errorMessage: "429 retry after 999" })).toBe(60_000);
		expect(retryWaitMs({ quotaFailover: false, backoffMs: 500_000, errorMessage: "529" })).toBe(60_000);
		expect(retryWaitMs({ quotaFailover: false, backoffMs: 4000, errorMessage: "529", remainingMs: 100 })).toBe(100);
	});
});

describe("spec 090 session retry gate", () => {
	const msg = (errorMessage: string) => ({ stopReason: "error", errorMessage }) as never;

	it("allows quota retry only when quota failover is on", () => {
		expect(quotaAllowsRetry(QUOTA, { autoFailoverOnQuotaExhaustion: false })).toBe(false);
		expect(quotaAllowsRetry(QUOTA, { autoFailoverOnQuotaExhaustion: true })).toBe(true);
		expect(quotaAllowsRetry(QUOTA, undefined)).toBe(true);
		expect(quotaAllowsRetry("429 Too Many Requests", { autoFailoverOnQuotaExhaustion: false })).toBe(true);
	});

	it("ends quota without failover and keeps the backoff formula for other errors", () => {
		const settings = { baseDelayMs: 2000 };
		expect(planRetryWait(msg(QUOTA), settings, 1, undefined, undefined, undefined)).toBeUndefined();
		expect(planRetryWait(msg(QUOTA), settings, 1, "deepseek/x", undefined, undefined)).toBe(0);
		expect(planRetryWait(msg("529 overloaded"), settings, 1, undefined, undefined, undefined)).toBe(2000);
		expect(planRetryWait(msg("529 overloaded"), settings, 3, undefined, undefined, undefined)).toBe(8000);
		expect(planRetryWait(msg("529 overloaded"), settings, 6, undefined, undefined, undefined)).toBe(60_000);
		expect(planRetryWait(msg("502 bad gateway"), settings, 3, undefined, "r/x", undefined)).toBe(400);
	});
});
