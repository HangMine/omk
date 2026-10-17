/**
 * OpenCode Go subscription usage: maps `GET /console/api/go/status` meters onto
 * the status-rail windows. Auth is the stored OpenCode OAuth user token; this
 * module never reads cookies or env itself. The endpoint is the same fixed
 * Console origin the Go docs direct users to for usage tracking.
 */

import { clampPercent, usageText } from "./provider-usage-text.ts";
import type { FetchLike, SubscriptionUsageSnapshot, SubscriptionUsageWindow } from "./provider-usage-types.ts";

const GO_STATUS_URL = "https://opencode.ai/console/api/go/status";
const MAX_USAGE_RESPONSE_BYTES = 1024 * 1024;
const PLAN_NAMES: Readonly<Record<string, string>> = { go: "Go", "go-plus": "Go Plus" };
const METERS = [
	{ key: "fiveHour", label: "5H" },
	{ key: "week", label: "7D" },
	{ key: "month", label: "MO" },
] as const;

export function parseOpenCodeGoUsageSnapshot(
	value: unknown,
): Pick<SubscriptionUsageSnapshot, "windows" | "message"> | undefined {
	const root = record(value);
	const access = record(root?.access);
	const meters = record(access?.meters);
	const message = planMessage(root);
	if (!meters) {
		return message === undefined ? undefined : { windows: [], message };
	}
	const windows: SubscriptionUsageWindow[] = [];
	for (const meter of METERS) {
		const window = goWindow(meter.label, meters[meter.key]);
		if (window) windows.push(window);
	}
	if (windows.length === 0 && message === undefined) return { windows: [], message: "usage unavailable" };
	return { windows, ...(message === undefined ? {} : { message }) };
}

export async function fetchOpenCodeGoUsage(
	label: string,
	apiKey: string,
	fetchImpl: FetchLike,
): Promise<SubscriptionUsageSnapshot> {
	const unavailable = (): SubscriptionUsageSnapshot => ({ label, windows: [], message: "usage unavailable" });
	const snapshot = parseOpenCodeGoUsageSnapshot(await fetchQuotaJson(fetchImpl, apiKey));
	if (!snapshot) return unavailable();
	if (snapshot.windows.length > 0) return { label, ...snapshot };
	return { label, windows: [], message: snapshot.message ?? "usage unavailable" };
}

function goWindow(label: string, value: unknown): SubscriptionUsageWindow | undefined {
	const meter = record(value);
	const limit = finiteNumber(meter?.limitMicroCents);
	const used = finiteNumber(meter?.usedMicroCents);
	if (!meter || limit === undefined || limit <= 0 || used === undefined || used < 0) return undefined;
	const resetsAt = epochSeconds(meter.resetsAt);
	return { label, usedPercent: clampPercent((used / limit) * 100), ...(resetsAt === undefined ? {} : { resetsAt }) };
}

function planMessage(root: Record<string, unknown> | undefined): string | undefined {
	const product = stringValue(root?.product);
	if (!product) return undefined;
	return usageText(PLAN_NAMES[product] ?? product.replace(/[_-]+/g, " "));
}

async function fetchQuotaJson(fetchImpl: FetchLike, apiKey: string): Promise<unknown> {
	const response = await fetchImpl(GO_STATUS_URL, {
		headers: {
			Authorization: `Bearer ${apiKey}`,
			Accept: "application/json",
			"User-Agent": "omk",
		},
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) return undefined;
	const declaredBytes = Number(response.headers?.get("content-length"));
	if (Number.isFinite(declaredBytes) && declaredBytes > MAX_USAGE_RESPONSE_BYTES) return undefined;
	if (!response.body || typeof response.body.getReader !== "function") {
		return await response.json();
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		totalBytes += value.byteLength;
		if (totalBytes > MAX_USAGE_RESPONSE_BYTES) {
			await reader.cancel();
			return undefined;
		}
		chunks.push(value);
	}
	const body = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return JSON.parse(new TextDecoder().decode(body)) as unknown;
	} catch {
		return undefined;
	}
}

function epochSeconds(value: unknown): number | undefined {
	const numeric = finiteNumber(value);
	if (numeric !== undefined) return numeric > 1_000_000_000_000 ? numeric / 1000 : numeric;
	if (typeof value !== "string" || !value.trim()) return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed / 1000 : undefined;
}

function finiteNumber(value: unknown): number | undefined {
	const number =
		typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
	return Number.isFinite(number) ? number : undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
