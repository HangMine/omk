# OMK v1.5.2

OMK 1.5.2 is a patch release that restores lockstep publication for all seven public
workspace packages. The npm registry accepted six packages at 1.5.1 but left
`omk-agent-core@1.5.1` in a staged state that could not be approved or overwritten.
The same provider-recovery changes are published as 1.5.2 for every package.

## Provider recovery carried forward from 1.5.1

- Cloudflare origin responses `520` through `527` are classified as transient upstream
  failures, including the observed `520 status code (no body)`.
- Explabs/OpenRouter quota prefixes such as `free_limit_reached`,
  `free_tier_requires_payment`, `model_requires_purchase`, `promo_byok_only`, and
  `no available platform credits` are recognized as quota exhaustion.
- Quota exhaustion can fail over to an authenticated
  `providerResilience.failoverCandidates` entry even when `--model` or `--provider`
  pinned the current model. Set `providerResilience.autoFailoverOnQuotaExhaustion` to
  `false` to keep the pin absolute. Safety-stop failover remains pin-gated.
- The default `retry.maxRetries` is `5` (2s, 4s, 8s, 16s, 32s backoff).

No CLI, protocol, or configuration keys were removed. There are no intentional
breaking changes.
