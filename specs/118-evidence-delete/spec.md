# Spec 118 — EVIDENCE delete-after-use (D2 recall, D3 spill/bash)

Base: `origin/main` `f2d0596a8e`. Builds on spec 106 D1 (#211, observe-only, `OMK_EVIDENCE_LIFECYCLE=observe`).
Source: 인호 plan §7 (요구사항 D) and §11 EV1–EV13. Scope of this file: spec only; no code, no deps, no CHANGELOG.

## 1. Problem

- D1 registers managed artifacts and reports `wouldDelete`, but `deletes` is the constant 0. Temporary raw output (goal recall logs up to 4 MiB body each, read/bash spills, `omk-bash-*.log`, executor `fullOutputPath`) stays on disk after its last use; only count pruners (`keepNewest`/`enforceCaps`, `deleteGoalRecallFiles`, executor discard) and session-file deletion remove anything (plan §7.2).
- `RecallAccessTracker` read counts are observation, not ACK (plan §7.2, S30). A read must never count as "used up" (EV2).
- Only goal recall has a consumer mapping in D1 (`repair-turn`, `acceptance-recheck`, hold `goal-active`). Every spill/bash/executor artifact is `holds:["unknown"]` (spec 106 §4), so nothing outside recall can be deleted safely yet.
- EV11 nonce prevents path reuse but is not ordering; spec 106 lists a durable monotonic counter as a D2 precondition.

## 2. Change (behind default-off flag)

Flag: **`OMK_EVIDENCE_LIFECYCLE=delete`** (extends the existing D1 variable; `delete` implies everything `observe` does). Unset or `observe` ⇒ behavior byte-identical to today's main (test-pinned). No new setting in `SettingsManager` in this spec; plan §8.1 `evidenceRetention` naming is left to promotion.

Split into two PRs, one concern each:

**D2 — recall deletion (first implementation PR).**
1. Durable monotonic recall counter per `(goal, round, revision)` in the recall dir (small JSON sidecar, written before the log file). File name keeps the D1 form `acceptance-<id>-<round>-<rev>-<attempt>-<nonce>.log`; `attempt` comes from the counter, not from `nextAttempt()` scanning survivors. Deleted paths are never reused (EV11).
2. Deletable iff all of plan §7.3 hold, mapped to the D1 record: producer `goal-recall`; status `present`; `requiredConsumers` all in `consumed[]` as **ACKs** (repair turn committed a result / acceptance recheck settled), not reads; `verified` passing re-run; no `goal-active`, `retry`, `recovery`, `awaiting-consumer`, `unknown` hold; no active reader lease.
3. Restartable delete (plan §7.5): re-check under owner → mark `deleting` + append intent to a per-session `evidence-deletions.jsonl` (ids, sha256 of path, bytes, reason; no path text, no content) → re-verify path is inside the recall dir, `lstat` not a symlink, inode/size match registration → `unlink` → record `deleted`. Failure ⇒ `delete_pending` with reason, bounded retry (3), never reported as `deleted` (EV5, EV6). Delete API takes artifact id, not a path.
4. Existing pruners (`keepNewest`, `enforceCaps`, `deleteGoalRecallFiles`) go through the same owner check when flag is `delete`: they skip artifacts with an active hold or lease and record why (EV13). Flag `observe`/off: unchanged.
5. Lookup states `present | deleted_after_use | missing_unexpectedly` returned to recall readers; a deleted file is not shown as a "Full output" link (plan §7.6, EV9).
6. Cancel, CLI exit, `dispose()`, `prompt_settled` are **not** ACK (plan §7.4). Resumable goals keep `recovery` hold. The 24h terminal-diagnostics TTL from the plan is **not** implemented in D2 (open question Q3).

**D3 — spill / tool-bash / executor deletion (second PR, only after D2 metrics).**
1. Give `read-spill`, `bash-spill`, `tool-output-log`, `bash-executor-log` a consumer mapping: the artifact's owning tool call result has been committed to the session and the turn that produced it is settled with no pending `read` of that path; interactive/RPC `fullOutputPath` returned to the user stays `holds:["user-visible"]` (never auto-deleted).
2. Same delete procedure as D2. Producers with no mapping stay `unknown` and are never deleted.
3. D3 ships only if D1/D2 data show `unknownHoldShare` for these producers can reach 0 for the mapped cases and `unattributed / processRegistered` = 0 in the analysed runs.

Out of scope for both: verified-run receipts/attestations/journal/`issuer.key`, `${sessionFile}.evidence`, `.omk/session-evidence/`, `run-gc.ts`, `readRunEvidence()` inputs (EV10), user-provided files, final deliverables, any file not registered by D1 (plan §7.1). Deleting a managed file does not delete conversation text, provider copies or backups; reports must not claim it does (plan §7.7).

## 3. Measurable success criterion

Primary (D2, per session, from the `evidence_lifecycle` custom entry, last entry per session):
- **Reclaimed share** = deleted recall bytes / registered recall bytes in sessions whose goal reached a passing re-run. Success: ≥ 80% of `wouldDelete` recall bytes observed with flag `observe` on the same task set are actually deleted with flag `delete`.
- **0 required-evidence loss**: 0 `missing_unexpectedly`, 0 reads of a `deleted_after_use` artifact by a required consumer, 0 deletes of an artifact with any hold.

Reported, not gated: latency from last ACK to `deleted`; `delete_pending` count by reason; disk bytes at session end.

## 4. Gates (deterministic, must be 100% before any paid run)

| Gate | Check |
|---|---|
| G0 | flag unset and `observe`: recall file names, prune behavior and session entries byte-identical to main (golden tests) |
| G1 | EV1 two consumers, one ACKed ⇒ kept; EV2 read/partial read/search only ⇒ kept; EV3 retry/recovery hold ⇒ kept |
| G2 | EV4 delete vs new consumer race ⇒ one consistent outcome (state version CAS) |
| G3 | EV5 crash after intent and after unlink ⇒ restart converges, file state matches record |
| G4 | EV6 EACCES/EBUSY/EIO/metadata write fail ⇒ no `deleted` mis-mark, ≤3 retries, reason recorded |
| G5 | EV7 symlink, swapped path, other session's file, file outside recall dir ⇒ 0 deletes |
| G6 | EV9 re-query/resume of deleted artifact ⇒ `deleted_after_use`, no fake link |
| G7 | EV10 verified-run GC/evidence/publish/recovery tests unchanged and green |
| G8 | EV11 delete all files of one `(goal, round, rev)` then re-run ⇒ new attempt number > all previous, no path reuse, survives process restart |
| G9 | EV13 count cap / clear-replace / session delete vs active reader ⇒ owner check not bypassed |
| G10 | trace and deletion log contain 0 path text and 0 output bytes (sha256 only) |
| G11 | no new dependency: Library Scout `git diff` check on `package.json` / lockfile per implementation PR |

D3 adds EV12 (each producer's real return path registered and cleaned; existing cleanup of unexposed output kept) to G1–G10.

## 5. A/B plan

- Arms: base = `OMK_EVIDENCE_LIFECYCLE=observe`; treatment = `OMK_EVIDENCE_LIFECYCLE=delete`. Base must be `observe` (not unset) so both arms produce the same report; flag-off vs observe equivalence is covered by G0.
- Base and treatment on one pinned main SHA, recorded in the report; same task set, same model, same seeds/repeats.
- Task set: tasks that hit at least one failing acceptance check and a repair turn (so recall is produced and consumed). Count eligible tasks from existing run logs first (free); need ≥ 3, else do not run.
- Gates (same as spec 116): pass rate ≥ base − 3pp; cost ≤ 1.10× base; wall time ≤ 1.25× base. Plus §3: 0 required-evidence loss (any one ⇒ fail regardless of pass rate) and reclaimed share ≥ 80%.
- Paid run: waits for 인호's $ cap.
- D3 gets its own A/B with the same gates after D2 is merged.

## 6. Tests (D2 PR)

- `test/evidence-lifecycle-delete.test.ts`: G1–G6, G8–G10 with temp dirs and injected fs faults.
- extend `test/evidence-lifecycle-observe.test.ts`: G0 golden names/entries for unset and `observe`.
- `test/suite/evidence-lifecycle-goal-session.test.ts`: real `AgentSession` goal fail → repair → passing re-run ⇒ recall deleted; cancel/dispose mid-goal ⇒ kept.
- existing verified-run suites unchanged (G7).

## 7. Rollback

Unset the flag or set `observe`: no deletes, existing pruners unchanged. Already-deleted files are not restorable (by design; temporary raw output only). Counter sidecar and `evidence-deletions.jsonl` are ignored when the flag is not `delete`. Code rollback = revert the D2 (or D3) PR; no schema migration of existing evidence readers.

## 8. Open questions for Tech Lead

- Q1. Flag: extend `OMK_EVIDENCE_LIFECYCLE` with `delete`, or a separate `OMK_EVIDENCE_DELETE=1` that requires `observe`?
- Q2. D2/D3 split as two PRs (recall first, spill/bash after D2 data) — OK? D3 gate on `unknownHoldShare` and `unattributed = 0` acceptable?
- Q3. 24h terminal failed-diagnostics TTL (plan §7.4): skip in D2 (ACK-only deletion) or include?
- Q4. Durable counter location: sidecar JSON in the recall dir, or the session journal?
- Q5. Should existing pruners honour holds (and so possibly keep more files than today's caps) under `delete`, given plan §7.6 says to limit new capture instead of deleting held evidence? This changes disk usage under cap pressure.
- Q6. Reclaimed-share bar 80%: fixed now, or report-only in first A/B like spec 117 G2?
- Q7. Storage budget (plan §7.6 per-session bytes/entries cap, capture admission limit): separate spec?
