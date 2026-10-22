# Spec 107 — OMK_EDIT_DIAGNOSTICS: new-only diagnostics after edit/write

Status: draft (spec only, no implementation)
Base: `origin/main` @ `f3dcf2c189` (Merge #221 release/1.5.6). Refs under `packages/coding-agent/src/core/tools/` unless noted; line numbers anchored to that SHA.
Order: Tech Lead 2026-10-22 KST, borrowing candidate "1" (lint-on-edit), after the bash truncation fix (`e4cefedb15`, branch `fix/bash-tail-drop-truncation`, not yet merged).
Freeze: 10/23 12:00 KST ⇒ default off.

## 1. Problem

After `edit`/`write` the model gets only `Successfully replaced N block(s)` (`edit.ts:189-196`) or `Successfully wrote N bytes` (`write.ts:90-94`). A type/syntax error the edit introduced is invisible until the model chooses to call `diagnostics`, run a build, or run tests — often several turns later, after building on top of the broken edit.

`diagnostics.ts` already exists (tsc / pyright|ruff / go vet / cargo check, fail-soft, normalized `DiagnosticLine`), but it is only a model-invoked tool (`index.ts:92,187,218`). Nothing runs it automatically.

## 2. Prior art and evidence (honest strength)

- SWE-agent `windowed_edit_linting` ([edit](https://github.com/SWE-agent/SWE-agent/blob/main/tools/windowed_edit_linting/bin/edit), MIT): lints after edit, compares with pre-edit lint, and **rejects/reverts** the edit when new errors appear.
- Aider auto-lint ([docs](https://aider.chat/docs/usage/lint-test.html), Apache-2.0): lints edited files and feeds errors back to the model.
- Evidence: [arXiv 2405.15793](https://arxiv.org/abs/2405.15793) Table 3 — edit with linting 18.0% vs 15.0% without (SWE-bench Lite, GPT-4 Turbo).
  **Weak for omk**: 2024 model, a different harness (ACI with 100-line windows), single run, and the measured variant *rejects* edits; we ship *report-only*. The +3.0 pp is not a prediction for omk. We expect at most a small effect; the A/B below decides.
- Code policy: **no code copied**. Fresh implementation; one attribution comment naming both sources. No new dependency.

## 3. Design

### 3.1 Flag
`OMK_EDIT_DIAGNOSTICS=1` enables; anything else (incl. unset) = off. Read per call via `process.env` (same convention as `OMK_RTK_OUTPUT` in `rtk-output.ts:39`). Flag off ⇒ the edit/write code path, tool result bytes and `details` are byte-identical to main (asserted by test, §7).

### 3.2 Integration points (verified at `f3dcf2c189`)
| File | Change |
|---|---|
| `diagnostics.ts` | Export a new internal helper `collectFileDiagnostics(cwd, path, { timeoutMs, signal, bypassCache: true })` that reuses `detectLanguages`/`CHECKERS` (`:290-318`) and returns `{ lines, skipped }`. Existing tool behavior unchanged. |
| new `edit-diagnostics.ts` | `isEditDiagnosticsEnabled()`, `diffNewDiagnostics(before, after)`, `formatNewDiagnostics(...)`. Attribution comment here. |
| `edit.ts:149-197` | Inside `withFileMutationQueue`, if flag on: baseline before `ops.writeFile` (`:184`), post-check after it; append the report to the text content; add `details.newDiagnostics`. |
| `write.ts:72-95` | Same; baseline only if the file existed (new file ⇒ empty baseline). |
| `index.ts` | No change (tools are already constructed with `cwd`). |

### 3.3 Algorithm
1. Language from extension only (`.ts/.tsx/.py/.go/.rs`); other files ⇒ skip both checks (zero cost).
2. **Baseline** (pre-write) and **post** run with `bypassCache: true`. Required: the 5 s TTL cache in `checkLanguage` (`:320-332`) keys on `language+cwd+path`, so a cached result would return the *pre-edit* diagnostics as the post-edit result.
3. New = post minus baseline under the key `(path, severity, message)` — **line/column excluded** so diagnostics that merely shift because lines were inserted above are not reported as new. Multiset semantics (count per key).
4. Report errors only by default (warnings counted, not listed). Cap 10 listed lines, then `... N more`.
5. Text appended to the existing success message, e.g.
   ```
   Successfully replaced 1 block(s) in src/a.ts.
   New diagnostics after this edit (2, vs pre-edit baseline):
   ERROR src/a.ts:12:5 Property 'foo' does not exist on type 'Bar'.
   ```
   No new diagnostics ⇒ append nothing (keeps tokens flat on the common path). Skipped/timeout ⇒ one line `Diagnostics skipped: <reason>.`
6. **Report only, never reject/revert** (v1). The edit is already written and the result is still a success.

### 3.4 Latency budget & failure behavior
- `OMK_EDIT_DIAGNOSTICS_TIMEOUT_MS`, default **10 000 ms per check** (vs 90 s default in the tool). Worst case per edit = 2 checks = 20 s; budget is enforced as a total deadline, post-check gets whatever remains of 20 s.
- tsc is project-wide (`checkTypeScript` runs `tsc --noEmit -p`), so on large repos it will hit the timeout. Timeout ⇒ `Diagnostics skipped: timeout` and the edit result is otherwise normal.
- Missing checker / no project marker / spawn failure ⇒ existing `skippedReason`, reported as one line; **never** a tool error.
- Baseline failed but post succeeded ⇒ do not report (cannot compute "new"); say `skipped: baseline unavailable`.
- Abort: `signal` aborts the checker child (needs `run()` to accept a signal; today it only has a SIGKILL timer, `:79-103`). Abort after the write still returns via the existing `throwIfAborted` path.
- Checks run inside the mutation queue so a concurrent edit to the same file cannot interleave between write and post-check. Cost: the queue is held up to 20 s per file.

## 4. Success criterion (fixed BEFORE any A/B)

- **Primary:** paired resolve rate on the same task set, arm ON (`OMK_EDIT_DIAGNOSTICS=1`) vs OFF. Ship-default-on only if ON − OFF ≥ **+δ pp** with the paired 95% CI (McNemar / paired bootstrap) excluding 0. δ to be fixed by Tech Lead before run 1 (proposal: δ = 2 pp; see Q4). Otherwise stays default-off.
- Task set: frozen list (ids + hash committed before first run), tasks in TS/Python only (where checkers exist), n chosen by Bench Analyst for the power needed; Agent Researcher suggested ≥100/arm.
- **Arms pinned** to the same `origin/main` SHA that contains `e4cefedb15` (bash truncation fix) once merged; the only difference is the env flag.
- **Equal-path-length build dirs** for both arms (e.g. `/workspace/omk-ab-on` / `/workspace/omk-ab-of`… same length) so prompt bytes do not differ by path.
- **Diff the first request payload** of ON vs OFF on one task: must be byte-identical (flag changes only tool results, never the system prompt/tool schema). Any diff ⇒ stop, fix, re-pin.
- **Free runs only.** No $ cap has been set by 인호, so no paid run until one is.

## 5. Guardrails (must not regress, judged on the same pairs)
- tokens/turn (median, p90): ON ≤ OFF × 1.10.
- wall time/task (median, p90): ON ≤ OFF × 1.25; per-edit diagnostics latency p90 reported separately.
- turns/task: report; no hard gate.
- edit/write tool error rate: must be unchanged (report-only must never turn a success into an error).
- Diagnostics-skipped rate by reason (timeout/missing checker) reported; if timeout > 50% of TS edits the result is "not measurable", not "no effect".

## 6. Risks
- Project-wide tsc on big repos ⇒ mostly timeouts ⇒ feature degenerates to noise. Measured by skipped rate.
- Path filter in checkers is substring `d.path.includes(path)` (`:257` etc.): `a.ts` matches `data.ts`; tsc paths are root-relative while `path` is cwd-relative. Implementation must normalize to absolute paths and compare exactly.
- Errors from *other* files caused by this edit (broken export) are filtered out by the per-file scope. v1 accepts this (Q2).
- Pre-existing broken repos: baseline subtraction keeps the noise out, but message-only keys can hide a second identical new error at a different site (multiset count mitigates).

## 7. Test plan
Unit (`test/edit-diagnostics.test.ts`, fake checker injected, no real tsc):
- flag off ⇒ result `content`/`details` deep-equal to main for edit and write.
- new error introduced ⇒ listed; pre-existing error ⇒ not listed; error shifted by inserted lines ⇒ not listed.
- fixing an error ⇒ nothing appended.
- timeout / missing checker / spawn failure ⇒ one `skipped` line, tool still succeeds.
- cache bypass: baseline and post within 5 s return different results.
- exact path match (`a.ts` vs `data.ts`).
- write to new file ⇒ empty baseline.
- abort during post-check ⇒ child killed, queue released.
Suite (`test/suite/edit-diagnostics-flag.test.ts`, faux provider per `test/suite/README.md`):
- session with flag on: faux model edits a TS fixture with a type error; the next request's tool-result message contains the new diagnostic; with flag off it does not; first request payload identical in both.
Gates: `npm run check`, targeted vitest, existing `test/diagnostics-tool.test.ts` unchanged and green.

## 8. Open questions for Tech Lead
- Q1 Reject/revert like SWE-agent? I propose **no** for v1: report-only cannot lose work, and the paper's arm is not comparable anyway. A reject variant could be a third A/B arm later.
- Q2 Per-file scope vs reporting new errors in other files (tsc is project-wide anyway, so cross-file is free for TS).
- Q3 Timeout default 10 s/check (20 s total) — acceptable, or lower (5 s) and accept more skips?
- Q4 δ for the primary criterion (proposal 2 pp) and n — needs Bench Analyst power calc.
- Q5 Warnings: list them, or errors only (proposal: errors only)?
- Q6 Holding the file mutation queue during checks vs releasing it and accepting a race.
