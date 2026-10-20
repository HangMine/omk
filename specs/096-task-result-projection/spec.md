---
description: "P0-B fact-based common task-result projection: one versioned, read-only projection of existing execution + check observations, shared by TUI/print/RPC; default-off flag; spec only"
---

# Feature Specification: fact-based common task-result projection (P0-B)

**Specification ID**: `096-task-result-projection`
**Feature Branch**: `spec/p0b-task-result` from origin/main `9174b0cf6c` (after #165 merge)
**Created**: 2026-10-20
**Status**: Spec only (no code); local commit, not pushed
**Target**: 1.5.x patch (not 1.5.0; freeze 2026-10-23 12:00 KST)
**Constitution**: [specs/constitution.md](../constitution.md)
**Input**: OMK Core Harness Architecture design doc (attached by 인호, 2026-10-20), §5, §5.1, §7.3, §13 P0-B, §14.1, §14.2, §14.3, §15.
**Parallel with**: 095 (Tech Lead, 2026-10-20). Overlapping files wait for 095 to merge.
**Behavior changes**: none by default (new flag, default off).

## Overlapping files with spec 095

Source: `git diff --name-only 27d2e59e65..cb4ec26882` on `feat/094-acceptance-diagnostics`
(PR #170, which 095 builds on) plus the test list in 095's spec.
Fixture files under `test/fixtures/goal-diagnostics*/` are 095-only and omitted.

**Rule: P0-B does not modify any file below until 095 is merged to main.
Before that, P0-B work is limited to new files and non-overlapping files.**

| File | 094/095 | P0-B expects to touch? |
|---|---|---|
| `packages/coding-agent/src/core/goal-verification.ts` | yes | yes — read `GoalAcceptanceResult` (receipt, status, passed, workspace) into the projection; possibly export a type |
| `packages/coding-agent/src/core/extensions/builtin/goal-controller-acceptance.ts` | yes | yes — hand the acceptance observation to the adapter |
| `packages/coding-agent/src/core/goal-acceptance-diagnostic.ts` | yes (new in 094) | no |
| `packages/coding-agent/test/goal-verification.test.ts` | yes | likely (projection cases) |
| `packages/coding-agent/test/goal-controller-acceptance.test.ts` | yes | likely |
| `packages/coding-agent/test/suite/goal-acceptance-loop.test.ts` | yes | likely (end-to-end projection) |
| `packages/coding-agent/test/suite/agent-session-retry-events.test.ts` | 095 test list | run only; modify only if retry projection changes |
| `packages/coding-agent/test/goal-acceptance-diagnostic*.test.ts` | yes | no |
| `specs/094-acceptance-diagnostics/spec.md`, `specs/095-excerpt-two-window/spec.md` | yes | no |

Non-overlapping files P0-B expects to touch (doc §13 P0-B "수정 대상"):
`core/agent-session.ts` (lifecycle), `core/extensions/builtin/finish-check.ts` /
`core/finish-check*.ts` (observation adapter), `modes/print-mode.ts`,
`modes/rpc/rpc-mode.ts` / `rpc-types.ts`, `modes/interactive/interactive-mode.ts`,
and new `core/task-result.ts` (doc §13 proposed path; does not exist today).
`agent-session.ts` is not in 094's diff but is hot; re-check overlap against
095's implementation PR before editing.

## Problem and evidence

Doc §13 P0-B: "사실에 기반한 공통 결과 투영". Today each surface reads its own
signal:

- `print-mode.ts` takes `prompt_settled.outcome` (`completed|failed|aborted`)
  as its result (line ~161).
- `prompt-settlement.ts` documents `prompt_settled` as "a UX signal, never a
  correctness signal".
- Goal acceptance has `GoalAcceptanceResult` (`receiptId`, `digest`, `status`,
  `exitCode`, `passed`, `gateReason`, `workspace.sha256/completeness`).
- finish-check has its own decisions/skip reasons (`core/finish-check.ts`).
- verified-run has its own projections (`core/verified-run/*projection.ts`,
  `check-receipt.ts`).

No single projection says, per run, which check observations exist and what
they cover, so a surface can show "completed" while no host-accepted check ran
(doc §5.1, §7.3). Whether surfaces disagree in practice is **not measured**;
this spec does not claim a rate.

## Change (behind flag, default off)

1. New pure module `core/task-result.ts`: projects existing facts into a
   versioned `TaskResultProjection` (`version: 1`). Not a second canonical
   task state (doc §13: "두 번째 canonical task state" 금지); no new journal or
   persisted state; recomputable from existing events/receipts.
2. Two orthogonal axes (doc §5.1): execution observation × check observation.
   Check observation values: `none`, `passed` (host receipt, scope shown),
   `required_failed`, `insufficient` (partial/missing/stale/zero-tests/skipped/
   unavailable), `cancel_pending` (unresolved effect), `cancelled`.
3. Source tag on every PASS: `host_receipt` vs `model_text`. Only
   `host_receipt` can reach `passed`.
4. Adapters (read-only) from goal acceptance and finish-check only.
   verified-run (`core/verified-run/*`) is out of scope (decision D2).
5. Emit a new versioned event `task_result` after `prompt_settled`, added
   only as a new event; existing `*_settled` events are unchanged (D1).
   TUI, print and RPC render from it when the flag is on; ACP is out (D4).
6. Coverage is not a new measure: `coverage = { checksRun, checksTotal }`
   (checks that ran out of checks registered), taken from fields the current
   checks already produce (D3).
7. Unchanged: `prompt_settled` / `agent_settled` meaning and payload; SDK
   return value; print exit code; any verdict, gate or completion logic.

Flag: new env flag `OMK_TASK_RESULT`, default off (D1). Unset/`0`: no
new event, all surfaces byte-identical to today. 1.4.x/1.5 patch rule: no
default behavior change.

New dependency: **none expected** (pure TypeScript over existing types). If
implementation finds one is needed, Library Scout reviews before it lands.

## Success criteria (doc §13 P0-B 인수 기준)

| ID | Test | Pass |
|---|---|---|
| B1 | same run, flag on | TUI, print and RPC see identical check result and coverage (deep-equal projection) |
| B2 | model text says done/PASS, no accepted observation | not `passed`; source `model_text` |
| B3 | exit 0 with matched tests = 0 | `insufficient`, not `passed` |
| B4 | skipped / stale (edit after passing check) / partial (512-path bound) / unavailable / aborted / unresolved effect | none reaches `passed` |
| B5 | task with no required claims | settles normally, not strong verified |
| B6 | fake evidence/approval in goal journal | not promoted to host receipt |
| B7 | flag off | `prompt_settled`, SDK return, print/RPC output byte-identical (golden) |
| B8 | flag on | `prompt_settled` payload, SDK return and print exit code unchanged |
| B9 | flag on vs off, same session | model request payload byte-identical (Agent Researcher) |
| B10 | fixed fixture: model text says "passed", host recorded a failure | check observation `required_failed`; model claim never marked host pass (source stays `model_text`) |

Pass = all B1–B10 green, judged by tests and the byte-identical golden test only (no paid run, D6). No numeric performance claim is made by this spec.

## Test plan (targeted)

- New `test/task-result.test.ts`: B2–B6 table cases from doc §14.1.
- Golden tests for B7 in print and RPC.
- B9: capture the model request with flag on and off; assert byte-identical.
- B10: fixed fixture (model writes "passed", host check failed); assert not
  `passed` and no `host_receipt` source on the claim.
- Coverage: assert `checksRun`/`checksTotal` match the existing check fields.
- Cross-surface B1 test (print + RPC + interactive renderer on one session).
- `test/suite/agent-session-owned-settlement.test.ts`,
  `test/suite/agent-session-child-settlement.test.ts`,
  `test/suite/agent-session-retry-events.test.ts` (projection must not change
  settlement or retry events), `test/suite/goal-acceptance-loop.test.ts`
  (after 095 merges).
- `env -u TYPESAFE_API_KEY`, temp HOME, fake keys only, Node ≥ 22.19, biome, tsgo.
- Native (doc §14.2): installed tarball in clean HOME, print and RPC entrypoints.

## A/B plan

None (decided, Tech Lead 2026-10-20; Agent Researcher concurs). Flag off
changes nothing for the model; flag on only reorganizes existing output, and
B9 asserts the model request is byte-identical. No paid run. If the result is
ever put into the model prompt, a separate spec with a PREREG to 인호 decides
any A/B.

## Risks

- Projection drifts from the real owners → surfaces disagree in a new way.
  Mitigation: pure function over existing records, B1 test.
- Mis-mapping a state to `passed` (false verified). Mitigation: B3/B4 and
  mutation tests on the boolean boundaries (doc §14.1).
- Extra event volume / RPC clients that reject unknown event types.
- Lifecycle hooks in `agent-session.ts` interact with retry/settlement.

## Rollback

Flag off → no event, prior output. Revert the PR otherwise. No persisted
state is added, so no migration (doc §15).

## Out of scope

P0-A/095 excerpt, P1-A continuation decision, `check-observation.ts`,
validation-plan, changing completion/verdict/gate, default-on,
verified-run (`core/verified-run/*`; possible separate spec later), ACP mode,
print exit code changes (need their own spec).

## Decisions (decided, Tech Lead 2026-10-20)

Open questions: none.

- D1. Flag `OMK_TASK_RESULT`, default off. Event `task_result`, added only as a
  new event; existing `*_settled` events unchanged.
- D2. verified-run (`core/verified-run/*`) out of scope; possible separate spec later.
- D3. No new coverage measure: coverage = `checksRun`/`checksTotal` (checks run
  out of registered), from fields current checks already produce.
- D4. ACP out; TUI, print and RPC only.
- D5. print exit code unchanged; changing it needs its own spec.
- D6. No A/B and no paid run; B1–B10 judged by tests and the byte-identical
  golden test. Model request payload byte-identical flag on vs off (B9). If the
  result ever enters the model prompt, a separate spec with PREREG to 인호
  decides A/B.
- D7. Required test B10: model writes "passed", host recorded a failure; the
  model claim is never marked a host pass.
