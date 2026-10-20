# OMK v1.5.4

OMK 1.5.4 is a patch release: a TypeSafe (JEV) key command, opt-in next-task
suggestions, quota-exhaustion handling without same-model retries, and a
run-journal reader fix.

## Added

- **`/jev` key command.** `/jev set`, `/jev status`, and `/jev clear` manage the
  TypeSafe key in `auth.json`. `status` prints only `stored`, `env`, or `none`, and no
  subcommand echoes key characters or makes a network call. A stored key wins over
  `TYPESAFE_API_KEY`, as for every other provider. The key is not masked while typing.
- **Extension `/jev` queries.** An extension that registers `/jev` still receives
  `/jev <query>`. The built-in command only claims `set`, `status`, `clear`, and a bare
  `/jev`.
- **Next-task suggestions (opt-in).** With `OMK_NEXT_SUGGESTIONS=1`, a completed turn can
  end with one short suggestion. It reuses the warm prompt cache of the same model, caps
  output at the thinking budget plus 128 tokens (128 with reasoning off), and is skipped
  when the cache is cold, the model changed, or provider usage is unavailable or at 90%
  or more.
- **Pinned quota failover notice.** When quota exhaustion moves a pinned model to a
  failover candidate, OMK shows one warning per turn and writes a `pinned-quota-failover`
  run-log record. `providerResilience.autoFailoverOnQuotaExhaustion: false` keeps the pin.

## Changed

- **Quota exhaustion is not retried.** Same-model retry cannot heal an exhausted quota, so
  the turn fails over at once when `providerResilience.autoFailoverOnQuotaExhaustion` is
  on and otherwise ends with `QuotaExhaustedNoRetryError`. Other retryable errors keep
  exponential backoff, honor `Retry-After`, and cap one wait at 60 s.
- `omk-ai` reads `TYPESAFE_API_KEY` for the `typesafe` provider, exports
  `DEFAULT_THINKING_BUDGETS`, and ships a regenerated model catalog pinned to verified
  refresh values.

## Fixed

- **Run-journal reads during a live append.** A reader drops the torn tail of an
  in-progress append only while the owner lease is live, retries for at most 250 ms, and
  retries a journal that has no complete record yet.

## Security

- `/jev set` rejects keys that start with `!`. `getApiKey` runs such a stored value as a
  shell command, so the key is refused and nothing is written.
- `test.sh` removes every variable whose name contains `KEY`, `SECRET`, `TOKEN`,
  `PASSWORD`, or `CREDENTIAL`, so the release test run cannot reach a live provider with
  the operator's key.

## Notes

- `OMK_NEXT_SUGGESTIONS` is off by default. With it off, the suggestion controller is not
  installed.
- No intentional breaking changes. With quota failover disabled, a quota-exhausted turn
  now ends at once instead of waiting through backoff.
- Project Context (`omk context ...`) is still not shipped; the v1.5.0 changelog entry
  carries a correction note.
