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
**Base**: main `7961ae2` (main merged in later, up to `23fe70e`)
**Classification**: 성능 판정 없음 — 정확성 수정 (Tech Lead 결정, 2026-10-11). A synchronous process spawn on the render path is a bug; merging does not depend on any timing result.

## Problem (#104 profile on #79 `7ff7bba`, t450 session; the timings here are background, not the merge criterion)

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
- Interactive mode starts the probe when it builds the control panel and, through `repaintWhenHeadroomVersionResolves()`, calls `requestRender()` exactly once if the probe finds a version (never when it is `null`), so the `headroom:<version>` label appears as soon as it is known.
- Every probe gets an `AbortController` signal. `InteractiveMode.stop()` calls `abortHeadroomVersionProbe()` first: a running child is killed, no further fallback probe starts, and the result is cached as `null`. Without it, a hung `headroom` would outlive `process.exit`, because the 750 ms timeout is a timer in the parent.
- The probe lives in `headroom-version-probe.ts`, whose only import is `node:child_process`. It runs each command through an injectable spawn function; the default is the real `execFile` one, and the 750 ms `timeout`, the abort `signal` and the `PATH`-only env are passed in that function's options, so an injected function sees the same contract. `setHeadroomProbeSpawnForTesting(fn | undefined)` swaps it (`undefined` restores the real one), aborts a running probe and clears the cache. Production code has no test branch.
- The coding-agent vitest setup file (`test/setup-env.ts`) installs a spawn that answers "no version" without running anything, before every test, with a fresh cache. Tests that construct `InteractiveMode` or render the control panel therefore never start a real `headroom`/`python3`. The swap is in-process only: omk child processes spawned by e2e tests run the real probe. Probe tests restore the real spawn or inject their own.

User-visible result: unchanged where headroom is not installed. Where it is installed, the label shows the policy id until the probe returns (typically well under a second; on large sessions it is already back when the first frame finishes), then `headroom:<version>`, as before.

## Acceptance

`packages/coding-agent/test/control-panel-headroom-probe.test.ts` (fails on main, passes with the change):

1. `formatHeadroomStatusLabel()` does not call `spawnSync`, returns the policy-id fallback before the probe settles, and starts at most one probe however often it is called.
2. When `headroom --version` prints a version, `loadHeadroomVersion()` resolves to it, only that one command ran, and the label becomes `headroom:<version>`.
3. When the first three probes fail, the `headroom-ai` Python probe is used; commands, arguments, env and timeout match the old synchronous probe.
4. When every probe fails, the result is `null`, the label stays the policy id, and no further probe runs.
5. A version found → `requestRender` called exactly once; `null` → not called.
6. A hung command (fake timers, Node's timeout error shape) ends at 750 ms per probe and falls through; after four probes the result is `null` and the label stayed the policy id throughout.
7. Abort: the running probe's signal is aborted, the probe settles to `null`, no further probe starts, and no timer is left.
8. An injected spawn receives `timeout: 750`, the abort `signal` (aborted by `abortHeadroomVersionProbe()`) and a `PATH`-only env; the real `execFile` is not called.

`packages/coding-agent/test/control-panel-headroom-probe-stop.test.ts` (real process, skipped on Windows): a fake `headroom` on `PATH` that records its pid and sleeps; `InteractiveMode.stop()` kills it, the probe settles to `null` in well under 750 ms, and the pid is gone (this case restores the real spawn). A second case keeps the setup's default spawn with a `headroom` on `PATH` that writes a marker file: the probe resolves `null` and the marker is never written.

Unchanged and passing: `control-panel-runtime-status.test.ts`, `control-plane-rail.test.ts` (its hermetic `child_process` mock also stubs `execFile`).

Timing (informal background only — not an A/B result and not a merge criterion): first call of `formatHeadroomStatusLabel()` before and after, on this box, 7 alternating pairs: median ~100.7 ms on main vs ~3.6 ms with the change, with no `headroom` on `PATH` and `python3` present. `bench/raw.tsv` header records the arms: base (main side) `7961ae2`, branch side `5162f0e` (an earlier local SHA of the fix commit; its `control-panel-runtime-status.ts` is identical to `08cd937`). The later review fixes (abort signal, test-runner switch) were not timed. No perf verdict is needed for this fix (Tech Lead, 2026-10-11). Script and raw data: `bench/run.sh <base-ref> [pairs]` (fresh `tsx` process per run, arms alternating, load1 recorded per run), `bench/first-label.mts`, `bench/raw.tsv`.

## Non-goals

- No change to the version parser, the probe order, or the label format.
- Other synchronous spawns at startup (`computeSessionWorkspaceScope`, sandbox probe, `tools-manager`) are outside the render path and out of scope.
- No change to the render pipeline (#79) or width/ANSI work (fix 1).

## Expected Files

- `specs/046-headroom-probe-off-render/spec.md`: this spec (first commit)
- `packages/coding-agent/src/modes/interactive/components/headroom-version-probe.ts`: async, cached, abortable probe with an injectable spawn (review m3/m4)
- `packages/coding-agent/src/modes/interactive/components/control-panel-runtime-status.ts`: render-path label reads the probe cache
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: start the probe with the control panel, re-render when a version arrives, abort it in `stop()`
- `packages/coding-agent/test/control-panel-headroom-probe.test.ts`: new
- `packages/coding-agent/test/control-panel-headroom-probe-stop.test.ts`: new (review m4)
- `packages/coding-agent/test/control-plane-rail.test.ts`: hermetic mock also stubs `execFile`
- `packages/coding-agent/test/setup-env.ts`: default "no version" probe spawn and a fresh probe cache for every test
- `packages/coding-agent/CHANGELOG.md`: one Changed entry
- `specs/046-headroom-probe-off-render/bench/`: timing script (`run.sh`, `first-label.mts`) and raw output (`raw.tsv`)
