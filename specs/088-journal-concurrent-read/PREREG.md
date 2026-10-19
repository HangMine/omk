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
