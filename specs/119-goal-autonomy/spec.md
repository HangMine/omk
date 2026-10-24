# Spec 119 — goal autonomy (`OMK_GOAL_AUTONOMY`)

Base: `origin/main` `fc3fee6b46`. Builds on spec 106 §5 (B — goal autonomy, AU1–AU4, PREREG non-inferiority) and the existing `/goal` controller.
Scope of this file: spec only; no code, no deps, no CHANGELOG.

## 1. Problem

- `/goal` already loops: `agent_settled` in `extensions/builtin/goal-controller.ts` calls `decideGoalContinuation()` (`goal-continuation.ts`) and, with an approved check, `GoalAcceptanceFlow.settle()` (`goal-controller-acceptance.ts`) runs the check, then `advance-round` + `continueGoal()` or `block()`.
- Gaps against spec 106 AU1–AU4:
  - Stops are only `round-limit`, `not-active`, check failure/blocked. No budget/deadline stop (AU4), no explicit stop reason for "outcome unknown" side effects (AU4).
  - A user steer queued mid-goal returns `queued` and the loop resumes on the next settle; there is no revocation record that rejects a late continuation of the old round (AU2).
  - A changed acceptance command bumps `revision`, but nothing prevents the controller from continuing under a scope (target files / command set) the user did not re-approve (AU3).
  - A goal is created only by an explicit `/goal <text>`; there is no opt-in path from an explicit execution request.
- Result: the model either re-asks for confirmation each step (cost) or, if pushed to continue, has no hard, recorded stop conditions beyond rounds.

## 2. Change (behind default-off flag)

Flag: **`OMK_GOAL_AUTONOMY=1`** (strict `=== "1"`; any other value ⇒ off). Unset ⇒ behavior byte-identical to main (test-pinned, G0). No YOLO; `command-safety` / `command-safety-parser` unchanged; `maxRounds` default 8, not raisable by the model.

1. **Stop policy** — extend `decideGoalContinuation()` input with optional `budget` (`{ maxCostUsd?, deadlineIso? }`, from `/goal budget …` or env, never model-set) and `lastSideEffect: "ok" | "unknown"`. New reasons `budget-limit`, `deadline`, `outcome-unknown`. Flag off ⇒ fields ignored, reasons unreachable. Each stop moves the goal to `blocked` via existing `store.transition` with a typed reason, appended as a `goal_autonomy_stop` custom entry (`{reason, round, revision}`; no prompt text).
2. **Outcome-unknown** — a tool result marked aborted/timeout for a mutating tool (`bash`, `edit`, `write`) in the settled turn sets `lastSideEffect="unknown"` ⇒ stop, never auto-continue that round (AU4).
3. **Steer/cancel revocation (AU2)** — on user input while a goal is active, record `goal_autonomy_revoke {round}`; `continueGoal()` refuses a continuation whose round ≤ revoked round until the user resumes (`/goal resume`). Cancel ⇒ `paused`.
4. **Scope pin (AU3)** — approval stores `{contractRevision, commandSha256}` (sha only). If `checkIdentity()` revision differs from the pinned one at settle, the loop stops with `scope-changed` and asks re-approval; no reuse of the old approval.
5. **Opt-in goal creation** — out of the first PR. Only explicit `/goal`. Intent classifier is a separate follow-up behind the same flag after metrics (Q3).

Integration points: `goal-continuation.ts` (`decideGoalContinuation`), `extensions/builtin/goal-controller.ts` (`agent_settled`, `continueGoal`, `/goal` command: `budget` subcommand, `input` handler), `goal-controller-acceptance.ts` (`settle`, `block`), `goal-acceptance.ts` (`checkIdentity`), `durable-goal.ts` (no schema change; reasons go in custom entries), `extensions/builtin/harness-factories.ts` (unchanged; goal controller already registered via `OMK_GOAL_CONTROLLER`).

## 3. Measurable success criterion

- **Primary: false-completion rate** (goal reported `completed`, fails independent grading), paired per task. Non-inferiority per spec 106 §5: pass iff one-sided 95% upper bound of FC(autonomy) − FC(baseline) < δ (δ = +5pp placeholder, pending 인호).
- Secondary (report-only): user confirmation turns per completed goal; verified completions; stop reasons histogram.
- A drop in confirmations with any rise in false completion ⇒ fail.

## 4. Gates (deterministic, 100% before any paid run)

| Gate | Check |
|---|---|
| G0 | flag unset / `0` / `true`: first request, session entries and goal transitions byte-identical to main (golden) |
| AU1 | approved check fail → repair → pass completes without extra confirmation, within `maxRounds` |
| AU2 | steer, cancel, permission revoke mid-goal ⇒ no later continuation of revoked round; late result not accepted |
| AU3 | command / revision / target change ⇒ `scope-changed` stop, old approval not reused |
| AU4 | round, deadline, cost limit, outcome-unknown ⇒ exact stop reason; 0 auto-retries of a mutating call with unknown outcome |
| G5 | model cannot raise `maxRounds` or budget (tool/prompt paths) |
| G6 | `goal_autonomy_*` entries contain no prompt/command text (sha256 only) |
| G7 | no new dependency (Library Scout diff on package/lock) |

## 5. Test plan

- `test/goal-continuation.test.ts`: new reasons, flag-off ignores fields.
- `test/goal-autonomy.test.ts` (faux model, realistic usage): AU1–AU4, G5, G6.
- `test/suite/goal-autonomy-session.test.ts`: real `AgentSession` loop incl. steer mid-goal and cancel.
- G0 golden: extend existing goal-controller tests for unset flag. Existing goal/recall/evidence (spec 098/118) suites unchanged.
- Targeted runs + `test/suite` + `npm run check`.

## 6. A/B plan

- Arms: base = flag unset with `/goal` + approved check; treatment = `OMK_GOAL_AUTONOMY=1`. One pinned main SHA, same tasks/model/provider/effort/tools/budget, paired.
- Free first: deterministic gates + count eligible tasks (approved check, ≥1 failing round) from existing run logs; pilot re-estimates p_disc before freezing n (spec 106 estimate ≈250 paired tasks at p_disc 0.10, δ 5pp).
- Extra gates as spec 116: cost ≤ 1.10× base, wall ≤ 1.25× base.
- **No paid run until 인호 posts a $ cap.**

## 7. Risks

- Runaway loops / cost: mitigated by round cap + budget + deadline, all user-set.
- Repeated side effects: outcome-unknown stop; command-safety unchanged.
- Silent scope drift: scope pin on revision + command sha.
- False completion rise: primary metric; any rise beyond δ fails.
- Steer race with an in-flight settle: revoke record checked in `continueGoal()` (test AU2).

## 8. Rollback

Unset the flag: controller behaves as main. New custom entries are ignored when off. Code rollback = revert the PR; no goal schema migration.

## 9. Open questions (Tech Lead)

1. δ = +5pp and the paid $ cap — still pending 인호; OK to land code with gates only?
2. Budget source: `/goal budget` subcommand only, or also env (`OMK_GOAL_BUDGET_USD`)? Cost from session usage — include subagent lanes?
3. Intent classifier (goal from explicit execution request): split to a later spec as proposed?
4. Outcome-unknown: is "aborted/timeout of `bash`/`edit`/`write`" the right definition, or use command-safety's mutating classification?
5. AU2: should steer pause the goal (`paused`) or only drop the pending continuation and keep `active`?
6. Stop reasons as custom entries vs. new `DurableGoalErrorCode` values (schema `omk.goal.v1` unchanged in this proposal)?
