# Spec 098: Raw-output recall for failing acceptance checks

Status: implemented behind a flag, not measured. Base: `origin/main` `29933049fe`.
Owner: Harness Engineer. Reviewer: Tech Lead. Research input: Agent Researcher design draft (098).
Flag: `OMK_GOAL_OUTPUT_RECALL=1` (default off; off = exactly current `main` behavior).
New dependencies: 0.

## 1. Problem (verified in source at `29933049fe`)

- The settled-turn follow-up for a failing acceptance check
  (`core/extensions/builtin/goal-controller-acceptance.ts`, `settle()`) tells the model
  ``Run it to see the output, fix the cause, and end your turn when it passes.``
  The model never sees the check's output; it must re-run the command only to read it.
- `GoalAcceptanceResult.outputTail` (last 2,000 chars) only goes to `ctx.ui.notify`.
- The verified-bash receipt keeps the last 64 KiB; it is not the full output and
  is the completion evidence, so 098 must not change it.

Excerpt rules (094→097) keep missing the cause on new holdouts (severity-blind
lint lines, summaries taking the last window). 098 keeps the full raw output
on disk and points the model at it, so the excerpt becomes a hint.

## 2. Change (flag on)

1. **Artifact.** The acceptance check's combined output (the same `onData` stream
   that feeds the receipt) is also streamed to a file:
   - session mode: `<session>.artifacts/acceptance-<goalId>-<round>-<rev>.log`
     (same dir as spec 066 MCP spills, dir 0700);
   - `--no-session`: `<tmpdir>/omk-accept-<16hex>.log`.
   - file 0600, created with `flag: "wx"`.
2. **Bytes cap 4 MiB.** Over the cap the file keeps the first 1 MiB and the last
   3 MiB with one `[omk: N bytes elided]` line in between.
3. **Count cap.** Per goal the latest 3 artifacts, per artifact dir 20; oldest
   first. Temp mode: files from this process are removed at exit, and
   `omk-accept-*` older than 24 h are swept when a new one is written.
4. **Abort / runner error.** The partial file is deleted and no reference is given.
5. **Follow-up** (replaces the `Run it to see the output` sentence):
   ```
   Acceptance check `<cmd>` <failure> (<receipt>).
   Diagnostic hint (may be incomplete):
   <last ≤1.5 KB of the cleaned output>
   Full output: <path> (<lines> lines, <size>; complete | middle elided N bytes)
   Read ranges with read(path, offset, limit) instead of re-running the check to see output.
   Fix the cause, then end your turn; the check re-runs automatically.
   ```
   The path is relative to cwd in session mode (readable with `read`), absolute in temp mode.
   If the artifact could not be written, the follow-up falls back to the `main` text.
6. **Trace.** The `goal_verification` entry gets `outputArtifact: { sha256, bytes,
   lines, complete, elidedBytes }` — counts and a digest only, 0 bytes of raw text.
7. **Separation.** The artifact is diagnostic only. Completion and evidence still
   come from the receipt alone. No redaction is applied and none is claimed.

## 3. Invariants

1. Flag off: no file is written, the follow-up and the `goal_verification` entry
   are byte-identical to `main` (test).
2. Receipt bytes, receipt policy id and gate decisions are unchanged in both arms.
3. No raw output text in session entries or traces.
4. No new tool; `read` (offset/limit) and `grep` are reused.

## 4. Tests

- Artifact unit: complete file, 4 MiB cap with head/tail + marker, 0600/0700,
  `wx`, abort deletes, per-goal and per-dir count caps, temp sweep.
- Controller: flag off follow-up byte-identical to `main`; flag on follow-up has
  the path, counts, hint, no `Run it to see the output`; the file content equals
  the command output; trace has sha256/counts and no raw text.

## 5. Not in scope / open

- The 097 two-window excerpt is not on `main`; the hint is the cleaned output tail
  until a v3 excerpt lands.
- Metrics (cause-acquired rate, duplicate re-runs) need the offline replay and a
  paid pilot; the cap values (4 MiB, 1:3, 3/20) are unmeasured defaults.
- bash tool spill cleanup (`omk-bash-*.log`) is a separate issue.
