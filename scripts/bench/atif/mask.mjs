/**
 * Spec 110 redaction. Masking is the only lossy step of the ATIF export.
 * Env values whose NAME matches SECRET_NAME are replaced by `[REDACTED:<NAME>]`,
 * then common key shapes by `[REDACTED:PATTERN]`. Values are never logged.
 */

export const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|AUTH|COOKIE/i;
/** Shorter values (flags like "1", "true") would shred unrelated text. */
export const MIN_SECRET_LENGTH = 8;
export const KEY_PATTERNS = [
	/\bsk-[A-Za-z0-9_-]{16,}/g,
	/\bxai-[A-Za-z0-9_-]{16,}/g,
	/\bgh[pousr]_[A-Za-z0-9]{20,}/g,
	/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
];

/** @param {Record<string, string | undefined>} env */
export function collectSecrets(env) {
	const out = [];
	for (const [name, value] of Object.entries(env)) {
		if (typeof value !== "string" || value.length < MIN_SECRET_LENGTH) continue;
		if (!SECRET_NAME.test(name)) continue;
		out.push({ name, value });
	}
	// Longest first so a secret that contains another is masked whole.
	return out.sort((a, b) => b.value.length - a.value.length);
}

/** @param {string} text @param {{name:string,value:string}[]} secrets */
export function maskString(text, secrets) {
	let out = text;
	for (const { name, value } of secrets) {
		if (out.includes(value)) out = out.split(value).join(`[REDACTED:${name}]`);
	}
	for (const pattern of KEY_PATTERNS) out = out.replace(pattern, "[REDACTED:PATTERN]");
	return out;
}

/** Deep copy with every string (keys included) masked. */
export function maskDeep(value, secrets) {
	if (typeof value === "string") return maskString(value, secrets);
	if (Array.isArray(value)) return value.map((v) => maskDeep(v, secrets));
	if (value && typeof value === "object") {
		const out = {};
		for (const [k, v] of Object.entries(value)) out[maskString(k, secrets)] = maskDeep(v, secrets);
		return out;
	}
	return value;
}

/** Count leaks in serialized output. Returns names only, never values. */
export function rescan(text, secrets) {
	const hits = [];
	for (const { name, value } of secrets) if (text.includes(value)) hits.push(name);
	for (const pattern of KEY_PATTERNS) {
		pattern.lastIndex = 0;
		if (new RegExp(pattern.source).test(text)) hits.push(`PATTERN:${pattern.source}`);
	}
	return hits;
}
