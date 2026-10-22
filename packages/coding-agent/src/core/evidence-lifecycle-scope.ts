/**
 * Spec 106 D1: which session owns an evidence artifact. AgentSession runs prompts and user bash inside
 * `withEvidenceSession(sessionId, …)`; producers (read/bash tools, executor, goal recall) read the owner
 * from this async context. No context ⇒ the explicit `unattributed` bucket, never another session.
 * Flag off ⇒ `withEvidenceSession` just calls `fn` (no context is created).
 */
import { AsyncLocalStorage } from "node:async_hooks";

export const EVIDENCE_UNATTRIBUTED = "unattributed";

const owner = new AsyncLocalStorage<string>();

export function withEvidenceSession<T>(sessionId: string, fn: () => T): T {
	return process.env.OMK_EVIDENCE_LIFECYCLE === "observe" ? owner.run(sessionId, fn) : fn();
}

export function currentEvidenceSession(): string {
	return owner.getStore() ?? EVIDENCE_UNATTRIBUTED;
}
