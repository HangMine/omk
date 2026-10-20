import { getEnvApiKey } from "omk-ai";
import type { AuthStorage } from "./auth-storage.ts";

/** auth.json provider id for the TypeSafe (Jev) API key. */
export const JEV_PROVIDER_ID = "typesafe";
/** Env var read when no key is stored (stored wins, like every other provider). */
export const JEV_ENV_VAR = "TYPESAFE_API_KEY";

export type JevKeySource = "stored" | "env" | "none";
export type JevSubcommand = "set" | "status" | "clear" | "usage" | "unknown";

export const JEV_USAGE = "Usage: /jev set | /jev status | /jev clear";
export const JEV_EMPTY_KEY_ERROR = "key cannot be empty";

/** OMK_JEV=1 (env only in v1) gates Jev features such as 091 skill selection. /jev key management ignores it. */
export function isJevEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.OMK_JEV === "1";
}

export function parseJevCommand(text: string): JevSubcommand | undefined {
	const trimmed = text.trim();
	if (trimmed !== "/jev" && !trimmed.startsWith("/jev ")) return undefined;
	const arg = trimmed.slice("/jev".length).trim();
	if (arg === "") return "usage";
	if (arg === "set" || arg === "status" || arg === "clear") return arg;
	return "unknown";
}

function hasStoredKey(authStorage: AuthStorage): boolean {
	const cred = authStorage.get(JEV_PROVIDER_ID);
	return cred?.type === "api_key" && cred.key.length > 0;
}

/** Source only; never returns or formats any key characters. */
export function getJevKeySource(authStorage: AuthStorage): JevKeySource {
	if (hasStoredKey(authStorage)) return "stored";
	if (getEnvApiKey(JEV_PROVIDER_ID)) return "env";
	return "none";
}

export type JevSetResult = { ok: true } | { ok: false; error: typeof JEV_EMPTY_KEY_ERROR };

/** Trims and stores the key in auth.json. Empty input writes nothing. Error text never echoes input. */
export function setJevKey(authStorage: AuthStorage, rawKey: string): JevSetResult {
	const key = rawKey.trim();
	if (!key) return { ok: false, error: JEV_EMPTY_KEY_ERROR };
	authStorage.set(JEV_PROVIDER_ID, { type: "api_key", key });
	return { ok: true };
}

export interface JevClearResult {
	removed: boolean;
	envStillSet: boolean;
}

export function clearJevKey(authStorage: AuthStorage): JevClearResult {
	const removed = authStorage.has(JEV_PROVIDER_ID);
	if (removed) authStorage.remove(JEV_PROVIDER_ID);
	return { removed, envStillSet: Boolean(getEnvApiKey(JEV_PROVIDER_ID)) };
}

export function formatJevClear(result: JevClearResult): string {
	const head = result.removed ? "Removed stored TypeSafe key." : "No stored TypeSafe key.";
	return result.envStillSet ? `${head} ${JEV_ENV_VAR} is still set in env (cannot be cleared from omk).` : head;
}
