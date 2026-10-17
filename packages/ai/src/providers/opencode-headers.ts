import type { Api, Model } from "../types.ts";

/** Go requires a client identity and conversation ID independently of prompt caching. */
export function openCodeHeaders(
	model: Model<Api>,
	sessionId?: string,
	optionsHeaders?: Record<string, string>,
): Record<string, string> | undefined {
	if (model.provider !== "opencode-go" || !URL.canParse(model.baseUrl)) return undefined;
	const url = new URL(model.baseUrl);
	if (url.origin !== "https://opencode.ai" || !/^\/(?:inference|zen)\/go(?:\/|$)/.test(url.pathname)) return undefined;
	const headers = new Headers(model.headers);
	for (const [name, value] of Object.entries(optionsHeaders ?? {})) headers.set(name, value);
	if (!headers.has("user-agent")) headers.set("user-agent", "omk/1.0");
	if (sessionId && !headers.has("x-opencode-session")) headers.set("x-opencode-session", sessionId);
	return Object.fromEntries(headers);
}
