---
description: "Verified-run journal readers see a prefix of complete records while the single writer appends: drop a torn tail, retry only real inconsistency within a 250 ms budget, and fail with concurrent_change instead of integrity/journal_truncated"
---

# Feature Specification: journal concurrent read

**Specification ID**: `088-journal-concurrent-read`
**Feature Branch**: `spec/088-journal-concurrent-read` from origin/main `af8d32559e`
**Created**: 2026-10-20
**Status**: Draft (spec first; implementation follows on the same branch; not pushed)
**Constitution**: [specs/constitution.md](../constitution.md)
**Input**: OMK and Tech Lead, from the 1.5.3 wrap-up (`notes/2026-10-19-deployment-wrap-up.md:278`, `readRunJournal` retry budget).
**OMK Preset**: `omk`

## Scope

- 1 writer: the `VerifiedRunJournal` owner holding the session owner lease.
- ≤ 8 concurrent readers on the same host: `inspect`, `events`, `readRunExplanation`.
- Non-goals: multiple writers, network file systems, Windows.

## Baseline (`af8d32559e`)

- `packages/coding-agent/src/core/verified-run/storage.ts:26-41` `readRegularFile`:
  - fstat before and after a whole-file read;
  - any change in size or ctime, or a short read, throws `VerifiedRunConcurrentChangeError`, which has public code `integrity` (`storage.ts:16-21`).
- `journal.ts:33` `JOURNAL_READ_RETRIES = 3`; waits are `attempt * 2` ms (`journal.ts:46`, `:66`), so 2+4+6 = 12 ms in total.
- `readJournalBytes` (`journal.ts:37-49`) retries only a concurrent change.
- `readRunJournal` (`journal.ts:52-94`):
  - re-reads while the last byte is not `\n`, then throws `journal_truncated` (`:61-67`);
  - throws `integrity` for an unparsable line (`:72-78`).
- A reader that races an append for longer than about 12 ms gets `integrity` or `journal_truncated`, even though nothing is corrupt.

## Guarantee

A reader-mode read returns either an error, or the records of a prefix of the journal in which every record is complete and hash-chained.

1. **Torn tail.** Bytes after the last `\n` are an in-progress append, so the reader drops them. The tail is not parsed, not repaired, and not written.
2. **Retry only real inconsistency, within a time budget.** Retry happens only when:
   - `readRegularFile` reports a concurrent change (size, ctime or length moved during the read); or
   - the file shrank below the length of a previous attempt's complete prefix in the same call.

   Total time budget: ≤ 250 ms per call, on a monotonic clock, including the read itself. Backoff starts at 2 ms and doubles, capped at the remaining budget.
3. **Budget exhaustion** throws `VerifiedRunError("concurrent_change")`, a new public code. Readers no longer see `integrity` or `journal_truncated` for a live append.
4. **Corruption stays `integrity`.** A complete line that fails to parse or fails the hash chain is still `integrity`. It is never dropped.
5. **Writer and recovery paths stay strict.** These still treat a torn tail as `journal_truncated`, because a writer must not append after unknown bytes:
   - `VerifiedRunJournal` (`journal.ts:108`, `:121`, `:135`);
   - coordinator mutations (`coordinator.ts:148`, `:220`, `:240`);
   - `recovery-command.ts:10`;
   - `run-gc.ts:106`.
6. **Reader mode** is opt-in through `readRunJournal(runPath, { mode: "reader" })`, used by `coordinator.ts:78` (`inspect`), `:101` (`events`) and `explanation.ts:29`.

## Requirements

### Requirement 1 - Deterministic read-hook tests (P0; must FAIL on `af8d32559e`)

1. **In-progress append (torn tail).** A read hook returns the committed bytes plus a partial next record (no trailing `\n`) on every attempt. Reader mode returns exactly the committed records.
   - On base: `journal_truncated`.
2. **Four consecutive changes exhaust the budget.** A read hook throws `VerifiedRunConcurrentChangeError` on every attempt, and an injected clock advances past 250 ms by the fourth retry. The result is `concurrent_change`, and the attempt count and elapsed time stay within the budget.
   - On base: `integrity`.
3. The failing names and output path on base, and the passing run after the fix, go in the PR body.

### Requirement 2 - No regression for strict paths (P0)

1. The existing test `refuses torn tails without repairing during inspection` (`test/verified-run-journal.test.ts:122`) still passes with the default (strict) mode.
2. Middle corruption is still `integrity`.
3. File bytes are unchanged after any read.

### Requirement 3 - Load gate (P1; PREREG first)

1. 1 writer and 8 readers; 30,000 reader-mode read attempts in total, run concurrently with continuous appends.
2. Pass requires 0 `integrity`, 0 non-prefix results (every returned record list equals a prefix of the final journal), and 0 `concurrent_change`.
3. The criteria are frozen in `PREREG.md` with sha256 before any load run.

### Requirement 4 - Common (P0)

1. Bug fix with no flag. The behaviour change applies to reader mode only.
2. 0 new dependencies.
3. Hooks run on every commit.
4. CHANGELOG is not edited; the PR body carries the Behavior changes line.

## Known risks

- A reader can see a slightly older prefix (the torn tail is dropped). This is intended; readers already get a snapshot.
- 250 ms of busy-retry blocks the reader's thread, because `Atomics.wait` is synchronous. The 8-reader scope bounds the cost.
