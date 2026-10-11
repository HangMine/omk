---
description: "Subagent workers start with --no-extensions; OMK_WORKER_EXTENSIONS opts named (or all) parent-loaded extensions back in, and the extension that registered the worker's model provider is forwarded automatically"
---

# Feature Specification: Workers don't load user extensions

**Specification ID**: `057-worker-no-extensions`
**Feature Branch**: `spec/worker-no-extensions` (spec), implementation branch after 053
**Created**: 2026-10-11
**Status**: Draft (spec only). Tech Lead approved the direction, decisions 1-8 and the answers to the four review questions (decisions 9-12). Open questions: none. Code starts after the P0 053 PR merges.
**Constitution**: [specs/constitution.md](../constitution.md)
**Input**: Tech Lead, after Staff Engineer's root-cause read of the pi-hermes-memory warning (`Memory auto-review failed in both transports … Memory mutation already in progress … spawn pi ENOENT`). Decisions are under [Decisions](#decisions-tech-lead-2026-10-11).
**Base**: main `f913f49`
**Order**: 053 (install safety and project trust gate), then this spec's implementation PR.

## Goal

A subagent worker loads only what the task needs. User extensions (global and project `packages`, `extensions` entries, auto-discovered `extensions/` directories) stay off in workers unless the user opts a named extension back in, or the worker's model provider comes from an extension. Skills, the command-safety gate and the built-in todo checklist are unchanged.

## Motivation

1. **Shared-state extensions multiply per worker.** With pi-hermes-memory 0.9.10 installed, every parallel worker loads its own copy. Each copy runs its own background review and writes the same `~/.pi/agent/pi-hermes-memory/*.md`, guarded by one cross-process SQLite lock (`~/.pi/agent/.pi-hermes-locks.sqlite`). The lock waits 5 s and then throws `Memory mutation already in progress` (`src/store/markdown-mutation-lock.ts:5,18-22` in the package). The extension labels that `provider_error` and falls back to a subprocess that runs a bare `pi` (`src/handlers/pi-child-process.ts:361-362`), which is not on PATH under omk. The user sees the warning. The memory path is hard-coded to `~/.pi/agent` unless `PI_CODING_AGENT_DIR` is set (`src/paths.ts:7-9`), so the copies cannot be told apart either. Workers are short-lived and headless, so a memory/learning extension in them adds contention and no value. The upstream defects are filed separately (`pi-hermes-memory` issue draft); this spec removes omk's share of the problem.
2. **Worker startup diet (spec 043).** 043 cut 131 modules from the worker start path but explicitly left "the worker argv, worker env, providers, tools, or the session runtime" alone (`specs/043-worker-startup-diet/spec.md:147`), and measured without user extensions. A user with extensions installed pays their import and factory cost once per worker, plus their event handlers on every turn.

## Background (code on main `f913f49`)

