---
description: "/jev slash command to set, inspect and clear the TypeSafe (Jev) API key using existing auth storage; default-off OMK_JEV; spec only"
---

# Feature Specification: `/jev` TypeSafe key command

**Specification ID**: `093-jev-key`
**Feature Branch**: `spec/jev-key` from origin/main `2cbb8ffa9a`
**Created**: 2026-10-20
**Status**: Spec only (no code); local commit, not pushed
**Constitution**: [specs/constitution.md](../constitution.md)
**Input**: 인호 in the omk harness team room: "OMK에서 /jev 넣어주고 키 설정하게 해".
**Behavior changes**: none by default (flag off).

## Problem

Jev skill selection (091) needs a TypeSafe API key. Today the only way to
supply it is the env var `TYPESAFE_API_KEY`. Users need a safe in-app way to
set, check and clear the key without it touching the repo, logs or sessions.

## Existing code (origin/main `2cbb8ffa9a`)

- Storage: `AuthStorage` / `FileAuthStorageBackend`,
  `packages/coding-agent/src/core/auth-storage.ts`. Default path
  `<agentDir>/auth.json` (`~/.omk/agent/auth.json`) at :81, :235; dir mode 0o700
  at :88; file mode 0o600 at :71, :95, :137, :182. `set()` :340, `remove()` :353.
- Precedence today (`getApiKey`, doc :729-735, code :736-790): runtime override
  → stored api_key (:755-756) → stored oauth → env (`getEnvApiKey`, :783-784)
  → fallback resolver. **Stored wins over env today.**
- Env map: `packages/ai/src/env-api-keys.ts` `getEnvApiKey` :180-182; no
  TypeSafe/Jev entry yet (multi-name pattern e.g. :112-114).
- Slash commands: registry `BUILTIN_SLASH_COMMANDS`,
  `packages/coding-agent/src/core/slash-commands.ts:18` (login/logout :42-43);
  mapped into autocomplete at `interactive-mode.ts:496,512`; dispatched by
  text match at `interactive-mode.ts:2948` (/login) and :2958 (/logout).
- API key entry: `interactive-mode.ts:5564` `dialog.showPrompt("Enter API
  key:")` then `authStorage.set(id, {type:"api_key", key})` :5569.
  `LoginDialogComponent.showPrompt` `components/login-dialog.ts:146` uses the
  plain `Input` from omk-tui (`packages/tui/src/components/input.ts`, render
  :378). **No masked input exists today**; the key is echoed while typing.

## Design

`/jev` is registered in `BUILTIN_SLASH_COMMANDS` and dispatched like /login.
Provider id in auth.json: `typesafe`.

| Subcommand | Behavior |
|---|---|
| `/jev set` | Masked prompt (each char rendered as `•`, value never in render output). Trim; empty → error "key cannot be empty" (no echo). Stores `{type:"api_key", key}` via existing `AuthStorage.set("typesafe", …)`. Input is not added to editor/input history or autocomplete history. |
| `/jev status` | Prints ONLY the source: `stored`, `env` or `none`. Zero key characters. |
| `/jev clear` | `AuthStorage.remove("typesafe")`. Reports if env is still set (cannot be cleared from omk). |
| `/jev` | Same as status plus a usage line. |

- **Masked input**: add an opt-in `mask` option to omk-tui `Input` (default off; render-only, value unchanged). `/login` masking is a separate later PR.
- **Storage**: existing auth.json only (0o600, dir 0o700). No new store; never the repo or project dir; never settings.json, session JSONL or run log.
- **Precedence**: same as every other provider (`getApiKey`, :729-735): stored key first, then env `TYPESAFE_API_KEY`. No typesafe exception.
- **Flag**: `OMK_JEV=1` (env only in v1) gates every Jev feature (091 selection). `/jev` key management works regardless, and `/jev` itself never makes a network or paid call.
- **Fallback** (091 design): flag off, no key, or call failure → no skill attach, next-task suggestions only.
- **Errors**: never include the key or headers; error names only.
- Zero new dependencies.
- Exposed-key revocation is done in the TypeSafe dashboard; the spec stores no real key, prefix or hash.
- **Operational note**: when 인호 rotates the key, the box env `TYPESAFE_API_KEY` should be cleared too, otherwise an old env value remains as fallback.

## Implementation split

- **PR1**: omk-tui `Input` `mask` option, default off. Unit tests only (tests 1-2).
- **PR2**: `/jev` command, on main after PR1 merges (tests 3-10).

## Tests (fake key `TEST_SECRET_KEY_123`, temp agent dir, mocked fetch with zero calls asserted)

PR1:
1. `Input` with mask on: render output contains no character of the typed value; `getValue()` returns it unchanged.
2. `Input` with mask off (default): render unchanged from today.

PR2:
3. Key absent from TUI render output during and after `/jev set`, `/jev status`, errors, logs, session JSONL and run log (grep count 0).
4. Status shows source only: output is one of `stored`/`env`/`none` and contains no substring of the key (any length ≥ 1 run of key chars beyond the fixed label text).
5. Key entered via `/jev set` never appears in input history or autocomplete history files (grep count 0).
6. auth.json mode 0o600 after set (dir 0o700).
7. Precedence: stored + env both set → stored key used, status says `stored`; stored absent + env set → env, status `env`.
8. `/jev clear` removes the stored key; status → `none` (or `env` if env set).
9. Empty input rejected, nothing written.
10. `/jev` performs 0 fetch calls.

## Success criterion

All 10 tests pass on Node 22; `rg TEST_SECRET_KEY_123` over every file the test run writes except auth.json = 0 matches; 0 new deps in package-lock diff; existing /login and Input tests unchanged and green.

## Open questions

- None open. Decided in room: stored-first precedence, provider id `typesafe`, `/login` mask later, `OMK_JEV` env-only, status source-only, two PRs.
