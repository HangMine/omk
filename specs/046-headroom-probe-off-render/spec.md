---
description: "Move the headroom version probe off the TUI render path: probe asynchronously once, cache the result, re-render when it lands"
---

# Feature Specification: Headroom version probe off the render path

**Specification ID**: `046-headroom-probe-off-render`
**Feature Branch**: `perf/headroom-off-render`
**Created**: 2026-10-11
**Status**: Draft
**Constitution**: [specs/constitution.md](../constitution.md)
**Input**: #104 first-paint profile, fix 4. Tech Lead approved it as its own small PR, independent of #79: a synchronous spawn on the render path is a bug whatever it costs.
**OMK Preset**: `omk`
**Base**: main `7961ae2`

## Problem (measured, #104 profile on #79 `7ff7bba`, t450 session)

The control panel builds its status snapshot inside `render()`. `createControlPanelStatusSnapshot` → `formatHeadroomStatusLabel` → `getInstalledHeadroomVersion` runs up to four `spawnSync` calls (`headroom --version`, `headroom version`, then `python3 -c "importlib.metadata.version(...)"` for `headroom` and `headroom-ai`, 750 ms timeout each) the first time it is called. That first call is inside the first `doRender`:

```
spawnSync ← readVersionFromCommand ← getInstalledHeadroomVersion ← formatHeadroomStatusLabel
  ← createControlPanelStatusSnapshot ← statusSnapshot ← renderControlPanelLayout
  ← ControlPanelComponent.render ← Container.render ← TUI.doRender
```

94.6 ms of CPU-profile time in the first `doRender` (`raw/prof/79-t450-cpu`), 92–151 ms across the #104 profiles. On a machine where neither `headroom` nor the Python distributions exist (the common case) all four probes run and fail. In the worst case (a hanging `headroom`) the first frame waits up to 3 s. The cost is fixed, so it hits every interactive start at any session size.

## Design

- `loadHeadroomVersion(): Promise<string | null>` runs the same four probes in the same order with the same arguments, env (`PATH` only), and 750 ms timeout, but with async `execFile`. It runs once per process; every caller shares the promise and the result is cached.
- `formatHeadroomStatusLabel()` (render path) never spawns synchronously. It reads the cache; before the probe has settled it starts the probe (once, without waiting) and returns the label for "no version", which is the existing fallback `getHeadroomRuntimeStatus().policyId`.
- Interactive mode starts the probe when it builds the control panel and calls `requestRender()` once if the probe finds a version, so the `headroom:<version>` label appears as soon as it is known.

User-visible result: unchanged where headroom is not installed. Where it is installed, the label shows the policy id until the probe returns (typically well under a second; on large sessions it is already back when the first frame finishes), then `headroom:<version>`, as before.

## Acceptance

`packages/coding-agent/test/control-panel-headroom-probe.test.ts` (fails on main, passes with the change):

1. `formatHeadroomStatusLabel()` does not call `spawnSync`, returns the policy-id fallback before the probe settles, and starts at most one probe however often it is called.
2. When `headroom --version` prints a version, `loadHeadroomVersion()` resolves to it, only that one command ran, and the label becomes `headroom:<version>`.
3. When the first three probes fail, the `headroom-ai` Python probe is used; commands, arguments, env and timeout match the old synchronous probe.
4. When every probe fails, the result is `null`, the label stays the policy id, and no further probe runs.

Unchanged and passing: `control-panel-runtime-status.test.ts`, `control-plane-rail.test.ts` (its hermetic `child_process` mock also stubs `execFile`).

Timing (informal, not an A/B): first call of `formatHeadroomStatusLabel()` before and after, on this box. A formal first-paint A/B is not required for this fix; it rides along with fix 1's 20-pair measurement.

## Non-goals

- No change to the version parser, the probe order, or the label format.
- Other synchronous spawns at startup (`computeSessionWorkspaceScope`, sandbox probe, `tools-manager`) are outside the render path and out of scope.
- No change to the render pipeline (#79) or width/ANSI work (fix 1).

## Expected Files

- `specs/046-headroom-probe-off-render/spec.md`: this spec (first commit)
- `packages/coding-agent/src/modes/interactive/components/control-panel-runtime-status.ts`: async, cached probe; render path reads the cache
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: start the probe with the control panel, re-render when a version arrives
- `packages/coding-agent/test/control-panel-headroom-probe.test.ts`: new
- `packages/coding-agent/test/control-plane-rail.test.ts`: hermetic mock also stubs `execFile`
- `packages/coding-agent/CHANGELOG.md`: one Changed entry
