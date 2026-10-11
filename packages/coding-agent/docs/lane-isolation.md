# Lane isolation planning

`src/core/lane-isolation-plan.ts` is a plan-time scaffold using the current
`SubagentLaneGrant` contract. It validates explicit agent, task, scope, skills,
hooks, MCP, acceptance criteria and evidence output before returning deterministic
branch and worktree paths. It does not create branches, worktrees or processes,
and it does not change the default subagent launcher.

Plans use `work/<runId>/<laneId>` and `.omk/worktrees/<runId>/<laneId>`. Identifiers
cannot contain traversal or path separators. Evidence must name a concrete path
under `.omk/runs/`. Grant paths cannot escape repository scope. Read-only grants
may declare read scopes but cannot declare product writes; write-scoped grants
must declare a write scope.

`assertNoLaneIsolationConflicts()` rejects duplicate lane identifiers, duplicate
evidence paths and overlapping writer scopes using the shared lane path rules.
This is conservative scheduling validation. A future caller that materializes a
plan must also enforce realpath and symlink confinement and the existing loadout
authority at every filesystem boundary.

The scaffold ports the validation and path-planning intent of PR #18 from the
legacy root-runtime layout. It does not import that branch's older runtime or
replace the current scheduler.
