import type { ExtensionContext, Theme } from "open-multi-agent-kit";

/** OMK replaces Theme instances; persistent Atelier components must follow that replacement. */
export function liveTheme(ctx: Pick<ExtensionContext, "ui">): Theme {
	let current = ctx.ui.theme;
	return new Proxy(current, {
		get(_target, key) {
			// Retired components retain only their last non-sensitive palette.
			try {
				current = ctx.ui.theme;
			} catch {
				/* The host rejects stale session contexts. */
			}
			const value: unknown = Reflect.get(current, key, current);
			return typeof value === "function" ? value.bind(current) : value;
		},
	});
}
