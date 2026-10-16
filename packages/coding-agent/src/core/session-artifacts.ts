import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { unlink } from "node:fs/promises";

/** Spec 066: per-session artifact directory (`<session>.jsonl` → `<session>.artifacts/`), deleted with the session. */
export function sessionArtifactDir(sessionFile: string): string {
	return `${sessionFile.replace(/\.jsonl$/u, "")}.artifacts`;
}

function removeSessionArtifacts(sessionPath: string): void {
	try {
		rmSync(sessionArtifactDir(sessionPath), { recursive: true, force: true });
	} catch {
		// Best effort: a leftover artifact directory must not fail the delete.
	}
}

/**
 * Delete a session file, trying the `trash` CLI first, then falling back to unlink. Its artifact directory is removed
 * too (spec 066).
 */
export async function deleteSessionFile(
	sessionPath: string,
): Promise<{ ok: boolean; method: "trash" | "unlink"; error?: string }> {
	const result = await deleteSessionFileOnly(sessionPath);
	if (result.ok) removeSessionArtifacts(sessionPath);
	return result;
}

async function deleteSessionFileOnly(
	sessionPath: string,
): Promise<{ ok: boolean; method: "trash" | "unlink"; error?: string }> {
	// Try `trash` first (if installed)
	const trashArgs = sessionPath.startsWith("-") ? ["--", sessionPath] : [sessionPath];
	const trashResult = spawnSync("trash", trashArgs, { encoding: "utf-8" });

	const getTrashErrorHint = (): string | null => {
		const parts: string[] = [];
		if (trashResult.error) {
			parts.push(trashResult.error.message);
		}
		const stderr = trashResult.stderr?.trim();
		if (stderr) {
			parts.push(stderr.split("\n")[0] ?? stderr);
		}
		if (parts.length === 0) return null;
		return `trash: ${parts.join(" · ").slice(0, 200)}`;
	};

	// If trash reports success, or the file is gone afterwards, treat it as successful
	if (trashResult.status === 0 || !existsSync(sessionPath)) {
		return { ok: true, method: "trash" };
	}

	// Fallback to permanent deletion
	try {
		await unlink(sessionPath);
		return { ok: true, method: "unlink" };
	} catch (err) {
		const unlinkError = err instanceof Error ? err.message : String(err);
		const trashErrorHint = getTrashErrorHint();
		const error = trashErrorHint ? `${unlinkError} (${trashErrorHint})` : unlinkError;
		return { ok: false, method: "unlink", error };
	}
}
