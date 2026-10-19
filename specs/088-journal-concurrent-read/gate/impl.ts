// Selects the product code under test. GATE_IMPL=head (default): this worktree's product code.
// GATE_IMPL=base: base-control only. It imports the default read path of a separate, unmodified
// checkout at af8d32559e (GATE_BASE_ROOT), and is never used for a verdict.
const base = process.env.GATE_BASE_ROOT ?? "/workspace/omk-he-testsh-base";
const src = (rel: string) => `${base}/packages/coding-agent/src/core/${rel}`;
export const IMPL = process.env.GATE_IMPL === "base" ? "base" : "head";
export const lib: any =
	IMPL === "base"
		? {
				...(await import(src("verified-run/journal.ts"))),
				...(await import(src("session-owner-lease.ts"))),
				...(await import(src("verified-run/storage.ts"))),
			}
		: await import("./common.ts");
