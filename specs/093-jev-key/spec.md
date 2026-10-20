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
| `/jev set` | Masked prompt (each char rendered as `•`, value never in render output). Trim; empty → error "key cannot be empty" (no echo). Stores `{type:"api_key", key}` via existing `AuthStorage.set("typesafe", …)`. |
| `/jev status` | Prints source (`env` / `stored` / `none`) and masked prefix: first 4 chars + `…`. If both env and stored exist, says env is used. |
| `/jev clear` | `AuthStorage.remove("typesafe")`. Reports if env still set (cannot be cleared from omk). |
| `/jev` | Same as status plus usage line. |

- **Masked input**: add an opt-in `mask` option to omk-tui `Input` (render-only; value unchanged). Login dialog untouched by default.
- **Storage**: existing auth.json only (0o600, dir 0o700). No new store; never the repo or project dir; never settings.json, session JSONL or run log.
- **Precedence**: env `TYPESAFE_API_KEY` first, then stored. Implemented locally for `typesafe` only (Jev resolver), so other providers' precedence is unchanged.
- **Flag**: `OMK_JEV=1` gates every Jev feature (091 selection). `/jev` key management works regardless, but `/jev` itself never makes a network/paid call.
- **Fallback** (091 design): flag off, no key, or call failure → no skill attach, next-task suggestions only.
- **Errors**: never include the key or headers; error names only.
- Zero new dependencies.
- Exposed-key revocation is done in the TypeSafe dashboard; the spec stores no real key, prefix or hash.

## Tests (fake key `TEST_SECRET_KEY_123`, temp agent dir, mocked fetch with zero calls asserted)

1. Key absent from TUI render output during and after `/jev set`, `/jev status`, errors, logs, session JSONL and run log (grep count 0; status shows only `TEST…`).
2. auth.json mode 0o600 after set (and dir 0o700).
3. Precedence: env set + stored set → env used, status says `env`; env unset → stored.
4. `/jev clear` removes stored key; status → `none` (or `env` if env set).
5. Empty input rejected, nothing written.
6. `/jev` performs 0 fetch calls.

## Success criterion

All 6 tests pass on Node 22; `rg TEST_SECRET_KEY_123` over every file the test run writes except auth.json = 0 matches; 0 new deps in package-lock diff; existing /login tests unchanged and green.

## Open questions

1. Env-first for `typesafe` differs from omk's global stored-first order (:729-735). Keep the per-provider exception, or follow global order?
2. Provider id `typesafe` vs `jev`; also accept extra env names?
3. Should `/login` API-key prompt also adopt the mask (separate PR)?
4. `OMK_JEV` as env only, or also a settings toggle?
