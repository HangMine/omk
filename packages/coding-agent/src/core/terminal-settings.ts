/** Resolve the terminal scrollback budget at the settings/env boundary. */
export function resolveScrollbackSeedScreens(configured: unknown, env: NodeJS.ProcessEnv = process.env): number {
	const override = env.OMK_SCROLLBACK_SCREENS?.trim();
	const value =
		typeof configured === "number" && Number.isFinite(configured)
			? configured
			: override
				? Number(override)
				: Number.NaN;
	return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 50;
}
