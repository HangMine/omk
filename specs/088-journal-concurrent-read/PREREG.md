# 088 load gate pre-registration

Fixed before any load run. Do not edit after the first run.

- Setup:
  - 1 writer appending verified-run events continuously through `VerifiedRunJournal.append`;
  - 8 reader workers calling `readRunJournal(runPath, { mode: "reader" })` in a loop;
  - same host, local file system (tmpfs or ext4, recorded at run time).
- Size: 30,000 read attempts in total across the 8 readers. One run.
- Pass: 0 `integrity`, 0 non-prefix results (each result's record hashes equal the first n hashes of the final journal), and 0 `concurrent_change`.
- Statistical statement: with 0 failures in 30,000 attempts, the 95% upper bound on the per-attempt failure rate is about 1.0e-4 (rule of three). No comparison with a base rate is made.
- Record: load1 at start and end, wall time, file system type, attempts per reader, and the counts of each outcome.

## Amendment 1 (2026-10-20, before the re-measure)

Added after the first run because that run had no validity conditions.

- First run (2026-10-20 05:58 KST, `/workspace/omk-he-088-loadgate.txt`): INVALID. It showed no evidence of contention. It is not counted as a pass or a fail.
- Setup change (accepted): the writer rotates runs. Each run directory has its own live session owner lease. When a run's journal is full (32 `model_request` events), the writer appends `failed` and starts the next run. It then publishes the run index by an atomic rename of a `current` pointer file. Each read follows the pointer. The prefix check uses each run's own final journal.
- Pass criteria unchanged: 30,000 reads, 8 readers, 0 `integrity`, 0 non-prefix, 0 `concurrent_change`. A `journal_truncated` while the owner lease is live is a failure and is also reported on its own.
- Validity conditions. If one is unmet, the run is INVALID, not FAIL:
  - (a) The writer appends for the whole reader duration. The writer start is at or before the first read, and the writer stop is at or after the last read. Timestamps are logged.
  - (b) Torn-tail drops (reads where a torn tail was dropped under a live lease) are at least 300.
- Report-only counts, with no threshold:
  - concurrent-change retry entries;
  - 0-byte or 0-record prefix encounters;
  - distinct torn tails as unique (run, byte offset) pairs.
- Upper bounds, by the rule of three when there are 0 failures:
  - per attempt over all reads: 3/30,000, about 1.0e-4;
  - per torn-tail drop: about 3/n_drops;
  - per distinct torn tail: about 3/n_distinct.

  The torn-tail bounds are much weaker than the 30,000-based bound.
- This re-measure is the single allowed re-measure. If validity is unmet again, do not rerun; report it for a setup discussion.
- Counters come only from the reader-mode test seams (`read`, `sleep` and `ownerLive` wrappers that call the default implementations). Product behavior is unchanged.

## Amendment 2 (2026-10-20, before calibration)

- A calibration smoke is approved. It does not count as the re-measure.
- Candidates for `GATE_READ_GAP_US`: 0, 200 and 1000.
- Each candidate smoke is 800 reads (8 readers × 100). Outputs are labeled "calibration, not gate".
- Selection rule: projected torn-tail drops at 30,000 reads (smoke drops × 37.5) must be at least 600 (twice the validity threshold). The smallest qualifying value is chosen. If none qualifies, stop and report; no gate.
- Failure counts must not influence the selection. Any smoke failure is reported and treated as a bug: stop, no gate.
