import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TUI } from "omk-tui";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { resetDebugTimingForTests } from "../src/core/debug-timing.ts";
import { debugTimingHookTargets, installDebugTimingHooks } from "../src/core/debug-timing-hooks.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

let server: http.Server;
let port = 0;
beforeAll(async () => {
	server = http.createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			res.writeHead(200, { "content-type": "text/event-stream" });
			const w = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
			const chunk = (delta: unknown, finish: string | null) =>
				w({
					id: "c",
					object: "chat.completion.chunk",
					created: 0,
					model: "m",
					choices: [{ index: 0, delta, finish_reason: finish }],
				});
			chunk({ role: "assistant", content: "ok" }, null);
			chunk({}, "stop");
			res.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	port = (server.address() as { port: number }).port;
});
afterAll(() => {
	server.close();
	resetDebugTimingForTests();
});

class NullTerminal {
	columns = 100;
	rows = 30;
	start() {}
	stop() {}
	async drainInput() {}
	write() {}
	get kittyProtocolActive() {
		return false;
	}
	moveBy() {}
	hideCursor() {}
	showCursor() {}
	clearLine() {}
	clearFromCursor() {}
	clearScreen() {}
	setTitle() {}
	setProgress() {}
}

async function drive(env: NodeJS.ProcessEnv): Promise<void> {
	const home = mkdtempSync(join(tmpdir(), "omk-spec065-"));
	const agentDir = join(home, "agent");
	const cwd = join(home, "proj");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	const fakeModels = ["m-0", "m-1"].map((id) => ({ id, contextWindow: 100000, maxTokens: 1024 }));
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				fake: {
					baseUrl: `http://127.0.0.1:${port}/v1`,
					api: "openai-completions",
					apiKey: "not-a-secret",
					compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
					models: fakeModels,
				},
			},
		}),
	);
	installDebugTimingHooks(env);
	initTheme("dark");
	const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
	const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
	await resourceLoader.reload();
	const model = modelRegistry.find("fake", "m-0");
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model,
		authStorage,
		modelRegistry,
		settingsManager,
		sessionManager: SessionManager.create(cwd, join(agentDir, "sessions")),
		resourceLoader,
	});
	const tui = new TUI(new NullTerminal() as never);
	await new Promise<void>((resolve) => {
		const realRender = tui.requestRender.bind(tui);
		const selector = new ModelSelectorComponent(
			{
				requestRender: (force?: boolean) => {
					realRender(force);
					setTimeout(resolve, 40);
				},
			} as never,
			model,
			settingsManager,
			modelRegistry,
			[],
			() => {},
			() => {},
		);
		tui.addChild(selector);
	});
	await session.setModel(modelRegistry.find("fake", "m-1")!);
	await session.prompt("hello");
	tui.stop();
}

describe("spec 065 OMK_TIMING debug timing", () => {
	it("every hooked method name exists on its target (a rename must fail here)", () => {
		const { spans, timed, render } = debugTimingHookTargets();
		const missing = [...spans, ...timed, render]
			.filter(([target, method]) => typeof (target as Record<string, unknown>)[method] !== "function")
			.map(([target, method]) => `${(target as { constructor: { name: string } }).constructor.name}.${method}`);
		expect(missing).toEqual([]);
		expect(spans.length + timed.length + 1).toBe(20);
	});

	it("off: installs nothing and writes nothing", async () => {
		const file = join(mkdtempSync(join(tmpdir(), "omk-spec065-off-")), "timing.log");
		const prompt = AgentSession.prototype.prompt;
		const loadModels = Object.getOwnPropertyDescriptor(ModelSelectorComponent.prototype, "loadModels")?.value;
		expect(installDebugTimingHooks({ OMK_TIMING_FILE: file })).toBe(false);
		await drive({ OMK_TIMING_FILE: file });
		expect(AgentSession.prototype.prompt).toBe(prompt);
		expect(Object.getOwnPropertyDescriptor(ModelSelectorComponent.prototype, "loadModels")?.value).toBe(loadModels);
		expect(existsSync(file)).toBe(false);
	}, 60000);

	it("on: logs model.open, model.apply and enter with their phases", async () => {
		const file = join(mkdtempSync(join(tmpdir(), "omk-spec065-on-")), "timing.log");
		await drive({ OMK_TIMING: "1", OMK_TIMING_FILE: file });
		const log = readFileSync(file, "utf8");
		if (process.env.SPEC065_PRINT) console.log(log);
		const line = (span: string) => log.split("\n").find((l) => l.includes(` ${span} total=`)) ?? "";
		expect(line("model.open")).toMatch(/firstFrame.*registry\.refresh=.*auth\.getAvailable=/);
		expect(line("model.apply")).toMatch(/ ok .*session\.appendModelChange=.*settings\.write=/);
		expect(line("enter")).toMatch(/request\.sent .*admit=.*session\.appendMessage=.*streamFn\.entered@/);
		expect(log).not.toContain("not-a-secret");
	}, 60000);
});
