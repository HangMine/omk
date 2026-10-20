import { lstatSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import {
	type DurableFileLockOwnerSnapshot,
	fileErrorCode,
	readDurableFileLockOwnerSync,
} from "./durable-file-lock-owner.ts";
import { DURABLE_FILE_LOCK_ROOT, processIsLive } from "./durable-file-lock-storage.ts";

export type DurableFileLockPeek = "live" | "dead" | "absent" | "unknown";

/**
 * Lock path for `scope`/`key` without creating or re-moding the lock root (spec 088).
 * Only for {@link peekDurableFileLockPathSync}; acquisition goes through `durableFileLockPath`.
 */
export function durableFileLockPathUnchecked(scope: string, key: string): string {
	if (!/^[a-z-]+$/u.test(scope)) throw new TypeError("Durable file lock scope is invalid");
	return join(DURABLE_FILE_LOCK_ROOT, `${scope}-${key}.lock`);
}

/**
 * Side-effect-free owner check (spec 088). Same owner read, host compare and liveness probe as
 * {@link inspectDurableFileLockPathSync}, but it never reclaims, acquires a lock, changes modes,
 * writes, renames or deletes. Another host or any read failure is `unknown`; a same-host owner
 * whose pid is gone is `dead`.
 */
export function peekDurableFileLockPathSync(lockPath: string): DurableFileLockPeek {
	let observed: DurableFileLockOwnerSnapshot;
	try {
		observed = readDurableFileLockOwnerSync(lockPath, { enforceMode: false });
	} catch (error) {
		if (fileErrorCode(error) === "ENOENT") {
			try {
				lstatSync(lockPath);
			} catch (pathError) {
				if (fileErrorCode(pathError) === "ENOENT") return "absent";
			}
		}
		return "unknown";
	}
	if (observed.owner.host !== hostname()) return "unknown";
	return processIsLive(observed.owner.pid) ? "live" : "dead";
}
