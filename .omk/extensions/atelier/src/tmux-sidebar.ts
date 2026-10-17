import { execFile, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { truncateToWidth } from "omk-tui";
import {
	createSidebarComponent,
	type SidebarController,
	type SidebarControllerOptions,
} from "../vendor/src/sidebar.ts";
import { DEFAULT_SIDEBAR_WIDTH, MIN_MAIN_WIDTH, MIN_SIDEBAR_WIDTH } from "./split-pane.ts";
import { liveTheme } from "./theme.ts";

const OWNER_OPTION = "@omk_atelier_owner";
const REFRESH_MS = 500;

/** The parent owns the empty pane and feeds the existing renderer through tmux stdin. */
export function createTmuxSidebarController(options: SidebarControllerOptions): SidebarController {
	const socket = process.env.TMUX?.split(",")[0];
	const main = process.env.TMUX_PANE;
	if (!socket?.startsWith("/") || !main || !/^%\d+$/.test(main)) throw new Error("Atelier requires a tmux pane");
	const prefix = ["-S", socket];
	const owner = randomUUID();
	let disposed = false;
	let height = 1;
	let pane: { id: string; writer: ReturnType<typeof spawn>; frame: string } | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let query: ReturnType<typeof execFile> | undefined;
	const component = createSidebarComponent({
		getSnapshot: options.getSnapshot,
		getConfig: options.getConfig,
		getHeight: () => height,
		canRenderImages: () => false,
		theme: liveTheme(options.ctx),
		colorEnabled: options.colorEnabled ?? true,
	});
	const tmux = (...args: string[]) =>
		execFileSync("tmux", [...prefix, ...args], {
			encoding: "utf8",
			timeout: 1500,
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	const report = (error: unknown) => {
		try {
			options.onError?.(error);
		} catch {
			// Cleanup must still finish when the host is already shutting down.
		}
	};
	const hide = () => {
		const previous = pane;
		pane = undefined;
		clearInterval(timer);
		timer = undefined;
		query?.kill();
		query = undefined;
		process.removeListener("exit", hide);
		if (!previous) return;
		previous.writer.stdin?.destroy();
		previous.writer.kill();
		try {
			if (tmux("display-message", "-p", "-t", previous.id, `#{${OWNER_OPTION}}`) === owner)
				tmux("kill-pane", "-t", previous.id);
		} catch {
			// A manually closed pane or stopped server is already released.
		}
	};
	const requestRender = () => {
		const current = pane;
		if (disposed || !current || query) return;
		const request = execFile(
			"tmux",
			[...prefix, "display-message", "-p", "-t", current.id, `#{${OWNER_OPTION}}\t#{pane_width}\t#{pane_height}`],
			{ encoding: "utf8", timeout: 1500 },
			(error, stdout) => {
				if (query === request) query = undefined;
				if (disposed || pane !== current) return;
				const [tag, columns, rows] = stdout.trim().split("\t");
				if (error || tag !== owner) {
					hide();
					return;
				}
				const width = Number(columns);
				height = Number(rows);
				if (![width, height].every((size) => Number.isInteger(size) && size > 0 && size <= 1000)) return;
				try {
					const lines = component.render(width).slice(0, height);
					const frame = `\u001b[?25l\u001b[?7l${lines
						.map((line, index) => `\u001b[${index + 1};1H\u001b[2K${truncateToWidth(line, width, "")}\u001b[0m`)
						.join("")}${lines.length < height ? `\u001b[${lines.length + 1};1H\u001b[J` : ""}`;
					const input = current.writer.stdin;
					if (frame !== current.frame && input && !input.destroyed && input.writableLength < 65536) {
						input.write(frame);
						current.frame = frame;
					}
				} catch (renderError) {
					hide();
					report(renderError);
				}
			},
		);
		query = request;
	};
	const show = () => {
		if (disposed || pane) return;
		if (options.ctx.mode !== "tui") return;
		let created: string | undefined;
		try {
			const available = Number(tmux("display-message", "-p", "-t", main, "#{pane_width}")) - MIN_MAIN_WIDTH - 1;
			if (available < MIN_SIDEBAR_WIDTH) {
				options.onWarning?.("The tmux sidebar needs at least 93 columns in the OMK pane");
				return;
			}
			created = tmux(
				"split-window",
				"-h",
				"-d",
				"-l",
				String(Math.min(DEFAULT_SIDEBAR_WIDTH, available)),
				"-t",
				main,
				"-P",
				"-F",
				"#{pane_id}",
				"",
			);
			if (!/^%\d+$/.test(created)) throw new Error("tmux did not return a sidebar pane ID");
			tmux("set-option", "-p", "-t", created, OWNER_OPTION, owner);
			const writer = spawn("tmux", [...prefix, "display-message", "-I", "-t", created], {
				stdio: ["pipe", "ignore", "ignore"],
			});
			const current = { id: created, writer, frame: "" };
			pane = current;
			const failed = (error: unknown) => {
				if (pane !== current) return;
				hide();
				report(error);
			};
			writer.on("error", failed);
			writer.stdin.on("error", failed);
			writer.once("close", () => failed(new Error("tmux sidebar output closed")));
			process.once("exit", hide);
			timer = setInterval(requestRender, REFRESH_MS);
			timer.unref();
			requestRender();
		} catch (error) {
			hide();
			if (created && /^%\d+$/.test(created)) {
				try {
					tmux("kill-pane", "-t", created);
				} catch {
					// The failed creation may already have removed its pane.
				}
			}
			report(error);
		}
	};
	return {
		show,
		hide,
		toggle: () => (pane ? hide() : show()),
		setMode(mode) {
			if (mode === "auto") options.onWarning?.("tmux owns sidebar sizing; use its pane divider or resize-pane");
		},
		getStatus: () => ({ mode: "manual", enabled: !!pane, presentation: pane ? "shown" : "off" }),
		isVisible: () => !!pane,
		isResizing: () => false,
		beginResize() {
			options.onWarning?.("Resize the sidebar with tmux's pane divider or resize-pane");
			return false;
		},
		requestRender,
		dispose() {
			disposed = true;
			hide();
		},
	};
}