- **Worker argv is built from scratch** in the subagent extension: `["--mode","json","-p","--no-session"]`, then `--model`, `--tools`, optional `--no-skills --skill …` (capability enforcement), `--append-system-prompt <file>`, `Task: …` (`examples/extensions/subagent/index.ts:338-422`). The binary is the parent's own entry point, `process.execPath` + `argv[1]` (`index.ts:304-318`), spawned with `subagentWorkerEnv(process.env)` (`index.ts:424-430`). No `--no-extensions`, and none of the parent's `-e` paths.
- **Agents without `model` get the parent's current model** as `provider/id` (`index.ts:635-637`), so a worker's `--model` is set whenever the parent has a model.
- **Worker env** (`examples/extensions/subagent/worker-env.ts`) drops lead-only vars and sets `OMK_FINISH_CHECK`, `OMK_DELIVERABLE_GUARD=0` and `OMK_RUN_LOG_ROLE`. Nothing about extensions. On the 053 branch it also sets `OMK_TRUST_PROJECT` per R6b.
- **The worker loads every user extension.** `main.ts:662,679-684` → `DefaultResourceLoader.reload()` → `packageManager.resolve()` (`resource-loader.ts:392`): project then global `packages` (`package-manager.ts:763-768`), local `extensions` entries and auto-discovered dirs under `~/.omk/agent` and `<cwd>/.omk` (`package-manager.ts:774-800`). Loaded at `resource-loader.ts:466-468,476`.
- **The off switch already exists**: `--no-extensions` / `-ne` (`cli/args.ts:184-185`). Help: "Disable extension discovery (explicit -e paths still work)" (`cli/help.ts:71`), and the loader does exactly that: `this.noExtensions ? cliEnabledExtensions : mergePaths(cli, enabled)` (`resource-loader.ts:466-468`). The built-in todo checklist and the command-safety gate are added after user extensions and do not depend on the flag (`resource-loader.ts:478` onward). Skills are a separate switch (`--no-skills`). The only in-tree session that already turns extensions off is the verified-run reference session (`core/verified-run-session.ts:22-31`).
- **omk does not read `~/.pi/agent`.** omk's agent dir is `~/.omk/agent` / `OMK_CODING_AGENT_DIR` (`config.ts:501,522`), packages install under `agentDir/npm` (`package-manager.ts:1969,2019`), and spec 048 rules out reading Pi's settings or packages (`specs/048-pi-compat/spec.md:99,216`). A pi package reaches omk only through `omk install` or `-e`.
- **Provider ownership is known at registration, then dropped.** The per-extension API passes the owner: `registerProvider(name, config) { runtime.registerProvider(name, config, extension.path) }` (`core/extensions/loader.ts:411-414`). Before bind, the runtime queues `{ name, config, extensionPath }` (`loader.ts:240-242`). The queue is flushed into the model registry by `ExtensionRunner.bindCore()` (`core/extensions/runner.ts:313-329`) or by `createAgentSessionServices` (`core/agent-session-services.ts:155-166`), and the path is used only for error messages. After bind, the runtime's `registerProvider` ignores the third argument (`runner.ts:333-339`). `ModelRegistry.registeredProviders` is `Map<providerName, config>` with no owner (`core/model-registry.ts:289,845-864`). So today nothing can answer "which extension registered provider X".
- **An extension cannot list the loaded extensions.** `ExtensionAPI` has `getAllTools()` (tool `sourceInfo`) but no accessor for loaded extensions or provider owners (`core/extensions/types.ts`). `Extension` carries `path`, `resolvedPath`, `sourceInfo` (`types.ts:1603-1615`). `SourceInfo` is `{ path, source, scope, origin, baseDir? }` (`core/source-info.ts:6-12`).

## Requirements

### Default

- **R1** The subagent worker argv contains `--no-extensions` by default, placed right after `--no-session`. Nothing else in the argv changes. Skills, `--no-skills`/`--skill` enforcement, prompt templates, context files, the command-safety gate and the todo checklist behave as today.
- **R2** The parent's own `-e` list is not forwarded (today's behavior, kept). The only `-e` arguments a worker gets come from R3 and R5.

### Opt-in: `OMK_WORKER_EXTENSIONS`

