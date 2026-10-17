import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { readBoundedFile } from "../vendor/src/bounded-file.ts";
import { emptySubagentUsage, type SubagentUsageSnapshot } from "../vendor/src/subagent-usage.ts";
import { isRecord } from "../vendor/src/text.ts";

const object = (value: unknown): Record<string, unknown> | undefined => (isRecord(value) ? value : undefined);
const numeric = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const hash = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const digest = (value: unknown): string | undefined =>
	typeof value === "string" ? value.replace(/^sha256:/, "") : undefined;
const sameRoute = (left: unknown, right: unknown): boolean => {
	const a = object(left),
		b = object(right);
	return (
		typeof a?.provider === "string" && typeof a.model === "string" && a.provider === b?.provider && a.model === b.model
	);
};

function answerMatches(value: unknown, expected: unknown): boolean {
	const answer = object(value);
	if (!answer || !Array.isArray(answer.blocks) || answer.blocks.length > 1000) return false;
	const buffers: Buffer[] = [];
	for (const raw of answer.blocks) {
		const block = object(raw);
		if (block?.kind !== "text" || typeof block.data_base64 !== "string") return false;
		const bytes = Buffer.from(block.data_base64, "base64");
		if (bytes.length !== block.byte_length || hash(bytes) !== digest(block.sha256)) return false;
		buffers.push(bytes);
	}
	const bytes = Buffer.concat(buffers);
	return (
		bytes.length === answer.byte_length && hash(bytes) === digest(answer.sha256) && hash(bytes) === digest(expected)
	);
}

/** Read only committed native child receipts linked by this session's successful launch and retrieval. */
export async function readDelegateUsage(options: {
	cwd: string;
	entries: readonly unknown[];
	signal?: AbortSignal;
}): Promise<SubagentUsageSnapshot> {
	const snapshot = emptySubagentUsage();
	const launches = new Map<string, Record<string, unknown>>();
	const completed = new Map<string, { details: Record<string, unknown>; at: number }>();
	for (const raw of options.entries.slice(-10000)) {
		const entry = object(raw),
			message = object(entry?.message),
			details = object(message?.details);
		if (entry?.type !== "message" || message?.role !== "toolResult" || message.isError || !details) continue;
		const task = object(details.task);
		if (
			message.toolName === "bg_delegate" &&
			details.schema_version === "pi-background-tasks.delegate-launch.v1" &&
			typeof task?.id === "string"
		)
			launches.set(task.id, details);
		if (
			message.toolName !== "bg_result" ||
			details.schema_version !== "pi-background-tasks.delegate-result-view.v1" ||
			details.state !== "committed" ||
			typeof details.task_id !== "string"
		)
			continue;
		const at = numeric(message.timestamp)
			? message.timestamp
			: typeof entry.timestamp === "string"
				? Date.parse(entry.timestamp)
				: NaN;
		if (numeric(at) && launches.has(details.task_id) && !completed.has(details.task_id))
			completed.set(details.task_id, { details, at });
	}
	let remaining = 8 * 1024 * 1024;
	for (const [id, { details, at }] of [...completed].slice(0, 64)) {
		if (options.signal?.aborted) break;
		try {
			const launch = launches.get(id),
				task = object(launch?.task);
			if (
				!launch ||
				!task ||
				typeof launch.artifact_dir !== "string" ||
				launch.artifact_dir !== details.artifact_dir ||
				!sameRoute(launch.route, details.route) ||
				!numeric(task.startTime) ||
				at < task.startTime
			)
				throw new Error("Delegate identity mismatch");
			const root = await realpath(join(options.cwd, ".pi/delegate"));
			const directory = await realpath(resolve(options.cwd, launch.artifact_dir));
			const path = await realpath(join(directory, "result.json"));
			const rel = relative(root, path);
			if (isAbsolute(rel) || rel.startsWith("..")) throw new Error("Delegate artifact outside project root");
			const bytes = await readBoundedFile(path, Math.min(2 * 1024 * 1024, remaining), options.signal);
			remaining -= bytes.length;
			const receipt = object(JSON.parse(bytes.toString("utf8")));
			if (options.signal?.aborted) break;
			if (
				receipt?.schema_version !== "pi-background-tasks.delegate-result.v1" ||
				receipt.task_id !== id ||
				receipt.launch_nonce !== object(task.delegate)?.launchNonce ||
				receipt.seed_sha256 !== launch.seed_sha256 ||
				!sameRoute(receipt.route, launch.route) ||
				!answerMatches(receipt.answer, details.answer_sha256)
			)
				throw new Error("Delegate receipt mismatch");
			const reported = object(receipt.usage),
				usage = object(reported?.usage),
				cost = object(usage?.cost)?.total;
			if (
				reported?.status !== "observed" ||
				!numeric(cost) ||
				["input", "output", "cacheRead", "cacheWrite", "totalTokens"].some((key) => !numeric(usage?.[key]))
			)
				throw new Error("Delegate usage unavailable");
			const agent = `${typeof task.name === "string" ? task.name.slice(0, 160) : "delegate"} (final receipt)`;
			const runId = `bg-delegate:${id}`;
			snapshot.runs.push({ id: runId, runId, agent, metadataPath: path, cost, priced: true });
			snapshot.costHistory.push({
				id: `${runId}:0`,
				runId,
				agent,
				stepIndex: 0,
				startedAt: task.startTime,
				points: [
					{ at: task.startTime, cost: 0 },
					{ at, cost },
				],
				partial: false,
			});
		} catch {
			snapshot.unavailable++;
		}
	}
	snapshot.limited = completed.size > 64;
	return snapshot;
}
