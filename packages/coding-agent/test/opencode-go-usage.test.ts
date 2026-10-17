import { describe, expect, it, vi } from "vitest";
import {
	getSubscriptionUsageSource,
	loadSubscriptionUsage,
	supportsSubscriptionUsage,
} from "../src/core/provider-usage.ts";
import { fetchOpenCodeGoUsage, parseOpenCodeGoUsageSnapshot } from "../src/core/provider-usage-go.ts";
import type { FetchLike, SubscriptionUsageSnapshot } from "../src/core/provider-usage-types.ts";

// The live /console/api/go/status shape: meter budgets are decimal strings and
// resets are ISO timestamps. Percentages mirror the console's Rolling/Weekly/
// Monthly meters (4% / 2% / 1% at these fixture values).
function goStatusFixture(product = "go-plus"): unknown {
	return {
		product,
		renewalPending: false,
		cancelAtPeriodEnd: false,
		access: {
			startsAt: "2026-10-16T18:53:36.000Z",
			endsAt: "2026-11-16T18:53:36.000Z",
			meters: {
				fiveHour: {
					startsAt: "2026-10-16T19:42:50.000Z",
					resetsAt: "2026-10-17T00:42:50.000Z",
					limitMicroCents: "1000",
					usedMicroCents: "40",
				},
				week: {
					startsAt: "2026-10-12T00:00:00.000Z",
					resetsAt: "2026-10-19T00:00:00.000Z",
					limitMicroCents: "1000",
					usedMicroCents: "20",
				},
				month: {
					resetsAt: "2026-11-16T18:53:36.000Z",
					limitMicroCents: "1000",
					usedMicroCents: "10",
				},
			},
		},
	};
}

function session(
	provider: string,
	options: { oauthProviders?: readonly string[]; apiKeys?: Readonly<Record<string, string>> } = {},
) {
	const oauthProviders = new Set(options.oauthProviders ?? []);
	return {
		state: { model: { provider, baseUrl: "https://opencode.ai/inference/go/openai/v1" } },
		modelRegistry: {
			isUsingOAuthProvider: (candidate: string) => oauthProviders.has(candidate),
			getProviderAuthStatus: () => ({ configured: true, source: "stored" as const }),
			getApiKeyForProvider: async (candidate: string) => options.apiKeys?.[candidate],
		},
	};
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		...init,
		headers: { "content-type": "application/json", ...init?.headers },
	});
}

describe("OpenCode Go usage windows", () => {
	it("maps the three Go meters to rail windows with console-matching percentages", () => {
		expect(parseOpenCodeGoUsageSnapshot(goStatusFixture())).toEqual({
			message: "Go Plus",
			windows: [
				{
					label: "5H",
					usedPercent: 4,
					resetsAt: Date.parse("2026-10-17T00:42:50.000Z") / 1000,
				},
				{
					label: "7D",
					usedPercent: 2,
					resetsAt: Date.parse("2026-10-19T00:00:00.000Z") / 1000,
				},
				{
					label: "MO",
					usedPercent: 1,
					resetsAt: Date.parse("2026-11-16T18:53:36.000Z") / 1000,
				},
			],
		});
	});

	it("labels the smaller plan from the product field", () => {
		expect(parseOpenCodeGoUsageSnapshot(goStatusFixture("go"))?.message).toBe("Go");
	});

	it("keeps partial meter sets instead of failing the whole snapshot", () => {
		const payload = goStatusFixture();
		const access = (payload as { access: { meters: Record<string, unknown> } }).access;
		delete access.meters.fiveHour;
		delete access.meters.week;
		const snapshot = parseOpenCodeGoUsageSnapshot(payload);
		expect(snapshot?.windows).toEqual([
			{
				label: "MO",
				usedPercent: 1,
				resetsAt: Date.parse("2026-11-16T18:53:36.000Z") / 1000,
			},
		]);
	});

	it.each([
		["missing access", { product: "go-plus" }],
		["empty meters", { product: "go-plus", access: { meters: {} } }],
		[
			"malformed meter budgets",
			{ product: "go-plus", access: { meters: { month: { limitMicroCents: "nope", usedMicroCents: "10" } } } },
		],
		[
			"zero budget",
			{ product: "go-plus", access: { meters: { month: { limitMicroCents: "0", usedMicroCents: "10" } } } },
		],
	])("does not invent usage for %s", (_name, payload) => {
		const snapshot = parseOpenCodeGoUsageSnapshot(payload);
		expect(snapshot?.windows).toEqual([]);
	});

	it("falls back to unavailable when the payload has no recognizable shape", () => {
		expect(parseOpenCodeGoUsageSnapshot(undefined)).toBeUndefined();
		expect(parseOpenCodeGoUsageSnapshot("nope")).toBeUndefined();
	});

	it("calls the fixed Console status endpoint with the stored token", async () => {
		const fetchMock = vi.fn<FetchLike>(async () => jsonResponse(goStatusFixture()));
		const snapshot = await fetchOpenCodeGoUsage("OPENCODE GO", "user-token", fetchMock);
		expect(snapshot.windows.map((window) => window.label)).toEqual(["5H", "7D", "MO"]);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://opencode.ai/console/api/go/status");
		const headers = init.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer user-token");
		expect(headers["User-Agent"]).toBe("omk");
	});

	it.each([
		["HTTP error", () => new Response("forbidden", { status: 401 })],
		[
			"oversized response",
			() => jsonResponse(goStatusFixture(), { headers: { "content-length": String(1024 * 1024 + 1) } }),
		],
		["invalid JSON", () => new Response("{{", { status: 200 })],
	])("reports usage unavailable for %s", async (_name, response) => {
		const snapshot = await fetchOpenCodeGoUsage("OPENCODE GO", "user-token", (async () => response()) as FetchLike);
		expect(snapshot).toEqual({ label: "OPENCODE GO", windows: [], message: "usage unavailable" });
	});

	it("registers OpenCode Go as an OAuth-only quota group", () => {
		expect(getSubscriptionUsageSource("opencode-go")?.label).toBe("OPENCODE GO");
		expect(supportsSubscriptionUsage(session("opencode-go", { oauthProviders: ["opencode-go"] }) as never)).toBe(
			true,
		);
		expect(
			supportsSubscriptionUsage(session("opencode-go", { apiKeys: { "opencode-go": "sk-test" } }) as never),
		).toBe(false);
	});

	it("loads the snapshot through the subscription usage pipeline", async () => {
		const fetchMock = vi.fn<FetchLike>(async () => jsonResponse(goStatusFixture()));
		const snapshot = (await loadSubscriptionUsage(
			session("opencode-go", {
				oauthProviders: ["opencode-go"],
				apiKeys: { "opencode-go": "user-token" },
			}) as never,
			fetchMock,
		)) as SubscriptionUsageSnapshot;
		expect(snapshot.label).toBe("OPENCODE GO");
		expect(snapshot.windows.map((window) => window.usedPercent)).toEqual([4, 2, 1]);
		expect(snapshot.message).toBe("Go Plus");
	});
});
