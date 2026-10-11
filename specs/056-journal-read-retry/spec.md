---
description: "omk run cancel/explain fail with verified-run: integrity when the live writer appends to the journal mid-read; retry only that case"
---

# Feature Specification: Journal reads survive a live writer

**Specification ID**: `056-journal-read-retry`
**Feature Branch**: `fix/journal-read-retry`
**Created**: 2026-10-11
**Status**: Draft
**Constitution**: [specs/constitution.md](../constitution.md)
**Input**: CI flake in `test/verified-run-cli-control.test.ts` ("cancels a run started by another process"), 4 failures since 2026-10-05, one on main. Tech Lead filed it as a P0 correctness bug, so there is no flag.
**OMK Preset**: `omk`

## CLI Harness Target Impact

**Classification**: fix (verified-run correctness). No change to journal format, error codes or messages.

| Dimension | Baseline (main `f913f49`) | Acceptance target | Regression floor | Verification command | Evidence artifact |
| --- | --- | --- | --- | --- | --- |
| Live journal reads | `omk run cancel` and `omk run explain` on a running run fail with `verified-run: integrity` when the writer appends while they read. The reproduction test sees about 130 failures in 1.5 s against a writer that changes the file every millisecond. | 0 failures in the same test. | Real corruption (bad JSON, broken hash chain, wrong `nlink`/file type, size limit, torn tail) still fails on the first read with the same code. | `npx vitest run test/verified-run-journal-read-retry.test.ts` in `packages/coding-agent` | that file |

## Problem

`readRegularFile` (`storage.ts`) fstat's the file before and after reading and throws `integrity` if size or ctime moved, or if fewer bytes came back than the first fstat promised. That is the right check for files that are finished before anyone reads them. The run journal is different: its owner keeps appending while other processes read it.

- `cancelVerifiedRun` starts with `requireRunJournal(runPath)` (`cancel-request.ts:144`), which reads the live journal before it even writes the cancel request. When the writer appends at that moment, the user's cancel fails with `integrity` and no request is written.
- `readRunExplanation` (`explanation.ts:29`), used by `omk run explain`/status, has the same exposure.
- The CLI test polls `readRunJournal` while the started run writes, which is how CI found it (`verified-run: integrity` at `storage.ts:28` via `journal.ts:29`).
- `run-gc` is not exposed: it takes the owner lease first (`run-gc.ts:98`) and returns `owner_live` while a writer holds it, so it never reads a journal that is being written.

## Design

1. `readRegularFile` throws `VerifiedRunConcurrentChangeError` for the "changed during read" branch only. It extends `VerifiedRunError` with code `integrity`, so every existing caller and message is unchanged.
2. `journal.ts` gets `readJournalBytes(path, read = readRegularFile)`. It retries only `VerifiedRunConcurrentChangeError`, up to `JOURNAL_READ_RETRIES = 3` re-reads (4 reads in total), sleeping 2, 4, 6 ms in between. After that the last error is thrown unchanged. It returns `{ bytes, attempts }` so tests can see which attempt succeeded.
3. `readRunJournal` is the only caller. `requireRunJournal`, `readRunExplanation`, `run-gc` and the writer's own re-read in `VerifiedRunJournal.append` all go through it, so there is one entry point.
4. The other ten `readRegularFile` callers (candidate, evidence, blobs, issuer key, git worker, cancel request) keep failing on the first change. Those files are complete before they are read, so a change there is a real anomaly.

## Acceptance

- AC1: with an injected reader, 0 to 3 concurrent changes succeed on attempt 1 to 4, and 4 changes throw `verified-run: integrity`.
- AC2: `integrity` from anything other than a concurrent change, `file_type`, `storage_limit` and non-omk errors are read exactly once.
- AC3: with a child process moving the live journal between two valid states every millisecond, `requireRunJournal` (cancel) and `readRunExplanation` (explain) see 0 failures over 1.5 s. Without the fix the same test fails (about 130 `integrity` errors per run, checked twice before the fix).
- AC4: `collectVerifiedRuns` keeps a live run as `owner_live` without reading its journal.
- AC5: existing verified-run journal, cli-control and supervisor tests pass unchanged.

## Non-goals

- No retry in the other `readRegularFile` callers.
- No change to the CLI test's polling loop. It goes through `readRunJournal`, so it is fixed by the product change, not by swallowing `integrity` in the test.
- The supervisor `unsettled` timeouts in CI are a different failure and are tracked separately.

## Known risks

- A writer that appends faster than every 2–6 ms for the whole retry window can still surface `integrity`. The real writer appends one durable (fsync'd) record per event, so this needs a far faster writer than omk has.
- The retry sleeps synchronously (at most 12 ms in total), because `readRunJournal` is synchronous.
