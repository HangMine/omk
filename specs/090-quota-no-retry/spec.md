---
description: "Quota exhaustion gets zero retry waits: fail over at once or end with a typed no-retry error; other retryable errors honor Retry-After, capped at 60s"
---

# Feature Specification: quota exhaustion is never retried on the same route

**Specification ID**: `090-quota-no-retry`
**Feature Branch**: `spec/090-quota-no-retry` from local main `af8d32559e`
**Created**: 2026-10-20
**Status**: Implementation (local commit; not pushed)
**Constitution**: [specs/constitution.md](../constitution.md)
**Input**: Design decided by Tech Lead and OMK in the omk harness team room.
**OMK Preset**: `omk`

**Behavior changes**: 쿼터 소진은 재시도하지 않음

## Problem

`provider-retry.ts` marks quota/billing exhaustion as retryable so the failover
chain can save the turn. When failover is off, or no authenticated candidate is
left, the session then retries the same quota-dead route up to `maxRetries`
(default 5) with the 2000·2^(n-1) ms backoff — about a minute of waiting that
cannot succeed until the billing window resets. A successful quota failover
still waited 400 ms. Provider Retry-After hints in the error text were ignored
by the agent-turn retry.

## Change

New module `packages/coding-agent/src/core/quota-retry-policy.ts`
(`agent-session.ts` does not grow; module-size ratchet holds):

- Quota vs transient 429 uses the existing `classifyProviderError`
  (`kind: "quota_exhausted"` vs `rate_limit` / `transient_transport`).
- `providerResilience.autoFailoverOnQuotaExhaustion` **on** (default): fail over
  immediately, pinned or not, with a 0 ms wait. If no candidate can be switched
  to, the turn ends at once (no same-model retry).
- **off**: the error is not retryable; the turn ends at once with no retry
  events.
- Either way, a turn that ends on quota exhaustion settles with
  `QuotaExhaustedNoRetryError` (`code: "quota_exhausted"`, `retryable: false`,
  message `quota exhausted, no retry: …`, provider message as `cause`), read
  with `quotaNoRetryErrorOf(session)`. `agent-session.ts` has one call line
  (`recordQuotaOutcome`); `prompt()` still resolves and the provider termination
  record is unchanged.
- Other retryable errors: a Retry-After hint in the error text
  (`Retry-After: N`, `retry-after-ms: N`, `retry after N s`, `try again in Ns`)
  replaces the backoff and is capped at 60 s; all waits stay within the run
  budget. The configured exponential backoff is not capped (its default
  reaches at most 32 s at `maxRetries` 5; an existing test pins a huge
  `baseDelayMs` to the timer limit).
- Unchanged: `maxRetries` default (`settings-manager.ts` `?? 5`), backoff
  formula, 520 and transient-429 behavior.

## Success criterion

A quota-exhausted turn makes exactly one provider call when failover is off or
impossible, and its failover retry has `delayMs === 0`. No Retry-After wait
exceeds 60 000 ms. All pre-existing retry, resilience and classification tests pass
unchanged.

## Tests

- `packages/coding-agent/test/agent-session-retry.test.ts` — six `spec 090:`
  cases (fail on base `af8d32559e`): ends at once when quota failover is
  disabled; zero-wait failover pinned / unpinned; ends at once with no usable
  candidate; honors Retry-After; caps Retry-After at 60 s. Three more fail on
  `93ac5e4ada`: failover off ends with `QuotaExhaustedNoRetryError` (cause =
  provider message); failover on with no usable candidate ends with the same
  error; a successful quota failover leaves no typed error.
- `packages/coding-agent/test/quota-retry-policy.test.ts` — unit tests for the
  classifier split, typed error, hint parsing, wait cap, retry gate (new module;
  fails on base).
- Regression: `provider-resilience.test.ts` (incl. line 221),
  `provider-retry.test.ts`, `provider-error-classification.test.ts`,
  `compaction-quota-failover.test.ts` stay green unchanged.

- A quota termination appends one `quota-no-retry` run-log line (spec 042,
  `OMK_RUN_LOG_DIR`) with `code`, `provider`, `model`, `failover`,
  `noCandidate` — no message text.
- Same-model route rotation (`shouldRotateRoute`) never fires for quota
  exhaustion, so a quota turn with no failover target ends with the route
  unchanged.

## Known risks

- Retry-After in HTTP-date form (e.g. `Retry-After: Wed, 21 Oct 2026 07:28:00 GMT`)
  is not parsed from error text; such errors fall back to the exponential
  backoff.
- `noCandidate` is inferred: failover was on and the turn still ended on quota.

## Rollback

Revert the single commit. No settings, schema, or persisted data change; to
restore the old wait-and-retry behavior only the retry gate and wait planner in
`agent-session.ts` need reverting.
