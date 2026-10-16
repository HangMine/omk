// Spec 062 UI-lag bench. Fake OpenAI-compatible server in-process; no real keys.
// usage: node lag-bench.mjs --worktree DIR --size small|large --runs 20 --providers 10 --models 50 --out f.json
import http from "node:http";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const worktree = arg("worktree"); const size = arg("size", "small"); const runs = +arg("runs", "20");
const nProv = +arg("providers", "10"); const nModels = +arg("models", "50"); const out = arg("out", "");
let tReq = 0;
const srv = http.createServer((req, res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
  if (!tReq) tReq = performance.now();
  res.writeHead(200, { "content-type": "text/event-stream" });
  const w = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  w({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] });
  w({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  w({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } });
  res.end("data: [DONE]\n\n"); }); });
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const port = srv.address().port;
const home = mkdtempSync(join(tmpdir(), "omk062-")); const agentDir = join(home, "agent"); const cwd = join(home, "proj");
mkdirSync(agentDir, { recursive: true }); mkdirSync(cwd, { recursive: true });
const providers = {};
for (let p = 0; p < nProv; p++) providers[`fake${p}`] = { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "not-a-secret",
  compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
  models: Array.from({ length: nModels }, (_, i) => ({ id: `model-${i}`, contextWindow: 1000000, maxTokens: 4096 })) };
writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers }));
writeFileSync(join(agentDir, "settings.json"), "{}"); writeFileSync(join(agentDir, "auth.json"), "{}");
process.env.OMK_CODING_AGENT_DIR = agentDir;
const m = await import(pathToFileURL(join(worktree, "packages/coding-agent/dist/index.js")).href);
const { createAgentSession, SessionManager, DefaultResourceLoader, SettingsManager, ModelRegistry, AuthStorage, ModelSelectorComponent, initTheme } = m;
initTheme?.("dark");
const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
const model = modelRegistry.find("fake0", "model-0");
const settingsManager = SettingsManager.create(cwd, agentDir);
const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager }); await resourceLoader.reload();
const sessionManager = SessionManager.create(cwd, join(agentDir, "sessions"));
const { session } = await createAgentSession({ cwd, agentDir, model, authStorage, modelRegistry, settingsManager, sessionManager, resourceLoader });
// seed history: large ~= 400 pairs x ~4000 chars (~400k tokens by chars/4)
const pairs = size === "large" ? 200 : 2; const body = "lorem ipsum dolor sit amet ".repeat(150); // ~4k chars
for (let i = 0; i < pairs; i++) {
  const u = { role: "user", content: [{ type: "text", text: `q${i} ${body}` }], timestamp: Date.now() };
  const a = { role: "assistant", content: [{ type: "text", text: `a${i} ${body}` }], api: "openai-completions", provider: "fake0", model: "model-0",
    usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
  sessionManager.appendMessage(u); sessionManager.appendMessage(a); session.agent.state.messages.push(u, a);
}
// segment timers
const seg = {}; const wrap = (obj, name, label) => { const f = obj?.[name]; if (typeof f !== "function") return console.error("nowrap", label);
  obj[name] = function (...a) { const t = performance.now(); const r = f.apply(this, a); const end = () => { (seg[label] ??= []).push(performance.now() - t); };
    if (r && typeof r.then === "function") return r.finally(end); end(); return r; }; };
wrap(session, "_checkCompaction", "checkCompaction"); wrap(session, "_checkProjectedCompaction", "checkProjectedCompaction");
wrap(session._turnAdmission, "admit", "turnAdmission.admit"); wrap(session._promptSkillFreeze, "turn", "promptSkillFreeze.turn");
wrap(session._extensionRunner, "emitBeforeAgentStart", "emitBeforeAgentStart"); wrap(session, "_ejectStickySafetyModelIfNeeded", "ejectSticky");
wrap(session, "_computePressureBucket", "computePressureBucket"); wrap(session, "_getContextBudgetOptions", "getContextBudgetOptions");
wrap(session._promptSkillFreeze.skillSearch, "logSession", "skillSearch.logSession");
let tPre = 0; wrap(session, "_runAgentPrompt", "runAgentPrompt(total)");
const origRun = session._runAgentPrompt; session._runAgentPrompt = function (...a) { tPre = performance.now(); return origRun.apply(this, a); };
const preReqAppend = [], postReqAppend = [];
{ const f = sessionManager.appendMessage.bind(sessionManager); sessionManager.appendMessage = (msg) => { const t = performance.now(); const r = f(msg); const d = performance.now() - t; if (measuring) (tReq ? postReqAppend : preReqAppend).push(d); return r; }; }
let measuring = false;
import("node:inspector").then(()=>{});
const { Session: InspSession } = await import("node:inspector/promises"); const insp = new InspSession(); insp.connect();
if (process.env.PROF) { await insp.post("Profiler.enable"); await insp.post("Profiler.start"); }
const enter = [], preflight = [];
for (let i = 0; i < runs + 2; i++) {
  tReq = 0; measuring = i >= 2; const t0 = performance.now(); await session.prompt(`bench ${i}`); measuring = false;
  if (i >= 2) { enter.push(tReq - t0); preflight.push(tPre - t0); }  // 2 warmups
  // keep history size constant: drop the turn we added
  session.agent.state.messages.splice(pairs * 2);
}
if (process.env.PROF) { const { profile } = await insp.post("Profiler.stop"); writeFileSync(process.env.PROF, JSON.stringify(profile)); }
for (const k of Object.keys(seg)) seg[k] = seg[k].slice(-runs);
// model selector
const tui = { requestRender() {} }; const open = [], render = [], filter = [], apply = [];
for (let i = 0; i < runs + 2; i++) {
  const t0 = performance.now(); let resolveLoaded; const loaded = new Promise((r) => (resolveLoaded = r));
  tui.requestRender = () => resolveLoaded();
  const sel = new ModelSelectorComponent(tui, session.model, settingsManager, modelRegistry, [], () => {}, () => {});
  const tCtor = performance.now(); await loaded; sel.render(120); const tR = performance.now();
  const tf = performance.now(); for (const ch of "model-4") sel.handleInput(ch), sel.render(120); const tfe = performance.now();
  const target = modelRegistry.find(`fake${nProv > 1 ? (i % (nProv - 1)) + 1 : 0}`, `model-${(i % (nModels-1))+1}`);
  const ta = performance.now(); await session.setModel(target); const tae = performance.now();
  if (i >= 2) { open.push(tCtor - t0); render.push(tR - t0); filter.push((tfe - tf) / 7); apply.push(tae - ta); }
}
const refreshT = [], availT = [], mcT = [], setDefT = [];
const st0 = (f, a) => { const t = performance.now(); f(); a.push(performance.now() - t); };
for (let i = 0; i < runs; i++) { st0(() => modelRegistry.refresh(), refreshT); st0(() => modelRegistry.getAvailable(), availT);
  st0(() => sessionManager.appendModelChange("fake0", "model-0"), mcT); st0(() => settingsManager.setDefaultModelAndProvider("fake0", "model-0"), setDefT); }
await session.setModel(model);
const st = (a) => { const s = [...a].sort((x, y) => x - y); const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, p50: +q(0.5).toFixed(2), p90: +q(0.9).toFixed(2), max: +s.at(-1).toFixed(2) }; };
const rep = { size, pairs, providers: nProv, modelsPerProvider: nModels, load1: +(await import("node:os")).loadavg()[0].toFixed(2),
  enterToRequest: st(enter), appendBeforeRequest: preReqAppend.length ? st(preReqAppend) : null, appendAfterRequest: postReqAppend.length ? st(postReqAppend) : null, preflightToRunAgentPrompt: st(preflight), segments: Object.fromEntries(Object.entries(seg).map(([k, v]) => [k, st(v)])),
  selector: { ctorSync: st(open), openToRendered: st(render), perKeystrokeFilterRender: st(filter), setModelApply: st(apply), registryRefresh: st(refreshT), getAvailable: st(availT), appendModelChange: st(mcT), setDefaultModelAndProvider: st(setDefT) } };
console.log(JSON.stringify(rep, null, 1)); if (out) writeFileSync(out, JSON.stringify(rep, null, 1));
srv.close(); process.exit(0);
