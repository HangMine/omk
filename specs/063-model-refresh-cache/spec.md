# Spec 063: skip ModelRegistry.refresh() on selector open when nothing changed (F4 from spec 062)

Status: implemented locally, waiting for Tech Lead review. Target 1.4.3. Base: origin/main `e28c260f75`.
Measurement: spec 062 (`harness/062-ui-lag`). With 500 models, `/model` open spends about 11–16 ms in
`ModelSelectorComponent.loadModels` → `ModelRegistry.refresh()` (`core/model-registry.ts` `refresh`/`loadModels`/`mergeCustomModels`).

## Change
- `ModelRegistry.refreshIfChanged()` runs `refresh()` only when one of its inputs differs from the last call through it.
  Inputs (`core/model-registry-refresh-inputs.ts`), all compared with `===`:
  - the exact models.json text (absent and unreadable are distinct markers). This is a content compare, not
    mtime/size, so a same-size edit inside the same timestamp tick is still caught. Reading the file is cheap; the
    parse, validation and merge are what cost.
  - the registered API provider objects (`getApiProviders()`)
  - each OAuth provider's own fields and, for model-modifying ones, the selected account's own fields
  - `registerProvider()` invalidates explicitly, because it mutates registry state outside `refresh()`.
- Call sites changed: `/model` selector open (`model-selector.ts` `loadModels`), `showModelsSelector` and
  `getModelCandidates` in `interactive-mode.ts`. Login/logout/account-select/provider-auth keep calling `refresh()`.
- Not cached: API-key availability. `getAvailable()` → `hasConfiguredAuth` already reads auth live, so a login shows up
  without a reload (tested).
- Default behavior: unchanged. The selector shows the same models and the same models.json error. Same-state equality is
  tested against a forced `refresh()`.
- Module-size baseline: `core/model-registry.ts` 740 → 746 (+6 LOC: import, field, 3-line method, invalidate call).
  This is a deliberate bump. The logic lives in the new module; only the hook points are in the registry.

## Tests (`test/spec063-model-refresh-cache.test.ts`, 6)
Covered:
- skip, and the skipped state deep-equals a forced refresh
- a same-size models.json edit reloads
- broken models.json reloads and surfaces the error
- deleting models.json reloads
- `registerProvider` forces a reload
- an OAuth credential change for a `modifyModels` provider reloads, and the new baseUrl is used
- an API-key login needs no reload

Mutants:
- never comparing inputs → 3 fail
- dropping the `registerProvider` invalidate → 1 fails

`model-registry.test.ts` (75) and `model-registry-snapshot.test.ts` (6) pass.

## Paired A/B (20 interleaved process pairs, 10 samples each; A = main dist, B = this branch)
`bench/ab063.sh <A> <B> 20 results/ab063`, then `node bench/absum063.mjs results/ab063`.
| p50 / p90 / p95 ms | A | B | paired A−B p50 (median, min) |
|---|---|---|---|
| selector open → rendered (lag-bench, 500 models) | 14.8 / 22.3 / 22.8 | 2.4 / 3.0 / 3.6 | 12.8 (min 10.9) |
| /model open → first frame (render-bench, 200-pair chat) | 21.0 / 25.3 / 28.8 | 6.5 / 7.5 / 9.0 | 14.4 (min 12.1) |
| select → frame | 4.7 / 5.1 / 5.8 | 4.7 / 5.1 / 5.9 | 0.2 |
load1 1.14–2.16 for both arms. Criterion "selector open with 500 models p50 ≤ 4 ms" ✅ (2.4).
Note: a direct forced `refresh()` timed in the bench went from 8.2 to 13.2 ms p50 in B. That code is unchanged; in B
the selector no longer runs it, so it stays colder in the JIT. It only matters at login/logout.
