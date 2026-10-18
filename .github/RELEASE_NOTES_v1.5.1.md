# OMK v1.5.1

OMK 1.5.1 is a patch release. All seven public workspace packages move together to
1.5.1. It fixes provider failures that ended a turn instead of retrying or failing
over, and it raises the default agent retry budget.

## Provider recovery

- Cloudflare origin responses `520` through `527` are now classified as transient
  upstream failures. The observed Explabs/1017 body `520 status code (no body)` is
  retried instead of ending the turn.
- Explabs/OpenRouter quota prefixes such as `free_limit_reached`,
  `free_tier_requires_payment`, `model_requires_purchase`, `promo_byok_only`, and
  `no available platform credits` are recognized as quota exhaustion.
- A quota refusal may now switch to an authenticated
  `providerResilience.failoverCandidates` entry even when `--model` or `--provider`
  pinned the current model, because a quota-dead pinned route cannot serve the next
  request. Safety-stop failover remains pin-gated. Set
  `providerResilience.autoFailoverOnQuotaExhaustion` to `false` to keep the pin
  absolute.
- The default `retry.maxRetries` is now `5` (2s, 4s, 8s, 16s, 32s backoff). The
  previous default of 3 gave up after about 14 seconds, which was shorter than
  observed gateway bursts.

## Compatibility

No CLI, protocol, or configuration keys were removed. The only behavior change is
that quota exhaustion can switch away from a pinned model unless the new setting is
disabled, and the default retry budget is larger. There are no intentional breaking
changes.
