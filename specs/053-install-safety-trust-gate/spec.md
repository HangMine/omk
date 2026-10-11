---
description: "P0 security: package install scripts off by default, and a project trust gate before a cloned repo's packages, extensions and shell settings load"
---

# Feature Specification: Install scripts off by default, project trust gate

**Specification ID**: `053-install-safety-trust-gate`
**Feature Branch**: `fix/install-safety-trust-gate` (off main `f913f49`)
**Created**: 2026-10-11
**Status**: Implemented on the branch (base main `f913f49`), not pushed; Tech Lead decisions applied; manual E2E results in the PR
**Constitution**: [specs/constitution.md](../constitution.md)
**Input**: Spec 048 (#118) decisions 5 and 7 by Tech Lead: install safety ships first as a separate P0 PR, before the pi adapter, together with a project trust gate that is independent of pi compat. Follow-up on #118: the trust env is `OMK_TRUST_PROJECT=1`, and opening the gate through it prints exactly one stderr line naming the trusted project path. Tech Lead's answers to this spec's 5 questions are under [Decisions](#decisions-tech-lead-2026-10-11).
**Order**: this PR, then the 048 adapter PR (which reads `isProjectTrusted()` from this gate).

## Problem (code on main `ccb7f1f`)

1. `omk install` runs package lifecycle scripts. `DefaultPackageManager.getNpmInstallArgs()` added `--ignore-scripts` only when a caller passed `ignoreScripts=true`; `install()`, `update()`, startup installs and `-e` never did. Git packages ran a bare `npm install` (`getGitDependencyInstallArgs()`).
2. A cloned repository runs code on the first `omk` in it. `DefaultResourceLoader.reload()` calls `packageManager.resolve()` with no `onMissing` callback, and `resolvePackageSources()` then installs every missing npm/git package named in the project's `.omk/settings.json` (`installMissing()` → `installParsedSource()`), scripts included, and loads its extensions. Project `extensions` entries and `.omk/extensions/` load the same way. `npmCommand`, `shellPath` and `shellCommandPrefix` come from the merged settings, so a project file can choose the program omk spawns for npm and for every `bash` tool call.
3. `omk install`, `omk update` and `omk config` inside such a repository use its `npmCommand` too.

MCP already has a project trust gate (`core/mcp/config.ts`, `OMK_TRUST_PROJECT_MCP`, `~/.omk/mcp-trust.json`); packages and extensions had none.

## Requirements

### Install scripts

- **R1** Every managed install skips lifecycle scripts by default: npm/bun/pnpm installs get `--ignore-scripts`, git package dependency installs get `--ignore-scripts`. This covers `omk install`, `omk update`, startup installs of missing project packages, and `-e`.
- **R2** `omk install --allow-scripts <source>` and `omk update --allow-scripts [...]` run scripts for that command only. Installs that happen on their own (startup, `-e`) never run scripts. Other commands reject the flag.
- **R3** A failure names the option: a failed `omk install`/`omk update` without `--allow-scripts` prints `omk install --allow-scripts <source>` (or `omk update --allow-scripts`); an extension that fails to load with a skipped-native-build symptom (missing bindings file, missing `.node`, "No native build was found", missing `build/`/`dist/` module, ...) gets the same hint appended to its diagnostic.

### Project trust gate

- **R4** Gated project code: `.omk/settings.json` keys `packages`, `extensions`, `npmCommand`, `shellPath`, `shellCommandPrefix`, and the auto-discovered `.omk/extensions/`. While the gate is closed these are withheld: project packages are neither installed nor loaded, project extensions are not loaded, and the three command settings fall back to the user-global values. Skills, prompt templates, themes, context files and every other project setting still apply. The project file itself is not modified.
- **R5** Interactive `omk` asks once per project, before the TUI starts (Trust / Don't trust; Esc decides nothing for this run), and stores the answer in `~/.omk/project-trust.json` (owner-only), pinned to a SHA-256 fingerprint of the gated settings values plus the sorted list of relative file paths under `.omk/extensions/`, recursive, `node_modules` and dot entries excluded, capped at 5000 entries. A changed fingerprint asks again. File contents are not hashed (see Known risks).
- **R6** `-p`, `--mode json`, `--mode rpc` and spawned workers never ask. A stored answer for the same path and fingerprint applies to them as well (same user, same path, same hash: already decided). No record, or a different fingerprint: closed unless `OMK_TRUST_PROJECT=1` (exactly `1`). In interactive mode the env also opens the gate without asking.
- **R6a** `OMK_TRUST_PROJECT=0` forces the gate closed in every mode, over a stored "trusted" and over the home-directory rule (benchmarks use it).
- **R6b** The subagent extension does not let workers inherit `OMK_TRUST_PROJECT`. It sets `OMK_TRUST_PROJECT=1` for a worker only when (a) this process trusted the parent's project (any route: stored, prompt, env, home) and (b) the worker cwd's gated-items fingerprint equals the parent's; a worktree of the same project at another path qualifies, a different hash does not. A parent running with `=0` passes `=0` down. Exposed as `workerProjectTrustEnv()` from the package index; the parent's trust is kept on a `Symbol.for` global so a separately loaded copy of the module sees it.
- **R7** When `OMK_TRUST_PROJECT=1` opens the gate, omk prints exactly one line to stderr, once per project path per process: `omk: OMK_TRUST_PROJECT=1 trusts project code in <absolute project path>`. Nothing is printed when the gate is opened any other way, or when the project has no gated code.
- **R8** A closed gate is a warning diagnostic naming the project path, what was withheld, and how to open it (`OMK_TRUST_PROJECT=1`, or answering the prompt). It never stops the run.
- **R9** The gate only matters when there is gated code: a project without any (no `.omk/`, or only skills/prompts/themes) is unaffected, asks nothing, prints nothing. The user's home directory (`cwd === ~`) counts as the user's own and is trusted (unless `OMK_TRUST_PROJECT=0`).
- **R10** `omk install|update|list` and `omk config` apply the gate without asking (stored answer or env), so an untrusted project's `npmCommand` does not run there.
- **R11** The SDK (`createAgentSession`, `createAgentSessionServices`) is unchanged: a `SettingsManager` is trusted unless `withholdProjectCode()` is called. The CLI is the gate's caller.
- **R12** Spec 048's `isProjectTrusted()` returns this gate's result for the session cwd, `false` when it cannot decide (048 decision 2). Implemented in the 048 adapter PR, not here.

## Design

| Piece | File | Notes |
| --- | --- | --- |
| Install args + hint | `core/package-install-args.ts` (new) | `buildNpmInstallArgs`, `buildGitDependencyInstallArgs`, `ALLOW_SCRIPTS_FLAG`, `withAllowScriptsHint`. Moved out of `package-manager.ts` (module-size baseline). |
| `allowScripts` option | `core/package-manager.ts` | `PackageManagerOptions.allowScripts`, default false. Only `package-manager-cli.ts` sets it. |
| CLI flag + help | `package-manager-cli.ts`, `cli/package-command-help.ts` (new, help text moved out) | `--allow-scripts` for install/update; hint on failure. |
| Gated keys | `core/project-code-settings.ts` (new) | `PROJECT_CODE_SETTING_KEYS`, `withoutProjectCode`, `trustedProjectSettings`, `collectProjectAutoExtensionEntries`. Structurally typed to avoid an import cycle with `settings-manager.ts`. |
| Withholding | `core/settings-manager.ts`, `core/settings-merge.ts` (new, `deepMergeSettings` moved out) | `withholdProjectCode()` / `isProjectCodeWithheld()`; merged settings drop gated project keys; survives `reload()`; `getProjectSettings()` stays raw so writes never drop a repo's entries. |
| Resolution | `core/package-manager.ts` | `resolve()` and `checkForAvailableUpdates()` read `trustedProjectSettings()`; `.omk/extensions/` auto-discovery goes through `collectProjectAutoExtensionEntries()`. |
| Decision + store | `core/project-trust.ts` (new) | `decideProjectTrust`, `inspectProjectCode`, `recordProjectTrustDecision`, `forgetProjectTrustDecision`, `formatEnvTrustNotice`, `rememberSessionTrust`, `workerProjectTrustEnv`. Mirrors the MCP trust store; separate file, separate env. |
| Worker env | `examples/extensions/subagent/worker-env.ts`, `.../subagent/index.ts`, `src/index.ts` | `subagentWorkerEnv(parent, projectTrust?)` drops an inherited `OMK_TRUST_PROJECT` and sets only the value from `workerProjectTrustEnv({ parentCwd, workerCwd })`. |
| Gate wiring | `cli/project-trust-gate.ts` (new), `main.ts` | `applyProjectTrustGate()` runs inside `createRuntime` for each runtime cwd, before `createAgentSessionServices` (which now gets the gated `SettingsManager`). |
| Prompt | `cli/project-trust-prompt.ts` (new) | Pre-TUI selector, same pattern as `cli/missing-session-cwd-prompt.ts`; loaded only when a decision is needed. Only the first runtime may prompt; later session switches into an undecided project withhold with a diagnostic. |

## Tests

- `test/package-install-scripts.test.ts`: `--ignore-scripts` by default on npm install and on git dependency installs; absent with `allowScripts`; startup install of a missing project package always skips scripts; symptom matcher; hint text; CLI passes `--allow-scripts` through; failed install names `omk install --allow-scripts <source>`; `omk list --allow-scripts` is rejected.
- `test/project-trust.test.ts`: no gated code → gate not involved; headless withheld without env; stored trust for the same hash opens headless, a changed hash or a stored refusal keeps it closed (decision 1); `OMK_TRUST_PROJECT=0` closes interactive and headless over stored trust and over home (decision 5); the fingerprint follows the recursive relative-path list under `.omk/extensions/`, ignores content edits, `node_modules` and dot entries (decision 4); `workerProjectTrustEnv` gives `1` for the same path and for a same-hash worktree, nothing for a different hash or an untrusted parent, and `0` under `=0` (decision 2); env opens in both modes and only for `1`; interactive asks once then follows the stored answer (trusted/denied); changed packages or a new `.omk/extensions/` entry asks again; home is trusted; store contents; `withholdProjectCode()` drops `npmCommand`/`shellPath`/`shellCommandPrefix`, keeps `theme`, leaves `getProjectSettings()` raw, survives `reload()`; withheld `resolve()` installs nothing and loads neither project packages nor `.omk/extensions/` nor `extensions` entries but keeps project skills; **R7: `OMK_TRUST_PROJECT=1` writes exactly one stderr line, equal to `formatEnvTrustNotice(<project path>)`, containing the path, and a second runtime for the same path prints nothing more**; no env → nothing printed, warning names `OMK_TRUST_PROJECT=1`; prompt answers trust/deny are recorded; no prompt available → withheld, nothing recorded.
- `examples/extensions/subagent/worker-env.test.ts`: an inherited `OMK_TRUST_PROJECT=1` is dropped; only the passed value is set.
- `test/stdout-cleanliness.test.ts`: it relied on an untrusted project's `npmCommand` + `packages` running at startup; it now opts in with `OMK_TRUST_PROJECT=1`, and two cases were added: without the env the project's `npmCommand` does not run, and with it the notice line appears once on stderr and never on stdout.
- Existing tests updated for R1: install-arg expectations in `package-manager.test.ts` gained `--ignore-scripts`; the install usage string in `package-command-paths.test.ts` gained `[--allow-scripts]`.

## Acceptance criteria

- [ ] R1-R11 covered by the tests above, all green.
- [ ] A cloned repo whose `.omk/settings.json` names `packages: ["npm:x"]` makes `omk -p hi` start without running npm and print a warning naming the repo path and `OMK_TRUST_PROJECT=1`; with `OMK_TRUST_PROJECT=1` it installs `x` with `--ignore-scripts` and prints the R7 line once.
- [ ] `omk install npm:x` passes `--ignore-scripts`; `omk install --allow-scripts npm:x` does not.
- [ ] CHANGELOG `[Unreleased]` → `Changed` entries for both behaviour changes; `docs/packages.md` (Install scripts, Project trust) and `docs/settings.md` (Project Overrides) updated.
- [ ] `npm run check` green (biome, module-size, import-cycles, tsgo, ...).
- [ ] Merge condition (a), manual E2E 1: the TUI asks once in a project with gated code and remembers the answer on the next start.
- [ ] Merge condition (b), manual E2E 2: in a cloned repo, `-p` is closed without the env, open with `OMK_TRUST_PROJECT=1` (one stderr line), open after a stored trust, and closed with `OMK_TRUST_PROJECT=0` even after the stored trust.
- E2E script (outside the repo, runs after the build, offline provider, tmux for the TUI): `/workspace/omk-p0-install-safety-e2e/run-e2e.sh`; outputs go to `/workspace/omk-p0-install-safety-e2e/out/`.

## Behaviour changes to call out in review

- Repositories with tracked `.omk/extensions/` (omk itself: `cli-anything`, `powershell-compat`, `prompt-url-widget.ts`, `reverse-skill.ts`, `telegram-notify`, `tps.ts`, ...) stop loading them until the checkout is trusted: answer the prompt once (headless runs and workers then follow it) or set `OMK_TRUST_PROJECT=1`. A new worktree is a new path and needs its own answer. CHANGELOG carries a line for this repo's developers.
- Native-build packages installed without `--allow-scripts` fail to load until reinstalled with it.

## Not in scope

- Gating project skills, prompt templates, `AGENTS.md` or `SYSTEM.md` (instructions, not code; prompt injection is a separate problem).
- Context files (`AGENTS.md`/`CLAUDE.md`, found by walking up from the cwd) are prompt text, not code execution, so P0 does not gate them. Everything gated here is read from `<cwd>/.omk` only.
- A `/trust` command or `omk trust` subcommand to revoke or re-ask (today: remove the entry from `~/.omk/project-trust.json`).
- Prompting on a mid-session switch into an undecided project (needs `interactive-mode.ts`).

## Known risks

- Changing the contents of an existing file under `.omk/extensions/` (or of a package already named in `packages`) does not change the fingerprint, so it does not re-prompt. A `git pull` that edits a trusted project's extension code loads the new code. Only adding, removing or renaming a file, or changing a gated settings value, asks again (decision 4).
- The `.omk/extensions/` walk stops at 5000 entries; past that, new files do not change the fingerprint.
- `node_modules` under `.omk/extensions/` is not hashed, so installing an extension's dependencies does not re-prompt; neither does a changed dependency.
- Workers inherit trust through `OMK_TRUST_PROJECT=1`, which opens the gate for whatever the worker's cwd holds when it starts; the parent checks the hash just before spawning, so a change in between is not caught.

## Decisions (Tech Lead, 2026-10-11)

All five questions are resolved.

1. **Stored trust in headless runs**: yes. Stored trust also opens `-p`, json, rpc and workers: same user, same path, same hash means it was decided. No record or a different hash: closed as before (R6).
2. **Workers**: the subagent extension passes `OMK_TRUST_PROJECT=1` only if the parent is trusted and the gated-items hash of the worker's cwd equals the parent's; a different hash gets nothing. This matters for worktrees at a different path (R6b).
3. **`npmCommand`, `shellPath`, `shellCommandPrefix`**: gated in this PR (R4).
4. **Fingerprint**: name-based, with the full recursive list of relative paths under `.omk/extensions/`, not only top-level names; content changes not re-prompting is a known risk (R5, Known risks).
5. **`OMK_TRUST_PROJECT=0`**: forces the gate closed even with stored trust; used for bench; tested (R6a).

Numbering: drafted as 050, renumbered to 053 because 050 (#116, skill selection), 051 and 052 are taken.
