# OMK v1.5.5

OMK 1.5.5 is a patch release. Secret redaction no longer runs on text, log and
session paths, the verified-bash receipt policy id now says so, and next-task
suggestions follow the editor on screen. New harness work since 1.5.4 ships
behind flags that are off by default.

## Changed

- **No secret redaction on text, log and session paths.** Values such as API
  responses recorded by `ApiBroker`, compaction input and run-journal entries are
  stored as-is.
- **Honest verified-bash policy id.** `VERIFIED_BASH_REDACTION_POLICY_ID` is now
  `omk-bash-combined-v2+raw-unredacted+utf8+capture-tail-128k+tail-64k`. Receipts
  written with the old id are unchanged; code that compares against the old string
  must update.

## Deprecated

- **`redactForModel`.** Still exported from the package root with its v1.5.4
  behavior, but omk no longer calls it. It will be removed in 2.0.0.

## Fixed

- **Next-task suggestions follow the editor on screen.** An extension that swaps in
  its own editor at session start no longer hides the suggestion.
