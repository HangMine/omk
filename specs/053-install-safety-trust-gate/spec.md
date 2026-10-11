---
description: "P0 security: package install scripts off by default, and a project trust gate before a cloned repo's packages, extensions and shell settings load"
---

# Feature Specification: Install scripts off by default, project trust gate

**Specification ID**: `053-install-safety-trust-gate`
**Feature Branch**: `fix/install-safety-trust-gate` (off main `f913f49`)
**Created**: 2026-10-11
**Status**: PR #124 (base main `f913f49`); Tech Lead decisions applied; [PR #124 review](#pr-124-review-tech-lead-2026-10-11) fixes applied on top of `ee73efe`; manual E2E results in the PR
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
- **R3** A failure that looks like a skipped install script names the option: a failed `omk install`/`omk update` without `--allow-scripts` whose error matches the skipped-script symptoms below prints `omk install --allow-scripts <source>` (or `omk update --allow-scripts`); other failures (network, 404, ...) do not suggest running scripts. An extension that fails to load with a skipped-native-build symptom (missing bindings file, missing `.node`, "No native build was found", missing `build/`/`dist/` module, ...) gets the same hint appended to its diagnostic.

### Project trust gate

- **R4** Gated project code: `.omk/settings.json` keys `packages`, `extensions`, `npmCommand`, `shellPath`, `shellCommandPrefix`, and the auto-discovered `.omk/extensions/`. While the gate is closed these are withheld: project packages are neither installed nor loaded, project extensions are not loaded, and the three command settings fall back to the user-global values. Skills, prompt templates, themes, context files and every other project setting still apply. The project file itself is not modified.
- **R5** Interactive `omk` asks once per project, before the TUI starts (Trust / Don't trust; Esc decides nothing for this run), and stores the answer in `~/.omk/project-trust.json` (owner-only), pinned to a SHA-256 fingerprint of the gated settings values, the sorted list of relative file paths under `.omk/extensions/` (recursive, `node_modules` and dot entries excluded, symlinked directories followed with an ancestor check against cycles, as the loader follows them), and the SHA-256 of the contents of the `package.json` manifests the loader reads (`.omk/extensions/package.json` and `.omk/extensions/<entry>/package.json`). A changed fingerprint asks again. Other file contents are not hashed (see Known risks). More than 5000 files: the walk stops, the surface is marked over the cap, and the gate stays closed in every mode (stored trust and `OMK_TRUST_PROJECT=1` included) with a warning saying why; a truncated list is never hashed.
- **R6** `-p`, `--mode json`, `--mode rpc` and spawned workers never ask. A stored answer for the same path and fingerprint applies to them as well (same user, same path, same hash: already decided). No record, or a different fingerprint: closed unless `OMK_TRUST_PROJECT=1` (exactly `1`). Interactive omk ignores `OMK_TRUST_PROJECT=1` (048 R7) and falls through to the stored answer or the prompt.
- **R6a** `OMK_TRUST_PROJECT=0` forces the gate closed in every mode, over a stored "trusted" and over the home-directory rule (benchmarks use it).
- **R6b** The subagent extension does not let workers inherit `OMK_TRUST_PROJECT`. It sets `OMK_TRUST_PROJECT=1` for a worker only when (a) this process trusted the parent's project (any route: stored, prompt, env, home), (b) the worker cwd (real path) is the parent project or a directory inside it (no git; a symlink resolves by real path), or lies in a worktree registered by the project's own repository: the parent's `git rev-parse --show-toplevel` (real path) is the project itself, the worker's `--show-toplevel` (real path) is listed by the parent's `git worktree list --porcelain -z`, and the worker cwd is inside that top level (async `execFile` with a 2 s timeout, `GIT_DIR`-style variables removed, `core.fsmonitor=false`, any failure or timeout closes; answers cached per process), and (c) the worker cwd's gated-items fingerprint equals the parent's. The worker cwd is model-chosen, so an unrelated directory with identical `packages` strings and extension file names gets nothing. The hash is compared first so git runs only for a matching hash outside the project. A parent running with `=0` passes `=0` down. Exposed as `workerProjectTrustEnv()` (async) from the package index; the parent's trust is kept on a `Symbol.for` global so a separately loaded copy of the module sees it.
- **R6c** `OMK_TRUST_PROJECT` is read once, at the start of `main()` (`captureStartupProjectTrust`). `1` is bound to the real path of the startup cwd and deleted from `process.env`, so the bash tool, `RpcClient` and every other child process start without it (a model running `cd /tmp/x && omk -p` does not trust `/tmp/x`). Later runtimes in the same process (session switch, `--session` into another project) are opened by it only when their cwd is that startup project. `0` stays in the environment (safe to inherit). A `1` that appears in `process.env` after startup is ignored.
- **R7** When `OMK_TRUST_PROJECT=1` opens the gate, omk prints exactly one line to stderr, once per project path per process: `omk: OMK_TRUST_PROJECT=1 trusts project code in <absolute project path>`. Nothing is printed when the gate is opened any other way, or when the project has no gated code.
- **R8** A closed gate is a warning diagnostic naming the project path, what was withheld, and how to open it (`OMK_TRUST_PROJECT=1`, or answering the prompt). It never stops the run.
- **R9** The gate only matters when there is gated code: a project without any (no `.omk/`, or only skills/prompts/themes) is unaffected, asks nothing, prints nothing. The user's home directory (`cwd === ~`) counts as the user's own and is trusted (unless `OMK_TRUST_PROJECT=0`).
- **R10** `omk install|update|remove|list`, `omk config` and `omk package doctor` apply the gate as a non-interactive run (stored answer or `OMK_TRUST_PROJECT=1`, never a prompt) and print the withheld warning on stderr (stdout stays clean for the doctor's JSON). In an untrusted project the project's `npmCommand` does not run, and `omk update` and `omk config` neither update nor install its `packages` (`update()` reads `trustedProjectSettings()`). `omk list` still lists the configured project packages (it reads settings, runs nothing).
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
| Decision | `core/project-trust.ts` (new) | `decideProjectTrust`, `formatEnvTrustNotice`; re-exports the pieces below. |
| Fingerprint | `core/project-code-fingerprint.ts` (new) | `inspectProjectCode`, `describeProjectCodeSurface`, `canonicalDir`, `MAX_EXTENSION_ENTRIES`. |
| Store | `core/project-trust-store.ts` (new) | `~/.omk/project-trust.json`; read-merge-write under a `.lock` directory (2 s wait, stale after 10 s), fresh `wx` 0600 temp file + `fchmod` + rename. Mirrors the MCP trust store; separate file, separate env. |
| Env | `core/project-trust-env.ts` (new) | `TRUST_PROJECT_ENV`, `captureStartupProjectTrust`, `projectTrustEnvFor` (R6c). |
| Workers | `core/project-trust-worker.ts` (new) | `rememberSessionTrust`, `workerProjectTrustEnv` (`@internal`, async, R6b). |
| Worker git check | `core/project-trust-git.ts` (new) | `isInRegisteredWorktree`, `runGit`, per-process cache on a `Symbol.for` global (R6b, re-review). |
| Worker env | `examples/extensions/subagent/worker-env.ts`, `.../subagent/index.ts`, `src/index.ts` | `subagentWorkerEnv(parent, projectTrust?)` drops an inherited `OMK_TRUST_PROJECT` and sets only the value from `workerProjectTrustEnv({ parentCwd, workerCwd })`. |
| Gate wiring | `cli/project-trust-gate.ts` (new), `main.ts`, `package-manager-cli.ts`, `commands/package-doctor-cli.ts` | `applyProjectTrustGate()` runs inside `createRuntime` for each runtime cwd, before `createAgentSessionServices` (which now gets the gated `SettingsManager`). `applyCommandProjectTrustGate()` is the non-interactive variant for the package commands, config and doctor (R10). `main()` calls `captureStartupProjectTrust(process.cwd())` first. |
| Prompt | `cli/project-trust-prompt.ts` (new) | Pre-TUI selector, same pattern as `cli/missing-session-cwd-prompt.ts`; loaded only when a decision is needed. Only the first runtime may prompt; later session switches into an undecided project withhold with a diagnostic. |

## Tests

- `test/package-install-scripts.test.ts`: `--ignore-scripts` by default on npm install and on git dependency installs; absent with `allowScripts`; startup install of a missing project package always skips scripts; symptom matcher; hint text; CLI passes `--allow-scripts` through; failed install names `omk install --allow-scripts <source>`; `omk list --allow-scripts` is rejected.
- `test/project-trust.test.ts`: no gated code → gate not involved; headless withheld without env; stored trust for the same hash opens headless, a changed hash or a stored refusal keeps it closed (decision 1); `OMK_TRUST_PROJECT=0` closes interactive and headless over stored trust and over home (decision 5); the fingerprint follows the recursive relative-path list under `.omk/extensions/`, ignores content edits, `node_modules` and dot entries (decision 4); `workerProjectTrustEnv` gives `1` for the same path, a same-hash subdirectory and a same-hash real git worktree, nothing for a different hash, an unrelated same-hash directory or an untrusted parent, and `0` under `=0` (decision 2, review M4); env opens non-interactive runs only and only for `1` (review M3); interactive asks once then follows the stored answer (trusted/denied); changed packages or a new `.omk/extensions/` entry asks again; home is trusted; store contents; `withholdProjectCode()` drops `npmCommand`/`shellPath`/`shellCommandPrefix`, keeps `theme`, leaves `getProjectSettings()` raw, survives `reload()`; withheld `resolve()` installs nothing and loads neither project packages nor `.omk/extensions/` nor `extensions` entries but keeps project skills; **R7: `OMK_TRUST_PROJECT=1` writes exactly one stderr line, equal to `formatEnvTrustNotice(<project path>)`, containing the path, and a second runtime for the same path prints nothing more**; no env → nothing printed, warning names `OMK_TRUST_PROJECT=1`; prompt answers trust/deny are recorded; no prompt available → withheld, nothing recorded.
- `examples/extensions/subagent/worker-env.test.ts`: an inherited `OMK_TRUST_PROJECT=1` is dropped; only the passed value is set.
- PR #124 review additions:
  - `test/project-trust-commands.test.ts` (new): B1 `update --extensions --allow-scripts` in an untrusted repo calls `runCommand` 0 times and warns on stderr, with a trusted control (`evil-npm`, no `--ignore-scripts`); the `--allow-scripts` hint only for skipped-script failures; n2/R10 `list` warns on stderr and still lists; `config` installs nothing and warns, trusted control installs with `--ignore-scripts`; M1 `package doctor` packs with plain `npm` and warns on stderr (stdout stays JSON), trusted control uses the project's `npmCommand`.
  - `test/project-trust.test.ts`: M3 interactive ignores `=1` (asks, then follows a stored refusal); M2 capture removes `1`, keeps `0`, opens only the startup project while a second runtime for a sibling directory stays closed, ignores a later `1` in `process.env`; the command gate warns on stderr; M4 an unrelated same-hash directory gets nothing, a subdirectory and a real `git worktree add` get `1`; m1 store written 0600 over a 0644 file (skipped on win32), entries merged and a stale lock broken; m2 `package.json` manifest contents change the hash, symlinked directories are followed without looping (skipped on win32), more than 5000 files stays closed even with the env or a stored trust.
  - `test/package-install-scripts.test.ts`: the install hint appears for a bindings-file failure and not for `npm ERR! 404`.
  - `test/project-trust-worker.test.ts` (new, re-review of `f79e090`): a project nested in a larger repository gives a sibling in that repository nothing (a subdirectory still gets `1` without git); a `.git` file with `gitdir: <trusted>/.git` gets nothing; a repository whose `core.worktree` names the trusted project gets nothing; a real `git worktree add` gets `1` with 3 git calls and a second spawn makes none; concurrent spawns share one run; a failing, throwing or worker-only-failing git runner gives nothing; `runGit` outside a repository resolves undefined; a symlink into the project is inside (no git), a symlink elsewhere gets nothing (skipped on win32).
  - `test/stdout-cleanliness.test.ts`: M2 end to end: with `OMK_TRUST_PROJECT=1` the project's fake npm (a child of omk) sees `OMK_TRUST_PROJECT` unset.
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

- Repositories with tracked `.omk/extensions/` (omk itself: `cli-anything`, `powershell-compat`, `prompt-url-widget.ts`, `reverse-skill.ts`, `telegram-notify`, `tps.ts`, ...) stop loading them until the checkout is trusted: answer the prompt once (headless runs and workers then follow it) or set `OMK_TRUST_PROJECT=1` for headless runs (interactive omk ignores it). A new worktree opened directly is a new path and needs its own answer; workers the parent sends into a worktree registered by the same repository follow the parent, but only when the trusted project is that repository's top level (a trusted package inside a monorepo forwards to its own subdirectories only). CHANGELOG carries a line for this repo's developers.
- Native-build packages installed without `--allow-scripts` fail to load until reinstalled with it.

## Not in scope

- Gating project skills, prompt templates, `AGENTS.md` or `SYSTEM.md` (instructions, not code; prompt injection is a separate problem).
- Context files (`AGENTS.md`/`CLAUDE.md`, found by walking up from the cwd) are prompt text, not code execution, so P0 does not gate them. Everything gated here is read from `<cwd>/.omk` only.
- A `/trust` command or `omk trust` subcommand to revoke or re-ask (today: remove the entry from `~/.omk/project-trust.json`).
- Prompting on a mid-session switch into an undecided project (needs `interactive-mode.ts`).

## Known risks

- Changing the contents of an existing source file under `.omk/extensions/` (or of a package already named in `packages`) does not change the fingerprint, so it does not re-prompt. A `git pull` that edits a trusted project's extension code loads the new code. Adding, removing or renaming a file, changing a gated settings value, or changing a `package.json` manifest the loader reads asks again (decision 4, review m2).
- `node_modules` under `.omk/extensions/` is not hashed, so installing an extension's dependencies does not re-prompt; neither does a changed dependency.
- A manifest's `extensions` entry can point outside `.omk/extensions/`; the manifest text is hashed, the target file's contents are not.
- Workers inherit trust through `OMK_TRUST_PROJECT=1`, which opens the gate for whatever the worker's cwd holds when it starts; the parent checks the hash just before spawning, so a change in between is not caught.
- The worker check runs `git rev-parse --show-toplevel` in the model-chosen worker directory, which reads that repository's git config. `rev-parse` runs no hooks and `core.fsmonitor` is forced off; it only runs when the hash already matches and the directory is outside the project. No `safe.directory` override is added: a repository owned by another user makes git fail, which closes.
- A worktree registered by the trusted repository is trusted for whatever it has checked out: the model can `git worktree add` a worktree at any commit (or edit files in the project itself), and the name-based fingerprint does not see content. This is the same exposure as editing the trusted project directly.
- git answers are cached for the life of the parent process, failures included: a worktree added after the first check of the same path, or a git that timed out once, keeps that worker path closed until omk restarts (fails closed). A cached "registered" answer is not re-checked if the worktree is later removed and the directory rebuilt; the hash is still checked on every spawn.
- `git worktree list -z` needs git 2.36 or newer; older git fails the check and workers outside the project get nothing.
- Store writes take a lock directory (`project-trust.json.lock`). If another omk holds it for more than 2 s (and it is not stale, >10 s), the write goes ahead unlocked and two concurrent writers can still lose one entry; the lost answer is asked again next time.
- `/reload` re-reads settings and resources but does not re-run the gate: a trusted session that gains new `.omk/extensions/` files during the session loads them on `/reload` without a new prompt. Fixing it needs `interactive-mode.ts` (Tech Lead's file); a new session or restart re-checks. Withheld state survives `/reload`.
- Project paths are compared as exact strings after `realpath`. Case-insensitive file systems (default macOS APFS, Windows NTFS) are not handled or verified: the same directory reached with different letter case is a different key (asked again, never a wrong trust, since the fingerprint still has to match). Not tested on macOS or Windows at all.
- `runMigrations(process.cwd())` (`migrations.ts` `migrateExtensionSystem`) runs before the gate and writes in an untrusted `<cwd>/.omk/`: it renames `.omk/commands/` to `.omk/prompts/` and archives `.omk/hooks/` to `.omk/hooks.migrated/`. It executes nothing from the project; it only renames directories (review n3).
- `OMK_TRUST_PROJECT=1` with `--session`/`--resume` into a session whose cwd is another project does not open that project (R6c); trust it interactively once instead.

## Deferred from 048 R5

Not implemented in this PR, to keep the P0 small (PR #124 review M5). Owner: Staff Engineer. Target release: 1.5.1.

- `--yes` for `omk install`, and refusing a non-TTY `omk install` of a source with extension code without `--yes` (048 R5 "Confirmation").
- `omk list` provenance: installed version, npm integrity, git commit SHA (048 R5 "Provenance").
- No auto-install of missing project packages even in a trusted project (048 R5 "No auto-install"); today a trusted project's missing `packages` still install at startup, scripts off.
- `omk -e … --allow-scripts` (048 R5 "Explicit opt-in"); today `-e` never runs scripts.

## Decisions (Tech Lead, 2026-10-11)

All five questions are resolved.

1. **Stored trust in headless runs**: yes. Stored trust also opens `-p`, json, rpc and workers: same user, same path, same hash means it was decided. No record or a different hash: closed as before (R6).
2. **Workers**: the subagent extension passes `OMK_TRUST_PROJECT=1` only if the parent is trusted and the gated-items hash of the worker's cwd equals the parent's; a different hash gets nothing. This matters for worktrees at a different path (R6b).
3. **`npmCommand`, `shellPath`, `shellCommandPrefix`**: gated in this PR (R4).
4. **Fingerprint**: name-based, with the full recursive list of relative paths under `.omk/extensions/`, not only top-level names; content changes not re-prompting is a known risk (R5, Known risks).
5. **`OMK_TRUST_PROJECT=0`**: forces the gate closed even with stored trust; used for bench; tested (R6a).

## PR #124 review (Tech Lead 2026-10-11)

Review of `ee73efe`: one blocker, five majors, minors and nits. Applied on top of `ee73efe`:

- **B1** `update()` reads `trustedProjectSettings()`: an untrusted project's `packages` are neither updated nor installed by `omk update`, with or without `--allow-scripts`. The `--allow-scripts` hint after a failed install/update shows only when `looksLikeSkippedInstallScript(message)`. Audit of the other raw `getProjectSettings()` reads in `package-manager.ts`: `addSourceToSettings`/`removeSourceFromSettings` (writes; must stay raw so a save never drops the repo's entries), `listConfiguredPackages` (`omk list`; reads and lists only, runs nothing), `resolve` and `checkForAvailableUpdates` (already trusted). `install`/`remove` act on the source the user typed; their `npmCommand` comes from the gated merged settings.
- **M1** `omk package doctor` applies the gate (non-interactive, stderr warning) before `npm pack`.
- **M2** R6c: read once at startup, bound to the startup cwd, `1` removed from `process.env`, `0` kept.
- **M3** `OMK_TRUST_PROJECT=1` is ignored in interactive omk (048 R7). Package commands, config and doctor are non-interactive runs for the gate, so `=1` still applies to them (R10).
- **M4** R6b path/worktree check before forwarding `1`.
- **M5** [Deferred from 048 R5](#deferred-from-048-r5).
- **m1** Store: fresh 0600 temp file (`wx` + `fchmod`), read-merge-write under a lock directory; residual recorded in Known risks; the permission test checks `mode & 0o777`.
- **m2** Fingerprint: manifests hashed, symlinked directories followed with an ancestor check, the cap fails closed instead of hashing a truncated list.
- **m3** `docs/security.md` (4.1) and `docs/environment-variables.md` (`OMK_TRUST_PROJECT`, `OMK_TRUST_PROJECT_MCP`) updated, plus `docs/packages.md` and the CHANGELOG.
- **m4**, **m5**, **n3**: recorded in Known risks (`/reload` needs `interactive-mode.ts`).
- **m6** Tests listed above. Still unverified end to end: the TUI "Don't trust" choice, a real worker spawned by the subagent extension, macOS and Windows.
- **n1** `TRUST_PROJECT_ENV` is no longer exported from the package index; `workerProjectTrustEnv` is marked `@internal`.
- **n2** `omk list` and `omk config` (and every package command) print the gate warning on stderr.
- **n4** The store is `~/.omk/project-trust.json` under the home directory, not the agent dir: it sits next to `~/.omk/mcp-trust.json` (same pattern), one answer covers every `OMK_CODING_AGENT_DIR` (bench and test runs use throwaway agent dirs), and it is outside every repository, so a project cannot write its own trust. A project cannot set `OMK_CODING_AGENT_DIR` (omk loads no environment from the project), so that is not the reason. This differs from 048 R7's "user-global agent dir" wording on purpose.

Numbering: drafted as 050, renumbered to 053 because 050 (#116, skill selection), 051 and 052 are taken.

## Follow-up after PR #124 re-review (Tech Lead 2026-10-11, `f79e090`)

No blockers. Minors fixed in a follow-up PR before 1.5.0:

- **Worker trust spoofing** (`project-trust-worker.ts:61-65`): `--git-common-dir` matched for a project nested in a larger repository (dotfiles repo at `~`, monorepo) and for a worker directory with a `.git` file pointing at `<trusted>/.git`. Replaced by the registered-worktree check in R6b: the parent's top level must be the project, the worker's top level must be in the parent's `git worktree list`, and the worker cwd must be inside its top level (this last part also closes a repository whose `core.worktree` names the trusted project). Same-path and inside-the-project rules are unchanged and need no git.
- **Tests**: `test/project-trust-worker.test.ts` (above), with an injected git runner.
- **Stall** (`:47`): `execFileSync` (2 s, up to twice per spawn) is now async `execFile`; the only caller (`examples/extensions/subagent/index.ts`, inside `runSingleAgentAttempt`) already awaits. Parent top level and worktree list are cached per parent project, worker top level per real path; concurrent spawns share one run.
- **Nit**: the `workerProjectTrustEnv` public export stays (the subagent example imports it); a TODO in `src/index.ts` marks it for removal when the example moves to an internal import path.
