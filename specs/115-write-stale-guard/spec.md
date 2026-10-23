# Spec 115: `OMK_WRITE_STALE_GUARD`: refuse a whole-file `write` over content the model has not seen

Status: draft (spec only, no code). Base: omk `d6737aa35e` (main after #250).
No paid A/B needed: the flag is default off, and when on it only refuses a write that would
overwrite bytes the model never read. Success is checked by unit tests and a cheap offline
replay of existing session logs (count, no model calls).

## Problem

The `write` tool replaces an existing file with no check of what is on disk.

- `packages/coding-agent/src/core/tools/write.ts:91-111`: inside `withFileMutationQueue` it
  runs `ops.mkdir(dir)` and then `ops.writeFile(absolutePath, content)`. The only look at the
  existing file is `existsSync(absolutePath)` for diagnostics (`:105`).
- `edit` is safe by design: `edit.ts:188-198` reads the current bytes and `oldText` must match
  them, so a stale view fails instead of clobbering. `write` has no such check.
- `read.ts:110` / `:138` read the file, but nothing records what was read.

So a whole-file `write` silently drops anything the model did not see:
1. the file was never read in this session (model writes from memory or a guess),
2. the file changed after the model read it (user edit in the editor, a formatter or
   codegen run via `bash`, a subagent/worker, another omk session),
3. the model read only part of it (`offset`/`limit`, or truncated at
   `DEFAULT_MAX_LINES`/`DEFAULT_MAX_BYTES`, `read.ts:151-185`) and rewrites the whole file.

`file-mutation-queue.ts` serialises writes in one process but does not detect any of these.

## Reference (idea only)

- OpenCode (`sst/opencode`, MIT): `FileTime.read` / `FileTime.assert` refuse a write/edit if
  the file was not read in the session or its mtime is newer than the recorded read.
- Claude Code (closed source, behaviour only): "File has not been read yet" / "File has been
  modified since read" errors on Write.

**No code is copied.** If the implementation PR copies from OpenCode it keeps the MIT notice in
a file header (MIT, no NOTICE needed). Nothing from closed source.

## Change

New env flag `OMK_WRITE_STALE_GUARD`, **default off**. Read per tool call
(`process.env`, like `OMK_EXEC_TRUNCATE_MIDDLE`), so tests can toggle it.

- **Off (unset, empty, anything but `1`)**: byte-identical tool output, details and
  description to `d6737aa35e`. No read is recorded (no memory cost).
- **On (`1`)**:
  - New module `packages/coding-agent/src/core/tools/file-read-ledger.ts`: per-session map
    `canonicalPath -> { sha256, size, full: boolean }`. Key = `canonicalizeForWrite`
    (`workspace-write-guard.ts:21`) so symlinks and `..` match the write key.
  - `read` records the sha256 of the bytes it read (`full` = no offset, no limit, not
    truncated). Images: record too (a write over an image is still a write).
  - `write` and `edit` record the sha256 of the bytes they wrote (so write→write and
    edit→write chains pass without a re-read).
  - `write`, inside the mutation queue, before `mkdir`/`writeFile`: if the target exists
    and is a regular file, hash it and refuse (throw, no write) when
    - no ledger entry → `Refusing to overwrite <path>: it exists and was not read in this session. Read it first (or use edit).`
    - hash differs → `Refusing to overwrite <path>: it changed on disk since you last read it. Read it again.`
    - entry exists, hash equal, `full` false → `Refusing to overwrite <path>: you read only part of it (<n> of <N> lines). Read the rest or use edit.`
  - New file (ENOENT): always allowed. Empty existing file (size 0): allowed.
  - `edit`: unchanged (already content-checked).
- Custom `operations` (SSH etc., `write.ts:88` comment): guard is skipped, same rule as
  edit diagnostics in #250 — the local hash cannot see the remote file. Listed under risks.
- Hashing reuses `node:crypto`; 0 new deps, no workflow edits, no CHANGELOG.
- Ledger lives on the session (cleared on new session / `/new`; kept across compaction,
  because the bytes on disk are what matters, not the context). Subagents get their own.

## Success criterion

1. Unit: all refusal / allow cases in Tests pass; flag-off snapshots byte-identical.
2. Offline replay (no model calls): a script over existing local session JSONL logs counts
   `write` calls on an existing path with no prior `read`/`write`/`edit` of that path in the
   session. Report the count as the "would refuse" rate. Proceed to a default-on proposal
   only if Tech Lead accepts that rate; the script is the measurement, no A/B needed.

## Tests

New `packages/coding-agent/test/spec115-write-stale-guard.test.ts`:

1. Off: write over an unread existing file succeeds; content/details identical to base.
2. On: write new file → ok.
3. On: write over unread existing file → throws "was not read", file unchanged.
4. On: read then write → ok.
5. On: read, external `fs.writeFileSync` change, write → throws "changed on disk", file keeps external bytes.
6. On: read with `limit` (partial) then write → throws "read only part"; truncated read (3000 lines) → same.
7. On: write then write (no read) → ok; edit then write → ok.
8. On: symlink path and `a/../b` path map to one ledger key.
9. On: empty existing file → ok.
10. On: custom `operations` → guard skipped.
11. On: refused write does not bump `getFileMutationGeneration()` and does not leave the queue locked (next write proceeds).
12. Ledger isolated per session (two sessions in one process).

## Risks

- More round-trips: the model must `read` before rewriting; for big files a partial read
  forces `edit` or more reads. That is the point, but it costs tokens. Replay count bounds it.
- Model writes via `bash` (`cat > f`) bypass the guard. Out of scope; not a sandbox.
- Hashing large files on every write: one extra read per overwrite, bounded by file size.
- SSH/custom operations get no protection.

## Rollback

Unset the flag (default). Code removal = revert the PR; no data migration, ledger is memory-only.

## Open questions for Tech Lead

1. Partial-read refusal (case 3 in Change): include in phase 1, or start with
   "never read" + "changed on disk" only?
2. Should `bash` that touches a path (best-effort parse) invalidate the ledger entry, or is the
   hash check at write time enough? (Proposed: hash check only.)
3. Error vs. warning: refuse (throw) as proposed, or first ship a warn-only mode
   (`OMK_WRITE_STALE_GUARD=warn`) to get the replay number from live runs?
4. Ledger on the session object vs. a module-level map keyed by session id — which fits
   agent-session-split better?
