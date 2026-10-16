// Spec 062 render-path bench: keypress -> next doRender done, through real TUI scheduling, counting terminal.
// usage: node render-bench.mjs --worktree DIR --pairs 200 --runs 20 --out f.json
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir, loadavg } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const wt = arg("worktree"); const pairs = +arg("pairs", "200"); const runs = +arg("runs", "20"); const out = arg("out", "");
const home = mkdtempSync(join(tmpdir(), "omk062r-")); const agentDir = join(home, "agent"); mkdirSync(agentDir, { recursive: true });
const providers = {}; for (let p = 0; p < 10; p++) providers[`fake${p}`] = { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "not-a-secret",
  models: Array.from({ length: 50 }, (_, i) => ({ id: `model-${i}`, contextWindow: 1000000, maxTokens: 4096, reasoning: true })) };
writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers })); writeFileSync(join(agentDir, "settings.json"), "{}"); writeFileSync(join(agentDir, "auth.json"), "{}");
process.env.OMK_CODING_AGENT_DIR = agentDir;
const ca = await import(pathToFileURL(join(wt, "packages/coding-agent/dist/index.js")).href);
const tuiMod = await import(pathToFileURL(join(wt, "packages/tui/dist/index.js")).href);
const { TUI, Container, Text } = tuiMod;
const { UserMessageComponent, AssistantMessageComponent, ModelSelectorComponent, ThinkingSelectorComponent, SettingsManager, ModelRegistry, AuthStorage, initTheme } = ca;
initTheme?.("dark");
class Term { bytes = 0; columns = 120; rows = 40; start() {} stop() {} async drainInput() {} write(d) { this.bytes += d.length; } get kittyProtocolActive() { return false; }
  moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} }
const term = new Term(); const tui = new TUI(term);
const chat = new Container(); const editorC = new Container(); const editor = new Text("> ", 1, 0);
tui.addChild(new Text("OMK header", 1, 0)); tui.addChild(chat); tui.addChild(editorC); editorC.addChild(editor);
const body = "lorem ipsum dolor sit amet ".repeat(150);
const md = (i) => `## answer ${i}\n\n${body}\n\n- item a\n- item b\n\n\`\`\`ts\nconst x${i} = ${i};\n\`\`\`\n`;
for (let i = 0; i < pairs; i++) {
  chat.addChild(new UserMessageComponent(`q${i} ${body}`));
  chat.addChild(new AssistantMessageComponent({ role: "assistant", content: [{ type: "text", text: md(i) }], api: "openai-completions", provider: "fake0", model: "model-0",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 0 }));
}
let frameWaiters = []; const renderMs = [];
const orig = tui.doRender.bind(tui); tui.doRender = (...a) => { const t = performance.now(); orig(...a); const e = performance.now(); renderMs.push(e - t); const w = frameWaiters; frameWaiters = []; w.forEach((f) => f(e)); };
const nextFrame = () => new Promise((r) => frameWaiters.push(r));
tui.requestRender(); await nextFrame(); const lines = tui.previousLines.length;
const authStorage = AuthStorage.create(join(agentDir, "auth.json")); const reg = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
const sm = SettingsManager.create(home, agentDir); let current = reg.find("fake0", "model-0");
const show = (c) => { editorC.clear(); editorC.addChild(c); tui.setFocus(c); tui.requestRender(); };
const done = () => { editorC.clear(); editorC.addChild(editor); tui.setFocus(editor); };
const R = { openModel: [], filterKey: [], selectModelFrame: [], openThinking: [], thinkingMove: [], thinkingSelect: [], enterEcho: [], frameRender: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < runs + 2; i++) {
  const keep = i >= 2; const push = (k, v) => keep && R[k].push(v);
  await sleep(40); // past MIN_RENDER_INTERVAL so each sample is a fresh frame
  let t = performance.now(); let loaded; const ld = new Promise((r) => (loaded = r));
  const realReq = tui.requestRender.bind(tui);
  const sel = new ModelSelectorComponent({ requestRender: (f) => { realReq(f); loaded(); } }, current, sm, reg, [], (m) => { current = m; done(); tui.requestRender(); }, done);
  show(sel); await ld; await nextFrame(); push("openModel", performance.now() - t);
  await sleep(40); t = performance.now(); sel.handleInput("4"); tui.requestRender(); await nextFrame(); push("filterKey", performance.now() - t);
  sel.handleInput("\x7f"); await sleep(40);
  t = performance.now(); sel.handleInput("\r"); await nextFrame(); push("selectModelFrame", performance.now() - t);
  // thinking selector (interactive-mode opens it right after a model select)
  await sleep(40); t = performance.now();
  const th = new ThinkingSelectorComponent("medium", ["off", "minimal", "low", "medium", "high", "xhigh"], () => { done(); tui.requestRender(); }, () => { done(); tui.requestRender(); });
  show(th); const thl = th.getSelectList(); tui.setFocus(thl); await nextFrame(); push("openThinking", performance.now() - t);
  await sleep(40); t = performance.now(); thl.handleInput("\x1b[B"); tui.requestRender(); await nextFrame(); push("thinkingMove", performance.now() - t);
  await sleep(40); t = performance.now(); thl.handleInput("\r"); await nextFrame(); push("thinkingSelect", performance.now() - t);
  // Enter -> user message echoed (interactive-mode adds UserMessageComponent + loader, then requestRender)
  await sleep(40); t = performance.now(); const um = new UserMessageComponent(`bench ${i}`); chat.addChild(um); chat.addChild(new Text("⠋ Working...", 1, 0)); tui.requestRender();
  await nextFrame(); push("enterEcho", performance.now() - t); chat.removeChild(um); chat.children.pop();
}
R.frameRender = renderMs.slice(-runs * 6);
const st = (a) => { const s = [...a].sort((x, y) => x - y); const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, p50: +q(0.5).toFixed(2), p90: +q(0.9).toFixed(2), p95: +q(0.95).toFixed(2), max: +s.at(-1).toFixed(2) }; };
const rep = { pairs, lines, load1: +loadavg()[0].toFixed(2), ...Object.fromEntries(Object.entries(R).map(([k, v]) => [k, st(v)])) };
console.log(JSON.stringify(rep)); if (out) writeFileSync(out, JSON.stringify(rep, null, 1)); tui.stop?.(); process.exit(0);