- **R3** `OMK_WORKER_EXTENSIONS` in the parent's environment is either `all` or a comma-separated list of names. Whitespace around entries is trimmed, and empty entries are ignored.
  - `all`: the worker argv omits `--no-extensions`, and the worker discovers extensions as it does today (still subject to the worker's own 053 trust decision).
  - Names: each entry is matched against the extensions **the parent actually loaded** (R6). Every match is forwarded as `-e <absolute resolvedPath>`.
- **R4** Matching rules, in order:
  1. An entry equal to a loaded extension's absolute `resolvedPath` matches that one extension. This is the only way to choose between same-named extensions; there is no `user:`/`project:` prefix.
  2. An entry equal to a loaded extension's **name** matches. The name is: for `origin: "package"`, the package name from `sourceInfo.source` (`npm:@scope/name@1.2.3` → `@scope/name`, `git:host/owner/repo@ref` → `repo`); otherwise the file basename without extension, or the parent directory name when the file is `index.{ts,js,mjs}`.
  3. A name matching more than one loaded extension forwards **none** of them for that entry, with one warning (R7) listing the candidates' absolute paths and saying to name the one wanted by its absolute path.
  4. No match: nothing forwarded, one warning.
- **R5** **Provider auto-forward.** Before spawning, the parent resolves the worker's `--model` (pinned `provider/id`, inherited `provider/id`, or a bare id resolved through `ctx.modelRegistry`) to a provider name. If that provider is owned by a loaded extension (R6), that one extension is forwarded as `-e <absolute resolvedPath>`, in addition to R3, de-duplicated. All other extensions stay off. No model (the parent has none and the agent pins none): no auto-forward.
- **R6** **Only parent-loaded extensions, only paths.** Forwarded values are always absolute paths of extensions present in the parent's loaded set at spawn time. They passed the parent's 053 trust gate (project extensions load only from a trusted project). An entry that looks like a package source (`npm:`, `git:`, `http(s):`, `ssh:`, or any `<scheme>:` prefix other than a Windows drive letter) is never forwarded, even if it matches. It gets a warning, because a source in a worker's `-e` would resolve and possibly install there.
- **R7** Warnings from R4/R6 go to the parent's stderr, prefixed `omk subagent: OMK_WORKER_EXTENSIONS`. Each distinct message is printed once per parent process. A warning never stops a spawn.
- **R8** `OMK_WORKER_EXTENSIONS` is inherited by workers through `subagentWorkerEnv` (unchanged pass-through), so a worker that spawns its own workers applies the same rule to its own loaded set.

### Provider ownership tracking (minimal)

- **R9** `ExtensionRuntime` gains `providerOwners: Map<string, string>` (provider name → owning extension's `resolvedPath`). It is written in the per-extension wrapper in `loader.ts` (`registerProvider`, `:411-414`) before delegating, so it covers both the pre-bind queue and post-bind direct calls without touching `runner.ts`'s replacement closures. The per-extension `unregisterProvider` (`:416-419`) deletes the entry only when this extension owns it. The last registration wins, matching `ModelRegistry.upsertRegisteredProvider`. A fresh runtime per `loadExtensions()` resets the map on `/reload`.
- **R10** **Internal hook, not public API.** The loaded-extension list is exposed only to the bundled subagent, through an internal accessor:
  - The loader attaches a non-enumerable, non-writable property keyed by `Symbol.for("omk.internal.loadedExtensions")` to each per-extension API object it builds (`loader.ts`, next to `registerProvider`). Its value is a function returning `ReadonlyArray<LoadedExtensionInfo>`, where `LoadedExtensionInfo = { name, path, resolvedPath, source, scope, origin, providers: string[] }`. `name` follows R4.2, and `providers` comes from `providerOwners`. Each call returns a fresh, frozen array; mutating it changes nothing.
  - The symbol, the function type and `LoadedExtensionInfo` live in an internal module (`core/extensions/internal-loaded-extensions.ts`, new). It is **not** added to the `ExtensionAPI` interface, not exported from the package index (`src/index.ts`), and not documented in `docs/extensions.md`.
  - The subagent reads it through a small typed helper in `examples/extensions/subagent/worker-extensions.ts` (`readLoadedExtensions(omk)`). If the property is missing (an older or foreign host), the subagent applies R1 and `all` as specified, forwards nothing by name or provider, and prints one R7 warning when `OMK_WORKER_EXTENSIONS` names entries it cannot resolve.
  - **Pi compat (048) surface is unchanged.** The Pi alias targets and 048's adapter export shims re-export nothing new, and the package doctor's export comparison sees no new name. A Pi extension cannot reach the accessor except by the same `Symbol.for` key, which is undocumented and carries no stability promise.
- **R11** **Built-in overrides count as owners.** An extension that only overrides a built-in provider's `baseUrl`/`headers` (`registerProvider("anthropic", { baseUrl, headers })`, documented at `types.ts:1326`) owns that provider name for R5, exactly like an extension that defines a new provider. A worker on `anthropic/*` then gets that extension. Without it, the worker would send requests to the built-in endpoint without the proxy or auth headers.

### Relation to 053

- **R12** With `--no-extensions`, project extensions (`.omk/settings.json` `extensions`/`packages`, `.omk/extensions/`) do not load in a worker regardless of its `OMK_TRUST_PROJECT`. 053 R6b still decides the worker's trust for everything else it gates (`npmCommand`, `shellPath`, `shellCommandPrefix`, and project `packages` for their skills). Under `all`, the worker's own 053 decision applies to its discovery as today. A forwarded `-e` path is a CLI path and is not re-gated in the worker; R6 guarantees the parent loaded it, so it was already trusted there.

## Design

| Piece | File | Notes |
| --- | --- | --- |
| Owner map | `core/extensions/loader.ts`, `core/extensions/types.ts` (`ExtensionRuntime`) | R9. Set in the per-extension wrapper; no change to `runner.ts` closures or `ModelRegistry`. |
| Internal accessor | `core/extensions/internal-loaded-extensions.ts` (new: symbol, `LoadedExtensionInfo`, name derivation), `core/extensions/loader.ts` (attaches the symbol property) | R10. Backed by the loader's extension list for this runtime. Not in `ExtensionAPI`, not exported from `src/index.ts`, no 048 shim change. |
| Worker args | `examples/extensions/subagent/worker-extensions.ts` (new) | Pure function `workerExtensionArgs({ env, loaded, workerProvider })` → `{ args: string[]; warnings: string[] }`. Implements R1, R3-R7. No I/O. Also `readLoadedExtensions(omk)` (R10 fallback when the symbol is absent). |
| Wiring | `examples/extensions/subagent/index.ts` | Insert `--no-extensions` (unless `all`) and the `-e` list in `runSingleAgentAttempt` (`:338`). Resolve the worker provider from `agent.model` and `ctx.modelRegistry`. Print warnings once. |
| Env | `examples/extensions/subagent/worker-env.ts` | No code change needed (spread already passes `OMK_WORKER_EXTENSIONS`); doc comment updated. |
| Docs | `docs/environment-variables.md`, `examples/extensions/subagent/README.md` | Variable, matching rules, provider auto-forward, re-enable line. `docs/extensions.md` gets one sentence saying workers start with `--no-extensions`; the internal accessor is not documented. |
| CHANGELOG | `packages/coding-agent/CHANGELOG.md` | `[Unreleased]` → new `### Breaking` section (text below). |

Proposed CHANGELOG text:

> ### Breaking
>
> - Subagent workers no longer load user extensions: the worker command line now includes `--no-extensions`. Skills, the command-safety gate and the todo checklist are unchanged, and the extension that registered the worker's model provider is still loaded automatically. To keep extensions in workers, set `OMK_WORKER_EXTENSIONS=all` or a comma-separated list of extension names (for example `OMK_WORKER_EXTENSIONS=my-mcp-adapter`).

## Tests

Unit, `examples/extensions/subagent/worker-extensions.test.ts`:

1. Default: no env → args contain `--no-extensions` and no `-e`.
2. Named opt-in: `OMK_WORKER_EXTENSIONS=a` with loaded `a` → `--no-extensions -e <abs path of a>`. Package-origin names (`npm:@s/a@1` → `@s/a`) and `index.ts` dir names resolve.
3. `all` → no `--no-extensions`, no `-e`.
4. Parent `-e` not forwarded: a loaded extension with `source: "cli"` that is not named and owns no provider is absent.
5. Provider auto-forward: worker provider `p` owned by `x`, two other loaded extensions → exactly `-e <x>`. A provider owned by nobody (built-in, not overridden) → nothing. Provider-owner plus a named entry for the same extension → one `-e`.
5b. Built-in override (R11): extension `proxy` registered only `{ baseUrl, headers }` for built-in `anthropic`, worker model `anthropic/<id>`, one other loaded extension → exactly `-e <proxy>`.
6. Sources never forwarded: `npm:a`, `git:github.com/o/a`, `https://…` → no `-e`, one warning each. A Windows path `C:\x\a.ts` is not mistaken for a scheme.
7. Collisions: two loaded extensions named `a` → none forwarded, one warning listing both absolute paths; giving one of those absolute paths forwards exactly that one.
9. Missing internal accessor (R10): `readLoadedExtensions` on an API object without the symbol → empty list; default still adds `--no-extensions`, `all` still omits it, a named entry warns once.
8. Unknown name → nothing forwarded, one warning. Duplicates and whitespace are handled.

Unit, `test/extension-provider-owners.test.ts`: a fixture extension calling `registerProvider` at load and again after bind is listed as owner by the internal accessor; an extension overriding only `baseUrl`/`headers` of a built-in provider is listed as its owner; `unregisterProvider` by a non-owner leaves the entry; the owner's unregister removes it; `/reload` resets it. The accessor property is non-enumerable, `ExtensionAPI`'s type has no such member, and `src/index.ts` exports none of the internal module's names.

Unit, `examples/extensions/subagent/worker-env.test.ts`: `OMK_WORKER_EXTENSIONS` passes through unchanged.

Integration, `test/subagent-worker-extensions.integration.test.ts` (mock OpenAI-compatible provider, temp `OMK_CODING_AGENT_DIR` with a fixture global extension that writes a marker file on load):

- default spawn → worker answers, no marker;
- `OMK_WORKER_EXTENSIONS=<fixture name>` → marker;
- fixture extension registers provider `fixture-mock` and the agent pins `fixture-mock/m1` → marker, and a second fixture extension's marker is absent;
- command-safety gate still blocks a blocked command in the worker (the worker's bash tool call is refused) with `--no-extensions` set;
- every run uses `OMK_TRUST_PROJECT=0`.

## Measurement

Spec 043 harness (`specs/043-worker-startup-diet/bench/`), quiet box, `PAUSE` gate honored, 20 interleaved pairs, `OMK_TRUST_PROJECT=0` in both arms, no profiler. Arm A is main's worker argv; arm B is the same argv as produced by `workerExtensionArgs` (a unit test pins that the harness argv equals the builder output). Judge: Bench Analyst's `paired_verdict.py` on `pairs.tsv` (bootstrap 95 % CI of the median paired difference).

| Env | Criterion | Kind |
| --- | --- | --- |
| (a) No user extensions installed | Team paired rule (not IQR). Time (`startup_ms`, `fast`) is a **regression, blocking**, when the 95 % CI lower bound of the paired difference (branch − main) is > 0 **and** its median is ≥ +5 ms. RSS (`peak_mib` in `fast`, `idle_mib` in `slow`) uses the same rule with +5 MiB. Anything else passes. | Gate |
| (b) 1 and 2 fixture extensions installed globally (one trivial, one importing a mid-size dependency) | Worker `startup_ms`, `peak_mib`, `idle_mib` for main vs branch, medians, p90, paired difference with CI | Report only |

Results go to the PR body with the raw `pairs.tsv`, and the env (`OMK_TRUST_PROJECT=0`, no parent `AGENTS.md` on the cwd path) is written into the record.

## Acceptance criteria

- [ ] R1-R12 covered by the tests above, all green.
- [ ] `npm run check` green (biome, module-size, import-cycles, tsgo).
- [ ] Measurement (a) passes; (b) reported.
- [ ] CHANGELOG `### Breaking` entry with the re-enable line; docs updated.
- [ ] Manual check: with pi-hermes-memory installed via `omk install`, a parallel subagent run of 4 workers shows no `Memory auto-review failed` warning from workers, and the parent's own memory review still runs.

## Non-goals

- Forwarding the parent's `-e` list to workers (R2 keeps today's behavior).
- A per-worker `PI_CODING_AGENT_DIR` or agent dir to isolate extension state.
- A `pi` shim or any mapping of `pi` spawns to omk (Tech Lead decision, 2026-10-11).
- Fixing pi-hermes-memory itself (upstream issue draft covers the hardcoded `pi` and the lock reporting).
- Changing skills, prompt templates or context-file loading in workers.
- Non-subagent spawn paths. The verified-run session already runs with `noExtensions` (`verified-run-session.ts:22-31`).

## Known risks

- **Tools and auth from extensions vanish in workers.** MCP adapters, custom tools and auth adapters that do not register a provider (for example ones that inject headers in `before_provider_request`) are no longer present in workers. Agents whose `--tools` list names an extension tool will see it missing. Mitigation: the Breaking entry and docs name `OMK_WORKER_EXTENSIONS`. Optionally, a later follow-up could warn when an agent's `tools` list names a tool owned by an extension that is not forwarded (tool `sourceInfo` is already available).
- **Name collisions.** Two extensions with the same derived name (a local `memory.ts` and a package `memory`) forward neither. The warning lists both absolute paths, which can be used instead.
- **Provider resolution mismatch.** The parent resolves a bare model id with its own registry. If the worker would resolve it differently (different settings in the worker's cwd), auto-forward can pick the wrong owner or none. Pinned `provider/id` (the inherited form) avoids this.
- **Forwarded project extensions bypass the worker's gate.** A project extension path forwarded by name loads in the worker even if the worker's cwd would not be trusted. R6 limits this to code the parent already trusted and loaded. A worker cwd in a different project is the residual case (same as 053's Known risks on worker trust).
- **Different cwd is a functional risk, not a trust bypass.** A worker may run in a different cwd than the parent (the subagent `cwd` parameter). A forwarded path is still code the parent trusted and loaded, so no untrusted code runs. The extension does see a different project than it did in the parent (its `ctx.cwd`, project config, and any per-project state), which can change what it does.
- **Module-size baselines.** `types.ts` and `loader.ts` may be at their size limits. The accessor, its type and the name helper already go in the new internal module; only the owner map touches `types.ts`.
- **Pi compatibility.** The accessor is internal and symbol-keyed. The 048 surface (aliases, export shims, doctor export list) is unchanged.

## Expected files

- `specs/057-worker-no-extensions/spec.md` (this spec, first commit)
- `packages/coding-agent/src/core/extensions/loader.ts`, `types.ts` (`ExtensionRuntime.providerOwners` only), `internal-loaded-extensions.ts` (new)
- `packages/coding-agent/examples/extensions/subagent/worker-extensions.ts` (new), `index.ts`, `worker-env.ts` (comment), `README.md`
- Tests: `examples/extensions/subagent/worker-extensions.test.ts` (new), `worker-env.test.ts`, `test/extension-provider-owners.test.ts` (new), `test/subagent-worker-extensions.integration.test.ts` (new)
- `packages/coding-agent/docs/environment-variables.md`, `docs/extensions.md` (one sentence)
- `packages/coding-agent/CHANGELOG.md`

## Decisions (Tech Lead, 2026-10-11)

1. Workers start with `--no-extensions` by default; built-ins unaffected (R1).
2. The parent's `-e` list is not forwarded (R2).
3. `OMK_WORKER_EXTENSIONS=name1,name2|all`; only parent-loaded extensions, absolute paths, never sources; `all` omits the flag; inherited via worker env (R3-R8).
4. The extension that registered the worker's model provider is forwarded automatically (R5, tracking R9-R11).
5. CHANGELOG under Breaking with the re-enable line.
6. Measurement on the 043 harness, 20 pairs, `OMK_TRUST_PROJECT=0`, no profiler: no-extension env is a no-regression gate, fixture env is report-only.
7. Tests as listed.
8. Relation to 053 as R12.
9. **Loaded-extension list is internal.** Used only by the bundled subagent through a `Symbol.for` accessor; not added to `ExtensionAPI`, not exported, not documented; the 048 pi-compat surface is unchanged (R10).
10. **Built-in overrides own the provider.** An extension that only overrides a built-in provider's `baseUrl`/`headers` counts as owner and is auto-forwarded; otherwise a worker would call the wrong endpoint without auth. Dedicated unit test 5b (R11).
11. **Duplicate names.** Forward none, warn, choose by absolute path. No scope prefix (R4).
12. **Regression gate.** Team paired rule, not IQR: 043 harness, 20 interleaved pairs, `paired_verdict.py`. No-extension env: time blocks when the 95 % CI lower bound > 0 and median ≥ +5 ms; RSS same with +5 MiB. Fixture-extension env: report only. Tech Lead accepts the trust Known-risk wording; the different-cwd note was added as a functional risk.

Open questions: none.
