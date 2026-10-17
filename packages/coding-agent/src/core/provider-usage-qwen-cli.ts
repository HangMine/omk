/**
 * QwenCloud CLI invocation for the token-plan quota source. Process spawning and
 * environment filtering live here so quota parsing stays in provider-usage.ts.
 */

import { execFile } from "node:child_process";

const MAX_USAGE_RESPONSE_BYTES = 1024 * 1024;
const QWEN_CLI_ENV_KEYS = [
	"PATH",
	"Path",
	"HOME",
	"USERPROFILE",
	"HOMEDRIVE",
	"HOMEPATH",
	"APPDATA",
	"LOCALAPPDATA",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_CACHE_HOME",
	"TMPDIR",
	"TEMP",
	"TMP",
	"SystemRoot",
	"WINDIR",
	"ComSpec",
	"PATHEXT",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TERM",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
] as const;

export type QwenCliResult =
	| { readonly kind: "missing" }
	| { readonly kind: "ran"; readonly exitCode: number; readonly stdout: string };
export type QwenCliRunner = (args: readonly string[], timeoutMs: number) => Promise<QwenCliResult>;

export function buildQwenCliEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const childEnvironment: NodeJS.ProcessEnv = {};
	for (const key of QWEN_CLI_ENV_KEYS) {
		const value = source[key];
		if (value !== undefined) childEnvironment[key] = value;
	}
	return childEnvironment;
}

export function runQwenCli(args: readonly string[], timeoutMs: number): Promise<QwenCliResult> {
	return new Promise((resolve) => {
		const binary = process.env.QWENCLOUD_CLI ?? "qwencloud";
		execFile(
			binary,
			[...args],
			{
				timeout: timeoutMs,
				maxBuffer: MAX_USAGE_RESPONSE_BYTES,
				windowsHide: true,
				env: buildQwenCliEnvironment(process.env),
			},
			(error, stdout) => {
				if (!error) {
					resolve({ kind: "ran", exitCode: 0, stdout });
					return;
				}
				const errno = (error as NodeJS.ErrnoException).code;
				if (errno === "ENOENT") {
					resolve({ kind: "missing" });
					return;
				}
				resolve({ kind: "ran", exitCode: typeof errno === "number" ? errno : 1, stdout: stdout ?? "" });
			},
		);
	});
}
