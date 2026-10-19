# OMK v1.5.3

OMK 1.5.3 is a patch release: two runtime fixes, plus test-fixture repairs that make the
suite green on a loaded host and restore CI.

## Fixed

- **Skill search phase.** `SkillSearchGate` now passes the active TODO kind into metacon
  ranking. The ranker and the `skill-select` run log already accepted a `phase`, but the
  gate never supplied one, so ranking and `phaseSource` always reported the `task` default.
- **Concurrent attachment previews.** Two previews of the same active attachment now share
  one in-flight Photon decode instead of each allocating a full-resolution image and a
  resized RGBA buffer. A dropped draft still releases its entry through the existing
  `WeakMap`.

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
- The full suite (`./test.sh`) passed twice in a row on this host while it was under load
  (load average about 26). `npm run check` and `npm run build` pass.
- Harness² (`google-research/harness2`) is not a dependency of this release. The evaluation
  in `notes/2026-10-19-harness2-assessment.md` concludes it is a Python 3.12 research harness
  for OpenCode/Codex substrates with no OMK substrate, so only its static validation rules are
  worth porting, under a separate spec.
