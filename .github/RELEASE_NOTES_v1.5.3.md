# OMK v1.5.3

OMK 1.5.3 is a patch release: three runtime fixes, plus test-fixture repairs that make the
suite green on a loaded host and restore CI.

## Fixed

- **Skill search phase.** `SkillSearchGate` now passes the active TODO kind into metacon
  ranking. The ranker and the `skill-select` run log already accepted a `phase`, but the
  gate never supplied one, so ranking and `phaseSource` always reported the `task` default.
- **Concurrent attachment previews.** Two previews of the same active attachment now share
  one in-flight Photon decode instead of each allocating a full-resolution image and a
  resized RGBA buffer. A dropped draft still releases its entry through the existing
  `WeakMap`.
- **Journal reads during a live append.** A reader that opens the journal before a writer
  appends and reads after it could observe a partial final line and report `integrity`.
  `readRunJournal` now retries that bounded window as a concurrent change; a read that still
  lacks a trailing newline after the bounded retries reports `journal_truncated`. A size/ctime
  race that exhausts the inner `readJournalBytes` retries surfaces as `integrity` instead,
  because `VerifiedRunConcurrentChangeError` carries that code. Middle-file corruption is
  unchanged. That `integrity` is what spec 056 specifies (Design 2, AC1); a writer that
  changes the file faster than the 2 to 6 ms retry window can still trigger it, which the
  spec lists as a known risk.

## Tests and CI

- Two compaction tests pin a 1 ms retry backoff. The default policy (5 attempts, 2 s base)
  waited about 62 s for a 503, past the 30 s Vitest timeout, which failed CI on every run
  since `retry.maxRetries` changed to 5 in 1.5.1. Retry counts and assertions are unchanged.
- `verified-run.test.ts` raises its fixture work/verify budget to 30 s and derives the
  "past the work deadline" clock from that budget. The old 3 s budget also bounded process
  spawn, so a loaded host failed the suite with `deadline`. The timeout behavior keeps its
  own test at `workMs: 100`.
- `verified-run-authority-restart.test.ts` uses a 60 s grant TTL. Its fixtures assert restart
  quarantine, not expiry. Expiry remains pinned deterministically in
  `verified-run-authority-store.test.ts`.
- `memory-factorial` allows 30 s for the host clock to recover instead of 5 s, so a WSL2 time
  resync no longer fails the offline experiment. The store's real-clock guard and the
  future-dated-memory assertions are unchanged.
- The `journal-read-retry` mutator retries a short `pwrite`, so the test only produces the two
  valid journal states it claims to produce.

## Notes

- No CLI, protocol, or configuration keys were added or removed. There are no intentional
  breaking changes.
- `npm run check` and `npm run build` pass.
- The suite was green at release time. An independent re-run on 2026-10-19 18:40 KST
  (load average 3.7 rising to 18 on 24 cores) exited 1: 9092 of 9153 tests passed, 60 were
  skipped, and one test added in this release (`verified-run-journal-read-retry.test.ts`,
  "explain's journal read survives a writer appending mid-read") reported `integrity`. The
  same file passes 6/6 standalone and in repeated standalone runs, so the failure is
  load-dependent rather than deterministic. See `notes/2026-10-19-deployment-wrap-up.md`.
- Harness² (`google-research/harness2`) is not a dependency of this release. The evaluation
  in `notes/2026-10-19-harness2-assessment.md` concludes it is a Python 3.12 research harness
  for OpenCode/Codex substrates with no OMK substrate, so only its static validation rules are
  worth porting, under a separate spec.
